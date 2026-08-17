import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeGrokSessions,
  detectGrok,
  modelsFromGrokInitialize,
  parseGrokModels,
  runGrok
} from "../src/grok.js";
import { chatRequestSchema } from "../src/protocol.js";

test("parses grok models output", () => {
  expect(parseGrokModels(`You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`)).toEqual([
    { id: "grok-4.6", name: "grok-4.6", reasoningEfforts: [] },
    { id: "grok-4.5", name: "grok-4.5", reasoningEfforts: [] }
  ]);
});

test("forwards advertised efforts in arrival order", () => {
  const incoming = [
    { value: "max" },
    { value: "made-up" },
    { value: "low" }
  ];
  const model = modelsFromGrokInitialize({
    _meta: {
      modelState: {
        availableModels: [{
          modelId: "any-model",
          name: "Any",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "low",
            reasoningEfforts: incoming
          }
        }]
      }
    }
  })[0];
  expect(model?.reasoningEfforts).toEqual(["max", "made-up", "low"]);
  expect(model?.defaultReasoningEffort).toBe("low");
});

const fakeGrok = `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("grok 1.0.3 (test)");
  process.exit(0);
}
if (process.argv.includes("models")) {
  console.log("Available models:\\n  * grok-4.6");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let mcpUrl;
let toolPrompt;
async function runLookup(message) {
  const callTool = (id, name, args) => fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name, arguments: args
    } })
  });
  const first = callTool(99, "lookup", { key: "alpha" });
  const second = callTool(100, "lookup_two", { key: "beta" });
  const call = { jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "use_tool",
    rawInput: { tool_name: "lookup", tool_input: { key: "alpha" } }
  } } };
  send(call);
  send(call);
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call",
    toolCallId: "call-2",
    title: "use_tool",
    rawInput: { tool_name: "lookup_two", tool_input: { key: "beta" } }
  } } });
  const payloads = await Promise.all([first, second].map(async (result) =>
    (await result).json()
  ));
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: payloads.map((payload) => payload.result.content[0].text).join("") }
  } } });
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id === 77 && message.result) {
    if (message.result.outcome.optionId !== "allow-once") process.exit(2);
    await runLookup(toolPrompt);
  } else if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      authMethods: [{ id: "cached_token" }],
      _meta: { modelState: { availableModels: [{
        modelId: "grok-4.6",
        name: "Grok 4.6",
        _meta: { supportsReasoningEffort: true, reasoningEfforts: [] }
      }] } }
    } });
  } else if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/new") {
    mcpUrl = message.params.mcpServers[0]?.url;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-1" } });
  } else if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text.includes("lookup")) {
      toolPrompt = message;
      send({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {
        toolCall: { title: "use_tool", rawInput: { tool_name: "lookup" } },
        options: [
          { kind: "allow_once", optionId: "allow-once" },
          { kind: "reject_once", optionId: "reject-once" }
        ]
      } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" }
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PONG" }
    } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

async function withFakeGrok(run: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-grok-test-"));
  const fake = join(directory, "grok");
  const original = process.env.AGENT_BRIDGE_GROK_COMMAND;
  await writeFile(fake, fakeGrok);
  await chmod(fake, 0o755);
  process.env.AGENT_BRIDGE_GROK_COMMAND = fake;
  try {
    await run();
  } finally {
    await closeGrokSessions();
    if (original == null) delete process.env.AGENT_BRIDGE_GROK_COMMAND;
    else process.env.AGENT_BRIDGE_GROK_COMMAND = original;
    await rm(directory, { recursive: true, force: true });
  }
}

test("runs a Grok ACP text turn and returns a host tool call", async () => {
  await withFakeGrok(async () => {
    const detected = await detectGrok();
    expect(detected.available).toBe(true);
    expect(detected.models.length).toBeGreaterThan(0);
    const deltas: Array<Record<string, unknown>> = [];
    expect(await runGrok(chatRequestSchema.parse({
      model: "grok-4.6",
      messages: [{ role: "user", content: "Reply PONG" }]
    }), { onDelta: (delta) => deltas.push(delta) })).toMatchObject({
      content: "PONG",
      finishReason: "stop"
    });
    expect(deltas).toEqual([
      { reasoning_content: "think" },
      { content: "PONG" }
    ]);

    const messages = [{ role: "user" as const, content: "Call lookup" }];
    const tools = [{
      type: "function" as const,
      function: { name: "lookup", parameters: { type: "object" } }
    }, {
      type: "function" as const,
      function: { name: "lookup_two", parameters: { type: "object" } }
    }];
    const append = (turn: Awaited<ReturnType<typeof runGrok>>, content: string) => {
      messages.push({ role: "assistant", content: "" } as never);
      (messages.at(-1) as Record<string, unknown>).tool_calls = turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }));
      messages.push({ role: "tool", tool_call_id: turn.toolCalls[0]!.id, content } as never);
    };
    const toolTurn = await runGrok(chatRequestSchema.parse({
      model: "grok-4.6",
      messages,
      tools
    }));
    expect(toolTurn).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: { key: "alpha" } }]
    });
    append(toolTurn, "RESULT1");
    const secondTurn = await runGrok(chatRequestSchema.parse({
      model: "grok-4.6",
      messages,
      tools
    }));
    expect(secondTurn).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-2", name: "lookup_two", arguments: { key: "beta" } }]
    });
    append(secondTurn, "RESULT2");
    expect(await runGrok(chatRequestSchema.parse({ model: "grok-4.6", messages, tools })))
      .toMatchObject({ content: "RESULT1RESULT2", finishReason: "stop" });
  });
}, 10_000);
