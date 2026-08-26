import { expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityEnvironment,
  antigravityTurnTimeoutMs,
  closeAntigravitySessions,
  completedAntigravityTurn,
  parseAgyModels,
  prepareIsolatedAntigravityHome,
  recoverTextToolCall,
  resolveAgyModel,
  runAntigravity
} from "../src/antigravity.js";
import { chatRequestSchema, type ChatTurn } from "../src/protocol.js";

test("parses agy models output into structured specs", () => {
  const output = `
Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.5-flash-high\tGemini 3.5 Flash (High)
gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)
gemini-3.5-flash-low\tGemini 3.5 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;
  const models = parseAgyModels(output);
  expect(models.length).toBe(7);

  const flash37 = models.find((m) => m.id === "gemini-3.7-flash");
  expect(flash37).toBeDefined();
  expect(flash37?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  expect(flash37?.defaultReasoningEffort).toBe("high");

  const pro31 = models.find((m) => m.id === "gemini-3.1-pro");
  expect(pro31).toBeDefined();
  expect(pro31?.reasoningEfforts).toEqual(["low", "high"]);

  const claudeSonnet = models.find((m) => m.id === "claude-sonnet-4.6");
  expect(claudeSonnet).toBeDefined();
  expect(claudeSonnet?.reasoningEfforts).toEqual(["high"]);
});

test("resolves canonical model slugs and reasoning efforts to CLI slugs", () => {
  expect(resolveAgyModel("gemini-3.7-flash", "low")).toBe("gemini-3.7-flash-low");
  expect(resolveAgyModel("gemini-3.7-flash", "high")).toBe("gemini-3.7-flash-high");
  expect(resolveAgyModel("gemini-3.7-flash")).toBe("gemini-3.7-flash-high");
  expect(resolveAgyModel("gemini-3.1-pro")).toBe("gemini-3.1-pro-high");
  expect(resolveAgyModel("claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
  expect(resolveAgyModel("gemini-3.7-flash-low")).toBe("gemini-3.7-flash-low");
});

test("resolves dynamically discovered model catalog CLI slugs", () => {
  const dynamicOutput = `
gemini-4.0-pro-high\tGemini 4.0 Pro (High)
gemini-4.0-pro-low\tGemini 4.0 Pro (Low)
`;
  const catalog = parseAgyModels(dynamicOutput);
  expect(catalog.length).toBe(1);
  expect(resolveAgyModel("gemini-4.0-pro", "high", catalog)).toBe("gemini-4.0-pro-high");
  expect(resolveAgyModel("gemini-4.0-pro", "low", catalog)).toBe("gemini-4.0-pro-low");
  expect(resolveAgyModel("gemini-4.0-pro", undefined, catalog)).toBe("gemini-4.0-pro-high");
  expect(resolveAgyModel("gemini-4.0-pro-high", undefined, catalog)).toBe("gemini-4.0-pro-high");
});

test("validates Antigravity environment isolation", async () => {
  const customHome = "/tmp/custom-isolated-home";
  const originalAntigravityHome = process.env.ANTIGRAVITY_HOME;
  const originalGeminiHome = process.env.GEMINI_HOME;
  process.env.ANTIGRAVITY_HOME = "/should/not/forward";
  process.env.GEMINI_HOME = "/should/not/forward";

  try {
    const env = antigravityEnvironment(customHome);
    expect(env.HOME).toBe(customHome);
    expect(env.TMPDIR).toBe(customHome);
    expect(env.ANTIGRAVITY_HOME).toBeUndefined();
    expect(env.GEMINI_HOME).toBeUndefined();
  } finally {
    if (originalAntigravityHome == null) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = originalAntigravityHome;
    if (originalGeminiHome == null) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = originalGeminiHome;
  }
});

test("prepares isolated home with scoped reads, explicit denies, and empty MCP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-home-test-"));
  try {
    const image = join(dir, "input.png");
    await writeFile(image, "image");
    const fakeHome = await prepareIsolatedAntigravityHome(dir, [image]);
    expect(fakeHome).toBe(join(dir, "home"));

    const geminiSettings = await Bun.file(join(fakeHome, ".gemini/settings.json")).json();
    expect(geminiSettings.permissions.allow).toEqual([`read_file(${await realpath(image)})`]);
    expect(geminiSettings.permissions.deny).toContain("command(*)");
    expect(geminiSettings.permissions.deny).toContain("write_file(*)");
    expect(geminiSettings.allowNonWorkspaceAccess).toBe(false);
    expect(geminiSettings.tools.enabled).toBe(false);
    expect(geminiSettings.mcp.servers).toEqual({});

    const cliSettings = await Bun.file(join(fakeHome, ".gemini/antigravity-cli/settings.json")).json();
    expect(cliSettings.permissions).toEqual(geminiSettings.permissions);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates Antigravity turn completion and timeout configuration", () => {
  const usage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };
  expect(completedAntigravityTurn("done", [], usage, [])).toMatchObject({
    content: "done",
    finishReason: "stop",
    usage: {
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10
    }
  });
  expect(() => completedAntigravityTurn("", [], usage, [])).toThrow(
    "Antigravity bridge returned no assistant turn"
  );
  expect(antigravityTurnTimeoutMs(undefined)).toBe(300_000);
  expect(antigravityTurnTimeoutMs("400000")).toBe(400_000);
  expect(() => antigravityTurnTimeoutMs("0")).toThrow(
    "AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS must be a positive integer"
  );
});

test("recovers a tool call emitted as text JSON or markdown codeblock", () => {
  const tools = [
    {
      type: "function" as const,
      function: { name: "get_weather", parameters: { type: "object" } }
    }
  ];

  const rawJson = '{"name":"get_weather","arguments":{"location":"Taipei"}}';
  expect(recoverTextToolCall(rawJson, tools)).toMatchObject({
    name: "get_weather",
    arguments: { location: "Taipei" }
  });

  const markdownJson = `
Here is the function call:
\`\`\`json
{
  "name": "get_weather",
  "arguments": {
    "location": "Tokyo",
    "unit": "celsius"
  }
}
\`\`\`
`;
  expect(recoverTextToolCall(markdownJson, tools)).toMatchObject({
    name: "get_weather",
    arguments: { location: "Tokyo", unit: "celsius" }
  });
});

