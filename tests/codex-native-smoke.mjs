// Opt-in: three real model turns; only synthetic records and native client search.
import assert from "node:assert/strict";
import { closeCodexSessions, runCodex, runCodexResponses } from "../src/codex.ts";
import { respondResponses, responsesRequestSchema } from "../src/responses.ts";

const model = process.env.AGENT_BRIDGE_CODEX_SMOKE_MODEL;
assert(model, "Set AGENT_BRIDGE_CODEX_SMOKE_MODEL to an account model explicitly");
const definition = { type: "namespace", name: "shipping", description: "Synthetic shipping delivery dates.", tools: [
  { type: "function", name: "get_eta", description: "Get delivery date for an order.", defer_loading: true, strict: true,
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false } }
] };
const tools = [{ type: "tool_search", execution: "client", description: "Discover tools from shipping (order delivery dates). Search before invoking deferred functions.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }];
const input = [{ role: "user", content: "First search for shipping delivery tools, then look up order 123. Report the exact returned date and proof string." }];
const invoke = async () => {
  const response = await respondResponses(responsesRequestSchema.parse({ model, input, tools, reasoning: { effort: "low" }, store: false }), runCodex, undefined, undefined, runCodexResponses);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "completed");
  return body;
};
const start = performance.now();
try {
  const first = await invoke();
  const searches = first.output.filter(i => i.type === "tool_search_call");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].execution, "client");
  assert.equal(typeof searches[0].arguments.query, "string");
  input.push(...first.output, { type: "tool_search_output", execution: "client", call_id: searches[0].call_id, status: "completed", tools: [definition] });
  const second = await invoke();
  const calls = second.output.filter(i => i.type === "function_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, "shipping");
  assert.equal(calls[0].name, "get_eta");
  assert.equal(JSON.parse(calls[0].arguments).order_id, "123");
  input.push(...second.output, { type: "function_call_output", call_id: calls[0].call_id, output: '{"delivery_date":"2026-10-22","proof":"NATIVE_REPLAY_OK"}' });
  const third = await invoke();
  const parts = third.output.filter(i => i.type === "message").flatMap(i => i.content);
  assert(parts.every(p => p.type !== "output_text" || Array.isArray(p.annotations)));
  assert(parts.map(p => p.text ?? "").join(" ").includes("NATIVE_REPLAY_OK"));
  assert(!third.output.some(i => i.internal_chat_message_metadata_passthrough));
  console.log(JSON.stringify({ success: true, model, nativeSearches: 1, hostCalls: 1, modelTurns: 3, durationMs: Math.round(performance.now() - start) }));
} finally { await closeCodexSessions(); }
