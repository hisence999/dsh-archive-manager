# T5 独立只读复核报告 — `dsh-archive-manager`

> 复核者：`verifier`（只读；写入范围仅 `test/verify/**`）
> 起始：2026-09-29 16:22（Asia/Shanghai），最后更新 17:00
> 本报告状态：**第一/二/三/四阶段 ✅（P17 已闭环）；第五阶段：A1–A7 正式判定表已出（见 §10）——A6 全案可定案，A1 结构部分可定案，其余按「逻辑层通过 / live 待真机」分格**
> 复核脚本现状：`node test\verify\run-all.mjs` → **9 个脚本全部 PASS（exit 0）**（日志：[run-20260929-165941.log](logs/run-20260929-165941.log)）；项目自带测试 `node --test "test/**/*.test.mjs"` → **71/71 通过**；`node scripts\build.mjs` exit 0（`lib/client.js` 29,468 字节）
> **快照纪律**：凡引 `lib/**` 的结论都绑定当次构建时间；判定前必须**先重建** `node scripts\build.mjs`（见 §2 第 4 条、§7）。
>
> ⚠️ **本报告含多轮中间态判定表（§10.1 / §12.2 / §13.5）。唯一有效的终版判定是 §14。**
> 此前出现的 A5「未通过 / 待真机」是**当时的历史实况**（当时确实未通过），与终版不矛盾 —— 终版保留了每一轮的证据与修复时间线。

## 0. 一句话状态

- PLAN.md 的**核心事实基线成立**（路由匹配语义、`/api` 之下 + 官方鉴权、设置页注册写法、bundle 信封、9 项基座表、官方设置页座位、官方无宿主侧会话删除接口），
  且 PLAN 的 P2/P3/P4/P13 漂移**已被 lead 修掉并经我复跑确认**。
- `src/host/**` 的**路径安全与 T6 加固通过**：越界 / 符号链接 / 穿越 / 级联 / 跨卷 / 磁盘零改动 / 归档集合校验 / fail-closed 守卫 / 稳定错误码 均有实现级 + 运行时级证据。
- 我提出的 **P6–P17 全部闭环**：P14（T6 期间我抓到的 500→409）由 host-recycle 修复；P16（`PurgeResponse` 未声明 `failed[]`）由 lead 修；P17（T7 分组原型键丢行，我用运行时探针复现）由 client-page 修复，我 46/46 复核通过。
- **A1–A7 正式判定表见 §10**：**A6 全案可定案**；**A1 结构部分可定案**（视觉待真机）；A2/A3/A4 判为「逻辑层通过 / live 待真机」；A5、A7 的 live 部分留白。**没有任何一格把"待真机"写成通过。**
- 本报告含**两处自我纠正**：
  （§4.6）我一度把「`HOST_ROUTES` 不带 `/api` 前缀」当作契约，实际官方校验器要求**必须带**（注册即失败的门槛）；
  （§2.1）我说过"0.2.0-rc.1 未发布到 npm"，实测 dist-tags 是 `latest=0.1.7-rc.2` + **`next=0.2.0-rc.1`**，且 profile 参照树已升到 0.2.0-rc.1 —— 该说法**不成立**，已更正。

## 1. 复核脚本与复现命令

```powershell
$node = 'D:\DSH\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node test\verify\run-all.mjs                # 汇总运行（6 个脚本；当前 6/6 PASS）
& $node test\verify\redline-scan.mjs           # 红线：全仓无物理删除语义
& $node test\verify\bundle-whitelist.mjs       # bundle 信封 + require 白名单（基座∪external）
& $node test\verify\platform-modules-check.mjs # 基座表 asar(0.2.0-rc.1) vs npm(0.1.7) 双源解析
& $node test\verify\contract-consistency.mjs   # 设置页 id/order、HOST_ROUTES、客户端调用侧、PLAN 漂移
& $node test\verify\host-contract.mjs          # 真跑 host 路由：4 端点/400/409/200/磁盘零改动/守卫 fail-closed
& $node test\verify\client-grouping.mjs        # T7 分组运行时复核（esbuild 内存求值源码，7 类断言）
& $node test\verify\facts-check.mjs            # PLAN 引用行号重放 + 官方删除接口重查
& $node test\verify\tools\asar-probe.mjs <needle> [before] [after] [max]  # asar 只读字节取样
```

这些脚本**刻意不是** `*.test.mjs`，不会混进 `pnpm test`（`test/**/*.test.mjs`）的基线；
`run-all.mjs` 用 `spawnSync(..., { stdio: 'inherit' })`，不使用被沙箱限制的管道捕获。

**证据来源登记**：[host-contract.mjs](host-contract.mjs)（把 `DSH_HOME` 指向 `test/verify/.nonexistent-home-for-verify`，跑完全部 400/409/200 分支后断言该路径**从未被创建**）是 **A5 / 「磁盘零改动不变量」**的正式证据来源；它只读、不建夹具、不写任何文件。

## 2. 方法论注记

### 2.1 证据必须分源标注（lead 确认，我已独立复核）

| 事实 | 我的复核方式 | 结果 |
|---|---|---|
| npm dist-tags：`latest = 0.1.7-rc.2`、**`next = 0.2.0-rc.1`** | `npm view @deepseek-ai/dsh dist-tags`（走 7897 代理） | `{ alpha: '0.1.7-alpha.2', latest: '0.1.7-rc.2', next: '0.2.0-rc.1' }` ✅ |
| 运行中的 GUI = 桌面端内置 **0.2.0-rc.1**（nightly 通道，`app-update.yml`） | asar 内 `"name":"@deepseek-ai/dsh-desktop-runtime","version":"0.2.0-rc.1"` | ✅ |
| 本机全局 CLI = **0.2.0-rc.1**（本次会话期间从 0.1.7-rc.2 升上来的） | `dsh --version`；`npm ls -g @deepseek-ai/dsh` | ✅ `0.2.0-rc.1` |
| **profile 参照树也已是 0.2.0-rc.1** | `.../profiles/node_modules/@deepseek-ai/dsh/package.json` = `0.2.0-rc.1`；其 `dsh-web-frontend/dist/assets/` 现为 `index-Dy0OhsZ5.js`（631,135 字节，与 asar 内同名文件**大小相同、种子表字面量逐字相同**） | ✅ 已从"低版本参照"变为"同版本跨安装交叉验证" |
| ⚠️ **更正**：我早先说"0.2.0-rc.1 未发布到 npm" —— **不成立**（它在 `next` 标签下）；`npm view ... version` 只反映 `latest` 标签 | 同上 | 已据此更正 §0/§2/§3-F5 的措辞 |

1. 凡涉及**运行中宿主行为** → 必须引 `E:\DSH\resources\app.asar`（0.2.0-rc.1），并标注 asar 字节偏移或 needle。
2. 只引 npm 0.1.7-rc.2 的 → 只能作**类型/格式参照**并显式标注版本。
3. 两种来源**不得混用**成一句话结论。
4. **每次复核先重建再读 `lib/**`**：本轮实测 `lib/**` 在 16:27、16:29、16:31、16:32、16:37、16:39 被多次重建；我曾读到旧 `lib` 而得出过期结论（§4.3）。
5. **以官方校验器为准，不以类型注释的字面理解为准**（§4.6 的教训）：`rpc.d.ts:112` 写 "Absolute path below `/api`"，字面可读成"不含 /api 前缀"，但 `assertFetchRoute` + `fetchRoutes.get(url.pathname)` 证明**必须带 `/api/`**。
6. **伪 ctx / 打桩层必须补齐官方会在真实路径上做的校验，否则只能证明"我们自己自洽"**（lead 认可的方法论）：
   `host-contract.mjs` 用伪 `connection.fetch.register` 捕获 route，会**绕过**官方 `assertFetchRoute`；
   因此脚本另行显式断言「注册路径必须 `/api/` 开头」。凡打桩替换掉官方入口的检查，都要列出该入口原本会做的校验并逐条补测。
7. **HMR 与宿主代码热替换：本机未观察到任何可靠手段（我早前的表述已被证伪，17:40 更正）**。
   - 我曾在 §2 写「HMR 对**已成功激活**的宿主 fiber **有效**」，依据是 lead 转述的一次"改 contracts 后仅 build、未重启即删除成功"。
     **该依据已被盘上证据推翻**：用户 17:34:50 点「清空回收站」后，盘上是 **T11 之前**的旧布局（台账被一起搬进 `purged/<批次>/<entryId>/`），而 lead 当时**已经 rebuild 过** → 运行中的宿主**仍在跑旧代码**。
   - 已验证的否证集合：改文件内容无效 / 改 `main` 无效 / `set_bundle`、`set_plugin` toggle 无效 / **rebuild 后亦无效**；官方 `hmr` 只暴露 `runExclusive`/`watchConfig`/`getLinked`，无手动 reload。
   - **结论**：宿主半侧的 live 证据**必须**在"用户重启后"采集；`lib/**` 的变更与运行中行为之间**没有任何保证**。
   - **纪律（为我自己记的）**：**不得把他人转述的观察写成"实测"**。本条早前被我标为"实测补充"，实际只是 lead 的推断。复核报告里的每条结论都必须标明**证据来源与我的独立程度**（★=我自己核的 / ○=引用他人的）。
   - 客户端半侧是否曾靠 HMR 生效：**同样存疑**（也可能只是一次页面重载）；但 A1 的 occupant 快照是**宿主插槽账本**事实，不因 HMR 而失真（见 §10.2）。
8. **产物可能落后于源码**（本轮再次踩到，见 §12.4）：我实测 `src/client/*.tsx`(17:23) 晚于 `lib/client.js`(17:12)，重建前 bundle 里**根本没有** `primitives` 的 require；重建后（39,956 字节）才出现。
   → 任何基于 `lib/**` 的结论，**先 `node scripts/build.mjs`**；项目自带测试同样受此影响。

## 3. 已完成的核验（PLAN.md 事实性）

### F1 `dsh-host-webserver/lib/index.js:322-332` = 精确表优先，其后最长前缀优先 — **通过**
参照版本 0.1.7-rc.2：322 行注释 `Longest-prefix-wins over the prefix table after an exact-table miss.`；324 行 `exact.get(pathname)`；329 行 `prefix.length > best.path.length`。
**跨版本复核（0.2.0-rc.1）**：asar byte `50010501` 处为完全相同实现。补充：前缀命中要求 `pathname === prefix || pathname.startsWith(prefix + '/')`。

### F2 `dsh-client-connection/lib/types/rpc.d.ts:110-129` 的 `ConnectionFetchRoute` — **通过（附 §4.6 的语义澄清）**
112 行 `Absolute path below \`/api\`; query parameters remain available on the request URL.`；118-119 行 `Handle one request after the physical carrier has applied its trust and authentication policy.`；
128 行 `register(route: ConnectionFetchRoute): () => Promise<void>`。→ 「鉴权由官方通道完成」成立；「path 在 `/api` 之下」成立，但**含义是路径本身位于 `/api` 之下、即含 `/api/` 前缀**（见 F10）。
注记：107 行 `ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'`，**无 DELETE**；本插件只用 GET/POST。

### F3 `dsh-client-ui-settings-general/lib/client.js:1167-1177` 的注册写法 — **通过**
`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id: "general", order: 0, label: () => t("general.nav"), locale: NS, children: {...} }, GeneralSection))`，`label` 是 **thunk**；0.2.0-rc.1 asar 内同款。

### F4 客户端 bundle 信封 `window.__ModuleLoader__.load({ id, factory })` — **通过**
0.2.0-rc.1 asar 内出现 **78 次**；本项目 [lib/client.js](../lib/client.js) 同款，factory 返回 `{ apply, inject }`。

### F5 `PLATFORM_MODULES` 基座表 — **通过（双源解析）**
用锚点（`"react/jsx-runtime":` → `return{` → 花括号配平）从**真实产物**解析：

| 来源 | 文件 | 结果 |
|---|---|---|
| 运行中 GUI **0.2.0-rc.1** | `app.asar` → `dist/assets/`**`index-Dy0OhsZ5.js`** | 9 键，与声明完全一致 |
| npm **0.1.7-rc.2**（参照） | `.../dist/assets/`**`index-Q6zc2uHV.js`** | 9 键，与声明完全一致 |

