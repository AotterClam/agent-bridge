import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  promptFor,
  selectedTools,
  type ChatRequest,
  type ChatRunner,
  type ChatTurn
} from "./protocol.js";

const exec = promisify(execFile);
const REASONING = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 300_000;

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function command() {
  return process.env.AGENT_BRIDGE_CODEX_COMMAND ?? "codex";
}

export function codexTurnTimeoutMs(
  value = process.env.AGENT_BRIDGE_CODEX_TIMEOUT_MS
) {
  if (value === undefined) return DEFAULT_CODEX_TURN_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("AGENT_BRIDGE_CODEX_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

export function completedCodexTurn(
  content: string,
  toolCalls: ChatTurn["toolCalls"],
  usage?: ChatTurn["usage"],
  tools: ChatRequest["tools"] = []
): ChatTurn {
  const recovered = !toolCalls.length
    ? recoverTextToolCall(content, tools)
    : undefined;
  const calls = recovered ? [recovered] : toolCalls;
  if (!content && !calls.length) {
    throw new Error("Codex bridge returned no assistant turn");
  }
  return {
    content: recovered ? null : content || null,
    toolCalls: calls,
    finishReason: calls.length ? "tool_calls" : "stop",
    usage
  };
}

export function recoverTextToolCall(
  content: string,
  tools: ChatRequest["tools"]
): ChatTurn["toolCalls"][number] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch {
    return;
  }
  const call = record(value);
  if (!tools.some(({ function: tool }) => tool.name === call.name)) return;
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  return {
    id: `exec-${crypto.randomUUID()}`,
    name: String(call.name),
    arguments: args as Record<string, unknown>
  };
}

export function codexEnvironment(home: string) {
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex")
  };
  for (const key of ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function rpc(child: ChildProcessWithoutNullStreams, onMessage: (message: RpcMessage) => void) {
  let nextId = 1;
  const pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id != null && !message.method) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message ?? "Codex request failed"));
        else request.resolve(message.result);
      } else {
        onMessage(message);
      }
    } catch {
      // Codex may print non-protocol startup output.
    }
  });
  return {
    request(method: string, params: unknown) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
    },
    close(error = new Error("Codex app-server closed")) {
      lines.close();
      pending.forEach(({ reject }) => reject(error));
      pending.clear();
    }
  };
}

function tokenUsage(params: Record<string, unknown>) {
  const last = record(record(params.tokenUsage).last);
  if (typeof last.totalTokens !== "number") return;
  return {
    promptTokens: Number(last.inputTokens ?? 0),
    completionTokens: Number(last.outputTokens ?? 0),
    totalTokens: last.totalTokens,
    reasoningTokens: Number(last.reasoningOutputTokens ?? 0)
  };
}

export async function detectCodex() {
  try {
    const [{ stdout: version }, { stdout }] = await Promise.all([
      exec(command(), ["--version"], { timeout: 5_000 }),
      exec(command(), ["debug", "models", "--bundled"], {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024
      })
    ]);
    const payload = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> };
    const models = (payload.models ?? [])
      .filter((model) => model.visibility === "list")
      .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
      .flatMap((model) => {
        if (typeof model.slug !== "string") return [];
        const efforts = Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
              .map((value) => String(record(value).effort ?? value))
              .filter((value) => REASONING.has(value))
          : [];
        const defaultEffort = String(model.default_reasoning_level ?? "");
        return [{
          id: model.slug,
          name: typeof model.display_name === "string" ? model.display_name : model.slug,
          reasoningEfforts: efforts,
          ...(REASONING.has(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {})
        }];
      });
    return {
      id: "codex" as const,
      name: "Codex",
      available: models.length > 0,
      version: version.trim(),
      error: models.length ? null : "Codex returned no models.",
      models
    };
  } catch (error) {
    return {
      id: "codex" as const,
      name: "Codex",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Codex unavailable.",
      models: []
    };
  }
}

export const runCodex: ChatRunner = async (input, options = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-codex-"));
  const child = spawn(
    command(),
    [
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "image_generation",
      "--disable", "multi_agent",
      "app-server",
      "--stdio"
    ],
    { cwd, env: codexEnvironment(cwd), stdio: ["pipe", "pipe", "pipe"] }
  );
  let content = "";
  let stderr = "";
  let usage: ChatTurn["usage"];
  let settled = false;
  const toolCalls: ChatTurn["toolCalls"] = [];
  let resolve!: (turn: ChatTurn) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ChatTurn>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const fail = (error: Error) => {
    if (!settled) {
      settled = true;
      reject(error);
    }
  };
  const client = rpc(child, (message) => {
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      content += params.delta;
    } else if (
      (message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/reasoning/textDelta") &&
      typeof params.delta === "string"
    ) {
      options.onDelta?.({ reasoning_content: params.delta });
    } else if (message.method === "thread/tokenUsage/updated") {
      usage = tokenUsage(params) ?? usage;
    } else if (message.method === "item/tool/call") {
      const call = {
        id: String(params.callId ?? crypto.randomUUID()),
        name: String(params.tool ?? ""),
        arguments: record(params.arguments)
      };
      toolCalls.push(call);
      if (content) options.onDelta?.({ content });
      options.onDelta?.({
        tool_calls: [{
          index: toolCalls.length - 1,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }]
      });
      if (!settled) {
        settled = true;
        resolve({ content: content || null, toolCalls, finishReason: "tool_calls", usage });
      }
    } else if (message.method === "turn/completed" && !settled) {
      const turn = record(params.turn);
      if (turn.status !== "completed") {
        fail(new Error(String(record(turn.error).message ?? "Codex turn failed")));
      } else {
        try {
          const completed = completedCodexTurn(
            content,
            toolCalls,
            usage,
            selectedTools(input)
          );
          if (!toolCalls.length && completed.toolCalls.length) {
            const call = completed.toolCalls[0]!;
            options.onDelta?.({
              tool_calls: [{
                index: 0,
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments)
                }
              }]
            });
          } else if (completed.content) {
            options.onDelta?.({ content: completed.content });
          }
          settled = true;
          resolve(completed);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Codex turn failed"));
        }
      }
    } else if (message.method?.includes("requestApproval")) {
      fail(new Error(`Codex built-in operation refused: ${message.method}`));
    }
  });
  const abort = () => {
    fail(new Error("Codex bridge aborted"));
    child.kill("SIGTERM");
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", fail);
  child.on("close", (code) => {
    client.close();
    fail(new Error(`Codex exited ${code ?? "without a code"}: ${stderr.slice(-1000)}`));
  });
  const timeoutMs = codexTurnTimeoutMs();
  const timeout = setTimeout(
    () => fail(new Error(`Codex turn timed out after ${timeoutMs} ms.`)),
    timeoutMs
  );
  timeout.unref();

  try {
    await client.request("initialize", {
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    client.notify("initialized");
    const started = record(await client.request("thread/start", {
      model: input.model,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      dynamicTools: selectedTools(input).map(({ function: tool }) => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.parameters ?? { type: "object", properties: {} }
      })),
      baseInstructions:
        "Produce exactly one assistant turn. Call host functions through the function interface when appropriate; never print a function call as text. Do not inspect files, run commands, browse, or use built-in tools."
    }));
    const threadId = record(started.thread).id;
    if (typeof threadId !== "string") throw new Error("Codex returned no thread id");
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: promptFor(input.messages, input.tool_choice), text_elements: [] }],
      ...(input.reasoning_effort ? { effort: input.reasoning_effort } : {}),
      summary: "concise"
    });
    return await result;
  } finally {
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    child.kill("SIGTERM");
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
};
