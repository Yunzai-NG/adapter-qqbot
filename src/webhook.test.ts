import { describe, expect, it } from "vitest"
import { Ed25519 } from "./ed25519.js"
import { createWebhookHandler, WEBHOOK_CALLBACK_PATH, type WebhookHandlerInfo } from "./webhook.js"
import type { WSPayload } from "./types.js"

/** 官方文档给出的签名用例：用它锁住 seed 生成与签名拼接方式 */
const SECRET = "DG5g3B4j9X2KOErG"
const APP_ID = "11111111"
const VALIDATION: WSPayload = {
  op: 13,
  d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" }
}
const VALIDATION_SIGNATURE =
  "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706"

/** 造一个最简 RouteRequest，只填 handler 真正读取的字段 */
function request(
  packet: unknown,
  headers: Record<string, string> = { "x-bot-appid": APP_ID },
  rawBody = JSON.stringify(packet)
) {
  return { headers, body: packet, rawBody, ip: "1.2.3.4", path: WEBHOOK_CALLBACK_PATH, params: {}, query: {}, method: "POST" } as never
}

/** 只收集日志文本，避免向测试输出刷屏 */
function collectingLogger() {
  const lines: string[] = []
  const push = (level: string) => (msg: unknown) => {
    lines.push(`${level} ${String(msg)}`)
  }
  const logger = {
    level: "debug" as const,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    mark: push("mark"),
    isLevelEnabled: () => true,
    child: () => logger
  }
  return { lines, logger }
}

function registry(ed25519 = new Ed25519(SECRET)): Map<string, WebhookHandlerInfo> {
  return new Map([[APP_ID, { handler: () => undefined, ed25519 }]])
}

describe("webhook handler", () => {
  it("answers op=13 with the signature from the official test vector", async () => {
    const handler = createWebhookHandler(registry())
    const response = (await handler(request(VALIDATION))) as { status: number; body: { signature: string } }

    expect(response.status).toBe(200)
    expect(response.body.signature).toBe(VALIDATION_SIGNATURE)
  })

  it("accepts event_ts as a number", async () => {
    const handler = createWebhookHandler(registry())
    const packet = { op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: 1725442341 } }
    const response = (await handler(request(packet))) as { body: { signature: string } }

    expect(response.body.signature).toBe(VALIDATION_SIGNATURE)
  })

  it("rejects a request without X-Bot-Appid and logs why", async () => {
    const { lines, logger } = collectingLogger()
    const handler = createWebhookHandler(registry(), logger)
    const response = (await handler(request(VALIDATION, {}))) as { status: number }

    expect(response.status).toBe(400)
    expect(lines.join("\n")).toContain("缺少 X-Bot-Appid")
  })

  it("returns 404 for an unregistered appid and names it in the log", async () => {
    const { lines, logger } = collectingLogger()
    const handler = createWebhookHandler(new Map(), logger)
    const response = (await handler(request(VALIDATION))) as { status: number }

    expect(response.status).toBe(404)
    expect(lines.join("\n")).toContain(`未注册：appid=${APP_ID}`)
  })

  it("rejects a malformed op=13 payload instead of signing garbage", async () => {
    const { lines, logger } = collectingLogger()
    const handler = createWebhookHandler(registry(), logger)
    const response = (await handler(request({ op: 13, d: {} }))) as { status: number }

    expect(response.status).toBe(400)
    expect(lines.join("\n")).toContain("缺少 plain_token / event_ts")
  })

  it("refuses to sign a JSON body, closing the signature oracle", async () => {
    const { lines, logger } = collectingLogger()
    const ed25519 = new Ed25519(SECRET)
    const handler = createWebhookHandler(registry(ed25519), logger)
    const forged = { op: 0, id: "FORGED", t: "AT_MESSAGE_CREATE", d: { content: "#关机" } }
    const eventTs = String(Math.floor(Date.now() / 1000))

    // 攻击链路第一步：把要伪造的事件体当 plain_token 去换签名，必须被拒
    const signAttempt = (await handler(
      request({ op: 13, d: { plain_token: JSON.stringify(forged), event_ts: eventTs } })
    )) as { status: number }

    expect(signAttempt.status).toBe(400)
    expect(lines.join("\n")).toContain("格式非法")

    // 即便攻击者自己算签名也无济于事（没有 AppSecret），顺手确认正常验签仍然生效
    const rejected = (await handler(
      request(forged, {
        "x-bot-appid": APP_ID,
        "x-signature-ed25519": "ab".repeat(64),
        "x-signature-timestamp": eventTs
      })
    )) as { status: number }

    expect(rejected.status).toBe(401)
  })

  it("rejects an op=13 whose event_ts is not numeric", async () => {
    const handler = createWebhookHandler(registry())
    const response = (await handler(
      request({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "2026-10-24T07:00:00Z" } })
    )) as { status: number }

    expect(response.status).toBe(400)
  })

  it("accepts the platform's real token shape", async () => {
    const handler = createWebhookHandler(registry())
    const response = (await handler(
      request({ op: 13, d: { plain_token: "qgg8vlvZRS6UYooatFL8Aw", event_ts: "1654503849680" } })
    )) as { status: number }

    expect(response.status).toBe(200)
  })

  it("rejects a correctly signed but stale event", async () => {
    const { lines, logger } = collectingLogger()
    const ed25519 = new Ed25519(SECRET)
    const handler = createWebhookHandler(registry(ed25519), logger)
    const packet = { op: 0, id: "STALE-1", t: "AT_MESSAGE_CREATE", d: { content: "hi" } }
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600)
    const signature = ed25519.sign(staleTs, JSON.stringify(packet))

    const response = (await handler(
      request(packet, {
        "x-bot-appid": APP_ID,
        "x-signature-ed25519": signature,
        "x-signature-timestamp": staleTs
      })
    )) as { status: number }

    expect(response.status).toBe(401)
    expect(lines.join("\n")).toContain("拒绝过期的事件推送")
  })

  it("delivers a signed event once and swallows the duplicate", async () => {
    const ed25519 = new Ed25519(SECRET)
    const received: unknown[] = []
    const handlers = new Map([[APP_ID, { handler: (_id: string, p: WSPayload) => { received.push(p) }, ed25519 }]])
    const handler = createWebhookHandler(handlers)
    const packet = { op: 0, id: "DUP-1", t: "AT_MESSAGE_CREATE", d: { id: "MSG-DUP", content: "hi" } }
    const ts = String(Math.floor(Date.now() / 1000))
    const headers = { "x-bot-appid": APP_ID, "x-signature-ed25519": ed25519.sign(ts, JSON.stringify(packet)), "x-signature-timestamp": ts }

    const first = (await handler(request(packet, headers))) as { body: { message: string } }
    const second = (await handler(request(packet, headers))) as { body: { message: string } }

    expect(first.body.message).toBe("success")
    expect(second.body.message).toBe("duplicate")
    expect(received).toHaveLength(1)
  })

  it("logs a signature mismatch on op=0", async () => {
    const { lines, logger } = collectingLogger()
    const handler = createWebhookHandler(registry(), logger)
    const headers = { "x-bot-appid": APP_ID, "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": "1725442341" }
    const response = (await handler(request({ op: 0, t: "AT_MESSAGE_CREATE", d: {} }, headers))) as { status: number }

    expect(response.status).toBe(401)
    expect(lines.join("\n")).toContain("签名校验失败")
  })

  it("reports the callback path the platform expects", () => {
    expect(WEBHOOK_CALLBACK_PATH).toBe("/plugin/adapter-qqbot/qqbot")
  })
})
