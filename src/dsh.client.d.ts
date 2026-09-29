/**
 * 浏览器半侧的 DSH 环境声明。**owner: client-page**（可扩展，勿删已有条目）。
 *
 * 来源：
 * - `ctx.slots`（客户端服务键 `slots`，见实时 Client Service 清单）：
 *   `inject(key, callback: () => SlotInjectionEffect): () => void`；
 *   `register(options, component): () => void`。
 *   官方用例：`dsh-client-ui-settings-general/lib/client.js:1167-1177`：
 *   ```js
 *   ctx.slots.inject("settings.section", () => ctx.slots.register({
 *     name: "settings.section", id: "general", order: 0,
 *     label: () => t("general.nav"), locale: NS,
 *     children: { "settings.general.item": { kind: "list", scope: "root" } }
 *   }, GeneralSection));
 *   ```
 * - `settings.section` 注册参数与页面收到的 ownerProps（`{ close }`）、standardProps
 *   （`useWorkspaces` / `useSessions` / `useSessionStatus` / `usePanelInfo` / `useResource`）：
 *   实时插槽巡检 `Slots.listSubTree root=settings.section` 的 `catalog` / `ownerProps` / `standardProps`。
 * - `ctx.locale`（客户端服务键 `locale`）：`register(ns, locale, dict): () => void`、
 *   `bind(ns): Translate`、`getLocale()`、`subscribe(fn)`。
 */

declare module '@deepseek-ai/cordis' {
	export interface Context {
		/** 插槽账本服务。 */
		readonly slots: DshSlotsService;
		/** 词典与语言偏好服务。 */
		readonly locale: DshLocaleService;
		/**
		 * 工作区客户端服务，提供官方归档/恢复接口。
		 * 来源：`dsh-api-workspace-controller/lib/types/client/service.d.ts:87,126`
		 * （`archiveSession` / `unarchiveSession`），经 PLAN 第 2.2 节的只读侦察确认。
		 */
		readonly workspaces: DshWorkspacesService;
	}
}

/** 会话摘要快照（`useSessions` 的 selector 入参）。 */
interface DshSessionsSnapshot {
	/**
	 * 会话 id → 摘要。
	 * 来源：官方 `dsh-client-ui-settings-general/lib/client.js` 中
	 * `useSessions((state) => { const main = Object.values(state.byId)...; return state.phase === "ready" ... })`
	 * —— 即快照同时暴露 `byId` 与 `phase`。
	 */
	readonly byId: Readonly<Record<string, DshSessionSummary>>;
	/** `idle` / `loading` / `ready` / `error` 等宿主相位。 */
	readonly phase?: string;
	readonly error?: unknown;
}

/** standardProps 里的 store 钩子：传 selector 订阅，返回派生值。 */
type DshStoreHook<T> = <R>(selector: (snapshot: T) => R) => R;

/** 工作区客户端服务（只声明本插件用到的面）。 */
interface DshWorkspacesService {
	/**
	 * 取消归档（恢复）一条会话，回原工作区原位置。
	 * 来源：`dsh-api-workspace-controller/lib/types/client/service.d.ts:126`。
	 */
	unarchiveSession(sessionId: DshSessionId): Promise<unknown>;
}

/**
 * `settings.section` 页面组件收到的完整 props。
 * ownerProps（`close`）+ standardProps（`useWorkspaces` / `useSessions`）+ 因注册时给了
 * `locale` 而注入的 `t`，来源：实时插槽巡检 `Slots.listSubTree root=settings.section`
 * 的 ownerProps / standardProps（见 PLAN 第 2.3 节与任务卡）。
 */
