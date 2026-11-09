/*!
 * dsh-feishu-digest v1.4.0
 * Copyright (c) 2026 dsh-feishu-digest contributors
 * Licensed under the MIT License. See LICENSE and NOTICE.
 *
 * The MIT License permits reuse, modification and redistribution of the code.
 * The project name and logo are brand identifiers; forks must not impersonate
 * the upstream project. See NOTICE for the brand-use statement.
 */

/**
 * dsh-feishu-digest —— DeepSeek Harness（DSH）任务结束飞书通知插件。
 *
 * 设计约束（详见 README）：
 * - 零第三方依赖：只使用 node: 内置模块（node:crypto）与全局 fetch。
 * - 只做单向通知：任务（turn）结束时，把结果以飞书「自定义机器人」文本消息推送到群。
 * - 默认发送本地抽取式摘要，可用 outputMode: full 发送完整输出。
 * - 绝不阻塞主流程：所有事件处理、网络请求都在 try/catch 内，且不 await 在 DSH 的主循环上。
 *
 * 事件来源（源码位置：@deepseek-ai/dsh-session/lib/types/types.d.ts 的 SessionEventMap）：
 *   'turn/start'        { turn }                       —— 回合开始
 *   'user/message'      UserMessage                    —— 人类 prompt / 注入上下文
 *   'assistant/message' { turn, step, message }        —— 该步的助手消息（取本回合最后一条非空文本）
 *   'turn/end'          { turn, reason: TurnEndReason } —— 回合结束（本插件的触发点）
 * 订阅入口：ctx.on('session/event', (session, event) => { ... })
 * 该事件在会话日志提交之后「即发即忘」地广播，观察者抛错会被 DSH 记录并隔离，不会回滚已提交的日志。
 */

