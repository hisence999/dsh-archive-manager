/**
 * T3 宿主半侧测试：回收站存储层（move / restore / list / purge）与 4 个端点。
 *
 * 全部用例只在**临时目录**（`os.tmpdir()` 下新建的假 harness home）上操作，
 * 绝不触碰真实 `$DSH_HOME`。
 *
 * 关于清理：本仓库红线（`AGENTS.md` A2）禁止任何物理删除语义，因此测试**不**用
 * `rm -r` 清理临时目录；临时目录留在系统 temp 下由系统回收。测试内部也从不使用
 * 删除 API —— 最后一条用例会对构建产物做「无删除语义调用」的静态守卫。
 *
 * 宿主要跑通本文件，先执行 `node scripts/build.mjs`（测试导入的是 `lib/**` 产物）。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { createRecycleStore, readSessionHeader, resolveHomeDir } from '../lib/host/recycle-store.js';
import { registerArchiveManagerRoutes } from '../lib/host/routes.js';
import { HOST_ROUTES, entryIdFor, parseEntryId } from '../lib/contracts.js';

/** 建一个假的 harness home（临时目录）。 */
async function makeHome() {
	return mkdtemp(join(tmpdir(), 'dsh-archive-manager-test-'));
}

/** 写一个会话目录：`<home>/sessions/<slug>/<sessionId>/`。 */
async function makeSession(home, sessionId, options = {}) {
	const { slug = '--C-Users-25286--', cwd = 'C:\\Users\\25286', delegationDepth = 0, payload = 'x'.repeat(128) } = options;
	const directory = join(home, 'sessions', slug, sessionId);
	await mkdir(directory, { recursive: true });
	const header = { type: 'session', version: 4, id: sessionId, createdAt: 1790476892885, cwd, isSeeded: false, delegationDepth, agentPreset: 'standard' };
	const transcript = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'message', payload })}\n`;
	await writeFile(join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(transcript, 'utf8')));
	await writeFile(join(directory, 'notes.txt'), 'attachment-bytes');
	return directory;
}

/** 递归快照目录树（名字 + 大小 + 类型），用于断言「磁盘零改动」。 */
async function snapshot(root) {
	const lines = [];
	async function walk(current) {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const full = join(current, entry.name);
			const stat = await lstat(full);
			const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
			lines.push(`${full.slice(root.length)}|${kind}|${stat.size}`);
			if (kind === 'dir') await walk(full);
		}
	}
	await walk(root);
	return lines.join('\n');
}

/** 在回收站里手工造一个条目（manifest 可控），用于反例。 */
async function craftEntry(home, entryId, manifest, options = {}) {
	const { withSession = true } = options;
	const directory = join(home, 'archive-manager', 'recycle', entryId);
	await mkdir(directory, { recursive: true });
	if (withSession) {
		await mkdir(join(directory, 'session'), { recursive: true });
		await writeFile(join(directory, 'session', 'session.v4.jsonl.zstd'), 'fake');
	}
	if (manifest !== undefined) await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
	return directory;
}

/**
 * 一个可控的假 Context，只实现本插件用到的最小面。
 * @param options.live 视为「正在运行」的会话 id 集合。
 * @param options.archived 官方 `workspaceRegistry.archivedSessionIds`（默认三个测试会话都算已归档）。
 * @param options.sessionsAvailable 为 false 时 `ctx.get('sessions')` 返回 undefined（模拟服务缺失）。
 * @param options.registryAvailable 为 false 时 `ctx.get('workspaceRegistry')` 返回 undefined。
 */
function fakeContext(options = {}) {
	const { live = new Set(), archived = [SESSION_A, SESSION_B, SESSION_C], sessionsAvailable = true, registryAvailable = true } = options;
	const routes = new Map();
	const disposers = [];
	return {
		routes,
		disposers,
		ctx: {
			connection: {
				fetch: {
					register(route) {
						routes.set(route.path, route);
						const dispose = async () => {
							routes.delete(route.path);
						};
						disposers.push(dispose);
						return dispose;
					}
				}
			},
			get(name) {
				if (name === 'sessions') {
					return sessionsAvailable
						? { get: (sessionId) => (live.has(sessionId) ? { id: sessionId } : undefined), list: () => [] }
						: undefined;
				}
				if (name === 'workspaceRegistry') {
					// 与官方一致：`archivedSessionIds` 是同步 getter（dsh-workspace/lib/index.js:504-505）
					return registryAvailable ? { get archivedSessionIds() { return archived; } } : undefined;
				}
				return undefined;
			},
			effect(callback) {
				disposers.push(callback());
				return () => {};
			}
		}
	};
}

/** 注册端点（临时把 DSH_HOME 指向假 home，注册后立刻还原）。 */
function registerWithHome(home, options) {
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const fake = fakeContext(options);
		registerArchiveManagerRoutes(fake.ctx);
		return fake;
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
}

/** 调一个已注册端点的 fetch。 */
async function callRoute(fake, path, options = {}) {
	const route = fake.routes.get(path);
	assert.ok(route, `端点未注册：${path}`);
	const { method = route.methods[0], body } = options;
	// HOST_ROUTES 自带 `/api/` 前缀，这里不再补前缀。
	const request = new Request(`http://127.0.0.1${path}`, {
		method,
		...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
	});
	const response = await route.fetch(request);
	const text = await response.text();
	return { status: response.status, headers: response.headers, body: text.length === 0 ? undefined : JSON.parse(text) };
}

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';

