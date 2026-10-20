import * as nativeResponses from "../src/native-responses.js";
import { nativePlan } from "../src/native-responses.js";
import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCodexSessions, codexError, discoverCodexModels, runCodex, runCodexResponses } from "../src/codex.js";
import { chatRequestSchema, errorPayload, errorStatus, respond, type ChatDelta } from "../src/protocol.js";
import { respondResponses, responsesRequestSchema, toChatRequest } from "../src/responses.js";

// Uses real stdio/process cleanup, but never a real account or model request.
async function withCodex(script: string, check: (directory: string) => Promise<void>, autoTurnStarted = true) {
  const directory = await mkdtemp(join(tmpdir(), "codex-regression-"));
  const command = join(directory, "codex.mjs");
  const previous = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const transcript = ${JSON.stringify(join(directory, "requests"))};
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const request = JSON.parse(line);
  if (${autoTurnStarted} && request.method === "turn/start") send({ method: "turn/started", params: { turn: { id: "active" } } });
  if (request.method === "initialize") send({ id: request.id, result: {} });
  else { ${script} }
});
`);
  await chmod(command, 0o755);
  process.env.AGENT_BRIDGE_CODEX_COMMAND = command;
  try { await check(directory); }
  finally {
    await closeCodexSessions();
    if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const batchScript = `
if (request.method === "thread/start") {
  if (!request.params.experimentalRawEvents) process.exit(9);
  send({ id: request.id, result: { thread: { id: "test" } } });
} else if (request.method === "turn/start") {
  send({ id: request.id, result: {} });
  const prompt = request.params.input[0].text;
  if (prompt.includes("result-two")) {
    send({ method: "item/agentMessage/delta", params: { delta: "Both results received" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  } else {
    const item = (id) => ({ type: "function_call", call_id: id, name: "lookup", arguments: JSON.stringify({ id }) });
    send({ method: "rawResponseItem/completed", params: { item: item("one") } });
    send({ id: 20, method: "item/tool/call", params: { callId: "one", tool: "lookup", arguments: { id: "one" } } });
    // The second item is intentionally delayed past an event-loop tick. There
    // is NO second item/tool/call: native dynamic tool execution is serialized.
    setTimeout(() => {
      send({ method: "rawResponseItem/completed", params: { item: item("two") } });
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
    }, 50);
  }
}`;
const input = chatRequestSchema.parse({ model: "test", messages: [{ role: "user", content: "Look up both" }],
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { id: { type: "string" } } } } }] });

test("pins cached model metadata to direct host tools without changing the native cache", async () => {
  const previous = process.env.CODEX_HOME;
  try {
    await withCodex(`
      if (request.method === "thread/start") {
        const option = process.argv.find(arg => arg.startsWith("model_catalog_json="));
        const catalog = JSON.parse(readFileSync(JSON.parse(option.split("=").slice(1).join("=")), "utf8"));
        if (catalog.models.length !== 1 || catalog.models[0].slug !== "test" ||
            catalog.models[0].tool_mode !== "direct" || catalog.models[0].supports_search_tool !== true || catalog.models[0].shell_type !== "disabled" ||
            catalog.models[0].context_window !== 123456 ||
            catalog.models[0].experimental_supported_tools.length !== 0) process.exit(7);
        send({ id: request.id, result: { thread: { id: "test" } } });
      } else if (request.method === "turn/start") {
        send({ id: request.id, result: {} });
        send({ method: "item/agentMessage/delta", params: { delta: "direct tools" } });
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
    `, async (directory) => {
      process.env.CODEX_HOME = directory;
      const cache = JSON.stringify({ identity: "do not copy", models: [
        { slug: "test", supports_search_tool: true, tool_mode: "code_mode_only", shell_type: "unified_exec", context_window: 123456, experimental_supported_tools: ["clock"] },
        { slug: "other", tool_mode: "code_mode_only" }
      ] });
      await writeFile(join(directory, "models_cache.json"), cache);
      expect((await runCodex(input)).content).toBe("direct tools");
      expect(await readFile(join(directory, "models_cache.json"), "utf8")).toBe(cache);
    });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("still refuses an unexpected built-in exec instead of executing or replaying it", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: { type: "custom_tool_call", name: "exec", input: "never run" } } });
    }
  `, async () => {
    await expect(runCodex(input)).rejects.toThrow("Codex built-in operation refused: exec");
  });
});

test("returns a complete tool batch before Codex waits for results and replays by call ID", async () => {
  await withCodex(batchScript, async (directory) => {
    const deltas: ChatDelta[] = [];
    const turn = await runCodex(input, { onDelta: (delta) => deltas.push(delta) });
    expect(turn.toolCalls.map((call) => call.id)).toEqual(["one", "two"]);
    expect(turn.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(deltas.flatMap((delta) => delta.tool_calls ?? []).map((call) => call.index)).toEqual([0, 1]);
    const next = await runCodex(chatRequestSchema.parse({ ...input, messages: [
      ...input.messages,
      { role: "assistant", tool_calls: turn.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) },
      { role: "tool", tool_call_id: "two", content: "result-two" },
      { role: "tool", tool_call_id: "one", content: "result-one" }
    ] }));
    expect(next.content).toBe("Both results received");
    const requests = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const replay = requests.filter((request) => request.method === "turn/start").at(-1).params.input[0].text;
    expect(replay).toContain('"tool_call_id":"two","content":"result-two"');
    expect(replay).toContain('"tool_call_id":"one","content":"result-one"');
  });
});

test("serializes all calls in Chat and Responses SSE and round-trips Responses outputs", async () => {
  await withCodex(batchScript, async () => {
    const chat = await respond({ ...input, stream: true }, runCodex);
    const text = await chat.text();
    expect(text).toContain('"index":0,"id":"one"');
    expect(text).toContain('"index":1,"id":"two"');
    const request = responsesRequestSchema.parse({ model: "test", input: "Look up both", stream: true,
      tools: [{ type: "function", name: "lookup", parameters: input.tools[0]!.function.parameters }] });
    const response = await respondResponses(request, runCodex);
    const body = await response.text();
    const terminal = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === "response.completed");
    expect(terminal.response.output.map((call: any) => call.call_id)).toEqual(["one", "two"]);
    const next = await respondResponses(responsesRequestSchema.parse({ ...request, stream: false, input: [
      { role: "user", content: "Look up both" }, ...terminal.response.output,
      { type: "function_call_output", call_id: "two", output: "result-two" },
      { type: "function_call_output", call_id: "one", output: "result-one" }
    ] }), runCodex);
    expect((await next.json()).output[0].content[0].text).toBe("Both results received");
  });
});

