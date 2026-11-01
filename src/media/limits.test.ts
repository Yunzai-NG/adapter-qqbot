import { describe, expect, it } from "vitest"
import { resolveImageLimits } from "./limits.js"

const MiB = 1024 * 1024

describe("resolveImageLimits", () => {
  it("只把配置值给频道，其余两条链路用平台默认上限", () => {
    expect(resolveImageLimits(4)).toEqual({
      channel: 4 * MiB,
      group: 20 * MiB,
      mediaHost: 10 * MiB
    })
  })

  it("配置调大也只影响频道，不会收紧群聊与图床", () => {
    expect(resolveImageLimits(30)).toEqual({
      channel: 30 * MiB,
      group: 20 * MiB,
      mediaHost: 10 * MiB
    })
  })

  it("配置 0 视为关闭压缩，三条链路都不整形", () => {
    expect(resolveImageLimits(0)).toEqual({ channel: 0, group: 0, mediaHost: 0 })
  })

  it("接受小数 MiB", () => {
    expect(resolveImageLimits(2.5).channel).toBe(Math.round(2.5 * MiB))
  })
})