import { createHash, createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 统一日志前缀，便于在 DSH 日志里过滤本插件。 */
const LOG_PREFIX = '[dsh-feishu-digest]'

/** 插件版本号（与 package.json 保持一致，仅用于日志）。 */
const VERSION = '1.4.0'

/** 默认请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 8000
/** 默认最大尝试次数（含首次）。R4：总共最多尝试 3 次。 */
const DEFAULT_RETRIES = 3
/** 默认单条消息正文截断上限（字符数）。R7。 */
const DEFAULT_MAX_CHARS = 8000
/** 默认输出模式：本地抽取式摘要；可选 full（完整输出）。 */
const DEFAULT_OUTPUT_MODE = 'summary'
/** 默认摘要长度上限（字符数）。 */
const DEFAULT_SUMMARY_MAX_CHARS = 400
/** 默认摘要最多保留几条“结果要点”。 */
const DEFAULT_SUMMARY_MAX_ITEMS = 6
/** 摘要中单条要点的最大长度（字符数）。 */
const DEFAULT_SUMMARY_ITEM_CHARS = 120
/** 指数退避的延迟上限，避免极大 attempts 时 setTimeout 溢出。 */
const MAX_RETRY_DELAY_MS = 30_000
/** 默认连续失败告警阈值。R5。 */
const DEFAULT_ALERT_THRESHOLD = 3
/** 默认告警冷却期：5 分钟。R5。 */
const DEFAULT_ALERT_COOLDOWN_MS = 5 * 60 * 1000
/** 指数退避的起始延迟（毫秒）。R4：500ms 起步 → 500、1000、2000… */
const DEFAULT_RETRY_BASE_DELAY_MS = 500
/** 飞书请求体的硬上限：20KB。R6。 */
const MAX_BODY_BYTES = 20 * 1024
/** 读取响应体时的内存上限，避免异常端点返回超大 body。 */
const MAX_RESPONSE_BYTES = 64 * 1024
/** 飞书限流错误码：HTTP 200 但 code=9499。 */
const FEISHU_RATE_LIMIT_CODE = 9499
/** 状态行与正文之间的分隔线。 */
const SEPARATOR = '─'.repeat(20)
/** 任务名最长取用户 prompt 的前多少字。R3。 */
const TITLE_MAX_CHARS = 80
/** 失败原因在状态行里的最大展示长度，避免把整段堆栈塞进群消息。 */
const REASON_MAX_CHARS = 160

// --- 通知精简管线 -----------------------------------------------------------
/** progress 类事件默认不推送。 */
const DEFAULT_DROP_PROGRESS = true
/** “结果里还有待办”的默认关键词。 */
const DEFAULT_TODO_KEYWORDS = ['必须', '需要你', '待办', '仍为空', '可以推翻', '建议', '剩余', '没动', '风险']
/** 一行型消息的字符上限。 */
const DEFAULT_ONE_LINE_MAX_CHARS = 80
/** 卡片正文的字符上限。 */
const DEFAULT_CARD_BODY_MAX_CHARS = 200
/** 一行型消息聚合窗口：30 分钟。 */
const DEFAULT_AGGREGATE_WINDOW_MS = 30 * 60 * 1000
/** 一行型消息聚合上限：5 条。 */
const DEFAULT_AGGREGATE_MAX_ITEMS = 5
/** LLM 压缩超时。 */
const DEFAULT_LLM_TIMEOUT_MS = 10_000
/** LLM 压缩输出上限。 */
const DEFAULT_LLM_MAX_TOKENS = 400
/** LLM 压缩失败后的重试次数。 */
const DEFAULT_LLM_RETRIES = 1
/** 归档目录默认放在用户目录下。 */
const DEFAULT_ARCHIVE_DIR = join(homedir(), '.dsh', 'feishu-digest', 'archive')

/**
 * 附录 A 的压缩提示词，原样嵌入；不要改写。
 * 反引号在模板字符串里转义，运行时的文本与附录一致。
 */
const LLM_DIGEST_PROMPT = `# 角色
你是飞书通知压缩器。输入是一段 Agent 任务报告，你从中抽取关键信息，输出一条精简通知的 JSON。

# 硬性规则
1. 只做抽取与概括，禁止编造原文没有的信息，禁止推测
2. 只输出严格 JSON，不要 markdown 代码块标记，不要任何解释文字
3. 某类内容不存在时输出空数组 []，不要硬凑
4. headline 不得重复项目名/任务名（卡片头部已展示）

# 输出格式
{"headline": "一句话结论，≤30字，含成功/失败状态",
 "artifacts": ["关键产物：commit号、链接、变更规模，每条≤30字"],
 "actions": ["需要用户亲自做的事，每条≤40字"],
 "risks": ["风险或需用户决策的事项，每条≤40字"]}

# 只保留以下四类
- 结果：成功 / 失败 / 部分完成
- 关键产物：commit、链接、变更文件数/行数
- 需用户行动：待填配置、待决策、待确认事项
- 风险与遗留

# 一律丢弃
- 实现细节、函数名/常量名/代码片段、改了哪几行
- 已完成事项的逐条明细
- 元信息：【自动摘要】标注、字符数、省略号截断痕迹、分隔线
- 过程叙述、礼貌语、自我说明

# 示例
输入：
P3 / P4 已全部修完并提交 \`2fe1810\`（工作区 clean）。
## P3（6 项）
- **D-01 死代码三处**：\`mismatch\`（恒 false）改为可达的 \`otherRecord\` 分支；
删 \`INVITE_SHARE_BACK\` / \`INVITE_SHARE_BACK_DESC\` / \`INVITE_MISMATCH_DESC\`；
\`loadPendingInvite\` 改为不导出的 \`readPendingInvite\`；\`CreateInviteResult\`…
## P4（8 项）
…
有两处我按「不是 bug」处理，如果你认为该算缺陷可以推翻：D-03（过期文档清理
是节流而非只删一条）和 D-07（产物已压缩，\`minified:false\` 无实际影响）。
… [自动摘要，原文 1900 字符]

输出：
{"headline":"P3×6、P4×8 已全部修复并提交",
 "artifacts":["commit 2fe1810，工作区 clean"],
 "actions":["如认为 D-03、D-07 应算缺陷，可提出推翻"],
 "risks":[]}`

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 生成 [dsh-feishu-digest] 前缀的日志器。
 *
 * 默认走 DSH 的 ctx.logger：cordis 的 LoggerService 只把消息投递给已注册的 exporter，
 * 插件侧不应该直接往 stdout/stderr 写（TUI 下会盖掉界面）。调试时设置
 * DSH_FEISHU_DEBUG=1，日志会**额外**镜像到控制台，方便在终端里确认加载与推送细节。
 *
 * @param {object} ctx cordis 上下文
 * @param {{ mirrorToConsole?: boolean }} [options]
 */
export function createLogger(ctx, options = {}) {
  const logger = ctx?.logger
  const mirror = options.mirrorToConsole ?? globalThis.process?.env?.DSH_FEISHU_DEBUG === '1'
  const write = (level, message) => {
    const text = `${LOG_PREFIX} ${message}`
    let delivered = false
    try {
      const target = logger?.[level]
      if (typeof target === 'function') {
        target.call(logger, text)
        delivered = true
      }
    } catch {
      /* 日志失败绝不影响主流程 */
    }
    // ctx.logger 不可用（或显式要求镜像）时才落到 console：保证日志不会丢，也不干扰 TUI。
    if (!delivered || mirror) {
      const fallback = level === 'debug' ? 'log' : level
      try {
        console[fallback](text)
      } catch {
        /* ignore */
      }
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => write('debug', message),
  }
}

/** 把任意抛出物转成一行可读文本。 */
export function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 按「字符（码点）」截断，避免把 emoji / 代理对劈成两半。 */
export function clipChars(text, maxChars) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const chars = Array.from(source)
  const limit = Math.max(0, Math.trunc(Number(maxChars) || 0))
  if (chars.length <= limit) return { text: chars.join(''), truncated: false, length: chars.length }
  return { text: chars.slice(0, limit).join(''), truncated: true, length: chars.length }
}

/** 按字符截断并补省略号，用于日志/告警里的短文本（不影响正文的 R6 截断标记）。 */
export function clipText(text, maxChars) {
  const clipped = clipChars(text, maxChars)
  return clipped.truncated ? `${clipped.text}…` : clipped.text
}

/** 从 llm 消息的 content 数组中抽取纯文本（只用 type === 'text' 的块）。 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 本地抽取式“结果摘要”（零依赖，不调用 LLM）。
 *
 * 目标不是复述全文，而是只传回结果：每段取“句头”（标题 + 首句/前几条结论），
 * 优先保留带数量、失败原因、未完成项的行；明确的“如何实现”行会被跳过。
 * 默认最多 6 条、单条最多 120 字、总长 400 字；需要更多细节时调大 summaryMaxChars。
 *
 * @param {string} text 原始输出
 * @param {{ maxChars?: number, maxItems?: number }} [options]
 * @returns {{ text: string, summarized: boolean, originalChars: number }}
 */
export function summarizeOutput(text, { maxChars = DEFAULT_SUMMARY_MAX_CHARS, maxItems = DEFAULT_SUMMARY_MAX_ITEMS } = {}) {
  const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : ''
  const originalChars = Array.from(source).length
  const limit = Math.max(0, Math.trunc(Number(maxChars) || 0))
  const itemLimit = Math.max(1, Math.trunc(Number(maxItems) || DEFAULT_SUMMARY_MAX_ITEMS))
  if (!source) return { text: '', summarized: false, originalChars: 0 }
  if (originalChars <= Math.min(limit, 80)) return { text: source, summarized: false, originalChars }

  const lines = source.split('\n')
  const outcomeRe = /(?:已(?:经)?(?:修复|修改|完成|更新|新增|删除|通过|处理|解决|合并|提交|发布|验证)|(?:修复|修改|新增|删除|完成|通过|失败|错误|异常|未完成|未修复|未验证|剩余|待办|待确认|无法|不支持)|P[0-4]|原因[:：]|(?:^|[^\d])\d+\s*(?:项|个|条|处|次))/i
  const failureRe = /(?:失败|错误|异常|未完成|未修复|未验证|剩余|待办|待确认|无法|不支持)/i
  const isFailure = (text) => {
    if (/失败\s*[0:：]?\s*0\s*(?:项|个|条|处|次)?/.test(text)) return false
    if (/(?:无|没有|零)\s*失败/.test(text)) return false
    return failureRe.test(text)
  }
  const genericHeadingRe = /^(?:说明|备注|附注|其他|背景|附录|参考)$/
  const howtoRe = /^(?:实现(?:方式|细节|思路|方案|步骤)|做法|方案|步骤|具体(?:做法|实现|方案|步骤)|代码|函数|方法|通过(?:修改|增加|使用|引入|调整|新增)|采用|首先|然后|接着|例如|比如)/
  const resultHeadingRe = /(?:结论|结果|总结|变更|验证|风险|下一步|待办|修复|测试|状态|交付|产出|问题|限制)/

  const cleanLine = (line) =>
    String(line ?? '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim()

  const firstSentence = (line) => {
    const clean = cleanLine(line)
    if (!clean) return ''
    const match = /^(.+?[。！？!?])(?=\s|$)/.exec(clean)
    return clipText(match ? match[1] : clean, DEFAULT_SUMMARY_ITEM_CHARS)
  }

  const headingOf = (line) => {
    const atx = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (atx) return cleanLine(atx[1])
    const bold = /^\*\*([^*]{1,60})\*\*[:：]?\s*$/.exec(line)
    if (bold) return cleanLine(bold[1])
    const colon = /^([^\s#*`]{1,40})[:：]\s*$/.exec(line)
    if (colon && !outcomeRe.test(colon[1])) return colon[1].trim()
    return ''
  }

  const sections = []
  const loose = []
  let current = null

  for (let index = 0; index < lines.length; index += 1) {
    const clean = lines[index].trim()
    if (!clean) continue
    if (/^```/.test(clean) || /^[-=_*]{3,}$/.test(clean)) continue

    const heading = headingOf(clean)
    if (heading) {
      current = { heading, index, items: [], seen: new Set(), total: 0 }
      sections.push(current)
      continue
    }

    const inlineLabel = /^(结论|结果|总结|变更|验证|风险|下一步|待办|状态|注意)[:：]\s*(.+)$/.exec(clean)
    if (inlineLabel) {
      loose.push({ text: firstSentence(clean), index, priority: isFailure(clean) ? 120 : 95 })
      continue
    }

    const sentence = firstSentence(clean)
    if (!sentence) continue
    const isHowto = howtoRe.test(clean) && !isFailure(clean)
    if (isHowto) continue

    if (current) current.total += 1

    if (current) {
      const key = sentence.slice(0, 60)
      if (!current.seen.has(key)) {
        current.seen.add(key)
        const important = isFailure(clean) || /(?:共|合计|总计)\s*\d+|\d+\s*(?:项|个|条|处|次)/.test(clean)
        current.items.push({ text: sentence, index, important })
      }
      continue
    }

    if (outcomeRe.test(clean) || sentence.length <= 80) {
      loose.push({ text: sentence, index, priority: isFailure(clean) ? 115 : outcomeRe.test(clean) ? 85 : 35 })
    }
  }

  const entries = []
  for (const section of sections) {
    const importantItems = section.items.filter((item) => item.important)
    const normalItems = section.items.filter((item) => !item.important)
    const pickedItems = importantItems.length > 0
      ? [...normalItems.slice(0, 2), ...importantItems.slice(0, 3)]
      : normalItems.slice(0, 3)
    pickedItems.sort((a, b) => a.index - b.index)
    const body = pickedItems.map((item) => item.text.replace(/[。！？!?]+$/u, '').trim()).join('；')
    const hay = `${section.heading} ${body}`
    const looksLikeHowto = genericHeadingRe.test(section.heading) ||
      ((howtoRe.test(section.heading) || /^具体(?:做法|实现|方案|步骤)/.test(body)) && !isFailure(hay))
    if (looksLikeHowto) continue
    const countHint = section.total > 3 && !/[（(]共\s*\d+\s*项/.test(section.heading) ? `（共 ${section.total} 项）` : ''
    const text = body ? `${section.heading}${countHint}：${body}。` : section.heading
    let priority = 40
    if (isFailure(hay)) priority = 120
    else if (outcomeRe.test(hay)) priority = 100
    else if (resultHeadingRe.test(section.heading)) priority = 90
    if (!body) priority = 15
    entries.push({ text: clipText(text, DEFAULT_SUMMARY_ITEM_CHARS), index: section.index, priority })
  }
  entries.push(...loose)

  const seen = new Set()
  const ranked = []
  for (const entry of entries.sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    const key = entry.text.replace(/\s+/g, '').slice(0, 60)
    if (!key || seen.has(key)) continue
    seen.add(key)
    ranked.push(entry)
  }

  const chosen = []
  let used = 0
  for (const entry of ranked) {
    if (chosen.length >= itemLimit) break
    if (entry.priority < 50 && chosen.length > 0) continue
    const separator = chosen.length > 0 ? 1 : 0
    const remaining = limit - used - separator
    if (remaining < 20) break
    const text = Array.from(entry.text).length > remaining ? clipText(entry.text, remaining) : entry.text
    const cost = Array.from(text).length + separator
    if (cost > remaining) continue
    chosen.push({ text, index: entry.index })
    used += cost
  }

  if (chosen.length === 0) {
    return { text: clipChars(source, limit).text, summarized: true, originalChars }
  }

  chosen.sort((a, b) => a.index - b.index)
  let output = chosen.map((item) => item.text).join('\n')
  if (Array.from(output).length > limit) output = clipChars(output, limit).text
  return { text: output, summarized: true, originalChars }
}

// ---------------------------------------------------------------------------
// 通知精简管线
// ---------------------------------------------------------------------------

/**
 * 去掉 agent 输出里的“摘要尾注”和截断痕迹。
 * 只做清洗，不改变业务语义；归档仍保存原文。
 */
export function cleanNoise(text) {
  let source = String(text ?? '')
  source = source.replace(/(?:\.{2,}|…)?\s*[\[【]\s*(?:自动摘要|已截断)[^\]】]*[\]】]/g, '')
  const lines = source.split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && /^[.．。…·\s]+$/.test(trimmed)) continue
    if (trimmed && /^[-=_*─—]{4,}$/.test(trimmed)) continue
    kept.push(line)
  }
  // 噪音行删掉后会留下空行；通知里不需要段落留白，统一压成单换行。
  return kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/** 兜底清洗：删噪音后只留前 8 个非空行，总长 300 字符。 */
export function fallbackClean(text) {
  const cleaned = cleanNoise(text)
  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim() !== '')
  const kept = lines.slice(0, 8).join('\n')
  return clipText(kept, 300)
}

/** 是否含待办关键词（大小写不敏感，支持字符串数组）。 */
export function hasTodoKeyword(text, keywords = DEFAULT_TODO_KEYWORDS) {
  const source = String(text ?? '')
  return keywords.some((keyword) => keyword && source.includes(keyword))
}

/** 成功回合里也可能有“某项失败/未修复”；这类结果不能压成一行。 */
function hasFailureSignal(text) {
  const source = String(text ?? '')
  if (/(?:失败\s*0|错误\s*0|异常\s*0|无失败|没有失败|零失败)/.test(source)) return false
  return /(?:失败|错误|异常|未修复|未完成|无法|阻塞)/.test(source)
}

/** 秒 → 一行型里的分钟展示。 */
function formatMinutes(seconds) {
  const value = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0
  return `${(value / 60).toFixed(1)} 分钟`
}

/** 生成一行型消息（≤ maxChars 字符）。 */
export function renderOneLine(event, maxChars = DEFAULT_ONE_LINE_MAX_CHARS) {
  const project = displayName(event?.project, '(未知项目)', 40)
  const conversation = displayName(event?.conversation, '(未命名对话)', 40)
  const task = displayName(event?.task, '(未命名任务)', 80)
  const icons = { success: '✅', failed: '❌', warning: '⏸️' }
  const labels = { success: '成功', failed: '失败', warning: '未完成' }
  const icon = icons[event?.status] || '✅'
  const label = labels[event?.status] || '成功'
  const suffix = ` —— ${label} ｜ ${project}·${conversation} ｜ ${formatMinutes(event?.duration_sec)}`
  const room = Math.max(4, maxChars - Array.from(suffix).length - 2)
  const line = `${icon} ${clipText(task, room)}${suffix}`
  const chars = Array.from(line)
  // clipText 的省略号会额外占 1 个字符；这里按硬上限重新裁，保证 ≤ maxChars。
  return chars.length <= maxChars ? line : `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/** 从正文里抽一个 commit 号（结构化字段缺失时的兜底）。 */
export function extractCommit(text) {
  const match = /(?:commit|提交)\s*[:：#]?\s*([0-9a-f]{7,40})\b/i.exec(String(text ?? ''))
  return match ? match[1] : ''
}

function stripLine(line) {
  return String(line ?? '')
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)、]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

function firstSentence(text, maxChars) {
  const source = String(text ?? '').trim()
  const match = /^(.+?[。！？!?])(?:\s|$)/.exec(source)
  return clipText((match ? match[1] : source).replace(/[。！？!?]$/, ''), maxChars)
}

/**
 * 本地兜底 Digest：不调用 LLM，按“结果 / 产物 / 需要你 / 风险”抽取。
 * 这是所有 LLM 失败路径的终点，也是失败卡片（详版）的来源。
 */
export function digestFromText(text) {
  const cleaned = cleanNoise(text)
  const lines = cleaned.split(/\r?\n/).map(stripLine).filter(Boolean)
  const resultRe = /(?:成功|失败|完成|修复|修完|修好|通过|未完成|部分完成|结论|结果|已提交|已合并|已全部)/i
  const riskRe = /(?:风险|遗留|失败|错误|异常|未完成|未修复|限制|不支持|阻塞|无法)/i
  const actionRe = /(?:需要你|待办|下一步|待确认|待决策|必须|请|剩余|仍为空|可以推翻|建议)/i
  const artifactRe = /(?:commit|提交|产物|链接|文件|变更|PR|https?:\/\/|版本|行数)/i

  const headlineLine = lines.find((line) => resultRe.test(line)) || lines[0] || '任务已结束'
  const headline = firstSentence(headlineLine.replace(/^(?:结论|结果|总结)[:：]\s*/, ''), 30)

  const artifacts = []
  const actions = []
  const risks = []
  for (const line of lines) {
    if (line === headlineLine) continue
    const item = firstSentence(line, 40)
    if (!item) continue
    if (riskRe.test(line)) {
      if (risks.length < 3 && !risks.includes(item)) risks.push(item)
    } else if (actionRe.test(line)) {
      if (actions.length < 3 && !actions.includes(item)) actions.push(item)
    } else if (artifactRe.test(line)) {
      if (artifacts.length < 3 && !artifacts.includes(item)) artifacts.push(item)
    }
  }
  return { headline, artifacts, actions, risks }
}

/** 渲染卡片的纯文本正文（≤ maxChars 字符）。 */
export function renderCardBody(digest, maxChars = DEFAULT_CARD_BODY_MAX_CHARS) {
  const lines = [`结论：${digest?.headline || '任务已结束'}`, '▸ 产物']
  const artifacts = Array.isArray(digest?.artifacts) ? digest.artifacts : []
  const actions = Array.isArray(digest?.actions) ? digest.actions : []
  const risks = Array.isArray(digest?.risks) ? digest.risks : []
  if (artifacts.length === 0) lines.push('· （无）')
  else for (const item of artifacts.slice(0, 3)) lines.push(`· ${item}`)

  lines.push('▸ 需要你')
  if (actions.length === 0) lines.push('· 无需操作')
  else for (const item of actions.slice(0, 3)) lines.push(`· ${item}`)

  if (risks.length > 0) {
    lines.push('▸ 风险')
    for (const item of risks.slice(0, 2)) lines.push(`· ${item}`)
  }
  return clipText(lines.join('\n'), maxChars)
}

/** 飞书互动卡片（msg_type=interactive 的 card 字段）。 */
export function buildCardMessage({ event, digest, color = 'blue', archiveUrl = '', maxChars = DEFAULT_CARD_BODY_MAX_CHARS }) {
  const icons = { success: '✅', failed: '❌', warning: '⏸️' }
  const icon = icons[event?.status] || '✅'
  const title = `${icon} ${clipText(displayName(event?.task, '(未命名任务)', 40), 40)}`
  const elements = []
  const project = displayName(event?.project, '(未知项目)', 40)
  const conversation = displayName(event?.conversation, '(未命名对话)', 40)
  // 保留 1.2 的三级名称：项目/对话作为卡片头部下方的元信息，任务名在 header。
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `项目：${project} ｜ 对话：${conversation}` }],
  })
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: renderCardBody(digest, maxChars) } })
  if (archiveUrl) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '查看原文' },
        type: 'default',
        url: archiveUrl,
      }],
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: title } },
    elements,
  }
}

