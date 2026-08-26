import type { ChatRequest } from "./protocol.js";

export type InputCapabilityStatus = "supported" | "unsupported" | "unknown";
export type InputCapability = {
  status: InputCapabilityStatus;
  probe: string;
  evidence: string;
  supported_openai_content_parts: string[];
  parameter_constraints: Record<string, unknown>;
  provider_capabilities: Record<string, unknown>;
};
export type InputCapabilities = {
  image: InputCapability;
  audio: InputCapability;
  pdf: InputCapability;
};
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export type ImageInput = {
  url: string;
  detail?: "auto" | "low" | "high";
};
export type AudioInput = { data: string; format: "wav" | "mp3" };
export type FileInput = {
  filename?: string;
  file_data?: string;
  file_url?: string;
  file_id?: string;
};

function contentParts(input: ChatRequest) {
  return input.messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content
      : []
  );
}

export function imageInputs(input: ChatRequest): ImageInput[] {
  return contentParts(input).flatMap((part) => {
    if (part.type !== "image_url") return [];
    return typeof part.image_url === "string"
      ? [{ url: part.image_url }]
      : [{ url: part.image_url.url, detail: part.image_url.detail }];
  });
}

export function audioInputs(input: ChatRequest): AudioInput[] {
  return contentParts(input).flatMap((part) =>
    part.type === "input_audio" ? [part.input_audio] : []
  );
}

export function decodeAudioInput(input: AudioInput) {
  const bytes = base64Bytes(input.data, "input_audio");
  const valid = input.format === "wav"
    ? bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WAVE"
    : bytes.subarray(0, 3).toString("ascii") === "ID3" ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (!valid) badRequest(`input_audio does not contain valid ${input.format.toUpperCase()} data.`);
  return bytes;
}

export function fileInputs(input: ChatRequest): FileInput[] {
  return contentParts(input).flatMap((part) =>
    part.type === "file" ? [part.file] : []
  );
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function base64Bytes(value: string, label: string, maxBytes = MAX_INPUT_BYTES) {
  const compact = value.replace(/\s/g, "");
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    badRequest(`${label} must contain valid base64 data.`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length > maxBytes) {
    badRequest(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
  }
  if (
    bytes.toString("base64").replace(/=+$/, "") !==
    compact.replace(/=+$/, "")
  ) {
    badRequest(`${label} must contain valid base64 data.`);
  }
  return bytes;
}

export function decodeDataUrl(
  value: string,
  label: string,
  maxBytes = MAX_INPUT_BYTES
) {
  const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) badRequest(`${label} must be a base64 data URL.`);
  return {
    mediaType: match[1]!.toLowerCase(),
    bytes: base64Bytes(match[2]!, label, maxBytes)
  };
}

function detectedImageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
}

export function decodeImageDataUrl(value: string, maxBytes?: number) {
  const decoded = decodeDataUrl(value, "image_url", maxBytes);
  const detected = detectedImageType(decoded.bytes);
  if (!detected || detected !== decoded.mediaType) {
    badRequest("image_url MIME type does not match PNG, JPEG, GIF, or WebP data.");
  }
  return { ...decoded, mediaType: detected };
}

export function validateRemoteUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    badRequest(`${label} must be an HTTP(S) URL or base64 data URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    badRequest(`${label} must use HTTP or HTTPS.`);
  }
  return url.toString();
}

export function pdfSource(input: FileInput) {
  if ([input.file_id, input.file_url, input.file_data].filter(Boolean).length > 1) {
    badRequest("PDF input must use exactly one of file_data, file_url, or file_id.");
  }
  if (input.file_id) {
    badRequest("file_id is not supported: this bridge does not store uploaded files.");
  }
  if (input.file_url) {
    return { type: "url" as const, url: validateRemoteUrl(input.file_url, "file_url") };
  }
  if (!input.file_data) badRequest("PDF input requires file_data or file_url.");
  const decoded = input.file_data.startsWith("data:")
    ? decodeDataUrl(input.file_data, "file_data")
    : {
        mediaType: "application/pdf",
        bytes: base64Bytes(input.file_data, "file_data")
      };
  if (
    decoded.mediaType !== "application/pdf" ||
    decoded.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    badRequest("Only valid application/pdf file inputs are supported.");
  }
  return {
    type: "base64" as const,
    media_type: "application/pdf" as const,
    data: decoded.bytes.toString("base64")
  };
}
