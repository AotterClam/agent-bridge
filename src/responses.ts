import { z } from "zod";
import {
  chatRequestSchema,
  type ChatDelta,
  type ChatRequest,
  type ChatRunner,
  type ChatTurn
} from "./protocol.js";
import { validateImageBase64, type ImageRunner } from "./images.js";

// Stateless subset of the OpenAI Responses API (the Open Responses shape):
// full `input` on every call, no `previous_response_id`, nothing stored.
// Anything that would require server-side state or a capability the chat
// lane lacks is rejected loudly rather than silently dropped.

const partSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    detail: z.enum(["auto", "low", "high"]).optional(),
    image_url: z.string().optional(),
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    file_url: z.string().optional(),
    filename: z.string().optional()
  })
  .passthrough();
const itemContent = z.union([z.string(), z.array(partSchema)]);
const itemSchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    content: itemContent.optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    output: itemContent.optional()
  })
  .passthrough();

export const responsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(itemSchema)]),
    instructions: z.string().nullish(),
    tools: z.array(z.object({ type: z.string() }).passthrough()).nullish(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({ type: z.literal("function"), name: z.string() }).passthrough(),
        z.object({ type: z.literal("image_generation") }).strict()
      ])
      .nullish(),
    stream: z.boolean().nullish(),
    reasoning: z
      .object({
        effort: z.string().nullish(),
        summary: z.string().nullish()
      })
      .passthrough()
      .nullish(),
    store: z.boolean().nullish(),
    previous_response_id: z.string().nullish(),
    max_output_tokens: z.number().nullish(),
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    top_logprobs: z.number().nullish(),
    max_tool_calls: z.number().nullish(),
    parallel_tool_calls: z.boolean().nullish(),
    background: z.boolean().nullish(),
    truncation: z.string().nullish(),
    text: z
      .object({
        format: z.object({ type: z.string() }).passthrough().nullish()
      })
      .passthrough()
      .nullish(),
    include: z.array(z.unknown()).nullish(),
    presence_penalty: z.number().nullish(),
    frequency_penalty: z.number().nullish(),
    service_tier: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    safety_identifier: z.string().nullish(),
    prompt_cache_key: z.string().nullish(),
    stream_options: z.record(z.string(), z.unknown()).nullish()
  })
  .strict();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function partText(
  content: z.infer<typeof itemContent>,
  kinds: readonly string[]
) {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!kinds.includes(part.type)) {
        badRequest(`Unsupported content part "${part.type}".`);
      }
      return part.text ?? "";
    })
    .join("");
}

function messageContent(
  content: z.infer<typeof itemContent>,
  role: "system" | "user" | "assistant"
) {
  if (typeof content === "string" || role !== "user") {
    return partText(content, ["input_text", "output_text", "text"]);
  }
  return content.map((part) => {
    if (["input_text", "output_text", "text"].includes(part.type)) {
      return { type: "text" as const, text: part.text ?? "" };
    }
    if (part.type === "input_image") {
      if (part.file_id) {
        badRequest("input_image file_id is not supported: this bridge stores no files.");
      }
      if (!part.image_url) badRequest("input_image requires image_url.");
      return {
        type: "image_url" as const,
        image_url: {
          url: part.image_url,
          ...(part.detail ? { detail: part.detail } : {})
        }
      };
    }
    if (part.type === "input_file") {
      if (part.file_id) {
        badRequest("input_file file_id is not supported: this bridge stores no files.");
      }
      if (!part.file_data && !part.file_url) {
        badRequest("input_file requires file_data or file_url.");
      }
      return {
        type: "file" as const,
        file: {
          ...(part.filename ? { filename: part.filename } : {}),
          ...(part.file_data ? { file_data: part.file_data } : {}),
          ...(part.file_url ? { file_url: part.file_url } : {})
        }
      };
    }
    badRequest(`Unsupported content part "${part.type}".`);
  });
}

/**
 * Controls the CLI-backed adapters cannot honor. Accepting them and
 * answering with defaults would misreport what actually ran, so any
 * effective value is refused instead of silently dropped.
 */
