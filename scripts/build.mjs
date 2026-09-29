/**
 * 统一从 src 生成可安装的 lib（宿主 ESM 产物 + 浏览器 bundle）。
 *
 * 刻意不做物理删除：只覆盖写入 lib 下当前源文件对应的产物。
 * 若源文件被删除，其 lib 对应物会残留 —— 由 `--check-stale` 只报告、不删除。
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(root, 'src');
const outputDirectory = join(root, 'lib');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const checkStaleOnly = process.argv.includes('--check-stale');

/** 浏览器 bundle 必须保持 external 的运行时提供方。 */
const CLIENT_EXTERNAL = [
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/*'
];

/** 把 bundle 体缩进进 factory 信封。 */
function indent(text, spaces = 4) {
	const pad = ' '.repeat(spaces);
	return text.split('\n').map((line) => (line.length === 0 ? line : pad + line)).join('\n');
}

async function listSourceFiles(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await listSourceFiles(full));
		// 环境声明（*.d.ts）不是可执行模块，不能被当作入口。
		else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
	}
	return found;
}

/** 宿主半侧入口 = src 下除 client/ 之外的全部源文件（保留相对导入，逐文件转译）。 */
async function hostEntryPoints() {
	const files = await listSourceFiles(sourceDirectory);
	return files.filter((file) => !file.startsWith(join(sourceDirectory, 'client') + sep));
}

if (checkStaleOnly) {
	const sources = new Set((await listSourceFiles(sourceDirectory)).map((file) => relative(sourceDirectory, file).replace(/\.tsx?$/, '.js')));
	const produced = await listSourceFiles(outputDirectory).catch(() => []);
	const stale = produced.map((file) => relative(outputDirectory, file)).filter((file) => !sources.has(file) && file !== 'client.js');
	for (const file of stale) console.warn(`[dsh-archive-manager] lib 中的残留产物（未自动删除）: ${file}`);
	console.log(`[dsh-archive-manager] --check-stale 完成：${stale.length} 个残留`);
	process.exit(0);
}

await mkdir(outputDirectory, { recursive: true });

// 1) 宿主半侧：逐文件转译成 ESM，保留相对导入（与 package.json exports 的 .js 说明符一致）。
await build({
	entryPoints: await hostEntryPoints(),
	outdir: outputDirectory,
	outbase: sourceDirectory,
	bundle: false,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	logLevel: 'warning'
});

// 2) 浏览器半侧：打成单个 CJS 工厂体，再套 `window.__ModuleLoader__.load` 信封。
const client = await build({
	entryPoints: [join(sourceDirectory, 'client', 'index.ts')],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'browser',
	target: 'es2022',
	minify: true,
	keepNames: true,
	legalComments: 'none',
	define: { 'process.env.NODE_ENV': '"production"' },
	external: CLIENT_EXTERNAL,
	logLevel: 'warning'
});

const bundleBody = client.outputFiles[0].text;
const envelope = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
${indent(bundleBody)}
    return module.exports;
  }
});
`;
await writeFile(join(outputDirectory, 'client.js'), envelope, 'utf8');

console.log(`[dsh-archive-manager] 已生成宿主入口 lib/index.js 与客户端 bundle lib/client.js（${envelope.length} 字节）`);