interface DshSettingsSectionProps {
	/** 关闭设置面板（面板开关状态归外壳所有）。 */
	readonly close?: () => void;
	/** 词典翻译函数（注册 `locale` 后由插槽注入）。 */
	readonly t?: DshTranslate;
	/** 工作区快照钩子；`WorkspaceSnapshot.archivedSessionIds` 是归档集合唯一真源。 */
	readonly useWorkspaces?: DshStoreHook<DshWorkspaceSnapshot>;
	/** 会话摘要钩子。 */
	readonly useSessions?: DshStoreHook<DshSessionsSnapshot>;
	/** 由本插件注册时通过 `inject` 回填的官方工作区服务。 */
	readonly workspaces?: DshWorkspacesService;
	/**
	 * **测试缝（T15）**：仅供服务端渲染 / 单测指定**初始**页签；运行时不给则默认「已归档」。
	 *
	 * - 只当 `useState` 的初值，**不是受控 prop** —— 页签切换仍由组件自己管；
	 * - 真实路径零影响：插槽只会传 ownerProps + standardProps + 我方
	 *   `inject()`（只返回 `{ workspaces }`）；`initialTab` 在 settings/slots 家族
	 *   的 22 个产物文件里 **0 命中**，且非法值会被 {@link resolveInitialTab} 折回 `'archived'`。
	 */
	readonly initialTab?: 'archived' | 'recycle';
	/**
	 * **测试缝（T15）**：仅供服务端渲染 / 单测注入首屏回收站条目。
	 *
	 * 为什么需要：`renderToStaticMarkup` 不跑 `useEffect`，`useRecycleBin` 会停在
	 * `entries = []`，回收站页签就只能渲染出「读取中」。真实路径仍由 `GET /list` 驱动。
	 *
	 * 类型用 `import()` 表达式直接引用契约（不做顶层 import，避免把本文件变成模块而
	 * 让上面的全局声明失效）。
	 */
	readonly initialRecycleEntries?: readonly import('./contracts.js').RecycleEntry[];
}

/** 设置页座位上的注册选项。 */
interface DshSectionRegistration {
	readonly name: 'settings.section';
	/** 本插件自己的条目 id（新 id 是「旁边新增一格」，不会顶替官方页面）。 */
	readonly id: string;
	/** 导航位置，升序。 */
	readonly order?: number;
	/** 导航显示文本；thunk 会在每次投影时重读，从而跟随语言而无需重新注册。 */
	readonly label?: string | (() => string);
	/** 词典命名空间，注册后组件会收到 `t`。 */
	readonly locale?: string;
	/**
	 * 额外注入给组件的 props 工厂。
	 * 来源：官方 `dsh-client-ui-settings-general/lib/client.js` 的
	 * `ctx.slots.register({ name: "settings.general.item", ..., inject: () => ({ hooks, setEnabled }) }, Row)`。
	 */
	readonly inject?: () => Record<string, unknown>;
}

/** 设置页组件收到的宿主方属性。 */
interface DshSettingsSectionOwnerProps {
	/** 关闭设置面板（面板开关状态归外壳所有）。 */
	close: () => void;
}

/** 插槽服务。 */
interface DshSlotsService {
	/** 等目标插槽被声明后再执行注册；返回注销器。 */
	inject(key: string, callback: () => unknown): () => void;
	/** 注册一个插槽条目。 */
	register(options: DshSectionRegistration, component: unknown): () => void;
}

/** 词典服务。 */
interface DshLocaleService {
	register(namespace: string, locale: string, dictionary: Record<string, string>): () => void;
	bind(namespace: string): DshTranslate;
	getLocale(): { id?: string };
	subscribe(listener: () => void): () => void;
}

/**
 * 一个工作区视图（`WorkspaceSnapshot.items` 的元素）。
 *
 * 证据：
 * - 宿主侧序列化：`dsh-api-workspace-controller/lib/index.js` 里
 *   `sessionIds: [...workspace.sessionIds]` / `sessionIds: [...record.sessionIds]`
 *   （同一对象里还有 `workspaceId` / `title` / `path`）。
 * - 客户端侧读取：`dsh-api-workspace-controller/lib/client.js` 中
 *   `workspaceId === view.workspaceId`、`view.updatedAt`。
 * - 字段清单以 `dsh-api-workspace-controller/lib/types/types.d.ts:12-25` 为准（lead 只读侦察）。
 */