/** 构造互动卡片请求体；签名与文本消息一致。 */
export function buildCardRequestBody(card, { secret, now = Date.now() } = {}) {
  const body = { msg_type: 'interactive', card }
  if (typeof secret === 'string' && secret.length > 0) {
    const timestamp = String(Math.floor(now / 1000))
    body.timestamp = timestamp
    body.sign = computeSign(timestamp, secret)
  }
  return body
}

/** 校验并裁剪 LLM 返回的 Digest；非法返回 null。 */
export function parseDigestJson(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const headline = typeof parsed.headline === 'string' ? clipText(parsed.headline, 30) : ''
  if (!headline) return null
  const cleanList = (value, maxChars) => (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => clipText(item.trim(), maxChars))
    .slice(0, 3)
  return {
    headline,
    artifacts: cleanList(parsed.artifacts, 30),
    actions: cleanList(parsed.actions, 40),
    risks: cleanList(parsed.risks, 40),
  }
}

/**
 * 调一次 DSH LLM 做压缩；超时/失败/JSON 非法都返回 null，由调用方走兜底。
 * 只有配置了 enabled + provider + model 且 ctx.llm 可用时才会真正发起请求。
 */
export async function callLlmDigest({ llm, config, body, log, signal } = {}) {
  if (!llm || typeof llm.stream !== 'function') return null
  if (config?.llmEnabled !== true || !config?.llmProvider || !config?.llmModel) return null

  const attempts = 1 + Math.max(0, Math.trunc(Number(config.llmRetries) || 0))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason ?? new Error('aborted'))
    signal?.addEventListener?.('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('llm timeout')), config.llmTimeoutMs)
    try {
      const stream = llm.stream({
        provider: config.llmProvider,
        model: config.llmModel,
        system: LLM_DIGEST_PROMPT,
        messages: [{
          id: `feishu-digest-${Date.now()}-${attempt}`,
          role: 'user',
          content: [{ type: 'text', text: String(body ?? '') }],
          source: { kind: 'user' },
        }],
        temperature: 0,
        maxTokens: config.llmMaxTokens,
        signal: controller.signal,
      })
      let raw = ''
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') raw += chunk.text
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message || 'llm error finish')
        }
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
          throw new Error(chunk.reason.failure?.message || 'llm aborted')
        }
      }
      const digest = parseDigestJson(raw)
      if (digest) return digest
      throw new Error('LLM 返回的不是合法 Digest JSON')
    } catch (error) {
      log?.warn?.(`LLM 压缩失败（第 ${attempt}/${attempts} 次）：${errorText(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', forward)
    }
  }
  return null
}

/** 归档：按 sha256(body) 前 8 位命名，`wx` 保证幂等。 */
export function createArchive({
  dir = DEFAULT_ARCHIVE_DIR,
  baseUrl = '',
  enabled = true,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
} = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  return {
    async save(body) {
      if (!enabled) return { id: '', url: '' }
      const text = String(body ?? '')
      const id = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
      await mkdirImpl(dir, { recursive: true })
      try {
        await writeFileImpl(join(dir, `${id}.md`), text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      return { id, url: base ? `${base}/${id}.md` : '' }
    },
  }
}

/** 一行型消息聚合器：窗口到期或满 maxItems 时 flush。 */
export function createAggregator({
  windowMs = DEFAULT_AGGREGATE_WINDOW_MS,
  maxItems = DEFAULT_AGGREGATE_MAX_ITEMS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFlush = async () => {},
} = {}) {
  const buffers = new Map()
  const flush = async (key) => {
    const buffer = buffers.get(key)
    if (!buffer) return
    buffers.delete(key)
    if (buffer.timer) clearTimer(buffer.timer)
    if (buffer.items.length > 0) await onFlush(buffer.items.slice())
  }
  const add = async (key, item) => {
    let buffer = buffers.get(key)
    if (!buffer) {
      buffer = { items: [], timer: undefined, createdAt: now() }
      buffers.set(key, buffer)
    }
    buffer.items.push(item)
    if (buffer.items.length >= maxItems) {
      await flush(key)
      return
    }
    if (!buffer.timer) {
      buffer.timer = setTimer(() => { void flush(key) }, windowMs)
      buffer.timer?.unref?.()
    }
  }
  return {
    add,
    flush,
    flushAll: async () => {
      for (const key of [...buffers.keys()]) await flush(key)
    },
    pending: (key) => buffers.get(key)?.items.length ?? 0,
    size: () => buffers.size,
  }
}

/** 纯规则路由：drop / line / card。 */
export function routeNotifyEvent(event, config = {}) {
  if (event?.type === 'error' || event?.status === 'failed') {
    return { action: 'card', color: 'red', useLlm: false }
  }
  if (event?.status === 'warning') {
    return { action: 'card', color: 'orange', useLlm: false }
  }
  if (event?.type === 'progress' && config.dropProgress !== false) {
    return { action: 'drop' }
  }
  if (hasTodoKeyword(event?.body, config.todoKeywords) || hasFailureSignal(event?.body)) {
    return { action: 'card', color: 'blue', useLlm: true }
  }
  return { action: 'line' }
}

/**
 * 统一通知管线：路由 → 一行聚合 / 卡片渲染 → 归档 → 发送。
 * 任何一步失败都尽量降级为一行型，绝不静默丢消息。
 */
export function createNotifyPipeline({
  config,
  log,
  send,
  archive = createArchive({ enabled: config.archiveEnabled, dir: config.archiveDir, baseUrl: config.archiveBaseUrl }),
  llm,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  signal,
} = {}) {
  const keyOf = (event) => `${event?.project ?? ''}\u0000${event?.conversation ?? ''}`

  const saveArchive = async (body) => {
    try {
      return await archive.save(body)
    } catch (error) {
      log?.warn?.(`归档失败，本次不附「查看原文」：${errorText(error)}`)
      return { id: '', url: '' }
    }
  }

  const sendSummary = async (items) => {
    // 汇总卡只列任务名；完整一行型太长，5 条会把 200 字上限撑爆。
    const body = clipText(
      items.map((item, index) => `${index + 1}. ${displayName(item.event.task, '(未命名任务)', 30)}`).join('\n'),
      config.cardBodyMaxChars,
    )
    const combined = items.map((item) => `## ${item.event.task}\n${item.event.body}`).join('\n\n---\n\n')
    const archived = await saveArchive(combined)
    const first = items[0]?.event ?? {}
    const project = displayName(first.project, '(未知项目)', 40)
    const conversation = displayName(first.conversation, '(未命名对话)', 40)
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: `📦 ${items.length} 个任务完成` } },
      elements: [
        { tag: 'note', elements: [{ tag: 'plain_text', content: `项目：${project} ｜ 对话：${conversation}` }] },
        { tag: 'div', text: { tag: 'lark_md', content: body } },
      ],
    }
    if (archived.url) {
      card.elements.push({
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看原文' }, type: 'default', url: archived.url }],
      })
    }
    try {
      await send({ card })
    } catch (error) {
      // 汇总卡失败时退回逐条一行型，至少不丢消息。
      log?.warn?.(`汇总卡发送失败，降级为一行型：${errorText(error)}`)
      for (const item of items) {
        try {
          await send({ text: item.line })
        } catch (fallbackError) {
          log?.error?.(`一行型兜底也发送失败：${errorText(fallbackError)}`)
        }
      }
    }
  }

  const aggregator = createAggregator({
    windowMs: config.aggregateWindowMs,
    maxItems: config.aggregateMaxItems,
    now,
    setTimer,
    clearTimer,
    onFlush: sendSummary,
  })

  const sendCard = async (event, color, useLlm) => {
    const cleaned = cleanNoise(event.body)
    let digest = useLlm ? await callLlmDigest({ llm, config, body: cleaned, log, signal }) : null
    if (!digest) digest = digestFromText(cleaned)
    const sha = event.commit || extractCommit(cleaned)
    if (sha) {
      const rest = digest.artifacts.filter((item) => !/[0-9a-f]{7,40}/i.test(item))
      digest.artifacts = [`commit ${sha}`, ...rest].slice(0, 3)
    }
    const archived = await saveArchive(event.body)
    const card = buildCardMessage({ event, digest, color, archiveUrl: archived.url, maxChars: config.cardBodyMaxChars })
    try {
      await send({ card })
    } catch (error) {
      log?.warn?.(`卡片发送失败，降级为一行文本：${errorText(error)}`)
      try {
        await send({ text: renderOneLine(event, config.oneLineMaxChars) })
      } catch (fallbackError) {
        log?.error?.(`一行文本兜底也发送失败：${errorText(fallbackError)}`)
      }
    }
  }

  return {
    async handle(event) {
      const route = routeNotifyEvent(event, config)
      if (route.action === 'drop') return
      const key = keyOf(event)
      if (route.action === 'line') {
        await aggregator.add(key, { event, line: renderOneLine(event, config.oneLineMaxChars) })
        return
      }
      // 卡片型不缓冲：先把同组的未发一行型汇总掉，再发当前卡片。
      await aggregator.flush(key)
      await sendCard(event, route.color, route.useLlm)
    },
    flushAll: () => aggregator.flushAll(),
    pending: (event) => aggregator.pending(keyOf(event)),
  }
}

