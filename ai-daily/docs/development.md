# ai-daily 开发文档（唯一总纲）

- **日期**: 2026-10-03
- **状态**: canonical — 开发/架构唯一总纲；运维/排障见 vault `Note/infra/ai-daily Workflow 运维.md`
- **取代**: `docs/` 下 4 篇 dated 设计文档（见 §13 历史索引）+ README 旧架构描述

## 速读（当前有效 · 维护于 2026-10-03）
- **2026-10-31 ai-daily 全天颗粒无收的双层根因（TDZ + 上游劣化）**：① **workflow 模板 TDZ**——`ai-daily.template.js` 在 args/window 块（78 行）引用 `defaultWindowFrom`，而 date-utils 占位符块在其后（128 行区）：args 缺 window 的 launch 模块求值即 `ReferenceError` 秒死（失败 json 实证 args=[]）；传了 window 的 launch 三元短路从不触雷，故 10-06～10-30 一直存活。修复=占位符上提到 args 块前（占位符位置即求值顺序，声明 154 < 使用 196）+ 宿主把 `window:{from,to}` 字面量算好注入 launch prompt（双保险）。② **上游渠道劣化**：#161 justwoker（opus）全天 500/403 已禁用（恢复 SQL 存档 `/data/new-api/backups/channel161-disable-*`）；#162 hyb-claude **串会话**（探针返回其他用户的 Understood/Entendido 确认语，`--debug` 抓包实证；裸 API 全形状复测 200——只有 CLI agentic 形状中招）；晚间 gemini/deepseek 档 524 + 19:20 四档探针全灭 rc=2。阶梯 gemini 档 3.6→3.8（3.6 是 CLI 模型目录不存在的死档）+ launch prompt 强制真实工具调用（opus 曾 42s 叙事假执行）。网关本体健康（tebi new-api v29.71，单发/8 并发/大输入/工具调用全形状复测 200）。上游恢复后 `schtasks /Run /TN ai-daily` 即补产。

- 生产 Windows 唯一：任务计划程序 `ai-daily`（每日 08:40）→ `run-daily-task.cmd` → `run-daily-win.sh` → `claude -p`（skill 编排）→ Workflow 产物 → `finalize.mjs` 落盘 vault `Note/AI/DallyReport/<date>/`（10-06 迁入 Note/，与 DallyReport 主系统同根）。Mac launchd 与 `~/.ai-daily` 已于 10-03 清流。
- 逻辑真源 = `scripts/ai-daily/*.mjs`（15 个 inline 逻辑模块 + 11 个宿主 CLI）+ `ai-daily.template.js`（编排骨架）；`build.mjs` inline 生成 3366 行自包含产物 `.claude/workflows/ai-daily.js`（repo 内），`--sync-vault` 一步同步产物 + SKILL.md 到 vault `.claude/`。
- 全链路预算：MAX_FETCH/MAX_VERIFY 16，五阶段墙钟切片 540/480/480/300s（总 1800s），report 单次 600s；对抗核查 2+1 票；跨天账本硬去重 + 昨日话题追踪 + 社区热度（10-03 五要素已上线）。
- 测试：`cd scripts/ai-daily && node --test test/*.test.mjs`（**必须 cd 进目录**，repo 根跑 glob 不中）；当前 492 项 483 pass / 0 fail / 9 有意 skip。
- 纪律红线：CDP 只复用 9222 已运行登录态 Chrome；日报正文写「社区」不点名站名；secrets 不入库不进 prompt；`--date` 全量重跑禁止（Iron Rule，单节修复 only）。

## 1. 系统总览

```
任务计划程序 ai-daily（08:40, StartWhenAvailable）
  └─ run-daily-task.cmd（Git Bash 包装，日志 C:/Users/mango/.ai-daily/task.*.log）
      └─ run-daily-win.sh
          ├─ 同日幂等（当日 md 已存在 → skip）
          ├─ linuxdo-prefetch.mjs（宿主 Node，CDP 只复用 9222 登录态 Chrome）→ linuxdo-prefetch.json 落盘
          ├─ claude -p「运行 ai-daily skill」× ORCH_LADDER 编排阶梯（每档先工具类探针）
          │    └─ skill → Workflow({scriptPath: .claude/workflows/ai-daily.js, args})
          │         ├─ Phase Harvest   分组批量串行抓 feed → 紧凑 digest
          │         ├─ Phase Discover  分组发现 + linuxdo 三态消费 + 兜底三级（harvest→static→救回）
          │         ├─ Phase Fetch     板间轮询公平配额 + linuxdo mint 直铸（不占配额）
          │         ├─ Phase Verify    2+1 对抗投票 + forum/blog 外部抽查票
          │         └─ Phase Synthesize report 阶梯合成 → render-md 确定性渲染 → return payloads
          ├─ artifact-check.mjs（宿主产物自检；workflow 失败时 host-finalize.mjs 找回）
          └─ 墙钟审计 + 日志轮转（keep 20）
```

**关键设计决策**：Workflow realm 无 fs/模块解析 → 产物单文件自包含，workflow 只 return payloads 不写盘；落盘提升为宿主确定性 Node 命令（finalize），消除 LLM 转录写盘的丢文件/control-char 类故障（8/21-8/22 实证）。

## 2. 仓库结构与双仓镜像

```
ai-daily/
├── ai-daily.template.js @ scripts/ai-daily/     # 编排骨架（1378 行）：realm 适配 + 五阶段编排
├── scripts/ai-daily/*.mjs                       # 逻辑模块真源 + 宿主 CLI
│   ├── 纯逻辑模块（build inline 进产物）：url-polyfill date-utils schemas boards dedup budget
│   │   wallclock ladder fallback prompts render-md cluster ledger claim-gate linuxdo
│   ├── 宿主 CLI/模块（绝不 inline）：linuxdo-prefetch linuxdo-fetch cdp-fetch cdp-core
│   │   artifact-check host-finalize host-paths progress generate-poster finalize cli-main
│   └── test/*.test.mjs                          # 35 个测试文件，node --test 直调模块真源
├── .claude/workflows/ai-daily.js                # build 产物（repo 内，勿手改）
├── .claude/skills/ai-daily/SKILL.md             # skill 编排器（vault 侧另有同步副本）
├── run-daily-win.sh / run-daily.sh              # Windows 生产 / Mac（已清流，保留语义参考）
├── run-daily-task.cmd / register-task.ps1       # 任务计划程序包装与注册
├── docs/development.md                          # 本文档（唯一总纲）
└── docs/2026-08-*.md                            # dated 历史设计快照（见 §13）
```

**双仓镜像纪律**：`DallyReport/ai-daily/scripts/ai-daily/` 是版本管理真源（本仓）；vault `.claude/` 是运行时副本。**改模块逻辑 → 改 `.mjs` 真源；改编排 → 改 `ai-daily.template.js`；改完必须 `node scripts/ai-daily/build.mjs --sync-vault`**（构建 + 产物/SKILL.md 一步同步 vault，逐字节相同自动跳过；10-03 §12-⑥ 前为手工 cp）。`generate-poster.mjs` 有跨仓依赖（向上找 DallyReport 仓根 image-gen），两仓各一份镜像，层数不同。

## 3. 构建系统（build.mjs）

```
node scripts/ai-daily/build.mjs [--out <path>] [--check-only] [--sync-vault [vaultClaudeDir]]
# 默认写 ../../.claude/workflows/ai-daily.js（repo 内）
# --sync-vault（10-03 §12-⑥）：产物写盘成功后把「workflow 产物 + SKILL.md」同步拷入 vault
#   .claude/（默认 E:/profile/note/note/.claude，可跟目录参数或 AI_DAILY_VAULT_CLAUDE 环境变量）。
#   逐字节相同自动跳过（幂等）；同步失败只告警不判 build 失败。
```

四道护栏，任一失败不出产物：

1. **inline 顺序即依赖序**（MODULES 数组）：url-polyfill 最先（realm 无 URL 全局，缺失 → new URL() 抛错被 catch 吞 → 完整版 0 角标）；date-utils 在 boards/dedup 前（GROUPS_RAW 闭包引用 normURL）；cluster 在 ledger 前（指纹复用 clusterTokenize）。**10/03 起 cdp-core 移出 MODULES**——CDP 传输层（`fetch`/`WebSocket`）随 linuxdo 拆分归宿主 `linuxdo-fetch.mjs`，realm 不再需要。
2. **realm guards**：REQUIRED_MARKERS（linuxdoPrefetched / reportedLedger / webFetchViaCdp 消费入口必须在场）+ FORBIDDEN_INLINE（宿主 CLI 不得 inline、`process.*`/`require(`/裸 `fetch(`/`WebSocket`/`AbortSignal` 禁入 realm、禁裸调 fetchLinuxDoNews34）——防止「模板已改、产物仍走旧裸抓」的静默漂移。10/03 起从单条 `process.exit|require(` 扩为「宿主 Node 专有 API 整类拦截」，CDP 传输层偷渡不再可能。
3. **语法门**：产物 = 顶层 export(meta) + 顶层 await + 顶层 return 混合体，ESM/CJS 任一模式都非法。check 前断言顶层 export 有且仅有一行 `export const meta = {`，剥掉后整体包进 `async function __syntaxGate__(args)` 再 `node --check`（与 Workflow harness 以函数体语义加载同构）。
4. **占位符零残留**断言。

## 4. Workflow realm 约束（所有设计的根源）

