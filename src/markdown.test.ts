import { describe, expect, it } from "vitest"
import { buildKeyboard, buildKeyboardButton, buildTemplateMarkdown, escapeMarkdown, keyboardAsInlineText, markdownImage, splitKeyboards } from "./markdown.js"

describe("QQ Markdown helpers", () => {
  it("escapes reserved sequences and transforms template newlines", () => {
    expect(escapeMarkdown("@user <qqbot-at-user />")).toBe("@​user <qqbot-​at-user />")
    expect(escapeMarkdown("a\nb", true)).toBe("a\rb")
    expect(buildTemplateMarkdown("@user\r", "template", "a")).toEqual([{
      custom_template_id: "template",
      params: [{ key: "a", values: ["@user\r"] }]
    }])
  })

  it("generates image Markdown with dimensions", () => {
    expect(markdownImage("https://example.test/a.png", "示例", 12, 34))
      .toBe("![示例 #12px #34px](https://example.test/a.png)")
  })

  it("maps core buttons onto official action types", () => {
    const link = buildKeyboardButton({ label: "官网", action: "link", data: "https://example.test" }, 0)
    const callback = buildKeyboardButton({
      label: "确认",
      visitedLabel: "已确认",
      action: "callback",
      data: "confirm"
    }, 1)
    const input = buildKeyboardButton({ label: "运行", action: "input", data: "/run", enter: true }, 2)

    expect(link.action.type).toBe(0)
    expect(callback.action.type).toBe(1)
    expect(input.action.type).toBe(2)
    expect(link.action.data).toBe("https://example.test")
    expect(callback.render_data.visited_label).toBe("已确认")
    expect(link.render_data.style).toBe(0)
    expect(callback.render_data.style).toBe(0)
    expect(input.render_data.style).toBe(0)
    expect(callback.action.permission).toEqual({ type: 2 })
    expect(callback.id).toBe("btn_1")
    expect(input.action.enter).toBe(true)
    expect(link.action.enter).toBeUndefined()
    expect(callback.action.enter).toBeUndefined()
  })

  it("limits every keyboard row to five buttons and splits overflow messages", () => {
    const rows = [[0, 1, 2, 3, 4, 5].map(index => ({
      label: `按钮${index}`,
      action: "input" as const,
      data: `/cmd ${index}`
    }))]
    const keyboard = buildKeyboard(rows)
    expect(keyboard?.content?.rows.map(row => row.buttons)).toHaveLength(2)
    expect(keyboard?.content?.rows.map(row => row.buttons.length)).toEqual([5, 1])
    expect(splitKeyboards(rows, 1)).toHaveLength(2)
  })

  it("escapes inline command attributes", () => {
    expect(keyboardAsInlineText([[{
      label: "<运行> & \"确认\"",
      action: "input",
      data: "/run --name=\"a&b\""
    }]])).toBe("\n<qqbot-cmd-input text=\"/run --name=&quot;a&amp;b&quot;\" show=\"[&lt;运行> &amp; &quot;确认&quot;]\" />")
  })
})
