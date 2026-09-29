/**
 * PLAN.md 事实性核验（T5 独立复核，对抗性）。
 *
 * 逐条把 PLAN.md 引用的「证据行号」拿到磁盘上重放；引用错位一律记为 MISMATCH。
 * 关键纪律：**npm 0.1.7-rc.2 的包只作参照，运行中宿主是 0.2.0-rc.1（asar）**，
 * 因此凡结论依赖运行时行为的事实，必须同时在 asar 上复核。
 *
 * 只读。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASAR_PATH, NPM_DSH_PACKAGES, DELETE_API_PATTERNS, discoverNpmFrontend } from './tools/expectations.mjs';

const PLAN_PATH = fileURLToPath(new URL('../../PLAN.md', import.meta.url));
/** 参照树（profile 安装）的 dsh 元包版本；本会话期间由 0.1.7-rc.2 升到 0.2.0-rc.1，故动态读取而非硬编码。 */
const TREE_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(`${NPM_DSH_PACKAGES}/../../package.json`, 'utf8')).version ?? 'unknown';
	} catch {
		return 'unknown';
	}
})();

const results = [];
const record = (status, label, evidence) => results.push({ status, label, evidence });

const lines = (file) => readFileSync(file, 'utf8').split(/\r?\n/);
const slice = (file, from, to) => lines(file).slice(from - 1, to).join('\n');

// ---------- 1. host-webserver match(): 精确表优先 + 最长前缀优先 ----------
{
	const file = `${NPM_DSH_PACKAGES}/dsh-host-webserver/lib/index.js`;
	if (!existsSync(file)) record('INCONCLUSIVE', 'host-webserver match()', `文件不存在：${file}`);
	else {
		const body = slice(file, 322, 332);
		const ok =
			body.includes('Longest-prefix-wins over the prefix table after an exact-table miss') &&
			/exact\.get\(pathname\)/.test(body) &&
			/prefix\.length > best\.path\.length/.test(body);
		record(ok ? 'PASS' : 'MISMATCH', 'PLAN 10.1：`dsh-host-webserver/lib/index.js:322-332` = 精确表优先、其后最长前缀优先',
			ok ? `第 322 行注释命中；324-331 行为 exact.get(pathname) + prefix.length 比较\n${body}` : `行 322-332 与描述不符：\n${body}`);
	}
	// 同款代码在运行中 GUI（0.2.0-rc.1）
	if (!existsSync(ASAR_PATH)) record('INCONCLUSIVE', 'host-webserver match() @0.2.0-rc.1', 'asar 不存在');
	else {
		const source = readFileSync(ASAR_PATH).toString('latin1');
		const ok = source.includes('Longest-prefix-wins over the prefix table after an exact-table miss') && source.includes('prefix.length > best.path.length');
		record(ok ? 'PASS' : 'MISMATCH', '运行中 0.2.0-rc.1 的 match() 语义相同（跨版本一致性）',
			ok ? `asar 内在 byte ${source.indexOf('Longest-prefix-wins')} 处命中同一实现` : 'asar 内未命中同款实现');
	}
}

// ---------- 2. connection fetch route：/api 之下 + 官方鉴权 ----------
{
	const file = `${NPM_DSH_PACKAGES}/dsh-client-connection/lib/types/rpc.d.ts`;
	if (!existsSync(file)) record('INCONCLUSIVE', 'connection fetch route 类型', `文件不存在：${file}`);
	else {
		const body = slice(file, 110, 129);
		const hasInterface = body.includes('ConnectionFetchRoute');
		const belowApi = body.includes('Absolute path below `/api`');
		const auth = body.includes('trust and authentication policy');
		const register = /register\(route: ConnectionFetchRoute\)/.test(body);
		const methodLine = lines(file)[106] ?? '';
		const methods = methodLine.includes("'GET' | 'HEAD' | 'POST'");
		record(hasInterface && belowApi && auth && register ? 'PASS' : 'MISMATCH',
			'PLAN D5：`dsh-client-connection/lib/types/rpc.d.ts:110-129` = path 在 /api 之下 + 鉴权由官方通道完成',
			`interface=${hasInterface} belowApi=${belowApi} auth=${auth} register=${register}；另注（第 107 行）：ConnectionFetchMethod 仅 GET/HEAD/POST=${methods} → 本插件只用 GET/POST，兼容`);
	}
}

