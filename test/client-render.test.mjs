/**
 * 客户端页面**渲染冒烟测试**（服务端渲染，不需要真机）。
 *
 * 为什么需要它：`test/client.test.mjs` 只测纯函数，验不到"把真实 props 喂进组件后
 * 能不能渲染出来"。这个测试按官方契约把 `settings.section` 的注册真跑一遍
 * （用假 ctx 捕获 `slots.register` 的实参），再用 `react-dom/server` 渲染捕获到的组件，
 * 覆盖四种路径：正常列表 / 空态 / 摘要缺失 / 插槽未提供数据源。
 *
 * 依据：
 * - bundle 信封与 factory 导出：官方产物 `dsh-client-ui-settings/lib/client.js:1-3,1529-1531`。
 * - 页面 props（`useWorkspaces` / `useSessions` / `workspaces` / `t`）：实时插槽巡检
 *   `Slots.listSubTree root=settings.section` 的 ownerProps + standardProps，以及
 *   官方 `dsh-client-ui-settings-general` 的 `inject` 工厂写法。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
const require = createRequire(import.meta.url);

/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的 SSR 最小桩。
 *
 * 为什么需要：本项目的客户端 bundle 把 `@deepseek-ai/*` 全部标为 external（运行时由 DSH 的模块表提供），
 * 而本机**没有安装**这些包，所以真实 `require` 会抛 `Cannot find module`。
 * 桩的作用是让"注册参数 + 我们的数据流/文案"这些断言仍可运行；**控件真实形态由真机截图与
 * `test/verify/theme-tokens.mjs` 等渠道保证**，不靠这里。
 *
 * 签名来源（**逐条核对官方 `.d.ts`**，不是猜的）：
 * - `relativeTime(at, now) → { unit: 'now'|'minutes'|'hours'|'days'|'months'|'years'; n: number }`
 *   —— `lib/types/relative-time.d.ts`；注意词表归**插件词典**所有，桩只回结构化 bucket。
 * - `fileSizeText(bytes) → string` —— `lib/types/file-size.d.ts`。
 * - `Button: { variant?: 'primary'|'ghost'|'outline'|'toolbar'; size?: 'md'|'sm'; icon?: ReactNode }`
 *   —— `lib/types/Button.d.ts`（**没有 danger 变体**）。
 * - `Input: { icon?: ReactNode } & InputHTMLAttributes` —— `lib/types/Input.d.ts`。
 * - `Checkbox: { checked; onChange(next); label: string; disabled?; title? }` —— `lib/types/Checkbox.d.ts`。
 * - `Pill: { active?; children? } & ButtonHTMLAttributes` —— `lib/types/Pill.d.ts`。
 * - `PathLabel: { path: string } & HTMLAttributes<span>` —— `lib/types/PathLabel.d.ts`。
 * - `SegmentedTabs: { items: [{ value, label, id, panelId }]; value; onChange; label }` —— `lib/types/SegmentedTabs.d.ts`。
 */
const React = require('react');

/** 官方 `Tag.tone` 白名单（`lib/types/Tag.d.ts` 的 `TagTone`）。 */
const TAG_TONES = new Set(['outline', 'solid', 'neutral', 'quiet', 'success', 'info', 'warning', 'danger']);

/**
 * 断言必需 props。
 *
 * 为什么桩要**主动抛错**而不是宽容兜底：verifier 审计发现，早期那个只取
 * `open/title/description/children` 的 `RiskConfirmation` 桩**会让"漏传必需 props"照样渲染**，
 * 而真实组件会变成"确认按钮永远点不了" —— 这就是假绿。桩必须比真实组件**更严格**，不能更宽松。
 */
function requireProps(component, props, names) {
	const missing = names.filter((name) => props[name] === undefined);
	if (missing.length > 0) {
		throw new Error(`${component} 未收到必需 props：${missing.join(', ')}（签名见官方 lib/types/*.d.ts）`);
	}
}

/** 官方图标是 `({ size = 16, className }) => svg`，无必需 props。 */
const icon = (name) => (props = {}) => React.createElement('span', { 'data-icon': name, ...props });

