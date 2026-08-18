# @aotterclam/agent-bridge

[![npm version](https://img.shields.io/npm/v/%40aotterclam%2Fagent-bridge)](https://www.npmjs.com/package/@aotterclam/agent-bridge)

A local OpenAI-compatible bridge for official coding-agent runtimes.

It provides one loopback API for Claude Code, Codex, and Grok Build while
preserving each provider's native model IDs, streaming text, reasoning, and
function tools. Credentials stay with the official local clients.

| Adapter | Official integration | Text | Reasoning | Tools |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Streaming | Streaming, model-dependent | Yes |
| Codex | `codex app-server` | Streaming | Streaming | Yes |
| Grok Build | `grok agent stdio` (ACP) | Streaming | Streaming | Yes |

Antigravity is not supported until Google publishes an official embeddable
SDK.

## Requirements

- Node.js 22 or newer, or Bun 1.3 or newer
- Claude Code installed and signed in for the Claude adapter
- Codex CLI installed and signed in for the Codex adapter
- Grok Build CLI installed and signed in for the Grok adapter

## Install

Published on [npm](https://www.npmjs.com/package/@aotterclam/agent-bridge), not
GitHub Packages.

```sh
npm install @aotterclam/agent-bridge
```

Or with Bun:

```sh
bun add @aotterclam/agent-bridge
```

## Run

Start the standalone loopback service with a random control token:

```sh
export AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
npx @aotterclam/agent-bridge
```

With Bun:

```sh
export AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
bunx @aotterclam/agent-bridge
```

The service listens on `127.0.0.1:3457` by default.

Check adapter availability:

```sh
curl \
  -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" \
  http://127.0.0.1:3457/capabilities
```

The response contains an opaque capability token for each available adapter.
Use that token as the API key and keep the selected native model ID unchanged.

## Select an agent

The bridge does not have a separate switch endpoint. The adapter's capability
token selects the runtime; the model ID selects one of that adapter's models.
The base URL stays the same.

| Agent | Adapter ID |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Grok Build | `grok` |

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const selectedAgent = "grok"; // Change to "claude" or "codex".
const response = await fetch("http://127.0.0.1:3457/capabilities", {
  headers: { authorization: `Bearer ${process.env.AGENT_BRIDGE_CONTROL_TOKEN}` },
});
if (!response.ok) throw new Error(`Capabilities returned ${response.status}`);

const { adapters } = await response.json();
const selectedAdapter = adapters.find(({ id }) => id === selectedAgent);
const selectedModel = selectedAdapter?.models[0];
if (!selectedAdapter?.available || !selectedModel) {
  throw new Error(`${selectedAgent} is unavailable`);
}

const provider = createOpenAICompatible({
  name: "local-agent-bridge",
  baseURL: "http://127.0.0.1:3457/v1",
  apiKey: selectedAdapter.capabilityToken,
});

const model = provider.chatModel(selectedModel.id);
```

To switch agents, select another adapter and use its capability token and model
on the next client or request. The control token is only for `/capabilities`;
do not use it for `/v1` requests.

Available OpenAI-compatible endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
```

Chat completions support regular and SSE responses, reasoning deltas when
provided by the adapter, and OpenAI function-tool calls.

## Reasoning effort and reasoning visibility

Two independent capabilities. `reasoning_effort` is forwarded to the adapter
(Claude SDK `effort`, Codex reasoning level); whether the model then *shows* its
reasoning is separate and not the bridge's to control. `GET /capabilities`
reports `reasoningEfforts` per model from each runtime's own metadata. Codex
also reports a per-model default; the Claude SDK does not, so
`defaultReasoningEffort` is absent there.

Measured 2026-07-30 (claude-agent-sdk 0.3.220, codex-cli 0.144.4):

| Model | `reasoningEfforts` | Reasoning text streamed |
| --- | --- | --- |
| claude-opus-5, claude-fable-5 | low – max | No, `thinking` arrives empty |
| claude-sonnet-5 | low – max | Not observed |
| claude-haiku-4-5 | none reported | **Yes** |
| gpt-5.6-\* | low – max | Yes |
| gpt-5.2 – gpt-5.5 | low – xhigh | Yes |

Opus 5 accepts every effort level and shows no reasoning text; Haiku 4.5 is the
reverse, so a host cannot infer one capability from the other. Models that
withhold the text still stream a thinking block signature with `thinking` as
`""`; the bridge drops those rather than emitting `reasoning_content: ""`.

A model whose metadata is silent about effort gets an empty list. Passing
`effort` to Haiku 4.5 produced no reproducible change in thinking length across
repeated runs, so silence is treated as unsupported rather than assumed to work.

## Embed

A Node.js or Bun application can own the server directly:

```ts
import {
  createAgentBridge,
  listen,
} from "@aotterclam/agent-bridge";

const bridge = await listen(
  createAgentBridge({ controlToken: sessionControlToken }),
  0,
);

const address = bridge.server.address();
if (!address || typeof address === "string") throw new Error("No bridge port");
console.log(`Agent Bridge: http://127.0.0.1:${address.port}/v1`);

process.once("exit", () => void bridge.close());
```

Pass `0` to let the operating system select an unused port, or pass a specific
port number when the host owns that port. Read the assigned port from
`bridge.server.address()` after `listen()` resolves.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_PORT` | `3457` | Loopback listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | `local-development-only` | Capability discovery token |
| `AGENT_BRIDGE_CLAUDE_TIMEOUT_MS` | `300000` | Maximum duration of one Claude SDK turn |
| `AGENT_BRIDGE_CODEX_TIMEOUT_MS` | `300000` | Maximum duration of one Codex App Server turn |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable path |
| `AGENT_BRIDGE_GROK_TIMEOUT_MS` | `300000` | Maximum duration of one Grok ACP turn |
| `AGENT_BRIDGE_GROK_COMMAND` | `grok` | Grok executable path |

Generate a random control token for every host session. Keep capability tokens
in memory; do not write them to logs, analytics, or project files.

## Safety

The bridge binds to loopback and uses credentials already configured by the
official Claude, Codex, and Grok clients. Codex turns use the configured
`CODEX_HOME` so the official client can persist credential rotation. Do not
expose the bridge through a public listener, reverse proxy, tunnel, or remote
port forward.

Users are responsible for complying with provider, employer, and customer
policies. This project is not affiliated with or endorsed by Anthropic, OpenAI,
or xAI.

## Development

```sh
bun install
bun run check
bun test
npm run test:node
bun run test:grok
```

## License

MIT
