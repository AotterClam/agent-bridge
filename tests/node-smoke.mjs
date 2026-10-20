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
  if (m.method === "thread/inject_items") globalThis.native = true;
  console.log(JSON.stringify({ id: m.id, result }));
  if (m.method === "turn/start" && globalThis.native) {
    console.log(JSON.stringify({ method: "turn/started", params: { turn: { id: "native-turn" } } }));
    console.log(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { type: "tool_search_call", id: "native-search", call_id: "search-call", execution: "client", arguments: { query: "shipping" }, status: "completed" } } }));
    console.log(JSON.stringify({ method: "rawResponse/completed", params: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } }));
  }
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
  const nativeBody = { model: "test", input: "Shipping", tools: [{ type: "tool_search", execution: "client", description: "Find shipping tools", parameters: { type: "object", properties: { query: { type: "string" } } } }] };
  const endpoint = `http://127.0.0.1:${cancelBridge.server.address().port}/v1/responses`;
  const rejected = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: JSON.stringify(nativeBody) });
  assert.equal(rejected.status, 401);
  const native = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${capabilityToken("cancel-test", "codex")}`, "content-type": "application/json" }, body: JSON.stringify(nativeBody) });
  assert.equal(native.status, 200);
  const payload = await native.json();
  assert.equal(payload.output[0].type, "tool_search_call");
  assert.equal(payload.output[0].call_id, "search-call");
  assert.deepEqual(payload.output[0].arguments, { query: "shipping" });
  assert.equal(payload.usage.total_tokens, 3);

  const loadedHistory = [
    { role: "user", content: "Shipping" },
    { type: "tool_search_call", call_id: "loaded-search", execution: "client", arguments: { query: "shipping" } },
    { type: "tool_search_output", call_id: "loaded-search", execution: "client", status: "completed", tools: [{ type: "function", name: "get_eta", parameters: { type: "object" } }] }
  ];
  for (const input of ["Shipping", loadedHistory]) {
    for (const stream of [false, true]) {
      const unsupported = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${capabilityToken("cancel-test", "codex")}`, "content-type": "application/json" }, body: JSON.stringify({ ...nativeBody, input, stream, tool_choice: "none" }) });
      assert.equal(unsupported.status, 400);
      assert.match(unsupported.headers.get("content-type"), /application\/json/);
      assert.match((await unsupported.json()).error.message, /tool_choice auto only/);
    }
  }
} finally {
  clearTimeout(timeout);
  await cancelBridge.close();
  if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_COMMAND;
  else process.env.AGENT_BRIDGE_CODEX_COMMAND = previous;
  await rm(directory, { recursive: true, force: true });
}
