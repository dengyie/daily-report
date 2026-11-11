---
name: ai-daily
description: 生成 AI 每日日报（自动每天 08:40 由 Windows 任务计划程序触发，也可手动 /ai-daily [--date YYYY-MM-DD]）。确定性覆盖 10 大板块 × 必查厂商花名册，grok-search/X/RSS 发现，对抗式核查，产出 E:/profile/note/note/Note/AI/DallyReport/<date>/YYYY-MM-DD-ai日报.md + 原始数据存档。
---

# AI 每日日报（ai-daily）

## 何时使用
- 用户要求"今天的 AI 日报 / 今日 AI 新闻 / 每日 AI 简报"。
- 手动补跑历史某天：`/ai-daily --date 2026-08-12`。
- 每日 08:40 由 **Windows 任务计划程序 `ai-daily`** 以 headless 方式自动触发（`run-daily-task.cmd` → `run-daily-win.sh`；Mac launchd 已于 2026-10-03 清退，生产 Windows 唯一）。

## 流程总览
编排器（本 skill，主会话）→ 调用 Workflow 工具跑 `.claude/workflows/ai-daily.js` → 子代理完成发现/抓取/核查/合成并 **return payloads**（realm 无 fs，不写盘）→ headless 由 `run-daily-win.sh` **HOST-FINALIZE**（`host-finalize.mjs` 从 completed workflow json 调 `finalize.mjs` 确定性落盘；编排器 Write 是加速不是唯一路径）→ 本 skill 汇报摘要 + 降级标记。

## 步骤

### 1. 解析参数
- 读取 `args` 或指令中的 `--date YYYY-MM-DD`；缺省 = 今天（`date +%F`）。
- `--force`：允许覆盖当日已存在的产物（默认若 `E:/profile/note/note/Note/AI/DallyReport/<date>/<date>-ai日报.md` 已存在则询问是否重跑）。

### 2. 计算日期窗口
- 报告日 T（即 `--date`）；新闻窗口 = **[T-2, T]**（覆盖前两天到当天）。
- 用 Bash 计算（Git Bash，GNU date）：`from=$(date -d '-2 days' +%F)`、`to=$(date +%F)`（若指定 --date 则先对 T 计算 T-2：`date -d "$T -2 days" +%F`）。
- 工作目录固定为 Obsidian vault 根 `E:/profile/note/note`。

### 3. 准备输出目录
- 生产路径：`E:/profile/note/note/Note/AI/DallyReport/<date>/`（Obsidian vault 内）。
- `outDir` = 该路径（`date` 替换为报告日）。

### 3.4. run 前 build 产物检查（部署纪律）
- 跑 workflow 前，若 `scripts/ai-daily/` 任何源文件比产物
  `.claude/workflows/ai-daily.js` 新，必须先重建产物：`node E:/code/DallyReport/ai-daily/scripts/ai-daily/build.mjs --sync-vault`（`--sync-vault` 会把重建后的产物与 SKILL.md 一并拷入 vault `.claude/`，漏 cp 即漂移）。
- 检测命令（工作目录 = 源仓库根 `E:/code/DallyReport/ai-daily`）：
  `find scripts/ai-daily -newer .claude/workflows/ai-daily.js`——有输出即需要重建。
- 原因：run 用的是磁盘上 workflow 文件那一刻的内容，源改动只改 `scripts/ai-daily/*.mjs` 而没重建 +
  提交产物，run 就会用旧版（缺失 citation/最新渲染逻辑）。build 产物与源模块必须同步提交。

### 4. 调用 Workflow
用 Workflow 工具，`scriptPath: E:/profile/note/note/.claude/workflows/ai-daily.js`，
`args` 传 JSON 对象：

```json
{
  "date": "YYYY-MM-DD",
  "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "outDir": "E:/profile/note/note/Note/AI/DallyReport/YYYY-MM-DD",
  "maxFetch": 16,
  "maxVerify": 16,
  "agentTimeoutMs": 360000,
  "probeTimeoutMs": 20000,
  "totalLimitMs": 1800000,
  "harvestBudgetMs": 540000,
  "discoverBudgetMs": 480000,
  "fetchBudgetMs": 480000,
  "verifyBudgetMs": 300000,
  "verifyInflightBufferMs": 60000,
  "synthesisLimitMs": 600000,
  "modelLadder": ["deepseek-v4-flash", "grok-4.6", "claude-opus-4-8", "gemini-3.7-flash-high"],
  "ladderBudgetMs": 900000,
  "webFetchViaCdp": false
}
```

