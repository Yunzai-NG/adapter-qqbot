/**
 * 模块职责：Webhook 路由处理器
 * 依赖方向：依赖 ed25519 / types / events
 * 生命周期：随插件 setup 创建，处理所有 webhook 请求
 * 注意事项：
 *   - 签名验证：x-signature-ed25519 + x-signature-timestamp
 *   - 签名内容：timestamp + body（字符串拼接）
 *   - op=13 回调验证：sign(event_ts, plain_token)
 *   - op=0 事件推送：verify(timestamp, rawBody, signature)
 */
import type { RouteHandler, RouteRequest, RouteResponse } from "@yunzai-ng/types"
import { Ed25519 } from "./ed25519.js"
import { OpCode } from "./types.js"
import type { WSPayload } from "./types.js"

/** Webhook 处理器注册信息 */
export interface WebhookHandlerInfo {
  /**
   *
   */
  handler: (appId: string, packet: WSPayload) => void
  /**
   *
   */
  ed25519: Ed25519
  /**
   *
   */
  logger?: { debug: (msg: string) => void }
}

/** 创建 webhook 路由处理器 */
export function createWebhookHandler(
  handlers: Map<string, WebhookHandlerInfo>
): RouteHandler {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    // 获取 AppID（QQ 平台使用 X-Bot-Appid）
    const appId = req.headers["x-bot-appid"] as string | undefined

    if (!appId || typeof appId !== "string") {
      return { status: 400, body: { error: "Missing X-Bot-Appid header" } }
    }

    // 查找对应的 Bot
    const handlerInfo = handlers.get(appId)
    if (!handlerInfo) {
      return { status: 404, body: { error: "Bot not found" } }
    }

    // 获取原始请求体字符串（用于签名验证）
    let rawBody: string
    if (req.rawBody instanceof Uint8Array) {
      rawBody = Buffer.from(req.rawBody).toString("utf8")
    } else if (typeof req.rawBody === "string") {
      rawBody = req.rawBody
    } else {
      rawBody = JSON.stringify(req.body)
    }

    // 解析数据包
    const packet = req.body as WSPayload

    // 根据 op 分发处理
    switch (packet.op) {
      case OpCode.CALLBACK_URL_VALIDATION: {
        // 回调地址验证（op=13）：不需要验证平台签名，直接生成并返回签名
        const { plain_token, event_ts } = packet.d as {
          plain_token: string
          event_ts: string
        }

        // 对 event_ts + plain_token 进行签名
        const signed = handlerInfo.ed25519.sign(event_ts, plain_token)

        return {
          status: 200,
          body: {
            plain_token,
            signature: signed
          }
        }
      }

      case OpCode.DISPATCH: {
        // 事件推送（op=0）：需要验证签名
        const signature = req.headers["x-signature-ed25519"] as string | undefined
        const timestamp = req.headers["x-signature-timestamp"] as string | undefined

        if (!signature) {
          return { status: 400, body: { error: "Missing signature" } }
        }

        if (!handlerInfo.ed25519.verify(timestamp ?? "", rawBody, signature)) {
          return { status: 401, body: { error: "Invalid signature" } }
        }

        handlerInfo.handler(appId, packet)
        return {
          status: 200,
          body: { code: 0, message: "success" }
        }
      }

      default:
        return { status: 400, body: { error: "Unknown op" } }
    }
  }
}
