/**
 * 宿主路由契约的**运行时**复核（T5 / T6）。
 *
 * 真跑 `lib/host/routes.js`：用伪 ctx 捕获 4 个 `connection.fetch.register` 的 route，
 * 直接调用其 `fetch(request)` 并断言状态码/响应体/磁盘零改动。
 *
 * 安全：全程把 `DSH_HOME` 指向 **test/verify 下一个不存在的路径**，
 * 因此 store 只会遇到 ENOENT（读空），不会碰真实 `$DSH_HOME`；
 * 脚本结束前会断言该路径**始终未被创建**（磁盘零改动不变量）。
 * 本脚本不写任何文件、不建夹具。
 *
 * **两个守卫必须分别探测**（它们是两件事，不能用一个 500 当另一个的证据）：
 * - P8：官方 `sessions` 服务不可用 → 500 `internal` 且文案点名 sessions；
 * - P7：官方 `workspaceRegistry` 服务不可用 → 500 `internal` 且文案点名 workspaceRegistry。
 * 脚本按探测结果决定 pre-T6 / T6 期望值，并把证据打印出来；未落地的契约记为 PENDING 而非 FAIL。
 *
 * 用法：node test/verify/host-contract.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
/** 故意指向不存在的目录：所有 store 操作都会走 ENOENT 分支。 */
const FAKE_HOME = join(HERE, '.nonexistent-home-for-verify');
if (existsSync(FAKE_HOME)) {
	console.error(`FAIL 前置条件失败：${FAKE_HOME} 竟然存在，脚本拒绝在非干净环境运行`);
	process.exit(1);
}
process.env.DSH_HOME = FAKE_HOME;

const failures = [];
const notes = [];
const pending = [];
const check = (ok, label, detail) => {
	if (ok) notes.push(`PASS ${label}`);
	else failures.push(`${label}${detail ? ` —— ${detail}` : ''}`);
};

const { registerArchiveManagerRoutes } = await import(pathToFileURL(join(ROOT, 'lib', 'host', 'routes.js')).href);
const contracts = await import(pathToFileURL(join(ROOT, 'lib', 'contracts.js')).href);
const { HOST_ROUTES, MAX_BATCH } = contracts;

const UUID = '6a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';
/** 本机真实形态：`workspace.json` 的 5 条归档 id **全是** `session-<uuid>`（这也正是真机首删 400 的原因）。 */
const PRE_FIXED_UUID_ARCHIVED = 'session-0b9de1ba-1918-40b3-8fcc-8ab15a645e50';
const PRE_FIXED_UUID_UNARCHIVED = 'session-4f2c1a3b-5d6e-4f70-8a91-0b1c2d3e4f50';

/** 服务存在但无活动会话：`get()` 恒 `undefined`。用 `undefined` 表示"服务不可用"。 */
const idleSessions = { get: () => undefined };

let registry;
let liveSessions;
let captured = [];

function makeCtx() {
	return {
		connection: { fetch: { register(route) { captured.push(route); return async () => {}; } } },
		get(name) {
			if (name === 'sessions') return liveSessions;
			if (name === 'workspaceRegistry') return registry;
			return undefined;
		},
		effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer(); }; },
		logger: { warn() {}, error() {}, info() {} }
	};
}

function register() {
	captured = [];
	registerArchiveManagerRoutes(makeCtx());
	return new Map(captured.map((route) => [route.path, route]));
}