test("uses all pages of the runtime model catalog without bundled fallback", async () => {
  await withCodex(`
    if (request.method === "model/list") {
      const page = request.params.cursor ? { data: [{ model: "second", displayName: "Second" }], nextCursor: null }
        : { data: [{ model: "allowed", displayName: "Allowed", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" },
            { model: "hidden", hidden: true }], nextCursor: "next" };
      send({ id: request.id, result: page });
    }
  `, async (directory) => {
    expect(await discoverCodexModels()).toEqual([
      { id: "allowed", name: "Allowed", reasoningEfforts: ["high"], defaultReasoningEffort: "high" },
      { id: "second", name: "Second", reasoningEfforts: [] }
    ]);
    expect(await readFile(join(directory, "requests"), "utf8")).toContain('"includeHidden":false');
  });
  await withCodex(`if (request.method === "model/list") send({ id: request.id, error: { message: "catalog unavailable" } });`, async () => {
    await expect(discoverCodexModels()).rejects.toThrow("catalog unavailable");
  });
});

test("preserves typed and JSON-envelope Codex upstream errors", () => {
  for (const status of [400, 401, 403, 404, 422, 429, 503]) {
    const error = codexError({ message: "upstream detail", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } });
    expect(errorStatus(error)).toBe(status);
    expect(errorPayload(error).message).toBe("upstream detail");
  }
  expect(errorStatus(codexError({ message: "bad", data: { codexErrorInfo: "badRequest" } }))).toBe(400);
  expect(errorStatus(codexError({ message: "panic" }))).toBe(500);
  expect(errorStatus(codexError({ message: "bad status", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 200 } } }))).toBe(500);
  const error = codexError({ message: JSON.stringify({ status: 400, error: { type: "invalid_request_error", code: "model_not_supported", message: "unsupported model" } }) });
  expect(errorPayload(error)).toMatchObject({ message: "unsupported model", type: "invalid_request_error", code: "model_not_supported", category: "invalid_request" });
});

test("expands an explicit batch into host calls without exposing the internal tool", async () => {
  await withCodex(`
    if (request.method === "thread/start") {
      const batch = request.params.dynamicTools.find(tool => tool.name.startsWith("__agent_bridge_batch"));
      if (!batch || !request.params.baseInstructions.includes(batch.name)) process.exit(7);
      send({ id: request.id, result: { thread: { id: "test" } } });
    } else if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: {
        type: "function_call", call_id: "batch", name: "__agent_bridge_batch",
        arguments: JSON.stringify({ calls: [{ name: "lookup", arguments: { id: "one" } }, { name: "lookup", arguments: { id: "two" } }] })
      } } });
      send({ method: "rawResponse/completed", params: {} });
    }
  `, async () => {
    const result = await runCodex(input);
    expect(result.toolCalls).toEqual([
      { id: "batch:0", name: "lookup", arguments: { id: "one" } },
      { id: "batch:1", name: "lookup", arguments: { id: "two" } }
    ]);
  });
});

