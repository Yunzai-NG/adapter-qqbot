# 核心 BotApi 方法 vs QQ Bot API 对照

## 类型定义

### UserInfo（用户基础信息）

| BotApi 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `uid` | `string` | 是 | 平台内唯一用户 id（QQ openid） |
| `name` | `string` | 否 | 昵称 |
| `avatar` | `string` | 否 | 头像地址 |
| `remark` | `string` | 否 | 好友备注 |

### MemberInfo（群成员信息，继承 UserInfo）

| BotApi 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `uid` | `string` | 是 | 用户 id |
| `name` | `string` | 否 | 昵称 |
| `avatar` | `string` | 否 | 头像地址 |
| `remark` | `string` | 否 | 好友备注 |
| `gid` | `string` | 是 | 所属群 id |
| `card` | `string` | 否 | 群名片 |
| `role` | `"owner" \| "admin" \| "member"` | 是 | 权限角色 |
| `title` | `string` | 否 | 专属头衔 |
| `joinTime` | `number` | 否 | 入群时间（秒级时间戳） |
| `lastSentTime` | `number` | 否 | 最后发言时间（秒级时间戳） |
| `shutUpTime` | `number` | 否 | 禁言到期时间（秒级时间戳） |

### GroupInfo（群信息）

| BotApi 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `gid` | `string` | 是 | 群 id |
| `name` | `string` | 否 | 群名 |
| `avatar` | `string` | 否 | 群头像 |
| `memberCount` | `number` | 否 | 当前人数 |
| `maxMemberCount` | `number` | 否 | 人数上限 |
| `owner` | `string` | 否 | 群主 id |
| `selfRole` | `GroupRole` | 否 | 机器人在本群的角色 |

### SendTarget（发送目标）

| scene | 必需字段 | 说明 |
|---|---|---|
| `"private"` | `uid`，`gid`（可选） | 私聊 / 群临时会话 |
| `"group"` | `gid` | 群聊 |
| `"guild"` | `guildId`，`channelId` | 频道 |

### SendResult（发送结果）

