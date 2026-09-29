/**
 * app.asar 只读字节探针（独立复核工具，T5）。
 *
 * 为什么需要它：运行中的 GUI 是**桌面端内置的 0.2.0-rc.1**，其代码打包在
 * `E:\DSH\resources\app.asar` 里，无法用普通编辑器打开，也无法 `glob` 进去。
 * asar 是「JSON 头 + 逐文件原样拼接」的容器，正文未压缩，因此可以按
 * latin1 读入整块后做 `indexOf` 定位，只打印针（needle）附近的小窗口，
 * 避免把压缩成单行的巨型 bundle 整行吐进终端。
 *
 * 只读：不写任何文件，不修改任何东西。
 *
 * 用法：
 *   node test/verify/tools/asar-probe.mjs [asar路径] <needle> [before] [after] [maxMatches]
 * 默认 asar 路径 = E:/DSH/resources/app.asar
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const asarPath = argv[0] && argv[0].endsWith('.asar') ? argv.shift() : 'E:/DSH/resources/app.asar';
const needle = argv[0];
if (needle === undefined) {
	console.error('用法: node test/verify/tools/asar-probe.mjs [asar路径] <needle> [before] [after] [maxMatches]');
	process.exit(2);
}
const before = Number(argv[1] ?? 120);
const after = Number(argv[2] ?? 400);
const maxMatches = Number(argv[3] ?? 3);
const capPerMatch = 1600;

const source = readFileSync(asarPath).toString('latin1');
console.log(`# asar=${asarPath} bytes=${source.length} needle=${JSON.stringify(needle)}`);

let index = -1;
let hits = 0;
for (;;) {
	index = source.indexOf(needle, index + 1);
	if (index < 0) break;
	hits += 1;
	const start = Math.max(0, index - before);
	const end = Math.min(source.length, index + after);
	const window = source.slice(start, end);
	console.log(`\n=== hit ${hits} @byte ${index} (window ${start}..${end}) ===`);
	console.log(window.length > capPerMatch ? `${window.slice(0, capPerMatch)}\n...<truncated, window=${window.length}>` : window);
	if (hits >= maxMatches) {
		console.log(`\n(已到 maxMatches=${maxMatches}，可能还有更多命中)`);
		break;
	}
}
if (hits === 0) console.log('\nNOT FOUND');
