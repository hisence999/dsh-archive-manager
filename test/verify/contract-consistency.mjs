/**
 * 契约一致性校验（T5 独立复核）。
 *
 * 覆盖四项：
 * 1. **设置页注册**：真跑 `lib/client.js`（伪 ctx 捕获 `ctx.slots.register` 实参），
 *    断言 `id`/`order` 与 `lib/contracts.js` 的常量逐字相同，且不与官方占用者撞 id。
 * 2. **宿主路由**：4 条路径必须来自共享常量 `HOST_ROUTES`，源码与产物里都不允许出现硬编码路由串。
 * 3. **客户端调用侧**：浏览器必须以 `CLIENT_API_PREFIX + HOST_ROUTES.x` 组 URL（T2 未交付时为未覆盖）。
 * 4. **PLAN.md 漂移**：计划文档里的路径/字段与冻结契约不一致时给出 WARN（文档漂移不算红线，但必须可见）。
 *
 * 只读。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { OFFICIAL_SETTINGS_SECTIONS } from './tools/expectations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const failures = [];
const warnings = [];
const notes = [];

/**
 * 剥掉注释（字符串内容保留），用于「**代码里**不许出现硬编码 URL / 路由串」这类检查。
 * 起因：`src/client/ArchivedSessionsSection.tsx` 的文件头注释里写了
 * `/api/dsh-archive-manager/recycle`，未剥注释时会被误判成硬编码 —— 与 redline-scan 同一类自命中。
 */
function stripComments(text) {
	const out = text.split('');
	let state = 'code';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (state === 'code') {
			if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'line'; i += 2; continue; }
			if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; state = 'block'; i += 2; continue; }
			if (ch === "'") state = 'sq';
			else if (ch === '"') state = 'dq';
			else if (ch === '`') state = 'tpl';
			i += 1;
			continue;
		}
		if (state === 'line') { if (ch === '\n') state = 'code'; else out[i] = ' '; i += 1; continue; }
		if (state === 'block') {
			if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
			if (ch !== '\n') out[i] = ' ';
			i += 1;
			continue;
		}
		if (ch === '\\') { i += 2; continue; }
		if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) state = 'code';
		i += 1;
	}
	return out.join('');
}

const contracts = await import(pathToFileURL(join(ROOT, 'lib', 'contracts.js')).href);
const { HOST_ROUTES, CLIENT_API_PREFIX, SETTINGS_SECTION_ID, SETTINGS_SECTION_ORDER, MAX_BATCH, entryIdFor, isSessionId, parseSessionIds, parseEntryId } = contracts;

// --- 1. 设置页注册（运行时真跑 bundle）---
const bundleSource = read('lib/client.js');
const requested = [];
let entry;
globalThis.window = { __ModuleLoader__: { load(value) { entry = value; } } };
try {
	new Function('require', `with (window) { ${bundleSource} }`)((id) => {
		requested.push(id);
		return {};
	});
} finally {
	delete globalThis.window;
}

const registrations = [];
if (!entry) {
	failures.push('lib/client.js 未注册 ModuleLoader 信封');
} else {
	const plugin = entry.factory((id) => ({ id }));
	if (typeof plugin.apply !== 'function') failures.push('客户端插件未导出 apply');
	else {
		const fakeCtx = {
			slots: {
				inject(name, contribute) {
					if (name !== 'settings.section') failures.push(`客户端 inject 了非预期插槽 ${name}`);
					contribute();
					return () => {};
				},
				register(spec, component) {
					registrations.push({ spec, component });
					return () => {};
				}
			},
			locale: { register: () => () => {} },
			// T2 的 registerLocales 通过 ctx.effect 挂 disposer；伪 ctx 必须提供它。
			effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer(); }; },
			logger: { warn() {}, error() {}, info() {} }
		};
		try {
			plugin.apply(fakeCtx);
		} catch (error) {
			failures.push(`apply(ctx) 抛错：${error?.message ?? error}`);
		}
	}
}

