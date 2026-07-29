import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createBridgeServer } from "../src/claude-bridge.mjs";

const servers: Array<ReturnType<typeof createBridgeServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((bridge) => bridge.close()));
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
