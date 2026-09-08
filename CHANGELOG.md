# 更新日志

本项目所有值得注意的变更都记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-08

本次以「补齐事件模型」为主线，将适配器可上抛的 QQ 事件补齐至 54 种（消息 6、
请求 1、强类型通知 2、GenericNotice 45），并修复频道 ID 精度与鉴权配置问题。

### 新增

- **入群申请**（`GROUP_JOIN_REQUEST`）解码为内核 `request` 事件：按 `invited_by` /
  `apply_source` 判定 `group.add`（自主申请）或 `group.invite`（被邀请），插件可用
  `e.approve()` / `e.reject(reason)` 审批，底层调用 `approval_join_request` API。
- **非 @ 群消息**（`GROUP_MESSAGE_CREATE`）解码，与 @ 变体同路。
- **公域论坛事件**（`OPEN_FORUM_*` 7 种）：主题、帖子、回复的增删，上抛为
  `open_forum.thread/post/reply.*` 通知。
- **语音/直播子频道成员进出**（`AUDIO_OR_LIVE_CHANNEL_MEMBER_ENTER/EXIT`）：
  上抛为 `channel.member.enter/exit` 通知。
- **互动回调应答 API**（`PUT /interactions/{interaction_id}`）：新增
  `api.replyInteraction(id, code)`，插件经 `bot.callApi("replyInteraction", { interactionId, code })`
  应答按钮点击，闭环互动交互。
- C2C 私聊消息补充 `subType: "friend"`；频道消息补充会话内序号 `seq`（取 `seq_in_channel`）。
- 声明 `groupRequest` 能力（`caps`），并在群聊系预设订阅中补充 `GROUP_MEMBER`(1<<24)
  意图，成员进退群事件方能收到。
- 新增文档 [docs/EVENTS.md](docs/EVENTS.md)（适配器 vs 内核事件完成度对照）与
  [docs/CORE-EVENTS.md](docs/CORE-EVENTS.md)（内核事件类型详解）。

### 变更

- **频道 ID 加 `qg_` 前缀**：频道用户 `user_id` 与「频道号-子频道」组合 ID 统一加
  `qg_` 前缀，规避 QQ 频道大整数超出 JS 安全整数导致的精度丢失；出站调用 API 时自动剥离前缀。
- **群成员进退群对齐强类型**：`GROUP_MEMBER_ADD` / `GROUP_MEMBER_REMOVE` 现上抛为内核
  强类型通知 `group.increase` / `group.decrease`（`gid`/`uid`/`operatorId`/`way`
  挂事件顶层），插件按强类型习惯读取不再拿到 `undefined`。
- **AppSecret 改为必填**：账号配置校验要求 AppSecret 非空。

### 修复

- **修复通知命名撞名**：机器人进出群（`GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT`）此前误用
  强类型名 `group.increase` / `group.decrease` 发 GenericNotice（字段藏在 `data` 内），
  现改名为 `group.robot.add` / `group.robot.del`，不再与强类型冲突。

### 移除

- **移除前端可配置的 Access Token 字段**：Access Token 仅能由 AppID + AppSecret 自动获取，
  不再支持手工填入。

## [0.1.0]

- 初始版本：QQ 官方机器人适配器，支持 WebSocket Gateway 与 Webhook 两种连接模式，
  覆盖群聊、C2C 私聊、频道、频道私信四大场景。

[0.2.0]: https://github.com/Yunzai-NG/adapter-qqbot/releases/tag/v0.2.0
[0.1.0]: https://github.com/Yunzai-NG/adapter-qqbot/releases/tag/v0.1.0
