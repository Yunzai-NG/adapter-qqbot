# 更新日志

本项目所有值得注意的变更都记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，  
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-10-24

### 修复

- **群消息的 `sender.uid` 会变成 `undefined`。** 群 / C2C 报文的 `author` 实际常常只带
  `member_openid`（群）或 `user_openid`（单聊），不带 `id`；而主解码路径只读 `author.id`，
  类型上还被 `MsgAuthor & { id: string }` 骗过去了。结果是群消息的 `e.sender.uid` 为空，
  连带 `atMe` 与主人判断一起失效。现在三个解码函数共用 `senderOf()`，按
  `id → member_openid → user_openid` 取值，与消息元素、引用发送者走同一条逻辑。
- **用户昵称留成空串。** `author.username` 为空或纯空白时，此前会把 `""` 原样交给内核，
  内核日志的 `name ?? ""` 不会兜底空串，于是打成 `(openid)` —— 既没有名字也看不出是缺失。
  现在归一成 `undefined`，内核按「无昵称」处理。名称来源确认只有 `author.username` 一个
  （群 / C2C / 频道 / 频道私信一致，官方文档示例里的 `""` 只是占位），并顺带裁掉两侧空白。

### 新增

- **消息去重与 `msg_seq` 递增。** 平台重复推送同一条入站消息（重连补发 / Webhook 重试 / 平台抖动）时，
  按 `场景:messageId` 在 5 分钟窗口内只提交内核一次 —— 此前同一条消息被推几次就会触发几次回复。
  出站侧修好被动回复的序号：同一 `msg_id` 的 `msg_seq` 从 1 递增，避免「同一对 `msg_id + msg_seq`
  重复发送」被平台判为重复请求，同一条消息因此可以连续回多条（处理中 → 结果）。
  序号表按 5 分钟窗口淘汰，不再随运行时长无限增长；主动推送用随机序号，不占被动回复的号段。
- **`imageToUrl` 自定义图床。** 插件在自己的 `setup` 里 `ctx.provide("qqbot.imageToUrl", fn)` 实现图床，
  适配器需要图片地址时先问它、拿到 URL 直接用；返回空或抛错才继续官方素材库 → 框架文件服务。
  函数原样收到 `file`（链接 / 绝对路径 / `base64://` 为字符串，渲染产物为 `Buffer`）与 `opts`（`filename` / `mime`），
  最后 `return` 地址即可。每次取址现查服务表，插件后加载、热重载、卸载即时生效。
- **图文卡片。** 群聊 / C2C 的 `share` 段改为发送 `msg_type=8` 的图文卡片（`card.type=tuwen`），
  不再拼成「标题 + 链接」纯文本；频道与频道私信无卡片能力，仍降级为文本。
  `title` / `description` 超长按平台上限（50 / 200 字符）按码点截断并补省略号，留空时用链接、标题兜底；
  缺 https 封面图或链接非 https 时整条退回文本并告警 —— 卡片四要素缺一即被平台判为「消息类型与内容不匹配」。
- **文本交互。** 按官方文本交互规范发送与解析 `<qqbot-at-user>`、`<qqbot-at-everyone />`、
  `<qqbot-cmd-enter>` / `<qqbot-cmd-input>`、`<#channel_id>`、`<emoji:id>`；指令与子频道跳转
  以 `raw` 段（`platformType: "text-interaction"`）收发。各场景不支持的能力降级为文本并告警，
  频道私信不再误发频道专属标签。

### 变更

- **源码按领域分层重构（不含行为变化）。** `src/` 由 36 个文件平铺改为 `protocol` / `transport` /
  `media` / `messaging` / `bot` / `shared` 六个领域目录，各带 `index.ts` 统一出口，依赖单向向下。
  `bot.ts`（1053 行单个闭包）拆成 `context`（共享状态与基础判定）/ `connection`（连接、入站、图床清理）/
  `send` / `query` / `manage`；`ed25519` 与 `webhook-registry` 并入 `transport/webhook.ts`，
  `image-size` 并入 `media/probe.ts`。对外接口、配置项与运行时行为均未改动。
