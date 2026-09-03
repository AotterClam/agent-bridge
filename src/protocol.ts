import { z } from "zod";

const textPart = z.object({ type: z.literal("text"), text: z.string() });
const imageUrlPart = z.object({
  type: z.literal("image_url"),
  image_url: z.union([
    z.string(),
    z.object({
      url: z.string(),
      detail: z.enum(["auto", "low", "high", "original"]).optional()
    })
  ])
});
const audioPart = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.enum(["wav", "mp3"])
  })
});
const filePart = z.object({
  type: z.literal("file"),
  file: z.object({
    filename: z.string().optional(),
    file_data: z.string().optional(),
    file_url: z.string().optional(),
    file_id: z.string().optional()
  })
});
const textContent = z.union([
  z.string(),
  z.array(textPart)
]);
const userContent = z.union([
  z.string(),
  z.array(z.discriminatedUnion("type", [textPart, imageUrlPart, audioPart, filePart]))
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
          z.object({ role: z.literal("user"), content: userContent }),
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
    reasoning_effort: z.string().min(1).optional()
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

/**
 * Session-level contract for adapters whose runtime exposes host functions
 * natively (Codex dynamicTools, Grok host tools). One wording, one place:
 * codex-cli 0.144 showed the models read this closely, and a lane keeping
 * its own copy regresses alone (2eb7c38, 204ecb9).
 */
export const HOST_TOOL_INSTRUCTIONS =
  "Produce exactly one assistant turn. The dynamic host functions supplied with this session ARE enabled and are your only way to act on the user's environment: call them through the function interface whenever they fit the request, and never print a function call as text. Built-in tools are disabled, so do not inspect files, run commands, or browse yourself — but that restriction does not apply to the host functions.";

function text(value: z.infer<typeof textContent>) {
  return typeof value === "string"
    ? value
    : value.map((part) => part.text).join("");
}

function userTranscriptContent(value: z.infer<typeof userContent>) {
  if (typeof value === "string") return value;
  return value.map((part) => {
    if (part.type === "text") return part;
    if (part.type === "image_url") {
      const detail = typeof part.image_url === "string"
        ? undefined
        : part.image_url.detail;
      return { type: part.type, attachment: true, ...(detail ? { detail } : {}) };
    }
    if (part.type === "input_audio") {
      return { type: part.type, attachment: true, format: part.input_audio.format };
    }
    return {
      type: part.type,
      attachment: true,
      ...(part.file.filename ? { filename: part.file.filename } : {})
    };
  });
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
    return {
      role: message.role,
      content:
        message.role === "user"
          ? userTranscriptContent(message.content)
          : text(message.content)
    };
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

/**
 * Shared error body for both streaming lanes. A stream has already sent its
 * HTTP status by the time a turn fails, so `category` is how a standard
 * classification — notably `auth_required` — reaches a host on this path.
 */
export function errorPayload(error: unknown) {
  const category = (error as { category?: unknown } | null)?.category;
  const phase = (error as { phase?: unknown } | null)?.phase;
  return {
    message: error instanceof Error ? error.message : "Bridge failed",
    ...(typeof category === "string" ? { category } : {}),
    ...(typeof phase === "string" ? { phase } : {})
  };
}

export const SSE_HEARTBEAT_MS = 15_000;

export function startSseHeartbeat(send: (chunk: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    stop();
    timer = setTimeout(() => {
      try {
        send(": ping\n\n");
        reset();
      } catch {
        stop();
      }
    }, SSE_HEARTBEAT_MS);
    timer.unref();
  };
  reset();
  return { reset, stop };
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
  let heartbeat: ReturnType<typeof startSseHeartbeat> | undefined;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (
        delta: ChatDelta,
        finishReason: ChatTurn["finishReason"] | null,
        turn?: ChatTurn
      ) => {
        if (canceled) return;
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
        heartbeat?.reset();
      };
      heartbeat = startSseHeartbeat((chunk) =>
        controller.enqueue(encoder.encode(chunk))
      );
      send({ role: "assistant" } as ChatDelta, null);
      void runner(input, { signal, onDelta: (delta) => send(delta, null) })
        .then((turn) => {
          send({}, turn.finishReason, turn);
        })
        .catch((error) => {
          if (canceled) return;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: errorPayload(error) })}\n\n`
            )
          );
        })
        .finally(() => {
          heartbeat?.stop();
          if (canceled) return;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
    },
    cancel() {
      canceled = true;
      heartbeat?.stop();
    }
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}
