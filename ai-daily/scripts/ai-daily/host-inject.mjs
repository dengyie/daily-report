// host-inject.mjs —— 编排器 launch 前，把注入数据直接 bake 进 workflow bundle（治 11-10/11-11 注入链事故）。
//
// 背景（11-11 复盘，四连根因）：args 注入走「子代理 Read 文件 → 模型转写进 Workflow tool_use input」，
// 转写层不可靠且不可测：v1 被大账本吓瘫不调用（空拉）；v2 漏 outDir 被 realm 拒；v3 首调漏 name 被
// InputValidationError 拒；v3 重试把完整 Read 到手的 107 条账本/8 帖 prefetch 转写成 [null]/null。
// 结论：注入数据不得再经模型。宿主在 launch 前把数据写进 bundle 头部常量，realm 从自己的源码里取。
//
// 语义（保守优先）：args 里模型真传了（非 null/undefined）→ 用模型的；否则用宿主 bake 的兜底。
//   这同时治「模型没传」与「模型转写成 null 占位」两种失败，而宿主文件内容永远比模型转写可信。
//
// 幂等：HOST-INJECT 段有标记，重复运行先删旧段再写新段；bundle 不存在则报错非 0。
// build.mjs 重建 bundle 会冲掉 bake 段 → 每次编排器 launch 前都必须重跑本脚本（幂等，成本 ~ms）。
// realm 侧消费在 ai-daily.template.js 的 args 归一区（HOST-INJECT-START 标记内联）。

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'

// CLI: node host-inject.mjs --bundle <path> --ledger <ledger.json> [--prefetch <prefetch.json>] [--receipts <receipts.json>]
export function hostInject({ bundle, ledger, prefetch, receipts } = {}) {
  if (!bundle || !existsSync(bundle)) return { error: `bundle 不存在: ${bundle}` }

  const pick = (p, what) => {
    if (!p) return undefined
    if (!existsSync(p)) return undefined
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'))
      // 空容器视为缺失：等价没注入，别把 args 里的真数据顶掉
      if (v == null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) return undefined
      return v
    } catch (e) {
      return { __host_inject_error: `${what} 解析失败: ${e.message}` }
    }
  }

  const inject = {}
  const led = pick(ledger, 'ledger')
  if (led !== undefined) inject.reportedLedger = led
  const pre = pick(prefetch, 'prefetch')
  if (pre !== undefined) inject.linuxdoPrefetched = pre
  const rec = pick(receipts, 'receipts')
  if (rec !== undefined) inject.fetchReceipts = rec

  const START = '// HOST-INJECT-START（host-inject.mjs 自动生成，勿手改；build 重建后由编排器重 bake）'
  const END = '// HOST-INJECT-END'
  let src = readFileSync(bundle, 'utf8')
  // 幂等：删旧段（含可能残留的半个段——只认完整 START..END，无 START 则无操作）
  const s = src.indexOf(START)
  if (s >= 0) {
    const e = src.indexOf(END, s)
    if (e < 0) return { error: 'bundle 存在 HOST-INJECT-START 但无 END（上次 bake 被截断？），拒绝覆盖' }
    src = src.slice(0, s) + src.slice(e + END.length)
  }
  // 插入点：args 归一两连守卫（string 解包 + 对象兜底）**之后**——若 harness 把 args 传成 JSON 字符串，
  // bake 段必须在解包后再合并，否则 args[k] 取在字符串上全 undefined、解包后数据丢失。
  // bundle 头部必含这两行（模板源固定），找不到即 bundle 版本不符，拒绝盲插。
  const ANCHOR = "if (!args || typeof args !== 'object') args = {}"
  const ai = src.indexOf(ANCHOR)
  if (ai < 0) return { error: `bundle 缺 args 归一锚点（${ANCHOR}），bundle 版本与 host-inject 不符` }
  const anchorEnd = ai + ANCHOR.length
  const body = Object.keys(inject).length
    ? `\n${START}\nconst HOST_INJECT = ${JSON.stringify(inject)}\nfor (const [k, v] of Object.entries(HOST_INJECT)) if (args[k] === undefined || args[k] === null) args[k] = v\n${END}\n`
    : `\n${START}\nconst HOST_INJECT = {}\n${END}\n`
  src = src.slice(0, anchorEnd) + body + src.slice(anchorEnd)

  const tmp = bundle + '.tmp'
  writeFileSync(tmp, src)
  renameSync(tmp, bundle)
  return { ok: true, injected: Object.keys(inject), ledgerEntries: Array.isArray(led) ? led.length : undefined }
}

// ─── CLI ───
const isMain = process.argv[1] && (process.argv[1].endsWith('host-inject.mjs'))
if (isMain) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  const bundle = arg('--bundle')
  const ledger = arg('--ledger')
  const prefetch = arg('--prefetch')
  const receipts = arg('--receipts')
  if (!bundle) { console.error('用法: node host-inject.mjs --bundle <workflow.js> --ledger <ledger.json> [--prefetch <p.json>] [--receipts <r.json>]'); process.exit(1) }
  const r = hostInject({ bundle, ledger, prefetch, receipts })
  if (r.error) { console.error('HOST-INJECT-FAIL', r.error); process.exit(1) }
  console.log(`HOST-INJECT-OK [${r.injected.join(',') || '无'}]${r.ledgerEntries !== undefined ? ` ledger=${r.ledgerEntries}条` : ''} → ${bundle}`)
}
