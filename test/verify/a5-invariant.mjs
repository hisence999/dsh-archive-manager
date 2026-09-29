/**
 * A5 不变式检查器（T5 / T13 验收用，**只读**）。
 *
 * 不变式（lead 裁决，PLAN §10.14）：
 * > **任何时候，只要某会话的工件被本插件从 `sessions/` 移走过，`list()` 就必须能上报它。**
 *
 * 为什么需要它：客户端「已归档」列表的幽灵行过滤**完全依赖 `/list`**（T12 的单一直源）。
 * 一旦某条被移走的会话不在 `/list` 里，而它的 id 仍在 `archivedSessionIds`，刷新后就会
 * 以「摘要缺失」幽灵行回归 —— 2026-09-29 17:34:50 的真机清空就复现了这一幕（旧布局把台账一起搬走）。
 *
 * 本脚本做三件事（全部只读；**绝不调用 recycle/restore/purge**）：
 * 1. 从盘上发现「本插件搬过」的会话：`recycle/<entryId>/manifest.json`、
 *    `purged/<批次>/<entryId>/manifest.json`（旧布局）、`purged/<批次>/batch.json` 的 `entries[]`；
 * 2. 用**构建产物** `lib/host/recycle-store.js` 对真实 `$DSH_HOME` 调 `list()`，得到上报集合；
 * 3. 断言：① 每条被搬过的会话都在上报集合里（不变式）；② 上报结果无重复 entryId / sessionId；
 *    ③ 交叉核对：`archivedSessionIds` 里、工件已不在 `sessions/` 且我们有台账的 id，必须被上报
 *    （这正是"幽灵行"的充要条件）。
 *
 * 用法：node test/verify/a5-invariant.mjs
 * 退出码：0 = 不变式成立；1 = 违反（打印每条违规的会话 id 与台账位置）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const HOME = process.env.DSH_HOME ?? 'D:\\DSH\\dsh-home';
const MANAGER_ROOT = join(HOME, 'archive-manager');
const RECYCLE_ROOT = join(MANAGER_ROOT, 'recycle');
const PURGED_ROOT = join(MANAGER_ROOT, 'purged');

const notes = [];
const failures = [];
const check = (ok, label, detail) => {
	if (ok) notes.push(`PASS ${label}`);
	else failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`);
};

/** 安全列目录（不存在/不可读 → 空）。 */
function names(directory) {
	try {
		return readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	} catch {
		return [];
	}
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** 从盘上收集「本插件搬过的会话」：sessionId → 台账位置列表。 */
function collectLedgers() {
	const found = new Map();
	const add = (sessionId, where) => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return;
		if (!found.has(sessionId)) found.set(sessionId, []);
		found.get(sessionId).push(where);
	};
	/** 目录名本身就是 `<movedAtMs>@<sessionId>`（契约 `entryIdFor`）——**不依赖任何 JSON**。 */
	const addFromEntryName = (name, where) => {
		try {
			add(parseEntryId(name).sessionId, `${where}（目录名解析）`);
		} catch {
			/* 不是 entryId 形态的目录：跳过（这里只可能是"目录名不是 entryId"，不是"静默吞错"） */
		}
	};
	// ① 回收站根（新布局：载荷在或已清空但台账留原地）
	for (const entry of names(RECYCLE_ROOT)) {
		if (!entry.isDirectory) continue;
		const manifest = readJson(join(RECYCLE_ROOT, entry.name, 'manifest.json'));
		if (manifest !== undefined) add(manifest.sessionId, `recycle/${entry.name}/manifest.json`);
		addFromEntryName(entry.name, `recycle/${entry.name}`);
	}
	// ② 冷存档：旧布局（台账随载荷一起被搬走）与新布局（只有载荷）
	for (const batch of names(PURGED_ROOT)) {
		if (!batch.isDirectory) continue;
		const batchDirectory = join(PURGED_ROOT, batch.name);
		const batchJson = readJson(join(batchDirectory, 'batch.json'));
		for (const item of Array.isArray(batchJson?.entries) ? batchJson.entries : []) {
			add(item?.sessionId, `purged/${batch.name}/batch.json#entries`);
		}
		for (const entry of names(batchDirectory)) {
			if (!entry.isDirectory) continue;
			const manifest = readJson(join(batchDirectory, entry.name, 'manifest.json'));
			if (manifest !== undefined) add(manifest.sessionId, `purged/${batch.name}/${entry.name}/manifest.json`);
			addFromEntryName(entry.name, `purged/${batch.name}/${entry.name}`);
		}
	}
	return found;
}

