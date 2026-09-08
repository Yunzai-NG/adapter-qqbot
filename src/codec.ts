/**
 * 模块职责：消息在通用模型与 QQ Bot API 之间的双向翻译
 * 依赖方向：依赖 types
 * 生命周期：纯函数
 * 注意事项：
 *   - QQ Bot 支持文本、Markdown、Ark、键盘等多种消息类型
 *   - 图片需先上传获取 URL 或使用 file_image 字段
 *   - @提及使用 <@user_id> 格式
 */
import type { Segment, ImageSegment, MediaRef } from "@yunzai-ng/types"

/** QQ Bot 消息段 */
export interface QQBotSegment {
  /**
   *
   */
  type: string
  /**
   *
   */
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
 * 编码单个消息段
 * @param segment 通用消息段
 * @returns QQ Bot 消息段；无法表达时 undefined
 */
export function encodeSegment(segment: Segment): QQBotSegment | undefined {
  switch (segment.type) {
    case "text":
      return { type: "text", data: { text: segment.text } }

    case "at":
      return { type: "at", data: { uid: segment.uid } }

    case "atAll":
      return { type: "atAll", data: {} }

    case "image":
      return { type: "image", data: { file: segment.file } }

    case "reply":
      return { type: "reply", data: { messageId: segment.messageId } }

    case "markdown":
      return { type: "markdown", data: { content: segment.content } }

    case "keyboard":
      return { type: "keyboard", data: { rows: segment.rows } }

    case "json":
      return { type: "json", data: { data: segment.data } }

    default:
      return undefined
  }
}

/**
 * 编码消息段数组
 * @param segments 通用消息段数组
 * @returns 编码结果
 */
export function encodeSegments(segments: readonly Segment[]): {
  content: string
  markdown?: string
  image?: MediaRef
  msgType: number
} {
  let content = ""
  let markdown: string | undefined
  let image: MediaRef | undefined
  let msgType = 0 // 0: 文本, 2: Markdown, 3: Ark, 4: Keyboard

  for (const segment of segments) {
    const encoded = encodeSegment(segment)
    if (!encoded) continue

    switch (encoded.type) {
      case "text":
        content += encoded.data.text as string
        break

      case "at":
        // 频道场景的 at 段 uid 带 qg_ 前缀，还原为裸 id 再拼 <@>
        content += `<@${stripGuildPrefix(encoded.data.uid as string)}>`
        break

      case "atAll":
        content += `@everyone`
        break

      case "image":
        // 图片需单独处理
        image = encoded.data.file as MediaRef
        break

      case "markdown":
        // 原生 markdown
        markdown = encoded.data.content as string
        msgType = 2
        break

      case "reply":
        // 引用回复在发送时处理
        break
    }
  }

  return { content, markdown, image, msgType }
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
  attachments?: Array<{ content_type: string; url: string; filename: string }>,
  guildScope = false
): Segment[] {
  const segments: Segment[] = []

  // 解析 @提及
  const mentionRegex = /<@!?(\d+)>/g
  let lastIndex = 0
  let match

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: content.slice(lastIndex, match.index) })
    }

    const uid = match[1]
    if (uid === "everyone") {
      segments.push({ type: "atAll" })
    } else {
      segments.push({ type: "at", uid: guildScope ? addGuildPrefix(uid) : uid })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", text: content.slice(lastIndex) })
  }

  // 解析附件
  if (attachments) {
    for (const att of attachments) {
      if (att.content_type.startsWith("image/")) {
        segments.push({
          type: "image",
          file: { kind: "url", url: att.url }
        } as ImageSegment)
      }
    }
  }

  return segments
}
