/**
 * T7 客户端「按工作区分组」的**运行时**复核（T5）。
 *
 * 手法与 `test/client.test.mjs` 相同：用 esbuild 把 `src/client/useArchivedSessions.ts`
 * 打成内存 CJS、以 React 桩求值，从而**直接调用**导出的纯函数做运行时断言
 * （不依赖 `lib/**` 是否已构建，也不依赖客户端 bundle 只导出 `apply`/`inject` 这件事）。
 *
 * 数据源依据（官方，0.2.0-rc.1）：
 * - `WorkspaceSnapshot.items: readonly WorkspaceView[]`（`dsh-api-workspace-controller/lib/types/client/model.d.ts:10`）
 * - `WorkspaceView { workspaceId, path, title, sessionIds, createdAt, updatedAt }`（同包 `lib/types/types.d.ts:13-25`）
 *
 * 覆盖 lead 指定的四项 + 对抗性反例：分组映射正确性 / 零命中组隐藏 / 兜底组不丢数据 / 跨组选择，
 * 外加同一 id 出现在多个工作区、畸形 views、原型键（`toString`/`constructor`/`__proto__`）。
 *
 * 只读；不写任何文件。
 * 用法：node test/verify/client-grouping.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { build } = await import('esbuild');

/** React 桩：被测模块只在钩子体内引用 React。 */
const reactStub = {
	useMemo: (factory) => factory(),
	useState: (initial) => [initial, () => undefined],
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial }),
	useEffect: () => undefined
};

/** 把客户端源码模块打成内存 CJS 并求值，返回其 exports。 */
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

const M = await loadModule('src/client/useArchivedSessions.ts');
const {
	buildRows,
	buildWorkspaceIndex,
	groupRowsByWorkspace,
	filterGroups,
	buildGroups,
	groupsRowIds,
	normalizeSelection,
	UNASSIGNED_GROUP_ID
} = M;

for (const name of ['buildRows', 'groupRowsByWorkspace', 'buildGroups', 'groupsRowIds', 'normalizeSelection', 'UNASSIGNED_GROUP_ID']) {
	if (M[name] === undefined) {
		console.error(`FAIL 缺少导出 ${name}：客户端模块契约变了，本脚本需同步`);
		process.exit(1);
	}
}

