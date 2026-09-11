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

/** 群消息事件 */
export interface GroupMessageEvent {
  id: string
  group_openid: string
  content: string
  timestamp: string
  message_reference?: { message_id: string }
  author: {
    id: string
    username: string
    avatar: string
    role?: "owner" | "admin" | "member"
  }
  attachments?: Attachment[]
}

/** C2C 消息事件 */
export interface C2CMessageEvent {
  id: string
  author: {
    id: string
    username: string
    avatar: string
  }
  content: string
  timestamp: string
  message_reference?: { message_id: string }
  attachments?: Attachment[]
}

/** 频道消息事件（AT_MESSAGE_CREATE） */
export interface GuildMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  content: string
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
}

/** 频道私信事件（DIRECT_MESSAGE_CREATE） */
export interface DirectMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  content: string
  timestamp: string
  message_reference?: { message_id: string }
  author: {
    id: string
    username: string
    avatar: string
  }
  attachments?: Attachment[]
  src_guild_id?: string
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
