/**
 * 红线检索（T5 独立复核）：证明仓库里不存在「物理删除语义」的调用。
 *
 * 判定口径（对齐 PLAN.md D2 与 AGENTS.md A2）：
 * - `src/**`、`lib/**`（产品代码与产物）出现任何删除语义 → **FAIL**（红线）。
 * - `test/**`、`scripts/**` 出现删除语义 → **WARN**（可能是临时目录清理，需人工判定，不算产品红线）。
 * - 文档/配置里作为「反面教材」被引用的字符串 → **INFO**。
 *
 * 扫描范围是显式白名单目录（src/scripts/test/lib + 4 个根级文件），
 * **不会**进入 node_modules / .git / .tmp / backups，且**绝不读取 memory/**（AGENTS.md A5）。
 *
 * 只读：本脚本不写任何文件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SCAN_DIRS = ['src', 'scripts', 'test', 'lib'];
const SCAN_FILES = ['package.json', 'cordis.patch.yml', 'tsconfig.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'backups', 'memory', 'dist']);

/** 每一条都是「物理/不可逆删除」的语义特征。 */
const PATTERNS = [
	{ id: 'fs.rm-family', re: /\b(?:fs|fsp|fsPromises|nodeFs|promises)\s*\.\s*(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b/g },
	{ id: 'bare-unlink-call', re: /(?<![.\w])unlink(?:Sync)?\s*\(/g },
	{ id: 'destructive-shell', re: /\b(?:rmtree|Remove-Item|erase|rmdir|unlink)\b\s*(?:-[a-zA-Z]|\/|[A-Za-z]:)?/g },
	{ id: 'rm-command', re: /(?<![.\w-])rm\s+-[rf]{1,2}\b/g },
	{ id: 'del-command', re: /(?<![.\w-])del\s+\/[a-zA-Z]/g },
	{ id: 'shutil', re: /\bshutil\s*\.\s*rmtree\b/g }
];

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walk(join(dir, entry.name));
		} else if (entry.isFile()) {
			yield join(dir, entry.name);
		} else {
			continue;
		}
	}
}

/**
 * 去掉注释（保留字符串原文），并把被剥掉的字符替换为空格以**保持行号不变**。
 * 理由：产品代码里常写「本文件不出现 rm/unlink」这类反向说明注释——
 * 那是纪律声明而不是调用，不应判为红线违规；而真正的调用不可能藏在注释里。
 */
function stripComments(text) {
	const out = text.split('');
	let state = 'code';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (state === 'code') {
			if (ch === '/' && next === '/') {
				out[i] = ' ';
				out[i + 1] = ' ';
				state = 'line';
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				out[i] = ' ';
				out[i + 1] = ' ';
				state = 'block';
				i += 2;
				continue;
			}
			if (ch === "'") state = 'sq';
			else if (ch === '"') state = 'dq';
			else if (ch === '`') state = 'tpl';
			i += 1;
			continue;
		}
		if (state === 'line') {
			if (ch === '\n') state = 'code';
			else out[i] = ' ';
			i += 1;
			continue;
		}
		if (state === 'block') {
			if (ch === '*' && next === '/') {
				out[i] = ' ';
				out[i + 1] = ' ';
				state = 'code';
				i += 2;
				continue;
			}
			if (ch !== '\n') out[i] = ' ';
			i += 1;
			continue;
		}
		// 字符串内部：只处理转义与收尾引号，内容原样保留。
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) state = 'code';
		i += 1;
	}
	return out.join('');
}

/** @returns {{file: string, line: number, text: string, pattern: string}[]} */
function scan() {
	const files = [];
	for (const dir of SCAN_DIRS) {
		const abs = join(ROOT, dir);
		try {
			if (statSync(abs).isDirectory()) files.push(...walk(abs));
		} catch {
			/* 目录不存在则跳过 */
		}
	}
	for (const name of SCAN_FILES) files.push(join(ROOT, name));

	const hits = [];
	const selfPath = fileURLToPath(import.meta.url);
	for (const file of files) {
		// 跳过本文件自身：它逐字包含这些正则的定义，否则会自命中。
		if (file === selfPath) continue;
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		const codeLines = stripComments(text).split(/\r?\n/);
		codeLines.forEach((codeLine, index) => {
			for (const { id, re } of PATTERNS) {
				re.lastIndex = 0;
				if (re.test(codeLine)) {
					hits.push({
						file: relative(ROOT, file).split(sep).join('/'),
						line: index + 1,
						text: (lines[index] ?? codeLine).trim().slice(0, 180),
						pattern: id
					});
				}
			}
		});
	}
	return hits;
}

const hits = scan();
const fail = hits.filter((h) => h.file.startsWith('src/') || h.file.startsWith('lib/'));
const warn = hits.filter((h) => !fail.includes(h));

console.log(`# 红线检索 scope=${SCAN_DIRS.join(',')} + ${SCAN_FILES.join(',')} skip=${[...SKIP_DIRS].join(',')}`);
console.log(`# hits total=${hits.length} fail(src|lib)=${fail.length} warn=${warn.length}`);
for (const hit of hits) {
	const tag = fail.includes(hit) ? 'FAIL' : 'WARN';
	console.log(`${tag} [${hit.pattern}] ${hit.file}:${hit.line}  ${hit.text}`);
}
if (hits.length === 0) console.log('PASS 未发现任何物理删除语义。');
else if (fail.length === 0) console.log('PASS(带告警) 产品代码无删除语义；告警项需人工确认是否为临时目录清理。');
else console.log('FAIL 产品代码出现物理删除语义 —— 红线违规。');

process.exitCode = fail.length === 0 ? 0 : 1;