const failures = [];
const notes = [];
const check = (ok, label, detail) => {
	if (ok) notes.push(`PASS ${label}`);
	else failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`);
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

/** 真实形状的行：由 buildRows 生成（而不是手搓对象），确保与被测实现同源。 */
const rows = buildRows([A, B, C, D, E], {
	[A]: { title: 'Alpha', cwd: 'D:\\work\\alpha', updatedAt: '2026-09-29T01:00:00.000Z' },
	[B]: { title: 'Beta', cwd: 'D:\\work\\beta', updatedAt: '2026-09-29T02:00:00.000Z' },
	[C]: { title: 'Gamma', cwd: 'D:\\work\\gamma', updatedAt: '2026-09-29T03:00:00.000Z' }
});
check(rows.length === 5, '前置：buildRows 保留 5 条（含 2 条无摘要）', `实际 ${rows.length}`);

// 官方 items 顺序：ws-2 在前、ws-1 在后；ws-empty 零命中；A/B 归 ws-2，C/D 归 ws-1，E 谁都不认领。
const views = [
	{ workspaceId: 'ws-2', title: '  工作区二  ', path: ' D:\\work\\two ', sessionIds: [A, B] },
	{ workspaceId: 'ws-1', title: '工作区一', path: 'D:\\work\\one', sessionIds: [C, D] },
	{ workspaceId: 'ws-empty', title: '空工作区', path: 'D:\\work\\empty', sessionIds: [] }
];

// --- 1. 分组映射正确性 + 组顺序 = items 顺序 + 零命中组隐藏 + 兜底组最后 ---
const groups = groupRowsByWorkspace(rows, views);
check(groups.length === 3, '产生 3 个组（2 个有命中 + 1 个兜底，零命中的 ws-empty 不出现）', JSON.stringify(groups.map((g) => g.id)));
check(groups[0]?.id === 'ws-2' && groups[1]?.id === 'ws-1' && groups[2]?.id === UNASSIGNED_GROUP_ID, '组顺序 = 官方 items 顺序，兜底组排最后', JSON.stringify(groups.map((g) => g.id)));
check(groups[0]?.rows.map((r) => r.id).join() === [A, B].join(), 'ws-2 组内是 A,B', groups[0]?.rows.map((r) => r.id).join());
check(groups[1]?.rows.map((r) => r.id).join() === [C, D].join(), 'ws-1 组内是 C,D', groups[1]?.rows.map((r) => r.id).join());
check(groups[2]?.rows.map((r) => r.id).join() === E, '兜底组恰好是未被认领的 E', groups[2]?.rows.map((r) => r.id).join());
check(groups[0]?.title === '工作区二' && groups[0]?.path === 'D:\\work\\two', '工作区 title/path 已 trim', JSON.stringify({ title: groups[0]?.title, path: groups[0]?.path }));
check(!groups.some((g) => g.id === 'ws-empty'), '零命中工作区不产生组（不出现空组头）');

// --- 2. 兜底组不丢数据：所有组的行数之和 === 输入行数 ---
{
	const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
	check(total === rows.length, '所有组行数之和 = 输入行数（无数据丢失）', `${total} vs ${rows.length}`);
	const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
	check(new Set(ids).size === ids.length, '同一行不会出现在多个组', JSON.stringify(ids));
}

// --- 3. 跨组选择：groupsRowIds 覆盖全部行且保持组顺序 ---
{
	const listed = groupsRowIds(groups);
	check(listed.length === rows.length, 'groupsRowIds 覆盖全部行（跨组全选）', `${listed.length} vs ${rows.length}`);
	check(listed.join() === [A, B, C, D, E].join(), 'groupsRowIds 顺序 = 组顺序 × 组内顺序', listed.join());
	const chosen = normalizeSelection([E, A, 'not-exist'], listed);
	check(chosen.join() === [A, E].join(), '跨组选择被规范化为列表顺序并去掉不存在的 id', chosen.join());
}

// --- 4. 构建链：buildGroups = 过滤 + 排序 + 分组（零命中组因过滤整组消失） ---
{
	const built = buildGroups(rows, views, 'Beta', 'updatedAt', 'desc');
	check(built.length === 1 && built[0].id === 'ws-2' && built[0].rows.length === 1, '关键词过滤后只剩命中组，且空组被隐藏', JSON.stringify(built.map((g) => [g.id, g.rows.length])));
	const all = buildGroups(rows, views, '', 'updatedAt', 'desc');
	check(all.reduce((sum, g) => sum + g.rows.length, 0) === rows.length, '空关键词时 buildGroups 不丢行', String(all.reduce((sum, g) => sum + g.rows.length, 0)));
}

// --- 5. 同一 id 出现在多个工作区：先到先得（确定性），且不丢行 ---
{
	const dupViews = [
		{ workspaceId: 'ws-2', title: 'two', sessionIds: [A] },
		{ workspaceId: 'ws-1', title: 'one', sessionIds: [A] }
	];
	const dup = groupRowsByWorkspace(buildRows([A], {}), dupViews);
	const index = buildWorkspaceIndex(dupViews);
	check(index[A] === 'ws-2', '重复归属时先到先得（确定性）', String(index[A]));
	check(dup.reduce((sum, g) => sum + g.rows.length, 0) === 1, '重复归属下仍只有 1 行（不重复计入）', String(dup.reduce((sum, g) => sum + g.rows.length, 0)));
}

// --- 6. 畸形 views：不得抛错、不得丢行 ---
{
	const malformed = [
		null,
		[],
		{ workspaceId: '', title: 'x', sessionIds: [A] },
		{ workspaceId: 'ws-x', title: 'x', sessionIds: 'not-an-array' },
		{ workspaceId: 'ws-y', title: 'y', sessionIds: [123, null, '', A] },
		{ workspaceId: 'ws-z', title: 'z' }
	];
	let threw = null;
	let result;
	try {
		result = groupRowsByWorkspace(buildRows([A], {}), malformed);
	} catch (error) {
		threw = error;
	}
	check(threw === null, '畸形 views 不抛错', threw === null ? undefined : String(threw?.message));
	check((result ?? []).reduce((sum, g) => sum + g.rows.length, 0) === 1, '畸形 views 下仍不丢行（A 落在 ws-y 组）', JSON.stringify((result ?? []).map((g) => [g.id, g.rows.length])));
}

// --- 7. 对抗性反例：原型键作为会话 id ---
{
	const cases = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'];
	for (const weird of cases) {
		let out;
		let error = null;
		try {
			out = groupRowsByWorkspace(buildRows([weird], {}), []);
		} catch (thrown) {
			error = thrown;
		}
		const kept = (out ?? []).reduce((sum, group) => sum + group.rows.length, 0);
		check(
			kept === 1,
			`原型键 id "${weird}" 不丢行（必须落进兜底组）`,
			error !== null ? `抛错 ${error.message}` : `组=${JSON.stringify((out ?? []).map((g) => [g.id, g.rows.length]))}`
		);
	}
}

// --- 8. 无 items 时：全部进兜底组，不丢行 ---
{
	const out = groupRowsByWorkspace(rows, undefined);
	check(out.length === 1 && out[0].id === UNASSIGNED_GROUP_ID && out[0].rows.length === rows.length, 'items 缺失时全部落兜底组且不丢行', JSON.stringify(out.map((g) => [g.id, g.rows.length])));
}

// --- 9. filterGroups 直接调用：零命中组不产生空组头 ---
{
	const filtered = filterGroups(groups, 'zzz-no-hit');
	check(filtered.length === 0, 'filterGroups：全部零命中时返回空数组（不产生空组头）', JSON.stringify(filtered.map((g) => g.id)));
	const kept = filterGroups(groups, 'Alpha');
	check(kept.length === 1 && kept[0].rows.length === 1, 'filterGroups：只保留命中组', JSON.stringify(kept.map((g) => [g.id, g.rows.length])));
}

// --- 10. resolvePhase：就绪判定的各态（含 phase 缺失时的兜底方向） ---
// 官方语义（已双源取证）：
// - 字段初值 `state = "loading"; phase = "pending"`（asar byte 17431321）；
// - 基线安装后 `this.state = "idle"; this.phase = "ready"`（asar byte 17438220）；
// - `state = "loading"` 的**唯一**运行时迁移点是 `handleCarrierFailure()`（asar byte 17439476），
//   它只置 state、不动 phase —— 所以「断线重连窗口」的真实组合是 state='loading' + phase='ready'，
//   官方注释明确此时**保留最后一份完整投影可见**。
{
	const { resolvePhase } = M;
	if (typeof resolvePhase !== 'function') {
		failures.push('resolvePhase 未导出');
	} else {
		const cases = [
			['idle+ready → ready（真实就绪）', { state: 'idle', phase: 'ready' }, 'ready'],
			['loading+pending → loading（真实加载中）', { state: 'loading', phase: 'pending' }, 'loading'],
			['error+pending → error', { state: 'error', phase: 'pending' }, 'error'],
			['error+ready → error（错误优先于就绪）', { state: 'error', phase: 'ready' }, 'error'],
			['idle 且 phase 缺失 → ready（安全方向：不永久转圈）', { state: 'idle' }, 'ready'],
			['loading 且 phase 缺失 → loading（不因缺字段而误判就绪）', { state: 'loading' }, 'loading'],
			['idle+pending → loading（phase 更保守）', { state: 'idle', phase: 'pending' }, 'loading'],
			['loading+ready → ready（断线重连：保留最后完整投影，官方 handleCarrierFailure 语义）', { state: 'loading', phase: 'ready' }, 'ready'],
			['undefined（插槽未提供工作区数据）→ unsupported', undefined, 'unsupported'],
			['空对象 → ready（无法判定时按就绪，避免永久转圈）', {}, 'ready']
		];
		for (const [label, input, expected] of cases) {
			let actual;
			let error = null;
			try {
				actual = resolvePhase(input);
			} catch (thrown) {
				error = thrown;
			}
			check(error === null && actual === expected, `resolvePhase：${label}`, error !== null ? `抛错 ${error.message}` : `实际 ${JSON.stringify(actual)}`);
		}
		// 关键不变量：只有"确实在加载"的输入才允许返回 loading
		const loadingInputs = [
			{ state: 'loading', phase: 'pending' },
			{ state: 'loading' },
			{ state: 'idle', phase: 'pending' }
		].every((input) => resolvePhase(input) === 'loading');
		check(loadingInputs, 'resolvePhase：loading 判定不吞掉真实就绪组合（idle+ready 必为 ready）', undefined);
	}
}

// --- 11. P17 修复后的新表面：自有键 / 原型污染 / 归属（对修复本身做对抗性复核） ---
{
	const protoViews = [{ workspaceId: 'ws-p', title: 'P', sessionIds: ['__proto__', 'toString'] }];
	const index = buildWorkspaceIndex(protoViews);
	check(Object.prototype.hasOwnProperty.call(index, '__proto__'), 'P17 修复：index 把 "__proto__" 存成**自有数据键**', JSON.stringify(Object.keys(index)));
	check(Object.getPrototypeOf(index) === Object.prototype, 'P17 修复：未发生原型污染（index 原型仍是 Object.prototype）', String(Object.getPrototypeOf(index)));
	check(!Object.prototype.hasOwnProperty.call(index, 'hasOwnProperty'), 'index 不含未声明的其他原型键自有属性', JSON.stringify(Object.keys(index)));

	const claimed = groupRowsByWorkspace(buildRows(['__proto__', 'toString'], {}), protoViews);
	check(claimed.length === 1 && claimed[0].id === 'ws-p' && claimed[0].rows.length === 2, 'P17 修复：被认领的原型键 id 正确归组（不丢行、不落兜底）', JSON.stringify(claimed.map((g) => [g.id, g.rows.length])));

	const unclaimed = groupRowsByWorkspace(buildRows(['__proto__'], {}), []);
	check(unclaimed.length === 1 && unclaimed[0].id === UNASSIGNED_GROUP_ID && unclaimed[0].rows.length === 1, 'P17 修复：无人认领的原型键 id 落兜底组', JSON.stringify(unclaimed.map((g) => [g.id, g.rows.length])));

	const noSummary = buildRows(['toString'], {});
	check(noSummary.length === 1 && noSummary[0].missingSummary === true, 'P17 修复：空 byId 下 id="toString" 必须 missingSummary=true（原型成员不得冒充摘要）', JSON.stringify(noSummary[0]));

	// `JSON.parse` 会产生**自有**的 `__proto__` 键，用来验证"真有该键时要用它"。
	const withProto = JSON.parse('{"__proto__":{"title":"  Proto 会话  ","cwd":"D:/p","updatedAt":1759100000000}}');
	const used = buildRows(['__proto__'], withProto);
	check(used.length === 1 && used[0].missingSummary === false && used[0].title === 'Proto 会话', 'byId 里真的存在 "__proto__" 自有键时被正确采用（title 已 trim）', JSON.stringify(used[0]));

	// 工作区 id 本身是原型键：必须是真实分组，不能被吞掉
	const protoWorkspace = groupRowsByWorkspace(buildRows(['11111111-1111-4111-8111-111111111111'], {}), [
		{ workspaceId: '__proto__', title: 'P', sessionIds: ['11111111-1111-4111-8111-111111111111'] }
	]);
	check(protoWorkspace.length === 1 && protoWorkspace[0].id === '__proto__', '工作区 id 为原型键时仍能成组', JSON.stringify(protoWorkspace.map((g) => g.id)));
}

console.log('# T7 客户端分组运行时复核（esbuild 内存求值 src/client/useArchivedSessions.ts）');
for (const note of notes) console.log(note);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? `\nPASS client-grouping（${notes.length} 项）` : `\nFAIL client-grouping（${failures.length}/${notes.length + failures.length} 项失败）`);
process.exitCode = failures.length === 0 ? 0 : 1;
