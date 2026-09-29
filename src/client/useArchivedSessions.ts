/**
 * 「已归档会话」页的数据模型。
 *
 * 数据源（唯一真源，不做任何本地归档账本）：
 * - 页面 standardProps 的 `useWorkspaces` → `WorkspaceSnapshot.archivedSessionIds`
 *   （registry 全局归档集合，宿主顺序）。
 * - 页面 standardProps 的 `useSessions` → 摘要 `byId`。
 * 两者都来自 `settings.section` 的 standardProps，来源见 `src/dsh.client.d.ts` 顶部注释。
 *
 * 本文件把「派生」与「渲染」分开：所有筛选 / 排序 / 选择 / 时间 / 错误归一化都是
 * 无副作用纯函数（`test/client.test.mjs` 直接对它们做单测），React 钩子只负责接线。
 */

import { useMemo } from 'react';
import type { HostErrorCode, RecycleEntry } from '../contracts.js';
import { MAX_BATCH, errorMessage } from '../contracts.js';

/** 列表排序维度。 */
export type SortKey = 'updatedAt' | 'title';

/** 排序方向。 */
export type SortDirection = 'asc' | 'desc';

/** 列表中的一行（由归档 id + 会话摘要派生，缺摘要也不丢行）。 */
export interface ArchivedRow {
	readonly id: string;
	/** 摘要标题；摘要缺失时为空串。 */
	readonly title: string;
	/** 摘要里的项目目录；缺失时为空串。 */
	readonly cwd: string;
	/** 更新时间（毫秒）；无法解析时为 `null`。 */
	readonly updatedAtMs: number | null;
	readonly running: boolean;
	/** 摘要缺失（归档集合里有 id，但 `useSessions().byId` 没有它）。 */
	readonly missingSummary: boolean;
}

/**
 * 把时间字段归一化成毫秒时间戳。
 * - 数字：`< 1e11` 视为秒级时间戳（DSH 少数投影字段用秒），否则视为毫秒；
 * - 字符串：走 `Date.parse`（ISO-8601）；
 * - 其它 / 非法值：`null`。
 */
export function toEpochMs(value: unknown): number | null {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return null;
		return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const parsed = Date.parse(trimmed);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

/** 单行派生：摘要缺失时给出 `missingSummary: true`，UI 据此显示「摘要缺失」。 */
export function rowFor(id: string, summary: DshSessionSummary | undefined): ArchivedRow {
	const title = typeof summary?.title === 'string' ? summary.title.trim() : '';
	const cwd = typeof summary?.cwd === 'string' ? summary.cwd.trim() : '';
	return {
		id,
		title,
		cwd,
		updatedAtMs: toEpochMs(summary?.updatedAt ?? summary?.createdAt),
		running: summary?.running === true,
		missingSummary: summary === undefined
	};
}

/**
 * 只在**自有键**上取会话摘要。
 * 直接用 `byId[id]` 时，`toString` / `constructor` / `__proto__` 这类原型键会命中
 * `Object.prototype` 的成员（真值），把「没有摘要」误判成「有摘要」。
 */
function ownedSummary(
	byId: Readonly<Record<string, DshSessionSummary>> | undefined,
	id: string
): DshSessionSummary | undefined {
	if (byId === undefined) return undefined;
	return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : undefined;
}

/**
 * 把归档 id 列表映射成行模型：保持宿主顺序、丢掉非字符串与重复 id、
 * **保留**没有摘要的 id（显示为「摘要缺失」而不是丢弃）。
 */
export function buildRows(
	archivedSessionIds: readonly unknown[] | undefined,
	byId: Readonly<Record<string, DshSessionSummary>> | undefined
): ArchivedRow[] {
	const rows: ArchivedRow[] = [];
	const seen = new Set<string>();
	for (const candidate of archivedSessionIds ?? []) {
		if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) continue;
		seen.add(candidate);
		rows.push(rowFor(candidate, ownedSummary(byId, candidate)));
	}
	return rows;
}

/** 关键词筛选：匹配标题 / 项目 / id；空白关键词返回全部（不修改入参）。 */
export function filterRows(rows: readonly ArchivedRow[], query: string): ArchivedRow[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return [...rows];
	return rows.filter((row) =>
		row.title.toLowerCase().includes(needle)
		|| row.cwd.toLowerCase().includes(needle)
		|| row.id.toLowerCase().includes(needle)
	);
}