| BotApi 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ok` | `boolean` | 是 | 是否成功送达 |
| `messageId` | `string` | 是 | 平台返回的消息 id，不返回时为空串 |
| `time` | `number` | 是 | 发送时间（毫秒时间戳） |
| `raw` | `unknown` | 否 | 平台原始返回 |

### MessageRecord（历史消息）

| BotApi 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `messageId` | `string` | 是 | 消息 id |
| `time` | `number` | 是 | 时间（毫秒时间戳） |
| `sender` | `UserInfo \| MemberInfo` | 是 | 发送者 |
| `message` | `Segment[]` | 是 | 消息内容段 |
| `group` | `GroupInfo` | 否 | 所在群，私聊时缺省 |

---

## 方法对照表

### 必需方法

| BotApi 方法 | 返回值 | QQ Bot API | 字段映射 | 状态 |
|---|---|---|---|---|
| `sendMessage(target, content, opts?)` | `SendResult` | 群: `POST /v2/groups/{gid}/messages`<br>C2C: `POST /v2/users/{uid}/messages`<br>频道: `POST /channels/{cid}/messages`<br>频道私信: `POST /dms/{gid}/messages` | `ok` ← 请求成功为 true<br>`messageId` ← 响应 `id`<br>`time` ← 响应 `timestamp` 或 `Date.now()` | ✅ 已实现 |
| `getSelfInfo()` | `UserInfo` | `GET /users/@me`<br>返回: `{ id, username, avatar, bot }` | `uid` ← `id`<br>`name` ← `username`<br>`avatar` ← `avatar` | ✅ 已实现 |
| `getFriend(uid)` | `UserInfo?` | `GET /v2/users/{openid}/info`<br>返回: `{ openid, nickname, head_url }` | `uid` ← `openid`<br>`name` ← `nickname`<br>`avatar` ← `head_url` | ✅ 已实现 |
| `getFriendList()` | `UserInfo[]` | 无此 API | 返回 `[]` | ❌ 不支持 |
| `getGroup(gid)` | `GroupInfo?` | 群: `GET /v2/groups/{gid}/info`<br>返回: `{ group_openid, name, avatar, owner_id, admin_count, member_count }`<br>selfRole: `GET /v2/groups/{gid}/members/{uid}`<br>频道+子频道: `GET /guilds/{id}` + `GET /channels/{id}`<br>返回: `{ id, name, icon, owner_id, member_count, max_members }`<br>selfRole: `GET /guilds/{id}/members/{uid}`<br>返回: `{ roles: ["4"] }` | 群: `gid` ← `group_openid`, `name` ← `name`, `avatar` ← `avatar`, `owner` ← `owner_id`, `memberCount` ← `member_count`, `selfRole` ← `role`<br>组合: `gid` ← `"频道号-子频道号"`, `name` ← `"频道名-子频道名"`, `avatar` ← `icon`, `memberCount` ← `member_count`, `maxMemberCount` ← `max_members`, `owner` ← `owner_id`, `selfRole` ← roles 含 "4" → owner, 含 "2" → admin, 否则 member<br>**注意**: 不支持单独的频道 ID，必须是 "频道id-子频道id" 格式 | ✅ 已实现 |
| `getGroupList()` | `GroupInfo[]` | 群: 无此 API<br>频道: 无此 API（可通过 `callApi` 调用 `GET /users/@me/guilds`） | 返回 `[]` | ❌ 不支持 |
| `getGroupMember(gid, uid)` | `MemberInfo?` | 群: `GET /v2/groups/{gid}/members/{uid}`<br>返回: `{ member_openid, join_type, role }`<br>频道: `GET /guilds/{gid}/members/{uid}`<br>返回: `{ user: { id, username, avatar }, nick, roles, joined_at }` | 群: `uid` ← `member_openid`, `gid` ← 传入 gid, `role` ← `role`<br>频道: `uid` ← `user.id`, `name` ← `user.username`, `avatar` ← `user.avatar`, `card` ← `nick`, `role` ← roles 含 "4" → owner, 含 "2" → admin, 否则 member, `joinTime` ← `joined_at` 转秒级 | ✅ 已实现 |
| `getGroupMemberList(gid, opts?)` | `MemberInfo[]` | 群: `GET /v2/groups/{gid}/members`<br>返回: `[{ member_openid, join_type, role }]`<br>频道: `GET /guilds/{gid}/members`<br>返回: `[{ user: { id, username, avatar }, nick, roles, joined_at }]` | 群: `uid` ← `member_openid`, `gid` ← 传入 gid, `role` ← `role`<br>频道: 每项映射同 `getGroupMember` | ✅ 已实现 |
| `recallMessage(messageId)` | `boolean` | 群: `DELETE /v2/groups/{gid}/messages/{mid}`<br>C2C: `DELETE /v2/users/{uid}/messages/{mid}`<br>频道: `DELETE /channels/{cid}/messages/{mid}`<br>频道私信: `DELETE /dms/{gid}/messages/{mid}` | 成功返回 `true`，失败返回 `false`<br>限制: 发送超过 2 分钟不可撤回 | ✅ 已实现 |
| `callApi(action, params?)` | `T` | 原生 API 透传 | 直接返回平台原始数据 | ✅ 已实现 |

### 可选方法

| BotApi 方法 | 返回值 | 需要 caps | QQ Bot API | 状态 |
|---|---|---|---|---|
| `sendForward?(target, nodes)` | `SendResult` | `forward` | 无此 API，降级为逐条发送 | ⚠️ 降级实现 |
| `setGroupCard?(gid, uid, card)` | `void` | `groupCard` | 无此 API | ❌ 不支持 |
| `muteGroupMember?(gid, uid, seconds)` | `void` | `groupMute` | 群: `POST /v2/groups/{gid}/restrict_chat_setting`<br>频道: `PATCH /guilds/{gid}/members/{uid}/mute` | ✅ 已实现 |
| `muteGroupAll?(gid, enable)` | `void` | `groupWholeMute` | 无此 API | ❌ 不支持 |
| `kickGroupMember?(gid, uid, reject?)` | `void` | `groupKick` | 群: `POST /v2/groups/{gid}/batch_remove_members`<br>返回: `{ remove_members_result, add_to_member_blacklist_fail_openids }`<br>频道: `DELETE /guilds/{id}/members/{uid}`<br>返回: 204 No Content | ✅ 已实现<br>注意: 群聊接口需白名单权限，正在内邀接入中 |
| `quitGroup?(gid)` | `void` | - | 无此 API | ❌ 不支持 |
| `handleFriendRequest?(flag, approve, remark?)` | `void` | `friendRequest` | 无此 API | ❌ 不支持 |
| `handleGroupRequest?(flag, approve, reason?)` | `void` | `groupRequest` | 群: `POST /v2/groups/{group_openid}/approval_join_request/{member_openid}`<br>请求体: `{ op: "approve" \| "decline", join_request_id?, reject_reason?, add_to_member_blacklist? }`<br>返回: 200 OK<br>flag 格式: `group_openid:member_openid:join_request_id`<br>频道: 无此 API | ⚠️ 仅群聊支持 |
| `fetchHistory?(target, count, before?)` | `MessageRecord[]` | `fetchHistory` | 无此 API | ❌ 不支持 |
| `getMessage?(messageId)` | `MessageRecord?` | - | 无此 API | ❌ 不支持 |
| `uploadGroupFile?(gid, file, name, folder?)` | `void` | `groupFile` | `POST /v2/groups/{gid}/files` | ⚠️ 待实现 |
| `setReaction?(messageId, emojiId, add?)` | `void` | `reaction` | 频道: `PUT/DELETE /channels/{cid}/messages/{mid}/reactions/{type}/{emoji_id}` | ⚠️ 待实现 |

---

## 只读属性

| BotApi 属性 | 类型 | QQ Bot 映射 |
|---|---|---|
| `selfId` | `string` | 机器人 QQ 号（robotUin）或 AppID |
| `platform` | `string` | 固定 `"qqbot"` |
| `adapterId` | `string` | 适配器 ID |
| `nickname` | `string` | 机器人名称（Ready 事件获取） |
| `online` | `boolean` | WebSocket 是否已连接 |
| `caps` | `ReadonlySet<BotCapability>` | 当前声明: `recall`, `forward`, `groupCard`, `groupMute`, `groupKick` |

---

## 总结

| 状态 | 数量 | 方法 |
|---|---|---|
| ✅ 完全实现 | 10 | sendMessage, recallMessage, getSelfInfo, getFriend, getGroup, getGroupMember, getGroupMemberList, muteGroupMember, kickGroupMember, callApi |
| ⚠️ 部分支持 | 4 | sendForward, handleGroupRequest, uploadGroupFile, setReaction |
| ❌ 不支持 | 8 | getFriendList, getGroupList, setGroupCard, muteGroupAll, quitGroup, handleFriendRequest, fetchHistory, getMessage |
