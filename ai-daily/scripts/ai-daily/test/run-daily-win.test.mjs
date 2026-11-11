import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows 生产 runner 契约测试（10-03 P2-④ 根因新增）。
// 背景：旧 run-daily-shim.test.mjs 只测 git 仓外 `~/.ai-daily/run-daily.sh`（Mac 宿主 shim），
// Windows 镜像 CI / 本机都没有该文件 → 7 条 runner 契约断言（含 HOST-FINALIZE 顺序）全部 SKIP，
// 生产 runner 的回归（10-02 移植时丢掉 host-finalize 调用）在测试层完全不可见。
// 本文件改为锁定**仓内** run-daily-win.sh（Windows 生产实际执行的那份），断言走源文件文本契约，
// 不依赖外部 shim、不依赖平台（Windows 与 CI 都跑）。
// GATEWAY-TOOL-PROBE-SENTINEL

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIN_RUNNER = path.resolve(HERE, '../../../run-daily-win.sh')
const win = () => fs.readFileSync(WIN_RUNNER, 'utf8')
// 探针 sentinel 锁定（与 run-daily-win.sh probe_gateway 读取同一文件同一 token）：
const SENTINEL_FILE = path.join(HERE, 'run-daily-shim.test.mjs')

test('Windows runner 在场且可读', () => {
  assert.ok(fs.existsSync(WIN_RUNNER), 'run-daily-win.sh 须存在（Windows 生产 runner 真源）')
  const sh = win()
  assert.match(sh, /^#!\/usr\/bin\/env bash/, 'shebang 为 bash')
  assert.ok(sh.includes('run-daily-win'), '文件自标为 Windows runner')
})

test('Windows runner：预抓 JSON 不得插进双引号 claude -p，注入走 host-inject bake（11-11 根治）', () => {
  const sh = win()
  assert.doesNotMatch(sh, /linuxdoPrefetched.: \$\(cat/, 'JSON 本体不得 $(cat) 进 claude -p 字符串')
  assert.match(sh, /linuxdo-prefetch\.json/, '预抓落盘路径在场，供 host-inject bake 进 bundle')
  const promptLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l) && /dangerously-skip-permissions/.test(l))
  assert.ok(promptLine, '真实 launch 行在场')
  assert.ok(!/\$\(cat/.test(promptLine), 'claude -p 行不得 $(cat) 任何文件')
  // 11-11 注入链根治：数据不再经模型转写——prompt 禁止 Read 注入文件、args 不传大对象；
  // 宿主在 launch 前 bake（HOST_INJECT 段，args 真传优先兜底合并）。
  assert.doesNotMatch(promptLine, /args\.reportedLedger/, 'prompt 不得再指示转写账本（四连事故根修）')
  assert.doesNotMatch(promptLine, /args\.linuxdoPrefetched/, 'prompt 不得再指示转写 prefetch')
  assert.doesNotMatch(promptLine, /args\.fetchReceipts/, 'prompt 不得再指示转写回执')
  assert.match(promptLine, /outDir/, 'prompt 必须含 outDir 字面量（v2 事故根修：缺字段被 realm 拒）')
  assert.match(promptLine, /HOST_INJECT/, 'prompt 说明数据已 bake，禁止 Read 注入文件')
  // 编排器必须在 launch 前 bake 且失败即中止（不空拉）
  assert.match(sh, /host-inject\.mjs/, 'launch 前调用 host-inject.mjs')
  assert.match(sh, /HOST-INJECT-FAIL.*中止|bake 失败时注入链不可信/, 'bake 失败中止护栏在场')
  assert.match(sh, /--ledger "\$LEDGER_INJECT"/, 'bake 输入为一次性账本副本（主账本路径不进任何模型可见面）')
})

test('Windows runner：AI_DAILY_RUN_START_EPOCH 导出（10-05 P1 墙钟 real_s 数据链路）', () => {
  const sh = win()
  assert.match(sh, /export AI_DAILY_RUN_START_EPOCH="\$WALL_START"/, '起始 epoch 经 env 传给 finalize（claude 子进程继承）')
  assert.match(sh, /WALL_START="\$\(date '\+%s'\)"/, 'WALL_START 为宿主 epoch 秒')
  assert.match(sh, /meta\.wallclock\.real_s/, 'WALLCLOCK 行指向 real_s 语义（内段 vs 全程）')
})

test('Windows runner：编排器韧性阶梯在场（探针/重拉/通知/快死）', () => {
  const sh = win()
  assert.match(sh, /probe_gateway\(\)/, '网关探针函数在场')
  assert.match(sh, /probe_wait\(\)/, '探针循环函数在场')
  assert.match(sh, /DEEPSEEK_TRIES=3/, 'DeepSeek 同档重试次数在场')
  assert.match(sh, /FALLBACK_TRIES=2/, '降级模型每档重试在场')
  assert.match(sh, /LAUNCH_FAST_DEATH_S=600/, '快死阈值在场')
  assert.match(sh, /REPORT-EXISTS/, '产物落盘即成功判定在场')
  assert.match(sh, /RELAUNCH-SKIP/, '非快死失败不重拉的护栏在场')
  assert.match(sh, /probe-exhausted/, '探针全失败的退出记账在场')
  assert.match(sh, /REPORT-EXISTS/, '产物落盘即成功判定在场（原 shim P0-1 契约，11-11 移植）')
  assert.match(sh, /notify\(\)/, '通知函数在场（Windows toast，失败回落纯日志）')
  assert.match(sh, /toast-fallback-log/, 'toast 失败回落日志兜底在场')
})

// ─── 11-11 P3：Mac shim 7 条 runner 契约移植收口 ───
// run-daily-shim.test.mjs 只在 Mac 宿主（~/.ai-daily/run-daily.sh 在场）才跑，Windows/CI 恒 skip，
// 7 条契约在生产 runner 上长期零覆盖。以下把仍适用于 Windows runner 的断言落到仓内源文件。

// 原 shim 测 4（探针质量）：探针必须工具调用类、认三种失败态、模型走 attempt 档；launch 不钉死单一模型。
test('Windows runner：探针与 launch 模型跟随 attempt 档，探针认 11128/channel/API Error 三失败态', () => {
  const sh = win()
  const probeFn = sh.match(/probe_gateway\(\) \{[\s\S]*?\n\}/)
  assert.ok(probeFn, 'probe_gateway 函数体可抽取')
  const probe = probeFn[0]
  assert.doesNotMatch(probe, /Reply with exactly: OK/, '短问答 OK 探针会在 chat 200 / tools 400 时假阳性放行（09-13 实证）')
  assert.match(probe, /dangerously-skip-permissions/, '探针须带与 launch 相同的 skip-permissions（工具路径）')
  assert.match(probe, /unapproved channel/, '探针须把渠道拦截当失败')
  assert.match(probe, /API Error/, '探针须把 API Error 当失败')
  assert.match(probe, /11128/, '探针须把 CPA 官方渠道码 11128 当失败')
  assert.match(probe, /--model "\$model"/, '探针模型须走本次 attempt 的 $model')
  const launchLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l))
  assert.ok(launchLine, '主 launch 行在场')
  assert.match(launchLine, /--model "\$MODEL"/, '主 launch 模型须走本次 attempt 的 $MODEL')
  assert.doesNotMatch(launchLine, /--model (gemini|deepseek|grok|claude)/, '主 launch 不得钉死单一模型（抽签失败后必须能换级）')
})

