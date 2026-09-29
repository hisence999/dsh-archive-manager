/**
 * T5 复核脚本汇总运行器。
 *
 * 用法：`node test/verify/run-all.mjs`（stdout 直接继承，不捕获子进程管道）
 * 退出码：任一脚本非 0 → 1。
 *
 * 刻意不用 `node --test`：这些是**复核脚本**（需要读取项目外的官方安装与 asar），
 * 不应混进 `pnpm test`（`test/**\/*.test.mjs`）的常规单元测试基线。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scripts = [
	['redline-scan.mjs', '红线：全仓无物理删除语义'],
	['bundle-whitelist.mjs', '客户端 bundle 信封 + require 白名单'],
	['platform-modules-check.mjs', 'PLATFORM_MODULES 基座表（asar vs npm 双源）'],
	['contract-consistency.mjs', '契约一致性：设置页 id/order、HOST_ROUTES、PLAN 漂移'],
	['host-contract.mjs', '宿主 4 路由运行时契约（400/409/200、磁盘零改动、ErrorResponse.code）'],
	['host-validator.mjs', '宿主真实校验器重建（抽取完整性 + 负控 + 正控）'],
	['client-grouping.mjs', 'T7 客户端分组运行时复核（映射/零命中隐藏/兜底不丢数据/跨组选择/原型键）'],
	['theme-tokens.mjs', '主题令牌存在性（对 asar 官方 419 个 --dsw-* 逐一比对）'],
	['facts-check.mjs', 'PLAN.md 引用行号与「无删除接口」的事实核验']
];

const summary = [];
for (const [file, label] of scripts) {
	console.log(`\n${'='.repeat(78)}\n## ${label}  (${file})\n${'='.repeat(78)}`);
	const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' });
	const code = result.status ?? 1;
	summary.push({ file, label, code });
}

console.log(`\n${'='.repeat(78)}\n## 汇总\n${'='.repeat(78)}`);
for (const { file, label, code } of summary) console.log(`${code === 0 ? 'PASS' : 'FAIL'} (exit ${code})  ${file}  — ${label}`);
const failed = summary.filter((s) => s.code !== 0);
console.log(failed.length === 0 ? '\n全部复核脚本通过。' : `\n${failed.length} 个复核脚本未通过：${failed.map((f) => f.file).join(', ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
