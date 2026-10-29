/**
 * 模块职责：Webhook 传输通道 —— 签名算法、处理器注册表与路由处理器
 * 依赖方向：依赖 tweetnacl / node:crypto 与 protocol/types；不依赖任何上层模块
 * 生命周期：注册表是模块级单例（随插件加载存在），路由处理器在 setup 时创建一次
 * 注意事项：
 *   - 签名验证：x-signature-ed25519 + x-signature-timestamp
 *   - 签名内容：timestamp + body（字符串拼接）
 *   - op=13 回调验证：sign(event_ts, plain_token)
 *   - op=0 事件推送：verify(timestamp, rawBody, signature)
 *   - 每个失败分支都必须留下日志：平台侧只会显示「校验不通过」，
 *     真正的病因（地址没打进来 / 账号没注册 / header 被代理吃掉）只能从这里看出来
 *   - 注册表与签名算法都只服务本通道，故与路由处理器同文件；bot 与入口只经由本模块交互
 */
import { timingSafeEqual } from "node:crypto"
import nacl from "tweetnacl"
import type { Logger, RouteHandler, RouteRequest, RouteResponse } from "@yunzai-ng/types"
import { OpCode } from "../protocol/types.js"
import type { WSPayload } from "../protocol/types.js"

/* ------------------------------------------------------------------ *
 * 签名算法（Ed25519）
 * ------------------------------------------------------------------ */

/** 从 secret 生成密钥对（不足 32 字节循环填充） */
function generateKeyPair(seed: string) {
  let finalSeed = seed
  while (finalSeed.length < 32) finalSeed = finalSeed.repeat(2)
  finalSeed = finalSeed.slice(0, 32)
  return nacl.sign.keyPair.fromSeed(Buffer.from(finalSeed, "utf-8"))
}

/** Ed25519 签名工具 */
export class Ed25519 {
  private secretKey: Uint8Array
  private publicKey: Uint8Array

  /** @param secret 机器人 AppSecret，作为密钥种子 */
  constructor(secret: string) {
    const keyPair = generateKeyPair(secret)
    this.secretKey = keyPair.secretKey
    this.publicKey = keyPair.publicKey
  }

  /** 对 eventTs + token 签名（hex 编码） */
  sign(eventTs: string, token: string): string {
    const messageBytes = Buffer.from(eventTs + token, "utf-8")
    const signature = nacl.sign.detached(messageBytes, this.secretKey)
    return Buffer.from(signature).toString("hex")
  }

  /**
   * 验证 webhook 推送签名（重新计算签名并定时安全比较）
   *
   * 不用 `===` 比较：字符串比较会在首个不同字符处提前返回，理论上可被逐字节
   * 掐时间推断出正确签名。这里先同样长再 `timingSafeEqual`。
   */
  verify(timestamp: string, rawBody: string, ed25519Hex: string): boolean {
    const expected = this.sign(timestamp, rawBody)
    const expectedBytes = Buffer.from(expected, "hex")
    const actualBytes = Buffer.from(ed25519Hex, "hex")

    // Hex 非法或长度不符时 Buffer 会截断，长度不同直接判否（timingSafeEqual 要求等长）
    if (expectedBytes.length !== actualBytes.length || expectedBytes.length === 0) return false
    return timingSafeEqual(expectedBytes, actualBytes)
  }
}

/** 插件 URL 作用域：与 definePlugin 的 name 保持一致 */
const PLUGIN_SCOPE = "/plugin/adapter-qqbot"

/** Webhook 路由路径（相对插件作用域） */
export const WEBHOOK_ROUTE_PATH = "/qqbot"

/** 开放平台「回调地址」中应填写的路径部分（域名之后的部分） */
export const WEBHOOK_CALLBACK_PATH = `${PLUGIN_SCOPE}${WEBHOOK_ROUTE_PATH}`

/** Webhook 处理器注册信息 */
export interface WebhookHandlerInfo {
  handler: (appId: string, packet: WSPayload) => void
  ed25519: Ed25519
}

/* ------------------------------------------------------------------ *
 * 处理器注册表（appId → handler info）
 * ------------------------------------------------------------------ */

/**
 * appId → handler info 的注册表
 *
 * 模块级单例：入口在 setup 时用它构建路由，BotDriver 在连接/断开时增删条目。
 * 与路由处理器同模块，是为了让「写注册表」与「读注册表」只有一处定义，
 * 不会出现两方各自 import 一个 20 行的中间层。
 */
export const webhookRegistry = new Map<string, WebhookHandlerInfo>()

/** 注册 webhook 处理器 */
export function registerWebhookHandler(appId: string, info: WebhookHandlerInfo): void {
  webhookRegistry.set(appId, info)
}

/** 注销 webhook 处理器 */
export function unregisterWebhookHandler(appId: string): void {
  webhookRegistry.delete(appId)
}

