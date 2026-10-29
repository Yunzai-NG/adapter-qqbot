/**
 * 模块职责：BotDriver 的共享状态与依赖容器
 * 依赖方向：依赖 transport（auth / api / upload）与 media（图床），不被它们反向依赖
 * 生命周期：随 createQQBotBot 创建一次，所有能力模块共用同一实例
 * 注意事项：
 *   - 这里只放「多个能力模块都要用」的状态与判定，具体能力在 connection / send / query / manage
 *   - `selfId` 与 `nickname` 可变：连接前取自配置，ready 后取平台真实值，故以字段而非函数暴露
 *   - 缓存类 Map 都在此处集中淘汰，避免各模块各写一份过期逻辑
 */
import type { AdapterHost, HttpClient, SendTarget } from "@yunzai-ng/types"
import type { QQBotAccount } from "../config.js"
import { TokenManager } from "../transport/auth.js"
import { ApiClient } from "../transport/api.js"
import { MediaUploader } from "../transport/upload.js"
import { OfficialImageHost } from "../media/official-image-host.js"
import { ImageResolver } from "../media/image-to-url.js"
import type { ImageToUrlFn } from "../media/image-to-url.js"
import { resolveMedia } from "../media/resolve.js"
import type { SendMessageRequest, SendMessageResponse } from "../protocol/types.js"
import { createMessageDeduper, createSequenceTracker } from "./reply-guard.js"
import type { MessageDeduper, SequenceTracker } from "./reply-guard.js"

/** 创建 BotDriver 所需的外部依赖 */
export interface BotDeps {
  adapterId: string
  http: HttpClient
  /** 取插件注册的自定义图床；传函数以反映后加载 / 热重载 / 卸载 */
  customImage?: () => ImageToUrlFn | undefined
}

/** 消息目标缓存的有效期：平台只接受 10 分钟内的撤回 / 表态 */
export const MESSAGE_TARGET_TTL = 10 * 60 * 1000

/** 消息目标缓存上限，超出按插入顺序淘汰最旧一条 */
const MESSAGE_TARGET_LIMIT = 1000

/** 被动回复上下文的有效期：平台只认 5 分钟内的 msg_id / event_id */
const REPLY_CONTEXT_TTL = 5 * 60 * 1000

/** 一条消息的发送目标，供撤回与表态反查 */
export interface CachedMessageTarget {
  target: SendTarget
  time: number
}

/** 被动回复上下文 */
export interface ReplyContext {
  msgId: string
  eventId?: string
  time: number
}

/** 能力模块共用的上下文 */
export interface BotContext {
  readonly account: QQBotAccount
  readonly host: AdapterHost
  readonly deps: BotDeps

  /** 机器人自身 id：连接前取自配置，ready 后为平台真实 QQ 号 */
  selfId: string
  /** 机器人昵称，ready 后才有值 */
  nickname: string

  /** 频道私信映射：uid → guildId */
  readonly directMessageGuildMap: Map<string, string>
  /** 消息目标缓存：messageId → 目标，用于撤回与表态 */
  readonly messageTargetMap: Map<string, CachedMessageTarget>
  /** 最近入站消息：目标 → 被动回复上下文 */
  readonly replyContext: Map<string, ReplyContext>
  /** 入站去重：同一条消息被平台重复推送时只处理一次 */
  readonly dedupe: MessageDeduper
  /** 出站序号：同一 msg_id 的多次回复必须递增 msg_seq，否则平台判为重复请求 */
  readonly sequence: SequenceTracker

  readonly tokenManager: TokenManager
  readonly api: ApiClient
  readonly uploader: MediaUploader
  readonly officialImageHost: OfficialImageHost
  readonly imageResolver: ImageResolver

  /** 目标的稳定键：被动回复上下文按此索引 */
  targetKey(target: SendTarget): string
  /** 是否为频道传输（频道本身或频道私信） */
  isGuildTransport(target: SendTarget): boolean
  /** 当前目标场景是否启用 Markdown */
  resolveMarkdownEnabled(target: SendTarget): boolean
  /** 按场景把请求派发到对应的发送接口 */
  dispatchSend(target: SendTarget, request: SendMessageRequest): Promise<SendMessageResponse>
  /** 文件服务对外基址：账号配置优先，否则用内核面板地址 */
  resolveFileBaseUrl(): string

  /** 记录可撤回 / 可表态的消息目标 */
  rememberMessageTarget(messageId: string, target: SendTarget): void
  /** 记录被动回复上下文 */
  rememberReplyContext(target: SendTarget, messageId: string, eventId?: string): void
  /**
   * 回填被动回复与引用上下文
   *
   * `msg_id` 与 `message_reference` 是两个独立语义：
   * - `msg_id`：被动回复标记（5 分钟内免主动额度），自动补，不产生引用样式
   * - `message_reference`：引用 UI，只在内核显式传 quote（e.reply 的 quote 选项 / reply 段）时设置
   *
   * `msg_seq` 是平台侧的幂等键：同一 `msg_id` 配同一个 `msg_seq` 会被判为重复请求而失败，
   * 故每条回复都要向 `sequence` 取一个递增的新序号。
   */
  applyReplyContext(target: SendTarget, request: SendMessageRequest, quote?: string): void
}