test('recycle：把会话目录整体移入回收站，并写全字段清单', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const original = await makeSession(home, SESSION_A);

	const result = await store.recycle([SESSION_A]);
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.moved, [SESSION_A]);
	assert.equal(existsSync(original), false, '源目录必须已经不在原处');

	const entries = await store.list();
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.equal(entry.sessionId, SESSION_A);
	assert.equal(entry.originalPath, original);
	assert.equal(entry.cwd, 'C:\\Users\\25286');
	assert.equal(entry.title, undefined);
	assert.match(entry.entryId, /^\d{1,17}@11111111-1111-4111-8111-111111111111$/);
	assert.equal(parseEntryId(entry.entryId).sessionId, SESSION_A);
	assert.ok(!Number.isNaN(Date.parse(entry.movedAt)));
	// 字节数 = 转录 + 附加文件（>0，且与磁盘实际一致）
	assert.equal(entry.bytes, (await lstat(join(home, 'archive-manager', 'recycle', entry.entryId, 'session', 'session.v4.jsonl.zstd'))).size
		+ (await lstat(join(home, 'archive-manager', 'recycle', entry.entryId, 'session', 'notes.txt'))).size);

	// manifest.json 与 list() 的返回一致，且目录名就是 entryId
	const manifest = JSON.parse(await readFile(join(home, 'archive-manager', 'recycle', entry.entryId, 'manifest.json'), 'utf8'));
	assert.deepEqual(manifest, entry);
});

test('restore：按清单移回原路径，条目不再出现在回收站清单里', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const original = await makeSession(home, SESSION_A);
	const before = await readFile(join(original, 'notes.txt'), 'utf8');

	await store.recycle([SESSION_A]);
	const [entry] = await store.list();
	const restored = await store.restore([entry.entryId]);
	assert.deepEqual(restored.failed, []);
	assert.deepEqual(restored.restored, [entry.entryId]);
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), true, '会话工件必须回到原路径');
	assert.equal(await readFile(join(original, 'notes.txt'), 'utf8'), before);
	assert.equal(existsSync(join(home, 'archive-manager', 'recycle', entry.entryId, 'session')), false);
	assert.deepEqual(await store.list(), [], '已还原的条目不再上报');
	// 「痕迹」保留：条目目录与清单仍在（不删除任何东西）
	assert.equal(existsSync(join(home, 'archive-manager', 'recycle', entry.entryId, 'manifest.json')), true);
});

/** 递归累计目录字节数（测试用，与实现里的统计口径一致：跳过符号链接）。 */
async function directoryBytes(directory) {
	let total = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(full);
		else if (entry.isFile()) total += (await lstat(full)).size;
	}
	return total;
}

test('purge（T11）：只移交载荷、保留台账，list 仍报告且带 purgedAt/purgedBatch', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home, now: () => 1790476892885 });
	await makeSession(home, SESSION_A);
	await makeSession(home, SESSION_B, { slug: '--D-DSH--' });
	await store.recycle([SESSION_A, SESSION_B]);
	const entries = await store.list();
	assert.equal(entries.length, 2);

	const purged = await store.purge();
	assert.deepEqual(purged, { purged: 2, failed: [] });

	// ① 台账留在回收站原地，并打上 purgedAt/purgedBatch
	const listed = await store.list();
	assert.equal(listed.length, 2, '已清空的条目仍要上报（客户端靠它过滤幽灵行）');
	assert.deepEqual(new Set(listed.map((entry) => entry.entryId)), new Set(entries.map((entry) => entry.entryId)));
	for (const entry of listed) {
		assert.equal(entry.purgedAt, new Date(1790476892885).toISOString());
		assert.equal(typeof entry.purgedBatch, 'string');
		assert.equal(entry.bytes, entries.find((item) => item.entryId === entry.entryId).bytes, 'bytes 语义仍是「当初移走的字节数」');
	}
	const batchName = listed[0].purgedBatch;
	assert.equal(listed[1].purgedBatch, batchName, '同一批次');

	const recycleEntries = await readdir(join(home, 'archive-manager', 'recycle'));
	assert.deepEqual(recycleEntries.sort(), entries.map((entry) => entry.entryId).sort(), '条目目录仍在回收站里');
	for (const entry of entries) {
		const entryDirectory = join(home, 'archive-manager', 'recycle', entry.entryId);
		assert.equal(existsSync(join(entryDirectory, 'manifest.json')), true, '台账必须在原地');
		assert.equal(existsSync(join(entryDirectory, 'session')), false, '载荷必须已经离开回收站');
	}

	// ② 载荷原封不动躺在冷存档区，字节数与 manifest.bytes 一致
	const batchDirectory = join(home, 'archive-manager', 'purged', batchName);
	for (const entry of entries) {
		const moved = join(batchDirectory, entry.entryId, 'session', 'session.v4.jsonl.zstd');
		assert.equal(existsSync(moved), true, `移交后必须保留：${moved}`);
		assert.equal(await directoryBytes(join(batchDirectory, entry.entryId, 'session')), entry.bytes, '冷存档字节数必须与台账一致');
	}

	// ③ batch.json 审计
	const batch = JSON.parse(await readFile(join(batchDirectory, 'batch.json'), 'utf8'));
	assert.equal(batch.sourceRoot, join(home, 'archive-manager', 'recycle'));
	assert.equal(batch.batch, batchName);
	assert.equal(batch.purgedAt, new Date(1790476892885).toISOString());
	assert.deepEqual(batch.skipped, []);
	assert.equal(batch.entries.length, 2);
});

test('purge（T11）幂等：重复清空不搬运、不报错、purgedAt 取首次时间', async () => {
	const home = await makeHome();
	let clock = 1790476892885;
	const store = createRecycleStore({ homeDir: home, now: () => clock });
	await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);

	const first = await store.purge();
	assert.equal(first.purged, 1);
	const [afterFirst] = await store.list();
	assert.equal(afterFirst.purgedAt, new Date(1790476892885).toISOString());

	// 时间前进后再清空：不得重复搬运，也不得覆盖首次 purgedAt
	clock = 1790476999999;
	const second = await store.purge();
	assert.deepEqual(second, { purged: 0, failed: [] }, '已清空的条目不再计数、也不报错');
	const [afterSecond] = await store.list();
	assert.equal(afterSecond.purgedAt, afterFirst.purgedAt, 'purgedAt 取首次移交时间');
	assert.equal(afterSecond.purgedBatch, afterFirst.purgedBatch);
	// 冷存档里只有一个批次、一份载荷
	const batches = await readdir(join(home, 'archive-manager', 'purged'));
	assert.equal(batches.length, 1);
	assert.equal(existsSync(join(home, 'archive-manager', 'purged', batches[0], afterFirst.entryId, 'session', 'session.v4.jsonl.zstd')), true);
});

