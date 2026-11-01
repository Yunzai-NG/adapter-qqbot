# 消息发送

消息段如何编码、各场景有哪些能力限制、平台幂等键怎么处理，都在这一篇。

## Markdown

配置项见 [README 配置 → 消息](../README.md#消息)。频道与群聊分场景独立开关，打开后按 **Markdown 模式** 发送：

| 模式          | 效果                                 |
| ----------- | ---------------------------------- |
| 原生 Markdown | 原生 Markdown 消息 + 交互键盘（按钮渲染为 QQ 键盘） |
| 内联指令        | 原生 Markdown + 文本指令链（按钮转为可点击的文本指令）  |
| 模板 Markdown | 按模板 ID 与参数键发送，超出参数槽位自动拆成多条         |
| 纯文本         | 禁用富 Markdown，按普通文本拆分发送             |

模板模式未填模板 ID 时自动退回纯文本。

## 文本交互

参考[官方说明](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)。

`at` / `atAll` / `face` 段按场景转成 `<qqbot-at-user>`、`<qqbot-at-everyone />`、`<emoji:id>`，平台不支持时降级为文本并告警。指令与子频道跳转用 `raw` 段：

```ts
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "cmd-enter", text: "/签到" } }
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "cmd-input", text: "/查询 ", show: "查询", reference: false } }
{ type: "raw", platform: "qqbot", platformType: "text-interaction", data: { type: "channel", channelId: "123" } }
```

限制：

- 群聊 @用户仅 Markdown 可用
- 系统表情与子频道跳转仅文字子频道
- `text` / `show` 上限 100 字符，由适配器 URL 编码
- 回车指令只在 C2C 生效，群聊与频道会转为输入框指令

## 图文卡片

`share` 段在群聊 / C2C 发送为 `msg_type=8` 图文卡片（`card.type=tuwen`）；频道与频道私信没有卡片能力，降级为文本。

```ts
{ type: "share", url: "https://example.com/news", title: "标题", content: "摘要", image: "https://example.com/cover.jpg" }
```

平台对四个字段均有硬性要求，任一不满足即判「消息类型与内容不匹配」：

| 字段               | 要求                        |
| ---------------- | ------------------------- |
| 标题 `title`       | 1-50 字符，留空用链接兜底，超长按码点截断   |
| 描述 `description` | 1-200 字符，留空用标题兜底，超长同上     |
| 链接 `url`         | 必须 https 且 ≤1024 字符，否则整条退回文本 |
| 封面 `pic_url`     | 必须 https 且有图，否则整条退回文本     |

## 富媒体

一条消息只能带一个富媒体元素，含多个富元素的消息会拆成多条按序发送。图片压缩上限见 [README 配置 → 图片](../README.md#图片)。

| 场景          | 图片              | 视频   | 语音   | 文件   |
| ----------- | --------------- | ---- | ---- | ---- |
| 群聊 / C2C 私聊 | 富媒体             | 富媒体  | 富媒体  | 富媒体  |
| 频道 / 频道私信   | multipart 或 URL | 降级文本 | 降级文本 | 降级文本 |

群聊 / C2C 走官方富媒体接口：

- 公网 URL 优先交平台转存，失败则本机下载后分片上传
- 本地路径 / Buffer / base64 走分片上传：预上传 → 并发 PUT → 合并，自动算 MD5 / SHA1 并按服务端配置重试
- Markdown 图片不能走富媒体接口，需转成公网 URL 或 `qqbot-media://`，见 [MEDIA.md](MEDIA.md)

频道场景的本地图片走 multipart `file_image` 直传，公网 URL 直接填 `image` 字段。

## 转发消息

「转发消息格式」可选 `合并`（默认）或 `多条`：

| 格式 | 效果            |
| -- | ------------- |
| 合并 | 多个节点合并为一条消息发送 |
| 多条 | 每个节点各自一条消息    |

含图片 / 视频的节点因平台单条限制仍会单独成条，无法展开的转发段降级为文本占位。

## 接收附件

各场景收到的 `attachments` 统一转成内核消息段：

| QQ 附件 MIME             | 内核消息段    |
| ---------------------- | -------- |
| `image/*`              | `image`  |
| `audio/*`              | `record` |
| `video/*`              | `video`  |
| 其他（PDF、压缩包、Office 文档等） | `file`   |

`file` 段只保留下载 URL、文件名与大小，适配器不在接收时下载附件，由使用方按需处理。

## 消息去重与重复回复

平台会重复推送同一条入站消息（WebSocket 重连补发、Webhook 重试、平台抖动），按 `msg_id` 直接处理会让一次提问触发多次回复。适配器在事件入口统一去重：

| 项  | 规则                       |
| -- | ------------------------ |
| 去重键 | `场景:messageId`，仅作用于消息事件，通知类事件不去重 |
| 窗口 | 5 分钟（与被动回复额度一致）          |
| 容量 | 最多 2000 条，超出淘汰最旧，过期项写入时清理 |

出站方向的 `msg_id` + `msg_seq` 是平台幂等键，同一对值重复发送会被判为重复请求。因此同一条入站消息的多次回复必须递增 `msg_seq`，适配器已自动处理：

| 场景               | `msg_seq`            |
| ---------------- | -------------------- |
| 被动回复（带 `msg_id` / `event_id`） | 同一锚点从 `1` 递增，窗口结束后重新计数 |
| 主动推送（无锚点）        | 随机值，不占用被动回复序号        |
| 触顶 60000         | 回绕到 `1`             |

消息被拆成多条发送（多富元素、Markdown 图文混排）时，每条各自取号，不会撞车。
