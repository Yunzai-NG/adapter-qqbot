/**
 * QQ Bot API v2 类型定义
 */

/** Access Token 响应 */
export interface TokenResponse {
  access_token: string
  expires_in: number
  expire_time: string
}

/** Gateway 信息 */
export interface GatewayInfo {
  url: string
  shards: number
  session_start_limit?: {
    total: number
    remaining: number
    reset_after: number
    max_concurrency: number
  }
}

/** WebSocket Payload */
export interface WSPayload {
  id?: string
  op: number
  d: unknown
  s?: number
  t?: string
}

/** Identify 数据 */
export interface IdentifyData {
  token: string
  intents: number
  shard: [number, number]
  properties?: {
    $os?: string
    $browser?: string
    $device?: string
  }
}

/** Resume 数据 */
export interface ResumeData {
  token: string
  session_id: string
  seq: number
}

/** READY 事件数据 */
export interface ReadyData {
  version: number
  session_id: string
  user: {
    id: string
    username: string
    bot: boolean
  }
  shard: [number, number]
  heartbeat_interval?: number
}

/** OpCode 定义 */
export const OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  HTTP_CALLBACK_ACK: 12,
  CALLBACK_URL_VALIDATION: 13
} as const

/** Intents 定义 */
export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  C2C_GROUP_AT_MESSAGE_CREATE: 1 << 25,
  GROUP_AT_MESSAGE_CREATE: 1 << 5,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29
} as const

/** 消息类型 */
export type MessageScene = "group" | "private" | "guild"

/** 机器人自身信息（GET /users/@me） */
export interface QQBotSelfInfo {
  id: string
  username: string
  avatar: string
  bot?: boolean
}

/** 用户信息（GET /v2/users/{openid}/info） */
export interface QQUserInfo {
  openid: string
  nickname: string
  head_url: string
}

/**
 * 消息场景上下文。
 *
 * 群 / C2C 的引用关系不走 `message_reference`，而是塞在 `ext` 里：
 * `msg_idx=` 当前消息索引、`ref_msg_idx=` 被引用消息索引、`auth_token=` 鉴权令牌。
 */
export interface MessageSceneInfo {
  /** 场景来源，`default` = 默认聊天窗口 */
  source?: string
  /** 扩展数据，每项形如 `key=value` */
  ext?: string[]
}

/** 消息元素里携带的发送者；字段随场景而异，一律可选 */
export interface MsgAuthor {
  id?: string
  username?: string
  avatar?: string
  bot?: boolean
  /** 该条提及是否指向当前机器人；平台用它标明「@ 的是你」 */
  is_you?: boolean
  /** 群成员 openid */
  member_openid?: string
  /** 单聊用户 openid */
  user_openid?: string
  /** 跨应用统一 openid */
  union_openid?: string
  /** 跨应用统一用户账号（可能为空） */
  union_user_account?: string
  /** 群内角色：member / admin / owner */
  member_role?: string
}

/**
 * 卡片类型标识。文档列出的取值之外平台可能新增，故保留 string 兜底。
 * - tuwen：图文 H5（如快手分享链接）
 * - feed：图文卡片（群相册、频道帖子、分享卡片）
 * - miniapp：小程序（微信小程序、QQ 小程序、哔哩哔哩等）
 * - map：位置卡片
 * - contact_card：好友名片
 * - video_share：视频分享
 * - music_together：一起听歌
 * - picture：图片
 */
export type ArkType =
  | "tuwen"
  | "feed"
  | "miniapp"
  | "map"
  | "contact_card"
  | "video_share"
  | "music_together"
  | "picture"
  | (string & {})

/** 卡片消息字段；只列文档给出的常见键名，其余键随卡片类型而异 */
export interface ArkFields {
  /** 来源标签 */
  tag?: string
  /** 来源标签（部分卡片为多个） */
  tags?: string | string[]
  /** 标题 */
  title?: string
  /** 描述 */
  desc?: string
  /** 跳转链接 */
  jump_url?: string
  /** 预览图 */
  preview?: string
  /** 来源名称 */
  source?: string
  /** 来源图标 */
  source_logo?: string
  /** 标签图标 */
  tag_icon?: string
  /** 昵称（好友名片等） */
  nickname?: string
  /** 头像（好友名片等） */
  avatar?: string
  /** 地址（位置卡片） */
  address?: string
  [key: string]: unknown
}

/**
 * 结构化卡片消息数据（`message_type=3` 时下发）。
 *
 * 与发送用的 {@link ArkPayload}（模板 id + kv）结构不同，是平台把卡片解析后的结果。
 */