test('restore（T11）：已清空的条目 → failed[entry-purged]，载荷在冷存档区', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home, now: () => 1790476892885 });
	const original = await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);
	const [entry] = await store.list();
	await store.purge();
	const [purgedEntry] = await store.list();

	const result = await store.restore([entry.entryId]);
	assert.deepEqual(result.restored, []);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].id, entry.entryId);
	assert.equal(result.failed[0].code, 'entry-purged');
	assert.match(result.failed[0].message, /冷存档区/);
	assert.equal(existsSync(original), false, '不得把原路径当成还原成功');
	// 载荷仍在冷存档区（人工可找回），台账也仍在回收站
	assert.equal(typeof purgedEntry.purgedBatch, 'string');
	assert.equal(
		existsSync(join(home, 'archive-manager', 'purged', purgedEntry.purgedBatch, entry.entryId, 'session', 'session.v4.jsonl.zstd')),
		true
	);
	assert.equal(existsSync(join(home, 'archive-manager', 'recycle', entry.entryId, 'manifest.json')), true);
});

test('purge：符号链接条目记入 failed[path-unsafe] 并原地保留（F3/P6）', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);
	const [entry] = await store.list();

	// 往回收站里塞一个指向外部的 junction：它不是可移交的条目
	const outside = join(home, 'outside-target');
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, 'keep.txt'), 'untouched');
	const linkName = entryIdFor(SESSION_B, 1790476892885);
	await symlink(outside, join(home, 'archive-manager', 'recycle', linkName), 'junction');

	const result = await store.purge();
	assert.equal(result.purged, 1, '只移交普通目录条目');
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].id, linkName);
	assert.equal(result.failed[0].code, 'path-unsafe');
	assert.match(result.failed[0].message, /符号链接/);

	// 链接与它的目标都原地保留，未被跟随、未被移交、未被删除
	const link = join(home, 'archive-manager', 'recycle', linkName);
	assert.equal((await lstat(link)).isSymbolicLink(), true, '符号链接条目必须原地保留');
	assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'untouched');

	// 审计：batch.json 记录了被跳过的条目
	const batches = await readdir(join(home, 'archive-manager', 'purged'));
	const batch = JSON.parse(await readFile(join(home, 'archive-manager', 'purged', batches[0], 'batch.json'), 'utf8'));
	assert.deepEqual(batch.skipped, [linkName]);
});

test('list()（T11）：坏条目与已还原痕迹都不上报，只上报台账可信的条目', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);
	const [entry] = await store.list();

	// 坏条目一：有载荷但没有清单
	await craftEntry(home, entryIdFor(SESSION_B, 1790476892885), undefined);
	// 坏条目二：清单 JSON 语法损坏
	const broken = entryIdFor(SESSION_C, 1790476892885);
	await mkdir(join(home, 'archive-manager', 'recycle', broken, 'session'), { recursive: true });
	await writeFile(join(home, 'archive-manager', 'recycle', broken, 'manifest.json'), '{ not json');
	// 坏条目三：清单与目录名/会话 id 不自洽
	const mismatched = entryIdFor(SESSION_A, 1790476999999);
	await mkdir(join(home, 'archive-manager', 'recycle', mismatched, 'session'), { recursive: true });
	await writeFile(
		join(home, 'archive-manager', 'recycle', mismatched, 'manifest.json'),
		JSON.stringify({ entryId: 'x', sessionId: SESSION_A })
	);

	assert.deepEqual((await store.list()).map((item) => item.entryId), [entry.entryId], '只上报台账可信的条目');

	// 已还原的痕迹（无载荷、无 purgedAt）同样不上报
	const restored = await store.restore([entry.entryId]);
	assert.deepEqual(restored.failed, []);
	assert.deepEqual(await store.list(), []);
});

/** 在冷存档区手工造一个条目目录（模拟旧布局 / P19 形态）。 */
async function craftPurgedEntry(home, batch, entryId, options = {}) {
	const { manifest, withSession = true, withManifest = true, batchJson } = options;
	const directory = join(home, 'archive-manager', 'purged', batch, entryId);
	if (withSession) {
		await mkdir(join(directory, 'session'), { recursive: true });
		await writeFile(join(directory, 'session', 'session.v4.jsonl.zstd'), 'cold');
	} else {
		await mkdir(directory, { recursive: true });
	}
	if (withManifest && manifest !== undefined) await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
	if (batchJson !== undefined) await writeFile(join(home, 'archive-manager', 'purged', batch, 'batch.json'), JSON.stringify(batchJson));
	return directory;
}

test('list()（T13）① 旧布局：台账随载荷躺在冷存档区、回收站根为空，也必须上报', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	// 模拟 T11 之前的旧代码：整个条目目录被搬到 purged/<批次>/<entryId>/
	const withBatchJson = entryIdFor(SESSION_A, 1790476892885);
	await craftPurgedEntry(home, '20260929-093450', withBatchJson, {
		manifest: { entryId: withBatchJson, sessionId: SESSION_A, movedAt: new Date(1790476892885).toISOString(), originalPath: join(home, 'sessions', '--slug--', SESSION_A), bytes: 4, cwd: 'C:\\Users\\25286' },
		batchJson: { purgedAt: '2026-09-29T09:34:50.000Z', sourceRoot: join(home, 'archive-manager', 'recycle'), entries: [], skipped: [] }
	});
	// 再造一条「batch.json 也丢了」的，purgedAt 由批次目录名推导
	const withoutBatchJson = entryIdFor(SESSION_B, 1790476999999);
	await craftPurgedEntry(home, '20260929-101112', withoutBatchJson, {
		manifest: { entryId: withoutBatchJson, sessionId: SESSION_B, movedAt: new Date(1790476999999).toISOString(), originalPath: join(home, 'sessions', '--D-DSH--', SESSION_B), bytes: 4 }
	});
	assert.deepEqual(await readdir(join(home, 'archive-manager', 'recycle')).catch(() => []), [], '回收站根为空（旧布局）');

	const listed = await store.list();
	assert.equal(listed.length, 2, '工件被本插件移走过就必须能上报');
	const first = listed.find((item) => item.entryId === withBatchJson);
	assert.equal(first.purgedAt, '2026-09-29T09:34:50.000Z', 'purgedAt 由 batch.json 推导');
	assert.equal(first.purgedBatch, '20260929-093450');
	const second = listed.find((item) => item.entryId === withoutBatchJson);
	assert.equal(second.purgedAt, new Date(Date.UTC(2026, 8, 29, 10, 11, 12)).toISOString(), 'batch.json 也丢时由批次目录名推导');
	assert.equal(second.purgedBatch, '20260929-101112');
	for (const item of listed) assert.equal(item.bytes, 4);
});

