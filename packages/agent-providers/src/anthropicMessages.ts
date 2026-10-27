import type {AgentReasoningEffort, AgentTokenUsage, AgentWireToolCall} from '@tulai-design/agent-core';
import type {StreamChatHandlers, StreamChatInput, StreamChatResult} from './chatCompletions.js';
import type {ChatContentPart, ChatRequestMessage} from './wire.js';
import {appendedUtf8Bytes, assertResponseBytes, cancelBody, isReadAbort, MAX_ERROR_BYTES, MAX_JSON_BYTES, readErrorText, readResponseJson, readSseEvents, redactCredentials, requestOnce, utf8Bytes} from './http/index.js';

/** Preserve these opaque blocks verbatim across the tool-result continuation. */
export type AnthropicContentBlock = (
    | {type: 'text'; text: string}
    | {type: 'thinking'; thinking: string; signature: string}
    | {type: 'redacted_thinking'; data: string}
    | {type: 'tool_use'; id: string; name: string; input: Record<string, unknown>}
) & Record<string, unknown>;

export type AnthropicRequestMessage = Exclude<ChatRequestMessage, {role: 'assistant'}>
    | (Extract<ChatRequestMessage, {role: 'assistant'}> & {anthropicContent?: AnthropicContentBlock[]});
export type AnthropicMessagesInput = Omit<StreamChatInput, 'messages'> & {
    messages: readonly AnthropicRequestMessage[];
    /** Native parameters only. Wire fields cannot be replaced through this object. */
    extraBody?: Record<string, unknown>;
};
export type AnthropicMessagesHandlers = Omit<StreamChatHandlers, 'materializeMessages'> & {
    materializeMessages?: (signal?: AbortSignal) => Promise<readonly AnthropicRequestMessage[]>;
};
export type AnthropicMessagesResult =
    | (Extract<StreamChatResult, {ok: true}> & {anthropicContent: AnthropicContentBlock[]})
    | Extract<StreamChatResult, {ok: false}>;

const MAX_BLOCKS = 128;
const MAX_TOOLS = 16;
const MAX_ARGUMENT_BYTES = 32768;
const DEFAULT_MAX_TOKENS = 16384;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A server root, API base, or complete Messages endpoint is accepted. */
export function anthropicMessagesUrl(baseUrl: string): string {
    const url = new URL(baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Messages 接口地址无效');
    }
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = !path ? '/v1/messages' : path.endsWith('/messages') ? path : `${path}/messages`;
    return url.href;
}

function userContent(content: string | ChatContentPart[]): Record<string, unknown>[] {
    if (typeof content === 'string') return [{type: 'text', text: content}];
    return content.map((part) => {
        if (part.type === 'text') return {type: 'text', text: part.text};
        const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(part.image_url.url);
        return {type: 'image', source: data
            ? {type: 'base64', media_type: data[1], data: data[2]}
            : {type: 'url', url: part.image_url.url}};
    });
}

function toMessages(input: readonly AnthropicRequestMessage[]): {
    system?: string;
    messages: Array<{role: 'user' | 'assistant'; content: Record<string, unknown>[]}>
} {
    const system: string[] = [];
    const messages: Array<{role: 'user' | 'assistant'; content: Record<string, unknown>[]}> = [];
    let lastWasTool = false;
    for (const message of input) {
        if (message.role === 'system') {
            if (messages.length) throw new Error('Messages 协议仅支持开头的系统消息');
            if (typeof message.content !== 'string' && message.content.some((part) => part.type !== 'text')) {
                throw new Error('系统消息仅支持文本');
            }
            system.push(typeof message.content === 'string' ? message.content : message.content.map((part) => part.type === 'text' ? part.text : '').join('\n'));
        } else if (message.role === 'tool') {
            const block = {type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content};
            if (lastWasTool) messages[messages.length - 1].content.push(block);
            else messages.push({role: 'user', content: [block]});
        } else if (message.role === 'assistant') {
            const content = message.anthropicContent ?? [
                ...(message.content ? [{type: 'text', text: message.content}] : []),
                ...(message.tool_calls ?? []).map((call) => {
                    let input: unknown;
                    try { input = JSON.parse(call.function.arguments); } catch { throw new Error('工具调用参数不是完整 JSON'); }
                    if (!record(input)) throw new Error('工具参数必须是对象');
                    return {type: 'tool_use', id: call.id, name: call.function.name, input};
                }),
            ];
            messages.push({role: 'assistant', content});
        } else messages.push({role: 'user', content: userContent(message.content)});
        lastWasTool = message.role === 'tool';
    }
    if (!messages.length) throw new Error('消息不能为空');
    return {...(system.length ? {system: system.join('\n\n')} : {}), messages};
}

