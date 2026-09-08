# yunzai-ng 内核事件类型详解

> 面向初次接触本框架的开发者，用大白话解释内核有哪些事件、每个事件是什么意思、
> 什么时候会触发、插件怎么用。

## 先建立一个直观印象

把整个框架想象成一个「传达室」：

1. 各个聊天平台（QQ、频道……）的消息/动静先由**适配器**接收
2. 适配器把平台报文翻译成统一的**事件**对象，交给内核（`host.submit()`）
3. 内核补齐公共信息（谁发的、哪个号收的、怎么回复……），然后广播给所有插件
4. 插件通过 `ctx.on(...)` 决定自己关心哪些事件、怎么处理

所以「内核事件类型」就是：**适配器允许往上交的所有动静的统一格式**。

## 事件分四大类（kind）

一条事件必属于以下四类之一，看 `e.kind` 就知道大类：

| kind | 通俗理解 | 例子 |
|---|---|---|
| `message` | **有人说话了** | 用户在群里发「#签到」 |
| `notice` | **有动静，但不是说话** | 有人进群了、消息被撤回了、机器人被踢了 |
| `request` | **有人请求，需要你点头/摇头** | 有人申请加群，机器人是管理员，可以同意或拒绝 |
| `meta` | **机器人自己的状态变化** | 连接建立、心跳 |

一句话区分：**要回复的是 message，要表态的是 request，旁听的是 notice，跟用户无关的是 meta。**

---

## 一、message（消息事件）

四种场景（`e.scene`）：

| scene | 含义 |
|---|---|
| `private` | 私聊（好友私聊、临时会话、频道私信） |
| `group` | 群聊 |
| `guild` | 频道（QQ 频道里的某个子频道） |

插件拿到的 `e`（运行时形态）主要信息：

- `e.messageId`：这条消息的平台 id（撤回它时用）
- `e.message`：消息内容，拆成一段一段（文本段、@段、图片段……）
- `e.text`：纯文本（内核帮你拼好、去空格）
- `e.sender`：谁发的（`uid`/昵称/头像；群消息还带身份角色）
- `e.group` / `e.channel`：在哪个群 / 哪个频道发的
- `e.atMe`：这条消息 @ 我了吗（含 @全体、叫昵称）
- `e.isMaster`：发送者是不是主人（配置里的主人列表）
- `e.isGroupAdmin` / `e.isGroupOwner`：发送者是不是群管理/群主（判权限用）
- `e.quote`：引用回复时，被引用那条消息的摘要
- `e.images`:消息里所有图片（**含引用消息里的图**——识图类指令靠它）

最常用的动作：

```ts
ctx.command("签到").action(async e => {
  await e.reply("签到成功")          // 回复这条消息
  await e.renderReply(template, data) // 渲染图片回复
  await e.recall()                    // 撤回自己刚发的（2 分钟内）
})
```

命令路由只对 message 生效：`ctx.command(...)`、`ctx.route(...)` 都是匹配消息的。

---

## 二、notice（通知事件）

「群里发生了什么，但不需要回复，只需要知道」。通知有个类型名 `e.noticeType`。

### 内核内置的 6 种强类型通知

字段直接挂在事件顶层（`e.gid`、`e.uid`……），类型定义齐全：

| noticeType | 意思 | 关键字段 |
|---|---|---|
| `group.increase` | 有成员进群 | 群号 `gid`、谁 `uid`、怎么进的（邀请/审批）`way` |
| `group.decrease` | 有成员退群/被踢 | `gid`、`uid`、操作者 `operatorId`、怎么走的 `way` |
| `group.admin` | 管理员任免 | `gid`、`uid`、变动后角色 `role` |
| `group.mute` | 有人被禁言/解禁 | `gid`、`uid`、时长 `duration`（0=解除）、全体 `whole` |
| `message.recall` | 有消息被撤回 | 群号 `gid`、撤谁的消息 `uid`、消息 id `messageId` |
| `poke` | 戳一戳 | 发起者 `uid`、被戳者 `targetId` |

用法示例：

```ts
ctx.on("notice", e => {
  if (e.noticeType === "group.increase") {
    // 新人入群欢迎（e.gid 群号、e.uid 新人 id）
  }
})
```

### GenericNotice（万能通知）

平台千奇百怪的事（QQ 的「机器人被拉黑」「表情表态」，Discord 的「有人开始直播」……）
内核不可能预知，所以留了一个万能格式：

```ts
{
  kind: "notice",
  noticeType: "guild.member.increase",  // 任意字符串，点分命名
  data: { ... }                         // 平台明细，结构由适配器自定
}
```

**注意陷阱**：GenericNotice 的明细在 `e.data` 里，不在顶层。适配器如果把自定义通知
命名为 `group.increase`（与强类型撞名），插件按强类型习惯读 `e.uid` 会拿到
`undefined`——真实数据在 `e.data.uid`。适配器应避免用强类型名发 GenericNotice。

通知也能回复（`e.reply()`）：有群号就回群，没有就私聊回相关用户。