const PRIMITIVES_STUB = {
	relativeTime: (at, now) => {
		const diff = Math.max(0, now - at);
		if (diff < 6e4) return { unit: 'now', n: 0 };
		if (diff < 36e5) return { unit: 'minutes', n: Math.floor(diff / 6e4) };
		if (diff < 864e5) return { unit: 'hours', n: Math.floor(diff / 36e5) };
		if (diff < 2592e6) return { unit: 'days', n: Math.floor(diff / 864e5) };
		if (diff < 31536e6) return { unit: 'months', n: Math.floor(diff / 2592e6) };
		return { unit: 'years', n: Math.floor(diff / 31536e6) };
	},
	fileSizeText: (bytes) => `${bytes}B`,
	Button: ({ children, icon: leading, ...rest }) => React.createElement('button', { type: 'button', ...rest }, leading ?? null, children),
	Input: ({ icon: leading, ...rest }) => React.createElement('span', null, leading ?? null, React.createElement('input', rest)),
	Checkbox: ({ checked, onChange, label, disabled, title, className }) => {
		requireProps('Checkbox', { onChange, label }, ['onChange', 'label']);
		return React.createElement(
			'label', { className, title },
			React.createElement('input', { type: 'checkbox', checked, disabled, onChange: () => onChange(!checked) }),
			label
		);
	},
	Pill: ({ children, active, ...rest }) => React.createElement('span', rest, children),
	Tag: ({ tone = 'outline', className, children }) => {
		if (!TAG_TONES.has(tone)) {
			throw new Error(`Tag 收到未知 tone "${tone}"；官方 TagTone 仅：${[...TAG_TONES].join('|')}`);
		}
		return React.createElement('span', { className, 'data-tone': tone }, children);
	},
	PathLabel: ({ path, ...rest }) => {
		requireProps('PathLabel', { path }, ['path']);
		return React.createElement('span', rest, path);
	},
	SegmentedTabs: ({ items, value, onChange, label }) => {
		requireProps('SegmentedTabs', { items, value, onChange, label }, ['items', 'value', 'onChange', 'label']);
		if (!Array.isArray(items) || items.length === 0) throw new Error('SegmentedTabs.items 必须是非空数组');
		for (const item of items) {
			requireProps('SegmentedTabs.items[]', item, ['value', 'label', 'id', 'panelId']);
		}
		return React.createElement(
			'div', { role: 'tablist', 'aria-label': label },
			items.map((item) => React.createElement(
				'button', { key: item.value, type: 'button', role: 'tab', 'aria-selected': item.value === value, onClick: () => onChange(item.value) },
				item.label
			))
		);
	},
	/**
	 * 官方要求 12 个 props，且**主操作在 `acknowledged` 之前不可用**（`lib/types/RiskConfirmation.d.ts`）。
	 * 桩实现同一门控，并校验齐全 —— 否则"漏接 acknowledged/onConfirm"会被静默放过。
	 */
	RiskConfirmation: ({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, disabled, onAcknowledgedChange, onCancel, onConfirm }) => {
		requireProps('RiskConfirmation', {
			open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, onAcknowledgedChange, onCancel, onConfirm
		}, ['open', 'title', 'description', 'acknowledgeLabel', 'cancelLabel', 'closeLabel', 'confirmLabel', 'acknowledged', 'onAcknowledgedChange', 'onCancel', 'onConfirm']);
		if (!open) return null;
		return React.createElement(
			'div', { role: 'dialog', 'aria-label': title },
			React.createElement('p', null, description),
			React.createElement(
				'label', null,
				React.createElement('input', { type: 'checkbox', checked: acknowledged, onChange: () => onAcknowledgedChange(!acknowledged) }),
				acknowledgeLabel
			),
			React.createElement('button', { type: 'button', onClick: onCancel }, cancelLabel),
			React.createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onCancel }, closeLabel),
			React.createElement('button', { type: 'button', disabled: disabled === true || !acknowledged, onClick: onConfirm }, confirmLabel)
		);
	},
	/** 官方 `Tooltip` 要求 `label` 与单个 anchor 子元素，并 clone 子元素。 */
	Tooltip: ({ label, children }) => {
		requireProps('Tooltip', { label, children }, ['label', 'children']);
		return children;
	},
	/** 官方 `Modal`：`open`/`onClose`/`title` 必需，非 headless 时 `closeLabel` 必需；关闭时返回 null。 */
	Modal: ({ open, onClose, title, closeLabel, description, children, footer, headless }) => {
		requireProps('Modal', { open, onClose, title }, ['open', 'onClose', 'title']);
		if (headless !== true) requireProps('Modal', { closeLabel }, ['closeLabel']);
		if (!open) return null;
		return React.createElement(
			'div', { role: 'dialog', 'aria-label': title },
			title, description ?? null, children ?? null, footer ?? null
		);
	},
	IconChevronDownOutlineRegular: icon('chevron-down'),
	IconRefreshOutlineRegular: icon('refresh'),
	IconSearchOutlineRegular: icon('search'),
	IconUnarchiveOutlineRegular: icon('unarchive'),
	IconTrashOutlineRegular: icon('trash'),
	IconArchiveOutlineRegular: icon('archive')
};