// 原 shim 测 5（编排器阶梯）：ORCH_LADDER 有序在场 + 换级日志 + 循环遍历。顺序为 Windows 当前
// 生产决策（11-01 用户指令移除 claude 档），锁定顺序防静默漂移；改阶梯时须同更本断言。
test('Windows runner：ORCH_LADDER 阶梯在场（gemini-3.8 主写 → deepseek → grok，无 claude 档）', () => {
  const sh = win()
  const ladder = sh.match(/ORCH_LADDER=\(([^)]+)\)/)
  assert.ok(ladder, 'ORCH_LADDER 数组在场')
  const models = ladder[1].trim().split(/\s+/)
  assert.deepEqual(
    models,
    ['gemini-3.8-flash', 'deepseek-v4-flash', 'grok-4.6'],
    '编排器阶梯须与 11-01 生产决策一致：gemini-3.8 主写，deepseek 兜底，grok 末位',
  )
  assert.doesNotMatch(sh, /ORCH_LADDER=\([^)]*claude/, '11-01 用户指令：阶梯不含 claude 档（串会话双雷）')
  assert.match(sh, /DEEPSEEK_TRIES=3/, 'DeepSeek 同档重试次数在场')
  assert.match(sh, /FALLBACK_TRIES=2/, '降级模型每档重试在场')
  assert.match(sh, /TRIES="\$DEEPSEEK_TRIES"/, '首档重试接 DEEPSEEK_TRIES')
  assert.match(sh, /TRIES="\$FALLBACK_TRIES"/, '后续档重试接 FALLBACK_TRIES')
  assert.match(sh, /MODEL-FALLBACK/, '换级须打日志，便于次日审计')
  assert.match(sh, /for MODEL in "\$\{ORCH_LADDER\[@\]\}"/, 'launch 循环须遍历阶梯而不是固定同模型')
})