interface DshWorkspaceView {
	readonly workspaceId: string;
	/** canonical host dir */
	readonly path: string;
	/** 用户可见名 */
	readonly title: string;
	/** 该工作区记账的会话 id（手工顺序）。 */
	readonly sessionIds: readonly DshSessionId[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** 设置页数据源：工作区快照（归档集合的唯一真源）。 */
interface DshWorkspaceSnapshot {
	/** 工作区视图列表，宿主顺序。 */
	readonly items: readonly DshWorkspaceView[];
	/** registry 全局归档集合，宿主顺序。 */
	readonly archivedSessionIds: readonly DshSessionId[];
	readonly pinnedSessionIds: readonly DshSessionId[];
	/**
	 * 请求状态：拉取成功后回到 `'idle'`，**没有** `'ready'`。
	 * 证据：`dsh-api-workspace-controller/lib/client.js` 的
	 * `state = "loading"` / `this.state = "idle"` / `this.state = "error"`。
	 */
	readonly state: 'idle' | 'loading' | 'error';
	/**
	 * 就绪相位：`'pending'` 起步，基线安装后置 `'ready'`。
	 * **判断"是否就绪"必须用它**（`state === 'idle'` 只表示没有在途请求）。
	 * 证据：同上文件的 `phase = "pending"` / `this.phase = "ready"`，
	 * 以及 `buildSnapshot()` 返回
	 * `{ items, archivedSessionIds, pinnedSessionIds, state, phase, error }`。
	 */
	readonly phase?: 'pending' | 'ready';
	readonly error: unknown;
}

/**
 * 官方 UI 原子件（`@deepseek-ai/dsh-client-ui-primitives`）。
 *
 * **免费基座模块**：在 `PLATFORM_MODULES` 里，运行时可直接 `import`，**无需**
 * `dsh.client.inject`（该字段只是信息性依赖，不参与模块解析）。
 *
 * 证据（逐条从 asar 内 `dsh-client-ui-primitives/lib/index.js` 抽取，非猜测）：
 * - 导出清单：该产物末尾 `export { ... }` 共 280 项，含 `Button` / `Input` / `Checkbox` /
 *   `SegmentedTabs` / `RiskConfirmation` / `Pill` / `Tag` / `PathLabel` / `relativeTime` /
 *   `fileSizeText` 与整套 `Icon*Outline{Medium,Regular}`。
 * - `function SegmentedTabs({ items, value, onChange, label, className })`，
 *   每项渲染 `Pill`，读取 `item.value` / `item.label` / `item.id` / `item.panelId`。
 * - `const Button = forwardRef(({ variant = "ghost", size = "md", icon, className, children, ...rest }, ref))`；
 *   变体来自 `Button.module.css`：`primary | ghost | outline | toolbar` —— **没有 danger 变体**。
 * - `function RiskConfirmation({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel,
 *   confirmLabel, acknowledged, disabled = false, onAcknowledgedChange, onCancel, onConfirm })`
 *   —— 内部用 `Modal` + 一个必勾选的确认 `Checkbox`。
 * - `function relativeTime(at, now)` 返回 `{ unit: 'now'|'minutes'|'hours'|'days'|'months'|'years', n }`
 *   （**只给结构化 bucket，文案留在各插件自己的词典里**）。
 * - `function fileSizeText(bytes)` 返回 `'1.2KB'` 这类字符串。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
	import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

	/** `SegmentedTabs` 的一项。 */
	export interface DshSegmentedTabItem {
		readonly value: string;
		readonly label: ReactNode;
		readonly id?: string;
		readonly panelId?: string;
	}

	/** `SegmentedTabs` 的 props。 */
	export interface DshSegmentedTabsProps {
		readonly items: readonly DshSegmentedTabItem[];
		readonly value: string;
		readonly onChange: (value: string) => void;
		readonly label?: string;
		readonly className?: string;
	}

	/** 分段页签（`role="tablist"`，支持方向键）。 */
	export function SegmentedTabs(props: DshSegmentedTabsProps): JSX.Element;

	/** 官方按钮变体（`Button.module.css`）。 */
	export type DshButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';

	/** `Button` 的 props；其余原生属性透传。 */
	export interface DshButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
		readonly variant?: DshButtonVariant;
		readonly size?: 'md' | 'sm';
		readonly icon?: ReactNode;
	}

	/** 官方按钮（默认 `ghost`；破坏性操作请自行用 `--dsw-alias-state-error-primary` 上色）。 */
	export const Button: (props: DshButtonProps) => JSX.Element;

	/** `RiskConfirmation` 的 props：必须勾选 `acknowledged` 才能确认。 */
	export interface DshRiskConfirmationProps {
		readonly open: boolean;
		readonly title: string;
		readonly description?: ReactNode;
		readonly acknowledgeLabel: string;
		readonly cancelLabel: string;
		readonly closeLabel: string;
		readonly confirmLabel: string;
		readonly acknowledged: boolean;
		readonly disabled?: boolean;
		readonly onAcknowledgedChange: (next: boolean) => void;
		readonly onCancel: () => void;
		readonly onConfirm: () => void;
	}

