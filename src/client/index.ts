/**
 * 浏览器半侧入口（web bundle）。
 *
 * 契约（对照官方已构建产物，例如 `dsh-client-ui-settings-general/lib/client.js`）：
 * 导出一个 Cordis 插件 `{ apply, inject }`；`apply(ctx)` 里通过
 * `ctx.slots.inject(...)` + `ctx.slots.register(...)` 注册设置页。
 *
 * 运行时 import 白名单（**只允许这 9 个基座模块**，见 `test/build.test.mjs`）：
 * react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、
 * @deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、
 * @deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit。
 * `dsh.client.inject` 只是**信息性**字段，不参与模块解析（`dsh-package-manifest` 的
 * `types.d.ts:76-89`：只有 `external` 才决定模块能否被解析），因此本文件
 * **不 import** `@deepseek-ai/dsh-client-locale` / `-ui-settings`：词典走 `ctx.locale`
 * 服务、座位走 `ctx.slots`、数据走页面 standardProps。
 * 类型专用导入必须写 `import type`，否则会被打进 bundle 并在运行时解析失败。
 */
import type { Context } from '@deepseek-ai/cordis';
import { LOCALE_NAMESPACE, SETTINGS_SECTION_ID, SETTINGS_SECTION_ORDER } from '../contracts.js';
import { ArchivedSessionsSection } from './ArchivedSessionsSection.js';
import { registerLocales } from './locales.js';

/**
 * 需要的客户端服务（Cordis 服务注入，与 `dsh.client.inject` 是两回事）：
 * - `slots`：插槽账本；`locale`：词典；`workspaces`：官方 `unarchiveSession`。
 */
export const inject = ['slots', 'locale', 'workspaces'];

/**
 * 注册「已归档会话」设置页与中英词典。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: Context): void {
	registerLocales(ctx);
	ctx.slots.inject('settings.section', () => ctx.slots.register({
		name: 'settings.section',
		id: SETTINGS_SECTION_ID,
		order: SETTINGS_SECTION_ORDER,
		// thunk：每次投影重读，切语言时自动跟随（不重新注册）。
		label: () => ctx.locale.bind(LOCALE_NAMESPACE)('section.nav'),
		locale: LOCALE_NAMESPACE,
		// 官方写法（dsh-client-ui-settings-general 的 inject 工厂）：把服务回填给组件，
		// 组件因此不必 import 任何非基座包。
		inject: () => ({ workspaces: ctx.workspaces })
	}, ArchivedSessionsSection));
}
