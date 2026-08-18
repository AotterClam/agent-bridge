# @aotterclam/agent-bridge

[![npm version](https://img.shields.io/npm/v/%40aotterclam%2Fagent-bridge)](https://www.npmjs.com/package/@aotterclam/agent-bridge)

A loopback OpenAI-compatible API for Claude Code, Codex, and Grok Build. It
uses the official local runtimes and their existing credentials while keeping
their native model IDs, streaming, reasoning, and function tools.

## Install

```sh
bun add @aotterclam/agent-bridge
```

`npm install @aotterclam/agent-bridge` works too. The package is published on
[npm](https://www.npmjs.com/package/@aotterclam/agent-bridge), not GitHub
Packages.

## Quick start

Let the host application own the bridge. `startAgentBridge()` creates a random
control token and asks the operating system for an unused loopback port.

```ts
import { startAgentBridge } from "@aotterclam/agent-bridge";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const bridge = await startAgentBridge();
const { adapter, baseUrl, apiKey } = await bridge.connection("grok");

const model = createOpenAICompatible({
  name: "local-agent-bridge",
  baseURL: baseUrl,
  apiKey,
}).chatModel(adapter.models[0]!.id);
```

Change `"grok"` to `"claude"` or `"codex"` to select another installed
agent. Call `await bridge.close()` during application shutdown.

| Adapter ID | Local requirement |
| --- | --- |
| `claude` | Claude Code installed and signed in |
| `codex` | Codex CLI installed and signed in |
| `grok` | Grok Build CLI installed and signed in |

Requires Node.js 22+ or Bun 1.3+.

## Discover agents and models

```ts
const adapters = await bridge.adapters({ refresh: true });
```

Each adapter reports availability, version, native model IDs, and supported
reasoning efforts. `connection(id)` rejects unavailable adapters and returns
the selected adapter plus its `/v1` base URL and capability token.

The capability token selects the runtime; the model ID selects one of that
runtime's models. There is no separate switch endpoint.

## Reasoning effort and reasoning visibility

Effort support and visible reasoning are separate capabilities. The
bridge-specific `/capabilities` endpoint reports what each official runtime
advertises; it is not part of the OpenAI API.

| Adapter | Effort metadata | Reasoning text |
| --- | --- | --- |
| Claude Code | Per-model Agent SDK metadata; no default | Only when the SDK emits non-empty thinking |
| Codex | Per-model app-server levels and default | Streamed when emitted |
| Grok Build | ACP `initialize` metadata, including its advertised default; empty on `grok models` fallback | ACP `agent_thought_chunk` when emitted |

An empty `reasoningEfforts` list means the runtime did not advertise levels;
the bridge does not invent them. `reasoning_effort` is forwarded unchanged
when supplied by the caller.

## Connect to a standalone bridge

Start a fixed-port process when another process owns its lifecycle:

```sh
export AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
npx @aotterclam/agent-bridge
```

It listens on `127.0.0.1:3457` by default. Connect with the same control token:

```ts
import { createAgentBridgeClient } from "@aotterclam/agent-bridge";

const bridge = createAgentBridgeClient({
  baseUrl: "http://127.0.0.1:3457",
  controlToken: process.env.AGENT_BRIDGE_CONTROL_TOKEN!,
});
```

Use `startAgentBridge({ port: 3457 })` only when the host also needs a fixed
port. Lower-level `createAgentBridge()` and `listen()` exports remain available
for custom server lifecycle control.

## Protocol

```text
GET  /health
GET  /capabilities
GET  /v1/models
POST /v1/chat/completions
```

Chat completions support regular and SSE responses, OpenAI function-tool
calls, and reasoning deltas when the official runtime supplies them.
The `/v1` routes are the OpenAI-compatible data plane; `/capabilities` uses the
separate control token for local discovery.

Antigravity is not supported because Google does not publish an official
embeddable runtime.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_PORT` | `3457` | Standalone listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | `local-development-only` | Standalone discovery token |
| `AGENT_BRIDGE_CLAUDE_TIMEOUT_MS` | `300000` | Claude turn timeout |
| `AGENT_BRIDGE_CODEX_TIMEOUT_MS` | `300000` | Codex turn timeout |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable |
| `AGENT_BRIDGE_GROK_TIMEOUT_MS` | `300000` | Grok turn timeout |
| `AGENT_BRIDGE_GROK_COMMAND` | `grok` | Grok executable |

## Safety

The bridge only accepts loopback HTTP URLs and uses credentials already owned
by the official clients. Do not expose it through a public listener, proxy,
tunnel, or remote port forward. Keep control and capability tokens out of logs,
analytics, and project files.

Users remain responsible for provider, employer, and customer policies. This
project is not affiliated with or endorsed by Anthropic, OpenAI, or xAI.

## Development

```sh
bun install
bun run check
bun test
npm run test:node
bun run test:grok
```

`bun run test:grok` requires the Grok CLI; the default test suite does not.

## License

MIT
