import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkClaim, needsVerification, gateClaims, isExtraordinaryClaim } from '../claim-gate.mjs'

// 10-04 日报质量审计回归（docs/2026-10-04-claim-quality-gate-design.md §1.1）：
// 论坛附件标注被提取为可证伪声明 → "image 580×286 7.97 KB" 通过 2-0 核查投票 → 写入生产账本，
// 并把 Antigravity Opus 5.5 发布（两帖印证）挤出正文。本组 fixture 逐字取自当日
// verified-claims.json 的 unverified 数组——垃圾原文一字不改，作为回归金标准。

const JUNK_10_04 = [
  'image 580×286 7.97 KB',
  '如图： image 487×438 13.4 KB 不用忍受被封号，KYC了，直接200刀ultra',
  'https://www.nytimes.com/2026/09/29/us/anthropic-claude-morals-ai.html The Times',
]

test('isJunkClaim：10-04 实证垃圾原文逐条拦截（回归金标准）', () => {
  for (const t of JUNK_10_04) assert.equal(isJunkClaim({ claim: t }), true, JSON.stringify(t))
})

test('isJunkClaim：ASCII x 尺寸分隔符变体同样拦截（10-04 复审 Suggestion-3）', () => {
  assert.equal(isJunkClaim({ claim: 'image 580x286 7.97 KB' }), true, '提取器产出 ASCII x 不漏')
  assert.equal(isJunkClaim({ claim: '如图： image 487x438 13.4 KB 不用忍受被封号' }), true, '内嵌变体')
})

test('isJunkClaim：模式表边界（附件标注变体 / 过短 / 纯 URL）', () => {
  assert.equal(isJunkClaim({ claim: 'image 487×438' }), true, '附件标注无大小后缀仍拦')
  assert.equal(isJunkClaim({ claim: '13.4 KB' }), true, '纯大小串')
  assert.equal(isJunkClaim({ claim: '涨停了' }), true, '<8 字符不可证伪')
  assert.equal(isJunkClaim({ claim: 'https://linux.do/t/2979428' }), true, '纯 URL')
  assert.equal(isJunkClaim({ claim: null }), true, '非字符串防御')
})

test('isJunkClaim：真实声明不误杀（反例锁死）', () => {
  const REAL = [
    'Gboard 已用基于 TEE 的联邦学习系统训练英语与日语下一词预测模型',            // 10-04 官方一手
    '微软把 Rust 提为一级语言',                                                 // 10-04 被挤出的真头条
    '谷歌宣布自 2026 年 10 月起调整 Gemini 用量限额，未订阅用户 10 月 9 日生效', // 数字 + 专名
    'OpenAI 发布 o6',                                                          // 短但有拉丁实体
    '如图 3 所示，营收增长 30%',                                                // 「如图」收窄模式防误杀（设计 §5）
    'https://research.google/blog/toward-provably-private-learning-from-federated-data/ 提出 TEE 联邦学习系统', // URL 开头但剩余文字 ≥12
  ]
  for (const t of REAL) assert.equal(isJunkClaim({ claim: t }), false, JSON.stringify(t))
})

test('isJunkClaim：残余语义噪声如实不拦（设计 §5 覆盖边界——靠 prompt 层减少；注意 CJK≥10 碎片仍可过 substance 门到达 verify，测试如实锁定边界不夸大）', () => {
  const RESIDUAL = [
    '这个参数和模型的数据知识量有关',                                                          // 无主语评论碎片
    '虽然技术报告都看过，但是看到切开来的电镜图还是有点起鸡皮疹药 哔哩哔哩 逻辑折叠深度解析', // 评论转述
  ]
  for (const t of RESIDUAL) assert.equal(isJunkClaim({ claim: t }), false, '机械模式不判语义——诚实锁定覆盖边界')
})

// ─── 11-13 质量闸补齐：Discourse 附件名直出形态（无 'image ' 前缀）漏网实证 ───
// fixture 逐字取自 2026-11-13 verified-claims.json unverified 数组——8 条未核里 2 条纯图片文件名、
// 1 条文件名+评论残片。既有模式表假设 'image ' 前缀必在，论坛 mint 路没有该前缀 → 全部漏网。

