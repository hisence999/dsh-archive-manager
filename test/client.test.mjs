/**
 * 客户端纯逻辑单测（node --test）。
 *
 * 测试对象是**源码**而不是 bundle：用 esbuild 把 `src/client/*.ts` 打成 CJS，
 * 用 `react` 桩求值，因此不依赖 `lib/` 是否已构建，也不受构建顺序影响。
 * （纯函数不触碰 React；`react` 只出现在钩子体内。）
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** React 桩：被测模块只在钩子体内引用 React。 */
const reactStub = {
	useMemo: (factory) => factory(),
	useState: (initial) => [initial, () => undefined]
};

/** 把某个客户端源码模块打成 CJS 并求值，返回其 exports。 */
async function loadModule(relativePath) {
	const result = await build({
		entryPoints: [join(root, relativePath)],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		external: ['react'],
		logLevel: 'silent'
	});
	const loaded = { exports: {} };
	const factory = new Function('require', 'module', 'exports', result.outputFiles[0].text);
	factory((id) => (id === 'react' ? reactStub : {}), loaded, loaded.exports);
	return loaded.exports;
}

const model = await loadModule('src/client/useArchivedSessions.ts');
const locales = await loadModule('src/client/locales.ts');
const bin = await loadModule('src/client/useRecycleBin.ts');

const summary = (overrides = {}) => ({ id: 'x', ...overrides });

test('buildRows：保持宿主顺序、去重、丢掉非字符串，并保留缺摘要的 id', () => {
	const rows = model.buildRows(
		['b', 'a', 'b', '', 42, null, 'c'],
		{
			a: summary({ title: '  Alpha  ', cwd: 'D:\\proj\\a', updatedAt: '2026-09-29T10:00:00.000Z' }),
			b: summary({ title: 'Beta', cwd: '', updatedAt: 1_700_000_000_000 })
		}
	);
	assert.deepEqual(rows.map((row) => row.id), ['b', 'a', 'c']);
	assert.equal(rows[0]?.title, 'Beta');
	assert.equal(rows[1]?.title, 'Alpha'); // trim
	assert.equal(rows[1]?.updatedAtMs, Date.parse('2026-09-29T10:00:00.000Z'));
	assert.equal(rows[2]?.missingSummary, true); // 缺摘要不丢行
	assert.equal(rows[2]?.title, '');
	assert.equal(rows[2]?.cwd, '');
});

test('buildRows：全部输入畸形时返回空数组而不是抛错', () => {
	assert.deepEqual(model.buildRows(undefined, undefined), []);
	assert.deepEqual(model.buildRows([1, {}, null], {}), []);
});

test('toEpochMs：毫秒 / 秒 / ISO 字符串 / 非法值', () => {
	assert.equal(model.toEpochMs(1_700_000_000_000), 1_700_000_000_000);
	assert.equal(model.toEpochMs(1_700_000_000), 1_700_000_000_000); // 秒 → 毫秒
	assert.equal(model.toEpochMs('2026-09-29T10:00:00.000Z'), Date.parse('2026-09-29T10:00:00.000Z'));
	assert.equal(model.toEpochMs('not-a-date'), null);
	assert.equal(model.toEpochMs(0), null);
	assert.equal(model.toEpochMs(-1), null);
	assert.equal(model.toEpochMs(Number.NaN), null);
	assert.equal(model.toEpochMs(undefined), null);
	assert.equal(model.toEpochMs({}), null);
});

test('rowFor：running 只在严格 true 时成立', () => {
	assert.equal(model.rowFor('id', summary({ running: true })).running, true);
	assert.equal(model.rowFor('id', summary({ running: 'yes' })).running, false);
	assert.equal(model.rowFor('id', undefined).missingSummary, true);
});

test('filterRows：匹配标题 / 项目 / id，大小写不敏感，空白词返回全部', () => {
	const rows = [
		model.rowFor('aaaaaaaa-0000-0000-0000-000000000001', summary({ title: 'Release notes', cwd: 'D:\\work\\dsh' })),
		model.rowFor('bbbbbbbb-0000-0000-0000-000000000002', summary({ title: '调试会话', cwd: 'D:\\proj\\other' }))
	];
	assert.equal(model.filterRows(rows, '').length, 2);
	assert.equal(model.filterRows(rows, '   ').length, 2);
	assert.deepEqual(model.filterRows(rows, 'RELEASE').map((row) => row.id), [rows[0].id]);
	assert.deepEqual(model.filterRows(rows, 'other').map((row) => row.id), [rows[1].id]);
	assert.deepEqual(model.filterRows(rows, 'bbbb').map((row) => row.id), [rows[1].id]);
	assert.equal(model.filterRows(rows, 'nothing').length, 0);
});

test('sortRows：按更新时间降序、未知时间排最后；按标题升序、空标题排最后', () => {
	const rows = [
		model.rowFor('old', summary({ title: 'old', updatedAt: 1_000 })),
		model.rowFor('none', summary({ title: 'none' })),
		model.rowFor('new', summary({ title: 'new', updatedAt: 9_000 }))
	];
	assert.deepEqual(model.sortRows(rows, 'updatedAt', 'desc').map((row) => row.id), ['new', 'old', 'none']);
	assert.deepEqual(model.sortRows(rows, 'updatedAt', 'asc').map((row) => row.id), ['old', 'new', 'none']);

	const titled = [
		model.rowFor('b', summary({ title: 'beta' })),
		model.rowFor('empty', summary({ cwd: 'D:\\x' })),
		model.rowFor('a', summary({ title: 'Alpha' }))
	];
	assert.deepEqual(model.sortRows(titled, 'title', 'asc').map((row) => row.id), ['a', 'b', 'empty']);
	assert.deepEqual(model.sortRows(titled, 'title', 'desc').map((row) => row.id), ['b', 'a', 'empty']);
});

test('sortRows：等值时保持原顺序（稳定排序）且不修改入参', () => {
	const rows = [
		model.rowFor('first', summary({ title: 'same', updatedAt: 5_000 })),
		model.rowFor('second', summary({ title: 'same', updatedAt: 5_000 })),
		model.rowFor('third', summary({ title: 'same', updatedAt: 5_000 }))
	];
	const before = rows.map((row) => row.id);
	assert.deepEqual(model.sortRows(rows, 'updatedAt', 'desc').map((row) => row.id), before);
	assert.deepEqual(rows.map((row) => row.id), before);
});

test('normalizeSelection：按当前列表顺序输出、去掉已不存在与重复的 id', () => {
	const available = ['b', 'a', 'c'];
	assert.deepEqual(model.normalizeSelection(['c', 'zzz', 'a', 'a'], available), ['a', 'c']);
	assert.deepEqual(model.normalizeSelection([], available), []);
	assert.deepEqual(model.normalizeSelection(['b'], []), []);
});

test('toggleSelection：加入 / 移除 / 幂等', () => {
	assert.deepEqual(model.toggleSelection([], 'a'), ['a']);
	assert.deepEqual(model.toggleSelection(['a', 'b'], 'a'), ['b']);
	assert.deepEqual(model.toggleSelection(['a'], 'a'), []);
});

test('timePhraseKey：官方 relativeTime 的 6 个 unit 全覆盖，未知 unit 降级', () => {
	assert.deepEqual([...model.TIME_UNITS], ['now', 'minutes', 'hours', 'days', 'months', 'years']);
	for (const unit of model.TIME_UNITS) assert.equal(model.timePhraseKey(unit), `time.${unit}`);
	assert.equal(model.timePhraseKey('fortnights'), 'time.unknown');
	assert.equal(model.timePhraseKey(undefined), 'time.unknown');
	assert.equal(model.timePhraseKey(7), 'time.unknown');
});

