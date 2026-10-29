/**
 * 模块职责：出站消息 —— 发送、转发、撤回、表态，以及 Markdown 发送前的图片转址
 * 依赖方向：依赖 messaging/outbound（段编译）、media（取址）与 protocol（Markdown 描述符）
 * 生命周期：随 createQQBotBot 创建一次，方法无内部状态，状态全在 BotContext
 * 注意事项：
 *   - 平台限制一条消息只带一个富元素，故先编译成多条计划再逐条发送
 *   - Markdown 开启时图片一律转公网地址写进 Markdown，绝不走富媒体接口
 *   - 至少一条送达即返回成功，失败明细留在 raw，避免上层把已投递内容误判为全失败
 */
import { toSegments } from "@yunzai-ng/core"
import type {
  ForwardNode,
  MessageContent,
  SendOptions,
  SendResult,
  SendTarget,
  Segment
} from "@yunzai-ng/types"
import type { SendMessageRequest, SendMessageResponse } from "../protocol/types.js"
import { markdownImage } from "../protocol/markdown.js"
import { buildOutbound } from "../messaging/outbound.js"
import type { OutboundMessage } from "../messaging/outbound.js"
import { getImageSize } from "../media/probe.js"
import { mediaUrl, resolveMedia } from "../media/resolve.js"
import { MESSAGE_TARGET_TTL } from "./context.js"
import type { BotContext } from "./context.js"

/** 发送能力面 */
export interface SendApi {
  sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult>
  sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult>
  recallMessage(messageId: string): Promise<boolean>
  setReaction(messageId: string, emojiId: string, add?: boolean): Promise<void>
}

/** 单张图片转公网 URL 的结果 */
interface ConvertedImage {
  /** 公网 URL（官方图床为 qqbot-media:// 引用） */
  url: string
  /** 实测宽高（Markdown 图片描述符需要） */
  size?: { width: number; height: number }
}