| 约束 | 根因 | 适配 |
|---|---|---|
| 无 Date.now / new Date() / performance | 静态拒绝（resume 确定性） | setTimeout 250ms 自递归 tick 累加器 `_wallMs` 是唯一直接时钟；日期算术全走 date-utils 纯函数（`_calendarDayMinus` 纯日历逆推） |
| 无 fetch / WebSocket / fs / require / process | 单文件 realm | CDP 抓取前移宿主（linuxdo-prefetch）；落盘前移宿主（finalize）；产物只 return payloads |
| 无 URL 全局 | realm 未注入 WHATWG URL | url-polyfill 第一顺位 inline（仅 .href/.hostname/protocol） |
| args 可能以 JSON 字符串注入 | harness 偶发 | 模板头部兼容解包 |
| resume 从头跑 | 确定性要求 | tick 重新起算=重新计时；状态不跨 resume |
| TDZ 风险 | inline 后仍是函数体顺序 | REPORTED_LEDGER 等必须在对应模块 inline 之后赋值（09-20 实证事故） |

## 5. 五阶段流水线

模板常量（args 可覆盖）：`MAX_FETCH=16`、`MAX_VERIFY=16`、`MAX_URLS_PER_BOARD=6`、`AGENT_TIMEOUT_MS=360s`、`SYNTHESIS_LIMIT_MS=600s`、`LADDER_BUDGET_MS=900s`、`TOTAL_LIMIT_MS=1800s`、`WALL_CALIBRATE_MS=120s`（标定窗长，0=显式禁用）、`CDP_FETCH_CLI`（Windows 仓绝对路径）、`GROK_DIR`（C:/Users/mango/.agents/skills/grok-search）——后两项 10-03 P0-D 前硬编码 Mac 路径，Windows 生产下 9222 fetch 通道与 grok-search skill 全哑。

### Harvest（切片 540s）
- 唯一 feed 去重（feedMap，共享源只抓一次）→ GROUPS_RAW 5 组（official/cn-media/en-media/opensource/academic）→ `HARVEST_BATCH=3` 批量串行，`tries=1`，单代理上界 1800s（8/16-8/19 实证：360s 死线会丢弃已完成的慢结果）。
- 产出 digestByKey（normURL(feed) → entries≤15 + recent≤4），按 feed 标签归栈，未标 feed 的条目单 feed 组归该 feed、多 feed 组丢弃（防串栈）。
- arXiv 官方 API 源单独放宽 40000 字符（Atom XML 50 条目 ≈42KB，普通 12000 会截到 header）。

### Discover（切片 480s）
- DISCOVER_GROUPS_ALL 6 组随选板派生（labs/opensource/academic 单板 + media-cn/media-en 合组 + linuxdo）；`DISCOVER_BATCH=3`，labs 1800s / 其它 2400s，`tries=1`（8/17 实证 tries=2 在网关差窗口救不回反而烧 80min）。
- **linuxdo 组在代理批循环之外、之前三态消费**（不被断路器/批 break 丢掉）：skip（无 cdpHost，urls:[] 不降级）→ failed（无有效预抓数据，realm 不裸抓）→ OK（预抓 JSON → 窗口预过滤 + likeCount desc 排序 → slice 配额 `LINUXDO_MAX_SOURCES=12`）。
- 闸门顺序（批边界）：budgetGate('Discover') → `roomTo('Fetch') < 480s` 保留窗（8/26：慢 discover 不得拖垮 Fetch 整段跳过）→ `BREAKER.open()`（8/31：计数断路器是事件循环饱和下唯一可靠闸门）。
- **三级兜底**：① harvest-fallback（disc 失败组从 digestByKey 补 entries，合组 board 按 feed.boards∩g.boards 派生——CRITICAL-1）→ ② static-fallback（全组 missing 或 0 URL+自报 degraded → 注入常驻一级页，`url` 不伪造 date）→ ③ 账本硬过滤（近 3 天已报道候选丢弃，storyMatch）。

### Fetch（切片 480s）
- linuxdo 治理（mint 前）：**LINUXDO-GOVERN** 出链帖（snippet 含 GitHub/arXiv/官网外链）→ 把外链 URL 转为真实 fetch 目标（found_via=linuxdo-outlink，提权必先抓——9/19 F7 引用造假根因修复）；空 snippet 帖丢弃计数（匿名抓必 403，进配额即白烧）。
- **LINUXDO-MINT 在 allocateFetchBudget 之前**：cdp snippet 直铸 forum 源（claim=正文首句，quote 可溯源，heat{likes,views,replies} 随行），铸出的 URL 从 boardURLMap 剔除不占 MAX_FETCH（09-20 实证：mint 在配额后会挤掉整板官方源）。
- `allocateFetchBudget` 板间轮询公平（每轮每板至多 1）+ prefer 通道按通道轮询等分（preferCap=⌊16×0.5⌋=8，linuxdo-cdp/linuxdo-outlink/static-fallback 三通道）；`FETCH_BATCH=6` 首批固定（allocate 已混排，不得扩首批）。
- `tries=2`；`bindExtractedClaims`：static-fallback 索引页缺合法文章 sourceUrl 的 claim 丢弃计数（indexClaimDropped），文章页回落 src.url 不计数。

### Verify（切片 300s − 60s inflight buffer）
- 配额按板比例分配（重板 arXiv 不得挤掉财经头条）→ rankedClaims 跨板轮询。
- **2+1 自适应投票**（语义与 3 票时代逐字一致）：round0 并发 2 票；双否→kill、双过→存活；分歧/缺票补 1 票。survives ⇔ valid≥2 且 refuted<2。全 Verify 共享一个阶梯 t0（多票不得各自吃满 LADDER_BUDGET_MS）。
- **外部抽查票**：forum/blog 存活 claim 加 1 张允许 WebSearch 的独立佐证票（2+1 内部票禁外部搜索，「引语整齐但事件不实」的论坛转述恰好能通关）；`externalCheckState` 三态——refuted 翻转回 killed / unavailable 烘焙「未核查」（绝不冒充已核查）/ corroborated。
- 配额内被 salvage/BREAK 截断的 claim 记 unverified 不蒸发（09-21 实证）。

### Synthesize（report 单次 600s × tries）
- 探针 advisory（只观察，不否决合成——8/29 实证单次探针超时曾把 9 条已确认内容整块降 raw）。
- report tries：当日有 claim → 2，全空 → 1；有内容走全阶梯，空板仅首档。
- status 由编排层烘焙进素材行（`_bakedStatus`：[窗口外·重大] / 未核查 / 已核查 N-M）；`_heatLine` 社区热度行（浏览·赞·回复，全 0 不产）。
- **report 幻觉引用确定性过滤**：items.sources 只保留 confirmed 真实 sourceUrl 集合（normURL）命中的，丢弃计数 `report_source_hallucination:N`。
- 失败 → `renderDegradedMarkdown` 降级版 md（必然成功，纯字符串拼接）。

## 6. 关键子系统

### 6.1 墙钟与断路器（三道闸门，8/31 P1）
累加器在事件循环饱和下**只低估**（8/31 实测 Fetch gate 低估 ≥4.7×，4h13m run 零 BUDGET-SKIP）：

1. **budgetGate**（预算.mjs）：累计死线 = 切片和（Verify 另减 60s inflight buffer）；超限记 budget_skipped 一次性；`roomTo()` 纯读不记账（批边界用）。
2. **WALL 标定**（wallclock.mjs）：`withDeadline` 真超时是「真实经过 ≥ ms」的硬证据，与同窗口累加器增量相比得饥饿倍率 → `WALL.observe` 标定（maxFactor 20 封顶 + 单调闸防时间倒流）；探针/短窗超时传 `observe=false` 不污染倍率。**周期标定链（10-03 §12-③ 根因版 `makeWallCalibrator`）**：窗口首尾相接的标定仪器（fire 即续排下一窗，观测无缝隙），每窗 `wallCalibrateMs`（默认 120000，0=显式禁用，非法类型 fail-fast）喂 `WALL.observe`；**nominal 必须 ≫ tick 粒度（250ms）**——首版 nominal=250ms 时 delta 恒为整数拍、factor 只能取 {1,null}，2s 全饱和实证 factor=1（仪器 no-op，review 抓出后抽成可注入假时钟的工厂并行为级测试锁死）。健康跑 factor=1 零影响零日志；饱和跑 fire 晚到、delta 停在解除批次首拍 → factor=win/delta ≫1。meta 记 wallclock{raw_s, calibrated_s, starvation_factor, peak_factor, observations, calibrate_period_ms}，与宿主侧 epoch（run-daily-win.sh WALL_START）三方对账。
3. **BREAKER 计数断路器**：不依赖时钟（饱和下计数依然准确），连续 3 或累计 5 次代理失败跳闸 → Discover 余批跳过直连 static-fallback。Discover 入口 `resetConsecutive()`（Harvest 失败不外溢，已跳闸仍 open）。中间失败不得自吃计数（ladder 工厂不碰断路器）。

