import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilityToken,
  startAgentBridge
} from "../src/index.js";
import {
  getDiscoveredCatalog,
  setDiscoveredCatalog
} from "../src/antigravity.js";

test("uploads a file and resolves its id into an AGY image request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-files-test-"));
  const fakeAgy = join(directory, "agy");
  const originalCommand = process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
  const originalCatalog = [...getDiscoveredCatalog()];
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("agy 1.1.21\\n");
else if (args[0] === "models") process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n");
else if (args[0] === "--help") process.stdout.write("Usage: agy\\n");
else {
  const prompt = args[args.indexOf("-p") + 1];
  const path = prompt.match(/Analyze the attached image at (.+?\\.(?:png|jpg|gif|webp))\\./)?.[1];
  const valid = path && existsSync(path) && readFileSync(path).subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const result = valid
    ? { status: "SUCCESS", response: "saw uploaded image" }
    : { status: "ERROR", error: "missing image" };
  process.stdout.write(JSON.stringify({ event: "result", result }) + "\\n");
}
`);
  await chmod(fakeAgy, 0o755);
  process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = fakeAgy;

  const controlToken = "files-test";
  const bridge = await startAgentBridge({
    controlToken,
    preloadModels: false
  });
  try {
    const baseUrl = bridge.baseUrl;
    const apiKey = capabilityToken(controlToken, "antigravity");
    const headers = { authorization: `Bearer ${apiKey}` };
    const form = new FormData();
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    form.set("purpose", "vision");
    form.set("file", new File([png], "sample.png", { type: "image/png" }));

    const uploadResponse = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers,
      body: form
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json() as { id: string };

    expect((await fetch(`${baseUrl}/v1/files/${upload.id}/content`, { headers })).status).toBe(200);
    const otherKey = capabilityToken(controlToken, "codex");
    expect((await fetch(`${baseUrl}/v1/files/${upload.id}`, {
      headers: { authorization: `Bearer ${otherKey}` }
    })).status).toBe(404);

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "Describe it." },
            { type: "input_image", file_id: upload.id }
          ]
        }]
      })
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("saw uploaded image");

    const discovery = await fetch(`${baseUrl}/capabilities`, {
      headers: { authorization: `Bearer ${controlToken}` }
    }).then((value) => value.json()) as any;
    expect(discovery.files).toMatchObject({
      status: "supported",
      scope: "process",
      accepted_media_types: ["*/*"]
    });
    expect(discovery.adapters.find((item: any) => item.id === "antigravity").inputs.image.status)
      .toBe("supported");

    const list = await fetch(`${baseUrl}/v1/files`, { headers })
      .then((value) => value.json()) as any;
    expect(list.data.map((file: any) => file.id)).toEqual([upload.id]);
    expect(await fetch(`${baseUrl}/v1/files/${upload.id}`, {
      method: "DELETE",
      headers
    }).then((value) => value.json())).toMatchObject({
      id: upload.id,
      deleted: true
    });
    expect((await fetch(`${baseUrl}/v1/files/${upload.id}`, { headers })).status).toBe(404);
  } finally {
    await bridge.close();
    if (originalCommand == null) delete process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
    else process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND = originalCommand;
    setDiscoveredCatalog(originalCatalog);
    await rm(directory, { recursive: true, force: true });
  }
});