function reasoningParameters(model: string, effort: AgentReasoningEffort | undefined, maxTokens: number): Record<string, unknown> {
    if (effort === undefined) return {};
    if (effort === 'none') {
        if (/(?:^|\/)claude-(?:mythos(?:-|$)|fable-5(?:[-.]|$)|opus-5[-.]5(?:-|$))/i.test(model)) {
            throw new Error('此模型不能关闭思考，请省略 reasoningEffort 或使用低推理强度');
        }
        if (/(?:^|\/)claude-sonnet-5[-.]5(?:-|$)/i.test(model)) {
            throw new Error('此模型不支持关闭全部思考，请通过 extraBody 指定 thinking.type: between_tools');
        }
        return {thinking: {type: 'disabled'}};
    }
    // A dated Claude 4 ID ends in -20250514: that suffix is not a minor version.
    const version = /(?:^|\/)claude-([a-z]+)-(\d{1,2})(?:[-.](\d{1,2})(?=-|$))?(?=-|$)/i.exec(model);
    const major = version ? +version[2] : undefined, minor = version ? +(version[3] ?? 0) : undefined;
    const adaptive = /(?:^|\/)claude-mythos(?:-|$)/i.test(model) || major !== undefined && (major > 4 || major === 4 && minor !== undefined && minor >= 6);
    if (adaptive) return {thinking: {type: 'adaptive'}, output_config: {effort: effort === 'minimal' ? 'low' : effort}};
    const legacy = /(?:^|\/)claude-3[-.]7-sonnet(?:-|$)/i.test(model)
        || major === 4 && (version?.[1] === 'sonnet' || version?.[1] === 'opus' || version?.[1] === 'haiku' && minor === 5);
    if (!legacy) throw new Error('此模型的 Messages 推理参数未知，请使用 extraBody 指定原生参数');
    const budget = ({minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 12288, max: 16384} as const)[effort];
    if (maxTokens <= budget) throw new Error(`max_tokens 必须大于推理预算（${budget}）`);
    return {thinking: {type: 'enabled', budget_tokens: budget}};
}

