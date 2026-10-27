import {describe, expect, it, vi} from 'vitest';
import {anthropicMessagesUrl, streamAnthropicMessages, type AnthropicMessagesInput} from './anthropicMessages.js';

const base: AnthropicMessagesInput = {
    baseUrl: 'https://aihubmix.com/v1', apiKey: 'test-secret', model: 'claude-haiku-5-5',
    messages: [{role: 'system', content: 'Be helpful'}, {role: 'user', content: 'Inspect appearance'}],
    tools: [{type: 'function', function: {name: 'get_appearance', description: 'Inspect appearance', parameters: {type: 'object', properties: {}}}}],
};
type Frame = Record<string, unknown>;
const start: Frame = {type: 'message_start', message: {type: 'message', role: 'assistant', content: [], usage: {input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 1}}};
const blockStart = (index: number, content_block: unknown): Frame => ({type: 'content_block_start', index, content_block});
const delta = (index: number, delta: unknown): Frame => ({type: 'content_block_delta', index, delta});
const blockStop = (index: number): Frame => ({type: 'content_block_stop', index});
const finish = (stop_reason = 'tool_use'): Frame[] => [{type: 'message_delta', delta: {stop_reason}, usage: {output_tokens: 6}}, {type: 'message_stop'}];
const tool = (index = 0, id = 'tool_1', input: Record<string, unknown> = {}): Frame[] => [blockStart(index, {type: 'tool_use', id, name: 'get_appearance', input}), blockStop(index)];
const thinking: Frame[] = [blockStart(0, {type: 'thinking', thinking: '', signature: ''}), delta(0, {type: 'thinking_delta', thinking: 'Inspect first.'}), delta(0, {type: 'signature_delta', signature: 'superseded-signature'}), delta(0, {type: 'signature_delta', signature: 'opaque-signature'}), blockStop(0)];
const textFrames: Frame[] = [start, blockStart(0, {type: 'text', text: ''}), delta(0, {type: 'text_delta', text: '你好 🌟'}), blockStop(0), ...finish('end_turn')];
const jsonResponse = (content: unknown[] = [{type: 'text', text: 'Done'}], stop_reason = 'end_turn') => Response.json({type: 'message', role: 'assistant', content, stop_reason, usage: {input_tokens: 10, output_tokens: 6}});
const sse = (frames: Frame[], chunkSize = 0, terminator = '\n\n') => {
    const bytes = new TextEncoder().encode(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}${terminator}`).join(''));
    return new Response(new ReadableStream<Uint8Array>({start(controller) {
        for (let start = 0; start < bytes.length; start += chunkSize || bytes.length) controller.enqueue(bytes.slice(start, start + (chunkSize || bytes.length)));
        controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}});
};
const call = (frames: Frame[], input: Partial<AnthropicMessagesInput> = {}) => streamAnthropicMessages({...base, ...input}, {fetchImpl: vi.fn(async () => sse(frames))});
const request = async (input: Partial<AnthropicMessagesInput> = {}) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse());
    const result = await streamAnthropicMessages({...base, ...input}, {fetchImpl});
    return {result, fetchImpl, body: fetchImpl.mock.calls[0] ? JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) : undefined};
};

describe('Anthropic Messages request and continuation', () => {
    it.each(['https://aihubmix.com', 'https://aihubmix.com/', 'https://aihubmix.com/v1', 'https://aihubmix.com/v1/', 'https://aihubmix.com/v1/messages/'])('normalizes endpoint %s', (url) => {
        expect(anthropicMessagesUrl(url)).toBe('https://aihubmix.com/v1/messages');
    });
    it.each(['https://key@example.com/v1', 'https://example.com/v1?secret=value', 'https://example.com/v1#hash', 'file:///tmp/a'])('rejects ambiguous endpoint %s', (url) => {
        expect(() => anthropicMessagesUrl(url)).toThrow();
    });
    it('sends native auth, system and tools without changing the model or default thinking', async () => {
        const {result, body, fetchImpl} = await request();
        expect(result.ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://aihubmix.com/v1/messages');
        expect(init).toMatchObject({credentials: 'omit', redirect: 'error', headers: {'x-api-key': 'test-secret', 'anthropic-version': '2023-06-01'}});
        expect(body).toEqual({model: base.model, max_tokens: 16384, system: 'Be helpful', stream: true,
            messages: [{role: 'user', content: [{type: 'text', text: 'Inspect appearance'}]}],
            tools: [{name: 'get_appearance', description: 'Inspect appearance', input_schema: {type: 'object', properties: {}}}]});
    });
    it.each(['claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-5.5', 'claude-fable-5-1'])('uses adaptive effort for %s', async (model) => {
        const {body} = await request({model, reasoningEffort: 'high'});
        expect(body.thinking).toEqual({type: 'adaptive'});
        expect(body.output_config).toEqual({effort: 'high'});
        expect(body.reasoning_effort).toBeUndefined();
        expect(body.model).toBe(model);
    });
    it('keeps supported legacy budgets and rejects insufficient output bounds before sending', async () => {
        expect((await request({model: 'claude-sonnet-4-5', reasoningEffort: 'medium'})).body.thinking).toEqual({type: 'enabled', budget_tokens: 4096});
        const invalid = await request({model: 'claude-sonnet-4-5', reasoningEffort: 'high', maxOutputTokens: 4096});
        expect(invalid.result).toMatchObject({ok: false});
        expect(invalid.fetchImpl).not.toHaveBeenCalled();
    });
    it.each(['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219'])('does not confuse a date suffix with an adaptive minor version: %s', async (model) => {
        expect((await request({model, reasoningEffort: 'medium'})).body.thinking).toEqual({type: 'enabled', budget_tokens: 4096});
    });
    it.each(['claude-custom', 'claude-3-5-haiku-latest'])('does not guess unsupported legacy reasoning for %s', async (model) => {
        const {result, fetchImpl} = await request({model, reasoningEffort: 'medium'});
        expect(result).toMatchObject({ok: false});
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each(['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-preview', 'claude-sonnet-5-5'])('rejects unsupported generic thinking disable for %s before sending', async (model) => {
        const {result, fetchImpl} = await request({model, reasoningEffort: 'none'});
        expect(result).toMatchObject({ok: false});
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each(['claude-haiku-5-5', 'claude-opus-5'])('preserves supported thinking disable for %s', async (model) => {
        expect((await request({model, reasoningEffort: 'none'})).body.thinking).toEqual({type: 'disabled'});
    });
    it('honors explicit native reasoning, strips incompatible sampling and protects wire fields', async () => {
        const {body} = await request({reasoningEffort: 'high', extraBody: {
            thinking: {type: 'adaptive', display: 'omitted'}, output_config: {effort: 'low'}, temperature: 0.7, top_p: 0.5, top_k: 10,
            model: 'changed', system: 'changed', messages: [], tools: [], stream: false, reasoning_effort: 'low', presence_penalty: 1,
        }});
        expect(body).toMatchObject({model: base.model, system: 'Be helpful', thinking: {type: 'adaptive', display: 'omitted'}, output_config: {effort: 'low'}, stream: true});
        for (const field of ['temperature', 'top_p', 'top_k', 'reasoning_effort', 'presence_penalty']) expect(body[field]).toBeUndefined();
        expect(body.tools).toHaveLength(1);
        expect(body.messages).toHaveLength(1);
    });
    it('lets explicit output_config effort override generic effort without legacy thinking', async () => {
        const {body} = await request({model: 'gateway-custom', reasoningEffort: 'high', extraBody: {output_config: {effort: 'low'}}});
        expect(body.output_config).toEqual({effort: 'low'});
        expect(body.thinking).toBeUndefined();
    });
    it('preserves signed/redacted thinking and batches parallel tool results into one user message', async () => {
        const first = await call([start, ...thinking, blockStart(1, {type: 'redacted_thinking', data: 'opaque-data'}), blockStop(1), ...tool(2), ...tool(3, 'tool_2'), ...finish()]);
        expect(first).toMatchObject({ok: true, anthropicContent: [{type: 'thinking', signature: 'opaque-signature'}, {type: 'redacted_thinking', data: 'opaque-data'}, {type: 'tool_use', id: 'tool_1'}, {type: 'tool_use', id: 'tool_2'}]});
        if (!first.ok) throw new Error(first.message);
        const {body} = await request({messages: [...base.messages,
            {role: 'assistant', content: first.content, tool_calls: first.toolCalls, anthropicContent: first.anthropicContent},
            {role: 'tool', tool_call_id: 'tool_1', content: 'first'}, {role: 'tool', tool_call_id: 'tool_2', content: 'second'},
        ]});
        expect(body.messages[1]).toEqual({role: 'assistant', content: first.anthropicContent});
        expect(body.messages[2]).toEqual({role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool_1', content: 'first'}, {type: 'tool_result', tool_use_id: 'tool_2', content: 'second'}]});
    });
    it('enables direct browser access only on the official Anthropic host', async () => {
        const official = await request({baseUrl: 'https://api.anthropic.com'});
        expect(official.fetchImpl.mock.calls[0][1]?.headers).toMatchObject({'anthropic-dangerous-direct-browser-access': 'true'});
        expect((await request()).fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('anthropic-dangerous-direct-browser-access');
    });
});

describe('Anthropic Messages responses', () => {
    it('assembles a tool at content index 1 after thinking, including {} arguments', async () => {
        const frames = [start, ...thinking, blockStart(1, {type: 'tool_use', id: 'tool_1', name: 'get_appearance', input: {}}), delta(1, {type: 'input_json_delta', partial_json: ''}), delta(1, {type: 'input_json_delta', partial_json: '{'}), delta(1, {type: 'input_json_delta', partial_json: '}'}), blockStop(1), ...finish()];
        const onReasoning = vi.fn();
        const result = await streamAnthropicMessages(base, {fetchImpl: vi.fn(async () => sse(frames, 3)), onReasoning});
        expect(result).toMatchObject({ok: true, toolCalls: [{id: 'tool_1', function: {name: 'get_appearance', arguments: '{}'}}], usage: {inputTokens: 30, cachedInputTokens: 20, outputTokens: 6, totalTokens: 36}});
        expect(onReasoning).toHaveBeenCalledExactlyOnceWith('Inspect first.');
        expect(JSON.stringify(onReasoning.mock.calls)).not.toContain('signature');
    });
    it('accepts a no-argument native tool with no argument deltas', async () => {
        expect(await call([start, ...tool(), ...finish()])).toMatchObject({ok: true, toolCalls: [{function: {arguments: '{}'}}]});
    });
    it('accepts an omitted initial signature and replaces repeated/updated full signatures', async () => {
        const result = await call([start, blockStart(0, {type: 'thinking', thinking: ''}),
            delta(0, {type: 'signature_delta', signature: 'first'}), delta(0, {type: 'signature_delta', signature: 'final'}),
            delta(0, {type: 'signature_delta', signature: 'final'}), blockStop(0), ...tool(1), ...finish()]);
        expect(result).toMatchObject({ok: true, anthropicContent: [{type: 'thinking', signature: 'final'}, {type: 'tool_use'}]});
        const invalid = await call([start, blockStart(0, {type: 'thinking', thinking: ''}), blockStop(0), ...tool(1), ...finish()]);
        expect(invalid).toMatchObject({ok: false});
    });
    it('decodes fragmented UTF-8 text and reports text once', async () => {
        const onDelta = vi.fn();
        const result = await streamAnthropicMessages(base, {fetchImpl: vi.fn(async () => sse(textFrames, 1)), onDelta});
        expect(result).toMatchObject({ok: true, content: '你好 🌟', via: 'stream'});
        expect(onDelta).toHaveBeenCalledExactlyOnceWith('你好 🌟');
    });
    it('supports native JSON tools and exposes unoffered names without executing them', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse([{type: 'tool_use', id: 'tool_1', name: 'other', input: {}}], 'tool_use'));
        expect(await streamAnthropicMessages(base, {fetchImpl})).toMatchObject({ok: true, via: 'json', unofferedToolNames: ['other'], toolCalls: [{function: {arguments: '{}'}}]});
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['missing message_stop', [start, ...tool(), finish()[0]]],
        ['missing block_stop', [start, blockStart(0, {type: 'tool_use', id: 'a', name: 'get_appearance', input: {}}), ...finish()]],
        ['truncated JSON', [start, blockStart(0, {type: 'tool_use', id: 'a', name: 'get_appearance', input: {}}), delta(0, {type: 'input_json_delta', partial_json: '{'}), blockStop(0), ...finish()]],
        ['nonobject arguments', [start, blockStart(0, {type: 'tool_use', id: 'a', name: 'get_appearance', input: {}}), delta(0, {type: 'input_json_delta', partial_json: '[]'}), blockStop(0), ...finish()]],
        ['duplicate tool ids', [start, ...tool(), ...tool(1), ...finish()]],
        ['wrong finish reason', [start, ...tool(), ...finish('end_turn')]],
        ['length limit', [start, ...tool(), ...finish('max_tokens')]],
        ['index drift', [start, blockStart(0, {type: 'tool_use', id: 'a', name: 'get_appearance', input: {}}), delta(1, {type: 'input_json_delta', partial_json: '{}'}), blockStop(0), ...finish()]],
        ['missing signature', [start, blockStart(0, {type: 'thinking', thinking: '', signature: ''}), blockStop(0), ...tool(1), ...finish()]],
        ['unknown block', [start, blockStart(0, {type: 'server_tool_use', id: 'a', name: 'search', input: {}}), blockStop(0), ...finish()]],
        ['missing start', [...tool(), ...finish()]],
        ['late content', [start, ...tool(), finish()[0], ...tool(1, 'b'), finish()[1]]],
    ] satisfies Array<[string, Frame[]]>)('rejects %s without returning callable tools', async (_name, frames) => {
        const result = await call(frames);
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('toolCalls');
    });
    it('enforces argument byte and tool count limits', async () => {
        const oversized = await call([start, ...tool(0, 'a', {text: '界'.repeat(12000)}), ...finish()]);
        expect(oversized).toMatchObject({ok: false});
        const tooMany = await call([start, ...Array.from({length: 17}, (_, index) => tool(index, `tool_${index}`)).flat(), ...finish()]);
        expect(tooMany).toMatchObject({ok: false});
    });
    it('does not leak credentials from HTTP or SSE errors and never retries', async () => {
        for (const response of [new Response('bad test-secret', {status: 400}), sse([{type: 'error', error: {message: 'bad test-secret'}}])]) {
            const fetchImpl = vi.fn(async () => response);
            const result = await streamAnthropicMessages(base, {fetchImpl});
            expect(result.ok).toBe(false);
            expect(JSON.stringify(result)).not.toContain('test-secret');
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    });
    it('cancels pending SSE reads and releases the reader on abort', async () => {
        const controller = new AbortController(), cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));}, cancel});
        const pending = streamAnthropicMessages(base, {signal: controller.signal, fetchImpl: vi.fn(async () => new Response(body, {headers: {'content-type': 'text/event-stream'}}))});
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        expect(await pending).toMatchObject({ok: false, aborted: true});
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });
    it('stops before fetching when already aborted', async () => {
        const controller = new AbortController(); controller.abort();
        const fetchImpl = vi.fn<typeof fetch>();
        expect(await streamAnthropicMessages(base, {signal: controller.signal, fetchImpl})).toMatchObject({ok: false, aborted: true});
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
