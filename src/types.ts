/**
 * QQ Bot API v2 类型定义
 */

/** Access Token 响应 */
export interface TokenResponse {
  /**
   *
   */
  access_token: string
  /**
   *
   */
  expires_in: number
  /**
   *
   */
  expire_time: string
}

/** Gateway 信息 */
export interface GatewayInfo {
  /**
   *
   */
  url: string
  /**
   *
   */
  shards: number
  /**
   *
   */
  session_start_limit?: {
    total: number
    remaining: number
    reset_after: number
    max_concurrency: number
  }
}

/** WebSocket Payload */
export interface WSPayload {
  /**
   *
   */
  id?: string
  /**
   *
   */
  op: number
  /**
   *
   */
  d: unknown
  /**
   *
   */
  s?: number
  /**
   *
   */
  t?: string
}

/** Identify 数据 */
export interface IdentifyData {
  /**
   *
   */
  token: string
  /**
   *
   */
  intents: number
  /**
   *
   */
  shard: [number, number]
  /**
   *
   */
  properties?: {
    $os?: string
    $browser?: string
    $device?: string
  }
}

/** Resume 数据 */
export interface ResumeData {
  /**
   *
   */
  token: string
  /**
   *
   */
  session_id: string
  /**
   *
   */
  seq: number
}

