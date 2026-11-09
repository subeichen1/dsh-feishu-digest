# dsh-feishu-digest

把 DeepSeek Harness（DSH）每一次任务的结束结果，经过**通知精简管线**压缩成一行消息或短卡片，再推送到你的飞书群。

成功的任务默认聚合成一行（30 分钟窗口或满 5 条汇总）；有待办、失败或错误的任务发卡片，只保留「结论 → 产物 → 需要你 → 风险」。原文全文在发送前归档到本地，卡片底部可挂「查看原文」。不需要公网 IP，不需要开服务，装好、填一个 Webhook 地址就能用。

默认不调用模型；只有“成功且含待办关键词或失败项”的卡片路径才会尝试 LLM 压缩，LLM 未配置或超时会自动退回本地兜底。

成功、无待办时只发一行，多个任务会聚合：

```
✅ 修复登录接口的空指针 —— 成功 ｜ 任务完成飞书传回·审计并修复 ｜ 3.0 分钟
```

有待办或失败时发短卡片，卡片头部是任务名，下面依次是项目/对话、结论、产物、需要你、风险：

```
✅ 修复登录接口的空指针
项目：任务完成飞书传回 ｜ 对话：审计并修复
结论：登录接口空指针已修复，回归测试通过
▸ 产物
· src/auth/login.ts
▸ 需要你
· 确认是否补一条边界场景测试
▸ 风险
· 真实设备未复测
[查看原文]
```

```
❌ 把支付模块拆成独立服务
项目：任务完成飞书传回 ｜ 对话：支付模块重构
结论：构建失败：类型错误
▸ 产物
· （无）
▸ 需要你
· 无需操作
▸ 风险
· 无法发布
```

---

## 目录

