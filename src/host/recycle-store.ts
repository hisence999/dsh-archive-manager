/**
 * 回收站存储层：本插件「删除」语义的唯一实现。
 *
 * 设计红线（PLAN 决策 D2 / `AGENTS.md` A2）：**任何路径都不执行物理删除**。
 * 因此本模块只出现 `readdir` / `lstat` / `mkdir` / `readFile` / `writeFile` / `rename`，
 * 不出现 `rm` / `rmSync` / `rmdir` / `unlink` 等不可逆调用：
 * - 「删除」= 把 `<sessions>/<cwd-slug>/<sessionId>/` 整体 rename 到
 *   `<home>/archive-manager/recycle/<entryId>/session/`；
 * - 「还原」= 按 `manifest.json` 把它 rename 回清单里的原路径；
 * - 「清空回收站」= **只把载荷 `session/` 移交**到 `<home>/archive-manager/purged/<批次>/<entryId>/session/`，
 *   台账 `manifest.json` **留在回收站原地**并打上 `purgedAt`/`purgedBatch`：一个字节都不抹除，
 *   载荷可在冷存档区人工找回（T11/2026-09-29 起）。
 *
 * 磁盘布局（每条记录一个目录；`manifest.json` 与 `session/` 分离，
 * 这样还原时不会往会话目录里留下本插件的文件）：
 * ```text
 * <home>/archive-manager/
 * ├─ recycle/<entryId>/
 * │  ├─ manifest.json   本插件台账（{@link RecycleEntry} 全字段；purge 后带上 purgedAt/purgedBatch）
 * │  └─ session/        原封不动的会话目录（session.v*.jsonl.zstd）；purge 后不在这里
 * └─ purged/<batchId>/
 *    ├─ batch.json      本批次移交清单（purgedAt / entries / skipped）
 *    └─ <entryId>/session/…      新布局：只有载荷
 *       └─ （旧布局/T11 之前）<entryId>/manifest.json 也在这里，台账随载荷一起被搬走
 * ```
 *
 * **不变式（T13，核心）**：任何时候，只要某会话的工件被本插件从 `sessions/` 移走过，
 * {@link RecycleStore.list} 就必须能上报它 —— 台账必须**仅凭磁盘状态重建**，
 * 不依赖任何「上一次写入是否成功」。因此 `list()` 的取数源是 `recycle/**manifest.json`
 * **∪** `purged/<批次>/<entryId>/manifest.json`（两处同一套逐字段校验，按 `entryId` 去重、
 * 回收站根优先），状态判定看**载荷在不在**而不是看标记：
 * | 状态 | 回收站根有载荷 | 冷存档区有载荷/台账 | `purgedAt` | 上报 | 可还原 |
 * |---|---|---|---|---|---|
 * | 在回收站里 | 有 | — | 无 | **是** | 是 |
 * | 已清空（新布局） | 无 | 有 | 有 | **是** | 否（`entry-purged`） |
 * | 已清空但台账未标记（P19） | 无 | 有 | 无（运行时由 `batch.json`/批次名推导） | **是** | 否（`entry-purged`） |
 * | 旧布局残留（台账在 `purged/`） | 无（回收站根可能整个为空） | 有 | 由 `batch.json`/批次名推导 | **是** | 否（`entry-purged`） |
 * | 已还原（痕迹） | 无 | 无 | 无 | 否 | — |
 * 清单缺失/损坏/不自洽的坏条目**一律不上报**；符号链接/非目录仍按 `path-unsafe` 拒绝。
 * 客户端据此继续过滤 `archivedSessionIds`，避免清空后刷新出现「摘要缺失」幽灵行。
 *
 * `$DSH_HOME` 解析：与官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 同序
 * （显式配置 > `$DSH_HOME` > `~/.dsh`，空白 `$DSH_HOME` 视为未设置）。插件侧拿不到
 * 「显式配置」这一层，故实现为 `$DSH_HOME` > `~/.dsh`。证据：
 * `E:\DSH\resources\app.asar` → `/dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`
 * 的 `resolveDshHome` / `defaultDshHome` / `expandHomePath`。
 */
import { lstat, mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib';
import {
	MANIFEST_FILE_NAME,
	RECYCLE_DIR_NAME,
	entryIdFor,
	errorMessage,
	isSessionId,
	parseEntryId,
	record,
	recycleRoot as recycleRootOf,
	sessionsRoot as sessionsRootOf,
	type Failure,
	type HostErrorCode,
	type PurgeResponse,
	type RecycleEntry,
	type RecycleResponse,
	type RestoreResponse
} from '../contracts.js';

/** 覆盖默认 harness home 的环境变量（官方 `resolveDshHome` 同名）。 */
export const DSH_HOME_ENV = 'DSH_HOME';

/** 默认 harness home 的目录名（`~/.dsh`）。 */
export const DSH_HOME_DIR_NAME = '.dsh';

/** 回收站条目里承载会话目录的子目录名。 */
export const ENTRY_SESSION_DIR_NAME = 'session';

/** 「清空回收站」的冷存档区目录名（移交目的地，非删除）。 */
export const PURGED_DIR_NAME = 'purged';

/** 移交批次清单文件名。 */
export const PURGE_BATCH_FILE_NAME = 'batch.json';

/** 读会话头部时最多读取的压缩字节数（头部在文件首行，无需解开整个转录）。 */
const HEADER_PREFIX_BYTES = 64 * 1024;

/** 会话转录文件名形态（本机实测同时存在 v3 与 v4）。 */
const TRANSCRIPT_PATTERN = /^session\.v\d+\.jsonl\.zstd$/;

/**
 * 目录定位结果：明确区分「找不到」与「有歧义」，绝不猜测。
 * 失败时带 {@link HostErrorCode}，让批量结果里的每条失败都能被客户端本地化。
 */
type Located =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly code: HostErrorCode; readonly reason: string };

