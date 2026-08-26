import type { IncomingMessage } from "node:http";
import { constants } from "node:fs";
import { access, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { FileStore } from "./files.js";
import { decodeImageDataUrl } from "./inputs.js";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BODY = 52 * 1024 * 1024;
export const MAX_EDIT_IMAGES = 16;
export const MAX_IMAGE_URL_CHARS = 20_971_520;
const imageSizeSchema = z.string().regex(/^(?:auto|[1-9]\d*x[1-9]\d*)$/);
const generationSchema = z
  .object({
    model: z.string().min(1).nullish(),
    prompt: z.string().min(1),
    n: z.literal(1).nullish(),
    stream: z.literal(false).nullish(),
    partial_images: z.literal(0).nullish(),
    response_format: z.literal("b64_json").nullish(),
    size: imageSizeSchema.nullish()
  })
  .strict();
const editControls = {
  model: z.string().min(1).nullish(),
  prompt: z.string().min(1),
  n: z.literal(1).nullish(),
  stream: z.literal(false).nullish(),
  partial_images: z.literal(0).nullish(),
  response_format: z.literal("b64_json").nullish(),
  size: imageSizeSchema.nullish()
};
const editJsonSchema = z
  .object({
    ...editControls,
    images: z.array(z
      .object({
        file_id: z.string().min(1).optional(),
        image_url: z.string().min(1).max(MAX_IMAGE_URL_CHARS).optional()
      })
      .strict()
      .refine(
        (image) => Number(Boolean(image.file_id)) + Number(Boolean(image.image_url)) === 1,
        { message: "Each image must use exactly one of file_id or image_url." }
      )).min(1).max(MAX_EDIT_IMAGES)
  })
  .strict();

export type ImageRequest = {
  model?: string;
  prompt: string;
  imagePaths?: string[];
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
type ParsedImageRequest = {
  input: ImageRequest;
  cleanup: () => Promise<void>;
};

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

export async function parseGenerationRequest(
  request: IncomingMessage
): Promise<ParsedImageRequest> {
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

function validateInputImage(data: Buffer) {
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image upload exceeds 50 MiB"), { status: 413 });
  }
  try {
    return imageExtension(data);
  } catch {
    badRequest("Only PNG, JPEG, and WebP images are supported.");
  }
}

async function materializeEditImages(
  images: Buffer[],
  controls: {
    model?: string | null;
    prompt: string;
    size?: string | null;
  }
) {
  const extensions = images.map(validateInputImage);
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-image-"));
  const imagePaths = extensions.map((extension, index) =>
    join(directory, `input-${index}${extension}`)
  );
  try {
    await Promise.all(imagePaths.map((path, index) =>
      writeFile(path, images[index]!, { flag: "wx", mode: 0o600 })
    ));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    input: {
      ...(controls.model ? { model: controls.model } : {}),
      prompt: controls.prompt,
      imagePaths,
      ...(controls.size ? { size: controls.size } : {})
    } satisfies ImageRequest,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

export async function parseEditRequest(
  request: IncomingMessage,
  store: FileStore,
  owner: string
): Promise<ParsedImageRequest> {
  const contentType = request.headers["content-type"] ?? "";
  const data = await bytes(request);
  if (/^application\/json(?:;|$)/i.test(contentType)) {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString("utf8"));
    } catch {
      badRequest("Request body must be valid JSON.");
    }
    const parsed = editJsonSchema.safeParse(payload);
    if (!parsed.success) badRequest(z.prettifyError(parsed.error));
    const images = await Promise.all(parsed.data.images.map(async (image) => {
      if (image.file_id) return (await store.read(owner, image.file_id)).data;
      return decodeImageDataUrl(image.image_url!, MAX_IMAGE_BYTES).bytes;
    }));
    return materializeEditImages(images, parsed.data);
  }
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    badRequest("Content-Type must be application/json or multipart/form-data.");
  }
  let form: FormData;
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
  const images: Array<string | File> = [];
  for (const [key, value] of form.entries()) {
    if (key === "image" || key === "image[]") images.push(value);
  }
  if (
    images.length < 1 ||
    images.length > MAX_EDIT_IMAGES ||
    !images.every((image): image is File => image instanceof File)
  ) {
    badRequest(`Between 1 and ${MAX_EDIT_IMAGES} image uploads are required.`);
  }
  return materializeEditImages(
    await Promise.all(images.map(async (image) =>
      Buffer.from(await image.arrayBuffer())
    )),
    {
      ...(typeof model === "string" ? { model } : {}),
      prompt,
      ...(typeof size === "string" ? { size } : {})
    }
  );
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
