/**
 * 模块职责：将 QQ Bot 的事件报文翻译为内核的 IncomingEvent
 * 依赖方向：依赖 codec / types
 * 生命周期：纯函数（仅在传入 logger 时产生调试日志副作用）
 * 注意事项：
 *   - QQ Bot 的事件类型以 GROUP_AT_MESSAGE_CREATE、C2C_MESSAGE_CREATE 等命名
 *   - 需区分群消息、私聊消息、频道消息和频道私信
 *   - 部分事件（如 FRIEND_ADD）需要特殊处理
 *   - 引用消息的取法随场景而异：群 / C2C 内联在 msg_elements，频道只有 message_reference
 *   - 传入 logger 时会在入口打印平台下发的原始事件，便于调试
 */
import type {
  ForwardNode,
  IncomingEvent,
  IncomingMessageEvent,
  IncomingRequestEvent,
  QuoteInfo,
  Segment,
  UserInfo,
  MemberInfo,
  Logger
} from "@yunzai-ng/types"
import { decodeArk, decodeMessage, addGuildPrefix, classifyAttachment, sceneExtValue, selfIdsOf } from "../protocol/codec.js"
import type { DecodeOptions } from "../protocol/codec.js"
import { normalizeUrl } from "../media/resolve.js"
import type {
  Attachment,
  MessageCreateEvent,
  GuildMessageEvent,
  DirectMessageEvent,
  MessageSceneInfo,
  MsgAuthor,
  MsgElement,
  MsgNode
} from "../protocol/types.js"

/** 序列化原始事件用于调试输出（容忍循环引用等不可序列化情况） */
function stringifyRaw(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/**
 * 组装解码选项
 *
 * `mentions` 总要带上：它既用来识别机器人自己，也用来给 `at` 段补展示名。
 * @param selfId 适配器认定的自身 id（真实 QQ 号）
 * @param mentions 报文 `mentions` 字段
 * @returns 解码选项
 */
function decodeOptions(selfId?: string, mentions?: readonly MsgAuthor[]): DecodeOptions {
  const options: DecodeOptions = { mentions }
  if (selfId) {
    options.selfId = selfId
    options.selfMentions = selfIdsOf(mentions)
  }
  return options
}

/**
 * 把平台附件渲染成一行详细描述，供控制台排障
 *
 * 输出形如：
 * `image,height=351,id=2216239210,size=48809,url=https://…,width=1206,file=https://…,name=xxx.jpg`
 * 多个附件以 ` | ` 分隔；缺省字段（平台没下发）不输出，避免出现 `height=undefined`。
 * @param attachments 平台下发的附件列表
 * @returns 单行描述；无附件时为空串
 */
export function describeAttachments(attachments?: readonly Attachment[]): string {
  if (!attachments || attachments.length === 0) return ""
  return attachments
    .map(attachment => {
      const url = normalizeUrl(attachment.url)
      const fields: Array<[string, unknown]> = [
        ["height", attachment.height],
        ["id", attachment.id],
        ["size", attachment.size],
        ["url", url],
        ["width", attachment.width],
        ["file", url],
        ["name", attachment.filename],
        // 语音专有：平台不保证下发，缺失时由 filter 自动略过
        ["asr", attachment.asr_refer_text],
        ["wav", attachment.voice_wav_url ? normalizeUrl(attachment.voice_wav_url) : undefined]
      ]
      const body = fields
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",")
      const type = classifyAttachment(attachment.content_type)
      return body ? `${type},${body}` : type
    })
    .join(" | ")
}

/** 把消息段渲染成一行可读摘要，供引用详情日志使用 */
function describeSegments(segments: readonly Segment[]): string {
  return segments
    .map(segment => {
      switch (segment.type) {
        case "text": return segment.text
        case "at": return `@${segment.name ?? segment.uid}`
        case "atAll": return "@全体"
        case "face": return `[表情${segment.id}]`
        case "image": return `[图片${segment.summary ? ` ${segment.summary}` : ""}]`
        case "record": return "[语音]"
        case "video": return "[视频]"
        case "file": return `[文件${segment.name ? ` ${segment.name}` : ""}]`
        case "share": return `[分享 ${segment.title}]`
        case "forward": return `[聊天记录${segment.nodes ? ` ${segment.nodes.length}条` : ""}]`
        case "raw": return ""
        default: return `[${segment.type}]`
      }
    })
    .join("")
}