/** 该行在给定维度上是否「无值」（无值的行永远排最后，与升降序无关）。 */
export function isMissingFor(row: ArchivedRow, key: SortKey): boolean {
	return key === 'title' ? row.title.length === 0 : row.updatedAtMs === null;
}

/** 排序：稳定排序；无值（无标题 / 无时间）永远排在最后。 */
export function sortRows(
	rows: readonly ArchivedRow[],
	key: SortKey,
	direction: SortDirection = 'desc'
): ArchivedRow[] {
	const factor = direction === 'asc' ? 1 : -1;
	const indexed = rows.map((row, index) => ({ row, index }));
	indexed.sort((a, b) => {
		const aMissing = isMissingFor(a.row, key);
		const bMissing = isMissingFor(b.row, key);
		if (aMissing !== bMissing) return aMissing ? 1 : -1;
		const compared = compareFor(a.row, b.row, key);
		if (compared !== 0) return compared * factor;
		return a.index - b.index;
	});
	return indexed.map((entry) => entry.row);
}

function compareFor(a: ArchivedRow, b: ArchivedRow, key: SortKey): number {
	if (key === 'title') return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
	const av = a.updatedAtMs ?? 0;
	const bv = b.updatedAtMs ?? 0;
	return av - bv;
}

/** 选择归一化：只保留仍存在于当前列表里的 id，并按列表顺序输出（去重）。 */
export function normalizeSelection(
	selected: Iterable<string>,
	available: readonly string[]
): string[] {
	const chosen = new Set(selected);
	const result: string[] = [];
	for (const id of available) {
		if (chosen.has(id)) result.push(id);
	}
	return result;
}

/** 切换单条选择。 */
export function toggleSelection(selected: Iterable<string>, id: string): string[] {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return [...next];
}

/** 兜底组 id：归档 id 不在任何工作区记账里（`sessionIds` 未覆盖）时使用。 */
export const UNASSIGNED_GROUP_ID = '__unassigned__';

/**
 * 行内是否要显示项目目录（`cwd`）。
 *
 * 列表已按工作区分组，组头（工作区标题 + `path`）与该行的 `cwd` 是同一串路径，
 * 行内再显示一次只是噪音（用户实测反馈 T8）。
 * **例外**：{@link UNASSIGNED_GROUP_ID} 兜底组的组头没有 `path`，必须保留行内 `cwd`，
 * 否则这些不属于任何工作区的行会失去位置信息。
 */
export function shouldShowRowCwd(groupId: string): boolean {
	return groupId === UNASSIGNED_GROUP_ID;
}

/** 一个工作区分组（或兜底组）。 */
export interface ArchivedGroup {
	/** 工作区 id；兜底组为 {@link UNASSIGNED_GROUP_ID}。 */
	readonly id: string;
	/** 工作区标题；兜底组为空串（渲染层查 i18n）。 */
	readonly title: string;
	/** 工作区目录；兜底组为空串。 */
	readonly path: string;
	/** 组内行（已按当前搜索/排序处理）。 */
	readonly rows: readonly ArchivedRow[];
}

/**
 * 由工作区视图的 `sessionIds` 建立 `sessionId → workspaceId` 反查表。
 * 不猜 cwd、不猜路径；畸形输入直接跳过。同一 id 出现在多个工作区时**先到先得**。
 *
 * 实现要点（verifier P17）：**内部用 `Map` 累积**，最后用 `Object.fromEntries` 导出普通对象。
 * 若直接用 `{}` 累积，`toString` / `constructor` / `__proto__` 这类原型键既会命中
 * `Object.prototype` 的成员（导致归属误判、整行丢失），`index['__proto__'] = ...`
 * 还是原型污染的写入面。导出成普通对象是为了保持 `index[id]` 的读取形状（有外部依赖）。
 */
export function buildWorkspaceIndex(views: readonly unknown[] | undefined): Record<string, string> {
	const owned = new Map<string, string>();
	for (const candidate of views ?? []) {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
		const view = candidate as Record<string, unknown>;
		const workspaceId = view.workspaceId;
		if (typeof workspaceId !== 'string' || workspaceId.length === 0) continue;
		if (!Array.isArray(view.sessionIds)) continue;
		for (const sessionId of view.sessionIds) {
			if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
			if (!owned.has(sessionId)) owned.set(sessionId, workspaceId);
		}
	}
	// `Object.fromEntries` 用 CreateDataProperty 建自有属性：`__proto__` 也只是普通键。
	return Object.fromEntries(owned);
}