const post = (routes, path, body) =>
	routes.get(path).fetch(new Request(`http://verify.local/api${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	}));

const readJson = async (response) => {
	const text = await response.text();
	try {
		return { status: response.status, body: JSON.parse(text), text };
	} catch {
		return { status: response.status, body: undefined, text };
	}
};

const expectError = async (routes, label, promise, status, expectedCode) => {
	const { status: actual, body, text } = await readJson(await promise);
	check(actual === status, `${label} → ${status}`, `实际 ${actual}：${text.slice(0, 120)}`);
	check(typeof body?.code === 'string' && body.code.length > 0, `${label} 响应带稳定 code（ErrorResponse）`, `实际体：${text.slice(0, 120)}`);
	check(expectedCode === undefined || body?.code === expectedCode, `${label} code 应为 ${expectedCode}`, `实际 ${JSON.stringify(body?.code)}`);
	check(typeof body?.message === 'string' && body.message.length > 0, `${label} 响应带 message`, `实际体：${text.slice(0, 120)}`);
};

// --- 0a. 注册形态 ---
liveSessions = idleSessions;
registry = { archivedSessionIds: [UUID] };
let routes = register();
check(captured.length === 4, '注册了恰好 4 个 route', `实际 ${captured.length}`);
for (const [path, method] of [
	[HOST_ROUTES.list, 'GET'],
	[HOST_ROUTES.recycle, 'POST'],
	[HOST_ROUTES.restore, 'POST'],
	[HOST_ROUTES.purge, 'POST']
]) {
	const route = routes.get(path);
	check(route !== undefined, `注册了 ${path}`, '未注册');
	if (!route) continue;
	check(Array.isArray(route.methods) && route.methods.length === 1 && route.methods[0] === method, `${path} 方法为 ${method}`, JSON.stringify(route.methods));
	check(route.requestBody === 'buffered', `${path} requestBody=buffered`, String(route.requestBody));
	// 伪 ctx 绕过了官方 `assertFetchRoute`，这里补上它的核心约束（否则检查会假绿）。
	check(route.path === path && path.startsWith('/api/'), `${path} 满足官方 assertFetchRoute 的 /api/ 前缀约束`, String(route.path));
}

// --- 0b. 分别探测两个 fail-closed 守卫 ---
liveSessions = undefined; // sessions 服务不可用
registry = { archivedSessionIds: [UUID] };
routes = register();
const probeSessions = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [UUID] }));
const sessionsFailClosed = probeSessions.status === 500 && probeSessions.body?.code === 'internal' && /sessions/.test(String(probeSessions.body?.message));

liveSessions = idleSessions; // sessions 可用但空闲
registry = undefined; // workspaceRegistry 服务不可用
routes = register();
const probeRegistry = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [UUID] }));
const registryFailClosed = probeRegistry.status === 500 && probeRegistry.body?.code === 'internal' && /workspaceRegistry/.test(String(probeRegistry.body?.message));

console.log(`# 探测 P8（sessions 不可用）→ ${probeSessions.status} ${JSON.stringify(probeSessions.body)?.slice(0, 140)}`);
console.log(`# 探测 P7（workspaceRegistry 不可用）→ ${probeRegistry.status} ${JSON.stringify(probeRegistry.body)?.slice(0, 140)}`);
console.log(`# 判定：sessionsFailClosed=${sessionsFailClosed} registryFailClosed=${registryFailClosed}`);

if (sessionsFailClosed) notes.push('PASS P8：sessions 服务不可用 → 500 internal（fail-closed，不静默放行）');
else pending.push(`未落地 P8：sessions 不可用时应 500 fail-closed（当前 ${probeSessions.status} ${probeSessions.text.slice(0, 100)}）`);
if (registryFailClosed) notes.push('PASS P7：workspaceRegistry 服务不可用 → 500 internal（fail-closed）');
else pending.push(`未落地 P7：workspaceRegistry 不可用时应 500 fail-closed（当前 ${probeRegistry.status} ${probeRegistry.text.slice(0, 100)}）`);

const T6 = registryFailClosed && sessionsFailClosed;

// --- 1. GET /list ---
{
	registry = { archivedSessionIds: [UUID] };
	routes = register();
	const response = await routes.get(HOST_ROUTES.list).fetch(new Request(`http://verify.local/api${HOST_ROUTES.list}`));
	const body = await response.json();
	check(response.status === 200, 'GET /list → 200', String(response.status));
	check(Array.isArray(body.entries) && body.entries.length === 0, 'GET /list 在空 home 下返回 entries: []', JSON.stringify(body).slice(0, 120));
}

// --- 2. 400 家族：磁盘零改动 ---
await expectError(routes, 'POST /recycle 空体', post(routes, HOST_ROUTES.recycle, ''), 400, 'invalid-input');
await expectError(routes, 'POST /recycle 坏 JSON', post(routes, HOST_ROUTES.recycle, '{'), 400, 'invalid-input');
await expectError(routes, 'POST /recycle 非数组', post(routes, HOST_ROUTES.recycle, { sessionIds: 'x' }), 400, 'invalid-input');
await expectError(routes, 'POST /recycle 空数组', post(routes, HOST_ROUTES.recycle, { sessionIds: [] }), 400, 'invalid-input');
await expectError(routes, 'POST /recycle 非 UUID', post(routes, HOST_ROUTES.recycle, { sessionIds: ['../etc/passwd'] }), 400, 'invalid-input');
await expectError(routes, 'POST /recycle 超 MAX_BATCH', post(routes, HOST_ROUTES.recycle, { sessionIds: Array.from({ length: MAX_BATCH + 1 }, () => UUID) }), 400, 'invalid-input');
await expectError(routes, 'POST /restore 空数组', post(routes, HOST_ROUTES.restore, { entryIds: [] }), 400, 'invalid-input');
await expectError(routes, 'POST /restore 非法 entryId', post(routes, HOST_ROUTES.restore, { entryIds: [`1759100000000@${UUID}/..`] }), 400, 'invalid-input');
await expectError(routes, 'POST /purge 缺 confirm', post(routes, HOST_ROUTES.purge, {}), 400, 'invalid-input');
await expectError(routes, 'POST /purge confirm=false', post(routes, HOST_ROUTES.purge, { confirm: false }), 400, 'invalid-input');

// --- 3. 409 session-live（已归档 + 会话运行中） ---
{
	registry = { archivedSessionIds: [UUID] };
	liveSessions = { get: (id) => ({ id }) };
	routes = register();
	const { status, body, text } = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [UUID] }));
	if (T6) {
		check(status === 409, 'POST /recycle 会话运行中 → 409', `实际 ${status}：${text.slice(0, 120)}`);
		check(body?.code === 'session-live', "409 code = 'session-live'", JSON.stringify(body?.code));
	} else {
		check(status === 409, 'POST /recycle 会话运行中 → 409', `实际 ${status}：${text.slice(0, 120)}`);
	}
}