test('hostErrorCode：契约内的码原样返回，其余降级成 unknown', () => {
	for (const code of model.HOST_ERROR_CODES) assert.equal(model.hostErrorCode(code), code);
	assert.equal(model.hostErrorCode('brand-new-code'), 'unknown');
	assert.equal(model.hostErrorCode(undefined), 'unknown');
	assert.equal(model.hostErrorCode(7), 'unknown');
	assert.equal(model.HOST_ERROR_CODES.length, 10);
	assert.ok(model.HOST_ERROR_CODES.includes('entry-purged'), 'T12 新码必须在白名单里');
});

test('parseApiFailure：正常 4xx/5xx 体、畸形体、非对象体都能降级', () => {
	const parsed = model.parseApiFailure(409, { code: 'session-live', message: 'busy', ids: ['a', 1, null] });
	assert.equal(parsed.status, 409);
	assert.equal(parsed.code, 'session-live');
	assert.equal(parsed.message, 'busy');
	assert.deepEqual(parsed.ids, ['a']);

	const unknownCode = model.parseApiFailure(500, { code: 'future-code', message: 'x' });
	assert.equal(unknownCode.code, 'unknown');
	assert.equal(unknownCode.message, 'x');

	assert.deepEqual(model.parseApiFailure(501, null), { status: 501, code: 'unknown', message: '', ids: [] });
	assert.deepEqual(model.parseApiFailure(400, [1, 2]), { status: 400, code: 'unknown', message: '', ids: [] });
	assert.deepEqual(model.parseApiFailure(400, 'oops'), { status: 400, code: 'unknown', message: '', ids: [] });
});

test('parseRecycleResponse：200 里的逐条失败同样带稳定 code', () => {
	const outcome = model.parseRecycleResponse({
		moved: ['a', 3],
		failed: [
			{ id: 'b', code: 'path-unsafe', message: 'symlink' },
			{ id: 'c', code: 'future', message: 'x' },
			'garbage'
		]
	});
	assert.deepEqual(outcome.moved, ['a']);
	assert.equal(outcome.failures.length, 2);
	assert.deepEqual(outcome.failures[0], { status: 200, code: 'path-unsafe', message: 'symlink', ids: ['b'] });
	assert.equal(outcome.failures[1].code, 'unknown');
	assert.deepEqual(model.parseRecycleResponse(undefined), { moved: [], failures: [] });
	assert.deepEqual(model.parseRecycleResponse('nope'), { moved: [], failures: [] });
});

test('safeJson：非法 JSON 返回 null 而不抛错', () => {
	assert.deepEqual(model.safeJson('{"a":1}'), { a: 1 });
	assert.equal(model.safeJson('<html>501</html>'), null);
	assert.equal(model.safeJson(''), null);
});

test('chunk / batchChunks：按契约上限 200 切块', () => {
	assert.deepEqual(model.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(model.chunk([], 2), []);
	const many = Array.from({ length: 201 }, (_, index) => index);
	const parts = model.batchChunks(many);
	assert.equal(parts.length, 2);
	assert.equal(parts[0].length, 200);
	assert.equal(parts[1].length, 1);
});

test('postJson：成功、非 2xx、网络异常、非 JSON 体四条分支', async () => {
	const calls = [];
	const okFetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: true, status: 200, text: async () => JSON.stringify({ moved: ['a'], failed: [] }) };
	};
	const ok = await model.postJson('/api/dsh-archive-manager/recycle', { sessionIds: ['a'] }, okFetch);
	assert.equal(ok.ok, true);
	assert.equal(calls[0].url, '/api/dsh-archive-manager/recycle'); // 直接用 HOST_ROUTES.*，不再拼前缀
	assert.equal(calls[0].init.method, 'POST');
	assert.deepEqual(JSON.parse(calls[0].init.body), { sessionIds: ['a'] });

	const rejectFetch = async () => ({
		ok: false,
		status: 409,
		text: async () => JSON.stringify({ code: 'session-live', message: 'busy', ids: ['a'] })
	});
	const rejected = await model.postJson('/api/dsh-archive-manager/recycle', {}, rejectFetch);
	assert.equal(rejected.ok, false);
	assert.equal(rejected.failure.code, 'session-live');
	assert.deepEqual(rejected.failure.ids, ['a']);

	const deadFetch = async () => {
		throw new Error('offline');
	};
	const dead = await model.postJson('/api/dsh-archive-manager/list', {}, deadFetch);
	assert.equal(dead.ok, false);
	assert.equal(dead.failure.status, 0);
	assert.equal(dead.failure.code, 'unknown');
	assert.equal(dead.failure.message, 'offline');

	const htmlFetch = async () => ({ ok: false, status: 501, text: async () => '<html>501</html>' });
	const html = await model.postJson('/api/dsh-archive-manager/recycle', {}, htmlFetch);
	assert.equal(html.ok, false);
	assert.equal(html.failure.code, 'unknown');
	assert.equal(html.failure.message, '');
});

test('interpolate：替换 {name}，缺值时保留原样', () => {
	assert.equal(locales.interpolate('已选 {count} 条', { count: 3 }), '已选 3 条');
	assert.equal(locales.interpolate('{a}-{b}', { a: 1 }), '1-{b}');
	assert.equal(locales.interpolate('no placeholder'), 'no placeholder');
});

test('pickDictionary：精确匹配、语言主标签回落、未知语言回落中文', () => {
	assert.equal(locales.pickDictionary('zh'), locales.LOCALE_ZH);
	assert.equal(locales.pickDictionary('en'), locales.LOCALE_EN);
	assert.equal(locales.pickDictionary('zh-CN'), locales.LOCALE_ZH);
	assert.equal(locales.pickDictionary('EN_us'), locales.LOCALE_EN);
	assert.equal(locales.pickDictionary('fr'), locales.LOCALE_ZH);
	assert.equal(locales.pickDictionary(undefined), locales.LOCALE_ZH);
});

test('createTranslate：宿主 t 优先；宿主未注册该 key 时回落内置词典', () => {
	const host = locales.createTranslate((key) => (key === 'section.nav' ? 'Host nav' : key), 'en');
	assert.equal(host('section.nav'), 'Host nav');
	assert.equal(host('state.loading'), locales.LOCALE_EN['state.loading']);

	const fallback = locales.createTranslate(undefined, 'en');
	assert.equal(fallback('section.nav'), 'Archived sessions');
	assert.equal(fallback('missing.key'), 'missing.key');
	assert.equal(fallback('batch.selected', { count: 2 }), '2 selected');
});

test('词典：中英 key 完全对齐，且九个宿主错误码都有中英文案', () => {
	const zhKeys = Object.keys(locales.LOCALE_ZH).sort();
	const enKeys = Object.keys(locales.LOCALE_EN).sort();
	assert.deepEqual(zhKeys, enKeys);
	for (const code of model.HOST_ERROR_CODES) {
		assert.equal(typeof locales.LOCALE_ZH[`error.${code}`], 'string', `缺少中文错误码文案：${code}`);
		assert.equal(typeof locales.LOCALE_EN[`error.${code}`], 'string', `缺少英文错误码文案：${code}`);
	}
	assert.equal(typeof locales.LOCALE_ZH['error.unknown'], 'string');
	assert.equal(typeof locales.LOCALE_EN['error.unknown'], 'string');
});

test('页面源码：只用主题令牌，不出现硬编码十六进制颜色', async () => {
	const source = await readFile(join(root, 'src/client/ArchivedSessionsSection.tsx'), 'utf8');
	assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, '出现了硬编码十六进制颜色');
	assert.ok(source.includes('var(--dsw-'), '应使用主题令牌');
	assert.ok(source.includes('aria-label'), '图标/控件需要 aria-label');
});

