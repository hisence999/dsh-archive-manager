/**
 * 「已归档会话 / 回收站」设置页。
 *
 * 保真度（T10）：控件、图标、格式化一律走官方免费基座
 * `@deepseek-ai/dsh-client-ui-primitives`，因此形态与 DSH 同源：
 * - `SegmentedTabs`（页签）、`Input`（搜索）、`Checkbox`（全选）、`Button`（全部动作）、
 *   `Pill`（计数徽标）、`Tooltip`（图标按钮提示）、`Modal` / `RiskConfirmation`（二次确认）、
 *   `PathLabel`（路径）、`relativeTime` / `fileSizeText`（格式化）、官方 `Icon*` 图标集。
 * - 颜色只用 `--dsw-*` 令牌；行是**扁平行 + 0.5px 细分隔线**（对齐「通用设置」页的宽松节奏），
 *   没有圆角描边卡片。
 * - 破坏性操作用**红色文字、无描边**（官方 `Button` 只有 primary/ghost/outline/toolbar，
 *   没有 danger 变体，所以用 `--dsw-alias-state-error-primary` 上色）。
 *
 * 行为约束：
 * - 列表按工作区分组（`WorkspaceSnapshot.items[].sessionIds` 反查，不猜 cwd）；
 *   搜索/排序在组内生效，零命中的组整组隐藏；行内不重复显示目录（兜底组例外）。
 * - 恢复走官方 `ctx.workspaces.unarchiveSession(id)`，逐条串行；
 *   删除 / 还原 / 清空走宿主 `/api/dsh-archive-manager/*`，失败按稳定 `code` 本地化。
 * - **幽灵行（P0）**：宿主删除只移动工件、不清理 `archivedSessionIds`，因此「已归档」
 *   视图必须用回收站清单（`GET /list`）过滤掉已回收的 id，见 `excludeRecycled`。
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import {
	Button,
	Checkbox,
	IconArchiveOutlineRegular,
	IconChevronDownOutlineRegular,
	IconRefreshOutlineRegular,
	IconSearchOutlineRegular,
	IconTrashOutlineRegular,
	IconUnarchiveOutlineRegular,
	Input,
	Modal,
	PathLabel,
	Pill,
	RiskConfirmation,
	SegmentedTabs,
	Tag,
	Tooltip,
	fileSizeText,
	relativeTime
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { RecycleEntry } from '../contracts.js';
import { HOST_ROUTES, SETTINGS_SECTION_ID } from '../contracts.js';
import { createTranslate } from './locales.js';
import type { Translate } from './locales.js';
import {
	UNASSIGNED_GROUP_ID,
	batchChunks,
	parseRecycleResponse,
	postJson,
	resolveInitialTab,
	shouldShowRowCwd,
	timePhraseKey,
	toggleSelection,
	useArchivedSessions
} from './useArchivedSessions.js';
import type { ApiFailure, ArchivedGroup, ArchivedRow, SectionTab, SortKey } from './useArchivedSessions.js';
import { parsePurgeOutcome, parseRestoreOutcome, restoreGuard, useRecycleBin } from './useRecycleBin.js';

/** 一次操作的提示。 */
interface Notice {
	readonly kind: 'success' | 'error';
	readonly text: string;
	readonly failure?: ApiFailure;
}

/** 待二次确认的操作。 */
interface PendingAction {
	readonly kind: 'recycle' | 'restore';
	readonly ids: readonly string[];
}

const token = {
	labelPrimary: 'var(--dsw-alias-label-primary)',
	labelSecondary: 'var(--dsw-alias-label-secondary)',
	labelTertiary: 'var(--dsw-alias-label-tertiary)',
	labelError: 'var(--dsw-alias-label-error)',
	bgLayer1: 'var(--dsw-alias-bg-layer-1)',
	bgLayer2: 'var(--dsw-alias-bg-layer-2)',
	bgLayer3: 'var(--dsw-alias-bg-layer-3)',
	borderL2: 'var(--dsw-alias-border-l2)',
	error: 'var(--dsw-alias-state-error-primary)',
	radiusMd: 'var(--dsw-radius-md)'
} as const;

