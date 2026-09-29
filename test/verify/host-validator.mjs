/**
 * 运行中宿主的 exact-Fetch-route 校验器：**独立重建 + 负控**（T5）。
 *
 * 背景：`scripts/check-routes-against-host.mjs`（lead 写）已经从 asar 抽出宿主的真实
 * `endpointFromPath` / `assertFetchRoute` 并跑通我们的 4 条路径。本脚本做的是**对抗性补充**：
 *
 * 1. **抽取完整性**：断言抽出的片段确实含应有的锚点（防止抽错函数/抽到同名别处）；
 * 2. **负控（negative control）**：把旧写法 `/dsh-archive-manager/list`（真机第一次激活失败的
 *    那一版）喂给同一个校验器，**必须被拒**。只有"接受正确输入 + 拒绝已知错误输入"同时成立，
 *    才能排除"校验器根本没在工作"的假绿；
 * 3. **越界/畸形路径**：无 `/api` 前缀、双前缀 `/api/api/...`、含 `..`、含空段、含非法字符，
 *    逐条必须被拒；
 * 4. 我们当前的 4 条 `HOST_ROUTES` 必须被接受。
 *
 * 只读；不写任何文件。
 * 用法：node test/verify/host-validator.mjs [asar路径]
 */
import fs from 'node:fs';

const asar = process.argv[2] ?? process.env.DSH_ASAR ?? 'E:\\DSH\\resources\\app.asar';
if (!fs.existsSync(asar)) {
	console.error(`未覆盖：找不到运行中 asar（${asar}）——本脚本必须对 0.2.0-rc.1 取证`);
	process.exit(2);
}

/** 按 asar 头部格式读出某个条目的文本。 */
function readAsarEntry(asarPath, target) {
	const fd = fs.openSync(asarPath, 'r');
	try {
		const head = Buffer.alloc(16);
		fs.readSync(fd, head, 0, 16, 0);
		const headerSize = head.readUInt32LE(4);
		const headerStrSize = head.readUInt32LE(8);
		const headerBuf = Buffer.alloc(headerStrSize);
		fs.readSync(fd, headerBuf, 0, headerStrSize, 16);
		const headerText = headerBuf.toString('utf8');
		const header = JSON.parse(headerText.slice(0, headerText.lastIndexOf('}') + 1));
		const dataOffset = 8 + headerSize;
		let node = header;
		for (const segment of target.split('/').filter(Boolean)) {
			node = node.files?.[segment];
			if (node === undefined) throw new Error(`asar 内未找到 ${target}`);
		}
		if (node.files !== undefined) throw new Error(`${target} 是目录`);
		const buf = Buffer.alloc(node.size);
		fs.readSync(fd, buf, 0, node.size, dataOffset + Number(node.offset));
		return buf.toString('utf8');
	} finally {
		fs.closeSync(fd);
	}
}

/** 按大括号配对抽 `function NAME(...) {...}`。 */
function extractFunction(text, name) {
	const start = text.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`未找到 function ${name}`);
	const open = text.indexOf('{', start);
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const char = text[index];
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	throw new Error(`function ${name} 的大括号不配对`);
}

function extractConst(text, name) {
	const matched = new RegExp(`const ${name} = .*?;`).exec(text);
	if (matched === null) throw new Error(`未找到 const ${name}`);
	return matched[0];
}

const ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js';
const source = readAsarEntry(asar, ENTRY);
const channelPattern = extractConst(source, 'CHANNEL_PATTERN');
const segmentPattern = extractConst(source, 'ENDPOINT_SEGMENT_PATTERN');
const endpointFromPathSrc = extractFunction(source, 'endpointFromPath');
const assertFetchRouteSrc = extractFunction(source, 'assertFetchRoute');

