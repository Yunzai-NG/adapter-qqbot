/**
 * 模块职责：消息在通用模型与 QQ Bot API 之间的双向翻译
 * 依赖方向：依赖 types
 * 生命周期：纯函数
 * 注意事项：
 *   - QQ Bot 支持文本、Markdown、Ark、键盘等多种消息类型
 *   - 图片需先上传获取 URL 或使用 file_image 字段
 *   - 发送使用新版 <qqbot-at-user>，接收兼容旧 <@user_id> 格式
 */
import type { Segment } from "@yunzai-ng/types"
import type { ArkData, Attachment, MsgAuthor } from "./types.js"
import { decodeMedia } from "../media/resolve.js"
import { parseCommand, tagAttributes } from "./interaction.js"

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
 * 解码选项
 *
 * 对齐 NapCat 的 at 段语义：`uid` 是平台用户 id，`name` 是展示名，核心日志渲染成
 * `[@name ?? uid]`、`atMe` 则拿 `uid` 与 `selfId` 比较。
 *
 * QQ Bot 的坑在于两套 id：正文 token 里是 openid / 频道用户 id，而 `selfId` 是真实
 * QQ 号，二者永不相等，群聊 `e.atMe` 因此恒为 false。报文 `mentions` 里
 * `is_you: true` 的那条就是机器人自己，据此把它的 `uid` 换成 `selfId`。
 */
export interface DecodeOptions {
  /** 适配器认定的自身 id（真实 QQ 号）；核心 `atMe` 与它比较 */
  selfId?: string
  /** 报文 `mentions` 中 `is_you` 为真的 id 集合（openid / 频道用户 id 等多种写法） */
  selfMentions?: readonly string[]
  /** 报文 `mentions`；用于给 `at` 段补展示名，避免日志里露出那串 32 位 id */
  mentions?: readonly MsgAuthor[]
}

/**
 * 收集 `mentions` 中代表机器人自身的 id
 *
 * 同一条提及会在 `id` / `member_openid` / `user_openid` / `union_openid` 里重复给出
 * 同一个 id，而正文 token 用哪一个并不固定，故四个字段都收进来。
 * @param mentions 报文 `mentions`
 * @returns 代表机器人自身的 id 集合
 */
export function selfIdsOf(mentions?: readonly MsgAuthor[]): string[] {
  const ids: string[] = []
  for (const item of mentions ?? []) {
    if (item?.is_you !== true) continue
    for (const id of [item.id, item.member_openid, item.user_openid, item.union_openid]) {
      if (id) ids.push(id)
    }
  }
  return ids
}

/**
 * 从 `mentions` 里查出某条 @ 的展示名
 *
 * 核心的 `at` 段渲染规则是 `[@name ?? uid]`，补上 name 就不会把那串
 * 32 位 openid / 频道用户 id 暴露到日志和回显里。
 * @param raw 正文 token 里的原始 id
 * @param mentions 报文 `mentions`
 * @returns 展示名；查不到时 undefined
 */
function mentionName(raw: string, mentions?: readonly MsgAuthor[]): string | undefined {
  for (const item of mentions ?? []) {
    if (
      item.id === raw ||
      item.member_openid === raw ||
      item.user_openid === raw ||
      item.union_openid === raw
    ) {
      return item.username
    }
  }
  return undefined
}

/**
 * 构造 `at` 段
 * @param raw 正文 token 里的原始 id
 * @param guildScope 频道场景；非自身提及加 qg_ 前缀
 * @param self 解码选项
 * @returns at 段
 */
function atSegment(raw: string, guildScope: boolean, self?: DecodeOptions): Segment {
  const selfId = self?.selfId
  // 只有机器人自己换成 selfId：核心据此判定 atMe；其余人的提及保留平台原始 id
  const uid = selfId && self.selfMentions?.includes(raw)
    ? selfId
    : guildScope ? addGuildPrefix(raw) : raw
  const name = mentionName(raw, self?.mentions)
  return name ? { type: "at", uid, name } : { type: "at", uid }
}

