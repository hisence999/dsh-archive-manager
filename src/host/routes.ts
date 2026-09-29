/**
 * 宿主端点注册（T3 实现，替换 T1 占位）。
 *
 * 4 个端点全部注册在官方 `connection` 服务的共享 API 通道上，路径取自
 * {@link HOST_ROUTES}（客户端按同一常量调用，改路径需 Lead 同意）：
 * - `GET  /list`    回收站清单（**含已清空但保留台账的条目**，带 `purgedAt`/`purgedBatch`）；
 * - `POST /recycle` 会话目录移入回收站；
 * - `POST /restore` 回收站条目移回原路径（已清空条目 → `failed[].code = 'entry-purged'`）；
 * - `POST /purge`   清空回收站（需 `{ confirm: true }`）。
 *
 * **`POST /purge` 的语义 = 移交载荷 + 保留台账，不是物理删除**（T11）：
 * 载荷 `<entryId>/session/` 被 rename 到 `<home>/archive-manager/purged/<批次>/<entryId>/session/`，
 * 一个字节都不抹除，可人工找回；台账 `manifest.json` 留在回收站原地并打上 `purgedAt`/`purgedBatch`，
 * 所以清空后 `GET /list` **仍然报告这些条目**（页面显示「已在冷存档区」）——这是**有意设计**：
 * 客户端靠这份台账把已处理的 id 从已归档列表过滤掉，否则刷新后会出现「摘要缺失」的幽灵行。
 * 响应 `{ purged, failed[] }`：`purged` 是本次真正移交的条目数（幂等：已移交过的不再计数），
 * `failed[]` 是原地保留的条目（符号链接/非目录、台账缺失或损坏、移交失败）。
 *
 * 状态码约定：
 * - `400` 入参非法（含 JSON 解析失败、数字/形态不对、批量超限、缺 `confirm`）——**磁盘零改动**；
 * - `409` 整批拒绝：会话**确认正在运行**（`session-live`，即 `sessionController.list()` 报 `running === true`）、
 *   会话活动**无法判定**（fail-safe，沿用 `session-live`）、或会话不在归档集合内（`session-not-archived`）
 *   ——`/recycle` 与 `/restore` 都在**整批预检**后拒绝，**磁盘零改动**；
 * - `500` 存储层意外异常；或 `sessions` / `workspaceRegistry` 服务不可用（fail-closed）。
 *
 * **T16 会话活动判据**（2026-09-29 修正）：`ctx.get('sessions').get(id) !== undefined` 只说明官方
 * **持有/加载**了该会话（官方术语 live/attached），**不等于正在运行**；fork/rewind 自动归档的源会话
 * 会长期 attached，拿它当判据会把合法操作永久挡死。现在只看 `sessionController.list()` 里
 * `running === true` 的会话，并且**必须有正面证据才放行**：attached 但确认未运行 → 放行；
 * 无法判定（服务缺失/抛错/2.5s 超时）→ 拒绝。
 * 逐条结果放在 200 响应的 `moved`/`failed`/`restored` 里，每条 `failed` 都带 {@link HostErrorCode}
 * 稳定码（`Failure` 已冻结为 `{ id, code, message }`）；4xx/5xx 的错误体是冻结的
 * {@link ErrorResponse} `{ code, message, ids? }`，`code` 取 {@link HostErrorCode} 字面量，供客户端本地化。
 *
 * 任何分支都不执行物理删除：删除语义完全由 {@link createRecycleStore} 的「移交」实现。
 */
import type { Context } from '@deepseek-ai/cordis';
import {
	HOST_ROUTES,
	errorMessage,
	parseEntryId,
	parseEntryIds,
	parseSessionIds,
	record,
	type ErrorResponse,
	type HostErrorCode,
	type ListResponse
} from '../contracts.js';
import { createRecycleStore, resolveHomeDir, type RecycleStore } from './recycle-store.js';

/** 所有响应的公共头：不外泄、不缓存。 */
const RESPONSE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

/** 统一 JSON 响应。 */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

/**
 * 错误码 → HTTP 状态：入参问题 400；整批拒绝类 409（运行中 / 未归档）；其余 500。
 *
 * `entry-not-found` / `entry-conflict` / `cross-device` / `path-unsafe` / `session-missing` /
 * `child-session` 主要作为 200 响应 `failed[].code` 出现（逐条结果）；它们若被误用作整体
 * 响应码，这里保留 500 兜底，避免静默降级成 200 语义。
 */