test("rejects malformed batches and errors from delta consumers without hanging", async () => {
  for (const [args, message] of [
    [{ calls: [] }, "empty or invalid tool batch"],
    [{ calls: [{ name: "not_supplied", arguments: {} }] }, "unknown host tool"],
    [{ calls: [{ name: "lookup", arguments: [] }] }, "non-object tool arguments"]
  ] as const) {
    await withCodex(`
      if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
      if (request.method === "turn/start") {
        send({ id: request.id, result: {} });
        send({ method: "rawResponseItem/completed", params: { item: {
          type: "function_call", call_id: "batch", name: "__agent_bridge_batch", arguments: ${JSON.stringify(JSON.stringify(args))}
        } } });
      }
    `, async () => { await expect(runCodex(input)).rejects.toThrow(message); });
  }
  await withCodex(batchScript, async () => {
    await expect(runCodex(input, { onDelta() { throw new Error("consumer failed"); } })).rejects.toThrow("consumer failed");
  });
});

test("keeps batch names collision-free and respects named/none tool selection", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "item/agentMessage/delta", params: { delta: "done" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  `, async (directory) => {
    const tools = [...input.tools, { type: "function" as const, function: { name: "__agent_bridge_batch" } }];
    await runCodex({ ...input, tools });
    await runCodex({ ...input, tools, tool_choice: { type: "function", function: { name: "lookup" } } });
    await runCodex({ ...input, tools, tool_choice: "none" });
    const starts = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line)).filter(request => request.method === "thread/start").map(request => request.params);
    expect(starts[0].dynamicTools.map((tool: any) => tool.name)).toEqual(["lookup", "__agent_bridge_batch", "__agent_bridge_batch_"]);
    expect(starts[1].dynamicTools.at(-1).inputSchema.properties.calls.items.properties.name.enum).toEqual(["lookup"]);
    expect(starts[2].dynamicTools).toEqual([]);
    expect(starts[2].baseInstructions).not.toContain("__agent_bridge_batch");
  });
});

test("unnamespaced discovery and foreign namespaces remain refused", async () => {
  for (const [name, namespace] of [["tool_search_tool", null], ["tool_search_tool", "functions"], ["lookup", "private_mcp"], ["lookup", "tool_search"]]) {
    await withCodex(`
      if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
      if (request.method === "turn/start") {
        send({ id: request.id, result: {} });
        send({ method: "rawResponseItem/completed", params: { item: {
          type: "function_call", call_id: "unknown", name: ${JSON.stringify(name)}, namespace: ${JSON.stringify(namespace)}, arguments: "{}"
        } } });
      }
    `, async () => { await expect(runCodex(input)).rejects.toThrow("unknown host tool call"); });
  }
});

test("leaves namespaced native discovery to Codex and sums every model response", async () => {
  for (const reportFinalUsage of [true, false]) await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: {
        type: "function_call", call_id: "native", namespace: "tool_search", name: "tool_search_tool", arguments: "{}"
      } } });
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningOutputTokens: 2 } } });
      setTimeout(() => {
        send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 20, outputTokens: 3, totalTokens: 23 }, total: { inputTokens: 30, outputTokens: 8, totalTokens: 38, reasoningOutputTokens: 3 } } } });
        send({ method: "rawResponseItem/completed", params: { item: {
          type: "function_call", call_id: "host", namespace: "functions", name: "lookup", arguments: "{}"
        } } });
        send({ method: "rawResponse/completed", params: ${JSON.stringify(reportFinalUsage ? { usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23, reasoningOutputTokens: 1 } } : {})} });
      }, 25);
    }
  `, async () => {
    const result = await runCodex(input);
    expect(result.toolCalls).toEqual([{ id: "host", name: "lookup", arguments: {} }]);
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 8, totalTokens: 38, reasoningTokens: 3 });
  });
});

const nativeSearch = { type: "tool_search", execution: "client", description: "Find shipping delivery tools.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const shipping = { type: "namespace", name: "shipping", description: "Delivery dates and shipment status.", tools: [
  { type: "function", name: "get_eta", description: "Get estimated delivery date", strict: true, defer_loading: true,
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false } }
] };
const nativeFixture = `
let history;
if (request.method === "thread/start") {
  if (request.params.dynamicTools.length) process.exit(8);
  send({ id: request.id, result: { thread: { id: "native" } } });
} else if (request.method === "thread/inject_items") {
  globalThis.history = request.params.items;
  for (const item of globalThis.history) send({ method: "rawResponseItem/completed", params: { item } });
  send({ id: request.id, result: {} });
} else if (request.method === "turn/start") {
  if (request.params.input.length) process.exit(9);
  send({ id: request.id, result: {} });
  const h = globalThis.history;
  let item;
  if (h.some(i => i.type === "function_call_output")) item = { type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "Delivery October 22", internal_metadata: "do not expose" }] };
  else if (h.some(i => i.type === "tool_search_output")) item = { type: "function_call", id: "fc", call_id: "eta-call", namespace: "shipping", name: "get_eta", arguments: '{"order_id":"123"}' };
  else item = { type: "function_call", id: "ts", call_id: "search-call", namespace: "tool_search", name: "tool_search_tool", arguments: '{"query":"shipping delivery"}' };
  send({ method: "rawResponseItem/completed", params: { item } });
  send({ method: "rawResponse/completed", params: { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } } });
  if (item.type === "message") send({ method: "turn/completed", params: { turn: { status: "completed" } } });
}`;

