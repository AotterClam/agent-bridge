import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexEnvironment } from "../src/codex.js";
import {
  chatRequestSchema,
  respond,
  selectedTools,
  type ChatRunner
} from "../src/protocol.js";

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