function unsupportedControl(input: ResponsesRequest) {
  if (input.store) return "store: true";
  if (input.max_output_tokens != null) return "max_output_tokens";
  if (input.temperature != null) return "temperature";
  if (input.top_p != null) return "top_p";
  if (input.top_logprobs) return "top_logprobs";
  if (input.max_tool_calls != null) return "max_tool_calls";
  if (input.parallel_tool_calls === false) return "parallel_tool_calls: false";
  if (input.background) return "background: true";
  if (input.truncation && input.truncation !== "disabled") {
    return `truncation: ${input.truncation}`;
  }
  const format = input.text?.format?.type;
  if (format && format !== "text") return `text.format: ${format}`;
  if (input.include?.length) return "include";
  if (input.presence_penalty) return "presence_penalty";
  if (input.frequency_penalty) return "frequency_penalty";
  if (
    input.service_tier != null &&
    input.service_tier !== "auto" &&
    input.service_tier !== "default"
  ) {
    return `service_tier: ${input.service_tier}`;
  }
  if (input.reasoning?.summary != null) return "reasoning.summary";
  if (input.stream_options != null) return "stream_options";
  if (input.safety_identifier != null) return "safety_identifier";
  if (input.prompt_cache_key != null) return "prompt_cache_key";
  return undefined;
}

export function toChatRequest(input: ResponsesRequest): ChatRequest {
  if (input.previous_response_id) {
    badRequest(
      "previous_response_id is not supported: this bridge is stateless, send the full input array."
    );
  }
  const control = unsupportedControl(input);
  if (control) {
    badRequest(`This bridge does not support ${control}.`);
  }
  const messages: Array<Record<string, unknown>> = [];
  if (input.instructions) {
    messages.push({ role: "system", content: input.instructions });
  }
  const items =
    typeof input.input === "string"
      ? [{ type: "message", role: "user", content: input.input }]
      : input.input;
  for (const item of items) {
    const type = item.type ?? "message";
    if (type === "message") {
      const role = item.role === "developer" ? "system" : item.role;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        badRequest(`Unsupported message role "${item.role}".`);
      }
      messages.push({
        role,
        content: messageContent(item.content ?? "", role)
      });
    } else if (type === "function_call") {
      if (!item.call_id || !item.name) {
        badRequest("function_call items need call_id and name.");
      }
      const call = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" }
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
    } else if (type === "function_call_output") {
      if (!item.call_id) badRequest("function_call_output items need call_id.");
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: partText(item.output ?? "", [
          "input_text",
          "output_text",
          "text"
        ])
      });
    } else if (type === "reasoning") {
      // Replayed reasoning items are opaque to a chat-completions backend.
    } else {
      badRequest(`Unsupported input item "${type}".`);
    }
  }
  const tools = (input.tools ?? []).map((tool) => {
    if (tool.type !== "function" || typeof tool.name !== "string") {
      badRequest("Only function tools are supported.");
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        ...(tool.parameters && typeof tool.parameters === "object"
          ? { parameters: tool.parameters }
          : {})
      }
    };
  });
  const choice = input.tool_choice ?? "auto";
  if (typeof choice === "object" && choice.type !== "function") {
    badRequest("image_generation tool_choice requires an image_generation tool.");
  }
  const chat = chatRequestSchema.safeParse({
    model: input.model,
    messages,
    tools,
    tool_choice:
      typeof choice === "object"
        ? { type: "function", function: { name: choice.name } }
        : choice,
    stream: input.stream ?? false,
    ...(input.reasoning?.effort
      ? { reasoning_effort: input.reasoning.effort }
      : {})
  });
  if (!chat.success) badRequest(z.prettifyError(chat.error));
  return chat.data;
}

type OutputItem = Record<string, unknown>;

function itemId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function usagePayload(turn: ChatTurn) {
  const input = turn.usage?.promptTokens ?? 0;
  const output = turn.usage?.completionTokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: turn.usage?.reasoningTokens ?? 0
    },
    total_tokens: turn.usage?.totalTokens ?? input + output
  };
}

function responsePayload(
  context: { id: string; created: number; request: ResponsesRequest },
  status: "in_progress" | "completed",
  output: OutputItem[],
  turn?: ChatTurn
) {
  return {
    id: context.id,
    object: "response",
    created_at: context.created,
    completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: context.request.instructions ?? null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: context.request.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: {
      effort: context.request.reasoning?.effort ?? null,
      summary: null
    },
    store: false,
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    text: { format: { type: "text" } },
    tool_choice: context.request.tool_choice ?? "auto",
    tools: context.request.tools ?? [],
    truncation: "disabled",
    usage: turn ? usagePayload(turn) : null,
    service_tier: "default",
    safety_identifier: null,
    prompt_cache_key: null,
    user: null,
    metadata: context.request.metadata ?? {}
  };
}

