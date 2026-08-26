import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeCodexSessions, runCodexImage } from "../src/codex.js";
import { createFileStore } from "../src/files.js";
import { capabilityToken, startAgentBridge } from "../src/index.js";
import {
  closeGrokSessions,
  grokAspectRatioForSize,
  runGrokImage
} from "../src/grok.js";
import {
  imageResponse,
  parseEditRequest,
  parseGenerationRequest,
  readOwnedImage
} from "../src/images.js";
import { respondResponses, responsesRequestSchema } from "../src/responses.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const png64 = png.toString("base64");

function incoming(
  data: Uint8Array,
  contentType: string,
  headers: Record<string, string> = {}
) {
  const request = Readable.from([data]) as IncomingMessage;
  request.headers = { "content-type": contentType, ...headers };
  return request;
}

test("parses the strict generation and edit subset", async () => {
  const store = createFileStore();
  const generated = await parseGenerationRequest(incoming(
    Buffer.from(JSON.stringify({ model: "test", prompt: "draw it", n: 1 })),
    "application/json"
  ));
  expect(generated.input).toEqual({ model: "test", prompt: "draw it" });
  expect((await parseGenerationRequest(incoming(
    Buffer.from(JSON.stringify({
      prompt: "draw it",
      model: null,
      n: null,
      stream: null,
      partial_images: null,
      response_format: null,
      size: null
    })),
    "application/json"
  ))).input).toEqual({ prompt: "draw it" });
  expect(() => imageResponse({ b64Json: "not-base64" })).toThrow("invalid base64");
  expect(await imageResponse({ b64Json: png64 }).json()).toMatchObject({
    created: expect.any(Number),
    data: [{ b64_json: png64 }]
  });

  expect((await parseGenerationRequest(incoming(
    Buffer.from(JSON.stringify({ model: "test", prompt: "draw it", size: "1024x1024" })),
    "application/json"
  ))).input).toEqual({ model: "test", prompt: "draw it", size: "1024x1024" });
  await expect(parseGenerationRequest(incoming(
    Buffer.from(JSON.stringify({ model: "test", prompt: "draw it", size: "wide" })),
    "application/json"
  ))).rejects.toMatchObject({ status: 400 });
  await expect(parseGenerationRequest(incoming(
    Buffer.from(JSON.stringify({ model: "test", prompt: "draw it", stream: true })),
    "application/json"
  ))).rejects.toMatchObject({ status: 400 });

  const form = new FormData();
  form.set("prompt", "make it blue");
  form.append("image", new File([png], "source.png", { type: "image/png" }));
  form.append("image[]", new File([png], "reference.png", { type: "image/png" }));
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type")!;
  const edited = await parseEditRequest(incoming(
    Buffer.from(await encoded.arrayBuffer()),
    contentType
  ), store, "codex");
  expect(edited.input).toMatchObject({ prompt: "make it blue" });
  expect(edited.input.model).toBeUndefined();
  expect(edited.input.imagePaths).toHaveLength(2);
  expect(await Promise.all(edited.input.imagePaths!.map((path) => readFile(path)))).toEqual([png, png]);
  const directory = dirname(edited.input.imagePaths![0]!);
  await edited.cleanup();
  await expect(lstat(directory)).rejects.toThrow();

  await expect(parseEditRequest(incoming(
    Buffer.from("too large"),
    contentType,
    { "content-length": String(53 * 1024 * 1024) }
  ), store, "codex")).rejects.toMatchObject({ status: 413 });
  await store.close();
});

