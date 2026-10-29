# QQ Bot (官方机器人) 适配器

Yunzai NG 的 QQ 官方机器人适配器，通过 QQ 开放平台 API v2 接入，支持 WebSocket Gateway 与 Webhook 两种连接模式，  
覆盖群聊、C2C 私聊、频道、频道私信四大场景。支持富媒体（图片 / 视频 / 语音 / 文件）发送、  
图文卡片（`share` 段）、多种 Markdown 发送模式与交互键盘；图片地址走**三级图床链路**  
（插件实现的 `imageToUrl` → 官方素材库 → 框架文件服务），插件只需把自己那级交出来。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 前置条件

1. 前往 [QQ 开放平台](https://q.qq.com) 注册开发者账号并创建机器人应用
2. 获取 **AppID** 和 **AppSecret**（应用管理 → 开发设置）
3. 根据使用场景选择连接方式：
   - **WebSocket Gateway**（推荐）：框架主动连接 QQ 官方 Gateway，实时接收事件
   - **Webhook 回调**：QQ 平台将事件 POST 至框架，适用于无法建立长连接的环境
4. 如需测试，可在应用管理中开启 **沙箱模式**

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `adapter-qqbot` → 安装。**装依赖与编译都由内核代跑**  
（索引里声明了 `setup.scripts: ["build"]`），故这条路装完即可用 —— 本仓库的 `dist/` 不进 git，  
不编译就没有入口。

亦可手工克隆至主目录的 `plugins/` 下，那时两步都要自己来：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-qqbot.git
cd adapter-qqbot
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

## 配置

在面板的账号页面添加 QQ Bot 账号。基础项如下，其余配置分散在对应的功能章节里：

| 配置项        | 说明                                  | 默认值               |
| ---------- | ----------------------------------- | ----------------- |
| 连接方式       | `WebSocket Gateway` 或 `Webhook 回调`  | WebSocket Gateway |
| AppID      | QQ 开放平台分配的机器人 AppID                | 必填                |
| AppSecret  | QQ 开放平台分配的机器人密钥                     | 必填                |
| 机器人 QQ 号   | 机器人的真实 QQ 号，用于日志显示                  | 留空                |
| 沙箱模式       | 使用沙箱环境进行测试                          | 关闭                |
| 事件订阅       | 预设订阅模式，仅 WebSocket 模式（见下）           | 群聊                |
| 分片配置       | `分片ID/分片总数`，如 `0/1`，仅 WebSocket 模式 | 0/1               |
| Webhook 监听路径 | Webhook 模式下接收事件的 URL 路径            | /qqbot            |

### 事件订阅预设

| 预设        | 说明                   | 适用场景     |
| --------- | -------------------- | -------- |
| 频道公域      | 公域频道消息 + 基础事件        | 公域机器人    |
| 频道私域      | 私域频道消息 + 论坛事件 + 基础事件 | 私域机器人    |
| 群聊        | 群聊和 C2C 私聊事件         | 群聊机器人    |
| 频道公域 + 群聊 | 公域频道 + 群聊            | 同时接入频道和群 |
| 频道私域 + 群聊 | 私域频道 + 群聊            | 同时接入频道和群 |

> 频道公域与私域**不能同时订阅**，这是 QQ 开放平台的限制。

各预设可接收的事件清单、与内核事件模型的完成度对照见 [docs/EVENTS.md](docs/EVENTS.md)。

### Webhook 回调

选择 **Webhook 回调**后按四步走：

1. **让 yunzai-ng 有公网可访问地址**（frp、ngrok 等内网穿透均可）
2. **面板填配置**：连接方式选 `Webhook 回调`，填 AppID 与 AppSecret（后者用于 Ed25519 签名验证）
3. **在开放平台配回调地址**：[Webhook 设置](https://q.qq.com/qqbot/#/developer/webhook-setting) 填  
   `https://你的公网域名:端口/plugin/adapter-qqbot/qqbot`，端口只允许 **80 / 443 / 8080 / 8443**
4. **保存地址**：平台会发 `op=13` 验证请求，适配器自动返回签名完成验证

> 回调地址必须是 HTTPS 且端口在允许范围内。用内网穿透时，确保穿透工具监听的是允许端口。

多个账号共用同一条回调路由，适配器按请求头 `X-Bot-Appid` 区分，无需为每个账号配不同地址。

### 沙箱模式

开启后 WebSocket 地址切换为 `wss://sandbox.api.sgroup.qq.com/websocket`、API 地址切换为  
`https://sandbox.api.sgroup.qq.com`，只能收到沙箱环境的测试事件，适用于开发调试。

## 消息发送

### Markdown

| 配置项          | 说明                            | 默认值         |
| ------------ | ----------------------------- | ----------- |
| 频道 Markdown  | 频道消息使用 Markdown 格式发送          | 关闭          |
| 群聊 Markdown  | 群聊消息使用 Markdown 格式发送          | 关闭          |
| Markdown 模式  | 上述开关打开后的发送策略（见下表）            | 原生 Markdown |
| Markdown 模板 ID | 模板模式使用的 `custom_template_id` | 留空          |
| 模板参数键        | 按顺序填写模板参数 key，如 `abcdefghij` | abcdefghij  |
| 键盘模板 ID      | 留空按消息按钮生成键盘，填写后使用平台按钮模板       | 留空          |

频道与群聊是**分场景开关**，两者独立；打开后按 **Markdown 模式** 选定的策略发送：

| 模式          | 说明                                 |
| ----------- | ---------------------------------- |
| 原生 Markdown | 原生 Markdown 消息 + 交互键盘（按钮渲染为 QQ 键盘） |
| 内联指令        | 原生 Markdown + 文本指令链（按钮转为可点击的文本指令）  |
| 模板 Markdown | 按模板 ID 与参数键发送，内容超出参数槽位自动拆分为多条      |
| 纯文本         | 禁用富 Markdown，按普通文本消息拆分发送           |

> 模板模式未填模板 ID 时自动退回纯文本。

**文本交互**（[官方说明](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)）：  
`at` / `atAll` / `face` 段按场景自动转成 `<qqbot-at-user>`、`<qqbot-at-everyone />`、`<emoji:id>`，  
平台不支持时降级为文本并告警（群聊 @用户 仅 Markdown 可用，系统表情与子频道跳转仅文字子频道）。  
指令与子频道跳转用 `raw` 段收发：

```ts
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "cmd-enter", text: "/签到" } }
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "cmd-input", text: "/查询 ", show: "查询", reference: false } }
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "channel", channelId: "123" } }
```

指令仅 Markdown 可用，`text` / `show` 上限 100 字符、由适配器 URL 编码；回车指令只在 C2C 生效，  
群聊与频道会改为输入框指令。

### 图文卡片

`share` 段在群聊 / C2C 发送为 `msg_type=8` 的图文卡片（`card.type=tuwen`），频道与频道私信没有  
卡片能力，降级为文本：

```ts
{ type: "share", url: "https://example.com/news", title: "标题", content: "摘要", image: "https://example.com/cover.jpg" }
```

四要素全是平台硬要求：`title` 1-50 字符、`description` 1-200 字符、`url` 与 `pic_url` 必须 https 且  
≤1024 字符，缺一项就整条被判「消息类型与内容不匹配」。因此适配器逐项处理：

| 字段           | 处理                                 |
| ------------ | ---------------------------------- |
| 标题 `title`   | 留空用链接兜底；超长按码点截断并补省略号（不切 emoji）    |
| 描述 `description` | 留空用标题兜底；超长同上                  |
| 链接 `url`     | 非 https 时**整条退回文本**                |
| 封面 `pic_url` | 缺图或非 https 时**整条退回文本**             |

宁可降级成「标题 + 摘要 + 链接」的文本并告警，也不发半成品卡片。

### 富媒体

平台限制一条消息只能携带一个富媒体元素，适配器会把含多个富元素的消息拆成多条按序发送。

| 配置项    | 说明                                | 默认值 |
| ------ | --------------------------------- | --- |
| 图片压缩上限 | sharp 可用时压缩超限图片，未安装则原样发送（MiB）    | 4   |

各场景能力：

| 场景          | 图片              | 视频   | 语音   | 文件   |
| ----------- | --------------- | ---- | ---- | ---- |
| 群聊 / C2C 私聊 | 富媒体             | 富媒体  | 富媒体  | 富媒体  |
| 频道 / 频道私信   | multipart 或 URL | 降级文本 | 降级文本 | 降级文本 |

群聊 / C2C 走官方富媒体接口：

- 源是公网 URL 时优先交给平台转存，转存失败则本机下载后走官方分片上传
- 其余来源（本地路径 / Buffer / base64）走分片上传：预上传 → 并发 PUT 分片 → 合并，  
  自动计算 MD5 / SHA1 并按服务端配置重试
- **Markdown 图片不能走富媒体接口**，必须经图床转成公网 URL 或 `qqbot-media://` 引用，见下节

频道场景的本地图片走 multipart `file_image` 直传，公网 URL 图片直接填 `image` 字段。

### 转发消息

「转发消息格式」取 `合并`（默认）或 `多条`：

| 格式 | 说明                |
| -- | ----------------- |
| 合并 | 多个节点合并进一条消息发送     |
| 多条 | 每个节点各自作为一条消息发送    |

含图片 / 视频等富媒体的节点因平台单条限制仍会单独成条，无法展开的转发段降级为文本占位。

### 接收附件

群聊、C2C 私聊、频道与频道私信收到的 `attachments` 统一转换为内核消息段：

| QQ 附件 MIME 类型            | 内核消息段    |
| ------------------------ | -------- |
| `image/*`                | `image`  |
| `audio/*`                | `record` |
| `video/*`                | `video`  |
| 其他（PDF、压缩包、Office 文档等）    | `file`   |

`file` 段保留 QQ 给的下载 URL、原始文件名与大小；适配器**不在接收时下载附件**，由使用方按需处理。

### 消息去重与重复回复

平台会把同一条入站消息**重复推送**（WebSocket 重连补发、Webhook 重试、平台侧抖动），
按 `msg_id` 直接处理会让一次提问触发多次回复。适配器在事件入口统一去重：

| 行为 | 规则 |
| --- | --- |
| 去重键 | `场景:messageId`，仅作用于消息事件，通知类事件不去重 |
| 窗口 | 5 分钟（与被动回复额度一致），窗口内同一条消息只提交内核一次 |
| 容量 | 最多 2000 条，超出按插入顺序淘汰最旧；过期项在写入时顺带清理 |

出站方向是另一回事：`msg_id` + `msg_seq` 是平台侧的**幂等键**，同一对值重复发送会被判为重复请求而失败。
因此同一条入站消息的多次回复（比如先回一句「处理中」再回结果）必须递增 `msg_seq`，适配器已自动处理：

| 场景 | `msg_seq` |
| --- | --- |
| 被动回复（带 `msg_id` / `event_id`） | 同一锚点从 `1` 开始递增，窗口结束后重新从 `1` 计数 |
| 主动推送（无锚点） | 随机值，不占用被动回复的序号空间 |
| 触顶 60000 | 回绕到 `1`（同一条消息回复 6 万次不现实，回绕只为不越出平台区间） |

一条消息被拆成多条发送（多富元素、Markdown 图文混排）时，每条各自取号，不会撞车。

## 图片地址

QQ 拉图是**服务器行为**，因此地址必须公网可达。适配器按链路取址，前一级不可用才走下一级：

| 顺序 | 通道    | 图片去向                                     | 生效条件                          |
| -- | ----- | ---------------------------------------- | ----------------------------- |
| 1  | 自定义图床 | 插件 `imageToUrl` 返回的地址                    | 插件用 `ctx.provide` 交出该函数；没装则公网直链原样用 |
| 2  | 官方图床  | QQ 素材库，换取 `qqbot-media://` 引用            | 官方图床开启、配额未满                   |
| 3  | 框架图床  | 内置 `/plugin/adapter-qqbot/file/:name` 路由 | 文件服务地址公网可达                    |

全链路不可用时图片降级为文本占位，日志里逐级说明失败原因。Markdown 图片无法走富媒体接口，需以  
`![摘要 #宽px #高px](url)` 嵌入 —— 平台要求显式声明尺寸，适配器会自动解析图片宽高。

相关配置：

| 配置项    | 说明                          | 默认值   |
| ------ | --------------------------- | ----- |
| 官方图床   | 上传到 QQ 素材库换取 `qqbot-media://` 引用 | 开启    |
| 文件服务地址 | 内置文件服务的对外基址；留空用内核面板地址        | 留空    |
| 图片保存时间 | 素材保留时间（秒），也是配额满时的清理依据        | 14400 |

> 旧配置里的「图床类型」「图床脚本路径」已移除，打开面板保存一次即自动迁移：  
> 选过框架图床的按关闭官方图床处理，脚本路径直接丢弃（改为插件 provide，见下）。

### 自定义图床（插件实现 `imageToUrl`）

**方向是适配器调用插件，不是插件调适配器。** 想做自己的图床，就在插件里实现一个 `imageToUrl`  
函数、用 `ctx.provide` 交出来；适配器需要地址时会先问它，拿到 URL 直接用：

```js
import { definePlugin } from "@yunzai-ng/core"

export default definePlugin({
  name: "my-image-host",
  setup(ctx) {
    ctx.provide("qqbot.imageToUrl", async (file, opts) => {
      // file: http(s) 链接 / 绝对路径 / base64:// 是字符串，渲染产物是 Buffer
      // opts: { filename?, mime? }
      if (typeof file === "string" && file.startsWith("http")) return file

      const url = await uploadToMyCdn(file, opts)
      if (!url) return undefined        // 这次处理不了，交给官方图床
      return url                       // https://cdn.example.com/xxx.png
    })
  }
})
```

| 项      | 说明                                                       |
| ------ | -------------------------------------------------------- |
| 服务键    | `"qqbot.imageToUrl"`（即 `adapter-qqbot` 导出的 `CUSTOM_IMAGE_KEY`） |
| `file` | `http(s)` 链接 / 绝对路径 / `base64://` 是字符串，字节是 `Buffer`      |
| `opts` | `filename`（含扩展名）、`mime`                                    |
| 返回值    | `http(s)://` 或 `qqbot-media://`；`null` / `undefined` / 空串表示交给下一级 |

<details>
<summary>行为细节（写图床插件时再看）</summary>

- **只在需要时被调用** —— 图片本来就是公网直链、或消息用不到地址时，插件不会被打扰
- 返回值只认 `http(s)` 与 `qqbot-media://`，相对路径一类判无效并继续下一级（否则会变成裂图）
- 函数抛错按「这次不行」处理：记一条 warn 后走官方图床，不中断发送
- 每次取址都**现查服务表**，插件后加载、面板热重载、卸载都立刻生效，不用重连账号
- `127.0.0.1` / 内网地址 QQ 拉不到，适配器会本机下载字节后再交给官方 / 框架上传

</details>

> 内核不支持全局 `Bot`，所以没有 `Bot.imageToUrl` 这种写法；交接一律经 `ctx.provide` / `ctx.inject`。

### 官方图床

把图片预先上传到 QQ 素材库，Markdown 里引用平台返回的 `qqbot-media://` 链接。**不依赖公网地址**，  
内网部署、没有穿透域名的机器人也能正常显示图片。

上传对插件透明：申请上传任务拿直传地址 → 直传二进制 → 确认完成换回引用链接，全程在发送前自动进行，  
失败自动降级。平台限制：单张 ≤10MB、仅 `png / jpeg / gif / webp`、**单机器人 100 张**、引用滑动过期  
（被消息引用即顺延，90 天未引用才失效）。适配器按内容哈希本地去重，同一张图在保存时间内只传一次。

<details>
<summary>配额与清理机制（发图量大时再看）</summary>

| 环节   | 行为                                                                 |
| ---- | ------------------------------------------------------------------ |
| 保存时间 | 默认 `14400`（4 小时，与上传任务有效期对齐），上限 `7776000`（90 天）；同时是去重有效期与清理判定线 |
| 定时清理 | 连接成功后启动，按保存时间的 1/4（最短 5 分钟、最长 24 小时）删超期图；连接后 30 秒补跑一轮，断开即停止 |
| 配额满  | 删超期旧图后重试一次；若全都还在保存时间内，告警并**回退框架图床**                                |
| 释放节流 | 释放动作 5 分钟内只做一次，期间再遇配额满直接交给框架图床，避免每张图白跑一次列表 + 删除                    |

100 张上限是给**发图量大**的机器人准备的 —— 每条消息里新出现的图片都占一张，靠「图片保存时间」滚动清理  
才能把配额让给新图。删除**不影响已发送的消息**（平台发送时已转存副本），只让引用链接失效；适配器会同步  
失效本地缓存，同一张图再发会重新上传。

</details>

### 框架图床

把图片发布到内置的 `/plugin/adapter-qqbot/file/:name` 路由，供 QQ 服务器拉取：

- **文件服务地址**是该路由的对外基址，留空时用内核面板的公网地址
- **必须公网可达**：`localhost` / `127.0.0.1` / `10.x` / `172.16-31.x` / `192.168.x` / `[::1]` /  
  `*.local` 以及只能内网解析的单标签主机名（如 `myserver`）都会**被直接跳过** —— QQ 拉不到，  
  发出去就是裂图。保存配置时面板会给出提示
- 文件保留 5 分钟（QQ 渲染消息时即刻拉取），最多驻留 100 个，超限自动淘汰

## 开发

### 源码布局

按**领域**分目录，依赖只能从下往上单方向引用，同层不互相 import：

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/index.ts` | 插件入口：注册适配器、Webhook 路由与文件路由 | — |
| `src/config.ts` | 账号配置 schema、校验与旧配置迁移 | — |
| `src/protocol/` | 平台协议：报文 DTO、段编解码、Markdown、图文卡片、文本交互标签 | `types` `codec` `markdown` `card` `interaction` |
| `src/transport/` | 与平台的 IO：令牌、HTTP 调用、WebSocket、Webhook（含签名与注册表）、富媒体上传 | `auth` `api` `gateway` `webhook` `upload` |
| `src/media/` | 媒体：字节解析、三级图床、官方素材清理、框架文件服务 | `resolve` `image-to-url` `official-image-host` `file-server` `probe` |
| `src/messaging/` | 消息编解码：平台事件 → 内核事件，内核段 → 出站计划 | `inbound` `outbound` |
| `src/bot/` | BotDriver 组合：上下文、连接、发送、查询、群管 | `context` `connection` `send` `query` `manage` |
| `src/shared/` | 零业务语义的通用工具：公网地址判定、可选依赖加载 | `public-url` `optional-deps` |

依赖方向（箭头表示「允许依赖」）：

```
shared ← protocol ← transport ← media ← messaging ← bot ← index
```

`protocol` 全是纯函数与类型，不碰网络与文件；一旦某段逻辑需要 `fetch` 或 `readFile`，它就不属于 `protocol`。

各目录的 `index.ts` 是该领域的统一出口，外部（入口与测试）只认出口、不深引实现文件。

### 环境与脚本

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`  
（运行期由宿主内核提供，插件目录内不应再装一份）。

<details>
<summary>首次开发：链接本地框架 checkout</summary>

**框架发布至 npm 之前**，本插件的 `tsc` 需要读取框架的 `dist/*.d.ts`，故要先构建一份本地框架：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build

cd ..\adapter-qqbot
pnpm install
pnpm run build
```

</details>

常用脚本：

```powershell
pnpm run build    # 编译（tsc -b）
pnpm run test     # 运行 vitest 测试
pnpm run lint     # ESLint 检查
pnpm run verify   # build + 测试类型检查 + lint + test 一键校验
```

增强依赖 `sharp` / `qrcode` / `silk-wasm` 声明为 `optionalDependencies`：未安装时相关增强功能  
自动降级（含「图片压缩上限」，默认 4 MiB），基础收发不受影响。

接口与事件细节见 [docs/API-REFERENCE.md](docs/API-REFERENCE.md)、[docs/EVENTS.md](docs/EVENTS.md)、  
[docs/CORE-EVENTS.md](docs/CORE-EVENTS.md)；内核事件与 QQ 事件的完整对照分析（含已知缺陷与验证脚本）见  
[docs/EVENT-ANALYSIS.md](docs/EVENT-ANALYSIS.md)。

## 许可

AGPL-3.0-or-later