/** 建立发送能力 */
export function createSender(ctx: BotContext): SendApi {
  const { account, host, deps } = ctx

  /**
   * 单张图片转公网 URL：走三级链路（自定义 → 官方 → 框架），全都不可用时返回 undefined
   *
   * 官方图床返回 `qqbot-media://` 引用，同样能写进 Markdown。
   */
  async function convertMarkdownImage(segment: Extract<Segment, { type: "image" }>): Promise<ConvertedImage | undefined> {
    try {
      const resolved = await resolveMedia(segment.file, deps.http)
      const size = getImageSize(resolved.buffer) ?? undefined
      const result = await ctx.imageResolver.toUrlFromMedia(resolved, mediaUrl(segment.file))
      if (result) {
        host.logger.debug(`[qqbot] Markdown 图片已转地址（${result.channel}）：${result.url}`)
        return { url: result.url, size }
      }
      host.logger.warn("[qqbot] 三级图床均不可用，图片已降级为文本")
      return undefined
    } catch (err) {
      host.logger.warn(`[qqbot] Markdown 图片处理失败，已降级为文本：${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /**
   * Markdown 图片计划：图片统一转公网 URL 后以 Markdown 发送，**绝不走 QQ 富媒体**
   *
   * 取址走图片链路的同一条路（自定义图床 → 官方 → 框架）；全链路不可用时图片降级为
   * 文本占位并告警。Markdown 未启用或 legacy 模式才返回 undefined 走原生路径。
   */
  async function buildMarkdownImagePlans(
    target: SendTarget,
    content: MessageContent
  ): Promise<OutboundMessage[] | undefined> {
    if (!ctx.resolveMarkdownEnabled(target) || account.markdownMode === "legacy") return undefined
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
      scene: ctx.isGuildTransport(target) ? "guild" : target.scene,
      directMessage: target.scene === "private" && ctx.isGuildTransport(target),
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

  /** 执行一条已编译的消息：补回复上下文、按需上传富媒体、派发到对应接口 */
  async function executeOutbound(
    target: SendTarget,
    message: OutboundMessage,
    quote?: string
  ): Promise<SendMessageResponse> {
    const request: SendMessageRequest = { ...message.request }
    ctx.applyReplyContext(target, request, quote)

    let response: SendMessageResponse
    if (message.upload) {
      if (target.scene === "group") {
        const uploaded = await ctx.uploader.upload(message.upload.ref, {
          target: "group", targetId: target.gid, fileType: message.upload.fileType, fileName: message.upload.name
        })
        request.media = { file_info: uploaded.file_info }
      } else if (target.scene === "private" && !ctx.isGuildTransport(target)) {
        const uploaded = await ctx.uploader.upload(message.upload.ref, {
          target: "user", targetId: target.uid, fileType: message.upload.fileType, fileName: message.upload.name
        })
        request.media = { file_info: uploaded.file_info }
      } else {
        throw new Error("频道场景不能走 QQ 富媒体上传接口")
      }
    }

    if (message.guildBlob) {
      const { buffer } = await resolveMedia(message.guildBlob, deps.http)
      if (target.scene === "guild") response = await ctx.api.sendGuildMessageWithImage(target.channelId, request, buffer)
      else if (target.scene === "private" && ctx.isGuildTransport(target)) {
        response = await ctx.api.sendDirectMessageWithImage(ctx.directMessageGuildMap.get(target.uid)!, request, buffer)
      } else throw new Error("只有频道场景可使用 multipart 图片")
    } else {
      response = await ctx.dispatchSend(target, request)
    }
    ctx.rememberMessageTarget(response.id, target)
    return response
  }

  async function sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult> {
    const messages = await buildMarkdownImagePlans(target, content) ?? buildOutbound(toSegments(content), {
      scene: ctx.isGuildTransport(target) ? "guild" : target.scene,
      directMessage: target.scene === "private" && ctx.isGuildTransport(target),
      markdownEnabled: ctx.resolveMarkdownEnabled(target),
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
  }

  return {
    sendMessage,

    async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
      if (!nodes.length) throw new Error("QQ Bot 转发消息没有节点")
      return sendMessage(target, [{ type: "forward", nodes }])
    },

    async recallMessage(messageId: string): Promise<boolean> {
      // QQ Bot API 撤回消息：
      // - 群聊: DELETE /v2/groups/{group_openid}/messages/{message_id}
      // - C2C 私聊: DELETE /v2/users/{openid}/messages/{message_id}
      // - 频道: DELETE /channels/{channel_id}/messages/{message_id}
      // - 频道私信: DELETE /dms/{guild_id}/messages/{message_id}
      const cached = ctx.messageTargetMap.get(messageId)
      const target = cached?.target
      if (!target || !cached || Date.now() - cached.time > MESSAGE_TARGET_TTL) {
        if (cached) ctx.messageTargetMap.delete(messageId)
        host.logger.warn(`未找到消息 ${messageId} 的有效目标信息，无法撤回`)
        return false
      }

      try {
        if (target.scene === "group") {
          // 撤回群消息
          await ctx.api.recallGroupMessage(target.gid, messageId)
        } else if (target.scene === "private") {
          // 检查是否是频道私信
          const guildId = ctx.directMessageGuildMap.get(target.uid)
          if (guildId) {
            // 撤回频道私信
            await ctx.api.recallDirectMessage(guildId, messageId)
          } else {
            // 撤回 C2C 私聊消息
            await ctx.api.recallC2CMessage(target.uid, messageId)
          }
        } else if (target.scene === "guild") {
          // 撤回频道消息
          await ctx.api.recallGuildMessage(target.channelId, messageId)
        } else {
          host.logger.warn(`不支持的消息场景: ${(target as any).scene}`)
          return false
        }

        // 撤回成功后移除缓存
        ctx.messageTargetMap.delete(messageId)
        return true
      } catch (err: any) {
        host.logger.error(`撤回消息失败: ${err.message}`)
        return false
      }
    },

    async setReaction(messageId: string, emojiId: string, add = true): Promise<void> {
      const cached = ctx.messageTargetMap.get(messageId)
      if (!cached || Date.now() - cached.time > MESSAGE_TARGET_TTL) {
        if (cached) ctx.messageTargetMap.delete(messageId)
        throw new Error(`未找到频道消息 ${messageId} 的有效目标信息，无法表态`)
      }
      if (cached.target.scene !== "guild") {
        throw new Error("QQ Bot 仅支持对频道消息设置表态")
      }
      await ctx.api.setGuildMessageReaction(cached.target.channelId, messageId, emojiId, add)
    }
  }
}