### 6.2 模型阶梯（两个层面，勿混淆）
- **realm 内 ladder**（ladder.mjs，作用于 report/verify 代理）：`DEFAULT_LADDER = [deepseek-v4-flash, grok-4.6, claude-opus-4-8, gemini-3.7-flash-high]`，args.modelLadder 可覆盖。仅 TRANSIENT（524/5xx/429/timeout/gateway）换级，null（超时）也换级（safeAgent 的唯一偏离），schema/end_turn 同级消化；LADDER_BUDGET_MS 900s 全程共享（verify 多票共享 t0）；中间失败不计入断路器。**重排决策待数据（10-03 §12-①）**：是否按网关实证把 opus 置首，等 10-04 run 的 `meta.ladder` 字段（report 实际尝试序 / verify 各档计数 / exhausted）确认 realm 内 deepseek 同病后再动——不盲改（verify 票全走首级，重排会把全部核查票抬到 opus 计价）。
- **宿主编排器阶梯**（run-daily-win.sh `ORCH_LADDER`，作用于整个 claude -p launch）：`[gemini-3.8-flash, deepseek-v4-flash, grok-4.6]`（2026-11-01 起 claude-opus 整档移除——Workflow 工具按模型可用性缺失 + 上游串会话；gemini-3.8 主写、deepseek 兜底）——10/02 网关实证后 opus 置首（deepseek 经 CLI 静默空回、gemini 把 launch 指令当闲聊不跑 skill）。每档先文件读 sentinel 探针（GATEWAY-TOOL-PROBE-SENTINEL，防短问答 200/tools 400 假阳性），快死 <600s 才重拉，≥600s 无产物 = workflow 深处失败不盲目重拉（SLOW_DEATH）。

### 6.3 跨天账本（ledger.mjs）
- 路径 `C:/Users/mango/.ai-daily/published-ledger.json`（HOME 而非 vault——无头上下文读 vault 会被拒，8/31 P4 实证）。
- 条目 `{day, url, tokens(≤64 分桶截断), title(≤80), major}`；记录端 finalize **先落盘后记账**（顺序曾反转导致次日硬过滤压制正当报道，9/19 P2-1 恢复），账本损坏备份 `.corrupt` 再重建，tmp+rename 原子写，60d prune，烟测 outDir 隔离（PROD_DALLYREPORT_PREFIX 判定）。
- 消费端 `storyMatch` 四级硬判定：URL 归一命中 → overlap≥0.8 且共享≥5 token → 连字符≥8 强 ASCII 实体精确命中 → 特异 ASCII（非通用词表）共享≥2 或带数字版本号。
- 生产前缀判定 `isProdOutDir` 吃**前缀列表** `PROD_DALLYREPORT_PREFIXES`（10-03 P0-B：Windows vault 路径置首 + Mac iCloud 兜底 + AI_DAILY_PROD_PREFIX 环境变量；此前 Mac 单前缀在 Windows 恒 false → 生产 LEDGER-SKIP + poster 永不跑）。
- 三个消费点：fetch 配额前硬过滤（lookback 3d）/ 种子退役（报过一次即退役，不看 lookback）/ report prompt 软网 reportedBlock（兜同事件换 URL，账本按 day 过滤不能 slice 头部——头部是最老条目）。
- **buildYesterdayTopics**（10-03 五要素）：昨日+前日条目（lookback 2）+ 今日 confirmed 中 storyMatch 命中 = 「本次新增」；streak 连续天数从**条目自身 day-1** 纯日历逆推（从 t 回看会命中条目自己——实测修正），回看走 day→entries 倒排索引（10-03 §12-⑤，O(回看×全账本)→O(回看×当日桶)）。

### 6.4 linuxdo 链路（CDP 纪律）
只复用 9222 已运行登录态 Chrome，绝不启动/关闭浏览器本体（只 /json/new + /json/close 临时标签）。链路：宿主 prefetch（列表页收齐 → 噪声过滤 → likeCount desc 排序 → 只深抓前 16 条富化正文+探测出链）→ JSON 落盘（本体永不进 claude -p 命令行，标题引号破 shell）→ args 注入 → 窗口预过滤+配额 → GOVERN → MINT → verify 正文行「社区热度」。无预抓数据时 realm 不裸抓（裸 fetch 必 403），如实降级 linuxdo_degraded。

### 6.5 major-out 注入（窗口外·重大）
行业里程碑级公认事件直入正文/头条但不冒充投票（vote '—'，confidence null，verifiedByVote false）。双源：discover 代理 majorOutOfWindow（age gate 14d）+ KNOWN_MAJOR_OUT 种子（age gate 21d，url 全量强制——纯媒体口径不收录）。去重三道：majorKey 指纹（顺序锁定：hassabis 在 jeff-dean 前）→ storyMatch 对本轮 confirmedVerify/majorOutClaims/账本互斥（MAJOR-DUP）→ 种子 splitSeeds 退役。

### 6.6 确定性渲染（render-md.mjs）
md 由 workflow 内纯字符串拼接产出，**必然成功**，report 成功即完整版、失败即降级版。节清单（存在才渲染=信息熵契约，不摆空骨架）：🔥 今日亮点（highlights）→ 一句话 → 执行摘要 → 🔁 昨日话题追踪（yesterdayTopics）→ 各板块 sections → 📎 窗口外参考 → 开放问题 → 📊 数据概览（漏斗表）→ 🧭 今日技术趋势（trend）→ 覆盖自检。buildCitationMap + buildCitationMap 幻觉防线（编号只挂真实 sourceUrl）。10-03 五要素（亮点/追踪/热度/漏斗/趋势）全部确定性渲染，report 代理不写这些节。

### 6.7 schema 契约（schemas.mjs）
REPORT_SCHEMA required = [oneLiner, execSummary, sections, caveats, openQuestions]；10-03 新增可选 `highlights`（≤4 条 {title,why}）与 `trend`——required 不变，旧产物/降级路径不填照常过 schema。item.status 枚举字面量（render 依赖精确值判定）。VERDICT_SCHEMA 含可选 `toolsUnavailable`（外部票三态判定的唯一可信信号）。

## 7. 降级旗标全表（排障核心，如实进 meta.degraded 与用户汇报）

| 旗标 | 触发 |
|---|---|
| `discovery_degraded:missing_<boards>` / `discovery_degraded` | 归属组全部无返回 / 有组自报 degraded |
| `discovery_recovered:<boards>` | disc 失败但 harvest entries 已补（通道 degraded、内容已补，不再标 missing） |
| `fetch_budget_dropped:N` | fetch 预算硬上限丢弃（meta.dropped_detail 分桶：linuxdo_cdp/static_fallback/other） |
| `verify_agent_errors:N` | 核查票代理错误 ≥1 |
| `budget_skipped:<stages>` | 阶段墙钟累计死线跳过 |
| `breaker_open:<reason>` | 计数断路器跳闸（consecutive_failures/total_failures@label） |
| `wallclock_starved:<f>x` | 饥饿倍率观测 >1.5 |
| `linuxdo_degraded:<reason>` | linuxdo 通道失败（no_cdp_host 跳过不算降级） |
| `ladder_used:<label:model…>` / `ladder_exhausted:<stage>` | report/verify 非首级救回 / 阶梯全废 |
| `index_claim_dropped:N` | 索引页 claim 缺合法文章 sourceUrl 被丢弃 |
| `external_check_unavailable:N` | forum/blog 外部抽查未完成（status 已烘焙「未核查」） |
| `report_source_hallucination:N` | report 编造的 URL 被确定性过滤 |
| `ledger_unavailable` | 无账本注入，本轮跨天去重关闭（fail-open 不阻断成稿） |
| `report_failed` | report 阶梯全废 → 降级 raw archive（仍出 md） |

meta.json 另有 `ledger_recorded`（recorded/skipped/failed，finalize 回写）与 `wallclock` 三方对账块。**所有降级必须如实转达用户，不得静默。**

## 8. 产物契约

`Note/AI/DallyReport/<date>/` 下 4+1 个文件，全部 tmp+rename 原子写：
`<date>-ai日报.md`、`<date>.verified-claims.json`（confirmed/refuted/unverified/outOfWindow）、`<date>.sources.json`、`<date>.meta.json`、`AI.png`（海报，isProd 才生成）。md 由编排器从 payloads.md 落盘。缺任一 payload 字段 finalize 报错非 0 退出。

## 9. 落盘与自检链（宿主 CLI）

| 脚本 | 职责 |
|---|---|
| `finalize.mjs` | 4 产物逐字节落盘 + 账本记账 + 海报；先落盘后记账 |
| `host-finalize.mjs` | 编排器死在 Write 前时，从 `~/.claude/projects/<cwd-slug>/<uuid>/workflows/wf_*.json` 找回 completed payloads 落盘（report 已在盘则 SKIP）。会话目录由 cwd 推导（`host-paths.mjs`），不再硬编码 Mac 会话名；`run-daily-win.sh`/`run-daily.sh` 都在 artifact-check **之前**调用 |
| `host-paths.mjs` | 宿主路径单一真源：`os.homedir()` + cwd slug → Claude 会话目录；`~/.ai-daily` 运行时目录。三个宿主 CLI 共用，杜绝 `process.env.HOME || ''`（无头 shell 下为空）与硬编码会话名 |
| `artifact-check.mjs` | 宿主产物自检摘要（md_bytes/confirmed/degraded/killed）；Windows 显式传 --dir（默认是 Mac iCloud 路径，HOME 取 `os.homedir()`） |
| `progress.mjs` | headless 终端单行进度（不画假百分比：墙钟 vs 30min / 五阶段推进 / 真实票数）；日志/会话路径走 `host-paths` |
| `cdp-fetch.mjs` | fetch 子代理经 Bash 调用的通用文章页 CDP 抓取（webFetchViaCdp:true 时，失败回落 WebFetch） |
| `linuxdo-fetch.mjs` | 宿主专用 linux.do CDP 抓取（`fetchLinuxDoNews34`，10/03 自 linuxdo.mjs 拆出）；复用 `cdp-core.mjs` 传输层，不 inline 进产物 |

## 10. 测试体系

