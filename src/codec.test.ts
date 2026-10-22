import { describe, expect, it } from "vitest"
import { decodeMessage, sceneExtValue } from "./codec.js"

describe("sceneExtValue", () => {
  it("extracts a key=value entry from message_scene.ext", () => {
    expect(sceneExtValue(["msg_idx=A", "ref_msg_idx=B", "auth_token=C"], "ref_msg_idx")).toBe("B")
  })

  it("splits only on the first `=` so base64-ish indices survive intact", () => {
    expect(sceneExtValue(["ref_msg_idx=REFIDX_a+b/c=="], "ref_msg_idx")).toBe("REFIDX_a+b/c==")
  })

  it("returns undefined for a missing key or absent ext", () => {
    expect(sceneExtValue(["msg_idx=A"], "ref_msg_idx")).toBeUndefined()
    expect(sceneExtValue(undefined, "ref_msg_idx")).toBeUndefined()
    expect(sceneExtValue([], "ref_msg_idx")).toBeUndefined()
  })
})

describe("decodeMessage", () => {
  it("preserves QQ tokens and classifies every attachment kind", () => {
    const message = decodeMessage(
      "hello <@everyone> <@!42> <emoji:123>",
      [
        { content_type: "image/png", filename: "a.png", url: "https://example.test/a.png", width: 10, height: 20 },
        { content_type: "audio/ogg", filename: "a.ogg", url: "https://example.test/a.ogg" },
        { content_type: "video/mp4", filename: "a.mp4", url: "https://example.test/a.mp4" },
        { content_type: "application/pdf", filename: "a.pdf", url: "https://example.test/a.pdf", size: 100 }
      ]
    )

    expect(message).toMatchObject([
      { type: "text", text: "hello " },
      { type: "atAll" },
      { type: "text", text: " " },
      { type: "at", uid: "42" },
      { type: "text", text: " " },
      { type: "face", id: 123 },
      { type: "image", width: 10, height: 20 },
      { type: "record" },
      { type: "video" },
      { type: "file", name: "a.pdf", size: 100 }
    ])
  })

  it("prefixes guild mention IDs without altering ordinary text", () => {
    expect(decodeMessage("<@99> text", undefined, true)).toEqual([
      { type: "at", uid: "qg_99" },
      { type: "text", text: " text" }
    ])
  })

  it("splits openid mentions out of the text so prefix commands still match", () => {
    // 实测报文：群聊 @机器人 下发 `<@大写openid>`（不带斜杠），旧正则只认 \d+ 导致整段留在正文
    expect(decodeMessage("<@5519A1A02E6BBE79C222FA4611115C66> #消息测试")).toEqual([
      { type: "at", uid: "5519A1A02E6BBE79C222FA4611115C66" },
      { type: "text", text: " #消息测试" }
    ])

    // 客户端展示的斜杠写法同样兼容
    expect(decodeMessage("<@//5519a1a02e6bbe79c222fa4611115c66/> #消息测试")).toEqual([
      { type: "at", uid: "5519a1a02e6bbe79c222fa4611115c66" },
      { type: "text", text: " #消息测试" }
    ])

    expect(decodeMessage("<@!//5519a1a02e6bbe79c222fa4611115c66/>hi")).toEqual([
      { type: "at", uid: "5519a1a02e6bbe79c222fa4611115c66" },
      { type: "text", text: "hi" }
    ])

    // 单斜杠写法同样识别，正文里不该残留 `<@`
    expect(decodeMessage("<@/abc123/> #ping")).toEqual([
      { type: "at", uid: "abc123" },
      { type: "text", text: " #ping" }
    ])
  })

  it("keeps an emoji token working next to an openid mention", () => {
    expect(decodeMessage("<@5519A1A02E6BBE79C222FA4611115C66> hi <emoji:66>")).toEqual([
      { type: "at", uid: "5519A1A02E6BBE79C222FA4611115C66" },
      { type: "text", text: " hi " },
      { type: "face", id: 66 }
    ])
  })

  it("handles image-only messages where the platform omits content", () => {
    expect(decodeMessage(undefined, [
      { content_type: "image/png", filename: "a.png", url: "https://example.test/a.png", width: 774, height: 476 }
    ])).toEqual([
      { type: "image", file: { kind: "url", url: "https://example.test/a.png" }, summary: "a.png", width: 774, height: 476 }
    ])
  })

  it("handles text + image messages, keeping text before the attachment", () => {
    expect(decodeMessage("看这个", [
      { content_type: "image/png", filename: "a.png", url: "https://example.test/a.png" }
    ])).toEqual([
      { type: "text", text: "看这个" },
      { type: "image", file: { kind: "url", url: "https://example.test/a.png" }, summary: "a.png", width: undefined, height: undefined }
    ])
  })

  it("returns an empty segment list when both content and attachments are absent", () => {
    expect(decodeMessage(undefined)).toEqual([])
  })

  it("adds the https scheme to guild attachment URLs that omit it", () => {
    expect(decodeMessage(undefined, [
      { content_type: "image/png", filename: "a.png", url: "gchat.qpic.cn/qmeetpic/1/2.png" }
    ])).toMatchObject([
      { type: "image", file: { kind: "url", url: "https://gchat.qpic.cn/qmeetpic/1/2.png" } }
    ])
  })

  it("leaves already-absolute attachment URLs untouched", () => {
    expect(decodeMessage(undefined, [
      { content_type: "image/png", filename: "a.png", url: "http://example.test/a.png" }
    ])).toMatchObject([
      { type: "image", file: { kind: "url", url: "http://example.test/a.png" } }
    ])
  })

  it("classifies QQ's bare `voice` content type as a record, not a file", () => {
    expect(decodeMessage(undefined, [
      { content_type: "voice", filename: "v.amr", url: "https://e.test/v.amr", size: 2469 }
    ])).toEqual([
      { type: "record", file: { kind: "url", url: "https://e.test/v.amr" } }
    ])
  })

  it("classifies video attachments as video segments", () => {
    expect(decodeMessage(undefined, [
      { content_type: "video/mp4", filename: "v.mp4", url: "https://e.test/v.mp4", size: 3905543 }
    ])).toEqual([
      { type: "video", file: { kind: "url", url: "https://e.test/v.mp4" } }
    ])
  })
})

