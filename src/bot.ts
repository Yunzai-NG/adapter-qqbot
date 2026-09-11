/**
 * 模块职责：BotDriver 实现 - 将内核的通用能力面转换为 QQ Bot 的 API 调用
 * 依赖方向：依赖 gateway / api / codec / events / config 与类型包
 * 生命周期：一个账号对应一个实例，connect() 与 disconnect() 各调用一次
 * 注意事项：
 *   - QQ Bot 使用 open_id 标识用户，group_openid 标识群
 *   - 消息发送需区分群消息和私聊消息
 *   - 支持文本、Markdown、Ark、键盘等多种消息类型
 */
import type {
  AdapterHost,
  BotCapability,
  BotDriver,
  HttpClient,
  MessageContent,
  SendOptions,
  SendResult,
  SendTarget,
  Segment,
  UserInfo,
  GroupInfo,
  MemberInfo,
  MemberListOptions,
  ForwardNode
} from "@yunzai-ng/types"
import { toSegments } from "@yunzai-ng/core"
import {
  PLATFORM,
  addGuildPrefix,
  stripGuildPrefix,
  plainGuildId,
  isGroupOpenId,
  isGuildScopeId,
  mapGroupRole,
  mapGuildRole
} from "./codec.js"
import { decodeEvent } from "./events.js"
import type { QQBotAccount } from "./config.js"
import { TokenManager } from "./auth.js"
import { ApiClient } from "./api.js"
import { Gateway } from "./gateway.js"
import type { ReadyData, SendMessageRequest, SendMessageResponse, WSPayload } from "./types.js"
import { resolveMedia } from "./media.js"
import { markdownImage } from "./markdown.js"
import { getImageSize } from "./image-size.js"
import { buildOutbound, type OutboundMessage } from "./outbound.js"
import { MediaUploader } from "./upload.js"
import { ImageHost } from "./image-host.js"
import { fileUrl, publishFile } from "./file-server.js"
import { registerWebhookHandler, unregisterWebhookHandler } from "./webhook-registry.js"
import { Ed25519 } from "./ed25519.js"

const SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
/** share_info 接口固定的 bkn 参数 */
const SHARE_INFO_BKN = 508459323

