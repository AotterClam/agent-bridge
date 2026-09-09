import assert from "node:assert/strict";
import { once } from "node:events";
import { createAgentBridge } from "@aotterclam/agent-bridge";

const bridge = createAgentBridge({
  controlToken: "node-smoke",
  preloadModels: false,
});

try {
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const address = bridge.server.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
} finally {
  await bridge.close();
}

// Node owns the production HTTP server. Exercise a real mid-stream disconnect:
// Bun 1.3's node:http shim does not emit ServerResponse.close in this case.
const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { capabilityToken } = await import("@aotterclam/agent-bridge");
const directory = await mkdtemp(join(tmpdir(), "bridge-node-cancel-"));
const command = join(directory, "codex.mjs");
const previous = process.env.AGENT_BRIDGE_CODEX_COMMAND;
await writeFile(command, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-test"); process.exit(0); }
if (process.argv.includes("generate-json-schema")) process.exit(0);
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  const result = m.method === "model/list" ? { data: [{ model: "test" }], nextCursor: null }
    : m.method === "thread/start" ? { thread: { id: "test" } } : {};
  console.log(JSON.stringify({ id: m.id, result }));
});
`);
await chmod(command, 0o755);
process.env.AGENT_BRIDGE_CODEX_COMMAND = command;
const records = [];
let canceled;
const closed = new Promise(resolve => { canceled = resolve; });
const cancelBridge = createAgentBridge({ controlToken: "cancel-test", preloadModels: false,
  logger: { level: "info", onLog(record) { records.push(record); if (record.meta?.outcome === "canceled") canceled(record); } },
  reconnect: { support: { codex: { label: "test", probe: async () => ({ state: "ready" }), login: () => ({ command: "unused", args: [] }) } } }
});
let timeout;
try {
  cancelBridge.server.listen(0, "127.0.0.1");
  await once(cancelBridge.server, "listening");
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${cancelBridge.server.address().port}/v1/responses`, {
    method: "POST", signal: controller.signal,
    headers: { authorization: `Bearer ${capabilityToken("cancel-test", "codex")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test", input: "hello", stream: true })
  });
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(records.filter(r => r.scope === "http").length, 0);
  controller.abort();
  await reader.cancel().catch(() => {});
  const record = await Promise.race([closed, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Missing cancellation log")), 2000);
  })]);
  assert.equal(record.meta.status, 200);
  assert.equal(record.meta.outcome, "canceled");
  assert.equal(records.filter(r => r.scope === "http").length, 1);
} finally {
  clearTimeout(timeout);
  await cancelBridge.close();
  if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
  else process.env.AGENT_BRIDGE_CODEX_COMMAND = previous;
  await rm(directory, { recursive: true, force: true });
}
