import { expect, test } from "bun:test";
import type { ChatRunner, ChatTurn } from "../src/protocol.js";
import {
  respondResponses,
  responsesRequestSchema,
  toChatRequest
} from "../src/responses.js";

function request(overrides: Record<string, unknown> = {}) {
  return responsesRequestSchema.parse({
    model: "test-model",
    input: "hello",
    ...overrides
  });
}

async function events(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data!.slice("data: ".length)) as Record<string, any>;
    });
}

test("translates a string input with instructions and tools", () => {
  const chat = toChatRequest(
    request({
      instructions: "Be terse.",
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Find a row",
          parameters: { type: "object", properties: {} },
          strict: true
        }
      ],
      tool_choice: { type: "function", name: "lookup" },
      reasoning: { effort: "low" }
    })
  );
  expect(chat.messages).toEqual([
    { role: "system", content: "Be terse." },
    { role: "user", content: "hello" }
  ]);
  expect(chat.tools[0]!.function.name).toBe("lookup");
  expect(chat.tool_choice).toEqual({
    type: "function",
    function: { name: "lookup" }
  });
  expect(chat.reasoning_effort).toBe("low");
});

test("replays function_call items as one assistant message per burst", () => {
  const chat = toChatRequest(
    request({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "call_1", name: "a", arguments: "{}" },
        { type: "function_call", call_id: "call_2", name: "b", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "function_call_output", call_id: "call_2", output: [{ type: "output_text", text: "fine" }] },
        { type: "reasoning", summary: [] },
        { role: "assistant", content: [{ type: "output_text", text: "done" }] }
      ]
    })
  );
  expect(chat.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant"
  ]);
  const assistant = chat.messages[1]!;
  expect(
    assistant.role === "assistant" && assistant.tool_calls?.map((c) => c.id)
  ).toEqual(["call_1", "call_2"]);
  const second = chat.messages[3]!;
  expect(second.role === "tool" && second.content).toBe("fine");
});

test("rejects controls the adapters cannot honor", () => {
  for (const overrides of [
    { temperature: 0.2 },
    { max_output_tokens: 100 },
    { top_p: 0.5 },
    { max_tool_calls: 2 },
    { parallel_tool_calls: false },
    { background: true },
    { truncation: "auto" },
    { text: { format: { type: "json_schema", schema: {} } } },
    { include: ["reasoning.encrypted_content"] },
    { presence_penalty: 0.5 },
    { frequency_penalty: -0.3 },
    { service_tier: "flex" },
    { reasoning: { summary: "detailed" } },
    { store: true },
    { stream_options: { include_usage: true } },
    { safety_identifier: "user-42" },
    { prompt_cache_key: "cache-key-9" }
  ]) {
    expect(() => toChatRequest(request(overrides))).toThrow(
      /does not support/
    );
    try {
      toChatRequest(request(overrides));
    } catch (error) {
      expect((error as { status?: number }).status).toBe(400);
    }
  }
  // Values equal to our actual behavior stay accepted.
  expect(() =>
    toChatRequest(
      request({
        temperature: null,
        parallel_tool_calls: true,
        truncation: "disabled",
        text: { format: { type: "text" } },
        include: [],
        presence_penalty: 0,
        frequency_penalty: 0,
        service_tier: "auto"
      })
    )
  ).not.toThrow();
});

test("echoes metadata", async () => {
  const runner: ChatRunner = async () => ({
    content: "ok",
    toolCalls: [],
    finishReason: "stop"
  });
  const response = await respondResponses(
    request({
      metadata: { task: "t-1" }
    }),
    runner
  );
  const payload = (await response.json()) as Record<string, any>;
  expect(payload.metadata).toEqual({ task: "t-1" });
});

test("tags translation failures as 400s", () => {
  try {
    toChatRequest(request({ input: [] }));
    throw new Error("expected a validation failure");
  } catch (error) {
    expect((error as { status?: number }).status).toBe(400);
  }
});

