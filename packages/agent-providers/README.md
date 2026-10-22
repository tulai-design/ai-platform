# @tulai-design/agent-providers

Portable Chat Completions and Responses protocol implementations with explicit
host transport. This package is prepared for public distribution; this
extraction task has not published it to npm.

| Export | Contents |
| --- | --- |
| `@tulai-design/agent-providers` | Streaming protocols, materialized wire types, endpoint and continuation helpers |
| `@tulai-design/agent-providers/http` | Bounded response/SSE readers, credential redaction, request and JSON policy helpers |

```ts
import {streamChatCompletions} from '@tulai-design/agent-providers';

const result = await streamChatCompletions({
  baseUrl: 'https://api.example.com/v1',
  apiKey: credentialFromHost,
  model: modelFromHost,
  messages: [{role: 'user', content: 'Hello'}],
}, {
  fetchImpl: authorizedHostFetch,
  signal: abortController.signal,
});
```

The example's credentials, model, transport and AbortController are supplied by
an application. Hosts own credential lookup, request authorization, reference
materialization, storage and native/browser transport selection. The library
never selects a global transport implicitly or owns a credential store.
Responses continuation preserves validated opaque protocol data; applications
persist it without reconstructing it from visible chat text.

The package depends on `@tulai-design/agent-core` through a semver range. It ships
ESM and TypeScript declarations, targets ES2022 and supports Node 20+ or browser
hosts with Fetch, streams and AbortSignal. Development uses the repository's
pinned Node/pnpm tooling. See the root [README](../../README.md) for the extraction
baseline and validation workflow.

MIT. Copyright (c) 2026 ROYIANS and Momoki contributors; see [LICENSE](LICENSE).
