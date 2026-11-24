import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LADDER, DEFAULT_LADDER_BUDGET_MS, makeSafeAgentWithLadder } from '../ladder.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TRANSIENT = /(422|429|5\d\d|524|timeout|timed out|connection closed|model not found|upstream|gateway|cloudflare)/i
// 2026-11-24 用户指令：两档阶梯（deepseek 主写 → glm-5.3 兜底）。
const LADDER = ['deepseek-v4-flash', 'glm-5.3-flash']
const TRANSIENT_MSG = '524 gateway timeout'

function makeHarness({ byModel = {}, costs = {}, AGENT_TIMEOUT_MS = 360000 } = {}) {
  const calls = []
  const logs = []
  let t = 0
  const recovered = []
  const exhausted = []
  const agent = async (prompt, opts) => {
    calls.push({ prompt, model: opts.model, label: opts.label, timeoutMs: opts.timeoutMs, phase: opts.phase })
    t += (costs[opts.model] || 0)
    const spec = byModel[opts.model]
    if (typeof spec === 'function') return spec()
    if (spec && spec.throw) throw new Error(spec.throw)
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'value')) return spec.value
    return { ok: true, model: opts.model }
  }
  const withDeadline = async (p) => p
  const now = () => t
  const log = (s) => logs.push(String(s))
  const run = makeSafeAgentWithLadder({
    agent, withDeadline, now, log, TRANSIENT, AGENT_TIMEOUT_MS,
    onRecovered: (label, model) => recovered.push({ label, model }),
    onExhausted: (label) => exhausted.push(label),
  })
  return { run, calls, logs, recovered, exhausted }
}

test('DEFAULT_LADDER 两档 id 与默认预算 900000', () => {
  assert.deepEqual(DEFAULT_LADDER, LADDER)
  assert.equal(DEFAULT_LADDER_BUDGET_MS, 900000)
})

test('逐级降：除末级外全 TRANSIENT，末级成功 → recovered at 末级', async () => {
  const h = makeHarness({
    byModel: Object.fromEntries(LADDER.map((m, i) => [m, i === LADDER.length - 1 ? { value: { body: 'ok' } } : { throw: TRANSIENT_MSG }])),
  })
  const last = LADDER[LADDER.length - 1]
  const r = await h.run('hello', { label: 'report', timeoutMs: 600000 }, LADDER, 900000)
  assert.deepEqual(r, { body: 'ok' })
  assert.deepEqual(h.calls.map(c => c.model), LADDER)
  assert.ok(h.logs.some(l => new RegExp('LADDER-OK report recovered at ' + last.replace(/\./g, '\.')).test(l)), '须含 LADDER-OK recovered at 末级：' + h.logs.join(' | '))
  assert.deepEqual(h.recovered, [{ label: 'report', model: last }])
  assert.equal(h.exhausted.length, 0)
})

