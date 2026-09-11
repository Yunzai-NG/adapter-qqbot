/**
 * 模块职责：把内核 Segment[] 编译为符合 QQ「一条仅一个富元素」约束的消息计划
 * 依赖方向：依赖 media / markdown / types；不执行网络请求
 * 生命周期：无状态纯函数；bot.ts 仅负责执行产出的计划
 * 注意事项：每个段必须编码、可读降级或记录 warn，绝不静默丢弃
 */
import type {
  ForwardNode,
  KeyboardButton,
  MediaRef,
  Segment
} from "@yunzai-ng/types"
import type { ArkPayload, KeyboardPayload, MarkdownPayload, SendMessageRequest } from "./types.js"
import {
  buildTemplateMarkdown,
  escapeMarkdown,
  keyboardAsInlineText,
  keyboardAsPlainText,
  splitKeyboards,
  type MarkdownMode
} from "./markdown.js"
import { stripGuildPrefix } from "./codec.js"
import type { MediaFileType } from "./media.js"

/** 一条待发送消息；至多携带一个富媒体 / markdown / ark / embed 元素 */
export interface OutboundMessage {
  /** 待发 API 请求 */
  request: SendMessageRequest
  /** 群 / C2C：先上传拿 file_info 回填 request.media */
  upload?: { ref: MediaRef; fileType: MediaFileType; name?: string }
  /** 频道 / 频道私信：本地图片走 multipart 的 file_image */
  guildBlob?: MediaRef
}

/** 编译消息计划所需场景与配置 */
export interface OutboundContext {
  /** group/c2c 走 v2 富媒体；guild 包括频道与频道私信 */
  scene: "group" | "private" | "guild"
  /** 是否启用 markdown 总开关 */
  markdownEnabled: boolean
  /** raw / inline / template / legacy */
  markdownMode?: MarkdownMode
  /** template 模式模板 id */
  markdownTemplateId?: string
  /** template 参数键序列 */
  markdownTemplateKeys?: string
  /** 按钮模板 id；存在时优先于 content 键盘 */
  keyboardTemplateId?: string
  /** bot appid，模板键盘需要 */
  appId?: string
  /** 转发展开策略：merge 合并进一条消息，multiple 每节点单独成条 */
  forwardMode?: "merge" | "multiple"
  /** 无法如实编码时记录警告 */
  warn?: (message: string) => void
}

/** raw qqbot media 私有段数据 */
interface RawMediaData {
  ref?: MediaRef
  file?: MediaRef
  fileType?: MediaFileType
  file_type?: MediaFileType
  name?: string
  file_info?: string
}

function rawObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readable(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isArk(value: unknown): value is ArkPayload {
  const obj = rawObject(value)
  return typeof obj?.template_id === "number" && Array.isArray(obj.kv)
}

function requestHasPayload(request: SendMessageRequest): boolean {
  return Boolean(
    request.content || request.markdown || request.keyboard || request.ark ||
    request.embed || request.image || request.media || request.file_image
  )
}

/**
 * 构建 QQ 出站消息计划
 * @param segments 内核规范化消息段
 * @param context 场景与 markdown 配置
 * @returns 顺序执行的消息计划
 */
export function buildOutbound(
  segments: readonly Segment[],
  context: OutboundContext
): OutboundMessage[] {
  const requestedMode = context.markdownEnabled ? context.markdownMode ?? "raw" : "legacy"
  const mode = requestedMode === "template" && !context.markdownTemplateId ? "legacy" : requestedMode
  const guild = context.scene === "guild"
  const canUseMarkdown = mode !== "legacy"
  const messages: OutboundMessage[] = []
  let content = ""
  let replyId: string | undefined
  let pendingKeyboard: KeyboardPayload | undefined

  const warn = (message: string): void => context.warn?.(`[qqbot] ${message}`)
  const append = (text: string): void => {
    content += mode === "legacy" ? text : escapeMarkdown(text, mode === "template")
  }

  const push = (message: OutboundMessage): void => {
    messages.push(message)
  }

  const emitText = (): void => {
    if (!content && !pendingKeyboard) return
    if (mode === "template" && context.markdownTemplateId) {
      const payloads = buildTemplateMarkdown(
        content || " ",
        context.markdownTemplateId,
        context.markdownTemplateKeys || "abcdefghij"
      )
      for (let index = 0; index < payloads.length; index++) {
        const request: SendMessageRequest = { msg_type: 2, markdown: payloads[index] }
        if (index === 0 && pendingKeyboard) request.keyboard = pendingKeyboard
        push({ request })
      }
    } else if (mode === "raw" || mode === "inline") {
      const request: SendMessageRequest = {
        msg_type: 2,
        markdown: { content: content || " " }
      }
      if (pendingKeyboard) request.keyboard = pendingKeyboard
      push({ request })
    } else {
      push({ request: { content: content || " " } })
    }
    content = ""
    pendingKeyboard = undefined
  }

  const emitMedia = (ref: MediaRef, fileType: MediaFileType, name?: string): void => {
    emitText()
    if (guild) {
      if (fileType !== 1) {
        append(`[${fileType === 2 ? "视频" : fileType === 3 ? "语音" : "文件"}]${name ? ` ${name}` : ""}`)
        warn(`频道不支持直接发送${fileType === 2 ? "视频" : fileType === 3 ? "语音" : "文件"}，已降级为文本`)
        emitText()
      } else if (ref.kind === "url") {
        push({ request: { image: ref.url } })
      } else if (ref.kind === "id") {
        append(`[图片 ${ref.id}]`)
        warn("频道不能使用 file_info 图片，已降级为文本")
        emitText()
      } else {
        push({ request: {}, guildBlob: ref })
      }
      return
    }
    if (ref.kind === "id") {
      push({ request: { msg_type: 7, media: { file_info: ref.id } } })
    } else {
      push({ request: { msg_type: 7 }, upload: { ref, fileType, name } })
    }
  }

  const emitMarkdown = (markdown: MarkdownPayload): void => {
    emitText()
    push({ request: { msg_type: 2, markdown } })
  }

  const emitCoreMarkdown = (markdown: string): void => {
    if (mode === "template" && context.markdownTemplateId) {
      emitText()
      append(markdown)
      emitText()
      return
    }
    emitMarkdown({ content: guild ? markdown.replace(/force_verify_image_resource/g, "") : markdown })
  }

  const emitKeyboard = (rows: readonly (readonly KeyboardButton[])[]): void => {
    if (mode === "inline") {
      content += keyboardAsInlineText(rows)
      return
    }
    if (!canUseMarkdown) {
      warn("键盘需要启用原生或模板 Markdown，已降级为可读文本")
      append(keyboardAsPlainText(rows))
      return
    }
    const keyboards = context.keyboardTemplateId
      ? [{ id: context.keyboardTemplateId, ...(context.appId ? { bot_appid: context.appId } : {}) }]
      : splitKeyboards(rows)
    if (!keyboards.length) return

    const last = messages.at(-1)
    if (content && !pendingKeyboard) {
      pendingKeyboard = keyboards.shift()
    } else if (!content && last?.request.markdown && !last.request.keyboard) {
      last.request.keyboard = keyboards.shift()
    }
    for (const keyboard of keyboards) {
      if (!content && !pendingKeyboard) {
        pendingKeyboard = keyboard
        content = " "
      } else if (content && pendingKeyboard) {
        emitText()
        pendingKeyboard = keyboard
        content = " "
      } else {
        push({ request: { msg_type: 2, markdown: { content: " " }, keyboard } })
      }
    }
  }

  const processRaw = (segment: Extract<Segment, { type: "raw" }>): void => {
    if (segment.platform !== "qqbot") {
      warn(`忽略其他平台 raw 段：${segment.platform}/${segment.platformType}`)
      append(`[raw:${segment.platform}/${segment.platformType}]`)
      return
    }
    const data = rawObject(segment.data)
    switch (segment.platformType) {
      case "ark":
        if (isArk(segment.data)) {
          emitText()
          push({ request: { msg_type: 3, ark: segment.data } })
        } else {
          warn("ark raw 数据无效，已降级为文本")
          append(readable(segment.data))
        }
        break
      case "embed":
        if (guild && data) {
          emitText()
          push({ request: { msg_type: 4, embed: data } })
        } else {
          warn("embed 仅频道支持或数据无效，已降级为文本")
          append(readable(segment.data))
        }
        break
      case "markdown":
        if (data) emitMarkdown(data as MarkdownPayload)
        else append(readable(segment.data))
        break
      case "keyboard":
        if (data) {
          emitText()
          push({ request: { msg_type: 2, markdown: { content: " " }, keyboard: data as KeyboardPayload } })
        } else append(readable(segment.data))
        break
      case "media": {
        const media = segment.data as RawMediaData
        const fileInfo = media?.file_info
        if (fileInfo) {
          if (guild) {
            append(`[图片 ${fileInfo}]`)
            warn("频道不能使用 file_info 图片，已降级为文本")
          } else {
            emitText()
            push({ request: { msg_type: 7, media: { file_info: fileInfo } } })
          }
        } else if (media?.ref || media?.file) {
          emitMedia(media.ref ?? media.file!, media.fileType ?? media.file_type ?? 1, media.name)
        } else {
          warn("media raw 数据缺少 file_info/ref，已降级为文本")
          append(readable(segment.data))
        }
        break
      }
      default:
        warn(`未知 qqbot raw 段 ${segment.platformType}，已降级为文本`)
        append(readable(segment.data))
    }
  }

  const process = (segment: Segment): void => {
    switch (segment.type) {
      case "text":
        append(segment.text)
        break
      case "at":
        if (guild) content += `<@${stripGuildPrefix(segment.uid)}>`
        else if (mode !== "legacy") content += `<qqbot-at-user id="${segment.uid}" />`
        else warn(`群/C2C 纯文本不支持 @${segment.uid}，已忽略提及语义`)
        break
      case "atAll":
        content += guild || mode === "legacy" ? "@everyone" : "<qqbot-at-everyone />"
        break
      case "face":
        content += `<emoji:${segment.id}>`
        break
      case "reply":
        replyId = segment.messageId
        break
      case "image":
        emitMedia(segment.file, 1)
        break
      case "record":
        emitMedia(segment.file, 3)
        break
      case "video":
        emitMedia(segment.file, 2)
        break
      case "file":
        emitMedia(segment.file, 4, segment.name)
        break
      case "location":
        append(`[位置] ${segment.title ?? ""}${segment.content ? `\n${segment.content}` : ""}\n${segment.lat},${segment.lon}`)
        break
      case "share":
        append(`${segment.title}${segment.content ? `\n${segment.content}` : ""}\n${segment.url}`)
        break
      case "contact":
        append(`[推荐${segment.scene === "user" ? "好友" : "群"}] ${segment.id}`)
        break
      case "json": {
        try {
          const parsed = JSON.parse(segment.data)
          if (isArk(parsed)) {
            emitText()
            push({ request: { msg_type: 3, ark: parsed } })
          } else append(segment.data)
        } catch {
          append(segment.data)
        }
        break
      }
      case "xml":
        append(`[XML] ${segment.data}`)
        break
      case "poke":
        append(`[戳一戳${segment.uid ? ` ${segment.uid}` : ""}]`)
        break
      case "dice":
        append(`[骰子${segment.result ? ` ${segment.result}` : ""}]`)
        break
      case "rps":
        append(`[猜拳${segment.result ? ` ${segment.result}` : ""}]`)
        break
      case "music":
        append(`[音乐] ${segment.title ?? segment.id ?? segment.platform}${segment.singer ? ` - ${segment.singer}` : ""}${segment.url ? `\n${segment.url}` : ""}`)
        break
      case "forward":
        emitText()
        if (segment.nodes?.length) {
          const nodes = segment.nodes
          const separate = context.forwardMode === "multiple"
          for (let index = 0; index < nodes.length; index++) {
            processForwardNode(nodes[index])
            // multiple：每节点单独成条；merge：仅在节点间插换行，末节点不留尾行
            if (separate) emitText()
            else if (content && index < nodes.length - 1) append("\n")
          }
        } else {
          append(`[转发消息${segment.id ? ` ${segment.id}` : ""}]`)
          warn("转发段没有可展开 nodes，已降级为文本")
        }
        break
      case "markdown":
        if (canUseMarkdown) {
          emitCoreMarkdown(segment.content)
        } else {
          warn("Markdown 未启用或模板 ID 缺失，已降级为纯文本")
          append(segment.content)
        }
        break
      case "keyboard":
        emitKeyboard(segment.rows)
        break
      case "raw":
        processRaw(segment)
        break
      default: {
        const exhaustive: never = segment
        warn(`未知段已降级为文本：${readable(exhaustive)}`)
        append(readable(exhaustive))
      }
    }
  }

  function processForwardNode(node: ForwardNode): void {
    if (node.message?.length) {
      for (const nested of node.message) process(nested)
    } else if (node.messageId) {
      append(`[转发消息 ${node.messageId}]`)
      warn("QQ 无法按 messageId 拉取并合并转发，已降级为文本")
    } else {
      append(`[转发节点${node.name ? ` ${node.name}` : ""}]`)
    }
  }

  for (const segment of segments) process(segment)
  emitText()

  if (replyId) {
    for (const message of messages) {
      message.request.msg_id = replyId
      message.request.message_reference = { message_id: replyId }
    }
  }

  // 有些输入只有 reply；不发送空消息。
  return messages.filter(message => message.guildBlob || message.upload || requestHasPayload(message.request))
}