test('list()（T13）② P19：载荷已走、台账未标记 → 仍按已清空上报', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);
	const [entry] = await store.list();

	// 手工复刻「载荷搬走了、写台账失败且回滚失败」：载荷进冷存档，回收站根台账保持无 purgedAt
	const batch = '20260929-101500';
	await craftPurgedEntry(home, batch, entry.entryId, {
		withManifest: false,
		withSession: false,
		batchJson: { purgedAt: '2026-09-29T10:15:00.000Z', batch, entries: [], skipped: [] }
	});
	await rename(
		join(home, 'archive-manager', 'recycle', entry.entryId, 'session'),
		join(home, 'archive-manager', 'purged', batch, entry.entryId, 'session')
	);
	assert.equal(existsSync(join(home, 'archive-manager', 'recycle', entry.entryId, 'session')), false);

	const listed = await store.list();
	assert.equal(listed.length, 1, 'P19 窗口必须关闭：不能因为台账没标记就不上报');
	assert.equal(listed[0].entryId, entry.entryId);
	assert.equal(listed[0].purgedAt, '2026-09-29T10:15:00.000Z', 'purgedAt 由 batch.json 推导');
	assert.equal(listed[0].purgedBatch, batch);

	// 幂等：载荷已不在回收站根，再 purge 不会重复搬运
	assert.deepEqual(await store.purge(), { purged: 0, failed: [] });
});

test('list()（T13）③ 两处都有台账 → 去重只出一条，字段以回收站根那份为准', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const entryId = entryIdFor(SESSION_A, 1790476892885);
	const originalPath = join(home, 'sessions', '--slug--', SESSION_A);
	// 回收站根：只有台账、没有载荷（bytes=111 作为「谁说了算」的记号）
	await craftEntry(home, entryId, { entryId, sessionId: SESSION_A, movedAt: new Date(1790476892885).toISOString(), originalPath, bytes: 111 }, { withSession: false });
	// 冷存档：旧布局的副本台账（bytes=222）+ 载荷
	await craftPurgedEntry(home, '20260929-110000', entryId, {
		manifest: { entryId, sessionId: SESSION_A, movedAt: new Date(1790476892885).toISOString(), originalPath, bytes: 222 },
		batchJson: { purgedAt: '2026-09-29T11:00:00.000Z', batch: '20260929-110000', entries: [], skipped: [] }
	});

	const listed = await store.list();
	assert.equal(listed.length, 1, '同一 entryId 必须去重');
	assert.equal(listed[0].bytes, 111, '字段以回收站根那份为准');
	assert.equal(listed[0].purgedBatch, '20260929-110000', '载荷实际所在批次');
	assert.equal(listed[0].purgedAt, '2026-09-29T11:00:00.000Z');
});

test('restore（T13）④ 载荷不在回收站根 → 三种形态都回 entry-purged', async () => {
	// (a) T11 新布局：purge() 之后（回收站根有台账 + purgedAt，载荷在冷存档）
	const homeA = await makeHome();
	const storeA = createRecycleStore({ homeDir: homeA, now: () => 1790476892885 });
	await makeSession(homeA, SESSION_A);
	await storeA.recycle([SESSION_A]);
	const [entryA] = await storeA.list();
	await storeA.purge();
	const caseA = await storeA.restore([entryA.entryId]);

	// (b) P19：载荷在冷存档、台账无标记
	const homeB = await makeHome();
	const storeB = createRecycleStore({ homeDir: homeB });
	await makeSession(homeB, SESSION_A);
	await storeB.recycle([SESSION_A]);
	const [entryB] = await storeB.list();
	const batchB = '20260929-120000';
	await craftPurgedEntry(homeB, batchB, entryB.entryId, {
		withManifest: false,
		withSession: false,
		batchJson: { purgedAt: '2026-09-29T12:00:00.000Z', batch: batchB, entries: [], skipped: [] }
	});
	await rename(
		join(homeB, 'archive-manager', 'recycle', entryB.entryId, 'session'),
		join(homeB, 'archive-manager', 'purged', batchB, entryB.entryId, 'session')
	);
	const caseB = await storeB.restore([entryB.entryId]);

	// (c) 旧布局：台账与载荷都在冷存档，回收站根没有该条目
	const homeC = await makeHome();
	const storeC = createRecycleStore({ homeDir: homeC });
	const entryIdC = entryIdFor(SESSION_C, 1790476892885);
	await craftPurgedEntry(homeC, '20260929-130000', entryIdC, {
		manifest: { entryId: entryIdC, sessionId: SESSION_C, movedAt: new Date(1790476892885).toISOString(), originalPath: join(homeC, 'sessions', '--slug--', SESSION_C), bytes: 4 },
		batchJson: { purgedAt: '2026-09-29T13:00:00.000Z', batch: '20260929-130000', entries: [], skipped: [] }
	});
	const caseC = await storeC.restore([entryIdC]);

	const cases = [
		['新布局', caseA, entryA.entryId, /20260927-024132/],
		['P19', caseB, entryB.entryId, /20260929-120000/],
		['旧布局', caseC, entryIdC, /20260929-130000/]
	];
	for (const [label, result, entryId, batchPattern] of cases) {
		assert.deepEqual(result.restored, [], `${label}：不得报告还原成功`);
		assert.equal(result.failed.length, 1, label);
		assert.equal(result.failed[0].id, entryId, label);
		assert.equal(result.failed[0].code, 'entry-purged', label);
		assert.match(result.failed[0].message, /冷存档区/, label);
		assert.match(result.failed[0].message, batchPattern, `${label}：措辞里带上冷存档批次`);
	}
});

