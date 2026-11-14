// claim-gate — 声明质量门（纯函数，realm 安全：无 process/fs/Date.now/fetch/WebSocket）。
//
// 10-04 日报质量审计实证（docs/2026-10-04-claim-quality-gate-design.md §1）：论坛附件标注被
// 提取为可证伪声明（"image 580×286 7.97 KB"）→ 通过 2-0 核查投票 → 写入生产账本；连带把
// Antigravity Opus 5.5 发布（两帖印证的当日最大模型新闻）挤出正文。本模块在 allClaims 汇合点
// （fetch 提取与 linuxdo mint 双路）单点拦截：垃圾声明不进 verify、不进正文、不进账本。
//
// 设计原则（宁漏勿滥）：模式表只收"机械可识别"形态；漏网的语义垃圾由 needsVerification 挡在
// verify 之外（最多落 unverified 池，永不可能 confirmed）；再漏的靠 fetch prompt 提取卫生规则
// 减少发生——三层防御，危害上限被 substance 门封顶（设计 §4/§5）。

// 确定性垃圾模式（全部锚定实证形态；正则即文档，测试用当日真实垃圾原文做 fixture。
// 尺寸分隔符收 [×xX]——提取器可能产出 ASCII x（image 580x286），10-04 复审 Suggestion-3）
// 11-13 实证补齐（Discourse 附件名前缀 image 常被省略，直接是文件名开头）：
//   'IMG_0610 1293×1056 127 KB' / '77d5…f6a4 1320×1735 179 KB'——既有 ① 假设 'image ' 前缀
//   必在，论坛 mint 路的附件标注没这个前缀 → 漏网进 unverified 池污染待核实小节。
// 11-14 复审收紧：哈希名必含 a-f 字母（MD5/SHA1 全数字概率≈0），模式禁 /i 且要求
//   至少一个字母——16+ 位纯数字开头（大数量级/精度位数）与大写 hex 词开头的真声明不误杀。
const JUNK_RES = [
  /^image\s+\d+[×xX]\d+/i,                                 // 附件尺寸标注开头（image 580×286 7.97 KB）
  /^\d+(\.\d+)?\s*(KB|MB|GB)\b/i,                      // 纯大小串开头
  /(^|\s)image\s+\d+[×xX]\d+\s+\d+(\.\d+)?\s*(KB|MB)\b/i,  // 内嵌附件标注（"如图： image 487×438 13.4 KB …"）
  /^如图[：:，,]?\s*(image|$)/i,                        // 「如图」图片说明碎片——收窄到紧跟附件标注或到此为止，
                                                       // 防误杀「如图 3 所示，营收增长 30%」（设计 §5；「如图所示」
                                                       // 11-14 独立成模式，见下）
  // ── 11-13：裸文件名开头的附件标注（无 'image ' 前缀形态），后跟评论残片不影响判定
  //   （'IMG_4628 1290×621 108 KB 不会真的是…'——文件名开头即机械可识别）──
  /^IMG_?\d{3,}\b/i,                                      // IMG_0610 1293×1056 127 KB（开头即文件名）
  /^(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/,                   // 77d5d7ae… 哈希文件名开头（hex 串内必含 a-f 字母，见上）
  /^[A-Za-z0-9_.\- ]{1,64}\.(jpe?g|png|gif|webp|avif)\b/i,  // image.png 类文件名直出（含带空格名）
  // ── 11-14 实证补齐（当日 unverified 池 2 条漏网新形态）──
  /^Screenshot_\d{8,}/i,                                  // 安卓时间戳截图名直出（Screenshot_20261113-010506_Gemini~1）
  /^[A-Za-z0-9_]{6,} \d{3,5}[×xX]\d{3,5} \d+(\.\d+)? (KB|MB)\b/i,
                                                          // 社媒媒体 ID + 宽高 + 大小（HW9GgJ_WcAA9m3I 2048×1162 171 KB
                                                          // ——Twitter/X 原图标注，ID 含大写字母，哈希模式管不到）
  /^如图所示[，,]?[\s\S]*(?:Screenshot_\d{8,}|\.(?:jpe?g|png|gif|webp|avif)\b|\d{3,5}[×xX]\d{3,5}\s+\d+(?:\.\d+)?\s*(?:KB|MB)\b)/i,
                                                          // 「如图所示」口语开头 + 附件标注证据（截图名/扩展名/宽高+大小）
                                                          // ——无证据的真实声明（如图所示，推理吞吐提升 30%）不误杀
]

/** 垃圾声明判定：过短（<8 字符，不可证伪）或命中任一垃圾模式。
 *  11-13 追加：附件文件名开头（无 'image ' 前缀形态）即机械可识别，尾部文字是评论残片
 *  不影响判定（'IMG_4628 1290×621 108 KB 不会真的是…'——见 JUNK_RES 11-13 段注释）。 */
export const isJunkClaim = c => {
  const t = (c && typeof c.claim === 'string') ? c.claim.trim() : ''
  if (t.length < 8) return true
  if (JUNK_RES.some(re => re.test(t))) return true
  // URL 转发残片：以链接开头、去掉链接后剩余文字 < 12 字符（如 "https://… The Times"）——
  // 可证伪声明需要文字陈述事实，链接后只剩几个词属转发残片（10-04 实证 #5）
  if (/^https?:\/\/\S+/.test(t) && t.replace(/^https?:\/\/\S+\s*/, '').length < 12) return true
  return false
}

/** verify substance 门：无数字、无拉丁实体、CJK 不足一句的声明不值得 2-3 张核查票——
 *  不丢数据（落 unverified 池照常渲染），只不进 rankedClaims（核查预算留给真声明）。 */
export const needsVerification = c => {
  const t = (c && typeof c.claim === 'string') ? c.claim : ''
  return /\d/.test(t) || /[A-Za-z]{2,}/.test(t) || (t.match(/[\u4e00-\u9fff]/g) || []).length >= 10
}

/** 批量分账：clean/dropped 两桶，对象引用原样透传（不改写不复制）。 */
export const gateClaims = claims => {
  const clean = []
  const dropped = []
  for (const c of claims || []) (isJunkClaim(c) ? dropped : clean).push(c)
  return { clean, dropped }
}
