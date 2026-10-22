# Tulai Design AI Platform

Shared AI foundation packages for Tulai Design products. This repository starts
with a runtime-neutral Agent execution library and portable model protocol
adapters. Additional platform services can be scoped here in the future;
`ai-proxy` is not implemented.

**Distribution status:** the packages are prepared for public distribution under
`@tulai-design/*`, but have not been released by this task. Repository versions
are preparation metadata, not evidence of an npm release. No automated workflow
publishes packages.

| Package | Public exports | Responsibility |
| --- | --- | --- |
| [`@tulai-design/agent-core`](packages/agent-core) | root | Agent execution, tool contracts, approvals, context compaction, capabilities and text skills |
| [`@tulai-design/agent-providers`](packages/agent-providers) | root, `/http` | Chat Completions and Responses protocols, continuation and bounded HTTP readers |

The packages ship ESM JavaScript and TypeScript declarations. Core has no
runtime dependencies. Providers declares a semver dependency on core and has no
product UI, concrete storage, credential store or native runtime dependency.
Applications own persistence, execution ownership, credentials, authorization,
transport selection and tool effects.

## Development

Use Node.js 24.11 or newer and pnpm 9.12.0 (the `packageManager` field pins the
development tool; `corepack enable` supplies it). The root `engines` range is
wider than the development baseline: Vitest 5 accepts
`^22.12.0 || ^24.0.0 || >=26.0.0`, while the published packages themselves only
need Node 20 or newer at runtime. Browser hosts must provide the standard Web
APIs used by their chosen entry, including Fetch, streams and AbortSignal.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

CI runs exactly this with Node 24.11 and pnpm 9.12.0.

Build before running package tests or type checks: tests import the actual built
public exports. Each package build clears `dist/` first, so removed or renamed
sources cannot leave stale modules behind in the artifact. `check` builds both
packages, type-checks production and test sources, runs the semantic suites,
inspects package dry-runs, and then validates the packed artifacts by installing
them into an isolated project outside this workspace
(`scripts/verify-packed-consumer.mjs`). That last step is what proves the
published entry points, declarations and the provider-to-core range work without
workspace state; a dry-run alone cannot. The workspace links the
semver-compatible core dependency locally; publishable metadata contains no
`workspace:*` version. Generated `dist`, `node_modules` and tarballs are ignored.

See [contribution and validation guidance](CONTRIBUTING.md) and the
[distribution preparation checklist](docs/publishing.md).

## Extraction and consumer rollout

The initial source and tests were extracted from
[`tulai-design/momoki`](https://github.com/tulai-design/momoki) commit
`78533ab247aa01f596eeff1f218ab7cfd3d620ef`. Package imports were renamed from
`@momoki/*` to `@tulai-design/*`; execution and protocol behavior were preserved.

Momoki continues consuming its existing private workspace packages. Switching
it, the Tulai homepage or another product to published packages is a later
coordinated task after an explicit release decision. That work must update
versions, imports, lockfiles and package-boundary checks together, validate the
installed public artifacts, and retain a rollback to the existing workspace
packages. Fixes made in one repository do not automatically reach the other;
reconcile changes against the extraction baseline.

## License

MIT. Copyright (c) 2026 ROYIANS and Momoki contributors. The original attribution
is preserved in the root and package [LICENSE](LICENSE) files.