	/** 危险操作二次确认（官方 Modal + 必勾确认）。 */
	export function RiskConfirmation(props: DshRiskConfirmationProps): JSX.Element;

	/** 官方相对时间 bucket。 */
	export interface DshTimePhrase {
		readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
		readonly n: number;
	}

	/** 结构化相对时间（文案由调用方词典决定）。 */
	export function relativeTime(at: number, now: number): DshTimePhrase;

	/** 人类可读的文件大小。 */
	export function fileSizeText(bytes: number): string;

	/** 单行输入（渲染为「包裹 span + 原生 input」，其余属性透传给 input）。 */
	export function Input(props: { readonly icon?: ReactNode; readonly className?: string } & InputHTMLAttributes<HTMLInputElement>): JSX.Element;

	/**
	 * 复选框。**`label` 是必填的可见文案**（官方实现为 `<label><input/><span>{label}</span></label>`），
	 * 因此只适合「全选」这类自带文案的控件；逐行选择用原生复选框 + `aria-label` 更紧凑。
	 */
	export function Checkbox(props: {
		readonly checked: boolean;
		readonly onChange: (checked: boolean) => void;
		readonly label: string;
		readonly disabled?: boolean;
		readonly title?: string;
		readonly className?: string;
	}): JSX.Element;

	/** 药丸徽标：不传 `onClick` 时渲染 `<span>`，传了则渲染 `<button>`。 */
	export function Pill(props: {
		readonly active?: boolean;
		readonly className?: string;
		readonly children?: ReactNode;
		readonly onClick?: () => void;
	}): JSX.Element;

	/**
	 * 只读标签；`tone` 决定配色（默认 `outline`）。
	 * 证据：`Tag.module.css` 里 `[data-tone='...']` 共 8 个取值：
	 * `outline | solid | neutral | quiet | success | info | warning | danger`。
	 */
	export type DshTagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger';

	export function Tag(props: {
		readonly tone?: DshTagTone;
		readonly className?: string;
		readonly children?: ReactNode;
	}): JSX.Element;

	/** 悬浮提示；会 clone 子元素并合并 ref，因此子元素必须能接收 ref。 */
	export function Tooltip(props: {
		readonly label: ReactNode;
		readonly side?: 'top' | 'bottom' | 'left' | 'right';
		readonly align?: 'start' | 'center' | 'end';
		readonly delayMs?: number;
		readonly disabled?: boolean;
		readonly children: ReactNode;
	}): JSX.Element;

	/**
	 * 官方模态框（`createPortal`）。
	 * **`open === false` 时直接 `return null`**，所以 SSR 初次渲染不会触发 portal——
	 * 这正是本页把确认弹窗初始状态设为关闭的原因。
	 */
	export function Modal(props: {
		readonly open: boolean;
		readonly onClose: () => void;
		readonly title: string;
		readonly closeLabel: string;
		readonly description?: ReactNode;
		readonly children?: ReactNode;
		readonly footer?: ReactNode;
		readonly className?: string;
		readonly contentClassName?: string;
	}): JSX.Element | null;

	/**
	 * 单行路径标签：完整路径放在 `title` 属性里，正文被拆成
	 * `<span class="directory">` + `<span class="name">`（窄容器时左侧渐隐）。
	 */
	export function PathLabel(props: { readonly path: string; readonly className?: string } & HTMLAttributes<HTMLSpanElement>): JSX.Element;

	/** 官方图标签名：`({ size = 16, className }) => svg`（`strokeWidth` 由 Medium/Regular 决定）。 */
	export type DshIcon = (props: { readonly size?: number; readonly className?: string }) => JSX.Element;

	export const IconChevronDownOutlineRegular: DshIcon;
	export const IconRefreshOutlineRegular: DshIcon;
	export const IconSearchOutlineRegular: DshIcon;
	export const IconUnarchiveOutlineRegular: DshIcon;
	export const IconTrashOutlineRegular: DshIcon;
	export const IconArchiveOutlineRegular: DshIcon;
}