/**
 * 只在**自有键**上取归属；否则返回 `undefined` 交给兜底组。
 * 直接用 `index[id]` 时，原型键会命中 `Object.prototype` 的真值成员，
 * 使 `?? UNASSIGNED_GROUP_ID` 不触发 → 行落入没有 meta 的组 → 整行从 UI 消失。
 */
function ownedIndexOf(index: Record<string, string>, sessionId: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(index, sessionId) ? index[sessionId] : undefined;
}

/** 读取工作区视图的可见元数据。 */
function workspaceMetaOf(view: Record<string, unknown>): { title: string; path: string } {
	return {
		title: typeof view.title === 'string' ? view.title.trim() : '',
		path: typeof view.path === 'string' ? view.path.trim() : ''
	};
}

/**
 * 按工作区分组：组顺序 = 官方 `items` 顺序；映射不到的 id 进
 * {@link UNASSIGNED_GROUP_ID} 兜底组（排最后，**绝不丢弃**）；没有命中的工作区不产生组。
 */
export function groupRowsByWorkspace(
	rows: readonly ArchivedRow[],
	views: readonly unknown[] | undefined
): ArchivedGroup[] {
	const index = buildWorkspaceIndex(views);
	const meta = new Map<string, { title: string; path: string }>();
	for (const candidate of views ?? []) {
		if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
		const view = candidate as Record<string, unknown>;
		const workspaceId = view.workspaceId;
		if (typeof workspaceId !== 'string' || workspaceId.length === 0 || meta.has(workspaceId)) continue;
		meta.set(workspaceId, workspaceMetaOf(view));
	}

	const buckets = new Map<string, ArchivedRow[]>();
	for (const row of rows) {
		const groupId = ownedIndexOf(index, row.id) ?? UNASSIGNED_GROUP_ID;
		const bucket = buckets.get(groupId);
		if (bucket === undefined) buckets.set(groupId, [row]);
		else bucket.push(row);
	}

	const groups: ArchivedGroup[] = [];
	for (const [workspaceId, info] of meta) {
		const bucket = buckets.get(workspaceId);
		if (bucket === undefined || bucket.length === 0) continue;
		groups.push({ id: workspaceId, title: info.title, path: info.path, rows: bucket });
	}
	const unassigned = buckets.get(UNASSIGNED_GROUP_ID);
	if (unassigned !== undefined && unassigned.length > 0) {
		groups.push({ id: UNASSIGNED_GROUP_ID, title: '', path: '', rows: unassigned });
	}
	return groups;
}

/** 组内搜索：零命中的组整组隐藏，不产生空组头。 */
export function filterGroups(groups: readonly ArchivedGroup[], query: string): ArchivedGroup[] {
	const needle = query.trim().toLowerCase();
	const result: ArchivedGroup[] = [];
	for (const group of groups) {
		const rows = needle.length === 0 ? [...group.rows] : filterRows(group.rows, needle);
		if (rows.length === 0) continue;
		result.push({ id: group.id, title: group.title, path: group.path, rows });
	}
	return result;
}

/** 组内排序（组本身顺序不变）。 */
export function sortGroupRows(
	groups: readonly ArchivedGroup[],
	key: SortKey,
	direction: SortDirection = 'desc'
): ArchivedGroup[] {
	return groups.map((group) => ({
		id: group.id,
		title: group.title,
		path: group.path,
		rows: sortRows(group.rows, key, direction)
	}));
}

/** 分组 → 组内筛选 → 组内排序（一次性组合，供组件使用）。 */
export function buildGroups(
	rows: readonly ArchivedRow[],
	views: readonly unknown[] | undefined,
	query: string,
	key: SortKey,
	direction: SortDirection = 'desc'
): ArchivedGroup[] {
	return sortGroupRows(filterGroups(groupRowsByWorkspace(rows, views), query), key, direction);
}

/** 展平所有可见组的行 id（跨组「全选当前筛选结果」用）。 */
export function groupsRowIds(groups: readonly ArchivedGroup[]): string[] {
	return groups.flatMap((group) => group.rows.map((row) => row.id));
}