test("native client discovery round-trips schemas, namespaces, call IDs and results without chat flattening", async () => {
  await withCodex(nativeFixture, async directory => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery for order 123", tools: [nativeSearch] });
    const first = await runCodexResponses(request);
    expect(first.output).toMatchObject([{ type: "tool_search_call", execution: "client", call_id: "search-call", arguments: { query: "shipping delivery" } }]);
    expect(first.usage?.totalTokens).toBe(15);
    const history = [{ role: "user", content: request.input }, ...first.output,
      { type: "tool_search_output", call_id: "search-call", execution: "client", status: "completed", tools: [shipping] }];
    const second = await runCodexResponses(responsesRequestSchema.parse({ ...request, input: history }));
    expect(second.output).toMatchObject([{ type: "function_call", namespace: "shipping", name: "get_eta", call_id: "eta-call" }]);
    const third = await runCodexResponses(responsesRequestSchema.parse({ ...request, input: [...history, ...second.output,
      { type: "function_call_output", call_id: "eta-call", output: '{"delivery_date":"2026-10-22"}' }] }));
    expect(third.output).toMatchObject([{ type: "message", content: [{ text: "Delivery October 22", annotations: [], logprobs: [] }] }]);
    expect(JSON.stringify(third.output)).not.toContain("internal_metadata");
    const requests = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const injection = requests.filter(r => r.method === "thread/inject_items").at(-1).params.items;
    expect(injection.find((i: any) => i.type === "tool_search_output").tools).toEqual([shipping]);
    expect(injection.find((i: any) => i.type === "function_call").namespace).toBe("shipping");
    expect(requests.filter(r => r.method === "turn/start").every(r => r.params.input.length === 0)).toBe(true);
  });
});

test("current discovery declarations follow stale history when a source is reenabled", async () => {
  await withCodex(nativeFixture, async directory => {
    const unavailable = { ...nativeSearch, description: "No shipping sources available.", parameters: { type: "object", properties: { query: { type: "string", enum: [] } }, required: ["query"], additionalProperties: false } };
    const history = [
      { type: "additional_tools", role: "developer", tools: [shipping] },
      { role: "user", content: "Delivery?" },
      { type: "tool_search_call", call_id: "old-search", execution: "client", arguments: { query: "shipping" } },
      { type: "tool_search_output", call_id: "old-search", execution: "client", status: "completed", tools: [] },
      { role: "assistant", content: "Shipping is unavailable." },
      { role: "user", content: "Delivery for order 123?" }
    ];
    await runCodexResponses(responsesRequestSchema.parse({ model: "test", input: history, tools: [nativeSearch, shipping] }));
    const requests = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const items = requests.find(r => r.method === "thread/inject_items").params.items;
    expect(items.at(-1)).toEqual({ type: "additional_tools", role: "developer", tools: [shipping, nativeSearch] });
    expect(items.slice(0, -1)).toEqual(nativePlan(responsesRequestSchema.parse({ model: "test", input: history, tools: [nativeSearch, shipping] })).history);
    expect(items.filter((item: any) => item.type === "message").map((item: any) => item.content[0].text)).toEqual(["Delivery?", "Shipping is unavailable.", "Delivery for order 123?"]);
    // Disabling advertises only the current discovery schema, without restoring
    // the old source's executable declaration or injecting a reminder prompt.
    await runCodexResponses(responsesRequestSchema.parse({ model: "test", input: "Delivery?", tools: [unavailable] }));
    const after = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(after.filter(r => r.method === "thread/inject_items").at(-1).params.items.at(-1).tools).toEqual([unavailable]);
  });
});

test("native JSON and SSE emit search items, function namespaces and final text", async () => {
  await withCodex(nativeFixture, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] });
    const response = await respondResponses(request, runCodex, undefined, undefined, runCodexResponses);
    const first = await response.json() as any;
    expect(first.output[0].type).toBe("tool_search_call");
    const history = [{ role: "user", content: "Delivery" }, ...first.output,
      { type: "tool_search_output", call_id: "search-call", execution: "client", status: "completed", tools: [shipping] }];
    const callResponse = await respondResponses(responsesRequestSchema.parse({ ...request, input: history, stream: true }), runCodex, undefined, undefined, runCodexResponses);
    const stream = await callResponse.text();
    expect(stream).toContain('"namespace":"shipping"');
    expect(stream).toContain('response.function_call_arguments.delta');
    const lastResponse = await respondResponses(responsesRequestSchema.parse({ ...request, stream: true, input: [...history,
      { type: "function_call", name: "get_eta", namespace: "shipping", call_id: "eta-call", arguments: '{}' },
      { type: "function_call_output", call_id: "eta-call", output: 'October 22' }] }), runCodex, undefined, undefined, runCodexResponses);
    const text = await lastResponse.text();
    expect(text).toContain('response.output_text.delta');
    expect(text).toContain('Delivery October 22');
    expect(text).toContain('response.completed');
    expect(text).toEndWith('data: [DONE]\n\n');
  });
});

