import { nativePlan } from "../src/native-responses.js";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCodexSessions, codexError, discoverCodexModels, runCodex, runCodexResponses } from "../src/codex.js";
import { chatRequestSchema, errorPayload, errorStatus, respond, type ChatDelta } from "../src/protocol.js";
import { respondResponses, responsesRequestSchema, toChatRequest } from "../src/responses.js";

// Uses real stdio/process cleanup, but never a real account or model request.
async function withCodex(script: string, check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "codex-regression-"));
  const command = join(directory, "codex.mjs");
  const previous = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const transcript = ${JSON.stringify(join(directory, "requests"))};
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const request = JSON.parse(line);
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
    expect(text).not.toContain('response.output_item.done');
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
    await expect(runCodexResponses(responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [shipping] }))).rejects.toHaveProperty("status", 400);
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
    expect(requests.find(r => r.method === "thread/inject_items").params.items[0].tools[0]).toEqual(custom);
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
        send({ id: request.id, result: {} });
        send({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "isolated" }] } } });
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
    `, async directory => {
      process.env.CODEX_HOME = directory;
      await writeFile(join(directory, "auth.json"), "synthetic-sign-in");
      await writeFile(join(directory, "config.toml"), '[mcp_servers.personal]\nurl = "https://personal.invalid"\n');
      const turn = await runCodexResponses(responsesRequestSchema.parse({ model: "test", input: "Delivery", tools: [nativeSearch] }));
      expect(turn.output).toMatchObject([{ content: [{ text: "isolated" }] }]);
      expect(await readFile(join(directory, "config.toml"), "utf8")).toContain("personal.invalid");
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
