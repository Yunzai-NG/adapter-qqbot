# QQ Bot 适配器 vs 内核事件：完成度对照

对照 [CORE-EVENTS.md](CORE-EVENTS.md) 的内核事件类型，逐项核对适配器实现（`src/events.ts`）。
QQ 事件清单以官方文档为准（bot.q.qq.com 事件列表）。共映射 54 种 QQ 事件：
消息 6、请求 1、强类型通知 2、GenericNotice 45。

## 消息（4 种场景）

| 内核 scene | QQ 事件 | 状态 |
|---|---|---|
| `group` | `GROUP_AT_MESSAGE_CREATE`（@ 机器人） | ✅ |
| `group` | `GROUP_MESSAGE_CREATE`（非 @ 群消息） | ✅ 与 @ 变体同路解码（需平台开通消息列表权限方能收到） |
| `private` | `C2C_MESSAGE_CREATE` | ✅ 带 `subType: "friend"` |
| `guild` | `AT_MESSAGE_CREATE` / `MESSAGE_CREATE` | ✅ 映射 `seq`（取 `seq_in_channel`） |
| `private`（direct） | `DIRECT_MESSAGE_CREATE` | ✅ |

字段级半完成：群 `sender.role` 恒 `"member"`（报文无角色）；
`quote` 四场景均不解析（识图类指令拿不到引用里的图）。

## 通知（强类型 6 种 + GenericNotice）

| 内核 noticeType | QQ 来源 | 状态 |
|---|---|---|
| `group.increase` | `GROUP_MEMBER_ADD` | ✅ 强类型：`gid`/`uid`/`operatorId`/`way` 均在顶层；预设已订阅 `GROUP_MEMBER`(1<<24)。机器人入群 `GROUP_ADD_ROBOT` 另以 `group.robot.add` 上抛，不再撞名 |
| `group.decrease` | `GROUP_MEMBER_REMOVE` | ✅ 同上；机器人退群走 `group.robot.del`。`way` 恒 `"other"`（报文无进出方式） |
| `group.admin` | — | ⛔ 平台无管理员变动推送 |
| `group.mute` | — | ⛔ 平台无禁言通知 |
| `message.recall` | `PUBLIC_MESSAGE_DELETE`（公域）/ `MESSAGE_DELETE`（私域） | 🟡 频道已适配：解码与订阅（1<<30 / 1<<9）均齐，以自定义 `guild.message.delete` 通知上抛。半适配点：未对齐强类型（字段在 `data` 内，对齐会丢 `channelId`）；丢弃 `op_user_id`（删除操作者）。群聊/C2C 平台无删除推送，无法完成 |
| `poke` | — | ⛔ 平台无戳一戳 |

GenericNotice（平台特有事件）：✅ 45 种 QQ 事件已映射——好友 4、群 4、频道 3、
子频道 3、频道成员 3、表态 2、互动 1、审核 2、删除 2、私域论坛 8、公域论坛 7、
音频 4、语音/直播子频道进出 2。未知事件降级为 `qqbot.<事件名>` 不丢弃。

已接入的原「未完成」平台事件：

| QQ 事件 | 内核 noticeType | 状态 |
|---|---|---|
| `OPEN_FORUM_THREAD_CREATE/UPDATE/DELETE`、`OPEN_FORUM_POST_CREATE/DELETE`、`OPEN_FORUM_REPLY_CREATE/DELETE` | `open_forum.thread.*` / `open_forum.post.*` / `open_forum.reply.*` | ✅ 已解码（公域字段较私域精简，携带 `gid`/`channelId`/`uid`，明细见 `raw`） |
| `AUDIO_OR_LIVE_CHANNEL_MEMBER_ENTER` / `EXIT` | `channel.member.enter` / `channel.member.exit` | ✅ 已解码（`gid`/`channelId`/`channelType`/`uid`） |
| 互动回调应答 API `PUT /interactions/{interaction_id}` | — | ✅ `api.replyInteraction(id, code)`，插件经 `bot.callApi("replyInteraction", { interactionId, code })` 应答按钮点击（`interactionId` 取互动通知 `data.noticeId`） |

小缺陷：通知顶层 `time` 未填（内核取到达时间）；`data.time` 秒/毫秒混杂。

## 请求（3 种）

| 内核 requestType | QQ 来源 | 状态 |
|---|---|---|
| `group.add` | `GROUP_JOIN_REQUEST`（自主申请） | ✅ 已解码；`e.approve()`/`e.reject(reason)` 经 `handleGroupRequest` 调 `approval_join_request` API；`caps` 含 `groupRequest` |
| `group.invite` | `GROUP_JOIN_REQUEST`（被邀请，`invited_by`/`apply_source` 判定） | ✅ 同上 |
| `friend` | — | ⛔ 平台单向添加无审批流，`FRIEND_ADD` 是事后通知非请求 |

`GROUP_JOIN_REQUEST` 的 flag 为 `group_openid:member_openid:join_request_id`，
`comment` 取 `verify_info`（申请验证语）。

## 元事件（5 种）

| 内核 metaType | 状态 |
|---|---|
| `connect` / `heartbeat` / `enable` / `disable` / `other` | ⬜ 不产出——上下线已由 `bot/online` / `bot/offline` 覆盖（`host.setStatus` 触发），心跳为 Gateway 内部实现，无插件侧需求 |

## 总线事件（适配器侧无需实现）

`message`/`notice`/`request`/`meta` 透传、`bot/online`/`bot/offline` 均由内核自动接通 ✅；其余总线事件与适配器无关。

## 汇总

| 类别 | ✅ | 🟡 半完成 | ⬜ 未完成 | ⛔ 无法 |
|---|---|---|---|---|
| 消息 | 4/4 场景（含非 @ 群消息、`seq`、C2C `subType`） | `role` 恒 member、`quote` 不解析 | — | — |
| 通知 | `group.increase/decrease` 强类型对齐；45 种 GenericNotice（含公域论坛、语音子频道进出、互动应答 API） | `message.recall`（频道已适配未对齐强类型，群聊/C2C 无推送） | — | `group.admin`、`group.mute`、`poke` |
| 请求 | `group.add` / `group.invite` | — | — | `friend` |
| 元 | — | — | —（非必需） | —（已被覆盖） |

剩余可选优化：① `message.recall` 对齐强类型（需内核 `RecallNotice` 增补 `channelId`）
② 引用消息 `quote` 解析（识图类指令）③ 群消息发送者角色 `sender.role`（报文暂无）。