/**
 * 桩的对外代理：**未知导出立刻报错**并点名，而不是返回 `undefined`
 * （否则会以 `X is not a function` 的形式在 JSX 深处炸掉，看不出是桩缺导出）。
 * 放行 esbuild 的 CJS interop 会探测的几个键。
 */
const INTEROP_KEYS = new Set(['__esModule', 'default', 'then', Symbol.toStringTag]);
const PRIMITIVES = new Proxy(PRIMITIVES_STUB, {
	get(target, key) {
		if (key in target) return target[key];
		if (INTEROP_KEYS.has(key)) return undefined;
		throw new Error(`PRIMITIVES_STUB 缺少导出 "${String(key)}"：请先核对官方 lib/types/index.d.ts，再把该导出按真实签名补进桩（不要退回宽松兜底）`);
	}
});

/** 供 bundle 工厂使用的 require：官方 primitives 走桩，其余走真实解析。 */
function clientRequire(id) {
	return id === '@deepseek-ai/dsh-client-ui-primitives' ? PRIMITIVES : require(id);
}

/** 会话 id（UUID 形态，与契约一致）。 */
const ARCHIVED_WITH_SUMMARY = '11111111-1111-4111-8111-111111111111';
const ARCHIVED_WITHOUT_SUMMARY = '22222222-2222-4222-8222-222222222222';

/**
 * 加载客户端 bundle 并取回 factory 的导出（`{ apply, inject }`）。
 * @returns 客户端插件导出。
 */
async function loadClientExports() {
	const source = await readFile(new URL('lib/client.js', root), 'utf8');
	let entry;
	globalThis.window = { __ModuleLoader__: { load: (registered) => { entry = registered; } } };
	try {
		new Function('window', source)(globalThis.window);
	} finally {
		delete globalThis.window;
	}
	assert.ok(entry, 'bundle 必须调用 window.__ModuleLoader__.load');
	return entry.factory(clientRequire);
}

/**
 * 用假 ctx 跑一次 `apply`，捕获 `settings.section` 的注册实参与词典注册。
 * @returns 捕获到的注册信息。
 */
async function applyWithFakeContext() {
	const client = await loadClientExports();
	const sections = [];
	const dictionaries = [];
	const ctx = {
		slots: {
			inject: (_key, callback) => { callback(); return () => {}; },
			register: (options, component) => { sections.push({ options, component }); return () => {}; }
		},
		locale: {
			register: (namespace, locale, dictionary) => { dictionaries.push({ namespace, locale, dictionary }); return () => {}; },
			bind: () => (key) => key,
			getLocale: () => ({ id: 'zh' }),
			subscribe: () => () => {}
		},
		workspaces: { unarchiveSession: async () => {} },
		// Cordis 的 effect 是「立即执行回调并登记注销器」，假 ctx 必须照做，
		// 否则依赖 effect 注册的词典永远不会被登记。
		effect: (callback) => { callback(); return () => {}; }
	};
	client.apply(ctx);
	assert.equal(sections.length, 1, '必须注册且只注册一个设置页');
	return { client, section: sections[0], dictionaries };
}

