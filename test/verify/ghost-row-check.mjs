/**
 * A5「幽灵行」判据检查（只读，**用户可复核**）。
 *
 * 判据（lead 裁决）：
 * > 幽灵行 = { id ∈ `workspace.json.global.archivedSessionIds` ：该 id 的工件**不在** `$DSH_HOME/sessions/<slug>/` 下
 * >            **且** 该 id **未被** `list()` 上报 } → 必须为 0。
 *
 * ⚠️ 判据易错点：**"无摘要"不是幽灵行**。归档会话在官方侧本来就可能没有摘要（`byId` 里没有该行），
 * 那只是 UI 显示「摘要缺失」；幽灵行的充要条件是「**工件缺失 ∧ 未上报**」——此时客户端
 * `recycledIds`（唯一真源 = `/list`）过滤不掉它，刷新后该行会回来且永远无法恢复。
 *
 * 只读保证：本脚本只调用 `lib/host/recycle-store.js` 的 `list()`（纯读目录/读文件），
 * **绝不**调用 `recycle` / `restore` / `purge`，不写盘、不移文件、不创建任何目录。
 *
 * 退出码：0 = PASS（幽灵行 0 条）；1 = FAIL（有幽灵行）；2 = SKIP（取不到证据：无 $DSH_HOME /
 * workspace.json / list() 不可用）——SKIP 绝不等于 PASS。
 *
 * 用法：node test/verify/ghost-row-check.mjs
 *       （可用 DSH_HOME 覆盖 home 目录）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const HOME = process.env.DSH_HOME ?? 'D:\\DSH\\dsh-home';
const SESSIONS_ROOT = join(HOME, 'sessions');
const WORKSPACE_JSON = join(HOME, 'storages', 'workspace.json');

const lines = [];
const say = (text) => lines.push(text);

function skip(reason) {
	say('# 幽灵行检查（A5 判据）');
	say(`# HOME = ${HOME}`);
	say(`SKIP ${reason}`);
	say('# 说明：取不到证据一律 SKIP，绝不当作 PASS（见 REPORT §2 规则 6/8）。');
	console.log(lines.join('\n'));
	process.exit(2);
}

if (!existsSync(WORKSPACE_JSON)) skip(`找不到 ${WORKSPACE_JSON}（本判据只在真实 profile 上有意义）`);
if (!existsSync(SESSIONS_ROOT)) skip(`找不到 ${SESSIONS_ROOT}`);

let state;
try {
	state = JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8'));
} catch (error) {
	skip(`workspace.json 解析失败：${error.message}`);
}
const archived = state?.global?.archivedSessionIds;
if (!Array.isArray(archived)) skip('workspace.json 里没有 global.archivedSessionIds 数组');

let reported;
try {
	const { createRecycleStore } = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'recycle-store.js')).href);
	reported = await createRecycleStore({ homeDir: HOME }).list();
} catch (error) {
	skip(`list() 不可用：${error.message}`);
}
const reportedIds = new Set(reported.map((entry) => entry.sessionId));

/** 工件是否在 `sessions/<slug>/<sessionId>` 下（只读）。 */
function artifactPresent(sessionId) {
	let slugs;
	try {
		slugs = readdirSync(SESSIONS_ROOT, { withFileTypes: true });
	} catch {
		return undefined; // 读不到 = 证据不足
	}
	for (const slug of slugs) {
		if (!slug.isDirectory()) continue;
		try {
			if (statSync(join(SESSIONS_ROOT, slug.name, sessionId)).isDirectory()) return true;
		} catch {
			/* 继续找 */
		}
	}
	return false;
}

say('# 幽灵行检查（A5 判据）');
say(`# HOME = ${HOME}`);
say(`# list() 上报条数 = ${reported.length}`);
say('# 归档 id 明细：');
const ghosts = [];
let indeterminate = 0;
for (const sessionId of archived) {
	const present = artifactPresent(sessionId);
	if (present === undefined) {
		indeterminate += 1;
		say(`#   ${sessionId}   工件:读不到   list 上报:${reportedIds.has(sessionId)}   → 证据不足`);
		continue;
	}
	const inList = reportedIds.has(sessionId);
	const ghost = !present && !inList;
	if (ghost) ghosts.push(sessionId);
	say(`#   ${sessionId}   工件:${present ? '在 sessions' : '缺失'}   list 上报:${inList ? 'true ' : 'false'}   → ${ghost ? '★幽灵行' : '合法'}`);
}
say(`# 幽灵行 = ${ghosts.length} 条${ghosts.length > 0 ? `：${ghosts.join(', ')}` : ''}`);
if (indeterminate > 0) say(`# 注意：有 ${indeterminate} 条因工件状态读不到而无法判定`);

if (indeterminate > 0 && ghosts.length === 0) {
	say('SKIP 存在无法判定的归档 id（证据不足），不判定为 PASS');
	console.log(lines.join('\n'));
	process.exit(2);
}

if (ghosts.length === 0) {
	say('PASS ghost-row-check（幽灵行 = 0）');
	console.log(lines.join('\n'));
	process.exit(0);
}
say(`FAIL ghost-row-check（幽灵行 ${ghosts.length} 条：${ghosts.join(', ')}）`);
say('# 含义：这些 id 的工件已被移走、但 /list 不上报 → 客户端过滤不掉 → 刷新后出现「摘要缺失」幽灵行。');
console.log(lines.join('\n'));
process.exit(1);