const JUNK_11_13 = [
  'IMG_0610 1293×1056 127 KB',                                     // 纯附件标注（IMG_ 文件名开头）
  '77d5d7ae6d3969bd8f66db74d573e3f38ed7f6a4 1320×1735 179 KB',     // 哈希文件名开头
  'IMG_4628 1290×621 108 KB 不会真的是老黄的D戳破AI泡沫吧',           // 文件名 + 尾部评论残片
]

test('isJunkClaim：11-13 实证附件名直出形态逐条拦截（回归金标准）', () => {
  for (const t of JUNK_11_13) assert.equal(isJunkClaim({ claim: t }), true, JSON.stringify(t))
  assert.equal(isJunkClaim({ claim: 'photo_2026-11-13.png' }), true, '图片扩展名文件名直出')
  assert.equal(isJunkClaim({ claim: 'screenshot 2026-11-13 at 10.24.11.jpeg' }), true, '带空格的文件名+扩展名')
})

test('isJunkClaim：11-13 形态反例不误杀（真实声明锁死）', () => {
  const REAL = [
    'Nvidia 准备解雇ceo黄仁勋，CFO 克雷斯临时接任',                     // 11-13 真 T1 头条（同源同日）
    'IMG 架构在推理时吞吐提升 25%',                                    // IMG 大写开头但非附件名（无数字序号）
    '该分辨率 1293×1056 的截图显示模型输出了错误答案',                   // 尺寸对在句中、无附件名开头
    'OpenAI 发布 GPT-6.2，在 SWE-Bench 上得分为 74.3%。',               // 正常实体声明
  ]
  for (const t of REAL) assert.equal(isJunkClaim({ claim: t }), false, JSON.stringify(t))
})

test('isJunkClaim：11-14 复审收紧——纯数字/大写 hex 开头的真声明不误杀', () => {
  const REAL = [
    '7777777777777777777777777777777 是一种新型密钥格式',               // 16+ 位纯数字开头（非 hex 文件名）
    '1152921504606846976 种组合超过棋类博弈状态空间',                   // 大数量级声明
    'DEADBEEFCAFEBABEDEADBEEFCAFEBABE 是该固件的魔数签名',              // 大写 hex 词开头（禁 /i 后不拦）
  ]
  for (const t of REAL) assert.equal(isJunkClaim({ claim: t }), false, JSON.stringify(t))
  // 金标哈希文件名（含 a-f 字母）仍拦——收紧不破正面形态
  assert.equal(isJunkClaim({ claim: 'deadbeefdeadbeefdeadbeefdeadbeef 1320×1735 179 KB' }), true, '小写 hex 哈希文件名仍拦')
})

test('isJunkClaim：11-14 实证——Screenshot_ 时间戳原图名 / 如图所示 变体（当日 unverified 池漏网新形态）', () => {
  // 逐字取自 2026-11-14 verified-claims.json unverified 数组（2 条漏网）
  assert.equal(isJunkClaim({ claim: 'HW9GgJ_WcAA9m3I 2048×1162 171 KB Screenshot_2026-11-13-09-32-13-66_0b2fce7a16bf2' }), true, '哈希 ID + 宽高 + Screenshot 时间戳组合（哈希前缀已拦，双保险）')
  assert.equal(isJunkClaim({ claim: '如图所示，Gemini Pro Pixel账号 Screenshot_20261113-010506_Gemini~1 1440×3021 271 KB' }), true, '「如图所示」口语变体开头（今日新金标）')
  assert.equal(isJunkClaim({ claim: 'Screenshot_20261113-010506_Gemini~1 1440×3021 271 KB' }), true, 'Screenshot_ 时间戳原图名直出（去掉前缀后裸形态）')
  // 反例：Screenshot_ 仅出现在句中、或「如图所示」后接真实说明 → 不误杀
  assert.equal(isJunkClaim({ claim: '该团队开源了 Screenshot_20261113 中展示的 UI 自动化框架' }), false, '文件名在句中不拦')
  assert.equal(isJunkClaim({ claim: '如图所示，推理吞吐提升 30%' }), false, '如图所示 + 真实声明不拦')
})