test("does not advertise a successful hosted search when Codex returns an unexecuted search", async () => {
  await withCodex(nativeFixture, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [{ type: "tool_search" }, shipping] });
    await expect(runCodexResponses(request)).rejects.toThrow("did not execute server-side native tool_search");
    const response = await respondResponses({ ...request, stream: true }, runCodex, undefined, undefined, runCodexResponses);
    const text = await response.text();
    expect(text).toContain('response.failed');
    expect(text).not.toContain('response.completed');
    expect(text).toContain('response.output_item.done');
  });
});

test("native discovery refuses missing executors, malformed replay and unsupported controls before spawning", async () => {
  const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] });
  await expect(respondResponses(request, runCodex)).rejects.toThrow("does not support native Responses");
  expect(() => toChatRequest(request)).toThrow("conversion to Chat Completions would lose their contract");
  for (const input of [
    [{ type: "tool_search_output", call_id: "missing", status: "completed", execution: "client", tools: [shipping] }],
    [{ type: "tool_search_call", call_id: "one", execution: "client", arguments: {} }],
    [{ type: "tool_search_call", call_id: "one", execution: "client", arguments: {} }, { type: "tool_search_output", call_id: "one", execution: "server", status: "completed", tools: [shipping] }],
    [{ type: "additional_tools", role: "user", tools: [shipping] }],
    [{ type: "additional_tools", role: "developer", tools: [{ type: "web_search" }] }],
    [{ role: "user", content: [{ type: "input_image", image_url: "file:///private" }] }]
  ]) await expect(runCodexResponses(responsesRequestSchema.parse({ ...request, input }))).rejects.toHaveProperty("status", 400);
  for (const extra of [{ previous_response_id: "resp_old" }, { temperature: 0.2 }, { max_output_tokens: 100 }, { tool_choice: "required" }]) {
    await expect(respondResponses(responsesRequestSchema.parse({ ...request, ...extra }), runCodex, undefined, undefined, runCodexResponses)).rejects.toHaveProperty("status", 400);
  }
});

test("native discovery still refuses undeclared host functions and built-in operations", async () => {
  for (const item of [
    { type: "function_call", namespace: "other", name: "get_eta", call_id: "x", arguments: '{}' },
    { type: "custom_tool_call", name: "exec", call_id: "x", input: "never execute" },
    { type: "function_call", namespace: "tool_search", name: "tool_search_tool", call_id: "x", arguments: '{}' }
  ]) await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: ${JSON.stringify(item)} } });
    }
  `, async () => {
    await expect(runCodexResponses(responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [shipping] }))).rejects.toHaveProperty("status", 502);
  });
});

test("forwards genuine hosted native search pairs without running an extra search layer", async () => {
  const hosted = [
    { type: "tool_search_call", id: "hosted-search", execution: "server", call_id: null, arguments: { query: "shipping" }, status: "completed" },
    { type: "tool_search_output", id: "hosted-result", execution: "server", call_id: null, tools: [shipping], status: "completed" },
    { type: "function_call", id: "hosted-function", namespace: "shipping", name: "get_eta", call_id: "call-eta", arguments: '{"order_id":"123"}' }
  ];
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      for (const item of ${JSON.stringify(hosted)}) send({ method: "rawResponseItem/completed", params: { item } });
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    }
  `, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [{ type: "tool_search" }, shipping] });
    const turn = await runCodexResponses(request);
    expect(turn.output).toEqual(hosted.map(i => ({ ...i, status: "completed" })));
    const replay = responsesRequestSchema.parse({ ...request, input: [{ role: "user", content: "Delivery" }, ...turn.output,
      { type: "function_call_output", call_id: "call-eta", output: "October 22" }] });
    expect(nativePlan(replay).history.filter(i => i.type === "tool_search_output")[0]?.call_id).toBeNull();
  });
});

