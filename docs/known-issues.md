# 已修复：fetchImpl 直接传 `fetch` 会报 Illegal invocation

状态：**已修复，将随 `@tulai-design/agent-providers@0.2.0` 发布**。影响旧版 `0.1.0`。
发现日期：2026-10-22（在搭搭 homepage 接入时发现）
修复日期：2026-10-27

## 现象

宿主按类型声明直接传入 `fetch`：

```ts
await streamChatCompletions(input, {
  fetchImpl: fetch,
  signal,
})
```

浏览器报错：

```
TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
```

请求没有发出，AI 调用整体失败。

## 原因

旧版 `packages/agent-providers/src/http/requestBoundary.ts` 以**方法调用**形式使用它：

```ts
export async function requestOnce(url: string, init: RequestWire, options: RequestBoundaryOptions): Promise<Response> {
    options.signal?.throwIfAborted();
    return options.fetchImpl(url, {  // ← this 被绑定到 options 对象
        ...init,
        signal: options.signal,
        credentials: options.credentials,
        redirect: options.redirect,
    });
}
```

原生 `fetch` 要求 `this` 是 `window`。写成 `options.fetchImpl(...)` 时 `this` 变成了 `options`，浏览器拒绝执行。

`responses.ts:229` 有同样的写法（`{fetchImpl: handlers.fetchImpl, ...}` 之后进入同一个 `requestOnce`）。

类型标注是 `fetchImpl: typeof fetch`，但 TypeScript 无法表达"这个函数调用时不能带 this"的约束，所以类型检查完全通过。

## 旧版宿主的临时绕法

包一层箭头函数。箭头函数没有自己的 `this`，内部从 `globalThis` 取，怎么传都不会丢绑定：

```ts
const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args)

await streamChatCompletions(input, {
  fetchImpl: browserFetch,
  signal,
})
```

已验证：包装后请求正常发出（跨域时会得到正常的 `Failed to fetch`，而不是 `Illegal invocation`）。

## 修复方式与回归验证

公共请求边界已将方法调用换成裸调用，适用于 Chat Completions、Responses 和 Messages：

```ts
export async function requestOnce(url: string, init: RequestWire, options: RequestBoundaryOptions): Promise<Response> {
    options.signal?.throwIfAborted();
    const {fetchImpl} = options;   // 先摘出来，this 不再指向 options
    return fetchImpl(url, {
        ...init,
        signal: options.signal,
        credentials: options.credentials,
        redirect: options.redirect,
    });
}
```

`providers.test.ts` 新增回归测试：通过构建后的公共导出调用 Chat Completions，传入会拒绝错误 `this` 的假 fetch，确认调用成功且接收者为 `undefined`。测试不会发起真实网络请求。

已有的箭头包装和显式绑定方式仍兼容；升级后不再要求宿主为这个问题额外包装。

## 影响面

旧版会影响在浏览器中直接传原生 `fetch` 的宿主。Node 环境下 `fetch` 不校验 `this`，原有的 Node 测试没有检查接收者，因此漏掉了这个问题；新增回归直接检查调用约定。
