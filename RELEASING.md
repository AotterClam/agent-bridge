# Releasing

`agent-bridge` is distributed from this private Git repository. GitHub is the
source host and release artifact store; it is not an npm registry.

| Consumer | Pin |
| --- | --- |
| Nacre | Tagged source commit through `vendor/agent-bridge` |
| Lumen Next | `agent-bridge-linux-x64` from the same tagged GitHub Release |

## Version policy

- Use SemVer and immutable annotated tags named `vX.Y.Z`.
- The tag and `package.json` version must match.
- Patch: compatible fixes and dependency updates.
- Minor: compatible adapters, endpoints, or capabilities.
- Major: breaking TypeScript exports, HTTP protocol, token behavior, or host
  lifecycle requirements.
- Documentation-only changes do not require a release.

Never move or reuse a release tag. Publish a new patch version instead.

## Release checklist

1. Start from a clean, current `main`.
2. Update `package.json` and `bun.lock` to the release version.
3. Run:

   ```sh
   bun install --frozen-lockfile
   bun run check
   bun test
   ```

4. Commit the version change.
5. Create and push the annotated tag:

   ```sh
   git tag -a v0.1.0 -m "agent-bridge v0.1.0"
   git push origin main v0.1.0
   ```

6. Wait for the release workflow to publish the Linux executable and checksum.
7. Update Nacre's submodule and the Lumen deployment release pin, then run
   each consumer's bridge smoke test.

## Consumer pinning

Applications must pin an exact release tag. Do not depend on `main`.

Nacre keeps the Git submodule on the release commit and imports it through a
local package dependency:

```json
{
  "dependencies": {
    "@aotterclam/agent-bridge": "file:vendor/agent-bridge"
  }
}
```

```sh
git -C vendor/agent-bridge fetch --tags
git -C vendor/agent-bridge checkout v0.1.0
bun install
git add vendor/agent-bridge bun.lock
```

Lumen deployment downloads and verifies the executable:

```sh
gh release download v0.1.0 \
  --repo AotterClam/agent-bridge \
  --pattern agent-bridge-linux-x64 \
  --pattern agent-bridge-linux-x64.sha256
sha256sum -c agent-bridge-linux-x64.sha256
install -m 0755 agent-bridge-linux-x64 \
  /opt/agent-bridge/releases/v0.1.0/agent-bridge
```

One loopback service may serve multiple Lumen instances only when they share
the same machine, OS user, provider subscriptions, trust boundary, and upgrade
schedule. Separate any boundary mismatch with another service and port.

Private-repository consumers and deployment jobs need GitHub read access
through an SSH key, PAT, GitHub App, or Actions token.

## When to add GitHub Packages

Stay with tagged source and release executables while Nacre bundles source and
Lumen runs a service. Add a private GitHub npm package only when another
consumer needs package-manager resolution and compiled JavaScript imports.