- **图床改为链路取址。** 插件实现的 `imageToUrl` → 官方素材库 → 框架文件服务，前一级不可用才走下一级；
  同时移除「图床类型」（`imageHostType`）与「图床脚本路径」（自定义 JS 脚本）两项配置 ——
  自定义图床改由插件 `provide` 一个函数交给适配器，不再需要写脚本文件、也不再往全局挂函数。
  新增「官方图床」（`officialImage`，默认开启）开关。旧配置打开面板保存一次即自动迁移：
  选过框架图床的按关闭官方图床处理，脚本路径直接丢弃。
- **官方图床配额释放加冷却。** 配额满时若距上次释放不足 5 分钟，不再翻页查询 / 删除，
  直接回退框架图床，避免每张新图都白跑一次列表与删除请求。
- **框架图床会跳过不可公网访问的地址。** 回环、`10/172.16-31/192.168/169.254/100.64` 等内网段、
  IPv6 回环与 ULA、`*.local` 以及单标签主机名一律不参与图床，QQ 服务器拉不到这些地址；
  账号配置保存时会对这类地址给出提示。
- 频道 @用户 / @全体 改用新版标签，不再发送即将弃用的 `<@id>` / `@everyone`。
- 内联指令的 `text` / `show` 改为 URL 编码（原为 XML 转义），超过 100 字符的按钮降级为文本。

## [0.3.5] - 2026-10-24

### 新增

- **Webhook 全链路日志。** 开放平台回调地址「保存失败/校验不通过」过去没有任何线索，现在  
  `op=13` 校验通过打 debug（含 appid、event_ts、签名前缀；平台保存地址时会连发两三条，放 info  
  会刷屏面板日志），缺 `X-Bot-Appid`、AppID 未注册、  
  `plain_token`/`event_ts` 缺失、`op=0` 签名校验失败、未知 op 均打 warn，并附 ip、User-Agent、  
  原始请求体片段与可能原因。
- **启动自检。** Webhook 模式连接时只打一行 `Webhook 模式已启用，当前地址为：<地址>`，  
  可直接复制到开放平台；内置服务器未启用时额外报 error，账号「Webhook 监听路径」与实际  
  路由不一致时额外告警。本机自测 `curl` 打进 info，`X-Bot-Appid` 直接填当前账号的 AppID，  
  可整条复制执行，并改用 `--data-raw` + 转义双引号（cmd 不认单引号）。
- **`webhook.test.ts`。** 用开放平台文档公布的标准签名用例（secret `DG5g3B4j9X2KOErG`）锁住  
  `op=13` 签名结果，覆盖缺头、未注册 AppID、异常 payload、签名不匹配等分支。

### 安全

- **修复 op=13 签名预言机（高危）。** 回调校验对 `event_ts + plain_token` 无条件签名，  
  而事件推送的验签内容是 `timestamp + body`，两者同构：攻击者把「想伪造的事件 JSON」  
  当 `plain_token` 发来即可换到一个能通过验签的签名，再投递伪造事件即被当作平台推送，  
  可冒充任意用户（含主人）触发指令。现限定 `plain_token` 为 base62、`event_ts` 为纯数字  
  （平台实际下发的形态），不符合直接 400 —— 合法事件体必然含 `{` / `"`，从此构造不出可被  
  op=0 接受的消息。注意：自测用的 `plain_token` 需为字母数字，`"test"` 仍合法。
- **签名比较改为定时安全。** `verify()` 由字符串 `===` 改为先比长度再  
  `crypto.timingSafeEqual`，消除逐字节计时侧信道。