/** 毫秒 → 「12.3 秒」（保留 1 位小数）。R3。 */
export function formatDuration(ms) {
  const value = Number.isFinite(ms) && ms >= 0 ? ms : 0
  return `${(value / 1000).toFixed(1)} 秒`
}

/**
 * 结束时间格式化为 zh-CN 习惯，并带本地时区偏移：2026/11/6 01:23:45（UTC+8）。R3。
 * 无效日期返回固定文案，避免把 NaN 发到群里。
 */
export function formatEndedAt(date) {
  const value = date instanceof Date ? date : new Date(date)
  if (!Number.isFinite(value.getTime())) return '未知时间'
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const offsetHours = Math.trunc(absolute / 60)
  const offsetRest = absolute % 60
  const zone = `UTC${sign}${offsetHours}${offsetRest ? `:${pad(offsetRest)}` : ''}`
  return `${value.getFullYear()}/${value.getMonth() + 1}/${value.getDate()} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}（${zone}）`
}

/** 打码 webhook：只保留协议、主机和路径前 12 个字符，去掉 userinfo/query/hash。 */
export function maskUrl(url) {
  const text = String(url ?? '')
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[invalid webhook]'
    const path = parsed.pathname || '/'
    return `${parsed.protocol}//${parsed.host}${path.slice(0, 12)}…`
  } catch {
    return '[invalid webhook]'
  }
}

/** 本地回环地址允许 http，方便本地 mock / 内网调试；其余一律要求 https。 */
function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

/**
 * 用 URL 解析器校验 webhook 地址，比正则更严格（会拒绝空格、缺主机等）。
 * 生产环境只接受 https；http 仅限 localhost/127.0.0.1/::1，避免 token 明文上网。
 */
function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    if (!parsed.hostname) return false
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 中和飞书文本消息里的 @ 标签，避免 Agent 输出中的 `<at user_id="all">`
 * 被飞书解释成 @全体成员。用全角小于号替换，保留可读性但不构成标签。
 */
export function sanitizeMentions(text) {
  return String(text ?? '').replace(/<(\/?at\b)/gi, '＜$1')
}

/** 把名称压成单行并限制长度；空值用 fallback。 */
function displayName(value, fallback, maxChars = TITLE_MAX_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  const clipped = clipChars(sanitizeMentions(text), maxChars)
  return clipped.truncated ? `${clipped.text}…` : clipped.text
}

/** 取第一个“非空”的值；空字符串和空数组视为未配置，便于回退到环境变量。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    return value
  }
  return undefined
}

/** 把 webhook 统一成去重后的字符串数组；非法项放进 invalid，供日志打码提示。 */
function normalizeWebhookList(raw, invalid) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const result = []
  for (const item of list) {
    if (typeof item !== 'string') {
      invalid.push(String(item))
      continue
    }
    const url = item.trim()
    if (!url) continue
    if (!isHttpUrl(url)) {
      invalid.push(url)
      continue
    }
    if (!result.includes(url)) result.push(url)
  }
  return result
}

// ---------------------------------------------------------------------------
// 状态映射：TurnEndReason → 图标 / 文案
// ---------------------------------------------------------------------------

/**
 * 把 turn/end 的 reason 映射成推送用的状态。
 * 源码：@deepseek-ai/dsh-session/lib/types/types.d.ts 的 TurnEndReasonMap
 * 规则（R3）：成功 ✅ / 失败 ❌ / 其他 ⏸️。
 */
export function describeTurnEnd(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
  switch (kind) {
    case 'completed':
      return { kind, icon: '✅', label: '任务完成', status: '成功', detail: '' }
    case 'error':
      return { kind, icon: '❌', label: '任务失败', status: '失败', detail: clipText(errorText(reason?.error?.message), REASON_MAX_CHARS) }
    case 'aborted': {
      const cause = reason?.reason
      const causeText =
        cause?.kind === 'hook' ? `hook：${clipText(errorText(cause?.reason), 60)}` : cause?.kind === 'user' ? '用户取消' : cause?.kind === 'parent' ? '父会话取消' : cause?.kind === 'disposed' ? '会话被释放' : '已取消'
      return { kind, icon: '⏸️', label: '任务已取消', status: '已取消', detail: causeText }
    }
    case 'blocked':
      return { kind, icon: '⏸️', label: '任务被阻塞', status: '已阻塞', detail: '' }
    case 'max-tokens':
      return { kind, icon: '⏸️', label: '任务达到长度上限', status: '已达上限', detail: '' }
    case 'interrupted':
      return { kind, icon: '⏸️', label: '任务被中断', status: '已中断', detail: '' }
    default:
      return { kind, icon: '⏸️', label: '任务结束', status: kind, detail: '' }
  }
}

// ---------------------------------------------------------------------------
// 消息组装（R3）与截断（R6）
// ---------------------------------------------------------------------------

/**
 * 组装消息头：状态 → 项目 → 对话 → 任务名 → 状态/耗时/结束时间 → 分隔线。
 * 项目/对话/任务三级名称由调用方解析；直接调用时用占位符兜底。
 */
export function buildHeader({ icon, label, projectName, conversationName, title, status, detail, durationMs, endedAt }) {
  const statusLine = sanitizeMentions(detail ? `${status}（${detail}）` : status)
  return [
    `${icon} ${label}`,
    `项目：${displayName(projectName, '(未知项目)')}`,
    `对话：${displayName(conversationName, '(未命名对话)')}`,
    `任务名：${displayName(title, '(未命名任务)')}`,
    `状态：${statusLine}`,
    `耗时：${formatDuration(durationMs)}`,
    `结束时间：${formatEndedAt(endedAt)}`,
    SEPARATOR,
  ].join('\n')
}

/**
 * 截断标记文案。
 * R6 要求「... [已截断，原长 N 字符]」，N 是**原始**字符数，不是截断后的长度。
 */
export function truncationNotice(originalChars) {
  return `\n\n... [已截断，原长 ${originalChars} 字符]`
}

/**
 * 计算「请求体字节数」。
 * 签名开启时飞书要求 body 顶层多两个字段（timestamp 10 位、sign 44 位 base64），
 * 这里用等长占位符测量，保证真实请求体也落在 20KB 以内。
 */
export function requestBodyBytes(text, hasSecret) {
  const body = { msg_type: 'text', content: { text } }
  if (hasSecret) {
    body.timestamp = '0000000000'
    body.sign = 'A'.repeat(44)
  }
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}