export interface ArkData {
  /** 卡片中的用户操作提示文本 */
  prompt?: string
  /** 卡片类型标识 */
  ark_type?: ArkType
  /** 卡片类型的中文名称，如「图文 H5」「小程序」「图文卡片」 */
  ark_name?: string
  /** 卡片字段 */
  fields?: ArkFields
}

/**
 * 消息元素。
 *
 * `message_type=103`（引用消息）时，被引消息的正文会内联在这里 —— 无需额外请求即可取到，
 * 这正是 `e.images` 能识别「被引用的图片」的数据来源。
 */
export interface MsgElement {
  /** 该元素对应的被引用消息索引 */
  msg_idx?: string
  /** 该元素对应的消息发送者 */
  author?: MsgAuthor
  /** 0=普通文本 3=结构化卡片 101=并行消息 102=聊天记录 103=引用消息 */
  message_type?: number
  /** 消息正文 */
  content?: string
  /** 该元素携带的附件 */
  attachments?: Attachment[]
  /** 结构化卡片数据（message_type=3 时有值） */
  ark_data?: ArkData
  /** 嵌套消息元素列表（递归结构） */
  msg_elements?: MsgElement[]
}

/** 并行消息节点 */
export interface MsgNode {
  content?: string
  message_type?: number
}

/**
 * 群 / C2C 消息事件体。
 *
 * GROUP_AT_MESSAGE_CREATE、GROUP_MESSAGE_CREATE、C2C_MESSAGE_CREATE 共用同一个事件体，区别只在：
 * - 群消息带 `group_openid`，`author` 填 `member_openid` / `member_role`；C2C 填 `user_openid`；
 * - GROUP_AT_MESSAGE_CREATE 的 `content` 已去掉 @机器人 前缀，`mentions` 也不含机器人自身。
 */
export interface MessageCreateEvent {
  /** 消息 ID，可用于被动回复和撤回 */
  id: string
  /** 群 OpenID；仅群消息有 */
  group_openid?: string
  /** 纯附件消息（图片/语音/视频单发）平台不下发该字段 */
  content?: string
  /** 消息发送时间，RFC3339 格式 */
  timestamp: string
  /**
   * 发送者
   *
   * **不能假定 `id` 存在**：群消息的 author 可能只带 `member_openid`，C2C 只带
   * `user_openid`。官方文档示例里两者并列，实际报文常只给其中一个。
   * 文档也未列 avatar，实际可能不带。
   */
  author: MsgAuthor
  message_reference?: { message_id: string }
  attachments?: Attachment[]
  /** 消息内容类型：0=普通文本 3=卡片 101=并行消息 102=聊天记录 103=引用消息 */
  message_type?: number
  /** 消息场景上下文（引用场景下含 `ref_msg_idx`） */
  message_scene?: MessageSceneInfo
  /** 消息元素列表；引用场景下即被引消息的内容 */
  msg_elements?: MsgElement[]
  /** 并行消息节点（部分引用场景随报文一同下发） */
  parallel_message?: { msg_nodes?: MsgNode[] }
  /** 消息中 @ 的用户；全量模式下 `is_you: true` 的那条就是当前机器人 */
  mentions?: MsgAuthor[]
  /** 结构化卡片消息数据（message_type=3 时有值） */
  ark_data?: ArkData
}

/** 频道消息事件（AT_MESSAGE_CREATE） */
export interface GuildMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  /** 纯附件消息（图片/语音/视频单发）平台不下发该字段 */
  content?: string
  timestamp: string
  message_reference?: { message_id: string }
  author: {
    id: string
    username: string
    avatar: string
    member_role?: string
  }
  member?: {
    roles?: string[]
    joined_at?: string
  }
  attachments?: Attachment[]
  seq_in_channel?: string
  /** 消息中 @ 的用户；**包含机器人自身**，`is_you: true` 的那条就是当前机器人 */
  mentions?: MsgAuthor[]
}

/** 频道私信事件（DIRECT_MESSAGE_CREATE） */
export interface DirectMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  /** 纯附件消息（图片/语音/视频单发）平台不下发该字段 */
  content?: string
  timestamp: string
  message_reference?: { message_id: string }
  author: {
    id: string
    username: string
    avatar: string
  }
  attachments?: Attachment[]
  src_guild_id?: string
  /** 消息中 @ 的用户；**包含机器人自身**，`is_you: true` 的那条就是当前机器人 */
  mentions?: MsgAuthor[]
}

/** 消息审核事件 */
export interface MessageAuditEvent {
  audit_id: string
  audit_time: string
  guild_id: string
  channel_id: string
  message_id: string
  create_time: string
}

/** 创建私信会话请求 */
export interface CreateDirectSessionRequest {
  recipient_id: string
  source_guild_id: string
}