9 键 = react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit。
PLAN 10.1 曾把来源写成 npm 的那个文件名（P2），**lead 已修**（PLAN:348-349 现明确标注 0.2.0-rc.1 与 0.1.7 两个文件名的对应关系），我复跑 `facts-check.mjs` 确认 PASS。
备注：`@deepseek-ai/dsh-client-locale` **不在**基座表内（T2 因此走 `ctx.locale` 服务而不 import，见 [src/client/index.ts:12-16](../src/client/index.ts#L12-L16)）。

### F6 官方是否真的没有「会话删除接口」 — **通过（措辞需限定）**
- 参照版本 0.1.7-rc.2：全量扫描 **1985 个 `*.d.ts`**，`deleteSession|removeSession|purgeSession` 的**公开**命中 **0**；唯一命中 `dsh-session-query-sqlite/lib/types/index.d.ts:106 private _deleteSession;`。
- 0.2.0-rc.1 asar：`removeSession` / `purgeSession` / `unarchive-sessions` **各 0 次**。
- ⚠️ 反例：asar 内 `deleteSession` 命中 **14 次**，全部属 **Agent 协议**层（`AGENT_METHODS.session_delete === "session/delete"`，由外部 agent 的 `sessionCapabilities.delete` 门控）；另 `_deleteSession` 5 次属 sqlite 索引。
- 判定：**「恢复走官方、删除必须自建宿主半侧」成立**；PLAN 2.2「完全不存在」应按 P5 限定为「DSH 自身会话存储/归档集合没有删除接口」。

### F7 设置页官方座位 — **通过**
0.2.0-rc.1 asar 内逐一命中 `account(-10)`（**仅已登录时注册**）、`general(0)`、`models(10)`、`plugins(15)`、`agent-presets(20)`。
运行时真跑 [lib/client.js](../lib/client.js) 捕获实参 = `{id:"archive-manager", order:25, label:"function"(thunk)}`，`25 > 官方最大 20` 且 id 不冲突 → 纯增量成立。

### F8 红线：全仓无物理删除语义 — **通过（快照）**
范围 `src`/`scripts`/`test`/`lib` + `package.json`/`cordis.patch.yml`/`tsconfig.json`（跳过 `node_modules`/`.git`/`.tmp`/`backups`，**绝不读 `memory/`**，AGENTS A5）：产品代码 **0 命中**。
WARN 均为**文本自命中**（如 `test/host.test.mjs:530-539` 的禁止模式列表、本报告自身描述），已逐条判读为无害；脚本先剥注释再匹配，故纪律声明注释不误判。

### F9 P1（`inject` vs `external`）修正复核 — **通过**
[test/build.test.mjs:74-86](../test/build.test.mjs#L74-L86) 白名单已改为「基座 ∪ `dsh.client.external`」；官方实证 `dsh-api-workspace-controller/package.json:44-54` 同时用 `external: ["@deepseek-ai/dsh-api-gateway/client"]`（**子路径**）与 `inject: [...]`。

### F10 宿主端点 `path` 的官方约束（**T6 期间双方共同确认，我双源验证**）— **通过**
- 官方校验：`assertFetchRoute(route)` → `if (endpointFromPath("/api", route.path) === void 0) throw new Error("connection: invalid exact Fetch route …")`；
  而 `endpointFromPath(channel, pathname)` 首行是 `if (!pathname.startsWith(`${channel}/`)) return void 0;` → **`path` 必须以 `/api/` 开头**，且每段匹配 `[A-Za-z0-9_$.-]+`。
- 官方分发：`this.fetchRoutes.get(new URL(request.url).pathname)`、`route?.methods.has(request.method) === true` → **完整 pathname 精确匹配**（含 `/api`），注册串必须与请求串完全相同。
- 证据：运行中 0.2.0-rc.1 asar byte `18559155`（assertFetchRoute）、`18553666`（fetchRoutes.get）；参照版本 0.1.7-rc.2 `dsh-client-connection/lib/index.js:711-716,758-762`。
- 落地：`HOST_ROUTES` 现为 `/api/dsh-archive-manager/{list,recycle,restore,purge}`（[src/contracts.ts:27-56](../src/contracts.ts#L27-L56)），`CLIENT_API_PREFIX` 降级为空串过渡别名；客户端直接 `postJson(HOST_ROUTES.recycle, …)`。
- **教训**：早前版本用不带 `/api` 的路径——那会在注册时**抛错、插件激活失败**。我的 `host-contract.mjs` 用伪 ctx 绕过了官方 `assertFetchRoute`，因此我**补了一条显式断言**（注册路径必须 `/api/` 开头），避免检查假绿。

## 4. `src/host/**` 路径安全与 T6 加固复核

### 4.1 通过项（实现级 + 测试级/运行时级证据）

| # | 检查 | 证据 |
|---|---|---|
| G1 | **无物理删除语义**：只 import `lstat/mkdir/open/readdir/readFile/rename/writeFile`；默认移动 = `rename`；purge 也是**移交**到 `purged/<batch>/` | F8 红线 0 命中 + `test/host.test.mjs` 自带守卫 |
| G2 | **`sessionId` 从不拼路径**：`isSessionId`（UUID）→ `readdir(sessionsRoot)` **精确名字比对**，歧义拒绝 | `test/host.test.mjs` 反例集（`../../etc/passwd`、`..\\..\\Windows`、`C:\\Windows\\System32`、非 UUID…） |
| G3 | **`entryId` 从不拼路径**：`parseEntryId` 形态校验 → `findEntryDirectory` 精确名字比对 | 同上 |
| G4 | **符号链接一律拒绝**（源目录 / 回收站条目 / slug；统计不跟随） | `test/host.test.mjs` 用 `symlink(..., 'junction')` 造真反例 |
| G5 | **还原目标严格限界**：`relativeInside`（拒 `..`/绝对/跨盘）+ `relativeSessionPath`（**恰好** `sessions/<slug>/<sessionId>` 两段、末段=sessionId） | `test/host.test.mjs`「originalPath 越界/层级不对 → 拒绝」 |
| G6 | **400/409 磁盘零改动** | `test/verify/host-contract.mjs`（断言 fake home 从未被创建）+ `test/host.test.mjs` 目录快照 |
| G7 | **不做跨会话级联**（`delegationDepth > 0` 拒绝并提示） | `test/host.test.mjs` |
| G8 | **跨卷 EXDEV 拒绝，不做「复制+删源」兜底** | `test/host.test.mjs` 真造 `rename` 跨卷失败 |
| G9 | **purge 二次确认**（`confirm !== true` → 400） | `test/host.test.mjs` |
| G10 | **稳定错误码**：`{code, message, ids?}`；`invalid-input`→400、`session-live`/`session-not-archived`→409、`internal`→500 | `test/verify/host-contract.mjs` 复跑 PASS |
| G11 | **T6 归档集合校验（P7）**：`ctx.get('workspaceRegistry')?.archivedSessionIds`；不在集合 → 409 `session-not-archived` + `ids`；服务/状态不可用 → 500 fail-closed 并点名服务 | 运行时实测（`host-contract.mjs` 输出探测行） |
| G12 | **T6 fail-closed 守卫（P8）**：`sessions` 不可用 → 500，不静默放行 | 运行时实测 |
| G13 | **T6 逐条 `failed[].code`（P12）** | 运行时实测：200 + `failed[0].code` 非空 |
| G14 | **T6 restore 与 recycle 对称 409（P9）** | 运行时实测：restore + 运行中 → 409 `session-live` |
| G15 | **T6 purge 只移交普通目录（P6）**：符号链接/非目录 → `failed[]` + `path-unsafe` 且**原地保留**；`batch.json` 记 `skipped` 审计 | 源码 [recycle-store.ts:585-602,627](../src/host/recycle-store.ts#L585-L602)（符号链接夹具按 lead 裁决留在 T3 测试） |
| G16 | **T6 回收站根目录提前创建（P10）**：在任何移动之前一次创建，失败即 500 且零改动 | 源码 |
| G17 | **T6 restore rename 失败映射（P11）**：`entry-conflict` / `entry-not-found`，不再一律 `internal` | 源码 |

### 4.2 发现项与闭环状态

| # | 严重度 | 问题与最终状态 | owner |
|---|---|---|---|
| **P6** | 中 → **已修** | `purge()` 原把符号链接也当条目移交（`isDirectory() \|\| isSymbolicLink()`），与 list/restore 策略不一致。现改为只移交 `isDirectory() && !isSymbolicLink()`，其余进 `failed[]` + `path-unsafe` 并原地保留 | host-recycle |
| **P7** | 中（A5 相关）→ **已裁决并落地** | 宿主原不校验"会话是否已归档"。**裁决**：`ctx.get('workspaceRegistry')` 校验 id ∈ `archivedSessionIds`；不在 → 整批 409 + `session-not-archived` + `ids`；服务不可用 → 500 `internal` 点名服务（不静默放行）。我双源核实服务名 `super(ctx, "workspaceRegistry")`（asar byte 66983533）与同步 getter `get archivedSessionIds()`（asar byte 66989691；npm 参照 `dsh-workspace/lib/types/index.d.ts:189-195`） | lead 决策 / host-recycle |
| **P8** | 中 → **已修** | 运行中守卫原 fail-open（服务缺失静默放行）。现 `sessions` 不可用 → 500 fail-closed | host-recycle |
| **P9** | 低 → **已修** | restore 原无整体预检（运行中只进 `failed[]` → 200）。现与 recycle 对称 → 409 | host-recycle |
| **P10** | 低 → **已修** | `mkdir(recycleRoot)` 原未包 try、失败会丢掉已移入的 `moved` 列表。现提前创建、失败即 500 且零改动 | host-recycle |
| **P11** | 低 → **已修** | restore 的 rename 失败映射到 `entry-conflict`/`entry-not-found` | host-recycle |
| **P12** | 中 → **已修** | 6 个 `HostErrorCode` 原永不出现（`Failure` 无 `code`）。现 `Failure = { id; code: HostErrorCode; message }`（contracts.ts:67-73），store 全分支接线 | lead / host-recycle |
| **P13** | 低 → **已修** | PLAN §5.2 已补 `{code,message,ids?}` 错误体与 `HostErrorCode` 说明 | lead |
| **P14** | **中（T6 期间我抓到）→ 已修** | `statusOf` 未映射新码，导致"未归档"返回 **500**（裁决要求 409）。证据：源码 `routes.ts:50-54` 只有 `invalid-input`/`session-live`；运行时 `POST /recycle` 未归档 UUID → 500 + 正确的 `code/ids`。**host-recycle 已修**，我复跑 `host-contract.mjs` → PASS（409 + code + ids 全绿） | host-recycle |
| **P16** | 低 → **已闭环（lead 已修，我复核）** | **`PurgeResponse` 契约空档**：store 的 `PurgeOutcome extends PurgeResponse` 在**所有**分支都返回 `failed[]`（recycle-store.ts:577-583,630），HTTP 响应因此总带 `failed`。**lead 已把 `failed?: Failure[]` 并入契约**（[contracts.ts:144-147](../src/contracts.ts#L144-L147)，附"否则用户会以为已清空"的裁决理由）→ A4 的 purge 判定**可按契约字段**记录 | lead（已闭环） |

### 4.3 中间态时间线（实证"读旧 `lib` 会得出过期结论"）

| 时刻 | 事件 |
|---|---|
| 16:30:29 | `src/contracts.ts` 新增 `HostErrorCode`/`ErrorResponse` |
| ~16:30 | 我的 `host-contract.mjs` 首次运行（`lib` 16:29:41、routes 16:27:24）→ **FAIL 10 项：4xx 缺 `code`** |
| 16:31:20 / 16:31:51 | routes 跟上；`lib` 重建 → 我复跑 **PASS** |
| 16:34-16:39 | T6 全面落地；`lib` 又重建两次 |
| 16:39 | P14 修复（`session-not-archived` → 409）；我复跑 `host-contract.mjs` **PASS** |
| 16:41-16:42 | 我修正自身脚本的 4 处缺陷后，`run-all.mjs` → **6/6 PASS（exit 0）** |

### 4.4 语义观察（非缺陷，已由 lead 确认）

recycle 中**归档集合校验先于运行中校验**（routes.ts:179-192）："既未归档又在运行"的会话得到 `session-not-archived`。
lead 确认为**有意优先级**（"没归档"比"在运行"更本质），并要求 T3 用专门用例锁住。

### 4.5 T6 运行时复核结果（`host-contract.mjs`，全绿）

| 目标 | 运行时证据 | 结果 |
|---|---|---|
| P7 registry 校验 | 未归档 UUID → **409** `session-not-archived` + `ids` | ✅ |
| P7 registry fail-closed | `workspaceRegistry` 不可用 → **500** `internal`，文案点名 `workspaceRegistry` | ✅ |
| P8 sessions fail-closed | `sessions` 不可用 → **500** `internal`，文案点名 sessions | ✅ |
| P12 `failed[].code` | 已归档但工件不存在 → 200，`failed[0].code` 非空 | ✅ |
| P9 restore 对称 | restore + 运行中 → 409 `session-live` | ✅ |
| 400 家族 | 空体 / 坏 JSON / 非数组 / 空数组 / 非 UUID / 超 `MAX_BATCH` / 非法 entryId / 缺 confirm → 全部 400 `invalid-input` | ✅ |
| 路由形态 | 4 条 `path` 均以 `/api/` 开头、方法正确、`requestBody: 'buffered'` | ✅ |
| **磁盘零改动** | 跑完全部分支后 `test/verify/.nonexistent-home-for-verify` **从未被创建** | ✅ |
| P14 | 未归档 → 409（修复前是 500） | ✅ 已闭环 |

**本轮未复核的 T6 细节**：P6 的符号链接 purge、P10 的 mkdir 失败注入、P11 的 rename 错误映射——这些需要符号链接/失败注入夹具，按 lead 裁决留在 `host-recycle` 的 `test/host.test.mjs`（我用只读方式复核其断言与源码路径）。

### 4.6 自我纠正与脚本自身缺陷修复（保留记录，避免"复核者也犯错却看不出来"）

1. **`HOST_ROUTES` 前缀（重要）**：我早先按 `rpc.d.ts:112` 的字面理解，断言"`HOST_ROUTES` 不该带 `/api` 前缀"，并据此把 T2/T6 把前缀加进常量的改动标记为可疑。
   **推翻依据**：`assertFetchRoute`（asar byte 18559155）要求 `endpointFromPath('/api', path)` 非空 ⇒ `path.startsWith('/api/')`；分发用 `fetchRoutes.get(new URL(request.url).pathname)`（asar byte 18553666）⇒ 必须是完整 pathname。
   **结论**：**带 `/api/` 前缀才是正确的**；旧写法会在注册时抛错、插件激活失败。我已把 `contract-consistency.mjs` 的规则改成官方口径（并在 `host-contract.mjs` 补断言，因为伪 ctx 绕过了官方校验）。
2. **注释误命中**：`contract-consistency.mjs` 原用未剥注释的文本检查"硬编码 URL"，把 [ArchivedSessionsSection.tsx:12](../src/client/ArchivedSessionsSection.tsx#L12) 文件头注释里的路径误报为硬编码。现改为先剥注释；客户端调用侧的口径也改为**整组文件**联合判定（`postJson` 定义与调用点在不同文件）。
3. **伪 ctx 缺 `ctx.effect`**：T2 的 `registerLocales` 用 `ctx.effect`，我的伪 ctx 未提供 → 误报 `apply() 抛错`。已补 `effect`/`logger`。
4. **`facts-check.mjs` 的资产名判定**：原断言"asar 不含 `index-Q6zc0HV.js` 就是 MISMATCH"，PLAN 修好 P2 后变成假阳性。现改为**按 asar 真实资源名反向比对 PLAN 引用**。
5. **`facts-check.mjs` 私有/公开删除接口**：原 `text.includes(pattern)` 会把 `private _deleteSession;` 误判为公开命中；现用词边界正则 `(?<![_\w])(deleteSession|removeSession|purgeSession)\b`。
6. **`redline-scan.mjs`**：修过两处 —— 跳过脚本自身、先剥注释再匹配。

## 5. 文档漂移（P2/P3/P4/P13 已由 lead 修掉，我复跑确认）

| # | 内容 | 状态 |
|---|---|---|
| P2 | PLAN 10.1 基座表来源文件名跨版本错位 | **已修**（PLAN:348-349 标注两版本），`facts-check.mjs` PASS |
| P3 | PLAN 5.2 `entryId` 写成 `${movedAt}__${sessionId}` | **已修**（PLAN:211 现为 `<movedAtMs>@<sessionId>`），`contract-consistency.mjs` PASS |
| P4 | PLAN 5.1 的 `inject` 清单含 package.json 未声明的包 | **已修**；另 `bundle-whitelist.mjs` 确认 bundle 只 require 基座 `react/jsx-runtime` |
| P5 | PLAN 2.2「删除会话完全不存在」措辞 | **建议保留限定**（F6 反例）；PLAN 已按 P5 限定 |
| P13 | PLAN §5.2 未含稳定错误体 | **已修**（PLAN:202 起） |
| P16 | `PurgeResponse` 未声明 `failed[]` | **仍敞开**（§4.2） |

## 6. 待核验清单 A1–A7（**全部未覆盖**）

阻塞：T2 真机页（`lib/client.js` 已是 T2 产物但未真机安装）与 T4（安装进 desktop profile + 冒烟）未完成。

| # | 验收项 | 状态 | 我要求的证据 |
|---|---|---|---|
| A1 | 设置页出现「已归档会话」、风格与邻居页一致 | **未覆盖** | 真机深浅色截图 + 实时插槽查询证明 `archive-manager` 与官方 5 项并存 |
| A2 | 列出全部已归档会话 | **未覆盖** | 与 `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds` **逐条集合对照** |
| A3 | 单条/批量恢复、行消失、回原位置 | **未覆盖** | 前后 `archivedSessionIds` 快照 + diff + 侧栏可见性；部分失败语义 |
| A4 | 删除成功且不可逆丢失为 0 | **未覆盖** | 回收站 + `manifest.json` + 还原后 **sha256 字节级一致**；purge 后 `purged/<batch>/` 仍在 |
| A5 | 删除后官方侧栏无坏行、无报错 | **未覆盖** | 归档筛选开/关截图 + 宿主日志无 error + `workspace.json` 无坏 id；宿主侧兜底已由 P7 落地，另以 [host-contract.mjs](host-contract.mjs) 作「磁盘零改动不变量」证据来源 |
| A6 | 全程无物理删除语义 | **部分覆盖** | 静态红线 PASS（F8）+ 运行时零改动 PASS；缺真机端到端复验与最终版重跑 |
| A7 | 深浅色/中英/字号跟随宿主 | **未覆盖** | 三连切换截图；静态：组件仅用 `var(--dsw-*)` 令牌（[ArchivedSessionsSection.tsx:40-61](../src/client/ArchivedSessionsSection.tsx#L40-L61)），需在真机确认令牌族与宿主一致 |

> A1/A2 相关的两项客户端预审已见 §9：**空态可达性**（官方前提已双证据核实、修复已被渲染测试锁住）✅；
> **T7 分组的四项复核点**已用运行时探针覆盖，其中兜底不丢数据被 **P17（原型键丢行）** 打破 ❌。
> 二者都不改变 A1–A7 的「未覆盖」判定（真机仍未触发）。

**第二阶段要主动构造的反例**：重复/并发同 id 调用（幂等）、**未归档但空闲的会话被移走**（P7 已由守卫挡住，仍需真机验证）、A5 侧栏坏行。
夹具分工（lead 已裁决）：需要建目录/符号链接的反例留在 `host-recycle` 的 `test/host.test.mjs`；我在 `test/verify/**` **只做只读探测，不建夹具、不删除**。

## 7. 未覆盖 / 已知限制（不得当作通过）

1. **A1–A7 全部未判定**（见 §6）。
2. 引 `lib/**` 的结论绑定构建时刻；判定前必须 `node scripts\build.mjs` 后整体复跑。
3. 真机（浏览器/桌面端）行为**未触发**：本阶段证据为静态/类型/字节级 + 宿主路由的进程内运行时调用。
4. `test/host.test.mjs` 的 `mkdtemp` 夹具**不做清理**（无删除语义，符合 A2）→ OS 临时目录会留有残留，属已知取舍。
5. `memory/` 未读取（AGENTS A5）；`backups/`、`.tmp/`、`node_modules/` 不在红线扫描范围。

## 8. 复核脚本自身可信度

- 6 个脚本当前全绿（`run-all.mjs` exit 0，日志 [run-20260929-164211.log](logs/run-20260929-164211.log)）；脚本缺陷修复史见 §4.6。
- `host-contract.mjs`：`DSH_HOME` 指向 `test/verify/.nonexistent-home-for-verify`，结束时断言该路径**从未被创建**；并按「分别探测 P7 / P8 守卫」自动识别 pre-T6 / T6，未落地的契约记 `PENDING` 而非 FAIL。
- 残余风险：剥注释器不区分模板字符串/正则字面量内的 `//`，可能漏报注释形态的删除调用（不影响方向性判定）；字符串里的 `rm -rf` 仍会命中（宁多报不漏报）。
- **本报告的判定边界**：静态与进程内运行时证据充分，但**真机行为一律未覆盖**；凡未验证项均标注「未覆盖」，不会写成通过。

## 9. T2 客户端 / T7 分组 复核（第四阶段，进行中）

### 9.1 空态 bug（lead 报告）— **官方前提我已核实，修复已落地并被测试锁住**

- **官方前提（双证据）**：`WorkspaceSnapshot` 同时有
  `state: 'idle' | 'loading' | 'error'`（**没有 `'ready'`**）与 `phase: 'pending' | 'ready'`
  —— npm 参照 `dsh-api-workspace-controller/lib/types/client/model.d.ts:7,15-16`；
  运行中 0.2.0-rc.1 asar 内类字段 `state = "loading"; phase = "pending";`（byte **17431321**）、
  基线安装后 `this.state = "idle"; this.phase = "ready";`（byte **17438220**）。
  → 「就绪」必须看 `phase`，只看 `state` 会把「已就绪且归档为空」当成加载中（空态不可达）。
- **修复**：[useArchivedSessions.ts:452-472](../src/client/useArchivedSessions.ts#L452-L472) 新增 `resolvePhase()`：
  `error → 'error'`；`phase === 'ready' → 'ready'`；`state === 'loading' || phase === 'pending' → 'loading'`；其余（含 `phase` 缺失的老快照/测试桩）→ `'ready'`（避免永久转圈）。
- **测试锁定（我读过断言内容，判定为强）**：`test/client-render.test.mjs:136-146`
  用真实快照形状 `{state:'idle', phase:'ready'}` 断言渲染出 `state.empty.title`；
  `:148-158` 反向断言 `{state:'loading', phase:'pending'}` 渲染 `state.loading`。
- **时间线（快照纪律的又一例）**：16:43 我跑全量测试时该项**失败**（`client-render.test.mjs:145`）；16:45 复跑即 **57/57 全绿**——修复在这两分钟之间落地。
  → 我记录的是修复后的状态，并把那次失败作为"必须在判定前重跑"的实证。

### 9.2 P17（我发现的运行时缺陷）— **已闭环**：client-page 修复，我 46/46 复核通过

- 机制：[useArchivedSessions.ts:172-186](../src/client/useArchivedSessions.ts#L172-L186) 的 `buildWorkspaceIndex` 返回**普通对象** `{}`；
  [groupRowsByWorkspace:216](../src/client/useArchivedSessions.ts#L216) 用 `index[row.id] ?? UNASSIGNED_GROUP_ID` 取分组。
  当 `row.id` 是 `toString` / `constructor` / `valueOf` / `hasOwnProperty` / `__proto__` 时，`index[row.id]` 命中 `Object.prototype` 上的成员（**真值**），
  `??` 兜底不触发 → 该行被塞进一个**没有 meta 的组** → 渲染循环按 `items` 顺序遍历，永远取不到它 → **整行从 UI 消失**，违反 T7 明确的「兜底组**绝不丢弃**」不变量。
- **运行时复现（我写的探针，独立于实现者）**：`node test\verify\client-grouping.mjs`
  ```
  前置：buildRows 只要求"非空字符串"，因此这类 id 能进到分组层
  FAIL 原型键 id "toString" 不丢行（必须落进兜底组） —— 组=[]
  FAIL 原型键 id "constructor" … 组=[]
  FAIL 原型键 id "__proto__" … 组=[]
  FAIL 原型键 id "valueOf" … 组=[]
  FAIL 原型键 id "hasOwnProperty" … 组=[]
  ```
  即 `groupRowsByWorkspace(buildRows(['toString'], {}), [])` 返回 `[]`，而期望是「一条兜底组」。
- **可达性评估**：真实链路里 `archivedSessionIds` 由宿主给出（UUID），因此**当前不易触发**；但
  `buildRows` 的入参校验只要求"非空字符串"，分组层的契约又是"绝不丢弃"，属**潜伏的健壮性缺陷**；且 `index['__proto__'] = wsId` 还构成原型污染写入面。
- **最小修复建议**（一行）：`const index: Record<string, string> = Object.create(null);`
  或改判定为 `Object.prototype.hasOwnProperty.call(index, row.id) ? index[row.id] : UNASSIGNED_GROUP_ID`；
  更稳的是把 `buildWorkspaceIndex` 的返回值改成 `Map<string,string>`。
- **owner**：`client-page`（`src/client/**`）。我已附复现命令通知。

### 9.3 T7 四项复核清单（lead 指定）— 运行时结果

| lead 指定的复核点 | 我的运行时断言 | 结果 |
|---|---|---|
| 分组映射正确性 | 2 个工作区按 `items[].sessionIds` 正确归组；组顺序 = 官方 `items` 顺序；`title`/`path` 已 trim | ✅ |
| 零命中组隐藏 | `sessionIds` 为空的工作区**不产生组**；`filterGroups`/`buildGroups` 零命中时返回空数组（无空组头） | ✅ |
| 兜底组不丢数据 | 未被任何 `sessionIds` 认领的 id 落 `__unassigned__` 且排最后；**所有组行数之和 = 输入行数**；同一行不重复出现 | ✅（除 P17 的原型键路径） |
| 跨组选择 | `groupsRowIds` 覆盖全部组并按「组顺序 × 组内顺序」；`normalizeSelection` 按列表顺序规范化并剔除不存在的 id | ✅ |
| 附加：重复归属 | 同一 id 出现在两个工作区时**先到先得**，且不重复计入 | ✅（确定性已文档化） |
| 附加：畸形 views | `null`/`[]`/空 workspaceId/非数组 `sessionIds`/非字符串项/缺 sessionIds → 不抛错、不丢行 | ✅ |
| 附加：`items` 缺失 | 全部落兜底组 | ✅ |
| 附加：原型键 id | 见 P17 | ❌ |

`client-grouping.mjs` 结果：**46 项断言全部 PASS**（含 P17 修复后的 9 条新断言、`resolvePhase` 12 条）。

### 9.4 P17 修复的独立复核（不止"让探针闭嘴"）

我读了修复后的实现，确认机制正确、且**没有为了讨好探针而牺牲形状**：

| 修复点 | 实现 | 我的独立断言 |
|---|---|---|
| 索引累积 | `buildWorkspaceIndex` 内部改用 `Map` 累积，出口 `Object.fromEntries(owned)`（`useArchivedSessions.ts:190-205`） | `index` 把 `"__proto__"` 存成**自有数据键**；`Object.getPrototypeOf(index) === Object.prototype`（**无原型污染**）；不自带多余原型键属性 |
| 归属取值 | `ownedIndexOf()` 用 `hasOwnProperty.call`（:212-214） | 被认领的原型键 id 正确归组；没人认领的落兜底组；**行数守恒** |
| 摘要取值 | `ownedSummary()`（:77-83）——`buildRows` 不再用 `byId?.[id]` | 空 `byId` 下 `id='toString'` 必须 `missingSummary === true`（原型成员不得冒充摘要）；`byId` 里**真有** `__proto__` 自有键（用 `JSON.parse` 构造）时被正确采用且 title 已 trim |
| 工作区 id 也是原型键 | `meta`/`buckets` 均为 `Map` | `workspaceId === '__proto__'` 时仍能成组 |

### 9.5 `resolvePhase()` 的独立判定（lead 点名要求，尤其"phase 缺失时的兜底方向"）

官方语义（双源取证）：字段初值 `state='loading' + phase='pending'`（asar byte **17431321**）；基线安装后 `this.state='idle'; this.phase='ready'`（asar byte **17438220**）；`state='loading'` 的**唯一运行时迁移点**是 `handleCarrierFailure()`（asar byte **17439476**，只置 state、**不动 phase**）。

12 条断言全部通过，关键结论：
- `idle + ready` → `ready`（真实就绪）✅；`loading + pending` → `loading` ✅；`error` 优先于 `ready` ✅。
- **`phase` 缺失时方向安全**：`{state:'idle'}` → `ready`（不永久转圈），`{state:'loading'}` → `loading`（不因缺字段而误判就绪）——两个方向都对，没有"用缺省值掩盖真实加载中"的风险。
- `loading + ready` → `ready`：这不是臆造的组合，正是**断线重连窗口**（`handleCarrierFailure` 只置 `state='loading'`，`phase` 保持 `'ready'`）；官方注释明确"Keep the last complete projection visible while a lost carrier reconnects"，按 ready 处理与官方意图一致 ✅。

### 9.6 对 lead 新增测试与脚本的审计（找假绿）

| 对象 | 我的审计结论 | 具体证据 / 我补的防守 |
|---|---|---|
| `test/style.test.mjs` | **无硬编码配色部分可靠**；**"只用 `--dsw-*` 家族"存在盲点**：只查族名、**不查令牌是否真实存在**，把 `--dsw-alias-bg-layer-2` 拼错成 `--dsw-layr-2` 时该守卫仍全绿，而浏览器只是静默不生效 | 我新增 [theme-tokens.mjs](theme-tokens.mjs)：从 asar 抽官方 **419** 个 `--dsw-*`，与插件实际使用的 **18** 个逐一比对 → 0 个不存在（当前无实际缺陷，但守卫已补上） |
| `test/client-render.test.mjs`（8 条） | **未发现假绿**：`sectionProps` 造的快照形状与官方类型逐字一致 —— `WorkspaceSnapshot{items, archivedSessionIds, pinnedSessionIds, state, phase, error}`（`model.d.ts:9-18`）、`SessionListState{ids, byId, phase, projectionsBySession}`（`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:43-52`）、`SessionSummary{title?,cwd?,running,updatedAt,...}`（同文件 :16-38；插件用到的字段都存在） | 两条新分组断言（:196-213 两个工作区各自成组+条数；:215-229 兜底组不丢行）我读过，断言实质有效 |
| `scripts/check-routes-against-host.mjs`（lead 写） | **方法成立**：确实从 asar 读出该条目并按 asar 头部格式定位 offset，`new Function` 隔离作用域重建，无全局泄漏；只校验 `assertFetchRoute`，不覆盖分发（我已另行在 asar 内确认 `fetchRoutes.get(new URL(request.url).pathname)` 精确匹配） | **缺负控**是它唯一的假绿风险：若抽取失败或抽错函数，它只会"全 PASS"。我新增 [host-validator.mjs](host-validator.mjs)：① 抽取完整性锚点断言；② 负控（旧写法 `/dsh-archive-manager/list`、`..`、空段、非法字符、查询串、仅 `/api`、空串、空/重复 methods **必须被拒**）；③ 正控 4 条 ✅ |
| 双前缀 `/api/api/...` | **意外发现**：官方 `assertFetchRoute` **不拒**双前缀，只把它解析成 `api/dsh-archive-manager/list` → 注册成功但真实请求 404（**静默失效**） | 我把这条从"负控"改成 OBSERVE，并靠在 `contract-consistency.mjs` 的契约层断言 `CLIENT_API_PREFIX === ''` 拦截 |

## 10. 正式 A1–A7 判定表（2026-09-29 17:00）

### 10.0 判定前的状态与证据来源（严格标注）

| 信号 | 状态 | 来源与我的独立程度 |
|---|---|---|
| 客户端半侧 live 注册 | `settings.section` occupants = 官方 `account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)` **原样** + `archive-manager(25) active:true` | **lead 抓取的 16:48 实时插槽快照**。我**未能独立复现**：client 侧 Inspect 查询需等页面响应，HMR 重载期间会挂起（我亲历一次被取消），lead 已要求停用该工具 |
| 宿主半侧 live | `include:archive-manager` = `fiberPhase:"failed"`（同一份旧栈），4 条 `/api` 路由**尚未注册** | lead 的 `plugin_manager` 观测。我自己也调过该工具，但返回 200 条中的前 50 条、未覆盖到 archive-manager，故这一格**引用 lead 观测** |
| 我的独立证据 | 9 个只读脚本全 PASS；项目测试 71/71；build exit 0 | 全部可复现（命令见 §1） |

### 10.1 判定表

| # | 验收项 | 判定 | 已到手的证据 | 仍待真机 |
|---|---|---|---|---|
| **A1** | 设置页出现「已归档会话」，样式与邻居页一致 | **部分通过**：结构 ✅ / 可渲染 ✅ / **视觉待真机** | lead live 快照（occupants 含 `archive-manager(25) active:true`、官方 5 项未被顶替）；`contract-consistency.mjs` 真跑 bundle 捕获 `{id:'archive-manager', order:25, label:"function"}`，`25 > 官方最大 20`、id 不冲突；`node --test` 71/71 含空态/列表/分组/兜底/无数据源四类渲染；`theme-tokens.mjs` 18/18 令牌存在 | 深浅色下与邻居页的视觉一致性（人眼）；重启后复查同一 occupant 查询 |
| **A2** | 列出全部已归档会话 | **逻辑层通过 / live 待真机** | 数据源 = `WorkspaceSnapshot.archivedSessionIds`（官方 registry 全局集合，`model.d.ts:12`）；`buildRows` 保持宿主顺序、去重、**保留缺摘要行**（我运行时断言 5 条含 2 条缺摘要全部保留）；渲染测试断言缺摘要行仍在列表 | 与 `$DSH_HOME\storages\workspace.json` 的 `archivedSessionIds` **逐条对照**（页面已 live，需人眼） |
| **A3** | 单条/批量恢复、行消失、回原位置 | **逻辑层通过 / live 待真机** | 恢复走官方 `props.workspaces.unarchiveSession(id)`（`src/client/index.ts:44` inject 工厂回填）；逐条串行、部分失败分开上报；渲染测试覆盖"组内全部恢复" | id 真的退出归档集合、侧栏可见、**回到原位置** |
| **A4** | 删除成功且不产生不可逆丢弃 | **逻辑层通过 / live 待真机（需重启）** | `host-contract.mjs` 进程内真跑 4 路由（400/409/200、`session-not-archived`、`failed[].code`、purge 二次确认、**磁盘零改动不变量**）；`test/host.test.mjs` 24/24（移交语义、EXDEV 拒绝 copy+delete、purge 符号链接原地保留） | 宿主 fiber 需重启变为 `active`；真机"删除→回收站→还原 sha256 一致" |
| **A5** | 删除后官方侧栏/主列表无坏行、不报错 | **待真机（需重启）** | 结构性降险已到位：宿主**强制**"必须已归档"（P7 → 409 `session-not-archived`），不会把未归档会话搬走 | 坏行是**真机现象**：归档筛选开/关各一次 + 宿主日志无 error + `workspace.json` 无坏 id |
| **A6** | 全程无 `rm`/`del`/`Remove-Item` 语义的物理删除 | **✅ 通过（可定案）** | `redline-scan.mjs` 产品代码 0 命中；产物级守卫（`test/host.test.mjs`「红线守卫」断言 2 个产物无 `.rm(`/`rmSync(`/`rmdir(`/`unlink(`/`Remove-Item`）我跑 71/71；`src/host/recycle-store.ts:5-6` 的唯一 `rm` 字样是**纪律注释**（lead 的说法我逐行复核过）；purge 也是**移交**到 `purged/`；EXDEV 明确拒绝、不做"复制+删源"兜底 | 真机删除动作的端到端复验属 A4/A5 范围；**"无删除语义"本身已可定案** |
| **A7** | 深浅色、中/英、字号跟随宿主 | **静态层通过 / live 待真机** | `style.test.mjs`（无硬编码配色）+ 我的 `theme-tokens.mjs`（18/18 令牌存在）；i18n：渲染测试断言注册 `['en','zh']` 双词典、`contract-consistency.mjs` 捕获 `label` 为 **thunk**（可随语言重读） | 主题/语言/字号三连的**实际跟随**（人眼） |

### 10.2 我的独立意见：客户端 HMR 生效是否足以作为 A1 的 live 证据？

**不足以覆盖 A1 全部，但足以支撑 A1 的"注册/占用"部分。** 理由：

1. occupant 账本是**宿主插槽账本**的事实（谁注册、order 多少、是否 active、官方 5 项有没有被顶替），与"页面渲染成什么样"无关 —— 账本不会因 HMR 而失真，故这部分可采信。
2. 但 A1 的后半句是"**样式与邻居页一致**"，那是纯视觉命题，账本不携带任何视觉信息；`theme-tokens.mjs` 只能证明"用的令牌真实存在"，不能证明"看起来一致"。
3. 仍建议**重启后复查同一个 occupant 查询**（成本极低）：lead 自己的实验已证明 HMR 只对**已成功加载**的 fiber 生效；而"HMR 加载的实例"与"重启后干净加载"在模块图/版本上未必等价（可能有旧包行残留）。复查即得交叉确认。

### 10.3 我**没有**验证的部分（显式列出，不得当作通过）

1. 任何真机浏览器渲染结果与视觉效果（A1 视觉、A5 坏行、A7 三连跟随）。
2. 宿主持久层真机行为（A4 的删除/还原端到端、回收站目录与 sha256）。
3. `fiberPhase` 重启后是否变 `active`（需用户重启）。
4. client 侧 Inspect 的直接复现（工具被停用）；A1 的 live 快照目前**只有 lead 一个来源**。
5. 并发/幂等（重复点击删除、同一 id 并发 recycle）——夹具属 `test/host.test.mjs`，我未构造。
6. `test/host.test.mjs` 的 `mkdtemp` 夹具不做清理（符合 A2），OS 临时目录有残留。

### 10.4 重启后我会立刻补的格子（收到 lead 的两个信号后）

| 待补格 | 我要求的证据 |
|---|---|
| A1 结构复核 | 重启后 `Slots.listSubTree root=settings.section` 里 `archive-manager(25) active:true` 仍在、官方 5 项仍原样（与 HMR 期间一致 → 交叉确认） |
| A4 | `plugin_manager list_plugins` 中 `include:archive-manager` 的 `fiberPhase` = `active`；然后真机删除一条归档会话 → 回收站目录 + `manifest.json` + 还原后 **sha256 与原目录一致** |
| A5 | 删除后官方侧栏/主列表（归档筛选开、关各一次）截图 + 宿主日志无 error + `workspace.json` 无坏 id |
| A2/A3 | 真机打开页面：列表与 `workspace.json` 的 `archivedSessionIds` 逐条一致；恢复后 id 退出集合、侧栏可见、位置正确 |
| A7 | 深/浅色、中/英、字号三连截图 |

## 11. 重启前收尾复核（17:05）

### 11.1 单文件入口改造的**回退**未影响复核 — ✅

lead 试过把 `main` 指向自包含的 `lib/entry.js`（指望"新 URL 免重启"），被实测否证（重激活仍报旧栈），已回退到 `lib/index.js`，并把三次否证写进 PLAN §10.7。我重跑确认：

| 项 | 结果 |
|---|---|
| `node scripts\build.mjs` | exit 0（`lib/index.js` 227 B + `lib/client.js` **29,706 B**） |
| `run-all.mjs` | **9/9 PASS**（[run-20260929-170439.log](logs/run-20260929-170439.log)） |
| `node --test "test/**/*.test.mjs"` | **73/73 PASS** |
| 我的脚本是否依赖被回退的入口 | **不依赖**：`host-contract.mjs`/`host-validator.mjs` 导入 `lib/host/routes.js`、`lib/contracts.js` 等逐文件产物；`bundle-whitelist.mjs` 读 `lib/client.js`；均仍存在 |
| REPORT 内的 `lib/index.js` 引用 | 仅 2 处，且都是**官方包**路径（`dsh-host-webserver/lib/index.js`、`dsh-client-connection/lib/index.js`），**无过期引用** |
| 遗留产物 | `lib/entry.js`（29,802 B，17:02）已无人引用；按 A2 一律不删除（lead 已在 PLAN §10.7 记为待人工清理）。INFO：它内含一份宿主代码副本，将来做「lib 产物文本检索」时要注意别把它当成现行实现 |

### 11.2 令牌存在性守卫（lead 新增）与抽取修复 — 复核通过，但有 1 处口径差异

- **抽取修复确认在代码里**：`test/style.test.mjs:88` 已按 `entry.unpacked === true || !Number.isFinite(Number(entry.offset))` 跳过；并加了 `official.size > 100` 的**抽断底线**（`assert.ok(official.size > 100, ...)`），能挡住"抽取被截断"这类回归——这点做得对（我先前遇到的问题正是"静默降级"，见 §11.3）。
- **口径差异（我实测）**：他们的 `hostCss()` 只遍历 `*.css` 条目 → **58 个 CSS 文件、393 个 `--dsw-*` 令牌**；而我的 `theme-tokens.mjs` 扫的是整个 asar → **419 个**。差的 26 个只出现在 `.css` 之外（asar 内的 JS 里内嵌 CSS 模块，如 `\0dsh-css:...*.module.css.mjs`）。
  - 影响方向：他们的集合**更小** ⇒ 若将来用到一个"只存在于 JS 内嵌 CSS"的合法令牌，会报**假警报**（false alarm），而**不会**放行拼写错误（拼错的令牌在两个集合里都不存在）。**当前 18 个令牌在两个集合里都存在 → 无实际缺陷。**
  - 建议：要么把抽取面放宽到所有文本条目，要么对 `missing` 先用更宽的集合复核一次再报错。
- `scripts/asar-read.mjs`：`cat`/`css` 已用 `readable()` 跳过 unpacked 条目 ✅；但文件头注释（:17-18）仍写着"`.css` / `.js` 均非 unpacked"——这句与修复后的行为不一致，属文档漂移（低）。

### 11.3 又一次"静默降级"教训（与我的 §4.6 同类）

他们早先只数到 94 个令牌、我数到 419 个 —— 根因是**抽取被截断却不报错**，而守卫**照样全绿**。
这与我在 §4.6 记录的另一起（硬编码 hash 资源名失效后脚本静默降级为"未覆盖"）是同一类风险：**"取不到证据"必须与"证据为假"区分开**。
→ 本报告采取的应对：凡"取不到"一律显式打印 `未覆盖`/`PENDING` 并计入失败或单独统计，绝不静默通过；`platform-modules-check.mjs` 也已改为**动态发现**资源文件 + 动态读版本。

### 11.4 重启后补格（收到 lead 两个信号 + 用户实测后）

沿用 §10.4，并补两项我要求的**原始证据**（不接受转述结论）：

| 待补格 | 我要求的原始证据 |
|---|---|
| A1（结构复核） | 重启后 `Slots.listSubTree root=settings.section`：`archive-manager(25) active:true` 仍在 **且官方 5 项 order/id 原样**（与 HMR 期间快照交叉确认） |
| A1（视觉）/A7 | 深/浅色 × 中/英 × 字号 的照片或截图（与「通用设置」页并列对比） |
| A4 | `fiberPhase=active`；随后**逐条**：`$DSH_HOME\archive-manager\recycle\<entryId>\manifest.json` 内容（含 `originalPath/bytes/movedAt`）+ 还原后**原目录文件 sha256 与删除前一致**；`purged/<batch>/batch.json` 在"清空"后仍在 |
| A5 | 侧栏归档筛选开/关各一次截图 + 宿主日志无 error 行 + `workspace.json` 的 `archivedSessionIds` 无指向已移走工件的坏 id |
| A2/A3 | 页面列表与 `workspace.json\archivedSessionIds` 的**逐条集合对照**；恢复后该 id 已退出集合、侧栏可见且**位置回到原工作区** |

## 12. 真机验收 + 契约变更复核（第二轮，17:25）

### 12.1 契约变更（会话 id 形态）——我的脚本已按新语义修正

真机删除曾返回 400「会话 ID 无效」，根因是 `isSessionId` 当时只接受**裸 UUID**，而真实数据里 `archivedSessionIds` 5 条**全是 `session-<uuid>`**。现契约（`src/contracts.ts:86,92`）改为**安全字符集 + 有界长度**：
```
SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
ENTRY_ID_PATTERN   = /^(\d{1,17})@([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
```
连带语义：形态合法但不存在的 id 不再是 400 —— `/recycle` 未归档 → **409 `session-not-archived`**；`/restore` 未知 entryId → 逐条 **`entry-not-found`**。

**我受影响并已修正的地方**（这正是"契约变更打到我"的清单）：
- `contract-consistency.mjs`：原来拿 `'not-a-uuid'` / `'1@not-a-uuid'` 当**非法**负控（新契约下它们是**合法形态**）→ 已换成真正危险字符的负控（`''`/`'.'`/`'..'`/`'a/b'`/`'a\\b'`/`'a b'`/`'-leading'`/`'.hidden'`/129 字符/含 NUL/超批量；entryId 用 `'a@b'`/`'@abc'`/`'1@'`/`'1@-lead'`/18 位时间戳），并新增**正向**断言（裸 UUID 与 `session-<uuid>` 都接受、去重保序、新形态 entryId 往返）。
- `host-contract.mjs`：新增 ① `restore` 未知 entryId 的逐条 `code === 'entry-not-found'`；② 新形态 `session-<uuid>` 且未归档 → **409**（不是 400）；③ P16 已并入契约，`purge.failed` 断言为数组。
- 复核后 **9/9 脚本 PASS**（[run-20260929-172509.log](logs/run-20260929-172509.log)）。

`test/contracts.test.mjs`（lead 新增）我读过：**判定为高质量**——两种真实形态正向、危险字符负控齐全、并且**直接读本机真实 `workspace.json`**（`global.archivedSessionIds` 与 `tables.workspaces[].sessionIds`）逐条校验，找不到文件时 skip。这条"用真实数据喂契约"正好补上了"79 项全绿却漏掉真机 bug"的根因。

### 12.2 A1–A7 最终判定（第二轮）

| # | 判定 | 证据（★ = 我独立核过；○ = 引用 lead/用户观测，我未亲验） |
|---|---|---|
| **A1** | **通过**（结构 ★ / 视觉 ○） | ★ `contract-consistency.mjs` 捕获注册实参 `{id:'archive-manager',order:25,label:thunk}`、25>官方最大 20、不撞 id；★ 重建后 bundle 正确 require 基座表内的 `@deepseek-ai/dsh-client-ui-primitives`（白名单 PASS）；★ `theme-tokens.mjs` 18/18 令牌存在。○ lead live 快照：occupants 含 `archive-manager(25) active`、官方 5 项原样；○ 用户截图：按工作区分组、组头带条数与「全部恢复」、行内「恢复/移入回收站」、搜索+排序+重新读取、空态与摘要缺失行、深色主题正常 |
| **A2** | **通过（★ 我逐条独立核对）** | 从 `$DSH_HOME\storages\workspace.json` 读出 `global.archivedSessionIds` 共 5 条，映射到工作区记账后为 **dsh-memory-v2 3 / 默认 1 / dsh-archive-manager 1**，与页面显示**完全一致**；5 个 id 逐条见 §12.3。另 ★ `buildRows` 保序去重、保留缺摘要行（运行时断言） |
| **A3** | **逻辑层通过 / live 仍留白** | ★ 走官方 `props.workspaces.unarchiveSession(id)`、逐条串行、部分失败分开上报；渲染测试覆盖"组内全部恢复"。**用户尚未点「恢复」**→ id 退出集合 / 侧栏可见 / 回原位三格留白 |
| **A4** | **通过（★ live 独立磁盘核对）** | ○ 用户点「移入回收站」成功；★ 我核对磁盘：`archive-manager\recycle\1790673301827@session-fa962f9d-…\` 含 `manifest.json`(340 B) 与 `session\session.v4.jsonl.zstd`(**98,604 B**)；★ manifest 全字段（entryId/sessionId/movedAt/originalPath/bytes/cwd），`bytes` 与实际文件大小一致；★ `originalPath` 指向 `sessions\--D-dsh-memory-v2--\<sessionId>`（sessions 下**恰好两级**）；★ **原路径已不存在**（是移动不是复制）；★ sha256 已记录 `366A0A94…F988`。另 ★ `host-contract.mjs` 覆盖 4 路由 400/409/200 与磁盘零改动不变量 |
| **A5** | **❌ 未通过（修复中，T9）** | ★ 我直接读盘确认：`global.archivedSessionIds` **仍是 5 条且包含被删除的 `session-fa962f9d-…`** → 客户端只是"提交成功后本地隐藏"，**刷新后该 id 会以「摘要缺失」幽灵行回来**。lead 的有意裁决（不动归档集合，避免会话回到官方主列表后变成缺工件的坏行）成立、理由可接受，但**验收项本身未通过**，修法已派 T9（客户端读 `/list` 建 `recycledIds` 过滤 + 「回收站」页签）。T9 交付后我复核 |
| **A6** | **通过（定案）** | ★ `redline-scan.mjs` 产品代码 0 命中；★ 产物守卫（`test/host.test.mjs`「红线守卫」）92/92 通过；★ `recycle-store.ts:5-6` 唯一 `rm` 字样是纪律注释；★ A4 的 live 证据本身就是"目录被移动、一个字节没少"（98,604 B 文件仍在、manifest 记录了 bytes） |
| **A7** | **静态层通过 / live 仍留白** | ★ `style.test.mjs` 三条全过（含新加的令牌存在性）+ ★ 我的 `theme-tokens.mjs`（18/18 存在）；★ 渲染测试断言注册 `['en','zh']` 双词典、`label` 为 **thunk**。**用户尚未切语言/字号** → 跟随三连留白 |

**总判定：A1/A2/A4/A6 = 通过；A5 = 未通过（修复中）；A3/A7 = 逻辑层或静态层通过、live 格留白。**

### 12.3 A2 的逐条对照（我读盘得到，可复现）

`$DSH_HOME\storages\workspace.json` → `global.archivedSessionIds`（5 条）与工作区记账的映射：

| # | sessionId | 所属工作区（title / path） |
|---|---|---|
| 1 | `session-0b9de1ba-1918-40b3-8fcc-8ab15a645e50` | dsh-memory-v2 / `D:\dsh-memory-v2` |
| 2 | `session-6dfd7d77-212b-49a4-8694-13d5ae8c4a58` | dsh-memory-v2 / `D:\dsh-memory-v2` |
| 3 | `session-fa962f9d-7835-41f1-9e47-16b98157aea0` | dsh-memory-v2 / `D:\dsh-memory-v2` ←**已被移入回收站，工件不在原处（A5 幽灵行来源）** |
| 4 | `session-28fbd508-3a20-4dd4-b901-9f0074e18419` | dsh-archive-manager / `D:\DSH-PLUGIN\dsh-archive-manager` |
| 5 | `session-d25778ea-f7c9-4cfd-b057-082f0f174a5a` | 默认 / `D:\PowerShell` |

→ 分组计数 `dsh-memory-v2 = 3`、`dsh-archive-manager = 1`、`默认 = 1`，与页面显示一致。

### 12.4 又一次"产物落后于源码"（我实测到，已写进 §2 规则 8）

- 重建前：`src/client/ArchivedSessionsSection.tsx`(17:23:26) 已 `import { Button, RiskConfirmation, SegmentedTabs, fileSizeText, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'`，但 `lib/client.js`(17:12:24, 29,792 B) 里 **`primitives`/`Button` 出现 0 次**、require 只有 `react` 与 `react/jsx-runtime`。
- 重建后：`lib/client.js` = **39,956 B**，require 列表变成 `react` / `react/jsx-runtime` / **`@deepseek-ai/dsh-client-ui-primitives`**（属基座 9 键 → 白名单 PASS）。
- 影响面（谁会被打到）：`test/build.test.mjs`、`test/client-render.test.mjs`（其 `PRIMITIVES_STUB` 在重建前**根本没被用到**）、我的 `bundle-whitelist.mjs` / `contract-consistency.mjs` —— **全都在测旧 bundle 而不自知**。这正是本报告反复强调"先重建再复核"的又一条实证。

### 12.5 SSR 桩审计（lead 点名：桩与真实组件差异会不会掩盖我们的问题）

我逐条对官方 `.d.ts`（参照树 0.2.0-rc.1 `dsh-client-ui-primitives/lib/types/`）核对：

| 桩 API | 官方签名 | 审计结论 |
|---|---|---|
| `relativeTime(at, now) → {unit, n}` | `RelativeTimeUnit = 'now'\|'minutes'\|'hours'\|'days'\|'months'\|'years'`，`RelativeTime{unit,n}`（`relative-time.d.ts:9-14,22`） | ✅ **忠实**（形状/arity 都对；桩的**分档阈值**是自算的，官方阈值可能不同，但插件只把 unit 映射为词典 key，两侧 key 齐全，不构成假绿） |
| `fileSizeText(bytes) → string` | `file-size.d.ts:7` | ✅ 忠实 |
| `Button` | `ButtonVariant = 'primary'\|'ghost'\|'outline'\|'toolbar'`（`Button.d.ts:3`）——**确无 `danger`** | ✅ 桩注释的"没有 danger 变体"**核实为真** |
| `Tag` | 8 个 tone（`Tag.d.ts:3-19`） | ⚠️ 桩**忽略 `tone`** → 传错 tone 不会暴露；**当前代码未用 Tag**，暂无实际影响 |
| `RiskConfirmation` | 12 个必需 props：`open/title/description/acknowledgeLabel/cancelLabel/closeLabel/confirmLabel/acknowledged/disabled?/onAcknowledgedChange/onCancel/onConfirm`（`RiskConfirmation.d.ts:1-14`），且**主操作在 `acknowledged` 前不可用** | ⚠️⚠️ **桩只取 `open/title/description/children`，忽略全部 label 与回调、也不实现门控** → 若我方漏传 `onConfirm`/`acknowledged` 未接线，桩**照样渲染**；真实组件则会"确认按钮永远不可点/文案空"。**这是当前最真实的假绿面**（`RiskConfirmation` 是代码在用的一环） |
| `Tag`/`RiskConfirmation` 的签名注释 | 桩的文档只列了 8 个 API | ⚠️ 缺 `Tag`、`RiskConfirmation` 两条；且桩共 10 个 API，**缺文档的正是这两个语义最重的** |
| 缺导出的行为 | — | ⚠️ 桩是普通对象：代码若 import 一个桩里没有的 primitives 导出，会得到 `undefined` → 运行到 JSX 时以 `undefined is not a function` 崩（**fail-loud，可接受**），但错误信息不指向"桩缺导出"。建议用 `Proxy` 对未知导出抛出带名字的错误 |

**建议（给 lead/client-page，低到中优先）**：
1. 让 `PRIMITIVES_STUB.RiskConfirmation` **校验必需 props**（缺 `onConfirm`/`acknowledged` 等即抛），并让主按钮的 `disabled` 反映 `!acknowledged`——这样"确认流程"就能被渲染测试覆盖；
2. 给 `Tag` 桩按 `TagTone` 白名单校验 `tone`（或至少 `console.error`）；
3. 用 `Proxy` 兜底未知导出，报"桩缺少导出 X"；
4. 补上 `Tag`/`RiskConfirmation` 的签名来源注释。

## 13. T11/T12 后复核 A5（第三轮，17:35）

### 13.1 我自己读到的当前真机状态（不引用转述）

| 项 | 我读到的值 |
|---|---|
| `$DSH_HOME\storages\workspace.json` | mtime **17:32:00** |
| `global.archivedSessionIds` | **4 条**：`0b9de1ba` / `6dfd7d77` / `fa962f9d` / `28fbd508` |
| 已删的 `fa962f9d` | **仍在集合内** → 幽灵行判据成立（A5 的核心风险仍在） |
| 已恢复的 `d25778ea` | **已移出集合** → **A3 的 live 证据我独立证实**（用户恢复成功） |
| 回收站树 | `recycle\1790673301827@session-fa962f9d-…\`：`manifest.json` 340 B + `session\session.v4.jsonl.zstd` 98,604 B；**尚无 `purged/`** → 用户还没做「清空」 |
| 复核快照 | `build` exit 0（`lib/client.js` **41,756 B**）、**9/9 脚本 PASS**（[run-20260929-173325.log](logs/run-20260929-173325.log)）、`node --test` **102/102 PASS** |

### 13.2 A5 判定：**架构修法成立、正常路径无幽灵行；但 live 未验 + 残留 1 条异常路径（P19）**

**正常路径（我逐行读代码核实）：**

| 场景 | 代码行为 | 结果 |
|---|---|---|
| 删除后（载荷在回收站） | `list()` 因**有载荷**上报（recycle-store.ts:437-438）→ `recycledIds` 覆盖 | 已归档页过滤掉 ✅ 无幽灵行 |
| 清空后（载荷进冷存档） | `purge` 保留 `manifest.json` 并写 `purgedAt`（:685-687）；`list()` 因 **`purgedAt`** 上报 | 仍覆盖 ✅ 无幽灵行（**T11 的关键修正**） |
| 还原后 | 无载荷 + 无 `purgedAt` → **不上报**（:438） | 刚恢复的会话**不会被永久过滤** ✅（这个收紧很关键） |

**异常路径遍历（lead 要求）：**

| # | 异常路径 | 代码行为 | 结论 |
|---|---|---|---|
| 1 | purge：载荷移动失败 | 原地保留 + `failed[internal]`（:679-683） | 有载荷 → 上报 ✅ |
| 2 | purge：载荷已移走、台账写失败、**回滚成功** | 载荷搬回（:691-695） | 有载荷 → 上报 ✅ |
| 3 | **purge：载荷移走、台账写失败、回滚也失败** | 仅记 `failed`，文案自认"载荷仍在冷存档区（台账未标记）"（:694） | 无载荷 + 无 `purgedAt` → **不上报 → 幽灵行** ❌ **P19** |
| 4 | `manifest.json` 缺失/损坏 | `list()` 跳过（:431-432） | 回收站页签看不到、也不能还原；若其载荷已被移走 → 幽灵行 ⚠️（既有边界，被"单一直源"放大） |
| 5 | `recycleRoot` readdir 失败 | `readDirectoryNames` 吞异常 → `/list` 返回空 | **首次**加载 → `recycledIds` 空 → 全部幽灵行；已成功加载过则保留上次 `entries`（useRecycleBin.ts:172）→ 只丢增量 ⚠️ |
| 6 | 用户手工删掉回收站条目目录 | 不上报 | 同上 → 幽灵行 ⚠️（自伤） |
| 7 | `/list` 网络/鉴权失败 | phase='error'，保留上次 entries + 内存 optimistic（:171-175） | 首次失败 → 幽灵行；重复失败 → 无新增幽灵 ⚠️ |

**结论：「单一直源」取舍成立** —— P19 需要"台账写失败 **且** 回滚也失败"两次故障叠加；#4/#5/#6 都属"回收站被外力破坏"的边界，且逐条都有明确行为（不静默损坏数据）。
**两条建议**：① 对 #3 加"尽力而为的二次台账写入"，或把标记**提前**到搬载荷之前（先写 `purgeIntent` → 搬 → 写 `purgedAt`），彻底消掉"载荷已走但台账未标记"的窗口；② README 写明"回收站根目录是过滤真源的索引，手工删除会导致幽灵行"。

### 13.3 T12 用例覆盖评估（lead 点名：是否真的覆盖"可重放"）

- ✅ **覆盖到位**：`normalizeRecycleEntry`（purgedAt/purgedBatch，含空白串与非字符串）、`isPurgedEntry` / `restoreGuard` 纯函数、`excludeRecycled` 的输出、分组不留空组头、`entry-purged` 中英文案与白名单。
- ⚠️ **"可重放"用例（client.test.mjs:686-709）是纯函数重放**：它自己 `new Set(entries.map(...))` 再调 `excludeRecycled`，**没有经过 `useRecycleBin`**。也就是说"`/list` 响应 → `hook.recycledIds` → 组件 `excludeRecycled`"这条链，目前只由**源码文本断言**守着（`:752` 断言 hook 里那行 `for (const entry of entries) ids.add(entry.sessionId)`；`:281` 组件确实调用，但没有断言）。
- ⚠️ **SSR 渲染测试覆盖不到这条链**：`renderToStaticMarkup` 不执行 `useEffect`，`useRecycleBin` 停留在初始态（`entries=[]`、`loading`）→ **幽灵行过滤在渲染测试里从未被执行**。
- ⚠️ **"不再有内存墓碑"是文本级断言**（`:750-752`）：换名（如 `cached`）重新引入内存兜底仍会通过。真正防"跨刷新记忆"的关键是**不引入持久化存储**——我已把 `localStorage`/`sessionStorage`/`indexedDB`/`caches` 的**否定断言**加进 [contract-consistency.mjs](contract-consistency.mjs) 的 A5 架构守卫（当前 PASS）。
- **建议（低优先，不阻塞）**：给 `getJson` 加可注入 seam，让渲染测试能喂一份 `/list` 响应，从而让"链"本身被自动化覆盖；或补一条 hook 级用例（需要能真正 setState 的 React 桩）。

### 13.4 PLAN §10.10–§10.13 复核

- **§10.10 事实我独立验证**：`$DSH_HOME\sessions\` 下**两种形态并存**——裸 UUID 目录 **53** 个、`session-` 前缀 **132** 个 ✅。「夹具镜像了假设」的根因分析成立，`test/contracts.test.mjs` 用真实 `workspace.json` 对齐是正确修法 ✅。
- **§10.11 / §10.13** 与我的独立观测一致（A4 磁盘证据、"不动归档集合"的理由成立）。
- **§10.12 三条偏离**：`Checkbox.label: string`（`Checkbox.d.ts:15`）✅ 证实"可见文案"的说法；`Menu` 的"无 `open===false` 早退"属**运行时**声明——官方类型里 `Menu` 返回**未标 `| null`**（而确实返回 null 的 `Modal` 标了 `ReactPortal | null`），这是**间接支持**，我未做运行时验证，建议该条标注为"类型层面的间接证据"。
- **一处措辞精度**：§10.13 说 `list()` "上报**所有**带台账的条目"——严格说是"**台账可解析**的条目"（manifest 缺失/损坏不上报，见 13.2 #4）。

### 13.5 定案快照（第三轮）

| # | 判定 | 变化 |
|---|---|---|
| A1 | **通过**（结构 ★ / 视觉 ○） | 无变化 |
| A2 | **通过（★ 逐条独立核对）** | 现为 4 条归档（含 1 条已删）→ 客户端过滤后页面应显示 **3** 条（dsh-memory-v2 2 + dsh-archive-manager 1） |
| A3 | **通过（★ live 由我独立证实）** | `d25778ea` 已移出归档集合；用户反馈"正常" ○ |
| A4 | **通过（★ live 磁盘核对）** | 回收站条目仍完整（340 B 台账 + 98,604 B 载荷） |
| **A5** | **未通过（架构已修，但仍待 live 清空实测 + P19 残留）** | T11/T12 修法成立且正常路径无幽灵行；残留异常路径 P19；用户"清空+刷新"尚未执行 |
| A6 | **通过** | 无变化 |
| A7 | **静态层通过 / live ○** | 用户反馈"保真度完美" ○；我未亲验像素 |

### 13.6 用户「清空」后的实盘 + 机械化判据 + 两个验收脚本（17:45）

#### （1）我独立读到的实盘（与 lead 的更正一致，并解释了 HMR 结论错在哪）

| 项 | 我读到的事实 |
|---|---|
| `recycle/` 根 | **空**（没有任何条目目录） |
| `purged/20260929-093450/<entryId>/` | `manifest.json` 340 B + `session\session.v4.jsonl.zstd` 98,604 B —— **台账被随载荷一起搬走** |
| `purged/20260929-093450/batch.json` | 496 B，`purgedAt/sourceRoot/entries[]（含完整 entry）/skipped[]` 齐全 |
| `archivedSessionIds` | 仍 **4 条**，含已被清空的 `session-fa962f9d-…` |

→ 这是 **T11 之前**的布局（T11 会把 `manifest.json` 留在回收站原地并写 `purgedAt`），而 lead 当时已 rebuild ⇒ **运行中的宿主仍在跑旧代码**，我 §2 规则 7 里"HMR 对已激活 fiber 有效"的说法**被证伪**，已改写并记上"不得把转述当实测"的纪律。

#### （2）A5 的机械化判据与两个脚本

**判据（lead 裁决）**：`幽灵行 = { id ∈ archivedSessionIds ：工件不在 sessions/<slug>/ 下 且 该 id 未被 list() 上报 }` 必须为 **0**。
**易错点（我按此实现）**：**"无摘要"不是幽灵行** —— `0b9de1ba`/`6dfd7d77` 工件完好但官方无摘要，属合法行；只有"**工件缺失 ∧ 未上报**"才是幽灵行。

| 脚本 | 定位 | 修前（本次实盘）输出 |
|---|---|---|
| [ghost-row-check.mjs](ghost-row-check.mjs) | **用户可复核的验收判据**（输出可直贴给用户）；无 `$DSH_HOME`/`workspace.json`/`list()` 不可用时 **SKIP（exit 2，不静默 PASS）** | `list() 上报条数 = 0`；4 条明细中 3 条"工件在 sessions、合法"，`session-fa962f9d-…` = **工件缺失 ∧ 未上报 → ★幽灵行**；`幽灵行 = 1 条` → **FAIL exit 1** |
| [a5-invariant.mjs](a5-invariant.mjs) | **更严的引擎不变式**（T13 的契约）：*任何被本插件搬过的会话都必须被 `list()` 上报*；另断言上报结果**无重复 entryId/sessionId** | `台账发现被搬过 = 1 条`、`list() = 0 条` → 3 项违反 |

**我顺带验到一个对 T13 很关键的事实**：同一个会话在盘上有**三路独立台账来源**——
`purged/<批次>/batch.json#entries`、`purged/<批次>/<entryId>/manifest.json`（旧布局）、
**`<entryId>` 目录名本身**（`1790673301827@session-fa962f9d-…` 可用 `parseEntryId` 直接得到 sessionId，**不依赖任何 JSON**）。
→ T13 的"∪ 台账"取数源**必须按 entryId 去重**，否则同一条会被上报多次（我的脚本已用"无重复"断言把这条钉住）。

> 这两个脚本**刻意不放进 `run-all.mjs`**：它们依赖 live 盘状态（T13+重启前必然红），
> 属于**验收点**而非"代码静态复核"。T13 落地 + 用户重启后，请跑：
> `node test\verify\ghost-row-check.mjs`（应 PASS，幽灵行 0）与 `node test\verify\a5-invariant.mjs`（应 PASS）。

#### （3）T13 不变式在我全部 7 条异常路径下的成立性（预判，待实现复核）

| # | 异常路径 | T13 "∪ 台账 + 回收站根无载荷即按已清空上报" 是否满足不变式 | 我的补充建议 |
|---|---|---|---|
| 1 | purge 载荷移动失败 | ✅ 载荷仍在回收站 → 有载荷即上报 | — |
| 2 | 载荷移走、台账写失败、回滚成功 | ✅ 同上 | — |
| 3 | 载荷移走、台账写失败、**回滚也失败** | ✅ 回收站根那份**旧 manifest 仍在**且无载荷 → 按"已清空"上报（`purgedAt` 可缺省） | 建议在 `list()` 输出里为"无标记的已清空"给出可辨识的 `purgedAt` 推导（批次名或 `batch.json`） |
| 4 | **旧布局残留**（本次实盘：台账随载荷进冷存档） | ✅ 用 `purged/<批次>/batch.json#entries` 或旧 manifest | 再加**目录名解析**（`parseEntryId`）作为第三路，连"两个 JSON 都坏"也能覆盖 |
| 5 | `manifest.json` 损坏（回收站根那份）＋冷存档无 manifest | ⚠️ 依赖 `batch.json`；`batch.json` 也坏则 ❌ | **建议：把 `purged/<批次>/<entryId>/session/` 的存在性 + 目录名也当台账来源**——目录名本身即 entryId，`session/` 存在即"载荷已走" |
| 6 | `recycle` 根 readdir 失败 | ❌ 不可判定（属"读不到"而非"没上报"） | 保持 fail-loud（500）；客户端已保留上次 `entries`（useRecycleBin.ts:172），首次加载窗口在 README 记明 |
| 7 | 用户手工删掉回收站/冷存档目录 | ❌ 数据被外力删除，无法恢复 | README 记明"回收站根与 purged 是过滤真源的索引，手工删除会导致幽灵行" |

**结论**：T13 的修法能覆盖 #3/#4（含本次实盘旧布局），是正确方向；**建议再补"目录名 + `session/` 存在性"两路来源**，把 #5 也覆盖，并按 entryId 去重。

#### （4）A5 基准证据

**修前基准（可复现）**：`幽灵行 = 1 条（session-fa962f9d-7835-41f1-9e47-16b98157aea0）`，根因 = 台账随载荷离开回收站 → `list()` 不上报 → 客户端 `recycledIds` 为空。
→ **A5 在 T13 落地且用户重启复测之前，一律记「未通过」**；复测通过后我会用同一条 `ghost-row-check.mjs` 命令出 PASS 证据并更新本表。

## 14. 终版定案快照（2026-09-29 17:55）

### 14.1 本轮我自己的快照（全部由我执行）

| 项 | 结果 |
|---|---|
| `node scripts\build.mjs` | exit 0（`lib/index.js` 227 B、`lib/client.js` **42,345 B**、`host/routes.js` 6,747 B、`host/recycle-store.js` 27,011 B） |
| `test\verify\run-all.mjs`（9 个静态/契约脚本） | **9/9 PASS**（[run-20260929-175411.log](logs/run-20260929-175411.log)） |
| `test\verify\ghost-row-check.mjs`（A5 判据） | **PASS：幽灵行 = 0**（`list() 上报条数 = 1`；`session-fa962f9d` 由"工件缺失 ∧ 未上报"变为"工件:缺失 **list 上报:true** → 合法"） |
| `test\verify\a5-invariant.mjs`（引擎不变式 + 去重） | **PASS**（含"不存在工件已移走但不上报的归档 id"） |
| `node --test "test/**/*.test.mjs"` | **113/113 PASS** |

### 14.2 部署判据（"宿主侧改动已生效"的可复现判据）

> **判据**：宿主进程的最早起始时间 **>** 全部构建产物的 mtime ⇒ 该进程加载的就是当前构建。

- **我的独立实测**：`Get-Process | ? { $_.Path -like 'E:\DSH*' } | Sort StartTime | Select -First 1` → `DeepSeek Harness` pid 44160，**起始 2026-09-29 17:52:48**（与 lead 所述一致，我复现）；部署时的构建时间为 **17:51:58** → **进程晚于产物** ✅。
- **脚本化**：[deploy-freshness.mjs](deploy-freshness.mjs)（只读）把这条判据做成可复现检查，并显式记录**限制**：
  这是 **mtime 代理**，只在"构建后未再重启"方向上有效；**反向不成立** —— 之后再做一次 `build`（即使源码一字未改）会把 mtime 推到进程之后。
  脚本因此在 mtime 判据不成立时追加"内容同一性"判定：与部署记录的大小比（本机 4/4 命中）。
- **本机现状说明**：我在 17:54:11 又 build 了一次（为出定案快照），所以**mtime 判据在我这次 build 之后不再成立**；但内容同一性成立：
  `src/**` 最新 mtime = **17:48:39** < 部署构建 17:51:58，且产物大小 4/4 与部署记录一致 ⇒ 我的 build 是**同一份源码的重放**。
  （`deploy-freshness.mjs` 输出：`PASS（mtime 不成立，但当前产物与部署记录的大小逐一相同）`。）

### 14.3 A5 终判：**通过** ✅

| 证据 | 来源 | 内容 |
|---|---|---|
| ① 机器判据在**真实盘**上成立 | **★ 我独立跑** `node test\verify\ghost-row-check.mjs` | `幽灵行 = 0`；`session-fa962f9d-…` 明细为「工件:缺失　list 上报:**true**　→ 合法」 |
| ② 真机 live 观察 | **○** 用户原话 + lead 转述 | 「已归档」**3 条**（幽灵行消失）、「回收站」**1 条**标记「已在冷存档区」且还原禁用、标题已加粗 |
| 对照（修复确实发生） | ★ 我在 §13.6 记录的**修前基准** | 同一命令、同一个盘：`list() = 0`、`幽灵行 = 1 条（session-fa962f9d-…）` |

**对 ② 的一点独立推理（不依赖用户描述本身）**：用户能**同时**看到"已归档 3 条 + 回收站 1 条已在冷存档区"，本身就要求 live 宿主的 `list()` **上报了那份冷存档台账**（旧布局的台账在 `purged/<批次>/<entryId>/` 下）—— 也就是说 **T13 的不变式在真机成立**，与我在真实盘上用 `a5-invariant.mjs` 得到的结果一致。

### 14.4 最终 A1–A7 判定表

★ = 我自己核过的证据；○ = 引用他人（lead/用户）观测。

| # | 验收项 | 终判 | 证据 |
|---|---|---|---|
| **A1** | 设置页出现「已归档会话」，样式与邻居页一致 | **通过** | ★ `contract-consistency.mjs` 真跑 bundle 捕获 `{id:'archive-manager',order:25,label:thunk}`、`25 > 官方最大 20`、不撞官方 id；★ 重建后 bundle 正确 require 基座表内的 `dsh-client-ui-primitives`（白名单 PASS）；★ `theme-tokens.mjs` 18/18 令牌在官方 419 个里存在；★ `node --test` 113/113 含空态/列表/分组/兜底/无数据源渲染。○ 用户 live：插槽 occupants 含 `archive-manager(25) active`、官方 5 项原样；截图确认分组/组头/行内操作/搜索排序/空态/摘要缺失行均正常（深色）。 |
| **A2** | 列出全部已归档会话 | **通过** | ★ 我从 `workspace.json` 逐条核对：归档集合 → 工作区分组 = `dsh-memory-v2 3 / dsh-archive-manager 1 / 默认 1`（当时 5 条），与页面显示一致；★ 客户端过滤后 live 显示 3 条（与归档集合中"工件仍在"的条目数一致）。○ 用户确认 3 条。 |
| **A3** | 单条/批量恢复成功、行消失、回到原工作区原位置 | **通过** | ★ 我读盘确认 `d25778ea` **已移出** `archivedSessionIds`（工件发现于 `sessions/` 下，已回到原工作区）；★ 恢复走官方 `props.workspaces.unarchiveSession(id)`、逐条串行、部分失败分开上报；○ 用户反馈"正常"。 |
| **A4** | 单条/批量删除成功且不产生不可逆丢弃 | **通过** | ★ 我核对磁盘：`recycle\<entryId>\manifest.json`（全字段：entryId/sessionId/movedAt/originalPath/bytes/cwd，340 B）+ `session\session.v4.jsonl.zstd`（98,604 B，与 manifest `bytes` 一致）；★ 原路径已不存在（**移动而非复制**）；★ sha256 已记录；★ `host-contract.mjs` 覆盖 4 路由 400/409/200 与**磁盘零改动不变量**。○ 用户点击成功。 |
| **A5** | 删除/清空后官方侧栏/主列表不出现坏行、不报错 | **通过** | 见 §14.3：★ `ghost-row-check` 幽灵行 0（`fa962f9d` 被上报）+ 修前基准 1 条作对照；○ 用户 live「已归档 3 条 / 回收站 1 条已在冷存档区且还原禁用」。 |
| **A6** | 全程无 `rm`/`del`/`Remove-Item` 语义的物理删除 | **通过** | ★ `redline-scan.mjs` 产品代码 0 命中；★ 产物守卫（`test/host.test.mjs`「红线守卫」）在 113/113 中通过；★ `recycle-store.ts` 顶部唯一 `rm` 字样是纪律注释；★ live 现场本身就是"移动"（98,604 B 一字节没少、台账仍在盘上）；★ `purge` 也是移交到 `purged/`，EXDEV 明确拒绝 copy+delete 兜底。 |
| **A7** | 深浅色、语言（中/英）、字号跟随宿主 | **通过** | ★ `style.test.mjs` 三条（禁硬编码配色 / 只允许 `--dsw-*` 族 / **令牌存在性**）+ ★ `theme-tokens.mjs`（官方 419 vs 插件 18，0 缺失）；★ 词典注册 `['en','zh']`、`label` 为 **thunk**（切语言可跟随）。○ 用户反馈"保真度完美"。 |

### 14.5 仍未覆盖 / 无法在真机复现的项（显式列出，**不得当作通过**）

1. **回收站页签的交互细节**：页签切换、清空确认弹窗（`RiskConfirmation` 的"勾选后才可确认"）只能人眼验证；SSR 冒烟跑不到 `useEffect`，因此"`/list` → `hook.recycledIds` → 组件过滤"这条链仍只有纯函数 + 源码断言守着（见 §13.3，改进项 T14）。
2. **双重故障不可复现**：`purge` 的"写台账失败 **且** 回滚也失败"（P19）在真机无法制造；T13 已从设计上兜住（冷存档回查 + 批次名推导 + 按 entryId 去重），但**没有真机证据**。
3. **残余低概率缺口（建议，非阻塞）**：若"回收站根台账损坏 **且** 冷存档内无台账 **且** `batch.json` 也损坏"，`list()` 仍会漏报（三条 JSON 全坏）。彻底的修法是引入**不依赖任何 JSON**的第三路来源：`purged/<批次>/<entryId>/` 的**目录名**（`parseEntryId` 即得 sessionId）与 **`session/` 载荷存在性**。
4. **A1 视觉 / A7 跟随**：我未亲验像素，均为 ○（用户反馈 + 截图描述）。
5. **A2 的"全部"**：我核的是"归档集合 ↔ 页面计数/分组一致"，未逐条核对官方摘要字段（`byId` 缺失属官方侧行为，非本插件缺陷）。
6. **一处文案漂移（新发现，trivial）**：`src/host/recycle-store.ts:589` 的失败文案仍写「会话 ID 无效（**必须是 UUID**）」，与已改为"安全字符集"的契约口径不一致（且上游 `parseSessionIds` 已先校验，该分支近乎不可达）。建议顺手改成"形态不安全"。

### 14.6 报告自洽性

- §10.10（会话 id 两形态）★ 独立验证；§10.11 的 HMR 结论已在 §2 规则 7 **更正并说明依据被证伪**；§13.6 的 A5 修前基准（幽灵行 1 条）与 §14.3 的终判（幽灵行 0）**同一条命令、同一个盘、互为对照**；§14.2 的部署判据补齐了"live 跑的到底是哪份代码"这一此前缺失的可复现环节。
- 早期判定表（§10.1 / §12.2 / §13.5）保留为历史中间态，顶部已有指向 §14 的醒目说明。

## 15. rc.2 复核快照（2026-09-29 20:50）— 版本标注刷新 + T16/T17 复核

### 15.1 环境变更（★ 全部我自己读的）

| 项 | 我读到的值 |
|---|---|
| `E:\DSH\resources\app.asar` | mtime **2026-09-29T10:34:26Z**（= 本地 18:34:26） |
| 运行中运行时 | `@deepseek-ai/dsh-desktop-runtime` / `@deepseek-ai/dsh` = **0.2.0-rc.2**（本会话内由 rc.1 自动升级） |
| 运行中前端资源 | **`index-5SrrfWpU.js`**（原 rc.1 为 `index-Dy0OhsZ5.js`） |
| 参照树（profile 安装） | 仍是 **0.2.0-rc.1**（`index-Dy0OhsZ5.js`）→ 两源**版本不同**，脚本已显式打印该差异 |
| 宿主进程最早起始 | **18:47:41** > asar mtime 18:34:26 ⇒ 运行中的确实是 rc.2 |
| 我的本轮构建 | **20:47:36** > 进程起始 18:47:41 ⇒ **宿主侧 T16 尚未 live**（与 lead 判断一致） |

### 15.2 rc.2 静态复核结果（★ 全部我跑，均 PASS）

| 检查 | 结果 |
|---|---|
| `node scripts\build.mjs` | exit 0（`lib/client.js` **43,825 B**） |
| `node --test "test/**/*.test.mjs"` | **120/120 PASS** |
| `facts-check.mjs` | **8 PASS / 0 MISMATCH**：lead 修复 PLAN §10.1（三版本并列）后那条 MISMATCH **已消除**；我的判据是"PLAN 必须引用 asar 里**动态解析出的**真实资源名" |
| `platform-modules-check.mjs` | rc.2 基座表 **9 键 == DECLARED** ✅；参照树 rc.1 基座表 **9 键 == DECLARED** ✅（跨版本交叉验证仍有效） |
| `scripts\check-routes-against-host.mjs`（rc.2 真实校验器） | **4/4 PASS** |
| `host-validator.mjs`（我补的负控） | **22 项 PASS** |
| `theme-tokens.mjs` | **10/10 令牌在 rc.2 官方 CSS 中存在**（用量由 18 降到 10：T10/T17 改用官方原子件后自绘样式减少） |
| `ghost-row-check.mjs` / `a5-invariant.mjs` | **幽灵行 0 / PASS** |

### 15.3 我改掉的 3 处**硬编码版本**（防复发）

- `tools/expectations.mjs` 新增 **`asarVersionInfo()`**：动态读取运行中 asar 的 version / 前端资源名 / mtime。
- `platform-modules-check.mjs`：原 INFO 行把 `0.2.0-rc.1` 与 `index-Dy0OhsZ5.js` 写死（升级后必然误报或静默降级）→ 改为动态，并**显式打印两源版本差异**。
- `facts-check.mjs`：3 处标签原写死 `0.2.0-rc.1` → 改为 `${RUNNING.version}`（现输出 `运行中 0.2.0-rc.2`）。
> 这正是 PLAN §10.17 那条教训的落地：**参照物（版本号、资源文件名）必须动态读取，不得硬编码**。

### 15.4 T16 复核（★ 我在 rc.2 asar 上独立核对，全部证实）

| lead 的声明 | 我的核对结果 |
|---|---|
| 服务名 `sessionController` | ✅ `super(ctx, "sessionController", { namespace: "session" })`（`dsh-api-session-controller/lib/index.js`） |
| 宿主实现是 `async list(signal)` 且返回**裸数组** | ✅ `async list(signal) { … const items = []; … }` 返回数组；同文件另有 Remote 装饰形态 `async list(request, signal)`（即 `.d.ts` 的客户端/远端形态）→ **两种签名确实不同**，按宿主形态接线是对的 |
| "running" 的判据 | ✅ `running: this.ctx.agents.get(session.id)?.status === "running"`；无 live 会话的行 `running: false`。即 **running 来自 agent 状态**，不是"被 DSH 加载/attached" |
| 影响 | 此前用 `ctx.get('sessions')?.get(id)` 只判 attached，会把 **fork/rewind 自动归档的源会话**永久挡成 409；T16 换成 agent 状态后解除 |

### 15.5 T17 复核（★ 源码级）

- `resolveRowRunning(status, summaryRunning)`：**状态表优先、回退摘要**；`status` 存在但 `running === undefined`（未知）按**未运行**处理（对应"未知按可删"，不会一禁了之）。
- `buildSectionModel` 内 `canRecycle = !running` 逐行派生；界面据此**在点击之前**禁用（T17 目的）。
- **附带消除一个覆盖缺口**：T14 的 `buildSectionModel` 把"`/list` 条目 + workspace 快照 + 会话摘要 → 最终分组"抽成**纯函数**，因此我 §13.3 提的"这条链只能靠源码文本断言"现在**可以真执行覆盖**。
- `error.session-live` 文案已改为同时覆盖两种拒绝原因（"仍在运行**或**被 DSH 加载"，`locales.ts:120/238`）✅。

### 15.6 A1–A7 版本标注刷新：**rc.1 逐项定案 + rc.2 实机复核**

| # | rc.1 定案（§14.4） | rc.2 复核 |
|---|---|---|
| A1 | 通过 | **维持**：rc.2 基座表 9 键一致、bundle 仍只 require 基座模块（白名单 PASS）、令牌 10/10 存在 |
| A2 | 通过 | **维持**：数据源仍是官方 `archivedSessionIds`，快照字段未变 |
| A3 | 通过 | **维持**：`unarchiveSession` 仍是官方接口 |
| A4 | 通过 | **维持**：rc.2 真实校验器 4/4、`host-contract` 全绿、磁盘证据未变 |
| A5 | 通过 | **维持**：rc.2 上幽灵行 0 |
| A6 | 通过 | **维持**：rc.2 红线扫描 0 命中 |
| A7 | 通过 | **维持**：rc.2 令牌存在性 10/10、词典/thunk 机制未变 |
| —— | —— | **新增 rc.2 live 证据（○）**：用户在 rc.2 上打开设置页，并收到**本插件返回的 `409 session-live`（含我们的错误码与文案）** ⇒ 我们的 4 条路由、鉴权链路与错误契约在 **rc.2 上真实可用**（比静态分析更强的"插件在 rc.2 可用"证据） |

**没有任何一项结论在 rc.2 上反转。**

### 15.7 T16 live：**已核实**（2026-09-29 21:05 更新）

**用户结论（○）**：重启后实测——**删除 fork / rewind 自动归档的源会话，不再被 409 `session-live` 挡住**（用户原话「成功了」）。

**部署判据（★ 我自己读的，并把 lead 的引用值更正为当前值）**：

| 项 | 我读到的值 |
|---|---|
| 宿主进程最早起始 | **21:00:12**（lead 引用的 `18:47:41` 是**上一个**进程，现已不存在） |
| T16 产物大小 | `host/routes.js` **8,335 B**、`host/recycle-store.js` **27,089 B**（T16 之后的值；T16 之前是 6,747 / 27,011） |
| 当前产物 mtime | **21:01:05**（重启之后又做了一次**同源重建**，故 mtime 晚于进程起始） |
| `src/**` 最新 mtime | **20:43:05** ⇒ 20:47 与 21:01 两次构建反映的是**同一份源码**（该源码即含 T16） |
| 内容同一性 | `deploy-freshness.mjs`：与部署记录大小 **4/4 命中** ⇒ PASS |

**结论**：T16 的构建（≤20:47:36）**早于** 21:00:12 的重启 ⇒ **运行中的宿主确实包含 T16** ✅。
（lead 的结论正确；其引用的进程起始时间是旧值。严格形式的"进程 > 产物 mtime"此刻不成立，唯一原因是**重启后又重建了一次同一份源码**——这个坑已写进脚本说明。）

**删除的磁盘落地（★ 我读盘）**：`recycle\1790686835940@session-ef92b327-be4c-48aa-a252-25875ebb3909\`
含 `manifest.json` 334 B（`movedAt 13:00:35.940Z`、`originalPath …\sessions\--D-PowerShell--\session-ef92b327-…`、`bytes 29265`、`cwd D:\PowerShell`）
与 `session\session.v4.jsonl.zstd` **29,265 B**（与台账 `bytes` 一致）⇒ **移动而非删除、工件完整**；`ghost-row-check` 里该 id 显示「工件:缺失 **list 上报:true** → 合法」。

### 15.8 rc.2 上仍未覆盖的项

1. ~~T16 的 live 行为（待重启）~~ → **已核实，见 §15.7**。
2. A1 视觉 / A7 跟随仍为 ○（用户反馈，我未亲验像素）；回收站页签切换与清空确认弹窗交互只能人眼。
3. P19 的"写台账失败 ∧ 回滚失败"双重故障真机无法制造（T13 已从设计兜住）。
4. 若根台账损坏 ∧ 冷存档无台账 ∧ `batch.json` 也损坏 → 仍会漏报（三条 JSON 全坏；建议补"目录名 / `session/` 存在性"这类不依赖 JSON 的来源）。

### 15.10 正面结论：**多状态并存**下幽灵行仍为 0（不变式的多重状态验证）

此前只验过**单一状态**（全部在站，或全部已清空）。本轮盘上**同时存在三种布局状态**（★ 我逐条读盘确认）：

| 状态 | 条目 | 我读到的关键事实 |
|---|---|---|
| **在站**（有载荷） | `1790678951272@session-43f2c68d-…`、`1790678953581@session-6fe12dd0-…`、`1790678975849@session-28fbd508-…`、`1790686835940@session-ef92b327-…`（×4） | 台账 334–376 B + 载荷 29,265 / 32,187 / 41,606 / 474,372 B |
| **已清空·新布局**（台账留原地带 `purgedAt`） | `1790676338466@session-6dfd7d77-…`、`1790676338472@session-0b9de1ba-…`（×2） | 台账 **416 B**（含 `purgedAt 10:05:42.789Z` / `purgedBatch 20260929-100542`），**无 `session/`**；载荷在 `purged\20260929-100542\<entryId>\session\` 下（47,131 / 40,589 B，与台账 `bytes` 一致） |
| **已清空·旧布局残留**（台账随载荷进冷存档） | `purged\20260929-093450\1790673301827@session-fa962f9d-…`（×1） | 台账 340 B 与载荷 98,604 B **同在冷存档**——就是当初触发 P19 的那一条 |

**结果**：上述三态并存（`archivedSessionIds` = **9** 条）时，`ghost-row-check.mjs` = **幽灵行 0**、`a5-invariant.mjs` = **PASS** ⇒ **§10.14 的不变式在"多状态并存"下依然成立**，这比只验单一状态强得多。

**一处精度更正（对 lead 表述）**：lead 写的是"在站 / 已清空 / **已还原痕迹**"三态并存；我读盘的结果是**在站 / 已清空(新布局) / 已清空(旧布局残留)**——盘上**当前没有"已还原痕迹"条目**（那需要一个"有台账、无载荷、且冷存档里也没有"的目录）。
不变式不依赖这一态存在，但既然报告是验收依据，就按实际读到的写。

**附带自审**：我自己的 `deploy-freshness.mjs` 期望表里 `client.js` 还写着 rc.1 时代的 42,345（当前 43,825），首跑报「3/4 命中」被我抓出并修正为 4/4 —— 又一次印证"期望表会过期，必须对着实际盘/产物核"。

### 15.9 工具纪律（本轮踩到并已改）

上一轮我用**嵌套引号的 PowerShell 一行命令**（`node -e "…[^"]+…"`）去读 asar，被 PS 解析器打挂、整轮作废。已改为：
1. 优先写 `.mjs` 脚本或 `node -e`（整段**单引号**包裹、内部只用双引号）；
2. 需要 asar 内容时用 `scripts/asar-read.mjs`（`find`/`cat`/`css`）或 `asar-probe.mjs`，**不做全量扫描**；
3. 单条命令 **>60s 无输出即跳过**，写「未覆盖（原因：超时）」，不重试第三次；
4. 继续**不用** client 侧 `cordis_inspect_query`（记忆 #0008：等页面响应会挂死）。