/**
 * 从已归档行里剔除**已回收**的 id（T9 / P0 幽灵行）。
 *
 * 宿主删除时只移动工件，**不会**清理 `workspace.json` 的 `archivedSessionIds`（lead 裁决：
 * 不在宿主侧 unarchive，避免工件已移走的会话回到官方侧栏主列表）。因此客户端必须用
 * `GET /list` 的回收站条目把已经回收、但归档集合里仍留着的 id 过滤掉，否则刷新页面后
 * 它们会以「摘要缺失」的幽灵行重新出现（PLAN 风险 R1 / 验收 A5）。
 */
export function excludeRecycled(
	rows: readonly ArchivedRow[],
	recycledIds: ReadonlySet<string>
): ArchivedRow[] {
	if (recycledIds.size === 0) return [...rows];
	return rows.filter((row) => !recycledIds.has(row.id));
}

/**
 * 官方 `relativeTime()` 返回单位的全集。
 * 来源：asar 内 `dsh-client-ui-primitives/lib/index.js` 的
 * `function relativeTime(at, now)` —— 依次返回 `now|minutes|hours|days|months|years`。
 */
export const TIME_UNITS = ['now', 'minutes', 'hours', 'days', 'months', 'years'] as const;

/**
 * 把官方 `relativeTime()` 的 `{ unit }` 映射成词典 key。
 * 认不出的单位降级成 `time.unknown`（官方将来新增单位也不会崩，也不会露出 `time.xxx` 生 key）。
 */
export function timePhraseKey(unit: unknown): string {
	return typeof unit === 'string' && (TIME_UNITS as readonly string[]).includes(unit)
		? `time.${unit}`
		: 'time.unknown';
}

/** 宿主契约里的稳定错误码全集（顺序与 `contracts.ts` 的文档一致）。 */
export const HOST_ERROR_CODES: readonly HostErrorCode[] = [
	'invalid-input',
	'session-live',
	'session-missing',
	'path-unsafe',
	'entry-not-found',
	'entry-conflict',
	'cross-device',
	'child-session',
	'internal',
	// T12 追加：对已移交冷存档区的条目调用 restore。
	'entry-purged'
];

/**
 * 归一化错误码：未知码（宿主将来新增）降级成 `'unknown'`，绝不抛错、绝不崩。
 */
export function hostErrorCode(value: unknown): HostErrorCode | 'unknown' {
	return typeof value === 'string' && (HOST_ERROR_CODES as readonly string[]).includes(value)
		? (value as HostErrorCode)
		: 'unknown';
}

/** 归一化后的失败信息。 */
export interface ApiFailure {
	/** HTTP 状态码；`0` 表示请求根本没发出去（网络层异常）。 */
	readonly status: number;
	readonly code: HostErrorCode | 'unknown';
	/** 宿主技术详情，只作兜底展示。 */
	readonly message: string;
	/** 相关 id（如 `session-live` 时正在运行的会话）。 */
	readonly ids: readonly string[];
}

/** 把 4xx/5xx 响应体归一化成 {@link ApiFailure}；任何畸形输入都降级而不是抛错。 */
export function parseApiFailure(status: number, body: unknown): ApiFailure {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { status, code: 'unknown', message: '', ids: [] };
	}
	const source = body as Record<string, unknown>;
	const ids = Array.isArray(source.ids)
		? source.ids.filter((item): item is string => typeof item === 'string')
		: [];
	return {
		status,
		code: hostErrorCode(source.code),
		message: typeof source.message === 'string' ? source.message : '',
		ids
	};
}

/** `JSON.parse` 的安全版本：失败返回 `null`。 */
export function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** 调用结果：成功带数据，失败带 {@link ApiFailure}。 */
export type HostApiResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly failure: ApiFailure };

/**
 * 同源 `fetch` 调用宿主路由。
 * `path` 直接传 `contracts.ts` 的 `HOST_ROUTES.*`（**已自带 `/api/` 前缀**，
 * 见该文件里 `assertFetchRoute` 的修正说明），这里不再拼任何前缀。
 * 鉴权由官方通道完成，这里只做 JSON 编解码与错误归一化。
 */
