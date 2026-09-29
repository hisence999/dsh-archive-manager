/**
 * 「已归档会话」页的中英词典与取词工具。
 *
 * 证据来源：
 * - `ctx.locale.register(namespace, locale, dictionary)` / `ctx.locale.bind(ns)`：
 *   实时 Client Service 清单里 `locale` 服务的签名，已固化在 `src/dsh.client.d.ts`
 *   （`DshLocaleService`）。
 * - 词典里出现 `{...}` 占位符时的插值由本文件的 {@link interpolate} 完成，**不依赖**
 *   宿主 `t` 是否支持第二个 `values` 参数，从而避免不同版本的行为差异。
 */

import type { Context } from '@deepseek-ai/cordis';
import { LOCALE_NAMESPACE } from '../contracts.js';

/** 一份扁平词典：`key → 文案`。 */
export type LocaleDictionary = Readonly<Record<string, string>>;

/** 宿主词典服务不可用时的兜底语言。 */
export const FALLBACK_LOCALE = 'zh';

/** 简体中文词典。 */
export const LOCALE_ZH: LocaleDictionary = {
	'section.nav': '已归档会话',
	'section.title': '已归档会话',
	'section.description': '这里列出所有已归档的会话。恢复后，会话会回到它原来的工作区位置。',

	'toolbar.search.placeholder': '搜索标题或项目',
	'toolbar.search.aria': '搜索已归档会话',
	'toolbar.sort.label': '排序',
	'toolbar.sort.updatedAt': '按更新时间',
	'toolbar.sort.title': '按标题',
	'toolbar.retry': '重新读取',
	'toolbar.retry.aria': '重新读取已归档会话',

	'state.loading': '正在读取已归档会话…',
	'state.empty.title': '还没有已归档会话',
	'state.empty.hint': '在侧栏把会话归档后，它会出现在这里。',
	'state.empty.filtered': '没有匹配的会话',
	'state.empty.filteredHint': '换个关键词，或清空搜索框。',
	'state.error.title': '读取已归档会话失败',
	'state.error.retry': '重试',
	'state.unsupported': '当前设置插槽没有提供工作区数据，无法列出已归档会话。',

	'list.count': '共 {count} 条',
	'list.filtered': '显示 {shown} / {total} 条',
	'list.selectAll.aria': '全选当前列表',
	'list.row.select.aria': '选择会话 {title}',

	'group.unassigned': '未归属工作区',
	'group.untitled': '未命名工作区',
	'group.count': '{count} 条',
	'group.collapse.aria': '收起工作区 {title}',
	'group.expand.aria': '展开工作区 {title}',
	'group.restoreAll': '全部恢复',
	'group.restoreAll.aria': '恢复工作区 {title} 的全部会话',

	'row.summaryMissing': '摘要缺失',
	'row.projectUnknown': '未知项目',
	'row.running': '运行中',
	'row.restore': '恢复',
	'row.restore.aria': '恢复会话 {title}',
	'row.delete': '移入回收站',
	'row.delete.aria': '把会话 {title} 移入回收站',

	'batch.selected': '已选 {count} 条',
	'batch.restore': '批量恢复',
	'batch.delete': '移入回收站',
	'batch.clear': '取消选择',

	'time.now': '刚刚',
	'time.minutes': '{n} 分钟前',
	'time.hours': '{n} 小时前',
	'time.days': '{n} 天前',
	'time.months': '{n} 个月前',
	'time.years': '{n} 年前',
	'time.unknown': '时间未知',

	'tab.label': '视图',
	'tab.archived': '已归档 {count}',
	'tab.recycle': '回收站 {count}',

	'recycle.description': '已移入回收站的会话。还原会把工件移回原路径；清空只是移交给冷存档区，不做物理删除。',
	'recycle.empty': '回收站是空的',
	'recycle.restore': '还原',
	'recycle.restore.aria': '还原回收站条目 {title}',
	'recycle.entryUntitled': '未命名会话',
	'recycle.purgedTag': '已在冷存档区',
	'recycle.purgedHint': '载荷已移交冷存档区（批次 {batch}），回收站内无法还原；可人工到 archive-manager/purged/{batch} 下找回。',
	'recycle.purgedHintNoBatch': '载荷已移交冷存档区，无法从本页还原。',
	'recycle.restore.disabled.aria': '无法还原：{title} 已在冷存档区',
	'recycle.purge': '清空回收站',
	'recycle.purge.title': '清空回收站？',
	'recycle.purge.body': '将把回收站里的 {count} 条会话移交到冷存档区。这只是移动，不做物理删除。',
	'recycle.purge.ack': '我了解：这是移交到冷存档区，不是物理删除',
	'recycle.purge.confirm': '移交到冷存档区',
	'recycle.purge.cancel': '取消',
	'recycle.purge.close': '关闭',
	'recycle.error.title': '读取回收站失败',
	'recycle.degraded': '回收站清单读取失败；「已归档」视图不受影响，可继续使用。',

	'notice.entryRestored': '已还原 {count} 条回收站条目',
	'notice.entryRestorePartial': '{ok} 条已还原，{failed} 条失败',
	'notice.purged': '已移交 {count} 条到冷存档区',
	'notice.purgePartial': '{ok} 条已移交，{failed} 条原地保留',

	'notice.restoredAll': '已恢复 {count} 条会话',
	'notice.restorePartial': '{ok} 条已恢复，{failed} 条恢复失败',
	'notice.recycledAll': '已把 {count} 条会话移入回收站（可还原）',
	'notice.recyclePartial': '{ok} 条已移入回收站，{failed} 条失败',
	'notice.noWorkspaces': '恢复接口不可用：插槽没有提供工作区服务。',
	'notice.dismiss': '关闭提示',

	'error.title': '操作失败',
	'error.technical': '技术详情',
	'error.sessionLiveHint': '其中 {count} 条会话正在运行，请先停止它们再重试。',
	'error.invalid-input': '请求不合法，已被拒绝。',
	'error.session-live': '会话正在运行，无法删除。',
	'error.session-missing': '找不到会话文件，可能已被移走。',
	'error.path-unsafe': '路径不安全（符号链接或越出会话目录），已拒绝。',
	'error.entry-not-found': '回收站条目不存在或已损坏。',
	'error.entry-conflict': '还原目标已存在，拒绝覆盖。',
	'error.cross-device': '回收站与会话目录不在同一卷，无法移动。',
	'error.child-session': '这是子代理子会话，不支持单独删除。',
	'error.internal': '宿主内部错误。',
	'error.entry-purged': '条目已移交到冷存档区，无法从本页还原。',
	'error.unknown': '未知错误。',

	'confirm.title': '移入回收站？',
	'confirm.body': '将把选中的 {count} 条会话移入插件回收站，之后可以还原；不会物理删除任何文件。',
	'confirm.confirm': '移入回收站',
	'confirm.cancel': '取消',
	'confirmRestore.title': '恢复这些会话？',
	'confirmRestore.body': '将恢复 {count} 条会话，它们会回到各自工作区的原位置。'
};

