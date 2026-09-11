import { describe, expect, it } from "vitest"
import { decodeMessage } from "./codec.js"

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
})