/** 从会话转录里尽力读出的元数据（读不到就不编造）。 */
export interface SessionMetadata {
	readonly title?: string;
	readonly cwd?: string;
	readonly delegationDepth?: number;
}

/** 建店的依赖；除 `homeDir` 外都是为可测性留的接缝。 */
export interface RecycleStoreOptions {
	/** `$DSH_HOME` 绝对路径；回收站与会话目录都由它派生。 */
	readonly homeDir: string;
	/** 时间来源（默认 `Date.now`）。 */
	readonly now?: () => number;
	/** 会话元数据读取（默认读转录首行头部）。 */
	readonly readSessionMetadata?: (sessionDir: string) => Promise<SessionMetadata | undefined>;
	/** 会话活动探针：返回 true 表示会话正在运行，必须拒绝操作。 */
	readonly isSessionLive?: (sessionId: string) => boolean;
	/** 目录移动实现（默认 `fs.promises.rename`）；跨卷失败时**不做**复制+删除兜底。 */
	readonly moveDirectory?: (from: string, to: string) => Promise<void>;
}

/** 回收站存储层。 */
export interface RecycleStore {
	/** 解析后的 `$DSH_HOME`。 */
	readonly homeDir: string;
	/** 回收站根目录绝对路径。 */
	readonly recycleRoot: string;
	/** 会话目录根绝对路径（还原目标必须落在它之下）。 */
	readonly sessionsRoot: string;
	/** 回收站清单（在站条目 + 已清空但保留台账的条目，按移入时间倒序；坏条目不上报）。 */
	list(): Promise<RecycleEntry[]>;
	/** 把会话目录移入回收站。 */
	recycle(sessionIds: readonly string[]): Promise<RecycleResponse>;
	/** 把回收站条目移回清单记录的原路径；已清空（`purgedAt`）的条目返回 `entry-purged`。 */
	restore(entryIds: readonly string[]): Promise<RestoreResponse>;
	/** 把回收站里的载荷移交到冷存档区（**不是物理删除**），台账留在原地。 */
	purge(): Promise<PurgeOutcome>;
}

/**
 * `purge()` 的结果。
 *
 * `PurgeResponse`（冻结契约）只有 `purged`；这里额外返回 `failed[]`，让「符号链接、坏台账、
 * 移交失败等条目被原地保留」这件事对客户端可见（F3/P6）。`PurgeOutcome` 扩展自 `PurgeResponse`，
 * 因此仍满足契约；建议 Lead 后续把 `failed?: Failure[]` 并入 `PurgeResponse`。
 */
export interface PurgeOutcome extends PurgeResponse {
	readonly failed: Failure[];
}

/** 展开 `~` / `~/` / `~\` 前缀（与官方 `expandHomePath` 同语义：只处理当前用户裸 `~`）。 */
export function expandHomePath(path: string): string {
	if (path === '~') return homedir();
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
	return path;
}

/**
 * 解析 harness home。
 * @param env - 环境映射（默认 `process.env`）；空白 `DSH_HOME` 视为未设置。
 * @returns 归一化后的绝对路径。
 */
export function resolveHomeDir(env: Record<string, string | undefined> = process.env): string {
	const fromEnv = env[DSH_HOME_ENV];
	const configured = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME);
	return resolve(expandHomePath(configured));
}

/** 判断 `target` 是否严格位于 `root` 之下；是则返回相对路径，否则 `undefined`。 */
function relativeInside(root: string, target: string): string | undefined {
	const rel = relative(resolve(root), resolve(target));
	if (rel.length === 0) return undefined;
	if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
	return rel;
}

/**
 * 校验还原目标形态：必须恰好是 `<sessions>/<cwd-slug>/<sessionId>`。
 * 只允许 `sessionsRoot` 之下两级、且末段与会话 id 完全一致，绝不接受更浅/更深的路径。
 */
function relativeSessionPath(sessionsRoot: string, sessionId: string, originalPath: string): string | undefined {
	const rel = relativeInside(sessionsRoot, originalPath);
	if (rel === undefined) return undefined;
	const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0);
	if (segments.length !== 2) return undefined;
	const [slug, leaf] = segments;
	if (slug === undefined || slug === '.' || slug === '..') return undefined;
	if (leaf !== sessionId) return undefined;
	return rel;
}

