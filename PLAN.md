# DSH 已归档会话管理插件 — 落地计划

> 状态：**待确认**（第 10 节有 4 个待你拍板的决策）
> 目标运行时：DSH **0.2.0-rc.1**（desktop profile）
> 本文所有"事实"均来自本机只读侦察，证据见第 2、4 节的行号与命令。

---

## 1. 目标与范围

### 1.1 用户目标
1. 对**已归档会话**执行**删除 / 恢复**。
2. 在**设置页**注册一个配置页，可视化批量管理。
3. 视觉风格对齐现有 DSH 极简设计（主题令牌、无障碍、深浅色）。
4. 参考 `D:\DSH-PLUGIN\dsh-archive-manager-example`，但**修正其已知问题**，不照抄。

### 1.2 验收标准（可执行）
| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 设置面板出现「已归档会话」页，样式与邻居页一致 | 打开 设置 → 已归档会话，深浅色各看一次 |
| A2 | 列出全部已归档会话（标题/项目/更新时间/归档状态） | 与 `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds` 逐条对照 |
| A3 | 单条/批量**恢复**成功，行从本页消失并回到原工作区原位置 | 恢复后侧栏可见，且 id 已退出归档集合 |
| A4 | 单条/批量**删除**成功，且**不产生不可逆丢弃** | 工件出现在回收站目录 + 可在回收站页还原 |
| A5 | 删除后官方侧栏/主列表**不出现坏行、不报错** | 侧栏归档筛选开/关各查一次 + 宿主日志无 error |
| A6 | 全程无 `rm`/`del`/`Remove-Item` 语义的物理删除 | 代码审查 + 回收站目录实测 |
| A7 | 深浅色、语言（中/英）、字号跟随宿主 | 切换主题/语言/字号后页面自动跟随 |

### 1.3 明确**不做**
- 不重写正文检索、轮次统计、诊断修复、更新器（示例里占了大头的功能，与本次目标无关）。
- 不替换任何官方宿主服务。
- 不做后台定时清理。

---

## 2. 已验证的事实基线

### 2.1 运行环境（关键：CLI 与 GUI 不是同一个安装）
| 项 | 值 | 证据 |
|---|---|---|
| GUI 运行时 | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.1** | `E:\DSH\resources\app.asar` → `/dsh/package.json` |
| 全局 CLI `dsh` | **0.1.7-rc.2**（另一套 npm 全局安装，**不是** GUI 用的） | `dsh --version` |
| npm 上最新发布 | **0.1.7-rc.2**（即 0.2.0-rc.1 **未发布到 npm**） | `npm view @deepseek-ai/dsh version` |
| profile | `desktop` | `$env:DSH_PROFILE` |
| `$DSH_HOME` | `D:\DSH\dsh-home` | env |
| GUI 地址 | http://127.0.0.1:19387 | 会话上下文 |

> **推论**：
> 1. 安装/调试必须以 **desktop profile** 为准；不要用全局 CLI 的版本来推断宿主能力。
> 2. 运行中的 GUI 比 npm 上任何版本都新（0.2.0-rc.1 只存在于桌面端 `app.asar`，`app-update.yml` 为
>    nightly 通道）→ **不能依赖 `dsh plugin add` 的版本校验**，安装走 profile 侧 `link:` + `dsh.profile.bundles`。
> 3. 引用官方实现证据时，凡涉及**运行中行为**必须引 asar（0.2.0-rc.1）；npm 树（0.1.7-rc.2）
>    只能作格式/类型参照，并标注版本——两者不可混用（这一条来自 verifier 的复核发现）。

### 2.2 官方能力边界（0.2.0-rc.1 实测）
| 能力 | 是否官方提供 | 接口 |
|---|---|---|
| 归档会话 | ✅ | 客户端 `ctx.workspaces.archiveSession(id,{stopActivity?})`、`ctx.uiWorkspace.archiveSession` |
| 取消归档（恢复） | ✅ | `ctx.workspaces.unarchiveSession(id)` |
| 归档状态读取 | ✅ | `ctx.workspaces` 快照 `WorkspaceSnapshot.archivedSessionIds`（registry 全局完整集合） |
| **删除会话（DSH 自身会话存储 / 归档集合）** | ❌ **无任何接口** | 全量 `*.d.ts` 检索 `deleteSession/removeSession/purgeSession`：npm 树 1985 个 d.ts 公开命中 **0**，唯一命中 `dsh-session-query-sqlite/lib/types/index.d.ts:106` 的**私有** `_deleteSession` |
| 「已归档会话」设置页 | ❌ 本机没有 | `app.asar` 内 `dsh-client-ui-settings-unarchive-sessions` **0 命中**；实时插槽占用者只有 account/general/models/plugins/agent-presets |
| 会话离开宿主的事件 | ✅ | 宿主事件 `api-session/removed(sessionId)` |

> **措辞更正（verifier 复核）**：0.2.0-rc.1 的 asar 内 `deleteSession` 有 14 处命中，但全属
> **Agent 协议层**（`AGENT_METHODS.session_delete === "session/delete"`，由外部 agent 的
> `sessionCapabilities.delete` 门控，删的是外部 agent 自己 session/list 里的条目），
> **与 DSH 宿主会话存储无关**。另 5 处 `_deleteSession` 属 sqlite 索引。
> 因此准确表述是：「**DSH 自身的会话存储与归档集合没有删除接口**」，而不是「删除完全不存在」。

**结论**：**恢复=纯官方接口，零风险；删除=必须自建宿主半侧。**

### 2.3 设置页座位（实时插槽实测）
`settings.section`（kind=list，root 作用域）：
- 注册参数：`{ id: string(必填), order?: number, label?: string | (() => string) }`
- 现有占用：`account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)`
- **catelog 明确写**：用**自己的新 id** = 旁边新增一格；复用官方 id 才会顶替它。
- 页面组件拿到的 standardProps 已含：`useWorkspaces`（`WorkspaceSnapshot`）、`useSessions`、`useSessionStatus`、`usePanelInfo`、`close`。

> 即：我们注册 `id: 'archive-manager'`, `order: 25` → **纯增量，不冲突、不禁用任何官方条目**。

### 2.4 归档数据模型
- 归档集合是 **registry 全局**的 `archivedSessionIds`，持久化在 `$DSH_HOME\storages\workspace.json`。
- **归档会话保留它原本的 `sessionIds` 记账槽位**（取消归档要还原位置）。
- 归档与置顶互斥（归档会丢掉置顶）。
（证据：`dsh-workspace/lib/types/spec.d.ts:36-49`）

### 2.5 磁盘布局（决定"删除"怎么实现）
```
D:\DSH\dsh-home\
├─ sessions\<cwd-slug>\<sessionId>\session.v4.jsonl.zstd   ← 会话转录
├─ storages\workspace.json                                  ← 归档集合 / 工作区记账
├─ storages\session_projcache\                              ← 投影缓存
├─ storages\session_projcache_archive_manager_v2\           ← ⚠ 示例插件留下的残留
└─ subagent-gc-backup\                                      ← 官方"备份而非删除"的先例
```

---

## 3. 总体架构

```
┌─ 客户端半侧（web bundle）───────────────────────────────┐
│ settings.section @ 'archive-manager'                     │
│  · 数据源：useWorkspaces().archivedSessionIds            │
│           + useSessions() 摘要                            │
│  · 恢复：ctx.workspaces.unarchiveSession(id)   ← 官方    │
│  · 删除：POST /api/dsh-archive-manager/recycle ← 自建    │
│  · 样式：仅用主题令牌(theme tokens)，0 硬编码配色         │
└──────────────────────────┬───────────────────────────────┘
                           │ 已认证 HTTP（client-connection fetch）
┌──────────────────────────▼───────────────────────────────┐
│ 宿主半侧（node）                                          │
│  ctx.webServer.register({ path, handler })               │
│   · POST /recycle   {sessionIds[]} → 移入回收站           │
│   · POST /restore   {entryIds[]}   → 移回原路径           │
│   · GET  /list                     → 回收站清单           │
│   · POST /purge     {}             → 清空（二次确认）      │
│  回收站：$DSH_HOME\archive-manager\recycle\<ts>__<sid>\   │
│           + manifest.json（原始路径/标题/cwd/大小/时间）   │
└──────────────────────────────────────────────────────────┘
```

### 3.1 分阶段（降低风险）
- **阶段一（纯客户端，零补丁）**：设置页 + 列表 + 搜索/排序 + 恢复 + 空态 + i18n。这一步只用官方接口，可独立验收。
- **阶段二（宿主半侧）**：回收站式删除 + 回收站视图 + 还原/清空 + 契约测试。
- **阶段三（可选）**：侧栏会话菜单项、批量选择增强、回收站容量提示。