test("native cancellation terminates the owned process and does not emit a completed response", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") send({ id: request.id, result: {} });
  `, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] });
    const abort = new AbortController();
    const promise = runCodexResponses(request, { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});

test("loaded namespace subsets retain schema identity and conflicting argument contracts fail closed", () => {
  const extra = { ...shipping.tools[0]!, name: "get_status" };
  const request = responsesRequestSchema.parse({ model: "test", tools: [nativeSearch, { ...shipping, tools: [...shipping.tools, extra] }], input: [
    { type: "tool_search_call", call_id: "search", execution: "client", arguments: { query: "delivery" } },
    { type: "tool_search_output", call_id: "search", execution: "client", status: "completed", tools: [shipping] }
  ] });
  expect(nativePlan(request).registry.size).toBe(2);
  expect(() => nativePlan({ ...request, input: [
    { type: "additional_tools", role: "developer", tools: [{ ...shipping, tools: [{ ...shipping.tools[0]!, parameters: { type: "object", properties: { admin: { type: "boolean" } } } }] }] }
  ] })).toThrow("Conflicting tool schema");
});

test("native client search preserves custom search arguments and supports the actual tool_search_call item", async () => {
  const custom = { ...nativeSearch, parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false } };
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: { type: "tool_search_call", id: "native-id", execution: "client", call_id: "native-call", arguments: { source: "shipping" }, status: "completed" } } });
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } } });
    }
  `, async directory => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [custom], reasoning: { summary: "detailed" } });
    const response = await respondResponses({ ...request, stream: true }, runCodex, undefined, undefined, runCodexResponses);
    const stream = await response.text();
    expect(stream).toContain('"arguments":{"source":"shipping"}');
    expect(stream).toContain('"call_id":"native-call"');
    expect(stream).toContain('response.output_item.done');
    const requests = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.find(r => r.method === "thread/inject_items").params.items.at(-1).tools[0]).toEqual(custom);
    expect(requests.find(r => r.method === "turn/start").params.summary).toBe("detailed");
  });
});

test("native host-tool sessions do not inherit personal MCP configuration or skills", async () => {
  const previous = process.env.CODEX_HOME;
  try {
    await withCodex(`
      if (request.method === "thread/start") {
        const config = process.env.CODEX_HOME;
        let inherited = false;
        try { readFileSync(config + "/config.toml"); inherited = true; } catch {}
        if (inherited || !process.argv.includes('web_search="disabled"')) process.exit(8);
        if (readFileSync(config + "/auth.json", "utf8") !== "synthetic-sign-in") process.exit(9);
        send({ id: request.id, result: { thread: { id: "test" } } });
      }
      if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
      if (request.method === "turn/start") {
        writeFileSync(process.env.CODEX_HOME + "/auth.json", "rotated-synthetic-sign-in", { mode: 0o600 });
        send({ id: request.id, result: {} });
        send({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "isolated" }] } } });
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
    `, async directory => {
      process.env.CODEX_HOME = directory;
      await writeFile(join(directory, "auth.json"), "synthetic-sign-in", { mode: 0o600 });
      await writeFile(join(directory, "config.toml"), '[mcp_servers.personal]\nurl = "https://personal.invalid"\n');
      const turn = await runCodexResponses(responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] }));
      expect(turn.output).toMatchObject([{ content: [{ text: "isolated" }] }]);
      expect(await readFile(join(directory, "config.toml"), "utf8")).toContain("personal.invalid");
      expect(await readFile(join(directory, "auth.json"), "utf8")).toBe("rotated-synthetic-sign-in");
      expect((await stat(join(directory, "auth.json"))).mode & 0o777).toBe(0o600);
    });
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("native replay filters history by turn ID and rejects reusing an old host call ID", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "turn/started", params: { turn: { id: "active" } } });
      send({ method: "rawResponseItem/completed", params: { turnId: "history", item: { type: "function_call", name: "not-allowed", call_id: "history-call", arguments: '{}' } } });
      send({ method: "rawResponseItem/completed", params: { turnId: "active", item: { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "eta-call", arguments: '{}' } } });
      send({ method: "rawResponse/completed", params: { turnId: "active", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
    }
  `, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [shipping] });
    expect((await runCodexResponses(request)).output).toMatchObject([{ call_id: "eta-call" }]);
    await expect(runCodexResponses(responsesRequestSchema.parse({ ...request, input: [
      { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "eta-call", arguments: '{}' },
      { type: "function_call_output", call_id: "eta-call", output: 'old result' }
    ] }))).rejects.toThrow("stale or duplicate");
  });
});

test("native items ignore late injection echoes until turn/started", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "OLD_MESSAGE" }] } } });
      send({ method: "rawResponseItem/completed", params: { item: { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "old-call", arguments: '{}' } } });
      send({ method: "turn/started", params: { turn: { id: "active" } } });
      send({ method: "rawResponseItem/completed", params: { turnId: "active", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "NEW_MESSAGE" }] } } });
      send({ method: "turn/completed", params: { turn: { id: "active", status: "completed" } } });
    }
  `, async () => {
    const items: unknown[] = [];
    const request = responsesRequestSchema.parse({ model: "test", tools: [shipping], input: [
      { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "old-call", arguments: '{}' },
      { type: "function_call_output", call_id: "old-call", output: 'old result' }
    ] });
    const turn = await runCodexResponses(request, { onItem: item => items.push(item) });
    expect(turn.output).toHaveLength(1);
    expect(JSON.stringify(turn.output)).toContain("NEW_MESSAGE");
    expect(JSON.stringify(turn.output)).not.toContain("OLD_MESSAGE");
    expect(items).toEqual(turn.output);
  }, false);
});

