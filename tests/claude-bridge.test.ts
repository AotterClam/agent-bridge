import { expect, test } from "bun:test";
import {
  createClaudeRunner,
  discoverClaudeModels,
  runClaudeTurn,
  streamEventDelta
} from "../src/claude-bridge.mjs";
import {
  chatRequestSchema,
  respond,
  type ChatDelta,
  type ChatRunner
} from "../src/protocol.js";

const input = {
  model: "claude-sonnet",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  tool_choice: "auto"
};

const ARTIFACT_ID = "0d92c89d-2e5b-4f7e-934b-421f24785566";
const artifactTool = {
  type: "function" as const,
  function: {
    name: "lookup",
    parameters: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          format: "uuid",
          pattern:
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        }
      },
      required: ["artifactId"],
      additionalProperties: false
    }
  }
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

test("sends image and PDF bytes as Claude content blocks", async () => {
  let userMessage: any;
  const queryFn = ({ prompt }: any) => Object.assign(
    (async function* () {
      for await (const message of prompt) userMessage = message;
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "seen" }] }
      };
    })(),
    { close() {} }
  );
  await runClaudeTurn(chatRequestSchema.parse({
    model: "claude-sonnet",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image_url", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        {
          type: "file",
          file: {
            filename: "tiny.pdf",
            file_data: Buffer.from("%PDF-1.4\n").toString("base64")
          }
        }
      ]
    }]
  }), { queryFn });
  expect(userMessage.message.content).toMatchObject([
    { type: "text" },
    { type: "image", source: { type: "base64", media_type: "image/png" } },
    {
      type: "document",
      title: "tiny.pdf",
      source: { type: "base64", media_type: "application/pdf" }
    }
  ]);
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
  const runner = createClaudeRunner({
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
  const response = await respond(
    chatRequestSchema.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: true
    }),
    runner as ChatRunner
  );
  const text = await response.text();
  expect(text).toContain('"content":"hello"');
  expect(text).toContain('"finish_reason":"stop"');
  expect(text).toContain("data: [DONE]");
});

test("passes the caller's JSON Schema unchanged to Claude", async () => {
  let listedSchema: unknown;
  await runClaudeTurn(
    chatRequestSchema.parse({
      ...input,
      tools: [artifactTool]
    }),
    {
      queryFn: ({ options }: any) =>
        Object.assign(
          (async function* () {
            const listTools =
              options.mcpServers.openai.instance.server._requestHandlers.get(
                "tools/list"
              );
            const listed = await listTools(
              { method: "tools/list", params: {} },
              {}
            );
            listedSchema = listed.tools[0].inputSchema;
            yield {
              type: "assistant",
              parent_tool_use_id: null,
              message: { content: [{ type: "text", text: "ok" }] }
            };
          })(),
          { close() {} }
        )
    }
  );
  expect(listedSchema).toEqual(artifactTool.function.parameters);
});

test("keeps a streamed UUID tool argument valid JSON", async () => {
  const runner = createClaudeRunner({
    queryFn: () =>
      Object.assign(
        (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_uuid",
                name: "mcp__openai__lookup",
                input: {}
              }
            }
          };
          for (const partial_json of [
            '{"artifactId":',
            `"${ARTIFACT_ID}`,
            '"}'
          ]) {
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json }
              }
            };
          }
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "toolu_uuid",
                  name: "mcp__openai__lookup",
                  input: { artifactId: ARTIFACT_ID }
                }
              ]
            }
          };
        })(),
        { close() {} }
      )
  });
  const response = await respond(
    chatRequestSchema.parse({
      ...input,
      stream: true,
      tools: [artifactTool]
    }),
    runner as ChatRunner
  );
  const chunks = (await response.text())
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: {"))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  const argumentsJson = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
    .map((call) => call.function?.arguments ?? "")
    .join("");
  expect(JSON.parse(argumentsJson)).toEqual({ artifactId: ARTIFACT_ID });
});

test("re-emits content and tool calls the SDK resolved without streaming", async () => {
  const runner = createClaudeRunner({
    queryFn: () =>
      Object.assign(
        (async function* () {
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              content: [
                { type: "text", text: "calling" },
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "mcp__openai__lookup",
                  input: { artifactId: ARTIFACT_ID }
                }
              ]
            }
          };
        })(),
        { close() {} }
      )
  });
  const deltas: unknown[] = [];
  const turn = await runner(
    chatRequestSchema.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      tools: [artifactTool]
    }),
    { onDelta: (delta: ChatDelta) => deltas.push(delta) }
  );
  expect(turn.toolCalls).toEqual([
    {
      id: "toolu_1",
      name: "lookup",
      arguments: { artifactId: ARTIFACT_ID }
    }
  ]);
  expect(turn.finishReason).toBe("tool_calls");
  expect(JSON.stringify(deltas)).toContain('"content":"calling"');
  expect(JSON.stringify(deltas)).toContain('"name":"lookup"');
});