---

## 4. 关键设计决策（逐条修正示例的问题）

| # | 决策 | 示例的做法（问题） | 我们的做法与理由 |
|---|---|---|---|
| **D1** | **不替换官方服务** | `cordis.patch.yml` 把官方 `workspace`、`session-projection-cache` 置 `disabled: true`，插入 59KB/12KB 的子类，直接调用父类私有成员（`requireState`/`requireTable`/`headers`/`entities`/`indexHeader`，见 `src/workspace.ts:1022-1143`） | 官方服务一行不动；宿主半侧只注册 4 个 HTTP 路由。私有成员一改示例就崩，我们不受影响 |
| **D2** | **删除 = 移入回收站** | `rm(target.path,{recursive:true,force:true})`（`src/workspace.ts:1206`、`:1315`）→ 不可逆 | 用 `rename`/移动把 `<sessionId>` 目录搬进插件回收站 + 写 `manifest.json`。**不执行任何物理删除**（满足 `AGENTS.md` A2；并可"还原"） |
| **D3** | **恢复走官方接口** | 0.1.6+ 已改用官方 `ctx.workspaces.unarchiveSession` | 直接沿用，不自己维护归档集合 |
| **D4** | **独立 id 注册设置页** | 禁用官方 `ui-settings-unarchive-sessions`，用户失去官方入口 | 本机该包不存在、插槽无占用 → 我们纯增量注册 `archive-manager`，不禁用任何条目 |
| **D5** | **复用官方 `/api` 鉴权通道** | 自建 Typert invocation 描述符 + 私有 HTTP 端点混用 | 宿主侧用 `ctx.connection.fetch.register({ path: '/dsh-archive-manager/xxx', ... })` —— 官方定义就是"Host 功能拥有的 `/api` 之下精确路由"，**鉴权由官方通道完成**（`dsh-client-connection/lib/types/rpc.d.ts:110-129`）；客户端同源 `fetch('/api/...')`。比裸 `webServer` 路由更安全，也不引入 Typert 手写描述符 |
| **D6** | **不做墓碑机制** | `trackTombstone` + `coldReuseKnown` 身份探针（`src/workspace.ts:1063-1126`）防止"已删会话复活" | 我们没接管索引，就不存在"复活"问题；不引入这套复杂度 |
| **D7** | **回收站放在 DSH 根外** | 在 DSH 存储里另建投影缓存域，留下 `session_projcache_archive_manager_v2` 残留 | 回收站目录 `$DSH_HOME\archive-manager\` 与 `sessions\**` **物理隔离**，绝不被会话扫描到 |

---

## 5. 文件清单与接口契约

```
D:\DSH-PLUGIN\dsh-archive-manager\
├─ package.json          # 插件清单（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml      # 只 insert 自己的两条 entry，不 disable 官方
├─ tsconfig.json
├─ PLAN.md               # 本文件
├─ src\
│  ├─ contracts.ts       # 共享类型 + 输入校验（纯函数，可单测）
│  ├─ host\
│  │  ├─ index.ts        # 宿主入口：注册路由
│  │  ├─ recycle-store.ts# 回收站：move/restore/list/purge + manifest
│  │  └─ session-files.ts# 定位会话工件（sessionId → 目录）
│  └─ client\
│     ├─ index.ts        # 客户端入口：注册 settings.section + locale
│     ├─ ArchivedSessionsPage.tsx
│     ├─ useArchivedSessions.ts
│     └─ locales.ts
├─ lib\                  # 构建产物（git 忽略，lib/client.js 必须存在）
├─ test\                 # *.test.mjs（node --test）
└─ scripts\build.mjs     # esbuild 打包客户端 + 抄送宿主
```

### 5.1 插件清单要点
```jsonc
{
  "name": "dsh-archive-manager",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 宿主半侧 entry
    "client": {                                     // 浏览器半侧
      "platform": "web",
      // inject 只是**信息性**的包名依赖，不参与模块解析（官方 manifest 原文：
      // "Informational package-name dependencies, not Cordis service injection."
      // —— dsh-package-manifest/lib/types/types.d.ts:79）
      "inject": ["@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-settings"],
      // external 才是决定模块能否被解析的权威声明（exact module request，可带 /client 子路径）。
      // 当前 bundle 只 require 基座模块，故留空；一旦要 import 非基座模块必须写在这里。
      // 官方同用两者的例子：dsh-api-workspace-controller/package.json:44-54
      "external": []
    }
  }
}
```
> 依据：`dsh-package-manifest/lib/types/types.d.ts:76-89`（`inject` 信息性 / `external` 权威）与
> `dsh-client-modules/README.zh.md:34-50`。**类型专用导入必须写 `import type`**，否则会被打进 bundle
> 并在运行时解析失败；`test/build.test.mjs` 会拦截「非基座且未在 `external` 声明」的 require。

### 5.2 宿主路由契约（阶段二）
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/dsh-archive-manager/list` | – | `{ entries: RecycleEntry[] }` |
| POST | `/api/dsh-archive-manager/recycle` | `{ sessionIds: string[] }` | `{ moved: string[], failed: Failure[] }` |
| POST | `/api/dsh-archive-manager/restore` | `{ entryIds: string[] }` | `{ restored: string[], failed: Failure[] }` |
| POST | `/api/dsh-archive-manager/purge` | `{ confirm: true }` | `{ purged: number }` |

失败一律返回 `ErrorResponse { code: HostErrorCode, message: string, ids?: string[] }`：
`code` 是**稳定错误码**（客户端据此做中英本地化），`message` 是人类可读技术详情（兜底展示）。
稳定码集合见 `src/contracts.ts` 的 `HostErrorCode`。

```ts
type RecycleEntry = {
  entryId: string          // `<movedAtMs>@<sessionId>`，由 entryIdFor() 生成
  sessionId: string
  title?: string           // 见下方说明：真实转录头没有 title，通常为空
  cwd?: string
  movedAt: string          // ISO-8601
  originalPath: string
  bytes: number
}
```
> **title 的现实**：DSH 的会话标题由官方投影缓存派生，转录头里没有 `title` 字段
> （host-recycle 实测 186 个真实会话 0 命中）。因此回收站条目的 `title` 一般为空，
> 标题由客户端从官方会话摘要显示；`cwd` 正常填充。

安全约束（写进实现与测试）：
- `sessionId` 必须匹配 UUID 形态；`entryId` 必须先过 `parseEntryId()` 解析成 `{sessionId, movedAtMs}`，
  再在回收站内 `readdir` **精确匹配目录名**，绝不把请求字符串当路径拼接。
- 移动前 `lstat` 校验源为目录且**不是符号链接**（借用示例 `:1186-1200` 的检查思路，但动作是 move 不是 rm）。
- `originalPath` 必须是 `$DSH_HOME\sessions\` 的**子路径**，否则拒绝。

### 5.3 客户端 API 用法
```ts
// 恢复（官方，无宿主依赖）
await ctx.workspaces.unarchiveSession(id)