test("native SSE delivers completed items before turn completion", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "EARLY_ITEM" }] } } });
      const timer = setInterval(() => {
        try { readFileSync(transcript + ".continue"); } catch { return; }
        clearInterval(timer);
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }, 10);
    }
  `, async directory => {
    const request = responsesRequestSchema.parse({ model: "test", tools: [nativeSearch], input: "Delivery", stream: true });
    const response = await respondResponses(request, runCodex, undefined, undefined, runCodexResponses);
    const reader = response.body!.getReader();
    let body = "";
    const decoder = new TextDecoder();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (!body.includes("response.output_text.delta")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Stream ended before item");
            body += decoder.decode(chunk.value);
          }
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Native item was buffered until turn completion")), 2500); })
      ]);
      expect(body).toContain("EARLY_ITEM");
      expect(body).not.toContain("response.completed");
      await writeFile(join(directory, "requests.continue"), "continue");
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; body += decoder.decode(chunk.value); }
      expect(body).toContain("response.completed");
      expect((body.match(/response.output_text.delta/g) ?? [])).toHaveLength(2); // event name and JSON type
    } finally { clearTimeout(timeout); await reader.cancel(); }
  });
});

const malformedNativeItems = [
    { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "x", arguments: '{PRIVATE_ARGUMENT' },
    { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "x", arguments: '[]' },
    { type: "function_call", namespace: "tool_search", name: "tool_search_tool", call_id: "x", arguments: '{PRIVATE_ARGUMENT' },
    { type: "function_call", namespace: "other", name: "get_eta", call_id: "x", arguments: '{}' },
    { type: "tool_search_call", call_id: "x", execution: "server", arguments: {} },
    { type: "tool_search_output", call_id: "x", execution: "server", tools: [{ type: "web_search" }] },
    { type: "unexpected_model_item" }
  ];
test.each(malformedNativeItems)("native model protocol error %#: 502 without leaking raw JSON", async item => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: ${JSON.stringify(item)} } });
    }
  `, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch, shipping] });
    let failure: unknown;
    try { await runCodexResponses(request); } catch (error) { failure = error; }
    expect(errorStatus(failure)).toBe(502);
    expect(errorPayload(failure).category).toBe("upstream_error");
    expect(errorPayload(failure).message).not.toContain("PRIVATE_ARGUMENT");
  });
});

test("native history only calls declared or previously discovered function identities", () => {
  const call = { type: "function_call", namespace: "shipping", name: "get_eta", call_id: "eta", arguments: '{}' };
  const result = { type: "function_call_output", call_id: "eta", output: 'date' };
  const loaded = { type: "additional_tools", role: "developer", tools: [shipping] };
  const request = responsesRequestSchema.parse({ model: "test", tools: [nativeSearch], input: [call, result] });
  expect(() => nativePlan(request)).toThrow("undeclared native function");
  expect(() => nativePlan({ ...request, input: [call, result, loaded] })).toThrow("undeclared native function");
  expect(nativePlan({ ...request, input: [loaded, call, result] }).registry.size).toBe(1);
  expect(() => nativePlan({ ...request, input: [loaded, { ...call, namespace: "foreign" }, result] })).toThrow("undeclared native function");
  expect(() => nativePlan({ ...request, input: [loaded, { ...call, arguments: '{PRIVATE_ARGUMENT' }, result] })).toThrow("valid JSON");
});

test("exact raw usage wins over thread totals in either event order for ordinary chat", async () => {
  for (const totalFirst of [true, false]) await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      const total = () => send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 900, outputTokens: 99, totalTokens: 999 }, last: { inputTokens: 500, outputTokens: 50, totalTokens: 550 } } } });
      if (${totalFirst}) total();
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
      if (!${totalFirst}) total();
      send({ method: "item/agentMessage/delta", params: { delta: "done" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  `, async () => {
    expect((await runCodex(input)).usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
});

test("native request validation runs once through Responses and once for direct callers", async () => {
  await withCodex(nativeFixture, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] });
    const parsed = spyOn(nativeResponses, "nativePlan");
    try {
      await respondResponses(request, runCodex, undefined, undefined, runCodexResponses);
      expect(parsed).toHaveBeenCalledTimes(1);
      await runCodexResponses(request);
      expect(parsed).toHaveBeenCalledTimes(2);
    } finally { parsed.mockRestore(); }
  });
});

test("native protocol failures retain upstream classification inside SSE", async () => {
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      send({ method: "rawResponseItem/completed", params: { item: { type: "function_call", name: "unknown", call_id: "x", arguments: '{}' } } });
    }
  `, async () => {
    const request = responsesRequestSchema.parse({ model: "test", tools: [nativeSearch], input: "Delivery", stream: true });
    const response = await respondResponses(request, runCodex, undefined, undefined, runCodexResponses);
    const body = await response.text();
    expect(body).toContain('"category":"upstream_error"');
    expect(body).toContain("response.failed");
    expect(body).not.toContain("response.completed");
  });
});