/**
 * 渲染页面组件所需的 props。
 *
 * 工作区快照按**官方真实语义**建模：`WorkspaceSnapshot` 是
 * `{ items, archivedSessionIds, pinnedSessionIds, state: 'idle' | 'loading' | 'error',
 *    phase: 'pending' | 'ready' }`（`dsh-api-workspace-controller/lib/types/client/model.d.ts:9-18`）。
 * 注意：`state` **没有** `'ready'` —— 拉取成功后回到 `'idle'`，就绪与否看 `phase`。
 * 因此「已就绪但归档集合为空」的真实快照 = `state: 'idle'` + `phase: 'ready'`。
 */
function sectionProps({
	archivedSessionIds,
	byId,
	t,
	withWorkspacesHook = true,
	workspaceState = 'idle',
	workspacePhase = 'ready',
	items = []
}) {
	return {
		...(withWorkspacesHook ? {
			useWorkspaces: (selector) => selector({
				items,
				archivedSessionIds,
				pinnedSessionIds: [],
				state: workspaceState,
				phase: workspacePhase,
				error: null
			})
		} : {}),
		useSessions: (selector) => selector({ byId, phase: 'ready' }),
		workspaces: { unarchiveSession: async () => {} },
		...(t === undefined ? {} : { t })
	};
}

