import { describe, expect, it } from "vitest"
import { atUser, channelTag, commandTag, parseCommand, tagAttributes } from "./interaction.js"

describe("text interaction tags", () => {
  it("escapes @ user ids so they cannot break the tag", () => {
    expect(atUser('a"/><x')).toBe('<qqbot-at-user id="a&quot;/&gt;&lt;x" />')
  })

  it("URL-encodes command attributes and only emits optional ones when set", () => {
    expect(commandTag({ type: "cmd-enter", text: "/签到 今天" })).toBe(`<qqbot-cmd-enter text="${encodeURIComponent("/签到 今天")}" />`)
    expect(commandTag({ type: "cmd-input", text: "/查", show: "查询", reference: true }))
      .toBe(`<qqbot-cmd-input text="%2F%E6%9F%A5" show="%E6%9F%A5%E8%AF%A2" reference="true" />`)
    expect(commandTag({ type: "cmd-input", text: "/a" })).toBe('<qqbot-cmd-input text="%2Fa" />')
  })

  it("enforces the 100-character limit before encoding", () => {
    expect(() => commandTag({ type: "cmd-enter", text: "中".repeat(100) })).not.toThrow()
    expect(() => commandTag({ type: "cmd-enter", text: "中".repeat(101) })).toThrow()
    expect(() => commandTag({ type: "cmd-input", text: "/a", show: "x".repeat(101) })).toThrow()
    expect(() => commandTag({ type: "cmd-enter", text: "" })).toThrow()
  })

  it("accepts only numeric channel ids", () => {
    expect(channelTag("123")).toBe("<#123>")
    expect(() => channelTag("12><@1")).toThrow()
  })

  it("round-trips commands and rejects malformed tags", () => {
    const tag = commandTag({ type: "cmd-input", text: "/run a&b", show: "运行", reference: false })
    expect(parseCommand(tag)).toEqual({ type: "cmd-input", text: "/run a&b", show: "运行", reference: false })
    expect(parseCommand('<qqbot-cmd-enter text="%E0%A4%A" />')).toBeUndefined()
    expect(parseCommand('<qqbot-cmd-input text="a" reference="yes" />')).toBeUndefined()
    expect(tagAttributes('<qqbot-at-user id="1" id="2" />')).toBeUndefined()
    expect(tagAttributes('<qqbot-at-user id="1" junk />')).toBeUndefined()
  })
})
