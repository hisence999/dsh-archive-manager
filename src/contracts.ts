/**
 * 本插件拥有的数据契约：宿主与浏览器两半共享的纯声明与纯函数（无 IO、无副作用）。
 *
 * 冻结于 T1（2026-09-29）。改动需 Lead 同意，并同步 `test/contracts.test.mjs`。
 *
 * 关键外部依据：
 * - 设置页座位 `settings.section`：注册参数 `{ id, order?, label? }`，用**自己的新 id**
 *   是「旁边新增一格」，复用官方 id 才会顶替 → 见实时插槽清单与
 *   `dsh-client-ui-settings/README.zh.md:40-42`。
 * - 宿主路由：`ctx.connection.fetch.register({ path })` 的 `path` 是「`/api` 之下」的
 *   绝对路径，浏览器实际请求 `/api` + 该值；鉴权由官方通道完成 → 见
 *   `dsh-client-connection/lib/types/rpc.d.ts:110-120`。
 */

/** 插件包名，同时是 `window.__ModuleLoader__.load` 的 id。 */
export const PACKAGE_NAME = 'dsh-archive-manager';

/** 设置页条目标识：必须是本插件自己的 id（不覆写任何官方页面）。 */
export const SETTINGS_SECTION_ID = 'archive-manager';

/** 设置页导航位置：官方现有占用为 account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)。 */
export const SETTINGS_SECTION_ORDER = 25;

/** i18n 命名空间。 */
export const LOCALE_NAMESPACE = 'dsh-archive-manager';

/**
 * 端点路径。
 *
 * **必须是含 `/api/` 前缀的完整路径名** —— 官方注释写的 "Absolute path below `/api`" 有歧义，
 * 实际以校验器为准：`assertFetchRoute` → `endpointFromPath('/api', path)` 要求
 * `path.startsWith('/api/')`，否则抛
 * `connection: invalid exact Fetch route "<path>"`。
 * 且每个路径段须匹配 `/^[A-Za-z0-9_$.-]+$/`。
 * 依据：运行中 asar 的 `dsh-client-connection/lib/index.js`（`assertFetchRoute`、
 * `endpointFromPath`、`ENDPOINT_SEGMENT_PATTERN`）；分发用 `fetchRoutes.get(url.pathname)`
 * 做**完整 pathname 精确匹配**，所以注册路径与浏览器请求路径必须是同一个字符串。
 *
 * 官方同款：`dsh-client-ui-deliverables` 的 `/api/present.host`、`/api/changes.summary`。
 *
 * 客户端直接 `fetch(HOST_ROUTES.list)`，无需再拼任何前缀。
 */
export const HOST_ROUTES = {
	list: '/api/dsh-archive-manager/list',
	recycle: '/api/dsh-archive-manager/recycle',
	restore: '/api/dsh-archive-manager/restore',
	purge: '/api/dsh-archive-manager/purge'
} as const;

/**
 * @deprecated 过渡别名，恒为空串。
 *
 * `HOST_ROUTES` 现已自带 `/api/` 前缀，`${CLIENT_API_PREFIX}${HOST_ROUTES.list}` 仍然得到
 * 正确 URL，仅为不打断既有代码而保留。**新代码请直接 `fetch(HOST_ROUTES.list)`。**
 */
export const CLIENT_API_PREFIX = '';

/** 单次请求最多处理的会话数；上限存在的意义是限制宿主瞬时负载。 */
export const MAX_BATCH = 200;

/** 回收站根目录名（位于 `$DSH_HOME` 下，与 `sessions/` 物理隔离，绝不被会话扫描命中）。 */
export const RECYCLE_DIR_NAME = 'archive-manager';

/** 回收站子目录名。 */
export const RECYCLE_SUBDIR_NAME = 'recycle';

/** 每条回收记录的清单文件名。 */
export const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * 会话 id 的可接受形态。
 *
 * **真实数据**（本机 `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds`）同时存在两种：
 * - 裸小写 UUID：`8402fa9c-abbf-46bc-8c42-370e9401976f`
 * - `session-` 前缀 UUID：`session-0b9de1ba-1918-40b3-8fcc-8ab15a645e50`
 *   （实测当时**全部 5 条归档 id 都是这种**）
 *
 * 教训：早先只接受裸 UUID，真机删除被本插件自己的校验器拒绝
 * （HTTP 400 `invalid-input` /「会话 ID 无效」）；**全套单测没抓到**，因为夹具全部沿用了
 * 同一个错误假设自造的 UUID（见 PLAN §10.10）。
 *
 * 安全语义：该 id 会被拼进 `<sessionsRoot>\<cwd-slug>\<sessionId>`，真正必须保证的是
 * **不含路径分隔符、无 `..` 穿越、长度有界**，而不是"必须是 UUID"。
 * 因此按"安全字符集 + 有界长度"校验，同时接受两种真实形态。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 回收条目 id：`<movedAt 毫秒>@<sessionId>`。
 * 只由宿主生成；客户端回传时**只用于在回收站内查找**，绝不直接拼进文件路径。
 */
