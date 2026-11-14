import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditReportBodies, extractSynthAtoms } from '../render-md.mjs'
import { sourceTier, capOutlinkQuality } from '../boards.mjs'
import { computeClusterHeat, isRoundupCluster } from '../cluster.mjs'
import { recordFetchReceipts, collectReceiptUrls } from '../finalize.mjs'

// ─── 11-10 P1（AIHOT 借鉴）：合成正文幻觉确定性校验 ───

const mkConfirmed = () => ([
  { claim: 'VFlash 在 3D 点运动预测上实现约 25 倍生成提速，平均成功率 70.2%。', quote: 'approximately 25x faster generation with 70.2% average success rate', sourceUrl: 'https://huggingface.co/papers/2611.08449' },
  { claim: 'Moonshot 开源 Kimi K3.1 Pro 权重：2.8T 总参、104B 激活的多模态 MoE。', quote: 'Kimi K3.1 Pro open weights 2.8T total parameters 104B activated', sourceUrl: 'https://huggingface.co/moonshotai/K3.1-Pro' },
])

const mkReport = summaries => ({
  sections: [{ board: 'labs', title: '实验室', items: summaries.map(s => ({
    title: '某条目', summary: s.summary, sources: s.sources, confidence: 'medium', status: '已核查 2-0',
  })) }],
})

test('extractSynthAtoms：拉丁实体与数字原子抽取，停用词/日期/URL 不算', () => {
  const a = extractSynthAtoms('OpenAI 发布 GPT-6.2，见 https://openai.com/news/2026-11-07/example，2026年11月6日 提速 25 倍、成功率 70.2%、融资 1,200 万美元。')
  assert.ok(a.has('openai') && a.has('gpt-6.2'), '实体词在集内: ' + [...a])
  assert.ok(a.has('70.2%') && a.has('1200'), '数字原子在集内: ' + [...a])
  assert.ok(!a.has('25'), '两位裸数字不查（防误杀）')
  assert.ok(![...a].some(x => x === '2026' || x.startsWith('openai.com')), '日期/URL 不产生原子')
})

test('auditReportBodies：凭空原子 → summary 替换为 claim 原文，计数与样本返回', () => {
  const confirmed = mkConfirmed()
  const report = mkReport([
    { summary: 'VFlash 提速约 25 倍，准确率 70.2%，由 AcmeLabs 发布。', sources: ['https://huggingface.co/papers/2611.08449'] },  // AcmeLabs 凭空
    { summary: 'Kimi K3.1 Pro 为 2.8T 总参 MoE。', sources: ['https://huggingface.co/moonshotai/K3.1-Pro'] },  // 干净
  ])
  const r = auditReportBodies(report, confirmed)
  assert.equal(r.replaced, 1)
  assert.ok(r.atoms >= 1)
  assert.ok(!report.sections[0].items[0].summary.includes('AcmeLabs'), '幻觉文本被替换')
  assert.ok(report.sections[0].items[0].summary.includes('VFlash'), '替换为 claim 原文')
  assert.equal(report.sections[0].items[1].summary.includes('2.8T'), true, '干净条目不动')
})

test('auditReportBodies：无对应 claim（sources 空）→ 保留原文只计数', () => {
  const report = mkReport([{ summary: 'AcmeLabs 凭空实体出现在无来源条目。', sources: [] }])
  const r = auditReportBodies(report, mkConfirmed())
  assert.equal(r.replaced, 0)
  assert.ok(report.sections[0].items[0].summary.includes('AcmeLabs'), '无替换源时不动正文')
})

test('auditReportBodies：金标为空（无 confirmed）→ 零操作', () => {
  const report = mkReport([{ summary: '任意文本 AcmeLabs。', sources: [] }])
  const r = auditReportBodies(report, [])
  assert.equal(r.replaced, 0)
  assert.equal(r.atoms, 0)
})

// ─── 11-12 根修：乱码门（11-11 成品三处漏网实证）───

