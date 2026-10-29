import { describe, expect, it } from "vitest"
import type { AdapterHost, Logger, SendTarget } from "@yunzai-ng/types"
import { validateAccount } from "../config.js"
import type { SendMessageRequest } from "../protocol/types.js"
import { createBotContext } from "./context.js"

/** 静默 logger */
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger

/** 造一个只提供上下文构造所需字段的 host */
function createHost(): AdapterHost {
  return {
    account: { selfId: "10001" },
    logger,
    server: { enabled: false, publicUrl: "", port: 0 },
    setStatus() {},
    submit() {}
  } as unknown as AdapterHost
}

/** 建一套上下文 */
function setup() {
  const account = validateAccount({ appId: "102000000", appSecret: "secret", mode: "websocket" })
  return createBotContext(account, createHost(), { adapterId: "qqbot", http: {} as never })
}

const target: SendTarget = { scene: "group", gid: "GROUP_1" }

describe("applyReplyContext", () => {
  it("marks the first reply as passive and starts msg_seq at 1", () => {
    const ctx = setup()
    ctx.rememberReplyContext(target, "MSG_1")

    const request: SendMessageRequest = {}
    ctx.applyReplyContext(target, request)

    expect(request.msg_id).toBe("MSG_1")
    expect(request.msg_seq).toBe(1)
    // 自动补的被动回复标记不产生引用样式
    expect(request.message_reference).toBeUndefined()
  })

  it("increments msg_seq on every further reply to the same message", () => {
    const ctx = setup()
    ctx.rememberReplyContext(target, "MSG_1")

    const seqs = [1, 2, 3].map(() => {
      const request: SendMessageRequest = {}
      ctx.applyReplyContext(target, request)
      expect(request.msg_id).toBe("MSG_1")
      return request.msg_seq
    })

    expect(seqs).toEqual([1, 2, 3])
  })

  it("counts each inbound message independently", () => {
    const ctx = setup()

    ctx.rememberReplyContext(target, "MSG_1")
    const a1: SendMessageRequest = {}
    ctx.applyReplyContext(target, a1)
    const a2: SendMessageRequest = {}
    ctx.applyReplyContext(target, a2)

    // 同一目标收到新消息：上下文指向新 msg_id，序号不受上一条消息的计数影响
    ctx.rememberReplyContext(target, "MSG_2")
    const b1: SendMessageRequest = {}
    ctx.applyReplyContext(target, b1)

    expect([a1.msg_seq, a2.msg_seq]).toEqual([1, 2])
    expect(b1.msg_id).toBe("MSG_2")
    expect(b1.msg_seq).toBe(1)
  })

  it("uses event_id for event-anchored replies and never sets msg_id", () => {
    const ctx = setup()

    const request: SendMessageRequest = {}
    ctx.applyReplyContext(target, request, "event_EVENT_1")

    expect(request.event_id).toBe("EVENT_1")
    expect(request.msg_id).toBeUndefined()
    expect(request.msg_seq).toBe(1)
  })

  it("leaves active pushes without any passive anchor", () => {
    const ctx = setup()

    const request: SendMessageRequest = {}
    ctx.applyReplyContext(target, request)

    expect(request.msg_id).toBeUndefined()
    expect(request.event_id).toBeUndefined()
    // 无锚点时给随机序号，同样落在平台允许区间
    expect(request.msg_seq).toBeGreaterThanOrEqual(1)
  })
})