/**
 * 组装最终文本。
 * - summary（默认）：先做本地抽取式摘要，再按 maxChars / 20KB 收缩。
 * - full：保留原有的 maxChars 截断与 20KB 二次收缩。
 * 返回可直接写进 content.text 的字符串。
 */
export function composeMessageText({
  icon,
  label,
  projectName,
  conversationName,
  title,
  status,
  detail = '',
  durationMs,
  endedAt,
  output,
  maxChars = DEFAULT_MAX_CHARS,
  hasSecret = false,
  limitBytes = MAX_BODY_BYTES,
  outputMode = DEFAULT_OUTPUT_MODE,
  summaryMaxChars = DEFAULT_SUMMARY_MAX_CHARS,
}) {
  const rawOutput = typeof output === 'string' && output.trim().length > 0 ? output : '(本回合没有文本输出)'
  const originalChars = Array.from(rawOutput).length
  const header = buildHeader({ icon, label, projectName, conversationName, title, status, detail, durationMs, endedAt })

  let body
  let notice = ''
  if (outputMode === 'full') {
    // 完整模式：保留原有的字符上限截断。
    const firstPass = clipChars(rawOutput, Math.max(0, maxChars))
    body = firstPass.text
    if (firstPass.truncated) notice = truncationNotice(originalChars)
  } else {
    // 摘要模式：摘要本身也受 maxChars 约束，避免 maxChars 很小时摘要反而更长。
    const summaryLimit = Math.max(0, Math.min(maxChars, summaryMaxChars))
    const summary = summarizeOutput(rawOutput, { maxChars: summaryLimit })
    body = summary.text || (summaryLimit > 0 ? '(本回合没有文本输出)' : '')
    if (summary.summarized) notice = `\n\n... [自动摘要，原文 ${summary.originalChars} 字符]`
  }

  // 正文里的 `<at ...>` 不能原样交给飞书，否则可能被解释成 @全体。
  const safeBody = sanitizeMentions(body)
  let candidate = safeBody + notice
  const render = (text) => `${header}\n${text}`
  if (requestBodyBytes(render(candidate), hasSecret) <= limitBytes) return render(candidate)

  // 请求体硬上限 20KB（R6）：用二分查找出「还能放下多少字符」。
  const shrinkNotice = notice || truncationNotice(originalChars)
  const chars = Array.from(safeBody)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const text = chars.slice(0, mid).join('') + shrinkNotice
    if (requestBodyBytes(render(text), hasSecret) <= limitBytes) low = mid
    else high = mid - 1
  }
  return render(chars.slice(0, low).join('') + shrinkNotice)
}

// ---------------------------------------------------------------------------
// 飞书签名（R2 / 技术细节）
// ---------------------------------------------------------------------------

/**
 * 计算飞书自定义机器人的签名。
 *
 * 飞书规则：以 `${timestamp}\n${secret}` 作为 HMAC-SHA256 的 key，
 * 对**空字符串**做 digest，再 base64。
 * 注意 key 是「时间戳 + 换行 + 密钥」这个字符串本身，而不是 secret。
 *
 * @param {string|number} timestamp 秒级时间戳
 * @param {string} secret 机器人签名密钥
 * @returns {string} base64 签名
 */
export function computeSign(timestamp, secret) {
  const key = `${timestamp}\n${secret}`
  return createHmac('sha256', Buffer.from(key, 'utf8')).update('').digest('base64')
}

/** 组装飞书文本消息请求体（msg_type=text），签名开启时附加 timestamp / sign。 */
export function buildRequestBody(text, { secret, now = Date.now() } = {}) {
  const body = { msg_type: 'text', content: { text } }
  if (secret) {
    const timestamp = String(Math.floor(now / 1000))
    body.timestamp = timestamp
    body.sign = computeSign(timestamp, secret)
  }
  return body
}

// ---------------------------------------------------------------------------
// 发送与重试（R4）
// ---------------------------------------------------------------------------

/** 可被中断的 sleep：插件卸载时立刻结束等待。 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 读取响应文本，最多保留 limit 字节。
 * 优先用流式读取，避免异常端点返回超大 body 时把内存打满；
 * 没有 ReadableStream 的实现（测试里的假 Response）退回 response.text()。
 */
export async function readResponseText(response, limit = MAX_RESPONSE_BYTES) {
  const maxBytes = Math.max(0, Math.trunc(Number(limit) || 0))
  const body = response?.body
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text()
    return typeof text === 'string' ? text.slice(0, maxBytes) : ''
  }

  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = Buffer.from(value)
      const remaining = maxBytes - total
      if (remaining <= 0) {
        await reader.cancel().catch(() => {})
        break
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        total = maxBytes
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(chunk)
      total += chunk.length
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** 解析 Retry-After（秒数或 HTTP 日期），返回毫秒；无法解析返回 0。 */
function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000)
  const date = Date.parse(String(raw))
  if (!Number.isFinite(date)) return 0
  return Math.max(0, date - Date.now())
}

/**
 * 发一次请求，并**解析响应体**判定成败（R4 的关键点）。
 *
 * 飞书常见坑：HTTP 200 但 body 里 code !== 0（例如签名错误 19021、限流 9499），
 * 只看 HTTP 状态码会把失败当成功。
 *
 * 返回值：
 *   ok        是否成功（HTTP 200 且 code === 0）
 *   retryable 是否值得重试（网络错误 / 超时 / HTTP 429 / HTTP 5xx / 飞书 9499 限流）
 *   detail    失败原因（写日志与告警用）
 */
