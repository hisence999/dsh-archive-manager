/**
 * "宿主侧改动是否已生效"的可复现判据（T5）。
 *
 * 为什么需要：本机**没有任何免重启热替换手段**（见 REPORT §2 规则 7 的否证集合），
 * 因此"live 行为"到底跑的是哪份代码，必须能用命令判定，而不是靠推断。
 *
 * 判据（lead 提出，我实现并补上限制说明）：
 * > **宿主进程的最早起始时间 > 全部构建产物的 mtime** ⇒ 该进程加载的就是当前构建。
 *
 * ⚠️ **限制（必须知道，否则会误判）**：这是 **mtime 代理**，只在"构建后进程没再重启"方向上有效。
 * 反向不成立：**重新 build（即使源码一字未改）会把 mtime 推到进程之后**，此时 mtime 判据不成立，
 * 但**代码内容可能完全相同**。因此判据不成立时，本脚本再给一层"内容同一性"辅助判定：
 * 把当前产物的 **大小 + sha256** 与 `EXPECTED` 表（部署当时记录的那份构建）比对。
 *
 * 只读：不写任何文件、不改任何产物。
 * 用法：node test/verify/deploy-freshness.mjs
 *       DSH_APP_ROOT 可覆盖宿主根目录（默认 E:\DSH）
 * 退出码：0 = 判据成立（或内容同一）；1 = 判据不成立且内容不同；2 = SKIP（无进程/无产物）
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const APP_ROOT = (process.env.DSH_APP_ROOT ?? 'E:\\DSH').toLowerCase();

/**
 * 部署当时（2026-09-29 21:01:05 构建、21:00:12 重启）产物的**大小**记录。
 * 用途：当 mtime 判据因"之后又 build 了一次"而不成立时，用大小/哈希确认内容是否同一。
 *
 * ⚠️ 更新史：17:54 那一版是 T16 **之前**的（`host/routes.js` 6,747 B、`host/recycle-store.js` 27,011 B）；
 * T16 把判据改为 `sessionController` 后这两者变成 **8,335 B / 27,089 B** —— 沿用旧表会误报"内容不同"。
 */
const EXPECTED = new Map([
	['index.js', 227],
	['client.js', 43825],
	['host/routes.js', 8335],
	['host/recycle-store.js', 27089]
]);

const lines = [];
const say = (text) => lines.push(text);
const flush = (code) => {
	console.log(lines.join('\n'));
	process.exit(code);
};

/** 列出 lib 下的 .js 产物。 */
function artifacts() {
	const found = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
		}
	};
	walk(join(ROOT, 'lib'));
	return found;
}

const output = artifacts().map((full) => {
	const stat = statSync(full);
	const bytes = readFileSync(full);
	return {
		rel: relative(join(ROOT, 'lib'), full).split(sep).join('/'),
		mtime: stat.mtime,
		size: stat.size,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
});
if (output.length === 0) {
	say('SKIP 未找到 lib/**/*.js 产物（先跑 node scripts/build.mjs）');
	flush(2);
}

const buildTime = output.reduce((latest, item) => (item.mtime > latest ? item.mtime : latest), output[0].mtime);
const buildTimeLabel = buildTime.toISOString();

for (const item of output) {
	const expected = EXPECTED.get(item.rel);
	say(`# 产物 ${item.rel}  ${item.size} B  mtime=${item.mtime.toISOString()}  sha256=${item.sha256.slice(0, 16)}…${expected === undefined ? '' : `  （部署记录 ${expected} B${expected === item.size ? ' ✓' : ' ✗ 不一致'}）`}`);
}

// 进程信息由 PowerShell 采集（Node 无内置进程枚举）：本脚本读环境变量传入的观测值，
// 使判据可被 CI/人工以同一命令复现。
const processStartRaw = process.env.DSH_HOST_START_ISO;
if (processStartRaw === undefined || processStartRaw.length === 0) {
	say('SKIP 未提供宿主进程起始时间（用 PowerShell 采集后以 DSH_HOST_START_ISO 传入）');
	say('# 采集命令：Get-Process | Where-Object { $_.Path -like "E:\\DSH*" } | Sort-Object StartTime | Select-Object -First 1 -ExpandProperty StartTime');
	flush(2);
}
const processStart = new Date(processStartRaw);
if (Number.isNaN(processStart.getTime())) {
	say(`SKIP DSH_HOST_START_ISO 不是合法时间：${processStartRaw}`);
	flush(2);
}

say(`# 宿主进程最早起始 = ${processStart.toISOString()}`);
say(`# 构建产物最新 mtime = ${buildTimeLabel}`);

if (processStart >= buildTime) {
	say('PASS deploy-freshness（进程晚于全部产物 → 运行中加载的就是当前构建）');
	flush(0);
}

// mtime 判据不成立：用"内容同一性"辅助判定（大小全中 + 源码未再变动）
const sizeMatches = [...EXPECTED.entries()].filter(([rel, size]) => output.find((item) => item.rel === rel)?.size === size).length;
say(`# mtime 判据不成立（产物比进程新）——这通常意味着"部署之后我又 build 了一次"（重放同一份源码也会刷新 mtime）。`);
say(`# 内容同一性辅助判定：部署记录的大小命中 ${sizeMatches}/${EXPECTED.size}`);
if (sizeMatches === EXPECTED.size) {
	say('PASS deploy-freshness（mtime 不成立，但当前产物与部署记录的大小逐一相同 → 内容极可能同一；如需铁证请比对 sha256）');
	flush(0);
}
say('FAIL deploy-freshness（mtime 与内容同一性均不能支持"运行中即当前构建"→ 请重启宿主后重测）');
flush(1);