- **必须 `cd scripts/ai-daily` 跑** `node --test test/*.test.mjs`（repo 根跑 glob 不中 → 0 tests 假绿）。
- 当前 453 项：444 pass / 0 fail / 9 有意 skip（2026-10-03 第四轮根因修复：Windows runner 契约测试 7 项新增（此前 7 条 shim 断言在 Windows 全 SKIP）、host-paths 6 项、标定链 rejection 兜底 2 项、build 护栏「宿主 API 整类拦截」1 项；10-04 烟测再补预抓失败日志 rc 捕获回归 1 项）。
- 测试原则：**纯函数直调**（测试直调 buildFallback/externalCheckState 等真实实现，不 grep 模板源码——消除 forward-test 缺陷）；realm 隔离（wallclock/budget 时钟注入 mock）；fail-open 契约固化（坏输入→null/[]，不抛穿）；skill-doc-contract 锁 SKILL.md 关键字面量（改 SKILL.md 前先看该测试）。
- 改动门禁：主仓根目录的 DallyReport 代码/测试改动必须先通过 `npm run check`（ESLint `no-undef` + 根目录全量测试）；`node --check` 只能证明语法可解析，不能替代未声明标识符检查。`ai-daily` 的 `ai-daily.template.js` 与生成的 `.claude/workflows/ai-daily.js` 使用工作流运行时语义，禁止按普通 Node 文件直接 `node --check` 或纳入根目录 ESLint；本子系统改动必须运行 `cd ai-daily/scripts/ai-daily && node --test test/*.test.mjs` 与 `node build.mjs --check-only`，再按既有流程同步 vault 产物并提交两仓。

## 11. 历史设计文档索引

| 文档 | 状态 |
|---|---|
| `2026-08-13-ai-daily-report-design.md` | 历史快照——初版设计（Mac launchd + seed 扫描架构，seed_URLs.json 已不存在）；需求/目标/覆盖模型仍有溯源价值 |
| `2026-08-18-ai-daily-refactor-design.md` | 历史快照——模块化重构（模块真源 + build inline + md 去代理化），机制仍是当前架构核心，changelog 已止于 8/18 |
| `2026-08-20-ai-daily-age-gate-design.md` | 历史快照——种子 age gate 设计，机制仍有效 |
| `2026-08-20-ai-daily-room-timeout-fix-design.md` | 历史快照——room-as-timeoutMs 错配修复史；语义已演进为「固定上界 + 批间 BREAK」（8/20 第十六项） |
| `superpowers/specs/2026-08-22/23-*.md` | 历史快照——sources-uncertainty / linuxdo-cluster-adaptive 设计快照 |

8/22 之后至 10-03 的迭代（windows 迁移、账本、prefetch 隔离、wallclock 标定、断路器、阶梯、mint/govern、索引页治理、五要素对齐）**无独立设计文档**，决策依据记录在各模块头注释与 vault 运维文档变更记录——本文档 §5-§7 即当前状态的权威描述。

## 12. 设计债务（2026-10-03 review → 同日第二轮清偿）

首轮 review 记录 6 项；同日第二轮开发清偿 5 项 + 新发现 4 项 P0 Windows 迁移缺陷（均已修，见 §13）：

1. ~~**realm 内阶梯首档与网关现状不匹配**~~ → **观测先行（已实现，重排待数据）**：meta 新增 `ladder{report:{used,tried}, verify:{tried_total,by_model}, exhausted}` 结构化账目；DEFAULT_LADDER 顺序暂不动（verify 票全走首级，盲排 opus 置首会把全部核查票抬到 opus 计价），等 10-04 run 的 meta.ladder 实证 realm 内 deepseek 是否同病后再决策。
2. ~~**`preferStaticFirst` 死导出**~~ → **已删除**（dedup.mjs 导出与 prefer-static.test.mjs 一并移除；allocateFetchBudget prefer 通道语义由 dedup.test.mjs P2 系列全覆盖）。
3. ~~**墙钟标定观测盲区**~~ → **已根因重建（review 后二次修复）**：review 实证 250ms 首版是 no-op 仪器（nominal==tick 粒度 → factor∈{1,null}，2s 全饱和 factor=1）且 0=禁用被默认分支吞掉。根因修复 = 仪器抽为 `wallclock.mjs makeWallCalibrator` 纯工厂（窗口首尾相接 + nominal≫tick 约束写进契约 + setTimer/readAccum/observe 全注入），默认窗 120s=480 拍；6 项行为级测试锁死健康/饱和/cap/幂等/禁用/fail-fast。
4. ~~**Windows 通知未实现**~~ → **已接 PowerShell WinRT toast**（run-daily-win.sh notify()；失败回落 log-only，真机验证通过；review 后补 `ps_escape` 单引号转义 + 撇号文案端到端验证）。
5. ~~**streakOf 复杂度**~~ → **已改倒排索引**（day→entries 预分组一次建表，每步只 match 当天桶；行为逐字节不变，29 项 ledger 测试全绿）。
6. ~~**双仓手工 cp 漂移**~~ → **build.mjs 已加 `--sync-vault`**（产物 + SKILL.md 一步同步，逐字节相同跳过；review 后补：失败路径 VAULT-SYNC-WARN 且 exit 0 有测试；去掉 `export` 防「import 即 main() 写盘」雷区）。

**review 第三轮补修（同日）**：② build.mjs 去 export + 失败路径测试；③ run-daily-win.sh `mkdir -p` 挪到 PATH 导出后（PATH 导出点之前不得有外部命令的纪律收口）+ notify() 参数 PS 转义；⑤ finalize `AI_DAILY_PROD_PREFIX` 改惰性读取（isProdOutDir 每次调用组装，不再模块加载期突变导出数组）+ 子进程 env 测试。
**遗留观察（不阻塞生产）**：~~① DEFAULT_LADDER 重排决策~~ → **已复盘关闭（11-11，见 §12.1）**；② artifact-check.mjs 默认 --dir 仍是 Mac iCloud 路径（Windows 生产显式传 --dir，无实际影响）；③ generate-poster 跨仓双镜像布局（有探测兜底，风险低）。

### 12.1 DEFAULT_LADDER 复盘结论（11-11 P8，观察项关闭）

10-29 ~ 11-10 共 11 个自然日 meta.ladder 实证（`E:/profile/note/note/Note/AI/DallyReport/<date>/<date>.meta.json`）：

| 结论 | 数据 |
|---|---|
| **verify 首档 deepseek 健康，重排仍无必要** | verify `by_model` 合计 236 票中 deepseek-v4-flash 224 票（94.9%）、grok-4.6 9 票、其余档 3 票；11 个 run 全部 `exhausted: []` 或仅 report 一档 |
| **report 深档救回率低且可自愈** | 11 天仅 2 次非首级成稿：11-02 report 四级爬满落 gemini-3.7-flash-high（exhausted:["report"]，仍出刊）、11-07 三级落 claude-opus-4-8；其余 9 天首档直出 |
| **编排器外档（ORCH_LADDER）与 realm 内阶梯已分工明确** | runner 侧 gemini-3.8-flash 置首（10-31 决策），realm 内 deepseek-v4-flash 置首——两层各自实证可用，互不干扰 |

**决策：DEFAULT_LADDER 维持 `[deepseek-v4-flash, grok-4.6, claude-opus-4-8, gemini-3.7-flash-high]` 不动。**
理由：verify 是票数大头（236 票 vs report 11 次），其 94.9% 首档命中率说明首档网关可用性健康；report 爬级 2/11 天的代价是可接受的（有素材日 ladderBudgetMs 900s 内自愈，无素材日零票不受影响）。若未来某周 deepseek 首档 TRANSIENT 率显著抬升（`ladder_used:verify` 连续出现），再评估把 grok-4.6 置首——数据触发的重排，不做预防性盲改。

## 13. 变更记录

- **2026-11-14（11-13 黄仁勋 case 复盘 → 质量闸三修）**：深想「怎么保证日报质量」后把结论落成三件结构修复（11-13 的 8 条 unverified 全为 linux.do 社区噪声、6 条 confirmed 全 T1 的数据支撑）：
  - **[gate·附件名直出伪 claim]** 11-13 unverified 里 3 条 Discourse 图片文件名伪 claim（`IMG_0610 1293×1056 127 KB`、`77d5d7ae…f6a4 1320×1735 179 KB`、`IMG_4628 1290×621 108 KB 不会真的是…`）漏过 claim-gate——既有模式表假设 `image ` 前缀必在，论坛 mint 路附件名直出没有该前缀。`claim-gate.mjs` 补四类机械模式：IMG_ 序号开头 / ≥16 位十六进制哈希开头 / 图片扩展名直出（含带空格名）/ 附件名开头+宽高对（尾部评论残片不影响判定）。**11-13 真实数据回放：3 垃圾全拦、6 confirmed 零误杀**；反例锁死（`IMG 架构吞吐提升 25%`、`该分辨率 1293×1056 的截图…` 不误杀）。
  - **[boards·outlink 假 primary 域名封顶]** 黄仁勋链路复盘实证：linuxdo-outlink 的 sourceQuality 由 fetch 代理自判（只看页面长相，无域名真伪校验），本次真身 nvidianews 通过了每一道门——机制上社区帖外链到转载/自媒体/仿冒域同样能拿 primary、骗过 verifyPrompt 的一手源宽松默认（默认 refuted=false）。新增 `capOutlinkQuality`（boards.mjs 纯函数，与 sourceTier 同域）：`found_via==='linuxdo-outlink'` 且 primary 的来源/claim，域名必须命中 TIER1_HOSTS（host 后缀判定）否则封顶 secondary 并计数；template fetch 绑定点接线，`meta.outlink_quality_capped` 入账。真 T1 回放行为不变、仿冒域 `openai.com.evil.io` 不借 T1 通票（4 行为测试）。
  - **[template·breaker 跳闸阶段戳]** `breaker_open:consecutive_failures:3@fetch:github.com` 看不出跳闸发生时处于哪个阶段（早期跳闸拖累全天 vs 尾部跳闸影响有限）。BREAKER 包装器化：跳闸瞬间（open 由 false 翻 true 的那一次 record）盖 `_TRIP_STAMP='@stage=<当前阶段>@t=<累加器秒>s'`（`_CURRENT_STAGE` 在五个 phase() 切换点跟踪），degraded 旗标与 `meta.breaker.tripStamp` 双消费；stats getter 透传。两个旧模板文本锁随包装器化更新（resetConsecutive 断言改为从 phase('Discover') 起找调用点，防包装器定义处误配）。
  - **认识论边界（运维文档化，不写代码）**：对抗投票验证「材料↔来源一致」，官方 T1 页面是链条终点；extraordinary claim（人事变动/收购/倒闭/安全事件）真伪由人工扫标题层交叉确认（每天 ~30 秒），工具层不可再兜底——已写入 vault 运维文档速读段。
  - 全量 **537 项 528 pass / 0 fail / 9 有意 skip**；产物 3778 行 `--sync-vault` 已同步。**11-15 08:40 起生效；观察点：新报告 unverified 应无图片文件名伪 claim、meta 应出现 outlink_quality_capped / breaker.tripStamp 字段。**

