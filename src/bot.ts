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
  MessageRecord,
  SendOptions,
  SendResult,
  SendTarget,
  UserInfo,
  GroupInfo,
  MemberInfo,
  MemberListOptions,
  ForwardNode
} from "@yunzai-ng/types"
import { toSegments } from "@yunzai-ng/core"
import { encodeSegments, PLATFORM, addGuildPrefix, stripGuildPrefix } from "./codec.js"
import { decodeEvent } from "./events.js"
import type { QQBotAccount } from "./config.js"
import { TokenManager } from "./auth.js"
import { ApiClient } from "./api.js"
import { Gateway } from "./gateway.js"
import type { ReadyData, SendMessageRequest } from "./types.js"
import { readFile } from "node:fs/promises"
import { initImageHost, uploadToImageHost, getImageHost } from "./image-host.js"
import { getImageSize } from "./image-size.js"
import { registerWebhookHandler, unregisterWebhookHandler } from "./index.js"
import { Ed25519 } from "./ed25519.js"
import type { WSPayload } from "./types.js"

const SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
const BKN = 508459323

/** 获取机器人真实 QQ 号 */
async function getRobotUin(appId: string, http: HttpClient): Promise<string | null> {
  try {
    const response = await http.request<{ data?: { robot_data?: { robot_uin?: string } } }>(
      `${SHARE_INFO_URL}?bkn=${BKN}&robot_appid=${appId}`,
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

/** 读取本地文件并转为 base64 */
async function readFileAsBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  return buffer.toString("base64")
}

/**
 * 将频道场景 gid（qg_ 前缀或「频道号-子频道」组合格式）还原为纯 guild_id。
 * 群聊 gid 为 32 位大写十六进制，不含 "-"，不会误入此函数的拆分逻辑。
 */
function plainGuildId(gid: string): string {
  const plain = stripGuildPrefix(gid)
  const dash = plain.indexOf("-")
  return dash === -1 ? plain : plain.slice(0, dash)
}

/** 声明支持的能力 */
const CAPS: readonly BotCapability[] = [
  "recall",
  "forward",
  "groupCard",
  "groupMute",
  "groupKick",
  "groupRequest"
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

  // 消息目标缓存：messageId → SendTarget，用于撤回消息
  const messageTargetMap = new Map<string, SendTarget>()

  const tokenManager = new TokenManager(account, deps.http, host.logger)
  const api = new ApiClient(tokenManager, deps.http, host.logger)
  const gateway = new Gateway(
    account,
    tokenManager,
    {
      onEvent: (eventType, data) => {
        // 拦截频道私信事件，记录 uid → guildId 映射
        if (eventType === "DIRECT_MESSAGE_CREATE") {
          const dmData = data as { author?: { id?: string }; guild_id?: string }
          if (dmData.author?.id && dmData.guild_id) {
            // 键与 decodeDirectMessage 产出的带 qg_ 前缀的 uid 保持一致
            directMessageGuildMap.set(addGuildPrefix(dmData.author.id), dmData.guild_id)
          }
        }

        const event = decodeEvent(eventType, data)
        if (event) {
          host.submit(event)
        }
      },
      onReady: async (data: ReadyData) => {
        nickname = data.user.username

        // 先获取真实 QQ 号，再设置 selfId
        let resolvedId = account.robotUin || data.user.id
        if (!account.robotUin) {
          const uin = await getRobotUin(account.appId, deps.http)
          if (uin) resolvedId = uin
        }

        selfId = resolvedId
        host.logger.debug(`已连接 QQ Bot：${nickname} (${selfId})`)
        host.setStatus("online")
      },
      onClosed: (reason) => {
        host.setStatus("offline", { error: reason })
      }
    },
    host.logger
  )

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
      // 连接前先获取真实 QQ 号
      if (!account.robotUin) {
        const uin = await getRobotUin(account.appId, deps.http)
        if (uin) {
          selfId = uin
        }
      } else {
        selfId = account.robotUin
      }

      // 初始化图床
      if (account.imageHostScript) {
        await initImageHost({
          enabled: true,
          scriptPath: account.imageHostScript
        }, host.logger)
      }

      // 根据模式选择不同的连接方式
      if (account.mode === "webhook") {
        // Webhook 模式：注册处理器到统一入口
        const webhookHandler = (appId: string, packet: WSPayload) => {
          // 复用 gateway 的事件处理逻辑
          if (packet.op === 0 && packet.t) {
            // 拦截频道私信事件，记录 uid → guildId 映射
            if (packet.t === "DIRECT_MESSAGE_CREATE") {
              const dmData = packet.d as { author?: { id?: string }; guild_id?: string }
              if (dmData.author?.id && dmData.guild_id) {
                // 键与 decodeDirectMessage 产出的带 qg_ 前缀的 uid 保持一致
                directMessageGuildMap.set(addGuildPrefix(dmData.author.id), dmData.guild_id)
              }
            }

            const event = decodeEvent(packet.t, packet.d)
            if (event) {
              host.submit(event)
            }
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
      const segments = toSegments(content)
      const { content: text, markdown, image, msgType } = encodeSegments(segments)

      // 处理引用回复
      const messageReference = opts?.quote ? { message_id: opts.quote } : undefined

      // 处理图片消息：使用图床将图片转为公网 URL，通过 Markdown 格式发送
      // 检查对应场景的 markdown 开关是否启用
      let markdownEnabled = false
      if (target.scene === "group" || (target.scene === "private" && !directMessageGuildMap.has(target.uid))) {
        // 群聊或 C2C 私聊
        markdownEnabled = account.groupMarkdown === true
      } else if (target.scene === "guild" || (target.scene === "private" && directMessageGuildMap.has(target.uid))) {
        // 频道消息或频道私信
        markdownEnabled = account.guildMarkdown === true
      }

      if (image && getImageHost().enabled && markdownEnabled) {
        host.logger.info(`[image-host] 检测到图片，尝试通过图床上传`)

        let imageBuffer: Buffer | undefined
        let filename = `image_${Date.now()}.png`
        let imageUrl: string | null = null
        let imageSize: { width: number; height: number } | null = null

        // 获取图片数据
        switch (image.kind) {
          case "url": {
            // 已经是公网 URL，需要下载解析尺寸
            imageUrl = image.url
            try {
              imageBuffer = Buffer.from(await deps.http.buffer(image.url))
              imageSize = getImageSize(imageBuffer)
            } catch (err: any) {
              host.logger.warn(`[image-host] 下载图片失败: ${err.message}`)
            }
            break
          }
          case "base64":
            imageBuffer = Buffer.from(image.base64, "base64")
            imageSize = getImageSize(imageBuffer)
            break
          case "buffer":
            imageBuffer = Buffer.from(image.data)
            imageSize = getImageSize(imageBuffer)
            break
          case "path":
            imageBuffer = await readFile(image.path)
            imageSize = getImageSize(imageBuffer)
            filename = image.path.split(/[\\/]/).pop() || filename
            break
          case "id":
            host.logger.warn(`[image-host] 不支持 id 类型图片`)
            break
        }

        // 上传到图床
        if (imageBuffer) {
          imageUrl = await uploadToImageHost(imageBuffer, { filename, mimeType: "image/png" })
          if (imageUrl) {
            host.logger.info(`[image-host] 图片上传成功: ${imageUrl}`)
          } else {
            host.logger.warn(`[image-host] 图片上传失败，降级为普通图片消息发送`)
          }
        }

        // 如果成功获取图片 URL，发送 Markdown 消息
        if (imageUrl) {
          // QQ Bot markdown 图片必须带尺寸：![text #Wpx #Hpx](url)
          const width = imageSize?.width ?? 1000
          const height = imageSize?.height ?? 1000
          // 如果有 markdown 内容，追加图片；否则只发送图片
          const mdContent = markdown ? `${markdown}\n![image #${width}px #${height}px](${imageUrl})` : `![image #${width}px #${height}px](${imageUrl})`
          const request: SendMessageRequest = {
            msg_type: 2,
            markdown: { content: mdContent },
            message_reference: messageReference
          }

          let response: { id: string; timestamp: string }
          if (target.scene === "group") {
            response = await api.sendGroupMessage(target.gid, request)
          } else if (target.scene === "private") {
            const guildId = directMessageGuildMap.get(target.uid)
            if (guildId) {
              response = await api.sendDirectMessage(guildId, request)
            } else {
              response = await api.sendC2CMessage(target.uid, request)
            }
          } else if (target.scene === "guild") {
            response = await api.sendGuildMessage(target.channelId, request)
          } else {
            throw new Error("QQ Bot 适配器不支持此消息场景")
          }

          messageTargetMap.set(response.id, target)
          return {
            ok: true,
            messageId: response.id,
            time: new Date(response.timestamp).getTime(),
            raw: response
          }
        }
      }

      // 如果有图片，需要先上传再发送
      if (image) {
        // 根据 MediaRef 类型构建上传请求
        const uploadRequest: { file_type: number; url?: string; file_data?: string; srv_send_msg: boolean } = {
          file_type: 1, // 1=图片
          srv_send_msg: false
        }

        switch (image.kind) {
          case "url":
            uploadRequest.url = image.url
            break
          case "base64":
            uploadRequest.file_data = image.base64
            break
          case "buffer":
            uploadRequest.file_data = Buffer.from(image.data).toString("base64")
            break
          case "path":
            uploadRequest.file_data = await readFileAsBase64(image.path)
            break
          case "id":
            // 已上传的资源 id，直接使用
            break
        }

        let fileInfo: string
        let response: { id: string; timestamp: string }

        if (target.scene === "group") {
          const uploadResp = await api.uploadGroupMedia(target.gid, uploadRequest)
          fileInfo = uploadResp.file_info

          const mediaRequest: SendMessageRequest = {
            msg_type: 7,
            media: { file_info: fileInfo },
            message_reference: messageReference
          }
          response = await api.sendGroupMessage(target.gid, mediaRequest)
        } else if (target.scene === "private") {
          // 检查是否是频道私信
          const guildId = directMessageGuildMap.get(target.uid)
          if (guildId) {
            // 频道私信使用 multipart/form-data 发送图片
            let imageBuffer: Buffer

            switch (image.kind) {
              case "url":
                throw new Error("QQ Bot 频道私信不支持 URL 方式发送图片")
              case "base64":
                imageBuffer = Buffer.from(image.base64, "base64")
                break
              case "buffer":
                imageBuffer = Buffer.from(image.data)
                break
              case "path":
                imageBuffer = await readFile(image.path)
                break
              case "id":
                throw new Error("QQ Bot 频道私信不支持 id 类型的图片")
            }

            const guildRequest: SendMessageRequest = {
              content: text || "",
              message_reference: messageReference
            }
            host.logger.info(`发送频道私信图片，大小: ${imageBuffer.length} bytes`)
            try {
              response = await api.sendDirectMessageWithImage(guildId, guildRequest, imageBuffer)
              host.logger.info(`频道私信图片发送成功: ${response.id}`)
            } catch (err: any) {
              host.logger.error(`频道私信图片发送失败: ${err.message}`)
              throw err
            }
          } else {
            // C2C 私聊使用富媒体上传 API
            const uploadResp = await api.uploadC2CMedia(target.uid, uploadRequest)
            fileInfo = uploadResp.file_info

            const mediaRequest: SendMessageRequest = {
              msg_type: 7,
              media: { file_info: fileInfo },
              message_reference: messageReference
            }
            response = await api.sendC2CMessage(target.uid, mediaRequest)
          }
        } else if (target.scene === "guild") {
          // 频道消息使用 multipart/form-data 发送图片
          let imageBuffer: Buffer

          host.logger.info(`频道消息图片类型: ${image.kind}`)

          switch (image.kind) {
            case "url": {
              // 公网 URL 使用 image 字段
              const request: SendMessageRequest = {
                content: text || "",
                image: image.url,
                message_reference: messageReference
              }
              response = await api.sendGuildMessage(target.channelId, request)
              return {
                ok: true,
                messageId: response.id,
                time: new Date(response.timestamp).getTime(),
                raw: response
              }
            }
            case "base64":
              imageBuffer = Buffer.from(image.base64, "base64")
              break
            case "buffer":
              imageBuffer = Buffer.from(image.data)
              break
            case "path":
              host.logger.info(`读取图片文件: ${image.path}`)
              imageBuffer = await readFile(image.path)
              break
            case "id":
              throw new Error("QQ Bot 频道消息不支持 id 类型的图片")
          }

          const guildRequest: SendMessageRequest = {
            content: text || "",
            message_reference: messageReference
          }
          host.logger.info(`发送频道图片，大小: ${imageBuffer.length} bytes`)
          try {
            response = await api.sendGuildMessageWithImage(target.channelId, guildRequest, imageBuffer)
            host.logger.info(`频道图片发送成功: ${response.id}`)
          } catch (err: any) {
            host.logger.error(`频道图片发送失败: ${err.message}`)
            throw err
          }
        } else {
          throw new Error("QQ Bot 适配器不支持此消息场景")
        }

        // 缓存消息目标映射，用于撤回
        messageTargetMap.set(response.id, target)

        return {
          ok: true,
          messageId: response.id,
          time: new Date(response.timestamp).getTime(),
          raw: response
        }
      }

      // 纯文本或 Markdown 消息
      const request: SendMessageRequest = {
        message_reference: messageReference
      }

      // 只有当 markdownEnabled 为 true 时才发送 markdown 消息
      if (msgType === 2 && markdown && markdownEnabled) {
        request.msg_type = 2
        request.markdown = { content: markdown }
        request.content = text || ""
      } else {
        request.content = text || ""
      }

      // 发送消息
      let response: { id: string; timestamp: string }

      if (target.scene === "group") {
        response = await api.sendGroupMessage(target.gid, request)
      } else if (target.scene === "private") {
        // 检查是否是频道私信
        const guildId = directMessageGuildMap.get(target.uid)
        if (guildId) {
          response = await api.sendDirectMessage(guildId, request)
        } else {
          response = await api.sendC2CMessage(target.uid, request)
        }
      } else if (target.scene === "guild") {
        response = await api.sendGuildMessage(target.channelId, request)
      } else {
        throw new Error("QQ Bot 适配器不支持此消息场景")
      }

      // 缓存消息目标映射，用于撤回
      messageTargetMap.set(response.id, target)

      return {
        ok: true,
        messageId: response.id,
        time: new Date(response.timestamp).getTime(),
        raw: response
      }
    },

    async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
      // QQ Bot 不支持合并转发，降级为逐条发送
      host.logger.warn("QQ Bot 不支持合并转发，将逐条发送消息")

      let lastResult: SendResult | undefined
      for (const node of nodes) {
        if (node.message) {
          lastResult = await this.sendMessage(target, node.message)
        }
      }

      return lastResult || { ok: true, messageId: "", time: Date.now(), raw: {} }
    },

    async recallMessage(messageId: string): Promise<boolean> {
      // QQ Bot API 撤回消息：
      // - 群聊: DELETE /v2/groups/{group_openid}/messages/{message_id}
      // - C2C 私聊: DELETE /v2/users/{openid}/messages/{message_id}
      // - 频道: DELETE /channels/{channel_id}/messages/{message_id}
      // - 频道私信: DELETE /dms/{guild_id}/messages/{message_id}
      const target = messageTargetMap.get(messageId)
      if (!target) {
        host.logger.warn(`未找到消息 ${messageId} 的目标信息，无法撤回`)
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
            selfRole = memberInfo.roles.includes("4") ? "owner" : memberInfo.roles.includes("2") ? "admin" : "member"
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
      const isGroup = /^[A-F0-9]{32}$/.test(gid)

      if (isGroup) {
        // 群聊 API
        try {
          const groupInfo = await api.getGroupInfo(gid)
          // 查询机器人在群内的角色
          let selfRole: "owner" | "admin" | "member" | undefined
          try {
            const memberInfo = await api.getGroupMemberInfo(gid, selfId)
            selfRole = memberInfo.role === "owner" ? "owner" : memberInfo.role === "admin" ? "admin" : "member"
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
      // QQ Bot API:
      // - 群聊: 不支持获取群列表
      // - 频道: GET /users/@me/guilds
      //   参数: before?, after?, limit?
      //   返回: Guild 对象数组
      // 群聊无法实现，频道可通过 callApi 调用
      return []
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
      const plainGid = stripGuildPrefix(gid)
      const isGuild = plainGid.includes("-") || /^\d+$/.test(plainGid)

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
            role: memberInfo.roles.includes("4") ? "owner" : memberInfo.roles.includes("2") ? "admin" : "member",
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
            role: memberInfo.role === "owner" ? "owner" : memberInfo.role === "admin" ? "admin" : "member"
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
      const plainGid = stripGuildPrefix(gid)
      const isGuild = plainGid.includes("-") || /^\d+$/.test(plainGid)

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
            role: m.roles.includes("4") ? "owner" : m.roles.includes("2") ? "admin" : "member",
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
            role: m.role === "owner" ? "owner" : m.role === "admin" ? "admin" : "member"
          }))
        } catch {
          return []
        }
      }
    },

    async setGroupCard(_gid: string, _uid: string, _card: string): Promise<void> {
      // QQ Bot API 不支持修改群名片
      // 群聊和频道均无此 API
      host.logger.warn("QQ Bot 不支持修改群名片")
    },

    async muteGroupMember(gid: string, uid: string, seconds: number): Promise<void> {
      // 判断是群聊还是频道
      const isGroup = /^[A-F0-9]{32}$/.test(gid)

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

    async muteGroupAll(_gid: string, _enable: boolean): Promise<void> {
      // QQ Bot API 不支持全体禁言
      // 群聊和频道均无此 API
      host.logger.warn("QQ Bot 不支持全体禁言")
    },

    async kickGroupMember(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void> {
      // 判断是群聊还是频道
      const isGroup = /^[A-F0-9]{32}$/.test(gid)

      if (isGroup) {
        // 群聊：POST /v2/groups/{group_openid}/batch_remove_members
        // 注意：该接口需白名单权限，且正在内邀接入中
        await api.kickGroupMember(gid, [uid], rejectAddAgain)
      } else {
        // 频道：DELETE /guilds/{guild_id}/members/{user_id}
        await api.kickGuildMember(plainGuildId(gid), stripGuildPrefix(uid), rejectAddAgain)
      }
    },

    async quitGroup(_gid: string): Promise<void> {
      // QQ Bot API 不支持主动退群
      // 群聊和频道均无此 API
      host.logger.warn("QQ Bot 不支持主动退群")
    },

    async handleFriendRequest(_flag: string, _approve: boolean, _remark?: string): Promise<void> {
      // QQ Bot API 不支持处理好友请求
      // 群聊和 C2C 私聊均无此 API
      host.logger.warn("QQ Bot 不支持处理好友请求")
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

    async setReaction(messageId: string, emojiId: string, _add = true): Promise<void> {
      // QQ Bot API:
      // - 频道: PUT /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
      //   参数: type (1=系统表情, 2=emoji), id (表情 ID)
      //   返回: 204 No Content
      // - 取消: DELETE /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
      // 群聊和 C2C 私聊不支持，频道可通过 callApi 调用
      host.logger.warn("QQ Bot 仅频道支持表情表态，可通过 callApi 实现")
    },

    async uploadGroupFile(_gid: string, _file: string, _name: string, _folder?: string): Promise<void> {
      // QQ Bot API:
      // - 群聊: POST /v2/groups/{group_openid}/files
      //   请求体: { file_type, url, srv_send_msg }
      //   返回: { file_uuid }
      // - C2C 私聊: POST /v2/users/{openid}/files
      //   请求体: { file_type, url, srv_send_msg }
      //   返回: { file_uuid }
      // 需要先上传文件获取 URL，或通过富媒体接口上传
      host.logger.warn("QQ Bot 文件上传需通过富媒体接口，可通过 callApi 实现")
    },

    async getMessage(_messageId: string): Promise<MessageRecord | undefined> {
      // QQ Bot API 不支持获取消息详情
      // 群聊、C2C 私聊、频道均无此 API
      return undefined
    },

    callApi<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      // 互动回调应答（按钮点击）：PUT /interactions/{interaction_id}
      if (action === "replyInteraction") {
        return api.replyInteraction(
          String(params?.interactionId ?? params?.interaction_id ?? ""),
          Number(params?.code ?? 0)
        ) as Promise<T>
      }
      return api.call(action, params as any)
    }
  }

  return driver
}
