import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeCodexSessions,
  codexEnvironment,
  codexTurnTimeoutMs,
  completedCodexTurn,
  recoverTextToolCall,
  runCodex,
  toCodexCompatibleSchema
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

test("replays Codex tool steps with the current tool list", async () => {
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
    const prompt = message.params.input[0].text;
    if (message.params.input.some((part) => part.type === "image")) {
      send({ method: "item/agentMessage/delta", params: { delta: "vision" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    } else if (prompt.includes("Do not call a function.")) {
      send({ method: "item/agentMessage/delta", params: { delta: "finalized" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    } else if (prompt.includes("second result")) {
      send({ method: "item/agentMessage/delta", params: { delta: "finished" } });
      send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    } else if (prompt.includes("first result")) {
      send({ id: 61, method: "item/tool/call", params: {
        callId: "call-2", tool: "lookup_two", arguments: { key: "beta" }
      } });
    } else {
      send({ id: 60, method: "item/tool/call", params: {
        callId: "call-1", tool: "lookup_one", arguments: { key: "alpha" }
      } });
    }
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
    const first = await runCodex(chatRequestSchema.parse({
      model: "test",
      messages,
      tools: [tools[0]]
    }));
    expect(first.toolCalls).toMatchObject([{ id: "call-1", name: "lookup_one" }]);
    appendToolResult(messages, first, "first result");

    const second = await runCodex(chatRequestSchema.parse({
      model: "test",
      messages,
      tools: [tools[1]]
    }));
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

    expect(await runCodex(chatRequestSchema.parse({
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: "data:image/png;base64,iVBORw0KGgo=" }
        ]
      }]
    }))).toMatchObject({ content: "vision", finishReason: "stop" });
  } finally {
    await closeCodexSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("collapses a homogeneous, length-pinned tuple to a single schema", () => {
  expect(toCodexCompatibleSchema({
    type: "object",
    properties: {
      coords: {
        type: "array",
        items: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }],
        minItems: 4,
        maxItems: 4
      }
    }
  })).toEqual({
    type: "object",
    properties: {
      coords: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        maxItems: 4
      }
    }
  });

  expect(toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "boolean" }, { type: "boolean" }],
    minItems: 2,
    additionalItems: false
  })).toEqual({
    type: "array",
    items: { type: "boolean" },
    minItems: 2,
    maxItems: 2
  });

  expect(toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "string" }],
    minItems: 1,
    maxItems: 1
  })).toEqual({
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 1
  });

  expect(toCodexCompatibleSchema({
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      score: {
        anyOf: [
          { type: "array", items: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 },
          { type: "null" }
        ]
      }
    },
    required: ["tags"]
  })).toEqual({
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      score: {
        anyOf: [
          { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          { type: "null" }
        ]
      }
    },
    required: ["tags"]
  });

  expect(toCodexCompatibleSchema("string")).toBe("string");
  expect(toCodexCompatibleSchema(null)).toBeNull();
  expect(toCodexCompatibleSchema(undefined)).toBeUndefined();
  expect(toCodexCompatibleSchema([1, 2, 3])).toEqual([1, 2, 3]);
  expect(toCodexCompatibleSchema({ type: "object", properties: {} }))
    .toEqual({ type: "object", properties: {} });

  const metadata = { items: [{ type: "string" }, { type: "number" }] };
  expect(toCodexCompatibleSchema({
    type: "object",
    default: metadata,
    examples: [metadata],
    const: metadata
  })).toEqual({ type: "object", default: metadata, examples: [metadata], const: metadata });
});