test("rejects stateful and unsupported requests loudly", () => {
  expect(() =>
    toChatRequest(request({ previous_response_id: "resp_1" }))
  ).toThrow("stateless");
  expect(() =>
    toChatRequest(request({ tools: [{ type: "web_search" }] }))
  ).toThrow("Only function tools");
  expect(() =>
    toChatRequest(
      request({
        input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }]
      })
    )
  ).toThrow('content part "input_image"');
  expect(() =>
    toChatRequest(request({ input: [{ type: "item_reference", id: "x" }] }))
  ).toThrow('input item "item_reference"');
  expect(() => request({ conversation: "conv_1" })).toThrow();
});

test("returns a completed response with message and function_call items", async () => {
  const runner: ChatRunner = async () => ({
    content: "hi there",
    toolCalls: [{ id: "call_9", name: "lookup", arguments: { q: 1 } }],
    finishReason: "tool_calls",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
  });
  const response = await respondResponses(request(), runner);
  const payload = (await response.json()) as Record<string, any>;
  expect(payload.object).toBe("response");
  expect(payload.status).toBe("completed");
  expect(payload.store).toBe(false);
  expect(payload.output.map((item: any) => item.type)).toEqual([
    "message",
    "function_call"
  ]);
  expect(payload.output[0].content[0].text).toBe("hi there");
  expect(payload.output[1]).toMatchObject({
    call_id: "call_9",
    name: "lookup",
    arguments: '{"q":1}'
  });
  expect(payload.usage).toMatchObject({
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15
  });
  // Open Responses ResponseResource required fields.
  expect(typeof payload.completed_at).toBe("number");
  expect(payload).toMatchObject({
    parallel_tool_calls: true,
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    max_tool_calls: null,
    truncation: "disabled",
    service_tier: "default",
    safety_identifier: null,
    prompt_cache_key: null,
    background: false
  });
});

test("terminates the stream with a [DONE] marker", async () => {
  const runner: ChatRunner = async () => ({
    content: "hi",
    toolCalls: [],
    finishReason: "stop"
  });
  const response = await respondResponses(request({ stream: true }), runner);
  const text = await response.text();
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("streams semantic events across reasoning, text, and tool calls", async () => {
  const runner: ChatRunner = async (_input, options) => {
    options?.onDelta?.({ reasoning_content: "thinking" });
    options?.onDelta?.({ content: "hel" });
    options?.onDelta?.({ content: "lo" });
    options?.onDelta?.({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":' }
        }
      ]
    });
    options?.onDelta?.({
      tool_calls: [{ index: 0, function: { arguments: "1}" } }]
    });
    return {
      content: "hello",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: 1 } }],
      finishReason: "tool_calls"
    } satisfies ChatTurn;
  };
  const parsed = await events(
    await respondResponses(request({ stream: true }), runner)
  );
  expect(parsed.map((event) => event.type)).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed"
  ]);
  expect(parsed.map((event) => event.sequence_number)).toEqual(
    parsed.map((_event, index) => index)
  );
  const completed = parsed.at(-1)!;
  expect(completed.response.status).toBe("completed");
  expect(completed.response.output.map((item: any) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call"
  ]);
  expect(completed.response.output[1].content[0].text).toBe("hello");
  expect(completed.response.output[2].arguments).toBe('{"q":1}');
});

test("re-emits content and calls the adapter resolved without streaming", async () => {
  const runner: ChatRunner = async () => ({
    content: "quiet",
    toolCalls: [{ id: "call_2", name: "b", arguments: {} }],
    finishReason: "tool_calls"
  });
  const parsed = await events(
    await respondResponses(request({ stream: true }), runner)
  );
  const types = parsed.map((event) => event.type);
  expect(types).toContain("response.output_text.delta");
  expect(types).toContain("response.function_call_arguments.done");
  const completed = parsed.at(-1)!;
  expect(completed.response.output.map((item: any) => item.type)).toEqual([
    "message",
    "function_call"
  ]);
});

test("reports runner failure as response.failed", async () => {
  const runner: ChatRunner = async () => {
    throw new Error("boom");
  };
  const parsed = await events(
    await respondResponses(request({ stream: true }), runner)
  );
  const failed = parsed.at(-1)!;
  expect(failed.type).toBe("response.failed");
  expect(failed.response.status).toBe("failed");
  expect(failed.response.error.message).toBe("boom");
});
