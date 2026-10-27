# @tulai-design/agent-core

Runtime-neutral Agent execution algorithms and typed host contracts, distributed
as a public ESM package under the `@tulai-design` scope.

The root ESM export includes `executeRun`, `createToolFactory`, approval and tool
validation, context budget/compaction helpers, capability registration and
resource-grant types, and portable text-skill helpers. TypeScript declarations
ship alongside JavaScript in `dist`.

```ts
import {estimateTokens, normalizeContextPolicy} from '@tulai-design/agent-core';

const policy = normalizeContextPolicy({historyMessageCount: 12});
const estimatedTokens = estimateTokens('Hello');
```

An execution host calls `executeRun` under its own execution ownership and
implements `RuntimeHost` for its own persistence, model dispatch, tool binding
and settlement. The library owns the loop; applications retain business
transactions, tool effects, resource authorization, credentials and durable
unknown-effect recovery. An in-memory example cannot prove restart safety.

There are no runtime dependencies or provider/product/storage/native imports.
The library targets ES2022, supports Node 20+ and can be used by browser hosts
that supply its required standard Web APIs. Development uses the repository's
pinned Node/pnpm tooling. See the root [README](../../README.md) for the extraction
baseline and validation workflow.

MIT. Copyright (c) 2026 ROYIANS and Momoki contributors; see [LICENSE](LICENSE).
