import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ChatTurn } from "./protocol.js";
import type { ResponsesRequest } from "./responses.js";

export type NativeItem = Record<string, unknown>;
export type NativeTurn = { output: NativeItem[]; usage?: ChatTurn["usage"] };
export type NativeRunner = (input: ResponsesRequest, options?: {
  signal?: AbortSignal; onItem?: (item: NativeItem) => void; plan?: NativePlan;
}) => Promise<NativeTurn>;
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const object = z.record(z.string(), z.unknown());
const fn = z.object({ type: z.literal("function"), name, description: z.string().optional(),
  parameters: object, strict: z.boolean().nullish(), defer_loading: z.boolean().optional() }).strict();
const namespace = z.object({ type: z.literal("namespace"), name, description: z.string(), tools: z.array(fn).min(1) }).strict();
const tool = z.union([fn, namespace]);
const search = z.object({ type: z.literal("tool_search"), execution: z.enum(["client", "server"]).optional(),
  description: z.string().optional(), parameters: object.optional() }).strict();
export type NativeTool = z.infer<typeof tool>;
export function validateNativeTools(value: unknown): NativeTool[] { return parse(z.array(tool), value); }
export function nativeError(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) nativeError(z.prettifyError(result.error));
  return result.data;
}
export function usesNativeResponses(input: ResponsesRequest) {
  return Boolean(input.tools?.some(t => t.type === "tool_search" || t.type === "namespace" || t.defer_loading != null) ||
    (Array.isArray(input.input) && input.input.some(i => i.namespace != null || ["tool_search_call", "tool_search_output", "additional_tools"].includes(i.type ?? ""))));
}
export type NativePlan = ReturnType<typeof nativePlan>;
export function nativePlan(input: ResponsesRequest) {
  if (input.previous_response_id) nativeError("Native Responses is stateless; send full input history.");
  if (input.tool_choice != null && input.tool_choice !== "auto") {
    nativeError("Native Responses supports tool_choice auto only; this Codex runtime cannot enforce other tool choices.");
  }
  const searches = (input.tools ?? []).filter(t => t.type === "tool_search").map(t => parse(search, t));
  if (searches.length > 1) nativeError("Only one native tool_search declaration is allowed.");
  const discovery = searches[0];
  if (discovery?.execution === "client" && (!discovery.parameters || !discovery.description)) {
    nativeError("Client tool_search requires description and parameters.");
  }
  if (discovery?.execution !== "client" && (discovery?.parameters || discovery?.description)) {
    nativeError("Server tool_search does not accept client parameters or description.");
  }
  const declared = (input.tools ?? []).filter(t => t.type !== "tool_search").map(t => parse(tool, t));
  const registry = new Map<string, z.infer<typeof fn>>();
  const register = (definitions: NativeTool[]) => {
    for (const definition of definitions) {
      const ns = definition.type === "namespace" ? definition.name : undefined;
      if (ns && ["functions", "tool_search"].includes(ns)) nativeError("Reserved native tool namespace.");
      const functions = definition.type === "namespace" ? definition.tools : [definition];
      for (const f of functions) {
        const key = `${ns ?? ""}/${f.name}`;
        const existing = registry.get(key);
        // Descriptions can change between turns; argument contracts cannot.
        if (existing && !isDeepStrictEqual({ ...existing, description: undefined }, { ...f, description: undefined })) nativeError(`Conflicting tool schema: ${key}`);
        registry.set(key, existing ?? f);
      }
    }
  };
  register(declared);
  const pending = new Map<string | symbol, { type: string; execution?: unknown }>();
  const ids = new Set<string>();
  const history: NativeItem[] = [];
  for (const raw of typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input) {
    const item: NativeItem = { ...raw, type: raw.type ?? "message" };
    // Unencrypted inline items must not trigger persisted-item lookup. Encrypted
    // content is bound to its original id and must retain that id for verification.
    if (!item.encrypted_content) delete item.id;
    if (item.type === "message") {
      if (!["system", "developer", "assistant", "user"].includes(String(item.role))) nativeError("Unsupported native message role.");
      if (typeof item.content === "string") item.content = [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }];
      if (!Array.isArray(item.content) || item.content.some(p => !p || typeof p !== "object" || !["input_text", "output_text"].includes(p.type) || typeof p.text !== "string")) nativeError("Native discovery currently accepts text content only.");
    } else if (item.type === "additional_tools") {
      if (item.role !== "developer") nativeError("additional_tools requires developer role.");
      register(parse(z.array(tool), item.tools));
    } else if (item.type === "tool_search_call" || item.type === "function_call") {
      const hosted = item.type === "tool_search_call" && item.execution === "server" && item.call_id == null;
      const id = hosted ? Symbol("hosted search") : item.call_id;
      if (typeof id !== "symbol" && (typeof id !== "string" || !id || ids.has(id))) nativeError("Missing or duplicate native call_id.");
      if (typeof id === "string") ids.add(id);
      pending.set(id as string | symbol, { type: String(item.type), execution: item.execution });
      if (item.type === "tool_search_call") {
        if (!["client", "server"].includes(String(item.execution))) nativeError("Invalid search execution.");
        parse(object, item.arguments);
      } else {
        if (typeof item.name !== "string" || typeof item.arguments !== "string") nativeError("Invalid native function_call.");
        const ns = item.namespace === "functions" || item.namespace === "" ? undefined : item.namespace;
        if ((ns != null && typeof ns !== "string") || !registry.has(`${ns ?? ""}/${item.name}`)) nativeError("History contains an undeclared native function.");
        let args: unknown;
        try { args = JSON.parse(item.arguments); } catch { nativeError("History function arguments must be valid JSON."); }
        if (!args || typeof args !== "object" || Array.isArray(args)) nativeError("History function arguments must be an object.");
      }
    } else if (item.type === "tool_search_output" || item.type === "function_call_output") {
      const expected = item.type === "tool_search_output" ? "tool_search_call" : "function_call";
      const hosted = item.type === "tool_search_output" && item.execution === "server" && item.call_id == null;
      const key = hosted ? [...pending].find(([id, call]) => typeof id === "symbol" && call.type === expected && call.execution === "server")?.[0] : item.call_id;
      if ((typeof key !== "string" && typeof key !== "symbol") || pending.get(key)?.type !== expected) nativeError("Native output has no matching call_id.");
      if (item.type === "tool_search_output" && pending.get(key)?.execution !== item.execution) nativeError("Search output execution does not match its call.");
      pending.delete(key);
      if (item.type === "tool_search_output") {
        if (item.status !== "completed" || !["client", "server"].includes(String(item.execution))) nativeError("Invalid search output status or execution.");
        register(parse(z.array(tool), item.tools));
      }
    } else if (item.type !== "reasoning") nativeError(`Unsupported native input item: ${item.type}`);
    history.push(item);
  }
  if (pending.size) nativeError("Native history has unresolved tool calls.");
  const currentTools = [...declared, ...(discovery ? [discovery] : [])];
  return { discovery, registry, history, currentTools };
}
