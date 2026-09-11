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
 * @param content 消息内容
 * @param attachments 附件列表
 * @param guildScope 频道场景；@提及的用户 id 加 qg_ 前缀
 * @returns 通用消息段数组
 */
export function decodeMessage(
  content: string,
  attachments?: Attachment[],
  guildScope = false
): Segment[] {
  const segments: Segment[] = []

  // @、@全体与 QQ 原生表情按出现位置拆开，保留其余原文。
  const tokenRegex = /<@!?(everyone|\d+)>|<emoji:(\d+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokenRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: content.slice(lastIndex, match.index) })
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
  if (lastIndex < content.length) {
    segments.push({ type: "text", text: content.slice(lastIndex) })
  }

  for (const attachment of attachments ?? []) {
    const file = { kind: "url" as const, url: attachment.url }
    const contentType = attachment.content_type.toLowerCase()
    if (contentType.startsWith("image/")) {
      segments.push({
        type: "image",
        file,
        summary: attachment.filename,
        width: attachment.width,
        height: attachment.height
      })
    } else if (contentType.startsWith("audio/")) {
      segments.push({ type: "record", file })
    } else if (contentType.startsWith("video/")) {
      segments.push({ type: "video", file })
    } else {
      segments.push({ type: "file", file, name: attachment.filename, size: attachment.size })
    }
  }

  return segments
}