/** 造一个官方 `WorkspaceView`（字段依据 `dsh-api-workspace-controller/lib/types/types.d.ts:12-25`）。 */
function workspaceView(workspaceId, title, path, sessionIds) {
	return { workspaceId, title, path, sessionIds, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
}

/** 用 `react-dom/server` 把组件渲染成静态 HTML。 */
async function render(section, props) {
	const React = require('react');
	const { renderToStaticMarkup } = await import('react-dom/server');
	return renderToStaticMarkup(React.createElement(section.component, props));
}

test('注册参数与官方契约一致，且中英词典都注册了', async () => {
	const { section, dictionaries } = await applyWithFakeContext();
	assert.equal(section.options.name, 'settings.section');
	assert.equal(section.options.id, 'archive-manager');
	assert.equal(section.options.order, 25);
	assert.equal(section.options.locale, 'dsh-archive-manager');
	assert.equal(typeof section.options.label, 'function', 'label 必须是 thunk 才能跟随语言');
	assert.equal(typeof section.component, 'function', '组件必须是可渲染的函数');

	const locales = dictionaries.map((item) => item.locale).sort();
	assert.deepEqual(locales, ['en', 'zh'], '中英词典都要注册');
	for (const item of dictionaries) {
		assert.ok(Object.keys(item.dictionary).length > 0, `${item.locale} 词典不得为空`);
	}
});

test('无可注入的 t 时使用自带词典渲染中文文案', async () => {
	const { section } = await applyWithFakeContext();
	const html = await render(section, sectionProps({ archivedSessionIds: [], byId: {} }));
	assert.ok(html.includes('已归档会话'), `应渲染出中文标题，实际：${html.slice(0, 200)}`);
});

test('已就绪但归档集合为空时渲染空态（真实快照 = state idle + phase ready）', async () => {
	const { section } = await applyWithFakeContext();
	const html = await render(section, sectionProps({
		archivedSessionIds: [],
		byId: {},
		t: (key) => `#${key}`,
		workspaceState: 'idle',
		workspacePhase: 'ready'
	}));
	assert.ok(html.includes('#state.empty.title'), `应显示空态而不是一直「正在读取」，实际：${html.slice(0, 400)}`);
});

test('工作区仍在 pending 时渲染读取中', async () => {
	const { section } = await applyWithFakeContext();
	const html = await render(section, sectionProps({
		archivedSessionIds: [],
		byId: {},
		t: (key) => `#${key}`,
		workspaceState: 'loading',
		workspacePhase: 'pending'
	}));
	assert.ok(html.includes('#state.loading'), `应显示读取中，实际：${html.slice(0, 400)}`);
});

test('已归档列表渲染摘要标题，摘要缺失的行也不丟', async () => {
	const { section } = await applyWithFakeContext();
	const html = await render(section, sectionProps({
		archivedSessionIds: [ARCHIVED_WITH_SUMMARY, ARCHIVED_WITHOUT_SUMMARY],
		byId: {
			[ARCHIVED_WITH_SUMMARY]: {
				id: ARCHIVED_WITH_SUMMARY,
				title: 'Alpha 会话',
				cwd: 'D:\\proj',
				updatedAt: 1759100000000
			}
		},
		t: (key) => `#${key}`
	}));
	assert.ok(html.includes('Alpha 会话'), '有摘要的行必须显示标题');
	assert.ok(html.includes('#row.summaryMissing'), '缺摘要的归档 id 必须仍在列表里，显示「摘要缺失」');
	assert.ok(!html.includes('#state.empty.title'), '有数据时不应出现空态');
});

test('插槽未提供工作区数据时渲染兜底文案而不是抛错', async () => {
	const { section } = await applyWithFakeContext();
	const html = await render(section, sectionProps({
		archivedSessionIds: [],
		byId: {},
		t: (key) => `#${key}`,
		withWorkspacesHook: false
	}));
	assert.ok(html.includes('#state.unsupported'), `兜底文案缺失，实际：${html.slice(0, 300)}`);
});

test('按工作区分组：两个工作区各自成组，组头带标题与条数', async () => {
	const { section } = await applyWithFakeContext();
	const alpha = workspaceView('ws-alpha', 'Alpha 项目', 'D:\\alpha', [ARCHIVED_WITH_SUMMARY]);
	const beta = workspaceView('ws-beta', 'Beta 项目', 'D:\\beta', ['33333333-3333-4333-8333-333333333333']);
	const html = await render(section, sectionProps({
		archivedSessionIds: [ARCHIVED_WITH_SUMMARY, '33333333-3333-4333-8333-333333333333'],
		byId: {
			[ARCHIVED_WITH_SUMMARY]: { id: ARCHIVED_WITH_SUMMARY, title: 'Alpha 会话', cwd: 'D:\\alpha', updatedAt: 1759100000000 },
			['33333333-3333-4333-8333-333333333333']: { id: '33333333-3333-4333-8333-333333333333', title: 'Beta 会话', cwd: 'D:\\beta', updatedAt: 1759100000001 }
		},
		t: (key) => `#${key}`,
		items: [alpha, beta]
	}));
	assert.ok(html.includes('Alpha 项目'), '必须渲染第一个工作区的组头');
	assert.ok(html.includes('Beta 项目'), '必须渲染第二个工作区的组头');
	assert.ok(html.includes('#group.count'), '组头必须带命中条数');
	assert.ok(!html.includes('#group.unassigned'), '两个工作区都在 items 里时不应出现兜底组');
});

test('映射不到的归档 id 进兜底组且不被丢弃', async () => {
	const { section } = await applyWithFakeContext();
	const unassignedId = '44444444-4444-4444-8444-444444444444';
	const html = await render(section, sectionProps({
		archivedSessionIds: [ARCHIVED_WITH_SUMMARY, unassignedId],
		byId: {
			[ARCHIVED_WITH_SUMMARY]: { id: ARCHIVED_WITH_SUMMARY, title: 'Alpha 会话', updatedAt: 1759100000000 },
			[unassignedId]: { id: unassignedId, title: '无人认领的会话', updatedAt: 1759100000002 }
		},
		t: (key) => `#${key}`,
		items: [workspaceView('ws-alpha', 'Alpha 项目', 'D:\\alpha', [ARCHIVED_WITH_SUMMARY])]
	}));
	assert.ok(html.includes('#group.unassigned'), '映射不到的 id 必须有兜底组');
	assert.ok(html.includes('无人认领的会话'), '兜底组里的行不得被丢弃');
});

/** 统计子串出现次数（用于断言"只渲染一次"）。 */
function occurrences(html, needle) {
	return html.split(needle).length - 1;
}

test('组内行不再重复显示目录（组头已显示 path）', async () => {
	const { section } = await applyWithFakeContext();
	const path = 'D:\\alpha-project';
	const html = await render(section, sectionProps({
		archivedSessionIds: [ARCHIVED_WITH_SUMMARY],
		byId: {
			[ARCHIVED_WITH_SUMMARY]: { id: ARCHIVED_WITH_SUMMARY, title: 'Alpha 会话', cwd: path, updatedAt: 1759100000000 }
		},
		t: (key) => `#${key}`,
		items: [workspaceView('ws-alpha', 'Alpha 项目', path, [ARCHIVED_WITH_SUMMARY])]
	}));
	// 兼容两种渲染：纯文本，或官方 `PathLabel`（完整路径只在 `title`，可见文本拆成目录+文件名）。
	// 因此同时数「完整路径」与「末段名」，任一重复都说明行内又显示了目录。
	assert.equal(occurrences(html, path), 1, `工作区路径只应由组头渲染一次（行内不得重复），实际出现 ${occurrences(html, path)} 次`);
	assert.equal(occurrences(html, 'alpha-project'), 1, '路径末段名也只应出现一次（PathLabel 拆分后仍适用）');
	assert.ok(html.includes('Alpha 会话'), '行标题仍要渲染');
});

test('兜底组内保留目录（组头没有 path，行不能失去位置信息）', async () => {
	const { section } = await applyWithFakeContext();
	const orphanId = '55555555-5555-4555-8555-555555555555';
	const orphanPath = 'D:\\orphan-project';
	const html = await render(section, sectionProps({
		archivedSessionIds: [orphanId],
		byId: {
			[orphanId]: { id: orphanId, title: '孤儿会话', cwd: orphanPath, updatedAt: 1759100000003 }
		},
		t: (key) => `#${key}`,
		items: []
	}));
	assert.ok(html.includes('#group.unassigned'), '必须出现兜底组');
	assert.equal(occurrences(html, orphanPath), 1, '兜底组内必须显示该行的目录');
	assert.equal(occurrences(html, 'orphan-project'), 1, '兜底组行的路径末段名应出现（PathLabel 拆分后仍适用）');
});

/**
 * 回收站页签的 DOM 映射（此前是**最后一个**没有任何行为断言覆盖的地方）。
 *
 * 为什么需要缝：`renderToStaticMarkup` 不执行 `useEffect`，而页签与回收站数据都在组件内部
 * state / hook 里，SSR 既点不了页签、也拿不到 `/list` 结果。因此组件提供了两个**测试缝**
 * （`initialTab` 只当 `useState` 初值、`initialRecycleEntries` 预置首屏条目；运行时默认
 * `'archived'` / `undefined`，真实路径行为不变）。
 * 夹具形状照 T11/T13 `GET /list` 的**真实响应**：已清空条目带 `purgedAt` + `purgedBatch`。
 */
test('回收站页签：已清空条目显示官方 Tag 标记且还原禁用（测试缝驱动）', async () => {
	const { section } = await applyWithFakeContext();
	const recycled = 'session-0b9de1ba-1111-4111-8111-111111111111';
	const batch = '20260929-093138';
	// 刻意**不注入 `t`**：这样走组件自带的 zh 词典与**真实插值**路径。
	// 原因：`createTranslate` 对宿主翻译器只传 key（`bound(key)`），插值由我们自己的词典层做
	// （`locales.ts:288-299`）—— 注入探针会让 `{batch}` 永远看不到，断言就成了假绿。
	const html = await render(section, {
		...sectionProps({ archivedSessionIds: [], byId: {} }),
		initialTab: 'recycle',
		initialRecycleEntries: [{
			entryId: `1790673301827@${recycled}`,
			sessionId: recycled,
			movedAt: '2026-09-29T09:31:38.509Z',
			originalPath: `D:\\DSH\\dsh-home\\sessions\\--C-Users-25286--\\${recycled}`,
			bytes: 132,
			cwd: 'D:\\DSH-PLUGIN\\dsh-archive-manager',
			purgedAt: '2026-09-29T09:31:38.509Z',
			purgedBatch: batch
		}]
	});

	assert.ok(html.includes('已在冷存档区'), `已清空条目必须显示「已在冷存档区」标记，实际：${html.slice(0, 700)}`);
	assert.ok(html.includes('data-tone='), '该标记必须用官方 Tag（渲染出 data-tone）');
	assert.ok(html.includes(`批次 ${batch}`), `必须把冷存档批次名代入文案，便于人工找回载荷，实际：${html.slice(0, 700)}`);
	assert.ok(html.includes('无法还原：未命名会话'), '禁用原因要进入独立无障碍名（按钮视觉禁用但 Tooltip 仍可读）');
	assert.ok(/<button[^>]*disabled/.test(html), '已清空条目的还原按钮必须是 disabled 的');
	assert.ok(!html.includes('无法从本页还原'), '有批次名时不得走「无批次」分支');
});