const section = registrations.find((r) => r.spec?.name === 'settings.section');
if (!section) {
	failures.push('客户端未注册 settings.section');
} else {
	notes.push(`注册实参：${JSON.stringify({ name: section.spec.name, id: section.spec.id, order: section.spec.order, label: typeof section.spec.label })}`);
	if (section.spec.id !== SETTINGS_SECTION_ID) failures.push(`settings.section id=${JSON.stringify(section.spec.id)} 应为 ${JSON.stringify(SETTINGS_SECTION_ID)}`);
	if (section.spec.order !== SETTINGS_SECTION_ORDER) failures.push(`settings.section order=${JSON.stringify(section.spec.order)} 应为 ${SETTINGS_SECTION_ORDER}`);
	if (typeof section.spec.label !== 'string' && typeof section.spec.label !== 'function') failures.push('settings.section 缺少 label');
	if (typeof section.component !== 'function' && typeof section.component !== 'object') failures.push('settings.section 缺少页面组件');
	const clash = OFFICIAL_SETTINGS_SECTIONS.find((s) => s.id === section.spec.id);
	if (clash) failures.push(`settings.section 复用了官方 id ${clash.id}（会顶替官方页）`);
	const lastOfficial = Math.max(...OFFICIAL_SETTINGS_SECTIONS.map((s) => s.order));
	if (typeof section.spec.order === 'number' && section.spec.order <= lastOfficial) {
		warnings.push(`order=${section.spec.order} 不大于官方最大 order=${lastOfficial}，需确认是否与官方页交错`);
	} else {
		notes.push(`order=${section.spec.order} > 官方最大 ${lastOfficial} → 纯增量追加`);
	}
}

// --- 2. 宿主路由（以**官方校验器**为准，而不是以类型注释的字面理解）---
// 官方依据：`assertFetchRoute` → `endpointFromPath('/api', route.path)` 要求 `path.startsWith('/api/')`；
// 分发用 `fetchRoutes.get(new URL(request.url).pathname)` 做**完整 pathname 精确匹配**，
// 因此注册路径与浏览器请求路径必须是同一个带 `/api` 前缀的字符串。
// 证据：运行中 0.2.0-rc.1 asar byte 18559155（assertFetchRoute）/ 18553666（fetchRoutes.get）；
//       参照版本 0.1.7-rc.2 `dsh-client-connection/lib/index.js:711-716,758-762`。
const routeValues = Object.values(HOST_ROUTES);
for (const key of ['list', 'recycle', 'restore', 'purge']) {
	if (typeof HOST_ROUTES[key] !== 'string') failures.push(`HOST_ROUTES 缺少 ${key}`);
}
if (new Set(routeValues).size !== routeValues.length) failures.push('HOST_ROUTES 存在重复路径');
const SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
for (const path of routeValues) {
	if (!path.startsWith('/api/')) failures.push(`HOST_ROUTES 值必须以 /api/ 开头（否则官方 assertFetchRoute 抛错、插件激活失败）：${path}`);
	const segments = path.split('/').slice(2).filter((segment) => segment.length > 0);
	if (segments.length === 0 || segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
		failures.push(`HOST_ROUTES 路径段不合官方 /^[A-Za-z0-9_$.-]+$/：${path}`);
	}
	if (!path.includes('dsh-archive-manager')) warnings.push(`HOST_ROUTES 路径未包含插件包名，可能与官方路由冲突：${path}`);
}
if (CLIENT_API_PREFIX !== '') {
	failures.push(`CLIENT_API_PREFIX 非空（${JSON.stringify(CLIENT_API_PREFIX)}）而 HOST_ROUTES 已自带 /api/ 前缀 → 拼接会得到 /api/api/...`);
} else {
	notes.push("CLIENT_API_PREFIX=''（过渡别名，恒为空串）；客户端直接 fetch(HOST_ROUTES.x)，规避双重前缀");
}