/** `lstat` 存在性判断，不跟随符号链接。 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** 读取目录下的名字集合；目录不存在时返回空集合。 */
async function readDirectoryNames(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** 递归累计目录字节数；跳过符号链接（不跟随、也不计入）。 */
async function directoryBytes(directory: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	let total = 0;
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			total += await directoryBytes(full);
			continue;
		}
		if (entry.isFile()) {
			try {
				total += (await lstat(full)).size;
			} catch {
				// 读取失败只影响统计，不影响移动本身。
			}
		}
	}
	return total;
}

/**
 * 默认的会话元数据读取：只解开转录文件的前 {@link HEADER_PREFIX_BYTES} 字节，
 * 取首行头部 JSON 的 `cwd` 与 `delegationDepth`。
 *
 * 实测形态（2026-09-29，`$DSH_HOME\sessions\**\session.v4.jsonl.zstd` 首行）：
 * `{"type":"session","version":4,"id":"…","createdAt":…,"cwd":"C:\\Users\\…","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}`。
 * 转录里**没有** title 字段（全量会话实测 0 命中），故 title 不编造、留空。
 */
export async function readSessionHeader(sessionDir: string): Promise<SessionMetadata | undefined> {
	let names: string[];
	try {
		names = (await readdir(sessionDir)).filter((name) => TRANSCRIPT_PATTERN.test(name)).sort();
	} catch {
		return undefined;
	}
	const name = names[names.length - 1];
	if (name === undefined) return undefined;
	try {
		const handle = await open(join(sessionDir, name), 'r');
		try {
			const size = (await handle.stat()).size;
			if (size <= 0) return undefined;
			const length = Math.min(HEADER_PREFIX_BYTES, size);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, 0);
			if (bytesRead <= 0) return undefined;
			// 允许截断的 zstd 帧：只解到能拿到首行为止。
			const text = zstdDecompressSync(buffer.subarray(0, bytesRead), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
			const firstLine = text.split('\n')[0] ?? '';
			const header = record(JSON.parse(firstLine));
			return {
				...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
				...(typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth)
					? { delegationDepth: header.delegationDepth }
					: {})
			};
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** 把已落盘/待落盘的清单内容解析成 {@link RecycleEntry}；任何不自洽都返回 `undefined`。 */
function parseManifest(value: unknown, expectedEntryId: string): RecycleEntry | undefined {
	try {
		const raw = record(value);
		if (raw.entryId !== expectedEntryId) return undefined;
		const parsed = parseEntryId(expectedEntryId);
		if (raw.sessionId !== parsed.sessionId) return undefined;
		if (typeof raw.originalPath !== 'string' || !isAbsolute(raw.originalPath)) return undefined;
		if (typeof raw.movedAt !== 'string' || Number.isNaN(Date.parse(raw.movedAt))) return undefined;
		if (typeof raw.bytes !== 'number' || !Number.isFinite(raw.bytes) || raw.bytes < 0) return undefined;
		return {
			entryId: expectedEntryId,
			sessionId: parsed.sessionId,
			movedAt: raw.movedAt,
			originalPath: raw.originalPath,
			bytes: raw.bytes,
			...(typeof raw.title === 'string' ? { title: raw.title } : {}),
			...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
			// T11：已移交载荷的台账标记；`purgedAt` 决定条目是否可还原、`purgedBatch` 指向冷存档批次。
			...(typeof raw.purgedAt === 'string' && !Number.isNaN(Date.parse(raw.purgedAt)) ? { purgedAt: raw.purgedAt } : {}),
			...(typeof raw.purgedBatch === 'string' ? { purgedBatch: raw.purgedBatch } : {})
		};
	} catch {
		return undefined;
	}
}

/** 读取一个目录里的 `manifest.json` 并校验；缺失或损坏返回 `undefined`。 */
async function readManifest(directory: string, expectedEntryId: string): Promise<RecycleEntry | undefined> {
	try {
		return parseManifest(JSON.parse(await readFile(join(directory, MANIFEST_FILE_NAME), 'utf8')) as unknown, expectedEntryId);
	} catch {
		return undefined;
	}
}

/** 目录是否是真实目录（不是符号链接、不是文件）。 */
async function isPlainDirectory(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** 移动失败的人话解释 + 稳定码；跨卷明确拒绝，不做复制+删除兜底。 */
function describeMoveFailure(error: unknown): { code: HostErrorCode; message: string } {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'EXDEV') {
		return {
			code: 'cross-device',
			message: '源目录与回收站不在同一卷，跨卷移交不受支持（不做复制+删源兜底），本次未做任何改动；请手动把会话目录移到与回收站同一卷后再试'
		};
	}
	if (code === 'ENOENT') return { code: 'session-missing', message: '源目录在移动前已消失，本次未做任何改动' };
	if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
		return { code: 'internal', message: `文件系统拒绝移动（${String(code)}），本次未做任何改动` };
	}
	return { code: 'internal', message: `移动失败：${errorMessage(error)}` };
}

/**
 * 还原方向（回收站 → `sessions`）的移动失败映射（F7/P11）。
 *
 * `pathExists` 预检与 `rename` 之间存在 TOCTOU 空窗，空窗内失败的成因只有两类，
 * 因此不该一律报 `internal`：
 * - 目标在空窗里被创建/被占用 → `entry-conflict`（拒绝覆盖，磁盘零改动）；
 * - 源条目或原工作区目录在空窗里消失 → `entry-not-found`。
 * 其余（含 EXDEV）另行映射。
 */
function describeRestoreMoveFailure(error: unknown): { code: HostErrorCode; message: string } {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'EXDEV') {
		return { code: 'cross-device', message: '回收站与还原目标不在同一卷，跨卷移交不受支持（不做复制+删源兜底），本次未做任何改动' };
	}
	if (code === 'ENOENT') {
		return { code: 'entry-not-found', message: '回收站条目或原工作区目录在移动前消失，本次未做任何改动' };
	}
	if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
		return { code: 'entry-conflict', message: `还原目标在移动前出现或被占用（${String(code)}），拒绝覆盖，本次未做任何改动` };
	}
	return { code: 'internal', message: `移动失败：${errorMessage(error)}` };
}

