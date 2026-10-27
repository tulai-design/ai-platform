# @tulai-design/agent-providers

Portable Chat Completions, Anthropic Messages and Responses protocol implementations
with explicit host transport, distributed as a public ESM package.

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

## Anthropic Messages

`streamAnthropicMessages` accepts the same text/image chat messages and function
tool schemas as Chat Completions. It maps system messages to the native `system`
field, functions to `input_schema`, and consecutive tool results to a single
native user message. Select this transport explicitly for a server that supports
Messages; the library does not infer a provider from a model name or retry using
a different protocol.

```ts
import {streamAnthropicMessages, type AnthropicRequestMessage} from '@tulai-design/agent-providers';

const messages: AnthropicRequestMessage[] = [{role: 'user', content: 'Inspect appearance'}];
const result = await streamAnthropicMessages({
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: credentialFromHost,
  model: 'claude-haiku-5-5',
  messages,
  tools: hostToolSchemas,
  reasoningEffort: 'medium',
}, {fetchImpl: authorizedHostFetch, signal: abortController.signal});

if (result.ok && result.toolCalls?.length) {
  messages.push({role: 'assistant', content: result.content,
    tool_calls: result.toolCalls, anthropicContent: result.anthropicContent});
  // Validate/authorize/execute each call in the host, then append its result:
  // messages.push({role: 'tool', tool_call_id: call.id, content: toolResult});
}
```

Always retain `anthropicContent` when continuing a tool round. It contains the
original ordered content blocks, including opaque thinking signatures and
redacted-thinking data; visible text alone cannot reconstruct that continuation.
Signatures are not delivered to `onReasoning`. Treat these blocks as private
protocol state rather than public activity logs. The host remains responsible
for validation, permissions, execution and persistence.

The endpoint accepts a server root, an API base, or a complete `/messages` URL.
Authentication uses `x-api-key` and `anthropic-version: 2023-06-01`. Browser-access
opt-in is sent only to `api.anthropic.com`; third-party gateways must provide
their own CORS support. Fetch uses omitted cookies and rejects redirects.

Messages requires `max_tokens`; the default is 16,384, overridden by
`maxOutputTokens` or native `extraBody.max_tokens`. An omitted `reasoningEffort`
leaves thinking at the server default. Claude 4.6 and newer named models use
adaptive thinking with `output_config.effort`; supported legacy models (Sonnet
3.7, Sonnet/Opus 4–4.5, Haiku 4.5) use bounded manual thinking budgets (low 1,024
/ medium 4,096 / high 8,192). Unknown models require explicit native parameters
when an effort override is requested. A manual budget
must be below `max_tokens`. Explicit `extraBody.thinking` or
`extraBody.output_config.effort` takes precedence over generic effort. Haiku 5.5
sampling overrides are omitted because that model fixes its sampling settings.
Generic `reasoningEffort: 'none'` is rejected locally for known always-thinking
models and Sonnet 5.5. Sonnet 5.5's distinct `between_tools` mode can be selected
explicitly through native `extraBody.thinking`.
OpenAI-only penalty and reasoning fields are never sent to Messages; native
extra parameters cannot replace model, messages, system, tools or stream.

The adapter supports client function tools, text, images, signed thinking and
redacted thinking. Built-in server tools and their content blocks are not yet
supported. It validates complete content blocks and the native `message_stop`
before exposing tools, including zero-argument tools whose initial input is
`{}` and needs no JSON delta. Length exhaustion, invalid arguments, duplicate
tool IDs, malformed framing and interrupted streams return failures with no
callable tools. Limits are 16 tool calls, 128 content blocks, 32 KiB per tool
argument object, and the shared 4 MiB response budget. Native JSON responses to
the same streaming request are supported without making a second request.

The package depends on `@tulai-design/agent-core` through a semver range. It ships
ESM and TypeScript declarations, targets ES2022 and supports Node 20+ or browser
hosts with Fetch, streams and AbortSignal. Development uses the repository's
pinned Node/pnpm tooling. See the root [README](../../README.md) for the extraction
baseline and validation workflow.

MIT. Copyright (c) 2026 ROYIANS and Momoki contributors; see [LICENSE](LICENSE).