export async function requestJson<T>(
	method: 'GET' | 'POST',
	path: string,
	payload: unknown,
	fetchImpl?: typeof fetch
): Promise<HostApiResult<T>> {
	const send = fetchImpl ?? globalThis.fetch;
	try {
		const init: RequestInit = { method, credentials: 'same-origin' };
		if (method === 'POST') {
			init.headers = { 'content-type': 'application/json' };
			init.body = JSON.stringify(payload);
		}
		const response = await send(path, init);
		const text = await response.text();
		const parsed = text.length === 0 ? null : safeJson(text);
		if (!response.ok) return { ok: false, failure: parseApiFailure(response.status, parsed) };
		return { ok: true, data: parsed as T };
	} catch (error) {
		return { ok: false, failure: { status: 0, code: 'unknown', message: errorMessage(error), ids: [] } };
	}
}

/** `POST` 的便捷封装。 */
export function postJson<T>(path: string, payload: unknown, fetchImpl?: typeof fetch): Promise<HostApiResult<T>> {
	return requestJson<T>('POST', path, payload, fetchImpl);
}

/** `GET` 的便捷封装（回收站清单用）。 */
export function getJson<T>(path: string, fetchImpl?: typeof fetch): Promise<HostApiResult<T>> {
	return requestJson<T>('GET', path, undefined, fetchImpl);
}

/** 按 {@link MAX_BATCH} 切块（批量删除分多次请求，避免宿主瞬时过载）。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const step = Number.isFinite(size) && size >= 1 ? Math.floor(size) : items.length || 1;
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += step) chunks.push(items.slice(index, index + step));
	return chunks;
}

/** 按 {@link MAX_BATCH} 把批量操作切块（与契约上限保持一致）。 */
export function batchChunks<T>(items: readonly T[]): T[][] {
	return chunk(items, MAX_BATCH);
}

/** `POST /recycle` 成功响应的归一化结果：200 里的逐条失败同样要能本地化。 */
export interface RecycleOutcome {
	readonly moved: readonly string[];
	readonly failures: readonly ApiFailure[];
}

/**
 * 归一化 `POST /recycle` 的 200 响应体。
 * 严格按契约形状读取（`{ moved, failed[] }`），畸形字段降级为空，绝不抛错。
 */
/**
 * 归一化契约里的 `Failure[]`（批量结果里的逐条失败）。
 * `code` 一律过 {@link hostErrorCode}，未知码降级成 `'unknown'`。
 */
export function parseFailures(value: unknown): ApiFailure[] {
	if (!Array.isArray(value)) return [];
	const failures: ApiFailure[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
		const failure = raw as Record<string, unknown>;
		failures.push({
			status: 200,
			code: hostErrorCode(failure.code),
			message: typeof failure.message === 'string' ? failure.message : '',
			ids: typeof failure.id === 'string' ? [failure.id] : []
		});
	}
	return failures;
}

/**
 * 归一化 `POST /recycle` 的 200 响应体。
 * 严格按契约形状读取（`{ moved, failed[] }`），畸形字段降级为空，绝不抛错。
 */
export function parseRecycleResponse(body: unknown): RecycleOutcome {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { moved: [], failures: [] };
	}
	const source = body as Record<string, unknown>;
	const moved = Array.isArray(source.moved)
		? source.moved.filter((item): item is string => typeof item === 'string')
		: [];
	return { moved, failures: parseFailures(source.failed) };
}

/** 页面模型三态 + 兜底态。 */
export type ArchivedPhase = 'loading' | 'ready' | 'error' | 'unsupported';

/** {@link useArchivedSessions} 需要的 standardProps 子集。 */
export interface ArchivedSessionsSource {
	readonly useWorkspaces?: DshStoreHook<DshWorkspaceSnapshot>;
	readonly useSessions?: DshStoreHook<DshSessionsSnapshot>;
}

/** 页面模型。 */
export interface ArchivedSessionsModel {
	readonly phase: ArchivedPhase;
	readonly rows: readonly ArchivedRow[];
	/** 工作区视图（分组用）；数据源未提供时为空数组。 */
	readonly workspaces: readonly unknown[];
	readonly error: unknown;
}

/**
 * 条目是否已移交冷存档区（T12）。
 *
 * 宿主 `purge` 只把 `session/` 载荷移走、`manifest.json` 留在回收站并写入 `purgedAt`，
 * 因此这类条目**仍然出现在 `/list` 里**（这正是过滤能跨刷新持久的原因），但**不可还原**。
 */
export function isPurgedEntry(entry: Pick<RecycleEntry, 'purgedAt'>): boolean {
	return typeof entry.purgedAt === 'string' && entry.purgedAt.length > 0;
}