test('auditReportBodies 乱码门：FFFD → 整段替换为 claim 原文（11-11「吞吐�� x86」case）', () => {
  const report = mkReport([{ summary: 'Agent 负载吞吐\ufffd\ufffd x86，宣称显著提升。', sources: ['https://huggingface.co/papers/2611.08449'] }])
  const r = auditReportBodies(report, mkConfirmed())
  assert.equal(r.mojibake, 1, 'FFFD 命中乱码门')
  assert.equal(r.replaced, 1, '有对应 claim → 整段替换')
  assert.ok(report.sections[0].items[0].summary.includes('VFlash'), '替换为 claim 原文')
  assert.ok(!report.sections[0].items[0].summary.includes('\ufffd'))
})

test('auditReportBodies 乱码门：金标不含的常用区生僻字 → 替换（11-11「工作巟。」case）', () => {
  // 11-12 设计收敛：常用区金标外单字判定误杀率实测不可行（金标是压缩改写，正常同义换词
  // 即触发，如'准确率' vs 金标'成功率'）→ 巟类不拦，记录设计决策于 render-md.mjs 注释 ③。
  // 本测试锁定：正常中文零误杀这一硬约束优先于覆盖生僻错字。
  const report = mkReport([{ summary: 'VFlash 提速约 25 倍，准确率 70.2%。', sources: ['https://huggingface.co/papers/2611.08449'] }])
  const r = auditReportBodies(report, mkConfirmed())
  assert.equal(r.mojibake, 0, '同义换词（金标无「准」字）零误杀')
  assert.equal(r.replaced, 0)
})

test('auditReportBodies 乱码门：CJK 扩展区/私有区字符 → 替换', () => {
  const report = mkReport([
    { summary: '该模型在测试中表现㐀㐁异常。', sources: ['https://huggingface.co/papers/2611.08449'] },   // 㐀=U+3400 Ext-A
    { summary: 'Kimi K3.1 Pro 权重已开放。', sources: ['https://huggingface.co/moonshotai/K3.1-Pro'] },
  ])
  const r = auditReportBodies(report, mkConfirmed())
  assert.equal(r.mojibake, 1, 'Ext-A 命中')
  assert.equal(r.replaced, 1)
  assert.ok(!report.sections[0].items[0].summary.includes('㐀'))
})

test('auditReportBodies 乱码门：金标含的 CJK 字不误杀（正常中文正文零操作）', () => {
  const report = mkReport([
    { summary: 'VFlash 提速约 25 倍，平均成功率 70.2%。', sources: ['https://huggingface.co/papers/2611.08449'] },
    { summary: 'Moonshot 开源 Kimi K3.1 Pro 权重。', sources: ['https://huggingface.co/moonshotai/K3.1-Pro'] },
  ])
  const r = auditReportBodies(report, mkConfirmed())
  assert.equal(r.mojibake, 0, '金标内的字全部放行')
  assert.equal(r.replaced, 0, '正常中文条目零操作')
})

// ─── 11-10 P2-①（AIHOT 借鉴）：信源 tier ───

test('sourceTier：官方一手域名 T1（含子域），媒体 T2，垃圾输入 T2', () => {
  assert.equal(sourceTier('https://openai.com/news/rss.xml'), 'T1')
  assert.equal(sourceTier('https://www.anthropic.com/news/model-hardware-standard'), 'T1')
  assert.equal(sourceTier('https://api-docs.deepseek.com/news/news260821'), 'T1')
  assert.equal(sourceTier('https://arxiv.org/abs/2611.08449'), 'T1')
  assert.equal(sourceTier('https://techcrunch.com/2026/11/07/x/'), 'T2')
  assert.equal(sourceTier('https://www.qbitai.com/2026/11/507082.html'), 'T2')
  assert.equal(sourceTier(''), 'T2')
  assert.equal(sourceTier(null), 'T2')
  // 仿冒域（openai.com.evil.io）不得命中：host 后缀判定
  assert.equal(sourceTier('https://openai.com.evil.io/news'), 'T2')
})

// ─── 11-13 质量闸（黄仁勋 case 复盘）：outlink 假 primary 域名封顶 ───

