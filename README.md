# @aotterclam/agent-bridge

[![npm version](https://img.shields.io/npm/v/%40aotterclam%2Fagent-bridge)](https://www.npmjs.com/package/@aotterclam/agent-bridge)

A loopback OpenAI-compatible API bridge for local coding agents: **Antigravity (Gemini)**, **Claude Code**, **Codex**, and **Grok Build**. It uses official local runtimes and their existing sign-ins while preserving native model IDs, streaming SSE tokens, reasoning content, and function tool calls.

---

## Quick start

You can use Agent Bridge in two ways:

### Option A: Standalone CLI (Zero Install)

Run directly from any terminal to start a local server with auto-discovery, live status indicators, and ready-to-run cURL examples:

```sh
npx @aotterclam/agent-bridge@latest
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
npx @aotterclam/agent-bridge@latest

# Specify custom port, discovery token, and logging:
npx @aotterclam/agent-bridge@latest --port 8080 --token secret-token --debug --log-file ./agent-bridge.log
```

Or configure via environment variables:

```sh
export AGENT_BRIDGE_PORT=3457
export AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
npx @aotterclam/agent-bridge@latest
```

### CLI options

| Option | Shorthand | Description |
| :--- | :--- | :--- |
| `--port <number>` | `-p` | Port to listen on (default: `3457` or `AGENT_BRIDGE_PORT`) |
| `--token <string>` | `-t` | Control token for discovery (default: `AGENT_BRIDGE_CONTROL_TOKEN` or a random token per run) |
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

6. Same turn over the stateless **Responses API** (any adapter):
```sh
curl http://127.0.0.1:3457/v1/responses \
  -H "Authorization: Bearer <CLAUDE_CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5[1m]",
    "input": "Explain quantum computing in one sentence."
  }'
```

The `store: false` lane accepts standard stateless reasoning controls,
including `max_output_tokens` and
`include: ["reasoning.encrypted_content"]`. Coding-agent runtimes expose
neither a native output-token cap nor replayable encrypted reasoning state, so
the bridge applies the token budget through their shared system transcript and
returns reasoning summaries without fabricating encrypted content.

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
npx @aotterclam/agent-bridge@latest --debug --log-file ./agent-bridge.log

# Stream structured JSON for log aggregators (e.g. Datadog / Fluentd / CloudWatch)
npx @aotterclam/agent-bridge@latest --format json
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
POST /reconnect
GET  /reconnect/{reconnect_id}
POST /reconnect/{reconnect_id}/cancel
GET  /v1/models
GET  /v1/model/info
GET  /model/info
POST /v1/chat/completions
POST /v1/responses
POST /v1/images/generations
POST /v1/images/edits
POST /v1/files
GET  /v1/files
GET  /v1/files/{file_id}
GET  /v1/files/{file_id}/content
DELETE /v1/files/{file_id}
```

Chat completions support standard JSON and SSE streaming responses, OpenAI function-tool calls, and reasoning deltas. The `/v1` routes form the OpenAI-compatible data plane; `/capabilities` and `/reconnect` use the separate control token for local discovery and sign-in.

`/v1/responses` implements the **stateless subset** of the OpenAI Responses API (the [Open Responses](https://www.openresponses.org) shape): send the full `input` item array on every call. Streaming uses semantic events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.reasoning_summary_text.delta`, …), and function tool calls round-trip via `function_call` / `function_call_output` items. No response or item history is stored, so `previous_response_id` and `item_reference` are rejected with `400` — clients must run with `store: false` semantics (for the Vercel AI SDK, pass `providerOptions: { openai: { store: false } }`).

### Image and file inputs

The bridge accepts OpenAI's binary input shapes rather than embedding bytes in a text prompt:

- Chat Completions: `image_url`, `input_audio`, and `file` user content parts.
- Responses: `input_image` and `input_file` user content parts.
- Image bytes use a base64 data URL; PDF `file_data` accepts raw base64 or a data URL. HTTP(S) URLs are passed only where the provider transport supports them.
- Base64 image, audio, and PDF inputs are limited to 20 MiB decoded; the JSON request body is limited to 30 MiB.

| Adapter | Image input | Audio input | PDF input |
| :--- | :--- | :--- | :--- |
| Codex | URL or data URL; `detail=auto/low/high` | base64 WAV or MP3 | No |
| Claude | URL or data URL; `detail=auto` | No | URL or base64 |
| Grok | Data URL only; `detail=auto`, no selected tools, prompt JSON at most 192 KiB | No | Not enabled (`embeddedContext` alone is insufficient evidence) |
| Antigravity | Data URL only; written to an isolated local path and exposed through an exact-path `read_file` grant; `detail=auto` | No | No |

Grok and Antigravity image discovery starts at `unknown` where the advertised schema is incomplete; the first successful non-streaming image request promotes that cached cell to `supported` for the running bridge.

```sh
curl http://127.0.0.1:3457/v1/responses \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"<MODEL_ID>",
    "input":[{"role":"user","content":[
      {"type":"input_text","text":"What is in this image?"},
      {"type":"input_image","image_url":"data:image/png;base64,<BASE64>"}
    ]}]
  }'
```

`POST /v1/files` accepts OpenAI-style multipart uploads and returns a `file_id`. Files are private to the adapter capability token, limited to 20 MiB, kept in a process-local temporary directory, and deleted when the bridge closes. List, metadata, content download, and delete routes are also available. The top-level `files` cell in `/capabilities` reports this lifecycle and the content parts for which the bridge resolves `file_id`.

Any MIME type can be stored and retrieved, but model ingestion is intentionally narrower: `input_image` must still be a valid provider-supported image, and `input_file` currently accepts valid PDFs only on PDF-capable adapters. Uploading a DOCX, archive, executable, or other opaque binary does not imply that a model can understand it.

```sh
FILE_ID=$(curl -s http://127.0.0.1:3457/v1/files \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -F purpose=vision -F file=@image.png | jq -r .id)

curl http://127.0.0.1:3457/v1/responses \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"<MODEL_ID>\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_image\",\"file_id\":\"$FILE_ID\"}]}]}"
```

### Images compatibility

Codex and Grok expose the wire shape documented by OpenAI for [image generation](https://developers.openai.com/api/reference/resources/images/methods/generate) and [image edits](https://developers.openai.com/api/reference/resources/images/methods/edit). The bridge accepts `n=1`, `response_format=b64_json`, and PNG, JPEG, or WebP edit inputs. Multipart edits accept repeated `image` and `image[]` fields used by official SDK clients; JSON edits accept the official `images: [{file_id|image_url}]` references. `file_id` resolves through the caller's private bridge FileStore, and `image_url` currently accepts base64 data URLs. Remote HTTP(S) `image_url` values and edit masks are not yet supported and return `400` instead of being ignored.

The Codex wire parser accepts the OpenAI schema limit of 16 edit inputs and passes every one to the app-server as a local image. Codex does not report a provider-side reference limit, so `/capabilities` keeps `runtime_max_items` unknown instead of claiming that 16-image execution was host-verified. Grok's installed `image_edit` tool accepts one input and reports `runtime_max_items: 1`, so Grok returns `400` for a multi-image edit instead of reducing the request to the lowest common denominator. The current parser caps the complete edit request at 52 MiB; this and the 50 MiB per-image limit are reported in `parameter_constraints`. Unsupported optional controls are rejected rather than silently ignored.

| Adapter | Generation `size` | Edit `size` |
| :--- | :--- | :--- |
| Codex | Not controllable through the current app-server image tool; its backend uses `auto` | Not controllable; backend uses `auto` |
| Grok | Maps `WIDTHxHEIGHT` to native `aspect_ratio` (`1:1`, `16:9`, `9:16`, `3:2`, or `2:3`); exact output pixels are provider-selected | Not exposed because Grok ignores `aspect_ratio` for the bridge's single-image edit |

```sh
curl http://127.0.0.1:3457/v1/images/generations \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A pearl inside a friendly clam"}'

curl http://127.0.0.1:3457/v1/images/edits \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -F 'image=@source.png' \
  -F 'image[]=@reference.png' \
  -F 'prompt=Make the pearl blue'

curl http://127.0.0.1:3457/v1/images/edits \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"Combine the references\",\"images\":[{\"file_id\":\"$FILE_ID\"},{\"image_url\":\"data:image/png;base64,<BASE64>\"}]}"
```

The stateless Responses API also supports the hosted `image_generation` tool on those adapters:

```sh
curl http://127.0.0.1:3457/v1/responses \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"<MODEL_ID>",
    "input":"Draw a pearl inside a friendly clam",
    "tools":[{"type":"image_generation"}]
  }'
```

Images streaming is part of the official OpenAI schema, but the local runtimes currently expose only terminal images. `/v1/images/*` therefore recognizes those official controls while returning `400` for `stream: true` and `partial_images > 0`. The bridge never emits a custom streaming dialect; exact official Images or Responses SSE can be added when a runtime exposes real partial frames.

### Host capability detection

`GET /capabilities` probes the CLI executable installed on the user's host. Its real path and version are returned only as a fingerprint; support is determined from the runtime's own capability response or tool catalog, not a version allowlist. Results are cached for the server lifetime; use `GET /capabilities?refresh=1` after changing a CLI installation.

Each input type and image output operation reports `supported`, `unsupported`, or `unknown` with its probe and evidence. Input cells expose `supported_openai_content_parts`; image output cells expose LiteLLM's `supported_openai_params`. Both include strict `parameter_constraints` and the underlying runtime's unnormalized `provider_capabilities`, so consumers can use portable OpenAI fields without losing provider-specific controls and caveats. The separate top-level `files` cell describes bridge storage rather than pretending it is a native model capability.

Codex currently self-reports image generation support, but its app-server image tool does not expose `size` even though its internal Images client has that field; the bridge reports the host-controllable surface, not a guessed backend maximum. Grok versions without a tool catalog start as `unknown` and are promoted after the first successful live image request. Claude image generation is unsupported. Antigravity's installed executable schema is reported under `provider_capabilities` (including edit/reference inputs and aspect ratios), while bridge execution remains disabled because the CLI does not offer safe single-tool authorization; the bridge does not enable its unrestricted permission bypass.

`GET /v1/model/info` (and LiteLLM's `/model/info` alias) uses the caller's adapter capability token and returns LiteLLM-shaped `model_name`, `litellm_params`, `model_info.supports_vision`, `supports_audio_input`, `supports_pdf_input`, and `supported_openai_params`. Bridge-specific evidence stays namespaced under `model_info.agent_bridge.inputs` and `.images`.

To verify the wire shape with the official OpenAI SDK through an independent conformance runner:

```sh
docker run --rm \
  -e OPENAI_BASE_URL=http://host.docker.internal:3457/v1 \
  -e OPENAI_API_KEY=<CAPABILITY_TOKEN> \
  -e OPENAI_IMAGE_MODEL=<MODEL_ID> \
  -e ALLOW_INSECURE_HTTP=true \
  -e TEST_SUITES=images_generations,images_edits \
  ghcr.io/beranekio/openai-compatibility-tester:latest
```

The external runner covers `/v1/images/*`; the repository tests cover the `/v1/responses` `image_generation_call` shape and rejection of unsupported controls.

---

## Sign-in state and reconnect

A discovered model catalog says nothing about whether the runtime is still
signed in, so an expired token reads as `available: true` right up until every
turn fails. Each `/capabilities` adapter therefore also reports a
provider-neutral sign-in contract, and hosts that embed the bridge can trigger
a re-authentication without asking the user to open a terminal.

| Field | Values | Meaning |
| :--- | :--- | :--- |
| `authState` | `ready` | The runtime answered that it is signed in |
| | `auth_required` | The runtime answered that it is signed out |
| | `reauth_pending` | A reconnect started through this bridge is in flight |
| `actions` | `["reconnect"]` | `POST /reconnect` can drive this adapter's login |
| | `[]` | No scriptable login; sign in with the vendor CLI yourself |

```sh
# Start the adapter's own sign-in (202)
curl -X POST http://127.0.0.1:3457/reconnect \
  -H "Authorization: Bearer <CONTROL_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"adapter":"codex"}'
# => {"reconnectId":"reconnect-…","adapter":"codex","state":"pending"}

# Poll until it leaves "pending"
curl -H "Authorization: Bearer <CONTROL_TOKEN>" \
  http://127.0.0.1:3457/reconnect/<RECONNECT_ID>
# => {"reconnectId":"…","adapter":"codex","state":"succeeded","detail":"…"}

# Give up early (idempotent)
curl -X POST -H "Authorization: Bearer <CONTROL_TOKEN>" \
  http://127.0.0.1:3457/reconnect/<RECONNECT_ID>/cancel
```

A second start for an adapter that is already reconnecting returns `409`. An
adapter with no scriptable login returns `400` with category `unsupported`.

### Error categories

Every bridge error — control plane, `/v1` JSON, and both streaming lanes —
carries `error.category`, a provider-neutral classification a host can switch
on instead of pattern-matching a runtime's error prose:

`auth_required`, `unsupported`, `conflict`, `invalid_request`, `not_found`,
`unauthorized`, `server_error`.

`/v1/responses` keeps its OpenAI `error.code` unchanged and adds `category`
beside it.

### From a failed turn to `authState`

A credential expires on the provider's clock. Nothing tells the bridge, so the
first thing that observes it is a turn that fails. When an adapter turn fails,
the bridge discards that adapter's cached sign-in reading and re-probes; if the
probe confirms the runtime is signed out, the failure is reported as `401` with
category `auth_required`, and the adapter reads `auth_required` in the very
next `/capabilities` — no `refresh=1` needed.

```jsonc
// POST /v1/chat/completions, credential expired
// HTTP 401
{"error": {"message": "…", "category": "auth_required"}}
```

Streaming has already sent its status line by then, so the same category rides
the existing stream terminators: `{"error":{"message":…,"category":…}}` in the
chat SSE lane, and the `response.failed` event's error object on
`/v1/responses`.

Two deliberate limits. A request the bridge itself rejected (any `4xx` — a
malformed body, an unsupported input) is not evidence about credentials: it
never re-probes and never claims `auth_required`. And an adapter with no probe
(`actions: []`) stays `ready`, because the bridge will not assert a sign-in
problem it has no way to observe.

Cached readings are invalidated by every signal that can change them:
`refresh=1`, a reconnect settling either way, a failed turn, and age — a
reading older than 60 seconds is re-probed, so a host that polls
`/capabilities` without running turns still converges. Concurrent failures and
concurrent discovery share one probe rather than each spawning a CLI.

The client SDK exposes the same three calls:

```ts
const bridge = await startAgentBridge();
const [codex] = (await bridge.adapters()).filter((a) => a.id === "codex");

if (codex.authState === "auth_required" && codex.actions.includes("reconnect")) {
  const { reconnectId } = await bridge.reconnect("codex");
  // poll bridge.reconnectStatus(reconnectId) until state !== "pending",
  // or bridge.cancelReconnect(reconnectId) to abandon it
}
```

### What each adapter can and cannot detect

| Adapter | Detection probe | Login | Boundary |
| :--- | :--- | :--- | :--- |
| Codex | `codex login status` exit code | `codex login` | A missing executable and a signed-out host both read as `auth_required` |
| Claude Code | `claude auth status --json` → `loggedIn` | `claude auth login` | An unreadable probe reports `ready`, not `auth_required` |
| Grok Build | none | none | `actions: []`; sign in with `grok` yourself |
| Antigravity | none | none | `actions: []`; sign in with `agy` yourself |

Honest limits of this lane:

- The login child runs with **all three stdio streams ignored**. An
  authorization URL carries state and PKCE parameters, so nothing the child
  writes is captured, logged, or returned, and `detail` is bridge-authored
  text only. The consequence is that the CLI must open a browser and finish on
  its own loopback callback; where it instead falls back to asking the user to
  paste a code into the terminal, this endpoint cannot complete the flow and
  fails on exit or timeout.
- Neither CLI reports machine-readable progress while a login runs, so a
  reconnect is `pending` until the process exits. Exit `0` is treated as
  necessary but not sufficient: the bridge re-runs the detection probe and only
  reports `succeeded` when the runtime confirms it is signed in.
- The Claude lane runs the Agent SDK, which resolves its own executable.
  Credentials are keyed to the config directory (`CLAUDE_CONFIG_DIR`), not to a
  particular binary, so signing in through `AGENT_BRIDGE_CLAUDE_COMMAND` on the
  same config directory is what the SDK reads back. Point that variable at the
  matching install if you keep several.
- The bridge does not list accounts, read quota, or store tokens. Those stay
  with the CLIs that already own them.

---

## Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_PORT` | `3457` | Standalone listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | random per run | Optional fixed standalone discovery token |
| `AGENT_BRIDGE_LOG_LEVEL` | `info` | Default log level (`debug`, `info`, `warn`, `error`, `silent`) |
| `AGENT_BRIDGE_LOG_FILE` | - | Default file path for structured log output |
| `AGENT_BRIDGE_LOG_FORMAT` | `pretty` | Log output style (`pretty` or `json`) |
| `AGENT_BRIDGE_RECONNECT_TIMEOUT_MS` | `300000` | Reconnect login timeout |
| `AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS` | `300000` | Antigravity turn timeout |
| `AGENT_BRIDGE_ANTIGRAVITY_COMMAND` | `agy` | Antigravity CLI executable |
| `AGENT_BRIDGE_CLAUDE_TIMEOUT_MS` | `300000` | Claude turn timeout |
| `AGENT_BRIDGE_CLAUDE_COMMAND` | `claude` | Claude CLI executable, used by reconnect only |
| `AGENT_BRIDGE_CODEX_TIMEOUT_MS` | `300000` | Codex turn timeout |
| `AGENT_BRIDGE_CODEX_HANDSHAKE_TIMEOUT_MS` | `60000` | Combined Codex `initialize` + `thread/start` timeout |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable |
| `AGENT_BRIDGE_GROK_TIMEOUT_MS` | `300000` | Grok turn timeout |
| `AGENT_BRIDGE_GROK_COMMAND` | `grok` | Grok executable |

Upgrade notes: [v0.1.13](docs/migrations/v0.1.13.md).

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