// 原 shim 测 6（子代理跟档 + 渠道快切）：子代理模型跟随当前档、连续 11128 快换档、LAUNCH_OUT 捕获。
test('Windows runner：子代理跟当前档模型，连续 11128 快切换档，LAUNCH_OUT 有捕获', () => {
  const sh = win()
  assert.match(sh, /export CLAUDE_CODE_SUBAGENT_MODEL="\$MODEL"/, 'harvest/discover/fetch 须跟本次 launch 档，不得钉死环境模型')
  assert.match(sh, /CHANNEL_FAIL_MAX=2/, '同档连续渠道拦截上限在场')
  assert.match(sh, /CHANNEL-FAIL/, '11128 快死须记账')
  assert.match(sh, /CHANNEL-FAIL-SKIP/, '连抽两次坏渠道须跳档，不得把首档 TRIES 打满')
  assert.match(sh, /LAUNCH_OUT=/, '须捕获 launch 输出才能认 11128，不能只看 rc')
})

test('Windows runner：HOST-FINALIZE 必须在 artifact-check 之前（09-20 422 空盘兜底）', () => {
  const sh = win()
  assert.match(sh, /host-finalize\.mjs/, '须调用宿主 host-finalize.mjs（从 completed workflow json 确定性落盘）')
  assert.match(sh, /HOST-FINALIZE/, '须打 HOST-FINALIZE 日志')
  const finalizeIdx = sh.indexOf('host-finalize.mjs')
  const checkIdx = sh.indexOf('artifact-check.mjs')
  assert.ok(finalizeIdx >= 0 && checkIdx >= 0, 'finalize 与 artifact-check 都在场')
  assert.ok(finalizeIdx < checkIdx, 'HOST-FINALIZE 必须在 artifact-check 之前（先落盘再自检）')
  assert.match(sh, /--since-epoch/, '只收本次 WALL_START 之后的 workflow json')
  assert.match(sh, /\[ ! -f "\$REPORT" \]/, '报告已在盘上则跳过 finalize（不覆盖编排器已写产物）')
  // SHA：被组织成变量级调用而非裸命令，防止 host-finalize 用相对路径/裸名（依赖 cwd）静默 no-op
  assert.match(sh, /host-finalize\.mjs" --date/, 'host-finalize 用绝对仓库路径调用（cwd 即 vault，slug 为 vault）')
})

test('Windows runner：PATH 导出在一切外部命令之前 + STAMP 非空兜底（11-02 空转根因治理）', () => {
  const sh = win()
  const exportIdx = sh.indexOf('export PATH=')
  const firstCmdIdx = Math.min(
    ...['mkdir -p "$LOGDIR"', 'STAMP=', 'cd "$VAULT"'].map(s => sh.indexOf(s)).filter(i => i >= 0),
  )
  assert.ok(exportIdx >= 0 && exportIdx < firstCmdIdx, 'PATH 导出点必须在任何外部命令之前（非登录 shell 无 /usr/bin）')
  assert.match(sh, /STAMP="\$\{STAMP:-unknown-time\}"/, 'STAMP 空值兜底为 unknown-time（date 不可达时日志仍可辨识）')
  assert.match(sh, /\[ -n "\$TODAY" \]/, '今日日期不可达则早退且不空跑')
})

test('Windows runner：探针 sentinel 文件与 probe_gateway 读取一致', () => {
  assert.ok(fs.existsSync(SENTINEL_FILE), 'probe_gateway 读取的 sentinel 源文件在场')
  assert.ok(win().includes('GATEWAY-TOOL-PROBE-SENTINEL') ||
    fs.readFileSync(SENTINEL_FILE, 'utf8').includes('GATEWAY-TOOL-PROBE-SENTINEL'),
  'sentinel token 契约两端在场（runner 探针读同一 token）')
})

test('Windows runner：prefetch 失败日志携带 node 真实退出码（10/04 smoke 实证：printf 之后 $? 恒 0）', () => {
  const sh = win()
  const failIdx = sh.indexOf('LINUXDO-PREFETCH-FAIL')
  assert.ok(failIdx >= 0, '预抓失败日志行在场')
  // 根因：`exit=$?` 若写在 printf 之后，取到的是 printf 的退出码（恒 0），node 真实 rc 被吞 →
  // 审计时永远看到 exit=0。必须在 else 口（$? 仍是 node 退出码）先捕获。
  assert.match(sh, /PREFETCH_RC=\$\?/, '在失败分支入口先捕获退出码')
  assert.doesNotMatch(sh, /LINUXDO-PREFETCH-FAIL exit=\$\?/, '日志不得取 printf 之后的 $?（恒 0）')
  assert.match(sh, /LINUXDO-PREFETCH-FAIL exit=\$PREFETCH_RC/, '日志引用捕获的真实退出码')
})

// F1（10-04 review 根因回归）：终态 done 行三态统一收口。
// 旧版只有 ATTEMPT=0 分支写 `done rc=2`，成功/有尝试失败直接落 WALLCLOCK → 进度台 DONE_RE
// 永不命中，恒显示「运行中」。固定：done 行必须(1)覆盖成功路径，(2)在 artifact-check 之后
// （先抢救+自检再判终态），(3)在 WALLCLOCK 之前（progress.mjs 视 done 行为终态边界）。
// 定位用发射专属 needle（`$STAMP done rc=` / `printf 'WALLCLOCK`），杜绝被正文注释抢先匹配。
test('Windows runner：F1 终态三态 done 行收口——成功后必发射，且在 WALLCLOCK 之前', () => {
  const sh = win()
  const artIdx = sh.indexOf('artifact-check.mjs')
  const done0 = sh.indexOf('$STAMP done rc=0 =====')
  const done2 = sh.indexOf('$STAMP done rc=2 (probe-exhausted)')
  const done1 = sh.indexOf('$STAMP done rc=1')
  const wallIdx = sh.indexOf("printf 'WALLCLOCK")
  assert.ok(done0 >= 0 && done2 >= 0 && done1 >= 0, '三态 done 发射点都在场（rc=0 成功 / rc=2 探针耗尽 / rc=1 尝试失败）')
  assert.ok(artIdx >= 0 && done0 > artIdx, 'done 行在 artifact-check 之后（先 host-finalize 抢救+自检再判终态）')
  assert.ok(wallIdx > done0, 'done 行在 WALLCLOCK 之前（progress.mjs 以 done 行为终态，须先于墙钟行）')
  assert.match(sh, /if \[ -f "\$REPORT" \]; then/, '终态块以 REPORT 在场为 rc=0 主判据（抢救成功也计成功）')
  assert.ok(sh.includes(String.raw`done rc=0 (skip-existing)`), "幂等 skip 路径也发射终态行（进度台不显示陈旧终态）")
  // 旧 bug 回归源："成功路径 RC 被强制 0 后 `if [ "$RC" != "0" ]` 跳过 done"——现在必须在 `[ -f "$REPORT" ]` 独立判，不得依赖 RC 分支
  assert.match(sh, /notify "日报未生成/, '失败态通知在场（不再只在成功路径静默）')
  assert.match(sh, /timeout 120 claude -p/, '探针带 120s 墙钟上限（10-04 实证：源站抖动时 CLI 被 hold 12min+，挂起须快速失败）')
})

test('Mac runners（run-daily.sh）：F1 终态三 done 行同样收口（与 win 对齐）', () => {
  const MAC = path.resolve(HERE, '../../../run-daily.sh')
  assert.ok(fs.existsSync(MAC), 'Mac parity runner 在场')
  const sh = fs.readFileSync(MAC, 'utf8')
  const artIdx = sh.indexOf('artifact-check.mjs')
  const done0 = sh.indexOf('$STAMP done rc=0 =====')
  const done2 = sh.indexOf('$STAMP done rc=2 (probe-exhausted)')
  const done1 = sh.indexOf('$STAMP done rc=1')
  const wallIdx = sh.indexOf("printf 'WALLCLOCK")
  assert.ok(done0 >= 0 && done2 >= 0 && done1 >= 0, '三态 done 发射点都在场')
  assert.ok(artIdx >= 0 && done0 > artIdx, 'done 行在 artifact-check 之后')
  assert.ok(wallIdx > done0, 'done 行在 WALLCLOCK 之前')
  assert.ok(sh.includes(String.raw`done rc=0 (skip-existing)`), "幂等 skip 路径也发射终态行")
})