test('路径安全：非法会话 ID 一律失败，且磁盘零改动', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const original = await makeSession(home, SESSION_A);
	const before = await snapshot(home);
	// 形态不合法（含路径穿越/绝对路径/空串/把路径当 id 传）→ invalid-input
	const shapeInvalid = ['../../etc/passwd', '..\\..\\Windows', 'C:\\Windows\\System32', '/etc/passwd', '', original];
	// 形态合法但磁盘上不存在 → session-missing
	// （2026-09-29 契约修正：会话 id 按"安全字符集 + 有界长度"校验，接受真实的 `session-<uuid>`
	//   与裸 UUID 两种形态，故 `not-a-uuid` 这类是"合法但不存在"，不再是非法输入。见 PLAN §10.10）
	const shapeValidMissing = ['session-1', 'not-a-uuid', '11111111-1111-4111-8111-11111111111Z'];

	const invalid = await store.recycle(shapeInvalid);
	assert.deepEqual(invalid.moved, []);
	assert.equal(invalid.failed.length, shapeInvalid.length);
	for (const failure of invalid.failed) {
		assert.equal(failure.code, 'invalid-input', '非法会话 ID 的逐条失败码');
		assert.ok(failure.message.length > 0);
	}

	const missing = await store.recycle(shapeValidMissing);
	assert.deepEqual(missing.moved, []);
	for (const failure of missing.failed) {
		assert.equal(failure.code, 'session-missing', '合法但不存在的会话');
		assert.ok(failure.message.length > 0);
	}

	assert.equal(await snapshot(home), before, '非法输入必须磁盘零改动');
	assert.equal(existsSync(join(home, 'archive-manager')), false, '不得为非法输入创建回收站');
});

test('路径安全：源目录是符号链接 → 拒绝并说明原因', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const realTarget = join(home, 'elsewhere', SESSION_A);
	await mkdir(realTarget, { recursive: true });
	await writeFile(join(realTarget, 'session.v4.jsonl.zstd'), 'real');
	const slugDirectory = join(home, 'sessions', '--C-Users-25286--');
	await mkdir(slugDirectory, { recursive: true });
	await symlink(realTarget, join(slugDirectory, SESSION_A), 'junction');
	const before = await snapshot(home);

	const result = await store.recycle([SESSION_A]);
	assert.deepEqual(result.moved, []);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].code, 'path-unsafe');
	assert.match(result.failed[0].message, /符号链接/);
	assert.equal(await snapshot(home), before, '拒绝时必须磁盘零改动');
});

test('路径安全：源不是目录、或根本不存在 → 拒绝', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const slugDirectory = join(home, 'sessions', '--C-Users-25286--');
	await mkdir(slugDirectory, { recursive: true });
	await writeFile(join(slugDirectory, SESSION_A), 'i am a file');
	const before = await snapshot(home);

	const asFile = await store.recycle([SESSION_A]);
	assert.equal(asFile.failed.length, 1);
	assert.equal(asFile.failed[0].code, 'path-unsafe');
	assert.match(asFile.failed[0].message, /不是普通目录/);
	const missing = await store.recycle([SESSION_B]);
	assert.equal(missing.failed.length, 1);
	assert.equal(missing.failed[0].code, 'session-missing');
	assert.match(missing.failed[0].message, /未找到/);
	assert.equal(await snapshot(home), before);
});

test('路径安全：非法 entryId 不触碰磁盘', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const before = await snapshot(home);
	// 形态不合法 → invalid-input（含路径穿越、绝对路径、缺 `@`、段超长、含分隔符）
	const shapeInvalid = ['../../etc/passwd', '..\\x', 'C:\\Windows', 'abc', '', '99999999999999999999@' + SESSION_A, '1@a/b'];
	// 形态合法但回收站里不存在 → entry-not-found
	// （2026-09-29 契约修正：会话 id 按"安全字符集 + 有界长度"校验，接受真实的 `session-<uuid>`
	//   与裸 UUID 两种形态，因此 `not-a-uuid` 属于"合法但不存在的条目"，不再算非法输入。见 PLAN §10.10）
	const shapeValidAbsent = ['1@not-a-uuid', `1@${SESSION_A.slice(0, -1)}`];

	const invalid = await store.restore(shapeInvalid);
	assert.deepEqual(invalid.restored, []);
	assert.equal(invalid.failed.length, shapeInvalid.length);
	for (const failure of invalid.failed) assert.equal(failure.code, 'invalid-input', '非法 entryId 的逐条失败码');

	const absent = await store.restore(shapeValidAbsent);
	assert.deepEqual(absent.restored, []);
	assert.equal(absent.failed.length, shapeValidAbsent.length);
	for (const failure of absent.failed) assert.equal(failure.code, 'entry-not-found', '合法但不存在的条目');

	assert.equal(await snapshot(home), before);
});

test('路径安全：条目不存在 / 清单缺失损坏 → 拒绝', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const missingId = entryIdFor(SESSION_A, 1790476892885);
	const absent = await store.restore([missingId]);
	assert.deepEqual(absent.restored, []);
	assert.equal(absent.failed[0].code, 'entry-not-found');
	assert.match(absent.failed[0].message, /没有该条目/);

	// 有目录、有 session/，但没有 manifest.json
	await craftEntry(home, missingId, undefined);
	const noManifest = await store.restore([missingId]);
	assert.deepEqual(noManifest.restored, []);
	assert.equal(noManifest.failed[0].code, 'entry-not-found');
	assert.match(noManifest.failed[0].message, /缺失或损坏/);

	// 清单与目录名/会话 id 不自洽
	await writeFile(join(home, 'archive-manager', 'recycle', missingId, 'manifest.json'), JSON.stringify({ entryId: 'x', sessionId: SESSION_A }));
	const mismatched = await store.restore([missingId]);
	assert.deepEqual(mismatched.restored, []);
	assert.equal(mismatched.failed[0].code, 'entry-not-found');
	assert.match(mismatched.failed[0].message, /缺失或损坏/);
});