const styles = {
	root: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 0 24px' },
	// 字重 600：官方 16px 的"strong"令牌是 500（`--dsw-font-base-strong-16`），
	// 但页面**标题**要压过它 —— 官方在更强的标题层级用 600（`--dsw-font-xl-24`、`--dsw-font-markdown-base-strong`）。
	title: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 600, color: token.labelPrimary },
	description: { margin: '4px 0 0', fontSize: '13px', lineHeight: '1.6', color: token.labelSecondary },
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '14px 0',
		borderTop: `0.5px solid ${token.borderL2}`
	},
	search: { flex: 1, minWidth: 0 },
	select: {
		height: '32px',
		padding: '0 8px',
		border: 'none',
		borderRadius: token.radiusMd,
		background: token.bgLayer1,
		font: 'inherit',
		fontSize: '13px',
		color: token.labelPrimary
	},
	sortLabel: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		fontSize: '12px',
		color: token.labelTertiary
	},
	selectionRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 0'
	},
	group: { display: 'flex', flexDirection: 'column' },
	groupHead: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '18px 0 6px',
		borderTop: `0.5px solid ${token.borderL2}`
	},
	groupToggle: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
		padding: 0,
		border: 'none',
		background: 'transparent',
		font: 'inherit',
		fontSize: '15px',
		fontWeight: 500,
		lineHeight: '1.5',
		color: token.labelPrimary,
		cursor: 'pointer'
	},
	chevron: { display: 'inline-flex', color: token.labelTertiary, transition: 'transform 120ms ease' },
	groupPath: { display: 'block', padding: '0 0 6px 22px', fontSize: '12px', lineHeight: '1.5', color: token.labelTertiary },
	list: { listStyle: 'none', margin: 0, padding: 0 },
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: '12px',
		padding: '14px 0',
		borderTop: `0.5px solid ${token.borderL2}`
	},
	rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
	rowTitle: {
		fontSize: '15px',
		fontWeight: 400,
		lineHeight: '1.45',
		color: token.labelPrimary,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap'
	},
	rowMeta: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '12px',
		lineHeight: '1.5',
		color: token.labelTertiary
	},
	rowActions: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
	tooltipAnchor: { display: 'inline-flex' },
	rowCwd: { display: 'inline-block', maxWidth: '100%', fontSize: '12px' },
	state: {
		padding: '28px 0',
		borderTop: `0.5px solid ${token.borderL2}`,
		fontSize: '13px',
		lineHeight: '1.6',
		color: token.labelSecondary
	},
	stateTitle: { color: token.labelPrimary, marginBottom: '4px' },
	batch: {
		position: 'sticky',
		bottom: 0,
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '12px 0',
		borderTop: `0.5px solid ${token.borderL2}`,
		background: token.bgLayer2
	},
	notice: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: '8px',
		margin: '4px 0',
		padding: '10px 12px',
		borderRadius: token.radiusMd,
		background: token.bgLayer3,
		fontSize: '12px',
		lineHeight: '1.6'
	},
	detail: { margin: '6px 0 0', fontSize: '11px', lineHeight: '1.6', color: token.labelTertiary, wordBreak: 'break-all' },
	dangerText: { color: token.error },
	degraded: { margin: 0, padding: '4px 0', fontSize: '12px', lineHeight: '1.6', color: token.labelTertiary }
} satisfies Record<string, CSSProperties>;

/** 渲染单条失败：主文案按稳定 `code` 本地化，宿主 `message` 只作技术详情。 */
function FailureBlock({ failure, t }: { failure: ApiFailure; t: Translate }): JSX.Element {
	const liveIds = failure.code === 'session-live' ? failure.ids : [];
	return (
		<div>
			<div>{t(`error.${failure.code}`)}</div>
			{liveIds.length > 0 ? (
				<div style={{ marginTop: '4px' }}>{t('error.sessionLiveHint', { count: liveIds.length })}</div>
			) : null}
			{failure.message.length > 0 ? (
				<details>
					<summary style={{ cursor: 'pointer' }}>{t('error.technical')}</summary>
					<pre style={styles.detail}>{`HTTP ${failure.status}: ${failure.message}`}</pre>
				</details>
			) : null}
		</div>
	);
}