/**
 * 回调校验里 plain_token 的合法形态
 *
 * 平台下发的 token 是 base62（如 `Arq0D5A61EgUu4OxUvOp`）。**必须限定字符集**，否则
 * op=13 就成了签名预言机：它的签名内容是 `event_ts + plain_token`，与 op=0 的
 * `timestamp + body` 完全同构，攻击者把「想伪造的事件 JSON」当 token 发过来即可换到
 * 一个能通过验签的签名。限定为 base62 后，能签出的消息只剩「数字 + 字母数字」，
 * 而合法事件体必然以 `{` 开头，构造不出来。
 */
const PLAIN_TOKEN_PATTERN = /^[A-Za-z0-9]{1,128}$/

/** event_ts 为秒或毫秒时间戳，只应是纯数字 */
const EVENT_TS_PATTERN = /^\d{1,16}$/

/** 事件推送签名时间戳允许的时钟偏差（秒）：超出即视为过期或重放 */
const TIMESTAMP_TOLERANCE_SECONDS = 300

/** 已处理事件 id 的缓存上限，超出按插入顺序淘汰最旧的一条 */
const SEEN_EVENT_LIMIT = 2048

/** 已处理事件 id（`appid:eventId`），用于挡重放与平台重试导致的重复执行 */
const seenEvents = new Map<string, number>()

/** 记录并判断某事件是否已处理过 */
function alreadySeen(key: string): boolean {
  if (seenEvents.has(key)) return true
  seenEvents.set(key, Date.now())
  if (seenEvents.size > SEEN_EVENT_LIMIT) {
    const oldest = seenEvents.keys().next().value
    if (oldest !== undefined) seenEvents.delete(oldest)
  }
  return false
}

/** 取单值请求头，数组形态取第一个 */
function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** 请求摘要：日志里定位「谁从哪儿打进来」 */
function describeRequest(req: RouteRequest): string {
  const ua = headerOf(req.headers["user-agent"]) ?? "-"
  return `ip=${req.ip} path=${req.path} ua="${ua}"`
}