test('中途成功：首级 TRANSIENT、次级成功 → 不爬更后级', async () => {
  const h = makeHarness({
    byModel: {
      [LADDER[0]]: { throw: TRANSIENT_MSG },
      [LADDER[1]]: { value: { body: 'next-ok' } },
    },
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 900000)
  assert.deepEqual(r, { body: 'next-ok' })
  assert.deepEqual(h.calls.map(c => c.model), [LADDER[0], LADDER[1]])
  assert.ok(h.logs.some(l => new RegExp('LADDER-OK report recovered at ' + LADDER[1].replace(/\./g, '\.')).test(l)))
  assert.deepEqual(h.recovered, [{ label: 'report', model: LADDER[1] }])
})

test('全阶梯废：全部 TRANSIENT → null + LADDER-FAIL at 末级', async () => {
  const h = makeHarness({
    byModel: Object.fromEntries(LADDER.map(m => [m, { throw: TRANSIENT_MSG }])),
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 900000)
  assert.equal(r, null)
  assert.equal(h.calls.length, LADDER.length)
  const lastRe = new RegExp('LADDER-FAIL report at ' + LADDER[LADDER.length - 1].replace(/\./g, '\.'))
  assert.ok(h.logs.some(l => lastRe.test(l)), '须含终局 LADDER-FAIL：' + h.logs.join(' | '))
  assert.deepEqual(h.exhausted, ['report'])
  assert.equal(h.recovered.length, 0)
})

test('非 TRANSIENT 早停：schema 失败不换级', async () => {
  const h = makeHarness({
    byModel: { 'deepseek-v4-flash': { throw: 'schema validation failed' } },
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 900000)
  assert.equal(r, null)
  assert.deepEqual(h.calls.map(c => c.model), ['deepseek-v4-flash'])
  assert.ok(!h.logs.some(l => /LADDER-NEXT/.test(l)), '非 TRANSIENT 不得 LADDER-NEXT：' + h.logs.join(' | '))
  assert.ok(h.logs.some(l => /LADDER-FAIL report at deepseek-v4-flash/.test(l)))
  assert.deepEqual(h.exhausted, ['report'])
})

test('null 路径换级：首级超时 null → 次级成功', async () => {
  const h = makeHarness({
    byModel: {
      [LADDER[0]]: { value: null },
      [LADDER[1]]: { value: { body: 'from-null' } },
    },
  })
  const r = await h.run('hello', { label: 'v0:claim', timeoutMs: 360000 }, LADDER, 900000)
  assert.deepEqual(r, { body: 'from-null' })
  assert.deepEqual(h.calls.map(c => c.model), [LADDER[0], LADDER[1]])
  const nextRe = new RegExp('LADDER-NEXT v0:claim ' + LADDER[0].replace(/\./g, '\\.') + ' → ' + LADDER[1].replace(/\./g, '\\.') + ' \\(null\\)')
  assert.ok(h.logs.some(l => nextRe.test(l)), '须含 null 换级日志：' + h.logs.join(' | '))
  assert.deepEqual(h.recovered, [{ label: 'v0:claim', model: LADDER[1] }])
})

test('预算耗尽：两级全 TRANSIENT、首级后预算已尽 → 停在首级不爬次级', async () => {
  // 两档阶梯下 LADDER-BUDGET 唯一可触发点 = 首级失败后爬次级前（末级失败直接 LADDER-FAIL）。
  const h = makeHarness({
    costs: { [LADDER[0]]: 700 },
    byModel: {
      [LADDER[0]]: { throw: TRANSIENT_MSG },
      [LADDER[1]]: { value: { body: 'should-not-run' } },
    },
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 600)
  assert.equal(r, null)
  assert.deepEqual(h.calls.map(c => c.model), [LADDER[0]])
  const stopRe = new RegExp('LADDER-BUDGET report .*停在 ' + LADDER[0].replace(/\./g, '\\.'))
  assert.ok(h.logs.some(l => stopRe.test(l)), '须含 LADDER-BUDGET 停在首级：' + h.logs.join(' | '))
  assert.deepEqual(h.exhausted, ['report'])
})

test('预算关闭：budgetMs=0 全阶梯 TRANSIENT → 跑满阶梯，无 LADDER-BUDGET', async () => {
  const h = makeHarness({
    costs: Object.fromEntries(LADDER.map(m => [m, 400])),
    byModel: Object.fromEntries(LADDER.map(m => [m, { throw: TRANSIENT_MSG }])),
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 0)
  assert.equal(r, null)
  assert.equal(h.calls.length, LADDER.length)
  assert.ok(!h.logs.some(l => /LADDER-BUDGET/.test(l)), 'budgetMs=0 不得提前停：' + h.logs.join(' | '))
  const lastRe = new RegExp('LADDER-FAIL report at ' + LADDER[LADDER.length - 1].replace(/\./g, '\.'))
  assert.ok(h.logs.some(l => lastRe.test(l)))
})

test('单级阶梯：仅 deepseek TRANSIENT → 立即 null，不尝试其它模型', async () => {
  const h = makeHarness({
    byModel: { 'deepseek-v4-flash': { throw: TRANSIENT_MSG } },
  })
  const r = await h.run('hello', { label: 'report' }, ['deepseek-v4-flash'], 900000)
  assert.equal(r, null)
  assert.deepEqual(h.calls.map(c => c.model), ['deepseek-v4-flash'])
  assert.ok(!h.calls.some(c => c.model !== 'deepseek-v4-flash'))
  assert.deepEqual(h.exhausted, ['report'])
})

test('首级成功：不 onRecovered、无 LADDER-OK', async () => {
  const h = makeHarness({
    byModel: { 'deepseek-v4-flash': { value: { body: 'first' } } },
  })
  const r = await h.run('hello', { label: 'report' }, LADDER, 900000)
  assert.deepEqual(r, { body: 'first' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.recovered.length, 0)
  assert.ok(!h.logs.some(l => /LADDER-OK/.test(l)), '首级成功不得 LADDER-OK：' + h.logs.join(' | '))
  assert.equal(h.exhausted.length, 0)
})

test('工厂源码不含 BREAKER（终局记账在调用方）', () => {
  const src = fs.readFileSync(path.join(HERE, '../ladder.mjs'), 'utf8')
  assert.ok(!src.includes('BREAKER'), 'ladder.mjs 不得调用 BREAKER')
})

test('空 ladder：立即 null + onExhausted', async () => {
  const h = makeHarness()
  const r = await h.run('hello', { label: 'report' }, [], 900000)
  assert.equal(r, null)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.exhausted, ['report'])
})

test('生产形状 withDeadline：reject 透传 → schema 不换级、524 换级', async () => {
  // 生产适配器必须让 agent reject 进入工厂 catch（TRANSIENT.test 才活）。
  // 身份 withDeadline=async p=>p 已经透传；这里显式用 Promise reject 通道，
  // 锁死「settle(null) 吞消息」不得回归。
  const make = (byModel) => {
    const calls = []
    const logs = []
    const agent = async (_p, opts) => {
      calls.push(opts.model)
      const spec = byModel[opts.model]
      if (spec && spec.throw) throw new Error(spec.throw)
      return spec && Object.prototype.hasOwnProperty.call(spec, 'value') ? spec.value : { ok: true }
    }
    const withDeadline = (p) => new Promise((resolve, reject) => p.then(resolve, reject))
    const run = makeSafeAgentWithLadder({
      agent, withDeadline, now: () => 0, log: s => logs.push(String(s)),
      TRANSIENT, AGENT_TIMEOUT_MS: 360000,
    })
    return { run, calls, logs }
  }
  const schema = make({ 'deepseek-v4-flash': { throw: 'schema validation failed' } })
  assert.equal(await schema.run('p', { label: 'report' }, LADDER, 900000), null)
  assert.deepEqual(schema.calls, ['deepseek-v4-flash'])
  assert.ok(!schema.logs.some(l => /LADDER-NEXT/.test(l)), 'schema reject 不得换级：' + schema.logs.join(' | '))

  const gw = make({
    [LADDER[0]]: { throw: TRANSIENT_MSG },
    [LADDER[1]]: { value: { body: 'recovered' } },
  })
  assert.deepEqual(await gw.run('p', { label: 'report' }, LADDER, 900000), { body: 'recovered' })
  assert.deepEqual(gw.calls, [LADDER[0], LADDER[1]])
  const nextRe = new RegExp('LADDER-NEXT report ' + LADDER[0].replace(/\./g, '\.') + ' → ' + LADDER[1].replace(/\./g, '\.'))
  assert.ok(gw.logs.some(l => nextRe.test(l)))
})

test('共享 t0：两票串行对同一 600ms 预算，后票不得再爬后续级', async () => {
  // P2-2：verify 每票自己 t0=now() 会让后票（或后批）重新吃满 LADDER_BUDGET_MS。
  // 共享阶段 t0 后：票 A 300+400 已超 600；票 B 只允许再试当前级（tier 0）然后停。
  const calls = []
  const logs = []
  let t = 0
  const costs = { [LADDER[0]]: 300, [LADDER[1]]: 400 }
  const agent = async (prompt, opts) => {
    calls.push({ prompt, model: opts.model })
    t += costs[opts.model] || 0
    throw new Error(TRANSIENT_MSG)
  }
  const run = makeSafeAgentWithLadder({
    agent, withDeadline: async (p) => p, now: () => t, log: s => logs.push(String(s)),
    TRANSIENT, AGENT_TIMEOUT_MS: 360000,
  })
  const t0 = 0
  const r1 = await run('vote-a', { label: 'v0:a' }, LADDER, 600, t0)
  const r2 = await run('vote-b', { label: 'v0:b' }, LADDER, 600, t0)
  assert.equal(r1, null)
  assert.equal(r2, null)
  assert.deepEqual(calls.filter(c => c.prompt === 'vote-a').map(c => c.model), [LADDER[0], LADDER[1]])
  assert.deepEqual(
    calls.filter(c => c.prompt === 'vote-b').map(c => c.model),
    [LADDER[0]],
    '后票共享 t0 已耗尽，只试 tier 0 即停，不得再爬后续级：' + JSON.stringify(calls),
  )
  const stopRe = new RegExp('LADDER-BUDGET v0:b .*停在 ' + LADDER[0].replace(/\./g, '\.'))
  assert.ok(logs.some(l => stopRe.test(l)), '后票须 LADDER-BUDGET：' + logs.join(' | '))
  assert.ok(!calls.some(c => c.model === 'ladderT0' || c.prompt === undefined))
})