/** 官方 `relativeTime` 的 `{unit,n}` → 本地化文案；时间缺失时走 `time.unknown`。 */
function timeText(atMs: number | null, t: Translate): string {
	if (atMs === null || !Number.isFinite(atMs)) return t('time.unknown');
	const phrase = relativeTime(atMs, Date.now());
	return t(timePhraseKey(phrase.unit), { n: phrase.n });
}

/** `movedAt`（ISO-8601）→ 毫秒；解析失败返回 `null`。 */
function movedAtMs(entry: RecycleEntry): number | null {
	const parsed = Date.parse(entry.movedAt);
	return Number.isNaN(parsed) ? null : parsed;
}

/** 稳定的 selector（模块级常量，避免每次渲染重新订阅会话状态）。 */
const selectSessionStatus = (
	snapshot: ReadonlyMap<string, DshSessionStatus>
): ReadonlyMap<string, DshSessionStatus> => snapshot;

/**
 * 设置页组件。
 * @param props - ownerProps（`close`）+ standardProps（`useWorkspaces` / `useSessions` /
 *   `useSessionStatus` / `t`）以及本插件通过 `inject` 回填的 `workspaces`。
 */
export function ArchivedSessionsSection(props: DshSettingsSectionProps): JSX.Element {
	const t = useMemo(() => createTranslate(props.t, undefined), [props.t]);
	const [tab, setTab] = useState<SectionTab>(() => resolveInitialTab(props.initialTab));
	const [retryToken, setRetryToken] = useState(0);
	const [query, setQuery] = useState('');
	const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
	const [selected, setSelected] = useState<readonly string[]>([]);
	// 本地即时隐藏（删除/恢复成功后的乐观反馈；下一次成功的清单刷新后由真源接管）。
	const [locallyGone, setLocallyGone] = useState<readonly string[]>([]);
	const [collapsed, setCollapsed] = useState<readonly string[]>([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [pending, setPending] = useState<PendingAction | null>(null);
	const [purgeOpen, setPurgeOpen] = useState(false);
	const [purgeAcknowledged, setPurgeAcknowledged] = useState(false);

	// 先订阅回收站清单与会话状态，再让 hook 调用**唯一**的纯派生函数 buildSectionModel（T14/T17）：
	// 组件、hook、测试走的是同一条派生路径。
	const bin = useRecycleBin(
		props.initialRecycleEntries === undefined ? undefined : { initialEntries: props.initialRecycleEntries }
	);
	// 官方 standardProps：会话运行状态快照（`Map<SessionId, SessionStatus>`）。
	// 与 useWorkspaces 同理，props 上的钩子在同一挂载期内是同一个函数，分支稳定。
	const statuses = props.useSessionStatus === undefined
		? undefined
		: props.useSessionStatus(selectSessionStatus);
	const model = useArchivedSessions(
		props,
		{
			recycleEntries: bin.entries,
			optimisticGone: locallyGone,
			sessionStatus: statuses,
			query,
			sortKey,
			selectedIds: selected
		},
		retryToken
	);

	// 清单成功拉取后，本地乐观隐藏交棒给 `/list` 条目（失败时保留，避免幽灵行回来）。
	useEffect(() => {
		if (bin.loadedToken > 0) setLocallyGone((prev) => (prev.length === 0 ? prev : []));
	}, [bin.loadedToken]);

	/** 行的可读名称（摘要缺失时用「摘要缺失」，不显示空标题）。 */
	const nameOf = (row: ArchivedRow): string => (row.title.length > 0 ? row.title : t('row.summaryMissing'));

	/** 组头标题：兜底组与未命名工作区走 i18n。 */
	const groupTitleOf = (group: ArchivedGroup): string => {
		if (group.id === UNASSIGNED_GROUP_ID) return t('group.unassigned');
		return group.title.length > 0 ? group.title : t('group.untitled');
	};

	const restore = async (ids: readonly string[]): Promise<void> => {
		if (ids.length === 0 || busy) return;
		const workspaces = props.workspaces;
		if (workspaces === undefined) {
			setNotice({ kind: 'error', text: t('notice.noWorkspaces') });
			return;
		}
		setBusy(true);
		const succeeded: string[] = [];
		const failed: string[] = [];
		// 官方接口逐条串行：一条失败不影响其余。
		for (const id of ids) {
			try {
				await workspaces.unarchiveSession(id);
				succeeded.push(id);
			} catch {
				failed.push(id);
			}
		}
		if (succeeded.length > 0) {
			const done = new Set(succeeded);
			setLocallyGone((prev) => [...new Set([...prev, ...succeeded])]);
			setSelected((prev) => prev.filter((id) => !done.has(id)));
		}
		setNotice(
			failed.length === 0
				? { kind: 'success', text: t('notice.restoredAll', { count: succeeded.length }) }
				: { kind: 'error', text: t('notice.restorePartial', { ok: succeeded.length, failed: failed.length }) }
		);
		await bin.refresh();
		setBusy(false);
	};

	const recycle = async (ids: readonly string[]): Promise<void> => {
		if (ids.length === 0 || busy) return;
		setBusy(true);
		let moved = 0;
		const failures: ApiFailure[] = [];
		for (const part of batchChunks(ids)) {
			const result = await postJson<unknown>(HOST_ROUTES.recycle, { sessionIds: part });
			if (!result.ok) {
				failures.push(result.failure);
				continue;
			}
			const outcome = parseRecycleResponse(result.data);
			moved += outcome.moved.length;
			if (outcome.moved.length > 0) {
				const done = new Set(outcome.moved);
				bin.markRecycled(outcome.moved);
				setSelected((prev) => prev.filter((id) => !done.has(id)));
			}
			failures.push(...outcome.failures);
		}
		const failedIds = new Set(failures.flatMap((failure) => [...failure.ids]));
		if (failedIds.size > 0) setSelected((prev) => prev.filter((id) => !failedIds.has(id)));
		const first = failures[0];
		if (failures.length === 0) {
			setNotice({ kind: 'success', text: t('notice.recycledAll', { count: moved }) });
		} else if (first === undefined) {
			setNotice({ kind: 'error', text: t('notice.recyclePartial', { ok: moved, failed: failures.length }) });
		} else {
			setNotice({
				kind: 'error',
				text: t('notice.recyclePartial', { ok: moved, failed: failures.length }),
				failure: first
			});
		}
		// 刷新回收站清单：幽灵行过滤依赖它（失败也不会让已归档视图报错）。
		await bin.refresh();
		setBusy(false);
	};

	/** 还原一条回收站条目（`POST /restore`）。已移交冷存档区的条目直接拦下（T12）。 */
	const restoreEntry = async (entry: RecycleEntry): Promise<void> => {
		if (busy) return;
		const guard = restoreGuard(entry);
		if (!guard.allowed) {
			setNotice({ kind: 'error', text: t(guard.reasonKey) });
			return;
		}
		setBusy(true);
		const result = await postJson<unknown>(HOST_ROUTES.restore, { entryIds: [entry.entryId] });
		if (!result.ok) {
			setNotice({ kind: 'error', text: t(`error.${result.failure.code}`), failure: result.failure });
		} else {
			const outcome = parseRestoreOutcome(result.data);
			const first = outcome.failures[0];
			if (outcome.failures.length === 0) {
				setNotice({ kind: 'success', text: t('notice.entryRestored', { count: outcome.restored.length || 1 }) });
			} else if (first === undefined) {
				setNotice({
					kind: 'error',
					text: t('notice.entryRestorePartial', { ok: outcome.restored.length, failed: outcome.failures.length })
				});
			} else {
				setNotice({
					kind: 'error',
					text: t('notice.entryRestorePartial', { ok: outcome.restored.length, failed: outcome.failures.length }),
					failure: first
				});
			}
			bin.forgetRecycled([entry.sessionId]);
		}
		await bin.refresh();
		setBusy(false);
	};

	/** 清空回收站（`POST /purge`，`confirm: true`）。 */
	const purge = async (): Promise<void> => {
		setPurgeOpen(false);
		setPurgeAcknowledged(false);
		if (busy) return;
		setBusy(true);
		const result = await postJson<unknown>(HOST_ROUTES.purge, { confirm: true });
		if (!result.ok) {
			setNotice({ kind: 'error', text: t(`error.${result.failure.code}`), failure: result.failure });
		} else {
			const outcome = parsePurgeOutcome(result.data);
			const first = outcome.failures[0];
			if (outcome.failures.length === 0) {
				setNotice({ kind: 'success', text: t('notice.purged', { count: outcome.purged }) });
			} else if (first === undefined) {
				setNotice({
					kind: 'error',
					text: t('notice.purgePartial', { ok: outcome.purged, failed: outcome.failures.length })
				});
			} else {
				setNotice({
					kind: 'error',
					text: t('notice.purgePartial', { ok: outcome.purged, failed: outcome.failures.length }),
					failure: first
				});
			}
		}
		await bin.refresh();
		setBusy(false);
	};

	/** 对话框确认：删除走 recycle，恢复走同一批量恢复路径。 */
	const confirmPending = async (): Promise<void> => {
		const action = pending;
		if (action === null) return;
		setPending(null);
		if (action.kind === 'recycle') await recycle(action.ids);
		else await restore(action.ids);
	};

	const renderRow = (row: ArchivedRow, showCwd: boolean): JSX.Element => {
		const title = nameOf(row);
		return (
			<li key={row.id} style={styles.row}>
				<input
					type="checkbox"
					checked={model.selected.includes(row.id)}
					disabled={busy}
					aria-label={t('list.row.select.aria', { title })}
					onChange={() => setSelected((prev) => toggleSelection(prev, row.id))}
				/>
				<div style={styles.rowMain}>
					<div style={styles.rowTitle}>{title}</div>
					<div style={styles.rowMeta}>
						{/* 组内不重复显示目录（组头已有 path）；兜底组例外，见 shouldShowRowCwd。 */}
						{showCwd ? (
							row.cwd.length > 0
								? <PathLabel path={row.cwd} style={styles.rowCwd} />
								: <span>{t('row.projectUnknown')}</span>
						) : null}
						{showCwd ? <span>·</span> : null}
						<span>{timeText(row.updatedAtMs, t)}</span>
						{row.missingSummary ? <Pill>{t('row.summaryMissing')}</Pill> : null}
						{row.running ? <Tag tone="info">{t('row.running')}</Tag> : null}
					</div>
				</div>
				<div style={styles.rowActions}>
					<Tooltip label={t('row.restore')}>
						<Button
							variant="ghost"
							size="sm"
							icon={<IconUnarchiveOutlineRegular />}
							disabled={busy}
							aria-label={t('row.restore.aria', { title })}
							onClick={() => void restore([row.id])}
						/>
					</Tooltip>
					{/* 运行中：**点之前**就禁用「移入回收站」并说明原因（T17）。 */}
					<Tooltip label={row.running ? t('row.delete.running') : t('row.delete')}>
						<span style={styles.tooltipAnchor}>
							<Button
								variant="ghost"
								size="sm"
								style={styles.dangerText}
								icon={<IconTrashOutlineRegular />}
								disabled={busy || !row.canRecycle}
								aria-label={row.running
									? t('row.delete.running.aria', { title })
									: t('row.delete.aria', { title })}
								onClick={() => setPending({ kind: 'recycle', ids: [row.id] })}
							/>
						</span>
					</Tooltip>
				</div>
			</li>
		);
	};

	const renderArchived = (): JSX.Element => {
		if (model.phase === 'unsupported') return <div style={styles.state}>{t('state.unsupported')}</div>;
		if (model.phase === 'loading') return <div style={styles.state}>{t('state.loading')}</div>;
		if (model.phase === 'error') {
			return (
				<div style={styles.state}>
					<div style={{ color: token.labelError }}>{t('state.error.title')}</div>
					<Button variant="outline" size="sm" style={{ marginTop: '8px' }} onClick={() => setRetryToken((n) => n + 1)}>
						{t('state.error.retry')}
					</Button>
				</div>
			);
		}
		if (model.alive.length === 0) {
			return (
				<div style={styles.state}>
					<div style={styles.stateTitle}>{t('state.empty.title')}</div>
					<div>{t('state.empty.hint')}</div>
				</div>
			);
		}
		if (model.listedIds.length === 0) {
			return (
				<div style={styles.state}>
					<div style={styles.stateTitle}>{t('state.empty.filtered')}</div>
					<div>{t('state.empty.filteredHint')}</div>
				</div>
			);
		}
		return (
			<div>
				{model.groups.map((group) => {
					const isCollapsed = collapsed.includes(group.id);
					const groupTitle = groupTitleOf(group);
					return (
						<section key={group.id} style={styles.group}>
							<div style={styles.groupHead}>
								<button
									type="button"
									style={styles.groupToggle}
									aria-expanded={!isCollapsed}
									aria-label={t(isCollapsed ? 'group.expand.aria' : 'group.collapse.aria', { title: groupTitle })}
									onClick={() => setCollapsed((prev) => toggleSelection(prev, group.id))}
								>
									<span
										aria-hidden="true"
										style={{ ...styles.chevron, transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}
									>
										<IconChevronDownOutlineRegular />
									</span>
									<span>{groupTitle}</span>
								</button>
								<Pill>{t('group.count', { count: group.rows.length })}</Pill>
								<Button
									variant="ghost"
									size="sm"
									icon={<IconUnarchiveOutlineRegular />}
									style={{ marginLeft: 'auto' }}
									disabled={busy}
									aria-label={t('group.restoreAll.aria', { title: groupTitle })}
									onClick={() => setPending({ kind: 'restore', ids: group.rows.map((row) => row.id) })}
								>
									{t('group.restoreAll')}
								</Button>
							</div>
							{group.path.length > 0 ? <PathLabel path={group.path} style={styles.groupPath} /> : null}
							{isCollapsed ? null : (
								<ul style={styles.list}>{group.rows.map((row) => renderRow(row, shouldShowRowCwd(group.id)))}</ul>
							)}
						</section>
					);
				})}
			</div>
		);
	};

	const renderRecycle = (): JSX.Element => {
		if (bin.phase === 'loading' && model.recycleRows.length === 0) {
			return <div style={styles.state}>{t('state.loading')}</div>;
		}
		if (bin.phase === 'error' && model.recycleRows.length === 0) {
			return (
				<div style={styles.state}>
					<div style={{ color: token.labelError }}>{t('recycle.error.title')}</div>
					<Button variant="outline" size="sm" style={{ marginTop: '8px' }} onClick={() => void bin.refresh()}>
						{t('state.error.retry')}
					</Button>
				</div>
			);
		}
		if (model.recycleRows.length === 0) {
			return <div style={styles.state}>{t('recycle.empty')}</div>;
		}
		return (
			<div>
				<ul style={styles.list}>
					{/* 逐条判定（purged / running / canRestore）全部来自模型，UI 只做映射。 */}
					{model.recycleRows.map((row) => {
						const entry = row.entry;
						const title = entry.title !== undefined && entry.title.length > 0
							? entry.title
							: t('recycle.entryUntitled');
						const reason = row.reasonKey.length > 0 ? t(row.reasonKey) : t('recycle.restore');
						return (
							<li key={entry.entryId} style={styles.row}>
								<div style={styles.rowMain}>
									<div style={styles.rowTitle}>{title}</div>
									<div style={styles.rowMeta}>
										{entry.cwd !== undefined && entry.cwd.length > 0 ? (
											<PathLabel path={entry.cwd} style={styles.rowCwd} />
										) : (
											<span>{entry.sessionId}</span>
										)}
										<span>·</span>
										<span>{timeText(movedAtMs(entry), t)}</span>
										<Pill>{fileSizeText(entry.bytes)}</Pill>
										{row.purged ? <Tag tone="neutral">{t('recycle.purgedTag')}</Tag> : null}
										{row.running ? <Tag tone="info">{t('row.running')}</Tag> : null}
									</div>
									{row.purged ? (
										<div style={styles.rowMeta}>
											{entry.purgedBatch !== undefined && entry.purgedBatch.length > 0
												? t('recycle.purgedHint', { batch: entry.purgedBatch })
												: t('recycle.purgedHintNoBatch')}
										</div>
									) : null}
								</div>
								<div style={styles.rowActions}>
									<Tooltip label={reason}>
										{/* 包一层 span：原生 disabled 按钮不派发鼠标事件，提示会挂不上。 */}
										<span style={styles.tooltipAnchor}>
											<Button
												variant="ghost"
												size="sm"
												icon={<IconUnarchiveOutlineRegular />}
												disabled={busy || !row.canRestore}
												aria-label={row.purged
													? t('recycle.restore.disabled.aria', { title })
													: row.running
														? t('recycle.restore.running.aria', { title })
														: t('recycle.restore.aria', { title })}
												onClick={() => void restoreEntry(entry)}
											/>
										</span>
									</Tooltip>
								</div>
							</li>
						);
					})}
				</ul>
				<div style={styles.batch}>
					<span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: token.labelTertiary }}>
						{t('recycle.description')}
					</span>
					<Button
						variant="ghost"
						size="sm"
						style={styles.dangerText}
						icon={<IconTrashOutlineRegular />}
						disabled={busy}
						onClick={() => {
							setPurgeAcknowledged(false);
							setPurgeOpen(true);
						}}
					>
						{t('recycle.purge')}
					</Button>
				</div>
			</div>
		);
	};

	const tabItems = useMemo(
		() => [
			{
				value: 'archived' as const,
				label: (
					<span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
						<IconArchiveOutlineRegular />
						{t('tab.archived', { count: model.alive.length })}
					</span>
				),
				id: 'archive-manager-tab-archived',
				panelId: 'archive-manager-panel-archived'
			},
			{
				value: 'recycle' as const,
				label: t('tab.recycle', { count: model.recycleRows.length }),
				id: 'archive-manager-tab-recycle',
				panelId: 'archive-manager-panel-recycle'
			}
		],
		[t, model.alive.length, model.recycleRows.length]
	);

	const dialogTitle = pending?.kind === 'restore' ? t('confirmRestore.title') : t('confirm.title');

	return (
		<div data-dsh-plugin={SETTINGS_SECTION_ID} style={styles.root}>
			<div>
				<h2 style={styles.title}>{t('section.title')}</h2>
				<p style={styles.description}>{t('section.description')}</p>
			</div>

			<SegmentedTabs
				items={tabItems}
				value={tab}
				onChange={(next) => setTab(next === 'recycle' ? 'recycle' : 'archived')}
				label={t('tab.label')}
			/>

			{notice === null ? null : (
				<div style={styles.notice} role="status">
					<div style={{ flex: 1, minWidth: 0, color: notice.kind === 'error' ? token.labelError : token.labelPrimary }}>
						<div>{notice.text}</div>
						{notice.failure === undefined ? null : <FailureBlock failure={notice.failure} t={t} />}
					</div>
					<Tooltip label={t('notice.dismiss')}>
						<Button variant="ghost" size="sm" aria-label={t('notice.dismiss')} onClick={() => setNotice(null)}>
							×
						</Button>
					</Tooltip>
				</div>
			)}

			{tab === 'archived' && bin.phase === 'error' && model.phase !== 'unsupported' ? (
				<p style={styles.degraded} role="status">{t('recycle.degraded')}</p>
			) : null}

			{tab === 'recycle' ? renderRecycle() : (
				<>
					<div style={styles.toolbar}>
						{/* Input 渲染「包裹 span + 原生 input」，外层留白由我们的容器负责。 */}
						<div style={styles.search}>
							<Input
								type="search"
								icon={<IconSearchOutlineRegular />}
								value={query}
								placeholder={t('toolbar.search.placeholder')}
								aria-label={t('toolbar.search.aria')}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</div>
						<label style={styles.sortLabel}>
							{t('toolbar.sort.label')}
							<select
								style={styles.select}
								value={sortKey}
								onChange={(event) => setSortKey(event.currentTarget.value === 'title' ? 'title' : 'updatedAt')}
							>
								<option value="updatedAt">{t('toolbar.sort.updatedAt')}</option>
								<option value="title">{t('toolbar.sort.title')}</option>
							</select>
						</label>
						<Tooltip label={t('toolbar.retry')}>
							<Button
								variant="ghost"
								size="sm"
								icon={<IconRefreshOutlineRegular />}
								disabled={busy}
								aria-label={t('toolbar.retry.aria')}
								onClick={() => setRetryToken((n) => n + 1)}
							/>
						</Tooltip>
					</div>

					<div style={styles.selectionRow}>
						{/* 官方 Checkbox 的 label 是可见文案，正好用作「全选」的说明。 */}
						<Checkbox
							checked={model.allSelected}
							disabled={busy || model.listedIds.length === 0}
							label={t('list.selectAll.aria')}
							onChange={() => setSelected(model.allSelected ? [] : model.listedIds)}
						/>
						<span style={{ fontSize: '12px', color: token.labelTertiary }}>
							{query.trim().length > 0
								? t('list.filtered', { shown: model.listedIds.length, total: model.alive.length })
								: t('list.count', { count: model.alive.length })}
						</span>
					</div>

					{renderArchived()}

					{model.selected.length === 0 ? null : (
						<div style={styles.batch}>
							<span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: token.labelPrimary }}>
								{t('batch.selected', { count: model.selected.length })}
							</span>
							<Button variant="outline" size="sm" disabled={busy} onClick={() => setSelected([])}>
								{t('batch.clear')}
							</Button>
							<Button
								variant="outline"
								size="sm"
								icon={<IconUnarchiveOutlineRegular />}
								disabled={busy}
								onClick={() => setPending({ kind: 'restore', ids: model.selected })}
							>
								{t('batch.restore')}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								style={styles.dangerText}
								icon={<IconTrashOutlineRegular />}
								disabled={busy}
								onClick={() => setPending({ kind: 'recycle', ids: model.selected })}
							>
								{t('batch.delete')}
							</Button>
						</div>
					)}
				</>
			)}

			<Modal
				open={pending !== null}
				onClose={() => setPending(null)}
				title={dialogTitle}
				closeLabel={t('confirm.cancel')}
				description={pending === null
					? undefined
					: t(pending.kind === 'restore' ? 'confirmRestore.body' : 'confirm.body', { count: pending.ids.length })}
				footer={
					<div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
						<Button variant="outline" size="md" onClick={() => setPending(null)}>
							{t('confirm.cancel')}
						</Button>
						<Button
							variant="primary"
							size="md"
							{...(pending?.kind === 'recycle' ? { style: styles.dangerText } : {})}
							onClick={() => void confirmPending()}
						>
							{pending?.kind === 'restore' ? t('batch.restore') : t('confirm.confirm')}
						</Button>
					</div>
				}
			/>

			<RiskConfirmation
				open={purgeOpen}
				title={t('recycle.purge.title')}
				description={t('recycle.purge.body', { count: model.recycleRows.length })}
				acknowledgeLabel={t('recycle.purge.ack')}
				cancelLabel={t('recycle.purge.cancel')}
				closeLabel={t('recycle.purge.close')}
				confirmLabel={t('recycle.purge.confirm')}
				acknowledged={purgeAcknowledged}
				disabled={busy}
				onAcknowledgedChange={setPurgeAcknowledged}
				onCancel={() => {
					setPurgeOpen(false);
					setPurgeAcknowledged(false);
				}}
				onConfirm={() => void purge()}
			/>
		</div>
	);
}
