import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostInject } from '../host-inject.mjs'

// ─── host-inject 宿主 bake 注入（11-11 根治：注入数据不经模型转写）───
// 背景：11-10 补跑四连事故——v1 空拉（大账本吓瘫）、v2 漏 outDir、v3 首调漏 name、v3 重试把完整
// Read 到手的 107 条账本转写成 [null]。注入链去模型化：宿主把数据 bake 进 bundle 头部，args 真传
// （非 null）则优先，bake 只兜底。

// 最小 bundle 骨架：锚点行必须与 host-inject 期望一致（模板源归一两连守卫）。
const mkBundle = () => `// 模拟 bundle 头
export const meta = { name: 'ai-daily' }
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { args = {} } }
if (!args || typeof args !== 'object') args = {}
const OUT = args.outDir || null
// ... realm 执行体
`

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-inject-test-'))
  const bundle = join(dir, 'bundle.js')
  writeFileSync(bundle, mkBundle())
  return { dir, bundle }
}

test('bake：账本/prefetch/receipts 写进 HOST-INJECT 段，位于 args 归一两连守卫之后', () => {
  const { dir, bundle } = mk()
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify([{ day: '2026-11-09', url: 'https://a.com', tokens: ['x'] }]))
  try {
    const r = hostInject({ bundle, ledger })
    assert.equal(r.ok, true)
    assert.deepEqual(r.injected, ['reportedLedger'])
    assert.equal(r.ledgerEntries, 1)
    const src = readFileSync(bundle, 'utf8')
    const bake = src.indexOf('const HOST_INJECT')
    const g2 = src.indexOf("if (!args || typeof args !== 'object') args = {}")
    assert.ok(bake > g2, 'bake 段必须在归一守卫之后（字符串 args 先解包再合并）')
    assert.ok(src.includes('HOST-INJECT-START') && src.includes('HOST-INJECT-END'))
    assert.ok(src.includes('"day":"2026-11-09"'), '账本数据原文在 bundle 内')
    // 语义顺序：解包 → 兜底合并 → OUT 读取（args 消费在 bake 之后）
    assert.ok(src.indexOf('const HOST_INJECT') < src.indexOf('const OUT'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：幂等——重复运行不堆叠段（旧段先删再写）', () => {
  const { dir, bundle } = mk()
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify([{ day: '2026-11-09', url: 'https://a.com', tokens: [] }]))
  try {
    assert.equal(hostInject({ bundle, ledger }).ok, true)
    assert.equal(hostInject({ bundle, ledger }).ok, true)
    const src = readFileSync(bundle, 'utf8')
    assert.equal((src.match(/HOST-INJECT-START/g) || []).length, 1)
    assert.equal((src.match(/HOST-INJECT-END/g) || []).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：args 真传的数据优先，null/undefined 占位才被兜底替换', () => {
  const { dir, bundle } = mk()
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify([{ day: '2026-11-09', url: 'https://a.com', tokens: [] }]))
  try {
    hostInject({ bundle, ledger })
    // 模拟 realm 执行：bake 段语义 = 仅 args[k] 为 null/undefined 时用 HOST_INJECT
    const src = readFileSync(bundle, 'utf8')
    assert.ok(src.includes("if (args[k] === undefined || args[k] === null) args[k] = v"), '兜底条件锁死：真传值不被顶掉')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：空容器/文件缺失 → 不注入该键（别把真数据顶掉），其余键正常', () => {
  const { dir, bundle } = mk()
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify([{ day: '2026-11-09', url: '', tokens: [] }]))
  const emptyArr = join(dir, 'empty-arr.json')
  writeFileSync(emptyArr, '[]')
  const emptyObj = join(dir, 'empty-obj.json')
  writeFileSync(emptyObj, '{}')
  try {
    const r = hostInject({ bundle, ledger, prefetch: emptyArr, receipts: emptyObj })
    assert.deepEqual(r.injected, ['reportedLedger'])
    const r2 = hostInject({ bundle, ledger, prefetch: join(dir, 'missing.json') })
    assert.deepEqual(r2.injected, ['reportedLedger'], '缺失文件静默跳过不报错')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：坏 JSON → 带错误标记注入（运行期可见），不炸整轮', () => {
  const { dir, bundle } = mk()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{broken')
  try {
    const r = hostInject({ bundle, prefetch: bad })
    assert.equal(r.ok, true)
    const src = readFileSync(bundle, 'utf8')
    assert.ok(src.includes('__host_inject_error'), '错误标记进 bundle，realm 侧可见')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：bundle 缺锚点 → 拒绝盲插报错非 0 语义（error 返回）', () => {
  const { dir, bundle } = mk()
  writeFileSync(bundle, "export const meta = {}\nconst x = args.date\n")
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, '[]')
  try {
    const r = hostInject({ bundle, ledger })
    assert.ok(r.error && r.error.includes('锚点'), '必须拒绝而不是乱插')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：残留半个段（有 START 无 END）→ 拒绝覆盖', () => {
  const { dir, bundle } = mk()
  writeFileSync(bundle, mkBundle() + '\n// HOST-INJECT-START（host-inject.mjs 自动生成，勿手改；build 重建后由编排器重 bake）\nconst HOST_INJECT = {}\n')
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify([{ day: '2026-11-09', url: '', tokens: [] }]))
  try {
    const r = hostInject({ bundle, ledger })
    assert.ok(r.error && r.error.includes('截断'), '半个段必须拒绝')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bake：bundle 不存在 → error；全空注入 → 写空段（标记仍在，幂等可重跑）', () => {
  const { dir, bundle } = mk()
  try {
    const r0 = hostInject({ bundle: join(dir, 'nope.js'), ledger: join(dir, 'x.json') })
    assert.ok(r0.error)
    const r = hostInject({ bundle })
    assert.equal(r.ok, true)
    assert.deepEqual(r.injected, [])
    const src = readFileSync(bundle, 'utf8')
    assert.ok(src.includes('const HOST_INJECT = {}'), '空注入也写空段')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
