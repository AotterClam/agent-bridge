# @aotterclam/agent-bridge

A local OpenAI-compatible bridge for official coding-agent runtimes.

It provides one loopback API for Claude Code and Codex while preserving each
provider's native model IDs, streaming text, reasoning, and function tools.
Credentials stay with the official local clients.

| Adapter | Official integration | Text | Reasoning | Tools |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Streaming | Streaming, model-dependent | Yes |
| Codex | `codex app-server` | Streaming | Streaming | Yes |

Antigravity is not supported until Google publishes an official embeddable
SDK.

## Requirements

- Node.js 22 or newer, or Bun 1.3 or newer
- Claude Code installed and signed in for the Claude adapter
- Codex CLI installed and signed in for the Codex adapter

## Install

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

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  name: "local-agent-bridge",
  baseURL: "http://127.0.0.1:3457/v1",
  apiKey: selectedAdapter.capabilityToken,
});

const model = provider.chatModel(selectedModel.id);
```

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
  3457,
);

process.once("exit", () => void bridge.close());
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_PORT` | `3457` | Loopback listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | `local-development-only` | Capability discovery token |
| `AGENT_BRIDGE_CLAUDE_TIMEOUT_MS` | `300000` | Maximum duration of one Claude SDK turn |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable path |

Generate a random control token for every host session. Keep capability tokens
in memory; do not write them to logs, analytics, or project files.

## Safety

The bridge binds to loopback and uses credentials already configured by the
official Claude and Codex clients. Codex turns use the configured `CODEX_HOME`
so the official client can persist credential rotation. Do not expose the
bridge through a public listener, reverse proxy, tunnel, or remote port forward.

Users are responsible for complying with provider, employer, and customer
policies. This project is not affiliated with or endorsed by Anthropic or
OpenAI.

## Development

```sh
bun install
bun run check
bun test
npm run test:node
```

## License

MIT
