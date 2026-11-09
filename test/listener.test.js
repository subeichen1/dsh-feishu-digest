import assert from 'node:assert/strict'
import http from 'node:http'
import {
  Config,
  apply,
  buildHeader,
  clipChars,
  composeMessageText,
  createFailureTracker,
  createSerialQueue,
  createTurnListener,
  formatEndedAt,
  maskUrl,
  normalizeConfig,
  postOnce,
  readResponseText,
  resolveConversationName,
  resolveProjectName,
  resolveTaskName,
  sanitizeMentions,
  sendWithRetry,
  summarizeOutput,
  VERSION,
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

function createLogger() {
  const lines = []
  const push = (line) => lines.push(String(line))
  return {
    lines,
    logger: { info: push, warn: push, error: push, debug: push },
  }
}

function createCtx() {
  const handlers = []
  const { lines, logger } = createLogger()
  return {
    lines,
    handlers,
    ctx: {
      logger,
      handlers,
      on(event, handler) {
        handlers.push({ event, handler })
      },
      effect() {},
      get() {
        return undefined
      },
    },
  }
}

function feedTurn(handler, session, turn, prompt, output, base = Date.now()) {
  handler(session, { type: 'turn/start', time: base, data: { turn } })
  handler(session, {
    type: 'user/message',
    time: base + 1,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] },
  })
  handler(session, {
    type: 'assistant/message',
    time: base + 2,
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: output }] } },
  })
  handler(session, { type: 'turn/end', time: base + 10, data: { turn, reason: { kind: 'completed' } } })
}

async function startServer() {
  const received = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      received.push({ url: req.url, raw, parsed: (() => { try { return JSON.parse(raw) } catch { return undefined } })() })
      if (req.url.startsWith('/business-fail') || req.url.startsWith('/alert-fail')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 500, msg: 'mock failure' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, msg: 'ok' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, received, port: server.address().port }
}

function fakeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => body,
  }
}

