import type { IncomingMessage } from "node:http";
import { constants } from "node:fs";
import { access, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BODY = 52 * 1024 * 1024;
const imageSizeSchema = z.string().regex(/^(?:auto|[1-9]\d*x[1-9]\d*)$/);
const generationSchema = z
  .object({
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    n: z.literal(1).optional(),
    stream: z.literal(false).optional(),
    partial_images: z.literal(0).optional(),
    response_format: z.literal("b64_json").optional(),
    size: imageSizeSchema.optional()
  })
  .strict();

export type ImageRequest = {
  model?: string;
  prompt: string;
  imagePath?: string;
  size?: string;
};

export type ImageResult = {
  b64Json: string;
  revisedPrompt?: string;
};

export type ImageRunner = (
  input: ImageRequest,
  options?: { signal?: AbortSignal }
) => Promise<ImageResult>;

export type ImageCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ImageCapability = {
  status: ImageCapabilityStatus;
  probe: string;
  evidence: string;
  supported_openai_params: readonly string[];
  parameter_constraints: Record<string, unknown>;
  provider_capabilities: Record<string, unknown>;
};
export type ImageCapabilities = {
  generation: ImageCapability;
  edit: ImageCapability;
  responsesImageGeneration: ImageCapability;
  fingerprint: {
    executable: string | null;
    version: string | null;
  };
};

export async function executableFingerprint(executable: string, version: string | null) {
  const candidates = executable.includes("/")
    ? [executable]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return { executable: await realpath(candidate), version };
    } catch {}
  }
  return { executable: null, version };
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

async function bytes(request: IncomingMessage) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BODY) {
    throw Object.assign(new Error("Request exceeds 52 MiB"), { status: 413 });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_IMAGE_BODY) {
      throw Object.assign(new Error("Request exceeds 52 MiB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function imageExtension(value: Uint8Array) {
  const data = Buffer.from(value);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return ".png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  throw new Error("Only PNG, JPEG, and WebP images are supported.");
}

export function validateImageBase64(value: string) {
  if (
    !value ||
    value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("Image runtime returned invalid base64");
  }
  const data = Buffer.from(value, "base64");
  imageExtension(data);
  return value;
}

export async function readOwnedImage(path: string, root: string) {
  if (!isAbsolute(path)) throw new Error("Image runtime returned a relative path");
  const [ownedRoot, candidate] = await Promise.all([realpath(root), realpath(path)]);
  const child = relative(ownedRoot, candidate);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Image runtime returned a path outside its owned directory");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error("Image runtime did not return a regular image file");
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error("Image runtime returned an image over 50 MiB");
    }
    const data = await file.readFile();
    imageExtension(data);
    return data.toString("base64");
  } finally {
    await file.close();
  }
}

export async function parseGenerationRequest(request: IncomingMessage) {
  let payload: unknown;
  try {
    payload = JSON.parse((await bytes(request)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) badRequest("Request body must be valid JSON.");
    throw error;
  }
  const parsed = generationSchema.safeParse(payload);
  if (!parsed.success) badRequest(z.prettifyError(parsed.error));
  return {
    input: {
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      prompt: parsed.data.prompt,
      ...(parsed.data.size ? { size: parsed.data.size } : {})
    } satisfies ImageRequest,
    cleanup: async () => {}
  };
}

export async function parseEditRequest(request: IncomingMessage) {
  const contentType = request.headers["content-type"] ?? "";
  let form: FormData;
  const data = await bytes(request);
  try {
    form = await new Response(data, {
      headers: { "content-type": contentType }
    }).formData();
  } catch {
    badRequest("Request body must be valid multipart/form-data.");
  }
  const allowed = new Set([
    "model",
    "prompt",
    "image",
    "image[]",
    "n",
    "stream",
    "partial_images",
    "response_format",
    "size"
  ]);
  for (const key of form.keys()) {
    if (!allowed.has(key)) badRequest(`Unsupported image edit field "${key}".`);
  }
  const model = form.get("model");
  const prompt = form.get("prompt");
  const size = form.get("size");
  if (model != null && (typeof model !== "string" || !model)) {
    badRequest("model must be a non-empty string.");
  }
  if (typeof prompt !== "string" || !prompt) badRequest("prompt is required.");
  if (size != null && (typeof size !== "string" || !imageSizeSchema.safeParse(size).success)) {
    badRequest("size must be auto or WIDTHxHEIGHT.");
  }
  for (const [key, expected] of [
    ["n", "1"],
    ["stream", "false"],
    ["partial_images", "0"],
    ["response_format", "b64_json"]
  ] as const) {
    const value = form.get(key);
    if (value != null && value !== expected) badRequest(`Unsupported ${key}: ${String(value)}.`);
  }
  const images = [...form.getAll("image"), ...form.getAll("image[]")];
  if (images.length !== 1 || typeof images[0] === "string") {
    badRequest("Exactly one image upload is required.");
  }
  const upload = images[0] as File;
  const imageData = Buffer.from(await upload.arrayBuffer());
  if (imageData.byteLength > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image upload exceeds 50 MiB"), { status: 413 });
  }
  let extension: string;
  try {
    extension = imageExtension(imageData);
  } catch {
    badRequest("Only PNG, JPEG, and WebP images are supported.");
  }
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-image-"));
  const imagePath = join(directory, `input${extension}`);
  try {
    await writeFile(imagePath, imageData, { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    input: {
      ...(typeof model === "string" ? { model } : {}),
      prompt,
      imagePath,
      ...(typeof size === "string" ? { size } : {})
    } satisfies ImageRequest,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

export function imageResponse(result: ImageResult) {
  validateImageBase64(result.b64Json);
  return Response.json({
    created: Math.floor(Date.now() / 1000),
    data: [{
      b64_json: result.b64Json,
      ...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {})
    }]
  });
}

export function ownedChild(root: string, child: string) {
  const path = resolve(root, child);
  const nested = relative(resolve(root), path);
  if (!nested || nested.startsWith("..") || isAbsolute(nested)) {
    throw new Error("Image runtime returned a path outside its owned directory");
  }
  return path;
}
