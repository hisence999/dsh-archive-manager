# dsh-archive-manager

在 DSH 的设置面板里**可视化管理已归档会话**：按工作区分组查看、搜索、排序、批量**恢复**，以及把不再需要的归档会话**移入回收站**（可还原，全程不做不可逆删除）。

> 目标运行时：**DSH 桌面端 0.2.0-rc.1**（desktop profile）—— npm 上该版本在 `next` 标签下，`latest` 仍是 0.1.7-rc.2。
> 其他 DSH 版本未纳入验证范围。

---

## 功能

| 你想做什么 | 在哪里 |
| --- | --- |
| 看有哪些已归档会话 | 设置 → 已归档会话 |
| 按工作区查看 | 列表默认按**工作区/项目分组**，组头可折叠 |
| 恢复一条 / 一组 / 一批 | 行内「恢复」图标按钮（悬停有 Tooltip）/ 组头「全部恢复」/ 勾选后底部批量条 |
| 删除（移入回收站） | 行内「移入回收站」图标按钮（**红字、无描边**）→ 官方 `Modal` 二次确认 |
| 搜索与排序 | 顶部搜索框 + 排序下拉（搜索/排序在**组内**生效，零命中的组整组隐藏） |
| 还原误删 | 「回收站」页签 → 行内「还原」 |
| 彻底让出磁盘 | 「回收站」页签 → 「清空回收站」（`RiskConfirmation` 勾选确认）：**载荷**移交到冷存档区，台账保留 |
| 控件与 DSH 同源 | 全部使用官方 UI 原子件（`Button`/`Input`/`Checkbox`/`Pill`/`Modal`/`RiskConfirmation`/`SegmentedTabs`/`PathLabel`/`Tag`/`Tooltip` + 官方图标集与 `relativeTime()`/`fileSizeText()`），行节奏对齐「通用设置」页 |

### 删除的语义：移入回收站，不抹除

- 「删除」= 把整个会话目录**移动**到 `$DSH_HOME\archive-manager\recycle\<entryId>\`，
  并写入 `manifest.json`（原始路径、`cwd`、字节数、移动时间）；`<entryId>` 形如 `<movedAtMs>@<sessionId>`。
- 「还原」= 按清单移回原路径；原路径越界、父目录不存在、目标已存在都会**拒绝**而不是猜。
- 「清空回收站」= 勾选确认后把**载荷**（`<entryId>/session/`）移交到
  `$DSH_HOME\archive-manager\purged\<批次>\<entryId>\`（冷存档，可人工找回），
  而**台账 `manifest.json` 留在回收站原地**并写入 `purgedAt`/`purgedBatch`。
  保留台账是**有意设计**：客户端据此把已处理的 id 从「已归档」列表**持续过滤**（否则刷新后会出现幽灵行，
  因为官方 `archivedSessionIds` 不会被本插件修改）。清空后条目**不可还原**（`entry-purged`），
  但记录仍显示在回收站页签，标记为「已在冷存档区」。
- **本插件不提供不可逆的物理删除**：全流程只有 `readdir/lstat/mkdir/readFile/writeFile/rename`。
- ⚠️ `$DSH_HOME\archive-manager\`（回收站 + 冷存档）是「哪些会话已被处理」的**索引**：**请勿手工删改**其中的
  `manifest.json`。索引一旦丢失，插件就无从得知该会话已被移走，它会以「摘要缺失」的行重新出现在已归档列表里
  —— 这是"绝不物理删除"的必然代价（官方 `archivedSessionIds` 不会被本插件修改，过滤只能靠这份索引）。
- 索引是**可从磁盘重建**的：`list()` 同时扫回收站与冷存档两处台账，并可按 `purged/<批次>/batch.json`
  乃至 `<entryId>` 目录名推导状态 —— 因此**即使条目已被清空、或旧版本曾把台账随载荷一起搬走**，它仍会被正确上报。
  不变式：*任何时候，只要某会话的工件被本插件从 `sessions/` 移走过，`list()` 就必须能上报它。*

### 验收判据（A5：删除后不得出现"坏行"）

```
幽灵行 = { id ∈ workspace.json 的 archivedSessionIds ：
           该 id 的工件不在 $DSH_HOME/sessions/<slug>/ 下  且  该 id 未被 /api/dsh-archive-manager/list 上报 }
