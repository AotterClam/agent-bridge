# agent-bridge

Private, local-only OpenAI-compatible adapters for official coding-agent
runtimes.

`agent-bridge` lets a desktop app or local developer tool use an existing
Claude Code or Codex subscription through one OpenAI-compatible interface.
It does not proxy credentials to a remote service and does not implement its
own agent runtime.

Supported adapters:

| Adapter | Official integration | Text streaming | Reasoning streaming | Function tools |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Yes | Yes | Yes |
| Codex | `codex app-server` | Yes | Yes | Yes |

Antigravity is intentionally unsupported until Google publishes an official
TypeScript SDK suitable for embedding.

## How it works

One bridge process registers every supported adapter and listens only on
`127.0.0.1`.

1. The host starts or embeds the bridge once.
2. The host calls `GET /capabilities` with its control token.
3. The bridge probes every adapter independently and returns availability,
   native model IDs, reasoning options, errors, and an opaque capability
   token for each adapter.
4. The host passes the selected adapter's capability token, unchanged native
   model ID, and the shared `/v1` URL to its OpenAI-compatible client.
5. The bridge selects the adapter from the capability token. Provider names
   are never encoded into model IDs or URL prefixes.

Unavailable adapters do not stop the bridge. Capability probes are fresh, so
a user can install or sign in to Claude Code or Codex and retry without
restarting the bridge. Heavy agent runtimes are started lazily for chat
requests rather than kept alive while unused.

```text
Host application
  |
  | GET /capabilities (control token)
  | POST /v1/chat/completions (adapter capability token)
  v
agent-bridge on 127.0.0.1
  |-- Claude Agent SDK
  `-- Codex app-server
```

## Requirements

- Bun
- Claude Code signed in for the Claude adapter
- Codex CLI signed in for the Codex adapter

The package is currently private and distributed through immutable GitHub
release tags rather than an npm registry.

| Consumer | Distribution | Lifecycle |
| --- | --- | --- |
| Nacre | Git submodule pinned to an exact tag | Bundled into the personal desktop product |
| Lumen Next development | Linux executable from the matching GitHub Release | Local loopback service; not a production provider |

Nacre imports the tagged source through
`"@aotterclam/agent-bridge": "file:vendor/agent-bridge"`. Lumen does not
install the package: local development downloads `agent-bridge-linux-x64` from
the private release and runs it as a separate service. See
[RELEASING.md](./RELEASING.md) for the release and pinning rules.

## Standalone mode

Use this mode when a desktop host should supervise a separate local bridge
process.

```sh
bun install
AGENT_BRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)" bun run start
```

The package also exposes an `agent-bridge` bin:

```sh
AGENT_BRIDGE_CONTROL_TOKEN=... agent-bridge
```

A Bun host can bundle the CLI and supervise it as a child:

```ts
const bridge = Bun.spawn(
  [process.execPath, "/absolute/path/to/agent-bridge.js"],
  {
    env: {
      ...process.env,
      AGENT_BRIDGE_CONTROL_TOKEN: sessionControlToken,
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.once("exit", () => bridge.kill());
```

The bridge should live for the host session. Do not restart it when an
individual adapter is unavailable; poll `/capabilities` after the user
installs or signs in to that provider.

## Embedded mode

Use this mode when the Bun host can own the bridge server directly:

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

Both modes expose the same protocol and adapter behavior. Standalone mode is
usually the cleaner boundary for a desktop application because process
lifecycle and agent dependencies remain outside the UI process.

### Shared Lumen development service

Multiple Lumen instances may share one standalone bridge when they run on the
same machine and have the same OS user, provider subscriptions, trust
boundary, and upgrade schedule. Keep the service on loopback:

```ini
[Service]
EnvironmentFile=/opt/agent-bridge/env/bridge.env
ExecStart=/opt/agent-bridge/current/agent-bridge
Restart=on-failure
```

Each Lumen deployment calls `/capabilities` with the bridge control token and
uses the selected adapter's capability token as `LUMEN_LLM_API_KEY`, with
`LUMEN_LLM_BASE_URL=http://127.0.0.1:3457/v1`. Capability tokens remain stable
across restarts while the control token is unchanged.

Use another process and port when OS users, customer data, provider accounts,
or release cadence differ.

Do not use personal Claude Code or Codex subscriptions as a production Lumen
backend. Production Lumen must use an API-key-authenticated managed provider or
customer gateway. Existing shared VM demos are temporary POC deployments.

## Capability discovery

`GET /health` is an unauthenticated process health probe.

`GET /capabilities` requires the host control token:

```sh
curl \
  -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" \
  http://127.0.0.1:3457/capabilities
```

Example response:

```json
{
  "adapters": [
    {
      "id": "claude",
      "name": "Claude Code",
      "available": true,
      "version": null,
      "error": null,
      "capabilityToken": "<opaque session token>",
      "models": [
        {
          "id": "claude-sonnet-4-5",
          "name": "claude-sonnet-4-5",
          "reasoningEfforts": []
        }
      ]
    }
  ]
}
```

The host should keep `capabilityToken` in memory for the current session. Do
not write it to workspace settings, logs, analytics, or remote storage.

## OpenAI-compatible usage

Use the adapter capability token as the API key and keep the native model ID
unchanged:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  name: "local-agent-bridge",
  baseURL: "http://127.0.0.1:3457/v1",
  apiKey: selectedAdapter.capabilityToken,
});

const model = provider.chatModel(selectedModel.id);
```

The same connection shape works with Mastra or another client that accepts an
OpenAI-compatible provider:

```ts
{
  providerId: "local-agent-bridge",
  modelId: selectedModel.id,
  baseUrl: "http://127.0.0.1:3457/v1",
  apiKey: selectedAdapter.capabilityToken
}
```

Available OpenAI-compatible endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
```

Chat completions support non-streaming and SSE streaming responses, native
model IDs, reasoning deltas where supplied by the provider, and OpenAI
function-tool calls.

## Why the adapters differ internally

Claude uses the official TypeScript Agent SDK. Its current implementation is
kept in `claude-bridge.mjs` because it is synchronized with the proven
Lumen Next bridge. The `.mjs` extension is not a runtime requirement; moving
it to strict TypeScript is a separate typing migration, not a functional
change.

Codex intentionally uses the official `codex app-server` protocol. The
official `@openai/codex-sdk` currently wraps `codex exec`; it does not expose
the app-server dynamic tool registration and reasoning-delta surface required
by this bridge. Replace the app-server client only when the official SDK
offers equivalent behavior.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BRIDGE_PORT` | `3457` | Loopback listener port |
| `AGENT_BRIDGE_CONTROL_TOKEN` | `local-development-only` | Host-only capability discovery token |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex` | Codex executable path |

The development control-token default is not suitable for a packaged app.
Generate a random token per host session and pass the same value to the host
backend and bridge process.

## Safety and policy

This package is intended for personal use on the same machine as the host
application. Nacre may include it in the released personal desktop product;
Lumen may use it only for local development or temporary POCs. It binds to
loopback and must not be exposed through a public listener, reverse proxy,
tunnel, or remote port forward.

The package uses credentials and subscriptions already configured by the
official Claude and Codex clients. Users and integrators are responsible for
ensuring their use complies with Anthropic, OpenAI, employer, and customer
policies. This project does not grant additional service rights and is not
affiliated with or endorsed by Anthropic or OpenAI.

## Development

```sh
bun install
bun run check
bun test
```

Keep adapter failures isolated, preserve native model IDs, and test changes
through the shared OpenAI-compatible contract.
