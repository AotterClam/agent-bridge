# Releasing

Releases are published manually to npmjs. Use a short-lived npm token and
never store it in the repository or shell profile.

## Version policy

- Use SemVer and immutable annotated tags named `vX.Y.Z`.
- The tag and `package.json` version must match.
- Never move or reuse a release tag.

## Release

1. Start from a clean, current `main`.
2. Update `package.json` and `bun.lock`.
3. Run:

   ```sh
   bun install --frozen-lockfile
   bun run check
   bun test
   npm pack --dry-run --registry https://registry.npmjs.org
   ```

4. Commit the version and create an annotated tag locally:

   ```sh
   git commit -am "release: agent-bridge v0.1.1"
   git tag -a v0.1.1 -m "agent-bridge v0.1.1"
   ```

5. Publish with a short-lived token:

   ```sh
   npm publish --access public --registry https://registry.npmjs.org
   ```

6. Push the exact published source and tag, then create release notes:

   ```sh
   git push origin main v0.1.1
   gh release create v0.1.1 --verify-tag --generate-notes
   ```

If npm publication fails, delete only the local tag, fix the problem, and
repeat with the same version. After npm accepts a version, it is immutable;
subsequent fixes require a new patch version.