async function main() {
  console.log('[1/9] 配置归一化与校验')

  check('VERSION 与 package.json 对齐', () => {
    assert.equal(VERSION, '1.4.0')
  })

  check('空字符串 webhook 会回退到环境变量', () => {
    const config = normalizeConfig({ webhook: '' }, { DSH_FEISHU_WEBHOOK: 'https://example.com/hook/env' })
    assert.deepEqual(config.webhooks, ['https://example.com/hook/env'])
    assert.equal(config.invalidWebhooks.length, 0)
  })

  check('空数组 webhook 也会回退到环境变量', () => {
    const config = normalizeConfig({ webhook: [] }, { DSH_FEISHU_WEBHOOK: 'https://example.com/hook/env' })
    assert.deepEqual(config.webhooks, ['https://example.com/hook/env'])
  })

  check('显式 config 优先于环境变量', () => {
    const config = normalizeConfig({ webhook: 'https://example.com/hook/config' }, { DSH_FEISHU_WEBHOOK: 'https://example.com/hook/env' })
    assert.deepEqual(config.webhooks, ['https://example.com/hook/config'])
  })

  check('非法 URL 进入 invalidWebhooks，而不是静默通过', () => {
    const config = normalizeConfig({ webhook: 'http://exa mple.com/hook/token' }, {})
    assert.equal(config.webhooks.length, 0)
    assert.equal(config.invalidWebhooks.length, 1)
  })

  check('告警 webhook 与告警密钥独立归一化', () => {
    const config = normalizeConfig({
      webhook: 'https://example.com/hook/main',
      alertWebhook: 'https://example.com/hook/alert',
      alertSecret: 'alert-secret',
    }, {})
    assert.deepEqual(config.alertWebhooks, ['https://example.com/hook/alert'])
    assert.equal(config.alertSecret, 'alert-secret')
    assert.equal(config.invalidAlertWebhooks.length, 0)
  })

  check('非法告警 webhook 单独收集', () => {
    const config = normalizeConfig({ alertWebhook: 'not-a-url' }, {})
    assert.equal(config.alertWebhooks.length, 0)
    assert.equal(config.invalidAlertWebhooks.length, 1)
  })

  check('默认输出模式是 summary，摘要上限 400', () => {
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main' }, {})
    assert.equal(config.outputMode, 'summary')
    assert.equal(config.summaryMaxChars, 400)
  })

  check('outputMode=full 与自定义摘要上限生效', () => {
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main', outputMode: 'full', summaryMaxChars: 200 }, {})
    assert.equal(config.outputMode, 'full')
    assert.equal(config.summaryMaxChars, 200)
  })

  check('Config 允许空配置（未配置 webhook 不报错）', () => {
    assert.equal(Config['~standard'].validate(undefined).issues, undefined)
    assert.deepEqual(Config['~standard'].validate(undefined).value, {})
    assert.equal(Config['~standard'].validate({}).issues, undefined)
  })

  check('Config 拒绝错误的 includeSubagents / outputMode / alertWebhook', () => {
    const result = Config['~standard'].validate({
      includeSubagents: 'true',
      outputMode: 'verbose',
      alertWebhook: 123,
    })
    assert.ok(Array.isArray(result.issues))
    assert.ok(result.issues.length >= 3)
  })

  check('Config 接受合法的新配置', () => {
    const result = Config['~standard'].validate({
      webhook: ['https://example.com/a'],
      alertWebhook: 'https://example.com/b',
      alertSecret: 's',
      outputMode: 'summary',
      summaryMaxChars: 300,
      includeSubagents: false,
    })
    assert.equal(result.issues, undefined)
  })

  console.log('\n[2/9] URL 打码')

  check('maskUrl 去掉 userinfo、query 和 hash', () => {
    const masked = maskUrl('https://user:pass@example.com/open-apis/bot/v2/hook/secret?token=abc#frag')
    assert.equal(masked, 'https://example.com/open-apis/b…')
    assert.ok(!masked.includes('user'))
    assert.ok(!masked.includes('pass'))
    assert.ok(!masked.includes('secret'))
  })

  check('maskUrl 对非法 URL 返回固定占位符', () => {
    assert.equal(maskUrl('not a url'), '[invalid webhook]')
    assert.equal(maskUrl('ftp://example.com/hook'), '[invalid webhook]')
  })

  console.log('\n[3/9] 本地抽取式摘要')

  check('短文本不摘要，原样返回', () => {
    const result = summarizeOutput('短结果', { maxChars: 100 })
    assert.equal(result.text, '短结果')
    assert.equal(result.summarized, false)
  })

  check('长结构化文本会保留标题、结论并限制长度', () => {
    const source = [
      '# 修复报告',
      '',
      '本次修复了 P2-1 和 P2-2。',
      '补充说明。'.repeat(30),
      '',
      '## 变更',
      '- 按回合记录首条人类 prompt',
      '- 告警走独立通道',
      '- 告警失败也进入冷却',
      '',
      '## 测试',
      '两个测试文件全部通过。',
      '',
      '结论：可以发布。',
    ].join('\n')
    const result = summarizeOutput(source, { maxChars: 120 })
    assert.equal(result.summarized, true)
    assert.ok(Array.from(result.text).length <= 120)
    assert.match(result.text, /修复报告|结论|测试/)
    assert.ok(!result.text.includes('```'))
  })

  check('摘要按段取句头，保留结果与数量，丢弃 how-to 和填充段', () => {
    const source = [
      '# 审计报告',
      '',
      '## 结论',
      '发现 3 个 P2 问题，已修复 2 个，剩余 1 个未修复。',
      '',
      '## 变更',
      '- 修复多回合任务名',
      '- 增加独立告警通道',
      '- 默认摘要收紧',
      '- 更新 README 和 CHANGELOG',
      '',
      '## 验证',
      '- npm test 76 项全部通过',
      '- 真实飞书端到端未验证',
      '- 代理环境未测试',
      '',
      '## 风险',
      '- 代理环境不支持',
      '- 摘要可能漏掉细节',
      '- 没有持久队列',
      '',
      '## 下一步',
      '- 在真实群做一次验收',
      '- 补充代理配置说明',
      '- 观察一周日志',
      '',
      '## 实现',
      '具体做法是通过修改 index.js 的 summarizeOutput，使用正则匹配标题和关键字，然后按分数排序，最后拼接。',
      '',
      '这一段是不重要的细节，应该被丢弃。',
      '',
      '## 其他',
      '这里是一些无关紧要的补充说明，用来凑长度，确保超过四百个字符。'.repeat(8),
    ].join('\n')
    const result = summarizeOutput(source, { maxChars: 400 })
    assert.equal(result.summarized, true)
    assert.match(result.text, /结论：发现 3 个 P2 问题/)
    assert.match(result.text, /变更（共 4 项）：/)
    assert.match(result.text, /验证：npm test 76 项全部通过/)
    assert.match(result.text, /风险：/)
    assert.match(result.text, /下一步：/)
    assert.ok(!result.text.includes('具体做法'))
    assert.ok(!result.text.includes('无关紧要'))
    assert.ok(Array.from(result.text).length <= 400)
  })

  check('摘要保留失败项与原因，并给出总项数', () => {
    const source = [
      '## P3/P4 修复',
      '- P3-1 已修复',
      '- P3-2 已修复',
      '- P3-3 已修复',
      '- P3-4 已修复',
      '- P4-1 已修复',
      '- P4-2 修复失败，原因：上游接口返回 500',
      '- P4-3 未修复，原因：需要产品确认',
      '- 其余 6 项已修复',
      '',
      '## 测试',
      '- npm test 76 项通过',
      '- 失败 0 项',
      '',
      '## 说明',
      '这里补充一些无关紧要的细节，把长度撑过上限，确保摘要逻辑被触发。'.repeat(8),
    ].join('\n')
    const result = summarizeOutput(source, { maxChars: 300 })
    assert.equal(result.summarized, true)
    assert.match(result.text, /P3\/P4 修复（共 8 项）/)
    assert.match(result.text, /P4-2 修复失败，原因：上游接口返回 500/)
    assert.match(result.text, /P4-3 未修复，原因：需要产品确认/)
    assert.ok(!result.text.includes('。；'), '句头之间不应出现「。；」')
    assert.ok(!result.text.includes('说明：'))
  })

  check('摘要默认最多保留 6 条结果要点', () => {
    const source = Array.from({ length: 12 }, (_, index) => [
      `## 段 ${index}`,
      `结论 ${index}：完成 ${index} 项。${'补充说明。'.repeat(40)}`,
    ].join('\n')).join('\n')
    const result = summarizeOutput(source, { maxChars: 2000 })
    assert.equal(result.summarized, true)
    const items = result.text.split('\n').filter(Boolean)
    assert.ok(items.length <= 6, `实际 ${items.length} 条`)
  })

  check('composeMessageText 默认使用摘要并标注原文长度', () => {
    const source = `# 报告\n${'无关内容。'.repeat(1000)}\n结论：完成。`
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      title: '摘要测试',
      status: '成功',
      durationMs: 1,
      endedAt: new Date(),
      output: source,
      maxChars: 8000,
      summaryMaxChars: 200,
    })
    assert.match(text, /自动摘要，原文 \d+ 字符/)
    assert.match(text, /结论：完成/)
    assert.ok(!text.includes('无关内容。'.repeat(100)))
  })

  check('outputMode=full 时保留完整输出与截断标记', () => {
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      title: '全文测试',
      status: '成功',
      durationMs: 1,
      endedAt: new Date(),
      output: 'A'.repeat(500),
      maxChars: 100,
      outputMode: 'full',
    })
    assert.match(text, /已截断，原长 500 字符/)
  })

  console.log('\n[4/9] 多回合任务名（P2-1）')

  check('第 2 回合的任务名取当前回合 prompt，而不是会话首条 prompt', () => {
    const delivered = []
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main' }, {})
    const listener = createTurnListener({
      ctx: { get: () => undefined },
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      deliver: async (payload) => { delivered.push(payload) },
      now: () => 1000,
    })
    const session = { id: 'multi-turn', header: { cwd: '.' } }
    feedTurn(listener.handle, session, 1, '第一回合任务', '第一回合结果', 1000)
    feedTurn(listener.handle, session, 2, '第二回合任务', '第二回合结果', 2000)

    assert.equal(delivered.length, 2)
    assert.equal(delivered[0].title, '第一回合任务')
    assert.equal(delivered[1].title, '第二回合任务')
  })

  check('同一回合重复 turn/end 只推送一次', () => {
    const delivered = []
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main' }, {})
    const listener = createTurnListener({
      ctx: { get: () => undefined },
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      deliver: async (payload) => { delivered.push(payload) },
      now: () => 1000,
    })
    const session = { id: 'dedup', header: { cwd: '.' } }
    listener.handle(session, { type: 'turn/start', time: 1000, data: { turn: 1 } })
    listener.handle(session, {
      type: 'user/message',
      time: 1001,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '去重任务' }] },
    })
    listener.handle(session, { type: 'turn/end', time: 1002, data: { turn: 1, reason: { kind: 'completed' } } })
    listener.handle(session, { type: 'turn/end', time: 1003, data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(delivered.length, 1)
  })

  console.log('\n[5/9] 子代理过滤')

  check('默认跳过 subagent 会话', () => {
    const delivered = []
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main' }, {})
    const listener = createTurnListener({
      ctx: { get: () => undefined },
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      deliver: async (payload) => { delivered.push(payload) },
      now: () => 1000,
    })
    const session = { id: 'sub-1', header: { origin: 'subagent' } }
    feedTurn(listener.handle, session, 1, '子代理任务', '子代理结果', 1000)
    assert.equal(delivered.length, 0)
  })

  check('includeSubagents=true 时允许 subagent 会话推送', () => {
    const delivered = []
    const config = normalizeConfig({ webhook: 'https://example.com/hook/main', includeSubagents: true }, {})
    const listener = createTurnListener({
      ctx: { get: () => undefined },
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      deliver: async (payload) => { delivered.push(payload) },
      now: () => 1000,
    })
    const session = { id: 'sub-2', header: { origin: 'subagent' } }
    feedTurn(listener.handle, session, 1, '子代理任务', '子代理结果', 1000)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].title, '子代理任务')
  })

  console.log('\n[6/9] 中止、token 打码与告警冷却')

  await checkAsync('已中止的 postOnce 不会发起 fetch', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test abort'))
    let called = false
    const result = await postOnce({
      url: 'https://example.com/hook',
      text: 'x',
      signal: controller.signal,
      fetchImpl: async () => { called = true; throw new Error('should not run') },
    })
    assert.equal(result.ok, false)
    assert.equal(result.retryable, false)
    assert.equal(called, false)
  })

  await checkAsync('已中止的 sendWithRetry 返回 attempts=0', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test abort'))
    let called = false
    const result = await sendWithRetry({
      url: 'https://example.com/hook',
      text: 'x',
      signal: controller.signal,
      fetchImpl: async () => { called = true; throw new Error('should not run') },
    })
    assert.equal(result.attempts, 0)
    assert.equal(called, false)
  })

  await checkAsync('畸形 URL 的错误文本不会泄露完整 token', async () => {
    const secretToken = 'SECRET-TOKEN-123'
    const result = await postOnce({
      url: `http://exa mple.com/open-apis/bot/v2/hook/${secretToken}`,
      text: 'x',
      timeoutMs: 1000,
    })
    assert.equal(result.ok, false)
    assert.ok(!result.detail.includes(secretToken), result.detail)
  })

  check('recordAlertFailed 会让告警进入冷却期', () => {
    let now = 10000
    const tracker = createFailureTracker({ threshold: 1, cooldownMs: 5000, now: () => now })
    assert.equal(tracker.recordFailure('u', 'boom').shouldAlert, true)
    tracker.recordAlertFailed('u')
    assert.equal(tracker.recordFailure('u', 'boom').shouldAlert, false)
    now += 5001
    assert.equal(tracker.recordFailure('u', 'boom').shouldAlert, true)
  })

  console.log('\n[7/9] 告警通道路由（P2-2）')

  const { server, received, port } = await startServer()
  try {
    await checkAsync('apply 默认走精简管线，而不是全文', async () => {
      received.length = 0
      const { ctx } = createCtx()
      apply(ctx, {
        webhook: `http://127.0.0.1:${port}/summary-ok`,
        aggregateWindowMs: 10,
        retries: 1,
        retryBaseDelayMs: 1,
      })
      const handler = ctx.handlers.find((item) => item.event === 'session/event')?.handler
      assert.ok(handler)
      const longOutput = `# 报告\n\n${'无关内容。'.repeat(500)}\n\n结论：全部通过。`
      const session = { id: 'summary-integration', header: { cwd: '.' } }
      feedTurn(handler, session, 1, '摘要集成', longOutput, Date.now())
      for (let i = 0; i < 100 && received.length < 1; i += 1) await sleep(20)
      assert.equal(received.length, 1, `应收到 1 次请求，实际 ${received.length}`)
      assert.equal(received[0].parsed.msg_type, 'interactive')
      const body = received[0].parsed.card.elements.find((item) => item.tag === 'div').text.content
      assert.ok(body.includes('摘要集成'))
      assert.ok(!body.includes('无关内容。'.repeat(100)), '精简后不应包含整段无关内容')
      assert.ok(!body.includes('自动摘要，原文'), '不应再透传旧摘要尾注')
    })

    await checkAsync('业务失败时告警走独立 alertWebhook', async () => {
      received.length = 0
      const { ctx } = createCtx()
      apply(ctx, {
        webhook: `http://127.0.0.1:${port}/business-fail`,
        alertWebhook: `http://127.0.0.1:${port}/alert-ok`,
        alertThreshold: 1,
        aggregateWindowMs: 10,
        retries: 1,
        retryBaseDelayMs: 1,
      })
      const handler = ctx.handlers.find((item) => item.event === 'session/event')?.handler
      assert.ok(handler)
      const session = { id: 'alert-route', header: { cwd: '.' } }
      feedTurn(handler, session, 1, '告警路由', '结果', Date.now())
      // 卡片失败后会先降级为一行型重试一次，再触发独立告警，因此是 3 次请求。
      for (let i = 0; i < 100 && received.length < 3; i += 1) await sleep(20)
      assert.equal(received.length, 3, `应收到 3 次请求，实际 ${received.length}`)
      assert.ok(received.some((item) => item.url === '/business-fail'))
      assert.ok(received.some((item) => item.url === '/alert-ok'))
      const alert = received.find((item) => item.url === '/alert-ok')
      assert.match(alert.parsed.content.text, /⚠️ DSH 推送告警/)
    })

    await checkAsync('告警失败后进入冷却，下一回合不重复告警', async () => {
      received.length = 0
      const { ctx } = createCtx()
      apply(ctx, {
        webhook: `http://127.0.0.1:${port}/business-fail`,
        alertWebhook: `http://127.0.0.1:${port}/alert-fail`,
        alertThreshold: 1,
        alertCooldownMs: 300000,
        aggregateWindowMs: 10,
        retries: 1,
        retryBaseDelayMs: 1,
      })
      const handler = ctx.handlers.find((item) => item.event === 'session/event')?.handler
      const session = { id: 'alert-cooldown', header: { cwd: '.' } }
      feedTurn(handler, session, 1, '第一回合', '结果', Date.now())
      // 卡片失败 + 一行型降级 + 告警失败，共 3 次。
      for (let i = 0; i < 100 && received.length < 3; i += 1) await sleep(20)
      assert.equal(received.length, 3, `第一回合应收到 3 次请求，实际 ${received.length}`)

      feedTurn(handler, session, 2, '第二回合', '结果', Date.now() + 1000)
      // 第二回合卡片与降级各一次；告警仍在冷却期，不应再发。
      for (let i = 0; i < 100 && received.length < 5; i += 1) await sleep(20)
      assert.equal(received.filter((item) => item.url === '/business-fail').length, 4)
      assert.equal(received.filter((item) => item.url === '/alert-fail').length, 1)
    })

    await checkAsync('多个业务 webhook 中一个失败不影响另一个', async () => {
      received.length = 0
      const { ctx } = createCtx()
      apply(ctx, {
        webhook: [
          `http://127.0.0.1:${port}/business-fail`,
          `http://127.0.0.1:${port}/business-ok`,
        ],
        alertThreshold: 3,
        aggregateWindowMs: 10,
        retries: 1,
        retryBaseDelayMs: 1,
      })
      const handler = ctx.handlers.find((item) => item.event === 'session/event')?.handler
      const session = { id: 'multi-webhook', header: { cwd: '.' } }
      feedTurn(handler, session, 1, '多群', '结果', Date.now())
      for (let i = 0; i < 100 && received.length < 2; i += 1) await sleep(20)
      assert.equal(received.length, 2)
      assert.ok(received.some((item) => item.url === '/business-fail'))
      assert.ok(received.some((item) => item.url === '/business-ok'))
    })
  } finally {
    server.close()
  }

  console.log('\n[8/9] 1.2.x 名称层级、限流与边界')

  check('卡片头部顺序为 项目 → 对话 → 任务名', () => {
    const header = buildHeader({
      icon: '✅',
      label: '任务完成',
      projectName: 'demo-project',
      conversationName: '会话标题',
      title: '当前回合任务',
      status: '成功',
      durationMs: 1200,
      endedAt: new Date('2026-11-06T10:00:00Z'),
    })
    const lines = header.split('\n')
    assert.equal(lines[0], '✅ 任务完成')
    assert.match(lines[1], /^项目：demo-project$/)
    assert.match(lines[2], /^对话：会话标题$/)
    assert.match(lines[3], /^任务名：当前回合任务$/)
  })

  check('项目名取 cwd 目录名，根目录回退占位符', () => {
    assert.equal(resolveProjectName({ header: { cwd: 'C:\\Users\\me\\Desktop\\demo\\' } }), 'demo')
    assert.equal(resolveProjectName({ header: { cwd: '/home/me/work/app' } }), 'app')
    assert.equal(resolveProjectName({ header: { cwd: 'C:\\' } }), '(未知项目)')
    assert.equal(resolveProjectName({ header: {} }), '(未知项目)')
  })

  check('对话名优先取会话日志最新标题', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'session/title', data: { title: '# 任务：旧 prompt', source: { kind: 'fallback' } } },
        { type: 'user/message', data: {} },
        { type: 'session/title', data: { title: '审计并修复', source: { kind: 'user' } } },
      ],
    }
    assert.equal(resolveConversationName({ get: () => ({ title: '服务快照' }) }, session), '审计并修复')
  })

  check('fallback 标题不当作对话名', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'session/title', data: { title: '# 角色设定 你是一名资深AI项', source: { kind: 'fallback' } } },
      ],
    }
    assert.equal(
      resolveConversationName({ get: () => ({ title: '服务快照', source: { kind: 'fallback' } }) }, session),
      '(未命名对话)',
    )
    assert.equal(
      resolveConversationName({ get: () => ({ title: '首条 prompt', source: { kind: 'fallback' } }) }, {}),
      '(未命名对话)',
    )
  })

  check('对话名在日志不可用时回退服务快照', () => {
    assert.equal(
      resolveConversationName({ get: () => ({ title: '服务快照', source: { kind: 'provider' } }) }, { snapshotEvents: () => [] }),
      '服务快照',
    )
    assert.equal(resolveConversationName({ get: () => ({ title: '排查登录问题' }) }, {}), '排查登录问题')
    assert.equal(resolveConversationName({ get: () => undefined }, {}), '(未命名对话)')
    assert.equal(resolveConversationName({ get: () => { throw new Error('not ready') } }, {}), '(未命名对话)')
  })

  check('任务名压成单行并回退', () => {
    assert.equal(resolveTaskName('  第一行\n第二行  '), '第一行 第二行')
    assert.equal(resolveTaskName(''), '(未命名任务)')
    assert.equal(resolveTaskName(undefined), '(未命名任务)')
  })

  check('sanitizeMentions 中和飞书 @ 标签', () => {
    const raw = '<at user_id="all">全体</at> 和 <at id="u1">某人</at>'
    const safe = sanitizeMentions(raw)
    assert.ok(!safe.includes('<at'), safe)
    assert.ok(safe.includes('＜at'))
  })

  check('composeMessageText 的正文也会中和 @ 标签', () => {
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      projectName: 'p',
      conversationName: 'c',
      title: 't',
      status: '成功',
      durationMs: 1,
      endedAt: new Date(),
      output: '<at user_id="all">全体</at>',
      outputMode: 'full',
    })
    assert.ok(!text.includes('<at'), text)
    assert.ok(text.includes('＜at'))
  })

  check('formatEndedAt 带时区偏移，非法日期回退', () => {
    assert.match(formatEndedAt(new Date('2026-11-06T10:00:00Z')), /（UTC[+-]\d+(?::\d{2})?）/)
    assert.equal(formatEndedAt(new Date('not-a-date')), '未知时间')
  })

  check('clipChars 接受非字符串与负数上限', () => {
    assert.equal(clipChars(12345, 2).text, '12')
    assert.equal(clipChars('abc', -1).text, '')
    assert.equal(clipChars(null, 3).text, '')
  })

  await checkAsync('readResponseText 流式读取最多 64KB', async () => {
    const text = await readResponseText(new Response('x'.repeat(100000)), 1024)
    assert.equal(Buffer.byteLength(text, 'utf8'), 1024)
  })

  await checkAsync('readResponseText 对无流响应退回 text() 并截断', async () => {
    const text = await readResponseText(fakeResponse(200, 'abcdef'), 3)
    assert.equal(text, 'abc')
  })

  await checkAsync('飞书 code=9499 视为可重试', async () => {
    let calls = 0
    const result = await sendWithRetry({
      url: 'https://example.com/hook',
      text: 'x',
      attempts: 2,
      retryBaseDelayMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1
        return calls === 1
          ? fakeResponse(200, JSON.stringify({ code: 9499, msg: 'rate limited' }))
          : fakeResponse(200, JSON.stringify({ code: 0, msg: 'ok' }))
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 2)
  })

  await checkAsync('sendWithRetry 尊重 Retry-After', async () => {
    let calls = 0
    let slept = 0
    const result = await sendWithRetry({
      url: 'https://example.com/hook',
      text: 'x',
      attempts: 2,
      retryBaseDelayMs: 10,
      sleepImpl: async (ms) => { slept = ms },
      fetchImpl: async () => {
        calls += 1
        return calls === 1
          ? fakeResponse(429, 'slow down', { 'retry-after': '2' })
          : fakeResponse(200, JSON.stringify({ code: 0 }))
      },
    })
    assert.equal(result.ok, true)
    assert.equal(slept, 2000)
  })

  await checkAsync('请求超时保留“超时”语义', async () => {
    const result = await postOnce({
      url: 'https://example.com/hook',
      text: 'x',
      timeoutMs: 10,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
      }),
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /请求超时（10ms）/)
  })

  await checkAsync('同一 webhook 串行发送，不同 webhook 不互相阻塞', async () => {
    const queue = createSerialQueue()
    const order = []
    const first = queue.run('a', async () => {
      await sleep(20)
      order.push('a1')
    })
    const second = queue.run('a', async () => { order.push('a2') })
    const other = queue.run('b', async () => { order.push('b1') })
    await Promise.all([first, second, other])
    assert.ok(order.indexOf('a1') < order.indexOf('a2'))
    assert.ok(order.includes('b1'))
  })

  check('Config 拒绝越界与小数', () => {
    for (const [key, value] of [['timeoutMs', 0], ['retries', 1.5], ['summaryMaxChars', 79], ['maxChars', -1], ['alertThreshold', 0]]) {
      const result = Config['~standard'].validate({ [key]: value })
      assert.ok(result.issues?.length, `${key}=${value} 应被拒绝`)
    }
  })

  check('recordSuccess 清空上次失败原因', () => {
    const tracker = createFailureTracker({ threshold: 1, cooldownMs: 0 })
    tracker.recordFailure('u', 'boom')
    tracker.recordSuccess('u')
    assert.equal(tracker.inspect('u').lastReason, '')
  })

  console.log('\n[9/9] 汇总')

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`\n失败：${failure.name}\n${failure.error?.stack ?? failure.error}`)
    process.exitCode = 1
    return
  }
  console.log('全部通过 ✅')
}

main().catch((error) => {
  console.error('自测脚本本身出错：', error)
  process.exitCode = 1
})