test("executes an Antigravity turn with stream-json events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-agy-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;

  await writeFile(
    fakeAgy,
    `#!/usr/bin/env node
const send = (data) => process.stdout.write(JSON.stringify(data) + "\\n");

send({ event: "init", init: { cwd: process.cwd() } });
send({
  event: "step_update",
  step_update: {
    step_type: "agent_response",
    text_delta: "Hello from ",
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
  }
});

send({
  event: "step_update",
  step_update: {
    step_type: "agent_response",
    text_delta: "Antigravity!",
    usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 }
  }
});
send({
  event: "result",
  result: {
    status: "SUCCESS",
    response: "Hello from Antigravity!",
    usage: { input_tokens: 10, output_tokens: 6, thinking_tokens: 4, total_tokens: 16 }
  }
});
`
  );
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;

  try {
    const deltas: string[] = [];
    const turn = await runAntigravity(
      chatRequestSchema.parse({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "Hi" }]
      }),
      {
        onDelta: (d) => {
          if (d.content) deltas.push(d.content);
        }
      }
    );

    expect(deltas.join("")).toBe("Hello from Antigravity!");
    expect(turn).toMatchObject({
      content: "Hello from Antigravity!",
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 6,
        totalTokens: 16,
        reasoningTokens: 4
      }
    });
  } finally {
    await closeAntigravitySessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes image input into the isolated AGY print-mode media lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-agy-image-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const path = prompt.match(/Analyze the attached image at (.+?\\.(?:png|jpg|gif|webp))\\./)?.[1];
if (!path || !existsSync(path) || readFileSync(path).subarray(1, 4).toString("ascii") !== "PNG") process.exit(9);
const send = (data) => process.stdout.write(JSON.stringify(data) + "\\n");
send({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: path } } } });
send({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: path } } } });
send({ event: "result", result: { status: "SUCCESS", response: "VISION" } });
`);
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;
  try {
    expect(await runAntigravity(chatRequestSchema.parse({
      model: "gemini-3.7-flash",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe it" },
          { type: "image_url", image_url: "data:image/png;base64,iVBORw0KGgo=" }
        ]
      }]
    }))).toMatchObject({ content: "VISION", finishReason: "stop" });
  } finally {
    await closeAntigravitySessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects built-in tool execution reported by Antigravity CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-agy-tool-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;

  await writeFile(
    fakeAgy,
    `#!/usr/bin/env node
const send = (data) => process.stdout.write(JSON.stringify(data) + "\\n");

send({ event: "init", init: { cwd: process.cwd() } });
send({
  event: "step_update",
  step_update: {
    step_type: "tool_use",
    tool_call: { name: "run_command", arguments: { command: "ls" } }
  }
});
`
  );
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;

  try {
    let error: Error | null = null;
    try {
      await runAntigravity(
        chatRequestSchema.parse({
          model: "gemini-3.7-flash",
          messages: [{ role: "user", content: "List files" }]
        })
      );
    } catch (err: any) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(error?.message).toContain("Built-in tool execution is disabled in agent bridge");
  } finally {
    await closeAntigravitySessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-success terminal states from Antigravity CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-agy-status-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;

  await writeFile(
    fakeAgy,
    `#!/usr/bin/env node
const send = (data) => process.stdout.write(JSON.stringify(data) + "\\n");

send({ event: "init", init: { cwd: process.cwd() } });
send({
  event: "step_update",
  step_update: {
    step_type: "agent_response",
    text_delta: "Partial output before cancel"
  }
});
send({
  event: "result",
  result: {
    status: "CANCELED",
    error: "Operation canceled by upstream"
  }
});
`
  );
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;

  try {
    let error: Error | null = null;
    try {
      await runAntigravity(
        chatRequestSchema.parse({
          model: "gemini-3.7-flash",
          messages: [{ role: "user", content: "Test cancel" }]
        })
      );
    } catch (err: any) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(error?.message).toContain("Operation canceled by upstream");
  } finally {
    await closeAntigravitySessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects when aborted mid-turn with partial text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-agy-abort-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;

  await writeFile(
    fakeAgy,
    `#!/usr/bin/env node
const send = (data) => process.stdout.write(JSON.stringify(data) + "\\n");

send({ event: "init", init: { cwd: process.cwd() } });
send({
  event: "step_update",
  step_update: {
    step_type: "agent_response",
    text_delta: "Partial stream content before abort"
  }
});
// Hang without sending result so caller aborts
setInterval(() => {}, 1000);
`
  );
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;

  const controller = new AbortController();
  try {
    const runPromise = runAntigravity(
      chatRequestSchema.parse({
        model: "gemini-3.7-flash",
        messages: [{ role: "user", content: "Test abort" }]
      }),
      { signal: controller.signal }
    );

    // Give time for partial text to arrive, then abort
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    let error: Error | null = null;
    try {
      await runPromise;
    } catch (err: any) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(error?.message).toContain("Antigravity bridge aborted");
  } finally {
    await closeAntigravitySessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    await rm(directory, { recursive: true, force: true });
  }
});
