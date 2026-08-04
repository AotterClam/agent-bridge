import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeCodexSessions,
  codexEnvironment,
  codexTurnTimeoutMs,
  completedCodexTurn,
  recoverTextToolCall,
  runCodex
} from "../src/codex.js";
import {
  chatRequestSchema,
  respond,
  selectedTools,
  type ChatRunner,
  type ChatTurn
} from "../src/protocol.js";

function appendToolResult(
  messages: Array<Record<string, unknown>>,
  turn: ChatTurn,
  content: string
) {
  const call = turn.toolCalls[0]!;
  messages.push(
    { role: "assistant", content: turn.content, tool_calls: [{
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }] },
    { role: "tool", tool_call_id: call.id, content }
  );
}

test("uses the configured Codex home while isolating the turn", () => {
  const original = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "/tmp/shared-codex";
    expect(codexEnvironment("/tmp/turn")).toMatchObject({
      HOME: "/tmp/turn",
      CODEX_HOME: "/tmp/shared-codex"
    });

    delete process.env.CODEX_HOME;
    expect(codexEnvironment("/tmp/turn").CODEX_HOME).toBe(join(homedir(), ".codex"));
  } finally {
    if (original == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});

test("validates Codex turn completion and timeout configuration", () => {
  expect(completedCodexTurn("done", [])).toMatchObject({
    content: "done",
    finishReason: "stop"
  });
  expect(() => completedCodexTurn("", [])).toThrow(
    "Codex bridge returned no assistant turn"
  );
  expect(codexTurnTimeoutMs(undefined)).toBe(300_000);
  expect(codexTurnTimeoutMs("450000")).toBe(450_000);
  expect(() => codexTurnTimeoutMs("0")).toThrow(
    "AGENT_BRIDGE_CODEX_TIMEOUT_MS must be a positive integer"
  );
});

test("recovers a registered tool call emitted as the whole assistant text", () => {
  const tools = [{
    type: "function" as const,
    function: { name: "inspect_catalog", parameters: { type: "object" } }
  }];
  const content = JSON.stringify({
    name: "inspect_catalog",
    arguments: JSON.stringify({ dataset: "dim_partner" })
  });

  expect(recoverTextToolCall(content, tools)).toMatchObject({
    name: "inspect_catalog",
    arguments: { dataset: "dim_partner" }
  });
  expect(completedCodexTurn(content, [], undefined, tools)).toMatchObject({
    content: null,
    finishReason: "tool_calls",
    toolCalls: [{ name: "inspect_catalog" }]
  });
  expect(recoverTextToolCall(
    '{"name":"revenue","arguments":{"unit":"TWD"}}',
    tools
  )).toBeUndefined();
});

const namedChoice = chatRequestSchema.parse({
  model: "test",
  messages: [{ role: "user", content: "Call the tool" }],
  tools: [{
    type: "function",
    function: { name: "lookup", parameters: { type: "object" } }
  }],
  tool_choice: { type: "function", function: { name: "lookup" } }
});

const ignoresChoice: ChatRunner = async () => ({
  content: "I could not call the tool.",
  toolCalls: [],
  finishReason: "stop"
});

test("returns a model turn that does not follow tool_choice", async () => {
  const response = await respond(namedChoice, ignoresChoice);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    choices: [{ message: { content: "I could not call the tool." } }]
  });

  const streamed = await respond({ ...namedChoice, stream: true }, ignoresChoice);
  const body = await streamed.text();
  expect(body).not.toContain('"error"');
  expect(body).toContain("data: [DONE]");
});

test("still rejects an unknown named tool before execution", () => {
  expect(() => selectedTools({
    ...namedChoice,
    tool_choice: { type: "function", function: { name: "missing" } }
  })).toThrow("Unknown tool_choice");
});

test("continues dynamic tool calls in the same Codex turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-test-"));
  const fakeCodex = join(directory, "codex");
  const originalCommand = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    if (message.params.input[0].text.includes("Do not call a function.")) {
      send({ method: "item/agentMessage/delta", params: { delta: "finalized" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    } else {
      send({ id: 60, method: "item/tool/call", params: {
        callId: "call-1", tool: "lookup_one", arguments: { key: "alpha" }
      } });
    }
  } else if (message.id === 60 && message.result?.contentItems?.[0]?.text === "first result") {
    send({ id: 61, method: "item/tool/call", params: {
      callId: "call-2", tool: "lookup_two", arguments: { key: "beta" }
    } });
  } else if (message.id === 61 && message.result?.contentItems?.[0]?.text === "second result") {
    send({ method: "item/agentMessage/delta", params: { delta: "finished" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
  await chmod(fakeCodex, 0o755);
  process.env.AGENT_BRIDGE_CODEX_COMMAND = fakeCodex;

  const tools = ["lookup_one", "lookup_two"].map((name) => ({
    type: "function" as const,
    function: { name, parameters: { type: "object" } }
  }));
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "Use both lookups" }
  ];

  try {
    const first = await runCodex(chatRequestSchema.parse({ model: "test", messages, tools }));
    expect(first.toolCalls).toMatchObject([{ id: "call-1", name: "lookup_one" }]);
    appendToolResult(messages, first, "first result");

    const second = await runCodex(chatRequestSchema.parse({ model: "test", messages, tools }));
    expect(second.toolCalls).toMatchObject([{ id: "call-2", name: "lookup_two" }]);
    appendToolResult(messages, second, "second result");

    expect(await runCodex(chatRequestSchema.parse({ model: "test", messages, tools })))
      .toMatchObject({ content: "finished", finishReason: "stop" });

    const finalizationMessages: Array<Record<string, unknown>> = [
      { role: "user", content: "Start another lookup" }
    ];
    const pending = await runCodex(chatRequestSchema.parse({
      model: "test",
      messages: finalizationMessages,
      tools
    }));
    appendToolResult(finalizationMessages, pending, "result");
    expect(await runCodex(chatRequestSchema.parse({
      model: "test",
      messages: finalizationMessages,
      tools,
      tool_choice: "none"
    }))).toMatchObject({ content: "finalized", finishReason: "stop" });
  } finally {
    await closeCodexSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