function statusOf(code: HostErrorCode): number {
	if (code === 'invalid-input') return 400;
	if (code === 'session-live' || code === 'session-not-archived') return 409;
	return 500;
}

/** 构造稳定错误体 `{ code, message, ids? }`；无相关 id 时省略该字段。 */
function errorResponse(code: HostErrorCode, message: string, ids?: readonly string[]): Response {
	const body: ErrorResponse = {
		code,
		message,
		...(ids === undefined || ids.length === 0 ? {} : { ids: [...ids] })
	};
	return json(body, statusOf(code));
}

/** 400：入参非法。 */
function badRequest(message: string): Response {
	return errorResponse('invalid-input', message);
}

/** 500：存储层意外异常。 */
function serverError(error: unknown): Response {
	return errorResponse('internal', errorMessage(error));
}

/**
 * 官方工作区注册表（**宿主侧**服务名 `workspaceRegistry`，不是客户端的 `workspaces`）的最小面。
 *
 * 证据（`E:\DSH\resources\app.asar` → `/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js`）：
 * - `:374` `super(ctx, "workspaceRegistry")` —— 服务名；
 * - `:504-505` `get archivedSessionIds() { return this.requireState().archivedSessionIds; }`
 *   —— 同步 getter，返回**归档会话 id 的完整集合**（registry 全局，见 PLAN 2.4）。
 * `requireState()` 在领域状态未就绪时会抛错，调用方必须按 fail-closed 处理（见 {@link registryUnavailable}）。
 */
interface DshWorkspaceRegistryLike {
	readonly archivedSessionIds: readonly string[];
}

/**
 * 会话活动探测不可用时的统一拒绝：**fail-closed**。
 *
 * PLAN R2 要求「运行中的会话一律拒绝」；若官方 `sessions` 服务未加载/未激活，探测结果
 * 不可信，此时放行等于把正在运行的会话搬走。宁可整批拒绝（500 + `internal`）也不 fail-open。
 */
function sessionsUnavailable(): Response {
	return errorResponse('internal', '会话活动探测不可用（官方 sessions 服务未加载）；为避免操作正在运行的会话，本次拒绝执行');
}

/** 归档集合探测不可用时的统一拒绝：**fail-closed**（缺服务/状态未就绪都拒绝，不得静默放行）。 */
function registryUnavailable(detail?: string): Response {
	const suffix = detail === undefined || detail.length === 0 ? '' : `：${detail}`;
	return errorResponse(
		'internal',
		`归档集合探测不可用（官方 workspaceRegistry 服务未加载或状态未就绪）${suffix}；为避免移走未归档会话，本次拒绝执行`
	);
}

/**
 * 读取归档会话集合；服务缺失或状态未就绪返回 `undefined`（调用方必须 fail-closed 拒绝）。
 */
