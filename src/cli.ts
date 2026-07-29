#!/usr/bin/env bun

import { listen } from "./index.js";

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
