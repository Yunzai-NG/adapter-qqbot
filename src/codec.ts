/**
 * 模块职责：消息在通用模型与 QQ Bot API 之间的双向翻译
 * 依赖方向：依赖 types
 * 生命周期：纯函数
 * 注意事项：
 *   - QQ Bot 支持文本、Markdown、Ark、键盘等多种消息类型
 *   - 图片需先上传获取 URL 或使用 file_image 字段
 *   - @提及使用 <@user_id> 格式
 */
import type { Segment } from "@yunzai-ng/types"
import type { Attachment } from "./types.js"
import { decodeMedia } from "./media.js"

/** QQ Bot 消息段 */
export interface QQBotSegment {
  type: string
  data: Record<string, unknown>
}

/** 平台标识 */
export const PLATFORM = "qqbot"

/**
 * 频道场景 ID 前缀。
 * QQ 频道的用户 id 与「频道号-子频道」组合 id 都是超出 JS 安全整数范围的纯数字，
 * 下游一旦按数字解析就会丢精度；加前缀使其不再是合法数字，把错误暴露在转换处。
 */
export const GUILD_PREFIX = "qg_"

/** 给频道场景 ID 加前缀；空值（空串 / undefined）原样返回 */
export function addGuildPrefix<T extends string | undefined>(id: T): T {
  return (id ? `${GUILD_PREFIX}${id}` : id) as T
}

/** 去掉频道场景 ID 前缀，还原为 API 所需的裸 ID */
export function stripGuildPrefix(id: string): string {
  return id.startsWith(GUILD_PREFIX) ? id.slice(GUILD_PREFIX.length) : id
}

/**
 * 从频道场景 gid（qg_ 前缀或「频道号-子频道」组合格式）还原为纯 guild_id。
 * 群聊 gid 为 32 位大写十六进制，不含 "-"，不会误入此函数的拆分逻辑。
 */
export function plainGuildId(gid: string): string {
  const plain = stripGuildPrefix(gid)
  const dash = plain.indexOf("-")
  return dash === -1 ? plain : plain.slice(0, dash)
}

/** 是否为群聊 group_openid（32 位大写十六进制） */
export function isGroupOpenId(gid: string): boolean {
  return /^[A-F0-9]{32}$/.test(gid)
}

/** 是否为频道场景 ID（qg_ 前缀 / 「频道号-子频道」组合 / 纯数字频道号） */
export function isGuildScopeId(gid: string): boolean {
  const plain = stripGuildPrefix(gid)
  return plain.includes("-") || /^\d+$/.test(plain)
}

/**
 * 附件 MIME / 类型标识 → 通用段类型
 *
 * QQ 的 `content_type` 并不总是规范 MIME：图片是 `image/jpeg`、视频是 `video/mp4`，
 * 但**语音只给裸的 `voice`**（不带斜杠），按 MIME 前缀判断会掉进 file 分支，
 * 于是语音消息被显示成「文件 xxx.amr」。这里把 `voice` / `audio` 一并归入 record。
 * @param contentType 平台下发的 content_type
 * @returns 通用段类型名
 */
export function classifyAttachment(contentType: string): "image" | "record" | "video" | "file" {
  const mime = contentType.toLowerCase()
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/") || mime === "voice" || mime.startsWith("voice/")) return "record"
  if (mime.startsWith("video/")) return "video"
  return "file"
}

/**
 * 从 `message_scene.ext` 中取出某个 `key=value` 项的值。
 *
 * 群 / C2C 的引用关系不走 `message_reference`：被引消息的索引塞在 ext 的 `ref_msg_idx=`，
 * 当前消息的索引在 `msg_idx=`，另有 `auth_token=` 鉴权令牌。这里按前缀匹配取值，
 * 值本身可能含 `=`（如 base64 索引），故只切第一个 `=`。
 * @param ext 平台下发的扩展数组
 * @param key 要取的键名
 * @returns 对应的值；键不存在时 undefined
 */
export function sceneExtValue(ext: readonly string[] | undefined, key: string): string | undefined {
  if (!ext) return undefined
  const prefix = `${key}=`
  for (const item of ext) {
    if (item.startsWith(prefix)) return item.slice(prefix.length)
  }
  return undefined
}

/** 群成员角色映射：owner / admin / member */
export function mapGroupRole(role: string): "owner" | "admin" | "member" {
  return role === "owner" ? "owner" : role === "admin" ? "admin" : "member"
}

/** 频道成员角色映射：4=owner, 2=admin, 其余=member */
export function mapGuildRole(roles: string[]): "owner" | "admin" | "member" {
  return roles.includes("4") ? "owner" : roles.includes("2") ? "admin" : "member"
}

/**
 * 解码 QQ Bot 消息
 * @param content 消息内容；纯附件消息（如图片单发）平台不下发该字段，此处按空串处理
 * @param attachments 附件列表
 * @param guildScope 频道场景；@提及的用户 id 加 qg_ 前缀
 * @returns 通用消息段数组
 */
export function decodeMessage(
  content: string | undefined,
  attachments?: Attachment[],
  guildScope = false
): Segment[] {
  const segments: Segment[] = []
  // 图片/语音/视频单发时平台只给 attachments，content 为 undefined；不能直接取 .length
  const text = content ?? ""

  // @、@全体与 QQ 原生表情按出现位置拆开，保留其余原文。
  const tokenRegex = /<@!?(everyone|\d+)>|<emoji:(\d+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) })
    }
    if (match[1] === "everyone") {
      segments.push({ type: "atAll" })
    } else if (match[1]) {
      segments.push({ type: "at", uid: guildScope ? addGuildPrefix(match[1]) : match[1] })
    } else if (match[2]) {
      segments.push({ type: "face", id: Number(match[2]) })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) })
  }

  for (const attachment of attachments ?? []) {
    // 附件 → MediaRef 的优先级链集中在 media.decodeMedia，此处不再就地拼 URL
    const file = decodeMedia(attachment)
    switch (classifyAttachment(attachment.content_type)) {
      case "image":
        segments.push({
          type: "image",
          file,
          summary: attachment.filename,
          width: attachment.width,
          height: attachment.height
        })
        break
      case "record":
        segments.push({ type: "record", file })
        break
      case "video":
        segments.push({ type: "video", file })
        break
      default:
        segments.push({ type: "file", file, name: attachment.filename, size: attachment.size })
    }
  }

  return segments
}