- [功能](#功能)
- [从 1.0 升级到 1.1](#从-10-升级到-11)
- [从 1.1 升级到 1.2](#从-11-升级到-12)
- [从 1.2 升级到 1.3](#从-12-升级到-13)
- [从 1.3 升级到 1.4](#从-13-升级到-14)
- [前置条件](#前置条件)
- [第一步：创建飞书自定义机器人](#第一步创建飞书自定义机器人)
- [第二步：安装插件](#第二步安装插件)
- [第三步：填写配置](#第三步填写配置)
- [配置项完整说明](#配置项完整说明)
- [环境变量兜底](#环境变量兜底)
- [消息格式说明](#消息格式说明)
- [重试与告警规则](#重试与告警规则)
- [自测](#自测)
- [常见问题](#常见问题)
- [卸载](#卸载)
- [部署前合规确认（P2-3）](#部署前合规确认p2-3)
- [隐私与安全](#隐私与安全)
- [实现说明](#实现说明)
- [开源与品牌使用](#开源与品牌使用)

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 任务结束即推送 | 订阅 DSH 的 `turn/end` 事件，回合结束的同一刻发送，不轮询、不攒批 |
| 三级名称 | 卡片依次显示 `项目`（cwd 目录名）、`对话`（会话最新标题）、`任务名`（本回合首条人类 prompt） |
| 成功/失败都推 | `completed` 用 ✅，`error` 用 ❌，取消/阻塞/超限/中断用 ⏸️ |
| 精简管线 | 成功无待办 → 一行型（30 分钟/5 条聚合）；失败/待办/含失败项 → `interactive` 卡片；原文先归档 |
| 默认精简 | 本地规则路由，不调用模型；失败/待办卡片优先保留结论、失败原因、待办与风险，丢弃 how-to 和元信息 |
| 原文可查 | 发送前全文归档到 `~/.dsh/feishu-digest/archive`，配 `archiveBaseUrl` 后卡片带「查看原文」 |
| 签名校验 | 飞书机器人开启「签名校验」时，自动附加 `timestamp` + `sign` |
| 失败重试 | 网络错误 / HTTP 429 / 5xx / 飞书 `code=9499` 才重试；尊重 `Retry-After`，指数退避最多 30 秒、最多 3 次 |
| 业务码判定 | HTTP 200 也会解析响应 JSON，只有 `code === 0` 才算成功；响应体最多读 64KB |
| 连续失败告警 | 同一 Webhook 连续最终失败 3 次发「⚠️ DSH 推送告警」，5 分钟冷却；可配独立告警群 |
| 20KB 保护 | 请求体硬上限 20KB，超长输出截断并注明原长度 |
| 多群推送 | `webhook` 支持字符串数组，逐个发送；同一 Webhook 串行排队，一个群失败不影响其他群 |
| 只发 https | 生产 Webhook 必须是 `https`；`http` 仅允许 localhost 回环，避免 token 明文上网 |
| 零依赖 | 只用 `node:crypto` 与内置 `fetch`，没有任何第三方包 |
| 不拖累主流程 | 所有回调都在 `try/catch` 里，推送异步执行、绝不阻塞 DSH |

---

## 从 1.0 升级到 1.1

1.1.0 有一个**行为变更**：默认从“发送全文”改为“发送本地摘要”。

- 想保持 1.0 的行为，在配置里显式加 `outputMode: full`。
- 想保留摘要但控制长度，调 `summaryMaxChars`（当前默认 400，1.1 时是 1200）。
- 告警默认仍回退到业务 Webhook；如果业务群和运维群分开，建议补 `alertWebhook` / `alertSecret`。
- 多回合会话的任务名现在按“本回合首条人类 prompt”取，不再复用会话首条 prompt；这是修复，不是配置项。

---

## 从 1.1 升级到 1.2

1.2.x 主要是可靠性、安全边界和消息可读性升级。配置字段名不变，但校验变严：过去能“勉强跑”的 `http` 远程地址和越界数值现在会被拒绝。

- **卡片三级名称**：`项目`（会话 cwd 的目录名）→ `对话`（会话日志里**最新**一条非 `fallback` 的 `session/title`）→ `任务名`（本回合首条人类 prompt）。任务名不再复用会话标题；对话名也不取首条 prompt。
- **Webhook 只接受 https**：`http` 仅允许 `localhost` / `127.0.0.1` / `::1`，避免 token 明文上网；本地 mock 仍可用。
- **飞书 `code=9499` 可重试**：之前 HTTP 200 + 9499 被当作不可重试；现在按限流处理，并尊重 `Retry-After`。
- **响应体上限 64KB**：流式读取，异常端点不会把内存打满。
- **同一 Webhook 串行发送**：多个回合同时结束时按到达顺序推送，不会乱序，也不会瞬间打爆群机器人。
- **时区与 @ 标签**：结束时间带 `UTC±N`；正文中的 `<at ...>` 会被中和，降低 @全体 注入风险。
- **配置边界前置校验**：`timeoutMs`、`retries`、`summaryMaxChars` 等越界会在加载时报错，不再静默夹紧。
- **默认摘要更短**：`summaryMaxChars` 默认从 1200 收紧到 600，最多保留 5 段，单行最多 200 字；需要更多内容时调大 `summaryMaxChars`。
- **测试**：`test/sign.test.js` 26 项 + `test/listener.test.js` 49 项，共 75 项。

---

## 从 1.2 升级到 1.3

1.3.0 只改默认摘要的“写法”，配置字段名不变：

- **只发结果，不发过程**：不再按行打分，而是按 Markdown 标题分节，每节取“标题 + 前几条句头”；失败项、未完成项、带数量的行优先保留。
- **跳过 how-to**：正文中以“实现 / 做法 / 方案 / 步骤 / 代码 / 函数 / 通过修改 / 采用 …”开头的行不会进入摘要；“说明 / 备注 / 其他 / 背景”等填充段直接跳过。
- **更短**：默认 `summaryMaxChars` 从 600 收到 400，最多 6 条、单条最多 120 字。
- **带数量**：某节正文超过 3 条时，标题后显示 `（共 N 项）`，避免只看到部分结果却不知道总数。
- **兼容**：`outputMode: full` 仍发全文；调大 `summaryMaxChars` 可以保留更多要点。
- **测试**：`test/sign.test.js` 26 项 + `test/listener.test.js` 51 项，共 77 项。

---

## 从 1.3 升级到 1.4

1.4.0 新增**通知精简管线**：所有飞书消息先经过统一路由，不再直接把 Agent 输出透传到群里。

- **成功且无待办**：进入聚合缓冲，30 分钟内或攒满 5 条后发一条一行/汇总消息；不会每回合刷屏。
- **成功但有待办关键词或失败项**（必须/需要你/待办/仍为空/可以推翻/建议/剩余/没动/风险，或正文含失败/错误/未修复）：走 LLM 压缩（可关）或本地兜底，发蓝色卡片：结论 → 产物 → 需要你 → 风险。这样“某项修复失败，原因…”不会被压成一行丢掉。
- **失败/错误**：立即发红色卡片，保留失败原因。
- **progress**：默认丢弃，避免过程消息刷屏；`dropProgress: false` 可放开。
- **原文归档**：发送前把全文写到 `~/.dsh/feishu-digest/archive/<hash>.md`，卡片上的「查看原文」按钮指向 `archiveBaseUrl`；不配 base URL 时仍归档，但按钮不出现。
- **`outputMode` / `summaryMaxChars`**：1.4 的发送管线不再读取这两个旧开关；原文在归档里，飞书只发精简结果。保留字段只为兼容旧配置。
- **测试**：26 + 51 + 22 = 99 项。

---

## 前置条件

| 项目 | 要求 |
| --- | --- |
| DSH | 0.1.x 及以上（需要 `session/event` 事件；`ctx.sessionTitle` 是可选服务，缺失时对话名回退 `(未命名对话)`，任务名仍取本回合 prompt） |
| Node.js | 18.17+（插件用到全局 `fetch`；实测 Node 24 正常） |
| 飞书 | 任意版本的群聊，能添加「自定义机器人」 |
| pnpm | **仅** `dsh plugin` 安装方式需要；手动安装不需要 |

---

## 第一步：创建飞书自定义机器人

1. 打开要接收通知的飞书群，点右上角 **⋯** → **设置** → **群机器人** → **添加机器人**，选择 **自定义机器人**。
2. 给它起个名字（比如 `DSH 任务通知`），点 **添加**。
3. 复制页面上的 **Webhook 地址**，形如：

   ```
   https://open.feishu.cn/open-apis/bot/v2/hook/1a2b3c4d-1111-2222-3333-444455556666
   ```

   > 这个地址就是「往这个群发消息的钥匙」，等同于密码，别发到公开仓库里。

4. **要不要开启签名校验？**

   | 你的情况 | 建议 | 插件怎么配 |
   | --- | --- | --- |
   | 只想自己用、Webhook 不会外泄 | 可以不开启 | `secret` 留空即可 |
   | 团队共用、Webhook 可能出现在截图/日志里 | 建议开启 | 开启后把「签名校验」下面那串密钥填到 `secret` |

   开启方式是同一个弹窗里的 **安全设置** → 勾选 **签名校验**，复制密钥（形如 `AbCdEfGhIjKlMnOpQrStUv`）。
   注意：开启签名校验后，**不带签名的请求会被飞书拒绝**（返回 `code: 19021 sign match fail`），所以必须同时配好 `secret`。

5. 可选：同一个弹窗里还有 **IP 白名单** 和 **关键词**。如果你填了关键词，消息里必须包含该关键词才会被接受——本插件不做关键词注入，建议不要设置，或者把关键词写在你的 prompt 里。

---

## 第二步：安装插件

插件包目录结构（发布后从 npm 安装时也一样）：

```
dsh-feishu-digest/
├── package.json          # 包声明：type=module、main、dsh.bundle.patch、files
├── cordis.patch.yml      # bundle 挂载声明：把插件插入 DSH 运行树
├── index.js              # 插件主体（唯一源码文件，零第三方依赖）
├── config.example.yml    # 配置示例（全是占位符）
├── README.md             # 本文件
├── CHANGELOG.md          # 版本变更记录
├── LICENSE               # MIT
├── NOTICE                # 版权、品牌/商标说明
├── test/sign.test.js     # 签名、报文、重试、截断自测
├── test/listener.test.js # 监听器、多回合、子代理、摘要、告警路由自测
└── .github/workflows/    # CI：Node 18.17 / 20 / 22
```

安装的本质是两件事：把包放进 profile 的依赖里，并让 DSH 把它当作一个 **bundle 层**加载。本包的 `package.json` 里已经声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

所以只要它作为依赖被安装，`dsh plugin` 会自动把它加进 `dsh.profile.bundles`，`cordis.patch.yml` 里的那一行就会被插入运行树。

> 下文的 `--profile web` 只是示例。请换成你实际使用的 profile（`desktop`、`tui` 等）；
> 插件装在哪个 profile，就只在哪个 profile 里生效。

### 方式 A：本地路径加载（推荐自用、改代码调试）

需要 pnpm。在**插件目录的上一级**执行（这样相对路径能被正确锚定）：

```powershell
# Windows PowerShell，假设插件目录是 .\dsh-feishu-digest
dsh plugin --profile web add file:./dsh-feishu-digest
```

```bash
# macOS / Linux
dsh plugin --profile web add file:./dsh-feishu-digest
```

`dsh plugin` 只是把参数原样转给 profile 目录里的 pnpm，所以也能用 `link:`：

```powershell
dsh plugin --profile web add link:./dsh-feishu-digest
```

`link:` 的好处是改完 `index.js` 重启 DSH 就生效，不用重新安装。

> 报 `pnpm not found on PATH` 就说明本机没有 pnpm。装一个（`npm i -g pnpm` 或 `corepack enable pnpm`）再重试，或者用下面的方式 B。

### 方式 B：手动安装（没有 pnpm 也能装）

以 Windows 的 `web` profile 为例，profile 目录是 `C:\Users\<你>\.dsh\profiles\web`：

1. 把整个 `dsh-feishu-digest` 目录放到 `C:\Users\<你>\.dsh\profiles\web\node_modules\dsh-feishu-digest`
   （或者建一个目录联接：`cmd /c mklink /J "C:\Users\<你>\.dsh\profiles\web\node_modules\dsh-feishu-digest" "D:\code\dsh-feishu-digest"`）。
2. 编辑 `C:\Users\<你>\.dsh\profiles\web\package.json`，在 `dependencies` 里加一条，并在 `dsh.profile.bundles` 里追加本包名：

   ```json
   {
     "name": "dsh-profile-web",
     "private": true,
     "dependencies": {
       "dsh-feishu-digest": "file:D:/code/dsh-feishu-digest"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-feishu-digest"],
         "patchReload": "live"
       }
     }
   }
   ```

3. 重启 DSH。`bundles` 的顺序就是层叠顺序，本条要放在最后（用户覆盖优先）。

> 验证是否真的挂上了，可以打印组合后的运行树（不会真正启动）：
>
> ```powershell
> dsh --profile web --dump-config | Select-String feishu
> ```
>
> 应该能看到 `id: feishu-digest` / `name: dsh-feishu-digest` 这一行。

### 方式 C：作为已发布 npm 包安装

```powershell
dsh plugin --profile web add dsh-feishu-digest
```

（发布到 npm 之后可用；包名不同则换名字。安装后同样会自动进入 `dsh.profile.bundles`。）

### 方式 D：离线分发包（tgz，推荐发给同事）

仓库根目录的 `dsh-feishu-digest-1.4.0.tgz` 由 `npm pack` 生成，可直接发给别人安装，无需先发 npm：

```powershell
dsh plugin --profile web add .\dsh-feishu-digest-1.4.0.tgz
```

包内已包含 `index.js`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`config.example.yml`、`LICENSE`、`NOTICE`、`test/sign.test.js`、`test/listener.test.js`、`test/pipeline.test.js` 与 `package.json`，共 11 个文件。对方机器没有 pnpm 时，也可以把 tgz 解开后把 `package\` 目录按「方式 B」放到 profile 的 `node_modules\dsh-feishu-digest`。

> `.gitignore` 默认忽略 `*.tgz`，打包产物不会进 Git；要发给别人时单独传 tgz 或走 npm 即可。

---

## 第三步：填写配置

配置文件是 **profile 目录下的 `cordis.patch.yml`**：

```
Windows:      C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml
macOS/Linux:  ~/.dsh/profiles/web/cordis.patch.yml
```

在文件末尾追加一段（**完整可复制**，只需要把 webhook 换成你自己的）：

```yaml
- id: feishu-digest
  config:
    webhook: https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    # 1.4 默认：成功无待办走一行/聚合，失败或待办走短卡片
    dropProgress: true
    oneLineMaxChars: 80
    cardBodyMaxChars: 200
```

开了签名校验就再加一行：

```yaml
- id: feishu-digest
  config:
    webhook: https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    secret: 你的签名密钥
```

如果希望业务通知发到项目群、告警单独发到运维群，再加一个独立的告警通道（可选）：

```yaml
- id: feishu-digest
  config:
    webhook: https://open.feishu.cn/open-apis/bot/v2/hook/项目群token
    secret: 项目群的签名密钥
    alertWebhook: https://open.feishu.cn/open-apis/bot/v2/hook/运维群token
    alertSecret: 运维群的签名密钥
```

不配置 `alertWebhook` 时，告警会回退到业务 `webhook`；这样虽然省事，但业务 Webhook 本身失效时告警也发不出去。

想同时发多个群，`webhook` 写成数组：

```yaml
- id: feishu-digest
  config:
    webhook:
      - https://open.feishu.cn/open-apis/bot/v2/hook/群A的token
      - https://open.feishu.cn/open-apis/bot/v2/hook/群B的token
```

> **为什么是覆盖而不是合并**：DSH 的 patch 规则是「同 id 的条目整块替换 config」，不是深合并。
> 所以这一段要么写全你要的键，要么只写想改的键（其余回落默认值）——本插件所有键都有默认值，只写 webhook 和 secret 就够了。
>
> 如果想让这份配置对**所有 profile** 生效，可以把它写进 `$DSH_HOME/cordis.patch.yml`
> （Windows：`C:\Users\<你>\.dsh\cordis.patch.yml`），这一层会作用在每个 profile 上。
>
> 同一个 profile 里不要保留多个同 id 块：它们会按顺序覆盖，只有最后一个生效，前几个看起来配置了、实际不会起作用。

保存后：`patchReload: "live"` 的 profile（如 `web`）会热重载配置；不确定就重启一次 DSH。

**怎么确认加载成功？** 设置环境变量 `DSH_FEISHU_DEBUG=1` 再启动，stderr 会打印：

```
[dsh-feishu-digest] loaded v1.4.0（webhook=1 个，告警=同业务 webhook，签名=关闭，管线=本地，超时=8000ms，最多尝试=3 次）
[dsh-feishu-digest] 检测到任务结束：✅ 任务完成（session=session-… turn=1 耗时=42.7 秒）
[dsh-feishu-digest] 推送成功（第 1/3 次）→ https://open.feishu.cn/open-apis/bot…
```

---

## 配置项完整说明

全部可选，除 `webhook` 外都有默认值。写错类型会在加载时报 `invalid config`，写错值（比如空的 webhook）只会 warning，不会影响 DSH 启动。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `webhook` | string \| string[] | 无（**必填**，否则只 warning 不推送） | 飞书群自定义机器人 Webhook 地址，必须是 `https`（`http` 仅允许 localhost 回环）。数组时逐个发送，先去重。非法 URL 会被忽略并 warning |
| `webhooks` | 同上 | — | `webhook` 的别名，两个都写时以 `webhook` 为准 |
| `secret` | string | `''` | 飞书「签名校验」密钥。为空表示不签名 |
| `outputMode` | `summary` \| `full` | `summary` | **1.4 起发送管线不再读取**，仅为兼容旧配置保留；飞书只发精简结果，全文进归档 |
| `summaryMaxChars` | number | `400` | **1.4 起发送管线不再读取**，同上；保留给旧版 `composeMessageText` 调用方 |
| `maxChars` | number | `8000` | **1.4 起发送管线不再读取**，同上；请求体仍有 20KB 硬上限 |
| `dropProgress` | boolean | `true` | `type=progress` 的过程消息默认丢弃；`false` 时按普通消息处理 |
| `todoKeywords` | string \| string[] | `必须/需要你/待办/仍为空/可以推翻/建议/剩余/没动/风险` | 命中任一词就走卡片（而不是一行型）；字符串用 `|`、逗号或换行分隔 |
| `oneLineMaxChars` | number | `80` | 一行型硬上限（40–200），超出截断 |
| `cardBodyMaxChars` | number | `200` | 卡片正文硬上限（80–500） |
| `aggregateWindowMs` | number | `1800000` | 一行型聚合窗口，默认 30 分钟 |
| `aggregateMaxItems` | number | `5` | 一行型缓冲满多少条立即 flush |
| `archiveEnabled` | boolean | `true` | 发送前是否把原文写入归档 |
| `archiveDir` | string | `~/.dsh/feishu-digest/archive` | 归档目录；文件名为 `sha256(原文)[:8].md`，重复写入幂等 |
| `archiveBaseUrl` | string | `''` | 归档对外 URL 前缀；配置后才生成「查看原文」按钮 |
| `llmEnabled` | boolean | `false` | 是否允许“成功且含待办/失败项”的卡片走 LLM 压缩；关闭时全走本地兜底 |
| `llmProvider` | string | `''` | DSH LLM provider id，例如 `deepseek`；`llmEnabled=true` 时必填 |
| `llmModel` | string | `''` | 模型 id；`llmEnabled=true` 时必填 |
| `llmTimeoutMs` | number | `10000` | LLM 单次超时（最小 100ms） |
| `llmMaxTokens` | number | `400` | LLM 最大输出 token（50–2000） |
| `llmRetries` | number | `1` | LLM 失败后的额外重试次数（0–3） |
| `alertWebhook` | string \| string[] | `''`（回退业务 `webhook`） | 告警专用 Webhook。配置后告警只发到这里，避免业务 Webhook 失效时告警也发不出去 |
| `alertSecret` | string | `''`（回退 `secret`） | 告警 Webhook 的签名密钥；告警群和业务群不是同一个机器人时必须单独配置 |
| `alertThreshold` | number | `3` | 同一业务 Webhook 连续**最终推送失败**多少次后发告警（不是 HTTP 尝试次数） |
| `alertCooldownMs` | number | `300000` | 告警冷却期（毫秒），默认 5 分钟；冷却期内不重复告警 |
| `retryBaseDelayMs` | number | `500` | 指数退避起始延迟，第 n 次重试前等待 `base × 2^(n-1)`，单次最多 30 秒 |
| `includeSubagents` | boolean | `false` | 是否也给子代理（subagent / fork 出来的会话）推送。默认关闭，避免一次任务刷出好几条 |

数值边界会在加载时校验：`timeoutMs >= 1`、`retries >= 1`、`maxChars >= 0`、`summaryMaxChars >= 80`、`alertThreshold >= 1`、`alertCooldownMs >= 0`、`retryBaseDelayMs >= 0`、`oneLineMaxChars >= 40`、`cardBodyMaxChars >= 80`、`aggregateWindowMs >= 1`、`aggregateMaxItems >= 1`、`llmTimeoutMs >= 100`、`llmMaxTokens >= 50`、`llmRetries >= 0`；整数项还必须是整数。越界会报 `invalid config` 并让该插件条目加载失败，而不是静默改成默认值。`oneLineMaxChars`/`cardBodyMaxChars`/`llmMaxTokens` 还有上限，归一化时会夹紧。

完整示例见 [config.example.yml](./config.example.yml)（里面全是占位符，可以直接抄）。

---

## 环境变量兜底

不想把 token 写进配置文件时，可以用环境变量。优先级：**配置文件 > 环境变量**。

| 用途 | 环境变量（按优先级） |
| --- | --- |
| 业务 Webhook | `DSH_FEISHU_WEBHOOK` → `FEISHU_WEBHOOK` → `FEISHU_BOT_WEBHOOK` |
| 业务签名密钥 | `DSH_FEISHU_SECRET` → `FEISHU_WEBHOOK_SECRET` → `FEISHU_BOT_SECRET` |
| 告警 Webhook | `DSH_FEISHU_ALERT_WEBHOOK` → `FEISHU_ALERT_WEBHOOK` |
| 告警签名密钥 | `DSH_FEISHU_ALERT_SECRET` → `FEISHU_ALERT_SECRET` |
| 调试日志 | `DSH_FEISHU_DEBUG=1`（把 `[dsh-feishu-digest]` 日志额外输出到控制台） |

> 配置里的空字符串、空数组会视为“未配置”，继续回退到环境变量；这样 profile 里写 `webhook: ""` 不会把环境变量挡掉。

```powershell
# Windows PowerShell（当前窗口有效，重启终端失效）
$env:DSH_FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
$env:DSH_FEISHU_SECRET  = "你的签名密钥"
dsh web
```

```bash
# macOS / Linux
export DSH_FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
export DSH_FEISHU_SECRET="你的签名密钥"
dsh web
```

想永久生效：写进 shell 的 profile，或写进 DSH 的 `.env`（`C:\Users\<你>\.dsh\.env`，DSH 启动时会加载）。

---

## 消息格式说明

所有消息都先经过 `createNotifyPipeline`，只有三种出口：

**1. 一行型（成功且无待办）**

```
✅ <任务名> —— 成功 ｜ <项目>·<对话> ｜ <N.N> 分钟
```

硬上限 `oneLineMaxChars`（默认 80 字）。不会立即发送，而是按 `(项目, 对话)` 进入缓冲，`aggregateWindowMs`（默认 30 分钟）到期或满 `aggregateMaxItems`（默认 5 条）时，合成一条「📦 N 个任务完成」汇总卡。

**2. 卡片型（失败/错误、warning、成功但含待办关键词或失败项）**

```
<图标> <任务名>
项目：<项目> ｜ 对话：<对话>
结论：<一句话结论>
▸ 产物
· <commit / 链接 / 变更文件数>
▸ 需要你
· <待填配置 / 待决策 / 待确认>
▸ 风险
· <风险或遗留>
[查看原文]
```

`▸ 需要你` 为空显示“无需操作”；`▸ 风险` 为空整行省略。卡片正文硬上限 `cardBodyMaxChars`（默认 200 字）。失败卡片红色、warning 橙色、成功待办/含失败项蓝色。

**3. 文本兜底 / 告警**

卡片发送失败时降级为一行型；网络层告警仍是纯文本：

```
⚠️ DSH 推送告警
已连续失败 N 次
最新失败原因：...
webhook：https://...
时间：...
请检查飞书机器人是否被移除、签名密钥是否正确、或群是否触发限流。
```

`项目` 取 `session.header.cwd` 的 basename；`对话` 取会话日志里**最新**一条真正的 `session/title`（跳过 `source.kind=fallback` 的首条 prompt，也不是本回合任务名），日志不可读时才用 `ctx.sessionTitle` 快照；`任务名` 只取本回合首条 `source.kind === 'user'` 的 prompt。三级名称都会压成单行并限制在 80 字以内。

### 状态映射

| `turn/end` 的 `reason.kind` | 图标 | 标题 | 含义 |
| --- | --- | --- | --- |
| `completed` | ✅ | 任务完成 | 正常跑完 |
| `error` | ❌ | 任务失败 | 模型/请求报错，附带错误信息 |
| `aborted` | ⏸️ | 任务已取消 | 用户取消、父会话取消、hook 取消、会话释放 |
| `blocked` | ⏸️ | 任务被阻塞 | 被策略挡住 |
| `max-tokens` | ⏸️ | 任务达到长度上限 | 输出被 token 上限截断 |
| `interrupted` | ⏸️ | 任务被中断 | 持久化层关闭的孤儿回合 |
| 其他/未知 | ⏸️ | 任务结束 | 兜底 |

### 名称从哪来

| 层级 | 来源 | 回退 |
| --- | --- | --- |
| 项目 | `session.header.cwd` 的目录名（如 `C:\work\demo` → `demo`） | `(未知项目)` |
| 对话 | 会话日志最新一条非 `fallback` 的 `session/title` → `ctx.sessionTitle.get(session).title` 快照 | `(未命名对话)` |
| 任务名 | 本回合首条 `source.kind === 'user'` 的 prompt 前 80 字 | `(未命名任务)` |

对话名是**项目里这条对话的总名称**，贯穿多个回合，不随单次任务变化；它取最新标题，因此用户重命名或标题服务刷新后会跟着更新，但不会退化成某次任务的 prompt。任务名才逐回合变化。注入的插件上下文（`source.kind !== 'user'`）不会污染任务名。

### 本地摘要规则（1.3 及以前，1.4 发送管线不再使用）

`outputMode: summary` 时，旧版 `composeMessageText` 会在本地做“结果要点”摘要；1.4 的发送管线直接输出一行/卡片，不再调用这个函数。下面保留给仍在使用导出函数的调用方参考：

- 按 Markdown 标题（`#`、`**标题**`、`标题：`）分节；每节取标题 + 前几条句头（到第一个 `。！？!?` 为止）。
- 失败/错误/未完成/剩余/待确认/无法，以及带“共 N 项”“合计”“数字+项/个/条”的行优先；某节超过 3 条时标题后显示 `（共 N 项）`。
- 以“实现 / 做法 / 方案 / 步骤 / 代码 / 函数 / 通过修改 / 采用 …”开头的 how-to 行会跳过；“说明 / 备注 / 附注 / 其他 / 背景 / 附录 / 参考”段整段跳过。
- 最多 6 条、单条最多 120 字、总长受 `summaryMaxChars`（默认 400，最小 80）和 `maxChars` 双重限制；按码点截断，emoji 不会被劈开。
- 正文里的 `结论：…`、`变更：…`、`验证：…`、`风险：…`、`下一步：…` 会作为高优先级要点保留。

摘要质量取决于输出结构：有标题、结论、失败项、待办列表时效果最好；纯散文会退化为少量首句。需要逐字全文时显式设置 `outputMode: full`；需要更多要点时调大 `summaryMaxChars`。

### 截断规则（R6）

- `full` 模式先按 `maxChars`（默认 8000 字符）截断正文，追加：

  ```
  ... [已截断，原长 12345 字符]
  ```

  `N` 是**原始**字符数（按码点算，emoji 不会被劈开）。

- `summary` 模式先按 `summaryMaxChars` 摘要；摘要标记是 `... [自动摘要，原文 N 字符]`。
- 两种模式最后都按**请求体 20KB** 硬上限做二次收缩：如果头部 + 正文 + 标记的 JSON 字节数超过 20480，
  会二分查找出还能放下多少字符并再次追加截断标记（此时标记里的 N 仍是原始长度）。
  签名开启时会按 `timestamp`(10 位) + `sign`(44 位) 的等长占位符预估，保证真实请求也不会超。

---

## 重试与告警规则

### 重试（R4）

| 情况 | 是否重试 |
| --- | --- |
| DNS/连接失败、请求超时 | ✅ 重试 |
| HTTP 429 | ✅ 重试 |
| HTTP 5xx | ✅ 重试 |
| HTTP 200 + 飞书 `code=9499`（限流） | ✅ 重试，并优先遵守 `Retry-After` |
| HTTP 200 但其他 `code !== 0`（如 19021 签名错误） | ❌ 不重试，直接失败 |
| 其他 4xx（400/403/404…） | ❌ 不重试，直接失败 |
| 插件卸载导致的中断 | ❌ 不重试 |

- 延迟：`500ms × 2^(n-1)` → 第 1 次重试前 500ms、第 2 次前 1000ms；服务端返回 `Retry-After` 时取两者较大值；单次退避最多 30 秒，避免极大 `retries` 把定时器撑爆。
- 响应体最多读取 64KB；超出的部分直接丢弃，避免异常端点把内存打满。
- 次数：`retries` 是**总尝试次数**，默认 3 次（首发 + 2 次重试）。
- 重试是“至少一次”语义：服务端已收到但响应超时/5xx 时，可能重复推送；飞书自定义机器人没有幂等键。

### 告警（R5）

- 每个业务 Webhook **独立**计数；某次推送成功会把该 Webhook 的连续失败计数清零。
- 连续**最终推送失败**次数 `>= alertThreshold`（默认 3）且距上次告警超过 `alertCooldownMs`（默认 5 分钟）时，发一条：

  ```
  ⚠️ DSH 推送告警
  已连续失败 3 次
  最新失败原因：HTTP 500 {"code":500,...}
  webhook：https://open.feishu.cn/open-apis/bot…
  时间：2026/11/6 01:20:11
  请检查飞书机器人是否被移除、签名密钥是否正确、或群是否触发限流。
  ```

- **告警通道**：优先发到 `alertWebhook`（可多个），没配置才回退到出问题的业务 `webhook`。业务 Webhook 整体失效时，独立告警通道仍然可用——这正是把告警和业务分开的原因。
- **告警成功后**：连续失败计数清零、冷却期重新开始。
- **告警失败后**：也会进入冷却期（`recordAlertFailed`），避免每个回合都重复 3 次业务推送 + 3 次告警重试；下一次告警要等冷却期结束。
- 告警自己也会走同一套重试逻辑；告警再失败只记日志，不会无限套娃。
- `alertThreshold` 统计的是“最终推送失败”的次数，不是 HTTP 尝试次数；`retries: 3` 时，一次业务失败最多算 1 次，不会因为内部重试 3 次就立刻触发告警。

---

## 自测

不需要任何测试框架，也不需要安装依赖：

```powershell
cd dsh-feishu-digest
npm test
# 等价于：
node test/sign.test.js
node test/listener.test.js
node test/pipeline.test.js
```

三个脚本全部本地运行、不联网，共 99 项检查：

`test/sign.test.js`（26 项）覆盖：

1. **签名**：与固定向量比对（`timestamp=1700000000` / `secret=test-secret-123` → `daPkaWCRHAAXQst93vVK9sXdMJfjB35Ze8NS9EabjgM=`），验证长度、换 key 会变化。
2. **报文格式**：起一个本地 http server 当假 webhook，断言 `POST`、`Content-Type: application/json`、
   `{msg_type:"text", content:{text}}`、项目/对话/任务名顺序、状态行/耗时/结束时间/分隔线/正文齐全；开签名时 `sign` 可复算。
3. **重试**：服务端返回 500 → 尝试 3 次后失败，且总耗时符合指数退避；429 会重试；400 不重试；**HTTP 200 + code=19021 判失败且不重试**。
4. **告警**：3 次失败触发一次告警，冷却期内不重复，冷却结束才再次告警，告警内容含失败原因且 webhook 打码。
5. **截断**：`outputMode: full` 下超长文本带 `[已截断，原长 N 字符]`；请求体始终 ≤ 20KB（含 emoji 与签名占位）。
6. **加载**：没配 webhook 时 `apply()` 不抛错、打印 warning 并输出 `loaded`；数组 webhook 会逐个发送。

`test/listener.test.js`（51 项）覆盖：

1. **配置**：空串/空数组回退环境变量、显式配置优先、非法 URL 收集、告警通道/密钥归一化、`outputMode`/`summaryMaxChars` 默认值与边界。
2. **Config 校验**：允许空配置；拒绝错误的 `includeSubagents`/`outputMode`/`alertWebhook` 类型。
3. **摘要**：短文本不摘要；长结构化文本保留标题与结论且不超限；按段取句头并保留数量/失败原因；丢弃 how-to 与“说明/其他”填充段；默认最多 6 条；`composeMessageText` 默认摘要并标注原文长度；`full` 模式保留截断标记；`apply` 实际发送时默认也是摘要而不是全文。
4. **多回合（P2-1）**：第 2 回合的任务名取当前回合 prompt，而不是会话首条 prompt；重复 `turn/end` 只推送一次。
5. **子代理**：默认跳过 subagent；`includeSubagents: true` 放行。
6. **中止与安全**：已中止的 `postOnce` 不发起 fetch；`sendWithRetry` 返回 `attempts: 0`；畸形 URL 的错误文本不含完整 token。
7. **告警路由（P2-2）**：业务失败时告警走独立 `alertWebhook`；告警失败后进入冷却、下一回合不重复告警；多个业务 Webhook 中一个失败不影响另一个。
8. **1.2.x 新行为**：项目/对话/任务名顺序；cwd 取项目名；对话取最新 `session/title`（多条标题时取最后一条，跳过 `source.kind=fallback` 的首条 prompt）；`<at>` 标签中和；结束时间时区；`code=9499` 重试；`Retry-After`；超时语义；64KB 响应上限；同一 Webhook 串行队列；Config 越界拒绝。

`test/pipeline.test.js`（22 项）覆盖：

1. **清洗**：删 `【自动摘要…】` 尾注、省略号独占行、4+ 分隔线；兜底只留前 8 个非空行、总长 ≤300。
2. **渲染**：一行型 ≤80 字；卡片按结论 → 产物 → 需要你 → 风险排列且 ≤200 字；空风险整行省略；「查看原文」按钮；签名卡片请求体。
3. **路由**：progress 默认丢弃、finish 不丢；error/failed 红色卡片；warning 橙色；success+待办或含失败项蓝色 LLM 卡片；“失败 0 项”仍走一行。
4. **聚合与归档**：满 5 条立即 flush、窗口到期 flush；归档按内容哈希命名、重复写入幂等。
5. **检验验收**：3 条 success 无待办只发 1 条汇总卡；LLM 抛错时降级本地卡片；失败红色卡片；卡片发送失败降级一行型。
6. **配置**：14 个新配置项的默认值、覆盖与非法值拒绝。

预期最后一行：`全部通过 ✅`。

---

## 常见问题

### 1. 报 `code: 19021 sign match fail`（签名错误）

- 飞书后台**开了**签名校验，但插件没配 `secret`；或者配了 `secret` 但后台**没开**（这时飞书其实不校验，但也可能是密钥抄错了）。
- 密钥带空格/换行最容易被忽略——插件会 `trim()`，但仍建议重新复制一遍。
- 算法是：`key = `${timestamp}\n${secret}``，对**空字符串**做 HMAC-SHA256 再 base64，`timestamp` 是**秒**（10 位）。
  插件内置的 `computeSign()` 可直接复算核对。
- 另外注意：如果飞书后台配置了 **IP 白名单**，请求来源 IP 不在白名单里也会失败。

### 2. 重启了但一条都没收到

按顺序排查：

1. 日志里有没有 `[dsh-feishu-digest] loaded`？没有 → 插件没挂上：
   - `dsh --profile web --dump-config` 里搜 `feishu-digest`，没有就是 `dsh.profile.bundles` 没加、或者 `package.json` 的 `files` 漏了 `cordis.patch.yml`（装上但不生效的典型原因）；
   - 用 `DSH_FEISHU_DEBUG=1` 启动能看到全部日志。
2. 有 `loaded` 但显示 `disabled：no webhook` → 配置没被读到：确认写在**当前 profile** 的 `cordis.patch.yml` 里（不是包目录里的示例文件），id 必须是 `feishu-digest`。
3. 有 `检测到任务结束` 但 `推送失败` → 看失败原因：`HTTP 404` 一般是 Webhook 抄错或机器人已被移除；`HTTP 400` 多为机器人被停用/关键词不匹配。
4. 任务确实是**子代理**跑的（subagent / fork）→ 默认不推送，配置 `includeSubagents: true`。
5. 你在看的是**别的 profile**（`web` / `tui` / `desktop` 是互相独立的配置）。

### 3. 收到 `400 Bad Request` 或 `请求体过大`

飞书消息有体积限制，本插件把**整个请求体**卡在 20KB（20480 字节）以内，正常不会触发。真的遇到了：

- 1.4 的卡片正文默认 ≤200 字；把它调小（`cardBodyMaxChars`，最小 80）。
- 一行型默认 ≤80 字；把它调小（`oneLineMaxChars`，最小 40）。
- 如果还超，说明归档路径/按钮等元数据异常，先看日志里的实际请求体大小。
- 注意 20KB 是**字节**不是字符：中文 1 字 ≈ 3 字节，8000 个中文字符 ≈ 24KB，
  所以中文长输出会被 20KB 规则二次截断——这是预期行为，标记会写明原始长度。

### 4. 触发了限流（429 / `code: 9499`）

飞书自定义机器人有频率限制（同一机器人 100 次/分钟、5 次/秒量级）。本插件会把 HTTP 429 和飞书 `code=9499` 都当作可重试错误，
最多再试 2 次（默认 500ms、1000ms 退避；服务端给了 `Retry-After` 就按它等）；仍失败就记日志，连续 3 次失败发告警。
同一 Webhook 的推送已经串行排队，不会因为多个回合并发而瞬间打爆限流。
如果你把 `includeSubagents` 打开了、又用了很多子代理，建议关掉它，或把 `alertThreshold` 调大。

### 5. 一条任务收到了两条通知

- 同一回合只会推一次（插件对 `session:id + turn` 做了去重，并跳过重放的历史事件）。
- 两条通常是：主会话 + 子代理会话各一条（关掉 `includeSubagents`），或者你在两个 profile 里都装了插件。

### 6. 消息里中文变乱码 / 换行丢了

飞书 `text` 消息按 UTF-8 解析，插件发的就是 UTF-8 JSON。乱码一般出现在「用 GBK 控制台看日志」时，
消息本身的字节是对的（可以在浏览器 DevTools 或飞书客户端里确认）。

### 7. 摘要看起来漏了重要内容

- 1.4 的卡片只保留结论、产物、需要你、风险；没有小标题的纯散文会退化成少量首句。
- 需要更多内容时调大 `cardBodyMaxChars` / `oneLineMaxChars`，或在 prompt 里要求 Agent 输出“结论 / 变更 / 验证 / 风险”这类结构化小标题。
- 逐字全文在归档目录（`archiveDir`）里；飞书端不再发送全文。确实要发全文时，请自行在 Agent 侧改输出，而不是依赖本插件。

### 8. 告警没收到 / 告警也发不出去

- 先确认 `alertWebhook` 是否配置；没配置时告警回退到业务 `webhook`，业务 Webhook 整体失效时告警也会失败。
- 告警失败后会进入 `alertCooldownMs` 冷却，不会每回合重复刷；看日志里的 `⚠️` 和 `推送失败` 记录。
- 告警群和业务群不是同一个机器人时，`alertSecret` 必须单独配置；只配 `secret` 不会自动套用到告警群。

### 9. 会不会拖慢任务 / 把任务搞挂？

不会。`turn/end` 是「提交后即发即忘」的广播事件，插件在这个回调里只做内存组装，网络请求异步执行且不 `await` 到 DSH 的主循环；
同一 Webhook 的请求进入串行队列，不同 Webhook 互不阻塞。所有回调都包在 `try/catch` 里，异常只写日志。插件卸载时还会 `AbortController.abort()` 掉在途请求。

---

## 卸载

```powershell
# 用 pnpm 装的
dsh plugin --profile web remove dsh-feishu-digest
```

手动装的：从 profile 的 `package.json` 里删掉依赖和 `dsh.profile.bundles` 里的条目，再删掉
`profiles\<profile>\node_modules\dsh-feishu-digest`，最后把 `cordis.patch.yml` 里那段 `- id: feishu-digest` 删掉。

---

## 部署前合规确认（P2-3）

这个插件会把 Agent 的任务名、状态、耗时和**输出内容**发送到飞书群。默认摘要降低了暴露面，但没有消除风险；生产部署前请逐项确认：

- [ ] **群范围**：接收群是否只有必要成员？是否允许外部成员、访客或机器人转发？
- [ ] **数据分类**：Agent 输出是否可能包含源代码、密钥、客户数据、个人信息、内部路径或未公开计划？
- [ ] **外发授权**：把上述内容发送到飞书（第三方 SaaS）是否已获得团队/客户/合规负责人授权？
- [ ] **保留策略**：飞书群消息、机器人日志、DSH 日志分别保留多久？是否有删除/导出流程？
- [ ] **最小化**：能否调小 `oneLineMaxChars` / `cardBodyMaxChars`、关闭 `llmEnabled`，或只对特定项目开启？
- [ ] **告警通道**：`alertWebhook` 是否指向受控的运维群，而不是外部群？
- [ ] **密钥管理**：Webhook 是否只放在 profile 配置或环境变量中，没有提交到 Git、截图或工单？

如果以上任何一项无法确认，建议先不要在生产 profile 启用，或只在隔离的测试群/测试项目里使用。插件本身不提供字段级脱敏、DLP、审计留痕或数据删除能力，这些需要部署方自行补齐。

---

## 隐私与安全

- 代码里**没有任何**硬编码的 Webhook、token 或密钥；`config.example.yml` 里也全是占位符。
- 日志里的 Webhook 一律打码（只留协议+域名+路径前 12 个字符），`userinfo`、query、hash 都会被去掉；非法 URL 只打印固定占位符，不会把完整 token 写进日志或告警消息。
- 生产 Webhook 只接受 `https`，`http` 仅允许 localhost 回环，避免 token 明文上网；插件不读取 `HTTP(S)_PROXY`，企业代理/自签 CA 场景需要自行在 Node 层配置。
- 默认发送的是「项目 + 对话 + 任务名 + 结论/产物/待办/风险」；原文归档到本地 `archiveDir`，不再整段发到飞书。精简结果仍可能包含代码片段、路径、错误信息等敏感内容，不是脱敏器。
- 正文中的 `<at ...>` 会被中和为全角字符，降低 @全体 注入风险；但这只是文本层防护，不替代内容审核。
- 如果启用 `llmEnabled`，命中的卡片正文会发给配置的 DSH LLM provider；不需要外部模型时保持 `false`，全走本地兜底。
- 插件只往外发消息，不读取群消息、不处理回调，没有任何入站通道。
- 归档文件可能包含完整 Agent 输出，属于本地敏感数据；插件没有自动删除/保留策略，需要部署方按 `archiveDir` 自行清理、加密或纳入备份策略。

---

## 实现说明

| 关注点 | 做法 |
| --- | --- |
| 触发点 | `ctx.on('session/event', (session, event) => …)`，只处理 `turn/start`、`user/message`、`assistant/message`、`turn/end` |
| 耗时 | `turn/end.time - turn/start.time`（`SessionEvent.time` 是 Unix 毫秒） |
| 最终输出 | 本回合最后一条**非空** `assistant/message` 里 `content` 中 `type === 'text'` 的块拼接（不含 reasoning / tool-call） |
| 精简路由 | `routeNotifyEvent()` 纯规则：失败/错误红卡、warning 橙卡、progress 默认丢弃、success+待办或失败项蓝卡（LLM）、其余一行型；finish/error 永不丢 |
| 卡片摘要 | LLM 可用时按附录提示词输出 JSON；失败/超时/非法 JSON 走 `digestFromText()` 本地兜底；commit 以结构化字段为准覆盖 |
| 原文归档 | `createArchive()`：`sha256(原文)[:8].md`，`flag: 'wx'` 幂等；发送前写盘，卡片的「查看原文」指向 `archiveBaseUrl` |
| 聚合 | `createAggregator()`：key=`(项目, 对话)`，一行型缓冲，30 分钟或满 5 条 flush 成汇总卡 |
| 项目名 | `session.header.cwd` 的 basename；根目录/空值回退 `(未知项目)` |
| 对话名 | 会话日志最新一条非 `fallback` 的 `session/title`；日志不可读时用 `ctx.sessionTitle.get(session).title` 快照；都没有才回退 `(未命名对话)`。不取首条 prompt |
| 任务名 | 本回合首条 `source.kind === 'user'` 的 prompt → `(未命名任务)`；不再使用会话标题 |
| 去重 | `session.id + turn` 的 FIFO（上限 500），跳过重放与重复广播；不是 LRU |
| 发送队列 | 同一 Webhook 一条串行队列，按到达顺序发送；不同 Webhook 互不阻塞 |
| 响应读取 | 流式读取，最多 64KB；超限取消并截断，避免异常端点耗尽内存 |
| URL 校验 | `new URL()` 解析；`https` 一律允许，`http` 仅允许 localhost/127.0.0.1/::1 |
| 子代理 | `header.origin === 'subagent'`、有 `parentSession`、或 `delegationDepth > 0` 时跳过（可配） |
| 告警路由 | 业务推送失败达阈值后，优先发 `alertWebhook`；未配置才回退到出问题的业务 `webhook`。告警成功或失败都会进入冷却 |
| 配置校验 | 导出 Standard Schema 形状的 `Config`（`{'~standard': {version, vendor, validate}}`），`webhook` 缺失不算错误 |
| 插件对象 | 默认导出 `{ name, inject: ['sessions'], Config, apply }`，DSH 以 `apply(ctx, config)` 调用 |
| 依赖 | 仅 `node:crypto`；`fetch` / `AbortController` / `Buffer` 都是 Node 内置 |

---

## 开源与品牌使用

这个项目使用 **MIT License**，是 OSI 认可的开源许可证：任何人都可以复制、修改、分发，包括商业使用，只要保留版权声明和许可证文本。

这意味着：

- **无法用 MIT 阻止别人复刻代码**，也无法阻止别人基于它做商业产品；这是选择 MIT 的代价，也是它能被广泛采用的原因。
- 项目**不做**代码混淆、License 激活、DRM 或“禁止复制”的技术限制；这些手段对 JavaScript 只能提高成本，不能真正保密。
- 能保护的是**品牌和署名**：`dsh-feishu-digest` 的名称、Logo 和“上游项目”身份不被授权用于暗示背书。Fork 请保留 `LICENSE` 和 [`NOTICE`](./NOTICE)，并明确标注“这是 fork，不是上游官方版本”。
- 如果你需要“源码可见但禁止商用/禁止复刻商用”，MIT 不适用；应改用 source-available 许可证，或把核心逻辑放到私有包/远程服务。具体边界见 [`NOTICE`](./NOTICE)。

## License

MIT，见 [LICENSE](./LICENSE)。版权、品牌/商标与 fork 说明见 [NOTICE](./NOTICE)。
