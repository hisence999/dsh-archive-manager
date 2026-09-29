/**
 * 样式守卫：客户端源码必须只用官方主题令牌，不得硬编码配色。
 *
 * 依据（需求 3「整体设计风格参考现有 DSH 的极简设计」）：
 * - 本机 0.2.0-rc.1 的令牌族是 `--dsw-*`。**已验证**：我们使用的 20 个令牌全部被
 *   运行中 asar（`E:\DSH\resources\app.asar`）内的官方 CSS 真实使用（官方 CSS 中
 *   共出现 94 个 `--dsw-*` 令牌）；抽取命令见 PLAN §10.5。
 * - 硬编码配色的后果是深浅色/换肤时该处不跟随，而且不会报错 —— 属于"静默失效"，
 *   只能靠静态守卫拦。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const clientDirectory = new URL('../src/client/', import.meta.url);

/** 读出客户端半侧全部源码文件。 */
async function clientSources() {
	const directory = new URL('../src/client/', import.meta.url);
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!/\.tsx?$/.test(entry.name)) continue;
		found.push({ name: entry.name, text: await readFile(new URL(entry.name, clientDirectory), 'utf8') });
	}
	return found;
}

test('客户端源码不含硬编码配色', async () => {
	const sources = await clientSources();
	assert.ok(sources.length > 0, '必须找到客户端源码');
	const offenders = [];
	for (const source of sources) {
		// 十六进制颜色字面量（#rgb / #rrggbb / #rrggbbaa）。
		for (const match of source.text.matchAll(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
			offenders.push(`${source.name}: 十六进制色值 ${match[0]}`);
		}
		// 函数式颜色（rgb/rgba/hsl/hsla）。
		for (const match of source.text.matchAll(/\b(?:rgba?|hsla?)\s*\(/g)) {
			offenders.push(`${source.name}: 颜色函数 ${match[0].trim()}`);
		}
	}
	assert.deepEqual(offenders, [], `禁止硬编码配色，请改用主题令牌：\n${offenders.join('\n')}`);
});

test('客户端源码只用 --dsw-* 令牌族', async () => {
	const sources = await clientSources();
	const families = new Set();
	let tokenUses = 0;
	for (const source of sources) {
		for (const match of source.text.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
			tokenUses += 1;
			const name = match[1];
			families.add(name.startsWith('--dsw-') ? '--dsw-*' : name);
		}
	}
	assert.ok(tokenUses > 0, '必须使用主题令牌');
	assert.deepEqual([...families], ['--dsw-*'], `只允许 --dsw-* 令牌族，发现：${[...families].join(', ')}`);
});

/** 从运行中 asar 抽出全部 CSS 文本（找不到 asar 时返回 undefined）。 */
function hostCss() {
	const asar = process.env.DSH_ASAR ?? 'E:\\DSH\\resources\\app.asar';
	if (!fs.existsSync(asar)) return undefined;
	const fd = fs.openSync(asar, 'r');
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

		const chunks = [];
		(function walk(node, prefix) {
			for (const [name, entry] of Object.entries(node.files || {})) {
				const path = prefix + '/' + name;
				if (entry.files) {
					walk(entry, path);
					continue;
				}
				// 令牌来源不止独立 `.css`：asar 里还有一批把 CSS 内嵌成 JS 模块的条目
				// （形如 `\0dsh-css:…module.css.mjs`），只扫 `.css` 会漏掉一部分合法令牌
				// （实测：仅 .css 得 393 个，含 css.mjs 后与 verifier 全量扫描的 419 个口径一致）。
				const lower = path.toLowerCase();
				if (!lower.endsWith('.css') && !lower.endsWith('.css.mjs')) continue;
				// asar 中 unpacked（存于 app.asar.unpacked）的条目不在此文件内，也没有 offset。
				if (entry.unpacked === true || !Number.isFinite(Number(entry.offset))) continue;
				const buf = Buffer.alloc(entry.size);
				fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
				chunks.push(buf.toString('utf8'));
			}
		})(header, '');
		return chunks.join('\n');
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * 令牌**存在性**守卫。
 *
 * 为什么需要：上一条只校验 `--dsw-*` 族名，把 `--dsw-alias-bg-layer-2` 拼错成别的名字
 * 仍然全绿 —— 而浏览器只是**静默不生效**（没有报错、没有兜底样式）。
 * verifier 的 `test/verify/theme-tokens.mjs` 也做了同一件事（官方 419 个 vs 插件 18 个，0 个不存在）；
 * 这里把它并入项目自带守卫，使其不依赖 verifier 的脚本也能拦住。
 * 找不到运行中 asar 时跳过（其他机器上不阻塞）。
 */
test('用到的每个 --dsw-* 令牌都存在于运行中宿主的官方 CSS', async (context) => {
	const css = hostCss();
	if (css === undefined) {
		context.skip('未找到运行中 asar（可用 DSH_ASAR 指定），跳过令牌存在性校验');
		return;
	}
	const official = new Set();
	for (const match of css.matchAll(/--dsw-[a-z0-9-]+/g)) official.add(match[0]);
	assert.ok(official.size > 100, `官方 CSS 中的令牌数量异常偏少（${official.size}），抽取可能失败`);

	const sources = await clientSources();
	const used = new Set();
	for (const source of sources) {
		for (const match of source.text.matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(match[1]);
	}
	const missing = [...used].filter((token) => !official.has(token));
	assert.deepEqual(missing, [], `以下令牌在官方 CSS 中不存在（拼写错误会静默失效）：\n${missing.join('\n')}`);
	assert.ok(used.size > 0, '必须使用主题令牌');
});
