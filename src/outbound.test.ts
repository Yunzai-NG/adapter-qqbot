import { describe, expect, it } from "vitest"
import type { Segment } from "@yunzai-ng/types"
import { buildOutbound } from "./outbound.js"

const rawContext = {
  scene: "group" as const,
  markdownEnabled: true,
  markdownMode: "raw" as const
}

describe("buildOutbound", () => {
  it("splits group media into one request per rich element and applies replies", () => {
    const segments: Segment[] = [
      { type: "text", text: "before" },
      { type: "image", file: { kind: "url", url: "https://example.test/1.png" } },
      { type: "text", text: "between" },
      { type: "image", file: { kind: "url", url: "https://example.test/2.png" } },
      { type: "reply", messageId: "quoted" }
    ]
    const messages = buildOutbound(segments, rawContext)

    expect(messages).toHaveLength(4)
    expect(messages.filter(message => message.upload)).toHaveLength(2)
    expect(messages.every(message => message.request.msg_id === "quoted")).toBe(true)
    expect(messages.every(message => message.request.message_reference?.message_id === "quoted")).toBe(true)
  })

  it("uses JSON image URLs and multipart blobs for guild images", () => {
    const messages = buildOutbound([
      { type: "image", file: { kind: "url", url: "https://example.test/1.png" } },
      { type: "image", file: { kind: "buffer", data: Buffer.from("local") } }
    ], { scene: "guild", markdownEnabled: false })

    expect(messages).toHaveLength(2)
    expect(messages[0].request.image).toBe("https://example.test/1.png")
    expect(messages[1].guildBlob).toMatchObject({ kind: "buffer" })
  })

  it("recursively expands forwards and never drops uncommon segments", () => {
    const warnings: string[] = []
    const messages = buildOutbound([
      {
        type: "forward",
        nodes: [{ message: [{ type: "dice", result: 4 }, { type: "text", text: "nested" }] }]
      },
      { type: "contact", scene: "user", id: "123" }
    ], { scene: "group", markdownEnabled: false, warn: message => warnings.push(message) })

    expect(messages.flatMap(message => message.request.content ?? "").join(""))
      .toContain("[骰子 4]nested[推荐好友] 123")
    expect(warnings).toHaveLength(0)
  })

  it("merges forward nodes into a single message by default", () => {
    const messages = buildOutbound([
      {
        type: "forward",
        nodes: [
          { message: [{ type: "text", text: "节点一" }] },
          { message: [{ type: "text", text: "节点二" }] }
        ]
      }
    ], { scene: "group", markdownEnabled: false })

    expect(messages).toHaveLength(1)
    expect(messages[0].request.content).toBe("节点一\n节点二")
  })

  it("emits one message per forward node in multiple mode", () => {
    const messages = buildOutbound([
      {
        type: "forward",
        nodes: [
          { message: [{ type: "text", text: "节点一" }] },
          { message: [{ type: "text", text: "节点二" }] }
        ]
      }
    ], { scene: "group", markdownEnabled: false, forwardMode: "multiple" })

    expect(messages).toHaveLength(2)
    expect(messages[0].request.content).toBe("节点一")
    expect(messages[1].request.content).toBe("节点二")
  })

  it("attaches the first keyboard to pending text", () => {
    const messages = buildOutbound([
      { type: "text", text: "正文" },
      { type: "keyboard", rows: [[{ label: "运行", action: "input", data: "/run" }]] }
    ], rawContext)

    expect(messages).toEqual([{
      request: {
        msg_type: 2,
        markdown: { content: "正文" },
        keyboard: expect.objectContaining({ content: expect.any(Object) })
      }
    }])
  })

  it("splits keyboard overflow into Markdown carrier messages", () => {
    const rows = Array.from({ length: 6 }, (_, index) => [{
      label: `按钮${index}`,
      action: "input" as const,
      data: `/cmd ${index}`
    }])
    const messages = buildOutbound([{ type: "keyboard", rows }], rawContext)

    expect(messages).toHaveLength(2)
    expect(messages.every(message => message.request.markdown?.content === " ")).toBe(true)
    expect(messages.map(message => message.request.keyboard?.content?.rows.length)).toEqual([5, 1])
  })

  it("keeps text on the first keyboard while splitting overflow", () => {
    const rows = Array.from({ length: 6 }, (_, index) => [{
      label: `按钮${index}`,
      action: "input" as const,
      data: `/cmd ${index}`
    }])
    const messages = buildOutbound([{ type: "text", text: "正文" }, { type: "keyboard", rows }], rawContext)

    expect(messages).toHaveLength(2)
    expect(messages[0].request.markdown?.content).toBe("正文")
    expect(messages.map(message => message.request.keyboard?.content?.rows.length)).toEqual([5, 1])
  })

  it("uses bot_appid for a template keyboard", () => {
    const messages = buildOutbound([{ type: "keyboard", rows: [[{
      label: "模板按钮",
      action: "input",
      data: "/test"
    }]] }], {
      ...rawContext,
      keyboardTemplateId: "template-id",
      appId: "app-id"
    })

    expect(messages[0].request.keyboard).toEqual({ id: "template-id", bot_appid: "app-id" })
  })

  it("builds configured template payloads for core Markdown", () => {
    const messages = buildOutbound([{ type: "markdown", content: "第一行\n第二行" }], {
      scene: "group",
      markdownEnabled: true,
      markdownMode: "template",
      markdownTemplateId: "template-id",
      markdownTemplateKeys: "ab"
    })

    expect(messages).toEqual([{
      request: {
        msg_type: 2,
        markdown: {
          custom_template_id: "template-id",
          params: [{ key: "a", values: ["第一行\r"] }, { key: "b", values: ["第二行"] }]
        }
      }
    }])
  })

  it("downgrades a guild raw file_info image to text", () => {
    const warnings: string[] = []
    const messages = buildOutbound([{
      type: "raw",
      platform: "qqbot",
      platformType: "media",
      data: { file_info: "known-image" }
    }], { scene: "guild", markdownEnabled: false, warn: message => warnings.push(message) })

    expect(messages).toEqual([{ request: { content: "[图片 known-image]" } }])
    expect(warnings).toHaveLength(1)
  })

  it("uses inline command tags only in inline Markdown mode", () => {
    const segments = [{ type: "keyboard" as const, rows: [[{ label: "运行", action: "input" as const, data: "/run" }]] }]

    expect(buildOutbound(segments, { scene: "group", markdownEnabled: true, markdownMode: "inline" }))
      .toEqual([{ request: { msg_type: 2, markdown: { content: "\n<qqbot-cmd-input text=\"/run\" show=\"[运行]\" />" } } }])
  })

  it("downgrades Markdown and keyboards when the Markdown switch is off", () => {
    const warnings: string[] = []
    const messages = buildOutbound([
      { type: "markdown", content: "**markdown**" },
      { type: "keyboard", rows: [[{ label: "运行", action: "input", data: "/run" }]] }
    ], { scene: "group", markdownEnabled: false, warn: message => warnings.push(message) })

    expect(messages).toEqual([{ request: { content: "**markdown**\n[运行] /run" } }])
    expect(warnings).toHaveLength(2)
  })
})