/** READY 事件数据 */
export interface ReadyData {
  /**
   *
   */
  version: number
  /**
   *
   */
  session_id: string
  /**
   *
   */
  user: {
    id: string
    username: string
    bot: boolean
  }
  /**
   *
   */
  shard: [number, number]
  /**
   *
   */
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

/** 用户信息 */
/** 机器人自身信息（GET /users/@me） */
export interface QQBotSelfInfo {
  /**
   *
   */
  id: string
  /**
   *
   */
  username: string
  /**
   *
   */
  avatar: string
  /**
   *
   */
  bot?: boolean
}

/** 用户信息（GET /v2/users/{openid}/info） */
export interface QQUserInfo {
  /**
   *
   */
  openid: string
  /**
   *
   */
  nickname: string
  /**
   *
   */
  head_url: string
}

/** @deprecated 使用 QQBotSelfInfo 或 QQUserInfo */
export interface QQUser {
  /**
   *
   */
  id: string
  /**
   *
   */
  username: string
  /**
   *
   */
  avatar: string
  /**
   *
   */
  bot?: boolean
}

/** 群消息事件 */
export interface GroupMessageEvent {
  /**
   *
   */
  id: string
  /**
   *
   */
  group_openid: string
  /**
   *
   */
  content: string
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  author: {
    id: string
    username: string
    avatar: string
  }
  /**
   *
   */
  attachments?: Attachment[]
}

/** C2C 消息事件 */
export interface C2CMessageEvent {
  /**
   *
   */
  id: string
  /**
   *
   */
  author: {
    id: string
    username: string
    avatar: string
  }
  /**
   *
   */
  content: string
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  attachments?: Attachment[]
}

/** 频道消息事件（AT_MESSAGE_CREATE） */
export interface GuildMessageEvent {
  /**
   *
   */
  id: string
  /**
   *
   */
  channel_id: string
  /**
   *
   */
  guild_id: string
  /**
   *
   */
  content: string
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  author: {
    id: string
    username: string
    avatar: string
    member_role?: string
  }
  /**
   *
   */
  member?: {
    roles?: string[]
    joined_at?: string
  }
  /**
   *
   */
  attachments?: Attachment[]
  /**
   *
   */
  seq_in_channel?: string
}

/** 频道私信事件（DIRECT_MESSAGE_CREATE） */
export interface DirectMessageEvent {
  /**
   *
   */
  id: string
  /**
   *
   */
  channel_id: string
  /**
   *
   */
  guild_id: string
  /**
   *
   */
  content: string
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  author: {
    id: string
    username: string
    avatar: string
  }
  /**
   *
   */
  attachments?: Attachment[]
  /**
   *
   */
  src_guild_id?: string
}

/** 消息审核事件 */
export interface MessageAuditEvent {
  /**
   *
   */
  audit_id: string
  /**
   *
   */
  audit_time: string
  /**
   *
   */
  guild_id: string
  /**
   *
   */
  channel_id: string
  /**
   *
   */
  message_id: string
  /**
   *
   */
  create_time: string
}

/** 创建私信会话请求 */
export interface CreateDirectSessionRequest {
  /**
   *
   */
  recipient_id: string
  /**
   *
   */
  source_guild_id: string
}

/** 创建私信会话响应 */
export interface CreateDirectSessionResponse {
  /**
   *
   */
  guild_id: string
  /**
   *
   */
  channel_id: string
  /**
   *
   */
  create_time: string
}

/** 附件 */
export interface Attachment {
  /**
   *
   */
  content_type: string
  /**
   *
   */
  filename: string
  /**
   *
   */
  url: string
  /**
   *
   */
  height?: number
  /**
   *
   */
  width?: number
  /**
   *
   */
  size?: number
}

/** 发送消息请求 */
export interface SendMessageRequest {
  /**
   *
   */
  content?: string
  /**
   *
   */
  msg_type?: number
  /**
   *
   */
  markdown?: MarkdownPayload
  /**
   *
   */
  keyboard?: KeyboardPayload
  /**
   *
   */
  ark?: ArkPayload
  /**
   *
   */
  image?: string
  /**
   *
   */
  file_image?: string
  /**
   *
   */
  media?: {
    file_info: string
  }
  /**
   *
   */
  message_reference?: {
    message_id: string
  }
  /**
   *
   */
  event_id?: string
  /**
   *
   */
  msg_id?: string
}

/** 富媒体上传请求 */
export interface UploadMediaRequest {
  /**
   *
   */
  file_type: number // 1=图片, 2=视频, 3=语音, 4=文件
  /**
   *
   */
  url?: string
  /**
   *
   */
  file_data?: string // base64
  /**
   *
   */
  srv_send_msg?: boolean
  /**
   *
   */
  file_name?: string
}

/** 富媒体上传响应 */
export interface UploadMediaResponse {
  /**
   *
   */
  file_uuid: string
  /**
   *
   */
  file_info: string
  /**
   *
   */
  ttl: number
}

/** Markdown 消息 */
export interface MarkdownPayload {
  /**
   *
   */
  custom_template_id?: string
  /**
   *
   */
  params?: Array<{
    key: string
    values: string[]
  }>
  /**
   *
   */
  content?: string
}

/** 键盘消息 */
export interface KeyboardPayload {
  /**
   *
   */
  id?: string
  /**
   *
   */
  content?: {
    rows: Array<{
      buttons: Array<{
        id?: string
        render_data: {
          label: string
          visited_label?: string
          style: number
        }
        action: {
          type: number
          permission?: {
            type: number
            specify_role_ids?: string[]
            specify_user_ids?: string[]
          }
          data?: string
        }
      }>
    }>
  }
}

/** Ark 消息 */
export interface ArkPayload {
  /**
   *
   */
  template_id: number
  /**
   *
   */
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
  /**
   *
   */
  id: string
  /**
   *
   */
  timestamp: string
}

/** API 错误 */
export interface QQBotError {
  /**
   *
   */
  code: number
  /**
   *
   */
  message: string
  /**
   *
   */
  data?: unknown
}

/** 群聊信息 */
export interface GroupInfo {
  /**
   *
   */
  group_openid: string
  /**
   *
   */
  name?: string
  /**
   *
   */
  avatar?: string
  /**
   *
   */
  owner_id?: string
  /**
   *
   */
  admin_count?: number
  /**
   *
   */
  member_count?: number
}

/** 频道信息 */
export interface GuildInfo {
  /**
   *
   */
  id: string
  /**
   *
   */
  name: string
  /**
   *
   */
  icon?: string
  /**
   *
   */
  owner_id?: string
  /**
   *
   */
  member_count?: number
  /**
   *
   */
  max_members?: number
  /**
   *
   */
  description?: string
  /**
   *
   */
  joined_at?: string
}

/** 子频道信息 */
export interface ChannelInfo {
  /**
   *
   */
  id: string
  /**
   *
   */
  guild_id: string
  /**
   *
   */
  name: string
  /**
   *
   */
  type: number
  /**
   *
   */
  sub_type: number
  /**
   *
   */
  position?: number
  /**
   *
   */
  parent_id?: string
  /**
   *
   */
  owner_id?: string
  /**
   *
   */
  private_type?: number
  /**
   *
   */
  speak_permission?: number
  /**
   *
   */
  application_id?: string
  /**
   *
   */
  permissions?: string
}

/** 群成员信息 */
export interface GroupMemberInfo {
  /**
   *
   */
  member_openid: string
  /**
   *
   */
  join_type: string
  /**
   *
   */
  role: string
}

/** 频道成员信息 */
export interface GuildMemberInfo {
  /**
   *
   */
  user: {
    id: string
    username: string
    avatar: string
    bot?: boolean
  }
  /**
   *
   */
  nick: string
  /**
   *
   */
  roles: string[]
  /**
   *
   */
  joined_at: string
}
