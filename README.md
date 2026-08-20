# @aotterclam/agent-bridge

[![npm version](https://img.shields.io/npm/v/%40aotterclam%2Fagent-bridge)](https://www.npmjs.com/package/@aotterclam/agent-bridge)

A loopback OpenAI-compatible API bridge for local coding agents: **Antigravity (Gemini)**, **Claude Code**, **Codex**, and **Grok Build**. It uses official local runtimes and their existing sign-ins while preserving native model IDs, streaming SSE tokens, reasoning content, and function tool calls.

---

## Quick start

You can use Agent Bridge in two ways:

### Option A: Standalone CLI (Zero Install)

Run directly from any terminal to start a local server with auto-discovery, live status indicators, and ready-to-run cURL examples:

```sh
npx @aotterclam/agent-bridge
# or with bunx:
bunx @aotterclam/agent-bridge
```

👉 [Jump to Standalone CLI Guide](#1-standalone-cli) for flags (`--port`, `--token`, `--debug`, `--log-file`), cURL examples, and token routing.

---

### Option B: Embedded in Application (Library)

Install into your project to let your application control the bridge lifecycle directly:

```sh
bun add @aotterclam/agent-bridge
# or: npm install @aotterclam/agent-bridge
```

```ts
import { startAgentBridge } from "@aotterclam/agent-bridge";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const bridge = await startAgentBridge();
const { adapter, baseUrl, apiKey } = await bridge.connection("antigravity");

const model = createOpenAICompatible({
  name: "local-agent-bridge",
  baseURL: baseUrl,
  apiKey,
}).chatModel(adapter.models[0]!.id);
```

👉 [Jump to Embedded Library Guide](#2-embedded-library-mode) for multi-agent switching, discovery, and lifecycle management.

---

## Supported agents & requirements

| Adapter ID | Agent Name | Local Requirement |
| :--- | :--- | :--- |
| `antigravity` | Antigravity (Gemini) | Antigravity CLI (`agy`) installed and signed in |
| `claude` | Claude Code | Claude Code installed and signed in |
| `codex` | Codex | Codex CLI installed and signed in |
| `grok` | Grok Build | Grok Build CLI installed and signed in |

*Requires Node.js 22+ or Bun 1.3+.*

---

## 1. Standalone CLI

### Running the server

```sh
# Start on default port (3457) with random control token:
npx @aotterclam/agent-bridge

# Specify custom port, discovery token, and logging:
npx @aotterclam/agent-bridge --port 8080 --token secret-token --debug --log-file ./agent-bridge.log
```

Or configure via environment variables:

```sh
export AGENT_BRIDGE_PORT=3457
export AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
npx @aotterclam/agent-bridge
```

### CLI options

| Option | Shorthand | Description |
| :--- | :--- | :--- |
| `--port <number>` | `-p` | Port to listen on (default: `3457` or `AGENT_BRIDGE_PORT`) |
| `--token <string>` | `-t` | Control token for discovery (default: `AGENT_BRIDGE_CONTROL_TOKEN` or `local-development-only`) |
| `--log-level <level>` | `-l` | Log verbosity: `debug`, `info`, `warn`, `error`, `silent` (default: `info`) |
| `--debug` | `-d` | Shorthand for `--log-level debug` |
| `--log-file <path>` | `-f` | Append structured logs to specified file path |
| `--format <format>` | | Output format: `pretty` or `json` (default: `pretty`) |
| `--quiet` | `-q` | Suppress startup banner and set log level to `silent` |
| `--version` | `-v` | Show version number |
| `--help` | `-h` | Show help and available options |

### How provider switching works

Agent Bridge routes requests using **Capability Tokens** derived from the master control token. There is no stateful switch endpoint; switching providers simply means passing that adapter's capability token in the `Authorization: Bearer <token>` header along with one of its native model IDs.

Because routing is token-scoped, identical model IDs across different providers never collide.

### Ready-to-run cURL examples

1. Query available adapters and their capability tokens:
```sh
curl -H "Authorization: Bearer my-control-token" http://127.0.0.1:3457/capabilities
```

2. Send chat completion to **Antigravity (Gemini)**:
```sh
curl http://127.0.0.1:3457/v1/chat/completions \
  -H "Authorization: Bearer <ANTIGRAVITY_CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.7-flash",
    "messages": [{"role": "user", "content": "Explain quantum computing in one sentence."}]
  }'
```

3. Send chat completion to **Codex**:
```sh
curl http://127.0.0.1:3457/v1/chat/completions \
  -H "Authorization: Bearer <CODEX_CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [{"role": "user", "content": "Explain quantum computing in one sentence."}]
  }'
```

4. Send chat completion to **Claude Code**:
```sh
curl http://127.0.0.1:3457/v1/chat/completions \
  -H "Authorization: Bearer <CLAUDE_CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5[1m]",
    "messages": [{"role": "user", "content": "Explain quantum computing in one sentence."}]
  }'
```

5. Send chat completion to **Grok Build**:
```sh
curl http://127.0.0.1:3457/v1/chat/completions \
  -H "Authorization: Bearer <GROK_CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.6",
    "messages": [{"role": "user", "content": "Explain quantum computing in one sentence."}]
  }'
```

### Client SDK connection

Connect to a standalone bridge using the client SDK:

```ts
import { createAgentBridgeClient } from "@aotterclam/agent-bridge";

const bridge = createAgentBridgeClient({
  baseUrl: "http://127.0.0.1:3457",
  controlToken: "my-control-token",
});

// Switch to Antigravity (Gemini)
const agy = await bridge.connection("antigravity");
console.log(agy.baseUrl, agy.apiKey, agy.adapter.models);

// Switch to Codex
const codex = await bridge.connection("codex");
console.log(codex.baseUrl, codex.apiKey, codex.adapter.models);
```

---

## 2. Embedded library mode

When embedding Agent Bridge directly into a Node.js / Bun application (e.g. an Electron desktop app, backend service, or custom CLI):

### Starting and stopping the bridge

`startAgentBridge()` asks the OS for an unused random port and generates a unique control token:

```ts
import { startAgentBridge } from "@aotterclam/agent-bridge";

const bridge = await startAgentBridge();

// Query discovered adapters
const adapters = await bridge.adapters({ refresh: true });

// Get connection for a specific provider
const { adapter, baseUrl, apiKey } = await bridge.connection("antigravity");

// Graceful shutdown on app exit
await bridge.close();
```

Use `startAgentBridge({ port: 3457 })` only when your host explicitly requires a fixed port. Lower-level `createAgentBridge()` and `listen()` exports remain available for custom lifecycle control.

---

## Logging & diagnostics (both modes)

Agent Bridge features a unified, multi-transport logging subsystem aligned across both Standalone and Embedded modes.

### In standalone mode

```sh
# Enable verbose debug logs and append to file
npx @aotterclam/agent-bridge --debug --log-file ./agent-bridge.log

# Stream structured JSON for log aggregators (e.g. Datadog / Fluentd / CloudWatch)
npx @aotterclam/agent-bridge --format json
```

### In embedded mode

Pass logger configuration or a custom log handler into `startAgentBridge()`:

```ts
import { startAgentBridge } from "@aotterclam/agent-bridge";

const bridge = await startAgentBridge({
  logger: {
    level: "debug",                 // 'debug' | 'info' | 'warn' | 'error' | 'silent'
    logFile: "/var/log/bridge.log", // Structured JSON Lines file output
    onLog: (record) => {
      // Forward to your application logger (e.g. Winston / Pino / Electron)
      console.log(`[${record.scope}] ${record.message}`, record.meta);
    }
  }
});
```

---

## Reasoning effort and reasoning visibility

Effort support and visible reasoning are separate capabilities. The bridge-specific `/capabilities` endpoint reports what each official runtime advertises:

| Adapter | Effort Metadata | Reasoning Text |
| :--- | :--- | :--- |
| **Antigravity** | Per-model effort levels (`low`, `medium`, `high`) | Streamed tokens & thinking token metrics |
| **Claude Code** | Per-model Agent SDK metadata; no default | Only when the SDK emits non-empty thinking |
| **Codex** | Per-model app-server levels and default | Streamed when emitted |
| **Grok Build** | ACP `initialize` metadata and default; empty on fallback | ACP `agent_thought_chunk` when emitted |

*An empty `reasoningEfforts` list means the runtime did not advertise levels. `reasoning_effort` is forwarded unchanged when supplied by the caller.*

### How to pass `reasoning_effort` in API calls

Pass `reasoning_effort` directly in the request payload using any OpenAI-compatible client or cURL:

#### 1. Raw HTTP / cURL
```sh
curl http://127.0.0.1:3457/v1/chat/completions \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.7-flash",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Analyze time complexity of quicksort."}]
  }'
```

#### 2. OpenAI SDK (TypeScript / JavaScript)
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${baseUrl}/v1`,
  apiKey: "<CAPABILITY_TOKEN>"
});

const response = await client.chat.completions.create({
  model: "gemini-3.7-flash",
  reasoning_effort: "high", // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  messages: [{ role: "user", content: "Solve this complex puzzle..." }]
});
```

#### 3. OpenAI SDK (Python)
```python
from openai import OpenAI

client = OpenAI(
    base_url=f"{base_url}/v1",
    api_key="<CAPABILITY_TOKEN>"
)

response = client.chat.completions.create(
    model="gpt-5.6-sol",
    reasoning_effort="high",
    messages=[{"role": "user", "content": "Explain step by step."}]
)
```

#### 4. Vercel AI SDK
```ts
import { streamText } from "ai";

const result = streamText({
  model,
  prompt: "Explain step by step.",
  providerOptions: {
    openaiCompatible: {
      reasoningEffort: "high"
    }
  }
});
```

---

## Protocol

```text
GET  /health
GET  /capabilities
GET  /v1/models
POST /v1/chat/completions
```

Chat completions support standard JSON and SSE streaming responses, OpenAI function-tool calls, and reasoning deltas. The `/v1` routes form the OpenAI-compatible data plane; `/capabilities` uses the separate control token for local discovery.

---

## Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_PORT` | `3457` | Standalone listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | `local-development-only` | Standalone discovery token |
| `AGENT_BRIDGE_LOG_LEVEL` | `info` | Default log level (`debug`, `info`, `warn`, `error`, `silent`) |
| `AGENT_BRIDGE_LOG_FILE` | - | Default file path for structured log output |
| `AGENT_BRIDGE_LOG_FORMAT` | `pretty` | Log output style (`pretty` or `json`) |
| `AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS` | `300000` | Antigravity turn timeout |
| `AGENT_BRIDGE_ANTIGRAVITY_COMMAND` | `agy` | Antigravity CLI executable |
| `AGENT_BRIDGE_CLAUDE_TIMEOUT_MS` | `300000` | Claude turn timeout |
| `AGENT_BRIDGE_CODEX_TIMEOUT_MS` | `300000` | Codex turn timeout |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable |
| `AGENT_BRIDGE_GROK_TIMEOUT_MS` | `300000` | Grok turn timeout |
| `AGENT_BRIDGE_GROK_COMMAND` | `grok` | Grok executable |

---

## Safety & security

The bridge only accepts loopback HTTP URLs and uses credentials already owned by the official clients. Do not expose it through a public listener, proxy, tunnel, or remote port forward. Keep control and capability tokens out of logs, analytics, and project files.

Users remain responsible for provider, employer, and customer policies. This project is not affiliated with or endorsed by Anthropic, Google, OpenAI, or xAI.

---

## Development

```sh
bun install
bun run check
bun test
npm run test:node
bun run test:grok
bun run test:antigravity
```

`bun run test:grok` and `bun run test:antigravity` run live end-to-end smoke tests against locally installed CLIs.

---

## License

MIT