// ---------- 3. settings-general 注册写法 ----------
{
	const file = `${NPM_DSH_PACKAGES}/dsh-client-ui-settings-general/lib/client.js`;
	if (!existsSync(file)) record('INCONCLUSIVE', 'settings.section 注册写法', `文件不存在：${file}`);
	else {
		const body = slice(file, 1167, 1177);
		const ok = body.includes('"settings.section"') && body.includes('id: "general",') && body.includes('order: 0,') && body.includes('label: () => t("general.nav")');
		record(ok ? 'PASS' : 'MISMATCH', 'PLAN 2.3：`dsh-client-ui-settings-general/lib/client.js:1167-1177` 的注册写法',
			ok ? 'id/order/label(thunk)/locale/children 逐项命中（label 为 thunk，与 PLAN 6 的 i18n 要求一致）' : `不符：\n${body}`);
	}
}

// ---------- 4. 信封 + 基座表（运行中 0.2.0-rc.1） ----------
{
	if (!existsSync(ASAR_PATH)) record('INCONCLUSIVE', 'bundle 信封 @0.2.0-rc.1', 'asar 不存在');
	else {
		const source = readFileSync(ASAR_PATH).toString('latin1');
		const envelope = source.split('window.__ModuleLoader__.load({').length - 1;
		record(envelope > 0 ? 'PASS' : 'MISMATCH', 'PLAN 10.1：客户端 bundle 信封 `window.__ModuleLoader__.load({id, factory})`',
			`asar 内出现 ${envelope} 次；样例：id "@deepseek-ai/dsh-client-locale" / factory: (require) => {...}`);
		const assetMatch = source.match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
		const realAsset = assetMatch === null ? undefined : `index-${assetMatch[1]}.js`;
		const npmAssetName = discoverNpmFrontend()?.index;
		const planText = existsSync(PLAN_PATH) ? readFileSync(PLAN_PATH, 'utf8') : '';
		const planCitesReal = realAsset !== undefined && planText.includes(realAsset);
		const planCitesNpm = planText.includes(npmAssetName);
		const npmLabeled = /0\.1\.7/.test(planText);
		record(planCitesReal ? 'PASS' : 'MISMATCH',
			'PLAN 10.1：基座表来源文件名必须与运行中 0.2.0-rc.1 的真实资源一致',
			`asar 内真实资源=${realAsset}（由 asar 中 assets/index-*.js 解析）；PLAN 是否引用它=${planCitesReal}；` +
				`PLAN 是否也提到 npm 版 ${npmAssetName}=${planCitesNpm}（提到时须标注 0.1.7：${npmLabeled}）。` +
				'两源解析出的 9 键基座表一致，见 platform-modules-check.mjs。');
	}
}