/** 获取机器人真实 QQ 号 */
async function getRobotUin(appId: string, http: HttpClient): Promise<string | null> {
  try {
    const response = await http.request<{ data?: { robot_data?: { robot_uin?: string } } }>(
      `${SHARE_INFO_URL}?bkn=${SHARE_INFO_BKN}&robot_appid=${appId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36"
        },
        responseType: "json",
        throwOnError: false
      }
    )
    return response.data?.data?.robot_data?.robot_uin ?? null
  } catch {
    return null
  }
}

/** 声明支持的能力 */
const CAPS: readonly BotCapability[] = [
  "recall",
  "forward",
  "groupMute",
  "groupKick",
  "groupRequest",
  "groupFile",
  "reaction",
  "markdown",
  "keyboard",
  "guild"
]

/** 创建 BotDriver */
export function createQQBotBot(
  account: QQBotAccount,
  host: AdapterHost,
  deps: { adapterId: string; http: HttpClient }
): BotDriver {
  let selfId = host.account.selfId ?? ""
  let nickname = ""

  // 频道私信映射缓存：uid → guildId
  const directMessageGuildMap = new Map<string, string>()

  // 消息目标缓存：messageId → SendTarget，用于撤回消息（10 分钟 / 最多 1000 条）
  const messageTargetMap = new Map<string, { target: SendTarget; time: number }>()
  const MESSAGE_TARGET_TTL = 10 * 60 * 1000
  const MESSAGE_TARGET_LIMIT = 1000

  // 最近入站消息：目标 → 被动回复上下文（平台只认 5 分钟内的 msg_id/event_id）
  const replyContext = new Map<string, { msgId: string; eventId?: string; time: number }>()
  // 同一 msg_id 的回复序号必须递增；主动推送使用随机初始值
  const seqCounter = new Map<string, number>()

  // 图床：按账号独立实例，connect() 时加载脚本
  const imageHost = new ImageHost()

  const tokenManager = new TokenManager(account, deps.http, host.logger)
  const api = new ApiClient(tokenManager, deps.http, host.logger)
  const uploader = new MediaUploader(api, deps.http, host.logger)

  function resolveSelfId(fallback: string): Promise<string> {
    if (account.robotUin) return Promise.resolve(account.robotUin)
    return getRobotUin(account.appId, deps.http).then(uin => uin ?? fallback)
  }

  function targetKey(target: SendTarget): string {
    if (target.scene === "group") return `group:${target.gid}`
    if (target.scene === "guild") return `guild:${target.channelId}`
    return `private:${target.uid}`
  }

  function rememberMessageTarget(messageId: string, target: SendTarget): void {
    const now = Date.now()
    for (const [id, value] of messageTargetMap) {
      if (now - value.time > MESSAGE_TARGET_TTL) messageTargetMap.delete(id)
    }
    messageTargetMap.delete(messageId)
    messageTargetMap.set(messageId, { target, time: now })
    while (messageTargetMap.size > MESSAGE_TARGET_LIMIT) {
      const firstId = messageTargetMap.keys().next().value
      if (firstId === undefined) break
      messageTargetMap.delete(firstId)
    }
  }

  function rememberReplyContext(target: SendTarget, messageId: string, eventId?: string): void {
    const now = Date.now()
    replyContext.set(targetKey(target), { msgId: messageId, eventId, time: now })
    for (const [key, value] of replyContext) {
      if (now - value.time > 300_000) replyContext.delete(key)
    }
  }

  function nextMessageSequence(messageId?: string): number {
    if (!messageId) return Math.floor(Math.random() * 999_999) + 1
    const next = (seqCounter.get(messageId) ?? 0) + 1
    seqCounter.set(messageId, next)
    return next
  }

  /**
   * 回填被动回复与引用上下文
   *
   * `msg_id` 与 `message_reference` 是两个独立语义：
   * - `msg_id`：被动回复标记（5 分钟内免主动额度），自动补，不产生引用样式
   * - `message_reference`：引用 UI，只在内核显式传 quote（e.reply 的 quote 选项 / reply 段）时设置
   */
  function applyReplyContext(target: SendTarget, request: SendMessageRequest, quote?: string): void {
    const reference = quote ?? request.msg_id
    if (reference) {
      if (reference.startsWith("event_")) {
        request.event_id = reference.slice("event_".length)
        delete request.msg_id
        delete request.message_reference
      } else {
        request.msg_id = reference
        request.message_reference = { message_id: reference }
      }
    } else if (!request.event_id) {
      const context = replyContext.get(targetKey(target))
      if (context && Date.now() - context.time <= 300_000) {
        // 仅被动回复标记；不挂 message_reference，避免每条回复都变成引用回复
        if (context.eventId) request.event_id = context.eventId
        else request.msg_id = context.msgId
      }
    }
    request.msg_seq = nextMessageSequence(request.msg_id ?? request.event_id)
  }

  // 事件入口：gateway onEvent 与 webhook handler 共用
  function ingest(eventType: string, data: unknown): void {
    // 拦截频道私信事件，记录 uid → guildId 映射
    // （键与 decodeDirectMessage 产出的带 qg_ 前缀 uid 保持一致）
    if (eventType === "DIRECT_MESSAGE_CREATE") {
      const dmData = data as { author?: { id?: string }; guild_id?: string }
      if (dmData.author?.id && dmData.guild_id) {
        directMessageGuildMap.set(addGuildPrefix(dmData.author.id), dmData.guild_id)
      }
    }

    const event = decodeEvent(eventType, data)
    if (event) {
      if (event.kind === "message") {
        const target: SendTarget = event.scene === "group"
          ? { scene: "group", gid: event.group!.gid }
          : event.scene === "guild"
            ? { scene: "guild", guildId: event.channel!.guildId, channelId: event.channel!.channelId }
            : { scene: "private", uid: event.sender.uid }
        rememberReplyContext(target, event.messageId)
      }
      host.submit(event)
    }
  }

  const gateway = new Gateway(
    account,
    tokenManager,
    {
      onEvent: (eventType, data) => ingest(eventType, data),
      onReady: async (data: ReadyData) => {
        nickname = data.user.username
        selfId = await resolveSelfId(data.user.id)
        host.logger.debug(`已连接 QQ Bot：${nickname} (${selfId})`)
        host.setStatus("online")
      },
      onClosed: (reason) => {
        host.setStatus("offline", { error: reason })
      }
    },
    host.logger
  )

  // 判定目标场景是否启用 markdown（群/C2C 用 groupMarkdown，频道/频道私信用 guildMarkdown）
  function resolveMarkdownEnabled(target: SendTarget): boolean {
    if (target.scene === "group" || (target.scene === "private" && !directMessageGuildMap.has(target.uid))) {
      return account.groupMarkdown === true
    }
    if (target.scene === "guild" || (target.scene === "private" && directMessageGuildMap.has(target.uid))) {
      return account.guildMarkdown === true
    }
    return false
  }

  // JSON body 消息按场景分发（图床 markdown 与纯文本/markdown 共用）
  async function dispatchSend(target: SendTarget, request: SendMessageRequest): Promise<SendMessageResponse> {
    if (target.scene === "group") return api.sendGroupMessage(target.gid, request)
    if (target.scene === "private") {
      const guildId = directMessageGuildMap.get(target.uid)
      return guildId ? api.sendDirectMessage(guildId, request) : api.sendC2CMessage(target.uid, request)
    }
    if (target.scene === "guild") return api.sendGuildMessage(target.channelId, request)
    throw new Error("QQ Bot 适配器不支持此消息场景")
  }

  function isGuildTransport(target: SendTarget): boolean {
    return target.scene === "guild" || (target.scene === "private" && directMessageGuildMap.has(target.uid))
  }

  async function executeOutbound(target: SendTarget, message: OutboundMessage, quote?: string): Promise<SendMessageResponse> {
    const request: SendMessageRequest = { ...message.request }
    applyReplyContext(target, request, quote)

    let response: SendMessageResponse
    if (message.upload) {
      if (target.scene === "group") {
        const uploaded = await uploader.upload(message.upload.ref, {
          target: "group", targetId: target.gid, fileType: message.upload.fileType, fileName: message.upload.name
        })
        request.media = { file_info: uploaded.file_info }
      } else if (target.scene === "private" && !isGuildTransport(target)) {
        const uploaded = await uploader.upload(message.upload.ref, {
          target: "user", targetId: target.uid, fileType: message.upload.fileType, fileName: message.upload.name
        })
        request.media = { file_info: uploaded.file_info }
      } else {
        throw new Error("频道场景不能走 QQ 富媒体上传接口")
      }
    }

    if (message.guildBlob) {
      const { buffer } = await resolveMedia(message.guildBlob, deps.http)
      if (target.scene === "guild") response = await api.sendGuildMessageWithImage(target.channelId, request, buffer)
      else if (target.scene === "private" && isGuildTransport(target)) {
        response = await api.sendDirectMessageWithImage(directMessageGuildMap.get(target.uid)!, request, buffer)
      } else throw new Error("只有频道场景可使用 multipart 图片")
    } else {
      response = await dispatchSend(target, request)
    }
    rememberMessageTarget(response.id, target)
    return response
  }

  /** 文件服务的对外基址：账号配置优先，否则用内核面板地址；服务器未启用返回空串 */
  function resolveFileBaseUrl(): string {
    const configured = account.serverAddress.trim()
    if (configured) return configured.replace(/\/+$/, "")
    const server = host.server
    return server.enabled ? server.publicUrl.replace(/\/+$/, "") : ""
  }

  /**
   * Markdown 图片计划：图片统一转公网 URL 后以 Markdown 发送，**绝不走 QQ 富媒体**
   *
   * 转换通道：图床脚本优先，失败降级内置 file 路由；两者都不可用时图片降级为
   * 文本占位并告警。Markdown 未启用或 legacy 模式才返回 undefined 走原生路径。
   */
  async function buildMarkdownImagePlans(
    target: SendTarget,
    content: MessageContent
  ): Promise<OutboundMessage[] | undefined> {
    if (!resolveMarkdownEnabled(target) || account.markdownMode === "legacy") return undefined
    const segments = toSegments(content)
    if (!segments.some(segment => segment.type === "image")) return undefined

    const transformed: Segment[] = []
    for (const segment of segments) {
      if (segment.type !== "image") {
        transformed.push(segment)
        continue
      }
      const converted = await convertMarkdownImage(segment)
      if (converted) {
        transformed.push({
          type: "markdown",
          content: markdownImage(
            converted.url,
            segment.summary ?? "图片",
            segment.width ?? converted.size?.width,
            segment.height ?? converted.size?.height
          )
        })
      } else {
        transformed.push({ type: "text", text: "[图片]" })
      }
    }
    return buildOutbound(transformed, {
      scene: isGuildTransport(target) ? "guild" : target.scene,
      markdownEnabled: true,
      markdownMode: account.markdownMode,
      markdownTemplateId: account.markdownTemplateId || undefined,
      markdownTemplateKeys: account.markdownTemplateKeys,
      keyboardTemplateId: account.keyboardTemplateId || undefined,
      appId: account.appId,
      forwardMode: account.forwardMode,
      warn: message => host.logger.warn(message)
    })
  }

  /** 单张图片转公网 URL 的结果 */
  interface ConvertedImage {
    /** 公网 URL */
    url: string
    /** 实测宽高（Markdown 图片描述符需要） */
    size?: { width: number; height: number }
  }

  /** 单张图片转公网 URL：图床脚本优先，失败或未配置时降级内置 file 路由 */
  async function convertMarkdownImage(segment: Extract<Segment, { type: "image" }>): Promise<ConvertedImage | undefined> {
    try {
      const resolved = await resolveMedia(segment.file, deps.http)
      const size = getImageSize(resolved.buffer) ?? undefined
      if (imageHost.enabled) {
        const url = await imageHost.upload(resolved.buffer, {
          filename: resolved.fileName,
          mimeType: resolved.mime
        })
        if (url) return { url, size }
        host.logger.warn("[qqbot] 图床上传失败，降级内置文件路由")
      }
      const baseUrl = resolveFileBaseUrl()
      if (baseUrl) {
        return { url: fileUrl(baseUrl, publishFile(resolved.buffer, resolved.mime)), size }
      }
      host.logger.warn("[qqbot] 无可用图片公网通道（图床脚本与文件服务地址均未配置），图片已降级为文本")
      return undefined
    } catch (err) {
      host.logger.warn(`[qqbot] Markdown 图片处理失败，已降级为文本：${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
  const driver: BotDriver = {
    platform: PLATFORM,
    adapterId: deps.adapterId,
    caps: new Set(CAPS),

    get selfId(): string {
      return selfId
    },
    get nickname(): string {
      return nickname
    },
    get online(): boolean {
      return gateway.ready
    },

    async connect(): Promise<void> {
      // 连接前先确定 selfId（真实 QQ 号），获取失败则保持当前值
      selfId = await resolveSelfId(selfId)

      // 初始化图床
      if (account.imageHostScript) {
        await imageHost.load(account.imageHostScript, host.logger)
      }

      // 无图床脚本时 Markdown 图片依赖文件路由；回环地址 QQ 拉不到，提前提醒
      if (!imageHost.enabled && (account.groupMarkdown || account.guildMarkdown)) {
        const base = resolveFileBaseUrl()
        if (base && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base)) {
          host.logger.warn(`[qqbot] 文件服务地址为回环地址（${base}），QQ 客户端可能无法拉取 Markdown 图片，请在账号配置 serverAddress 填公网地址或穿透域名`)
        }
      }

      // 根据模式选择不同的连接方式
      if (account.mode === "webhook") {
        // Webhook 模式：注册处理器到统一入口，复用 gateway 的事件处理逻辑
        const webhookHandler = (appId: string, packet: WSPayload) => {
          if (packet.op === 0 && packet.t) {
            ingest(packet.t, packet.d)
          }
        }

        // 创建 Ed25519 实例用于签名验证
        const ed25519 = new Ed25519(account.appSecret)

        registerWebhookHandler(account.appId, {
          handler: webhookHandler,
          ed25519
        })
        host.logger.info(`Webhook 模式已启用，监听路径：${account.listenPath}`)
        host.setStatus("online")
      } else {
        // WebSocket 模式：使用 Gateway 连接
        await gateway.connect()
      }
    },

    async disconnect(): Promise<void> {
      if (account.mode === "webhook") {
        // Webhook 模式：注销处理器
        unregisterWebhookHandler(account.appId)
        host.logger.info("Webhook 模式已断开")
      } else {
        // WebSocket 模式：断开 Gateway
        await gateway.disconnect()
      }
    },

    async sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult> {
      const messages = await buildMarkdownImagePlans(target, content) ?? buildOutbound(toSegments(content), {
        scene: isGuildTransport(target) ? "guild" : target.scene,
        markdownEnabled: resolveMarkdownEnabled(target),
        markdownMode: account.markdownMode,
        markdownTemplateId: account.markdownTemplateId || undefined,
        markdownTemplateKeys: account.markdownTemplateKeys,
        keyboardTemplateId: account.keyboardTemplateId || undefined,
        appId: account.appId,
        forwardMode: account.forwardMode,
        warn: message => host.logger.warn(message)
      })
      if (!messages.length) {
        throw new Error("QQ Bot 没有可发送的消息内容")
      }

      const responses: SendMessageResponse[] = []
      const errors: unknown[] = []
      for (const message of messages) {
        try {
          responses.push(await executeOutbound(target, message, opts?.quote))
        } catch (err) {
          errors.push(err)
          host.logger.error(`[qqbot] 发送消息失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!responses.length) {
        throw errors[0] instanceof Error ? errors[0] : new Error("QQ Bot 消息发送失败")
      }

      const first = responses[0]
      const messageIds = responses.map(response => response.id)
      return {
        // 至少一条已送达即返回成功；失败明细保留在 raw，避免上层把已投递内容误判为全失败。
        ok: true,
        messageId: first.id,
        time: new Date(first.timestamp).getTime(),
        raw: {
          messageIds,
          responses,
          ...(errors.length ? { errors } : {})
        }
      }
    },

    async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
      if (!nodes.length) throw new Error("QQ Bot 转发消息没有节点")
      return this.sendMessage(target, [{ type: "forward", nodes }])
    },

    async recallMessage(messageId: string): Promise<boolean> {
      // QQ Bot API 撤回消息：
      // - 群聊: DELETE /v2/groups/{group_openid}/messages/{message_id}
      // - C2C 私聊: DELETE /v2/users/{openid}/messages/{message_id}
      // - 频道: DELETE /channels/{channel_id}/messages/{message_id}
      // - 频道私信: DELETE /dms/{guild_id}/messages/{message_id}
      const cached = messageTargetMap.get(messageId)
      const target = cached?.target
      if (!target || !cached || Date.now() - cached.time > MESSAGE_TARGET_TTL) {
        if (cached) messageTargetMap.delete(messageId)
        host.logger.warn(`未找到消息 ${messageId} 的有效目标信息，无法撤回`)
        return false
      }

      try {
        if (target.scene === "group") {
          // 撤回群消息
          await api.recallGroupMessage(target.gid, messageId)
        } else if (target.scene === "private") {
          // 检查是否是频道私信
          const guildId = directMessageGuildMap.get(target.uid)
          if (guildId) {
            // 撤回频道私信
            await api.recallDirectMessage(guildId, messageId)
          } else {
            // 撤回 C2C 私聊消息
            await api.recallC2CMessage(target.uid, messageId)
          }
        } else if (target.scene === "guild") {
          // 撤回频道消息
          await api.recallGuildMessage(target.channelId, messageId)
        } else {
          host.logger.warn(`不支持的消息场景: ${(target as any).scene}`)
          return false
        }

        // 撤回成功后移除缓存
        messageTargetMap.delete(messageId)
        return true
      } catch (err: any) {
        host.logger.error(`撤回消息失败: ${err.message}`)
        return false
      }
    },

    async getSelfInfo(): Promise<UserInfo> {
      // QQ Bot API: GET /users/@me
      // 返回: { id, username, avatar, bot }
      try {
        const user = await api.getSelfInfo()
        return {
          uid: user.id,
          name: user.username,
          avatar: user.avatar
        }
      } catch {
        // API 调用失败时返回缓存值
        return {
          uid: selfId,
          name: nickname,
          avatar: ""
        }
      }
    },

    async getFriend(uid: string): Promise<UserInfo | undefined> {
      // QQ Bot API: GET /v2/users/{openid}/info
      // 返回: { openid, nickname, head_url }
      try {
        const user = await api.getUserInfo(uid)
        return {
          uid: user.openid,
          name: user.nickname,
          avatar: user.head_url
        }
      } catch {
        return undefined
      }
    },

    async getFriendList(): Promise<UserInfo[]> {
      // QQ Bot API 不支持获取好友列表
      // 群聊和 C2C 私聊均无好友列表 API
      return []
    },

    async getGroup(gid: string): Promise<GroupInfo | undefined> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/info
      //   返回: { group_openid, name, avatar, owner_id, admin_count, member_count }
      //   selfRole: GET /v2/groups/{group_openid}/members/{member_openid}
      //   返回: { member_openid, join_type, role }
      // - 频道+子频道: GET /guilds/{guild_id} + GET /channels/{channel_id}
      //   返回: gid="qg_频道id-子频道id"（qg_ 前缀防止丢精度，兼容无前缀格式）, name="频道名-子频道名", avatar=频道icon, memberCount=频道member_count, maxMemberCount=频道max_members, owner=频道owner_id
      //   selfRole: GET /guilds/{guild_id}/members/{user_id}
      //   返回: roles 数组，4=owner, 2=admin, 1=member

      // 判断 ID 类型：
      // - 群聊 ID (group_openid): 32位大写十六进制字符串
      // - 频道+子频道: "qg_guild_id-channel_id" 格式（如 "qg_123456-789012"）
      // - 注意：不支持单独的频道 ID，必须是组合格式

      // 检查是否是 "频道号-子频道号" 格式
      const plainGid = stripGuildPrefix(gid)
      if (plainGid.includes("-")) {
        const [guildId, channelId] = plainGid.split("-")
        try {
          const [guildInfo, channelInfo] = await Promise.all([
            api.getGuildInfo(guildId),
            api.getChannelInfo(channelId)
          ])
          // 查询机器人在频道内的角色
          let selfRole: "owner" | "admin" | "member" | undefined
          try {
            const memberInfo = await api.getGuildMemberInfo(guildId, selfId)
            selfRole = mapGuildRole(memberInfo.roles)
          } catch {
            // 查询失败时不设置 selfRole
          }
          return {
            gid: addGuildPrefix(`${guildId}-${channelId}`),
            name: `${guildInfo.name}-${channelInfo.name}`,
            avatar: guildInfo.icon,
            memberCount: guildInfo.member_count,
            maxMemberCount: guildInfo.max_members,
            owner: guildInfo.owner_id,
            selfRole
          }
        } catch {
          return undefined
        }
      }

      // 判断是群聊还是频道+子频道
      const isGroup = isGroupOpenId(gid)

      if (isGroup) {
        // 群聊 API
        try {
          const groupInfo = await api.getGroupInfo(gid)
          // 查询机器人在群内的角色
          let selfRole: "owner" | "admin" | "member" | undefined
          try {
            const memberInfo = await api.getGroupMemberInfo(gid, selfId)
            selfRole = mapGroupRole(memberInfo.role)
          } catch {
            // 查询失败时不设置 selfRole
          }
          return {
            gid: groupInfo.group_openid,
            name: groupInfo.name || "未知群",
            avatar: groupInfo.avatar,
            memberCount: groupInfo.member_count,
            owner: groupInfo.owner_id,
            selfRole
          }
        } catch {
          return undefined
        }
      } else {
        // 纯数字 ID 不支持，必须是 "频道id-子频道id" 格式
        return undefined
      }
    },

    async getGroupList(): Promise<GroupInfo[]> {
      const guilds: GroupInfo[] = []
      const seen = new Set<string>()
      let after: string | undefined

      while (true) {
        const page = await api.getGuildList(after)
        if (!page.length) break
        for (const guild of page) {
          guilds.push({
            gid: addGuildPrefix(guild.id),
            name: guild.name,
            avatar: guild.icon,
            memberCount: guild.member_count,
            maxMemberCount: guild.max_members,
            owner: guild.owner_id
          })
        }
        if (page.length < 100) break
        const next = page.at(-1)?.id
        if (!next || seen.has(next)) {
          throw new Error("QQ Bot 频道列表分页游标重复或缺失")
        }
        seen.add(next)
        after = next
      }
      return guilds
    },

    async getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/members/{member_openid}
      //   返回: { member_openid, join_type, role }
      // - 频道: GET /guilds/{guild_id}/members/{user_id}
      //   返回: { user: { id, username, avatar, bot? }, nick, roles, joined_at }

      // 通过 ID 格式判断是群聊还是频道
      // 群聊 ID (group_openid): 32位大写十六进制字符串
      // 频道 ID: qg_ 前缀、数字或「频道号-子频道」组合格式
      const isGuild = isGuildScopeId(gid)

      if (isGuild) {
        // 频道 API
        try {
          const memberInfo = await api.getGuildMemberInfo(plainGuildId(gid), stripGuildPrefix(uid))
          return {
            uid: addGuildPrefix(memberInfo.user.id),
            gid,
            name: memberInfo.user.username,
            avatar: memberInfo.user.avatar,
            card: memberInfo.nick,
            role: mapGuildRole(memberInfo.roles),
            joinTime: memberInfo.joined_at ? Math.floor(new Date(memberInfo.joined_at).getTime() / 1000) : undefined
          }
        } catch {
          return undefined
        }
      } else {
        // 群聊 API
        try {
          const memberInfo = await api.getGroupMemberInfo(gid, uid)
          return {
            uid: memberInfo.member_openid,
            gid,
            name: memberInfo.username,
            avatar: `https://q.qlogo.cn/qqapp/${account.appId}/${uid}/100`,
            role: mapGroupRole(memberInfo.role),
            joinTime: memberInfo.joined_at ? Math.floor(new Date(memberInfo.joined_at).getTime() / 1000) : undefined
          }
        } catch {
          return undefined
        }
      }
    },

    async getGroupMemberList(gid: string, _opts?: MemberListOptions): Promise<MemberInfo[]> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/members
      //   返回: [{ member_openid, join_type, role }]
      // - 频道: GET /guilds/{guild_id}/members
      //   返回: [{ user: { id, username, avatar }, nick, roles, joined_at }]

      // 通过 ID 格式判断是群聊还是频道
      // 群聊 ID (group_openid): 32位大写十六进制字符串
      // 频道 ID: qg_ 前缀、数字或「频道号-子频道」组合格式
      const isGuild = isGuildScopeId(gid)

      if (isGuild) {
        // 频道 API
        try {
          const members = await api.getGuildMemberListInfo(plainGuildId(gid))
          return members.map((m) => ({
            uid: addGuildPrefix(m.user.id),
            gid,
            name: m.user.username,
            avatar: m.user.avatar,
            card: m.nick,
            role: mapGuildRole(m.roles),
            joinTime: m.joined_at ? Math.floor(new Date(m.joined_at).getTime() / 1000) : undefined
          }))
        } catch {
          return []
        }
      } else {
        // 群聊 API
        try {
          const members = await api.getGroupMemberListInfo(gid)
          return members.map((m) => ({
            uid: m.member_openid,
            gid,
            role: mapGroupRole(m.role)
          }))
        } catch {
          return []
        }
      }
    },

    async muteGroupMember(gid: string, uid: string, seconds: number): Promise<void> {
      // 判断是群聊还是频道
      const isGroup = isGroupOpenId(gid)

      if (isGroup) {
        // 群聊：POST /v2/groups/{group_openid}/restrict_chat_setting
        // 需要 RFC3339 格式的到期时间
        const expireAt = new Date(Date.now() + seconds * 1000).toISOString()
        await api.muteGroupMember(gid, uid, expireAt)
      } else {
        // 频道：PATCH /guilds/{guild_id}/members/{user_id}/mute
        await api.muteGuildMember(plainGuildId(gid), stripGuildPrefix(uid), seconds)
      }
    },

    async kickGroupMember(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void> {
      // 判断是群聊还是频道
      const isGroup = isGroupOpenId(gid)

      if (isGroup) {
        // 群聊：POST /v2/groups/{group_openid}/batch_remove_members
        // 注意：该接口需白名单权限，且正在内邀接入中
        await api.kickGroupMember(gid, [uid], rejectAddAgain)
      } else {
        // 频道：DELETE /guilds/{guild_id}/members/{user_id}
        await api.kickGuildMember(plainGuildId(gid), stripGuildPrefix(uid), rejectAddAgain)
      }
    },

    async handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<void> {
      // flag 格式: group_openid:member_openid:join_request_id
      const parts = flag.split(":")
      if (parts.length < 2) {
        host.logger.warn(`handleGroupRequest: flag 格式错误，期望 group_openid:member_openid[:join_request_id]，实际: ${flag}`)
        return
      }

      const [groupOpenId, memberOpenId, joinRequestId] = parts
      const op = approve ? "approve" : "decline"

      await api.handleGroupJoinRequest(groupOpenId, memberOpenId, op, joinRequestId, reason)
    },

    async setReaction(messageId: string, emojiId: string, add = true): Promise<void> {
      const cached = messageTargetMap.get(messageId)
      if (!cached || Date.now() - cached.time > MESSAGE_TARGET_TTL) {
        if (cached) messageTargetMap.delete(messageId)
        throw new Error(`未找到频道消息 ${messageId} 的有效目标信息，无法表态`)
      }
      if (cached.target.scene !== "guild") {
        throw new Error("QQ Bot 仅支持对频道消息设置表态")
      }
      await api.setGuildMessageReaction(cached.target.channelId, messageId, emojiId, add)
    },

    async uploadGroupFile(gid: string, file: string, name: string, _folder?: string): Promise<void> {
      if (!isGroupOpenId(gid)) {
        throw new Error("QQ Bot 仅支持向群聊上传文件")
      }
      await uploader.upload({ kind: "path", path: file }, {
        target: "group",
        targetId: gid,
        fileType: 4,
        fileName: name,
        srvSendMsg: true
      })
    },

    callApi<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      // 互动回调应答（按钮点击）：PUT /interactions/{interaction_id}
      if (action === "replyInteraction") {
        return api.replyInteraction(
          String(params?.interactionId ?? params?.interaction_id ?? ""),
          Number(params?.code ?? 0)
        ) as Promise<T>
      }
      return api.call<T>("POST", action, params)
    }
  }

  return driver
}