/** 创建私信会话响应 */
export interface CreateDirectSessionResponse {
  guild_id: string
  channel_id: string
  create_time: string
}

/** 附件 */
export interface Attachment {
  content_type: string
  filename: string
  url: string
  height?: number
  width?: number
  size?: number
  /** 平台侧附件 id（日志/排障用，不参与消息段构造） */
  id?: string
  /** 语音附件：SILK 等格式转换后的 WAV 直链（仅语音有，平台不保证下发） */
  voice_wav_url?: string
  /** 语音附件：平台侧的 ASR 参考识别文本（仅语音有，平台不保证下发） */
  asr_refer_text?: string
}

/** 发送消息请求 */
export interface SendMessageRequest {
  content?: string
  msg_type?: number
  markdown?: MarkdownPayload
  keyboard?: KeyboardPayload
  ark?: ArkPayload
  /** 频道 Embed（msg_type=4） */
  embed?: Record<string, unknown>
  image?: string
  file_image?: string
  media?: {
    file_info: string
  }
  /** 图文卡片（msg_type=8）；仅群聊 / C2C 支持，频道无此能力 */
  card?: MessageCard
  message_reference?: {
    message_id: string
  }
  event_id?: string
  msg_id?: string
  /** 被动回复序号：同一 msg_id 的多条回复需递增，否则第二条起被平台静默丢弃 */
  msg_seq?: number
}

/** 富媒体上传请求 */
export interface UploadMediaRequest {
  /** 1=图片, 2=视频, 3=语音, 4=文件 */
  file_type: number
  url?: string
  /** base64 编码的文件内容 */
  file_data?: string
  srv_send_msg?: boolean
  file_name?: string
}

/** 富媒体上传响应 */
export interface UploadMediaResponse {
  file_uuid: string
  file_info: string
  ttl: number
}

/** 分片预上传请求 */
export interface UploadPrepareRequest {
  /** 1=图片 2=视频 3=语音 4=文件 */
  file_type: number
  file_size: string
  file_name: string
  md5: string
  sha1: string
  md5_10m: string
}

/** 单个分片信息 */
export interface UploadPart {
  index: number
  presigned_url: string
  block_size: string
}

/** 分片上传的并发与重试配置（服务端下发，缺省用上游默认） */
export interface UploadConfig {
  concurrency?: number
  retry_timeout?: number
  retry_delay?: number
}

/** 分片预上传响应 */
export interface UploadPrepareResponse {
  upload_id: string
  block_size: string
  parts: UploadPart[]
  upload_config?: UploadConfig
}

/** 单分片完成通知请求 */
export interface UploadPartFinishRequest {
  upload_id: string
  part_index: number
  block_size: string
  md5: string
}

/** files 接口请求：URL 转存（带 url）或合并分片（带 upload_id） */
export interface FilesRequest {
  /** 1=图片 2=视频 3=语音 4=文件 */
  file_type: number
  url?: string
  upload_id?: string
  file_name?: string
  srv_send_msg?: boolean
}

/** 官方素材库：申请图片上传 */
export interface MediaImagePrepareRequest {
  /** 文件名（含扩展名，扩展名须与 content_type 一致） */
  file_name: string
  /** 文件大小（字节） */
  file_size: number
  /** 图片 MIME：image/png / image/jpeg / image/gif / image/webp */
  content_type: string
  /** 文件内容 MD5（32 位十六进制） */
  md5: string
  /** 文件内容 SHA1（40 位十六进制） */
  sha1: string
}

/** 官方素材库：申请图片上传的响应 */
export interface MediaImagePrepareResponse {
  /** 上传任务 ID，4 小时内有效 */
  upload_id: string
  /** 预签名直传地址 */
  presigned_url: string
  /** 预签名地址有效期（秒） */
  expires_in: number
}

/** 官方素材库：完成图片上传 */
export interface MediaImageCompleteRequest {
  /** prepare 返回的上传任务 ID */
  upload_id: string
  /** 文件 MD5（与 COS 对象 ETag 比对） */
  md5: string
}

/** 官方素材库：完成图片上传的响应 */
export interface MediaImageCompleteResponse {
  /** 图片 ID，用于查询与删除 */
  image_id: string
  /** Markdown 引用链接：qqbot-media://image/v1/<token> */
  url: string
  /** 滑动有效期（秒），每次被消息引用后顺延 */
  ttl: number
  /** 临时预览链接，仅供自查 */
  preview_url?: string
}

/** 官方素材库：单张有效图片 */
export interface MediaImageItem {
  /** 图片 ID，用于删除 */
  image_id: string
  /** Markdown 引用链接 */
  url: string
  /** 上传时的文件名 */
  file_name: string
  /** 临时预览链接，仅供自查 */
  preview_url?: string
  /** 上传时间（Unix 秒） */
  created_at: number
  /** 过期时间（Unix 秒），每次被引用后顺延 */
  expires_at: number
}

