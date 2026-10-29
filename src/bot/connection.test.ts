import { describe, expect, it, vi } from "vitest"
import type { AdapterHost, Logger } from "@yunzai-ng/types"
import { validateAccount } from "../config.js"
import { createBotContext } from "./context.js"
import { createConnection } from "./connection.js"

/** 静默 logger，避免解码过程的 debug 日志刷屏 */
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger

/** 造一个只实现 ingest 所需字段的 host */
function createHost(submit = vi.fn()): { host: AdapterHost; submit: ReturnType<typeof vi.fn> } {
  const host = {
    account: { selfId: "10001" },
    logger,
    server: { enabled: false, publicUrl: "", port: 0 },
    setStatus() {},
    submit
  } as unknown as AdapterHost
  return { host, submit }
}

/** 一条最简群消息报文 */
function groupMessage(id: string): Record<string, unknown> {
  return {
    id,
    content: "hi",
    timestamp: "2026-10-29T10:00:00Z",
    group_openid: "GROUP_1",
    author: { id: "USER_1", username: "tester", avatar: "" }
  }
}

/** 建一套 context + connection，返回事件入口 */
function setup(): { ingest: (type: string, data: unknown) => void; submit: ReturnType<typeof vi.fn> } {
  const { host, submit } = createHost()
  const account = validateAccount({ appId: "102000000", appSecret: "secret", mode: "websocket" })
  const ctx = createBotContext(account, host, { adapterId: "qqbot", http: {} as never })
  return { ingest: createConnection(ctx).ingest, submit }
}

describe("ingest dedupe", () => {
  it("submits a repeated push of the same message only once", () => {
    const { ingest, submit } = setup()
    const packet = groupMessage("MSG_1")

    ingest("GROUP_AT_MESSAGE_CREATE", packet)
    ingest("GROUP_AT_MESSAGE_CREATE", packet)
    ingest("GROUP_AT_MESSAGE_CREATE", packet)

    expect(submit).toHaveBeenCalledTimes(1)
  })

  it("submits distinct messages separately", () => {
    const { ingest, submit } = setup()

    ingest("GROUP_AT_MESSAGE_CREATE", groupMessage("MSG_1"))
    ingest("GROUP_AT_MESSAGE_CREATE", groupMessage("MSG_2"))

    expect(submit).toHaveBeenCalledTimes(2)
  })

  it("keeps repeated notices untouched — only messages are deduped", () => {
    const { ingest, submit } = setup()
    const notice = { group_openid: "GROUP_1", timestamp: "2026-10-29T10:00:00Z", member_openid: "USER_1" }

    ingest("GROUP_MEMBER_ADD", notice)
    ingest("GROUP_MEMBER_ADD", notice)

    expect(submit).toHaveBeenCalledTimes(2)
  })
})
