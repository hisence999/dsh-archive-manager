/**
 * 用**运行中宿主里的真实校验器**验证我们的路由路径（开发/CI 可选的强校验）。
 *
 * 背景：真机第一次激活失败，报
 *   `connection: invalid exact Fetch route "/dsh-archive-manager/list"`
 * —— 因为 `ctx.connection.fetch.register` 的 `path` 必须自带 `/api/` 前缀，而官方
 * types 里 "Absolute path below `/api`" 的注释有歧义。`test/build.test.mjs` 用等价规则
 * 做了永久守卫（正则近似）；本脚本进一步**从 asar 抽出宿主的真实实现并直接执行**，
 * 把"我们以为的规则"换成"宿主实际执行的规则"。
 *
 * 用法：
 *   node scripts/check-routes-against-host.mjs [asar 路径]
 *   （默认 `E:\DSH\resources\app.asar`，可用环境变量 DSH_ASAR 覆盖）
 * 找不到 asar 时打印 SKIP 并以 0 退出（其他机器上不阻塞）。
 */
import fs from 'node:fs';

const asar = process.argv[2] ?? process.env.DSH_ASAR ?? 'E:\\DSH\\resources\\app.asar';
if (!fs.existsSync(asar)) {
	console.log(`SKIP: 未找到 asar（${asar}），跳过宿主真实校验器验证`);
	process.exit(0);
}

/** 读出 asar 中某个条目的文本。 */
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

/** 从源码文本里按大括号配对抽出一个 `function NAME(...) {...}` 的完整定义。 */
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

/** 抽出一个 `const NAME = /.../;` 形式的常量定义。 */
function extractConst(text, name) {
	const matched = new RegExp(`const ${name} = .*?;`).exec(text);
	if (matched === null) throw new Error(`未找到 const ${name}`);
	return matched[0];
}

const connectionSource = readAsarEntry(asar, 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js');
const snippets = [
	extractConst(connectionSource, 'CHANNEL_PATTERN'),
	extractConst(connectionSource, 'ENDPOINT_SEGMENT_PATTERN'),
	extractFunction(connectionSource, 'endpointFromPath'),
	extractFunction(connectionSource, 'assertFetchRoute')
];

// 在隔离作用域里重建宿主的真实校验器。
const host = new Function(`${snippets.join('\n')}\nreturn { endpointFromPath, assertFetchRoute };`)();

const { HOST_ROUTES } = await import(new URL('../lib/contracts.js', import.meta.url).href);
const methods = { list: ['GET'], recycle: ['POST'], restore: ['POST'], purge: ['POST'] };

let failed = 0;
console.log(`宿主校验器来源：${asar} → dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`);
for (const [name, path] of Object.entries(HOST_ROUTES)) {
	const endpoint = host.endpointFromPath('/api', path);
	const problems = [];
	if (endpoint === undefined) problems.push('endpointFromPath 返回 undefined（path 必须 /api/ 开头且每段合法）');
	try {
		host.assertFetchRoute({ path, methods: methods[name] });
	} catch (error) {
		problems.push(`assertFetchRoute 抛错：${error.message}`);
	}
	if (problems.length === 0) console.log(`  PASS  ${name.padEnd(8)} ${path}  → endpoint "${endpoint}"`);
	else {
		failed += 1;
		console.log(`  FAIL  ${name.padEnd(8)} ${path}\n        ${problems.join('\n        ')}`);
	}
}
console.log(failed === 0 ? '结论：4 条路由全部通过运行中宿主的真实校验器' : `结论：${failed} 条未通过`);
process.exit(failed === 0 ? 0 : 1);