test('客户端入口：注册 id/order 与契约一致', async () => {
	const source = await readFile(join(root, 'src/client/index.ts'), 'utf8');
	assert.ok(source.includes('SETTINGS_SECTION_ID'), 'id 必须来自契约常量');
	assert.ok(source.includes('SETTINGS_SECTION_ORDER'), 'order 必须来自契约常量');
	assert.ok(source.includes("inject = ['slots', 'locale', 'workspaces']"), 'Cordis 服务注入');
	assert.ok(source.includes('label: () =>'), 'label 必须是 thunk（跟随语言）');
});

test('客户端源码：运行时 import 只落在基座白名单内', async () => {
	const BASE = new Set([
		'react',
		'react/jsx-runtime',
		'react-dom',
		'react-dom/client',
		'@deepseek-ai/cordis',
		'@deepseek-ai/dsh-client-store',
		'@deepseek-ai/dsh-client-ui-slots',
		'@deepseek-ai/dsh-client-ui-primitives',
		'@deepseek-ai/dsh-client-ui-dockkit'
	]);
	for (const file of ['index.ts', 'locales.ts', 'useArchivedSessions.ts', 'ArchivedSessionsSection.tsx']) {
		const source = await readFile(join(root, 'src/client', file), 'utf8');
		const specifiers = [...source.matchAll(/^\s*import[^\n]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
		for (const specifier of specifiers) {
			if (specifier.startsWith('.')) continue; // 相对模块进 bundle
			assert.ok(BASE.has(specifier), `${file} 运行时 import 了非基座模块：${specifier}`);
		}
	}
});

// ---------------------------------------------------------------------------
// T7：就绪判定（state vs phase）与工作区分组
// ---------------------------------------------------------------------------

/**
 * 分组夹具：三个工作区 + 一条无法归组 + 一个工作区没有任何归档。
 * 归档顺序（宿主 `archivedSessionIds`）刻意与工作区顺序不同，确保分组顺序取自 `items`。
 */
function fixture() {
	const alpha = 'aaaaaaaa-0000-4000-8000-000000000001';
	const alpha2 = 'aaaaaaaa-0000-4000-8000-000000000002';
	const beta = 'bbbbbbbb-0000-4000-8000-000000000001';
	const orphan = 'cccccccc-0000-4000-8000-000000000001';
	const elsewhere = 'dddddddd-0000-4000-8000-000000000001';
	const views = [
		{ workspaceId: 'ws-a', path: 'D:\\repos\\alpha', title: 'Alpha 项目', sessionIds: [alpha, alpha2] },
		{ workspaceId: 'ws-b', path: 'D:\\repos\\beta', title: 'Beta', sessionIds: [beta] },
		{ workspaceId: 'ws-c', path: 'D:\\repos\\gamma', title: 'Gamma', sessionIds: [elsewhere] }
	];
	// 会话标题用 ASCII，避免 localeCompare 随宿主语言（拼音/笔画）变化而让断言不稳定；
	// 中文排序行为由实现交给 localeCompare，本文件不锁定具体顺序。
	const rows = model.buildRows([beta, orphan, alpha, alpha2], {
		[alpha]: { id: alpha, title: 'Alpha A', cwd: 'D:\\repos\\alpha', updatedAt: 1_000 },
		[alpha2]: { id: alpha2, title: 'Alpha B', cwd: 'D:\\repos\\alpha', updatedAt: 9_000 },
		[beta]: { id: beta, title: 'Beta A', cwd: 'D:\\repos\\beta', updatedAt: 5_000 }
	});
	return { rows, views, ids: { alpha, alpha2, beta, orphan, elsewhere } };
}

test('resolvePhase：就绪看 phase，state 只表示请求状态', () => {
	// 官方真实快照：拉取成功后 state 回到 'idle'（联合类型里没有 'ready'），就绪由 phase 表达。
	assert.equal(model.resolvePhase({ state: 'idle', phase: 'ready' }), 'ready');
	assert.equal(model.resolvePhase({ state: 'loading', phase: 'pending' }), 'loading');
	assert.equal(model.resolvePhase({ state: 'error', phase: 'pending' }), 'error');
	assert.equal(model.resolvePhase(undefined), 'unsupported');
	// phase 缺失（老快照 / 测试桩）时按已就绪处理，避免永久转圈。
	assert.equal(model.resolvePhase({ state: 'idle' }), 'ready');
	assert.equal(model.resolvePhase({ state: 'loading' }), 'loading');
	assert.equal(model.resolvePhase({}), 'ready');
	// 'ready' 不是官方 state 取值，但桩若给了也应认。
	assert.equal(model.resolvePhase({ state: 'ready' }), 'ready');
	// error 优先于一切。
	assert.equal(model.resolvePhase({ state: 'error', phase: 'ready' }), 'error');
});

test('groupRowsByWorkspace：组顺序取 items、兜底组排最后、无归档的工作区不产生组', () => {
	const { rows, views, ids } = fixture();
	const groups = model.groupRowsByWorkspace(rows, views);
	assert.deepEqual(groups.map((group) => group.id), ['ws-a', 'ws-b', model.UNASSIGNED_GROUP_ID]);
	assert.deepEqual(groups[0].rows.map((row) => row.id), [ids.alpha, ids.alpha2]);
	assert.deepEqual(groups[1].rows.map((row) => row.id), [ids.beta]);
	assert.deepEqual(groups[2].rows.map((row) => row.id), [ids.orphan]);
	assert.equal(groups[0].title, 'Alpha 项目');
	assert.equal(groups[0].path, 'D:\\repos\\alpha');
	// 兜底组没有工作区元数据，由渲染层查 i18n。
	assert.equal(groups[2].title, '');
	assert.equal(groups[2].path, '');
	// 任何一行都不得被丢弃。
	assert.equal(groups.reduce((total, group) => total + group.rows.length, 0), rows.length);
	// ws-c 没有任何已归档会话 → 不出现空组头。
	assert.equal(groups.some((group) => group.id === 'ws-c'), false);
});

test('buildWorkspaceIndex：不猜 cwd，畸形输入跳过，重复归属先到先得', () => {
	const shared = 'aaaaaaaa-0000-4000-8000-000000000001';
	assert.deepEqual(model.buildWorkspaceIndex(undefined), {});
	assert.deepEqual(model.buildWorkspaceIndex([null, 'x', 7, {}, { workspaceId: 'w' }, { workspaceId: 'w', sessionIds: 'nope' }]), {});
	assert.deepEqual(model.buildWorkspaceIndex([{ workspaceId: 'w2', sessionIds: [1, '', shared, shared] }]), { [shared]: 'w2' });
	assert.deepEqual(
		model.buildWorkspaceIndex([
			{ workspaceId: 'w1', sessionIds: [shared] },
			{ workspaceId: 'w2', sessionIds: [shared] }
		]),
		{ [shared]: 'w1' }
	);
});

test('groupRowsByWorkspace：views 为空或全是畸形时，所有行进兜底组', () => {
	const { rows } = fixture();
	for (const views of [undefined, [], ['nope', null]]) {
		const groups = model.groupRowsByWorkspace(rows, views);
		assert.equal(groups.length, 1);
		assert.equal(groups[0].id, model.UNASSIGNED_GROUP_ID);
		assert.equal(groups[0].rows.length, rows.length);
	}
});

test('组内搜索：零命中的组整组隐藏，不得出现空组头', () => {
	const { rows, views } = fixture();
	const grouped = model.groupRowsByWorkspace(rows, views);

	const onlyBeta = model.filterGroups(grouped, 'beta');
	assert.deepEqual(onlyBeta.map((group) => group.id), ['ws-b']);
	assert.deepEqual(onlyBeta[0].rows.map((row) => row.title), ['Beta A']);

	const none = model.filterGroups(grouped, 'zzzz-not-found');
	assert.deepEqual(none, []);

	const all = model.filterGroups(grouped, '   ');
	assert.deepEqual(all.map((group) => group.id), grouped.map((group) => group.id));
	for (const group of all) assert.ok(group.rows.length > 0, '不得出现空组');
});

test('buildGroups：排序只在组内生效，组顺序不被排序打乱', () => {
	const { rows, views, ids } = fixture();
	const groups = model.buildGroups(rows, views, '', 'updatedAt', 'desc');
	assert.deepEqual(groups.map((group) => group.id), ['ws-a', 'ws-b', model.UNASSIGNED_GROUP_ID]);
	assert.deepEqual(groups[0].rows.map((row) => row.id), [ids.alpha2, ids.alpha]);
	assert.deepEqual(groups[1].rows.map((row) => row.id), [ids.beta]);
	// 未知时间排在组内最后（该组只有一条）。
	assert.deepEqual(groups[2].rows.map((row) => row.id), [ids.orphan]);

	const byTitle = model.buildGroups(rows, views, '', 'title', 'asc');
	assert.deepEqual(byTitle[0].rows.map((row) => row.title), ['Alpha A', 'Alpha B']);
});

test('跨组选择：展平顺序 = 组顺序 × 组内顺序，选择归一化仍按展平顺序', () => {
	const { rows, views, ids } = fixture();
	const groups = model.buildGroups(rows, views, '', 'updatedAt', 'desc');
	const listed = model.groupsRowIds(groups);
	assert.deepEqual(listed, [ids.alpha2, ids.alpha, ids.beta, ids.orphan]);

	// 跨组勾选（含一个已不存在的 id）→ 归一化后按展平顺序输出。
	assert.deepEqual(
		model.normalizeSelection([ids.beta, 'gone', ids.alpha2], listed),
		[ids.alpha2, ids.beta]
	);
});

test('筛选后「全选当前结果」只覆盖仍然可见的行', () => {
	const { rows, views, ids } = fixture();
	const groups = model.buildGroups(rows, views, 'alpha', 'updatedAt', 'desc');
	const listed = model.groupsRowIds(groups);
	assert.deepEqual(listed, [ids.alpha2, ids.alpha]);
	assert.equal(listed.includes(ids.beta), false, '被隐藏组的行不应进入当前筛选结果');
});

test('原型键 id：绝不丢行、落兜底组、不污染 Object.prototype（verifier P17 回归）', () => {
	const weirdIds = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];
	for (const weird of weirdIds) {
		const rows = model.buildRows([weird], {});
		assert.equal(rows.length, 1, `${weird}：buildRows 不得丢行`);
		assert.equal(rows[0].missingSummary, true, `${weird}：不得被 Object.prototype 成员冒充成「有摘要」`);

		const groups = model.groupRowsByWorkspace(rows, []);
		assert.equal(groups.length, 1, `${weird}：必须落进一条兜底组`);
		assert.equal(groups[0].id, model.UNASSIGNED_GROUP_ID);
		assert.deepEqual(groups[0].rows.map((row) => row.id), [weird]);
	}
});

test('索引导出的读取形状保持不变，且 __proto__ 只是普通自有键', () => {
	const index = model.buildWorkspaceIndex([{ workspaceId: 'ws-w', sessionIds: ['toString', '__proto__'] }]);
	// 外部依赖 `index[id]` 的直接读取（verifier 探针也这么用）。
	assert.equal(index['toString'], 'ws-w');
	assert.equal(index['__proto__'], 'ws-w');
	// 仍是普通对象，且这两个键是被创建的自有数据属性，而不是原型改写。
	assert.equal(Object.getPrototypeOf(index), Object.prototype);
	assert.equal(Object.prototype.hasOwnProperty.call(index, 'toString'), true);
	assert.equal(Object.prototype.hasOwnProperty.call(index, '__proto__'), true);

	// 原型键若真有归属，必须进入对应工作区组，而不是兜底组。
	const grouped = model.groupRowsByWorkspace(
		model.buildRows(['toString'], {}),
		[{ workspaceId: 'ws-w', title: 'W', path: 'D:\\w', sessionIds: ['toString'] }]
	);
	assert.deepEqual(grouped.map((group) => group.id), ['ws-w']);
	assert.deepEqual(grouped[0].rows.map((row) => row.id), ['toString']);
});

test('T8：组内行不重复显示目录，兜底组保留目录', () => {
	const { rows, views } = fixture();
	const groups = model.groupRowsByWorkspace(rows, views);
	for (const group of groups) {
		const show = model.shouldShowRowCwd(group.id);
		if (group.id === model.UNASSIGNED_GROUP_ID) {
			assert.equal(show, true, '兜底组组头没有 path，必须保留行内 cwd');
		} else {
			assert.equal(show, false, `工作区组 ${group.id} 的行不应重复显示 cwd`);
		}
	}
	assert.equal(model.shouldShowRowCwd('ws-a'), false);
	assert.equal(model.shouldShowRowCwd(model.UNASSIGNED_GROUP_ID), true);
	// 只影响显示，不影响搜索：按目录关键词仍能筛出组内的行。
	const byCwd = model.buildGroups(rows, views, 'repos\\alpha', 'updatedAt', 'desc');
	assert.deepEqual(byCwd.map((group) => group.id), ['ws-a']);
	assert.equal(byCwd[0].rows.length, 2);
});

// ---------------------------------------------------------------------------
// T9：回收站数据层 + 幽灵行过滤
// ---------------------------------------------------------------------------

/** 一条形状合法的回收站条目（entryId 必须过契约的 `<movedAt>@<sessionId>`）。 */
const entry = (sessionId, overrides = {}) => ({
	entryId: `1790673301827@${sessionId}`,
	sessionId,
	movedAt: '2026-09-29T09:00:00.000Z',
	originalPath: `D:\\DSH\\sessions\\slug\\${sessionId}`,
	bytes: 98_604,
	...overrides
});

/**
 * 用一份 `/list` 条目（已归一化）直接驱动**单点真源** `buildSectionModel`。
 * 默认给一个「已就绪但归档集合为空」的空快照，可用 overrides 覆盖 workspace/sessions 等。
 */
const binView = ({ entries, ...overrides }) => model.buildSectionModel({
	workspace: { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null },
	sessions: { byId: {} },
	recycleEntries: entries,
	optimisticGone: [],
	query: '',
	sortKey: 'updatedAt',
	selectedIds: [],
	...overrides
});

test('T9 excludeRecycled：剔除已回收 id，其余行原样保留', () => {
	const { rows, ids } = fixture();
	const alive = model.excludeRecycled(rows, new Set([ids.alpha, ids.orphan]));
	assert.deepEqual(alive.map((row) => row.id), [ids.beta, ids.alpha2]);
	// 空集合时返回副本而不是同一个数组引用。
	const untouched = model.excludeRecycled(rows, new Set());
	assert.deepEqual(untouched.map((row) => row.id), rows.map((row) => row.id));
	assert.notEqual(untouched, rows);
});

test('T9 幽灵行：过滤掉被回收的 id 后，该工作区组整组消失（不留空组头）', () => {
	const { rows, views, ids } = fixture();
	// fixture：ws-a 有 alpha/alpha2，ws-b 有 beta，另有一条孤儿行。
	const alive = model.excludeRecycled(rows, new Set([ids.alpha, ids.alpha2]));
	const groups = model.groupRowsByWorkspace(alive, views);
	assert.deepEqual(groups.map((group) => group.id), ['ws-b', model.UNASSIGNED_GROUP_ID]);
	assert.equal(groups.some((group) => group.id === 'ws-a'), false, 'ws-a 已空，不得留下空组头');
	// 全部回收 → 没有任何组，页面走空态。
	assert.deepEqual(model.groupRowsByWorkspace(model.excludeRecycled(rows, new Set(rows.map((row) => row.id))), views), []);
});

test('T9 幽灵行：回收 id 在归档集合里仍留着，但不再进入任何视图', () => {
	// 模拟真机：archivedSessionIds 仍是 5 条（宿主不清理），回收站清单里多出其中 1 条。
	const ghost = 'ffffffff-0000-4000-8000-000000000001';
	const rows = model.buildRows(['aaaaaaaa-0000-4000-8000-000000000001', ghost], {});
	const recycled = new Set(bin.parseRecycleEntries({ entries: [entry(ghost)] }).map((item) => item.sessionId));
	assert.deepEqual(recycled, new Set([ghost]));
	assert.deepEqual(model.excludeRecycled(rows, recycled).map((row) => row.id), ['aaaaaaaa-0000-4000-8000-000000000001']);
});

test('T9 parseRecycleEntries：缺 title / 缺 cwd / 坏 bytes / 非法 entryId 全部降级', () => {
	const parsed = bin.parseRecycleEntries({
		entries: [
			entry('aaaaaaaa-0000-4000-8000-000000000001'),
			entry('bbbbbbbb-0000-4000-8000-000000000001', { title: '  有标题  ', cwd: 'D:\\proj' }),
			entry('cccccccc-0000-4000-8000-000000000001', { bytes: Number.NaN }),
			entry('dddddddd-0000-4000-8000-000000000001', { bytes: -5 }),
			entry('eeeeeeee-0000-4000-8000-000000000001', { movedAt: 42 }),
			{ entryId: 'not-an-entry-id', sessionId: 'ffffffff-0000-4000-8000-000000000001' },
			{ entryId: '1790673301827@x', sessionId: '' },
			null,
			'garbage'
		]
	});
	assert.equal(parsed.length, 5, '非法条目必须被丢弃而不是抛出');
	assert.equal(parsed[0].title, undefined, '缺 title 时不应造一个空串');
	assert.equal(parsed[0].cwd, undefined, '缺 cwd 时不应造一个空串');
	assert.equal(parsed[1].title, '有标题');
	assert.equal(parsed[1].cwd, 'D:\\proj');
	assert.equal(parsed[2].bytes, 0, '坏 bytes 归零');
	assert.equal(parsed[3].bytes, 0, '负 bytes 归零');
	assert.equal(parsed[4].movedAt, '', '非字符串 movedAt 归空串（UI 侧显示「时间未知」）');
});

test('T9 parseRecycleEntries：非对象 / 缺 entries / entries 非数组都返回空数组', () => {
	for (const body of [undefined, null, 'x', 7, [], {}, { entries: 'nope' }, { entries: null }]) {
		assert.deepEqual(bin.parseRecycleEntries(body), []);
	}
});

test('T9 parsePurgeOutcome：purged 计数 + failed[] 逐条失败码', () => {
	const outcome = bin.parsePurgeOutcome({
		purged: 2,
		failed: [{ id: '1790673301827@aaaaaaaa-0000-4000-8000-000000000001', code: 'path-unsafe', message: 'symlink 原地保留' }]
	});
	assert.equal(outcome.purged, 2);
	assert.equal(outcome.failures.length, 1);
	assert.deepEqual(outcome.failures[0], {
		status: 200,
		code: 'path-unsafe',
		message: 'symlink 原地保留',
		ids: ['1790673301827@aaaaaaaa-0000-4000-8000-000000000001']
	});
	assert.deepEqual(bin.parsePurgeOutcome(undefined), { purged: 0, failures: [] });
	assert.deepEqual(bin.parsePurgeOutcome({ purged: -1 }), { purged: 0, failures: [] });
	assert.equal(bin.parsePurgeOutcome({ purged: 1.7 }).purged, 2); // 四舍五入到整数
});

test('T9 parseRestoreOutcome：restored 列表 + failed[]', () => {
	const outcome = bin.parseRestoreOutcome({
		restored: ['1790673301827@aaaaaaaa-0000-4000-8000-000000000001', 42],
		failed: [{ id: '1790673301827@bbbbbbbb-0000-4000-8000-000000000001', code: 'entry-conflict', message: '目标已存在' }]
	});
	assert.deepEqual(outcome.restored, ['1790673301827@aaaaaaaa-0000-4000-8000-000000000001']);
	assert.equal(outcome.failures.length, 1);
	assert.equal(outcome.failures[0].code, 'entry-conflict');
	assert.deepEqual(bin.parseRestoreOutcome('nope'), { restored: [], failures: [] });
});

test('T9 GET /list：走 requestJson 的 GET 分支（无 body / 无 content-type），失败按 code 归一化', async () => {
	const calls = [];
	const okFetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: true, status: 200, text: async () => JSON.stringify({ entries: [entry('aaaaaaaa-0000-4000-8000-000000000001')] }) };
	};
	const ok = await model.getJson('/api/dsh-archive-manager/list', okFetch);
	assert.equal(ok.ok, true);
	assert.equal(calls[0].url, '/api/dsh-archive-manager/list');
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(calls[0].init.body, undefined);
	assert.equal(calls[0].init.headers, undefined);
	assert.equal(bin.parseRecycleEntries(ok.data).length, 1);

	// 501（旧宿主）→ 仍按 code 本地化，不抛错。
	const notReady = async () => ({ ok: false, status: 501, text: async () => JSON.stringify({ code: 'internal', message: 'not implemented' }) });
	const failed = await model.getJson('/api/dsh-archive-manager/list', notReady);
	assert.equal(failed.ok, false);
	assert.equal(failed.failure.code, 'internal');
	assert.equal(failed.failure.status, 501);
});

