#!/usr/bin/env bun

export {};

const entry = process.argv[1];
process.argv[1] = "agent-bridge";
const { listen } = await import("./index.js");
process.argv[1] = entry;

const bridge = await listen();
console.log(
  `agent bridge listening on http://127.0.0.1:${process.env.AGENT_BRIDGE_PORT ?? 3457}/v1`
);

const close = async () => {
  await bridge.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