test("resolves JSON edit file_id and data URL images with strict one-of", async () => {
  const store = createFileStore();
  const upload = new FormData();
  upload.set("purpose", "vision");
  upload.set("file", new File([png], "stored.png", { type: "image/png" }));
  const encoded = new Response(upload);
  const contentType = encoded.headers.get("content-type")!;
  try {
    const file = await store.upload(incoming(
      Buffer.from(await encoded.arrayBuffer()),
      contentType
    ), "codex");
    const edit = await parseEditRequest(incoming(Buffer.from(JSON.stringify({
      prompt: "combine them",
      model: null,
      n: null,
      stream: null,
      partial_images: null,
      response_format: null,
      size: null,
      images: [
        { file_id: file.id },
        { image_url: `data:image/png;base64,${png64}` }
      ]
    })), "application/json"), store, "codex");
    expect(edit.input.imagePaths).toHaveLength(2);
    expect(await Promise.all(edit.input.imagePaths!.map((path) => readFile(path)))).toEqual([png, png]);
    await edit.cleanup();

    for (const image of [
      {},
      { file_id: file.id, image_url: `data:image/png;base64,${png64}` }
    ]) {
      await expect(parseEditRequest(incoming(Buffer.from(JSON.stringify({
        prompt: "invalid",
        images: [image]
      })), "application/json"), store, "codex")).rejects.toMatchObject({ status: 400 });
    }

    await expect(parseEditRequest(incoming(Buffer.from(JSON.stringify({
      prompt: "remote",
      images: [{ image_url: "https://example.com/source.png" }]
    })), "application/json"), store, "codex")).rejects.toMatchObject({ status: 400 });

    const sixteen = await parseEditRequest(incoming(Buffer.from(JSON.stringify({
      prompt: "sixteen",
      images: Array.from({ length: 16 }, () => ({
        image_url: `data:image/png;base64,${png64}`
      }))
    })), "application/json"), store, "codex");
    expect(sixteen.input.imagePaths).toHaveLength(16);
    await sixteen.cleanup();

    await expect(parseEditRequest(incoming(Buffer.from(JSON.stringify({
      prompt: "seventeen",
      images: Array.from({ length: 17 }, () => ({
        image_url: `data:image/png;base64,${png64}`
      }))
    })), "application/json"), store, "codex")).rejects.toMatchObject({ status: 400 });
  } finally {
    await store.close();
  }
});

test("returns a Responses image_generation_call and validates image controls", async () => {
  const input = responsesRequestSchema.parse({
    model: "test",
    input: "draw a clam",
    tools: [{ type: "image_generation", partial_images: 0, size: "1600x900" }]
  });
  const response = await respondResponses(
    input,
    async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
    undefined,
    async (request) => {
      expect(request).toEqual({ model: "test", prompt: "draw a clam", size: "1600x900" });
      return { b64Json: png64 };
    }
  );
  expect(await response.json()).toMatchObject({
    object: "response",
    status: "completed",
    output: [{ type: "image_generation_call", status: "completed", result: png64 }]
  });

  await expect(respondResponses(
    responsesRequestSchema.parse({
      model: "test",
      input: "draw",
      tools: [{ type: "image_generation", size: "wide" }],
      tool_choice: "required"
    }),
    async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
    undefined,
    async () => ({ b64Json: png64 })
  )).rejects.toMatchObject({ status: 400 });

  for (const extra of [
    { tool_choice: "required", store: true },
    { tool_choice: "required", instructions: "override the user" },
    { tool_choice: "none" }
  ]) {
    await expect(respondResponses(
      responsesRequestSchema.parse({
        model: "test",
        input: "draw",
        tools: [{ type: "image_generation" }],
        ...extra
      }),
      async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
      undefined,
      async () => ({ b64Json: png64 })
    )).rejects.toMatchObject({ status: 400 });
  }
});