---

## 三、request（请求事件）

「有人提交了申请，机器人的意见影响结果」。与 notice 的本质区别：**request 有
`approve()` / `reject()` 两个动作可选**。

| requestType | 意思 | e.approve() 的效果 |
|---|---|---|
| `friend` | 好友请求 | 同意后可加备注 |
| `group.add` | 申请加群 | 机器人（管理员）放行 |
| `group.invite` | 邀请入群 | 同意邀请 |

字段：`uid`（申请人）、`gid`（目标群）、`comment`（申请附言）、`flag`（平台内部标识，
同意/拒绝时内核自动带过去，插件不用管）。

```ts
ctx.on("request", async e => {
  if (e.requestType === "group.add") {
    if (e.comment?.includes("暗号")) await e.approve()
    else await e.reject("请填写暗号")
  }
})
```

内核做了个贴心封装：好友请求的第三个参数是「同意后设置的**备注**」，加群请求的
第三个参数是「**拒绝理由**」——这两个语义在底层 API 里不对称（源自 OneBot），
插件侧不用关心，`approve(extra)` / `reject(reason)` 传对位置即可。

---

## 四、meta（元事件）

机器人自己的状态，跟用户无关。类型 `metaType`：

| metaType | 含义 |
|---|---|
| `connect` | 连接建立 |
| `enable` / `disable` | 账号被启用/停用 |
| `heartbeat` | 心跳（定期报平安） |
| `other` | 其他 |

适用场景：极少数插件需要感知连接细节（比如自检脚本）。**日常开发几乎用不到**——
账号上下线用总线事件 `bot/online` / `bot/offline` 更方便（见下）。

---

## 五、总线事件（ctx.on 能监听的全部清单）

前面四类是「事件大类」；下面是插件实际能 `ctx.on` 的完整列表（`CoreEventMap`）：

### 平台事件透传

| 事件名 | 触发时机 |
|---|---|
| `message` | 收到任何消息（**命令路由之后**才触发——统计类插件能看到 `e.command` 是否命中） |
| `notice` | 收到任何通知 |
| `request` | 收到任何请求 |
| `meta` | 收到任何元事件 |

### 应用与账号状态

| 事件名 | 触发时机 |
|---|---|
| `app/ready` | 全部插件加载完、服务就绪（开机完成） |
| `app/stopping` | 开始停机（插件在此保存数据） |
| `bot/online` / `bot/offline` | 某账号上线/掉线 |

### 插件与配置

| 事件名 | 触发时机 |
|---|---|
| `plugin/loaded` / `plugin/unloaded` / `plugin/error` | 某插件加载/卸载/加载失败 |
| `config/changed` | 配置被改（WebUI 里改配置就触发） |

### 处理过程埋点（做监控/统计用）

| 事件名 | 触发时机 |
|---|---|
| `command/done` | 一条命令跑完（带耗时；成功/失败都触发） |
| `message/sent` | 一条消息发出去（无论 reply、主动推送还是定时任务发的） |
| `render/done` | 一次渲染结束 |
| `pipeline/error` | 事件处理中抛了未捕获错误 |

`message` vs `command/done` 的分工：前者说「收到了一条消息」，后者说「某条命令跑完
了、花了多久」——一条消息可能命中 0 条或多条命令，所以统计调用次数要看后者。

---

## 六、一条消息的完整旅程（串起来看）

以「用户在群里发 `#签到`」为例：

```
QQ 服务器
  → 适配器收到报文，翻译成 message 事件（scene=group, message=[{text:"#签到"}]...）
  → host.submit() 交给内核
  → 内核先判：维护模式？机器人自己发的？→ 不是，构造运行时事件
  → 中间件链（可改写消息内容）
  → prompt 等待者（有人正在等回答吗？）
  → 命令路由（匹配到「签到」命令）
  → 冷却检查（这个用户刷屏了吗？）
  → 执行签到命令的 action(e) → e.reply("签到成功")
  → 广播总线事件：message、command/done、message/sent
```

`submit()` 永不抛错——适配器在 socket 回调里调它，任何异常都由内核兜住并转成
`pipeline/error`，不会带崩进程。

---

## 附：速查

- 四大类：`message` / `notice` / `request` / `meta`
- 消息三场景：`private` / `group` / `guild`
- 强类型通知 6 种：`group.increase`、`group.decrease`、`group.admin`、`group.mute`、
  `message.recall`、`poke`；其余通知走 GenericNotice（明细在 `e.data`）
- 请求 3 种：`friend`、`group.add`、`group.invite`
- 元事件 5 种：`connect`、`enable`、`disable`、`heartbeat`、`other`
- 总线 16 个：`app/ready`、`app/stopping`、`bot/online`、`bot/offline`、`message`、
  `notice`、`request`、`meta`、`plugin/loaded`、`plugin/unloaded`、`plugin/error`、
  `config/changed`、`pipeline/error`、`command/done`、`message/sent`、`render/done`