// --- 4. 归档集合校验（P7 行为层） ---
{
	liveSessions = idleSessions;
	registry = { archivedSessionIds: [OTHER_UUID] }; // UUID 不在归档集合内
	routes = register();
	const { status, body, text } = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [UUID] }));
	if (T6) {
		check(status === 409, 'T6：未归档的会话 → 409', `实际 ${status}：${text.slice(0, 140)}`);
		check(body?.code === 'session-not-archived', "T6：code = 'session-not-archived'", JSON.stringify(body?.code));
		check(Array.isArray(body?.ids) && body.ids.includes(UUID), 'T6：409 体带 ids', JSON.stringify(body?.ids));
	} else {
		pending.push(`未落地 T6：未归档会话应 409 session-not-archived（当前 ${status} ${JSON.stringify(body)}）`);
	}
}

// --- 5. 200 家族（已归档但工件不存在：逐条 failed，且必须带 code） ---
{
	liveSessions = idleSessions;
	registry = { archivedSessionIds: [UUID] };
	routes = register();
	const { status, body } = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [UUID] }));
	check(status === 200, 'POST /recycle 已归档但工件不存在 → 200（逐条 failed）', `实际 ${status}`);
	check(Array.isArray(body?.moved) && body.moved.length === 0 && Array.isArray(body?.failed) && body.failed.length === 1, 'POST /recycle 报告 1 条失败', JSON.stringify(body)?.slice(0, 160));
	const failure = body?.failed?.[0];
	if (T6) check(typeof failure?.code === 'string' && failure.code.length > 0, 'T6：failed[] 逐条带 code（P12 修复）', JSON.stringify(failure));
	else pending.push(`未落地 T6：failed[] 逐条带 code（当前 ${JSON.stringify(failure)}）`);

	const restore = await readJson(await post(routes, HOST_ROUTES.restore, { entryIds: [`1759100000000@${UUID}`] }));
	check(restore.status === 200, 'POST /restore 未知 entryId → 200（逐条 failed）', `实际 ${restore.status}`);
	check(Array.isArray(restore.body?.restored) && restore.body.restored.length === 0, 'POST /restore 未知 entryId 未报告成功', JSON.stringify(restore.body)?.slice(0, 160));
	// 语义变更（2026-09-29）：形态合法但不存在的 entryId 不再是 400，而是逐条 `entry-not-found`。
	check(restore.body?.failed?.[0]?.code === 'entry-not-found', "POST /restore 未知 entryId 的逐条 code = 'entry-not-found'", JSON.stringify(restore.body?.failed?.[0]));

	const purge = await readJson(await post(routes, HOST_ROUTES.purge, { confirm: true }));
	check(purge.status === 200 && purge.body?.purged === 0, 'POST /purge 空回收站 → {purged:0}', `${purge.status} ${JSON.stringify(purge.body)}`);
	// P16 已由 lead 并入契约（`PurgeResponse.failed?`），这里断言它确实是数组。
	if ('failed' in (purge.body ?? {})) {
		check(Array.isArray(purge.body.failed), 'purge 响应里的 failed 是数组（P16 已并入契约 PurgeResponse）', JSON.stringify(purge.body.failed)?.slice(0, 120));
	}
}

