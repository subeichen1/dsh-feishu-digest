/**
 * dsh-feishu-digest 最小自测脚本（零依赖，直接 `node test/sign.test.js`）。
 *
 * 覆盖四件事：
 *   ① 签名算法：与固定向量比对，保证 HMAC-SHA256(timestamp\nsecret, "") 的 base64 正确；
 *   ② 请求格式：起一个本地 http server 当假 webhook，验证 POST body 是飞书 text 消息；
 *   ③ 重试：服务端返回 500 时按指数退避重试，总共 3 次后判定失败；4xx 与 code!=0 不重试；
 *   ④ 告警：连续 3 次失败发「⚠️ DSH 推送告警」，5 分钟冷却期内不重复；
 * 另附：截断标记、状态映射、未配置 webhook 时插件仍能加载。
 *
 * 任何一项失败都会打印 ✗ 并以退出码 1 结束，方便接进 CI。
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import {
  apply,
  buildAlertText,
  composeMessageText,
  computeSign,
  createFailureTracker,
  describeTurnEnd,
  sendWithRetry,
} from '../index.js'

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 假 webhook：本地 http server
// ---------------------------------------------------------------------------

let mode = 'ok'
const received = []

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    received.push({ method: req.method, url: req.url, headers: req.headers, body, parsed })

    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (mode === 'http500') return reply(500, { code: 500, msg: 'internal error' })
    if (mode === 'http429') return reply(429, { code: 9499, msg: 'too many requests' })
    if (mode === 'http400') return reply(400, { code: 19001, msg: 'param invalid' })
    // 飞书常见坑：HTTP 200 但业务码非 0（签名错误时就是这种）
    if (mode === 'badSign') return reply(200, { code: 19021, msg: 'sign match fail' })
    return reply(200, { code: 0, msg: 'success' })
  })
})

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const webhook = `http://127.0.0.1:${port}/open-apis/bot/v2/hook/mock-token`

  console.log('\n[1/6] 签名算法')

  // 固定向量：timestamp=1700000000、secret=test-secret-123。
  // 算法：key = `${timestamp}\n${secret}`，对空字符串做 HMAC-SHA256，结果 base64。
  const EXPECTED_SIGN = 'daPkaWCRHAAXQst93vVK9sXdMJfjB35Ze8NS9EabjgM='
  check('computeSign 与固定向量一致', () => {
    assert.equal(computeSign('1700000000', 'test-secret-123'), EXPECTED_SIGN)
  })
  check('签名是 44 字符的 base64（SHA-256 的长度）', () => {
    const sign = computeSign('1700000000', 'another-secret')
    assert.equal(sign.length, 44)
    assert.match(sign, /^[A-Za-z0-9+/]{43}=$/)
  })
  check('换 secret 签名的结果必须变化', () => {
    assert.notEqual(computeSign('1700000000', 'a'), computeSign('1700000000', 'b'))
  })
  check('换 timestamp 签名的结果必须变化', () => {
    assert.notEqual(computeSign('1700000000', 'test-secret-123'), computeSign('1700000001', 'test-secret-123'))
  })

  console.log('\n[2/6] POST body 格式（假 webhook 实际收包）')

  const messageText = composeMessageText({
    icon: '✅',
    label: '任务完成',
    projectName: 'dsh-feishu-digest',
    conversationName: '实现飞书通知',
    title: '帮我写一个飞书通知插件',
    status: '成功',
    detail: '',
    durationMs: 12345,
    endedAt: new Date('2026-11-06T01:23:45'),
    output: '插件已生成，自测全部通过。',
    maxChars: 8000,
    hasSecret: false,
  })

  mode = 'ok'
  received.length = 0
  const okResult = await sendWithRetry({ url: webhook, text: messageText, attempts: 3, retryBaseDelayMs: 10 })
  const first = received[0]

  check('请求成功（HTTP 200 且 code === 0）', () => {
    assert.equal(okResult.ok, true)
    assert.equal(okResult.attempts, 1)
  })
  check('发的是 POST，Content-Type 为 application/json', () => {
    assert.equal(first.method, 'POST')
    assert.match(String(first.headers['content-type']), /application\/json/)
  })
  check('body 为 { msg_type: "text", content: { text } }（未开签名时不带 timestamp/sign）', () => {
    assert.equal(first.parsed.msg_type, 'text')
    assert.equal(typeof first.parsed.content.text, 'string')
    assert.ok(!('timestamp' in first.parsed))
    assert.ok(!('sign' in first.parsed))
  })
  check('第一行是状态图标，且按项目 / 对话 / 任务名 / 状态 / 耗时 / 结束时间排列', () => {
    const lines = first.parsed.content.text.split('\n')
    assert.ok(lines[0].startsWith('✅'))
    assert.match(lines[1], /^项目：dsh-feishu-digest$/)
    assert.match(lines[2], /^对话：实现飞书通知$/)
    assert.match(lines[3], /^任务名：帮我写一个飞书通知插件$/)
    assert.match(lines.join('\n'), /状态：成功/)
    assert.match(lines.join('\n'), /耗时：12\.3 秒/)
    assert.match(lines.join('\n'), /结束时间：2026\/11\/6 01:23:45/)
    assert.match(lines.join('\n'), /─{20}/)
  })
  check('分隔线之后是正文（摘要或全文）', () => {
    const text = first.parsed.content.text
    assert.ok(text.includes('插件已生成，自测全部通过。'))
  })

  // 开启签名后：body 里要出现 timestamp 与 sign，且 sign 可复算。
  mode = 'ok'
  received.length = 0
  await sendWithRetry({ url: webhook, text: '签名测试', secret: 'test-secret-123', attempts: 1, retryBaseDelayMs: 10 })
  check('开启签名后 body 带 10 位 timestamp 与可复算的 sign', () => {
    const body = received[0].parsed
    assert.match(String(body.timestamp), /^\d{10}$/)
    assert.equal(body.sign, computeSign(body.timestamp, 'test-secret-123'))
  })

  console.log('\n[3/6] 失败重试（指数退避，最多 3 次）')

  mode = 'http500'
  received.length = 0
  const startedAt = Date.now()
  const fail500 = await sendWithRetry({ url: webhook, text: '会失败的推送', attempts: 3, retryBaseDelayMs: 50 })
  const elapsed = Date.now() - startedAt

  check('HTTP 500 一共尝试 3 次后判定失败', () => {
    assert.equal(fail500.ok, false)
    assert.equal(fail500.attempts, 3)
    assert.equal(received.length, 3)
  })
  check('退避为 500ms 起步的指数序列（测试里用 50ms：50 + 100 = 150ms 起）', () => {
    assert.ok(elapsed >= 150, `实际耗时 ${elapsed}ms，应 ≥ 150ms`)
  })

  // 把重试失败接到告警器上，验证端到端告警。
  mode = 'http500'
  received.length = 0
  let nowMs = 1_700_000_000_000
  const tracker = createFailureTracker({ threshold: 3, cooldownMs: 5 * 60 * 1000, now: () => nowMs })
  const alertLog = []

  for (let i = 0; i < 3; i += 1) {
    const result = await sendWithRetry({ url: webhook, text: '会失败的推送', attempts: 3, retryBaseDelayMs: 5 })
    assert.equal(result.ok, false)
    const failure = tracker.recordFailure(webhook, result.detail)
    alertLog.push(failure.shouldAlert)
    if (failure.shouldAlert) {
      // 告警走的是同一个 webhook（真实环境此处才是唯一还通的路）
      mode = 'ok'
      const alertText = buildAlertText({ consecutive: failure.consecutive, reason: failure.reason, url: webhook })
      const alertResult = await sendWithRetry({ url: webhook, text: alertText, attempts: 1, retryBaseDelayMs: 5 })
      if (alertResult.ok) tracker.recordAlertSent(webhook)
      mode = 'http500'
    }
  }

  check('前两次失败不告警，第 3 次失败才告警', () => {
    assert.deepEqual(alertLog, [false, false, true])
  })
  check('告警文案以「⚠️ DSH 推送告警」开头并含失败原因', () => {
    const alertBody = received.find((item) => String(item.parsed?.content?.text ?? '').startsWith('⚠️ DSH 推送告警'))
    assert.ok(alertBody, '没有收到告警消息')
    const text = alertBody.parsed.content.text
    assert.match(text, /已连续失败 3 次/)
    assert.match(text, /最新失败原因：.*HTTP 500/)
    // webhook 必须打码：只保留协议+域名+一小段路径，token 不能出现在告警里
    assert.match(text, /webhook：http:\/\/127\.0\.0\.1:\d+\/open-apis\/b…/)
    assert.ok(!text.includes('mock-token'), '告警文案里不应出现完整 token')
  })
  check('告警发送成功后重置连续失败计数', () => {
    assert.equal(tracker.inspect(webhook).consecutive, 0)
  })
  check('5 分钟冷却期内再次连续失败也不重复告警', () => {
    const before = tracker.inspect(webhook).lastAlertAt
    let shouldAlert = false
    for (let i = 0; i < 3; i += 1) shouldAlert = tracker.recordFailure(webhook, 'HTTP 500 cooling').shouldAlert
    assert.equal(shouldAlert, false)
    assert.equal(tracker.inspect(webhook).lastAlertAt, before)
  })
  check('冷却期结束后（+5 分钟）才会再次告警', () => {
    nowMs = tracker.inspect(webhook).lastAlertAt + 5 * 60 * 1000 + 1
    let shouldAlert = false
    for (let i = 0; i < 3; i += 1) shouldAlert = tracker.recordFailure(webhook, 'HTTP 500 after cooldown').shouldAlert
    assert.equal(shouldAlert, true)
  })

  console.log('\n[4/6] 不该重试的失败')

  mode = 'http400'
  received.length = 0
  const fail400 = await sendWithRetry({ url: webhook, text: '参数错误', attempts: 3, retryBaseDelayMs: 5 })
  check('HTTP 400 不重试，只尝试 1 次', () => {
    assert.equal(fail400.ok, false)
    assert.equal(fail400.attempts, 1)
    assert.equal(fail400.retryable, false)
    assert.equal(received.length, 1)
  })

  mode = 'badSign'
  received.length = 0
  const failSign = await sendWithRetry({ url: webhook, text: '签名错误', secret: 'wrong', attempts: 3, retryBaseDelayMs: 5 })
  check('HTTP 200 但 code=19021 判为失败且不重试（不能只看状态码）', () => {
    assert.equal(failSign.ok, false)
    assert.equal(failSign.status, 200)
    assert.equal(failSign.code, 19021)
    assert.equal(failSign.attempts, 1)
    assert.match(failSign.detail, /19021/)
  })

  mode = 'http429'
  received.length = 0
  const fail429 = await sendWithRetry({ url: webhook, text: '限流', attempts: 2, retryBaseDelayMs: 5 })
  check('HTTP 429 属于可重试错误，会尝试 2 次', () => {
    assert.equal(fail429.ok, false)
    assert.equal(fail429.attempts, 2)
    assert.equal(received.length, 2)
  })

  console.log('\n[5/6] 文本保护（20KB / 截断）')

  check('超长输出被截断并注明原长度', () => {
    const long = 'A'.repeat(30000)
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      title: '超长输出',
      status: '成功',
      durationMs: 1000,
      endedAt: new Date(),
      output: long,
      maxChars: 8000,
      outputMode: 'full',
    })
    assert.ok(text.includes('... [已截断，原长 30000 字符]'))
    assert.ok(text.length < 9000)
  })
  check('请求体始终不超过 20KB（含 emoji 与签名占位）', () => {
    const long = '成'.repeat(30000) + '✅'.repeat(1000)
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      title: '超长输出',
      status: '成功',
      durationMs: 1000,
      endedAt: new Date(),
      output: long,
      maxChars: 100000, // 故意把字符上限调大，让 20KB 字节上限生效
      hasSecret: true,
      outputMode: 'full',
    })
    assert.ok(text.includes('已截断，原长'))
    const bytes = Buffer.byteLength(JSON.stringify({ msg_type: 'text', content: { text }, timestamp: '0000000000', sign: 'A'.repeat(44) }), 'utf8')
    assert.ok(bytes <= 20 * 1024, `请求体 ${bytes} 字节，超过 20KB`)
  })
  check('短输出不会被截断、也不会多出标记', () => {
    const text = composeMessageText({
      icon: '✅',
      label: '任务完成',
      title: '短',
      status: '成功',
      durationMs: 1,
      endedAt: new Date(),
      output: 'hello',
      maxChars: 8000,
    })
    assert.ok(text.endsWith('hello'))
    assert.ok(!text.includes('已截断'))
  })

  console.log('\n[6/6] 状态映射与未配置 webhook 时的加载')

  check('completed → ✅ / error → ❌ / blocked → ⏸️', () => {
    assert.equal(describeTurnEnd({ kind: 'completed' }).icon, '✅')
    const failed = describeTurnEnd({ kind: 'error', error: { message: '模型调用失败', code: 'UNKNOWN' } })
    assert.equal(failed.icon, '❌')
    assert.match(failed.detail, /模型调用失败/)
    assert.equal(describeTurnEnd({ kind: 'blocked' }).icon, '⏸️')
    assert.equal(describeTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }).icon, '⏸️')
    assert.equal(describeTurnEnd({ kind: 'max-tokens' }).icon, '⏸️')
  })

  await checkAsync('未配置 webhook 时 apply 不抛错、打印 warning、且仍输出 loaded 日志', async () => {
    const logs = []
    const fakeCtx = {
      logger: {
        info: (line) => logs.push(String(line)),
        warn: (line) => logs.push(String(line)),
        error: (line) => logs.push(String(line)),
        debug: (line) => logs.push(String(line)),
      },
      on() {},
      effect() {},
      get() {
        return undefined
      },
    }
    // 清空环境变量兜底，确保走「未配置」分支
    const savedWebhook = process.env.DSH_FEISHU_WEBHOOK
    const savedFeishu = process.env.FEISHU_WEBHOOK
    const savedBot = process.env.FEISHU_BOT_WEBHOOK
    delete process.env.DSH_FEISHU_WEBHOOK
    delete process.env.FEISHU_WEBHOOK
    delete process.env.FEISHU_BOT_WEBHOOK
    try {
      apply(fakeCtx, {})
      await sleep(10)
    } finally {
      if (savedWebhook !== undefined) process.env.DSH_FEISHU_WEBHOOK = savedWebhook
      if (savedFeishu !== undefined) process.env.FEISHU_WEBHOOK = savedFeishu
      if (savedBot !== undefined) process.env.FEISHU_BOT_WEBHOOK = savedBot
    }
    assert.ok(logs.some((line) => line.includes('[dsh-feishu-digest]') && line.includes('未配置 webhook')))
    assert.ok(logs.some((line) => line.includes('loaded v1.4.0')))
  })

  await checkAsync('webhook 为字符串数组时逐个发送（R8）', async () => {
    mode = 'ok'
    received.length = 0
    const urls = [`http://127.0.0.1:${port}/hook/a`, `http://127.0.0.1:${port}/hook/b`]
    const logs = []
    const handlers = []
    const fakeCtx = {
      logger: { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)), debug: () => {} },
      on(event, handler) {
        handlers.push({ event, handler })
      },
      effect() {},
      get() {
        return undefined
      },
    }
    apply(fakeCtx, { webhook: urls, aggregateWindowMs: 10, aggregateMaxItems: 5 })

    // 直接喂一条完成的 turn/end，走完整的「事件 → 组装 → 推送」链路
    const handler = handlers.find((item) => item.event === 'session/event')?.handler
    assert.ok(handler, '没有订阅 session/event')
    const session = { id: 'session-1', header: { cwd: '.' } }
    const base = Date.now()
    handler(session, { type: 'turn/start', time: base, data: { turn: 1 } })
    handler(session, { type: 'user/message', time: base + 5, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '两个群都发' }] } })
    handler(session, { type: 'assistant/message', time: base + 10, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '结果正文' }] } } })
    handler(session, { type: 'turn/end', time: base + 1000, data: { turn: 1, reason: { kind: 'completed' } } })

    // 推送是异步的，等它把两个 webhook 都打完
    for (let i = 0; i < 50 && received.length < 2; i += 1) await sleep(20)
    assert.equal(received.length, 2, `应收到 2 次请求，实际 ${received.length}`)
    assert.deepEqual(
      received.map((item) => item.url).sort(),
      ['/hook/a', '/hook/b'],
    )
    assert.equal(received[0].parsed.msg_type, 'interactive')
    const body = received[0].parsed.card.elements.find((item) => item.tag === 'div').text.content
    assert.ok(body.includes('两个群都发'))
    assert.match(received[0].parsed.card.header.title.content, /1 个任务完成/)
    assert.ok(logs.some((line) => line.includes('loaded v1.4.0') && line.includes('webhook=2 个')))
  })

  // -------------------------------------------------------------------------
  // 汇总
  // -------------------------------------------------------------------------
  server.close()

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
  server.close()
  process.exitCode = 1
})