describe("decodeMessage 自身提及归一化", () => {
  const OPENID = "5519A1A02E6BBE79C222FA4611115C66"
  const SELF = "2854196810"

  it("把 mentions 里 is_you 的 @ 换成 selfId，核心的 atMe 才能成立", () => {
    // 实测报文：content 用 openid，mentions 里 is_you=true，selfId 是真实 QQ 号。
    // 不归一化时 at.uid 与 selfId 永不相等，群聊 e.atMe 恒为 false
    expect(decodeMessage(`<@${OPENID}> #消息测试`, undefined, false, {
      selfId: SELF,
      selfMentions: [OPENID]
    })).toEqual([
      { type: "at", uid: SELF },
      { type: "text", text: " #消息测试" }
    ])
  })

  it("斜杠写法的自身提及同样归一化", () => {
    expect(decodeMessage(`<@//${OPENID}/> #ping`, undefined, false, {
      selfId: SELF,
      selfMentions: [OPENID]
    })).toEqual([
      { type: "at", uid: SELF },
      { type: "text", text: " #ping" }
    ])
  })

  it("别人的提及保持平台原始 id，不与 selfId 混用", () => {
    const other = "FF23DED2F67B06F46C7A23AE9BB7C5AE"
    expect(decodeMessage(`<@${OPENID}> <@${other}> hi`, undefined, false, {
      selfId: SELF,
      selfMentions: [OPENID]
    })).toEqual([
      { type: "at", uid: SELF },
      { type: "text", text: " " },
      { type: "at", uid: other },
      { type: "text", text: " hi" }
    ])
  })

  it("频道场景下自身提及不加 qg_ 前缀，否则与 selfId 不等", () => {
    expect(decodeMessage(`<@${OPENID}> hi`, undefined, true, {
      selfId: SELF,
      selfMentions: [OPENID]
    })).toEqual([
      { type: "at", uid: SELF },
      { type: "text", text: " hi" }
    ])
  })

  it("未提供 selfId 时退回原始行为，不影响只做解析的调用方", () => {
    expect(decodeMessage(`<@${OPENID}> hi`)).toEqual([
      { type: "at", uid: OPENID },
      { type: "text", text: " hi" }
    ])
  })

  it("selfMentions 为空时不做任何替换", () => {
    expect(decodeMessage(`<@${OPENID}> hi`, undefined, false, { selfId: SELF })).toEqual([
      { type: "at", uid: OPENID },
      { type: "text", text: " hi" }
    ])
  })
})