test("routes Responses image_generation through the HTTP data plane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-responses-image-test-"));
  const fake = join(directory, "grok");
  const grokHome = join(directory, "grok-home");
  const originalCommand = process.env.AGENT_BRIDGE_GROK_COMMAND;
  const originalHome = process.env.GROK_HOME;
  await writeFile(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("grok 1.0.0\\n");
else if (args.includes("--help")) process.stdout.write("Usage: grok\\n");
else {
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let cwd;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {
      authMethods: [{ id: "cached_token" }],
      toolCatalog: ["image_gen", "image_edit"],
      _meta: { modelState: { availableModels: [{ modelId: "grok-test", name: "Grok Test" }] } }
    } });
    else if (message.method === "authenticate") send({ jsonrpc: "2.0", id: message.id, result: {} });
    else if (message.method === "session/new") {
      cwd = realpathSync(message.params.cwd);
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-image" } });
    } else if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { update: {
        sessionUpdate: "tool_call", toolCallId: "call-image", toolName: "image_gen",
        _meta: { "x.ai/tool": { name: "image_gen" } }
      } } });
      send({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {
        toolCall: { toolName: "image_gen", _meta: { "x.ai/tool": { name: "image_gen" } } },
        options: [{ kind: "allow_once", optionId: "allow-once" }]
      } });
    } else if (message.id === 77 && message.result) {
      const root = join(process.env.GROK_HOME, "sessions", encodeURIComponent(cwd), "session-image", "images");
      const path = join(root, "result.png");
      mkdirSync(root, { recursive: true });
      writeFileSync(path, Buffer.from(${JSON.stringify(png64)}, "base64"));
      send({ jsonrpc: "2.0", method: "session/update", params: { update: {
        sessionUpdate: "tool_call_update", toolCallId: "call-image", status: "completed",
        rawOutput: { path }
      } } });
    }
  });
}
`);
  await chmod(fake, 0o755);
  process.env.AGENT_BRIDGE_GROK_COMMAND = fake;
  process.env.GROK_HOME = grokHome;
  const controlToken = "responses-image-test";
  const bridge = await startAgentBridge({ controlToken, preloadModels: false });
  try {
    const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capabilityToken(controlToken, "grok")}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-test",
        input: "draw a clam",
        tools: [{ type: "image_generation" }]
      })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "response",
      output: [{ type: "image_generation_call", result: png64 }]
    });
  } finally {
    await bridge.close();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_GROK_COMMAND;
    else process.env.AGENT_BRIDGE_GROK_COMMAND = originalCommand;
    if (originalHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("reads only regular images below an owned real path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-owned-image-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-bridge-outside-image-"));
  try {
    const image = join(directory, "ok.png");
    const foreign = join(outside, "foreign.png");
    const link = join(directory, "link.png");
    await writeFile(image, png);
    await writeFile(foreign, png);
    await symlink(foreign, link);
    expect(await readOwnedImage(image, directory)).toBe(png64);
    await expect(readOwnedImage(foreign, directory)).rejects.toThrow("outside");
    await expect(readOwnedImage(link, directory)).rejects.toThrow("outside");
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  }
});

test("Codex generation and edit consume result base64 and clean their thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-codex-image-test-"));
  const fake = join(directory, "codex");
  const codexHome = join(directory, "codex-home");
  const source = join(directory, "source.png");
  const originalCommand = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  const originalHome = process.env.CODEX_HOME;
  await writeFile(source, png);
  await writeFile(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const image = Buffer.from(${JSON.stringify(png64)}, "base64");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-image" } } });
  else if (message.method === "turn/start") {
    const text = message.params.input.find((item) => item.type === "text")?.text ?? "";
    const images = message.params.input.filter((item) => item.type === "localImage");
    if (text.includes("combine") && images.length !== 2) {
      send({ id: message.id, result: { turn: { id: "turn-image" } } });
      send({ method: "turn/completed", params: { turn: {
        status: "failed", error: { message: "expected two local images" }
      } } });
      return;
    }
    const root = join(process.env.CODEX_HOME, "generated_images", "thread-image");
    const path = join(root, "output.png");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, image);
    send({ id: message.id, result: { turn: { id: "turn-image" } } });
    send({ method: "item/completed", params: { item: {
      type: "imageGeneration", id: "image-1", status: "completed",
      revisedPrompt: null, result: image.toString("base64"), failure: null, savedPath: path
    } } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
  await chmod(fake, 0o755);
  process.env.AGENT_BRIDGE_CODEX_COMMAND = fake;
  process.env.CODEX_HOME = codexHome;
  try {
    expect(await runCodexImage({ prompt: "draw" })).toEqual({ b64Json: png64 });
    await expect(lstat(join(codexHome, "generated_images", "thread-image"))).rejects.toThrow();
    expect(await runCodexImage({ model: "test", prompt: "blue", imagePaths: [source] }))
      .toEqual({ b64Json: png64 });
    expect(await runCodexImage({ prompt: "combine", imagePaths: [source, source] }))
      .toEqual({ b64Json: png64 });
    await expect(runCodexImage({ prompt: "wide", size: "1600x900" }))
      .rejects.toThrow("does not expose image size");
    await expect(lstat(join(codexHome, "generated_images", "thread-image"))).rejects.toThrow();
  } finally {
    await closeCodexSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCommand;
    if (originalHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Grok generation and edit read and remove only this session image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-grok-image-test-"));
  const fake = join(directory, "grok");
  const grokHome = join(directory, "grok-home");
  const source = join(directory, "source.png");
  const realTemp = join(directory, "real-tmp");
  const tempAlias = join(directory, "tmp-link");
  const originalCommand = process.env.AGENT_BRIDGE_GROK_COMMAND;
  const originalHome = process.env.GROK_HOME;
  const originalTmp = process.env.TMPDIR;
  await mkdir(realTemp);
  await symlink(realTemp, tempAlias);
  await writeFile(source, png);
  await writeFile(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const image = Buffer.from(${JSON.stringify(png64)}, "base64");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let expected;
let callId;
let sessionCwd;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [{ id: "cached_token" }] } });
  else if (message.method === "authenticate") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "session/new") {
    sessionCwd = realpathSync(message.params.cwd);
    const sessionId = process.argv.includes("traversal") ? "../../escape" : "session-image";
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  }
  else if (message.method === "session/prompt") {
    if (process.argv.includes("ratio") && !message.params.prompt[0].text.includes('aspect_ratio "16:9"')) process.exit(9);
    expected = message.params.prompt[0].text.includes("image_edit") ? "image_edit" : "image_gen";
    callId = "call-image";
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "tool_call", toolCallId: callId, toolName: expected,
      _meta: { "x.ai/tool": { name: expected } }
    } } });
    if (process.argv.includes("failure")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { update: {
        sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed",
        rawOutput: { message: "image blocked" }
      } } });
      return;
    }
    send({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {
      toolCall: { toolName: expected, _meta: { "x.ai/tool": { name: expected } } },
      options: [{ kind: "allow_once", optionId: "allow-once" }, { kind: "reject_once", optionId: "reject-once" }]
    } });
  } else if (message.id === 77 && message.result) {
    const root = join(process.env.GROK_HOME, "sessions", encodeURIComponent(sessionCwd), "session-image", "images");
    const path = join(root, "1.jpg");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, image);
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed",
      rawOutput: { type: "ImageGen", path, filename: "1.jpg", session_folder: "images" }
    } } });
  }
});
`);
  await chmod(fake, 0o755);
  process.env.AGENT_BRIDGE_GROK_COMMAND = fake;
  process.env.GROK_HOME = grokHome;
  process.env.TMPDIR = tempAlias;
  try {
    expect(await runGrokImage({ prompt: "draw" })).toEqual({ b64Json: png64 });
    expect(await runGrokImage({ model: "test", prompt: "blue", imagePaths: [source] }))
      .toEqual({ b64Json: png64 });
    await expect(runGrokImage({ prompt: "combine", imagePaths: [source, source] }))
      .rejects.toThrow("at most one");
    await expect(runGrokImage({ prompt: "crop", imagePaths: [source], size: "1600x900" }))
      .rejects.toThrow("ignores aspect_ratio");
    expect(await runGrokImage({ model: "ratio", prompt: "wide", size: "1600x900" }))
      .toEqual({ b64Json: png64 });
    await expect(runGrokImage({ model: "traversal", prompt: "draw" }))
      .rejects.toThrow("outside");
    await expect(runGrokImage({ model: "failure", prompt: "draw" }))
      .rejects.toThrow("image blocked");
    const files = Array.from(new Bun.Glob("sessions/**/*").scanSync(grokHome));
    expect(files).toEqual([]);
  } finally {
    await closeGrokSessions();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_GROK_COMMAND;
    else process.env.AGENT_BRIDGE_GROK_COMMAND = originalCommand;
    if (originalHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalHome;
    if (originalTmp == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps OpenAI size to Grok's native aspect_ratio without guessing", () => {
  expect(grokAspectRatioForSize("auto")).toBe("auto");
  expect(grokAspectRatioForSize("1536x1024")).toBe("3:2");
  expect(grokAspectRatioForSize("2048x1152")).toBe("16:9");
  expect(() => grokAspectRatioForSize("5x4")).toThrow("supports these aspect ratios");
});

test("image runners abort during initialization and clean their temp directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-image-abort-test-"));
  const fake = join(directory, "hung-agent");
  const temp = join(directory, "tmp");
  const originalCodex = process.env.AGENT_BRIDGE_CODEX_COMMAND;
  const originalGrok = process.env.AGENT_BRIDGE_GROK_COMMAND;
  const originalTmp = process.env.TMPDIR;
  await mkdir(temp);
  await writeFile(fake, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  await chmod(fake, 0o755);
  process.env.TMPDIR = temp;
  try {
    process.env.AGENT_BRIDGE_CODEX_COMMAND = fake;
    await expect(runCodexImage(
      { prompt: "draw" },
      { signal: AbortSignal.abort() }
    )).rejects.toThrow("aborted");

    process.env.AGENT_BRIDGE_GROK_COMMAND = fake;
    await expect(runGrokImage(
      { prompt: "draw" },
      { signal: AbortSignal.abort() }
    )).rejects.toThrow("aborted");

    expect(await readdir(temp)).toEqual([]);
  } finally {
    await Promise.all([closeCodexSessions(), closeGrokSessions()]);
    if (originalCodex == null) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
    else process.env.AGENT_BRIDGE_CODEX_COMMAND = originalCodex;
    if (originalGrok == null) delete process.env.AGENT_BRIDGE_GROK_COMMAND;
    else process.env.AGENT_BRIDGE_GROK_COMMAND = originalGrok;
    if (originalTmp == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(directory, { recursive: true, force: true });
  }
});