// 清单
const { archivedSessionIds } = useWorkspaces(s => s)     // standardProps
const sessions = useSessions()                            // 摘要 byId
```
组件类型：`SectionProps<'archive-manager'>` 取自 `@deepseek-ai/dsh-client-ui-settings/client` 的 slot 契约。

---

## 6. UI 规范（对齐 DSH 极简设计）

- **只用主题令牌**：颜色一律 `var(--dsh-*)` / `ctx.theme` 令牌；`overrideTokens` 仅在必要时使用，禁止硬编码十六进制。参考邻居页（通用设置）的分组行、"标题 + 说明 + 右侧控件"节奏。
- **布局**：`分组标题 → 说明文字 → 列表卡片`；行高、圆角、分隔线与 General 页一致；列表用紧凑行（标题 / 项目 / 相对时间），操作放行尾 hover 图标 + "…" 菜单。
- **交互**：搜索框 + 排序下拉 + 多选 + 底部批量条；危险操作（删除）用二次确认对话框，文案明确"移入回收站，可还原"。
- **状态**：loading / empty / error 三态齐备；空态给出下一步（"还没有已归档会话"）。
- **i18n**：`ctx.locale.register(ns, { zh, en })`；`label` 用 thunk `() => t('section.title')` 以便切语言自动跟随。
- **无障碍**：图标按钮带 `aria-label`；批量条可键盘操作；focus 环沿用宿主 token。

---

## 7. 实施阶段 / 团队分工

> 按你的授权使用 Agent Teams。写入范围互不重叠；共享文件（`package.json`/`cordis.patch.yml`/`lib/*` 集成）全部归 Lead。

| 角色 | 负责 | 写入范围 | 依赖 |
|---|---|---|---|
| **Lead（我）** | 契约冻结、`package.json`/`cordis.patch.yml`、构建脚本、集成、安装进 desktop profile、终验收 | `package.json`, `cordis.patch.yml`, `scripts/**`, `src/contracts.ts`, `README.md` | – |
| **teammate `client-page`** | 设置页 UI、i18n、主题对齐、客户端数据钩子 | `src/client/**`, `test/client.*.test.mjs` | 契约冻结 |
| **teammate `host-recycle`** | 回收站存储层（move/restore/list/purge）、路径安全校验、路由 | `src/host/**`, `test/host.*.test.mjs` | 契约冻结 |
| **teammate `verifier`** | 只读独立复核：验收 A1–A7、边界用例、反例（符号链接、越界路径、并发） | `test/verify/**`（只写测试与报告） | 阶段一/二完成 |

任务卡（team_task_create）：
1. `T1 契约冻结 + 骨架 + 构建跑通`（Lead）
2. `T2 设置页骨架 + 列表/恢复`（client-page）← blocked_by T1
3. `T3 回收站存储层 + 路由`（host-recycle）← blocked_by T1
4. `T4 集成 + 安装到 desktop profile + 冒烟`（Lead）← blocked_by T2,T3
5. `T5 独立验证与反例`（verifier）← blocked_by T4

### 7.1 安装方式（待你确认，见第 10 节）
参照本 profile 既有的本地插件（`dsh-memory: link:D:/dsh-memory-v2`）：
```jsonc
// D:\DSH\dsh-home\profiles\desktop\package.json → dependencies 追加
"dsh-archive-manager": "link:D:/DSH-PLUGIN/dsh-archive-manager"
```
```yaml
# D:\DSH\dsh-home\profiles\desktop\cordis.patch.yml 末尾追加
- insert:
    - id: archive-manager
      name: 'dsh-archive-manager'
```
然后 `pnpm install` 到该 profile，重启桌面端 + `Ctrl+Shift+R`。

---

## 8. 测试与验收

| 层 | 内容 |
|---|---|
| 单测（node --test，`*.test.mjs`） | 契约校验纯函数；回收站 move/restore/purge（临时目录）；路径安全反例（`..`、绝对路径、符号链接、非 sessions 子路径、非 UUID id） |
| 构建校验 | `pnpm typecheck` + `lib/client.js` 存在且非空 |
| 集成冒烟 | 真机：造一条会话 → 归档 → 本页恢复 → 再归档 → 删除 → 检查回收站 → 还原 |
| 验收 | A1–A7 逐条，含深浅色/中英/字号三连检查 |
| 独立复核 | `verifier` 只读复核实现与验收证据（`AGENTS.md` D2） |

**回归基线**：删除前后 `workspace.json` 的 `archivedSessionIds`、`sessions\` 目录树、回收站三处的对照快照。

---

## 9. 风险与未决项

| # | 风险 | 影响 | 缓解 / 待验证 |
|---|---|---|---|
| R1 | **删除后官方侧栏可能露出"缺摘要"的坏行** | 中 | **必须实测**：两种顺序各试一次（① 保持归档标记 + 仅移走工件 ② 先 `unarchiveSession` 再移走工件）。倾向 ①：id 留在"归档"桶（默认不可见），我们的页面用回收站清单把它改判为"已删除"。若仍露坏行 → 追加一次 `api-session/removed` + 评估是否需要一个"清理残留归档标记"维护动作 |
| R2 | 回收站里的会话若被其他 DSH 进程引用（正在运行中） | 高 | 移走前复用官方活动查询（宿主事件 `workspace/session-activity` 语义 / `sessions.get(id)`）：**运行中一律拒绝并提示**，不自动强停 |
| R3 | 子代理（subagent）子会话的级联 | 中 | 示例会级联删除 `origin:'subagent'` 子会话（`:1274-1309`）。我们**默认不级联**，只在页面上提示"该会话有 N 个子代理会话"，由用户显式勾选 |
| R4 | `link:` 本地插件在桌面端的加载路径 | 中 | 安装后 `dsh --profile desktop --dump-config` 应出现 `archive-manager`；失败则改用 profile 内包拷贝方式 |
| R5 | 宿主 `webServer.register` 路由与已认证 fetch 的鉴权形态 | 低 | 阶段二第一步先做"Hello"空路由冒烟；不通过则退回 Typert `@Remote` 方案 |
| R6 | 会话工件随 DSH 版本变形（目录布局变更） | 中 | 定位逻辑单点收敛在 `session-files.ts`，并在找不到时**拒绝操作**而非猜测路径；写进 README |
| R7 | 回收站无限增长 | 低 | 页面显示占用大小；"清空回收站"需二次确认；提供"仅保留最近 N 天"作为后续项 |

---

## 10. 已确认的决策（2026-09-29 用户拍板）

1. **删除的语义** = **移入插件回收站（可还原）**，不做不可逆物理删除；清空回收站也只做"移交"，不直接抹除。
2. **入口范围** = 先只做「设置 → 已归档会话」一页；侧栏会话菜单项留到阶段三。
3. **安装授权** = 已授权修改 `profiles\desktop\package.json` 与 `profiles\desktop\cordis.patch.yml`，改前先备份
   （备份已完成：`backups\profile-desktop-20260929-161756\`，含 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`）。
4. **团队规模** = 3 个 teammate（client-page / host-recycle / verifier）。

### 10.0 开发流程索引（阶段 → 本章章节 → 日志 → 长期记忆）
> 目的：让"整个开发流程"在**仓库里**可追溯，而不只存在于会话与记忆系统里。
> 日志为项目过程记录（`memory_search` + `includeJournal:true`），记忆为可复用结论。

| 阶段 | 发生了什么 | 本章 | 日志 | 记忆 |
|---|---|---|---|---|
| 1 侦察定调 | 确认无官方删除接口与归档页 → 四个决策（删除=移入回收站、只做设置页、授权改 profile、3 队友） | §1–§4、§10 | J-20260929-1802 | #0002 #0005 |
| 2 契约与路由 | 冻结 4 条路由/id 校验；**真 bug**：path 必须自带 `/api` 前缀 → 永久守卫 + 用宿主真实校验器验路由 | §5、§10.7 | -2 | #0003 #0007 |
| 3 三半侧并行 | host-recycle 交付存储层与端点；client-page 交付设置页；verifier 建 9 个只读复核脚本 | §7、§10.2–10.3 | -3 | #0004 |
| 4 安装与模块缓存 | `install_bundle target=link:` 装进 desktop profile；**fiberPhase failed** 定性为模块缓存 → 必须重启；单文件入口绕缓存被**实测否证** | §10.4、§10.6、§10.7 | -3 -4 | #0012 #0010 |
| 5 真机冒烟与 id 形态 | 页面通过（A1/A2/A7）；删除被自己的校验器拒 → 真实 id 是 `session-<uuid>`，改为安全字符集 + 用真实数据喂养契约测试 | §10.10 | -5 | #0009 |
| 6 幽灵行与台账不变式 | 四步演进 T9→T11→T12→T13，修前 1 条幽灵行 → 修后 0 条；不动官方归档集合 | §10.11、§10.13、§10.14 | -6 | #0013 |
| 7 保真度治理 | 改用官方 UI 原子件（免费基座表内）；三条有意偏离；纠正 `time.*` 归属；标题字重 500→600 | §10.5、§10.12 | -7 | #0011 |
| 8 覆盖盲区治理 | `buildSectionModel` 单点真源让 A5 链路可执行断言；`initialTab` 测试缝；一次断言方式的自我纠错 | §10.9（第三例）、§10.12 | -8 | #0014 #0015 |
| 9 终验交付 | 部署判据（进程晚于产物）；A1–A7 全通过；一处刻意不一致留痕 | §10.15 | -9 | #0010 #0013 |

### 10.1 侦察后对计划的修订（重要）
- **D5 修订**：宿主路由不用 `ctx.webServer.register`，改用官方 `ctx.connection.fetch.register(...)`。
  原因：`webServer.match()` 是「精确表优先，其后**最长前缀**优先」
  （`dsh-host-webserver/lib/index.js:322-332`），`/api` 已被官方网关以 prefix 占用；
  而 `connection.fetch.register` 的 `path` 天然就是「`/api` 之下」，且**自带官方鉴权**，
  不需要我们自己写 `admit()`。官方用例：`dsh-client-ui-deliverables/lib/index.js:48-98`。
- **客户端运行时白名单已锁定**：`PLATFORM_MODULES` 静态基座（9 键）=
  react / react/jsx-runtime / react-dom / react-dom/client / `@deepseek-ai/cordis` /
  `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-slots` /
  `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-dockkit`。
  **非基座模块请求必须写进 `dsh.client.external`**（不是 `inject`——见下方 P1）；
  **类型专用导入必须写 `import type`**，否则会被打进 bundle 并在运行时解析失败 ——
  已由 `test/build.test.mjs` 自动拦截。
- **P1（verifier 发现，lead 已独立复核并修正）**：`dsh.client.inject` 的官方定义是
  "Informational package-name dependencies, **not** Cordis service injection."
  （`dsh-package-manifest/lib/types/types.d.ts:79`），真正决定模块解析的是
  `dsh.client.external`（同文件 `:83-88`："Exact module-table requests beyond the implicit
  client baseline, including subpaths such as `<pkg>/client`"）；官方同时用两者的例子是
  `dsh-api-workspace-controller/package.json:44-54`。
  → 修正：`test/build.test.mjs` 的白名单口径改为「基座 ∪ `external`」；
  并已通知 client-page **不要 import 非基座模块**（`@deepseek-ai/dsh-client-locale` 等
  属于非基座），改为通过 **Cordis 服务注入**（`export const inject = ['slots','locale']`）
  使用 `ctx.locale` / `ctx.slots`，无需任何模块导入。
- **P2（verifier 发现，已修正）**：基座表在**运行中 asar** 里的真实来源文件，随宿主版本而变 ——
  必须**动态读取**，不得硬编码：
  - **当前运行中 asar（0.2.0-rc.2，`app.asar` mtime 2026-09-29 18:34:26）** =
    `dsh-web-frontend/dist/assets/index-5SrrfWpU.js`；
  - 更早的 rc.1 asar = `index-Dy0OhsZ5.js`；
  - 计划初版引用的 `index-Q6zc2uHV.js` **只存在于 npm 0.1.7 安装**。
  三者解析出的 **9 键基座表完全一致**（`platform-modules-check.mjs` 双源比对 PASS）。
  → 教训：证据跨版本错位是"静默失效"的高发区，`facts-check.mjs` 因此把"必须引用运行中资源"做成了硬判据。
- **不再安装 `@deepseek-ai/*` 类型包**：本机 GUI 是桌面端内置运行时，而 npm 上长期只有 0.1.7-rc.2，
  两者不是同一套。改为手写环境声明 `src/dsh.d.ts` / `src/dsh.host.d.ts` /
  `src/dsh.client.d.ts`，每条都带证据来源注释。只从 npm 安装 `esbuild` / `typescript` / `@types/*`。

### 10.2 T1 完成状态
- 产物：`lib/index.js`、`lib/contracts.js`、`lib/host/routes.js`、`lib/client.js`（ModuleLoader 信封）。
- 验证：`tsc --noEmit` 退出码 0；`node --test "test/**/*.test.mjs"` 通过（含 require 白名单守卫）。
- 待办：T2 客户端页、T3 回收站存储层、T4 集成安装与冒烟、T5 独立验证。