test('T9 回收站与页签文案：中英 key 对齐且都被注册', () => {
	const zh = locales.LOCALE_ZH;
	const en = locales.LOCALE_EN;
	for (const key of ['tab.label', 'tab.archived', 'tab.recycle', 'recycle.empty', 'recycle.purge.title', 'recycle.purge.ack', 'recycle.degraded', 'recycle.entryUntitled']) {
		assert.equal(typeof zh[key], 'string', `中文缺文案：${key}`);
		assert.equal(typeof en[key], 'string', `英文缺文案：${key}`);
	}
	// 清空回收站的确认文案必须写明「不做物理删除」。
	assert.ok(zh['recycle.purge.body'].includes('不做物理删除'));
	assert.ok(en['recycle.purge.body'].includes('not a physical delete'));
});

// ---------------------------------------------------------------------------
// T12：消费宿主台账（含已清空条目）→ 过滤跨刷新持久
// ---------------------------------------------------------------------------

test('T12 normalizeRecycleEntry：解析 purgedAt / purgedBatch，空串与空白串都不落字段', () => {
	const withLedger = bin.normalizeRecycleEntry(entry('aaaaaaaa-0000-4000-8000-000000000001', {
		purgedAt: '  2026-09-29T10:00:00.000Z  ',
		purgedBatch: '  batch-20260929-100000  '
	}));
	assert.equal(withLedger.purgedAt, '2026-09-29T10:00:00.000Z');
	assert.equal(withLedger.purgedBatch, 'batch-20260929-100000');

	const empty = bin.normalizeRecycleEntry(entry('bbbbbbbb-0000-4000-8000-000000000001', { purgedAt: '   ' }));
	assert.equal('purgedAt' in empty, false, '空白 purgedAt 不应落成字段（避免被当成已清空）');
	assert.equal('purgedBatch' in empty, false);

	const nonString = bin.normalizeRecycleEntry(entry('cccccccc-0000-4000-8000-000000000001', { purgedAt: 42, purgedBatch: null }));
	assert.equal('purgedAt' in nonString, false);
});