test('路径安全：清单里的 originalPath 越界 / 层级不对 → 拒绝', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const sessionsRoot = join(home, 'sessions');
	const outside = join(home, 'evil');
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, 'keep.txt'), 'untouched');
	const before = await snapshot(join(home, 'evil'));

	const cases = [
		{ label: '完全在 sessions 之外', originalPath: join(outside, SESSION_A), code: 'path-unsafe' },
		{ label: '就是 sessions 根', originalPath: sessionsRoot, code: 'path-unsafe' },
		{ label: '层级不足（缺 slug）', originalPath: join(sessionsRoot, SESSION_A), code: 'path-unsafe' },
		{ label: '层级过深', originalPath: join(sessionsRoot, '--slug--', SESSION_A, 'deeper'), code: 'path-unsafe' },
		{ label: '末段不是本会话', originalPath: join(sessionsRoot, '--slug--', SESSION_B), code: 'path-unsafe' },
		{ label: '相对路径', originalPath: 'sessions\\--slug--\\' + SESSION_A, code: 'entry-not-found' }
	];
	for (const [index, item] of cases.entries()) {
		const entryId = entryIdFor(index % 2 === 0 ? SESSION_A : SESSION_B, 1790476892885 + index);
		await craftEntry(home, entryId, {
			entryId,
			sessionId: parseEntryId(entryId).sessionId,
			movedAt: new Date(parseEntryId(entryId).movedAtMs).toISOString(),
			originalPath: item.originalPath,
			bytes: 4
		});
		const result = await store.restore([entryId]);
		assert.deepEqual(result.restored, [], `${item.label}：必须拒绝`);
		assert.equal(result.failed[0].code, item.code, item.label);
		assert.match(result.failed[0].message, /原始路径|缺失或损坏/, item.label);
	}
	assert.equal(await snapshot(join(home, 'evil')), before, '越界路径不得被触碰');
});

test('路径安全：还原目标已存在 → 拒绝覆盖；父目录不存在 → 拒绝静默创建', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const original = await makeSession(home, SESSION_A);
	await store.recycle([SESSION_A]);
	const [entry] = await store.list();

	// 抢占原路径，写入与回收站不同的内容
	await mkdir(original, { recursive: true });
	await writeFile(join(original, 'mine.txt'), 'do-not-overwrite');
	const occupied = await store.restore([entry.entryId]);
	assert.deepEqual(occupied.restored, []);
	assert.equal(occupied.failed[0].code, 'entry-conflict');
	assert.match(occupied.failed[0].message, /已存在/);
	assert.equal(await readFile(join(original, 'mine.txt'), 'utf8'), 'do-not-overwrite');
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), false, '不得覆盖已存在的目录');

	// 父（cwd-slug）目录不存在：清单合法但父目录缺席
	const missingParentSlug = '--slug-that-does-not-exist--';
	const orphanId = entryIdFor(SESSION_C, 1790476892885);
	await craftEntry(home, orphanId, {
		entryId: orphanId,
		sessionId: SESSION_C,
		movedAt: new Date(1790476892885).toISOString(),
		originalPath: join(home, 'sessions', missingParentSlug, SESSION_C),
		bytes: 4
	});
	const orphan = await store.restore([orphanId]);
	assert.deepEqual(orphan.restored, []);
	assert.equal(orphan.failed[0].code, 'entry-conflict');
	assert.match(orphan.failed[0].message, /原工作区目录不存在/);
	assert.equal(existsSync(join(home, 'sessions', missingParentSlug)), false, '不得静默创建到别处');
});

test('子代理子会话：只记入 failed，不做跨会话级联', async () => {
	const home = await makeHome();
	const store = createRecycleStore({ homeDir: home });
	const original = await makeSession(home, SESSION_A, { delegationDepth: 1 });

	const result = await store.recycle([SESSION_A]);
	assert.deepEqual(result.moved, []);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].code, 'child-session');
	assert.match(result.failed[0].message, /子代理子会话/);
	assert.match(result.failed[0].message, /delegationDepth=1/);
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), true, '源目录必须原样保留');
});

test('运行中的会话：拒绝移入回收站与还原', async () => {
	const home = await makeHome();
	const original = await makeSession(home, SESSION_A);
	const live = createRecycleStore({ homeDir: home, isSessionLive: (sessionId) => sessionId === SESSION_A });
	const blocked = await live.recycle([SESSION_A]);
	assert.deepEqual(blocked.moved, []);
	assert.equal(blocked.failed[0].code, 'session-live');
	assert.match(blocked.failed[0].message, /正在运行/);
	assert.equal(existsSync(original), true);

	// 还原侧同样拦截
	const offline = createRecycleStore({ homeDir: home });
	await offline.recycle([SESSION_A]);
	const [entry] = await offline.list();
	const restoreBlocked = await live.restore([entry.entryId]);
	assert.deepEqual(restoreBlocked.restored, []);
	assert.equal(restoreBlocked.failed[0].code, 'session-live');
	assert.match(restoreBlocked.failed[0].message, /正在运行/);
});

