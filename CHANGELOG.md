# Changelog

本项目遵循语义化版本。行为变更会在这里标注“破坏性”或“兼容”。

## 1.4.1 — 2026-11-09

### 修复

- 补齐 npm 发布元数据：`repository` / `homepage` / `bugs` 指向 [github.com/subeichen1/dsh-feishu-digest](https://github.com/subeichen1/dsh-feishu-digest)。
  （1.4.0 是首次发布，发布时仓库尚未确定，因此没有 repository 字段。）

## 1.4.0 — 2026-11-09

### 新增

- **通知精简管线**：所有飞书消息先经过统一路由，agent 侧零改动。
  - 成功且无待办：一行型，按 `(项目, 对话)` 聚合，30 分钟或满 5 条 flush。
  - 成功且含待办关键词或失败项：可选 LLM 压缩，失败自动降级本地兜底；发送蓝色卡片。这样“某项修复失败，原因…”不会被压成一行丢掉。
  - 失败/错误：立即发红色详版卡片；warning 橙色；progress 默认丢弃，但 finish/error 永不丢。
  - 卡片结构：结论 → `▸ 产物` → `▸ 需要你`（空则“无需操作”）→ `▸ 风险`（空则省略）。
- **归档**：发送前把原文写入 `~/.dsh/feishu-digest/archive/<sha256前8位>.md`，重复写入幂等；`archiveBaseUrl` 配置后卡片显示「查看原文」。
- **本地兜底清洗**：删除 `【自动摘要…】` 尾注、省略号独占行、4+ 分隔线；只留前 8 个非空行、总长 ≤300。
- **配置**：`dropProgress`、`todoKeywords`、`oneLineMaxChars`、`cardBodyMaxChars`、`aggregateWindowMs`、`aggregateMaxItems`、`archiveEnabled`、`archiveDir`、`archiveBaseUrl`、`llmEnabled`、`llmProvider`、`llmModel`、`llmTimeoutMs`、`llmMaxTokens`、`llmRetries`。

### 变更

- **破坏性（消息形态）**：飞书不再直接发送 Agent 原文；`outputMode` / `summaryMaxChars` / `maxChars` 对发送管线不再生效，仅为兼容旧配置保留。原文仍在归档中。
- 一行型硬上限 80 字，卡片正文硬上限 200 字。
- 卡片头部显示任务名；项目/对话放在头部下方的 note 中。
- **公开发布用名**：npm 包名 `dsh-feishu-digest`，运行树里的行 id 为 `feishu-digest`，归档目录 `~/.dsh/feishu-digest/archive`。
  旧的 `dsh-feishu-notify` 包名已被他人占用，如从旧名迁移：把 profile 里的 `- id: feishu-notify` 改成 `feishu-digest`、
  依赖与 `dsh.profile.bundles` 里的包名换掉；旧归档目录可用 `archiveDir` 指回去。

### 测试

- `test/sign.test.js`：26 项。
- `test/listener.test.js`：51 项。
- `test/pipeline.test.js`：22 项。
- 合计 99 项，零第三方依赖，`npm test` 全绿。

## 1.3.0 — 2026-11-09

### 变更

- 默认摘要从“按行打分”改为“结果要点”：按 Markdown 标题分节，每节取标题 + 前几条句头；失败项、未完成项、带数量的行优先。
- “实现 / 做法 / 方案 / 步骤 / 代码 / 函数 / 通过修改 / 采用 …”等 how-to 行不再进入摘要；“说明 / 备注 / 其他 / 背景”等填充段整段跳过。
- 某节正文超过 3 条时，标题后显示 `（共 N 项）`，避免只看到部分结果却不知道总数。
- 默认 `summaryMaxChars` 从 600 收紧到 400，最多 6 条、单条最多 120 字；`outputMode: full` 仍可发送完整输出。
- 配置字段名不变；这是默认行为变更，不需要迁移配置。

### 测试

- `test/sign.test.js`：26 项。
- `test/listener.test.js`：51 项。
- 合计 77 项，零第三方依赖，`npm test` 全绿。

## 1.2.1 — 2026-11-06

### 变更

- 默认摘要更短：`summaryMaxChars` 从 1200 收紧到 600，最多保留 5 段，单行最多 200 字；需要更多内容时调大 `summaryMaxChars`。
- 配置项名称不变；`outputMode: full` 仍可发送完整输出。

### 测试

- `test/sign.test.js`：26 项。
- `test/listener.test.js`：49 项。
- 合计 75 项，零第三方依赖，`npm test` 全绿。

## 1.2.0 — 2026-11-06

### 新增

- 卡片头部增加 `项目` 与 `对话` 两级名称，顺序为：状态 → 项目 → 对话 → 任务名。
  - `项目` 取 `session.header.cwd` 的目录名。
  - `对话` 取会话日志中最新一条 `session/title`，跳过 `source.kind=fallback` 的首条 prompt；日志不可读时才用 `ctx.sessionTitle.get(session).title` 快照。不取首条 prompt。
  - `任务名` 仍取本回合首条人类 prompt，不再复用会话标题。
- 同一 Webhook 的推送改为串行队列，多个回合同时结束时按到达顺序发送。
- 响应体流式读取，最多 64KB，避免异常端点耗尽内存。
- 飞书 `code=9499` 按限流处理，可重试；支持 `Retry-After`。
- 结束时间附带本地时区偏移（`UTC±N`）。
- 正文中的 `<at ...>` 会被中和为全角字符，降低 @全体 注入风险。

### 变更

- Webhook 仅接受 `https`；`http` 只允许 `localhost` / `127.0.0.1` / `::1`。
- `Config` 增加数值边界与整数校验，越界会报 `invalid config`，不再静默夹紧。
- 超时错误保留“请求超时（Nms）”语义，不再退化成泛化的网络错误。
- `recordSuccess` 会清空上次失败原因。
- 退避延迟统一封顶 30 秒，并优先尊重服务端 `Retry-After`。

### 测试

- `test/sign.test.js`：26 项。
- `test/listener.test.js`：48 项。
- 合计 74 项，零第三方依赖，`npm test` 全绿。

## 1.1.0 — 2026-11-06

### 新增

- 默认 `outputMode: summary`：本地抽取式摘要，零依赖、不调用模型。
- `summaryMaxChars`（默认 1200，最小 80）。
- `alertWebhook` / `alertSecret` 独立告警通道。
- `NOTICE`、GitHub Actions CI、`test/listener.test.js`。

### 修复

- 多回合会话的任务名取当前回合首条人类 prompt，不再复用会话首条 prompt。
- 告警失败后也进入冷却，避免每个回合重复告警。
- 非法 Webhook 日志打码；畸形 URL 的 fetch 错误文本不再泄露完整 token。
- `maskUrl` 去掉 userinfo、query、hash。

## 1.0.0 — 初始版本

- 任务结束时推送飞书群自定义机器人。
- 支持签名、重试、连续失败告警、20KB 请求体保护、多 Webhook。
