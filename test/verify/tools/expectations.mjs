/**
 * 复核用「官方事实」冻结表（T5）。每条都带可复现证据；改动必须同步证据。
 *
 * 注意版本分野（2026-09-29 16:58 更正）：
 * - 运行中的 GUI = 桌面端内置 **0.2.0-rc.1**，代码在 `E:\DSH\resources\app.asar`（未压缩，可按 latin1 直读）。
 * - npm 上的 dist-tag：`latest = 0.1.7-rc.2`、**`next = 0.2.0-rc.1`**（`npm view @deepseek-ai/dsh dist-tags` 实测）。
 *   → 早先"0.2.0-rc.1 未发布到 npm"的说法**不成立**，已更正；本机全局 CLI 亦已是 0.2.0-rc.1。
 * - profile 参照树 `D:\DSH\dsh-home\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
 *   **在本次会话期间已从 0.1.7-rc.2 升到 0.2.0-rc.1**（其 `dsh-web-frontend` 前端资源已从
 *   `index-Q6zc2uHV.js` 变为 `index-Dy0OhsZ5.js`，与 asar 内同名同大小 631135 字节）。
 *   因此该树**不再**是"低版本参照"，而是**另一套安装的同版本交叉验证源**；
 *   凡涉及运行中宿主行为的结论仍以 asar 为准。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

export const ASAR_PATH = 'E:/DSH/resources/app.asar';
export const NPM_DSH_PACKAGES = 'D:/DSH/dsh-home/profiles/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
export const NPM_FRONTEND_DIR = `${NPM_DSH_PACKAGES}/dsh-web-frontend/dist/assets`;

/**
 * **动态读取运行中 asar 的版本与前端资源名**（不得硬编码版本号或 hash）。
 *
 * 起因：本会话里运行中的宿主从 **0.2.0-rc.1 自动升级到 0.2.0-rc.2**，
 * 前端资源也从 `index-Dy0OhsZ5.js` 变成 `index-5SrrfWpU.js`；
 * 任何把版本号/文件名写死的断言都会在升级后要么误报、要么静默降级。
 * @returns 版本信息，或 `undefined`（asar 不存在时）。
 */
export function asarVersionInfo() {
	if (!existsSync(ASAR_PATH)) return undefined;
	const source = readFileSync(ASAR_PATH).toString('latin1');
	const versionMatch = source.match(/"@deepseek-ai\/dsh-desktop-runtime"[\s\S]{0,240}?"version":\s*"([^"]+)"/);
	const assetMatch = source.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
	return {
		asarPath: ASAR_PATH,
		version: versionMatch?.[1] ?? 'unknown',
		asset: assetMatch?.[1] ?? undefined,
		mtimeIso: statSync(ASAR_PATH).mtime.toISOString()
	};
}

/**
 * **动态发现**参照树的前端 index bundle（不要硬编码 hash：本会话里该文件名已变过一次，
 * 硬编码会让检查静默降级成"未覆盖"）。
 * @returns 发现的文件信息，或 `undefined`（目录/文件缺失时）。
 */
export function discoverNpmFrontend() {
	if (!existsSync(NPM_FRONTEND_DIR)) return undefined;
	const files = readdirSync(NPM_FRONTEND_DIR);
	const index = files.find((name) => /^index-.*\.js$/.test(name));
	const css = files.find((name) => /^index-.*\.css$/.test(name));
	if (index === undefined) return undefined;
	const packageJson = `${NPM_DSH_PACKAGES}/dsh-web-frontend/package.json`;
	const version = existsSync(packageJson)
		? (JSON.parse(readFileSync(packageJson, 'utf8')).version ?? 'unknown')
		: 'unknown';
	return { directory: NPM_FRONTEND_DIR, index, css, version, path: `${NPM_FRONTEND_DIR}/${index}` };
}

/**
 * 客户端 bundle 可直接 require 的静态基座（`PLATFORM_MODULES`）。
 * 证据（0.2.0-rc.1，运行中 GUI）：asar 内 `index-Dy0OhsZ5.js` 中的种子表
 * `function QS(){return{react:bf,"react/jsx-runtime":Lf,"react-dom":Pf,"react-dom/client":zf,
 * "@deepseek-ai/cordis":of,"@deepseek-ai/dsh-client-store":sh,"@deepseek-ai/dsh-client-ui-slots":fh,
 * "@deepseek-ai/dsh-client-ui-primitives":eE,"@deepseek-ai/dsh-client-ui-dockkit":ZS}}`
 * 复核脚本：`test/verify/platform-modules-check.mjs`。
 */
export const PLATFORM_MODULES = [
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/cordis',
	'@deepseek-ai/dsh-client-store',
	'@deepseek-ai/dsh-client-ui-slots',
	'@deepseek-ai/dsh-client-ui-primitives',
	'@deepseek-ai/dsh-client-ui-dockkit'
];

/**
 * `settings.section` 官方占用者（0.2.0-rc.1 asar 内的注册调用）。
 * 证据：asar 内可见
 * `id: "account", order: -10`（仅在已登录时注册）、`id: "general", order: 0`、
 * `id: "models", order: 10`、`id: "plugins", order: 15`、`id: "agent-presets", order: 20`。
 * 复核脚本：`test/verify/contract-consistency.mjs`。
 */
export const OFFICIAL_SETTINGS_SECTIONS = [
	{ id: 'account', order: -10 },
	{ id: 'general', order: 0 },
	{ id: 'models', order: 10 },
	{ id: 'plugins', order: 15 },
	{ id: 'agent-presets', order: 20 }
];

/**
 * 官方**不存在**「DSH 自身会话存储/归档集合的删除接口」时，用于反证的检索词。
 * 复核脚本 `test/verify/facts-check.mjs` 会在 0.2.0-rc.1 asar 与 npm 0.1.7 的 `*.d.ts` 上重跑。
 *
 * 已知反例（必须在报告里写清楚，不能笼统说「完全不存在」）：
 * - asar 内 `deleteSession` 命中 **Agent 协议**桥接（`AGENT_METHODS.session_delete === "session/delete"`，
 *   由外部 agent 的 `sessionCapabilities.delete` 能力门控）——它删的是 agent 自己 `session/list` 里的会话，
 *   不是 DSH 宿主的工作区/转录存储；
 * - asar 内 `_deleteSession`（下划线私有）命中 sqlite 搜索索引 `session-query-sqlite` 的索引行删除。
 * - `removeSession` / `purgeSession` / `unarchive-sessions`：两个版本均 0 命中。
 */
export const DELETE_API_PATTERNS = ['deleteSession', 'removeSession', 'purgeSession'];