/** 请求体预览：截断避免刷屏，仅用于判断对端到底发了什么 */
function previewBody(rawBody: string): string {
  const flat = rawBody.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/** 创建 webhook 路由处理器 */
export function createWebhookHandler(
  handlers: Map<string, WebhookHandlerInfo>,
  logger?: Logger
): RouteHandler {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    // 获取 AppID（QQ 平台使用 X-Bot-Appid）
    const appId = headerOf(req.headers["x-bot-appid"])

    if (!appId) {
      // 平台一定会带这个头；缺失基本只有一种可能：反向代理/防火墙剥掉了自定义头
      logger?.warn(
        `[qqbot] Webhook 请求缺少 X-Bot-Appid 头（${describeRequest(req)}）——` +
          `检查反向代理是否过滤了 X-Bot-Appid 请求头`
      )
      return { status: 400, body: { error: "Missing X-Bot-Appid header" } }
    }

    // 查找对应的 Bot
    const handlerInfo = handlers.get(appId)
    if (!handlerInfo) {
      // 最常见的一种「平台校验不通过」：账号没启动，或模式不是 webhook
      const known = [...handlers.keys()]
      logger?.warn(
        `[qqbot] Webhook 请求的 AppID 未注册：appid=${appId}（${describeRequest(req)}）。` +
          `已注册 AppID：${known.length > 0 ? known.join(", ") : "无"}。` +
          `请确认该账号已启用且连接方式为「Webhook 回调」，并检查账号里填的 AppID 是否与开放平台一致`
      )
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

    if (packet === undefined || packet === null || typeof packet !== "object") {
      logger?.warn(
        `[qqbot] Webhook 请求体不是 JSON 对象：appid=${appId}（${describeRequest(req)}），` +
          `原始内容=「${previewBody(rawBody)}」`
      )
      return { status: 400, body: { error: "Invalid payload" } }
    }

    logger?.debug(
      `[qqbot] Webhook 请求：appid=${appId} op=${packet.op} t=${packet.t ?? "-"}（${describeRequest(req)}）`
    )

    // 根据 op 分发处理
    switch (packet.op) {
      case OpCode.CALLBACK_URL_VALIDATION: {
        // 回调地址验证（op=13）：不需要验证平台签名，直接生成并返回签名。
        // 正因为「不需要验签」，这里必须严格约束入参，否则等于对外开放一个签名服务。
        const d = packet.d as { plain_token?: unknown; event_ts?: unknown } | undefined
        const plainToken = d?.plain_token
        const rawEventTs = d?.event_ts

        // event_ts 在不同版本文档里既出现过字符串也出现过数字，两者都要接受；
        // 缺字段时直接 400 —— 否则会签出一个必然被平台判错的值，还查不到原因
        if (
          typeof plainToken !== "string" ||
          (typeof rawEventTs !== "string" && typeof rawEventTs !== "number")
        ) {
          logger?.warn(
            `[qqbot] 回调地址校验（op=13）请求体缺少 plain_token / event_ts：appid=${appId}，` +
              `原始内容=「${previewBody(rawBody)}」`
          )
          return { status: 400, body: { error: "Invalid callback validation payload" } }
        }

        const eventTs = String(rawEventTs)

        // 字符集/格式校验：挡住「把任意事件体当 plain_token 换签名」的签名预言机。
        // 合法事件体必然含 `{` / `"` / `:`，而 token 只允许 base62、时间戳只允许数字，
        // 故攻击者再也无法构造出能被 op=0 接受的消息。
        if (!PLAIN_TOKEN_PATTERN.test(plainToken) || !EVENT_TS_PATTERN.test(eventTs)) {
          logger?.warn(
            `[qqbot] 拒绝回调地址校验（op=13）：plain_token / event_ts 格式非法，` +
              `appid=${appId} event_ts=${eventTs.slice(0, 20)} ` +
              `plain_token=${previewBody(plainToken)}（${describeRequest(req)}）。` +
              `平台下发的是 base62 token + 纯数字时间戳，出现其他内容视为伪造请求`
          )
          return { status: 400, body: { error: "Invalid callback validation payload" } }
        }

        // 对 event_ts + plain_token 进行签名
        const signed = handlerInfo.ed25519.sign(eventTs, plainToken)

        // 平台保存回调地址时会连打两三条，属正常握手，info 级别会污染面板日志；
        // 排障时把日志级别调到 debug 即可看到完整 token 与签名
        logger?.debug(
          `[qqbot] 开放平台回调地址校验通过：appid=${appId} event_ts=${eventTs} ` +
            `plain_token=${plainToken} signature=${signed.slice(0, 16)}…`
        )

        return {
          status: 200,
          body: {
            plain_token: plainToken,
            signature: signed
          }
        }
      }

      case OpCode.DISPATCH: {
        // 事件推送（op=0）：需要验证签名
        const signature = headerOf(req.headers["x-signature-ed25519"])
        const timestamp = headerOf(req.headers["x-signature-timestamp"])

        if (!signature) {
          logger?.warn(
            `[qqbot] 事件推送（op=0）缺少 X-Signature-Ed25519 头：appid=${appId} ` +
              `timestamp=${timestamp ?? "缺失"}（${describeRequest(req)}）——` +
              `检查反向代理是否过滤了签名相关请求头`
          )
          return { status: 400, body: { error: "Missing signature" } }
        }

        if (!handlerInfo.ed25519.verify(timestamp ?? "", rawBody, signature)) {
          logger?.warn(
            `[qqbot] 事件推送签名校验失败：appid=${appId} timestamp=${timestamp ?? "缺失"} ` +
              `收到签名=${signature.slice(0, 16)}… 原始体长度=${rawBody.length} ` +
              `内容=「${previewBody(rawBody)}」。常见原因：账号 AppSecret 与平台不一致，` +
              `或反向代理改写了请求体（需保持原始字节不变）`
          )
          return { status: 401, body: { error: "Invalid signature" } }
        }

        // 时间戳新鲜度：签名只对「当时」有效，过期的一律按重放拒绝。
        // 平台给的是秒级时间戳（也兼容毫秒），与本机时钟允许 5 分钟偏差。
        const signedAt = Number(timestamp)
        const nowSeconds = Math.floor(Date.now() / 1000)
        const signedAtSeconds = signedAt > 1e12 ? signedAt / 1000 : signedAt
        const skew = Math.abs(nowSeconds - signedAtSeconds)

        if (!Number.isFinite(signedAtSeconds) || skew > TIMESTAMP_TOLERANCE_SECONDS) {
          logger?.warn(
            `[qqbot] 拒绝过期的事件推送：appid=${appId} 签名时间戳=${timestamp ?? "缺失"} ` +
              `本机时间=${nowSeconds} 相差=${Number.isFinite(skew) ? Math.round(skew) : "?"} 秒 ` +
              `（阈值 ${TIMESTAMP_TOLERANCE_SECONDS} 秒）。可能是重放攻击，` +
              `也可能是本机时钟未同步（检查 NTP）`
          )
          return { status: 401, body: { error: "Stale timestamp" } }
        }

        // 幂等：平台超时重试会重发同一事件，重放攻击也依赖重复投递。
        // 键里带上事件类型：不同 t 的事件可能共用同一个 d.id（例如都指向同一条消息）
        const eventId =
          typeof packet.id === "string" && packet.id !== ""
            ? packet.id
            : typeof (packet.d as { id?: unknown } | undefined)?.id === "string"
              ? (packet.d as { id: string }).id
              : undefined

        if (eventId !== undefined && alreadySeen(`${appId}:${packet.t ?? ""}:${eventId}`)) {
          logger?.debug(`[qqbot] 事件重复投递，已跳过：appid=${appId} t=${packet.t ?? "-"} id=${eventId}`)
          return { status: 200, body: { code: 0, message: "duplicate" } }
        }

        handlerInfo.handler(appId, packet)
        return {
          status: 200,
          body: { code: 0, message: "success" }
        }
      }

      default:
        logger?.warn(
          `[qqbot] 未知的 Webhook op=${String(packet.op)}：appid=${appId}（${describeRequest(req)}），` +
            `原始内容=「${previewBody(rawBody)}」`
        )
        return { status: 400, body: { error: "Unknown op" } }
    }
  }
}