/**
 * 把引用消息渲染成一行详细描述，供控制台排障
 *
 * 输出形如：`引用 [REFIDX_X50iYj1Fv3B0jXJ5lwrZR+2…] 归途守候你(FF23…): 2`
 * 群 / C2C 的索引是一长串 base64，截断以免淹没日志；频道只有 id、没有正文。
 * @param quote 引用信息
 * @returns 单行描述；无引用时为空串
 */
export function describeQuote(quote?: QuoteInfo): string {
  if (!quote) return ""
  const id = quote.messageId.length > 24 ? `${quote.messageId.slice(0, 24)}…` : quote.messageId
  const head = `引用 [${id}]${quote.sender ? ` ${quote.sender.name ?? ""}(${quote.sender.uid})` : ""}`
  const body = quote.message?.length ? describeSegments(quote.message) : quote.text ?? ""
  return body ? `${head}: ${body}` : head
}

/**
 * 解析事件
 * @param eventType 事件类型
 * @param data 事件数据
 * @param logger 可选日志器；传入时在入口打印平台下发的原始事件
 * @param selfId 适配器认定的自身 id；传入后机器人自己的 @ 会换成该 id，`e.atMe` 才成立
 * @returns 内核事件；无法处理时 undefined
 */
export function decodeEvent(
  eventType: string,
  data: unknown,
  logger?: Logger,
  selfId?: string
): IncomingEvent | undefined {
  logger?.debug(`[qqbot] 收到平台事件 ${eventType}：${stringifyRaw(data)}`)
  const payload = data as Record<string, any>
  switch (eventType) {
    // ── 消息事件 ──
    case "GROUP_AT_MESSAGE_CREATE":
    case "GROUP_MESSAGE_CREATE":
      return decodeMessageCreate(data as MessageCreateEvent, true, selfId)
    case "C2C_MESSAGE_CREATE":
      return decodeMessageCreate(data as MessageCreateEvent, false, selfId)
    case "AT_MESSAGE_CREATE":
    case "MESSAGE_CREATE":
      return decodeGuildMessage(data as GuildMessageEvent, selfId)
    case "DIRECT_MESSAGE_CREATE":
      return decodeDirectMessage(data as DirectMessageEvent, selfId)

    // ── 好友（C2C）事件 ──
    case "FRIEND_ADD":
      return notice("friend.increase", { uid: payload.openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "FRIEND_DEL":
      return notice("friend.decrease", { uid: payload.openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "C2C_MSG_REJECT":
      return notice("friend.msgReject", { uid: payload.openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "C2C_MSG_RECEIVE":
      return notice("friend.msgReceive", { uid: payload.openid, time: parseTimestamp(payload.timestamp) }, payload)

    // ── 群事件 ──
    case "GROUP_ADD_ROBOT":
      return notice("group.robot.add", { gid: payload.group_openid, uid: payload.op_member_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_DEL_ROBOT":
      return notice("group.robot.del", { gid: payload.group_openid, uid: payload.op_member_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MSG_REJECT":
      return notice("group.msgReject", { gid: payload.group_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MSG_RECEIVE":
      return notice("group.msgReceive", { gid: payload.group_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MEMBER_ADD":
      return {
        kind: "notice",
        noticeType: "group.increase",
        gid: payload.group_openid ?? payload.group_id,
        uid: payload.member_openid ?? payload.user_openid ?? payload.user_id,
        operatorId: payload.op_member_openid ?? payload.operator_id,
        way: "other",
        time: parseTimestamp(payload.timestamp),
        raw: payload
      }
    case "GROUP_MEMBER_REMOVE":
      return {
        kind: "notice",
        noticeType: "group.decrease",
        gid: payload.group_openid ?? payload.group_id,
        uid: payload.member_openid ?? payload.user_openid ?? payload.user_id,
        operatorId: payload.op_member_openid ?? payload.operator_id,
        way: "other",
        time: parseTimestamp(payload.timestamp),
        raw: payload
      }
    case "GROUP_JOIN_REQUEST":
      return decodeGroupJoinRequest(payload)

    // ── 频道事件 ──
    case "GUILD_CREATE":
      return notice("guild.increase", {
        gid: payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_UPDATE":
      return notice("guild.update", {
        gid: payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_DELETE":
      return notice("guild.decrease", {
        gid: payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 子频道事件 ──
    case "CHANNEL_CREATE":
      return notice("channel.increase", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "CHANNEL_UPDATE":
      return notice("channel.update", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "CHANNEL_DELETE":
      return notice("channel.decrease", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 频道成员事件 ──
    case "GUILD_MEMBER_ADD":
      return notice("guild.member.increase", {
        gid: payload.guild_id,
        uid: addGuildPrefix(payload.user?.id),
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_MEMBER_UPDATE":
      return notice("guild.member.update", {
        gid: payload.guild_id,
        uid: addGuildPrefix(payload.user?.id),
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_MEMBER_REMOVE":
      return notice("guild.member.decrease", {
        gid: payload.guild_id,
        uid: addGuildPrefix(payload.user?.id),
        operatorId: addGuildPrefix(payload.op_user_id),
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 表情表态事件 ──
    case "MESSAGE_REACTION_ADD":
      return notice("reaction.add", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        uid: addGuildPrefix(payload.user_id),
        messageId: payload.target?.id,
        emoji: payload.emoji,
        time: Date.now()
      }, payload)
    case "MESSAGE_REACTION_REMOVE":
      return notice("reaction.remove", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        uid: addGuildPrefix(payload.user_id),
        messageId: payload.target?.id,
        emoji: payload.emoji,
        time: Date.now()
      }, payload)

    // ── 互动事件 ──
    case "INTERACTION_CREATE":
      return decodeInteraction(payload)

    // ── 消息审核事件 ──
    case "MESSAGE_AUDIT_PASS":
      return decodeMessageAudit(payload, true)
    case "MESSAGE_AUDIT_REJECT":
      return decodeMessageAudit(payload, false)

    // ── 消息删除事件 ──
    case "PUBLIC_MESSAGE_DELETE":
      return notice("guild.message.delete", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        messageId: payload.message_id,
        time: Date.now()
      }, payload)
    case "MESSAGE_DELETE":
      return notice("guild.message.delete", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        messageId: payload.message_id || payload.id,
        time: Date.now()
      }, payload)

    // ── 论坛事件 ──
    case "FORUM_THREAD_CREATE":
      return decodeForumEvent("forum.thread.create", payload)
    case "FORUM_THREAD_UPDATE":
      return decodeForumEvent("forum.thread.update", payload)
    case "FORUM_THREAD_DELETE":
      return decodeForumEvent("forum.thread.delete", payload)
    case "FORUM_POST_CREATE":
      return decodeForumEvent("forum.post.create", payload)
    case "FORUM_POST_DELETE":
      return decodeForumEvent("forum.post.delete", payload)
    case "FORUM_REPLY_CREATE":
      return decodeForumEvent("forum.reply.create", payload)
    case "FORUM_REPLY_DELETE":
      return decodeForumEvent("forum.reply.delete", payload)
    case "FORUM_PUBLISH_AUDIT_RESULT":
      return decodeForumAudit(payload)

    // ── 公域论坛事件（字段较私域精简） ──
    case "OPEN_FORUM_THREAD_CREATE":
      return decodeOpenForumEvent("open_forum.thread.create", payload)
    case "OPEN_FORUM_THREAD_UPDATE":
      return decodeOpenForumEvent("open_forum.thread.update", payload)
    case "OPEN_FORUM_THREAD_DELETE":
      return decodeOpenForumEvent("open_forum.thread.delete", payload)
    case "OPEN_FORUM_POST_CREATE":
      return decodeOpenForumEvent("open_forum.post.create", payload)
    case "OPEN_FORUM_POST_DELETE":
      return decodeOpenForumEvent("open_forum.post.delete", payload)
    case "OPEN_FORUM_REPLY_CREATE":
      return decodeOpenForumEvent("open_forum.reply.create", payload)
    case "OPEN_FORUM_REPLY_DELETE":
      return decodeOpenForumEvent("open_forum.reply.delete", payload)

    // ── 音频事件 ──
    case "AUDIO_START":
      return notice("audio.start", { gid: payload.guild_id, channelId: payload.channel_id, time: Date.now() }, payload)
    case "AUDIO_FINISH":
      return notice("audio.finish", { gid: payload.guild_id, channelId: payload.channel_id, time: Date.now() }, payload)
    case "AUDIO_ON_MIC":
      return notice("audio.onMic", { gid: payload.guild_id, channelId: payload.channel_id, uid: addGuildPrefix(payload.user_id), time: Date.now() }, payload)
    case "AUDIO_OFF_MIC":
      return notice("audio.offMic", { gid: payload.guild_id, channelId: payload.channel_id, uid: addGuildPrefix(payload.user_id), time: Date.now() }, payload)

    // ── 音视频/直播子频道成员进出 ──
    case "AUDIO_OR_LIVE_CHANNEL_MEMBER_ENTER":
      return notice("channel.member.enter", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        channelType: payload.channel_type,
        uid: addGuildPrefix(payload.user_id),
        time: Date.now()
      }, payload)
    case "AUDIO_OR_LIVE_CHANNEL_MEMBER_EXIT":
      return notice("channel.member.exit", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        channelType: payload.channel_type,
        uid: addGuildPrefix(payload.user_id),
        time: Date.now()
      }, payload)

    default:
      // 未知事件降级为 GenericNotice
      return {
        kind: "notice",
        noticeType: `qqbot.${eventType.toLowerCase()}`,
        data: payload,
        raw: payload
      }
  }
}

// ── 辅助函数 ──

/** 构造 notice 事件 */
function notice(noticeType: string, data: Record<string, unknown>, raw: Record<string, unknown>): IncomingEvent {
  return { kind: "notice", noticeType, data, raw }
}

/** 解析时间戳（支持字符串和数字） */
function parseTimestamp(timestamp: unknown): number {
  if (typeof timestamp === "number") return timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  if (typeof timestamp === "string") {
    const parsed = new Date(timestamp).getTime()
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

// ── 引用消息解析 ──

/** 引用关系的原始来源：群/C2C 走 msg_elements，频道走 message_reference */
interface QuoteSource {
  message_type?: number
  message_scene?: MessageSceneInfo
  msg_elements?: MsgElement[]
  parallel_message?: { msg_nodes?: MsgNode[] }
  message_reference?: { message_id: string }
}

/** 取消息段里所有文本段拼成的纯文本（用于 QuoteInfo.text 摘要） */
function plainTextOf(segments: readonly Segment[]): string {
  let text = ""
  for (const segment of segments) {
    if (segment.type === "text") text += segment.text
  }
  return text.trim()
}

/** 引用消息 */
const MESSAGE_TYPE_QUOTE = 103
/** 聊天记录（合并转发） */
const MESSAGE_TYPE_FORWARD = 102

/**
 * 平台 author → 内核用户信息
 *
 * 三处要点，缺一处就会在日志里看到一串 openid 而不是名字：
 * - **id 的兜底顺序**：群消息的 `author` 可能只有 `member_openid`（没有 `id`），
 *   C2C 只有 `user_openid`，频道才有 `id`。只读 `author.id` 会让群消息的 uid 变成
 *   `undefined`，进而带崩 `atMe` 与主人判断。
 * - **名称只有 `author.username` 一个来源**，群 / C2C / 频道 / 频道私信全一样。
 *   官方文档示例里的 `"username": ""` 是占位，实际报文有值。
 * - **空串归一成 `undefined`**：内核日志是 `name ?? ""` + `(uid)`，留空串会打出
 *   `(openid)` 这种既没名字又不像错误的样子；归一后内核才知道真的没有名字。
 * @param author 报文里的 author
 * @param guildScope 频道场景：uid 需加 `qg_` 前缀
 * @returns 用户信息；连 id 都没有时 undefined
 */
function senderOf(author: MsgAuthor | undefined, guildScope: boolean): UserInfo | undefined {
  const id = author?.id ?? author?.member_openid ?? author?.user_openid
  if (!id) return undefined
  const name = author?.username?.trim()
  return {
    uid: guildScope ? addGuildPrefix(id) : id,
    name: name || undefined,
    avatar: author?.avatar
  }
}

/**
 * 解码单个消息元素：正文、附件、卡片，以及嵌套的子元素
 *
 * 嵌套的聊天记录（`message_type=102`）收成一个 `forward` 段；其余嵌套元素直接展开在后面。
 * @param element 消息元素
 * @param guildScope 频道场景：@ uid 需加 qg_ 前缀
 * @returns 消息段
 */
function decodeElement(element: MsgElement, guildScope: boolean): Segment[] {
  const segments = decodeMessage(element.content, element.attachments, guildScope)
  segments.push(...decodeArk(element.ark_data))
  const children = element.msg_elements
  if (children?.length) {
    if (element.message_type === MESSAGE_TYPE_FORWARD) {
      segments.push(forwardOf(children, guildScope))
    } else {
      for (const child of children) segments.push(...decodeElement(child, guildScope))
    }
  }
  return segments
}

/**
 * 把一组元素收成合并转发段，每个元素一个节点
 *
 * 平台常把整段聊天记录压成一个元素、正文是 `=== 消息 1 ===` 这样的摘要文本，
 * 这时只有一个节点，内容即摘要 —— 不去猜它的格式。
 * @param elements 聊天记录中的元素
 * @param guildScope 频道场景
 * @returns 合并转发段
 */
function forwardOf(elements: readonly MsgElement[], guildScope: boolean): Segment {
  const nodes: ForwardNode[] = elements.map(element => {
    const sender = senderOf(element.author, guildScope)
    const node: ForwardNode = { message: decodeElement(element, guildScope) }
    if (sender) {
      node.uid = sender.uid
      if (sender.name) node.name = sender.name
    }
    return node
  })
  return { type: "forward", nodes }
}

/** 报文是否为引用：类型标明 103，或带了引用索引 / 引用 id */
function isQuote(source: QuoteSource): boolean {
  return source.message_type === MESSAGE_TYPE_QUOTE
    || source.message_reference?.message_id !== undefined
    || sceneExtValue(source.message_scene?.ext, "ref_msg_idx") !== undefined
}

/**
 * 解码群 / C2C 报文的消息体：正文 + 附件 + 卡片 + 非引用的消息元素
 *
 * `msg_elements` 的含义随 `message_type` 而变：
 * - 103 引用：是被引消息，交给 {@link buildQuote}，不进正文；
 * - 102 聊天记录：收成 `forward` 段追加在正文之后（正文是平台生成的摘要）；
 * - 其他（如 101 并行消息）：仅当报文自身没有正文、附件和卡片时才展开为正文，
 *   避免平台把同一内容在两处各给一份时重复。
 * @param data 群 / C2C 消息报文
 * @param selfId 适配器认定的自身 id
 * @returns 消息段
 */
function decodeBody(data: MessageCreateEvent, selfId?: string): Segment[] {
  const message = decodeMessage(data.content, data.attachments, false, decodeOptions(selfId, data.mentions))
  message.push(...decodeArk(data.ark_data))
  const elements = data.msg_elements
  if (!elements?.length || isQuote(data)) return message
  if (data.message_type === MESSAGE_TYPE_FORWARD) {
    message.push(forwardOf(elements, false))
  } else if (!data.content?.trim() && !data.attachments?.length && !data.ark_data) {
    message.length = 0
    for (const element of elements) message.push(...decodeElement(element, false))
  }
  return message
}

/**
 * 构造引用消息。
 *
 * 三种场景取引用的方式并不相同：
 * - 群 / C2C：报文带 `message_type=103`，被引消息的正文**内联**在 `msg_elements`，
 *   引用索引在 `message_scene.ext` 的 `ref_msg_idx`。正文已经到手，无需额外请求，
 *   这里直接解析成消息段 —— 否则 `e.images` 永远拿不到「被引用的图片」。
 * - 频道 / 频道私信：只有 `message_reference.message_id`，正文需另调接口，故只填 id。
 *
 * 不是引用的报文（聊天记录、卡片等也会带 `msg_elements`）一律返回 undefined。
 *
 * 注意群 / C2C 没有真实的被引消息 id，`QuoteInfo.messageId` 只能填 `ref_msg_idx` 索引，
 * 仅供日志与去重参考，不可直接用于发送时的 `message_reference`。
 * @param source 消息事件报文
 * @param guildScope 频道场景：被引正文里的 @ uid 需加 qg_ 前缀
 * @returns 引用信息；无引用时 undefined
 */
function buildQuote(source: QuoteSource, guildScope = false): QuoteInfo | undefined {
  if (!isQuote(source)) return undefined
  // msg_elements 是权威来源；parallel_message 是部分版本随报文附带的等价内容，作兜底
  const elements: MsgElement[] = source.msg_elements?.length
    ? source.msg_elements
    : (source.parallel_message?.msg_nodes ?? []).map(node => ({ content: node.content }))
  const messageId = source.message_reference?.message_id
    ?? sceneExtValue(source.message_scene?.ext, "ref_msg_idx")
    ?? elements[0]?.msg_idx

  if (!elements.length) {
    return messageId ? { messageId } : undefined
  }

  const message: Segment[] = []
  let sender: UserInfo | undefined
  for (const element of elements) {
    message.push(...decodeElement(element, guildScope))
    sender ??= senderOf(element.author, guildScope)
  }
  if (!message.length) {
    return messageId ? { messageId } : undefined
  }

  return {
    messageId: messageId ?? "",
    sender,
    text: plainTextOf(message) || undefined,
    message
  }
}

// ── 消息事件解析 ──

/**
 * 解析群 / C2C 消息
 *
 * 三个事件共用同一个事件体，解码完全一致，只有场景与发送者信息按群 / 单聊分开填。
 * @param data 消息报文
 * @param group 是否群消息
 * @param selfId 适配器认定的自身 id
 * @returns 内核消息事件
 */
function decodeMessageCreate(data: MessageCreateEvent, group: boolean, selfId?: string): IncomingMessageEvent {
  const base = {
    kind: "message" as const,
    messageId: data.id,
    message: decodeBody(data, selfId),
    quote: buildQuote(data),
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
  // sender 是内核必填字段，故 author 整个缺失时也要给个占位，不能省
  const sender = senderOf(data.author, false) ?? { uid: "" }
  if (!group) return { ...base, scene: "private", subType: "friend", sender }

  const gid = data.group_openid ?? ""
  return {
    ...base,
    scene: "group",
    sender: { ...sender, gid, role: data.author?.member_role || "member" } as MemberInfo,
    group: { gid }
  }
}

/**
 * 解析频道消息
 * @param data 频道消息报文
 * @returns 内核消息事件
 */
function decodeGuildMessage(data: GuildMessageEvent, selfId?: string): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments, true, decodeOptions(selfId, data.mentions))
  return {
    kind: "message",
    scene: "guild",
    messageId: data.id,
    seq: data.seq_in_channel ? Number(data.seq_in_channel) : undefined,
    message,
    sender: {
      ...(senderOf(data.author, true) ?? { uid: "" }),
      role: data.author?.member_role || "member"
    } as UserInfo,
    channel: {
      channelId: data.channel_id,
      guildId: data.guild_id,
      name: addGuildPrefix(`${data.guild_id}-${data.channel_id}`)
    },
    quote: buildQuote(data, true),
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

/**
 * 解析频道私信
 * @param data 频道私信报文
 * @returns 内核消息事件
 */
function decodeDirectMessage(data: DirectMessageEvent, selfId?: string): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments, true, decodeOptions(selfId, data.mentions))
  return {
    kind: "message",
    scene: "private",
    subType: "direct",
    messageId: data.id,
    message,
    sender: senderOf(data.author, true) ?? { uid: "" },
    channel: { channelId: data.channel_id, guildId: data.guild_id },
    quote: buildQuote(data, true),
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

// ── 互动事件解析 ──

function decodeInteraction(payload: Record<string, any>): IncomingEvent {
  const scene = payload.scene
  const base = { time: Date.now() }
  if (scene === "c2c") {
    return notice("friend.action", { ...base, uid: payload.user_openid, data: payload.data, noticeId: payload.id }, payload)
  }
  if (scene === "group") {
    return notice("group.action", { ...base, gid: payload.group_openid, uid: payload.group_member_openid, data: payload.data, noticeId: payload.id }, payload)
  }
  if (scene === "guild") {
    return notice("guild.action", { ...base, gid: payload.guild_id, channelId: payload.channel_id, uid: addGuildPrefix(payload.data?.resolved?.user_id), data: payload.data, noticeId: payload.id }, payload)
  }
  return notice("interaction", { ...base, data: payload.data, noticeId: payload.id }, payload)
}

// ── 消息审核事件解析 ──

function decodeMessageAudit(
  data: Record<string, any>,
  passed: boolean
): IncomingEvent {
  return {
    kind: "notice",
    noticeType: passed ? "message.audit.pass" : "message.audit.reject",
    data: {
      auditId: data.audit_id,
      auditTime: parseTimestamp(data.audit_time),
      guildId: data.guild_id,
      channelId: data.channel_id,
      messageId: data.message_id,
      createTime: parseTimestamp(data.create_time),
      passed
    },
    raw: data
  }
}

// ── 论坛事件解析 ──

function decodeForumEvent(subType: string, payload: Record<string, any>): IncomingEvent {
  const data: Record<string, unknown> = {
    gid: payload.guild_id,
    channelId: payload.channel_id,
    uid: addGuildPrefix(payload.author_id)
  }
  // 提取具体内容信息
  if (payload.thread_info) {
    data.threadId = payload.thread_info.thread_id
    data.title = payload.thread_info.title
    data.content = payload.thread_info.content
    data.time = parseTimestamp(payload.thread_info.date_time)
  } else if (payload.post_info) {
    data.threadId = payload.post_info.thread_id
    data.postId = payload.post_info.post_id
    data.content = payload.post_info.content
    data.time = parseTimestamp(payload.post_info.date_time)
  } else if (payload.reply_info) {
    data.threadId = payload.reply_info.thread_id
    data.postId = payload.reply_info.post_id
    data.replyId = payload.reply_info.reply_id
    data.content = payload.reply_info.content
    data.time = parseTimestamp(payload.reply_info.date_time)
  }
  return notice(subType, data, payload)
}

function decodeForumAudit(payload: Record<string, any>): IncomingEvent {
  return notice("forum.audit", {
    gid: payload.guild_id,
    channelId: payload.channel_id,
    uid: addGuildPrefix(payload.author_id),
    threadId: payload.thread_id,
    postId: payload.post_id,
    replyId: payload.reply_id,
    type: payload.type,
    result: payload.result,
    message: payload.err_msg
  }, payload)
}

// ── 公域论坛事件解析 ──

function decodeOpenForumEvent(subType: string, payload: Record<string, any>): IncomingEvent {
  return notice(subType, {
    gid: payload.guild_id,
    channelId: payload.channel_id,
    uid: addGuildPrefix(payload.author_id),
    time: parseTimestamp(payload.timestamp)
  }, payload)
}

// ── 入群申请事件解析 ──

function decodeGroupJoinRequest(payload: Record<string, any>): IncomingRequestEvent {
  const invited = payload.invited_by != null || payload.apply_source === "invited"
  const comment = typeof payload.verify_info === "string"
    ? payload.verify_info
    : payload.verify_info?.verify_message
  return {
    kind: "request",
    requestType: invited ? "group.invite" : "group.add",
    uid: payload.member_openid,
    gid: payload.group_openid,
    comment,
    flag: `${payload.group_openid}:${payload.member_openid}:${payload.join_request_id ?? ""}`,
    time: parseTimestamp(payload.apply_at ?? payload.timestamp),
    raw: payload
  }
}