### 10.3 T3 完成后的契约增补（2026-09-29）
- **错误响应体冻结为稳定错误码**：`{ code: HostErrorCode, message: string, ids?: string[] }`
  （见 `src/contracts.ts`）。原因：客户端必须能本地化失败提示（中/英），不能只依赖宿主的人类文案；
  客户端按 `code` 查词典，`message` 作兜底技术详情。
- **T3 的六项实现取舍均已由 lead 裁决接受**：回收站布局 `<entryId>/manifest.json` + `<entryId>/session/`；
  `$DSH_HOME` 解析同官方 `resolveDshHome` 的 `$DSH_HOME > ~/.dsh` 优先序；
  409 为**整批拒绝**（非跳过继续）；清空回收站 = 二次确认后移交到 `purged/<批次>/`（可审计、零删除）；
  子代理子会话拒绝且不级联；跨卷 EXDEV 直接拒绝（不做「复制+删源」）。
- **已知限制**：`manifest.title` 一般为空（真实转录头无 `title` 字段，实测 186 个会话 0 命中），
  标题由客户端从官方会话摘要显示；不提供「某会话有哪些子代理子会话」的枚举能力，
  PLAN 风险表 R3 的「提示 N 个子会话」**降级为不做**。

### 10.4 T4 集成安装（进行中）与 T6/T7
- **安装方式已改为官方插件管理器**：用 `plugin_manager install_bundle target=link:D:/DSH-PLUGIN/dsh-archive-manager`
  （而非手改 profile）。实测它会自动完成 profile 的 `link:` 依赖 + `dsh.profile.bundles` 登记 + `pnpm install` + 尝试 live 激活。
  profile 与备份的差异**仅两项**（`dependencies` 增加 link、`bundles` 增加 `dsh-archive-manager`），无其它改动。
- **安装立刻抓到真 bug（已修 + 已加永久守卫）**：`ctx.connection.fetch.register` 的 `path` **必须自带 `/api/` 前缀**。
  官方 types 注释 "Absolute path below `/api`" 有歧义，真实规则在 `assertFetchRoute` → `endpointFromPath('/api', path)`
  要求 `path.startsWith('/api/')`，每段须匹配 `/^[A-Za-z0-9_$.-]+$/`，且分发用 `fetchRoutes.get(url.pathname)` 做完整
  pathname 精确匹配。→ 契约已改为 `/api/dsh-archive-manager/*`，并在 `test/build.test.mjs` 增加「路由必须满足官方规则」的守卫测试。
- **live 激活失败的真正原因是模块缓存**：DSH 进程缓存了我们第一次（路由未带 `/api`）的模块实例，
  错误栈行号与当前文件不符、toggle 重激活后报同一旧路径。**需重启桌面端才能换成新模块**（我无法重启——会话运行在该进程内）。
- **T6（宿主加固）已完成**：verifier 早审的 P6/P7/P8/P9/P10/P11 全部落地 ——
  宿主用 `ctx.get('workspaceRegistry')` 校验 id ∈ `archivedSessionIds`（不在集合 → 整批 **409 `session-not-archived`** + `ids`，
  服务缺失 → **500 `internal` 点名服务**，fail-closed）；`sessions`/`workspaceRegistry` 缺失一律 fail-closed；
  purge 遇符号链接条目 → `failed[{code:'path-unsafe'}]` 原地保留；restore 与 recycle 对称（运行中整批 409）；
  回收站根目录在任何移动前创建（失败即 500 且磁盘零改动）；`Failure.code` 全分支接线；restore 的 TOCTOU 映射到
  `entry-conflict`/`entry-not-found`。**有意优先级：归档校验先于运行中校验**（既未归档又在运行 → `session-not-archived`），已用用例锁住。
- **契约追加两项**（均为加性变更）：`Failure` 增加 `code: HostErrorCode`；`PurgeResponse` 增加可选 `failed?: Failure[]`
  （否则客户端看不到「清空时被原地保留的条目」）。
- **T7（用户新增需求）**：已归档列表**按工作区分组**。数据源锁定为官方 `WorkspaceSnapshot.items: WorkspaceView[]`
  （`{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`，依据 `dsh-api-workspace-controller/lib/types/types.d.ts:12-25`），
  用 `items[].sessionIds` 建 `sessionId → workspaceId` 反查表，**不靠 `cwd` 猜**；映射不到的 id 进兜底组且不丢弃。
- **新增验证资产：客户端渲染冒烟测试** `test/client-render.test.mjs`（Lead 所有）—— 用假 ctx 真跑 `apply` 捕获
  `settings.section` 注册实参，再用 `react-dom/server` 渲染，覆盖注册参数/中文词典兜底/空态/摘要缺失/数据源缺失/读取中 6 条路径。
  它立刻抓到一个**真功能 bug**：`useArchivedSessions` 用 `state === 'idle'` 当 loading，而官方
  `WorkspaceSnapshot.state` 的联合类型是 `'idle' | 'loading' | 'error'`（**没有 `'ready'`**，拉取成功后回到 `'idle'`），
  就绪与否应看 `phase: 'pending' | 'ready'` → 导致「已就绪且无归档」时永久显示「正在读取…」、空态不可达。已派给 client-page 修复。