function readArchivedSessionIds(ctx: Context): readonly string[] | undefined {
	try {
		const registry = ctx.get('workspaceRegistry') as DshWorkspaceRegistryLike | undefined;
		const archived = registry?.archivedSessionIds;
		return Array.isArray(archived) ? archived : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 官方会话控制器（宿主侧服务名 `sessionController`）的最小面。
 *
 * 证据（`E:\DSH\resources\app.asar` → `/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/`）：
 * - `lib/index.js:2847` `super(ctx, "sessionController", { namespace: "session" })` —— 服务名；
 * - `lib/index.js:1888-1906` `async list(signal)` —— **宿主侧只收一个 signal**，直接返回
 *   `SessionSummary[]`（不自带 `{ items }` 信封）；`lib/index.js:1907-1919` 说明 cold 会话
 *   `running: false`；
 * - `lib/index.js:1877` `running: this.ctx.agents.get(session.id)?.status === "running"`
 *   —— `running` 的精确语义：**该会话拥有 Agent 且 Agent 状态为 running**；
 * - 客户端 Remote 形态是 `{ items: SessionSummary[] }`（`lib/client.js:2613` 调
 *   `remote.session.list({})`，`lib/types/index.d.ts:75-80` 注释
 *   "Read all visible Session rows without resuming an Agent"）。
 *
 * 2026-09-29 教训：早先拿 `ctx.get('sessions').get(id) !== undefined` 当「正在运行」，
 * 那实际是官方术语里的 **live/attached**（`dsh-session-reference/lib/index.js:562`
 * 注释原文 "the listed session, live **or cold**"）。fork/rewind 后源会话被自动归档
 * 但仍 attached，于是既删不掉也恢复不了。T16 起改看 `running`。
 */
interface DshSessionControllerLike {
	list(signal?: AbortSignal): Promise<unknown>;
}

/** 一次会话列表读取的超时上限。 */
const RUNNING_PROBE_TIMEOUT_MS = 2500;

/** 读一次「正在运行的会话 id 集合」；**无法判定返回 `undefined`**（调用方必须 fail-safe）。 */
async function readRunningSessionIds(ctx: Context): Promise<ReadonlySet<string> | undefined> {
	const controller = ctx.get('sessionController') as DshSessionControllerLike | undefined;
	if (controller === undefined || typeof controller.list !== 'function') return undefined;
	try {
		const raw = await controller.list(AbortSignal.timeout(RUNNING_PROBE_TIMEOUT_MS));
		// 归一两种形态：宿主直接返回数组；客户端/未来版本可能包一层 `{ items }`。
		const items: readonly unknown[] | undefined = Array.isArray(raw)
			? raw
			: raw !== null && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
				? ((raw as { items: unknown[] }).items)
				: undefined;
		if (items === undefined) return undefined;
		const running = new Set<string>();
		for (const item of items) {
			if (item === null || typeof item !== 'object') continue;
			const summary = item as { sessionId?: unknown; running?: unknown };
			if (summary.running === true && typeof summary.sessionId === 'string') running.add(summary.sessionId);
		}
		return running;
	} catch {
		// 服务抛错、`sessionQuery` 未挂载、或 2.5s 超时 —— 都视为「无法判定」。
		return undefined;
	}
}

/** 整批会话活动判定的结果。 */
type SessionActivityCheck =
	| { readonly ok: false; readonly response: Response }
	| { readonly ok: true; readonly running: ReadonlySet<string>; readonly undecidable: readonly string[] };

/**
 * 判定这批会话里哪些必须因「活动」被拒绝（T16，**必须有正面证据才放行**）。
 *
 * - 未 attached（cold）→ 放行（与官方一致：cold 会话 `running: false`）；
 * - attached 且 `running === true` → 进 `running`（整批 409）；
 * - attached 但活动不可判定（`sessionController` 缺失/抛错/超时）→ 进 `undecidable`（整批 409，fail-safe）；
 * - attached 且确认未运行 → 放行（fork/rewind 自动归档源会话的场景）。
 */
async function checkSessionActivity(ctx: Context, sessionIds: readonly string[]): Promise<SessionActivityCheck> {
	const sessions = ctx.get('sessions');
	if (sessions === undefined) return { ok: false, response: sessionsUnavailable() };
	const attached = sessionIds.filter((sessionId) => sessions.get(sessionId) !== undefined);
	if (attached.length === 0) return { ok: true, running: new Set(), undecidable: [] };
	const runningIds = await readRunningSessionIds(ctx);
	if (runningIds === undefined) return { ok: true, running: new Set(), undecidable: attached };
	return { ok: true, running: new Set(attached.filter((sessionId) => runningIds.has(sessionId))), undecidable: [] };
}

/** 把活动判定结果翻成响应；无需拒绝时返回 `undefined`。 */
function sessionActivityResponse(activity: SessionActivityCheck, action: string): Response | undefined {
	if (!activity.ok) return activity.response;
	if (activity.running.size > 0) {
		const ids = [...activity.running];
		return errorResponse('session-live', `会话正在运行，拒绝${action}：${ids.join('、')}`, ids);
	}
	if (activity.undecidable.length > 0) {
		return errorResponse(
			'session-live',
			`无法确认会话是否仍在运行（官方 sessionController 未加载、读取失败或超时），拒绝${action}：${activity.undecidable.join('、')}`,
			activity.undecidable
		);
	}
	return undefined;
}

/** 读取并解析缓冲请求体；空体或坏 JSON 都抛 `TypeError`（交由调用方转 400）。 */
async function readJsonBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.trim().length === 0) throw new TypeError('请求体必须是非空 JSON');
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		// 引擎自带的解析文案随 Node 版本变化，这里加稳定前缀，客户端仍按 code 本地化。
		throw new TypeError(`请求体不是合法 JSON：${errorMessage(error)}`);
	}
}

/**
 * 注册 4 个端点。
 * @param ctx - 宿主插件上下文，需已注入官方 `connection` 服务。
 */
