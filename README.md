# @aotterclam/agent-bridge

A local OpenAI-compatible bridge for official coding-agent runtimes.

It provides one loopback API for Claude Code and Codex while preserving each
provider's native model IDs, streaming text, reasoning, and function tools.
Credentials stay with the official local clients.

| Adapter | Official integration | Text | Reasoning | Tools |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Streaming | Streaming | Yes |
| Codex | `codex app-server` | Streaming | Streaming | Yes |

Antigravity is not supported until Google publishes an official embeddable
SDK.

## Requirements

- Bun 1.3 or newer
- Claude Code installed and signed in for the Claude adapter
- Codex CLI installed and signed in for the Codex adapter

## Install

```sh
bun add @aotterclam/agent-bridge
```

## Run

Start the standalone loopback service with a random control token:

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

## Embed

A Bun application can own the server directly:

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
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable path |

Generate a random control token for every host session. Keep capability tokens
in memory; do not write them to logs, analytics, or project files.

## Safety

The bridge binds to loopback and uses credentials already configured by the
official Claude and Codex clients. Do not expose it through a public listener,
reverse proxy, tunnel, or remote port forward.

Users are responsible for complying with provider, employer, and customer
policies. This project is not affiliated with or endorsed by Anthropic or
OpenAI.

## Development

```sh
bun install
bun run check
bun test
```

## License

MIT