test("fails fast instead of guessing at a tuple rewrite that isn't provably safe", () => {
  expect(() => toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2
  })).toThrow('tuple-form "items"');

  expect(() => toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "number" }, { type: "number" }]
  })).toThrow('tuple-form "items"');

  expect(() => toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "number" }, { type: "number" }],
    minItems: 0,
    maxItems: 2
  })).toThrow('tuple-form "items"');

  expect(() => toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "number" }, { type: "number" }],
    minItems: 2,
    additionalItems: { type: "string" }
  })).toThrow('tuple-form "items"');

  expect(() => toCodexCompatibleSchema({
    type: "array",
    items: [{ type: "number" }, { type: "number" }],
    minItems: 2,
    maxItems: 1,
    additionalItems: false
  })).toThrow('tuple-form "items"');

  expect(() => toCodexCompatibleSchema({
    type: "object",
    properties: {
      coords: { type: "array", items: [{ type: "string" }, { type: "number" }] }
    }
  })).toThrow('tuple-form "items"');
});

test("names the offending tool and never dispatches an unsupported schema to codex app-server", async () => {
  // Regression test for the review finding on the first version of this fix: a
  // heterogeneous or open-ended tuple must fail the turn locally — naming the tool —
  // instead of either being silently mistranslated or forwarded to codex app-server.
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-test-"));
  const fakeCodex = join(directory, "codex");
  const capturedThreadStart = join(directory, "thread-start.json");
  const originalCommand = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") {
    writeFileSync(${JSON.stringify(capturedThreadStart)}, JSON.stringify(message.params));
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
  }
});
`);
  await chmod(fakeCodex, 0o755);
  process.env.AGENT_BRIDGE_CODEX_COMMAND = fakeCodex;

  try {
    let caught: unknown;
    try {
      await runCodex(chatRequestSchema.parse({
        model: "test",
        messages: [{ role: "user", content: "set the region" }],
        tools: [{
          type: "function",
          function: {
            name: "set_media_region",
            parameters: {
              type: "object",
              properties: {
                coords: { type: "array", items: [{ type: "string" }, { type: "number" }] }
              }
            }
          }
        }]
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Codex tool "set_media_region"');
    expect((caught as Error).message).toContain("unsupported parameter schema");

    // The capture file is only ever written by the fake codex's thread/start handler, so
    // its absence proves the request never reached the app-server RPC layer.
    await expect(readFile(capturedThreadStart, "utf8")).rejects.toThrow();
  } finally {
    await closeCodexSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("sends a codex-compatible dynamicTools schema over the wire for a length-pinned tuple", async () => {
  // Regression test for: codex app-server rejected the whole thread/start request with
  // `dynamic tool input schema is not supported for set_media_region: invalid type: map,
  // expected a string` whenever a tool's JSON Schema used tuple-form `items` (an array of
  // per-position schemas) — the exact shape zod-to-json-schema emits for a plain zod
  // tuple. This spawns a fake codex that captures the raw thread/start params to a file,
  // so the assertion covers what actually goes out over the app-server RPC wire — not
  // just the pure toCodexCompatibleSchema unit above.
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-test-"));
  const fakeCodex = join(directory, "codex");
  const capturedThreadStart = join(directory, "thread-start.json");
  const originalCommand = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") {
    writeFileSync(${JSON.stringify(capturedThreadStart)}, JSON.stringify(message.params));
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "done" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
  await chmod(fakeCodex, 0o755);
  process.env.AGENT_BRIDGE_CODEX_COMMAND = fakeCodex;

  try {
    await runCodex(chatRequestSchema.parse({
      model: "test",
      messages: [{ role: "user", content: "set the region" }],
      tools: [{
        type: "function",
        function: {
          name: "set_media_region",
          parameters: {
            type: "object",
            properties: {
              coords: {
                type: "array",
                items: [
                  { type: "number" },
                  { type: "number" },
                  { type: "number" },
                  { type: "number" }
                ],
                minItems: 4,
                maxItems: 4
              }
            }
          }
        }
      }]
    }));

    const params = JSON.parse(await readFile(capturedThreadStart, "utf8"));
    expect(params.dynamicTools).toEqual([{
      type: "function",
      name: "set_media_region",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          coords: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4
          }
        }
      }
    }]);
  } finally {
    await closeCodexSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