test('T12 isPurgedEntry / restoreGuard：有 purgedAt 即不可还原，原因码是 entry-purged', () => {
	assert.equal(bin.isPurgedEntry({ purgedAt: '2026-09-29T10:00:00.000Z' }), true);
	assert.equal(bin.isPurgedEntry({}), false);
	assert.equal(bin.isPurgedEntry({ purgedAt: '' }), false);

	assert.deepEqual(bin.restoreGuard({}), { allowed: true, purged: false, reasonKey: '' });
	assert.deepEqual(bin.restoreGuard({ purgedAt: '2026-09-29T10:00:00.000Z' }), {
		allowed: false,
		purged: true,
		reasonKey: 'error.entry-purged'
	});
});

test('T12 验收核心：清空后刷新（只有一份 /list 响应做输入），已归档列表不再出现那些 id', () => {
	const live = 'aaaaaaaa-0000-4000-8000-000000000001';
	const ghost = 'ffffffff-0000-4000-8000-000000000001';
	// archivedSessionIds 仍留着两条（宿主不清理归档集合）。
	const rows = model.buildRows([live, ghost], {});

	// 「刷新后」= 全新状态，唯一输入是宿主这次返回的 /list（被清空的条目带 purgedAt）。
	const entries = bin.parseRecycleEntries({
		entries: [entry(ghost, { purgedAt: '2026-09-29T10:00:00.000Z', purgedBatch: 'batch-1' })]
	});
	// 1) 条目仍留在清单里（回收站页签要能显示「已在冷存档区」）。
	assert.equal(entries.length, 1);
	assert.equal(bin.isPurgedEntry(entries[0]), true);
	// 2) recycledIds 覆盖它 → 已归档列表只剩 live 一条，幽灵行不出现。
	const recycled = new Set(entries.map((item) => item.sessionId));
	assert.deepEqual(model.excludeRecycled(rows, recycled).map((row) => row.id), [live]);
	// 3) 不依赖任何内存状态：同样的输入再算一次结果相同（可重放）。
	assert.deepEqual(
		model.excludeRecycled(model.buildRows([live, ghost], {}), new Set(bin.parseRecycleEntries({
			entries: [entry(ghost, { purgedAt: '2026-09-29T10:00:00.000Z' })]
		}).map((item) => item.sessionId))).map((row) => row.id),
		[live]
	);
});

