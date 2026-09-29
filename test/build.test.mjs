/**
 * T1 构建契约测试：产物必须能被 DSH 客户端模块系统加载，且只 require 基座白名单内的模块。
 *
 * 依据：
 * - 信封格式 `window.__ModuleLoader__.load({ id, factory })`：
 *   官方产物头部，如 `dsh-client-ui-settings/lib/client.js:1-3`。
 * - `factory` 返回插件导出 `{ apply, inject }`：官方产物尾部，如
 *   `dsh-client-ui-settings/lib/client.js:1529-1531`。
 * - 免费基座（`PLATFORM_MODULES`）：react、react/jsx-runtime、react-dom、react-dom/client、
 *   @deepseek-ai/cordis、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、
 *   @deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit。
 *   （来源：`dsh-web-frontend/dist/assets/index-Q6zc2uHV.js` 中的种子表函数）
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

/** 运行时无需声明即可解析的静态基座模块（`PLATFORM_MODULES`，9 键）。 */
const PLATFORM_MODULES = new Set([
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/cordis',
	'@deepseek-ai/dsh-client-store',
	'@deepseek-ai/dsh-client-ui-slots',
	'@deepseek-ai/dsh-client-ui-primitives',
	'@deepseek-ai/dsh-client-ui-dockkit'
]);

test('宿主入口导出 apply / inject / name', async () => {
	const host = await import(new URL('lib/index.js', root).href);
	assert.equal(typeof host.apply, 'function');
	assert.deepEqual(host.inject, ['connection']);
	assert.equal(host.name, 'archive-manager');
});

test('逐文件产物齐全（宿主入口的相对依赖与复核脚本的导入面）', async () => {
	for (const file of ['lib/contracts.js', 'lib/host/routes.js', 'lib/host/recycle-store.js']) {
		const source = await readFile(new URL(file, root), 'utf8');
		assert.ok(source.length > 0, `${file} 不得为空`);
	}
});

test('客户端 bundle 信封合法，且只 require 白名单模块', async () => {
	const source = await readFile(new URL('lib/client.js', root), 'utf8');
	const requested = [];
	let registered;
	globalThis.window = {
		__ModuleLoader__: {
			load(entry) {
				registered = entry;
			}
		}
	};
	try {
		// 不执行工厂体之外的副作用；工厂内的 require 记录到这里。
		const script = new Function('require', `with (window) { ${source} }`);
		script((id) => {
			requested.push(id);
			return {};
		});
	} finally {
		delete globalThis.window;
	}

	assert.ok(registered, 'bundle 必须调用 window.__ModuleLoader__.load');
	assert.equal(registered.id, packageJson.name, 'id 必须是包名');
	assert.equal(typeof registered.factory, 'function');

	const exports = registered.factory((id) => {
		requested.push(id);
		return {};
	});
	assert.equal(typeof exports.apply, 'function', 'factory 必须导出 apply');
	assert.ok(Array.isArray(exports.inject), 'factory 必须导出 inject');

	// 模块解析的权威声明是 `dsh.client.external`（exact module request），
	// `dsh.client.inject` 按官方 manifest 只是**信息性**的包名依赖：
	//   "Informational package-name dependencies, not Cordis service injection."
	//   —— `dsh-package-manifest/lib/types/types.d.ts:79`
	//   external: "Exact module-table requests beyond the implicit client baseline,
	//   including subpaths such as `<pkg>/client`" —— 同文件 83-88 行。
	const declaredExternal = new Set(packageJson.dsh.client.external ?? []);
	for (const id of requested) {
		assert.ok(
			PLATFORM_MODULES.has(id) || declaredExternal.has(id),
			`运行时 require 了未声明的模块：${id}（非基座模块必须写进 dsh.client.external；若是类型导入请改用 import type）`
		);
	}
});

test('插件清单声明了 bundle patch 与 web 客户端', () => {
	assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
	assert.equal(packageJson.dsh.client.platform, 'web');
	assert.equal(packageJson.type, 'module');
	assert.equal(packageJson.main, 'lib/index.js');
	assert.equal(fileURLToPath(new URL('cordis.patch.yml', root)).endsWith('cordis.patch.yml'), true);
});

/**
 * 路由 path 必须满足官方 exact Fetch route 规则。
 *
 * 这条守卫来自一次真机事故：宿主注册 `/dsh-archive-manager/list` 时激活失败并报
 * `connection: invalid exact Fetch route "/dsh-archive-manager/list"`。
 * 官方校验器（运行中 asar 的 `dsh-client-connection/lib/index.js`）：
 *   assertFetchRoute: endpointFromPath('/api', route.path) 必须非 undefined
 *   endpointFromPath: path 必须 startsWith('/api/')，且每段匹配 /^[A-Za-z0-9_$.-]+$/
 * 分发侧 fetchRoutes.get(url.pathname) 做完整 pathname 精确匹配，所以注册路径与
 * 浏览器请求路径必须是同一个字符串。
 */
test('HOST_ROUTES 满足官方 exact Fetch route 规则', async () => {
	const { HOST_ROUTES } = await import(new URL('lib/contracts.js', root).href);
	const segmentPattern = /^[A-Za-z0-9_$.-]+$/;
	const paths = Object.values(HOST_ROUTES);
	assert.equal(new Set(paths).size, paths.length, '路由路径不得重复');
	for (const path of paths) {
		assert.ok(path.startsWith('/api/'), `路由 ${path} 必须以 /api/ 开头（assertFetchRoute 要求）`);
		for (const segment of path.slice('/api/'.length).split('/')) {
			assert.ok(segmentPattern.test(segment), `路由段 "${segment}" 不匹配官方片段模式`);
		}
	}
});
