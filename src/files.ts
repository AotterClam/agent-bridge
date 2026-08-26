import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest } from "./protocol.js";
import type { ResponsesRequest } from "./responses.js";
import { MAX_INPUT_BYTES } from "./inputs.js";

const MAX_FILE_BODY = 22 * 1024 * 1024;

export const fileStorageCapability = {
  status: "supported" as const,
  scope: "process" as const,
  persistence: "Files are deleted when the bridge closes",
  max_file_bytes: MAX_INPUT_BYTES,
  accepted_media_types: ["*/*"],
  resolves_file_id_for: ["input_image", "input_file", "chat.file", "images.edit"],
  endpoints: [
    "POST /v1/files",
    "GET /v1/files",
    "GET /v1/files/{file_id}",
    "GET /v1/files/{file_id}/content",
    "DELETE /v1/files/{file_id}"
  ]
};

export type FileObject = {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
};

type StoredFile = FileObject & {
  owner: string;
  mediaType: string;
  path: string;
};

function httpError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function publicFile(file: StoredFile): FileObject {
  const { owner: _owner, mediaType: _mediaType, path: _path, ...value } = file;
  return value;
}

async function requestBytes(request: IncomingMessage) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_FILE_BODY) {
    httpError(413, "File upload request exceeds 22 MiB.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_FILE_BODY) httpError(413, "File upload request exceeds 22 MiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createFileStore() {
  const root = mkdtemp(join(tmpdir(), "agent-bridge-files-"));
  const files = new Map<string, StoredFile>();

  const stored = (owner: string, id: string) => {
    const file = files.get(id);
    if (!file || file.owner !== owner) httpError(404, `File ${id} not found.`);
    return file;
  };

  return {
    capability: fileStorageCapability,
    async upload(request: IncomingMessage, owner: string) {
      const contentType = request.headers["content-type"] ?? "";
      if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
        httpError(400, "Content-Type must be multipart/form-data.");
      }
      const bytes = await requestBytes(request);
      let form: FormData;
      try {
        form = await new Response(bytes, {
          headers: { "content-type": contentType }
        }).formData();
      } catch {
        httpError(400, "Request body must be valid multipart/form-data.");
      }
      for (const key of form.keys()) {
        if (key !== "file" && key !== "purpose") {
          httpError(400, `Unsupported file upload field "${key}".`);
        }
      }
      const upload = form.get("file");
      const purpose = form.get("purpose");
      if (form.getAll("file").length !== 1 || form.getAll("purpose").length !== 1) {
        httpError(400, "Exactly one file and purpose are required.");
      }
      if (!(upload instanceof File) || !upload.name) httpError(400, "file is required.");
      if (typeof purpose !== "string" || !purpose) httpError(400, "purpose is required.");
      const data = Buffer.from(await upload.arrayBuffer());
      if (data.length > MAX_INPUT_BYTES) httpError(413, "File exceeds 20 MiB.");
      const id = `file-${randomUUID().replaceAll("-", "")}`;
      const path = join(await root, id);
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
      const file: StoredFile = {
        id,
        object: "file",
        bytes: data.length,
        created_at: Math.floor(Date.now() / 1000),
        filename: upload.name,
        purpose,
        owner,
        mediaType: /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(upload.type)
          ? upload.type
          : "application/octet-stream",
        path
      };
      files.set(id, file);
      return publicFile(file);
    },
    list(owner: string) {
      return [...files.values()]
        .filter((file) => file.owner === owner)
        .sort((a, b) => b.created_at - a.created_at)
        .map(publicFile);
    },
    get(owner: string, id: string) {
      return publicFile(stored(owner, id));
    },
    async read(owner: string, id: string) {
      const file = stored(owner, id);
      return {
        ...publicFile(file),
        mediaType: file.mediaType,
        data: await readFile(file.path)
      };
    },
    async delete(owner: string, id: string) {
      const file = stored(owner, id);
      files.delete(id);
      await rm(file.path, { force: true });
      return { id, object: "file" as const, deleted: true };
    },
    async close() {
      files.clear();
      await rm(await root, { recursive: true, force: true });
    }
  };
}

export type FileStore = ReturnType<typeof createFileStore>;

function dataUrl(file: Awaited<ReturnType<FileStore["read"]>>) {
  return `data:${file.mediaType};base64,${file.data.toString("base64")}`;
}

export async function materializeChatFileIds(
  input: ChatRequest,
  store: FileStore,
  owner: string
) {
  for (const message of input.messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "file" || !part.file.file_id) continue;
      if (part.file.file_data || part.file.file_url) {
        httpError(400, "file must use exactly one of file_data, file_url, or file_id.");
      }
      const file = await store.read(owner, part.file.file_id);
      part.file = {
        filename: part.file.filename || file.filename,
        file_data: dataUrl(file)
      };
    }
  }
  return input;
}

export async function materializeResponseFileIds(
  input: ResponsesRequest,
  store: FileStore,
  owner: string
) {
  if (typeof input.input === "string") return input;
  for (const item of input.input) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part.file_id) continue;
      if (part.type === "input_image") {
        if (part.image_url) httpError(400, "input_image must use image_url or file_id, not both.");
        const file = await store.read(owner, part.file_id);
        part.image_url = dataUrl(file);
        part.file_id = undefined;
      } else if (part.type === "input_file") {
        if (part.file_data || part.file_url) {
          httpError(400, "input_file must use exactly one of file_data, file_url, or file_id.");
        }
        const file = await store.read(owner, part.file_id);
        part.file_data = dataUrl(file);
        part.filename ||= file.filename;
        part.file_id = undefined;
      }
    }
  }
  return input;
}