test('T12 清单同时含在站与已清空条目时，两类都被过滤，且分组不留空组头', () => {
	const { rows, views, ids } = fixture();
	const entries = bin.parseRecycleEntries({
		entries: [
			entry(ids.alpha),
			entry(ids.alpha2, { purgedAt: '2026-09-29T10:00:00.000Z', purgedBatch: 'batch-2' })
		]
	});
	const recycled = new Set(entries.map((item) => item.sessionId));
	const groups = model.groupRowsByWorkspace(model.excludeRecycled(rows, recycled), views);
	assert.deepEqual(groups.map((group) => group.id), ['ws-b', model.UNASSIGNED_GROUP_ID]);
	assert.equal(groups.some((group) => group.id === 'ws-a'), false, 'ws-a 的两条都被回收，不得留空组头');
});

test('T12 entry-purged：中英词典都有本地化文案，且识别为契约内合法码', () => {
	assert.equal(model.hostErrorCode('entry-purged'), 'entry-purged');
	assert.equal(typeof locales.LOCALE_ZH['error.entry-purged'], 'string');
	assert.equal(typeof locales.LOCALE_EN['error.entry-purged'], 'string');
	for (const key of ['recycle.purgedTag', 'recycle.purgedHint', 'recycle.purgedHintNoBatch', 'recycle.restore.disabled.aria']) {
		assert.equal(typeof locales.LOCALE_ZH[key], 'string', `中文缺文案：${key}`);
		assert.equal(typeof locales.LOCALE_EN[key], 'string', `英文缺文案：${key}`);
	}
	// 禁用说明里应能带出冷存档批次名。
	assert.ok(locales.LOCALE_ZH['recycle.purgedHint'].includes('{batch}'));
	assert.ok(locales.LOCALE_EN['recycle.purgedHint'].includes('{batch}'));
});

test('T14 回收站行的判定改为行为断言：模型直接给出 purged / canRestore / reasonKey', () => {	const modelOf = binView({
		entries: [
			entry('aaaaaaaa-0000-4000-8000-000000000001'),
			entry('bbbbbbbb-0000-4000-8000-000000000001', {
				purgedAt: '2026-09-29T10:00:00.000Z',
				purgedBatch: '20260929-093138'
			})
		]
	});
	assert.equal(modelOf.recycleRows.length, 2);
	assert.deepEqual(
		modelOf.recycleRows.map((row) => ({ purged: row.purged, canRestore: row.canRestore, reasonKey: row.reasonKey })),
		[
			{ purged: false, canRestore: true, reasonKey: '' },
			{ purged: true, canRestore: false, reasonKey: 'error.entry-purged' }
		]
	);
	assert.equal(modelOf.activeRecycleCount, 1);
	assert.equal(modelOf.purgedCount, 1);
	// 已清空条目的批次名要能被 UI 取到（便于人工找回）。
	assert.equal(modelOf.recycleRows[1].entry.purgedBatch, '20260929-093138');
});

test('T14 防回归：src/client/** 里零持久化 API，且过滤真源只剩 /list', async () => {
	// T12 删掉了内存墓碑；这条断言阻止以后引入隐式持久化（localStorage 等）。
	const offenders = [];
	const files = (await readdir(join(root, 'src/client'), { withFileTypes: true }))
		.filter((item) => item.isFile() && /\.tsx?$/.test(item.name))
		.map((item) => item.name);
	for (const file of files) {
		const source = await readFile(join(root, 'src/client', file), 'utf8');
		for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'markPurged', 'tombstoned']) {
			if (source.includes(api)) offenders.push(`${file}: ${api}`);
		}
	}
	assert.deepEqual(offenders, [], `src/client/** 出现了持久化/墓碑语义：\n${offenders.join('\n')}`);
	assert.ok(files.length >= 5, '应扫描到全部客户端源码');

	const hookSource = await readFile(join(root, 'src/client/useRecycleBin.ts'), 'utf8');
	assert.ok(
		hookSource.includes('for (const entry of entries) ids.add(entry.sessionId)'),
		'recycledIds 必须覆盖 /list 全部条目'
	);
});

// ---------------------------------------------------------------------------
// T14：A5 核心链路的端到端行为断言（原始输入 → 最终视图模型）
// ---------------------------------------------------------------------------

/** 真实形状的夹具：4 条归档，其中 `session-` 前缀那条的工件已被移走。 */
const E2E = {
	ghost: 'session-0b9de1ba-1111-4111-8111-111111111111',
	alpha1: 'aaaaaaaa-0000-4000-8000-000000000001',
	alpha2: 'aaaaaaaa-0000-4000-8000-000000000002',
	beta1: 'bbbbbbbb-0000-4000-8000-000000000001'
};

/** 归档快照（宿主顺序；ghost 仍在 archivedSessionIds 里 —— 宿主不会清理它）。 */
const e2eSnapshot = {
	items: [
		{ workspaceId: 'ws-a', path: 'D:\\repos\\alpha', title: 'Alpha 项目', sessionIds: [E2E.alpha1, E2E.alpha2, E2E.ghost], createdAt: 'x', updatedAt: 'x' },
		{ workspaceId: 'ws-b', path: 'D:\\repos\\beta', title: 'Beta', sessionIds: [E2E.beta1], createdAt: 'x', updatedAt: 'x' }
	],
	archivedSessionIds: [E2E.alpha1, E2E.ghost, E2E.alpha2, E2E.beta1],
	pinnedSessionIds: [],
	state: 'idle',
	phase: 'ready',
	error: null
};