- **拒绝过期事件 + 幂等去重。** op=0 校验签名时间戳与本机时钟的偏差（±300 秒，兼容秒/毫秒），  
  过期按重放拒绝；并缓存 `appid:事件类型:事件 id` 挡重放与平台超时重试导致的重复执行  
  （重复投递返回 `200 duplicate`，不再二次触发指令）。

### 修复

- **误导性的启动日志。** 原日志「Webhook 模式已启用，监听路径：`/qqbot`」打印的是  
  `listenPath`，而该配置并不参与路由（实际固定为 `/plugin/adapter-qqbot/qqbot`），  
  照着填会 404。现改为输出完整回调地址，并在两者不一致时明确告警。
- `op=13` 请求体缺 `plain_token`/`event_ts` 时不再拿 `undefined` 签出一个必然判错的值，  
  改为返回 400 并记录日志。

## [0.3.4] - 2026-10-22

### 新增

- **图床类型三选一。** 「图片」分组新增 `imageHostType`，把「文件服务地址」「图床脚本路径」收成三个互斥通道  
  （框架图床 / 官方图床 / 外置图床），面板只显示当前通道需要的字段。
- **官方图床。** 图片传到 QQ 素材库换取 `qqbot-media://` 引用，**无需公网地址**；按内容哈希去重，  
  不重复占用 100 张配额。保存时间默认 14400 秒（官方上传任务 4 小时过期），上限 7776000 秒；  
  仅支持 png / jpeg / gif / webp 且 ≤10MB，不符或失败时降级框架图床。
- **素材自动清理。** 官方图床下连接即启动后台任务，按保存时间的 1/4（5 分钟 ~ 24 小时）定期删除超期图片，  
  连接后 30 秒补跑一轮，断开即停；素材满 100 张时同样会清理并重试一次上传。只释放配额，不影响已发送消息。

### 变更

- 旧配置没有 `imageHostType` 时自动迁移：填过脚本的按外置图床，其余框架图床。
- 文件服务地址仅在框架图床下校验，隐藏字段的历史值不再阻塞保存。
- `callApi` 支持「方法 + 路径」写法（GET / DELETE 参数拼查询串），并新增 `forgetOfficialImage`  
  供插件删除素材后失效本地缓存。
- `decodeEvent` / `decodeMessage` 新增可选自身 id 参数；不传时解析结果与旧版一致。

### 修复

- **群聊 @机器人 后指令无法匹配、`e.atMe` 恒为 false。** 提及是 `<@OPENID>`（非纯数字），解码只认  
  `<@123>`，标记留在正文里导致 `^#指令` 全部失配。现把 id 放宽到 `[\w-]+` 并拆成 `at` 段，再按报文  
  `mentions` 里 `is_you` 标记把机器人自己的提及归一化成 `selfId`（真实 QQ 号），`e.atMe` / `e.atUsers`  
  与核心语义一致；各 `at` 段补上 `name`（报文里的昵称），日志与回显不再露出 32 位 openid；  
  `<@//openid/>`、`<@!…>`、`<emoji:n>` 混排均覆盖。

## [0.3.3] - 2026-10-18

### 变更

- 入口不再写 `version` 与 `description`，一律取 package.json，发版只改那一处；package.json 补上  
  `homepage`，面板插件页由此有了「访问仓库」。`name` 仍写在入口里：省掉它要内核 0.6.5。

## 0.3.2 - 2026-10-01

本次补齐引用消息的解析，并把入站媒体的解码收敛到媒体模块。

### 新增

- **引用消息解析（群聊 / C2C）。** 此前收到引用消息只能拿到一条普通文本，被引用的原文完全丢失。  
  现按平台约定解析：`message_type=103` 表示引用消息，被引消息的索引在 `message_scene.ext` 的  
  `ref_msg_idx`，原文则**内联**在 `msg_elements[]` 中（回退 `parallel_message.msg_nodes[]`）；  
  适配器将其还原为消息段填入 `e.quote`，插件可直接读取被引正文、发送者与时间。频道与频道私信  
  场景平台只下发 `message_reference.message_id`，正文需另调接口，故仅填 ID。

