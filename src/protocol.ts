import { z } from "zod";

const textContent = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() }))
]);
const functionCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() })
});
const toolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() })
  })
]);

export const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z.discriminatedUnion("role", [
          z.object({ role: z.literal("system"), content: textContent }),
          z.object({ role: z.literal("user"), content: textContent }),
          z.object({
            role: z.literal("assistant"),
            content: textContent.nullable().optional(),
            tool_calls: z.array(functionCall).optional()
          }),
          z.object({
            role: z.literal("tool"),
            content: textContent,
            tool_call_id: z.string(),
            name: z.string().optional()
          })
        ])
      )
      .min(1),
    tools: z
      .array(
        z.object({
          type: z.literal("function"),
          function: z.object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional()
          })
        })
      )
      .optional()
      .default([]),
    tool_choice: toolChoice.optional().default("auto"),
    stream: z.boolean().optional().default(false),
    reasoning_effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
  })
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatTool = ChatRequest["tools"][number];
export type ChatDelta = {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
};
export type ChatTurn = {
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: "stop" | "tool_calls";
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
};
export type ChatRunner = (
  input: ChatRequest,
  options?: { signal?: AbortSignal; onDelta?: (delta: ChatDelta) => void }
) => Promise<ChatTurn>;

function text(value: z.infer<typeof textContent>) {
  return typeof value === "string"
    ? value
    : value.map((part) => part.text).join("");
}

export function promptFor(messages: ChatRequest["messages"], choice: ChatRequest["tool_choice"]) {
  const transcript = messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: message.role,
        content: message.content == null ? "" : text(message.content),
        tool_calls: message.tool_calls ?? []
      };
    }
    if (message.role === "tool") {
      return {
        role: message.role,
        tool_call_id: message.tool_call_id,
        name: message.name,
        content: text(message.content)
      };
    }
    return { role: message.role, content: text(message.content) };
  });
  const instruction =
    choice === "required"
      ? "You must call one of the supplied functions."
      : typeof choice === "object"
        ? `You must call ${JSON.stringify(choice.function.name)}.`
        : choice === "none"
          ? "Do not call a function."
          : "Answer or call a supplied function as appropriate.";
  return [
    "Produce exactly one assistant turn for this OpenAI chat transcript.",
    instruction,
    "Preserve tool-call IDs and never invent a tool result.",
    JSON.stringify(transcript)
  ].join("\n\n");
}

export function selectedTools(input: ChatRequest) {
  const choice = input.tool_choice;
  if (choice === "none") return [];
  if (typeof choice === "object") {
    const selected = input.tools.filter(
      ({ function: tool }) => tool.name === choice.function.name
    );
    if (selected.length !== 1) throw new Error("Unknown tool_choice");
    return selected;
  }
  if (choice === "required" && !input.tools.length) {
    throw new Error("tool_choice is required but no tools were supplied");
  }
  return input.tools;
}

function validateChoice(input: ChatRequest, turn: ChatTurn) {
  const choice = input.tool_choice;
  const names = turn.toolCalls.map(({ name }) => name);
  if (choice === "none" && names.length) {
    throw new Error("Agent called a tool while tool_choice was none");
  }
  if (choice === "required" && !names.length) {
    throw new Error("Agent did not call a required tool");
  }
  if (
    typeof choice === "object" &&
    (!names.length || names.some((name) => name !== choice.function.name))
  ) {
    throw new Error(`Agent did not call ${choice.function.name}`);
  }
}

function usage(turn: ChatTurn) {
  return {
    prompt_tokens: turn.usage?.promptTokens ?? 0,
    completion_tokens: turn.usage?.completionTokens ?? 0,
    total_tokens: turn.usage?.totalTokens ?? 0,
    ...(turn.usage?.reasoningTokens == null
      ? {}
      : {
          completion_tokens_details: {
            reasoning_tokens: turn.usage.reasoningTokens
          }
        })
  };
}

function toolCalls(turn: ChatTurn) {
  return turn.toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }
  }));
}

export async function respond(
  input: ChatRequest,
  runner: ChatRunner,
  signal?: AbortSignal
) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!input.stream) {
    const turn = await runner(input, { signal });
    validateChoice(input, turn);
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.content,
            ...(turn.toolCalls.length ? { tool_calls: toolCalls(turn) } : {})
          },
          finish_reason: turn.finishReason
        }
      ],
      usage: usage(turn)
    });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (delta: ChatDelta, finishReason: ChatTurn["finishReason"] | null, turn?: ChatTurn) =>
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: input.model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
              ...(turn ? { usage: usage(turn) } : {})
            })}\n\n`
          )
        );
      send({ role: "assistant" } as ChatDelta, null);
      void runner(input, { signal, onDelta: (delta) => send(delta, null) })
        .then((turn) => {
          validateChoice(input, turn);
          send({}, turn.finishReason, turn);
        })
        .catch((error) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message: error instanceof Error ? error.message : "Bridge failed"
                }
              })}\n\n`
            )
          )
        )
        .finally(() => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
    }
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}
