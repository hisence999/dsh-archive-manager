/**
 * 只读 asar 巡检工具（开发用）。
 *
 * 为什么需要它：运行中的 GUI 是**桌面端内置**的 0.2.0-rc.1，其源码只存在于
 * `E:\DSH\resources\app.asar`（asar 归档），npm 上拿不到同版本源码；而判断"运行中宿主
 * 到底怎么写"必须以它为准（见 PLAN §2.1 的版本纪律）。
 *
 * 用法：
 *   node scripts/asar-read.mjs <asar 路径> find <路径子串>        # 列出匹配文件与大小
 *   node scripts/asar-read.mjs <asar 路径> cat  <路径子串>        # 打印匹配的文本文件（>200KB 跳过）
 *   node scripts/asar-read.mjs <asar 路径> css  <路径子串>        # 只打印匹配的 .css（用于主题令牌核对）
 *
 * 例（核对主题令牌）：
 *   node scripts/asar-read.mjs "E:\DSH\resources\app.asar" css ".css" > all-css.txt
 *
 * 只读：不会写入或修改 asar。
 * 注意：asar 中 `unpacked: true` 的条目（正文实际存放在 `app.asar.unpacked`）没有 `offset`，
 * 会被跳过并在 `cat` 模式下标注；早期版本直接读取它们会抛 `RangeError` 并**静默截断**输出
 * —— 这正是"取不到证据被当成没有证据"的典型坑，现已修正。
 */
import fs from "node:fs";

const asar = process.argv[2];
const mode = process.argv[3] || "find";
const needle = process.argv[4] || "";

if (asar === undefined || !fs.existsSync(asar)) {
	console.error("用法: node scripts/asar-read.mjs <asar 路径> <find|cat|css> <路径子串>");
	process.exit(2);
}

const fd = fs.openSync(asar, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const headerStrSize = head.readUInt32LE(8);
const headerBuf = Buffer.alloc(headerStrSize);
fs.readSync(fd, headerBuf, 0, headerStrSize, 16);
const headerText = headerBuf.toString("utf8");
const header = JSON.parse(headerText.slice(0, headerText.lastIndexOf("}") + 1));
const dataOffset = 8 + headerSize;

const files = [];
(function walk(node, prefix) {
	for (const [name, entry] of Object.entries(node.files || {})) {
		const path = prefix + "/" + name;
		if (entry.files) walk(entry, path);
		else files.push({ path, offset: Number(entry.offset), size: entry.size });
	}
})(header, "");

/** 打印一个条目的正文。 */
function emit(entry, printHeader) {
	// asar 中 `unpacked: true` 的条目实际存放在 app.asar.unpacked，本文件内没有 offset。
	if (entry.unpacked === true || !Number.isFinite(Number(entry.offset))) throw new RangeError(`${entry.path} 是 unpacked 条目，无 offset`);
	const buf = Buffer.alloc(entry.size);
	fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
	if (printHeader) console.log(`\n/* ===== ${entry.path} (${entry.size} bytes) ===== */\n`);
	console.log(buf.toString("utf8"));
}

/** 条目正文是否可读（排除 unpacked 与 offset 异常者）。 */
function readable(entry) {
	return entry.unpacked !== true && Number.isFinite(Number(entry.offset));
}

const key = needle.toLowerCase();
if (mode === "find") {
	const hits = files.filter((file) => file.path.toLowerCase().includes(key));
	for (const hit of hits) console.log(hit.size.toString().padStart(8), hit.path);
	console.log("total files:", files.length, "hits:", hits.length);
} else if (mode === "cat") {
	for (const hit of files.filter((file) => file.path.toLowerCase().includes(key))) {
		if (!readable(hit)) {
			console.log(`\n===== ${hit.path} (unpacked，正文在 app.asar.unpacked) =====\n`);
			continue;
		}
		if (hit.size > 200000) {
			console.log(`\n===== ${hit.path} (${hit.size} bytes, skipped) =====\n`);
			continue;
		}
		emit(hit, true);
	}
} else if (mode === "css") {
	const hits = files.filter((file) => file.path.toLowerCase().includes(key) && file.path.toLowerCase().endsWith(".css"));
	for (const hit of hits) if (readable(hit)) emit(hit, true);
	console.log(`/* css files: ${hits.length} */`);
} else {
	console.error(`未知模式: ${mode}`);
	process.exit(2);
}
fs.closeSync(fd);
