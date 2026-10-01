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
