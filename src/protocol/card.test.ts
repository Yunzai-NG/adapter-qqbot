import { describe, expect, it } from "vitest"
import type { ShareSegment } from "@yunzai-ng/types"
import { CARD_DESCRIPTION_MAX, CARD_TITLE_MAX, buildTuwenCard } from "./card.js"

/** 一份四要素齐全的分享段 */
const full: ShareSegment = {
  type: "share",
  url: "https://news.qq.com/rain/a/20261014A05XYZ00",
  title: "iPhone 17 Pro 正式发布",
  content: "全新 A20 芯片 / 钛金属机身",
  image: "https://inews.gtimg.com/newsapp_bt/0/xxx/1000.jpg"
}

describe("buildTuwenCard", () => {
  it("maps a complete share segment to a tuwen card", () => {
    const built = buildTuwenCard(full)

    expect(built).toEqual({
      ok: true,
      card: {
        type: "tuwen",
        content: {
          title: "iPhone 17 Pro 正式发布",
          description: "全新 A20 芯片 / 钛金属机身",
          url: "https://news.qq.com/rain/a/20261014A05XYZ00",
          pic_url: "https://inews.gtimg.com/newsapp_bt/0/xxx/1000.jpg"
        }
      }
    })
  })

  it("truncates oversized title and description within platform limits", () => {
    const built = buildTuwenCard({
      ...full,
      title: "标".repeat(CARD_TITLE_MAX + 20),
      content: "描".repeat(CARD_DESCRIPTION_MAX + 20)
    })

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(Array.from(built.card.content.title)).toHaveLength(CARD_TITLE_MAX)
    expect(Array.from(built.card.content.description)).toHaveLength(CARD_DESCRIPTION_MAX)
    expect(built.card.content.title.endsWith("…")).toBe(true)
    expect(built.card.content.description.endsWith("…")).toBe(true)
  })

  it("never splits a surrogate pair when truncating", () => {
    const built = buildTuwenCard({ ...full, title: "🎉".repeat(CARD_TITLE_MAX + 5) })

    expect(built.ok).toBe(true)
    if (!built.ok) return
    const chars = Array.from(built.card.content.title)
    expect(chars).toHaveLength(CARD_TITLE_MAX)
    expect(chars.slice(0, -1).every(char => char === "🎉")).toBe(true)
    expect(chars.at(-1)).toBe("…")
  })

  it("falls back to the url for an empty title and to the title for an empty description", () => {
    const built = buildTuwenCard({ ...full, title: "  ", content: undefined })

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.card.content.title).toBe(full.url)
    expect(built.card.content.description).toBe(full.url)
  })

  it("rejects cards without an https cover image", () => {
    expect(buildTuwenCard({ ...full, image: undefined }))
      .toEqual({ ok: false, reason: "图文卡片需要封面图，分享段缺少 image" })
    expect(buildTuwenCard({ ...full, image: "http://example.test/a.jpg" }))
      .toEqual({ ok: false, reason: "封面图必须是 https 地址（当前：http://example.test/a.jpg）" })
  })

  it("rejects non-https and oversized links", () => {
    expect(buildTuwenCard({ ...full, url: "http://example.test/a" }).ok).toBe(false)
    expect(buildTuwenCard({ ...full, url: "" }).ok).toBe(false)
    expect(buildTuwenCard({ ...full, url: `https://example.test/${"a".repeat(1100)}` }))
      .toEqual({ ok: false, reason: "分享链接超过 1024 字符" })
  })

  it("rejects image references that are not plain https urls", () => {
    expect(buildTuwenCard({ ...full, image: "qqbot-media://image/v1/token" }).ok).toBe(false)
    expect(buildTuwenCard({ ...full, image: "https://example.test/a b.jpg" }).ok).toBe(false)
  })
})