/** 单条还原的准入判定（UI 与调用路径共用同一份判定，避免两处各判一次）。 */
export function restoreGuard(entry: Pick<RecycleEntry, 'purgedAt'>): {
	readonly allowed: boolean;
	readonly purged: boolean;
	readonly reasonKey: string;
} {
	const purged = isPurgedEntry(entry);
	return purged
		? { allowed: false, purged: true, reasonKey: 'error.entry-purged' }
		: { allowed: true, purged: false, reasonKey: '' };
}

/** 视图侧输入（组件拥有的本地交互状态）。 */
export interface SectionViewInput {
	/** `GET /list` 归一化后的**全部**条目（含已移交冷存档区的）。 */
	readonly recycleEntries: readonly RecycleEntry[];
	/** 删除/恢复成功后的本地乐观隐藏（下一次成功刷新后由清单接管）。 */
	readonly optimisticGone: readonly string[];
	readonly query: string;
	readonly sortKey: SortKey;
	readonly direction?: SortDirection;
	readonly selectedIds: readonly string[];
}

/** {@link buildSectionModel} 的完整输入。 */
export interface ArchivedSectionInput extends SectionViewInput {
	readonly workspace: DshWorkspaceSnapshot | undefined;
	readonly sessions: DshSessionsSnapshot | undefined;
}

/** 回收站页签的一行。 */
export interface RecycleRow {
	readonly entry: RecycleEntry;
	readonly purged: boolean;
	readonly canRestore: boolean;
	readonly reasonKey: string;
}

/**
 * 「原始输入 → 最终视图模型」的**唯一**派生入口（T14）。
 *
 * 为什么要有它：A5 的判据是「喂一份真实 `/list` 响应后，最终列表里确实没有那些 id」，
 * 而这条链此前只能用源码文本断言守着（SSR 跑不到 `useEffect`，hook 停在初始态）。
 * 抽成纯函数后，测试可以**真执行**整条链：workspace 快照 + 会话摘要 + `/list` 条目 → 最终分组。
 *
 * 语义要点（不得改变）：
 * - **过滤发生在分组之前**：已回收 id 先被剔除，再分组；因此被清空的工作区不会留下空组头。
 * - 已回收 id = `/list` 全量条目（active + purged）∪ 本地乐观隐藏 → 跨刷新持久。
 * - 纯函数：不读时钟、不读存储、不产生副作用，可重放。
 */
export function buildSectionModel(input: ArchivedSectionInput): ArchivedSectionModel {
	const workspace = input.workspace;
	const phase = resolvePhase(workspace);
	const rows = workspace === undefined
		? []
		: buildRows(workspace.archivedSessionIds, input.sessions?.byId);
	const workspaces: readonly unknown[] = workspace !== undefined && Array.isArray(workspace.items)
		? workspace.items
		: [];

	// 已回收：清单全量条目 + 本地乐观隐藏。
	const recycled = new Set<string>();
	for (const entry of input.recycleEntries) recycled.add(entry.sessionId);
	for (const id of input.optimisticGone) recycled.add(id);

	// 先过滤、后分组（顺序是 A5 的语义核心）。
	const alive = rows.filter((row) => !recycled.has(row.id));
	const direction = input.direction ?? (input.sortKey === 'title' ? 'asc' : 'desc');
	const groups = buildGroups(alive, workspaces, input.query, input.sortKey, direction);
	const listedIds = groupsRowIds(groups);
	const selected = normalizeSelection(input.selectedIds, listedIds);

	const recycleRows: RecycleRow[] = input.recycleEntries.map((entry) => {
		const guard = restoreGuard(entry);
		return { entry, purged: guard.purged, canRestore: guard.allowed, reasonKey: guard.reasonKey };
	});

	return {
		phase,
		error: workspace?.error,
		rows,
		alive,
		workspaces,
		groups,
		listedIds,
		selected,
		allSelected: listedIds.length > 0 && selected.length === listedIds.length,
		recycledIds: [...recycled].sort(),
		recycleRows,
		activeRecycleCount: recycleRows.filter((row) => !row.purged).length,
		purgedCount: recycleRows.filter((row) => row.purged).length
	};
}