> **headless vs 手动（契约总表，详细机制见各专项条目）**：
>
> | 维度 | headless（run-daily-win.sh 每日 08:40） | 手动 `/ai-daily` |
> |---|---|---|
> | linux.do | 显式传 `linuxdoCdpHost: "127.0.0.1:9222"`、`linuxdoMaxSources: 12`、`webFetchViaCdp: true`（复用 9222 登录态 Chrome；mint 直铸不占 fetch 配额） | 默认**不启用** CDP fetch（避免离开 9222 环境误跑）；需启用时手写 `"linuxdoCdpHost": "127.0.0.1:9222", "webFetchViaCdp": true`（`linuxdoMaxSources` 不传即默认 12） |
> | 跨天账本注入 | **host-inject bake**：launch 前账本/回执/prefetch 一次性副本直接 bake 进 bundle `HOST_INJECT` 常量（args 归一后兜底合并，真传非 null 优先）；prompt **禁止 Read 注入文件、禁止把注入内容传进 args**（详见 §9/13 跨天账本） | **Read 转写**：`C:/Users/mango/.ai-daily/published-ledger.json` 存在 → **必须 Read 后把 JSON 数组传 `args.reportedLedger`**（空数组/`[]` 与不传等价 → `ledger_unavailable` fail-open）；仅文件不存在（首跑）才省略 |
> | fetch 回执 | bake 自动注入（`fetch-receipts.json`，主文件路径不进 prompt，同账本铁律） | 不传即过滤关闭（首跑语义，fail-open）；48h 内已抓候选让位新 URL，`static-fallback` 发现页豁免必重抓 |
> | 落盘 | HOST-FINALIZE（`host-finalize.mjs`）兜底 + 编排器 finalize | 编排器 finalize.mjs 直落 |
>
> 注入链双轨的根因与事故链见 §9/13 与 §8/26：11-10 补跑四连事故（空拉/漏 outDir/漏 name/转写成 `[null]`）实证模型转写层不可靠 → headless 全面改 bake。

> **9/02 进度条（宿主只读观察 CLI）**：headless 跑批时另开终端跑 `node E:/code/DallyReport/ai-daily/scripts/ai-daily/progress.mjs`（默认 5s 单行重绘；`--once` 打一行即退）。只读数据源 `C:/Users/mango/.ai-daily/run-daily.log` + 最新 workflow journal/转录，显示：墙钟 vs 30m 软目标（超 ⚠）、五阶段推进 收/发/抓/核/稿（agent 转录首行锚点分类）、journal 代理计数（在飞以 result 归账）、编排器可见 524 与换级旗标、终态 rc+ARTIFACT+WALLCLOCK。总票数开跑前未知 → **不画假百分比**。**不 inline 进 workflow 产物**（与 `linuxdo-prefetch.mjs` 同款宿主 CLI，build MODULES 不含）；exit：进行中 0 / 终态透传 rc / 未启动 2。注意编排器级 524 计数可为 0 而 realm 内大量 agent 死亡（风暴只在 journal/转录可见）。