function textPart(text: string) {
  return { type: "output_text", annotations: [], logprobs: [], text };
}

export async function respondResponses(
  input: ResponsesRequest,
  runner: ChatRunner,
  signal?: AbortSignal,
  imageRunner?: ImageRunner
) {
  const imageTools = (input.tools ?? []).filter((tool) => tool.type === "image_generation");
  if (imageTools.length) {
    if (!imageRunner) badRequest("This adapter does not support image_generation.");
    if (input.stream) badRequest("Streaming image_generation is not supported.");
    if (imageTools.length !== 1 || input.tools?.length !== 1) {
      badRequest("image_generation must be the only tool.");
    }
    const imageTool = imageTools[0]!;
    if (Object.keys(imageTool).some((key) => !["type", "partial_images", "size"].includes(key))) {
      badRequest("Optional image_generation tool parameters are not supported.");
    }
    if (imageTool.partial_images != null && imageTool.partial_images !== 0) {
      badRequest("partial_images greater than 0 is not supported.");
    }
    if (
      imageTool.size != null &&
      (typeof imageTool.size !== "string" || !/^(?:auto|[1-9]\d*x[1-9]\d*)$/.test(imageTool.size))
    ) {
      badRequest("size must be auto or WIDTHxHEIGHT.");
    }
    if (input.previous_response_id) {
      badRequest("previous_response_id is not supported: this bridge is stateless.");
    }
    const control = unsupportedControl(input);
    if (control) badRequest(`This bridge does not support ${control}.`);
    if (input.tool_choice === "none") {
      badRequest("tool_choice none cannot be used with the image_generation lane.");
    }
    if (
      input.tool_choice !== "required" &&
      !(
        input.tool_choice != null &&
        typeof input.tool_choice === "object" &&
        input.tool_choice.type === "image_generation"
      )
    ) {
      badRequest(
        "image_generation requires tool_choice required or { type: \"image_generation\" }."
      );
    }
    if (typeof input.input !== "string") {
      badRequest("image_generation currently requires a string input.");
    }
    if (input.instructions != null) {
      badRequest("instructions are not supported in the image_generation lane.");
    }
    if (input.reasoning?.effort != null) {
      badRequest("reasoning.effort is not supported in the image_generation lane.");
    }
    const context = {
      id: itemId("resp"),
      created: Math.floor(Date.now() / 1000),
      request: input
    };
    const generated = await imageRunner({
      model: input.model,
      prompt: input.input,
      ...(typeof imageTool.size === "string" ? { size: imageTool.size } : {})
    }, { signal });
    validateImageBase64(generated.b64Json);
    return Response.json(responsePayload(context, "completed", [{
      id: itemId("ig"),
      type: "image_generation_call",
      status: "completed",
      result: generated.b64Json,
      ...(generated.revisedPrompt ? { revised_prompt: generated.revisedPrompt } : {})
    }]));
  }
  const chat = toChatRequest(input);
  const context = {
    id: itemId("resp"),
    created: Math.floor(Date.now() / 1000),
    request: input
  };
  if (!input.stream) {
    const turn = await runner(chat, { signal });
    const output: OutputItem[] = [];
    if (turn.content) {
      output.push({
        id: itemId("msg"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [textPart(turn.content)]
      });
    }
    for (const call of turn.toolCalls) {
      output.push({
        id: itemId("fc"),
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments)
      });
    }
    return Response.json(responsePayload(context, "completed", output, turn));
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      const send = (type: string, payload: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(
            `event: ${type}\ndata: ${JSON.stringify({
              type,
              sequence_number: sequence++,
              ...payload
            })}\n\n`
          )
        );

      type Open =
        | { kind: "message"; id: string; text: string }
        | { kind: "reasoning"; id: string; text: string }
        | {
            kind: "function_call";
            id: string;
            chatIndex: number;
            callId: string;
            name: string;
            args: string;
          };
      let open: Open | null = null;
      const output: OutputItem[] = [];
      const seenCallIds = new Set<string>();
      let sawText = false;

      const closeOpen = () => {
        if (!open) return;
        const index = output.length;
        let item: OutputItem;
        if (open.kind === "message") {
          const part = textPart(open.text);
          send("response.output_text.done", {
            item_id: open.id,
            output_index: index,
            content_index: 0,
            logprobs: [],
            text: open.text
          });
          send("response.content_part.done", {
            item_id: open.id,
            output_index: index,
            content_index: 0,
            part
          });
          item = {
            id: open.id,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [part]
          };
        } else if (open.kind === "reasoning") {
          const part = { type: "summary_text", text: open.text };
          send("response.reasoning_summary_text.done", {
            item_id: open.id,
            output_index: index,
            summary_index: 0,
            text: open.text
          });
          send("response.reasoning_summary_part.done", {
            item_id: open.id,
            output_index: index,
            summary_index: 0,
            part
          });
          item = { id: open.id, type: "reasoning", summary: [part] };
        } else {
          send("response.function_call_arguments.done", {
            item_id: open.id,
            output_index: index,
            call_id: open.callId,
            name: open.name,
            arguments: open.args
          });
          item = {
            id: open.id,
            type: "function_call",
            status: "completed",
            call_id: open.callId,
            name: open.name,
            arguments: open.args
          };
        }
        send("response.output_item.done", { output_index: index, item });
        output.push(item);
        open = null;
      };

      const addItem = (item: OutputItem) =>
        send("response.output_item.added", {
          output_index: output.length,
          item
        });

      const onDelta = (delta: ChatDelta) => {
        if (delta.reasoning_content) {
          if (open?.kind !== "reasoning") {
            closeOpen();
            const id = itemId("rs");
            addItem({ id, type: "reasoning", summary: [] });
            send("response.reasoning_summary_part.added", {
              item_id: id,
              output_index: output.length,
              summary_index: 0,
              part: { type: "summary_text", text: "" }
            });
            open = { kind: "reasoning", id, text: "" };
          }
          open.text += delta.reasoning_content;
          send("response.reasoning_summary_text.delta", {
            item_id: open.id,
            output_index: output.length,
            summary_index: 0,
            delta: delta.reasoning_content
          });
        }
        if (delta.content) {
          if (open?.kind !== "message") {
            closeOpen();
            const id = itemId("msg");
            addItem({
              id,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: []
            });
            send("response.content_part.added", {
              item_id: id,
              output_index: output.length,
              content_index: 0,
              part: textPart("")
            });
            open = { kind: "message", id, text: "" };
          }
          sawText = true;
          open.text += delta.content;
          send("response.output_text.delta", {
            item_id: open.id,
            output_index: output.length,
            content_index: 0,
            logprobs: [],
            delta: delta.content
          });
        }
        for (const call of delta.tool_calls ?? []) {
          if (open?.kind !== "function_call" || open.chatIndex !== call.index) {
            closeOpen();
            // ponytail: adapters send id+name on a call's first delta; a
            // name-less opener would need buffering nothing emits today.
            const id = itemId("fc");
            const callId = call.id ?? itemId("call");
            const name = call.function?.name ?? "";
            addItem({
              id,
              type: "function_call",
              status: "in_progress",
              call_id: callId,
              name,
              arguments: ""
            });
            open = {
              kind: "function_call",
              id,
              chatIndex: call.index,
              callId,
              name,
              args: ""
            };
          }
          if (call.id) seenCallIds.add(call.id);
          const args = call.function?.arguments ?? "";
          if (args) {
            open.args += args;
            send("response.function_call_arguments.delta", {
              item_id: open.id,
              output_index: output.length,
              delta: args
            });
          }
        }
      };

      send(
        "response.created",
        { response: responsePayload(context, "in_progress", []) }
      );
      send(
        "response.in_progress",
        { response: responsePayload(context, "in_progress", []) }
      );
      void runner(chat, { signal, onDelta })
        .then((turn) => {
          // Adapters may resolve content or calls they never streamed.
          if (turn.content && !sawText) onDelta({ content: turn.content });
          turn.toolCalls.forEach((call, index) => {
            if (seenCallIds.has(call.id)) return;
            onDelta({
              tool_calls: [
                {
                  index: -1 - index,
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments)
                  }
                }
              ]
            });
          });
          closeOpen();
          send("response.completed", {
            response: responsePayload(context, "completed", output, turn)
          });
        })
        .catch((error) => {
          closeOpen();
          send("response.failed", {
            response: {
              ...responsePayload(context, "in_progress", output),
              status: "failed",
              error: {
                code: "server_error",
                message:
                  error instanceof Error ? error.message : "Bridge failed"
              }
            }
          });
        })
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