/** 官方素材库：查询有效图片的响应 */
export interface MediaImageListResponse {
  /** 图片列表，按上传时间倒序 */
  images: MediaImageItem[]
  /** 下一页游标，为空表示末页 */
  next_cursor: string
  /** 当前有效图片总数 */
  total: number
}

/** Markdown 消息 */
export interface MarkdownPayload {
  custom_template_id?: string
  params?: Array<{
    key: string
    values: string[]
  }>
  content?: string
}

/** 键盘消息 */
export interface KeyboardPayload {
  /** 平台键盘模板 ID */
  id?: string
  /** 使用键盘模板时的机器人 AppID */
  bot_appid?: string
  content?: {
    rows: Array<{
      buttons: Array<{
        /** 按钮 ID，同一键盘内唯一 */
        id?: string
        render_data: {
          /** 按钮文字，最多 10 字符 */
          label: string
          /** 点击后文字，不传则保持不变 */
          visited_label?: string
          /** 0：灰色线框，1：蓝色线框，3：白底红字，4：蓝底白字（官方未定义 2） */
          style: number
        }
        action: {
          /** 0：跳转按钮 1：回调按钮 2：指令按钮 */
          type: number
          permission?: {
            /** 0=指定用户, 1=管理员, 2=所有人 */
            type: number
            specify_role_ids?: string[]
            specify_user_ids?: string[]
          }
          /** 回调数据，type=1/2 时必填 */
          data?: string
          /** 指令按钮：点击后直接自动发送 data（仅单聊） */
          enter?: boolean
          /** 指令按钮：指令是否带引用回复本消息 */
          reply?: boolean
          /** 指令按钮：设为 1 时忽略 enter 并唤起选图器 */
          anchor?: number
          /** 版本过低时提示文案 */
          unsupport_tips?: string
          /** 二次确认；content 非空时点击先弹确认 */
          modal?: {
            content?: string
            confirm_text?: string
            cancel_text?: string
          }
        }
        /** 分组 ID：同组按钮点击后其余变灰，仅 action.type=1 有效 */
        group_id?: string
      }>
    }>
  }
}

/** Ark 消息 */
export interface ArkPayload {
  template_id: number
  kv: Array<{
    key: string
    value?: string
    obj?: Array<{
      obj_key: string
      obj_value: string
    }>
  }>
}

/** 图文卡片元素；四个字段平台均为必填 */
export interface TuwenCardContent {
  /** 标题，1-50 字符 */
  title: string
  /** 描述，1-200 字符 */
  description: string
  /** 点击跳转链接，必须为 https，≤1024 字符 */
  url: string
  /** 封面图链接，必须为 https，≤1024 字符 */
  pic_url: string
}

/**
 * 卡片消息（msg_type=8）
 *
 * 目前平台只开放 `tuwen`（图文卡片）一种类型，群聊与 C2C 均支持，频道不支持。
 */
export interface MessageCard {
  /** 卡片类型：tuwen=图文卡片 */
  type: "tuwen"
  /** 卡片元素 */
  content: TuwenCardContent
}

/** 发送消息响应 */
export interface SendMessageResponse {
  id: string
  timestamp: string
  /** 消息进入平台审核队列，id 为 audit_id。 */
  auditStatus?: "pending"
  /** 审核响应或平台未识别字段，供调用方排障。 */
  raw?: unknown
}

/** API 错误 */
export interface QQBotError {
  code: number
  message: string
  data?: unknown
}

/** 群聊信息 */
export interface GroupInfo {
  group_openid: string
  name?: string
  avatar?: string
  owner_id?: string
  admin_count?: number
  member_count?: number
}

/** 频道信息 */
export interface GuildInfo {
  id: string
  name: string
  icon?: string
  owner_id?: string
  member_count?: number
  max_members?: number
  description?: string
  joined_at?: string
}

/** 子频道信息 */
export interface ChannelInfo {
  id: string
  guild_id: string
  name: string
  type: number
  sub_type: number
  position?: number
  parent_id?: string
  owner_id?: string
  private_type?: number
  speak_permission?: number
  application_id?: string
  permissions?: string
}

/** 群成员信息 */
export interface GroupMemberInfo {
  member_openid: string
  join_type: string
  role: string
  username: string | undefined
  joined_at: number | undefined
  bot: boolean
}

/** 频道成员信息 */
export interface GuildMemberInfo {
  user: {
    id: string
    username: string
    avatar: string
    bot?: boolean
  }
  nick: string
  roles: string[]
  joined_at: string
}
