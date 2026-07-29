#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createSdkMcpServer,
  query as claudeQuery,
  tool as claudeTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_PORT = 3457;
const DEFAULT_TOKEN = "dev-only";
const TOOL_PREFIX = "mcp__openai__";
// The bridge translates one OpenAI-compatible model call into exactly one
// Claude SDK assistant turn. Lumen's outer runtime owns the configurable
// agent-step budget; this is not a product thread or user-turn limit.
const BRIDGE_SDK_TURN_BUDGET = 1;

async function* idlePrompt(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
}

export async function discoverClaudeModels(options = {}) {
  const controller = new AbortController();
  const queryFn = options.queryFn ?? claudeQuery;
  const stream = queryFn({
    prompt: idlePrompt(controller.signal),
    options: {
      tools: [],
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      abortController: controller,
    },
  });
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  try {
    const models = await stream.supportedModels();
    const catalog = new Map();
    for (const model of [
      ...models.filter(({ value }) => value !== "default"),
      ...models.filter(({ value }) => value === "default"),
    ]) {
      const id = model.resolvedModel ?? model.value;
      const alias = model.value === id ? undefined : model.value;
      const existing = catalog.get(id);
      if (existing) {
        if (alias && !existing.aliases?.includes(alias)) {
          existing.aliases = [...(existing.aliases ?? []), alias];
        }
        continue;
      }
      catalog.set(id, {
        id,
        name: id,
        description: model.description,
        ...(alias ? { aliases: [alias] } : {}),
      });
    }
    return [...catalog.values()];
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream.close();
  }
}

const textPart = z.object({ type: z.literal("text"), text: z.string() });
const content = z.union([z.string(), z.array(textPart)]);
const functionCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content }),
  z.object({ role: z.literal("user"), content }),
  z.object({
    role: z.literal("assistant"),
    content: content.nullable().optional(),
    tool_calls: z.array(functionCall).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content,
    tool_call_id: z.string(),
    name: z.string().optional(),
  }),
]);
const functionTool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});
const toolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);
const completionRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1),
    tools: z.array(functionTool).optional().default([]),
    tool_choice: toolChoice.optional().default("auto"),
    stream: z.boolean().optional().default(false),
  })
  // OpenAI-compatible clients add optional tuning fields such as max_tokens.
  // Validate the protocol fields this bridge consumes and ignore the rest.
  .passthrough();

function textOf(value) {
  return typeof value === "string"
    ? value
    : value.map((part) => part.text).join("");
}

function promptFor(messages, choice) {
  const transcript = messages.map((item) => {
    if (item.role === "assistant") {
      return {
        role: item.role,
        content: item.content == null ? "" : textOf(item.content),
        tool_calls: item.tool_calls ?? [],
      };
    }
    if (item.role === "tool") {
      return {
        role: item.role,
        tool_call_id: item.tool_call_id,
        name: item.name,
        content: textOf(item.content),
      };
    }
    return { role: item.role, content: textOf(item.content) };
  });
  const instruction =
    choice === "required"
      ? "You must call one of the supplied functions in this turn."
      : typeof choice === "object"
        ? `You must call the supplied function named ${JSON.stringify(choice.function.name)}.`
        : choice === "none"
          ? "Do not call a function in this turn."
          : "Answer or call a supplied function as appropriate.";
  return [
    "Continue the following OpenAI chat transcript by producing exactly one assistant turn.",
    instruction,
    "Preserve tool-call IDs and use the supplied function schemas. Do not claim a tool result before one appears in the transcript.",
    JSON.stringify(transcript),
  ].join("\n\n");
}

function toolName(value) {
  const name = String(value);
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toolShape(parameters) {
  const schema = z.fromJSONSchema(parameters ?? { type: "object", properties: {} });
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("Function parameters must be a JSON Schema object");
  }
  return schema.shape;
}

function selectedTools(tools, choice) {
  if (choice === "none") return [];
  if (typeof choice === "object") {
    const selected = tools.filter(
      (item) => item.function.name === choice.function.name,
    );
    if (selected.length !== 1) throw new Error("tool_choice names an unknown function");
    return selected;
  }
  if (choice === "required" && tools.length === 0) {
    throw new Error("tool_choice is required but no functions were supplied");
  }
  return tools;
}

