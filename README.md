# dsh-archive-manager

> 目标运行时：DSH 桌面端 0.2.x；其他版本未纳入验证范围。

## 项目介绍

DSH 只提供会话的**归档 / 取消归档**：没有删除入口，也没有浏览已归档会话的界面 —— 归档之后想反悔，只能回到会话列表里逐个操作。

本插件在 **DSH 设置面板**里补上「已归档会话」页签：按工作区分组浏览、搜索排序、批量恢复，并把不再需要的归档会话**移入回收站**（可还原，不引入任何不可逆删除）。

实现分两半，两侧共享一份冻结契约：

- **客户端半侧** —— 设置页 UI：使用官方 UI 原子件，数据来自官方会话快照与官方取消归档接口。
- **宿主半侧** —— 注册若干条官方鉴权 `/api` 路由，负责回收站与冷存档的读写。

**不替换、不禁用、不接管任何官方服务。**

## 架构

```
客户端半侧（设置页）
  ├── 数据源：官方 WorkspaceSnapshot（已归档 id + 会话条目，用于工作区分组）
  ├── 恢复  ：官方 ctx.workspaces.unarchiveSession(id)
  └── 删除 / 还原 / 清空：/api/dsh-archive-manager/*   ← 本插件宿主半侧

宿主半侧
  └── 若干条官方鉴权路由（ctx.connection.fetch.register）
        └── 回收站：$DSH_HOME\archive-manager\recycle\<entryId>\ + manifest.json
```

关键取舍：

| 常见做法 | 本项目 | 原因 |
| :-- | :-- | :-- |
| 直接抹掉会话目录 | 整体**移动**到回收站，可还原 | 不可逆删除无法挽回 |
| 禁用 / 替换官方服务，调用其私有成员 | **一行官方服务都不动**，只注册自己的端点 | 依赖私有成员的实现会随宿主升级而崩 |
| 自建调用描述符 + 私有 HTTP 端点 | 官方 `ctx.connection.fetch.register(...)` | 官方定义即「Host 功能拥有的 `/api` 精确路由」，鉴权由官方通道完成 |

宿主侧的**安全边界**（均有反例测试）：id 按**安全字符集 + 有界长度**校验，不含路径分隔符、无 `..` 穿越；id 允许**裸 UUID** 与 **`session-` 前缀**两种真实形态，不作 UUID 假设；`entryId` 先解析、再在回收站内 `readdir` 精确匹配，不拼路径；源目录必须是普通目录（拒符号链接）；还原目标必须落在 `$DSH_HOME\sessions` 之下且恰好两层；运行中或未归档的会话一律整批拒绝；官方服务不可用时 **fail-closed**，绝不静默放行。

## 功能

| 你想做什么 | 在哪里 |
| :-- | :-- |
| 看有哪些已归档会话 | 设置 → 已归档会话 |
| 按工作区查看 | 列表默认按**工作区 / 项目分组**，组头可折叠 |
| 恢复一条 / 一组 / 一批 | 行内「恢复」按钮 / 组头「全部恢复」/ 勾选后底部批量条 |
| 删除（移入回收站） | 行内「移入回收站」按钮 → 官方 `Modal` 二次确认 |
| 搜索与排序 | 顶部搜索框 + 排序下拉（在**组内**生效，零命中的组整组隐藏） |
| 还原误删 | 「回收站」页签 → 行内「还原」 |
| 让出磁盘空间 | 「回收站」页签 → 「清空回收站」（勾选确认）：载荷移交冷存档区，台账保留 |
| 控件与 DSH 同源 | 全部使用官方 UI 原子件（`Button` / `Input` / `Checkbox` / `Pill` / `Modal` / `RiskConfirmation` / `SegmentedTabs` / `PathLabel` / `Tag` / `Tooltip` + 官方图标集），行节奏对齐「通用设置」页 |

### 删除的语义：移入回收站，不抹除

- 「删除」= 把整个会话目录**移动**到 `$DSH_HOME\archive-manager\recycle\<entryId>\`（`<entryId>` 形如 `<movedAtMs>@<sessionId>`），并写入 `manifest.json`：原始路径、`cwd`、字节数、移动时间。
- 「还原」= 按清单移回原路径；原路径越界、父目录不存在、目标已存在都会**拒绝**，而不是猜。
- 「清空回收站」= 勾选确认后把**载荷**（`<entryId>\session\`）移交到 `$DSH_HOME\archive-manager\purged\<批次>\<entryId>\`（冷存档，可人工找回），台账 `manifest.json` 留在回收站原地并记录 `purgedAt` / `purgedBatch`；清空后的条目**不可还原**。
- 本插件**不提供不可逆的物理删除**：全流程只有 `readdir` / `lstat` / `mkdir` / `readFile` / `writeFile` / `rename`。
- `$DSH_HOME\archive-manager\` 是「哪些会话已被处理」的索引：**请勿手工删改**其中的 `manifest.json`。索引一旦丢失，插件就无从得知该会话已被移走，它会以「摘要缺失」的行重新出现在已归档列表里。

## 安装方式

前置：DSH 桌面端可正常使用。下文用 `$DSH_HOME` 指会话与 profile 的根目录，`<插件仓库>` 指本仓库的绝对路径。

**1) 构建**（产出 `lib/index.js` 与 `lib/client.js`）

```powershell
# 在 <插件仓库> 目录下执行
node scripts/build.mjs
```

**2) 安装**（推荐用 DSH 自带的插件管理器）

在 Agent 会话里执行等价的插件管理器调用，它会自动完成 profile 的 `link:` 依赖、`dsh.profile.bundles` 登记与 `pnpm install`：

```
plugin_manager install_bundle target=link:<插件仓库>
```

手动等价做法：

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
"dependencies": { "dsh-archive-manager": "link:<插件仓库>" },
"dsh": { "profile": { "bundles": [ "dsh-archive-manager" ] } }
```

```powershell
# 在 $DSH_HOME/profiles/<profile> 目录下执行
pnpm install
```

**3) 重启 DSH 桌面端**，然后硬刷新页面（`Ctrl+Shift+R`）。

> 为什么必须重启：DSH 进程会缓存已加载的插件模块，**新装的插件（或激活失败过的插件）换不掉旧模块实例**；热补丁只协调配置补丁层，不替换已导入的模块。
