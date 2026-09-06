/**
 * 模块职责：将 QQ Bot 的事件报文翻译为内核的 IncomingEvent
 * 依赖方向：依赖 codec / types
 * 生命周期：纯函数
 * 注意事项：
 *   - QQ Bot 的事件类型以 GROUP_AT_MESSAGE_CREATE、C2C_MESSAGE_CREATE 等命名
 *   - 需区分群消息、私聊消息、频道消息和频道私信
 *   - 部分事件（如 FRIEND_ADD）需要特殊处理
 */
import type { IncomingEvent, IncomingMessageEvent, UserInfo, MemberInfo } from "@yunzai-ng/types"
import { decodeMessage } from "./codec.js"
import type { GroupMessageEvent, C2CMessageEvent, GuildMessageEvent, DirectMessageEvent } from "./types.js"

/**
 * 解析事件
 * @param eventType 事件类型
 * @param data 事件数据
 * @returns 内核事件；无法处理时 undefined
 */
export function decodeEvent(eventType: string, data: unknown): IncomingEvent | undefined {
  const payload = data as Record<string, any>
  switch (eventType) {
    // ── 消息事件 ──
    case "GROUP_AT_MESSAGE_CREATE":
      return decodeGroupMessage(data as GroupMessageEvent)
    case "C2C_MESSAGE_CREATE":
      return decodeC2CMessage(data as C2CMessageEvent)
    case "AT_MESSAGE_CREATE":
    case "MESSAGE_CREATE":
      return decodeGuildMessage(data as GuildMessageEvent)
    case "DIRECT_MESSAGE_CREATE":
      return decodeDirectMessage(data as DirectMessageEvent)

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
      return notice("group.increase", { gid: payload.group_openid, uid: payload.op_member_openid, way: "invite", time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_DEL_ROBOT":
      return notice("group.decrease", { gid: payload.group_openid, uid: payload.op_member_openid, way: "kick", time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MSG_REJECT":
      return notice("group.msgReject", { gid: payload.group_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MSG_RECEIVE":
      return notice("group.msgReceive", { gid: payload.group_openid, time: parseTimestamp(payload.timestamp) }, payload)
    case "GROUP_MEMBER_ADD":
      return notice("group.member.increase", {
        gid: payload.group_openid ?? payload.group_id,
        uid: payload.member_openid ?? payload.user_openid ?? payload.user_id,
        operatorId: payload.op_member_openid ?? payload.operator_id,
        time: parseTimestamp(payload.timestamp)
      }, payload)
    case "GROUP_MEMBER_REMOVE":
      return notice("group.member.decrease", {
        gid: payload.group_openid ?? payload.group_id,
        uid: payload.member_openid ?? payload.user_openid ?? payload.user_id,
        operatorId: payload.op_member_openid ?? payload.operator_id,
        time: parseTimestamp(payload.timestamp)
      }, payload)

    // ── 频道事件 ──
    case "GUILD_CREATE":
      return notice("guild.increase", {
        gid: payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_UPDATE":
      return notice("guild.update", {
        gid: payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_DELETE":
      return notice("guild.decrease", {
        gid: payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 子频道事件 ──
    case "CHANNEL_CREATE":
      return notice("channel.increase", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "CHANNEL_UPDATE":
      return notice("channel.update", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "CHANNEL_DELETE":
      return notice("channel.decrease", {
        gid: payload.guild_id,
        channelId: payload.channel_id || payload.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 频道成员事件 ──
    case "GUILD_MEMBER_ADD":
      return notice("guild.member.increase", {
        gid: payload.guild_id,
        uid: payload.user?.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_MEMBER_UPDATE":
      return notice("guild.member.update", {
        gid: payload.guild_id,
        uid: payload.user?.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)
    case "GUILD_MEMBER_REMOVE":
      return notice("guild.member.decrease", {
        gid: payload.guild_id,
        uid: payload.user?.id,
        operatorId: payload.op_user_id,
        time: parseTimestamp(payload.joined_at)
      }, payload)

    // ── 表情表态事件 ──
    case "MESSAGE_REACTION_ADD":
      return notice("reaction.add", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        uid: payload.user_id,
        messageId: payload.target?.id,
        emoji: payload.emoji,
        time: Date.now()
      }, payload)
    case "MESSAGE_REACTION_REMOVE":
      return notice("reaction.remove", {
        gid: payload.guild_id,
        channelId: payload.channel_id,
        uid: payload.user_id,
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

    // ── 音频事件 ──
    case "AUDIO_START":
      return notice("audio.start", { gid: payload.guild_id, channelId: payload.channel_id, time: Date.now() }, payload)
    case "AUDIO_FINISH":
      return notice("audio.finish", { gid: payload.guild_id, channelId: payload.channel_id, time: Date.now() }, payload)
    case "AUDIO_ON_MIC":
      return notice("audio.onMic", { gid: payload.guild_id, channelId: payload.channel_id, uid: payload.user_id, time: Date.now() }, payload)
    case "AUDIO_OFF_MIC":
      return notice("audio.offMic", { gid: payload.guild_id, channelId: payload.channel_id, uid: payload.user_id, time: Date.now() }, payload)

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

// ── 消息事件解析 ──

function decodeGroupMessage(data: GroupMessageEvent): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments)
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
      role: "member"
    } as MemberInfo,
    group: { gid: data.group_openid },
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

function decodeC2CMessage(data: C2CMessageEvent): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments)
  return {
    kind: "message",
    scene: "private",
    messageId: data.id,
    message,
    sender: {
      uid: data.author.id,
      name: data.author.username,
      avatar: data.author.avatar
    } as UserInfo,
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

function decodeGuildMessage(data: GuildMessageEvent): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments)
  return {
    kind: "message",
    scene: "guild",
    messageId: data.id,
    message,
    sender: {
      uid: data.author.id,
      name: data.author.username,
      avatar: data.author.avatar,
      role: data.author.member_role || "member"
    } as UserInfo,
    channel: {
      channelId: data.channel_id,
      guildId: data.guild_id,
      name: `${data.guild_id}-${data.channel_id}`
    },
    time: new Date(data.timestamp).getTime(),
    raw: data as unknown as Record<string, unknown>
  }
}

function decodeDirectMessage(data: DirectMessageEvent): IncomingMessageEvent {
  const message = decodeMessage(data.content, data.attachments)
  return {
    kind: "message",
    scene: "private",
    subType: "direct",
    messageId: data.id,
    message,
    sender: {
      uid: data.author.id,
      name: data.author.username,
      avatar: data.author.avatar
    } as UserInfo,
    channel: { channelId: data.channel_id, guildId: data.guild_id },
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
    return notice("guild.action", { ...base, gid: payload.guild_id, channelId: payload.channel_id, uid: payload.data?.resolved?.user_id, data: payload.data, noticeId: payload.id }, payload)
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
    uid: payload.author_id
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
    uid: payload.author_id,
    threadId: payload.thread_id,
    postId: payload.post_id,
    replyId: payload.reply_id,
    type: payload.type,
    result: payload.result,
    message: payload.err_msg
  }, payload)
}