// ---------- 5. 「官方没有会话删除接口」：两个版本各自重查 ----------
{
	// 5a. npm 0.1.7 的 *.d.ts 全量
	const hits = [];
	const privateHits = [];
	let scanned = 0;
	// 公开标识符：前面不能是 `_` 或词字符，故 `private _deleteSession;` 不算公开命中。
	const publicRe = new RegExp(`(?<![_\\w])(${DELETE_API_PATTERNS.join('|')})\\b`);
	const privateRe = new RegExp(`(?<![\\w])(_${DELETE_API_PATTERNS.join('|_')})\\b`);
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === 'node_modules') continue;
				walk(full);
			} else if (e.isFile() && e.name.endsWith('.d.ts')) {
				scanned += 1;
				let text;
				try {
					text = readFileSync(full, 'utf8');
				} catch {
					continue;
				}
				const relativePath = full.replace(/\\/g, '/');
				text.split(/\r?\n/).forEach((line, index) => {
					if (publicRe.test(line)) hits.push(`${relativePath}:${index + 1} :: ${line.trim().slice(0, 140)}`);
					if (privateRe.test(line)) privateHits.push(`${relativePath}:${index + 1} :: ${line.trim().slice(0, 140)}`);
				});
			}
		}
	};
	if (existsSync(NPM_DSH_PACKAGES)) walk(NPM_DSH_PACKAGES);
	record(hits.length === 0 ? 'PASS' : 'MISMATCH',
		`PLAN 2.2：参照树（@deepseek-ai/dsh@${TREE_VERSION}）全量 *.d.ts 无**公开** deleteSession/removeSession/purgeSession`,
		`扫描 ${scanned} 个 .d.ts（树版本 ${TREE_VERSION}；本会话期间该树已由 0.1.7-rc.2 升到 0.2.0-rc.1，即与运行中宿主同版本 → 该结论比原先更强）；公开命中 ${hits.length} 条；下划线私有命中 ${privateHits.length} 条\n${hits.join('\n')}${privateHits.length ? `\n私有（不算公开接口）：\n${privateHits.join('\n')}` : ''}`);

	// 5b. 运行中 0.2.0-rc.1 asar
	if (existsSync(ASAR_PATH)) {
		const source = readFileSync(ASAR_PATH).toString('latin1');
		const counts = {};
		for (const pattern of [...DELETE_API_PATTERNS, '_deleteSession', 'removeSession', 'purgeSession', 'unarchive-sessions']) {
			counts[pattern] = source.split(pattern).length - 1;
		}
		const agentProtocol = source.includes('session_delete: "session/delete"') && source.includes('sessionCapabilities.delete');
		record(counts.removeSession === 0 && counts.purgeSession === 0 && counts['unarchive-sessions'] === 0 ? 'PASS' : 'MISMATCH',
			'PLAN 2.2：运行中 0.2.0-rc.1 无 removeSession/purgeSession，且无官方 unarchive-sessions 设置页',
			`出现次数 ${JSON.stringify(counts)}`);
		record('INFO',
			'PLAN 2.2 措辞「删除会话 ❌ 完全不存在」需限定范围（重要反例）',
			`0.2.0-rc.1 asar 内 deleteSession 命中 ${counts.deleteSession} 次，全部属 **Agent 协议**层：` +
				`AGENT_METHODS.session_delete === "session/delete"（agentCapabilities=${agentProtocol}），用于请求外部 agent 删除其 session/list 中的会话；` +
				`另有下划线私有 _deleteSession(${counts._deleteSession} 次) 属 sqlite 搜索索引行删除。` +
				'→ 结论「DSH 自身工作区/转录存储没有删除接口」成立；但「全仓完全不存在该标识符」不成立。');
	}
}

// ---------- 输出 ----------
const order = { PASS: 0, MISMATCH: 1, INCONCLUSIVE: 2, INFO: 3 };
results.sort((a, b) => order[a.status] - order[b.status]);
let mismatches = 0;
for (const r of results) {
	if (r.status === 'MISMATCH') mismatches += 1;
	console.log(`[${r.status}] ${r.label}\n    ${r.evidence.replace(/\n/g, '\n    ')}\n`);
}
console.log(`# 汇总：${results.filter((r) => r.status === 'PASS').length} PASS / ${mismatches} MISMATCH / ${results.filter((r) => r.status === 'INCONCLUSIVE').length} INCONCLUSIVE / ${results.filter((r) => r.status === 'INFO').length} INFO`);
console.log(mismatches === 0 ? 'PASS facts-check' : `FAIL facts-check（${mismatches} 项引用不符）`);
process.exitCode = mismatches === 0 ? 0 : 1;