/** 会话摘要（ghost 没有摘要 —— 它已被移走）。 */
const e2eSessions = {
	byId: {
		[E2E.alpha1]: { id: E2E.alpha1, title: 'Alpha 一', cwd: 'D:\\repos\\alpha', updatedAt: 1_759_100_000_000 },
		[E2E.alpha2]: { id: E2E.alpha2, title: 'Alpha 二', cwd: 'D:\\repos\\alpha', updatedAt: 1_759_100_001_000 },
		[E2E.beta1]: { id: E2E.beta1, title: 'Beta 一', cwd: 'D:\\repos\\beta', updatedAt: 1_759_100_002_000 }
	}
};

/** `/list` 的**原始**响应体（形状照 T11/T13 实测：条目带 purgedAt / purgedBatch）。 */
const e2eListBody = {
	entries: [
		{
			entryId: `1790673301827@${E2E.ghost}`,
			sessionId: E2E.ghost,
			movedAt: '2026-09-29T09:31:38.509Z',
			originalPath: `D:\\DSH\\dsh-home\\sessions\\dsh-archive-manager\\${E2E.ghost}`,
			bytes: 132,
			cwd: 'D:\\DSH-PLUGIN\\dsh-archive-manager',
			purgedAt: '2026-09-29T09:31:38.509Z',
			purgedBatch: '20260929-093138'
		}
	]
};

/** 「一次完整渲染」：原始 `/list` 响应 → 解析 → 单点模型（不经过任何内存状态）。 */
const renderOnce = () => model.buildSectionModel({
	workspace: e2eSnapshot,
	sessions: e2eSessions,
	recycleEntries: bin.parseRecycleEntries(e2eListBody),
	optimisticGone: [],
	query: '',
	sortKey: 'updatedAt',
	selectedIds: []
});

test('T14 端到端：喂真实形状 /list 响应后，最终视图里没有已回收 id，其余 3 条分组正确', () => {
	const view = renderOnce();

	// 输入侧：归档集合确实是 4 条（证明过滤是"真发生"，不是输入本来就没有）。
	assert.equal(view.rows.length, 4, '归档全集应为 4 条');
	assert.ok(view.rows.some((row) => row.id === E2E.ghost), 'ghost 必须在归档全集里');

	// A5 判据：最终可见行与分组里都没有它。
	assert.equal(view.phase, 'ready');
	assert.equal(view.alive.length, 3, '过滤后应只剩 3 条');
	assert.equal(view.alive.some((row) => row.id === E2E.ghost), false, '最终视图不得含已回收 id');
	assert.deepEqual(view.recycledIds, [E2E.ghost]);
	assert.ok(view.listedIds.includes(E2E.ghost) === false);

	// 分组与组头条数（ws-a 本来会因 ghost 变成 3 条）。
	assert.deepEqual(view.groups.map((group) => [group.id, group.rows.length]), [['ws-a', 2], ['ws-b', 1]]);
	assert.equal(view.groups[0].title, 'Alpha 项目');
	assert.deepEqual(view.groups[0].rows.map((row) => row.id), [E2E.alpha2, E2E.alpha1]); // updatedAt 降序
	assert.equal(view.groups[1].title, 'Beta');

	// 回收站侧：条目仍在清单里，且标记为不可还原（跨刷新持久的那条台账）。
	assert.equal(view.recycleRows.length, 1);
	assert.equal(view.recycleRows[0].purged, true);
	assert.equal(view.recycleRows[0].canRestore, false);
	assert.equal(view.purgedCount, 1);
});

test('T14 可重放：同一份输入重复调用，模型逐字段相等（"刷新"= 全新状态）', () => {
	const first = renderOnce();
	const second = renderOnce();
	assert.deepEqual(second, first);
	// 深比较掩不住差异时再逐字段核一遍关键项。
	assert.deepEqual(second.recycledIds, first.recycledIds);
	assert.deepEqual(second.listedIds, first.listedIds);
	assert.deepEqual(second.groups.map((group) => [group.id, group.rows.map((row) => row.id)]),
		first.groups.map((group) => [group.id, group.rows.map((row) => row.id)]));
});

test('T14 过滤必须发生在分组之前：被清空的工作区整组消失，不留空组头', () => {
	const view = model.buildSectionModel({
		workspace: {
			...e2eSnapshot,
			// ghost 属于 ws-a；ws-a 只剩它一条 → 过滤后该组必须整体消失。
			archivedSessionIds: [E2E.ghost, E2E.beta1]
		},
		sessions: e2eSessions,
		recycleEntries: bin.parseRecycleEntries(e2eListBody),
		optimisticGone: [],
		query: '',
		sortKey: 'updatedAt',
		selectedIds: []
	});
	assert.deepEqual(view.groups.map((group) => group.id), ['ws-b']);
	assert.equal(view.alive.length, 1);
	assert.deepEqual(view.recycledIds, [E2E.ghost]);
});

test('T14 在站 + 已清空混合：两类都被过滤；搜索命中已回收 id 时不会把它"筛回来"', () => {
	const entries = bin.parseRecycleEntries({
		entries: [
			entry(E2E.alpha1),
			{
				entryId: `1790673301827@${E2E.ghost}`,
				sessionId: E2E.ghost,
				movedAt: '2026-09-29T09:31:38.509Z',
				originalPath: `D:\\x\\${E2E.ghost}`,
				bytes: 1,
				purgedAt: '2026-09-29T09:31:38.509Z',
				purgedBatch: '20260929-093138'
			}
		]
	});
	const view = model.buildSectionModel({
		workspace: e2eSnapshot,
		sessions: e2eSessions,
		recycleEntries: entries,
		optimisticGone: [],
		query: 'session-0b9de1ba', // 直接搜 ghost 的 id
		sortKey: 'updatedAt',
		selectedIds: []
	});
	assert.deepEqual(view.recycledIds, [E2E.alpha1, E2E.ghost].sort());
	assert.deepEqual(view.listedIds, [], '被过滤的 id 不该因为搜索而回到列表');
	assert.deepEqual(view.groups, []);
});

// ---------------------------------------------------------------------------
// T15：回收站页签的 SSR 测试缝（initialTab / initialRecycleEntries）
// ---------------------------------------------------------------------------

test('T15 resolveInitialTab：只认 "recycle"，其余（含未注入与误注入）一律折回 "archived"', () => {
	assert.equal(model.resolveInitialTab('recycle'), 'recycle');
	assert.equal(model.resolveInitialTab('archived'), 'archived');
	// 真实路径：插槽不传这个 prop。
	assert.equal(model.resolveInitialTab(undefined), 'archived');
	assert.equal(model.resolveInitialTab(null), 'archived');
	// 被误注入的任意值也不改变默认行为。
	assert.equal(model.resolveInitialTab('Recycle'), 'archived');
	assert.equal(model.resolveInitialTab('recycle '), 'archived');
	assert.equal(model.resolveInitialTab({ tab: 'recycle' }), 'archived');
	assert.equal(model.resolveInitialTab(1), 'archived');
});

test('T15 首屏进回收站视图：缝的值 + 一份 /list 响应 → 回收站侧有可渲染内容（Tag/禁用还原的来源）', () => {
	// 页签本身由 resolveInitialTab 决定；回收站视图的内容由模型的 recycleRows 决定。
	assert.equal(model.resolveInitialTab('recycle'), 'recycle');

	const entries = bin.parseRecycleEntries({
		entries: [
			entry(E2E.alpha1),
			{
				entryId: `1790673301827@${E2E.ghost}`,
				sessionId: E2E.ghost,
				movedAt: '2026-09-29T09:31:38.509Z',
				originalPath: `D:\\x\\${E2E.ghost}`,
				bytes: 132,
				cwd: 'D:\\DSH-PLUGIN\\dsh-archive-manager',
				purgedAt: '2026-09-29T09:31:38.509Z',
				purgedBatch: '20260929-093138'
			}
		]
	});
	const view = binView({ entries });
	// 首屏（SSR）要渲染 Tag + 禁用还原，靠的就是这两条：purged 标记与 canRestore。
	assert.equal(view.recycleRows.length, 2);
	assert.equal(view.purgedCount, 1);
	assert.deepEqual(
		view.recycleRows.map((row) => row.canRestore),
		[true, false]
	);
	assert.equal(view.recycleRows[1].entry.purgedBatch, '20260929-093138');
});

