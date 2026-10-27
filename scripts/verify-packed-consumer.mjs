#!/usr/bin/env node
// Validates the packages the way a real consumer receives them: pack both
// tarballs, install them into an isolated project outside this workspace, then
// type-check and execute code that imports only the published entry points.
//
// A workspace test cannot prove this. Source aliases, undeclared
// devDependencies and a missing declaration in `files` all resolve locally and
// fail only once the packages are installed from their tarballs.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packages = [
    {dir: 'packages/agent-core', name: '@tulai-design/agent-core'},
    {dir: 'packages/agent-providers', name: '@tulai-design/agent-providers'},
];

const work = mkdtempSync(join(tmpdir(), 'tulai-consumer-'));
const tarballs = join(work, 'tarballs');
const consumer = join(work, 'consumer');

function run(command, args, cwd) {
    execFileSync(command, args, {cwd, stdio: 'pipe', encoding: 'utf8'});
}

function fail(message) {
    console.error(`\nverify-packed-consumer: ${message}`);
    if (!process.env.KEEP_CONSUMER) rmSync(work, {recursive: true, force: true});
    else console.error(`kept: ${work}`);
    process.exit(1);
}

function readPackedManifest(tarball) {
    return JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {encoding: 'utf8'}));
}

const installed = {};

try {
    execFileSync('mkdir', ['-p', tarballs, consumer]);

    for (const pkg of packages) {
        const before = new Set(execFileSync('ls', [tarballs], {encoding: 'utf8'}).split('\n').filter(Boolean));
        run('npm', ['pack', '--pack-destination', tarballs, '--silent'], join(root, pkg.dir));
        const added = execFileSync('ls', [tarballs], {encoding: 'utf8'}).split('\n').filter((f) => f && !before.has(f));
        if (added.length !== 1) fail(`expected one tarball from ${pkg.name}, got: ${added.join(', ') || 'none'}`);

        const tarball = join(tarballs, added[0]);
        const manifest = readPackedManifest(tarball);

        // Publish-blocking metadata must never survive into a tarball.
        if (manifest.private) fail(`${pkg.name} is still marked private in its tarball`);
        if (manifest.name !== pkg.name) fail(`tarball name ${manifest.name} does not match ${pkg.name}`);
        for (const [depName, range] of Object.entries(manifest.dependencies ?? {})) {
            // A tarball must resolve through the registry. Local protocols and
            // paths work only inside the workspace that produced them.
            if (/^(workspace:|file:|link:|portal:|\.{0,2}\/)/.test(range)) {
                fail(`${pkg.name} depends on ${depName}@${range}; a packaged dependency needs a registry range`);
            }
        }

        installed[pkg.name] = {tarball, manifest};
        console.log(`packed ${pkg.name}@${manifest.version}`);
    }

    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
        name: 'tulai-consumer-verification',
        private: true,
        type: 'module',
        version: '0.0.0',
    }, null, 2));

    // Install every tarball in one command so the provider's core dependency
    // resolves to the packed core rather than a registry lookup.
    run('npm', [
        'install', '--no-audit', '--no-fund', '--ignore-scripts',
        ...packages.map((pkg) => installed[pkg.name].tarball),
        'typescript@^5.9.2',
    ], consumer);

    // macOS resolves the temp directory through a symlink, so compare real paths.
    const consumerReal = execFileSync('node', ['-e',
        `process.stdout.write(require('node:fs').realpathSync(${JSON.stringify(consumer)}))`,
    ], {encoding: 'utf8'});

    for (const pkg of packages) {
        const installedDir = join(consumer, 'node_modules', ...pkg.name.split('/'));
        if (!existsSync(join(installedDir, 'package.json'))) fail(`${pkg.name} did not install into the consumer`);
        const onDisk = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
        if (onDisk.version !== installed[pkg.name].manifest.version) {
            fail(`${pkg.name} installed ${onDisk.version}, expected ${installed[pkg.name].manifest.version}`);
        }
        // A symlink means the consumer reached workspace state instead of the artifact.
        const real = execFileSync('node', ['-e',
            `process.stdout.write(require('node:fs').realpathSync(${JSON.stringify(installedDir)}))`,
        ], {encoding: 'utf8'});
        if (!real.startsWith(consumerReal)) fail(`${pkg.name} resolved outside the consumer at ${real}`);
    }

    // Imports here name only the published entry points. Nothing reaches into
    // another package's private source.
    writeFileSync(join(consumer, 'index.ts'), `
import {MODEL_STEPS_PER_SEGMENT, estimateTokens, normalizeContextPolicy, requiresToolApproval} from '@tulai-design/agent-core';
import {authHeaders, chatCompletionsUrl, streamAnthropicMessages, anthropicMessagesUrl, type AnthropicMessagesInput, type AnthropicMessagesHandlers, type AnthropicMessagesResult, type AnthropicContentBlock} from '@tulai-design/agent-providers';
import {normalizeBaseUrl, redactCredentials} from '@tulai-design/agent-providers/http';

const policy = normalizeContextPolicy({historyMessageCount: 12});
const tokens: number = estimateTokens('Hello 世界');
const steps: number = MODEL_STEPS_PER_SEGMENT;
const headers = authHeaders('  test-key  ');
const url: string = chatCompletionsUrl('https://example.invalid/v1///');
const base: string = normalizeBaseUrl(' https://example.invalid/v1/ ');
const redacted: string = redactCredentials('Authorization: Bearer sk-test-key', 'sk-test-key');
const approval: boolean = requiresToolApproval('ask', {effect: 'write', highRisk: () => false}, {});

const nativeInput: AnthropicMessagesInput = {
    baseUrl: 'https://example.invalid', apiKey: 'native-test-key', model: 'claude-haiku-5-5',
    messages: [{role: 'system', content: 'System prompt'}, {role: 'user', content: 'Hello'}],
    reasoningEffort: 'medium',
};
const nativeBlocks: AnthropicContentBlock[] = [
    {type: 'thinking', thinking: '', signature: 'exact-opaque-signature'},
    {type: 'text', text: 'Hello from Messages'},
];
const nativeRequests: {url: string; headers: Record<string, string>; body: Record<string, unknown>}[] = [];
const nativeHandlers: AnthropicMessagesHandlers = {fetchImpl: async (requestUrl, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized native request');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {headers[key] = value;});
    nativeRequests.push({url: String(requestUrl), headers, body: JSON.parse(init.body)});
    return Response.json({id: 'msg_packed_consumer', type: 'message', role: 'assistant', content: nativeBlocks,
        stop_reason: 'end_turn', usage: {input_tokens: 5, output_tokens: 4}});
}};
const nativeResult: AnthropicMessagesResult = await streamAnthropicMessages(nativeInput, nativeHandlers);
const nativeUrl: string = anthropicMessagesUrl(nativeInput.baseUrl);

export const observed = {policy, tokens, steps, headers, url, base, redacted, approval, nativeBlocks, nativeRequests, nativeResult, nativeUrl};
`);

    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: false,
            outDir: 'out',
            types: [],
        },
        include: ['index.ts'],
    }, null, 2));

    // skipLibCheck is off on purpose: the emitted declarations must stand on
    // their own without the source tree.
    run('npx', ['tsc', '-p', 'tsconfig.json'], consumer);

    writeFileSync(join(consumer, 'assert.mjs'), `
import assert from 'node:assert/strict';
const {observed} = await import('./out/index.js');

assert.equal(observed.policy.historyMessageCount, 12);
assert.ok(observed.tokens > 0);
assert.equal(observed.steps, 32);
assert.equal(observed.headers.Authorization, 'Bearer test-key');
assert.equal(observed.url, 'https://example.invalid/v1/chat/completions');
assert.equal(observed.base, 'https://example.invalid/v1');
assert.ok(!observed.redacted.includes('sk-test-key'), 'credential material survived redaction');
assert.equal(observed.approval, true);
assert.equal(observed.nativeUrl, 'https://example.invalid/v1/messages');
assert.equal(observed.nativeRequests.length, 1);
const nativeRequest = observed.nativeRequests[0];
assert.equal(nativeRequest.url, observed.nativeUrl);
assert.equal(nativeRequest.headers['x-api-key'], 'native-test-key');
assert.equal(nativeRequest.headers['anthropic-version'], '2023-06-01');
assert.equal(nativeRequest.headers.authorization, undefined);
assert.equal(nativeRequest.body.system, 'System prompt');
assert.deepEqual(nativeRequest.body.messages, [{role: 'user', content: [{type: 'text', text: 'Hello'}]}]);
assert.deepEqual(nativeRequest.body.thinking, {type: 'adaptive'});
assert.deepEqual(nativeRequest.body.output_config, {effort: 'medium'});
assert.equal(observed.nativeResult.ok, true);
assert.equal(observed.nativeResult.content, 'Hello from Messages');
assert.deepEqual(observed.nativeResult.anthropicContent, observed.nativeBlocks);
console.log('installed packages type-check and execute correctly');
`);

    const output = execFileSync('node', ['assert.mjs'], {cwd: consumer, encoding: 'utf8'});
    process.stdout.write(output);

    rmSync(work, {recursive: true, force: true});
    console.log('verify-packed-consumer: passed');
} catch (error) {
    const stderr = error.stderr?.toString().trim();
    const stdout = error.stdout?.toString().trim();
    fail(`${error.message.split('\n')[0]}${stdout ? `\n${stdout}` : ''}${stderr ? `\n${stderr}` : ''}`);
}
