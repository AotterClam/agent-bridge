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