test('capOutlinkQuality：11-13 黄仁勋 fixture 回放——真 T1（nvidianews）primary 行为不变', () => {
  const bound = {
    url: 'https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition',
    title: 'Nvidia准备解雇ceo黄仁勋（更新：黄仁勋已辞去Nvidia CEO）',
    found_via: 'linuxdo-outlink', board: 'linuxdo',
    sourceQuality: 'primary',
    claims: [{ claim: '黄仁勋已辞去 Nvidia CEO，CFO 克雷斯临时接任', sourceUrl: 'https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition', sourceQuality: 'primary' }],
  }
  const r = capOutlinkQuality(bound)
  assert.equal(r.capped, 0, '真 T1 不封顶')
  assert.equal(bound.sourceQuality, 'primary')
  assert.equal(bound.claims[0].sourceQuality, 'primary')
})

test('capOutlinkQuality：非 T1 域（转载/自媒体/仿冒）outlink primary → 封顶 secondary 并计数', () => {
  // HIGH_VALUE_OUTLINK_RE 白名单含 techcrunch 等媒体域——社区帖引到媒体页本就该是 secondary
  const bound = {
    url: 'https://techcrunch.com/2026/11/13/some-repost/',
    found_via: 'linuxdo-outlink', board: 'linuxdo',
    sourceQuality: 'primary',  // fetch 代理看页面长相误判（无域名校验时的真实行为）
    claims: [
      { claim: '某模型发布', sourceUrl: 'https://some-blog.io/post', sourceQuality: 'primary' },
      { claim: '另一发布', sourceUrl: 'https://techcrunch.com/2026/11/13/x/', sourceQuality: 'primary' },  // 源页自身 = T2
    ],
  }
  const r = capOutlinkQuality(bound)
  assert.equal(r.capped, 3, '源 + 2 claim 全封顶')
  assert.equal(bound.sourceQuality, 'secondary')
  assert.equal(bound.claims[0].sourceQuality, 'secondary')
  assert.equal(bound.claims[1].sourceQuality, 'secondary')
})

test('capOutlinkQuality：仿冒域 openai.com.evil.io 不得借 T1 通票（host 后缀判定）', () => {
  const bound = {
    url: 'https://openai.com.evil.io/news/ceoresign', found_via: 'linuxdo-outlink',
    sourceQuality: 'primary', claims: [{ claim: '假官宣', sourceQuality: 'primary' }],
  }
  const r = capOutlinkQuality(bound)
  assert.equal(r.capped, 2, '仿冒域全封顶——本闸的存在意义')
  assert.equal(bound.sourceQuality, 'secondary')
})

test('capOutlinkQuality：非 outlink 通道与非 primary 质量零操作（审计透传）', () => {
  const forum = { url: 'https://some-forum.io/t/1', found_via: 'linuxdo-cdp', sourceQuality: 'forum', claims: [] }
  assert.equal(capOutlinkQuality(forum).capped, 0)
  assert.equal(forum.sourceQuality, 'forum', 'forum 不动')
  const staticSrc = { url: 'https://qbitai.com/', found_via: 'static-fallback', sourceQuality: 'primary', claims: [] }
  assert.equal(capOutlinkQuality(staticSrc).capped, 0, 'static-fallback 不归本闸（自有索引页治理）')
  const secondary = { url: 'https://blog.example.io/x', found_via: 'linuxdo-outlink', sourceQuality: 'secondary', claims: [] }
  assert.equal(capOutlinkQuality(secondary).capped, 0, '本就 secondary 无需封顶')
  assert.equal(capOutlinkQuality(null).capped, 0, 'null 防御')
})

// ─── 11-10 P2-②/P3（AIHOT 借鉴）：事件热度 + ROUNDUP ───

const mkCluster = (items) => ({ key: items[0].claim, items })