- **2026-11-12（11-12 事故三修 · `19569a4`/`b936f8a`）**：08:40 定时 run `GATEWAY-ROUTE ABORT`（当日空转）+ 09:42 手动重跑验收，连环根修三件：
  - **[runner·路由探针单发 `19569a4`]** 路由选择块只调一次 `probe_gateway`——gemini-3.8-flash 上游负载均衡 TTFT 抖动（504 `loadbalancer: time to first token timeout`，同请求 5s~91s 方差实测）一击即弃 → 当日放弃。debug 追踪另实锤并发问题：上游某渠道额度耗尽时 403 `insufficient_user_quota` 原样透传（"余额 $0.14" 实为**渠道级**余额，非用户钱包——用户侧确认无需充值）。根修：改走 launch 段同款 `probe_wait`（3 次重试 + 30s 间隔），渠道抖动靠重复请求消化；ABORT 消息带末次 `PROBE_LAST_OUT` 便于归因。网关侧需求（用户已提）：渠道 403 不透传、自动换渠道。
  - **[render·合成乱码门 `b936f8a`]** 11-11 成品三处合成期漏网（`sources.json` 干净、成品正文污染）：FFFD×2（「吞吐�� x86」）、生僻错字（「工作巟。」U+5DDF）、无关短语插入（「5 倍批发契约合约条款第 7 条」——`synth_body_hallucination:5` 的漏网之鱼）。`extractSynthAtoms` 只提拉丁/数字原子，编码损坏完全在盲区。新增 `synthMojibakeHit` 确定性乱码门（FFFD + CJK Ext-A/兼容/私有区）→ 命中整段替换为 claim 原文。**误杀实测收敛**：常用区金标外单字判定不实现——金标是压缩改写语料，正常同义换词（'准确率' vs 金标'成功率'）即触发，误杀率不可接受；「批发契约」类搭配判定同样暂缓。小而准优先。
  - **[render·windowMisses 短名折叠 `b936f8a`]** 11-11 窗口外参考「基元律动发布NeoHorse-1.5-Flash Preview」与「基元律动」同事件两行漏折——纯中文短名（<8 字）被 `includes` 长度门槛与 CJK bigram 共享门槛（3 字名最多 2 bigram < 4）双重排除。`wmNearDup` 补包含短路（去停用 bigram 后实质 token ≥2 才折，泛称不折防误杀）。
  - **[render·auditReportBodies 落盘形变防御 `b936f8a`]** 端到端复现实锤：template 内存金标是 `c.sourceUrl`、finalize 落盘形变为 `c.source`——`auditReportBodies` 只认 sourceUrl，替换路径在落盘结构下**永远失配**（`res.replaced` 恒 0）。双字段兼容（`sourceUrl || source`）。
  - 全量 **531 项 522 pass / 0 fail / 9 有意 skip**；产物 3719 行 `--sync-vault` 已同步。11-12 重跑 gemini 档慢死（1949s 无产物）→ 阶梯自动换档 deepseek-v4-flash 探针过，验证继续。

- **2026-11-11（11-11 晨间自然 run 验收 + 三根修 · `c5ffbcd`）**：08:40 bake 首战自然 run **rc=0**（46m43s，confirmed=16/urls 25/46，10 板全覆盖零 degraded 板块）——host-inject bake 通道生产首验通过（`ledger_injected:224`、无 `ledger_unavailable`、记账 16 条、P1 质量行全部渲染）。验收抓到并根修三问题：
  - **[P1·回归 P6 stats 引用]** P6 抓取率门引用了未定义的 `stats` 变量（stats 只内联进 meta 字面量，门位置在 meta 之前）→ realm ReferenceError，后处理崩溃；子代理以 `sources.length` 临时恢复落盘（未改 bundle 原文件，产物如实）。根修：门取数内联同口径（`sources.length` / `discoverRows.reduce`，与 meta.stats 逐字同源）+ 契约测试 3 断言锁死「不得引用 stats 变量」。
  - **[P1·prefetch 瞬态重试]** 11-02/09/10/11 晨 08:40 连续四天 prefetch 一次性失败（`empty_pages`/`fetch failed`/`prefetch_failed` 三形态）而手动复跑全 OK——晨间 9222 Chrome 抖动属瞬态，原实现一次失败即 `ok:false` 落定（社区信源断供整天）。`runPrefetch` 瞬态类重试 2 次（3s/8s 退避）；`empty_posts`（全噪声，确定性）豁免；连带修复 `prefetchLinuxDo` 失败 reason 归因（抓到页但 posts 空时误标 empty_posts）。
  - **[数据·11-02 补账]** 11-02 出刊 `recorded_count=5` 但账本 0 条——10-31 覆盖事故连带损失（11-10 重建脚本 DAYS 硬编码漏 11-02），非 finalize 记账断层（meta 实证当天记账路径正常）。按 11-10 同口径补账 5 条（makeLedgerEntry + normURL 去重 + `isJunkClaim`），账本 224→229，`parseReportedLedger` 消费端验证通过（备份 `.bak-20261111-rebuild`）。11-03/04 rc=1 无产物，真实无账可记。
  - **[观察·task.err.log]** syntax error 三条为 11-01 01:09 编辑窗口期历史残留（mtime + git 历史实证），当前 runner `bash -n` OK + 13/13 契约绿，非现行缺陷。
  - 全量 **524 项 515 pass / 0 fail / 9 有意 skip**；产物 3683 行 `--sync-vault` 已同步（重建后已重 bake）。

- **2026-11-11（P 系列优化批 · 12 项清偿）**：11-10 注入链四连事故根治（host-inject bake，`5f7de38`）后的优化迭代，Explore 全仓 survey → 12 项分优先级执行：
  - **[P1 AIHOT 可观测性闭环]** `render-md.mjs` 漏斗表增质量/信源结构行（`t1_sources`/`t2_sources`/`top_heat`/`fetch_receipts_reused`/`synth_body_hallucination`/`roundup_clusters`——此前 meta.stats 已算 6 字段但从不渲染，读者看不见）；frontmatter stats 增 `t1_sources` + `synth_body_hallucination`；SKILL 第 5 步汇报清单同步。
  - **[P5 降级日量化账]** `renderDegradedMarkdown` 增可选 `meta`：降级版同渲染 frontmatter + 数据概览漏斗表（report 死了不等于 discover/fetch/verify 管道没跑，数字如实入表）；表行抽 `funnelLines` 纯函数完整版/降级版共用。
  - **[P6 旗标疲劳]** `fetch_budget_dropped` 常态配额让位（45 发现 16 配额 → 29 丢弃是健康形态）不再逐日打 degraded 旗标——改走漏斗行「发现链接（配额让位 N 条未抓）」备注；仅抓取率 <50%（`urls_fetched/urls_discovered < 0.5`）或 0 发现仍丢弃时恢复旗标。`stats.fetch_budget_dropped` 进 meta.stats。
  - **[P3 shim 契约移植]** run-daily-shim.test.mjs 的 runner 契约（探针质量/阶梯顺序/子代理跟档/渠道快切）移植到 run-daily-win.test.mjs 锁仓内 runner（原文件 Mac-only 恒 skip，7 断言生产零覆盖——本次 +3 测全绿）；原文件降级注释。
  - **[P2 种子审计]** boards-seeds 测试 UTC 日期缺陷修复（`toISOString()` 在本地 0:00-7:59 取昨天 → 种子存活窗滞后一日）；近 21d 官方一手里程碑全已入账（ERNIE-5.5/Kimi K3.1 Pro/Muse/GPT-6 Cyber/LongCat-2.5/Cosmos 3），splitSeeds「报过即退役」语义下无合法可插种子，skip 态保留为维护信号（结论写入测试头注释）。
  - **[P7 Poster 空图重试]** `shot.mjs renderHtmlToPng` 瞬态失败类（`POSTER_EMPTY_PNG`/`NOT_PNG`/`TRUNCATED_PNG`/`BAD_DIM`——Chrome 跑了但产物错，内存压力下第二次常成功）自动重试 1 次；结构失败（无 Chrome/尺寸非法/spawn 错）不重试。+3 测。
  - **[P8 DEFAULT_LADDER 复盘]** 11 天 meta.ladder 实证：verify 236 票 94.9% 首档直出、exhausted 零；report 爬级仅 2/11 天且自愈出刊 → **维持 DEFAULT_LADDER 不动**（§12.1，观察项关闭）。
  - **[P4 SKILL.md 解压]** 三大巨型单行段落（headless vs 手动 / 8-27 预抓数据流 / 可选 args / 9-13 账本）拆子标题 + 契约总表；skill-doc-contract 14/14 全绿（契约措辞零漂移）。
  - **[P9 build.mjs IIFE 块级作用域改造]** `stripModule` 由「剥 export 后整文件平铺 inline」改为每模块包进 IIFE、导出面解构回 bundle 顶层——模块**私有**顶层标识符封闭在自身 IIFE 内，跨模块撞名（8/23 C1 事故：`tokenize` 撞车 → 宿主 new Function SyntaxError，node --check 假绿）**结构性不可能**，「同形函数必须异名」的人肉纪律退役（cluster/render-md/ledger 三套 tokenizer 保留各自词法名仅为 ESM 源可读性与测试锚点）。残留约束：各模块**导出面**不得重名（解构到顶层仍是重名 decl）——syntaxGate 的 node --check 必然响亮失败，不静默；单行多导出 `export const A = 1, B = 2` 形态不支持（新增模块须知）。产物级证据测试 +3（IIFE≥15/wmTokenize 私有名封闭/导出面解构在场）；全量 521 项 512 pass / 0 fail / 9 有意 skip + poster 55 + build 14 + skill-contract 14；产物 3680 行 `--sync-vault` 已同步。

