import {
  createSdkMcpServer,
  query as claudeQuery,
  tool as claudeTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { promptFor, selectedTools } from "./protocol.js";
import {
  decodeImageDataUrl,
  fileInputs,
  imageInputs,
  pdfSource,
  validateRemoteUrl,
} from "./inputs.js";

const TOOL_PREFIX = "mcp__openai__";
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
// The bridge translates one OpenAI-compatible model call into exactly one
// Claude SDK assistant turn. The host runtime owns the configurable
// agent-step budget; this is not a product thread or user-turn limit.
const BRIDGE_SDK_TURN_BUDGET = 1;

function turnTimeoutMs(value = process.env.AGENT_BRIDGE_CLAUDE_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TURN_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("AGENT_BRIDGE_CLAUDE_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

async function* idlePrompt(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Effort levels the SDK reports for one model, in canonical order. */
function effortLevels({ supportsEffort, supportedEffortLevels }) {
  if (supportsEffort === false || !Array.isArray(supportedEffortLevels)) return [];
  return EFFORT_LEVELS.filter((level) => supportedEffortLevels.includes(level));
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
        // Effort is per-model and the SDK reports it. Reporting a fixed empty
        // list told hosts every Claude model was unconfigurable, which left
        // their effort pickers dead.
        reasoningEfforts: effortLevels(model),
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

function prepareTools(input) {
  try {
    const selected = selectedTools(input);
    return { selected, sdk: proxyTools(selected) };
  } catch (error) {
    if (error && typeof error === "object") error.status = 400;
    throw error;
  }
}

async function* structuredPrompt(input) {
  const content = [{ type: "text", text: promptFor(input.messages, input.tool_choice) }];
  for (const image of imageInputs(input)) {
    if (image.url.startsWith("data:")) {
      const decoded = decodeImageDataUrl(image.url);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: decoded.mediaType,
          data: decoded.bytes.toString("base64"),
        },
      });
    } else {
      content.push({
        type: "image",
        source: {
          type: "url",
          url: validateRemoteUrl(image.url, "image_url"),
        },
      });
    }
  }
  for (const file of fileInputs(input)) {
    content.push({
      type: "document",
      source: pdfSource(file),
      ...(file.filename ? { title: file.filename } : {}),
    });
  }
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

function sdkPrompt(input) {
  return imageInputs(input).length || fileInputs(input).length
    ? structuredPrompt(input)
    : promptFor(input.messages, input.tool_choice);
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
      // Some models stream a thinking block's signature while withholding its
      // text, so `thinking` arrives as "". Forwarding that claims reasoning is
      // present when there is nothing to show.
      return event.delta.thinking
        ? { reasoning_content: event.delta.thinking }
        : undefined;
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
  const prepared = options.preparedTools ?? prepareTools(input);
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
  const timeoutMs = turnTimeoutMs(options.timeoutMs);
  let abortCause;
  const forwardAbort = () => {
    abortCause ??= "upstream";
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    abortCause ??= "timeout";
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const queryFn = options.queryFn ?? claudeQuery;
  const stream = queryFn({
    prompt: sdkPrompt(input),
    options: {
      model: input.model,
      maxTurns: BRIDGE_SDK_TURN_BUDGET,
      tools: [],
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      includePartialMessages: true,
      abortController: controller,
      // Adaptive thinking is already the SDK default, so `thinking` is left
      // alone; effort is the knob a host can actually ask for.
      ...(input.reasoning_effort ? { effort: input.reasoning_effort } : {}),
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
  } catch (error) {
    if (abortCause === "timeout") {
      throw new Error(`Claude turn timed out after ${timeoutMs} ms.`);
    }
    if (abortCause === "upstream") {
      throw new Error("Claude turn cancelled.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    stream.close?.();
  }
}

/**
 * Adapts the single-turn Claude lane to the shared ChatRunner contract, so
 * both /v1/chat/completions and /v1/responses serve it through the same
 * formatters as every other adapter. `defaults` (queryFn, timeoutMs) exist
 * for tests; production callers pass none.
 */
export function createClaudeRunner(defaults = {}) {
  const active = new Set();
  const runner = async (input, options = {}) => {
    const controller = new AbortController();
    active.add(controller);
    const forward = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", forward, { once: true });
    const toolCallIndexes = new Map();
    let emittedText = false;
    const emittedCallIds = new Set();
    try {
      const turn = await runClaudeTurn(input, {
        queryFn: defaults.queryFn,
        timeoutMs: defaults.timeoutMs,
        signal: controller.signal,
        onEvent(event) {
          const delta = streamEventDelta(event, toolCallIndexes);
          if (!delta) return;
          if (typeof delta.content === "string" && delta.content) {
            emittedText = true;
          }
          for (const call of delta.tool_calls ?? []) {
            if (call.id) emittedCallIds.add(call.id);
          }
          options.onDelta?.(delta);
        },
      });
      // Some models withhold streamed text or tool blocks; re-emit whatever
      // the resolved turn carries so streaming clients still receive it.
      if (options.onDelta) {
        if (!emittedText && turn.content) {
          options.onDelta({ content: turn.content });
        }
        turn.toolCalls.forEach((call, index) => {
          if (!emittedCallIds.has(call.id)) {
            options.onDelta({ tool_calls: [{ index, ...call }] });
          }
        });
      }
      return {
        content: turn.content,
        toolCalls: turn.toolCalls.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments || "{}"),
        })),
        finishReason: turn.finishReason,
      };
    } finally {
      active.delete(controller);
      options.signal?.removeEventListener("abort", forward);
    }
  };
  runner.close = () => {
    for (const controller of active) controller.abort();
    active.clear();
  };
  return runner;
}