export async function postOnce({ url, text, card, secret, timeoutMs = DEFAULT_TIMEOUT_MS, signal, fetchImpl = globalThis.fetch } = {}) {
  // 插件已卸载 / 调用方已取消：不再发起新请求。
  if (signal?.aborted) return { ok: false, retryable: false, status: undefined, code: undefined, detail: '已中止：请求未发送' }

  const body = card ? buildCardRequestBody(card, { secret }) : buildRequestBody(text, { secret })
  const payload = JSON.stringify(body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onOuterAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  signal?.addEventListener?.('abort', onOuterAbort, { once: true })

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    })
    const rawText = await readResponseText(response)
    const status = response.status
    const retryAfter = retryAfterMs(response.headers)

    // HTTP 层失败：只有 429 与 5xx 值得重试，其余 4xx 直接判失败（R4）。
    if (!response.ok) {
      const retryable = status === 429 || status >= 500
      return {
        ok: false,
        retryable,
        status,
        code: undefined,
        retryAfterMs: retryable ? retryAfter : 0,
        detail: `HTTP ${status}${rawText ? ` ${clipText(rawText, 200)}` : ''}`,
      }
    }

    // HTTP 200：必须解析 body 的 code 字段（R4）。
    let parsed
    try {
      parsed = JSON.parse(rawText)
    } catch {
      return { ok: false, retryable: false, status, code: undefined, detail: `HTTP 200 但响应不是 JSON：${clipText(rawText, 160)}` }
    }
    const code = parsed?.code
    if (code === 0) return { ok: true, retryable: false, status, code, detail: 'ok' }
    const message = parsed?.msg ?? parsed?.message ?? rawText
    const retryable = code === FEISHU_RATE_LIMIT_CODE
    return {
      ok: false,
      retryable,
      status,
      code,
      retryAfterMs: retryable ? retryAfter : 0,
      detail: `飞书返回 code=${String(code)} ${clipText(String(message ?? ''), 160)}${retryable ? '（限流，可重试）' : ''}`,
    }
  } catch (error) {
    // fetch 的 TypeError 可能带完整 URL（含 webhook token），日志/告警里必须先打码。
    const rawReason = errorText(error)
    const safeReason = typeof url === 'string' && url ? rawReason.split(url).join(maskUrl(url)) : rawReason
    // 插件卸载触发的中断：不再重试。
    if (signal?.aborted) return { ok: false, retryable: false, status: undefined, code: undefined, detail: `已中止：${safeReason}` }
    // 内层 controller 被超时定时器中止：保留“超时”语义，不要退化成泛化的网络错误。
    if (controller.signal.aborted) {
      return { ok: false, retryable: true, status: undefined, code: undefined, detail: `请求超时（${timeoutMs}ms）` }
    }
    // 网络层异常（DNS、连接重置等）：可重试。
    return { ok: false, retryable: true, status: undefined, code: undefined, detail: `网络错误：${safeReason}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onOuterAbort)
  }
}

/**
 * 带指数退避的重试（R4）。
 * 只有 retryable 的失败才重试；延迟为 base * 2^(attempt-1)：500ms、1000ms…
 * attempts 语义 = 总尝试次数（默认 3）。
 */
export async function sendWithRetry({ url, text, card, secret, timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_RETRIES, retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS, signal, log, fetchImpl, sleepImpl = sleep } = {}) {
  if (signal?.aborted) return { ok: false, retryable: false, detail: '已中止：请求未发送', attempts: 0 }

  const total = Math.max(1, Math.trunc(Number(attempts) || DEFAULT_RETRIES))
  let result = { ok: false, retryable: false, detail: '未发送' }
  let tried = 0

  for (let attempt = 1; attempt <= total; attempt += 1) {
    tried = attempt
    result = await postOnce({ url, text, card, secret, timeoutMs, signal, fetchImpl })
    if (result.ok) {
      log?.info?.(`推送成功（第 ${attempt}/${total} 次）→ ${maskUrl(url)}`)
      return { ...result, attempts: attempt }
    }

    const willRetry = result.retryable && attempt < total && !signal?.aborted
    log?.warn?.(`推送失败（第 ${attempt}/${total} 次）→ ${maskUrl(url)}：${result.detail}${willRetry ? '，准备退避重试' : '，不再重试'}`)
    if (!willRetry) break

    // 优先尊重服务端 Retry-After；没有时用指数退避，并统一封顶。
    const backoff = retryBaseDelayMs * 2 ** (attempt - 1)
    const serverDelay = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 0
    const delay = Math.min(Math.max(backoff, serverDelay), MAX_RETRY_DELAY_MS)
    log?.info?.(`${delay}ms 后重试…`)
    await sleepImpl(delay, signal)
    if (signal?.aborted) break
  }

  return { ...result, ok: false, attempts: tried }
}

// ---------------------------------------------------------------------------
// 连续失败告警（R5）
// ---------------------------------------------------------------------------

/**
 * 连续失败计数器 + 告警冷却。
 * 每个 webhook 独立计数（多人各自配置自己的群时互不影响），
 * 冷却期内不重复告警，告警发送成功后清零（R5）。
 */
export function createFailureTracker({ threshold = DEFAULT_ALERT_THRESHOLD, cooldownMs = DEFAULT_ALERT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  const states = new Map()

  const stateOf = (key) => {
    let state = states.get(key)
    if (!state) {
      state = { consecutive: 0, lastAlertAt: 0, lastReason: '' }
      states.set(key, state)
    }
    return state
  }

  return {
    /** 记录一次推送失败；返回此刻是否应该发告警。 */
    recordFailure(key, reason) {
      const state = stateOf(key)
      state.consecutive += 1
      state.lastReason = clipText(String(reason ?? ''), REASON_MAX_CHARS)
      const cooledDown = now() - state.lastAlertAt >= cooldownMs
      return { shouldAlert: state.consecutive >= threshold && cooledDown, consecutive: state.consecutive, reason: state.lastReason }
    },
    /** 记录一次推送成功：打断连续失败计数。 */
    recordSuccess(key) {
      const state = stateOf(key)
      state.consecutive = 0
      state.lastReason = ''
    },
    /** 告警发送成功后调用：重置连续失败计数并开始新的冷却期。 */
    recordAlertSent(key) {
      const state = stateOf(key)
      state.consecutive = 0
      state.lastAlertAt = now()
    },
    /**
     * 告警发送失败后调用：同样进入冷却期。
     * 否则告警通道本身故障时，每个回合都会重新触发一轮告警重试。
     */
    recordAlertFailed(key) {
      const state = stateOf(key)
      state.consecutive = 0
      state.lastAlertAt = now()
    },
    /** 读取当前状态（测试/日志用）。 */
    inspect(key) {
      const state = stateOf(key)
      return { ...state }
    },
  }
}

/** 组装告警文案（R5：标题「⚠️ DSH 推送告警」+ 最新失败原因）。 */
export function buildAlertText({ consecutive, reason, url, endedAt = new Date() } = {}) {
  return [
    '⚠️ DSH 推送告警',
    `已连续失败 ${String(consecutive ?? 0)} 次`,
    `最新失败原因：${clipText(String(reason ?? '未知'), REASON_MAX_CHARS)}`,
    `webhook：${maskUrl(url)}`,
    `时间：${formatEndedAt(endedAt)}`,
    '请检查飞书机器人是否被移除、签名密钥是否正确、或群是否触发限流。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 配置（R7 / R8 / R9）
// ---------------------------------------------------------------------------

/** 默认配置；所有项都可以通过插件 config 或环境变量覆盖。 */
export function defaultConfig() {
  return {
    webhooks: [],
    alertWebhooks: [],
    secret: '',
    alertSecret: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    maxChars: DEFAULT_MAX_CHARS,
    outputMode: DEFAULT_OUTPUT_MODE,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    alertThreshold: DEFAULT_ALERT_THRESHOLD,
    alertCooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
    retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    includeSubagents: false,
    dropProgress: DEFAULT_DROP_PROGRESS,
    todoKeywords: DEFAULT_TODO_KEYWORDS.slice(),
    oneLineMaxChars: DEFAULT_ONE_LINE_MAX_CHARS,
    cardBodyMaxChars: DEFAULT_CARD_BODY_MAX_CHARS,
    aggregateWindowMs: DEFAULT_AGGREGATE_WINDOW_MS,
    aggregateMaxItems: DEFAULT_AGGREGATE_MAX_ITEMS,
    archiveEnabled: true,
    archiveDir: DEFAULT_ARCHIVE_DIR,
    archiveBaseUrl: '',
    llmEnabled: false,
    llmProvider: '',
    llmModel: '',
    llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    llmMaxTokens: DEFAULT_LLM_MAX_TOKENS,
    llmRetries: DEFAULT_LLM_RETRIES,
  }
}

/** 读取环境变量兜底（R7）：优先 DSH_FEISHU_*，其次 FEISHU_*。 */
export function readEnv(env = globalThis.process?.env ?? {}) {
  const pick = (...names) => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }
  return {
    webhook: pick('DSH_FEISHU_WEBHOOK', 'FEISHU_WEBHOOK', 'FEISHU_BOT_WEBHOOK'),
    alertWebhook: pick('DSH_FEISHU_ALERT_WEBHOOK', 'FEISHU_ALERT_WEBHOOK'),
    secret: pick('DSH_FEISHU_SECRET', 'FEISHU_WEBHOOK_SECRET', 'FEISHU_BOT_SECRET'),
    alertSecret: pick('DSH_FEISHU_ALERT_SECRET', 'FEISHU_ALERT_SECRET'),
  }
}

/** 取数字配置，非法值回落到默认值。 */
function numberOr(value, fallback, { min = 0 } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

/**
 * 归一化配置：合并默认值、插件 config、环境变量，并把 webhook 统一成数组（R8）。
 * 注意：这里的 webhook/secret 只来自用户配置或环境变量，代码里不存在任何真实 token。
 */
export function normalizeConfig(rawConfig = {}, env = globalThis.process?.env ?? {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const defaults = defaultConfig()
  const fromEnv = readEnv(env)

  // webhook 接受「字符串」或「字符串数组」（R8），也可用 webhooks 作为别名。
  // 空字符串/空数组视为未配置，继续回退到环境变量。
  const invalidWebhooks = []
  const rawWebhooks = firstNonEmpty(config.webhook, config.webhooks, fromEnv.webhook)
  const webhooks = normalizeWebhookList(rawWebhooks, invalidWebhooks)

  // 告警通道独立配置；未配置时在 apply 里回退到业务 webhook。
  const invalidAlertWebhooks = []
  const rawAlertWebhooks = firstNonEmpty(config.alertWebhook, config.alertWebhooks, fromEnv.alertWebhook)
  const alertWebhooks = normalizeWebhookList(rawAlertWebhooks, invalidAlertWebhooks)

  const secretRaw = config.secret ?? fromEnv.secret
  // 告警机器人可以有自己的签名密钥；没有则复用业务密钥。
  const alertSecretRaw = firstNonEmpty(config.alertSecret, fromEnv.alertSecret, secretRaw)

  const keywordsRaw = config.todoKeywords ?? config.todo_keywords
  const keywordList = Array.isArray(keywordsRaw)
    ? keywordsRaw
    : typeof keywordsRaw === 'string'
      ? keywordsRaw.split(/[|,，\n]/)
      : defaults.todoKeywords
  const todoKeywords = [...new Set(keywordList.map((item) => String(item).trim()).filter(Boolean))]
  const archiveBaseUrl = typeof config.archiveBaseUrl === 'string' ? config.archiveBaseUrl.trim().replace(/\/+$/, '') : ''
  const archiveDir = typeof config.archiveDir === 'string' && config.archiveDir.trim() ? config.archiveDir.trim() : defaults.archiveDir

  return {
    ...defaults,
    webhooks,
    invalidWebhooks,
    alertWebhooks,
    invalidAlertWebhooks,
    secret: typeof secretRaw === 'string' ? secretRaw.trim() : '',
    alertSecret: typeof alertSecretRaw === 'string' ? alertSecretRaw.trim() : '',
    timeoutMs: numberOr(config.timeoutMs ?? config.timeout, defaults.timeoutMs, { min: 1 }),
    retries: Math.max(1, Math.trunc(numberOr(config.retries ?? config.attempts, defaults.retries, { min: 1 }))),
    maxChars: Math.max(0, Math.trunc(numberOr(config.maxChars ?? config.truncateAt, defaults.maxChars, { min: 0 }))),
    outputMode: config.outputMode === 'full' ? 'full' : DEFAULT_OUTPUT_MODE,
    summaryMaxChars: Math.max(80, Math.trunc(numberOr(config.summaryMaxChars, defaults.summaryMaxChars, { min: 80 }))),
    alertThreshold: Math.max(1, Math.trunc(numberOr(config.alertThreshold, defaults.alertThreshold, { min: 1 }))),
    alertCooldownMs: numberOr(config.alertCooldownMs ?? config.alertCooldown, defaults.alertCooldownMs, { min: 0 }),
    retryBaseDelayMs: numberOr(config.retryBaseDelayMs, defaults.retryBaseDelayMs, { min: 0 }),
    includeSubagents: config.includeSubagents === true,
    dropProgress: (config.dropProgress ?? config.drop_progress) !== false,
    todoKeywords: todoKeywords.length > 0 ? todoKeywords : defaults.todoKeywords,
    oneLineMaxChars: Math.min(200, Math.max(40, Math.trunc(numberOr(config.oneLineMaxChars, defaults.oneLineMaxChars, { min: 40 })))),
    cardBodyMaxChars: Math.min(500, Math.max(80, Math.trunc(numberOr(config.cardBodyMaxChars, defaults.cardBodyMaxChars, { min: 80 })))),
    aggregateWindowMs: Math.max(1, Math.trunc(numberOr(config.aggregateWindowMs, defaults.aggregateWindowMs, { min: 1 }))),
    aggregateMaxItems: Math.max(1, Math.trunc(numberOr(config.aggregateMaxItems, defaults.aggregateMaxItems, { min: 1 }))),
    archiveEnabled: config.archiveEnabled !== false,
    archiveDir,
    archiveBaseUrl,
    llmEnabled: config.llmEnabled === true,
    llmProvider: typeof config.llmProvider === 'string' ? config.llmProvider.trim() : '',
    llmModel: typeof config.llmModel === 'string' ? config.llmModel.trim() : '',
    llmTimeoutMs: Math.max(100, Math.trunc(numberOr(config.llmTimeoutMs, defaults.llmTimeoutMs, { min: 100 }))),
    llmMaxTokens: Math.min(2000, Math.max(50, Math.trunc(numberOr(config.llmMaxTokens, defaults.llmMaxTokens, { min: 50 })))),
    llmRetries: Math.min(3, Math.max(0, Math.trunc(numberOr(config.llmRetries, defaults.llmRetries, { min: 0 })))),
  }
}

/**
 * cordis 的 Config 校验器（Standard Schema 形状）。
 * DSH 在挂载插件前调用 runtime.Config['~standard'].validate(config)，
 * 校验失败会抛 `invalid config: ...` 并让这一行插件加载失败。
 *
 * 刻意保持宽松：webhook 缺失**不是**错误（R9 要求未配置时插件仍能正常加载）。
 * 只有类型明显写错（比如 webhook 是个对象）才会报 issue，
 * 让用户尽早发现自己写错了，而不是静默不推送。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-feishu-digest',
    validate(value) {
      const issues = []
      const config = value ?? {}
      if (typeof config !== 'object' || Array.isArray(config)) {
        return { issues: [{ message: 'config 必须是一个对象', path: [] }] }
      }
      const webhook = config.webhook ?? config.webhooks
      if (webhook !== undefined && webhook !== null) {
        const ok = typeof webhook === 'string' || (Array.isArray(webhook) && webhook.every((item) => typeof item === 'string'))
        if (!ok) issues.push({ message: 'webhook 必须是字符串或字符串数组', path: ['webhook'] })
      }
      const alertWebhook = config.alertWebhook ?? config.alertWebhooks
      if (alertWebhook !== undefined && alertWebhook !== null) {
        const ok = typeof alertWebhook === 'string' || (Array.isArray(alertWebhook) && alertWebhook.every((item) => typeof item === 'string'))
        if (!ok) issues.push({ message: 'alertWebhook 必须是字符串或字符串数组', path: ['alertWebhook'] })
      }
      if (config.secret !== undefined && config.secret !== null && typeof config.secret !== 'string') {
        issues.push({ message: 'secret 必须是字符串', path: ['secret'] })
      }
      if (config.alertSecret !== undefined && config.alertSecret !== null && typeof config.alertSecret !== 'string') {
        issues.push({ message: 'alertSecret 必须是字符串', path: ['alertSecret'] })
      }
      if (config.outputMode !== undefined && config.outputMode !== null && config.outputMode !== 'summary' && config.outputMode !== 'full') {
        issues.push({ message: 'outputMode 只能是 summary 或 full', path: ['outputMode'] })
      }
      if (config.includeSubagents !== undefined && config.includeSubagents !== null && typeof config.includeSubagents !== 'boolean') {
        issues.push({ message: 'includeSubagents 必须是布尔值', path: ['includeSubagents'] })
      }
      for (const key of ['dropProgress', 'archiveEnabled', 'llmEnabled']) {
        if (config[key] !== undefined && config[key] !== null && typeof config[key] !== 'boolean') {
          issues.push({ message: `${key} 必须是布尔值`, path: [key] })
        }
      }
      for (const key of ['llmProvider', 'llmModel', 'archiveDir', 'archiveBaseUrl']) {
        if (config[key] !== undefined && config[key] !== null && typeof config[key] !== 'string') {
          issues.push({ message: `${key} 必须是字符串`, path: [key] })
        }
      }
      const keywords = config.todoKeywords ?? config.todo_keywords
      if (keywords !== undefined && keywords !== null) {
        const ok = typeof keywords === 'string' || (Array.isArray(keywords) && keywords.every((item) => typeof item === 'string'))
        if (!ok) issues.push({ message: 'todoKeywords 必须是字符串或字符串数组', path: ['todoKeywords'] })
      }
      const numericRules = {
        timeoutMs: { min: 1, integer: true },
        retries: { min: 1, integer: true },
        maxChars: { min: 0, integer: true },
        summaryMaxChars: { min: 80, integer: true },
        alertThreshold: { min: 1, integer: true },
        alertCooldownMs: { min: 0, integer: false },
        retryBaseDelayMs: { min: 0, integer: false },
        oneLineMaxChars: { min: 40, integer: true },
        cardBodyMaxChars: { min: 80, integer: true },
        aggregateWindowMs: { min: 1, integer: true },
        aggregateMaxItems: { min: 1, integer: true },
        llmTimeoutMs: { min: 100, integer: true },
        llmMaxTokens: { min: 50, integer: true },
        llmRetries: { min: 0, integer: true },
      }
      for (const [key, rule] of Object.entries(numericRules)) {
        const item = config[key]
        if (item === undefined || item === null) continue
        const numeric = typeof item === 'number' ? item : Number(item)
        if (!Number.isFinite(numeric)) {
          issues.push({ message: `${key} 必须是数字`, path: [key] })
          continue
        }
        if (numeric < rule.min) issues.push({ message: `${key} 不能小于 ${rule.min}`, path: [key] })
        if (rule.integer && !Number.isInteger(numeric)) issues.push({ message: `${key} 必须是整数`, path: [key] })
      }
      if (issues.length > 0) return { issues }
      return { value: config }
    },
  },
}

// ---------------------------------------------------------------------------
// 会话状态与事件处理
// ---------------------------------------------------------------------------

/** 每个会话的滚动状态：本回合开始时间、本回合首条人类 prompt、最后一条助手文本。 */
function createSessionState() {
  return {
    turnStarts: new Map(),
    turnFirstUserText: new Map(),
    currentTurn: undefined,
    pendingUserText: '',
    lastAssistantText: '',
    lastUserText: '',
  }
}

/** 判断是否子代理会话（默认跳过，避免一次任务刷出多条推送）。 */
function isSubagentSession(session) {
  try {
    const header = session?.header
    if (!header) return false
    return header.origin === 'subagent' || Boolean(header.parentSession) || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  } catch {
    return false
  }
}

/**
 * 项目名：取会话 cwd 的目录名。
 * 例如 `C:\Users\me\Desktop\demo` → `demo`；根目录/空值回退 `(未知项目)`。
 */
export function resolveProjectName(session) {
  try {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') return '(未知项目)'
    const trimmed = cwd.trim().replace(/[\\/]+$/, '')
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed === '/' || /^[A-Za-z]:$/.test(trimmed)) {
      return '(未知项目)'
    }
    const base = trimmed.split(/[\\/]/).pop()
    return displayName(base, '(未知项目)')
  } catch {
    return '(未知项目)'
  }
}

/**
 * `session/title` 的 source.kind 为 fallback 时，标题只是首条人类 prompt 的截断，
 * 不是对话的总名称；只有 user（用户重命名）或 provider（模型生成）才算真正的对话标题。
 * 缺失 source 的旧日志按“可用”处理，避免老版本 DSH 上退化成占位符。
 */
function isConversationTitleSource(source) {
  return !source || source.kind !== 'fallback'
}

/**
 * 对话名：取会话日志中**最新**一条真正的 session/title，而不是首条 prompt 或本回合任务名。
 * 对话贯穿多个回合，标题可能被用户重命名或由标题服务刷新；日志是最终事实来源。
 * 日志不可读时退回 dsh-session-title 的快照；两者都没有才回退占位符。
 */
export function resolveConversationName(sessionTitleService, session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'session/title') continue
      if (!isConversationTitleSource(event.data?.source)) continue
      const title = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
      if (title) return displayName(title, '(未命名对话)')
    }
  } catch {
    /* 日志不可读时退回服务快照 */
  }
  try {
    const snapshot = sessionTitleService?.get?.(session)
    if (isConversationTitleSource(snapshot?.source)) {
      const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
      if (title) return displayName(title, '(未命名对话)')
    }
  } catch {
    /* 标题服务不可用时忽略 */
  }
  return '(未命名对话)'
}

/** 任务名：本回合首条人类 prompt（或最后一条用户文本）前 80 字。 */
export function resolveTaskName(fallbackText) {
  return displayName(fallbackText, '(未命名任务)')
}

/**
 * 创建事件处理逻辑（与 apply 分离，便于单测直接调用）。
 * 返回 handle(session, event) 和若干内部状态钩子。
 */
export function createTurnListener({ ctx, config, log, deliver, now = () => Date.now() }) {
  const states = new WeakMap()
  const seen = new Set()
  const sentOrder = []

  const stateOf = (session) => {
    let state = states.get(session)
    if (!state) {
      state = createSessionState()
      states.set(session, state)
    }
    return state
  }

  /** 去重：同一会话同一回合只推送一次（导入/重放日志时可能出现重复事件）。 */
  const firstTime = (session, turn) => {
    const key = `${String(session?.id ?? '?')}:${String(turn)}`
    if (seen.has(key)) return false
    seen.add(key)
    sentOrder.push(key)
    if (sentOrder.length > 500) {
      const oldest = sentOrder.shift()
      seen.delete(oldest)
    }
    return true
  }

  const handle = (session, event) => {
    if (!session || !event || typeof event.type !== 'string') return
    const state = stateOf(session)
    const time = typeof event.time === 'number' ? event.time : now()

    switch (event.type) {
      case 'turn/start': {
        const turn = event.data?.turn
        state.currentTurn = turn
        state.turnStarts.set(turn, time)
        // 如果 user/message 先于 turn/start 到达，把它归入刚开的这个回合。
        if (state.pendingUserText) {
          if (!state.turnFirstUserText.has(turn)) state.turnFirstUserText.set(turn, state.pendingUserText)
          state.pendingUserText = ''
        }
        // 新回合开始：清掉上一回合的助手输出与用户文本，避免串到本回合。
        state.lastAssistantText = ''
        state.lastUserText = ''
        break
      }
      case 'user/message': {
        const message = event.data
        if (!message || message.role !== 'user') break
        // source.kind === 'user' 才是真人 prompt；plugin/inject 的上下文不算任务名。
        if (message.source?.kind !== 'user') break
        const text = contentText(message.content)
        if (!text) break
        state.lastUserText = text
        // 只记录本回合首条人类 prompt；没有 currentTurn 时先暂存，等 turn/start 认领。
        if (state.currentTurn === undefined) state.pendingUserText = text
        else if (!state.turnFirstUserText.has(state.currentTurn)) state.turnFirstUserText.set(state.currentTurn, text)
        break
      }
      case 'assistant/message': {
        const text = contentText(event.data?.message?.content)
        if (text) state.lastAssistantText = text
        break
      }
      case 'turn/end': {
        const turn = event.data?.turn
        if (!firstTime(session, turn)) {
          log?.debug?.(`忽略重复的 turn/end（session=${String(session.id)} turn=${String(turn)}）`)
          break
        }
        // 无论是否跳过子代理，都清理本回合的临时状态，避免 Map 无限增长。
        const turnFirstUserText = state.turnFirstUserText.get(turn)
        state.turnFirstUserText.delete(turn)
        const startedAt = state.turnStarts.get(turn)
        state.turnStarts.delete(turn)
        if (state.currentTurn === turn) state.currentTurn = undefined

        if (!config.includeSubagents && isSubagentSession(session)) {
          log?.debug?.(`跳过子代理会话（session=${String(session.id)}）`)
          break
        }

        const durationMs = typeof startedAt === 'number' ? Math.max(0, time - startedAt) : 0
        const status = describeTurnEnd(event.data?.reason)
        const sessionTitleService = safeService(ctx, 'sessionTitle')
        const projectName = resolveProjectName(session)
        const conversationName = resolveConversationName(sessionTitleService, session)
        // 任务名只看本回合首条人类 prompt；只有本回合没有 prompt 时才退回最后一条用户文本。
        const taskName = resolveTaskName(turnFirstUserText || state.lastUserText)

        const notifyEvent = {
          type: status.kind === 'error' ? 'error' : 'finish',
          project: projectName,
          conversation: conversationName,
          task: taskName,
          status: status.kind === 'completed' ? 'success' : status.kind === 'error' ? 'failed' : 'warning',
          duration_sec: durationMs / 1000,
          ended_at: new Date(time).toISOString(),
          body: state.lastAssistantText,
          // 兼容旧调用方/测试：title 仍是任务名。
          title: taskName,
          session,
          turn,
        }

        // 任务名可能包含用户 prompt，日志只记录 session/turn 与耗时，不打印标题。
        log?.info?.(`检测到任务结束：${status.icon} ${status.label}（session=${String(session.id)} turn=${String(turn)} 耗时=${formatDuration(durationMs)}）`)
        // 不 await：turn/end 是即发即忘的广播，推送失败也只记日志（R9）。
        deliver(notifyEvent).catch((error) => {
          log?.error?.(`推送流程异常：${errorText(error)}`)
        })
        break
      }
      default:
        break
    }
  }

  return { handle, states, isSubagentSession }
}

/** 安全读取可选服务：缺失或未就绪时返回 undefined，而不是抛错。 */
function safeService(ctx, name) {
  try {
    return ctx?.get?.(name, false) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 每个 key 一条串行队列：同一 webhook 的推送按到达顺序执行，不同 webhook 互不阻塞。
 * task 失败不会卡住后续任务；队列尾指针在任务结束后清理，避免 Map 无限增长。
 */
export function createSerialQueue() {
  const tails = new Map()
  return {
    run(key, task) {
      const previous = tails.get(key) ?? Promise.resolve()
      const current = previous.then(task, task)
      tails.set(key, current)
      const cleanup = () => {
        if (tails.get(key) === current) tails.delete(key)
      }
      current.then(cleanup, cleanup)
      return current
    },
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 插件入口：cordis 会以 apply(ctx, config) 调用（源码：@deepseek-ai/cordis/lib/index.js 的 Fiber#execute）。
 * config 来自 cordis.patch.yml 里该行的 config:，已通过 Config 校验。
 */
export function apply(ctx, rawConfig) {
  const log = createLogger(ctx)

  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    log.error(`配置解析失败，插件以空配置运行：${errorText(error)}`)
    config = defaultConfig()
  }

  // R9：未配置 webhook 时必须正常加载，只打印 warning 并跳过推送。
  if (config.webhooks.length === 0) {
    log.warn('未配置 webhook（config.webhook 或环境变量 DSH_FEISHU_WEBHOOK），插件已加载但不会推送消息')
    log.info(`loaded v${VERSION}（disabled：no webhook）`)
    return
  }

  if (config.invalidWebhooks.length > 0) {
    const masked = config.invalidWebhooks.map((url, index) => `#${index + 1} ${maskUrl(url)}`).join('、')
    log.warn(`已忽略 ${config.invalidWebhooks.length} 个非法 webhook（必须是 http(s) URL）：${masked}`)
  }
  if (config.invalidAlertWebhooks.length > 0) {
    const masked = config.invalidAlertWebhooks.map((url, index) => `#${index + 1} ${maskUrl(url)}`).join('、')
    log.warn(`已忽略 ${config.invalidAlertWebhooks.length} 个非法告警 webhook（必须是 http(s) URL）：${masked}`)
  }

  const alertLabel = config.alertWebhooks.length > 0 ? `${config.alertWebhooks.length} 个独立通道` : '同业务 webhook'
  log.info(
    `loaded v${VERSION}（webhook=${config.webhooks.length} 个，告警=${alertLabel}，签名=${config.secret ? '开启' : '关闭'}，管线=${config.llmEnabled ? 'LLM' : '本地'}，超时=${config.timeoutMs}ms，最多尝试=${config.retries} 次）`,
  )

  // 插件卸载时中断所有在途请求，避免残留重试。
  const controller = new AbortController()
  try {
    ctx?.effect?.(() => () => {
      // 先把聚合中的一行型消息尽量冲出去，再中断在途请求。
      Promise.resolve(pipeline?.flushAll?.()).catch(() => {})
      controller.abort(new Error('plugin disposed'))
    }, 'dsh-feishu-digest.dispose()')
  } catch {
    /* effect 不可用时忽略，最坏情况是卸载后仍有请求在飞 */
  }

  const tracker = createFailureTracker({ threshold: config.alertThreshold, cooldownMs: config.alertCooldownMs })
  // 同一 webhook 串行发送，避免多个回合并发时消息乱序、或瞬间打爆群机器人限流。
  const queue = createSerialQueue()

  /** 往单个 webhook 推送消息（text 或 interactive card）；失败时按 R5 触发告警。 */
  const pushTo = async (url, message) => {
    const text = typeof message === 'string' ? message : message?.text
    const card = typeof message === 'object' ? message?.card : undefined
    const result = await sendWithRetry({
      url,
      text,
      card,
      secret: config.secret,
      timeoutMs: config.timeoutMs,
      attempts: config.retries,
      retryBaseDelayMs: config.retryBaseDelayMs,
      signal: controller.signal,
      log,
    })

    if (result.ok) {
      tracker.recordSuccess(url)
      return result
    }

    log.error(`推送最终失败（共尝试 ${result.attempts} 次）→ ${maskUrl(url)}：${result.detail}`)

    // R5：连续失败达到阈值且冷却期已过 → 发一条告警。
    const failure = tracker.recordFailure(url, result.detail)
    if (!failure.shouldAlert) return result

    const alertText = buildAlertText({ consecutive: failure.consecutive, reason: failure.reason, url })
    // 告警优先走独立通道；没有独立通道时才回退到刚失败的业务 webhook。
    const alertTargets = config.alertWebhooks.length > 0 ? config.alertWebhooks : [url]
    log.warn(`连续失败 ${failure.consecutive} 次，发送推送告警 → ${alertTargets.map(maskUrl).join('、')}`)

    let alertSent = false
    for (const target of alertTargets) {
      try {
        const alertResult = await sendWithRetry({
          url: target,
          text: alertText,
          secret: config.alertSecret || config.secret,
          timeoutMs: config.timeoutMs,
          attempts: config.retries,
          retryBaseDelayMs: config.retryBaseDelayMs,
          signal: controller.signal,
          log,
        })
        if (alertResult.ok) {
          alertSent = true
          log.info(`告警已发送 → ${maskUrl(target)}`)
        } else {
          log.error(`告警消息发送失败 → ${maskUrl(target)}：${alertResult.detail}`)
        }
      } catch (error) {
        log.error(`告警消息发送异常 → ${maskUrl(target)}：${errorText(error)}`)
      }
    }

    // 告警成功或失败都进入冷却期：否则告警通道本身故障时，每个回合都会重试一轮。
    if (alertSent) tracker.recordAlertSent(url)
    else tracker.recordAlertFailed(url)
    return result
  }

  /** 统一出口：同一逻辑消息按顺序发到每个 webhook（R8：数组时逐个发送）。 */
  const send = async (message) => {
    let delivered = false
    for (const url of config.webhooks) {
      try {
        const result = await queue.run(url, () => pushTo(url, message))
        if (result?.ok) delivered = true
      } catch (error) {
        // 单个 webhook 出错不影响其余 webhook。
        log.error(`webhook 处理异常 → ${maskUrl(url)}：${errorText(error)}`)
      }
    }
    // 让管线知道整条消息是否真的送达：卡片失败时才有机会降级为一行型文本。
    if (!delivered) throw new Error('所有 webhook 均发送失败')
  }

  const llm = safeService(ctx, 'llm')
  const pipeline = createNotifyPipeline({
    config,
    log,
    send,
    llm,
    signal: controller.signal,
  })

  const deliver = async (event) => {
    await pipeline.handle(event)
  }

  const listener = createTurnListener({ ctx, config, log, deliver })

  try {
    ctx.on('session/event', (session, event) => {
      // R9：任何异常都必须在本插件内消化，绝不影响 DSH 主任务流程。
      try {
        listener.handle(session, event)
      } catch (error) {
        log.error(`处理 session/event 失败：${errorText(error)}`)
      }
    })
  } catch (error) {
    log.error(`订阅 session/event 失败：${errorText(error)}`)
  }
}

/** cordis 插件对象：name 用于日志，inject 声明依赖的 session 服务。 */
const plugin = {
  name: 'dsh-feishu-digest',
  // 等 ctx.sessions 就绪后再加载；sessionTitle 是可选服务，用 ctx.get 安全读取。
  inject: ['sessions'],
  Config,
  apply,
}

export { apply as default_apply, VERSION }
export default plugin
