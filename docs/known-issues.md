# 已知问题：fetchImpl 直接传 `fetch` 会报 Illegal invocation

状态：**未修复**，影响 `@tulai-design/agent-providers@0.1.0`
发现日期：2026-10-22（在搭搭 homepage 接入时发现）

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

`packages/agent-providers/src/http/requestBoundary.ts:14` 以**方法调用**形式使用它：

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

## 宿主的临时绕法

包一层箭头函数。箭头函数没有自己的 `this`，内部从 `globalThis` 取，怎么传都不会丢绑定：

```ts
const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args)

await streamChatCompletions(input, {
  fetchImpl: browserFetch,
  signal,
})
```

已验证：包装后请求正常发出（跨域时会得到正常的 `Failed to fetch`，而不是 `Illegal invocation`）。

## 建议的修法

优先改 provider 内部，把方法调用换成裸调用：

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

修完后建议补一条回归测试：传入一个断言 `this` 为 `undefined`/`globalThis` 的假 fetch，确认 provider 内部没有把它当方法调用。

若暂不修代码，至少在 README 里写明宿主必须传入已绑定 `globalThis` 的 fetch——但这是把内部实现细节推给调用方，不如直接修。

## 影响面

任何在浏览器中直接传原生 `fetch` 的宿主都会踩到。Node 环境下 `fetch` 不校验 `this`，所以本项目现有的测试（都在 Node + 假 fetch 里跑）无法发现这个问题——这是它漏到发布版的直接原因。
