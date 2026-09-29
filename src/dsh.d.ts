/**
 * 共享的 DSH 环境声明（宿主与浏览器两半都用）。
 *
 * 本文件**手写**而非安装 `@deepseek-ai/*` 类型包：本机 GUI 运行时是桌面端
 * 内置的 0.2.0-rc.1（`E:\DSH\resources\app.asar` → `/dsh/package.json`），
 * 与 npm 全局 CLI 的 0.1.7-rc.2 不是同一套；手写声明与运行时一一对应，
 * 且每条都有可追溯证据。
 *
 * 维护规则：新增声明必须附「来源」注释（包名 + 文件 + 行号）；
 * 两半各自的可变部分在 `dsh.host.d.ts` / `dsh.client.d.ts` 中。
 */

declare module '@deepseek-ai/cordis' {
	/** 插件上下文；只声明本插件实际用到的最小面。 */
	export interface Context {
		/**
		 * 注册一个随当前 fiber 回收的副作用。
		 * 来源：官方客户端/宿主插件普遍用法，如
		 * `dsh-client-ui-deliverables/lib/index.js:63`、`dsh-api-session-controller/lib/index.js:2396`。
		 */
		effect(callback: () => (() => void) | void, name?: string): () => void;
	}
}

/** 会话 id：DSH 使用小写 UUID 字符串。 */
type DshSessionId = string;

/** 工作区 id。 */
type DshWorkspaceId = string;

/** 词典翻译函数（`ctx.locale.bind(ns)` 的产物）。 */
type DshTranslate = (key: string, values?: Record<string, unknown>) => string;

/** 会话列表快照里的单条摘要；字段按 `contracts.ts` 的 `SessionSummary` 语义使用。 */
interface DshSessionSummary {
	readonly id: DshSessionId;
	readonly title?: string;
	readonly cwd?: string;
	readonly updatedAt?: string | number;
	readonly createdAt?: string | number;
	readonly running?: boolean;
}