### 变更

- **入站媒体解码收敛到媒体模块。** 新增 `media.decodeMedia()`，把「QQ 附件 → `MediaRef`」的判定  
  集中到一处：`url` 优先，语音附件的 `voice_wav_url` 兜底，两者都缺时返回空 `id`，不再拼出  
  `https://` 这类残缺地址。`codec.decodeMessage()` 不再就地拼 URL，`normalizeUrl()` 也由  
  `codec.ts` 移入 `media.ts`。

### 修复

- **补全语音附件字段。** `Attachment` 此前完全丢弃 `voice_wav_url`（语音转码后的 WAV 直链）与  
  `asr_refer_text`（平台侧 ASR 参考文本），现纳入类型定义；平台下发时一并出现在附件详情日志中。

## 0.3.1 - 2026-09-18

本次是收尾：账号配置在面板上按用途分组，依赖基线抬到当前内核。

### 变更

- **面板账号表单按用途分组。** 表单此前是十几个字段平铺一列，六项 Markdown 配置与转发格式夹在图片  
  参数与连接参数之间，找一项要逐行读下来。现分两组 —— `消息`（频道 Markdown、群聊 Markdown、  
  Markdown 模式、Markdown 模板 ID、模板参数键、键盘模板 ID、转发消息格式）与 `图片`（图片压缩上限、  
  图床脚本路径、文件服务地址）；连接方式、AppID / AppSecret、机器人 QQ 号、事件订阅、分片、沙箱与  
  Webhook 监听路径不进组。分组只写进 schema 的元数据，不改动校验与取值。
- **依赖基线抬到 `@yunzai-ng/core >=0.4.0`、`@yunzai-ng/types >=0.3.0`**（原为 `>=0.2.0` / `>=0.1.1`），  
  锁文件随之重新解析。这项只影响安装时的依赖解析与兼容性校验，不改动运行时行为。

## 0.3.0 - 2026-09-11

本次聚焦出站消息能力，完善消息段编解码、富媒体收发、Markdown 与交互键盘支持，并补齐相应测试覆盖。

### 新增

- **富媒体收发链路**：群聊与 C2C 支持图片、视频、语音和文件的官方富媒体上传；公网 URL 优先转存，其他来源自动走分片上传。频道场景支持图片 URL 与 multipart 直传。
- **Markdown 图片与文件服务**：Markdown 图片会转为带尺寸的公网 URL；支持自定义图床脚本及内置临时文件服务作为回退通道。
- **Markdown 发送模式**：支持原生、内联指令、模板及纯文本回退四种模式，并支持模板参数自动拆分。
- **交互键盘与消息段**：支持 QQ 键盘、Ark、Embed、回复、转发及 `qqbot` 原始消息段的出站编码；转发可配置合并或逐条发送。
- **附件解码**：收到的 QQ 附件按 MIME 类型统一转换为 `image`、`record`、`video` 或 `file` 消息段。
- **可选能力依赖**：增加 `qrcode`、`sharp` 与 `silk-wasm` 可选依赖，分别用于二维码、图片压缩和 Silk 音频处理。

### 变更

- 重构消息编解码与出站发送流程，按 QQ 平台「单条消息仅一个富元素」限制自动拆分消息，并为无法编码的内容提供可读降级与日志告警。
- 更新 README，补充 Markdown、图床、文件服务、富媒体及转发消息的配置和行为说明。

### 修复

- 同步锁文件与可选依赖，保证安装后可正确解析新增的媒体处理能力。

## 0.2.0 - 2026-09-08

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

## 0.1.0

- 初始版本：QQ 官方机器人适配器，支持 WebSocket Gateway 与 Webhook 两种连接模式，  
  覆盖群聊、C2C 私聊、频道、频道私信四大场景。