const ENTRY_ID_PATTERN = /^(\d{1,17})@([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/**
 * 一条失败明细（批量结果里的逐条失败）。
 * `id` 是会话 id 或回收条目 id，取决于出错的操作。
 *
 * `code` 由 T3 交付后追加冻结：批量结果同样需要可本地化的原因，
 * 否则「哪条是符号链接、哪条是跨卷、哪条是子会话」只剩人类文案。
 * 取值集合见 {@link HostErrorCode}。
 */
export interface Failure {
	id: string;
	/** 稳定错误码，客户端据此本地化。 */
	code: HostErrorCode;
	/** 人类可读技术详情（兜底展示）。 */
	message: string;
}

/**
 * 回收站中的一条记录（`manifest.json` 的完整内容）。
 *
 * **为什么清空后条目仍然保留**：DSH 的 `archivedSessionIds` 是官方状态，本插件**有意不修改**它
 * （改动它会让会话回到官方侧栏主列表，而工件已不在 → 可能留下更显眼的坏行）。
 * 于是客户端只能靠"回收站台账"把已处理的 id 从已归档列表里过滤掉。
 * 如果清空回收站时把台账也一起搬走，刷新页面后那些 id 就会以「摘要缺失」的幽灵行回来
 * （实测确认：无摘要 ≠ 幽灵行，真实会话也可能没有摘要，所以不能拿"无摘要"当判据）。
 * 因此：**清空 = 只把"载荷"（`session/`）移交到冷存档区，条目记录 `manifest.json` 留在原地**，
 * 并打上 {@link RecycleEntry.purgedAt} 标记，供客户端持续过滤与展示"已在冷存档区"。
 */
export interface RecycleEntry {
	/** 条目标识，见 {@link entryIdFor}。 */
	entryId: string;
	sessionId: string;
	title?: string;
	cwd?: string;
	/** 移入回收站的时间，ISO-8601。 */
	movedAt: string;
	/** 原会话目录绝对路径；还原时校验它仍在 `$DSH_HOME/sessions` 之下。 */
	originalPath: string;
	/** 已移走的字节数（诊断与展示用）。 */
	bytes: number;
	/**
	 * 载荷已移交到冷存档区的时间（ISO-8601）。存在即表示：
	 * `session/` 已不在回收站里（在 `purged/<purgedBatch>/` 下），条目**不可还原**，
	 * 但记录保留，客户端仍应据此过滤 `archivedSessionIds`。
	 */
	purgedAt?: string;
	/** 冷存档批次目录名（`purged/<批次>/`），便于人工找回。 */
	purgedBatch?: string;
}

/** `POST /recycle` 请求体。 */
export interface RecycleRequest {
	sessionIds: string[];
}

/** `POST /recycle` 响应体。 */
export interface RecycleResponse {
	moved: string[];
	failed: Failure[];
}

/** `POST /restore` 请求体。 */
export interface RestoreRequest {
	entryIds: string[];
}

/** `POST /restore` 响应体。 */
export interface RestoreResponse {
	restored: string[];
	failed: Failure[];
}

/** `POST /purge` 请求体；`confirm` 必须为字面量 `true`。 */
export interface PurgeRequest {
	confirm: true;
}

/**
 * `POST /purge` 响应体。
 *
 * `failed` 由 T6 的 F3 裁决追加：清空回收站时，被判定为**不安全而原地保留**的条目
 * （例如符号链接）必须能被客户端读到，否则用户会以为"已清空"。
 * 追加为可选字段，对既有调用方无破坏。
 */
export interface PurgeResponse {
	purged: number;
	failed?: Failure[];
}

/** `GET /list` 响应体。 */
export interface ListResponse {
	entries: RecycleEntry[];
}

/**
 * 宿主错误响应体的稳定错误码。
 *
 * 为什么要稳定码：客户端必须能把失败提示本地化（中/英），不能只依赖宿主返回的
 * 人类文案。客户端按 `code` 查词典，`message` 只作为兜底技术详情展示。
 *
 * 由 T3 交付后追加冻结（2026-09-29）。
 */
export type HostErrorCode =
	/** 请求体不合法：非数组、超 {@link MAX_BATCH}、非 UUID、非法 entryId、缺 `confirm`。 */
	| 'invalid-input'
	/** 会话正在运行，整批拒绝且磁盘零改动。 */
	| 'session-live'
	/**
	 * 会话不在归档集合内。
	 *
	 * 产品决策（lead，2026-09-29）：宿主**只允许**移走已归档会话，避免把仍出现在
	 * 官方侧栏主列表里的会话工件搬走后留下坏行（PLAN 风险 R1 / 验收 A5）。
	 * 客户端本就不该发这种请求；这一层是防御性的 fail-closed。
	 */
	| 'session-not-archived'
	/** 源会话目录不存在或不可读。 */
	| 'session-missing'
	/** 路径不安全：符号链接、越出 `$DSH_HOME/sessions`、非预期目录类型。 */
	| 'path-unsafe'
	/** 回收站条目不存在或清单缺失/损坏。 */
	| 'entry-not-found'
	/** 还原目标已存在（或父目录不存在），拒绝覆盖。 */
	| 'entry-conflict'
	/**
	 * 条目载荷已移交到冷存档区（`purgedAt` 存在），**不可还原**。
	 * 台账（`manifest.json`）按设计保留，以便客户端持续过滤 `archivedSessionIds`。
	 */
	| 'entry-purged'
	/** 跨卷移动（EXDEV）；按 A2 不做「复制+删源」兜底，直接拒绝。 */
	| 'cross-device'
	/** 该会话是子代理子会话；不做级联删除。 */
	| 'child-session'
	/** 未预期的内部失败。 */
	| 'internal';

/** 4xx/5xx 响应体。 */
export interface ErrorResponse {
	/** 稳定错误码，客户端据此本地化。 */
	code: HostErrorCode;
	/** 人类可读说明（技术详情，作为兜底展示）。 */
	message: string;
	/** 相关 id（会话 id 或回收条目 id）；与错误无关时省略。 */
	ids?: string[];
}

/** 所有外部输入先缩窄，避免 JSON.parse 或网络结果把 `any` 传播进业务层。 */
export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('参数必须为对象');
	return value as Record<string, unknown>;
}

/** 取错误消息的稳定字符串形式。 */
export function errorMessage(error: unknown): string {
	return String(error && typeof error === 'object' && 'message' in error ? (error as Error).message : error);
}

/** 会话 id 形态校验。 */
export function isSessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** 由会话 id 与移入时间生成条目标识。 */
export function entryIdFor(sessionId: string, movedAtMs: number): string {
	if (!isSessionId(sessionId)) throw new TypeError('会话 ID 无效');
	if (!Number.isSafeInteger(movedAtMs) || movedAtMs < 0) throw new TypeError('时间戳无效');
	return `${movedAtMs}@${sessionId}`;
}

/** 解析条目标识；失败抛 `TypeError`。 */
export function parseEntryId(entryId: string): { sessionId: string; movedAtMs: number } {
	const matched = ENTRY_ID_PATTERN.exec(entryId);
	if (matched === null) throw new TypeError('回收条目 ID 无效');
	const movedAtMs = Number(matched[1]);
	if (!Number.isSafeInteger(movedAtMs)) throw new TypeError('回收条目 ID 无效');
	return { sessionId: matched[2] as string, movedAtMs };
}

/**
 * 校验并归一化一批会话 id：非空数组、逐项形态合法、去重且保持顺序、不超过 {@link MAX_BATCH}。
 */
export function parseSessionIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new TypeError('会话列表不能为空');
	if (value.length > MAX_BATCH) throw new TypeError(`一次最多处理 ${MAX_BATCH} 个会话`);
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!isSessionId(item)) throw new TypeError('会话 ID 无效');
		if (seen.has(item)) continue;
		seen.add(item);
		unique.push(item);
	}
	return unique;
}

/** 校验并归一化一批回收条目 id。 */
export function parseEntryIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new TypeError('条目列表不能为空');
	if (value.length > MAX_BATCH) throw new TypeError(`一次最多处理 ${MAX_BATCH} 个条目`);
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') throw new TypeError('回收条目 ID 无效');
		parseEntryId(item);
		if (seen.has(item)) continue;
		seen.add(item);
		unique.push(item);
	}
	return unique;
}

/** 回收站根目录绝对路径（`<home>/archive-manager/recycle`）。 */
export function recycleRoot(homeDir: string): string {
	return [homeDir.replace(/[\\/]+$/, ''), RECYCLE_DIR_NAME, RECYCLE_SUBDIR_NAME].join('\\');
}

/** 会话目录根（`<home>/sessions`）；还原目标必须落在它之下。 */
export function sessionsRoot(homeDir: string): string {
	return [homeDir.replace(/[\\/]+$/, ''), 'sessions'].join('\\');
}