### 13.1 评估立项（未实现，仅结论）

- **[P10 discover 接模型阶梯]** **结论：暂不做。** 数据：verify 票 94.9% 首档直出（§12.1），说明网关对普通代理的 TRANSIENT 率低；discover 现有韧性是 `BREAKER` 计数断路器 + harvest-fallback 兜底 + `discovery_recovered` 如实上报，8/31 生产风暴的教训是**快速跳闸换通道**（断路器）而非**原地换模型重试**——discover 每板独立、单板失败已有兜底救回通道，阶梯会引入「每板独立预算 vs 全程共享预算」的复杂度，收益（省下的兜底轮次）不抵成本。触发条件（满足才重开）：discover 代理连续多日大面积 TRANSIENT（`discovery_degraded` 常态化）且断路器跳闸后 static-fallback 兜底明显不足（`urls_discovered` 断崖）。
- **[P11 Instagram 窗口缺口]** **结论：立项待评估，暂不排期。** 现状：10 板覆盖里无 Instagram 源（发现靠 grok-search/X/RSS/HF/linux.do），AI 实验室动态经 Instagram 首发的情况（如 Meta AI 官号）只能等二手媒体转报——窗口滞后约 1 天。评估要点：① IG 官方账号 RSS 桥（rsshub 等）可用性与稳定性；② 9222 登录态 CDP 抓 IG 的 ToS 风险与频率纪律（现纪律只覆盖 linux.do 公开 JSON API）；③ 实际增益（21d 内 IG 首发且未被他源覆盖的里程碑数——初步查账本为 0，二手媒体覆盖足够）。**在增益数据非零前不投入开发**；若出现 IG 独家首发漏报案例，从该案例起步设计最小通道。

- **2026-10-03（第四轮 · 深度 review 根因修复）**：对第三轮做深度 review，八项全部根因修复：
  - **[P1-① 恢复路径从未接线]** `run-daily-win.sh`/`run-daily.sh` 此前只在 artifact-check——09-21 建的 `host-finalize.mjs`（编排器 422 死在 Write 前时从 completed `wf_*.json` 找回 payloads 落盘）从未被 Windows runner 调用（10-02 移植时从 Mac git 外 shim 丢掉该步）。现两 runner 都在 artifact-check **之前**跑 `host-finalize.mjs --date --out --since-epoch $WALL_START`；且 `host-finalize` 的 `DEFAULT_PROJECTS` 旧版硬编码 Mac 会话名 → 改由 cwd 推导。
  - **[P2-② HOME 判据]** `host-finalize`/`artifact-check`/`progress` 各写 `process.env.HOME || ''`（非登录 shell 下为空 → 路径退化）。新增 `host-paths.mjs` 单一真源（`os.homedir()` + projectSlug + env 覆盖）。
  - **[P2-③ realm 死代码]** 旧版把 linuxdo 抓取连同 `cdp-core`（fetch/WebSocket）inline 进产物、realm 永不执行还让护栏盯不住。拆 `linuxdo-fetch.mjs`（宿主），`linuxdo.mjs` 只留纯解析；`cdp-core` 移出 MODULES；build 护栏从单条扩为宿主 Node API 整类拦截（`process.*`/`require(`/裸 `fetch(`/`WebSocket`/`AbortSignal`）。
  - **[P2-④ 契约测试盲区]** 旧 shim 测试在 Windows 全 SKIP（7 断言），HOST-FINALIZE 回归不可见。新增 `run-daily-win.test.mjs` 锁仓内 runner（6 测，跨平台跑）。
  - **[P3-⑤ 标定链 rejection]** `makeWallCalibrator` `once().then(chain)` 对 rejection 零兜底 → 窗内 try/catch + 链尾 `.catch` 日志停链。
  - **[P3-⑥ 海报默认路径]** `generate-poster` CLI 默认 outDir 硬编码 Mac iCloud → `AI_DAILY_REPORT_DIR` 覆盖 → win32 vault 生产根 → 其余 Mac 兜底。
  - **[P3-⑦ 空 STAMP]** runner 早退日志 STAMP 空 → `${STAMP:-unknown-time}` 兜底。
  - 全量 **452 项 443 pass / 0 fail / 9 有意 skip**；产物 3212 行 `--sync-vault` 已同步。
- **2026-10-06（产物迁入 Note/AI/DallyReport + 海报改名 · 用户裁决「通过 obsidian 同步下日报」）**：ai-daily 产出目录从 vault 根 `AI/DallyReport/` 迁入 `Note/AI/DallyReport/`（与 DallyReport 主系统同根——主系统日报本就入库 vault git，Obsidian 同步即覆盖 ai-daily 日报）。四处合同 + 主仓一处覆盖口：
  - **[host-paths 单一真源]** `WIN_PROD_DALLYREPORT_ROOT` → `E:/profile/note/note/Note/AI/DallyReport`、`macProdDallyReportRoot` → `…/obsidian-note/Note/AI/DallyReport`——artifact-check / generate-poster / finalize（PROD_DALLYREPORT_PREFIXES）三处消费方自动跟随；双 runner `OB_DIR` 与 artifact-check `--dir` 显式传参同步改。
  - **[海报防撞名]** 共目录后主系统海报恒名 `AI.png`（周五为 `AI-周报.png`），ai-daily 海报必须异名。主仓 `src/poster/period.mjs aiPosterFileName` 增 `config.posterFile` 覆盖口（**不传则行为逐字节不变**，主系统零感知）；ai-daily `generate-poster.mjs` 传 `cfg.posterFile='ai-daily.png'` 且 md 内嵌改 `![[ai-daily.png]]`。**生成期即异名**而非事后改名——事后改名会先覆盖主系统当天已有海报再搬走。副带修复：旧版借 `loadConfig` 时周五自动进周报模式产出过 `AI-周报.png`（10-02 实证），覆盖口同时消灭该漂移。
  - **[历史产物搬移]** 33 个日期目录全部迁入 Note/AI/DallyReport（与主系统重叠的 9 个日期目录逐文件合并，共享目录里主系统的 `AI.png`/`AI-周报.png` 原样保留）；ai-daily 海报统一改名 `ai-daily.png`、全部 `<date>-ai日报.md` 内嵌重写 `![[ai-daily.png]]`（含 10-02 历史错嵌 `![[AI-周报.png]]` 归一）；vault 根空壳 `AI/` 移除。全树审计：ai-daily md 内嵌无一例外指向 `ai-daily.png` 且文件在场。
  - **[同步语义]** 主系统日报本就 tracked 于 vault git（1081 文件实证）→ 迁移后 ai-daily 产物同样 `git add` 入库，随 vault git 同步到其它端（此前 AI/DallyReport 大部 untracked 不同步）。
  - 测试锚点同步：host-paths/ledger（含反斜杠形态）/host-finalize/generate-poster（补 `posterFile` 传入断言）。主仓 `image-gen-weekly.test.mjs` 5/5（覆盖口向后兼容实证）。SKILL.md 11 处路径 + 产物说明同步。
