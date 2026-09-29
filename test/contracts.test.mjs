/**
 * 契约回归测试（Lead 所有）。
 *
 * 存在的原因：真机删除曾被**本插件自己的校验器**拒绝（HTTP 400 `invalid-input`），
 * 因为 `isSessionId` 只接受裸 UUID，而真实归档 id 全是 `session-<uuid>` 形态。
 * 全套单测当时全绿 —— **夹具沿用了同一个错误假设**，所以没有任何测试能发现它。
 *
 * 因此本文件做两件事：
 * 1. 显式覆盖两种真实 id 形态（含带前缀的）；
 * 2. **用本机真实 `workspace.json` 的数据喂养断言**（存在才跑，不存在则 skip），
 *    确保契约与真实数据持续对齐，而不是与我们的假设对齐。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
const {
	isSessionId,
	parseSessionIds,
	parseEntryIds,
	entryIdFor,
	parseEntryId,
	MAX_BATCH,
	recycleRoot,
	sessionsRoot
} = await import(new URL('lib/contracts.js', root).href);

/** 真实存在的两种 id 形态（第一条来自 sessions 目录，第二条来自 archivedSessionIds）。 */
const BARE_UUID = '8402fa9c-abbf-46bc-8c42-370e9401976f';
const PREFIXED_UUID = 'session-0b9de1ba-1918-40b3-8fcc-8ab15a645e50';

test('接受两种真实 id 形态（裸 UUID 与 session- 前缀 UUID）', () => {
	for (const id of [BARE_UUID, PREFIXED_UUID]) {
		assert.equal(isSessionId(id), true, `${id} 必须被接受`);
		assert.deepEqual(parseSessionIds([id]), [id]);
	}
	// 契约刻意按"安全字符集 + 有界长度"设计（不是"必须是 UUID"）：
	// 这类名字在文件系统层面无害，会被后续的"未归档"校验挡在 409，而不是 400。
	for (const id of ['session-', 'a.b_c-d', 'ABC123']) {
		assert.equal(isSessionId(id), true, `${JSON.stringify(id)} 形态安全，应被接受`);
	}
});

test('拒绝一切可能逃出 sessions 根或破坏目录名的输入', () => {
	const rejected = [
		'', '.', '..', '../..', 'a/b', 'a\\b', 'a b', 'sub/../x',
		'-leading', '.hidden', 'a'.repeat(129), 'null\u0000byte'
	];
	for (const id of rejected) {
		assert.equal(isSessionId(id), false, `${JSON.stringify(id)} 必须被拒绝`);
		assert.throws(() => parseSessionIds([id]), TypeError);
	}
});

test('会话 id 列表：去重保持顺序、空数组与超批量被拒', () => {
	assert.deepEqual(parseSessionIds([PREFIXED_UUID, BARE_UUID, PREFIXED_UUID]), [PREFIXED_UUID, BARE_UUID]);
	assert.throws(() => parseSessionIds([]), TypeError);
	assert.throws(() => parseSessionIds(Array.from({ length: MAX_BATCH + 1 }, (_, index) => `session-${index}`)), TypeError);
});

test('回收条目 id 可往返，且只接受由宿主生成的形态', () => {
	const entryId = entryIdFor(PREFIXED_UUID, 1759100000000);
	assert.equal(entryId, `1759100000000@${PREFIXED_UUID}`);
	assert.deepEqual(parseEntryId(entryId), { sessionId: PREFIXED_UUID, movedAtMs: 1759100000000 });
	assert.deepEqual(parseEntryIds([entryId, entryId]), [entryId]);
	assert.throws(() => parseEntryId(`1759100000000@${BARE_UUID}/x`), TypeError);
	assert.throws(() => parseEntryIds(['not-an-entry-id']), TypeError);
});

test('路径推导仍把会话与回收站放在预期位置', () => {
	assert.equal(sessionsRoot('D:\\DSH\\dsh-home'), 'D:\\DSH\\dsh-home\\sessions');
	assert.equal(recycleRoot('D:\\DSH\\dsh-home'), 'D:\\DSH\\dsh-home\\archive-manager\\recycle');
	assert.equal(recycleRoot('D:\\DSH\\dsh-home\\'), 'D:\\DSH\\dsh-home\\archive-manager\\recycle');
});

/**
 * 用**本机真实数据**验证契约：`$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds`
 * 每一条都必须被 `isSessionId` 接受。找不到文件时 skip（其他机器上不阻塞）。
 */
test('真实 archivedSessionIds 全部通过校验', async (context) => {
	const home = process.env.DSH_HOME ?? 'D:\\DSH\\dsh-home';
	const file = `${home}\\storages\\workspace.json`;
	if (!fs.existsSync(file)) {
		context.skip(`未找到 ${file}，跳过真实数据校验`);
		return;
	}
	const state = JSON.parse(await readFile(file, 'utf8'));
	const ids = state?.global?.archivedSessionIds ?? [];
	assert.ok(Array.isArray(ids), 'archivedSessionIds 必须是数组');
	for (const id of ids) {
		assert.equal(isSessionId(id), true, `真实归档 id ${JSON.stringify(id)} 必须通过校验`);
		assert.deepEqual(parseSessionIds([id]), [id]);
	}
	// 顺带覆盖工作区记账里的 id（可能包含裸 UUID 形态）。
	const accounted = Object.values(state?.tables?.workspaces ?? {}).flatMap((workspace) => workspace.sessionIds ?? []);
	for (const id of accounted) assert.equal(isSessionId(id), true, `真实记账 id ${JSON.stringify(id)} 必须通过校验`);
});
