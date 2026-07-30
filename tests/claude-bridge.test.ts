import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import {
  createBridgeServer,
  discoverClaudeModels,
  runClaudeTurn,
  streamEventDelta
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

function capturingQuery(seen: { options?: any }) {
  return ({ options }: any) => {
    seen.options = options;
    return Object.assign(
      (async function* () {
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "ok" }] }
        };
      })(),
      { close() {} }
    );
  };
}

test("advertises the effort levels the SDK reports for each model", async () => {
  const models = await discoverClaudeModels({
    queryFn: () =>
      Object.assign((async function* () {})(), {
        close() {},
        supportedModels: async () => [
          // Out of order, with an unknown level.
          {
            value: "opus",
            resolvedModel: "claude-opus-5",
            supportsEffort: true,
            supportedEffortLevels: ["max", "nonsense", "low", "high"]
          },
          // Metadata predating the effort fields. Silence is not permission:
          // effort had no reproducible effect here when measured, so the list
          // stays empty rather than advertising a knob.
          { value: "haiku", resolvedModel: "claude-haiku-4-5" },
          {
            value: "opted-out",
            resolvedModel: "claude-opted-out",
            supportsEffort: false,
            supportedEffortLevels: ["low", "high"]
          }
        ]
      })
  });

  expect(
    models.map(({ id, reasoningEfforts }: any) => [id, reasoningEfforts])
  ).toEqual([
    ["claude-opus-5", ["low", "high", "max"]],
    ["claude-haiku-4-5", []],
    ["claude-opted-out", []]
  ]);
});

test("forwards a requested effort to the Claude SDK", async () => {
  const requested: { options?: any } = {};
  await runClaudeTurn(
    { ...input, reasoning_effort: "max" },
    { queryFn: capturingQuery(requested) }
  );
  expect(requested.options.effort).toBe("max");

  const unset: { options?: any } = {};
  await runClaudeTurn(input, { queryFn: capturingQuery(unset) });
  expect(unset.options).not.toHaveProperty("effort");
});

test("does not report reasoning when a model withholds its thinking text", () => {
  const thinking = (text: string) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text }
  });
  expect(streamEventDelta(thinking(""))).toBeUndefined();
  expect(streamEventDelta(thinking("weighing it"))).toEqual({
    reasoning_content: "weighing it"
  });
});

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