- **2026-10-05（10-05 生产 run 验收分析 · 五问题根因修复 · 全量 483 测 474 pass / 0 fail / 9 有意 skip）**：对 10-05 首个新链路生产 run（`done rc=0`、61m、无 502/524、质量门首战 `dropped=2`、账本 +7）做验收分析，5 问题全部根因修复：
  - **[P2 账本毒条目渗透（新发现）]** 质量门上线**前**入库的 10-04「image 580×286 7.97 KB」经 `buildYesterdayTopics` 原样渲染进 10-05 报告「昨日话题追踪」——门只拦今日 claim，拦不住历史毒条目。三层修复：① 消费端入口 `parseReportedLedger` 统一 `isJunkClaim` 卫生过滤（title 判定、title 缺失 fail-open、全滤光 → null 等价无账本如实降级），一处过滤保护全部账本消费者（fetch 硬过滤/种子退役/report 软网/昨日话题追踪）；② 记录端 `ledgerEntriesFromClaims` 过 `isJunkClaim` 兜底（进出两端防线）；③ 存量清理：生产账本 8→7 条（毒条目移除，备份 `published-ledger.json.bak-20261005`）。
  - **[P3 参考来源「未抓取」标注]** major-out 引用的是发现期提供、从未抓取验证的 URL（10-05 实证 `[2] anthropic.com/claude-sonnet-5-5` 疑似发现模型猜测路径），参考来源里与已抓取链接同等呈现。`buildCitationMap` 增 `fetchedUrls` 参数（normURL 归一对比，Set/数组通吃），集合外编号补 `〔未抓取〕`；模板传抓取期真实 URL 全集（来源页 + 索引页真实文章 claimUrl）；缺省不标注（向后兼容/降级版）。
  - **[P3 ledger 字段正名]** meta `ledger_entries`（注入候选数）屡被误读为「今日新增记账数」（10-05 实际注入 1、新增 7）→ 改名 `ledger_injected`；新增数由 finalize 记账后原子回写 `ledger_recorded_count`。
  - **[P1 墙钟口径收紧]** realm 累加器只测 workflow 内段（10-05 实测内段 2383s vs 全程 3661s，探针/模型换档 ~25 分钟不可见；realm 无时钟无法自测）。根因修复走宿主链路：runner `export AI_DAILY_RUN_START_EPOCH`（claude 子进程继承）→ finalize（宿主 CLI 有真实时钟）`realWallSecondsFromEnv` 实测回写 `meta.wallclock.real_s`（非法/越界 >24h/未来时刻 fail-open 不回填）；meta.wallclock 注释与 WALLCLOCK 行语义同步收紧（raw/calibrated=内段，real_s=全 run）。零 realm 改动、零 args 改动。
  - **[P3 抓取 null 静默蒸发]** `extracted.filter(Boolean)` 把两轮代理无产出的来源无声丢弃——10-05 漏斗 18 发现 − 2 去重 − 1 已报道 ≠ 12 抓取，3 条无痕。新增 `meta.fetch_agent_errors` 计数 + journal `FETCH-AGENT-NULL` 逐条日志（web 波动常态，只计数不降级）。
  - **[discovery 供给弱查证（无缺陷结论）]** 10-05 供给弱（10 板 6 空、18 发现/12 抓取、verify 6/16 票 10 条如实落 unverified）为**窗口日历效应**（10-03/04 周六日）+ verify 预算软目标尾部硬停的**设计内行为**，非确定性缺陷；labs 花名册 `has_dynamic/report_match` 语义正常。唯一修复项即上条 fetch null 计数。
  - **[环境漂移 · cdp-fetch 测试时间脆弱]** Windows 定时器分辨率收紧（15.6ms）实证每轮询迭代 ~31ms（mock setTimeout(0) + poll setTimeout(1) 两链式定时器）→ CLI 测试旧 `pollMaxMs=1000`（意图 1ms×1000≈1s）实耗 31s 撞 execFileSync 30s 杀、stderr 空丢失。HEAD 干净 worktree 复现 = 非本轮引入。测试常量 1000→60（60×31ms≈1.9s，意图仍成立）并注记根因；生产代码无涉。
  - SKILL.md 三处契约同步（记录端兜底/ledger_injected 语义/real_s）。产物 **3343 行** `--sync-vault` 已同步（vault 产物 + SKILL.md 双更新）。**下次 10-06 08:40 生效**。
- **2026-10-04（质量审计 + 声明质量门设计文档）**：对当日日报做全链路质量审计（四件套 + 双 workflow payload + 生产账本），抓到**管线真实 bug**：论坛附件标注被提取为可证伪声明（`image 580×286 7.97 KB`）→ 通过 2-0 核查投票 → 写入生产账本；连带后果——`Antigravity 发布 Opus 5.5/Sonnet 5.5`（两帖印证的当日最大模型新闻）与微软 Rust 一级语言因 claim 被提取成附件垃圾/评论碎片而被挤出正文。反幻觉护栏实战通过（`report_source_hallucination:5` 全拦）。产出 **`docs/2026-10-04-claim-quality-gate-design.md`**（六项改造：claim-gate 纯模块确定性垃圾模式 / 模板 allClaims 单点接线（fetch+mint 双路覆盖）/ verify substance 门（过滤必须先于配额分配）/ 全错票补投轮 / fetch prompt 提取卫生硬化 / sourcesJson claimUrls 精度；含 10-04 真实垃圾原文回归 fixtures 与实施清单）。**已实施（同日）**：claim-gate.mjs + 6 组测试、模板 8 处接线（allClaims 门 / substance 门先于配额 / VERIFY-RETRY 全错票补投 / substance 声明落 unverified 不蒸发 / sourcesJson claimUrls / meta `claim_gate`+`verify_retry` / stats 两字段）、fetchPrompt 声明卫生规则；新增 prompts 卫生断言与 workflow-integration 接线顺序锁（「过滤先于配额」「补投先于外部抽查」两条硬顺序）。**同日复审（4×P3+S×3 全修）**：P3-1 垃圾同步剥离 `sources[].claims`（boardClaimCount/claimCount/claimUrls 三处消费方与 allClaims 同口径，否则覆盖自检与数据概览数字分裂）；P3-2 §5「危害上限被封死」表述如实化（CJK≥10 流畅碎片仍可达 verify，靠 prompt 层压制）；S-3 尺寸分隔符收 `[×xX]`（ASCII x 变体）；S-1 补投轮独立阶梯 t0 `verifyRetryLadderT0`（风暴耗尽共享 900s 预算后仍有完整降级链；主批次共享纪律不变）；S-2 mint 短标题回落确认无需改（两者皆 <8 字符的帖零信息，gate 拦截即设计行为）。**真实数据重放验证**：10-04 的 16 条生产声明——3 条垃圾全拦、13 条进 verify。全量 **477 项 468 pass / 0 fail / 9 有意 skip**；产物 **3313 行** `--sync-vault` 已同步。下次 08:40 生效，验收口径：log 出现 `CLAIM-GATE dropped=N`、meta 三新字段、confirmed 无附件标注形态。
- **2026-10-04（第五轮 · review 全量根因修复 + 部署确认）**：对本轮 F1–F6 修复变更再做一次生产 review（4×P3 + 1×Suggestion，无阻塞项），全部根因修复：
  - **[F1 终态收口（两 runner）]** 成功/失败/探针耗尽三态 `done rc=` 统一收口在 artifact-check 之后、WALLCLOCK 之前（旧版只有 ATTEMPT=0 分支写 done，成功路径 RC 被强制 0 后 `if [ "$RC" != "0" ]` 跳过 → 进度台终态永不可达恒「运行中」）；rc=0 以 `[ -f "$REPORT" ]` 为主判据（host-finalize 抢救成功也算成功）；幂等 skip 路径补 `done rc=0 (skip-existing)`（skip 日不再显示陈旧终态）。`run-daily-win.test.mjs` 用发射专属 needle（`$STAMP done rc=0 =====` / `printf 'WALLCLOCK`）锁三态位置契约，防注释抢先匹配。
  - **[F3 finalize.mjs CLI 门控]** 旧版 CLI 无条件摊模块顶层——import 时宿主 argv 里的非 `--` 参数被当 result 路径 → import 即写盘（实证）；`--out <dir> <result>` 顺序把 dir 当 result → ENOENT。根因修复：`isCliMain` 门控 + 旗标带值解析（位置参数与旗标值互不污染，顺序无感）+ 无参 usage exit 1。回归：import-only wrapper 零写盘、旗标前置顺序、无参 usage、`--out` 末参无值回落。
  - **[F2→F-1 生产根单一真源]** F2 修复时 artifact-check 新写的三级默认根解析与 `generate-poster.defaultReportRoot` / `finalize.PROD_DALLYREPORT_PREFIXES` 三处同构字面量 → 收敛 `host-paths.prodDallyReportRoot()`（`AI_DAILY_REPORT_DIR` env → win32 生产根 → Darwin iCloud），artifact-check 改调用点惰性求值，generate-poster 删本地副本（os import 清理），finalize 前缀引用同一常量（`[0]` 仍为 win 字面量，ledger.test 钉住）。单测锁「artifact-check 不得再持生产根字面量」。
  - **[新发现 P1 · 宿主 CLI「今天」用 UTC]** 部署 smoke 实证 `progress --once` 03:00 显示 `ai-daily 2026-10-03`——`new Date().toISOString()` 是 UTC 日期，本地 00:00–08:00（CST）「今天」= 昨天 → 标签错天、artifact-check/generate-poster 无参默认查错日。`host-paths.localDateStr()`（本地时区 YYYY-MM-DD）三处替换 + 已知 UTC 时刻回归（CST 02:00 → 当天）。
  - **[F4/F6 progress]** `phaseCounts` 导出 + `inflight` clamp≥0（重复 result 事件如重试续写会让 done 超转录计数 → 负在飞）+ fakeIo 单测（转录归类/probed/负 clamp/缺目录静默）；真实 runner 成功日志 fixture（Windows 无时区 + Mac CST）锁 F1 发射格式——DONE0/DONE1 自此有真实生产发射方。
  - **格式卫生**：win runner 终态信息块缩进恢复 2 空格、finalize.mjs 末尾补换行。
  - **部署验证（全绿）**：全量 **468 项 459 pass / 0 fail / 9 有意 skip**；产物零漂移（fresh build == 仓内 `.claude/workflows/ai-daily.js` == vault 产物逐字节相同，SKILL.md 同——本次全部变更均为宿主 CLI/runner，不在 build MODULES，产物无需重建）；smoke：`artifact-check` 无 `--dir` 命中 win32 生产根 `ARTIFACT-OK`（真实 10-02 产物）、`progress --once` 正确显示 2026-10-04、`host-finalize` SKIP report_exists。**10-05 08:40 起为首个发射 `done rc=` 终态行的生产 run**；10-02/10-03 缺口日维持不补齐（未授权）。