/** 创建上下文：装配传输与图床依赖，并给出跨模块共用的基础判定 */
export function createBotContext(account: QQBotAccount, host: AdapterHost, deps: BotDeps): BotContext {
  const tokenManager = new TokenManager(account, deps.http, host.logger)
  const api = new ApiClient(tokenManager, deps.http, host.logger)
  const uploader = new MediaUploader(api, deps.http, host.logger)
  // 官方图床：按账号一个实例，本地去重缓存随进程存活
  const officialImageHost = new OfficialImageHost(api, deps.http, host.logger, account.imageSaveSeconds)

  /**
   * 图片转地址链路：自定义图床（插件实现 imageToUrl）→ 官方素材库 → 框架文件服务
   *
   * 自定义那一级由插件经 `ctx.provide(CUSTOM_IMAGE_KEY, fn)` 注入，可能根本没装，
   * 故传取用函数而不是实例；官方那一级按配置决定是否存在；框架那一级的基址随内核面板
   * 地址变化，同样传函数。
   */
  const imageResolver = new ImageResolver({
    resolve: ref => resolveMedia(ref, deps.http),
    ...(deps.customImage ? { custom: deps.customImage } : {}),
    ...(account.officialImage
      ? {
          official: (buffer: Buffer, meta: { filename?: string; mime?: string }) =>
            officialImageHost.upload(buffer, { filename: meta.filename, mime: meta.mime })
        }
      : {}),
    frameworkBase: () => ctx.resolveFileBaseUrl(),
    logger: host.logger
  })

  const ctx: BotContext = {
    account,
    host,
    deps,

    selfId: host.account.selfId ?? "",
    nickname: "",

    directMessageGuildMap: new Map(),
    messageTargetMap: new Map(),
    replyContext: new Map(),
    dedupe: createMessageDeduper(),
    sequence: createSequenceTracker(),

    tokenManager,
    api,
    uploader,
    officialImageHost,
    imageResolver,

    targetKey(target: SendTarget): string {
      if (target.scene === "group") return `group:${target.gid}`
      if (target.scene === "guild") return `guild:${target.channelId}`
      return `private:${target.uid}`
    },

    isGuildTransport(target: SendTarget): boolean {
      return target.scene === "guild" || (target.scene === "private" && ctx.directMessageGuildMap.has(target.uid))
    },

    resolveMarkdownEnabled(target: SendTarget): boolean {
      // 群 / C2C 用 groupMarkdown，频道 / 频道私信用 guildMarkdown
      if (target.scene === "group" || (target.scene === "private" && !ctx.directMessageGuildMap.has(target.uid))) {
        return account.groupMarkdown === true
      }
      if (target.scene === "guild" || (target.scene === "private" && ctx.directMessageGuildMap.has(target.uid))) {
        return account.guildMarkdown === true
      }
      return false
    },

    async dispatchSend(target: SendTarget, request: SendMessageRequest): Promise<SendMessageResponse> {
      if (target.scene === "group") return api.sendGroupMessage(target.gid, request)
      if (target.scene === "private") {
        const guildId = ctx.directMessageGuildMap.get(target.uid)
        return guildId ? api.sendDirectMessage(guildId, request) : api.sendC2CMessage(target.uid, request)
      }
      if (target.scene === "guild") return api.sendGuildMessage(target.channelId, request)
      throw new Error("QQ Bot 适配器不支持此消息场景")
    },

    resolveFileBaseUrl(): string {
      const configured = account.serverAddress.trim()
      if (configured) return configured.replace(/\/+$/, "")
      const server = host.server
      return server.enabled ? server.publicUrl.replace(/\/+$/, "") : ""
    },

    rememberMessageTarget(messageId: string, target: SendTarget): void {
      const now = Date.now()
      for (const [id, value] of ctx.messageTargetMap) {
        if (now - value.time > MESSAGE_TARGET_TTL) ctx.messageTargetMap.delete(id)
      }
      ctx.messageTargetMap.delete(messageId)
      ctx.messageTargetMap.set(messageId, { target, time: now })
      while (ctx.messageTargetMap.size > MESSAGE_TARGET_LIMIT) {
        const firstId = ctx.messageTargetMap.keys().next().value
        if (firstId === undefined) break
        ctx.messageTargetMap.delete(firstId)
      }
    },

    rememberReplyContext(target: SendTarget, messageId: string, eventId?: string): void {
      const now = Date.now()
      ctx.replyContext.set(ctx.targetKey(target), { msgId: messageId, eventId, time: now })
      for (const [key, value] of ctx.replyContext) {
        if (now - value.time > REPLY_CONTEXT_TTL) ctx.replyContext.delete(key)
      }
    },

    applyReplyContext(target: SendTarget, request: SendMessageRequest, quote?: string): void {
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
        const context = ctx.replyContext.get(ctx.targetKey(target))
        if (context && Date.now() - context.time <= REPLY_CONTEXT_TTL) {
          // 仅被动回复标记；不挂 message_reference，避免每条回复都变成引用回复
          if (context.eventId) request.event_id = context.eventId
          else request.msg_id = context.msgId
        }
      }
      request.msg_seq = ctx.sequence.next(request.msg_id ?? request.event_id)
    }
  }

  return ctx
}
