import { describe, expect, it } from "vitest"
import type { Logger } from "@yunzai-ng/types"
import { ImageResolver } from "./image-to-url.js"
import type { ImageToUrlFn } from "./image-to-url.js"
import { isPublicHttpUrl } from "../shared/public-url.js"
import type { ResolvedMedia } from "./resolve.js"

/** 收集告警，验证降级原因是可观测的 */
function createLogger(warnings: string[]): Logger {
  return {
    debug() {},
    info() {},
    warn(message: string) { warnings.push(message) },
    error() {}
  } as unknown as Logger
}

/** 一份固定的图片字节 */
const media: ResolvedMedia = { buffer: Buffer.from("img"), fileName: "a.png", mime: "image/png" }

/** 用固定字节的 resolve，省去真实下载 */
const resolve = async (): Promise<ResolvedMedia> => media

/** 框架图床通道可用时的公网基址 */
const PUBLIC_BASE = "https://bot.test"

describe("ImageResolver", () => {
  it("returns an already-public http(s) url without uploading", async () => {
    let officialCalls = 0
    let resolves = 0
    const resolver = new ImageResolver({
      resolve: async () => {
        resolves++
        return media
      },
      official: async () => {
        officialCalls++
        return "qqbot-media://image/v1/x"
      },
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect(await resolver.toUrl({ kind: "url", url: "https://cdn.test/a.png" }))
      .toEqual({ url: "https://cdn.test/a.png", channel: "custom" })
    // 直链直用：既不下载字节，也不占官方配额
    expect(resolves).toBe(0)
    expect(officialCalls).toBe(0)
  })

  it("uploads a private url instead of handing it to QQ", async () => {
    const resolver = new ImageResolver({
      resolve,
      official: async () => "qqbot-media://image/v1/x",
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    // 渲染服务的 127.0.0.1 地址 QQ 拉不到，改走本机下载 + 上传
    expect(await resolver.toUrl({ kind: "url", url: "http://127.0.0.1:8080/render.png" }))
      .toEqual({ url: "qqbot-media://image/v1/x", channel: "official" })
  })

  it("uploads through the official host first and returns its url", async () => {
    const warnings: string[] = []
    const resolver = new ImageResolver({
      resolve,
      official: async () => "qqbot-media://image/v1/x",
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger(warnings)
    })

    expect(await resolver.toUrl({ kind: "path", path: "/tmp/a.png" }))
      .toEqual({ url: "qqbot-media://image/v1/x", channel: "official" })
    expect(warnings).toEqual([])
  })

  it("falls back to the framework host when the official one gives nothing", async () => {
    const warnings: string[] = []
    const resolver = new ImageResolver({
      resolve,
      official: async () => null,
      frameworkBase: () => PUBLIC_BASE,
      publish: () => "f1.png",
      logger: createLogger(warnings)
    })

    expect(await resolver.toUrlFromMedia(media)).toEqual({
      url: `${PUBLIC_BASE}/plugin/adapter-qqbot/file/f1.png`,
      channel: "framework"
    })
    expect(warnings.some(message => message.includes("官方图床未返回可用地址"))).toBe(true)
  })

  it("treats an official host exception as a fallback trigger", async () => {
    const warnings: string[] = []
    const resolver = new ImageResolver({
      resolve,
      official: async () => {
        throw new Error("boom")
      },
      frameworkBase: () => PUBLIC_BASE,
      publish: () => "f2.png",
      logger: createLogger(warnings)
    })

    expect((await resolver.toUrlFromMedia(media))?.channel).toBe("framework")
    expect(warnings.some(message => message.includes("官方图床上传异常"))).toBe(true)
  })

  it("refuses framework bases that QQ cannot reach", async () => {
    const warnings: string[] = []
    const resolver = new ImageResolver({
      resolve,
      frameworkBase: () => "http://192.168.1.2:2536",
      publish: () => "f3.png",
      logger: createLogger(warnings)
    })

    expect(await resolver.toUrlFromMedia(media)).toBeNull()
    expect(warnings.some(message => message.includes("不是公网可达地址"))).toBe(true)
  })

  it("returns null when no channel is configured", async () => {
    const warnings: string[] = []
    const resolver = new ImageResolver({ resolve, logger: createLogger(warnings) })

    expect(await resolver.toUrlFromMedia(media)).toBeNull()
    expect(warnings.some(message => message.includes("框架图床不可用"))).toBe(true)
  })
})

describe("ImageResolver 的自定义图床（插件实现 imageToUrl）", () => {
  /** 官方通道的替身，记录被调用次数 */
  function officialSpy(url = "qqbot-media://image/v1/official") {
    const spy = { calls: 0, url }
    return {
      spy,
      attempt: async () => {
        spy.calls++
        return spy.url
      }
    }
  }

  it("takes the plugin's url first and never downloads or uploads", async () => {
    const { spy, attempt } = officialSpy()
    let resolves = 0
    const resolver = new ImageResolver({
      resolve: async () => {
        resolves++
        return media
      },
      custom: () => async () => "https://my-cdn.test/up.png",
      official: attempt,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect(await resolver.toUrl({ kind: "url", url: "https://example.com/a.png" }))
      .toEqual({ url: "https://my-cdn.test/up.png", channel: "custom" })
    expect(resolves).toBe(0)
    expect(spy.calls).toBe(0)
  })

  it("hands the plugin the original link so it can just return it", async () => {
    // 与常见图床脚本的写法一致：字符串且以 http 开头就原样交回
    const seen: unknown[] = []
    const resolver = new ImageResolver({
      resolve,
      custom: () => async file => {
        seen.push(file)
        return typeof file === "string" && file.startsWith("http") ? file : undefined
      },
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect(await resolver.toUrl({ kind: "url", url: "https://mine.test/b.png" }))
      .toEqual({ url: "https://mine.test/b.png", channel: "custom" })
    expect(seen).toEqual(["https://mine.test/b.png"])
  })

  it("hands the plugin raw bytes when the image is local", async () => {
    const seen: unknown[] = []
    const resolver = new ImageResolver({
      resolve,
      custom: () => async (file, opts) => {
        seen.push(file, opts)
        return "https://my-cdn.test/local.png"
      },
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect((await resolver.toUrlFromMedia(media))?.channel).toBe("custom")
    expect(Buffer.isBuffer(seen[0])).toBe(true)
    expect(seen[1]).toEqual({ filename: "a.png", mime: "image/png" })
  })

  it("falls through to the official host when the plugin declines", async () => {
    const warnings: string[] = []
    const { spy, attempt } = officialSpy()
    const resolver = new ImageResolver({
      resolve,
      custom: () => async () => undefined,
      official: attempt,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger(warnings)
    })

    expect((await resolver.toUrl({ kind: "path", path: "/tmp/a.png" }))?.channel).toBe("official")
    expect(spy.calls).toBe(1)
    expect(warnings.some(message => message.includes("自定义图床未返回可用地址"))).toBe(true)
  })

  it("treats a plugin exception as a fallback trigger", async () => {
    const warnings: string[] = []
    const { attempt } = officialSpy()
    const resolver = new ImageResolver({
      resolve,
      custom: () => async () => {
        throw new Error("oss 401")
      },
      official: attempt,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger(warnings)
    })

    expect((await resolver.toUrl({ kind: "path", path: "/tmp/a.png" }))?.channel).toBe("official")
    expect(warnings.some(message => message.includes("自定义图床处理失败"))).toBe(true)
    expect(warnings.some(message => message.includes("oss 401"))).toBe(true)
  })

  it("rejects addresses QQ cannot render, such as bare relative paths", async () => {
    const warnings: string[] = []
    const { attempt } = officialSpy()
    const resolver = new ImageResolver({
      resolve,
      custom: () => async () => "/upload/a.png",
      official: attempt,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger(warnings)
    })

    expect((await resolver.toUrlFromMedia(media))?.channel).toBe("official")
    expect(warnings.some(message => message.includes("自定义图床未返回可用地址"))).toBe(true)
  })

  it("accepts an official media reference returned by the plugin", async () => {
    const resolver = new ImageResolver({
      resolve,
      custom: () => async () => "qqbot-media://image/v1/mine",
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect(await resolver.toUrlFromMedia(media))
      .toEqual({ url: "qqbot-media://image/v1/mine", channel: "custom" })
  })

  it("still reuses a public link when no plugin provides imageToUrl", async () => {
    const resolver = new ImageResolver({
      resolve,
      custom: () => undefined,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect(await resolver.toUrl({ kind: "url", url: "https://cdn.test/a.png" }))
      .toEqual({ url: "https://cdn.test/a.png", channel: "custom" })
  })

  it("looks the plugin up on every call, so a late load takes effect", async () => {
    const holder: { fn: ImageToUrlFn | undefined } = { fn: undefined }
    const resolver = new ImageResolver({
      resolve,
      custom: () => holder.fn,
      frameworkBase: () => PUBLIC_BASE,
      logger: createLogger([])
    })

    expect((await resolver.toUrlFromMedia(media))?.channel).toBe("framework")
    holder.fn = () => "https://my-cdn.test/late.png"
    expect(await resolver.toUrlFromMedia(media))
      .toEqual({ url: "https://my-cdn.test/late.png", channel: "custom" })
  })
})

describe("isPublicHttpUrl", () => {
  it.each([
    ["https://example.com/cover.jpg", true],
    ["http://1.2.3.4:2536", true],
    ["https://abc.trycloudflare.com", true],
    ["http://172.32.0.1", true],
    ["http://127.0.0.1:2536", false],
    ["http://localhost:2536", false],
    ["http://[::1]:2536", false],
    ["http://192.168.1.2:2536", false],
    ["http://10.0.0.5", false],
    ["http://172.20.1.1", false],
    ["http://169.254.1.1", false],
    ["http://100.64.0.1", false],
    ["http://[fd00::1]", false],
    ["http://myserver:2536", false],
    ["http://nas.local", false],
    ["ftp://example.com", false],
    ["", false]
  ])("%s → %s", (value, expected) => {
    expect(isPublicHttpUrl(value)).toBe(expected)
  })
})