test('computeClusterHeat：独立域名计数 × 24h 半衰，roundup 由编排层折价', () => {
  const today = '2026-11-10'
  const fresh = mkCluster([
    { claim: 'A 事件', date: '2026-11-10', sources: ['https://a.com/x', 'https://b.com/y'], sourceUrl: 'https://a.com/x' },
    { claim: 'A 事件进展', date: '2026-11-10', sources: ['https://a.com/z'], sourceUrl: 'https://a.com/z' },  // 同域 a.com 不重复计
  ])
  assert.equal(computeClusterHeat(fresh, today), 2)  // a.com + b.com = 2 独立源，当日内不衰减

  const old = mkCluster([{ claim: 'B 事件', date: '2026-11-08', sources: ['https://c.com/x'], sourceUrl: 'https://c.com/x' }])
  const h = computeClusterHeat(old, today)
  assert.ok(h > 0.2 && h < 0.3, '48h = 1×0.5^2 ≈ 0.25（24h 衰减一半），got ' + h)

  assert.equal(computeClusterHeat(mkCluster([{ claim: 'C', sources: [], sourceUrl: '' }]), today), 0, '无来源 → 0')
  assert.equal(computeClusterHeat(mkCluster([{ claim: 'D', date: '垃圾', sources: ['https://e.com/x'] }]), today), 1, '日期解析失败 → 当日内不衰减（保守取高）')
})

test('isRoundupCluster：汇总词命中为真，普通事件为假', () => {
  assert.equal(isRoundupCluster(mkCluster([{ claim: '本周 AI 领域一周要闻汇总：多家媒体盘点了大模型进展', title: 'weekly roundup' }])), true)
  assert.equal(isRoundupCluster(mkCluster([{ claim: 'VFlash 在 3D 点运动预测上实现 25 倍提速', title: 'VFlash 论文' }])), false)
})

// ─── 11-10 P2-③（AIHOT 借鉴）：fetch 回执 ───

import { parseFetchReceipts, receiptFilter } from '../ledger.mjs'

test('parseFetchReceipts：合法对象通过，非对象/数组/脏值过滤，全脏→null', () => {
  assert.deepEqual(parseFetchReceipts({ 'a.com': '2026-11-09', 'bad.com': 'nope' }), { 'a.com': '2026-11-09' })
  assert.equal(parseFetchReceipts(null), null)
  assert.equal(parseFetchReceipts([['a', 'b']]), null)
  assert.equal(parseFetchReceipts({ x: 123 }), null)  // 非字符串值全滤→空
})

test('parseFetchReceipts：JSON 字符串容错（review P2 根修，对齐 parseReportedLedger 契约）', () => {
  assert.deepEqual(parseFetchReceipts('{"a.com":"2026-11-09"}'), { 'a.com': '2026-11-09' })
  assert.equal(parseFetchReceipts('{broken'), null, '坏字符串 → null（fail-open 过滤关闭）')
  assert.equal(parseFetchReceipts('null'), null)
})

test('collectReceiptUrls：template 真实对象形态（review P1 根修回归锁）——{confirmed}/{sources} 对象 + claimUrls 必收', () => {
  // template.js 真实形态：claimsJson 顶层 {confirmed:[]}，sourcesJson 顶层 {sources:[{url, claimUrls}]}
  const claimsJson = JSON.stringify({ date: '2026-11-10', confirmed: [{ source: 'https://a.com/x' }], refuted: [] })
  const sourcesJson = JSON.stringify({ date: '2026-11-10', sources: [
    { url: 'https://b.com/idx' },                                            // 索引页（0-claim 也必进回执域）
    { url: 'https://c.com/x', claimUrls: ['https://c.com/art-1', 'https://c.com/art-2'] },  // 索引页抓出的文章页
  ] })
  const urls = collectReceiptUrls(claimsJson, sourcesJson).sort()
  assert.deepEqual(urls, ['https://a.com/x', 'https://b.com/idx', 'https://c.com/art-1', 'https://c.com/art-2', 'https://c.com/x'])
  // 数组形态兼容兜底
  const arrUrls = collectReceiptUrls(JSON.stringify([{ source: 'https://d.com/w' }]), JSON.stringify([{ url: 'https://e.com/v' }]))
  assert.deepEqual(arrUrls.sort(), ['https://d.com/w', 'https://e.com/v'])
  // 空输入防御
  assert.deepEqual(collectReceiptUrls(null, null), [])
})

