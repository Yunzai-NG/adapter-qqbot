import { describe, expect, it } from "vitest"
import type { Logger, SendTarget, Segment } from "@yunzai-ng/types"
import type { BotContext } from "./context.js"
import type { SendMessageRequest } from "../protocol/types.js"
import { createSender } from "./send.js"

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

/** 一张字节无效的图片：取不到尺寸时 Markdown 描述符按 1000x1000 兜底，不影响拆分逻辑 */
const image: Segment = { type: "image", file: { kind: "buffer", data: new Uint8Array([1, 2, 3]) } }

interface Harness {
  ctx: BotContext
  sent: SendMessageRequest[]
  state: { uploads: number }
}

/** 只装配发送链路需要的那几个成员，其余按 BotContext 断言掉 */
function harness(options: { markdown: boolean; scene: "group" | "guild"; mode?: "raw" | "inline" }): Harness {
  const sent: SendMessageRequest[] = []
  const state = { uploads: 0 }
  const ctx = {
    account: {
      appId: "app-id",
      imageMaxSizeMb: 0,
      markdownMode: options.mode ?? "raw",
      markdownTemplateId: "",
      markdownTemplateKeys: "abcdefghij",
      keyboardTemplateId: "",
      forwardMode: "merge"
    },
    host: { logger },
    deps: { http: {} },
    directMessageGuildMap: new Map<string, string>(),
    messageTargetMap: new Map(),
    imageResolver: {
      toUrlFromMedia: async () => ({ url: "https://cdn.test/a.png", channel: "custom" })
    },
    uploader: {
      upload: async () => {
        state.uploads++
        return { file_uuid: "uuid", file_info: "file-info", ttl: 0 }
      }
    },
    resolveMarkdownEnabled: () => options.markdown,
    isGuildTransport: () => options.scene === "guild",
    dispatchSend: async (_target: SendTarget, request: SendMessageRequest) => {
      sent.push(request)
      return { id: `msg-${sent.length}`, timestamp: String(Date.now()) }
    },
    applyReplyContext: () => {},
    rememberMessageTarget: () => {},
    api: {}
  } as unknown as BotContext
  return { ctx, sent, state }
}

describe("sendMessage", () => {
  it("keeps text and an image in one Markdown message", async () => {
    const { ctx, sent } = harness({ markdown: true, scene: "group" })
    await createSender(ctx).sendMessage({ scene: "group", gid: "g1" }, [
      { type: "text", text: "看看" },
      image
    ])

    expect(sent).toHaveLength(1)
    // 图片跟在文字后面是允许的（行内），末尾没有后续内容就不补空行
    expect(sent[0].markdown?.content).toBe("看看![图片 #1000px #1000px](https://cdn.test/a.png)")
  })

  it("puts a line break after a Markdown image so the following text starts a new line", async () => {
    // 今日小猪的实际排版：图片段在前，标题与引用块在后面的 Markdown 段里
    const { ctx, sent } = harness({ markdown: true, scene: "group" })
    await createSender(ctx).sendMessage({ scene: "group", gid: "g1" }, [
      image,
      { type: "markdown", content: "**【复读猪】**" }
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0].markdown?.content).toBe(
      "![图片 #1000px #1000px](https://cdn.test/a.png)\r**【复读猪】**"
    )
  })

  it("merges several images into the same Markdown message", async () => {
    const { ctx, sent } = harness({ markdown: true, scene: "guild" })
    await createSender(ctx).sendMessage({ scene: "guild", guildId: "gd", channelId: "c1" }, [
      { type: "text", text: "两张" },
      image,
      { type: "text", text: "都在" },
      image
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0].markdown?.content?.match(/!\[图片/g)).toHaveLength(2)
    expect(sent[0].file_image).toBeUndefined()
  })

  it("still splits a rich-media image into its own message without Markdown", async () => {
    const { ctx, sent, state } = harness({ markdown: false, scene: "group" })
    await createSender(ctx).sendMessage({ scene: "group", gid: "g1" }, [
      { type: "text", text: "说明" },
      image
    ])

    expect(sent).toHaveLength(2)
    expect(sent[0].content).toBe("说明")
    expect(sent[1].msg_type).toBe(7)
    expect(sent[1].media?.file_info).toBe("file-info")
    expect(state.uploads).toBe(1)
  })
})
