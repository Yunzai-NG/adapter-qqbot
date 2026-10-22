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
  IncomingEvent,
  IncomingMessageEvent,
  IncomingRequestEvent,
  QuoteInfo,
  Segment,
  UserInfo,
  MemberInfo,
  Logger
} from "@yunzai-ng/types"
import { decodeMessage, addGuildPrefix, classifyAttachment, sceneExtValue, selfIdsOf } from "./codec.js"
import type { DecodeOptions } from "./codec.js"
import { normalizeUrl } from "./media.js"
import type {
  Attachment,
  GroupMessageEvent,
  C2CMessageEvent,
  GuildMessageEvent,
  DirectMessageEvent,
  MessageSceneInfo,
  MsgAuthor,
  MsgElement,
  MsgNode
} from "./types.js"

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
      return decodeGroupMessage(data as GroupMessageEvent, selfId)
    case "C2C_MESSAGE_CREATE":
      return decodeC2CMessage(data as C2CMessageEvent, selfId)
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

/**
 * 构造引用消息。
 *
 * 三种场景取引用的方式并不相同：
 * - 群 / C2C：报文带 `message_type=103`，被引消息的正文**内联**在 `msg_elements`，
 *   引用索引在 `message_scene.ext` 的 `ref_msg_idx`。正文已经到手，无需额外请求，
 *   这里直接解析成消息段 —— 否则 `e.images` 永远拿不到「被引用的图片」。
 * - 频道 / 频道私信：只有 `message_reference.message_id`，正文需另调接口，故只填 id。
 *
 * 注意群 / C2C 没有真实的被引消息 id，`QuoteInfo.messageId` 只能填 `ref_msg_idx` 索引，
 * 仅供日志与去重参考，不可直接用于发送时的 `message_reference`。
 * @param source 消息事件报文
 * @param guildScope 频道场景：被引正文里的 @ uid 需加 qg_ 前缀
 * @returns 引用信息；无引用时 undefined
 */
function buildQuote(source: QuoteSource, guildScope = false): QuoteInfo | undefined {
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
    message.push(...decodeMessage(element.content, element.attachments, guildScope))
    if (!sender && element.author?.id) {
      sender = {
        uid: guildScope ? addGuildPrefix(element.author.id) : element.author.id,
        name: element.author.username,
        avatar: element.author.avatar
      }
    }
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
 * 解析群消息
 * @param data 群消息报文
 * @returns 内核消息事件
 */
function decodeGroupMessage(data: GroupMessageEvent, selfId?: string): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments, false, decodeOptions(selfId, data.mentions))
  return {
    kind: "message",
    scene: "group",
    messageId: data.id,
    message,
    sender: {
      uid: data.author.id,
      gid: data.group_openid,
      name: data.author.username,
      avatar: data.author.avatar,
      role: data.author.role || "member"
    } as MemberInfo,
    group: { gid: data.group_openid },
    quote: buildQuote(data),
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

/**
 * 解析 C2C 消息
 * @param data 单聊消息报文
 * @returns 内核消息事件
 */
function decodeC2CMessage(data: C2CMessageEvent, selfId?: string): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments, false, decodeOptions(selfId, data.mentions))
  return {
    kind: "message",
    scene: "private",
    subType: "friend",
    messageId: data.id,
    message,
    sender: {
      uid: data.author.id,
      name: data.author.username,
      avatar: data.author.avatar
    } as UserInfo,
    quote: buildQuote(data),
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
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
      uid: addGuildPrefix(data.author.id),
      name: data.author.username,
      avatar: data.author.avatar,
      role: data.author.member_role || "member"
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
    sender: {
      uid: addGuildPrefix(data.author.id),
      name: data.author.username,
      avatar: data.author.avatar
    } as UserInfo,
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
