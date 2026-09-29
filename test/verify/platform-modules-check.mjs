/**
 * `PLATFORM_MODULES` 基座表核验（T5 独立复核）。
 *
 * 结论对象：客户端 bundle 只允许 require 基座表里的模块（其余必须走清单声明）。
 * 因此「基座表到底是哪 9 个键」必须是**可复现地从真实产物解析出来的**，
 * 而不是抄文档。
 *
 * 证据来源（两个都查，并互相比较）：
 * - 运行中 GUI：`E:\DSH\resources\app.asar` 内 `@deepseek-ai/dsh-web-frontend@0.2.0-rc.1`
 *   的 `dist/assets/index-Dy0OhsZ5.js`（注意：PLAN.md 10.1 引用的 `index-Q6zc2uHV.js`
 *   其实在 npm 0.1.7 安装里，见下方 npm 证据）。
 * - npm 全局 CLI 0.1.7-rc.2：`dsh-web-frontend/dist/assets/index-Q6zc2uHV.js`。
 *
 * 解析方式：asar / js 都是纯文本，用 `"react/jsx-runtime":` 作锚点向前找最近的
 * `return{`，再做花括号配平，取出种子表对象字面量并提取键。
 * 解析失败一律报告「未覆盖」，绝不因为解析不到就默认通过。
 *
 * 只读。
 * 用法：node test/verify/platform-modules-check.mjs [--asar <path>] [--npm <path>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { ASAR_PATH, NPM_FRONTEND_DIR, PLATFORM_MODULES as DECLARED, discoverNpmFrontend } from './tools/expectations.mjs';

const args = process.argv.slice(2);
function argOf(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ASAR = argOf('--asar', ASAR_PATH);
/** 动态发现参照树的前端 bundle（**不硬编码 hash**：本会话内该文件名已从 Q6zc2uHV 变为 Dy0OhsZ5）。 */
const npmFrontend = discoverNpmFrontend();
const NPM_FRONTEND = argOf('--npm', npmFrontend?.path ?? '');

/** 从一段文本里抽「react/jsx-runtime 所在的种子表对象」的键。 */
function extractSeedKeys(source) {
	const anchor = source.indexOf('"react/jsx-runtime":');
	if (anchor < 0) return { keys: null, reason: '锚点 "react/jsx-runtime": 未找到' };
	const returnIndex = source.lastIndexOf('return{', anchor);
	if (returnIndex < 0) return { keys: null, reason: '锚点之前找不到 return{' };
	const open = returnIndex + 'return'.length;
	let depth = 0;
	let end = -1;
	const limit = Math.min(source.length, open + 4000);
	for (let i = open; i < limit; i += 1) {
		const ch = source[i];
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return { keys: null, reason: '花括号未配平（窗口 4000 字符内）' };
	const literal = source.slice(open + 1, end);
	const keys = [];
	const re = /(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:/g;
	let match;
	while ((match = re.exec(literal)) !== null) keys.push(match[1] ?? match[2]);
	return { keys, literal };
}

const reports = [];
let failed = false;

function compare(label, keys, evidence) {
	if (keys === null) {
		reports.push(`未覆盖 ${label}：${evidence.reason}`);
		failed = true;
		return;
	}
	const missing = DECLARED.filter((k) => !keys.includes(k));
	const extra = keys.filter((k) => !DECLARED.includes(k));
	const same = missing.length === 0 && extra.length === 0;
	reports.push(
		`${same ? 'PASS' : 'FAIL'} ${label}（${keys.length} 键）` +
			(same ? ` == DECLARED(${DECLARED.length})` : `\n    missing=${JSON.stringify(missing)}\n    extra=${JSON.stringify(extra)}`) +
			`\n    证据：${evidence.source}\n    字面量：${evidence.literal}`
	);
	if (!same) failed = true;
}

// --- 运行中的 GUI（0.2.0-rc.1）---
if (!existsSync(ASAR)) {
	reports.push(`未覆盖 运行中 GUI 基座表：asar 不存在 ${ASAR}`);
	failed = true;
} else {
	const source = readFileSync(ASAR).toString('latin1');
	const version = source.includes('"version": "0.2.0-rc.1"');
	const asset = source.includes('assets/index-Dy0OhsZ5.js');
	const assetCited = source.includes('assets/index-Q6zc2uHV.js');
	reports.push(`INFO asar 版本串 0.2.0-rc.1=${version}；真实前端资源 index-Dy0OhsZ5.js=${asset}；PLAN 引用的 index-Q6zc2uHV.js=${assetCited}`);
	const { keys, reason, literal } = extractSeedKeys(source);
	compare('运行中 GUI 基座表', keys ?? null, { reason, literal: (literal ?? '').slice(0, 400), source: `${ASAR}（latin1 解析）` });
}

// --- 参照树前端（本次会话期间已升到 0.2.0-rc.1；与 asar 是**两套安装**的同版本交叉验证）---
if (!existsSync(NPM_FRONTEND)) {
	reports.push(`未覆盖 参照树基座表：在 ${NPM_FRONTEND_DIR} 未发现 index-*.js（硬编码 hash 已失效过一次，故本脚本改为动态发现）`);
	failed = true;
} else {
	const source = readFileSync(NPM_FRONTEND, 'utf8');
	const { keys, reason, literal } = extractSeedKeys(source);
	compare(
		`参照树基座表（dsh-web-frontend@${npmFrontend?.version ?? 'unknown'}，${npmFrontend?.index ?? '?'}）`,
		keys ?? null,
		{ reason, literal: (literal ?? '').slice(0, 400), source: NPM_FRONTEND }
	);
}

console.log(`# 声明的基座表（DECLARED，${DECLARED.length} 键）：${DECLARED.join(', ')}`);
for (const line of reports) console.log(`\n${line}`);
console.log(`\n${failed ? 'FAIL' : 'PASS'} platform-modules-check`);
process.exitCode = failed ? 1 : 0;
