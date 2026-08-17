#!/usr/bin/env bun
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAgentBridge } from "../src/index.ts";

const bridge = createAgentBridge({
  controlToken: "grok-smoke",
  preloadModels: false
});

const close = () => bridge.close();

try {
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const address = bridge.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const capabilities = await fetch(`${base}/capabilities`, {
    headers: { authorization: "Bearer grok-smoke" }
  });
  assert.equal(capabilities.status, 200);
  const body = await capabilities.json();
  const grok = body.adapters.find((adapter) => adapter.id === "grok");
  assert(grok, "capabilities did not include a grok adapter");

  if (!grok.available) {
    console.log(`skip grok smoke: ${grok.error ?? "Grok unavailable"}`);
    process.exit(0);
  }

  const model = grok.models[0]?.id;
  assert(model, "Grok advertised no models");
  console.log(`grok smoke using ${model} (${grok.version ?? "unknown version"})`);

  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grok.capabilityToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      reasoning_effort: "low",
      messages: [{
        role: "user",
        content: "Reply with exactly PONG and nothing else. Do not use tools."
      }]
    })
  });
  const payload = await completion.json();
  assert.equal(completion.status, 200, JSON.stringify(payload));
  const text = payload.choices?.[0]?.message?.content ?? "";
  assert.match(text, /PONG/i, `unexpected completion: ${JSON.stringify(payload)}`);
  console.log("grok smoke ok:", JSON.stringify(text));
} finally {
  await close();
}
