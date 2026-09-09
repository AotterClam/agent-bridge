import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCodexSessions, codexError, discoverCodexModels, runCodex } from "../src/codex.js";
import { chatRequestSchema, errorPayload, errorStatus, respond, type ChatDelta } from "../src/protocol.js";
import { respondResponses, responsesRequestSchema } from "../src/responses.js";

// Uses real stdio/process cleanup, but never a real account or model request.
async function withCodex(script: string, check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "codex-regression-"));
  const command = join(directory, "codex.mjs");
  const previous = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
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