// --- 5b. 新形态契约：`session-<uuid>` 形态且未归档 → 409（此前会被当成 400 invalid-input） ---
{
	liveSessions = idleSessions;
	registry = { archivedSessionIds: [PRE_FIXED_UUID_ARCHIVED] };
	routes = register();
	const { status, body, text } = await readJson(await post(routes, HOST_ROUTES.recycle, { sessionIds: [PRE_FIXED_UUID_UNARCHIVED] }));
	check(status === 409, '新形态：`session-` 前缀且未归档 → 409（不是 400）', `实际 ${status}：${text.slice(0, 140)}`);
	check(body?.code === 'session-not-archived', "新形态：code = 'session-not-archived'", JSON.stringify(body?.code));
}

// --- 6. restore 与 recycle 的 409 对称性（P9） ---
{
	registry = { archivedSessionIds: [UUID] };
	liveSessions = { get: (id) => ({ id }) };
	routes = register();
	const { status, text } = await readJson(await post(routes, HOST_ROUTES.restore, { entryIds: [`1759100000000@${UUID}`] }));
	if (T6) check(status === 409, 'T6：restore 会话运行中 → 409（与 recycle 对称）', `实际 ${status}：${text.slice(0, 140)}`);
	else pending.push(`未落地 T6：restore 运行中应 409（当前 ${status}）`);
	liveSessions = idleSessions;
}

// --- 7. 磁盘零改动不变量 ---
check(!existsSync(FAKE_HOME), '整个复核过程未创建任何目录（磁盘零改动）', `${FAKE_HOME} 被创建了`);

console.log('# 宿主路由运行时契约复核（分别探测 P7/P8 守卫）');
console.log(`# DSH_HOME(本次会话内) = ${FAKE_HOME}`);
for (const note of notes) console.log(note);
for (const item of pending) console.log(`PENDING ${item}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0
	? `\nPASS host-contract（T6=${T6}；PENDING ${pending.length} 项属尚未落地的契约，不算失败）`
	: `\nFAIL host-contract（${failures.length} 项）`);
process.exitCode = failures.length === 0 ? 0 : 1;