必须为 0
```

⚠️ 注意：**"摘要缺失"不是坏行** —— 真实会话也可能没有摘要（本机就有两条工件完好但无摘要的归档会话）。
只有"**工件已被移走 ∧ 未被上报**"同时成立才是幽灵行。只读复现：`node test/verify/ghost-row-check.mjs`。

会话目录与 `$DSH_HOME\sessions\` 物理隔离，DSH 的会话扫描永远不会碰到它。

---

## 安装

前置：DSH 桌面端可正常使用，`$DSH_HOME` 为 `D:\DSH\dsh-home`（其他机器请替换）。

```powershell
# 1) 构建（产出 lib/index.js 与 lib/client.js）
Set-Location D:\DSH-PLUGIN\dsh-archive-manager
node scripts\build.mjs
```

**2) 安装（推荐：用 DSH 自带的插件管理器）**

在 Agent 会话里执行等价的插件管理器调用
`plugin_manager install_bundle target=link:D:/DSH-PLUGIN/dsh-archive-manager`，
它会自动完成 profile 的 `link:` 依赖、`dsh.profile.bundles` 登记与 `pnpm install`。

手动等价做法（与本机既有本地插件 `dsh-memory` 同款）：
```jsonc
// D:\DSH\dsh-home\profiles\desktop\package.json
"dependencies":     { "dsh-archive-manager": "link:D:/DSH-PLUGIN/dsh-archive-manager", ... },
"dsh": { "profile": { "bundles": [ ..., "dsh-archive-manager" ] } }
```
```powershell
Set-Location D:\DSH\dsh-home\profiles\desktop
pnpm install
```

**3) 重启 DSH 桌面端**，然后 `Ctrl+Shift+R` 硬刷新页面。

> 为什么必须重启：DSH 进程会缓存已加载的插件模块，**新装的插件（或激活失败过的插件）换不掉旧模块实例**。
> 热补丁（`patchReload: live`）只协调配置补丁层，不替换已导入的模块。

---

## 架构（为什么不照抄现成的社区插件）

任务开始时有一份可参考的实现 `@michengai/dsh-archive-manager`。本项目在关键处**刻意采用不同做法**：

| 社区实现 | 本项目 | 原因 |
| --- | --- | --- |
| `rm -rf` 会话目录与 spill 目录 | 整体**移动**到回收站，可还原 | 不可逆删除无法挽回；遵循「删除即移入回收站」 |
| 禁用官方 `workspace` / `session-projection-cache`，插入自写子类并调用父类私有成员 | **一行官方服务都不动**，只注册自己的端点 | 依赖私有成员的实现会随宿主升级而崩；不接管索引也就不需要墓碑机制 |
| 自带 Typert 调用描述符 + 私有 HTTP 端点 | 官方 `ctx.connection.fetch.register(...)` | 官方定义就是「Host 功能拥有的 `/api` 精确路由」，**鉴权由官方通道完成** |

```
设置页（客户端半侧）
  ├── 数据源：官方 WorkspaceSnapshot（archivedSessionIds + items 用于工作区分组）
  ├── 恢复：ctx.workspaces.unarchiveSession(id)          ← 官方接口
  └── 删除/还原/清空：/api/dsh-archive-manager/*         ← 本插件宿主半侧

宿主半侧
  └── 4 条官方鉴权路由（ctx.connection.fetch.register）
       └── 回收站：$DSH_HOME\archive-manager\recycle\<entryId>\ + manifest.json
```

宿主端的**安全边界**（均有反例测试）：id 按**安全字符集 + 有界长度**校验
（`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` —— 不含路径分隔符、无 `..` 穿越）；
⚠️ DSH 的会话 id 有**两种真实形态**：裸 UUID（`8402fa9c-…`）与 **`session-` 前缀 UUID**（`session-0b9de1ba-…`），
**不能假设只有 UUID** —— 真机删除曾因此被本插件自己的校验器拒绝（详见 PLAN §10.10）；
`entryId` 必须先解析再在回收站内
`readdir` 精确匹配（不拼路径）；源目录必须是普通目录（**拒符号链接**）；还原目标必须落在
`$DSH_HOME\sessions` 之下且恰好两层；运行中的会话、未归档的会话一律**整批拒绝**；
`workspaceRegistry` / `sessions` 服务不可用时 **fail-closed**（500 并点名服务），绝不静默放行。

---

## 开发

```powershell
$node = 'D:\DSH\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node node_modules\typescript\bin\tsc --noEmit      # 类型检查
& $node --test "test/**/*.test.mjs"                   # 测试（当前 69 项）
& $node scripts\build.mjs                             # 构建
```

### 目录

| 路径 | 作用 |
| --- | --- |
| `src/contracts.ts` | **冻结的契约**：端点路径、条目结构、稳定错误码、校验与路径推导（纯函数，两半共享） |
| `src/index.ts` | 宿主入口，只注入官方 `connection` 服务 |
| `src/host/routes.ts` | 4 个端点的注册、HTTP 语义、fail-closed 守卫 |
| `src/host/recycle-store.ts` | 回收站存储层：移动 / 还原 / 清单 / 清空（零物理删除） |
| `src/client/**` | 设置页、分组、词典、数据钩子 |
| `src/dsh.d.ts`、`src/dsh.host.d.ts`、`src/dsh.client.d.ts` | 手写 DSH 环境声明，每条附证据来源 |
| `scripts/build.mjs` | 宿主逐文件转译 ESM + 客户端 esbuild 打包并套 `window.__ModuleLoader__.load` 信封 |

### 客户端半侧的硬规则

DSH 客户端模块系统有一张**冻结的静态基座表**，以下模块无需声明即可 `require`：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

- 基座之外的运行时依赖必须写进 `package.json` 的 **`dsh.client.external`**；
  `dsh.client.inject` 按官方 manifest 只是**信息性**字段，不参与模块解析。
- **类型专用导入必须写 `import type`** —— 否则会被打进 bundle 并在运行时解析失败。
- 颜色只用 `--dsw-*` 主题令牌，禁止硬编码配色。

以上三条分别由 `test/build.test.mjs` 与 `test/style.test.mjs` 自动拦截。

### 验证资产

| 文件 | 作用 |
| --- | --- |
| `test/build.test.mjs` | bundle 信封与导出、require 白名单、**路由必须满足官方 exact Fetch route 规则** |
| `test/contracts.test.mjs` | 契约回归：两种**真实** id 形态（裸 UUID / `session-<uuid>`）、危险字符负控、`entryId` 往返；并**直接读本机真实 `workspace.json`** 逐条校验归档 id 与工作区记账 id（缺文件则 skip） |
| `test/client-render.test.mjs` | 服务端渲染冒烟（10 条）：注册参数、中文词典兜底、空态、读取中、摘要缺失、数据源缺失、工作区分组、兜底组、**组内行不重复显示目录**、**兜底组保留目录**（后两条对官方 `PathLabel` 的文本拆分也稳健）。官方 primitives 走 **SSR 桩**：签名逐条对过 `lib/types/*.d.ts`，且**校验必需 props、实现 `RiskConfirmation` 的勾选门控、未知导出直接报"桩缺少导出 X"**——比真实组件更严格，避免假绿 |
| `test/style.test.mjs` | 禁止硬编码配色；只允许 `--dsw-*` 令牌族；并逐一对运行中 asar 的官方 CSS 校验**每个令牌真实存在**（拼错会静默失效） |
| `test/host.test.mjs` | 回收站存储层 **31** 用例（路径安全反例、逐条失败码、**清空=移交载荷+保留台账**、**台账可从磁盘重建**（旧布局/P19 形态/两处去重）、purge 幂等、`entry-purged`、删除语义静态守卫） |
| `test/client.test.mjs` | 客户端纯函数 **51** 用例（分组映射、就绪判定、筛选排序、选择归一化、回收站条目归一化、`restoreGuard` 双重拦截、**清空后刷新仍无幽灵行**、中英词典） |
| `test/verify/**` | 独立只读复核：红线扫描、基座表双源解析、契约一致性、PLAN 事实重放、宿主路由真跑；外加两个**验收脚本**（依赖 live 盘状态、不进 `run-all`）：`ghost-row-check.mjs`（A5 判据）、`a5-invariant.mjs`（台账不变式 + 上报去重） |

### 开发脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/asar-read.mjs` | 只读巡检运行中 `app.asar`（`find`/`cat`/`css` 三种模式）。判断"运行中宿主到底怎么写"必须以它为准——桌面端内置的 0.2.0-rc.1 源码只在 asar 里 |
| `scripts/check-routes-against-host.mjs` | 从 asar 抽出运行中宿主的**真实** `endpointFromPath` + `assertFetchRoute` 并执行，逐条校验 4 个端点路径（找不到 asar 时 SKIP） |

---

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 设置里没有「已归档会话」 | profile 是否同时加了 `link:` 依赖**和** `dsh.profile.bundles`；`lib/client.js` 是否存在；**是否重启过桌面端**；硬刷新页面 |
| 页面向导里没有数据 | 宿主半侧是否激活（插件管理器里 `include:archive-manager` 的 `fiberPhase` 应为 `active`） |
| 删除提示 409 `session-live` | 该会话正在运行，先停止其活动 |
| 删除提示 409 `session-not-archived` | 该会话不在归档集合内（本插件只管理已归档会话） |
| 删除提示 500 `internal` | 官方 `workspaceRegistry` / `sessions` 服务不可用（fail-closed 保护） |
| 删除提示 500 `cross-device` | 会话与回收站不在同一卷；请手动移至同卷后重试 |

---

## 已知边界（有意接受，非缺陷）

1. **过滤索引依赖 `$DSH_HOME\archive-manager\` 下的台账**：这是"绝不物理删除"的必然代价 —— 官方
   `archivedSessionIds` 不会被本插件修改，所以"哪些会话已被处理"只能由这份索引回答。**请勿手工删改**其中的
   `manifest.json`（详见上文「删除的语义」与 A5 判据）。
2. **极端情形仍会漏报**：回收站根台账损坏 **∧** 冷存档无台账 **∧** `batch.json` 也损坏（三处独立损坏同时发生）时，
   该条目会漏报并显示为「摘要缺失」行。彻底修法是再加一路**不依赖任何 JSON** 的来源
   （`purged/<批次>/<entryId>/` 的目录名 + `session/` 存在性）；因**宿主侧每次改动都需重启一次桌面端**，暂未加入。
3. **台账只增不减**：清空后的条目记录长期保留（约 340 B/条），在回收站页签里累积为「已在冷存档区」。
   它们同时是人工找回冷存档载荷的**唯一索引**。
4. **宿主侧改动必须重启桌面端**才生效（客户端侧刷新页面即可）；这不是本插件的限制，而是 DSH 的模块装载行为
   （见 PLAN §10.6/§10.11，以及记忆 #0010）。

---

## 许可

MIT