/** English dictionary (kept structurally identical to {@link LOCALE_ZH}). */
export const LOCALE_EN: LocaleDictionary = {
	'section.nav': 'Archived sessions',
	'section.title': 'Archived sessions',
	'section.description': 'Every archived session is listed here. Restoring one returns it to its original workspace position.',

	'toolbar.search.placeholder': 'Search title or project',
	'toolbar.search.aria': 'Search archived sessions',
	'toolbar.sort.label': 'Sort',
	'toolbar.sort.updatedAt': 'By updated time',
	'toolbar.sort.title': 'By title',
	'toolbar.retry': 'Reload',
	'toolbar.retry.aria': 'Reload archived sessions',

	'state.loading': 'Loading archived sessions…',
	'state.empty.title': 'No archived sessions yet',
	'state.empty.hint': 'Archive a session from the sidebar and it will show up here.',
	'state.empty.filtered': 'No matching sessions',
	'state.empty.filteredHint': 'Try another keyword, or clear the search box.',
	'state.error.title': 'Could not load archived sessions',
	'state.error.retry': 'Retry',
	'state.unsupported': 'This settings slot did not provide workspace data, so archived sessions cannot be listed.',

	'list.count': '{count} total',
	'list.filtered': 'Showing {shown} of {total}',
	'list.selectAll.aria': 'Select every listed session',
	'list.row.select.aria': 'Select session {title}',

	'group.unassigned': 'No workspace',
	'group.untitled': 'Untitled workspace',
	'group.count': '{count} session(s)',
	'group.collapse.aria': 'Collapse workspace {title}',
	'group.expand.aria': 'Expand workspace {title}',
	'group.restoreAll': 'Restore all',
	'group.restoreAll.aria': 'Restore every session in workspace {title}',

	'row.summaryMissing': 'Summary missing',
	'row.projectUnknown': 'Unknown project',
	'row.running': 'Running',
	'row.restore': 'Restore',
	'row.restore.aria': 'Restore session {title}',
	'row.delete': 'Move to recycle bin',
	'row.delete.aria': 'Move session {title} to the recycle bin',

	'batch.selected': '{count} selected',
	'batch.restore': 'Restore selected',
	'batch.delete': 'Move to recycle bin',
	'batch.clear': 'Clear selection',

	'time.now': 'just now',
	'time.minutes': '{n} minutes ago',
	'time.hours': '{n} hours ago',
	'time.days': '{n} days ago',
	'time.months': '{n} months ago',
	'time.years': '{n} years ago',
	'time.unknown': 'Time unknown',

	'tab.label': 'Views',
	'tab.archived': 'Archived {count}',
	'tab.recycle': 'Recycle bin {count}',

	'recycle.description': 'Sessions moved to the recycle bin. Restoring moves the files back to their original path; emptying only hands them to cold storage — nothing is physically deleted.',
	'recycle.empty': 'The recycle bin is empty',
	'recycle.restore': 'Restore',
	'recycle.restore.aria': 'Restore recycle-bin entry {title}',
	'recycle.entryUntitled': 'Untitled session',
	'recycle.purgedTag': 'In cold storage',
	'recycle.purgedHint': 'The payload was handed to cold storage (batch {batch}) and cannot be restored from the recycle bin; recover it manually under archive-manager/purged/{batch}.',
	'recycle.purgedHintNoBatch': 'The payload was handed to cold storage and cannot be restored from this page.',
	'recycle.restore.disabled.aria': 'Cannot restore: {title} is already in cold storage',
	'recycle.purge': 'Empty recycle bin',
	'recycle.purge.title': 'Empty the recycle bin?',
	'recycle.purge.body': 'The {count} session(s) in the recycle bin will be handed over to cold storage. This is a move, not a physical delete.',
	'recycle.purge.ack': 'I understand: this hands them to cold storage, it does not physically delete them',
	'recycle.purge.confirm': 'Hand over to cold storage',
	'recycle.purge.cancel': 'Cancel',
	'recycle.purge.close': 'Close',
	'recycle.error.title': 'Could not load the recycle bin',
	'recycle.degraded': 'The recycle bin could not be loaded; the Archived view is unaffected and remains usable.',

	'notice.entryRestored': 'Restored {count} recycle-bin entry(ies)',
	'notice.entryRestorePartial': '{ok} restored, {failed} failed',
	'notice.purged': 'Handed {count} over to cold storage',
	'notice.purgePartial': '{ok} handed over, {failed} kept in place',

	'notice.restoredAll': 'Restored {count} session(s)',
	'notice.restorePartial': '{ok} restored, {failed} failed',
	'notice.recycledAll': 'Moved {count} session(s) to the recycle bin (restorable)',
	'notice.recyclePartial': '{ok} moved to the recycle bin, {failed} failed',
	'notice.noWorkspaces': 'Restore is unavailable: the slot did not provide the workspace service.',
	'notice.dismiss': 'Dismiss',

	'error.title': 'Operation failed',
	'error.technical': 'Technical details',
	'error.sessionLiveHint': '{count} of them are running; stop those sessions and retry.',
	'error.invalid-input': 'The request was rejected as invalid.',
	'error.session-live': 'The session is running and cannot be deleted.',
	'error.session-missing': 'The session files are missing; they may already have been moved.',
	'error.path-unsafe': 'Unsafe path (symbolic link or outside the sessions directory); refused.',
	'error.entry-not-found': 'The recycle-bin entry is missing or damaged.',
	'error.entry-conflict': 'The restore target already exists; refusing to overwrite.',
	'error.cross-device': 'The recycle bin and the sessions directory are on different volumes.',
	'error.child-session': 'This is a subagent child session and cannot be deleted on its own.',
	'error.internal': 'Internal host error.',
	'error.entry-purged': 'This entry has been handed to cold storage and cannot be restored from this page.',
	'error.unknown': 'Unknown error.',

	'confirm.title': 'Move to the recycle bin?',
	'confirm.body': 'The {count} selected session(s) will be moved to the plugin recycle bin, where they can be restored. No file is physically deleted.',
	'confirm.confirm': 'Move to recycle bin',
	'confirm.cancel': 'Cancel',
	'confirmRestore.title': 'Restore these sessions?',
	'confirmRestore.body': 'The {count} session(s) will be restored to their original workspace positions.'
};