/** {@link buildSectionModel} 的产物：组件渲染所需的全部派生结果。 */
export interface ArchivedSectionModel {
	readonly phase: ArchivedPhase;
	readonly error: unknown;
	/** 归档全集（未经回收过滤）。 */
	readonly rows: readonly ArchivedRow[];
	/** 过滤后的可见行。 */
	readonly alive: readonly ArchivedRow[];
	readonly workspaces: readonly unknown[];
	/** 分组 → 组内搜索 → 组内排序后的最终列表。 */
	readonly groups: readonly ArchivedGroup[];
	readonly listedIds: readonly string[];
	readonly selected: readonly string[];
	readonly allSelected: boolean;
	/** 已回收（含已清空）的会话 id，已排序，便于断言与比较。 */
	readonly recycledIds: readonly string[];
	readonly recycleRows: readonly RecycleRow[];
	readonly activeRecycleCount: number;
	readonly purgedCount: number;
}

/**
 * 工作区快照的就绪判定。
 *
 * `WorkspaceSnapshot` 同时有 `state` 与 `phase`：
 * - **真实就绪** = `state: 'idle'` + `phase: 'ready'`（`state` 的联合类型里**没有** `'ready'`）；
 * - **真实加载中** = `state: 'loading'` + `phase: 'pending'`。
 * 只看 `state` 会把「已就绪但归档集合为空」误判成 loading → 空态永远不可达（T7 修）。
 * 证据：`dsh-api-workspace-controller/lib/client.js` 的
 * `state = "loading"; phase = "pending"`，以及基线安装后的
 * `this.state = "idle"; this.phase = "ready";`；`buildSnapshot()` 同时返回二者。
 * `phase` 缺失（老快照 / 测试桩）时按**已就绪**处理，避免永久转圈。
 */
export function resolvePhase(
	workspace: { readonly state?: string; readonly phase?: string } | undefined
): ArchivedPhase {
	if (workspace === undefined) return 'unsupported';
	if (workspace.state === 'error') return 'error';
	if (workspace.phase === 'ready') return 'ready';
	if (workspace.state === 'loading' || workspace.phase === 'pending') return 'loading';
	return 'ready';
}

/** 页签。 */
export type SectionTab = 'archived' | 'recycle';

/**
 * 归一化**初始**页签（T15 测试缝）。
 *
 * 这是"测试缝"：SSR / 单测要渲染回收站页签只能靠初值注入（`renderToStaticMarkup`
 * 点不了按钮）。真实路径下插槽不传这个 prop，因此恒为 `'archived'`。
 * 只接受 `'recycle'` 这一个字面量，其余（含 `undefined`、被误注入的任意值）一律折回
 * `'archived'` —— 因此即使外部真塞了同名 prop 也不会改变默认行为。
 */
export function resolveInitialTab(value: unknown): SectionTab {
	return value === 'recycle' ? 'recycle' : 'archived';
}

/** 稳定的 selector（模块级常量，避免每次渲染重新订阅）。 */
const selectWorkspace = (snapshot: DshWorkspaceSnapshot): DshWorkspaceSnapshot => snapshot;
const selectSessions = (snapshot: DshSessionsSnapshot): DshSessionsSnapshot => snapshot;

/**
 * 订阅归档集合 / 工作区视图 / 会话摘要，并**调用 {@link buildSectionModel}** 得到最终视图模型。
 *
 * 钩子本身不做任何派生：它只负责订阅 + 把组件本地状态一起喂给那唯一一个纯函数，
 * 因此「渲染用的模型」与「测试断言的模型」永远是同一份代码路径。
 * `retryToken` 变化时强制重算（「重试」按钮用）。
 */
export function useArchivedSessions(
	source: ArchivedSessionsSource,
	view: SectionViewInput,
	retryToken: number
): ArchivedSectionModel {
	const useWorkspaces = source.useWorkspaces;
	const useSessions = source.useSessions;
	// standardProps 恒为同一批函数，因此这两个分支在组件生命周期内稳定，不会破坏 Hook 次序。
	const workspace = useWorkspaces === undefined ? undefined : useWorkspaces(selectWorkspace);
	const sessions = useSessions === undefined ? undefined : useSessions(selectSessions);

	return useMemo<ArchivedSectionModel>(
		() => buildSectionModel({ workspace, sessions, ...view }),
		// 逐项列依赖：`view` 对象每次渲染都是新引用，不能整体当依赖。
		[
			workspace,
			sessions,
			view.recycleEntries,
			view.optimisticGone,
			view.query,
			view.sortKey,
			view.direction,
			view.selectedIds,
			retryToken
		]
	);
}