> **8/27 Task 2 预抓隔离数据流**：linux.do 的 CDP 登录态抓取**前移到宿主 Node**。
>
> **抓取**：headless 由 `run-daily-win.sh` 在调 Workflow 前先跑 `node E:/code/DallyReport/ai-daily/scripts/ai-daily/linuxdo-prefetch.mjs --host 127.0.0.1:9222 --max-sources 28 --deep-fetch 16`（10/03 起：28 是**交付 buffer**——prefetch 内部噪声过滤→likeCount/date 质量排序→深抓 ≤16 条富化正文+探出链；Workflow 消费配额 `linuxdoMaxSources:12` 另设且先做窗口过滤），stdout 成功 JSON **落盘** `C:/Users/mango/.ai-daily/linuxdo-prefetch.json`。**9/01 P2**：JSON 本体**不得** `$(cat)` 进双引号 `claude -p`（帖子标题含引号会破 shell）。
>
> **注入双轨（11-11）**：headless 由 `host-inject.mjs` 在 launch 前把该文件 bake 进 bundle（子代理不再 Read）；手动跑仍编排器 **Read 该文件** 后把对象作为 `args.linuxdoPrefetched` 传入。
>
> **数据流**：`linuxdo-prefetch.mjs（宿主 Node CLI，复用 linuxdo-fetch.mjs 的 fetchLinuxDoNews34）→ stdout 成功 JSON（ok:true + posts）→ 落盘 prefetch 文件 → headless: host-inject bake（手动: 编排器 Read）→ args.linuxdoPrefetched（bake 路径在 realm args 归一后兜底合并，语义等价）→ Workflow realm 内严格校验 ok===true && posts 含非空 url/title → LINUXDO-OK 消费进 linuxdo 板（found_via:'linuxdo-cdp'，consume 保留 snippet）。
>
> **9/01 覆盖韧性（9/20 治理后）**：linuxdo-cdp 直铸在 `allocateFetchBudget` **之前**，不占 MAX_FETCH。
> - 出链帖（snippet 含 GitHub/arXiv/官网等权威外链）：`extractHighValueOutlink` 探测并转为 **`linuxdo-outlink` 真实 fetch 目标**（日志 `LINUXDO-GOVERN`，claim 只能落在被真实读过的权威页——旧版直接标 primary 是引用造假）。
> - 无出链且带非空 snippet 的帖：`mintLinuxdoSource` **直铸** forum claim（日志 `LINUXDO-MINT`，恒 forum 质量），并从 boardURLMap 剔除——**跳过 fetch 代理、不占 MAX_FETCH**（linux.do 无 cookie 的裸 WebFetch 是结构性弱路径；09-20 实证 mint 在配额后会挤掉官方源）。
> - 空 snippet 帖直接丢弃（`linuxdo_empty_snippet_dropped`，不再喂给必 403 的 fetch 代理白烧配额）。配额外的 linuxdo 只在 `budgetDropped`，不铸。realm **仍不得**调 `fetchLinuxDoNews34`。
>
> **失败契约**：prefetch 失败/空 stdout → `run-daily-win.sh` 一律把 `{"ok":false,"reason":…}` 写入同一文件（**绝不以 stderr 文本当成功 JSON**）；realm 内无有效 `linuxdoPrefetched` 时**绝不调用裸 fetchLinuxDoNews34**（realm 无 fetch/WebSocket 全局）→ 走 `LINUXDO-FAIL no_fetch_realm` 稳定降级（meta `linuxdo_degraded:no_fetch_realm`，板不崩、无 ReferenceError）。**手动 `/ai-daily` 默认不产生 prefetch** → linuxdo 板走 no_cdp_host 空板或不启用；**绝不在 realm 内裸抓 CDP**。
>
> **宿主边界**：`linuxdo-prefetch.mjs` 是**宿主 Node CLI，build 时不 inline 进产物**（build.mjs 的 MODULES 不含它；`build.test.mjs` F2 断言产物无 `prefetchLinuxDo`/无任何宿主网络进程 API（`fetch(`/`WebSocket`/`process.`/`require(`/`AbortSignal`）/无裸 `await fetchLinuxDoNews34(`）。

> **可选 args 与阶段预算（总表；演进史注释压缩到 §尾部「演进日志索引」）**：
>
> | arg（默认） | 语义 | 备注 |
> |---|---|---|
> | `maxFetch`/`maxVerify`（16/16） | 8/31 由 12 上调 | 8/30 实证 45 发现仅 12 抓取、预算掐头去尾 |
> | `agentTimeoutMs`（360000=6min） | 单代理超时即失败 | harvest/discover 不换新代理重跑，fetch 换一次，verify/report 走阶梯（零素材只跑首级）；8/18 起 md 走 render-md 确定性拼接 |
> | `linuxdoCdpHost`（null） | 传 `"127.0.0.1:9222"` 启用 linux.do CDP 发现组 | headless 显式传；手动补跑默认不启用；纪律=只复用 9222 登录态、只关自开临时标签、绝不关浏览器本体 |
> | `linuxdoMaxSources`（12） | 论坛配额（9/15 严控防挤占官方源；10/03 由 8 上调，mint 不占 MAX_FETCH） | 供「社区热度」叙事 |
> | `cdpFetchCli` / `grokDir` | 默认仓内 `cdp-fetch.mjs` / grok-search skill 目录 | 10-03 P0-D Windows 生产修复；移植机器才需覆盖 |
> | `probeTimeoutMs`（20000） | Synthesize 前观察探针超时 | 8/30 起**探针仅观察不否决**（advisory），仅记录饱和度 |
> | `totalLimitMs`（1800000） | 仅约束 Harvest–Verify 切片死线 | 合成入口不看总墙钟（9/01 方案 D 脱钩） |
> | `synthesisLimitMs`（默认 600000） | report 单次 timeout × reportTries；合成与总墙钟脱钩（9/01 方案 D） | 600s = report timeout |
> | `harvestBudgetMs`/`discoverBudgetMs`/`fetchBudgetMs`/`verifyBudgetMs`（540000/480000/480000/300000） | 各阶段累计墙钟死线（9/8/8/5min，切片和=30min） | 8/17 实测健康包络 30.8min 装不进 30min 盘子 → Verify 每批重算 room、末批在飞 360s 可软越线 |
> | `verifyInflightBufferMs`（60000） | Verify 死线在切片和后扣此缓冲 | 给最后一批固定 360s 在飞票留余量；批内尾部超死线由软目标容忍 |
> | `breakerConsecutive`（3）/`breakerTotal`（5） | 计数型断路器跳闸阈值（8/31 P1） | 连续/累计失败跳闸；跳闸跳代理余批直连 static-fallback |
> | `modelLadder` / `ladderBudgetMs` | 9/02 模型阶梯，仅 report+verify | 见 §9/02 模型阶梯条目 |
> | `boards` | 限定**板块**子集（冒烟/单板调试） | 取值是板块名（labs/strategy/.../linuxdo），**不是发现组名**（media-cn 等）——发现组按覆盖板块求交集，交集为空的组被过滤。激活 media-cn 组 = 传其覆盖板块任一（如 `["labs","strategy"]`）。linuxdo 板需配合 `linuxdoCdpHost` |
> | `KNOWN_MAJOR_OUT` 种子 age gate | 种子 `date` 距报告日 ≤21d 注入，超期退役 | `SEED-AGE` 日志；`REPORT_DAY` 未知 fail-open 全注入；内容刷新为独立人工动作（8/20 第十七项） |
>
> **阶段预算语义**：预算只作**批间** BREAK 判定（墙钟守护在批次边界），单代理超时一律固定上界（harvest 1800s / discover labs 1800s·其余 2400s / fetch·verify 360s / report 600s），不随 room 收紧——8/19 回归（room 注入 timeoutMs 导致 436s 成功 discover 被 410s 判废）已由 test/no-room-in-timeout.test.mjs 源级固化。时钟源为脚本内 setTimeout 链累加器——Workflow realm 无 `performance`/`Date.now`，仅此链在 `await` 期间持续推进，故 budgetGate 真实生效。8/19 调序：discover 换 `--extra 4` 走 Tavily 快速兜底，harvest 保留 442-800s 慢但有效的 crops。
>
> **降级判定（8/22 第十八项）**：`computeBoardStates`（boards.mjs）——板 `degraded` = 任一归属组失败（无返回）或返回组自报 degraded；板 `missing` = 所有归属组全部无返回。修复 8/21 bug：media-cn 失败时被 media-en 兜底的板此前静默 0 claims 不标红；现在同组覆盖板全部如实标红，`discovery_degraded:missing_*` 只报真正无覆盖的独占板（safety/people）。`test/coverage.test.mjs` 锁死。
>
> **落盘与兜底（8/22 第十九/二十项）**：workflow realm 无 fs（build 护栏：单文件自包含），只 return payloads 不写盘 → `finalize.mjs`（Node fs 逐字节写 4 产物，缺字段报错非 0；CLI + 可 import 函数；`test/finalize.test.mjs` 锁保真/错误路径/幂等），收尾 `node scripts/ai-daily/finalize.mjs <workflow-result路径> --out <outDir>`。兜底运行时修复：合组失败时兜底 entry 旧版 `board:null` 被下游全丢弃 → 按 `digest feed.boards ∩ g.boards` 派生归属板（dedup 跨板去重不重复抓）；`computeBoardStates` 增第三参数 `recoveredKeys`，兜底救回的板 `missing` 降 false 但 `degraded` 保留 true 并标 `recovered` 溯源；coverage 渲染补 `[recovered]`，meta 降级 flags 新增 `discovery_recovered:<boards>`（§5.2 运行时缺陷 6 测新增固化）。

> **8/26 静态兜底（static-fallback）真实降级契约**：discover 某板**所有归属组全失败**且 harvest-fallback 未救回时，从 `boards.mjs` 的 `STATIC_FALLBACK_SOURCES`（精选常驻一级/官方新闻页 URL）注入该板 `boardURLMap`（`found_via:'static-fallback'`），fetch/verify 仍对抗式处理。**三个诚实契约**：① 静态注入在 `allocateFetchBudget` **之前**（实获配额）；② 静态项**只进 boardURLMap、不进 discoverRows.urls → `urls_discovered` 绝不包含静态项**（统计只算真 discovery 行）；③ `degraded` 保留如实上报（discover 代理失败不因兜底内容而伪健康）。`budget_skipped:<阶段>` **仅表示整段阶段被跳过**（该阶段累计墙钟死线超限），不代表单批失败；`fetch_budget_dropped:N` 是 fetch **启动前**按配额算的丢弃计数（不是真抓了 N 条）。linux.do：`no_cdp_host`（默认）→ LINUXDO-SKIP 空板不降级；`no_fetch_realm`（有 host 但无有效 prefetch）→ `linuxdo_degraded:no_fetch_realm` 诚实降级。**
>
> **9/01 覆盖韧性（Fetch 首批混排 + linuxdo snippet 直铸 + breaker 阶段隔离）**：① `allocateFetchBudget` Phase 1 已按通道轮询混排 `linuxdo-cdp` / `static-fallback`；编排层**不再**二次静态前置（旧 `preferStaticFirst` 死导出已删除，10-03 §12-②），`FETCH_FIRST_BATCH === FETCH_BATCH`（默认 6）——首批必须是 prefer 通道混合物，预算一紧不得把已获配额的 linuxdo 整批蒸发。② 配额内 linuxdo+snippet 由 `mintLinuxdoSource` 直铸（见上数据流）。FETCH-SALVAGE 改看 `!stageFetchRan`（Fetch 批未跑），不因 mint 已写入 `extracted` 而关闭救护。③ `phase('Discover')` 之后、代理批循环之前调 `BREAKER.resetConsecutive()`——清连续失败计数，不清 `failures`/`successes`/`reason`；已跳闸仍 open。`total=5` 仍是 run 级保险丝。
>
> **9/13 跨天账本 + fetch 走 9222（重构）**：
>
> **① 跨天去重账本**（治「同一事件连续多天整条重复成稿」）
> - **存储**：生产账本 `C:/Users/mango/.ai-daily/published-ledger.json`（HOME 而非 iCloud：launchd TCC 读不了 Mobile Documents，8/31 P4 实证；HOME 路径有 linuxdo-prefetch.json 先例）。**主文件路径不进 prompt**（铁律）。
> - **记录端** = `finalize.mjs`：写完 4 产物自动追加 confirmed 条目（URL+指纹 token+day+major；先过 `isJunkClaim` 兜底——10-05 P2）；**非生产 outDir 不记账 → `LEDGER-SKIP`**（烟测 /tmp 天然隔离）；显式 `--ledger` 可覆盖；记账后原子回写 meta：`ledger_recorded` / `ledger_recorded_count`（本轮实际新增记账数）/ `wallclock.real_s`（runner 起始 epoch 经 `AI_DAILY_RUN_START_EPOCH` env 注入、finalize 宿主时钟实测，10-05 P1）。
> - **注入（编排器在调 Workflow 前必须完成）**：headless 11-11 起 **bake 注入**——`host-inject.mjs` launch 前把账本一次性副本 bake 进 bundle `HOST_INJECT` 常量，args 归一后兜底合并，`ledger_injected` 计数与 Read 转写完全等价；**bake 失败 rc≠0 中止不空拉**。手动跑仍 **Read 转写**。存在 → 注入（禁止因 resume/漏读而省略）；不存在（首跑）→ 不注入、不报错。
> - **realm 内消费三道**：近 3 天已报道 URL/指纹**硬过滤**（fetch 配额前，meta `reported_deduped:N`）；已报道**种子退役**（`SEED-LEDGER` 日志，报过一次即退役，不再 21 天逐日注入）；近 3 天已报道**名单进 report 输入**（软网，prompt 4.8：同事件换 URL 一律不写正文，实质新增只写增量并标「前情提要」）。
> - **无账本** → fail-open + degraded 旗标 `ledger_unavailable`。meta 增 `reported_deduped` / `major_dup_skipped` / `ledger_injected`（**注入 workflow 的账本条目数**，不是本轮新增记账数——10-05 P3 由 `ledger_entries` 改名；消费端入口 `parseReportedLedger` 统一 `isJunkClaim` 卫生过滤，历史毒条目不再渗入报告）。
>
> **② fetch 走 9222**（治「除 linux.do 外全部抓取不走登录态浏览器」）
> - `args.webFetchViaCdp: true`（headless 显式传；手动默认 false 维持纯 WebFetch）时，fetch 代理 Step1 先经 Bash 跑宿主 CLI `node E:/code/DallyReport/ai-daily/scripts/ai-daily/cdp-fetch.mjs '<url>'`（9222 临时标签读正文，`{ok:true,url,chars,text}` JSON 到 stdout；失败非零退出+stderr 诊断），失败回落 WebFetch 文本抓取。
> - **索引页治理**（两种模式都生效）：`found_via=static-fallback` 的来源是栏目/索引页——只做发现入口，从索引页选窗口内真实文章 URL 逐条抓正文，claim 带可选 `sourceUrl`（EXTRACT_SCHEMA 字段）= 真实文章 URL。**9/21 夜（review 改名）**：注入走 `bindExtractedClaims`——索引页缺合法 http(s) 文章 `sourceUrl` 的 claim **丢弃并计入** `index_claim_dropped:N`（计数字段 `indexClaimDropped`；日志 `INDEX-CLAIM-DROPPED`；不得再叫 `index_page_citation`，也不得把栏目 URL 如 `https://x.ai/news` 注入引用/verify/角标）；文章页缺可选 `sourceUrl` 回落 `src.url`、**不计**旗标。
> - **窗口外参考折叠**：`foldWindowMisses`（CJK bigram 共享 ≥4，词法名 `wm*`）折叠中文近重复；**列表内部**拉丁 token 必须共享 ≥2（`WM_ASCII_MIN_INTERNAL`，只共享一个厂商标记的两条不同事件不得互折），与正文/major-out 互折仍是共享 1 个拉丁 token 即去掉。
> - **宿主边界**：`cdp-fetch.mjs` 是**宿主 Node CLI 不 inline 进产物**（与 linuxdo-prefetch 同款；CDP 协议层抽在 `cdp-core.mjs`，宿主专用——10/03 起**不再 inline 进 realm**：linuxdo 拆出纯解析层后，`cdp-core`/`linuxdo-fetch` 均归宿主，realm 产物经 build 护栏禁含 `fetch`/`WebSocket`/`process`）。
> - **并发纪律**：只复用已运行 9222、只关自开临时标签、绝不关浏览器本体；并发信号量上限 3（`C:/Users/mango/.ai-daily/cdp-locks/lock-0.lock`…`lock-2.lock` 固定槽 `wx` 抢位，锁等待 = 一次完整读页 35s（open+poll+5s，9/19 C2）、持锁每 10s 心跳续期 mtime、>60s 无心跳才陈旧回收（9/19 C3，活锁不再被误回收））。
> - **major-out 跨天互斥**：`_majorDupCheck` 先查 `REPORTED_LEDGER`（跨天命中返回 `ledger`，不得只互斥本窗）；`storyMatch` 对带连字符、**含字母**、≥8 的 ASCII 产品名（如 V4-Flash-Vision-Exp）精确命中账本 token，避免短 name 打不满 SHARE_MIN；**ISO 日期（`2026-09-13`）不得当强实体**（日报/linux.do 标题几乎每天都带日期）。

> **9/19 内容质量三件套（核查真实性 / 聚类误合 / 状态烘焙）**：① **外部抽查票**——forum/blog 来源的存活 claim 加 1 张**允许 WebSearch** 的独立佐证票（`externalVerifyPrompt`；内部 2+1 票禁外部搜索只做文本自洽，「引语整齐但不实」的论坛转述恰是盲区，9/17 实证网信办条目唯一来源是论坛转帖）：否决 → 翻转回 killed；佐证 → `externalCheck=corroborated`；不可用 → `externalCheck=unavailable` 且 Status 烘焙为「未核查」（三态判定 `externalCheckState`：代理失败 / 模型自报 `toolsUnavailable=true` / Verify 预算耗尽未轮到，**绝不冒充佐证**；degraded 旗标 `external_check_unavailable:N`，meta `external_check{targets,corroborated,refuted,unavailable}`）。② **Status 烘焙**——reportBody 素材行由编排层预烘 `Status:`（投票比 + 外部抽查结果），report prompt §4 只许照抄、禁止自行推导（旧版模型手抄投票比写错字面量即徽标丢失）。③ **聚类误合治理**——CJK 阈值 3→4、四字通用术语内部 bigram 全停用（人工智能/机器学习/数据中心等单个四字词即可凑满旧阈值 3 是误合根因）、簇大小上限 4（桥接 token 传递闭包不再串 5+ 条）、`mergeCluster` status 取「最已核查」（首条 `[窗口外·重大]` 不再把已核查项拖成未核查）。ledger 指纹改 ASCII/CJK **分桶各留 32**（旧版整体截 64、ASCII 在前，长英文 snippet 的中文 bigram 全被截掉 → 中文重复漏过硬过滤）。

> **8/31 P1 墙钟标定与计数型断路器（新增可选 args）**：realm 唯一时钟是 `setTimeout` 链累加器，它计的是 **tick 发生次数 × 250ms**，事件循环饱和时 tick 被饿死 → **只低估、永不高估**（8/31 生产 run 实测 Fetch gate ≥4.7×、Verify ≥6.6×、synth ≥7.6×，4h13m 的 run 零 `BUDGET-SKIP`，30min 软目标形同不存在）。修法两条：① **墙钟标定**——`setTimeout(ms)` 绝不早于 ms 真实毫秒触发，故每次真超时都证明「真实经过 ≥ ms」，与同窗口累加器增量相比即得饥饿倍率（`wallclock.mjs`），所有闸门读的 `RUN_ELAPSED` 已是标定后读数（**单调不减**，倍率回落不让已越线阶段复活；倍率封顶 20×；无观测时逐字节等价旧行为，健康跑零影响）；② **计数型断路器**——失败计数不依赖时钟，饱和下依然准确，`safeAgent` 终局失败/成功均记账，Discover 批首查 `BREAKER.open()`，跳闸即跳**代理**余批直连 static-fallback → Fetch（8/31 实测 Harvest 烧 70min、Discover 再烧 129min，而失败信号早已密集）。**linuxdo 是宿主预抓通道，消费在代理批循环之前，断路器跳闸不得丢掉已预抓 posts。** **9/01**：`phase('Discover')` 入口调 `BREAKER.resetConsecutive()`（清连续计数，不清累计 failures；已跳闸仍 open），Harvest 垫高的 consecutive 不得让 Discover 第一失败即跳闸。新增可选 args：`breakerConsecutive`（默认 3，连续失败跳闸阈值）、`breakerTotal`（默认 5，累计失败跳闸阈值）。**可审计**：日志 `BREAKER-OPEN Discover 余批跳过`、`[墙钟标定 … 饥饿倍率 N.NN×]`；降级旗标 `breaker_open:<reason>`、`wallclock_starved:<N>x`（**峰值**倍率 >1.5 且有真实观测时——先饿后恢复不抹旗标）；meta 增 `wallclock{raw_s,calibrated_s,starvation_factor,peak_factor,observations}`（`starvation_factor` 为最新倍率、`peak_factor` 为本 run 最高）与 `breaker{open,reason,failures,successes,consecutive}` 便于与宿主侧 `run-daily-win.sh` 记录的**真实 epoch** 三方对账。**10-05 P1 语义收紧**：raw/calibrated 仅 **workflow 内段**（runner 起始→workflow 启动之间的探针/模型换档段 realm 根本看不见，10-05 实测内段 2383s vs 全程 3661s）；全 run 真实总墙钟 = `wallclock.real_s`，由 finalize 宿主实测回写（`AI_DAILY_RUN_START_EPOCH` env，缺省 fail-open 不回填）。探针超时 `withDeadline(..., false)` **不**喂 `WALL.observe`（短窗不得污染标定）。

> **9/02 模型阶梯（仅 report + verify）**：`args.modelLadder` 默认 `deepseek-v4-flash` → `grok-4.6` → `claude-opus-4-8` → `gemini-3.7-flash-high`；`args.ladderBudgetMs` 默认 900000（15 分钟）。**仅 report / verify 走阶梯**（`safeAgentWithLadder`）；**harvest / discover / fetch 不走阶梯**，仍继承环境 `CLAUDE_CODE_SUBAGENT_MODEL` 经 `safeAgent`（不传 `model:` 字面量）。仅 TRANSIENT（422/429/5xx/524/timeout/gateway/cloudflare/model not found/upstream）或 `withDeadline` 超时 null 换级；schema / end_turn 等同级消化。**`withDeadline` reject 必须透传错误进工厂 catch**（不得 `settle(null)` 抹消息，否则生产里 schema 与 524 都长得像 `(null)`）。中间级失败不 `BREAKER.record`；终局 null 才由调用方记账。预算在当前级失败后再查，超了停在当前级；`ladderBudgetMs<=0` 关闭检查。**Verify 全阶段共享 `verifyLadderT0`**，票不得各自重新吃满 `ladderBudgetMs`。`reportTries` 仍是外层闸门（`allClaims.length === 0 ? 1 : 2`）：零素材只跑 `MODEL_LADDER[0]`，有素材才爬满四级。`generated_by` / frontmatter `model:` / 横幅跟 report 实际用到的模型（换级后的），不是永远 `MODEL_LADDER[0]`。降级旗标 `ladder_used:<label>:<model>+…`（非首级救回）、`ladder_exhausted:report|verify`（该阶段阶梯耗尽）。

### 5. 收尾与汇报
- 若 Workflow 返回 `artifacts` 且含 `payloads`：**4 个产物用 finalize 确定性落盘**——
  `node E:/code/DallyReport/ai-daily/scripts/ai-daily/finalize.mjs <workflow-result路径> --out "E:/profile/note/note/Note/AI/DallyReport/<date>"`。finalize 从 result 的
  `payloads.{claims,sources,meta,md}` 逐字节写入 `<date>.verified-claims.json`、
  `<date>.sources.json`、`<date>.meta.json`、`<date>-ai日报.md`，缺任一字段报错非 0 退出（可一键重放、可单测，
  不再依赖主会话手工 Write——8/21 直跑 Workflow 工具时曾因跳过手工落盘而缺失产物）。md 由 workflow 内确定性渲染
  （render-md 模块）产出，report 成功即完整版、失败即降级版，**必然成功**，不再有 mdWriter 代理。
  - **headless HOST-FINALIZE（09-21）**：编排器 422/Connection lost 死在 Write 前时，`run-daily-win.sh` 在 artifact-check **之前**跑 `node <REPO_AI>/scripts/ai-daily/host-finalize.mjs --date <T> --out <outDir> --since-epoch <WALL_START>`——从 workflow 会话目录 `wf_*.json` 找回本次 completed payloads 落盘。报告已在盘上则 `HOST-FINALIZE-SKIP report_exists`。烟测 /tmp json 对不上生产 outDir，不会误收。
  - 直跑 Workflow 工具（非 skill 入口）时，workflow result 落在 task 的 output 文件，用上述 finalize 命令即可落盘。
- 确认 `E:/profile/note/note/Note/AI/DallyReport/<date>/<date>-ai日报.md` 等文件存在，向用户给出：
  - 统计：`stats`（抓取 URL 数 / 提取 claim 数 / 核查数 / 确认数 / 否决数 / **重大超窗事实数 `major_out`**——`[窗口外·重大]` 行业里程碑，非窗口内、未经投票，但应出现在正文/头条并如实标注；11-11 起另有 `t1_sources` 信源分层与 `synth_body_hallucination` 幻觉替换数进 frontmatter）
  - 头条一句话：`headline`
  - 执行摘要：`summary`
  - 覆盖矩阵要点 + 确认无动态的厂商
  - **降级标记 `degraded`**（如 discovery_degraded / discovery_recovered / verify_agent_errors / fetch_budget_dropped / budget_skipped / `ladder_used:` / `ladder_exhausted:`）——必须如实转达。`discovery_recovered:<boards>` 表示这些板 discover 代理失败但已从 harvest entries 兜底救回 URL（通道仍 degraded、内容已补，不再标 missing）。`ladder_used:<label>:<model>+…` 表示 report/verify 在非首级模型救回；`ladder_exhausted:report|verify` 表示该阶段四级/预算耗尽。
  - **10/03 对齐参考日报的完整版新节**（render-md 确定性渲染，report 成功才出现）：
    `## 🔥 今日亮点`（report.highlights，2-4 条 {title, why}，只能来自已写入正文的事项）、
    `## 🔁 昨日话题追踪`（跨天账本确定性渲染——昨日/前日已报道条目 + 今日 confirmed storyMatch 命中 =「本次新增」，连续天数 streak 由 buildYesterdayTopics 计算，report 代理不写此节）、
    `## 📊 数据概览`（漏斗表：社区预抓帖 → 发现链接 → 抓取正文 → 提取声明 → 核查确认/否决 → 纳入正文 → 话题组，来自 meta.stats 扩展字段 community_topics/claims_extracted/topic_groups/included；11-11 起 AIHOT 质量/信源结构行同表渲染——`t1_sources`/`t2_sources`（官方一手/媒体分层）、`top_heat`（头条热度）、`fetch_receipts_reused`（回执复用省配额）、`synth_body_hallucination`（合成幻觉正文替换数）、`roundup_clusters`，有值才出该行）、
    `## 🧭 今日技术趋势`（report.trend 收尾综述段，有观点非流水账）。
    社区热度：mint 直铸 claim 带 `heat`（浏览/赞/回复），report 素材行「社区热度：浏览 N · 赞 N · 回复 N」——正文措辞写「社区」，**不点名论坛站名**（既有纪律）。
- 若 Workflow 返回 `error` 或产物缺失：降级处理，产出一份"未核查日报"到 `E:/profile/note/note/Note/AI/DallyReport/<date>/<date>-ai日报.md`（标注降级原因），并保留已归档 JSON；如实向用户说明失败点。
- 不要向用户重复贴全文大 JSON；贴 md 文件路径 + 摘要即可。
- **生成完成后清理本会话开起的浏览器/进程**：若本次生成过程中，我（编排器）为开发/调试而调用过 Playwright MCP / 启动过浏览器或 node 进程，则收尾时**只关闭我自己开起的那几个**（精确按本会话子进程/本会话写入的标记关闭，或用 `pkill -f 'playwright-mcp.*<本会话唯一标识>'`）。**绝不**去关用户自己开的 Chrome/浏览器/其他 Claude Code 会话的工具进程——那些不属于日报系统。关闭前用 `ps -o pid,etime,lstart,command` 复核该进程确实是本会话拉起、且不是其它会话/用户正在用的，再终止。本条为流程纪律：生成完日报即清理自身资源，不遗留占用。

## 产出物命名
- `E:/profile/note/note/Note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD-ai日报.md`
- `E:/profile/note/note/Note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.verified-claims.json`
- `E:/profile/note/note/Note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.sources.json`
- `E:/profile/note/note/Note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.meta.json`

## 手动补跑示例
```
/ai-daily --date 2026-08-12
/ai-daily --date 2026-08-13 --force
```
