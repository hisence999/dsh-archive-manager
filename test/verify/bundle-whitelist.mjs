/**
 * 客户端 bundle 白名单 + 信封校验（T5 独立复核，比 `test/build.test.mjs` 更严格）。
 *
 * 在 `test/build.test.mjs` 基础上补三点：
 * 1. 白名单命中必须区分字段：`PLATFORM_MODULES`（基座，免费）vs
 *    `dsh.client.external`（真正决定运行时模块解析）vs `dsh.client.inject`
 *    （官方类型注释明确写着 "Informational package-name dependencies, not Cordis
 *    service injection"，见 `dsh-package-manifest/lib/types/types.d.ts:76-89`）。
 *    只靠 `inject` 声明的非基座模块 = **运行时解析会失败**，本脚本按 FAIL 处理。
 * 2. 禁止 require Node 内建（浏览器 bundle 里出现 fs/path 等即为错误）。
 * 3. 报告 `require.async` 动态 chunk 请求。
 *
 * 只读。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLATFORM_MODULES } from './tools/expectations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

const NODE_BUILTINS = new Set([
	'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'path', 'node:path', 'os', 'node:os',
	'child_process', 'node:child_process', 'crypto', 'node:crypto', 'http', 'node:http',
	'https', 'node:https', 'net', 'node:net', 'url', 'node:url', 'util', 'node:util',
	'events', 'node:events', 'stream', 'node:stream', 'worker_threads', 'node:worker_threads'
]);

const declaredExternal = new Set(packageJson?.dsh?.client?.external ?? []);
const declaredInject = new Set(packageJson?.dsh?.client?.inject ?? []);
const platform = new Set(PLATFORM_MODULES);

const failures = [];
const warnings = [];
const notes = [];

// --- 1. 执行信封，捕获注册与 require ---
const requested = [];
let registered;
globalThis.window = {
	__ModuleLoader__: {
		load(entry) {
			registered = entry;
		}
	}
};
try {
	const script = new Function('require', `with (window) { ${source} }`);
	script((id) => {
		requested.push(id);
		return {};
	});
} finally {
	delete globalThis.window;
}

if (!registered) {
	failures.push('bundle 未调用 window.__ModuleLoader__.load({ id, factory })');
} else {
	if (registered.id !== packageJson.name) failures.push(`信封 id=${JSON.stringify(registered.id)} 应为包名 ${packageJson.name}`);
	if (typeof registered.factory !== 'function') failures.push('信封 factory 不是函数');
	if (typeof registered.factory === 'function') {
		let exports;
		try {
			exports = registered.factory((id) => {
				requested.push(id);
				return {};
			});
		} catch (error) {
			failures.push(`factory 执行抛错：${error?.message ?? error}`);
		}
		if (exports) {
			if (typeof exports.apply !== 'function') failures.push('factory 未导出 apply 函数');
			if (!Array.isArray(exports.inject)) failures.push('factory 未导出 inject 数组');
		}
	}
}
notes.push(`信封形态：${registered ? 'window.__ModuleLoader__.load({ id, factory })' : '（未注册）'}；bundle 字节数 ${Buffer.byteLength(source)}`);

// --- 2. 逐个 require 归类 ---
const seen = new Set();
for (const id of requested) {
	if (seen.has(id)) continue;
	seen.add(id);
	if (platform.has(id)) continue;
	if (NODE_BUILTINS.has(id)) {
		failures.push(`require 了 Node 内建模块 ${id}（浏览器 bundle 不允许）`);
		continue;
	}
	if (declaredExternal.has(id)) {
		notes.push(`require ${id} → dsh.client.external ✅`);
		continue;
	}
	if (declaredInject.has(id)) {
		failures.push(`require ${id} 只在 dsh.client.inject 里声明；该字段官方定义为 informational，不参与模块解析 —— 必须改到 dsh.client.external`);
		continue;
	}
	failures.push(`require 了未声明提供方的模块 ${id}`);
}
if (seen.size === 0) notes.push('本次构建未 require 任何外部模块（仅内联代码）');

// --- 3. 动态 chunk ---
for (const match of source.matchAll(/require\s*\.\s*async\s*\(/g)) {
	warnings.push(`bundle 含 require.async（动态 chunk，位置 ${match.index}）—— 需确认 chunk 产物随包发布`);
}

console.log(`# 校验对象：${join(ROOT, 'lib', 'client.js')}`);
console.log(`# require 到的模块（${seen.size}）：${[...seen].join(', ') || '（无）'}`);
console.log(`# dsh.client.external=${JSON.stringify([...declaredExternal])} dsh.client.inject=${JSON.stringify([...declaredInject])}`);
for (const note of notes) console.log(`NOTE ${note}`);
for (const warning of warnings) console.log(`WARN ${warning}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? '\nPASS bundle-whitelist' : `\nFAIL bundle-whitelist（${failures.length} 项）`);
process.exitCode = failures.length === 0 ? 0 : 1;