function proxyTools(tools) {
  return tools.map(({ function: definition }) =>
    claudeTool(
      definition.name,
      definition.description ?? "",
      toolShape(definition.parameters),
      async () => ({
        content: [{ type: "text", text: "__bridge_pending__" }],
      }),
      { alwaysLoad: true },
    ),
  );
}

function prepareTools(tools, choice) {
  try {
    const selected = selectedTools(tools, choice);
    return { selected, sdk: proxyTools(selected) };
  } catch (error) {
    if (error && typeof error === "object") error.status = 400;
    throw error;
  }
}

function completionId() {
  return `chatcmpl-${crypto.randomUUID()}`;
}

function chunk(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function streamEventDelta(event, toolCallIndexes = new Map()) {
  const toolCallIndex = (contentIndex) => {
    if (!toolCallIndexes.has(contentIndex)) {
      toolCallIndexes.set(contentIndex, toolCallIndexes.size);
    }
    return toolCallIndexes.get(contentIndex);
  };
  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    return {
      tool_calls: [
        {
          index: toolCallIndex(event.index),
          id: event.content_block.id,
          type: "function",
          function: {
            name: toolName(event.content_block.name),
            arguments: "",
          },
        },
      ],
    };
  }
  if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") return { content: event.delta.text };
    if (event.delta.type === "thinking_delta") {
      return { reasoning_content: event.delta.thinking };
    }
    if (event.delta.type === "input_json_delta") {
      return {
        tool_calls: [
          {
            index: toolCallIndex(event.index),
            function: { arguments: event.delta.partial_json },
          },
        ],
      };
    }
  }
  return undefined;
}

function assistantTurn(message) {
  const content = [];
  const toolCalls = [];
  for (const block of message.message.content ?? []) {
    if (block.type === "text") content.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: toolName(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return {
    content: content.join("") || null,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
  };
}

export async function runClaudeTurn(input, options = {}) {
  const prepared =
    options.preparedTools ?? prepareTools(input.tools, input.tool_choice);
  const tools = prepared.selected;
  const sdkTools = prepared.sdk;
  const mcpServer = sdkTools.length
    ? createSdkMcpServer({
        name: "openai",
        version: "0.0.0",
        tools: sdkTools,
        alwaysLoad: true,
      })
    : undefined;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 120_000,
  );
  const queryFn = options.queryFn ?? claudeQuery;
  const stream = queryFn({
    prompt: promptFor(input.messages, input.tool_choice),
    options: {
      model: input.model,
      maxTurns: BRIDGE_SDK_TURN_BUDGET,
      tools: [],
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      includePartialMessages: true,
      abortController: controller,
      ...(mcpServer ? { mcpServers: { openai: mcpServer } } : {}),
      ...(sdkTools.length
        ? { allowedTools: tools.map((item) => `${TOOL_PREFIX}${item.function.name}`) }
        : {}),
    },
  });
  let content = "";
  let sawAssistant = false;
  try {
    for await (const item of stream) {
      if (item.type === "stream_event") {
        options.onEvent?.(item.event);
      } else if (item.type === "assistant" && item.parent_tool_use_id == null) {
        if (item.error) throw new Error(`Claude bridge failed: ${item.error}`);
        // One Claude API turn can emit several assistant messages (for
        // example, a thinking block followed by a tool-use block).
        const next = assistantTurn(item);
        sawAssistant = true;
        content += next.content ?? "";
        // The OpenAI client owns tool execution and the following model step.
        if (next.toolCalls.length) {
          return { ...next, content: content || null };
        }
      } else if (item.type === "result") {
        if (item.subtype && item.subtype !== "success") {
          throw new Error(`Claude bridge returned error result: ${item.subtype}`);
        }
        break;
      }
    }
    if (!sawAssistant) throw new Error("Claude bridge returned no assistant turn");
    return { content: content || null, toolCalls: [], finishReason: "stop" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    stream.close?.();
  }
}

function completionResponse(id, created, model, turn) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: turn.content,
          ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
        },
        finish_reason: turn.finishReason,
      },
    ],
  };
}

function errorPayload(message, type = "invalid_request_error") {
  return { error: { message, type, param: null, code: null } };
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 2 MiB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.status = 400;
    throw error;
  }
}