### 10.5 样式令牌验证与验证资产
- **令牌存在性验证（需求 3 的关键证据）**：从运行中 `E:\DSH\resources\app.asar` 抽取全部 CSS
  （`\node_modules\@deepseek-ai\dsh-client-ui-*/lib/**\*.css`，共 194.6 KB），其中官方 CSS 出现的
  `--dsw-*` 令牌共 **94 个**；本插件客户端源码使用的 **20 个令牌全部被官方 CSS 真实使用** → 令牌名无误，
  深浅色/换肤可跟随。
  抽取方式：`scripts/asar-read.mjs` 的 `css` 模式（只读开发工具，用法见文件头；同一工具也可用于核对运行中宿主源码）。
  **注意**：该脚本对 asar 中 `unpacked`（无 `offset`）的条目会抛 `RangeError`，但 `.css` 均非 unpacked，
  所以本次 CSS 覆盖完整。
- **验证资产清单**
  | 文件 | 归属 | 作用 |
  |---|---|---|
  | `test/build.test.mjs` | Lead | bundle 信封与导出、require 白名单（基座 ∪ `external`）、**HOST_ROUTES 必须满足官方 exact Fetch route 规则** |
  | `test/client-render.test.mjs` | Lead | 服务端渲染冒烟 6 条路径（注册参数/中文词典兜底/空态/摘要缺失/数据源缺失/读取中），用假 ctx 真跑 `apply` 再 `react-dom/server` 渲染 |
  | `test/style.test.mjs` | Lead | 禁止硬编码配色（`#hex`/`rgb()`/`hsl()`）、只允许 `--dsw-*` 令牌族 |
  | `test/host.test.mjs` | host-recycle | 回收站存储层 24 用例（含路径安全反例、逐条 `Failure.code`、删除语义静态守卫） |
  | `test/client.test.mjs` | client-page | 客户端纯函数与源码级 import 白名单 |
  | `test/verify/**` | verifier | 只读独立复核：红线扫描、bundle 白名单、基座表双源解析、契约一致性、PLAN 事实重放、宿主路由真跑 |

> **强校验脚本**：`scripts/check-routes-against-host.mjs` —— 从 `app.asar` 抽出运行中宿主的**真实**
> `endpointFromPath` + `assertFetchRoute`（含两个正则常量）在隔离作用域里重建并执行，逐条断言 4 个端点。
> 实测结果（2026-09-29）：`list/recycle/restore/purge` **全部 PASS**，endpoint 分别为
> `dsh-archive-manager/{list,recycle,restore,purge}`。这把"我们以为的规则"换成了"宿主实际执行的规则"，
> 证明当前代码正确、真机未生效纯粹是旧模块缓存所致。找不到 asar 时该脚本打印 SKIP 并退出 0。

### 10.6 两半的 live 生效路径**不同**（实测结论，重要）
- **客户端半侧：无需重启，HMR 即可生效。** 实测：`lib/client.js` 内容变化后 revision 变化 → 页面重载新 bundle；
  插槽巡检可见 `settings.section` 的 occupants 出现 `{ id: 'archive-manager', order: 25, active: true }`，
  且官方 account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20) **全部保持原样**（纯增量成立）。
  反复 `set_bundle` 开关后该占用者依然稳定在位。
  → 因此 **A1 的注册部分、A2（列表/分组/搜索排序）、A3（恢复走官方 `ctx.workspaces.unarchiveSession`）、
  A7（主题/语言）都不依赖宿主半侧**，可在重启前就验证。
- **宿主半侧：必须重启进程。** 实测：进程缓存了首次激活失败时的模块实例，`set_bundle` 反复 toggle、
  甚至改动 `lib/index.js` 内容后重激活，报错仍是**同一份旧栈**（`lib/host/routes.js:52`，而当前文件的
  `path:` 在 74/87/121/154 行）。结论：Cordis 的模块注册表**不会为一个激活失败的 fiber 失效化其模块**，
  HMR 只对已成功加载的 fiber 生效。
  → 因此 **A4（删除→回收站）、A5（删除后无坏行）必须等重启后的 live 信号**。
- 推论（写进 README 的排查表）：任何**新装**插件或**激活失败过**的插件，都要重启桌面端才能换掉旧模块；
  只改客户端 bundle 的迭代则不必重启。

### 10.7 被否证的尝试（**不要重做**）：靠改入口路径绕过模块缓存
- 曾尝试：把 `main` 从 `lib/index.js` 改成**自包含单文件** `lib/entry.js`（esbuild `bundle: true`），
  指望 Loader 因"新 URL"重新导入当前代码，从而免重启激活。
- **实测否证**：即使 `main` 已指向 `lib/entry.js`，重激活的报错栈**仍指向 `lib/index.js:4` 与 `lib/host/routes.js:52`**
  → 说明**加载器在首次装载时就固化了入口模块记录，重激活不会重读 `package.json` 的 `main`**。
  连同先前两次否证（改文件内容无效、`set_bundle`/`set_plugin` toggle 无效），结论是：
  **进程内没有可用的免重启换模块手段**（官方 `hmr` 服务也只暴露 `runExclusive`/`watchConfig`/`getLinked`，
  没有手动 reload/invalidate 入口）。
- 因此该改动已**回退**（`main` 仍为 `lib/index.js`，构建脚本不再产出单文件入口），
  以免留下"没有理由的复杂度"。
- **遗留**：本次实验中生成的 `lib\entry.js` 已不再被任何东西引用（`lib/` 是构建产物目录且已 gitignore）。
  按 A2 我不执行删除，需人工清理时请连同 `.tmp\asar-read.mjs`（临时脚本，已转正到 `scripts\asar-read.mjs`）一并处理。

### 10.8 重启后验收窗口的操作清单（自包含，供重启后的会话直接照做）
> 重启会中断当前会话，因此下列步骤写成不依赖会话记忆的形式。
> **前置：没有任何 teammate 在跑**，否则重启会打断它（用户已明确指出这一点）。

**A. 重启前**：`list_agents` 确认全员 `inactive`；`plugin_manager list_plugins` 确认 `include:archive-manager` 当前为 `failed`（重启前的预期态）。

**B. 重启桌面端 + 页面 `Ctrl+Shift+R`。**

**C. lead 侧读两个信号（不需要页面配合）**
1. `plugin_manager list_plugins`（offset≈194）→ `include:archive-manager` 的 **`fiberPhase` 必须为 `active`**。
2. `cordis_inspect_query(client, Slots, listSubTree, root="settings.section")` 的 `occupants` 必须含
   `{ id: "archive-manager", order: 25, active: true }`，且官方 account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20) 全部原样。
   ⚠️ 这是 **client 侧**查询，会等页面响应、**容易挂死**：只查一次；无响应就跳过，改用 D 的人工结果（勿重试）。

**D. 人工点击（用户）**
1. 设置 → 已归档会话：按工作区分组、组头可折叠、搜索/排序在组内生效（A1/A2）。
2. 挑一条**不重要的**已归档会话 →「…」→ 删除 → 确认（A4 前半）。
3. 侧栏主列表与归档筛选：**不得出现异常行**（A5）。
4. 回收站视图 → 还原那条会话（A4 后半，可逆性）。
5. 切深/浅色、切中/英、改字号：页面跟随（A7）。