function requestBody(input: AnthropicMessagesInput, messages: readonly AnthropicRequestMessage[]): Record<string, unknown> {
    const extras = {...input.extraBody};
    const configuredMax = input.maxOutputTokens ?? extras.max_tokens ?? DEFAULT_MAX_TOKENS;
    if (typeof configuredMax !== 'number' || !Number.isSafeInteger(configuredMax) || configuredMax < 1) throw new Error('max_tokens 必须是正整数');
    // Extra native reasoning controls are authoritative; never emit an incompatible second control.
    const reasoning = extras.thinking !== undefined || record(extras.output_config) && extras.output_config.effort !== undefined
        ? {} : reasoningParameters(input.model.trim(), input.reasoningEffort, configuredMax);
    if (record(reasoning.output_config) && record(extras.output_config)) {
        extras.output_config = {...reasoning.output_config, ...extras.output_config};
    }
    for (const key of ['model', 'messages', 'system', 'tools', 'stream', 'reasoning_effort', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty']) delete extras[key];
    // Haiku 5.5 fixes sampling; stale settings from a different model must not cause a 400.
    if (/(?:^|\/)claude-haiku-5[-.]5(?:-|$)/i.test(input.model.trim())) {
        for (const key of ['temperature', 'top_p', 'top_k']) delete extras[key];
    }
    return {
        ...reasoning, ...extras,
        model: input.model.trim(), max_tokens: configuredMax,
        ...toMessages(messages), stream: true,
        ...(input.tools?.length ? {tools: input.tools.map(({function: tool}) => ({name: tool.name, description: tool.description, input_schema: tool.parameters}))} : {}),
    };
}

function validateBlock(value: unknown, complete: boolean): AnthropicContentBlock {
    if (!record(value)) throw new Error('模型内容块格式无效');
    const block = {...value};
    switch (block.type) {
        case 'text':
            if (typeof block.text !== 'string') throw new Error('文本内容块格式无效');
            break;
        case 'thinking':
            if (!complete && block.signature === undefined) block.signature = '';
            if (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || complete && !block.signature) throw new Error('思考内容块缺少签名或格式无效');
            break;
        case 'redacted_thinking':
            if (typeof block.data !== 'string' || !block.data) throw new Error('隐藏思考内容块格式无效');
            break;
        case 'tool_use':
            if (typeof block.id !== 'string' || !block.id || block.id.length > 256 || typeof block.name !== 'string' || !block.name || block.name.length > 128) throw new Error('工具调用缺少标识或名称');
            if (!record(block.input)) throw new Error('工具参数必须是对象');
            if (utf8Bytes(JSON.stringify(block.input)) > MAX_ARGUMENT_BYTES) throw new Error('工具调用超过大小限制');
            break;
        default: throw new Error(`不支持的 Messages 内容块：${String(block.type).slice(0, 50)}`);
    }
    return block as AnthropicContentBlock;
}

function finishResult(blocks: AnthropicContentBlock[], finishReason: string | undefined, via: 'stream' | 'json', input: AnthropicMessagesInput): AnthropicMessagesResult {
    const content = blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
    const reasoning = blocks.flatMap((block) => block.type === 'thinking' ? [block.thinking] : []).join('');
    const ids = new Set<string>();
    const toolCalls: AgentWireToolCall[] = [];
    for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        if (!input.tools?.length) throw new Error('模型请求了工具调用，当前执行尚未启用工具能力');
        if (ids.has(block.id) || toolCalls.length >= MAX_TOOLS) throw new Error('工具调用标识重复或超过限制');
        ids.add(block.id);
        toolCalls.push({id: block.id, type: 'function', function: {name: block.name, arguments: JSON.stringify(block.input)}});
    }
    if (finishReason === 'max_tokens') return {ok: false, message: '回复达到模型长度上限，内容未完成', finishReason};
    if (toolCalls.length ? finishReason !== 'tool_use' : !['end_turn', 'stop_sequence'].includes(finishReason ?? '')) {
        return {ok: false, message: 'Messages 回复缺少完整或受支持的结束状态', ...(finishReason ? {finishReason} : {})};
    }
    if (!toolCalls.length && !content.trim()) return {ok: false, message: '模型未返回有效的回答内容', finishReason};
    const unofferedToolNames = toolCalls.filter((call) => !input.tools?.some((tool) => tool.function.name === call.function.name)).map((call) => call.function.name);
    return {ok: true, content, reasoning, via, finishReason, anthropicContent: blocks,
        ...(toolCalls.length ? {toolCalls} : {}), ...(unofferedToolNames.length ? {unofferedToolNames} : {})};
}

type BlockState = {block: AnthropicContentBlock; closed: boolean; arguments: string; argumentBytes: number; sawArguments: boolean};

/** Native Messages, one POST, no protocol fallback or automatic resubmission. */
export async function streamAnthropicMessages(input: AnthropicMessagesInput, handlers: AnthropicMessagesHandlers): Promise<AnthropicMessagesResult> {
    const apiKey = input.apiKey.trim();
    const signal = handlers.signal;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    let nativeUsage: Record<string, number> = {};
    const usage = (): AgentTokenUsage | undefined => {
        if (!Object.keys(nativeUsage).length) return undefined;
        const inputTokens = nativeUsage.input_tokens === undefined ? undefined : nativeUsage.input_tokens + (nativeUsage.cache_read_input_tokens ?? 0) + (nativeUsage.cache_creation_input_tokens ?? 0);
        const outputTokens = nativeUsage.output_tokens;
        return {...(inputTokens !== undefined ? {inputTokens} : {}), ...(outputTokens !== undefined ? {outputTokens} : {}),
            ...(nativeUsage.cache_read_input_tokens !== undefined ? {cachedInputTokens: nativeUsage.cache_read_input_tokens} : {}),
            ...(inputTokens !== undefined && outputTokens !== undefined ? {totalTokens: inputTokens + outputTokens} : {})};
    };
    const withMetrics = (result: AnthropicMessagesResult): AnthropicMessagesResult => {
        const counts = usage();
        return {...result, ...(counts ? {usage: counts} : {}), metrics: {startedAt, endedAt: Date.now(), ...(firstTokenAt === undefined ? {} : {firstTokenAt}), ...(counts ? {usage: counts} : {})}};
    };
    const readUsage = (value: unknown) => {
        if (!record(value)) return;
        for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
            if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) nativeUsage[key] = value[key];
        }
    };
    const emit = (block: AnthropicContentBlock, text: string) => {
        signal?.throwIfAborted();
        if (text && firstTokenAt === undefined) firstTokenAt = Date.now();
        if (block.type === 'text' && text) handlers.onDelta?.(text);
        if (block.type === 'thinking' && text) handlers.onReasoning?.(text);
        signal?.throwIfAborted();
    };
    try {
        signal?.throwIfAborted();
        if (!input.baseUrl.trim()) throw new Error('请填写 Base URL');
        if (!apiKey) throw new Error('请填写 API Key');
        if (!input.model.trim()) throw new Error('请选择模型');
        handlers.validateRequest?.();
        const url = anthropicMessagesUrl(input.baseUrl);
        const body = requestBody(input, await (handlers.materializeMessages?.(signal) ?? input.messages));
        const res = await requestOnce(url, {
            method: 'POST',
            headers: {'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
                ...(new URL(url).hostname === 'api.anthropic.com' ? {'anthropic-dangerous-direct-browser-access': 'true'} : {})},
            body: JSON.stringify(body),
        }, {fetchImpl: handlers.fetchImpl, signal, credentials: 'omit', redirect: 'error'});
        if (signal?.aborted) await cancelBody(res.body);
        signal?.throwIfAborted();
        if (!res.ok) {
            const detail = await readErrorText(res, MAX_ERROR_BYTES, signal);
            throw new Error(`请求失败（${res.status}）：${redactCredentials(detail, apiKey).slice(0, 200)}`);
        }
        if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
            const value: unknown = await readResponseJson(res, MAX_JSON_BYTES, signal);
            if (record(value) && value.type === 'error') throw new Error(record(value.error) && typeof value.error.message === 'string' ? value.error.message : '模型服务返回错误');
            if (!record(value) || value.type !== 'message' || value.role !== 'assistant' || !Array.isArray(value.content) || value.content.length > MAX_BLOCKS) throw new Error('Messages 响应格式无效');
            readUsage(value.usage);
            const blocks = value.content.map((block) => validateBlock(block, true));
            const result = finishResult(blocks, typeof value.stop_reason === 'string' ? value.stop_reason : undefined, 'json', input);
            if (result.ok) for (const block of blocks) emit(block, block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '');
            signal?.throwIfAborted();
            return withMetrics(result);
        }
        let started = false, stopped = false, finishReason: string | undefined, retainedBytes = 0;
        const blocks: BlockState[] = [];
        const account = (bytes: number) => { retainedBytes += bytes; assertResponseBytes(retainedBytes, MAX_JSON_BYTES); };
        for await (const event of readSseEvents(res, signal)) {
            if (!event.data && !event.event) continue;
            let value: unknown;
            try { value = JSON.parse(event.data); } catch { throw new Error('模型返回了无效的流事件'); }
            if (!record(value) || typeof value.type !== 'string' || event.event && event.event !== value.type) throw new Error('Messages 流事件类型无效');
            if (value.type === 'error') throw new Error(record(value.error) && typeof value.error.message === 'string' ? value.error.message : '模型服务返回错误');
            if (value.type === 'ping') continue;
            if (value.type === 'message_start') {
                if (started || !record(value.message) || value.message.role !== 'assistant' || value.message.type !== 'message' || !Array.isArray(value.message.content) || value.message.content.length) throw new Error('Messages 起始事件无效');
                started = true;
                readUsage(value.message.usage);
                continue;
            }
            if (!started) throw new Error('Messages 流缺少起始事件');
            if (value.type === 'message_delta') {
                if (blocks.some((block) => !block.closed) || !record(value.delta)) throw new Error('Messages 内容块尚未完成');
                const reason = value.delta.stop_reason;
                if (reason != null) {
                    if (typeof reason !== 'string' || !reason || finishReason && finishReason !== reason) throw new Error('Messages 结束状态无效');
                    finishReason = reason;
                }
                readUsage(value.usage);
                continue;
            }
            if (value.type === 'message_stop') {
                if (!finishReason || blocks.some((block) => !block.closed)) throw new Error('Messages 回复尚未完成');
                stopped = true;
                break;
            }
            if (finishReason) throw new Error('模型在结束状态后继续返回内容');
            const index = value.index;
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_BLOCKS) throw new Error('Messages 内容块索引无效');
            if (value.type === 'content_block_start') {
                if (index !== blocks.length || blocks.some((block) => !block.closed)) throw new Error('Messages 内容块起始顺序无效');
                const block = validateBlock(value.content_block, false);
                if (block.type === 'tool_use') {
                    if (!input.tools?.length || blocks.filter((state) => state.block.type === 'tool_use').length >= MAX_TOOLS) throw new Error('工具调用未启用或超过限制');
                    if (firstTokenAt === undefined) firstTokenAt = Date.now();
                }
                account(utf8Bytes(JSON.stringify(block)));
                blocks.push({block, closed: false, arguments: '', argumentBytes: 0, sawArguments: false});
                emit(block, block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '');
            } else {
                const state = blocks[index];
                if (!state || state.closed) throw new Error('Messages 内容块缺失或已经结束');
                if (value.type === 'content_block_stop') {
                    if (state.block.type === 'tool_use' && state.sawArguments) {
                        let parsed: unknown;
                        try { parsed = JSON.parse(state.arguments); } catch { throw new Error('工具调用参数不是完整 JSON'); }
                        if (!record(parsed)) throw new Error('工具参数必须是对象');
                        state.block.input = parsed;
                    }
                    validateBlock(state.block, true);
                    state.closed = true;
                } else if (value.type === 'content_block_delta' && record(value.delta)) {
                    const delta = value.delta, block = state.block;
                    if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') {
                        if (Object.keys(block.input).length) throw new Error('工具调用同时包含初始参数和增量参数');
                        const bytes = appendedUtf8Bytes(state.arguments, delta.partial_json);
                        state.argumentBytes += bytes;
                        if (state.argumentBytes > MAX_ARGUMENT_BYTES) throw new Error('工具调用超过大小限制');
                        account(bytes);
                        state.arguments += delta.partial_json;
                        // Empty deltas do not replace the valid empty object in content_block_start.
                        if (delta.partial_json) state.sawArguments = true;
                    } else if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
                        account(appendedUtf8Bytes(block.text, delta.text)); block.text += delta.text; emit(block, delta.text);
                    } else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') {
                        account(appendedUtf8Bytes(block.thinking, delta.thinking)); block.thinking += delta.thinking; emit(block, delta.thinking);
                    } else if (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string') {
                        // Unlike text deltas, the SDK treats a signature event as the complete value.
                        account(utf8Bytes(delta.signature) - utf8Bytes(block.signature)); block.signature = delta.signature;
                    } else throw new Error('Messages 内容增量类型无效');
                } else throw new Error('不支持的 Messages 流事件');
            }
        }
        signal?.throwIfAborted();
        if (!stopped) throw new Error('回复流意外中断，已保留收到的内容');
        return withMetrics(finishResult(blocks.map(({block}) => block), finishReason, 'stream', input));
    } catch (error) {
        if (isReadAbort(error, signal)) return withMetrics({ok: false, message: '已停止', aborted: true});
        return withMetrics({ok: false, message: redactCredentials(error instanceof Error ? error.message : '网络错误', apiKey).slice(0, 300)});
    }
}
