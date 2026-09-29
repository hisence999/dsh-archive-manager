/**
 * 回收站数据层（T9）。
 *
 * 存在的理由（P0「幽灵行」）：宿主删除会话时只把工件**移动**到回收站，
 * `$DSH_HOME/storages/workspace.json` 的 `archivedSessionIds` **不会**被清理
 * （lead 裁决：不在宿主侧 unarchive，否则工件已移走的会话会回到官方侧栏主列表）。
 * 因此客户端必须自己读回收站清单，把这些 id 从「已归档」视图里过滤掉，
 * 否则刷新页面后会以「摘要缺失」的幽灵行回来。
 *
 * 本文件只依赖契约与同目录的 HTTP/错误工具，**不 import 官方 primitives**，
 * 以便纯逻辑能被 `test/client.test.mjs` 直接单测。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ListResponse, RecycleEntry } from '../contracts.js';
import { HOST_ROUTES, parseEntryId } from '../contracts.js';
import { getJson, parseFailures } from './useArchivedSessions.js';
import type { ApiFailure } from './useArchivedSessions.js';

/** 回收站视图相位。 */
export type RecycleBinPhase = 'loading' | 'ready' | 'error';

/** `POST /restore` 的归一化结果。 */
export interface RestoreOutcome {
	readonly restored: readonly string[];
	readonly failures: readonly ApiFailure[];
}

/** `POST /purge` 的归一化结果。 */
export interface PurgeOutcome {
	readonly purged: number;
	readonly failures: readonly ApiFailure[];
}

/** 单个回收条目的归一化：畸形条目返回 `undefined`（宁可少一条，也不崩）。 */
export function normalizeRecycleEntry(raw: unknown): RecycleEntry | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const entryId = typeof source.entryId === 'string' ? source.entryId : '';
	const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
	if (entryId.length === 0 || sessionId.length === 0) return undefined;
	try {
		// 契约校验：entryId 必须是 `<movedAt>@<sessionId>`（宿主是唯一生成者）。
		parseEntryId(entryId);
	} catch {
		return undefined;
	}
	const bytes = typeof source.bytes === 'number' && Number.isFinite(source.bytes) && source.bytes >= 0
		? Math.round(source.bytes)
		: 0;
	const title = typeof source.title === 'string' ? source.title.trim() : '';
	const cwd = typeof source.cwd === 'string' ? source.cwd.trim() : '';
	// T12 台账：`purgedAt` 存在 = 载荷已移交冷存档区（条目仍在回收站清单里，但不可还原）。
	const purgedAt = typeof source.purgedAt === 'string' ? source.purgedAt.trim() : '';
	const purgedBatch = typeof source.purgedBatch === 'string' ? source.purgedBatch.trim() : '';
	return {
		entryId,
		sessionId,
		movedAt: typeof source.movedAt === 'string' ? source.movedAt : '',
		originalPath: typeof source.originalPath === 'string' ? source.originalPath : '',
		bytes,
		...(title.length > 0 ? { title } : {}),
		...(cwd.length > 0 ? { cwd } : {}),
		...(purgedAt.length > 0 ? { purgedAt } : {}),
		...(purgedBatch.length > 0 ? { purgedBatch } : {})
	};
}

/**
 * `isPurgedEntry` / `restoreGuard` 定义在 `useArchivedSessions.ts`
 * —— 那里是纯派生模型的家（`buildSectionModel` 也要用它们），放这里会形成循环依赖。
 * 此处原样转出，保持既有导入面不变。
 */
export { isPurgedEntry, restoreGuard } from './useArchivedSessions.js';

/** 归一化 `GET /list` 响应体（`{ entries: RecycleEntry[] }`）。 */
export function parseRecycleEntries(body: unknown): RecycleEntry[] {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
	const source = body as Record<string, unknown>;
	if (!Array.isArray(source.entries)) return [];
	const entries: RecycleEntry[] = [];
	for (const raw of source.entries) {
		const entry = normalizeRecycleEntry(raw);
		if (entry !== undefined) entries.push(entry);
	}
	return entries;
}

/** 归一化 `POST /restore` 响应体。 */
export function parseRestoreOutcome(body: unknown): RestoreOutcome {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { restored: [], failures: [] };
	}
	const source = body as Record<string, unknown>;
	const restored = Array.isArray(source.restored)
		? source.restored.filter((item): item is string => typeof item === 'string')
		: [];
	return { restored, failures: parseFailures(source.failed) };
}

/** 归一化 `POST /purge` 响应体（`failed[]` 也要展示，见 T6 的 F3 裁决）。 */
export function parsePurgeOutcome(body: unknown): PurgeOutcome {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { purged: 0, failures: [] };
	}
	const source = body as Record<string, unknown>;
	const purged = typeof source.purged === 'number' && Number.isFinite(source.purged) && source.purged >= 0
		? Math.round(source.purged)
		: 0;
	return { purged, failures: parseFailures(source.failed) };
}

