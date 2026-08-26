import { expect, test } from "bun:test";
import {
  decodeAudioInput,
  decodeImageDataUrl,
  pdfSource
} from "../src/inputs.js";
import { chatRequestSchema, promptFor } from "../src/protocol.js";

test("validates binary signatures and keeps attachment bytes out of transcripts", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  expect(decodeImageDataUrl(png).mediaType).toBe("image/png");
  expect(() => decodeImageDataUrl("data:image/jpeg;base64,iVBORw0KGgo="))
    .toThrow("MIME type does not match");
  expect(pdfSource({
    filename: "tiny.pdf",
    file_data: Buffer.from("%PDF-1.4\n").toString("base64")
  })).toMatchObject({ type: "base64", media_type: "application/pdf" });
  expect(() => pdfSource({ file_id: "file_1" })).toThrow("does not store uploaded files");
  expect(() => pdfSource({
    file_url: "https://example.com/a.pdf",
    file_data: Buffer.from("%PDF-1.4\n").toString("base64")
  })).toThrow("exactly one");
  expect(decodeAudioInput({
    format: "wav",
    data: Buffer.from("RIFF0000WAVE").toString("base64")
  }).length).toBe(12);
  expect(() => decodeAudioInput({
    format: "mp3",
    data: Buffer.from("not mp3").toString("base64")
  })).toThrow("valid MP3");

  const request = chatRequestSchema.parse({
    model: "test",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image_url", image_url: png }
      ]
    }]
  });
  const transcript = promptFor(request.messages, request.tool_choice);
  expect(transcript).toContain('"attachment":true');
  expect(transcript).not.toContain("iVBORw0KGgo");
});