**E. lead 侧核对磁盘证据（删除之后）**
- `$DSH_HOME\archive-manager\recycle\` 下应出现 `<movedAtMs>@<sessionId>\`，内含 `manifest.json` 与 `session\` 子目录
  （会话目录是**被移动**而非删除；`session\` 里仍是 `session.v*.jsonl.zstd`）。
- `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds` 变化应与操作一致；不得出现"有 id 但无工件"的坏行（A5）。
- 还原后：该条目只剩 `manifest.json`（`list()` 只上报仍带 `session\` 的条目，故自动从清单消失）。

**F. 收尾**：结果交给 verifier 补完 A1–A7；然后人工清理两个遗留文件（见 §10.7）：`lib\entry.js`、`.tmp\asar-read.mjs`。

### 10.9 方法论：必须区分"取不到证据"与"证据为假"
本项目在一天内踩到**两次同类**风险，都写在这里以免重犯（其中一条由 verifier 在其 REPORT §11.3 独立提出）：

1. **抽取被静默截断**：我早先从 `app.asar` 抽 CSS 时，遇到 `unpacked`（无 `offset`）条目抛 `RangeError`，
   进程在中途死掉，只得到 194 KB / **94 个** `--dsw-*` 令牌；而 verifier 全量扫描得到 **419 个**。
   当时我的守卫**照样全绿** —— 因为"没抽到"和"不存在"在断言里长得一样。
   → 修正：跳过不可读条目 + 加**抽断底线**（`official.size > 100`，低于此值判定抽取失败而不是"全都存在"）。
2. **参照物失效后静默降级**（verifier 侧）：其脚本曾硬编码前端资源文件名，宿主升级后该文件不存在，
   脚本没有报错而是退化成"未覆盖"，看起来仍是通过。

**规则**：取证类脚本必须把"取不到证据"显式标记为**未覆盖并计入失败**，不得静默通过；
并且要么动态发现参照物（版本/hash 不硬编码），要么在找不到时**明确报错**。

**第三例（本轮新增）**：写 SSR 断言时若**注入自己的 `t` 探针**，所有插值参数都会消失 ——
因为 `createTranslate(bound, …)` 对宿主翻译器只传 key（`bound(key)`），插值由**我们自己的词典层**
（`locales.ts` 的 `interpolate`）完成。于是 `{batch}` 之类占位符永远不会出现在 HTML 里，
"批次名可读"这类断言就会**必然失败或被迫写弱**（写弱 = 放行真实缺陷）。
正确做法：**不注入 `t`**，让组件走自带 zh 词典与真实插值路径，直接断言**用户可见文案**。
教训：断言失败时先判断"是产品错了还是我的观测方式错了" —— 这次是后者，而正确答案比原计划**更强**。

**第四例（lead 自己犯的，由 verifier 逐条读盘纠正）**：两处"推断当观测"。
① **形式谬误**：我写"宿主进程起始 18:47:41 **<** 产物 mtime 20:47:36 ⇒ **已包含** T16" —— 进程早于产物
**并不蕴含**"包含该产物"（正确论证要三条同时成立：`src/**` 最新 mtime 20:43:05 且此后未变 ⇒ 两次构建同源；
产物大小是 T16 之后的值 —— `routes.js` **8,335 B** vs 之前 6,747 B；**重启（21:00:12）晚于 T16 的构建**）。
② **把设计当事实**：我写盘上并存"在站 / 已清空 / **已还原痕迹**"三态，而 verifier 逐条读盘得到的是
"在站 ×4 / 已清空(新布局) ×2 / 已清空(**旧布局残留**) ×1"，**当前根本没有"已还原痕迹"目录** ——
我是照着代码里的状态机说的，不是照着盘说的。
→ **规则**：报告里的每个数字与状态，要么标 ★（自核，含读取时间），要么标 ○（引用，含来源）；
**不得把"代码支持的状态"写成"盘上存在的事实"**；引用他人转述前先自己读一遍。

### 10.10 会话 id 的真实形态：**全部单测都没抓到的那个 bug**
- **现象**：真机点「移入回收站」→ `HTTP 400 invalid-input`「会话 ID 无效」。宿主半侧与鉴权都正常，
  是**本插件自己的校验器**拒绝了合法请求。
- **根因**：`isSessionId` 只接受**裸小写 UUID**，而真实数据里存在两种形态：
  - 裸 UUID：`8402fa9c-abbf-46bc-8c42-370e9401976f`
  - **`session-` 前缀 UUID**：`session-0b9de1ba-1918-40b3-8fcc-8ab15a645e50`
    —— 实测当时 `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds` **5 条全是这种**；
    而 `$DSH_HOME\sessions\` 下两种并存（子代理会话是裸 UUID）。
- **为什么整套测试（当时 79 项）全绿**：所有人的夹具都用**同一个错误假设**自造的裸 UUID ——
  **夹具镜像了假设**，所以断言只能证明"我们与自己一致"。
- **修正**：校验目标从"必须是 UUID"改为**安全语义**（这才是真正要保证的）：
  ```ts
  const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;   // 不含分隔符 / 无 .. / 长度有界
  const ENTRY_ID_PATTERN  = /^(\d{1,17})@([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
  ```
- **连带语义变化**（已同步测试期望）：形态合法但不存在的 id 不再算"非法输入"：
  - `/recycle` 收到未归档 id → `409 session-not-archived`（而非 400）；
  - `/restore` 收到合法但不存在的 entryId → `entry-not-found`（而非 `invalid-input`）。
- **防复发**：新增 `test/contracts.test.mjs`，其中一条**直接读本机真实 `workspace.json`**，
  断言 `archivedSessionIds` 与工作区记账里的**每一个真实 id** 都能通过校验 —— 让契约对着真实数据对齐，
  而不是对着我们的假设对齐。找不到该文件时 skip。

### 10.11 真机验收记录（2026-09-29，用户重启后）
- ~~HMR 对「已激活」的宿主 fiber 有效~~ → **该结论已被证伪**（2026-09-29 17:34 live 证据）：
  用户点「清空回收站」后，盘上出现 `purged/<批次>/<entryId>/manifest.json`（**台账随载荷一起被搬走**）且回收站根为空 ——
  这正是 **T11 之前**的旧代码行为（T11 会把 `manifest.json` 留在原地并写 `purgedAt`），而我当时**已经**重新 `build` 过。
  → 修正结论：**本机未观察到任何"免重启换宿主代码"的可靠手段**。此前那次"删除成功"更可能是用户在两次操作之间
  自己重启过一次，**不能作为 HMR 生效的证据**（我把它当成了证据，这是本轮的一个判断错误）。
  → 实践含义：宿主半侧的改动一律按"需要重启"处理；用户最终需 **1 次重启** 加载 T11/T12/T13。
  → 连带缺陷：旧代码把台账搬走后 `list()` 取不到该条目 → 客户端过滤失效 → 幽灵行回归（详见 §10.14）。
- **A4 删除的真实落地**（用户操作 + lead 磁盘核对）：
  `$DSH_HOME\archive-manager\recycle\1790673301827@session-fa962f9d-7835-41f1-9e47-16b98157aea0\`
  含 `manifest.json`（`entryId/sessionId/movedAt/originalPath/bytes/cwd` 全字段）与
  `session\session.v4.jsonl.zstd`（98,604 B）—— 目录是**被移动**而非删除，符合 D2。
- **由此暴露的真缺陷（已派 T9）**：宿主**不动** `archivedSessionIds`（有意裁决，避免会话回到官方主列表
  后变成缺工件的坏行），因此被删 id 仍在归档集合里 → 客户端仅"提交成功后本地隐藏"，
  **刷新后会以「摘要缺失」的幽灵行回来**（`buildRows` 对无摘要的归档 id 会保留一行）。
  修法：客户端读 `/list` 得 `recycledIds` 并**从已归档列表过滤**，同时用官方 `SegmentedTabs`
  加「回收站」页签提供**还原 / 清空**（清空仍是移交到冷存档区，不做物理删除）。
- **保真度治理（已派 T10）**：用户主观反馈"有差别"。lead 定位为客观差异：
  ① 控件是"描边+透明底"而 DSH 是"填充面+无描边"；② 用圆角描边卡片包行而 DSH 是"扁平行+细横线"；
  ③ 破坏性操作与常规操作同权重（DSH 的危险操作是红色文字无描边）；④ 手搓相对时间（DSH 有官方 `relativeTime`）。
  根治手段：改用**官方 UI 原子件**（`Button`/`Input`/`Checkbox`/`Pill`/`Menu`/`Modal`/`RiskConfirmation`/
  `Toast`/`Tooltip`/`SegmentedTabs`/`PathLabel`/`DisclosureRow` + `Icon*` 图标集 + `relativeTime`/`fileSizeText`）
  —— 它们就在**免费基座表**里，无需新增依赖、无需 `inject`，控件形态与 DSH 同源。

### 10.12 T10 落地结果与**三条有意偏离**（不要"顺手统一"回去）
已替换为官方件的：`SegmentedTabs`（页签）、`Input`（搜索，带 `IconSearchOutlineRegular`）、`Checkbox`（全选）、
`Button`（四处动作）、`Pill`（组头条数）、`IconChevronDownOutlineRegular`（折叠）、
`IconUnarchiveOutlineRegular`/`IconTrashOutlineRegular`（行操作）、`IconRefreshOutlineRegular`（重新读取）、
`PathLabel`（路径，完整路径进 `title`、正文拆目录+文件名）、`Modal`（删除确认）、`RiskConfirmation`（清空确认）、
`relativeTime()`、`fileSizeText()`。行节奏改为**扁平行 + 0.5px 细分隔**（对齐通用设置页）。

**三条有意不替换**（理由经 lead 批准，已在代码注释与本节留痕）：
1. **不用 `Menu`/`MenuItemButton`**：官方 `Menu` **没有「`open===false` 就 return null」的早退**，依赖 anchor 定位 +
   `MenuSurface`/portal，SSR 风险高；而行内只有 2 个操作，**图标按钮 + `Tooltip`** 更稳，也更接近模型页「行内直接给删除」的观感。
   （verifier 注记：该判断在**类型层面只有间接证据** —— 官方 `Modal` 的返回类型标了 `ReactPortal | null`，而 `Menu` 未标；
   属运行时观察 + 类型推断，不是官方明文契约。）
2. **不用 `Toast`**：它需要 anchor 元素与自发消失计时，而失败提示需要**长久可读并展开技术详情**（`<details>`）；
   自动消失反而有害。改为内联提示 + `role="status"` + 令牌化样式。
3. **逐行选择用原生 `<input type="checkbox">`**：官方 `Checkbox` 的 `label: string` 是**可见文案**，
   逐行会渲染成「选择会话 XXX」把行标题重复一遍，且其 input 不透传 `aria-label`。**全选**仍用官方 `Checkbox`。

**一处对 lead 指令的纠正（由 client-page 提出，lead 确认其正确）**：T10 任务卡里我写"删掉我们自己的 `time.*` 词典条目"是**错的** ——
官方 `relativeTime()` 只返回结构化 bucket `{unit,n}`，其注释明确 *"the words stay in each plugin's own dictionary"*，
所以 `time.now|minutes|hours|days|months|years|unknown` 是**必需**资源。现由官方 bucket 驱动、我方词典出词。

### 10.13 T11/T12 裁决：清空回收站改为「移交载荷 + 保留台账」
- **缺口**：T9 用 `/list` 建 `recycledIds` 过滤已回收 id，但 `purge` 会把条目整体搬走 → 条目离开 `/list`
  → 客户端只能靠**内存态**墓碑兜着 → **刷新后幽灵行回来**（client-page 如实上报，未擅自加持久化）。
- **裁决**：不改官方归档集合（理由见 §10.11），改为**让台账活得比载荷久**：
  `purge` 只把 `<entryId>/session/` 移到 `purged/<批次>/<entryId>/session/`，
  **`manifest.json` 留在回收站原地**并写入 `purgedAt`/`purgedBatch`；`list()` 上报**台账可解析**且状态可判定的条目
  （严格说不是"所有带台账的" —— 清单缺失/损坏/不自洽的不上报，见 §10.14）。
  客户端据此把过滤变成**跨刷新持久**，并在回收站页签把已清空条目标记为「已在冷存档区」（不可还原）。
- **契约**（`src/contracts.ts`，lead 维护）：`RecycleEntry.purgedAt?`/`purgedBatch?`；`HostErrorCode` 新增 `entry-purged`。
- **否决的备选**：客户端 `localStorage` 持久化墓碑。理由：浏览器/Profile 换一个就失效，属"靠本地记忆兜住语义"，
  而账号数据在不同浏览器下本该一致；台账法把状态留在 `$DSH_HOME` 里，与插件其余状态同源。
- **已知的设计后果（接受并留痕）**：台账**只增不减** —— 因为 A2 禁止物理删除，被清空的条目记录会长期留在
  回收站根目录（每条 = 一个目录 + 一个约 340 B 的 `manifest.json`），回收站页签里会一条条累积为
  「已在冷存档区」。这是"绝不物理删除 + 必须持续过滤"两个约束下的必然结果：
  若删掉记录，客户端就失去过滤依据，幽灵行会立刻回来；若上报却不留记录，则语义自相矛盾。
  体积可忽略（340 B/条），且这些记录同时是**人工找回冷存档载荷的唯一索引**。

### 10.14 台账必须"可从磁盘重建"（T13 的不变式）
- **不变式**：*任何时候，只要某会话的工件被本插件从 `sessions/` 移走过，`list()` 就必须能上报它。*
- **触发它的两条证据**：
  1. **旧布局残留**（2026-09-29 17:34 用户实测，lead 读盘）：运行中的宿主是 **T11 之前**的代码，`purge` 把**整个条目目录**
     （含 `manifest.json`）搬进 `purged/<批次>/`，回收站根变空 → `list()` 取不到 → 客户端过滤失效 → **幽灵行回归**。
  2. **P19**（verifier 异常路径遍历）：`purge` 时"载荷已移走 + 台账写失败 + 回滚也失败" → 无载荷、无 `purgedAt` → 不上报 → 幽灵行。
- **共同根因**：台账能否被拿到，取决于"上一次写入是否成功"。
- **修法**：`list()` 的取数源 = `recycle/<entryId>/manifest.json` **∪** `purged/<批次>/<entryId>/manifest.json`；
  回收站根**无载荷**即按已清空上报（`purgedAt` 缺省时用 `batch.json`/批次名推导）；`restore` 的判据同样从"看标记"改为"**看载荷在不在**"。
  → 无论哪一步写失败、无论新旧布局，**只要工件被移走过就一定能上报**。
- **留在外面的边界**（已评估、fail-loud）：回收站根被手工删除、`manifest.json` 被人为损坏、`recycle/` 读取失败、
  `/list` 请求失败 —— 这些"外力破坏索引"的路径会让幽灵行显形，但都不静默损坏数据；
  README 已写明"回收站目录是过滤索引，请勿手工删改"。
- **落地结果（T13，已自测 + 真实盘复测）**：`list()` 取数源 = 回收站根 ∪ 冷存档台账，按 `entryId` 去重（回收站根优先）；
  状态**看载荷在不在**；`purgedAt` 推导顺序 = 台账自带 → `batch.json.purgedAt` → 批次目录名（`YYYYMMDD-HHmmss` UTC）→ 兜底 `movedAt`；
  `restore` 对"载荷不在回收站根"的三种形态统一回 `entry-purged`。
  真实盘（旧布局）实测：**修前 `list() = 0 条 → 幽灵行 1 条`；修后 `list() = 1 条（purgedAt 由 batch.json 推导）→ 幽灵行 0 条`**。
  测试 106/106（host 31/31）。verifier 另写两个**验收脚本**（不进 `run-all`，属 live 验收点）：
  `test/verify/ghost-row-check.mjs`（A5 判据，SKIP 时 exit 2 不静默通过）与 `test/verify/a5-invariant.mjs`（不变式 + 上报去重）。

### 10.15 终版验收快照与**交付时的一处刻意不一致**（用户重启后，2026-09-29 17:5x）
- **部署判据**：宿主主进程起始 **17:52:48** 晚于全部产物 mtime **17:51:58** ⇒ live 跑的就是当时构建。
  verifier 已把该判据固化成 `test/verify/deploy-freshness.mjs`，并明确它是 **mtime 代理**（反向不成立），
  故脚本另做「内容同一性」辅助判定；同时记录了它的正确用法：需以 `DSH_HOST_START_ISO` 传入宿主进程起始时间。
- **A1–A7 终判：全部通过**（verifier 报告 §14 为唯一有效终判，每条标 ★自核 / ○引用）。
  A5 的两条独立证据：① verifier 在真实盘跑 `ghost-row-check` 得 **幽灵行 0**（对照 §13.6 修前的 **1 条**）；
  ② 用户 live 观察「已归档 3 条 + 回收站 1 条已在冷存档区」—— 后者**本身就要求 live 宿主上报冷存档台账**，
  与 §10.14 的不变式一致（这条是 verifier 提出的**不依赖用户描述**的独立推理）。
- ⚠️ **刻意不一致（唯一一处，必须留痕）**：verifier 收尾时发现 `recycle-store.ts` 纵深防御分支的错误文案仍写
  「会话 ID 无效（**必须是 UUID**）」，与 §10.10 已改为"安全字符集 + 有界长度"的口径矛盾。lead 已就地改成
  「会话 ID 不合法：含路径分隔符、`..` 穿越风险或长度越界」。
  **代价**：宿主侧改动 ⇒ **运行中的进程仍是旧文案**（`recycle-store.js` 27,011 → 27,089 B），
  于是 `deploy-freshness.mjs` 会（正确地）报 FAIL。**行为零差异**：该分支被上游 `parseSessionIds` 遮蔽，
  错误码 `invalid-input` 与 HTTP 400 都不变，用户不可能看到这句文案。**下次任何原因的重启自动对齐**，不必为本条专门重启。
- **仍留在外面的低概率缺口（接受并留痕，非阻塞）**：回收站根台账损坏 ∧ 冷存档无台账 ∧ `batch.json` 也损坏
  → 该条目仍会漏报 → 幽灵行。彻底修法是再加一路**不依赖任何 JSON** 的来源（`purged/<批次>/<entryId>/` 的目录名
  + `session/` 存在性）。现在不做的理由：宿主侧每次改动都要用户重启一次，而该缺口需三处独立损坏同时发生。

### 10.16 「live/attached」≠「running」：一次判据过宽导致的真实卡死（2026-09-29 晚，用户真机）
- **现象**：用户删除 **fork/rewind 自动归档的源会话** 被拒 409 `session-live`「会话正在运行」，但该会话**早已停止运行**
  （转写文件 mtime 停在 1.7 小时前）。
- **根因**：旧判据 `ctx.get('sessions')?.get(id) !== undefined` 问的是"官方会话服务**是否持有**该会话"。
  按官方术语这叫 **live / attached**（证据：`dsh-session-reference/lib/index.js:562` 注释 *"the listed session, live **or cold**"*），
  **不等于"正在运行"**。fork/rewind 后源会话被自动归档却仍挂在内存里 → 既删不掉、也恢复不了（restore 用同一判据），用户被永久卡住。
- **正确来源**（lead 逐行核对）：
  ```js
  ctx.get('sessionController').list(signal)   // 宿主签名只收 signal（lib/index.js:1888），返回裸数组
  running:        this.ctx.agents.get(id)?.status === 'running'   // :1877 —— running 的精确语义
  agentAvailable: this.ctx.agents.get(id)?.session === session    // :1876
  // 注释 :1884 "Read every visible attached and persisted Session" → 冷/归档会话也在内，running:false（:1907-1914）
  ```
- ⚠️ **一个必须记住的坑（由 host-recycle 实测抓出）**：`lib/types/index.d.ts:75-80` 声明的
  `list(_request: SessionListRequest, signal: AbortSignal): Promise<{items}>` 描述的是**客户端 Remote 形态**（`lib/client.js:2613` 的
  `this.remote.session.list({})`）；**宿主实现完全不同**（`async list(signal)`，返回**裸数组**）。
  照 .d.ts 字面在宿主侧调用 `list({}, signal)`，会把 `{}` 当 signal 用而抛错 → **所有 attached 会话被误判"无法判定"**。
  实现因此对两种形态做了归一（`Array.isArray(raw) ? raw : raw.items`）并用 `wrapped` 用例锁住。
  **教训：Typert 远端服务的 `.d.ts` 是远端契约，宿主调用必须读宿主 `lib/index.js` 实现。**
- **新判据（必须有正面证据才放行）**：`runningIds.has(id)` → 409（文案现在才真的准确）；
  **attached 但不在 `runningIds` → 放行**（用户的场景）；attached 且**无法判定**（服务缺失/抛错/2.5s 超时/形态不认识）→
  **409 fail-safe**，文案说明"无法确认是否仍在运行"；cold 会话 → 放行且**完全不探测**（用例断言 `probes.length === 0`）。
  `restore` 用同一函数、完全对称。**fail-safe 选拒绝的理由**：这套动作是"不可逆感知"的（工件被搬走、页面行消失），
  而"无法判定"意味着我们**没有**"它没在跑"的正面证据 —— 拒绝的代价只是稍后重试，放行的代价是赌用户数据。
- **为何不改成"未归档优先"**：优先级维持既有裁定（`session-not-archived` 先于 `session-live`），既有用例仍绿。
  契约未改（不加新码，沿用 `session-live`）；`sessions` 服务整体缺失仍是 500 `internal`（fail-closed）。

### 10.17 ⚠️ 会话进行到一半时，宿主**自动升级**了：0.2.0-rc.1 → **0.2.0-rc.2**
- **实测证据**：`E:\DSH\resources\app.asar` 的 mtime = **2026-09-29 18:34:26**，其内 `/dsh/package.json` 已是
  `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2` 与 `@deepseek-ai/dsh@0.2.0-rc.2`；前端资源名由 `index-Dy0OhsZ5.js`
  变为 `index-5SrrfWpU.js`。当前最早宿主进程起始 **18:47:41** ⇒ **进程晚于 asar**，即**现在运行的就是 rc.2**。
- **发现方式（值得记）**：不是我们主动查出来的，而是 verifier 的 `facts-check.mjs` **报了一条 MISMATCH**
  —— "PLAN 引用的基座表资源名与运行中 asar 的真实资源不一致"。这正是 §10.9 那条纪律（参照物要动态发现、
  取不到/变了必须报错）在起作用：**证据跨版本错位没有静默通过**。
- **对本插件的影响（已核对的部分）**：
  - **插件在 rc.2 下工作正常**：用户在 rc.2 上打开了设置页、并收到了**本插件返回的** `409 session-live`（含我们的错误码与文案）
    —— 这是比静态分析更强的 live 证据（页面渲染 + 4 条 `/api` 路由 + 错误契约都在 rc.2 上跑通了）。
  - `scripts/check-routes-against-host.mjs` 现在读的是 **rc.2 asar**，**4/4 仍 PASS** ⇒ `/api` 路由规则未变。
  - 9 键基座表：npm 参照树（仍是 0.1.7/rc.1）与 rc.2 asar 解析结果一致（`platform-modules-check.mjs` PASS）。
- **尚未做**：verifier 的终版 A1–A7 是按 rc.1 定案的；**需要在 rc.2 上重跑一遍静态复核**并把版本标注刷新
  （npm 参照树仍是旧版，这是它的已知局限）。目标验收口径也随之更新为"rc.1 逐项定案 + rc.2 实机复核"。
- **教训**：交付期间宿主会自己升级；**"目标版本"必须带时间戳与 asar mtime**，否则"通过验收"这句话会随环境漂移而失真。

### 10.18 工具坑：**PowerShell 嵌套引号**会让整轮队友工作作废
- **现象**（本轮真实发生）：verifier 在 rc.2 复核中反复失败，它自己的原话是「PS 引号导致失败，改用我的 asar-probe」，
  用户侧表现为"子代理命令卡住"。lead 用 `interrupt_agent` 中断了那一轮 → **文件系统无任何损失**，只是该轮作废
  （`test/verify/logs/` 最新日志仍停在更早那份，可用来确认"没有产出"）。
- **根因**：Windows PowerShell 里嵌套引号（外层双引号内再套双引号、或 `$()` 里再套引号）极易被打散，
  轻则命令报错反复重试，重则停在等待输入上。
- **规则（对 lead 与队友一致）**：
  1. 需要跑脚本时**写文件再执行**（`.mjs`），或 `node -e` 用**单引号**包裹整段、内部只用双引号；
     pwsh 里写 `@'…'@` here-string 最稳。
  2. **不要写"一行流"的复杂 pwsh**，尤其不要嵌套引号。
  3. 任何命令 **>60 s 无输出就跳过**并在报告里写"未覆盖（原因）"，**不要重试第三次**。
  4. 症状是"看上去卡住"时，先判断是"阻塞等待"还是"自旋算不动"：看进程 CPU（自旋会累积 CPU，阻塞不会），
     再看队友最后的原话（往往已经写明失败原因）。
  5. 需要中止时用 `interrupt_agent`（保留其待办收件箱），并把"为什么中断 + 换什么写法"讲清楚再让它继续。

---

## 附：证据索引
| 结论 | 位置 |
|---|---|
| GUI 运行时 0.2.0-rc.1 | `E:\DSH\resources\app.asar` → `/dsh/package.json` |
| `settings.section` 现存占用者 | `cordis_inspect_query(client, Slots, listSubTree, root=settings.section)` |
| 无官方 unarchive-sessions 包 | app.asar 全路径检索 0 命中 + 实时插槽无该页 |
| 恢复/归档接口 | `dsh-api-workspace-controller/lib/types/client/service.d.ts:87,126` |
| 归档集合模型 | `dsh-workspace/lib/types/spec.d.ts:36-49` |
| 快照字段 | `dsh-api-workspace-controller/lib/types/client/model.d.ts:9-18` |
| 无删除接口 | 全量 `*.d.ts` grep `deleteSession\|removeSession\|purgeSession`（仅私有 `_deleteSession`） |
| 客户端插件构建契约 | `dsh-client-modules/README.zh.md:34-50` |
| 设置页扩展点 | `dsh-client-ui-settings/README.zh.md:40-42` |
| 示例的 rm 与私有成员依赖 | `dsh-archive-manager-example/src/workspace.ts:1206,1315,1022-1143,1063-1126` |
| 示例的官方条目禁用 | `dsh-archive-manager-example/cordis.patch.yml:9-16` |
| 残留物 | `D:\DSH\dsh-home\storages\session_projcache_archive_manager_v2` |