const hostSources = ['src/host/routes.ts', 'lib/host/routes.js'];
for (const file of hostSources) {
	let text;
	try {
		text = read(file);
	} catch {
		notes.push(`未覆盖 ${file}：文件不存在`);
		continue;
	}
	if (!/HOST_ROUTES/.test(text)) failures.push(`${file} 未引用共享常量 HOST_ROUTES（可能硬编码路由）`);
	// 只看代码，不看注释：文件头注释里出现路径是文档，不是硬编码。
	for (const match of stripComments(text).matchAll(/['"`]\/api\/dsh-archive-manager\/[a-z]+['"`]/g)) {
		failures.push(`${file} 代码里硬编码路由串 ${match[0]}`);
	}
}

// --- 3. 客户端调用侧 ---
// 口径：**整组**客户端文件合起来看。调用点与常量可以在不同文件
// （`postJson` 定义在 useArchivedSessions.ts、`HOST_ROUTES.recycle` 在组件里传入），
// 逐文件要求同时出现二者会误报。
const clientFiles = ['src/client/index.ts', 'src/client/ArchivedSessionsSection.tsx', 'src/client/useArchivedSessions.ts'];
const clientCodes = [];
let clientCallSeen = false;
for (const file of clientFiles) {
	let text;
	try {
		text = read(file);
	} catch {
		continue;
	}
	const code = stripComments(text);
	clientCodes.push({ file, code });
	if (/\b(?:fetch|postJson)\s*[(<]/.test(code)) clientCallSeen = true;
	for (const match of code.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)) {
		failures.push(`${file} 代码里硬编码 URL ${match[1]}`);
	}
}
const clientAll = clientCodes.map((entry) => entry.code).join('\n');
if (clientCallSeen) {
	if (!/HOST_ROUTES/.test(clientAll)) failures.push('客户端发起 HTTP 调用却没有使用共享常量 HOST_ROUTES');
	else notes.push(`客户端调用侧使用共享常量 HOST_ROUTES（覆盖 ${clientCodes.length} 个文件）`);
} else {
	notes.push('未覆盖 客户端调用侧：src/client/** 里暂无 fetch/postJson 调用');
}
// A5 架构守卫（T12）：幽灵行过滤的**唯一真源**必须是 `/list`。
// 若有人在客户端重新引入跨刷新的持久化状态（localStorage/sessionStorage/indexedDB），
// 「刷新后按 /list 重算」这条不变量就被悄悄破坏，且纯函数测试与源码断言都拦不住。
for (const { file, code } of clientCodes) {
	for (const match of code.matchAll(/\b(localStorage|sessionStorage|indexedDB|caches)\b/g)) {
		failures.push(`${file} 使用了持久化/跨刷新存储 ${match[1]} —— A5 要求过滤真源只有 /list（T12）`);
	}
}
notes.push('A5 架构守卫：客户端源码未使用 localStorage/sessionStorage/indexedDB/caches');

// --- 4. PLAN.md 漂移 ---
let plan;
try {
	plan = read('PLAN.md');
} catch {
	plan = null;
}
if (plan === null) {
	notes.push('未覆盖 PLAN.md 漂移检查：读不到 PLAN.md');
} else {
	const planRoutes = new Set();
	for (const match of plan.matchAll(/`(\/api\/dsh-archive-manager\/[a-z]+)`/g)) planRoutes.add(match[1]);
	const missingInPlan = routeValues.filter((r) => !planRoutes.has(r));
	if (missingInPlan.length > 0) warnings.push(`PLAN.md 未列出这些契约路径：${missingInPlan.join(', ')}`);

	const sample = entryIdFor('6a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d', 1759100000000);
	// 接受三种等价写法：真样例、模板 `${movedAtMs}@${sessionId}`、占位 `<movedAtMs>@<sessionId>`。
	// 旧的 `__` 分隔写法才算漂移（P3 已由 lead 修掉）。
	const formatOk =
		plan.includes(sample) ||
		plan.includes('@${sessionId}') ||
		plan.includes('@<sessionId>');
	if (!formatOk) {
		const legacy = plan.match(/`[^`]*\$\{movedAt\}[^`]*__[^`]*`/);
		warnings.push(
			`PLAN.md 的 entryId 写法与冻结契约不一致：契约 entryIdFor() 产出 ${JSON.stringify(sample)}` +
				(legacy ? `，PLAN 里仍是 ${legacy[0]}` : '，PLAN 中未找到等价写法')
		);
	} else {
		notes.push('PLAN.md 的 entryId 写法与冻结契约一致（@ 分隔）');
	}

	const planInjectBlock = plan.match(/"client"\s*:\s*\{[\s\S]{0,400}?\}/);
	if (planInjectBlock) {
		const planModules = [...planInjectBlock[0].matchAll(/@deepseek-ai\/[a-z0-9-]+/g)].map((m) => m[0]);
		const pkg = JSON.parse(read('package.json'));
		const actual = new Set([...(pkg.dsh.client.inject ?? []), ...(pkg.dsh.client.external ?? [])]);
		const onlyInPlan = [...new Set(planModules)].filter((m) => !actual.has(m));
		if (onlyInPlan.length > 0) warnings.push(`PLAN.md 5.1 声明但 package.json 里没有的客户端依赖：${onlyInPlan.join(', ')}`);
	} else {
		notes.push('未覆盖 PLAN.md 5.1 inject 清单比对：未解析到 jsonc 块');
	}
}

// --- 5. 契约纯函数自检（最小）---
// 形态契约自 2026-09-29 起是**安全字符集 + 有界长度**（`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`），
// **不是**"必须是裸 UUID"：真实 `workspace.json` 里既有 `session-<uuid>` 也有裸 UUID。
// 因此这里既要正向接受两种真实形态，也要用**真正带危险字符**的输入做负控。
const uuid = '6a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const prefixed = `session-${uuid}`;
for (const ok of [uuid, prefixed, 'a.b_c-d', 'ABC123']) {
	if (!isSessionId(ok)) failures.push(`isSessionId 应接受形态安全的 id：${ok}`);
}
if (parseSessionIds([uuid, uuid]).length !== 1) failures.push('parseSessionIds 未去重');
if (parseSessionIds([prefixed, uuid, prefixed]).join() !== [prefixed, uuid].join()) failures.push('parseSessionIds 顺序/去重不符合预期');
const badSessionIds = [
	[],
	'x',
	[''],
	['.'],
	['..'],
	['a/b'],
	['a\\b'],
	['a b'],
	['-leading'],
	['.hidden'],
	['a'.repeat(129)],
	['null\u0000byte'],
	Array.from({ length: MAX_BATCH + 1 }, () => uuid)
];
for (const bad of badSessionIds) {
	try {
		parseSessionIds(bad);
		failures.push(`parseSessionIds 接受了非法输入 ${JSON.stringify(bad).slice(0, 60)}`);
	} catch {
		/* 预期拒绝 */
	}
}
const badEntryIds = ['', '..', uuid, `${uuid}/../x`, '1@not a uuid', 'a@b', '@abc', '1@', '1@-lead', '123456789012345678@abc'];
for (const bad of badEntryIds) {
	try {
		parseEntryId(bad);
		failures.push(`parseEntryId 接受了非法输入 ${JSON.stringify(bad)}`);
	} catch {
		/* 预期拒绝 */
	}
}
// 新形态往返：`session-<uuid>` 也必须能生成/解析 entryId
{
	const roundTrip = entryIdFor(prefixed, 1759100000000);
	if (parseEntryId(roundTrip).sessionId !== prefixed) failures.push('entryId 往返失败（session- 前缀形态）');
	notes.push(`entryId 往返样例（新形态）= ${roundTrip}`);
}
notes.push(`MAX_BATCH=${MAX_BATCH}；裸 UUID 样例=${uuid}；前缀形态样例=${prefixed}`);

console.log('# 契约一致性校验');
for (const note of notes) console.log(`NOTE ${note}`);
for (const warning of warnings) console.log(`WARN ${warning}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? '\nPASS contract-consistency（含 WARN 见上）' : `\nFAIL contract-consistency（${failures.length} 项）`);
process.exitCode = failures.length === 0 ? 0 : 1;