/** 读取真实 `archivedSessionIds`（只读 workspace.json）。 */
function readArchivedSessionIds() {
	const file = join(HOME, 'storages', 'workspace.json');
	const state = readJson(file);
	const ids = state?.global?.archivedSessionIds;
	return Array.isArray(ids) ? ids : undefined;
}

/** 工件是否还在 `sessions/<slug>/<sessionId>` 下（只读）。 */
function artifactPresent(sessionId) {
	const sessionsRoot = join(HOME, 'sessions');
	for (const slug of names(sessionsRoot)) {
		if (!slug.isDirectory) continue;
		const candidate = join(sessionsRoot, slug.name, sessionId);
		try {
			if (statSync(candidate).isDirectory()) return true;
		} catch {
			/* 不存在即继续 */
		}
	}
	return false;
}

if (!existsSync(MANAGER_ROOT)) {
	console.error(`未覆盖：找不到 ${MANAGER_ROOT}（本检查器只在真机上运行）`);
	process.exit(2);
}

const { createRecycleStore } = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'recycle-store.js')).href);
const { parseEntryId } = await import(pathToFileURL(join(ROOT, 'lib', 'contracts.js')).href);
const store = createRecycleStore({ homeDir: HOME });
// 只用读接口：list() 仅列目录与读文件，不写盘、不移文件。
const reported = await store.list();
const reportedIds = new Set(reported.map((entry) => entry.sessionId));

const ledgers = collectLedgers();
const archived = readArchivedSessionIds();

notes.push(`HOME=${HOME}`);
notes.push(`台账发现的"被搬过"会话 = ${ledgers.size} 条`);
notes.push(`list() 上报条目 = ${reported.length} 条：${reported.map((e) => e.sessionId).join(', ') || '（空）'}`);

// ① 不变式：每条被搬过的会话都必须被上报
for (const [sessionId, where] of ledgers) {
	check(reportedIds.has(sessionId), `不变式：被搬过的会话 ${sessionId} 必须在 /list 上报`, `台账位置：${where.join(' / ')}`);
}

// ② 去重：上报结果不得重复 entryId / sessionId
{
	const entryIds = reported.map((entry) => entry.entryId);
	const dupEntry = entryIds.filter((id, index) => entryIds.indexOf(id) !== index);
	const sessionIds = reported.map((entry) => entry.sessionId);
	const dupSession = sessionIds.filter((id, index) => sessionIds.indexOf(id) !== index);
	check(dupEntry.length === 0, '上报结果无重复 entryId', JSON.stringify(dupEntry));
	check(dupSession.length === 0, '上报结果无重复 sessionId', JSON.stringify(dupSession));
}

// ③ 幽灵行充要条件：归档集合里、工件已不在 sessions/、且我们有台账 → 必须被上报
if (archived === undefined) {
	notes.push('未覆盖 交叉核对：读不到 archivedSessionIds');
} else {
	for (const sessionId of archived) {
		if (artifactPresent(sessionId)) continue;
		if (!ledgers.has(sessionId)) continue;
		check(reportedIds.has(sessionId), `幽灵行判据：归档 id ${sessionId} 的工件已不在 sessions/，必须被 /list 上报`, `否则客户端刷新后会显示「摘要缺失」幽灵行`);
	}
	const ghostRisk = archived.filter((id) => !artifactPresent(id) && ledgers.has(id) && !reportedIds.has(id));
	check(ghostRisk.length === 0, '不存在"工件已移走但 /list 不上报"的归档 id（幽灵行根因）', JSON.stringify(ghostRisk));
}

for (const note of notes) console.log(`# ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? '\nPASS a5-invariant' : `\nFAIL a5-invariant（${failures.length} 项违反）`);
process.exitCode = failures.length === 0 ? 0 : 1;