/**
 * 解码 QQ Bot 消息
 * @param content 消息内容；纯附件消息（如图片单发）平台不下发该字段，此处按空串处理
 * @param attachments 附件列表
 * @param guildScope 频道场景；@提及的用户 id 加 qg_ 前缀
 * @param self 自身标识；传入后机器人自己的 @ 换成 `selfId`，其余 @ 补上展示名
 * @returns 通用消息段数组
 */
export function decodeMessage(
  content: string | undefined,
  attachments?: Attachment[],
  guildScope = false,
  self?: DecodeOptions
): Segment[] {
  const segments: Segment[] = []
  // 图片/语音/视频单发时平台只给 attachments，content 为 undefined；不能直接取 .length
  const text = content ?? ""

  // 新版交互标签与旧提及格式按出现位置解析，未知/不完整标签原样保留。
  // 全量群消息仍可能下发 <@openid> / <@all>，频道旧格式还包括 <@!id>。
  const tokenRegex = /<qqbot-(?:at-user|at-everyone|cmd-enter|cmd-input)\b[^>]*\/>|<@!?(everyone|all|[\w-]+)>|<@!?\/\/?([^>\s/]+)\/?>|<emoji:(\d+)>|<#(\d+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) })
    }
    if (match[0].startsWith("<qqbot-at-user")) {
      const attributes = tagAttributes(match[0])
      segments.push(attributes?.id ? atSegment(attributes.id, guildScope, self) : { type: "text", text: match[0] })
    } else if (match[0].startsWith("<qqbot-at-everyone")) {
      segments.push(tagAttributes(match[0]) ? { type: "atAll" } : { type: "text", text: match[0] })
    } else if (match[0].startsWith("<qqbot-cmd-")) {
      const command = parseCommand(match[0])
      segments.push(command
        ? { type: "raw", platform: PLATFORM, platformType: "text-interaction", data: command }
        : { type: "text", text: match[0] })
    } else if (match[1] === "everyone" || match[1] === "all") {
      segments.push({ type: "atAll" })
    } else if (match[1]) {
      segments.push(atSegment(match[1], guildScope, self))
    } else if (match[2]) {
      segments.push(atSegment(match[2], guildScope, self))
    } else if (match[3]) {
      segments.push({ type: "face", id: Number(match[3]) })
    } else if (match[4]) {
      segments.push(guildScope
        ? { type: "raw", platform: PLATFORM, platformType: "text-interaction", data: { type: "channel", channelId: match[4] } }
        : { type: "text", text: match[0] })
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

/** 卡片字段取字符串值；平台偶尔给数组（如 `tags`），非字符串一律视为缺失 */
function arkField(fields: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields?.[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/**
 * 解码结构化卡片（`ark_data`）
 *
 * 平台已在 `content` 里给出卡片摘要文本，正文由 {@link decodeMessage} 负责，这里只补卡片本身：
 * - 有跳转链接的卡片（图文、小程序、视频分享等）额外给一个 `share` 段，插件不必认识 ark 结构；
 * - 总是附一个 `raw` 段（platformType=`ark_data`）保留完整卡片，`ark_type` / `fields` 都在里面。
 *   它与发送用的 `ark`（模板 id + kv）结构不同，故不复用 `ark` 这个类型名，免得原样回发时被当成模板。
 * @param ark 平台下发的卡片数据
 * @returns 卡片消息段；无数据时为空数组
 */
export function decodeArk(ark?: ArkData): Segment[] {
  if (!ark || typeof ark !== "object") return []
  const segments: Segment[] = []
  const url = arkField(ark.fields, "jump_url", "url")
  if (url) {
    segments.push({
      type: "share",
      url,
      title: arkField(ark.fields, "title") ?? ark.prompt ?? ark.ark_name ?? url,
      content: arkField(ark.fields, "desc", "source"),
      image: arkField(ark.fields, "preview")
    })
  }
  segments.push({ type: "raw", platform: PLATFORM, platformType: "ark_data", data: ark })
  return segments
}