/** 所有内置词典，按语言 id 索引。 */
export const DICTIONARIES: Readonly<Record<string, LocaleDictionary>> = {
	zh: LOCALE_ZH,
	en: LOCALE_EN
};

/**
 * 取某个语言 id 对应的词典：先精确匹配，再取语言主标签（`zh-CN` → `zh`），
 * 最后回落到 {@link FALLBACK_LOCALE}。
 */
export function pickDictionary(localeId: string | undefined): LocaleDictionary {
	const raw = typeof localeId === 'string' ? localeId.trim().toLowerCase() : '';
	const exact = DICTIONARIES[raw];
	if (exact !== undefined) return exact;
	const primary = raw.split(/[-_]/)[0] ?? '';
	return DICTIONARIES[primary] ?? LOCALE_ZH;
}

/**
 * 用 `values` 替换模板里的 `{name}` 占位符。
 * 未提供对应值时保留原样，便于一眼看出漏配的文案。
 */
export function interpolate(template: string, values?: Readonly<Record<string, string | number>>): string {
	if (values === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (matched, name: string) => {
		const value = values[name];
		return value === undefined ? matched : String(value);
	});
}

/** 页面使用的取词函数。 */
export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

/**
 * 组装取词函数：优先用宿主 `t`（`locale` 注册后由插槽注入），
 * 宿主缺失时回落到内置词典。两者都查不到时返回 key 本身（可见但不会崩）。
 */
export function createTranslate(bound: DshTranslate | undefined, localeId: string | undefined): Translate {
	const dictionary = pickDictionary(localeId);
	return (key, values) => {
		let template: string | undefined;
		if (typeof bound === 'function') {
			const fromHost = bound(key);
			// 宿主未注册该 key 时通常原样返回 key，此时改用内置词典兜底。
			if (typeof fromHost === 'string' && fromHost.length > 0 && fromHost !== key) template = fromHost;
		}
		template ??= dictionary[key];
		return interpolate(template ?? key, values);
	};
}

/** 把中英词典注册到宿主 `locale` 服务；随插件 fiber 一起回收。 */
export function registerLocales(ctx: Context): void {
	for (const [localeId, dictionary] of Object.entries(DICTIONARIES)) {
		ctx.effect(
			() => ctx.locale.register(LOCALE_NAMESPACE, localeId, { ...dictionary }),
			`dsh-archive-manager: locale ${localeId}`
		);
	}
}