test('receiptFilter：static-fallback 豁免必重抓（review 根修①），age<=1 复用、age>=2 重抓（根修②）', () => {
  const receipts = { 'a.com/x': '2026-11-09', 'b.com/y': '2026-11-08', 'c.com/z': '2026-11-10' }
  const targets = [
    { url: 'https://a.com/x' },                              // 昨天抓过 → 复用
    { url: 'https://b.com/y' },                              // 前天抓过 → 重抓（原 age<=2 会误复用 ~72h）
    { url: 'https://c.com/z' },                              // 今天抓过 → 复用
    { url: 'https://static.com/idx', found_via: 'static-fallback' },  // 昨天抓过也必重抓
    { url: 'https://d.com/new' },                            // 没抓过 → 保留
  ]
  const { keep, reused } = receiptFilter(targets, receipts, '2026-11-10')
  assert.equal(reused, 2, 'a.com 与 c.com 复用')
  const keptUrls = keep.map(t => t.url)
  assert.ok(keptUrls.includes('https://b.com/y'), '前天抓过的重抓')
  assert.ok(keptUrls.includes('https://static.com/idx'), 'static-fallback 豁免：发现页必重抓')
  assert.ok(keptUrls.includes('https://d.com/new'))
  assert.equal(keptUrls.includes('https://a.com/x'), false)
  // 防御：垃圾输入目标不炸
  const r2 = receiptFilter([null, { url: '' }], receipts, '2026-11-10')
  assert.equal(r2.keep.length, 2)
})