- **2026-10-04（第四轮后续 · 深度 review 根因修复）**：对第四轮+烟测后的代码再走一遍深度 review（宿主 CLI 侧），抓到 `progress.mjs` 两处「只有 CST 才能工作」的解析缺陷并根因修复：
  - **[P1] progress.mjs START_RE/DONE_RE 写死 `CST` 字面量 → 进度台在 Windows 恒「未启动」**：Mac launchd 宿主 `date '+%Z'` 出 `CST`，但 Windows Git Bash **出空串** → `run-daily-win.sh` 实际写出 `===== 2026-10-04 02:55:53  start run-daily-win（CEILING_MS=0）=====`（时间戳后**两个连续空格**、无时区标记），旧正则 `(\S+ \S+) CST start` 永不匹配 → 整个 Windows 平台的进度台恒显「run-daily.log 无本次 start 标记」，墙钟/五阶段/522 计数全哑。时区标记改可选 `(?: \S+)?`，空格分隔改 ` +`（一个或多个——无时区时的双空格是实测形态）。
  - **[P1] DONE_RE 不认 `(probe-exhausted)` 后缀 → 终态在两平台都测不到**：两 runner 的探针耗尽分支都写 `===== … done rc=2 (probe-exhausted) =====`，旧 `rc=(\d+) =====` 因括号后缀失配 → 终态永不判定，rc=2 的 run 永远显示「运行中」。后缀改可选 `(?: \([^)]*\))?`，rc 仍取第一个捕获组。
  - 实证：对真实生产日志（`~/.ai-daily/run-daily.log`，含 10-02 带戳 start + 10-03 空戳行）跑 `progress.mjs --once`，修复前恒「未启动」，修复后如实报出「2026-10-03 | ⚠1951m28s/30m | 编排器阶段」——正确暴露 10-02 run 有 start 无 done 的遗弃态。
  - `progress.test.mjs` 补两条回归（Windows 双空格/无时区 start 可识别 + `done rc=2 (probe-exhausted)` 判终态），并锁 CST 旧格式不回归。progress.mjs 是宿主 CLI（不在 build MODULES），产物不需重建。全量 **455 项 446 pass / 0 fail / 9 有意 skip**。
- **2026-10-04（第四轮后续 · 烟测实证修复）**：对第四轮变更做受限烟测（临时 projects 目录伪造 completed workflow json + 临时 outDir + 临时 AI_DAILY_HOME；只复用 9222 登录态 Chrome 开/读/关临时标签）。**恢复链全绿**：host-finalize 找回 payloads → 落盘 4 产物（LEDGER-SKIP，非生产 outDir 不记账）→ 二次调用 `HOST-FINALIZE-SKIP report_exists` → 无匹配日期 `no_matching_workflow` rc=1 → artifact-check `ARTIFACT-OK` → linuxdo-prefetch 走 9222 `ok:true posts=8` → build --check-only OK。烟测抓到一个真 bug 并根因修复：
  - **[P2] run-daily-win.sh / run-daily.sh 预抓失败日志吞退出码**：`echo "LINUXDO-PREFETCH-FAIL exit=$?"` 写在 `printf > "$PREFETCH_JSON"` **之后**，`$?` 取到的是 printf 的退出码（恒 0），node 预抓的真实 rc 被吞 → 日志永远 `exit=0`，CDP 失败/崩溃/524 不可审计。先在 else 分支入口（`$?` 仍是条件命令 node 的 rc）捕获 `PREFETCH_RC=$?` 再写 JSON，日志引用真实码。两 runner 同修；`run-daily-win.test.mjs` 补回归锁（断言不含 `exit=$?`、含 `PREFETCH_RC=$?` 与 `exit=$PREFETCH_RC`）。全量 **453 项 444 pass / 0 fail / 9 有意 skip**。
- **2026-10-03（第三轮 · code review 根因修复）**：对第二轮变更做 final review（P2×1 / P3×2 / Suggestion×2），全部根因修复：
  - **[P2] 周期标定仪器重建**：review 用 tick 链模拟实证 250ms 首版是 no-op（nominal==tick 粒度 → delta 恒整数拍 → factor∈{1,null}，2s 全饱和 factor=1；nominal 1000ms 对照组 factor=4）。根因修复 = 仪器抽为 `wallclock.mjs makeWallCalibrator` 纯工厂：窗口首尾相接（fire 即续排，观测无缝隙）、nominal≫tick 契约写进注释、setTimer/readAccum/observe 全部可注入；默认窗 120s=480 拍（健康 factor=1 零日志，饱和 fire 晚到 factor=480→cap 20）。行为级测试 6 项（假时钟）当场再抓出一个真 bug：**0=显式禁用被默认分支吞掉**（args.wallCalibrateMs=0 关不掉仪器）——改为 0 合法禁用、非法类型 fail-fast。workflow-integration 断言同步更新。
  - **[P3] build.mjs**：去掉 `export syncVault`（脚本即入口形态不得 export——import 即触发底部 main() 写盘真实产物，build.test.mjs 头注释记载的事故形态）；补同步失败路径测试（vault 目标不可写 → VAULT-SYNC-WARN 且 exit 0、产物不受影响）。
  - **[P3] run-daily-win.sh**：`mkdir -p "$LOGDIR"` 挪到 PATH 导出后（纪律收口：PATH 导出点之前不得有外部命令——mkdir 也是 /usr/bin 外部命令，留在前面则 LOGDIR 缺失场景全 run 静默失日志）；notify() 加 `ps_escape`（单引号翻倍转义），含撇号文案端到端 toast 验证通过。
  - **[Suggestion] finalize.mjs**：`AI_DAILY_PROD_PREFIX` 改惰性读取（isProdOutDir 每次调用组装前缀，不再模块加载期突变导出数组）；补子进程 env 覆盖测试（命中/不命中/导出数组不被突变三断言）。
  - 测试 436 项 428 pass / 0 fail / 8 skip；产物 3354 行；`--sync-vault` 已同步（SKILL.md identical 自动跳过）。下次生效 10-04 08:40。
- **2026-10-03（第二轮 · 按 §12 清偿 + 生产 P0 修复）**：
  - **P0-A run-daily-win.sh 整轮空转修复**（10-03 08:40 生产实证）：任务计划程序调起的 bash.exe 非登录 shell，PATH 无 Git `/usr/bin` → `date/seq/tr/wc` 全部 command not found，四档探针被 `seq` 失败全灭、**零 launch** 即 rc=2 放弃，10-03 日报缺口。修：PATH 前插 `/e/code/Git/usr/bin`、STAMP 挪到 PATH 导出后、TODAY 空值守卫早退。最小 PATH 模拟验证通过。**10-03 无日报（09-25 以来第二个缺口日），如需补偿须用户授权单日跑（Iron Rule：已有产物日期禁 --date 全量重跑）。**
  - **P0-B finalize.mjs 生产前缀 Windows 化**：`PROD_DALLYREPORT_PREFIX`（Mac iCloud 单前缀）→ `PROD_DALLYREPORT_PREFIXES` 列表（Windows vault 置首 + Mac 兜底 + AI_DAILY_PROD_PREFIX 覆盖）。旧版在 Windows 上 isProdOutDir 恒 false → 生产 LEDGER-SKIP（跨天去重失效）+ poster 永不跑。**注意：10-02 产物若出自 Windows 路径，其账本未记账；10-04 起恢复正常。**
  - **P0-C SKILL.md Windows 路径对齐**：frontmatter/触发器/日期命令（GNU date）/outDir/scriptPath/build 检查/finalize 命令/产出物命名/headless 契约（linuxdoMaxSources 12）全部改 Windows 实路径，残留 Mac 叙述字样清零；新增 cdpFetchCli/grokDir 可选 args 说明。
  - **P0-D 模板 Mac 硬编码路径清除**：`CDP_FETCH_CLI` 与 `GROK_DIR` 旧硬编码 `/Users/mango/...` → args 可覆盖 + Windows 生产默认（旧版在 Windows 生产下 9222 fetch 通道静默哑火、grok-search skill 指向不存在文件）。加 `assert.doesNotMatch(/['"]\/Users\/mango\//)` 源级防回归。
  - **§12 六项清偿**：① meta.ladder 阶梯观测账（重排待 10-04 数据）② 删 preferStaticFirst ③ 周期墙钟标定（wallCalibrateMs 默认 600s）④ PowerShell toast 通知 ⑤ streakOf 倒排索引 ⑥ build.mjs --sync-vault。
  - 测试 429 项 421 pass / 0 fail / 8 skip；产物 3309 行；`--sync-vault` 已同步 vault 产物 + SKILL.md。下次生效 10-04 08:40。
- **2026-10-03（第一轮）**: 建立本文档为唯一总纲；吸收 4 篇 dated 设计文档与 README 旧架构描述（均已加历史快照标注）；依据 15 个模块真源 + 模板 1273 行逐一核对契约（含 10-03 五要素：亮点/昨日话题追踪/社区热度/数据概览/趋势收尾）；记录设计债务 6 项（§12）。同日完成 10-03 五要素对齐（主仓 `7e14ea3`）、433 项测试全绿（425/0/8）、产物 3269 行。
