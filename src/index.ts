/**
 * 宿主半侧入口。
 *
 * 只注入官方 `connection` 服务：本插件的 4 个端点注册在它的共享 API 通道上，
 * 从而由官方通道套上 Host/Origin 校验与浏览器鉴权（见
 * `dsh-client-connection/lib/types/rpc.d.ts:110-120`）。
 *
 * 刻意不做的事（对照 @michengai/dsh-archive-manager-example）：
 * - 不替换官方 `workspace` / `session-projection-cache` 服务；
 * - 不使用 `ctx.webServer.register` 直接挂裸路由（`/api` 已被官方网关占用）；
 * - 不提供任何物理删除端点。
 */
import type { Context } from '@deepseek-ai/cordis';
import { registerArchiveManagerRoutes } from './host/routes.js';

/** 声明只依赖官方连接服务。 */
export const inject = ['connection'];

/** 插件显示名（Cordis 用于日志与插件清单展示）。 */
export const name = 'archive-manager';

/**
 * 注册已归档会话管理的宿主端点。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx: Context): void {
	registerArchiveManagerRoutes(ctx);
}
