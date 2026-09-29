/**
 * 宿主半侧的 DSH 环境声明。**owner: host-recycle**（可扩展，勿删已有条目）。
 *
 * 来源：
 * - `dsh-client-connection/lib/types/rpc.d.ts:110-129`：
 *   `ConnectionFetchRoute { path; methods: ('GET'|'HEAD'|'POST')[]; requestBody: 'buffered'|'streaming'; fetch(request: Request): Promise<Response> }`，
 *   `HostConnectionFetch.register(route): () => Promise<void>`。
 * - 官方用例：`dsh-client-ui-deliverables/lib/index.js:48-98`（同一形态注册多条路由）。
 * - `dsh-client-connection/lib/types/rpc.d.ts:148-188`：`HostConnectionHandle`。
 * - 路由匹配：`path` 是 `/api` **之下**的绝对路径；浏览器请求 `/api` + 该值。
 */

declare module '@deepseek-ai/cordis' {
	export interface Context {
		/** 官方连接服务（宿主面）。 */
		readonly connection: DshHostConnectionHandle;
		/**
		 * 读取已注册的宿主服务；服务缺席时返回 `undefined`（不抛错）。
		 *
		 * 来源：官方与示例插件普遍用法 —— 示例 `src/workspace.ts:666`、`:1007`、`:1243`
		 * 用 `this.ctx.get("sessions")` 读取官方会话服务；
		 * 官方包 `dsh-session-reference/lib/index.js:566` 用 `this.ctx.get("sessions")?.get(id)`。
		 */
		get(name: 'sessions'): DshHostSessions | undefined;
		get(name: string): unknown;
	}
}

/**
 * 官方会话服务（`ctx.get('sessions')`）的最小面。
 *
 * 来源：`E:\DSH\resources\app.asar` → `/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`
 * - `:1621` `constructor(ctx) { super(ctx, "sessions"); … }` —— 服务名就是 `sessions`；
 * - `:1856-1863` `get(id)`：返回活动会话，无则 `undefined`（用来判断「会话正在运行」）；
 * - `:1864-1870` `list()`：按创建顺序返回全部活动会话。
 */
interface DshHostSessions {
	/** 活动会话；无则 `undefined`。 */
	get(sessionId: string): unknown;
	/** 全部活动会话（新数组）。 */
	list(): readonly unknown[];
}

/** 宿主侧精确 fetch 路由的 HTTP 方法集合。 */
type DshConnectionFetchMethod = 'GET' | 'HEAD' | 'POST';

/** 请求体呈现方式。 */
type DshConnectionRequestBodyMode = 'buffered' | 'streaming';

/** 一条由 Host 功能拥有的精确 fetch 路由。 */
interface DshConnectionFetchRoute {
	/** `/api` 之下的绝对路径。 */
	readonly path: string;
	readonly methods: readonly DshConnectionFetchMethod[];
	readonly requestBody: DshConnectionRequestBodyMode;
	/** 物理载体已施加信任与鉴权策略后调用。 */
	readonly fetch: (request: Request) => Promise<Response>;
}

/** 精确 fetch 路由注册表。 */
interface DshHostConnectionFetch {
	register(route: DshConnectionFetchRoute): () => Promise<void>;
}

/** `ctx.connection` 在宿主半侧的最小面。 */
interface DshHostConnectionHandle {
	readonly fetch: DshHostConnectionFetch;
}
