# agent-bridge

Private, local-only OpenAI-compatible adapters for official coding-agent
runtimes.

Supported runtimes:

- Claude Agent SDK
- Codex app-server

Antigravity is intentionally unsupported until Google publishes an official
TypeScript SDK.

## Safety and policy

This package is intended for personal use on the same machine as the host
application. It binds no public network service by itself. The host must keep
the bridge on loopback, protect it with the generated capability token, and
must not forward that token off-device.

The package uses credentials and subscriptions already configured by the
official Claude and Codex clients. Users are responsible for ensuring their
use complies with Anthropic, OpenAI, employer, and customer policies. This
project does not grant additional service rights and is not affiliated with
or endorsed by Anthropic or OpenAI.

## Host integration

Run it as a supervised local process:

```sh
AGENT_BRIDGE_CONTROL_TOKEN=... agent-bridge
```

Or embed its lifecycle in a Bun host:

```ts
import { createAgentBridge, listen } from "@aotterclam/agent-bridge";

const bridge = await listen(createAgentBridge(), 3457);
process.once("exit", () => void bridge.close());
```

The host obtains adapter status and opaque capability tokens from
`GET /capabilities`. Adapter identity is never encoded in the public URL or
native model ID.