/** 建一个回收站存储层。 */
export function createRecycleStore(options: RecycleStoreOptions): RecycleStore {
	if (typeof options.homeDir !== 'string' || options.homeDir.trim().length === 0) throw new TypeError('homeDir 必须是非空路径');
	const homeDir = resolve(options.homeDir);
	const recycleRoot = recycleRootOf(homeDir);
	const sessionsRoot = sessionsRootOf(homeDir);
	const purgedRoot = join(homeDir, RECYCLE_DIR_NAME, PURGED_DIR_NAME);
	const now = options.now ?? ((): number => Date.now());
	const isSessionLive = options.isSessionLive ?? ((): boolean => false);
	const readSessionMetadata = options.readSessionMetadata ?? readSessionHeader;
	const moveDirectory = options.moveDirectory ?? ((from: string, to: string): Promise<void> => rename(from, to));

	/** 在会话根下按**磁盘上的名字**精确定位 `<slug>/<sessionId>`；请求字符串不参与拼路径。 */
	async function findSessionDirectory(sessionId: string): Promise<Located> {
		let slugs: Dirent[];
		try {
			slugs = await readdir(sessionsRoot, { withFileTypes: true });
		} catch (error) {
			return { ok: false, code: 'session-missing', reason: `无法读取会话目录（${errorMessage(error)}）` };
		}
		const matches: string[] = [];
		for (const slug of slugs) {
			if (!slug.isDirectory() || slug.isSymbolicLink()) continue;
			const slugPath = join(sessionsRoot, slug.name);
			let children: Dirent[];
			try {
				children = await readdir(slugPath, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const child of children) {
				if (child.name !== sessionId) continue;
				matches.push(join(slugPath, child.name));
			}
		}
		if (matches.length === 0) return { ok: false, code: 'session-missing', reason: '未找到该会话的工件目录' };
		if (matches.length > 1) return { ok: false, code: 'path-unsafe', reason: '在多个工作区目录下找到同一会话，拒绝猜测' };
		return { ok: true, path: matches[0] as string };
	}

	/** 在回收站根下按名字精确定位条目目录；请求里的 `entryId` 不做路径拼接。 */
	async function findEntryDirectory(entryId: string): Promise<Located> {
		let entries: Dirent[];
		try {
			entries = await readdir(recycleRoot, { withFileTypes: true });
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code === 'ENOENT') return { ok: false, code: 'entry-not-found', reason: '回收站里没有该条目' };
			return { ok: false, code: 'internal', reason: `无法读取回收站（${errorMessage(error)}）` };
		}
		for (const entry of entries) {
			if (entry.name !== entryId) continue;
			if (entry.isSymbolicLink()) return { ok: false, code: 'path-unsafe', reason: '回收站条目是符号链接，拒绝操作' };
			if (!entry.isDirectory()) return { ok: false, code: 'path-unsafe', reason: '回收站条目不是目录，拒绝操作' };
			return { ok: true, path: join(recycleRoot, entry.name) };
		}
		return { ok: false, code: 'entry-not-found', reason: '回收站里没有该条目' };
	}

	/** 在给定根目录下挑一个未被占用的条目名（先 readdir，再按名字比对）。 */
	async function allocateName(directory: string, candidate: (attempt: number) => string, attempts = 1000): Promise<string> {
		const taken = new Set(await readDirectoryNames(directory));
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const name = candidate(attempt);
			if (!taken.has(name)) return name;
		}
		throw new Error('无法分配未被占用的目录名');
	}

	/** 批次元信息缓存（只缓存成功读取的 `purgedAt`）。 */
	const batchPurgedAtCache = new Map<string, string>();

	/** 读 `purged/<批次>/batch.json` 的 `purgedAt`；读不到返回 `undefined`。 */
	async function readBatchPurgedAt(batch: string): Promise<string | undefined> {
		const cached = batchPurgedAtCache.get(batch);
		if (cached !== undefined) return cached;
		try {
			const raw = record(JSON.parse(await readFile(join(purgedRoot, batch, PURGE_BATCH_FILE_NAME), 'utf8')) as unknown);
			if (typeof raw.purgedAt === 'string' && !Number.isNaN(Date.parse(raw.purgedAt))) {
				batchPurgedAtCache.set(batch, raw.purgedAt);
				return raw.purgedAt;
			}
		} catch {
			// batch.json 缺失/损坏：由调用方回落到批次目录名或 movedAt。
		}
		return undefined;
	}

	/** 由批次目录名 `YYYYMMDD-HHmmss`（UTC）推导 `purgedAt`。 */
	function purgedAtFromBatchName(batch: string): string | undefined {
		const matched = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(batch);
		if (matched === null) return undefined;
		const [, year, month, day, hour, minute, second] = matched as unknown as [string, string, string, string, string, string, string];
		const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
		return Number.isNaN(epochMs) ? undefined : new Date(epochMs).toISOString();
	}

	/**
	 * 在冷存档区找某条目：`purged/<批次>/<entryId>`。
	 *
	 * 先按台账里的 `purgedBatch` 提示找（仍走 `readdir` + 名字精确匹配，绝不拼请求字符串）；
	 * 提示失效时退化为扫描全部批次。找不到返回 `undefined`。
	 */
	async function findPurgedEntry(entryId: string, batchHint?: string): Promise<{ batch: string; directory: string } | undefined> {
		let batches: Dirent[];
		try {
			batches = await readdir(purgedRoot, { withFileTypes: true });
		} catch {
			return undefined;
		}
		const candidates = batches.filter((batch) => batch.isDirectory() && !batch.isSymbolicLink());
		const passes = batchHint === undefined ? [false] : [true, false];
		for (const useHint of passes) {
			for (const batch of candidates) {
				if (useHint && batch.name !== batchHint) continue;
				// `entryId` 已过 `parseEntryId`（单段安全名），这里再按磁盘名字精确匹配一层。
				const directory = join(purgedRoot, batch.name, entryId);
				if (await pathExists(directory)) return { batch: batch.name, directory };
			}
		}
		return undefined;
	}

	/**
	 * 给台账补上「载荷已在冷存档区」的信息。
	 *
	 * 推导顺序：台账自带的 `purgedAt` → `batch.json` 的 `purgedAt` → 批次目录名 →
	 * （最后兜底）`movedAt`。这样**不依赖上一次写入是否成功**。
	 */
	async function withPurgedInfo(manifest: RecycleEntry, batch: string | undefined): Promise<RecycleEntry> {
		const resolvedBatch = manifest.purgedBatch ?? batch;
		const purgedAt =
			manifest.purgedAt ??
			(resolvedBatch === undefined ? undefined : await readBatchPurgedAt(resolvedBatch)) ??
			(resolvedBatch === undefined ? undefined : purgedAtFromBatchName(resolvedBatch)) ??
			manifest.movedAt;
		return {
			...manifest,
			purgedAt,
			...(resolvedBatch === undefined ? {} : { purgedBatch: resolvedBatch })
		};
	}

	/**
	 * 回收站台账（{@link RecycleStore.list}）。
	 *
	 * **不变式（T13）**：任何时候，只要某会话的工件被本插件从 `sessions/` 移走过，
	 * `list()` 就必须能上报它 —— 台账必须仅凭**磁盘状态**重建，不依赖任何「上一次写入是否成功」。
	 * 因此取数源有两处，都走同一套 {@link parseManifest} 逐字段校验，按 `entryId` 去重（回收站根优先）：
	 * 1. `recycle/<entryId>/manifest.json`（在站台账）；
	 * 2. `purged/<批次>/<entryId>/manifest.json`（冷存档内的台账：T11 之前的旧布局会把台账随载荷一起搬走，
	 *    以及「写台账失败」的所有变体，都只能靠这里兜住）。
	 *
	 * 状态判定**看载荷在不在**，不看标记：
	 * | 回收站根 | 载荷在 `purged/` | 上报 | 说明 |
	 * |---|---|---|---|
	 * | 有载荷 | — | 是（active） | 在站 |
	 * | 无载荷 | 在 | 是（purged） | `purgedAt` 缺失时按上文推导（P19 修法） |
	 * | 无载荷，但有 `purgedAt` | 不在 | 是（purged） | 台账说已清空，按已清空上报 |
	 * | 无载荷、无 `purgedAt`、`purged/` 里也没有 | 不在 | **否** | 已还原的痕迹，上报会让 A3「还原后行消失」失效 |
	 * 坏台账（缺失/损坏/不自洽）一律不上报。
	 */
	async function list(): Promise<RecycleEntry[]> {
		const entries: RecycleEntry[] = [];
		const reported = new Set<string>();
		// ① 回收站根（优先级最高）
		for (const name of await readDirectoryNames(recycleRoot)) {
			const directory = join(recycleRoot, name);
			if (!(await isPlainDirectory(directory))) continue;
			// 坏条目（清单缺失/损坏/不自洽）一律不上报：`parseManifest` 已经逐字段校验。
			const manifest = await readManifest(directory, name);
			if (manifest === undefined) continue;
			if (await isPlainDirectory(join(directory, ENTRY_SESSION_DIR_NAME))) {
				entries.push(manifest);
				reported.add(name);
				continue;
			}
			// 无载荷 → 看冷存档区：能找到载荷（或台账自述已清空）就按已清空上报。
			const purged = await findPurgedEntry(name, manifest.purgedBatch);
			if (purged !== undefined) {
				entries.push(await withPurgedInfo(manifest, purged.batch));
				reported.add(name);
				continue;
			}
			if (manifest.purgedAt !== undefined) {
				entries.push(await withPurgedInfo(manifest, manifest.purgedBatch));
				reported.add(name);
			}
			// 否则：已还原的痕迹，不上报。
		}
		// ② 冷存档区里的台账（旧布局残留 / 台账被随载荷搬走 / 写台账失败）
		let batches: Dirent[];
		try {
			batches = await readdir(purgedRoot, { withFileTypes: true });
		} catch {
			batches = [];
		}
		for (const batch of batches) {
			if (!batch.isDirectory() || batch.isSymbolicLink()) continue;
			const batchDirectory = join(purgedRoot, batch.name);
			for (const name of await readDirectoryNames(batchDirectory)) {
				if (reported.has(name)) continue; // 回收站根已经报过 → 去重，以根那份为准
				const directory = join(batchDirectory, name);
				if (!(await isPlainDirectory(directory))) continue;
				// 旧布局：台账就在载荷旁边；新布局这里只有 `session/`，没有台账 → 跳过。
				const manifest = await readManifest(directory, name);
				if (manifest === undefined) continue;
				entries.push(await withPurgedInfo(manifest, batch.name));
				reported.add(name);
			}
		}
		entries.sort((left, right) => {
			const delta = Date.parse(right.movedAt) - Date.parse(left.movedAt);
			return delta !== 0 ? delta : right.entryId.localeCompare(left.entryId);
		});
		return entries;
	}

	async function recycle(sessionIds: readonly string[]): Promise<RecycleResponse> {
		const moved: string[] = [];
		const failed: Failure[] = [];
		let prepared = false;
		for (const sessionId of sessionIds) {
			if (!isSessionId(sessionId)) {
				failed.push({ id: String(sessionId), code: 'invalid-input', message: '会话 ID 不合法：含路径分隔符、`..` 穿越风险或长度越界' });
				continue;
			}
			if (isSessionLive(sessionId)) {
				failed.push({ id: sessionId, code: 'session-live', message: '会话正在运行，拒绝移动' });
				continue;
			}
			const located = await findSessionDirectory(sessionId);
			if (!located.ok) {
				failed.push({ id: sessionId, code: located.code, message: located.reason });
				continue;
			}
			if (!(await isPlainDirectory(located.path))) {
				failed.push({ id: sessionId, code: 'path-unsafe', message: '源目录不是普通目录（不存在、或为符号链接/文件），拒绝移动' });
				continue;
			}
			const metadata = await readSessionMetadata(located.path);
			const depth = metadata?.delegationDepth ?? 0;
			if (depth > 0) {
				failed.push({
					id: sessionId,
					code: 'child-session',
					message: `该会话是子代理子会话（delegationDepth=${depth}）；本插件不做跨会话级联删除，请先处理其父会话`
				});
				continue;
			}
			const bytes = await directoryBytes(located.path);
			// F5/P10：回收站根目录在**任何移动之前**创建一次；失败即抛出（此时磁盘零改动），
			// 之后逐条目失败一律进 `failed[]`，不会让已成功的 moved 因后续异常丢失。
			if (!prepared) {
				try {
					await mkdir(recycleRoot, { recursive: true });
					prepared = true;
				} catch (error) {
					throw new Error(`无法创建回收站目录（${errorMessage(error)}）`);
				}
			}
			const requestedMovedAtMs = Math.max(0, Math.trunc(now()));
			let entryDirectory: string;
			try {
				// 同一毫秒内重复移入时把时间戳 +1ms 错开，避免条目名撞车；`mkdir` 非递归，避免连坐创建。
				const entryId = await allocateName(recycleRoot, (attempt) => entryIdFor(sessionId, requestedMovedAtMs + attempt));
				entryDirectory = join(recycleRoot, entryId);
				await mkdir(entryDirectory);
			} catch (error) {
				failed.push({ id: sessionId, code: 'internal', message: `无法在回收站里创建条目目录：${errorMessage(error)}` });
				continue;
			}
			const entryId = basename(entryDirectory);
			const movedAtMs = parseEntryId(entryId).movedAtMs;
			try {
				await moveDirectory(located.path, join(entryDirectory, ENTRY_SESSION_DIR_NAME));
			} catch (error) {
				const moveFailure = describeMoveFailure(error);
				failed.push({ id: sessionId, code: moveFailure.code, message: moveFailure.message });
				continue;
			}
			const entry: RecycleEntry = {
				entryId,
				sessionId,
				movedAt: new Date(movedAtMs).toISOString(),
				originalPath: located.path,
				bytes,
				...(metadata?.title !== undefined ? { title: metadata.title } : {}),
				...(metadata?.cwd !== undefined ? { cwd: metadata.cwd } : {})
			};
			try {
				await writeFile(join(entryDirectory, MANIFEST_FILE_NAME), `${JSON.stringify(entry, null, '\t')}\n`, 'utf8');
			} catch (error) {
				let rollback = '已回滚到原路径';
				try {
					await moveDirectory(join(entryDirectory, ENTRY_SESSION_DIR_NAME), located.path);
				} catch {
					rollback = '回滚也失败，会话目录仍在回收站条目里';
				}
				failed.push({ id: sessionId, code: 'internal', message: `写清单失败（${errorMessage(error)}），${rollback}` });
				continue;
			}
			moved.push(sessionId);
		}
		return { moved, failed };
	}

	/**
	 * 还原（T13 谓词修正）。
	 *
	 * 判据是**载荷在不在回收站根**，不是「有没有 `purgedAt` 标记」——标记只用来措辞。
	 * 这覆盖「载荷已走但台账未标记」（P19）与「台账随载荷一起躺在冷存档区」（旧布局）：
	 * 三种形态都回 `failed[].code = 'entry-purged'`；载荷彻底不在（已还原过）则 `entry-not-found`。
	 */
	async function restore(entryIds: readonly string[]): Promise<RestoreResponse> {
		const restored: string[] = [];
		const failed: Failure[] = [];
		/** 「载荷在冷存档区」的统一回复。 */
		const purgedFailure = async (entryId: string, manifest: RecycleEntry | undefined, batch: string | undefined, purgedAt: string | undefined): Promise<Failure> => {
			const resolvedBatch = manifest?.purgedBatch ?? batch;
			const resolvedAt = manifest?.purgedAt ?? purgedAt;
			const where = resolvedBatch === undefined ? '' : `批次 ${resolvedBatch}${resolvedAt === undefined ? '' : `，${resolvedAt}`}`;
			return {
				id: entryId,
				code: 'entry-purged',
				message: `载荷已移交到冷存档区（${where === '' ? '冷存档区' : where}），回收站内无法还原；可人工到 <home>/archive-manager/purged/ 下找回`
			};
		};
		for (const entryId of entryIds) {
			let sessionId: string;
			try {
				sessionId = parseEntryId(entryId).sessionId;
			} catch (error) {
				failed.push({ id: String(entryId), code: 'invalid-input', message: errorMessage(error) });
				continue;
			}
			const located = await findEntryDirectory(entryId);
			const manifest = located.ok ? await readManifest(located.path, entryId) : undefined;
			const purged = await findPurgedEntry(entryId, manifest?.purgedBatch);
			if (located.ok && manifest === undefined) {
				// 回收站里有目录但台账坏了：若冷存档区能找到载荷，仍按「已清空」如实告知。
				if (purged !== undefined) {
					failed.push(await purgedFailure(entryId, undefined, purged.batch, await readBatchPurgedAt(purged.batch)));
					continue;
				}
				failed.push({ id: entryId, code: 'entry-not-found', message: `${MANIFEST_FILE_NAME} 缺失或损坏，拒绝还原` });
				continue;
			}
			if (!located.ok && purged === undefined) {
				failed.push({ id: entryId, code: located.code, message: located.reason });
				continue;
			}
			// 载荷在不在回收站根？不在就走 entry-purged（旧布局下台账也在冷存档区）。
			const payloadInRecycle = located.ok && (await isPlainDirectory(join(located.path, ENTRY_SESSION_DIR_NAME)));
			if (!payloadInRecycle) {
				if (purged !== undefined) {
					failed.push(await purgedFailure(entryId, manifest, purged.batch, await readBatchPurgedAt(purged.batch)));
					continue;
				}
				failed.push({ id: entryId, code: 'entry-not-found', message: '回收站条目里没有可还原的会话目录（可能已经还原过）' });
				continue;
			}
			// 到这里：载荷就在回收站条目里，台账也可信（`located.ok` ⇒ `manifest` 有值）。
			const entry = manifest as RecycleEntry;
			if (relativeSessionPath(sessionsRoot, sessionId, entry.originalPath) === undefined) {
				failed.push({ id: entryId, code: 'path-unsafe', message: '清单里的原始路径不是会话目录之下的合法位置，拒绝还原' });
				continue;
			}
			if (isSessionLive(sessionId)) {
				failed.push({ id: entryId, code: 'session-live', message: '会话正在运行，拒绝还原' });
				continue;
			}
			const source = join(located.path, ENTRY_SESSION_DIR_NAME);
			const parent = dirname(resolve(entry.originalPath));
			if (!(await isPlainDirectory(parent))) {
				failed.push({ id: entryId, code: 'entry-conflict', message: '原工作区目录不存在（或不是普通目录），拒绝静默创建到别处' });
				continue;
			}
			if (await pathExists(entry.originalPath)) {
				failed.push({ id: entryId, code: 'entry-conflict', message: '还原目标已存在，拒绝覆盖' });
				continue;
			}
			try {
				await moveDirectory(source, entry.originalPath);
			} catch (error) {
				const moveFailure = describeRestoreMoveFailure(error);
				failed.push({ id: entryId, code: moveFailure.code, message: moveFailure.message });
				continue;
			}
			restored.push(entryId);
		}
		return { restored, failed };
	}

	/**
	 * 清空回收站 = **只移交载荷、保留台账**（T11）。
	 *
	 * **这不是物理删除**：`<entryId>/session/` 被 rename 到
	 * `<home>/archive-manager/purged/<批次>/<entryId>/session/`，字节可人工找回；
	 * `<entryId>/manifest.json` 原地保留并打上 `purgedAt`/`purgedBatch`，
	 * 因此 {@link list} 仍会报告该条目（客户端继续用它过滤 `archivedSessionIds`，刷新不出幽灵行），
	 * 但 {@link restore} 会以 `entry-purged` 拒绝。
	 *
	 * 幂等：已带 `purgedAt` 的条目不再搬运、`purgedAt` 取**首次**移交时间，不被覆盖。
	 * 原地保留（计 `skipped`，不进 `purged`）：符号链接/非目录（`path-unsafe`）、
	 * 清单缺失或损坏（`entry-not-found`）、无载荷的「已还原痕迹」。
	 */
	async function purge(): Promise<PurgeOutcome> {
		const failed: Failure[] = [];
		let entries: Dirent[];
		try {
			entries = await readdir(recycleRoot, { withFileTypes: true });
		} catch {
			return { purged: 0, failed };
		}
		// F3/P6：只处理**普通目录**条目。符号链接与其它类型一律原地保留并记入 failed，
		// 与 `list()` / `restore()` 的拒绝策略保持一致（不移交、不跟随、不删除）。
		const candidates: Dirent[] = [];
		const skipped: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				candidates.push(entry);
				continue;
			}
			skipped.push(entry.name);
			failed.push({
				id: entry.name,
				code: 'path-unsafe',
				message: entry.isSymbolicLink()
					? '回收站条目是符号链接，拒绝移交，已原地保留'
					: '回收站条目不是普通目录，拒绝移交，已原地保留'
			});
		}
		// 先筛出「真的需要移交」的条目：有载荷、且未被移交过。
		const pending: { name: string; directory: string; manifest: RecycleEntry }[] = [];
		for (const entry of candidates) {
			const directory = join(recycleRoot, entry.name);
			const manifest = await readManifest(directory, entry.name);
			if (manifest === undefined) {
				// 没有可信台账就不猜、不搬：原地保留并如实上报（`list()` 也不会上报它）。
				skipped.push(entry.name);
				failed.push({ id: entry.name, code: 'entry-not-found', message: `${MANIFEST_FILE_NAME} 缺失或损坏，拒绝移交，已原地保留` });
				continue;
			}
			if (manifest.purgedAt !== undefined) {
				// 幂等：已清空过，保留首次 purgedAt，不重复搬运。
				skipped.push(entry.name);
				continue;
			}
			if (!(await isPlainDirectory(join(directory, ENTRY_SESSION_DIR_NAME)))) {
				// 已还原的痕迹：没有载荷可移交。
				skipped.push(entry.name);
				continue;
			}
			pending.push({ name: entry.name, directory, manifest });
		}
		if (pending.length === 0) return { purged: 0, failed };
		await mkdir(purgedRoot, { recursive: true });
		const stamp = new Date(Math.max(0, Math.trunc(now()))).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
		const batch = await allocateName(purgedRoot, (attempt) => (attempt === 0 ? stamp : `${stamp}-${attempt + 1}`));
		const batchDirectory = join(purgedRoot, batch);
		await mkdir(batchDirectory);
		const purgedAt = new Date(Math.max(0, Math.trunc(now()))).toISOString();
		const records: RecycleEntry[] = [];
		let purged = 0;
		for (const item of pending) {
			const from = join(item.directory, ENTRY_SESSION_DIR_NAME);
			const toDirectory = join(batchDirectory, item.name);
			try {
				await mkdir(toDirectory);
				await moveDirectory(from, join(toDirectory, ENTRY_SESSION_DIR_NAME));
			} catch (error) {
				// 移交失败的条目原地保留，绝不抹除；结果里如实上报。
				skipped.push(item.name);
				failed.push({ id: item.name, code: 'internal', message: `移交失败，载荷已原地保留：${errorMessage(error)}` });
				continue;
			}
			const purgedEntry: RecycleEntry = { ...item.manifest, purgedAt, purgedBatch: batch };
			try {
				await writeFile(join(item.directory, MANIFEST_FILE_NAME), `${JSON.stringify(purgedEntry, null, '\t')}\n`, 'utf8');
			} catch (error) {
				// 台账写失败 → 把载荷搬回来，避免出现「载荷已走但台账说可还原」的半截状态。
				let rollback = '载荷已搬回回收站';
				try {
					await moveDirectory(join(toDirectory, ENTRY_SESSION_DIR_NAME), from);
				} catch {
					rollback = '载荷仍在冷存档区（台账未标记）';
				}
				skipped.push(item.name);
				failed.push({ id: item.name, code: 'internal', message: `写台账失败（${errorMessage(error)}），${rollback}` });
				continue;
			}
			records.push(purgedEntry);
			purged += 1;
		}
		await writeFile(
			join(batchDirectory, PURGE_BATCH_FILE_NAME),
			`${JSON.stringify({ purgedAt, sourceRoot: recycleRoot, batch, entries: records, skipped }, null, '\t')}\n`,
			'utf8'
		);
		return { purged, failed };
	}

	return { homeDir, recycleRoot, sessionsRoot, list, recycle, restore, purge };
}