export function registerArchiveManagerRoutes(ctx: Context): void {
	const homeDir = resolveHomeDir();
	/** list/purge 不涉及会话活动判定，给一个空集合即可。 */
	const noRunning: ReadonlySet<string> = new Set();
	/**
	 * 按「本次请求确认正在运行的会话」建一个存储层实例。
	 *
	 * T16 起 store 的 `isSessionLive` 语义 = **确认正在运行**（不再用 attached 推导），
	 * 由端点把 `sessionController.list()` 的正面证据传进来；这样第二道防线与第一道判据一致。
	 */
	const storeFor = (running: ReadonlySet<string>): RecycleStore =>
		createRecycleStore({ homeDir, isSessionLive: (sessionId) => running.has(sessionId) });
	const store = storeFor(noRunning);

	const listRoute = ctx.connection.fetch.register({
		path: HOST_ROUTES.list,
		methods: ['GET'],
		requestBody: 'buffered',
		fetch: async (): Promise<Response> => {
			try {
				const body: ListResponse = { entries: await store.list() };
				return json(body);
			} catch (error) {
				return serverError(error);
			}
		}
	});

	const recycleRoute = ctx.connection.fetch.register({
		path: HOST_ROUTES.recycle,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request: Request): Promise<Response> => {
			let sessionIds: string[];
			try {
				sessionIds = parseSessionIds(record(await readJsonBody(request)).sessionIds);
			} catch (error) {
				return badRequest(errorMessage(error));
			}
			// 守卫一（fail-closed，产品红线）：只允许移走**已归档**会话（F1/P7）。
			// 有意先于活动判定：「没归档」比「在运行」更本质（Lead 2026-09-29 裁定），
			// 也顺带避开昂贵的 sessionController 读取。
			const archived = readArchivedSessionIds(ctx);
			if (archived === undefined) return registryUnavailable();
			const notArchived = sessionIds.filter((sessionId) => !archived.includes(sessionId));
			if (notArchived.length > 0) {
				return errorResponse(
					'session-not-archived',
					`以下会话不在归档集合内，拒绝移入回收站（避免官方侧栏留下坏行）：${notArchived.join('、')}`,
					notArchived
				);
			}
			// 守卫二（T16）：只有**确认正在运行**才拒绝；attached 但空闲放行，无法判定则 fail-safe 拒绝
			const activity = await checkSessionActivity(ctx, sessionIds);
			const activityResponse = sessionActivityResponse(activity, '移入回收站');
			if (activityResponse !== undefined) return activityResponse;
			try {
				return json(await storeFor(activity.ok ? activity.running : noRunning).recycle(sessionIds));
			} catch (error) {
				return serverError(error);
			}
		}
	});

	const restoreRoute = ctx.connection.fetch.register({
		path: HOST_ROUTES.restore,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request: Request): Promise<Response> => {
			let entryIds: string[];
			try {
				entryIds = parseEntryIds(record(await readJsonBody(request)).entryIds);
			} catch (error) {
				return badRequest(errorMessage(error));
			}
			// 与 /recycle 对称的整批预检（F4/P9 + T16）：探测不可用即 500，确认正在运行才 409
			const pendingSessionIds: string[] = [];
			for (const entryId of entryIds) {
				try {
					pendingSessionIds.push(parseEntryId(entryId).sessionId);
				} catch {
					// 非法 entryId 交给存储层逐条报 invalid-input
				}
			}
			const activity = await checkSessionActivity(ctx, pendingSessionIds);
			const activityResponse = sessionActivityResponse(activity, '还原');
			if (activityResponse !== undefined) return activityResponse;
			try {
				return json(await storeFor(activity.ok ? activity.running : noRunning).restore(entryIds));
			} catch (error) {
				return serverError(error);
			}
		}
	});

	const purgeRoute = ctx.connection.fetch.register({
		path: HOST_ROUTES.purge,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request: Request): Promise<Response> => {
			try {
				const body = record(await readJsonBody(request));
				// 二次确认：必须是字面量 true（契约 PurgeRequest）。
				if (body.confirm !== true) throw new TypeError('清空回收站需要二次确认（confirm: true）');
			} catch (error) {
				return badRequest(errorMessage(error));
			}
			try {
				return json(await store.purge());
			} catch (error) {
				return serverError(error);
			}
		}
	});

	const registered = [listRoute, recycleRoute, restoreRoute, purgeRoute];
	ctx.effect(() => () => {
		for (const dispose of registered) void dispose();
	}, 'dsh-archive-manager.registerRoutes()');
}