const failures = [];
const notes = [];
const check = (ok, label, detail) => {
	if (ok) notes.push(`PASS ${label}`);
	else failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`);
};

// --- 1. 抽取完整性（锚点必须存在，否则「抽错东西」也会 PASS） ---
check(channelPattern.includes('CHANNEL_PATTERN'), '抽取完整性：CHANNEL_PATTERN 片段含自身标识', channelPattern);
check(segmentPattern.includes('ENDPOINT_SEGMENT_PATTERN'), '抽取完整性：ENDPOINT_SEGMENT_PATTERN 片段含自身标识', segmentPattern);
check(endpointFromPathSrc.includes('startsWith') && endpointFromPathSrc.includes('channel'), '抽取完整性：endpointFromPath 片段含 startsWith(channel/) 逻辑', endpointFromPathSrc.slice(0, 120));
check(assertFetchRouteSrc.includes('invalid exact Fetch route'), '抽取完整性：assertFetchRoute 片段含官方错误文案', assertFetchRouteSrc.slice(0, 160));
notes.push(`片段长度：endpointFromPath=${endpointFromPathSrc.length} assertFetchRoute=${assertFetchRouteSrc.length}`);

// --- 2. 在隔离作用域重建校验器 ---
const host = new Function(`${[channelPattern, segmentPattern, endpointFromPathSrc, assertFetchRouteSrc].join('\n')}\nreturn { endpointFromPath, assertFetchRoute };`)();
const accepts = (path) => {
	try {
		host.assertFetchRoute({ path, methods: ['POST'] });
		return host.endpointFromPath('/api', path) !== undefined;
	} catch {
		return false;
	}
};

// --- 3. 负控：旧写法 / 畸形写法必须被拒 ---
const rejects = [
	['旧写法（真机第一次激活失败的那一版）', '/dsh-archive-manager/list'],
	['不含 /api', '/dsh-archive-manager/list'],
	['含 .. 段', '/api/../dsh-archive-manager/list'],
	['含空段', '/api//dsh-archive-manager/list'],
	['含非法字符', '/api/dsh archive manager/list'],
	['含查询串', '/api/dsh-archive-manager/list?x=1'],
	['仅 /api', '/api'],
	['空串', '']
];
for (const [label, path] of rejects) {
	check(!accepts(path), `负控：${label} 必须被宿主校验器拒绝（${JSON.stringify(path)}）`, accepts(path) ? '竟然被接受' : undefined);
}

// --- 3b. 双前缀：官方校验器**不会**拒绝，只会把它解析成另一个 endpoint ---
// 这是重要发现：`/api/api/dsh-archive-manager/list` 能注册成功，但真实请求只会打到
// `/api/dsh-archive-manager/list`（分发用 fetchRoutes.get(url.pathname) 精确匹配）→ **静默 404**。
// 所以"双前缀"由 `contract-consistency.mjs` 在契约层拦截（CLIENT_API_PREFIX 必须为空串）。
{
	const dbl = host.endpointFromPath('/api', '/api/api/dsh-archive-manager/list');
	check(dbl === 'api/dsh-archive-manager/list', 'OBSERVE：双前缀被官方校验器解析成 "api/dsh-archive-manager/list"（不报错，会静默 404）', JSON.stringify(dbl));
	notes.push('OBSERVE 官方 assertFetchRoute 不拦双前缀；契约层 guard 见 contract-consistency.mjs 的 CLIENT_API_PREFIX 断言');
}

// --- 4. 正控：我们当前的 4 条路由必须被接受 ---
const { HOST_ROUTES } = await import(new URL('../../lib/contracts.js', import.meta.url).href);
const methods = { list: ['GET'], recycle: ['POST'], restore: ['POST'], purge: ['POST'] };
notes.push(`校验器来源：${asar} → ${ENTRY}`);
for (const [name, path] of Object.entries(HOST_ROUTES)) {
	const endpoint = host.endpointFromPath('/api', path);
	let error = null;
	try {
		host.assertFetchRoute({ path, methods: methods[name] });
	} catch (thrown) {
		error = thrown;
	}
	check(error === null && endpoint === `dsh-archive-manager/${name}`, `正控：${name} 被接受且 endpoint 正确`, error === null ? `endpoint=${JSON.stringify(endpoint)}` : `抛错 ${error.message}`);
}

// --- 5. 方法数组的官方约束（assertFetchRoute 也管这个） ---
{
	let emptyRejected = false;
	let dupRejected = false;
	try {
		host.assertFetchRoute({ path: '/api/x/y', methods: [] });
	} catch {
		emptyRejected = true;
	}
	try {
		host.assertFetchRoute({ path: '/api/x/y', methods: ['POST', 'POST'] });
	} catch {
		dupRejected = true;
	}
	check(emptyRejected, '负控：空 methods 被拒（官方 assertFetchRoute 会抛）');
	check(dupRejected, '负控：重复 methods 被拒');
}

for (const note of notes) console.log(`# ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? `\nPASS host-validator（${notes.length} 项说明 / 全部断言通过）` : `\nFAIL host-validator（${failures.length} 项）`);
process.exitCode = failures.length === 0 ? 0 : 1;
