# Releasing

`agent-bridge` is distributed from this private Git repository. GitHub is the
source host; it is not currently used as an npm registry.

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

6. Create the GitHub release:

   ```sh
   gh release create v0.1.0 \
     --repo AotterClam/agent-bridge \
     --verify-tag \
     --generate-notes
   ```

7. Update each consumer to the tagged commit and run its bridge smoke test.

## Consumer pinning

Applications must pin an exact release tag. Do not depend on `main`.

For a normal Bun dependency:

```json
{
  "dependencies": {
    "@aotterclam/agent-bridge": "git+ssh://git@github.com/AotterClam/agent-bridge.git#v0.1.0"
  }
}
```

For a source-bundling desktop app such as Nacre, keep the Git submodule on the
release commit and import it through a local package dependency:

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

Private-repository consumers need GitHub read access through their developer
SSH key or CI credential.

## When to add GitHub Packages

Stay with tagged Git dependencies while consumers use Bun and need the source
for bundling. Add a private GitHub npm package only when independent consumers
need registry version ranges, automated dependency updates, or compiled
Node.js artifacts. That change also requires a `dist` build, declarations,
`publishConfig`, package-access policy, and authenticated release workflow.
