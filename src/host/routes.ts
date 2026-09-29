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
 * - `409` 整批拒绝：会话正在运行（`session-live`），或会话不在归档集合内（`session-not-archived`）
 *   ——`/recycle` 与 `/restore` 都在**整批预检**后拒绝，**磁盘零改动**；
 * - `500` 存储层意外异常；或会话活动/归档集合探测不可用（fail-closed，见 {@link sessionsUnavailable}）。
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
import { createRecycleStore, resolveHomeDir } from './recycle-store.js';

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
	const store = createRecycleStore({
		homeDir: resolveHomeDir(),
		/**
		 * 会话活动探针（第二道防线；第一道是端点里的整批预检与 fail-closed）。
		 * 官方宿主服务名与语义：
		 * `dsh-session/lib/index.js:1621`（`super(ctx, "sessions")`）、
		 * `:1856-1863`（`get(id)` 返回活动会话，无则 `undefined`）；
		 * 消费方用例 `dsh-session-reference/lib/index.js:566`、示例 `src/workspace.ts:666-672`。
		 */
		isSessionLive: (sessionId) => ctx.get('sessions')?.get(sessionId) !== undefined
	});

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
			// 守卫一（fail-closed）：会话活动探测必须可用（F2/P8）
			const sessions = ctx.get('sessions');
			if (sessions === undefined) return sessionsUnavailable();
			// 守卫二（fail-closed，产品红线）：只允许移走**已归档**会话（F1/P7）
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
			const running = sessionIds.filter((sessionId) => sessions.get(sessionId) !== undefined);
			if (running.length > 0) {
				return errorResponse('session-live', `会话正在运行，拒绝移入回收站：${running.join('、')}`, running);
			}
			try {
				return json(await store.recycle(sessionIds));
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
			// 与 /recycle 对称的整批预检（F4/P9）：探测不可用即 500，运行中整批 409
			const sessions = ctx.get('sessions');
			if (sessions === undefined) return sessionsUnavailable();
			const running: string[] = [];
			for (const entryId of entryIds) {
				let sessionId: string;
				try {
					sessionId = parseEntryId(entryId).sessionId;
				} catch {
					continue; // 非法 entryId 交给存储层逐条报 invalid-input
				}
				if (sessions.get(sessionId) !== undefined && !running.includes(sessionId)) running.push(sessionId);
			}
			if (running.length > 0) {
				return errorResponse('session-live', `会话正在运行，拒绝还原：${running.join('、')}`, running);
			}
			try {
				return json(await store.restore(entryIds));
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
