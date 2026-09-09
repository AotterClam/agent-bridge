// Opt-in: uses the signed-in Codex account for two model turns. No real tools run.
import assert from "node:assert/strict";
import { closeCodexSessions, discoverCodexModels, runCodex } from "../src/codex.ts";
import { chatRequestSchema } from "../src/protocol.ts";

const models = await discoverCodexModels();
const model = process.env.AGENT_BRIDGE_CODEX_SMOKE_MODEL ?? models[0]?.id;
assert(models.some(item => item.id === model), "Smoke model must be in the account catalog");
console.log("Account catalog:", models.map(item => item.id).join(", "));
const input = chatRequestSchema.parse({ model, reasoning_effort: "low",
  messages: [{ role: "user", content: "Look up alpha and beta, then report both returned strings. These are independent: submit both lookups together before receiving either result." }],
  tools: [{ type: "function", function: { name: "lookup", description: "Dummy host lookup; independent keys can be requested together.",
    parameters: { type: "object", properties: { key: { type: "string", enum: ["alpha", "beta"] } }, required: ["key"], additionalProperties: false } } }],
  tool_choice: "required"
});
try {
  const first = await runCodex(input);
  assert.deepEqual(first.toolCalls.map(call => call.arguments.key).sort(), ["alpha", "beta"]);
  assert.equal(new Set(first.toolCalls.map(call => call.id)).size, 2);
  assert(first.toolCalls.every(call => call.name === "lookup"));
  const assistant = { role: "assistant", content: first.content, tool_calls: first.toolCalls.map(call => ({
    id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) }
  })) };
  const outputs = first.toolCalls.toReversed().map(call => ({ role: "tool", tool_call_id: call.id,
    content: call.arguments.key === "alpha" ? "ALPHA_OK" : "BETA_OK" }));
  const second = await runCodex(chatRequestSchema.parse({ ...input, tool_choice: "none", messages: [...input.messages, assistant, ...outputs] }));
  assert(second.content?.includes("ALPHA_OK"));
  assert(second.content?.includes("BETA_OK"));
  assert.equal(second.toolCalls.length, 0);
  console.log("PASS: two host calls in one response, distinct IDs, reversed outputs replayed successfully.");
} finally {
  await closeCodexSessions();
}