test('跨卷（EXDEV）：拒绝移交，不做「复制 + 删源」兜底', async () => {
	const home = await makeHome();
	await makeSession(home, SESSION_A);
	const beforeSessions = await snapshot(join(home, 'sessions'));
	const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
	// 真实 rename 的跨卷行为：失败即返回，不产生任何副本
	const store = createRecycleStore({
		homeDir: home,
		moveDirectory: async (from, to) => {
			if (from.includes('sessions')) throw exdev;
			await rename(from, to);
		}
	});
	const original = join(home, 'sessions', '--C-Users-25286--', SESSION_A);

	const result = await store.recycle([SESSION_A]);
	assert.deepEqual(result.moved, []);
	assert.equal(result.failed[0].code, 'cross-device');
	assert.match(result.failed[0].message, /跨卷/);
	assert.match(result.failed[0].message, /同一卷后再试/, 'EXDEV 必须提示用户手动移到同卷');
	assert.match(result.failed[0].message, /已原地保留|未做任何改动/);
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), true, '源目录必须原样保留');
	assert.equal(await snapshot(join(home, 'sessions')), beforeSessions, '会话目录树零改动');
	// 失败时最多只留下一个空壳目录（未写清单，list() 不会上报）；绝不留下任何部分副本
	const shells = await readdir(join(home, 'archive-manager', 'recycle'), { withFileTypes: true }).catch(() => []);
	for (const shell of shells) {
		assert.equal(shell.isDirectory(), true);
		assert.deepEqual(await readdir(join(home, 'archive-manager', 'recycle', shell.name)), [], '不得留下部分副本');
	}
	assert.deepEqual(await store.list(), [], '空壳不得出现在清单里');
});

test('readSessionHeader / resolveHomeDir：元数据与会话 home 解析', async () => {
	const home = await makeHome();
	const sessionDirectory = await makeSession(home, SESSION_A, { cwd: 'D:\\work\\demo', delegationDepth: 2 });
	const metadata = await readSessionHeader(sessionDirectory);
	assert.deepEqual(metadata, { cwd: 'D:\\work\\demo', delegationDepth: 2 });
	assert.equal(await readSessionHeader(join(home, 'nope')), undefined);

	assert.equal(resolveHomeDir({ DSH_HOME: 'D:\\custom-home' }), resolve('D:\\custom-home'));
	assert.equal(resolveHomeDir({ DSH_HOME: '   ' }), join(homedir(), '.dsh'), '空白 DSH_HOME 视为未设置');
	assert.equal(resolveHomeDir({}), join(homedir(), '.dsh'));
	assert.equal(resolveHomeDir({ DSH_HOME: '~' }), homedir());
	assert.equal(resolveHomeDir({ DSH_HOME: '~/nested' }), join(homedir(), 'nested'));
});

test('端点：注册路径/方法/请求体形态与注销', async () => {
	const home = await makeHome();
	const fake = registerWithHome(home);
	assert.deepEqual([...fake.routes.keys()].sort(), Object.values(HOST_ROUTES).sort());
	for (const path of [HOST_ROUTES.list]) {
		assert.deepEqual(fake.routes.get(path).methods, ['GET']);
	}
	for (const path of [HOST_ROUTES.recycle, HOST_ROUTES.restore, HOST_ROUTES.purge]) {
		assert.deepEqual(fake.routes.get(path).methods, ['POST']);
	}
	for (const route of fake.routes.values()) assert.equal(route.requestBody, 'buffered');

	const empty = await callRoute(fake, HOST_ROUTES.list);
	assert.equal(empty.status, 200);
	assert.deepEqual(empty.body, { entries: [] });
	assert.equal(empty.headers.get('cache-control'), 'no-store');

	// 注销：ctx.effect 的回调被调用后，4 条路由都应释放
	for (const dispose of fake.disposers) await dispose();
	assert.equal(fake.routes.size, 0);
});

test('端点：400 非法输入（磁盘零改动）/ 409 会话运行中 / 200 正常流程', async () => {
	const home = await makeHome();
	const original = await makeSession(home, SESSION_A);
	const before = await snapshot(home);
	const fake = registerWithHome(home);

	// 400：空数组、非法 id（含路径穿越）、坏 JSON、缺字段 —— 稳定码 invalid-input，无 ids 字段
	// 注意：`'nope'` 这类**形态合法但未归档**的 id 不再走 400 —— 2026-09-29 契约修正后，
	// 会话 id 按"安全字符集 + 有界长度"校验（接受真实的 `session-<uuid>` 与裸 UUID 两种形态），
	// 因此它走 409 session-not-archived（专门的用例见下方 F1 组）。
	for (const body of [{ sessionIds: [] }, { sessionIds: ['../../etc'] }, { nope: true }, 'not-json']) {
		const response = await callRoute(fake, HOST_ROUTES.recycle, { body });
		assert.equal(response.status, 400, `应当 400：${JSON.stringify(body)}`);
		assert.equal(response.body.code, 'invalid-input');
		assert.equal(typeof response.body.message, 'string');
		assert.ok(response.body.message.length > 0);
		assert.equal(response.body.ids, undefined);
		assert.equal('error' in response.body, false, '旧错误体字段 error 已废除');
	}
	assert.equal(await snapshot(home), before, '400 必须磁盘零改动');

	// 409：会话正在运行 → 整批拒绝，稳定码 session-live + ids，磁盘零改动
	const liveContext = fakeContext({ live: new Set([SESSION_A]) });
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		registerArchiveManagerRoutes(liveContext.ctx);
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
	const running = await callRoute(liveContext, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(running.status, 409);
	assert.equal(running.body.code, 'session-live');
	assert.deepEqual(running.body.ids, [SESSION_A]);
	assert.match(running.body.message, /正在运行/);
	assert.equal(await snapshot(home), before);

	// 200：正常移入 → 清单 → 还原
	const moved = await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(moved.status, 200);
	assert.deepEqual(moved.body, { moved: [SESSION_A], failed: [] });
	assert.equal(existsSync(original), false);

	const listed = await callRoute(fake, HOST_ROUTES.list);
	assert.equal(listed.status, 200);
	assert.equal(listed.body.entries.length, 1);
	const entryId = listed.body.entries[0].entryId;

	// restore 的 400 与 200
	const badRestore = await callRoute(fake, HOST_ROUTES.restore, { body: { entryIds: ['../x'] } });
	assert.equal(badRestore.status, 400);
	assert.equal(badRestore.body.code, 'invalid-input');
	const restored = await callRoute(fake, HOST_ROUTES.restore, { body: { entryIds: [entryId] } });
	assert.equal(restored.status, 200);
	assert.deepEqual(restored.body, { restored: [entryId], failed: [] });
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), true);
});