/** 回收站视图。 */
export interface RecycleBinView {
	readonly phase: RecycleBinPhase;
	/** `/list` 的全部条目，含已移交冷存档区的（`purgedAt` 存在）。 */
	readonly entries: readonly RecycleEntry[];
	/** `/list` 失败时的归一化错误；成功时为 `undefined`。 */
	readonly error: ApiFailure | undefined;
	/**
	 * 应当从「已归档」视图里剔除的会话 id。
	 * **覆盖 `/list` 的全部条目**（active + 已移交冷存档区的 purged），
	 * 所以过滤跨刷新持久，不再需要内存墓碑兜底（T12）。
	 */
	readonly recycledIds: ReadonlySet<string>;
	/** 成功加载次数；`> 0` 表示已成功拉取过（可用于交棒乐观隐藏）。 */
	readonly loadedToken: number;
	refresh(): Promise<void>;
	/** 删除成功后立即隐藏（下次成功 refresh 后由清单接管）。 */
	markRecycled(ids: readonly string[]): void;
	/** 还原成功后取消本地隐藏。 */
	forgetRecycled(ids: readonly string[]): void;
}

/**
 * 订阅回收站清单：挂载时自动拉取，并在每次 recycle/restore/purge 之后由调用方 `refresh()`。
 *
 * 幽灵行过滤的唯一真源就是这份清单：
 * - 宿主 `purge` 只移走 `session/` 载荷、把 `manifest.json` 留在回收站并写入 `purgedAt`，
 *   因此已清空的条目**仍然在 `/list` 里**，{@link RecycleBinView.recycledIds} 自然覆盖它们，
 *   刷新页面后也不会再有幽灵行（T12）。
 *
 * `/list` 失败**不抛错、不整页报错**：相位变成 `error`，`recycledIds` 只保留本地乐观集合，
 * 「已归档」视图照常渲染（优雅降级）。
 *
 * @param options.initialEntries - **测试缝（T15）**：仅供 SSR / 单测预置首屏条目
 *   （`renderToStaticMarkup` 不跑 `useEffect`，否则回收站页签只能渲染「读取中」）。
 *   真实路径不传，`entries` 从 `[]` 起步、由 `GET /list` 填充。
 */
export function useRecycleBin(options?: { readonly initialEntries?: readonly RecycleEntry[] }): RecycleBinView {
	const seed = options?.initialEntries;
	const [entries, setEntries] = useState<readonly RecycleEntry[]>(() => seed ?? []);
	// 预置了条目就直接是 ready，否则等第一次 `/list`。
	const [phase, setPhase] = useState<RecycleBinPhase>(() =>
		seed !== undefined && seed.length > 0 ? 'ready' : 'loading'
	);
	const [error, setError] = useState<ApiFailure | undefined>(undefined);
	// 删除后、清单刷新前的乐观隐藏。
	const [optimistic, setOptimistic] = useState<readonly string[]>([]);
	const [loadedToken, setLoadedToken] = useState(0);

	const refresh = useCallback(async (): Promise<void> => {
		const result = await getJson<ListResponse>(HOST_ROUTES.list);
		if (result.ok) {
			setEntries(parseRecycleEntries(result.data));
			setPhase('ready');
			setError(undefined);
			setLoadedToken((count) => count + 1);
		} else {
			// 失败时保留上一次的 entries，避免把已知的回收记录丢掉。
			setPhase('error');
			setError(result.failure);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 清单成功后，乐观隐藏交棒给 `entries`（避免本地集合与真源长期分叉）。
	useEffect(() => {
		if (loadedToken > 0) setOptimistic((prev) => (prev.length === 0 ? prev : []));
	}, [loadedToken]);

	const recycledIds = useMemo(() => {
		// `/list` 的全部条目（含 purged）都要过滤掉——这样跨刷新也成立。
		const ids = new Set<string>();
		for (const entry of entries) ids.add(entry.sessionId);
		for (const id of optimistic) ids.add(id);
		return ids;
	}, [entries, optimistic]);

	const markRecycled = useCallback((ids: readonly string[]) => {
		if (ids.length === 0) return;
		setOptimistic((prev) => [...new Set([...prev, ...ids])]);
	}, []);

	const forgetRecycled = useCallback((ids: readonly string[]) => {
		if (ids.length === 0) return;
		const drop = new Set(ids);
		setOptimistic((prev) => prev.filter((id) => !drop.has(id)));
	}, []);

	return { phase, entries, error, recycledIds, loadedToken, refresh, markRecycled, forgetRecycled };
}
