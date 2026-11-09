import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditReportBodies, extractSynthAtoms } from '../render-md.mjs'
import { sourceTier } from '../boards.mjs'
import { computeClusterHeat, isRoundupCluster } from '../cluster.mjs'
import { recordFetchReceipts } from '../finalize.mjs'

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