test('端点：500 未预期失败返回 { code: "internal", message }，磁盘零改动', async () => {
	const home = await makeHome();
	// 用一个同名**文件**占据 archive-manager 位置：回收站目录无法创建 → 存储层抛错 → 500
	await writeFile(join(home, 'archive-manager'), 'not a directory');
	const original = await makeSession(home, SESSION_A);
	const fake = registerWithHome(home);

	const response = await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(response.status, 500);
	assert.equal(response.body.code, 'internal');
	assert.equal(typeof response.body.message, 'string');
	assert.ok(response.body.message.length > 0);
	assert.equal(response.body.ids, undefined);
	assert.equal(existsSync(join(original, 'session.v4.jsonl.zstd')), true, '失败时不得移动会话目录');
	assert.equal(await readFile(join(home, 'archive-manager'), 'utf8'), 'not a directory', '不得覆盖同名文件');
});

test('端点：purge 必须二次确认，确认后只做移交', async () => {
	const home = await makeHome();
	await makeSession(home, SESSION_A);
	const fake = registerWithHome(home);

	for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
		const response = await callRoute(fake, HOST_ROUTES.purge, { body });
		assert.equal(response.status, 400, `缺少 confirm:true 必须 400：${JSON.stringify(body)}`);
		assert.equal(response.body.code, 'invalid-input');
		assert.match(response.body.message, /二次确认/);
	}
	assert.equal(existsSync(join(home, 'archive-manager')), false);

	await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	const purged = await callRoute(fake, HOST_ROUTES.purge, { body: { confirm: true } });
	assert.equal(purged.status, 200);
	assert.deepEqual(purged.body, { purged: 1, failed: [] });
	const batches = await readdir(join(home, 'archive-manager', 'purged'));
	assert.equal(batches.length, 1);
});

test('端点：未归档但仍空闲的会话 → 409 session-not-archived 且磁盘零改动（F1/P7）', async () => {
	const home = await makeHome();
	const original = await makeSession(home, SESSION_A);
	const before = await snapshot(home);
	// 归档集合里没有 SESSION_A：客户端本不该发这种请求，这一层是防御性 fail-closed
	const fake = registerWithHome(home, { archived: [SESSION_B] });

	const response = await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(response.status, 409, '「未归档」是状态冲突，不是 500 故障');
	assert.equal(response.body.code, 'session-not-archived');
	assert.deepEqual(response.body.ids, [SESSION_A]);
	assert.match(response.body.message, /不在归档集合内/);
	assert.equal(await snapshot(home), before, '磁盘零改动');
	assert.equal(existsSync(original), true);
});

test('端点：既未归档又在运行 → 归档校验优先（有意的优先级，F1）', async () => {
	const home = await makeHome();
	await makeSession(home, SESSION_A);
	const fake = registerWithHome(home, { archived: [], live: new Set([SESSION_A]) });

	const response = await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(response.status, 409);
	assert.equal(response.body.code, 'session-not-archived', '"没归档"是比"在运行"更本质的拒绝理由');
});

test('端点：sessions / workspaceRegistry 缺失 → 500 internal 并点名服务（F2/P8）', async () => {
	const home = await makeHome();
	await makeSession(home, SESSION_A);

	// 会话活动探测不可用：recycle 与 restore 都必须 fail-closed
	const noSessions = registerWithHome(home, { sessionsAvailable: false });
	for (const [path, body] of [
		[HOST_ROUTES.recycle, { sessionIds: [SESSION_A] }],
		[HOST_ROUTES.restore, { entryIds: [entryIdFor(SESSION_A, 1790476892885)] }]
	]) {
		const response = await callRoute(noSessions, path, { body });
		assert.equal(response.status, 500, `${path} 必须 fail-closed`);
		assert.equal(response.body.code, 'internal');
		assert.match(response.body.message, /sessions/);
	}

	// 归档集合不可用：不得当成"没归档"放行，也不得当成"已归档"放行
	const noRegistry = registerWithHome(home, { registryAvailable: false });
	const response = await callRoute(noRegistry, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	assert.equal(response.status, 500);
	assert.equal(response.body.code, 'internal');
	assert.match(response.body.message, /workspaceRegistry/);
	assert.equal(existsSync(join(home, 'sessions', '--C-Users-25286--', SESSION_A, 'session.v4.jsonl.zstd')), true);
});

test('端点：restore 运行中 → 409 session-live（与 recycle 对称，F4/P9）', async () => {
	const home = await makeHome();
	await makeSession(home, SESSION_A);
	const fake = registerWithHome(home);
	await callRoute(fake, HOST_ROUTES.recycle, { body: { sessionIds: [SESSION_A] } });
	const [entry] = (await callRoute(fake, HOST_ROUTES.list)).body.entries;

	const liveFake = registerWithHome(home, { live: new Set([SESSION_A]) });
	const response = await callRoute(liveFake, HOST_ROUTES.restore, { body: { entryIds: [entry.entryId] } });
	assert.equal(response.status, 409);
	assert.equal(response.body.code, 'session-live');
	assert.deepEqual(response.body.ids, [SESSION_A]);
	assert.equal(
		existsSync(join(home, 'archive-manager', 'recycle', entry.entryId, 'session')),
		true,
		'409 必须磁盘零改动'
	);
});

test('红线守卫：构建产物里没有任何物理删除语义的调用', async () => {
	const forbidden = [
		/\.rm\s*\(/,
		/\brmSync\s*\(/,
		/\brmdir\s*\(/,
		/\brmdirSync\s*\(/,
		/\bunlink\s*\(/,
		/\bunlinkSync\s*\(/,
		/Remove-Item/,
		/\bdel\s+\//
	];
	for (const relative of ['lib/host/recycle-store.js', 'lib/host/routes.js']) {
		const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
		for (const pattern of forbidden) {
			assert.equal(pattern.test(source), false, `${relative} 命中禁止的删除语义：${pattern}`);
		}
	}
	// 未打包的宿主 ESM 产物必须导出建店函数与 home 解析
	const store = await import('../lib/host/recycle-store.js');
	assert.equal(typeof store.createRecycleStore, 'function');
	assert.equal(typeof store.resolveHomeDir, 'function');
	assert.equal(typeof store.readSessionHeader, 'function');
});