test('T15 页签仍是组件内部 state（测试缝只当初值，没有变成受控 prop）', async () => {
	const source = await readFile(join(root, 'src/client/ArchivedSessionsSection.tsx'), 'utf8');
	assert.ok(
		source.includes('useState<SectionTab>(() => resolveInitialTab(props.initialTab))'),
		'initialTab 只能作为 useState 初值使用'
	);
	assert.ok(source.includes('onChange={(next) => setTab('), '页签切换仍由组件自己管理');
	assert.ok(source.includes("props.initialRecycleEntries === undefined ? undefined : { initialEntries: props.initialRecycleEntries }"),
		'回收站预置条目走 useRecycleBin 的测试缝');
});

// ---------------------------------------------------------------------------
// T17：把「运行中」在点击之前标出来
// ---------------------------------------------------------------------------

test('T17 resolveRowRunning：状态优先、缺失回退摘要、状态存在但 running 未知按未运行', () => {
	assert.equal(model.resolveRowRunning({ running: true }, false), true);
	// 状态表里有这条就信它（可以覆盖摘要里的旧值）。
	assert.equal(model.resolveRowRunning({ running: false }, true), false);
	// 未知 → 按可删，不因为状态未知就禁用一切（要求 3）。
	assert.equal(model.resolveRowRunning({ running: undefined }, true), false);
	assert.equal(model.resolveRowRunning({}, true), false);
	// 状态表里没有这条 → 回退会话摘要。
	assert.equal(model.resolveRowRunning(undefined, true), true);
	assert.equal(model.resolveRowRunning(undefined, false), false);
});

test('T17 模型：running 的行被标记且不可回收，其余可回收（与幽灵行过滤/分组组合正确）', () => {
	const statuses = new Map([
		[E2E.alpha1, { running: true }],
		[E2E.beta1, { running: undefined }]
	]);
	const view = model.buildSectionModel({
		workspace: e2eSnapshot,
		sessions: e2eSessions,
		recycleEntries: bin.parseRecycleEntries(e2eListBody),
		optimisticGone: [],
		sessionStatus: statuses,
		query: '',
		sortKey: 'updatedAt',
		selectedIds: []
	});
	const rows = new Map(view.alive.map((row) => [row.id, row]));

	assert.equal(rows.get(E2E.alpha1).running, true, '状态 running:true → 行被标记');
	assert.equal(rows.get(E2E.alpha1).canRecycle, false, '状态 running:true → 不可移入回收站（按钮禁用）');
	assert.equal(rows.get(E2E.alpha2).running, false);
	assert.equal(rows.get(E2E.alpha2).canRecycle, true, '状态表里没有它且摘要也没有 → 可删');
	assert.equal(rows.get(E2E.beta1).running, false, 'running:undefined → 按未运行');
	assert.equal(rows.get(E2E.beta1).canRecycle, true, '未知状态不得禁用');

	// 既有行为不回退：幽灵行过滤、分组、组内计数都不受影响。
	assert.equal(view.alive.some((row) => row.id === E2E.ghost), false);
	assert.deepEqual(view.groups.map((group) => [group.id, group.rows.length]), [['ws-a', 2], ['ws-b', 1]]);
	// 运行中的行仍然可见、可被选中、可被搜索（只是不可删）。
	assert.ok(view.listedIds.includes(E2E.alpha1));
	const searched = model.buildSectionModel({
		workspace: e2eSnapshot,
		sessions: e2eSessions,
		recycleEntries: [],
		optimisticGone: [],
		sessionStatus: statuses,
		query: 'Alpha 一',
		sortKey: 'updatedAt',
		selectedIds: [E2E.alpha1]
	});
	assert.deepEqual(searched.listedIds, [E2E.alpha1]);
	assert.deepEqual(searched.selected, [E2E.alpha1]);
	assert.equal(searched.allSelected, true);
	assert.equal(searched.alive.find((row) => row.id === E2E.alpha1).canRecycle, false, '搜索不改变可删性');
});

test('T17 模型：状态表缺失时回退会话摘要的 running', () => {
	const view = model.buildSectionModel({
		workspace: e2eSnapshot,
		sessions: { byId: { ...e2eSessions.byId, [E2E.alpha2]: { ...e2eSessions.byId[E2E.alpha2], running: true } } },
		recycleEntries: [],
		optimisticGone: [],
		query: '',
		sortKey: 'updatedAt',
		selectedIds: []
	});
	const rows = new Map(view.alive.map((row) => [row.id, row]));
	assert.equal(rows.get(E2E.alpha2).running, true);
	assert.equal(rows.get(E2E.alpha2).canRecycle, false);
	assert.equal(rows.get(E2E.alpha1).canRecycle, true);
});

test('T17 回收站：运行中的条目不可还原（宿主同样拒绝 restore），purged 的原因优先', () => {
	const purgedGhost = {
		entryId: `1790673301827@${E2E.ghost}`,
		sessionId: E2E.ghost,
		movedAt: '2026-09-29T09:31:38.509Z',
		originalPath: `D:\\x\\${E2E.ghost}`,
		bytes: 1,
		purgedAt: '2026-09-29T09:31:38.509Z',
		purgedBatch: 'b1'
	};
	const entries = bin.parseRecycleEntries({
		entries: [entry(E2E.alpha1), entry(E2E.beta1), purgedGhost]
	});
	const view = binView({
		entries,
		sessionStatus: new Map([[E2E.alpha1, { running: true }], [E2E.ghost, { running: true }]])
	});
	const bySession = new Map(view.recycleRows.map((row) => [row.entry.sessionId, row]));

	assert.equal(bySession.get(E2E.alpha1).running, true);
	assert.equal(bySession.get(E2E.alpha1).canRestore, false, '运行中的条目不可还原');
	assert.equal(bySession.get(E2E.alpha1).reasonKey, 'error.session-live');
	assert.equal(bySession.get(E2E.beta1).canRestore, true);
	assert.equal(bySession.get(E2E.beta1).reasonKey, '');
	// 既已移交冷存档区、又在运行 → 原因取 purged（那是更根本的阻碍）。
	assert.equal(bySession.get(E2E.ghost).canRestore, false);
	assert.equal(bySession.get(E2E.ghost).reasonKey, 'error.entry-purged');
});

test('T17 文案：error.session-live 同时覆盖「仍在运行」与「被 DSH 加载」，新 aria 文案中英齐备', () => {
	assert.ok(locales.LOCALE_ZH['error.session-live'].includes('仍在运行'));
	assert.ok(locales.LOCALE_ZH['error.session-live'].includes('被 DSH 加载'));
	assert.ok(locales.LOCALE_EN['error.session-live'].includes('still running'));
	assert.ok(locales.LOCALE_EN['error.session-live'].includes('loaded by DSH'));
	for (const key of ['row.delete.running', 'row.delete.running.aria', 'recycle.restore.running.aria']) {
		assert.equal(typeof locales.LOCALE_ZH[key], 'string', `中文缺文案：${key}`);
		assert.equal(typeof locales.LOCALE_EN[key], 'string', `英文缺文案：${key}`);
	}
	// 「运行中」标签沿用已有 key。
	assert.equal(locales.LOCALE_ZH['row.running'], '运行中');
	assert.equal(locales.LOCALE_EN['row.running'], 'Running');
});
