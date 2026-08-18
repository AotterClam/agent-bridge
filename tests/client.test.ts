import { expect, test } from "bun:test";
import {
  createAgentBridgeClient
} from "../src/index.js";

const response = {
  adapters: [{
    id: "grok",
    name: "Grok Build",
    available: true,
    version: "1.0.0",
    error: null,
    capabilityToken: "grok-token",
    models: [{
      id: "grok-code-fast-1",
      name: "Grok Code Fast 1",
      reasoningEfforts: []
    }]
  }]
};

test("selects an adapter and refreshes capabilities", async () => {
  expect(() => createAgentBridgeClient({
    baseUrl: "https://bridge.example.com",
    controlToken: "do-not-send"
  })).toThrow("loopback HTTP URL");

  const requests: Array<{ url: string; authorization: string | null }> = [];
  const client = createAgentBridgeClient({
    baseUrl: "http://127.0.0.1:3457/",
    controlToken: "control-token",
    fetch: (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization")
      });
      return Response.json(response);
    }) as typeof fetch
  });

  const connection = await client.connection("grok");
  expect(connection).toMatchObject({
    baseUrl: "http://127.0.0.1:3457/v1",
    apiKey: "grok-token",
    adapter: { id: "grok" }
  });
  expect(requests).toEqual([{
    url: "http://127.0.0.1:3457/capabilities",
    authorization: "Bearer control-token"
  }]);

  const adapters = await client.adapters({ refresh: true });
  expect(adapters[0]?.id).toBe("grok");
  expect(requests[1]?.url).toBe(
    "http://127.0.0.1:3457/capabilities?refresh=1"
  );
});