async function streamCompletion(response, input, options) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let emittedText = false;
  const emittedToolCallIds = new Set();
  const toolCallIndexes = new Map();
  const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(chunk(id, created, input.model, { role: "assistant" }));
  try {
    const turn = await runClaudeTurn(input, {
      ...options,
      onEvent(event) {
        const delta = streamEventDelta(event, toolCallIndexes);
        if (!delta) return;
        if (typeof delta.content === "string") emittedText ||= delta.content.length > 0;
        for (const call of delta.tool_calls ?? []) {
          if (call.id) emittedToolCallIds.add(call.id);
        }
        send(chunk(id, created, input.model, delta));
      },
    });
    if (!emittedText && turn.content) {
      send(chunk(id, created, input.model, { content: turn.content }));
    }
    for (const [index, call] of turn.toolCalls.entries()) {
      if (!emittedToolCallIds.has(call.id)) {
        send(chunk(id, created, input.model, {
          tool_calls: [{ index, ...call }],
        }));
      }
    }
    send(chunk(id, created, input.model, {}, turn.finishReason));
  } catch (error) {
    send(errorPayload(error instanceof Error ? error.message : "Bridge failed", "server_error"));
  } finally {
    response.end("data: [DONE]\n\n");
  }
}

export function createClaudeHandler(options = {}) {
  const token = options.token ?? process.env.CC_BRIDGE_TOKEN ?? DEFAULT_TOKEN;
  const active = new Set();
  let modelCatalog;
  const listModels = () => {
    modelCatalog ??= (options.listModels?.() ?? discoverClaudeModels()).catch(
      (error) => {
        modelCatalog = undefined;
        throw error;
      },
    );
    return modelCatalog;
  };
  if (options.preloadModels) void listModels().catch(() => {});
  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, errorPayload("Invalid API key", "authentication_error"));
      }
      try {
        return json(response, 200, {
          object: "list",
          data: (await listModels()).map((model) => ({
            ...model,
            object: "model",
            created: 0,
            owned_by: "claude-code",
          })),
        });
      } catch (error) {
        return json(
          response,
          500,
          errorPayload(
            error instanceof Error ? error.message : "Model discovery failed",
            "server_error",
          ),
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return json(response, 404, errorPayload("Not found"));
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      return json(response, 401, errorPayload("Invalid API key", "authentication_error"));
    }
    if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
      return json(response, 400, errorPayload("Content-Type must be application/json"));
    }
    try {
      const parsed = completionRequest.safeParse(await readBody(request));
      if (!parsed.success) {
        return json(response, 400, errorPayload(z.prettifyError(parsed.error)));
      }
      const preparedTools = prepareTools(
        parsed.data.tools,
        parsed.data.tool_choice,
      );
      const controller = new AbortController();
      active.add(controller);
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        if (parsed.data.stream) {
          await streamCompletion(response, parsed.data, {
            queryFn: options.queryFn,
            signal: controller.signal,
            timeoutMs: options.timeoutMs,
            preparedTools,
          });
        } else {
          const id = completionId();
          const created = Math.floor(Date.now() / 1000);
          const turn = await runClaudeTurn(parsed.data, {
            queryFn: options.queryFn,
            signal: controller.signal,
            timeoutMs: options.timeoutMs,
            preparedTools,
          });
          json(response, 200, completionResponse(id, created, parsed.data.model, turn));
        }
      } finally {
        active.delete(controller);
      }
    } catch (error) {
      const status = error?.status ?? 500;
      if (!response.headersSent) {
        json(
          response,
          status,
          errorPayload(
            error instanceof Error ? error.message : "Bridge failed",
            status >= 500 ? "server_error" : "invalid_request_error",
          ),
        );
      }
    }
  };
  handler.close = () => {
    for (const controller of active) controller.abort();
  };
  return handler;
}

export function createBridgeServer(options = {}) {
  const handler = createClaudeHandler(options);
  const server = createServer(handler);
  return {
    server,
    close: () => {
      handler.close();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function startBridge() {
  const port = Number(process.env.CC_BRIDGE_PORT ?? DEFAULT_PORT);
  const bridge = createBridgeServer({ preloadModels: true });
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`cc bridge listening on http://127.0.0.1:${port}/v1`);
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startBridge();
}
