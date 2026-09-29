/**
 * 主题令牌存在性复核（T5）——补 `test/style.test.mjs` 的盲点。
 *
 * `test/style.test.mjs` 只断言"用了 `--dsw-*` 族"，**不校验令牌名是否真的存在**：
 * 把 `--dsw-alias-bg-layer-2` 拼错成 `--dsw-alias-bg-layr-2` 时，
 * 该守卫仍然全绿，而浏览器只是**静默不生效**（正是 style.test.mjs 自己说要拦的"静默失效"）。
 *
 * 本脚本独立地从**运行中的 0.2.0-rc.1 asar** 抽取官方 CSS 里真实出现过的 `--dsw-*` 令牌集合，
 * 再与插件源码实际使用的令牌逐一比对：
 * - 插件用到但官方集合里没有 → **FAIL**（拼写错误 / 令牌已下线）；
 * - 插件用了 `--dsw-*` 之外的 CSS 变量 → **FAIL**（族外令牌）。
 *
 * 只读；不写任何文件。
 * 用法：node test/verify/theme-tokens.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLIENT_DIR = join(ROOT, 'src', 'client');
const ASAR = process.env.VERIFY_ASAR ?? 'E:/DSH/resources/app.asar';

const failures = [];
const notes = [];

if (!existsSync(ASAR)) {
	console.error(`未覆盖：找不到运行中 asar（${ASAR}）——本脚本必须对 0.2.0-rc.1 取证，拒绝改用 npm 参照版`);
	process.exit(2);
}

const official = new Set(readFileSync(ASAR).toString('latin1').match(/--dsw-[a-z0-9-]+/g) ?? []);
notes.push(`官方 CSS 中的 --dsw-* 令牌（0.2.0-rc.1 asar）= ${official.size} 个`);

const files = readdirSync(CLIENT_DIR, { withFileTypes: true })
	.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
	.map((entry) => entry.name);
notes.push(`扫描客户端源码 ${files.length} 个文件：${files.join(', ')}`);

const used = new Map(); // token -> 出现文件集合
const foreign = []; // 非 --dsw-* 的 CSS 变量
for (const name of files) {
	const text = readFileSync(join(CLIENT_DIR, name), 'utf8');
	for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
		const token = match[1];
		if (!token.startsWith('--dsw-')) {
			foreign.push(`${name}: ${token}`);
			continue;
		}
		if (!used.has(token)) used.set(token, new Set());
		used.get(token).add(name);
	}
}

const unknown = [...used.keys()].filter((token) => !official.has(token));
notes.push(`插件实际使用 --dsw-* 令牌 = ${used.size} 个（去重）`);
if (foreign.length > 0) failures.push(`使用了 --dsw-* 之外的 CSS 变量：\n  ${foreign.join('\n  ')}`);
if (unknown.length > 0) {
	failures.push(
		`以下令牌在运行中 0.2.0-rc.1 的官方 CSS 里不存在（拼写错误或已下线，浏览器会静默失效）：\n  ${unknown.join('\n  ')}`
	);
} else {
	notes.push('PASS 全部令牌都能在官方 CSS 里找到实体（无拼写错误）');
}

for (const note of notes) console.log(`# ${note}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length === 0 ? '\nPASS theme-tokens' : `\nFAIL theme-tokens（${failures.length} 项）`);
process.exitCode = failures.length === 0 ? 0 : 1;
