import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import {
  createBridgeServer,
  runClaudeTurn
} from "../src/claude-bridge.mjs";

const servers: Array<ReturnType<typeof createBridgeServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((bridge) => bridge.close()));
});

const input = {
  model: "claude-sonnet",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  tool_choice: "auto"
};

function abortedQuery({ options }: any) {
  return Object.assign(
    (async function* () {
      await new Promise<void>((resolve) => {
        if (options.abortController.signal.aborted) resolve();
        else options.abortController.signal.addEventListener("abort", resolve, {
          once: true
        });
      });
      throw new Error("Claude Code process aborted by user");
    })(),
    { close() {} }
  );
}

test("reports a turn timeout instead of a user abort", async () => {
  await expect(
    runClaudeTurn(input, { queryFn: abortedQuery, timeoutMs: 5 })
  ).rejects.toThrow("Claude turn timed out after 5 ms.");
});

test("distinguishes an upstream cancellation from a timeout", async () => {
  const controller = new AbortController();
  const turn = runClaudeTurn(input, {
    queryFn: abortedQuery,
    signal: controller.signal,
    timeoutMs: 60_000
  });
  controller.abort();
  await expect(turn).rejects.toThrow("Claude turn cancelled.");
});

test("keeps the lumen-next OpenAI streaming contract", async () => {
  const bridge = createBridgeServer({
    token: "test-token",
    listModels: async () => [
      {
        id: "claude-sonnet",
        name: "claude-sonnet",
        description: "Sonnet"
      }
    ],
    queryFn: () =>
      Object.assign(
        (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hello" }
            }
          };
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "hello" }] }
          };
        })(),
        { close() {} }
      )
  });
  servers.push(bridge);
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const address = bridge.server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const headers = {
    authorization: "Bearer test-token",
    "content-type": "application/json"
  };

  const models = await fetch(`${baseUrl}/models`, { headers });
  expect(models.status).toBe(200);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: true
    })
  });
  const text = await response.text();
  expect(text).toContain('"content":"hello"');
  expect(text).toContain('"finish_reason":"stop"');
  expect(text).toContain("data: [DONE]");
});