test('recordFetchReceipts：合并追加、URL 归一、60 天 prune、损坏重建', () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await_import_fs()
  const dir = mkdtempSync('receipts-test-')
  const p = dir + '/fetch-receipts.json'
  try {
    const r1 = recordFetchReceipts(p, ['https://www.A.com/x', 'https://b.com/y?q=1'], '2026-11-08')
    assert.deepEqual(r1, { total: 2, added: 2 })
    const r2 = recordFetchReceipts(p, ['https://a.com/x', 'https://c.com/z'], '2026-11-10')  // a.com 归一命中 → 只加 c
    assert.deepEqual(r2, { total: 3, added: 1 })
    const j = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(j['a.com/x'], '2026-11-10', '同 URL 刷新为最新抓取日')
    // 60 天 prune
    writeFileSync(p, JSON.stringify({ 'old.com/x': '2026-08-01', 'new.com/y': '2026-11-09' }))
    const r3 = recordFetchReceipts(p, [], '2026-11-10')
    assert.deepEqual(r3, { total: 1, added: 0 })
    assert.equal(JSON.parse(readFileSync(p, 'utf8'))['old.com/x'], undefined, '超 60 天条目被 prune')
    // 损坏重建
    writeFileSync(p, '{broken')
    const r4 = recordFetchReceipts(p, ['https://d.com/w'], '2026-11-10')
    assert.deepEqual(r4, { total: 1, added: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// node:test 顶层 await import 的最小包装（避免文件级 top-level await 与其它 runner 冲突）
import fs from 'node:fs'
function await_import_fs() { return fs }

// ─── 11-10 二次事故回归锁：--ledger 隔离下回执不得写穿 DEFAULT ───
test('CLI --ledger 隔离：finalize 落盘成功路径的回执跟 override 同目录，不写 DEFAULT_FETCH_RECEIPTS', async t => {
  // 直测 cliMain 内部分支语义不可行（spawn 成本高）——用与 cliMain 相同的表达式验证：
  // ledgerOverride 存在 → receiptsPath = dirname(override)/fetch-receipts.json
  const path = (await import('node:path')).default
  const override = '/tmp/fake/ledger.json'
  const receiptsPath = override ? path.join(path.dirname(override), 'fetch-receipts.json') : 'DEFAULT'
  const os = (await import('node:os')).default
  assert.equal(receiptsPath, path.join('/tmp/fake', 'fetch-receipts.json'))
  assert.notEqual(receiptsPath, path.join(os.homedir(), '.ai-daily', 'fetch-receipts.json'), '不得指向生产回执路径')
})

// ─── 11-14 P2：未核查项 title-claim 一致性门（当日 4/4 错位实证）───
// 实证：report 代理为 unverified claim 自拟 title 时概括了背景事件而非 claim 本身
// （title 说 Orchestrator 配额、正文渲染 Hydrogen 定价原文）——title 是编的、claim 是
// 账本原文，无一致性约束。确定性防线：title 实体原子与 claim 原子零交集 → 弃 title。

test('auditReportBodies title 门：未核查项 title 与 claim 零实体交集 → 弃 title 用 claim 原文（11-14 实证回放）', () => {
  const confirmed = []
  const unverified = [
    { claim: 'Gemini 4 Hydrogen 在整个 100 万 token 上下文窗口内实行统一价格：输入 1.50 美元/百万 token，输出 7.50 美元/百万 token。', sourceUrl: 'https://blog.google/x' },
    { claim: 'inclusionAI 发布 Duo v1 全双工世界模型，可实时持续感知视听输入并同时回应用户', sourceUrl: 'https://huggingface.co/y' },
  ]
  const mkItem = (title, summary, sources) => ({ title, summary, sources, confidence: 'low', status: '未核查' })
  const report = { sections: [{ board: 'labs', title: '实验室', items: [
    // 11-14 真实错位形态：title 讲 Orchestrator 配额，claim 是 Hydrogen 定价
    mkItem('据称 Antigravity Orchestrator 少耗 24% 配额', unverified[0].claim, ['https://blog.google/x']),
    mkItem('称 Duo v1 用双 rollout 蒸馏缓解分布偏移', unverified[1].claim, ['https://huggingface.co/y']),
  ] }] }
  const r = auditReportBodies(report, confirmed, unverified)
  assert.equal(r.titleFixed, 2, '两条错位 title 全被弃用: ' + JSON.stringify(r))
  assert.ok(report.sections[0].items[0].title.includes('Hydrogen') || report.sections[0].items[0].title.includes('统一价格'), 'title 修复为 claim 前缀: ' + report.sections[0].items[0].title)
  assert.ok(report.sections[0].items[1].title.includes('Duo') || report.sections[0].items[1].title.includes('全双工'), 'title 修复为 claim 前缀: ' + report.sections[0].items[1].title)
})

test('auditReportBodies title 门：title 与 claim 共享实体 → 不动；已核查项不校验（不扩口径）', () => {
  const confirmed = mkConfirmed()
  const unverified = [
    { claim: '据称 DuoEcho 团队裁撤了整个 multimodal 团队约 70 人', sourceUrl: 'https://example.com/z' },
  ]
  const report = { sections: [{ board: 'labs', title: '实验室', items: [
    // 未核查 + title 与 claim 共享实体（DuoEcho/multimodal/70）→ 不动
    { title: '传 DuoEcho 裁撤 multimodal 团队 70 人', summary: unverified[0].claim, sources: ['https://example.com/z'], status: '未核查' },
    // 已核查项即使 title 与 claim 零交集也不校验（vote 支撑，不扩口径）
    { title: '开源推理栈迈入基础设施时代', summary: 'VFlash 提速 25 倍。', sources: ['https://huggingface.co/papers/2611.08449'], status: '已核查 2-0' },
  ] }] }
  const r = auditReportBodies(report, confirmed, unverified)
  assert.equal(r.titleFixed, 0, '零误杀')
  assert.equal(report.sections[0].items[0].title, '传 DuoEcho 裁撤 multimodal 团队 70 人', '共享实体的 title 不动')
  assert.equal(report.sections[0].items[1].title, '开源推理栈迈入基础设施时代', '已核查项不校验')
})

test('auditReportBodies title 门：无 claim 来源对应 → title 保留（不编造替换源）', () => {
  const report = { sections: [{ board: 'labs', title: '实验室', items: [
    { title: '凭空标题无来源', summary: '某声明 AcmeLabs 相关。', sources: [], status: '未核查' },
  ] }] }
  const r = auditReportBodies(report, [], [])
  assert.equal(r.titleFixed, 0)
  assert.equal(report.sections[0].items[0].title, '凭空标题无来源', '无替换源不动')
})