test("native item consumer errors reject and clean up the owned session", async () => {
  await withCodex(nativeFixture, async () => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] });
    await expect(runCodexResponses(request, { onItem() { throw new Error("consumer failed"); } })).rejects.toThrow("consumer failed");
  });
});

test("native tool_choice none fails before RPC for fresh and loaded history, JSON and SSE", async () => {
  await withCodex(nativeFixture, async directory => {
    const loaded = [
      { role: "user", content: "Delivery" },
      { type: "tool_search_call", call_id: "old-search", execution: "client", arguments: { query: "shipping" } },
      { type: "tool_search_output", call_id: "old-search", execution: "client", status: "completed", tools: [shipping] }
    ];
    for (const input of ["Delivery", loaded]) {
      const request = responsesRequestSchema.parse({ model: "test", input, tools: [nativeSearch], tool_choice: "none" });
      await expect(runCodexResponses(request)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("tool_choice auto only") });
      for (const stream of [false, true]) {
        await expect(respondResponses({ ...request, stream }, runCodex, undefined, undefined, runCodexResponses)).rejects.toHaveProperty("status", 400);
      }
    }
    await expect(readFile(join(directory, "requests"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });
});

test.each([false, true])("native encrypted fields survive JSON/SSE case %# and history injection", async stream => {
  const items = [
    { type: "reasoning", id: "reasoning", summary: [], encrypted_content: "SYNTHETIC_REASONING" },
    { type: "tool_search_call", call_id: "search-native", execution: "client", arguments: { query: "shipping" }, encrypted_content: "SYNTHETIC_SEARCH" },
    { type: "function_call", call_id: "search-legacy", namespace: "tool_search", name: "tool_search_tool", arguments: '{"query":"shipping"}', encrypted_content: "SYNTHETIC_LEGACY_SEARCH" },
    { type: "function_call", call_id: "host", namespace: "shipping", name: "get_eta", arguments: '{"order_id":"123"}', encrypted_content: "SYNTHETIC_FUNCTION" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic delivery" }], encrypted_content: "SYNTHETIC_MESSAGE" }
  ];
  await withCodex(`
    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "test" } } });
    if (request.method === "thread/inject_items") {
      globalThis.replay = request.params.items.some(i => i.type === "function_call_output");
      send({ id: request.id, result: {} });
    }
    if (request.method === "turn/start") {
      send({ id: request.id, result: {} });
      const items = globalThis.replay ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Replayed" }] }] : ${JSON.stringify(items)};
      for (const item of items) send({ method: "rawResponseItem/completed", params: { item: { ...item, internal_chat_message_metadata_passthrough: { private: "NEVER_EXPOSE" } } } });
      send({ method: "rawResponse/completed", params: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  `, async directory => {
    const request = responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch, shipping], stream });
    const response = await respondResponses(request, runCodex, undefined, undefined, runCodexResponses);
    let output: any[];
    if (stream) {
      const body = await response.text();
      const events = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      output = events.find(event => event.type === "response.completed").response.output;
      expect(events.filter(event => event.type === "response.output_item.done").map(event => event.item.encrypted_content)).toEqual(items.map(item => item.encrypted_content));
      expect(body).not.toContain("NEVER_EXPOSE");
    } else output = (await response.json() as any).output;
    expect(output.map(item => item.encrypted_content)).toEqual(items.map(item => item.encrypted_content));
    expect(JSON.stringify(output)).not.toContain("NEVER_EXPOSE");
    const replay = responsesRequestSchema.parse({ ...request, input: [{ role: "user", content: "Delivery" }, ...output,
      ...["search-native", "search-legacy"].map(call_id => ({ type: "tool_search_output", call_id, execution: "client", status: "completed", tools: [shipping] })),
      { type: "function_call_output", id: "opaque-output-id", call_id: "host", output: "October 22" }
    ] });
    await runCodexResponses(replay);
    const requests = (await readFile(join(directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const injected = requests.filter(request => request.method === "thread/inject_items").at(-1).params.items;
    expect(injected.filter((item: any) => !item.encrypted_content).every((item: any) => item.id === undefined)).toBe(true);
    expect(injected.filter((item: any) => item.encrypted_content).map((item: any) => item.id)).toEqual(output.map(item => item.id));
    expect(injected.find((item: any) => item.type === "function_call_output")).toMatchObject({ call_id: "host", output: "October 22" });
    expect(injected.filter((item: any) => item.encrypted_content).map((item: any) => item.encrypted_content)).toEqual(items.map(item => item.encrypted_content));
  });
});