test('needsVerification：无实质内容不烧核查票（三分支与边界）', () => {
  assert.equal(needsVerification({ claim: '纯中文碎片句子测试' }), false, '9 CJK 无数字无拉丁 → 不核')
  assert.equal(needsVerification({ claim: '纯中文碎片句子测试十条' }), true, '10 CJK 成句 → 核')
  assert.equal(needsVerification({ claim: '版本 2.0 发布' }), true, '含数字')
  assert.equal(needsVerification({ claim: 'Rust 一级语言' }), true, '含拉丁实体')
  assert.equal(needsVerification({ claim: '' }), false, '空串防御')
  // 10-04 实证：垃圾附件标注即使漏过 isJunkClaim 也必须被 substance 门拦在 verify 外
  assert.equal(needsVerification({ claim: 'image 580×286' }), true, '含数字——由 isJunkClaim 前置拦截，双门互补')
})

test('gateClaims：分账不丢不改写（对象引用原样透传）', () => {
  const junk = { claim: 'image 580×286 7.97 KB', sourceUrl: 'https://linux.do/t/2979428' }
  const real = { claim: '微软把 Rust 提为一级语言', sourceUrl: 'https://linux.do/t/2977263', importance: 'central' }
  const { clean, dropped } = gateClaims([junk, real])
  assert.deepEqual(dropped, [junk], '垃圾入 dropped')
  assert.deepEqual(clean, [real], '真声明入 clean')
  assert.equal(clean[0], real, '引用透传（不改写不复制）')
  assert.equal(gateClaims(null).dropped.length, 0, 'null 防御')
  assert.equal(gateClaims([]).clean.length, 0, '空批防御')
})

// ─── 11-14 external_check 目标扩展：isExtraordinaryClaim（人事/并购/解散关闭/诉讼）───
// 根修动因：T2 占比 71% 环境下 forum/blog 口径太窄（11-14 实证 10/14 confirmed 全无外部防线）。
// 非常规声明（组织级事件突变）是软文最爱的形态，仅靠内部一致性票无法识破——二手源命中即进
// ext 抽查。机械可识别（动词+实体结构），宁滥勿漏（佐证票成本有界：每条 1 张 low-effort 票）。

test('isExtraordinaryClaim：人事变动/并购/解散关闭/诉讼处罚 四族正面形态', () => {
  const HIT = [
    'Nvidia 准备解雇ceo黄仁勋，CFO 克雷斯临时接任',       // 11-13 真 T1 头条（人事）
    'OpenAI 收购 AI 编程初创 Cursor',                     // 并购
    '英特尔宣布关闭其车载 AI 部门',                        // 关闭
    'Meta 遭美国司法部反垄断起诉',                        // 诉讼
    'OpenAI 解散其 AGI Readiness 团队',                   // 解散
    '孙鹏加入字节跳动出任产品负责人',                      // 11-13 账本实证条目（离职/加入族）
    '某公司因数据违规被立案调查',                          // 强组合「立案调查」（11-14 review P2-②）
  ]
  for (const t of HIT) assert.equal(isExtraordinaryClaim({ claim: t }), true, JSON.stringify(t))
})

test('isExtraordinaryClaim：常规发布/性能/融资声明不命中（ext 预算不被常规新闻吃掉）', () => {
  const MISS = [
    'OpenAI 发布 GPT-6.2，在 SWE-Bench 上得分为 74.3%。',
    '微软把 Rust 提为一级语言',
    '谷歌宣布自 2026 年 10 月起调整 Gemini 用量限额',
    'Gboard 已用基于 TEE 的联邦学习系统训练英语与日语下一词预测模型',
    '该模型推理吞吐提升 30%',
    '调查显示 80% 开发者已在日常使用 AI 编码助手',         // 裸「调查」= survey 义，11-14 review P2-② 实证误报
    '一项针对 2000 名用户的调查发现付费意愿下降',           // 同上（问卷高频形态）
    '',                                        // 空串防御
  ]
  for (const t of MISS) assert.equal(isExtraordinaryClaim({ claim: t }), false, JSON.stringify(t))
  assert.equal(isExtraordinaryClaim(null), false, 'null 防御')
})
