import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  buildCardMessage,
  buildCardRequestBody,
  cleanNoise,
  createAggregator,
  createArchive,
  createNotifyPipeline,
  digestFromText,
  extractCommit,
  fallbackClean,
  hasTodoKeyword,
  normalizeConfig,
  parseDigestJson,
  renderCardBody,
  renderOneLine,
  routeNotifyEvent,
} from '../index.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function event(overrides = {}) {
  return {
    type: 'finish',
    project: '任务完成飞书传回',
    conversation: '审计并修复',
    task: '修复登录接口的空指针',
    status: 'success',
    duration_sec: 180,
    ended_at: '2026-11-09T04:00:00.000Z',
    body: '结论：登录接口空指针已修复，测试全部通过。',
    ...overrides,
  }
}

const fakeArchive = { save: async () => ({ id: 'abcd1234', url: '' }) }

async function main() {
  console.log('[1/6] 清洗与兜底')

  check('删除自动摘要尾注、省略号行和长分隔线', () => {
    const text = [
      '结论：登录接口空指针已修复。',
      '... [自动摘要，原文 1900 字符]',
      '----------',
      '…',
      '验证：npm test 全部通过。',
    ].join('\n')
    const cleaned = cleanNoise(text)
    assert.equal(cleaned, '结论：登录接口空指针已修复。\n验证：npm test 全部通过。')
    assert.ok(!cleaned.includes('自动摘要'))
  })

  check('兜底清洗只留前 8 个非空行、总长不超过 300', () => {
    const source = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：这是一段很长的实现细节说明，用来测试兜底截断。`).join('\n')
    const cleaned = fallbackClean(source)
    assert.equal(cleaned.split('\n').length, 8)
    assert.ok(Array.from(cleaned).length <= 300)
    assert.ok(!cleaned.includes('自动摘要'))
  })

  check('一行型不超过 80 字且含任务、项目、对话', () => {
    const line = renderOneLine(event({ task: '修复登录接口的空指针'.repeat(5) }))
    assert.ok(Array.from(line).length <= 80, `实际 ${Array.from(line).length} 字：${line}`)
    assert.ok(line.startsWith('✅'))
    assert.ok(line.includes('任务完成飞书传回'))
    assert.ok(line.includes('审计并修复'))
  })

  check('待办关键词命中与未命中', () => {
    assert.equal(hasTodoKeyword('需要你确认配置'), true)
    assert.equal(hasTodoKeyword('全部完成，无风险'), true)
    assert.equal(hasTodoKeyword('全部完成'), false)
  })

  console.log('\n[2/6] Digest 与卡片')

  check('本地 Digest 保留结论、产物、行动与风险', () => {
    const digest = digestFromText([
      '结论：P3/P4 已全部修复并提交。',
      'commit 2fe1810，工作区 clean。',
      '需要你确认是否推翻 D-03。',
      '风险：代理环境不支持。',
    ].join('\n'))
    assert.match(digest.headline, /P3\/P4/)
    assert.ok(digest.artifacts.some((item) => item.includes('2fe1810')))
    assert.ok(digest.actions.some((item) => item.includes('需要你')))
    assert.ok(digest.risks.some((item) => item.includes('风险')))
  })

  check('卡片正文按结论 → 产物 → 需要你 → 风险排列且不超过 200 字', () => {
    const body = renderCardBody({
      headline: 'P3×6、P4×8 已全部修复并提交',
      artifacts: ['commit 2fe1810，工作区 clean'],
      actions: [],
      risks: [],
    })
    assert.ok(body.indexOf('结论：') < body.indexOf('▸ 产物'))
    assert.ok(body.indexOf('▸ 产物') < body.indexOf('▸ 需要你'))
    assert.ok(body.includes('无需操作'))
    assert.ok(!body.includes('▸ 风险'))
    assert.ok(Array.from(body).length <= 200)
  })

  check('卡片含「查看原文」按钮，正文不含自动摘要尾注', () => {
    const card = buildCardMessage({
      event: event(),
      digest: { headline: '已修复', artifacts: [], actions: [], risks: [] },
      color: 'blue',
      archiveUrl: 'https://example.com/archive/abcd1234.md',
    })
    const action = card.elements.find((item) => item.tag === 'action')
    assert.equal(action.actions[0].text.content, '查看原文')
    assert.equal(action.actions[0].url, 'https://example.com/archive/abcd1234.md')
    assert.ok(!card.elements.find((item) => item.tag === 'div').text.content.includes('自动摘要'))
  })

  check('卡片请求体支持签名', () => {
    const card = buildCardMessage({ event: event(), digest: { headline: '完成', artifacts: [], actions: [], risks: [] } })
    const body = buildCardRequestBody(card, { secret: 'secret', now: 1_700_000_000_000 })
    assert.equal(body.msg_type, 'interactive')
    assert.equal(body.timestamp, '1700000000')
    assert.equal(body.sign.length, 44)
  })

  check('LLM 返回的 JSON 能被校验和裁剪', () => {
    const digest = parseDigestJson('```json\n{"headline":"完成","artifacts":["a"],"actions":[],"risks":["r"]}\n```')
    assert.equal(digest.headline, '完成')
    assert.deepEqual(digest.artifacts, ['a'])
    assert.deepEqual(digest.risks, ['r'])
    assert.equal(parseDigestJson('not json'), null)
  })

  check('commit 提取支持 commit/提交前缀', () => {
    assert.equal(extractCommit('已提交：2fe1810'), '2fe1810')
    assert.equal(extractCommit('no commit here'), '')
  })

  console.log('\n[3/6] 规则路由')

  check('progress 默认丢弃，finish 永不丢弃', () => {
    assert.equal(routeNotifyEvent(event({ type: 'progress' })).action, 'drop')
    assert.notEqual(routeNotifyEvent(event({ type: 'finish' })).action, 'drop')
  })

  check('error/failed 走红色卡片，warning 走橙色卡片', () => {
    assert.deepEqual(routeNotifyEvent(event({ status: 'failed' })), { action: 'card', color: 'red', useLlm: false })
    assert.deepEqual(routeNotifyEvent(event({ type: 'error' })), { action: 'card', color: 'red', useLlm: false })
    assert.deepEqual(routeNotifyEvent(event({ status: 'warning' })), { action: 'card', color: 'orange', useLlm: false })
  })

  check('success 无待办走一行，有待办/失败项走蓝色 LLM 卡片', () => {
    assert.equal(routeNotifyEvent(event({ body: '全部完成。' })).action, 'line')
    assert.deepEqual(routeNotifyEvent(event({ body: '需要你确认配置。' })), { action: 'card', color: 'blue', useLlm: true })
    assert.deepEqual(routeNotifyEvent(event({ body: 'P3 已修复；P4-2 修复失败，原因：上游 500。' })), { action: 'card', color: 'blue', useLlm: true })
    assert.equal(routeNotifyEvent(event({ body: '测试通过；失败 0 项。' })).action, 'line')
  })

  console.log('\n[4/6] 聚合与归档')

  check('聚合满 5 条立即 flush，未满按窗口 flush', async () => {
    const flushes = []
    let timer = null
    const aggregator = createAggregator({
      windowMs: 30_000,
      maxItems: 5,
      setTimer: (fn) => { timer = fn; return { unref() {} } },
      clearTimer: () => { timer = null },
      onFlush: async (items) => { flushes.push(items.map((item) => item.line)) },
    })
    for (let i = 0; i < 4; i += 1) await aggregator.add('k', { line: `L${i}` })
    assert.equal(flushes.length, 0)
    assert.equal(aggregator.pending('k'), 4)
    await aggregator.add('k', { line: 'L4' })
    assert.equal(flushes.length, 1)
    assert.equal(flushes[0].length, 5)

    await aggregator.add('k2', { line: 'W0' })
    assert.equal(typeof timer, 'function')
    await timer()
    assert.equal(flushes.length, 2)
    assert.deepEqual(flushes[1], ['W0'])
  })

  check('归档按内容哈希命名且重复写入幂等', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-archive-'))
    try {
      const archive = createArchive({ dir, baseUrl: 'https://example.com/archive/' })
      const first = await archive.save('原文内容')
      const second = await archive.save('原文内容')
      assert.equal(first.id, second.id)
      assert.equal(first.url, `https://example.com/archive/${first.id}.md`)
      assert.equal(await readFile(join(dir, `${first.id}.md`), 'utf8'), '原文内容')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  console.log('\n[5/6] 管线路由与降级')

  await checkAsync('3 条 success 无待办只发 1 条汇总卡', async () => {
    const sent = []
    const pipeline = createNotifyPipeline({
      config: normalizeConfig({ webhook: 'https://example.com/hook' }),
      send: async (message) => { sent.push(message) },
      archive: fakeArchive,
    })
    await pipeline.handle(event({ task: '任务 A' }))
    await pipeline.handle(event({ task: '任务 B' }))
    await pipeline.handle(event({ task: '任务 C' }))
    assert.equal(sent.length, 0, '窗口未到期时不应发送')
    await pipeline.flushAll()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].card.header.title.content, '📦 3 个任务完成')
    const body = sent[0].card.elements.find((item) => item.tag === 'div').text.content
    assert.ok(body.includes('任务 A') && body.includes('任务 B') && body.includes('任务 C'))
    assert.ok(!body.includes('自动摘要'))
  })

  await checkAsync('有待办时走 LLM 卡片，正文不超过 200 字', async () => {
    const sent = []
    const llm = {
      async *stream() {
        yield { type: 'text-delta', text: JSON.stringify({ headline: '配置待确认', artifacts: [], actions: ['确认告警群'], risks: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const pipeline = createNotifyPipeline({
      config: normalizeConfig({ webhook: 'https://example.com/hook', llmEnabled: true, llmProvider: 'p', llmModel: 'm' }),
      send: async (message) => { sent.push(message) },
      archive: fakeArchive,
      llm,
    })
    await pipeline.handle(event({ body: '需要你确认告警群配置。' }))
    assert.equal(sent.length, 1)
    const body = sent[0].card.elements.find((item) => item.tag === 'div').text.content
    assert.ok(body.includes('配置待确认'))
    assert.ok(body.includes('确认告警群'))
    assert.ok(Array.from(body).length <= 200)
    assert.equal(sent[0].card.header.template, 'blue')
  })

  await checkAsync('LLM 超时/抛错时降级为本地卡片，不丢消息', async () => {
    const sent = []
    const llm = { async *stream() { throw new Error('mock timeout') } }
    const pipeline = createNotifyPipeline({
      config: normalizeConfig({ webhook: 'https://example.com/hook', llmEnabled: true, llmProvider: 'p', llmModel: 'm' }),
      send: async (message) => { sent.push(message) },
      archive: fakeArchive,
      llm,
    })
    await pipeline.handle(event({ body: '需要你确认配置。\n... [自动摘要，原文 1900 字符]' }))
    assert.equal(sent.length, 1)
    const body = sent[0].card.elements.find((item) => item.tag === 'div').text.content
    assert.ok(!body.includes('自动摘要'))
    assert.ok(body.includes('▸ 需要你'))
  })

  await checkAsync('失败消息走红色详版卡片', async () => {
    const sent = []
    const pipeline = createNotifyPipeline({
      config: normalizeConfig({ webhook: 'https://example.com/hook' }),
      send: async (message) => { sent.push(message) },
      archive: fakeArchive,
    })
    await pipeline.handle(event({ type: 'error', status: 'failed', body: '构建失败：类型错误。\n风险：无法发布。' }))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].card.header.template, 'red')
    assert.ok(sent[0].card.elements.find((item) => item.tag === 'div').text.content.includes('构建失败'))
  })

  await checkAsync('卡片发送失败时降级为一行型', async () => {
    let calls = 0
    const sent = []
    const pipeline = createNotifyPipeline({
      config: normalizeConfig({ webhook: 'https://example.com/hook' }),
      send: async (message) => {
        calls += 1
        if (calls === 1) throw new Error('card rejected')
        sent.push(message)
      },
      archive: fakeArchive,
    })
    await pipeline.handle(event({ status: 'failed', body: '失败。' }))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.startsWith('❌'))
  })

  console.log('\n[6/6] 配置')

  check('管线配置有默认值并接受合法覆盖', () => {
    const config = normalizeConfig({ webhook: 'https://example.com/hook' })
    assert.equal(config.dropProgress, true)
    assert.equal(config.oneLineMaxChars, 80)
    assert.equal(config.cardBodyMaxChars, 200)
    assert.equal(config.aggregateWindowMs, 1_800_000)
    assert.equal(config.aggregateMaxItems, 5)
    assert.equal(config.archiveEnabled, true)
    assert.equal(config.llmEnabled, false)
    assert.ok(config.todoKeywords.includes('需要你'))

    const custom = normalizeConfig({
      webhook: 'https://example.com/hook',
      drop_progress: false,
      todoKeywords: '必须|待确认',
      oneLineMaxChars: 60,
      cardBodyMaxChars: 120,
      aggregateWindowMs: 1000,
      aggregateMaxItems: 2,
      archiveEnabled: false,
      llmEnabled: true,
      llmProvider: 'p',
      llmModel: 'm',
    })
    assert.equal(custom.dropProgress, false)
    assert.deepEqual(custom.todoKeywords, ['必须', '待确认'])
    assert.equal(custom.oneLineMaxChars, 60)
    assert.equal(custom.cardBodyMaxChars, 120)
    assert.equal(custom.aggregateWindowMs, 1000)
    assert.equal(custom.aggregateMaxItems, 2)
    assert.equal(custom.archiveEnabled, false)
    assert.equal(custom.llmEnabled, true)
  })

  check('Config 拒绝错误的管线字段', () => {
    const result = Config['~standard'].validate({
      webhook: 'https://example.com/hook',
      dropProgress: 'yes',
      cardBodyMaxChars: 10,
      llmEnabled: 'true',
      todoKeywords: 1,
    })
    assert.ok(Array.isArray(result.issues))
    assert.ok(result.issues.length >= 4)
  })

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n失败：${failure.name}`)
      console.error(failure.error?.stack ?? String(failure.error))
    }
    process.exitCode = 1
  } else {
    console.log('全部通过 ✅')
  }
}

await main()
