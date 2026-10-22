# Contributing

Install the pnpm version in `packageManager` and a supported development Node
version listed in the root manifest. CI uses Node 24.11 and a frozen lockfile.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Run `pnpm build` before individual `pnpm typecheck` or `pnpm test` commands.
Tests resolve each package's built exports, including providers' core dependency;
there are no source aliases that can hide a missing declaration or runtime file.
The type check includes test files as well as production source. Each build
clears `dist/` first, so a deleted source cannot survive as a stale module in
the tarball.

Keep the package boundary small:

- Core owns neutral execution algorithms and typed host contracts. It must not
  import providers, a product application, concrete storage or Node-only APIs.
- Providers may import core's public exports. Hosts supply transport,
  credentials and materialized protocol content.
- Cross-package imports use declared public exports. Do not traverse another
  package's private source or add a production source alias.
- Preserve valid `.js` specifiers for emitted ESM and explicit export maps.
- Build output is generated and must not be committed. Builds clean output so
  obsolete modules cannot survive a source removal.

Add tests for changes to execution, approvals, atomic/unknown effects,
continuation, compaction, provider payloads or bounded reads. Keep HTTP tests
local and deterministic; ordinary validation needs no provider credentials or
paid network calls. A package test is not proof of a product's storage or native
transport integration.

Run package dry-runs and the isolated packed consumer whenever changing exports,
manifests, dependencies or build settings. Review tarball contents and confirm
the provider dependency is semver metadata. `pnpm verify:consumer` packs both
packages, installs them into a temporary project outside the workspace,
type-checks code that imports only the published entry points with
`skipLibCheck` disabled, and executes it. It runs as the last step of
`pnpm check`. Run `git diff --check` before review.

Package publication and product migration require separate explicit decisions.
Follow [publishing preparation](docs/publishing.md); CI only validates artifacts.
