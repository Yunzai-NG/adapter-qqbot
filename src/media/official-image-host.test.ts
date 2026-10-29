import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { QQBotApiError } from "../transport/api.js"
import { DEFAULT_SAVE_SECONDS, MAX_SAVE_SECONDS, normalizeSaveSeconds, OfficialImageHost, sweepIntervalMs } from "./official-image-host.js"

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex")
}

describe("OfficialImageHost", () => {
  it("uploads through prepare, PUT and complete, then reuses the cached reference", async () => {
    const calls: string[] = []
    const api = {
      prepareImageUpload: async (request: { file_name: string; content_type: string; md5: string; sha1: string }) => {
        calls.push(`prepare:${request.file_name}:${request.content_type}`)
        expect(request.md5).toBe(md5(Buffer.from("png-bytes")))
        expect(request.sha1).toHaveLength(40)
        return { upload_id: "upload-id", presigned_url: "https://upload.test/img", expires_in: 3600 }
      },
      completeImageUpload: async (request: { upload_id: string; md5: string }) => {
        calls.push(`complete:${request.upload_id}:${request.md5}`)
        return { image_id: "image-id", url: "qqbot-media://image/v1/token", ttl: 7_776_000 }
      }
    }
    const http = {
      request: async (url: string, options: { body?: Uint8Array }) => {
        calls.push(`put:${url}:${Buffer.from(options.body ?? []).toString()}`)
        return { data: undefined, headers: {}, status: 200 }
      }
    } as unknown as HttpClient

    const host = new OfficialImageHost(api as never, http, logger, 14400)
    const buffer = Buffer.from("png-bytes")

    expect(await host.upload(buffer, { filename: "chart.png", mime: "image/png" }))
      .toBe("qqbot-media://image/v1/token")
    // 第二次同样的图片命中本地缓存，不再上传
    expect(await host.upload(buffer, { filename: "chart.png", mime: "image/png" }))
      .toBe("qqbot-media://image/v1/token")

    expect(calls).toEqual([
      "prepare:chart.png:image/png",
      "put:https://upload.test/img:png-bytes",
      `complete:upload-id:${md5(buffer)}`
    ])
  })

  it("rewrites a mismatched extension so it matches the content type", async () => {
    let fileName = ""
    const api = {
      prepareImageUpload: async (request: { file_name: string }) => {
        fileName = request.file_name
        return { upload_id: "id", presigned_url: "https://upload.test/x", expires_in: 60 }
      },
      completeImageUpload: async () => ({ image_id: "id", url: "qqbot-media://image/v1/t", ttl: 1 })
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger)

    await host.upload(Buffer.from("jpg-bytes"), { filename: "render.bmp", mime: "image/jpg" })

    expect(fileName.startsWith("image-")).toBe(true)
    expect(fileName.endsWith(".jpg")).toBe(true)
  })

  it("rejects unsupported formats and upload failures without throwing", async () => {
    const api = {
      prepareImageUpload: async () => {
        throw new Error("boom")
      },
      completeImageUpload: async () => ({ image_id: "id", url: "", ttl: 1 })
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger)

    expect(await host.upload(Buffer.from("bmp"), { filename: "a.bmp", mime: "image/bmp" })).toBeNull()
    expect(await host.upload(Buffer.from("png"), { filename: "a.png", mime: "image/png" })).toBeNull()
  })

  it("clears materials older than the save time on 40035007, then retries once", async () => {
    const now = Math.floor(Date.now() / 1000)
    const deleted: string[] = []
    const pages: string[] = []
    let prepares = 0

    const api = {
      prepareImageUpload: async () => {
        prepares++
        if (prepares === 1) throw new QQBotApiError("图片数量超过上限", 40035007)
        return { upload_id: "u1", presigned_url: "https://upload.test/img", expires_in: 60 }
      },
      completeImageUpload: async () => ({
        image_id: "new",
        url: "qqbot-media://image/v1/new",
        ttl: 7_776_000
      }),
      listMediaImages: async (cursor?: string) => {
        pages.push(cursor ?? "first")
        if (!cursor) {
          return {
            images: [
              { image_id: "old-1", url: "qqbot-media://image/v1/a", file_name: "a.png", created_at: now - 7200, expires_at: now + 100 }
            ],
            next_cursor: "page-2",
            total: 3
          }
        }
        return {
          images: [
            { image_id: "old-2", url: "qqbot-media://image/v1/b", file_name: "b.png", created_at: now - 5400, expires_at: now + 100 },
            { image_id: "fresh", url: "qqbot-media://image/v1/c", file_name: "c.png", created_at: now - 60, expires_at: now + 100 }
          ],
          next_cursor: "",
          total: 3
        }
      },
      deleteMediaImage: async (imageId: string) => {
        deleted.push(imageId)
      }
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    // 保存时间 1 小时：两张超期、一张仍在保留期内
    const host = new OfficialImageHost(api as never, http, logger, 3600)

    expect(await host.upload(Buffer.from("png"), { filename: "x.png", mime: "image/png" }))
      .toBe("qqbot-media://image/v1/new")
    expect(prepares).toBe(2)
    expect(pages).toEqual(["first", "page-2"])
    expect(deleted).toEqual(["old-1", "old-2"])
  })

  it("gives up when every material is still inside the save window", async () => {
    const now = Math.floor(Date.now() / 1000)
    const deleted: string[] = []
    let prepares = 0

    const api = {
      prepareImageUpload: async () => {
        prepares++
        throw new QQBotApiError("图片数量超过上限", 40035007)
      },
      completeImageUpload: async () => ({ image_id: "id", url: "", ttl: 1 }),
      listMediaImages: async () => ({
        images: [
          { image_id: "fresh", url: "qqbot-media://image/v1/c", file_name: "c.png", created_at: now - 60, expires_at: now + 100 }
        ],
        next_cursor: "",
        total: 1
      }),
      deleteMediaImage: async (imageId: string) => {
        deleted.push(imageId)
      }
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger, 3600)

    expect(await host.upload(Buffer.from("png"), { filename: "x.png", mime: "image/png" })).toBeNull()
    expect(prepares).toBe(1)
    expect(deleted).toEqual([])
  })

  it("treats an already deleted material as freed and keeps cleaning", async () => {
    const now = Math.floor(Date.now() / 1000)
    const deleted: string[] = []
    let prepares = 0

    const api = {
      prepareImageUpload: async () => {
        prepares++
        if (prepares === 1) throw new QQBotApiError("图片数量超过上限", 40035007)
        return { upload_id: "u1", presigned_url: "https://upload.test/img", expires_in: 60 }
      },
      completeImageUpload: async () => ({ image_id: "new", url: "qqbot-media://image/v1/new", ttl: 1 }),
      listMediaImages: async () => ({
        images: [
          { image_id: "gone", url: "qqbot-media://image/v1/gone", file_name: "g.png", created_at: now - 9000, expires_at: now + 100 },
          { image_id: "old", url: "qqbot-media://image/v1/old", file_name: "o.png", created_at: now - 8000, expires_at: now + 100 }
        ],
        next_cursor: "",
        total: 2
      }),
      deleteMediaImage: async (imageId: string) => {
        if (imageId === "gone") throw new QQBotApiError("图片不存在", 40035008)
        deleted.push(imageId)
      }
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger, 3600)

    expect(await host.upload(Buffer.from("png"), { filename: "x.png", mime: "image/png" }))
      .toBe("qqbot-media://image/v1/new")
    expect(deleted).toEqual(["old"])
  })

  it("sweeps expired materials without waiting for a quota error", async () => {
    const now = Math.floor(Date.now() / 1000)
    const deleted: string[] = []
    const api = {
      prepareImageUpload: async () => {
        throw new Error("sweep 不应触发上传")
      },
      completeImageUpload: async () => ({ image_id: "id", url: "", ttl: 1 }),
      listMediaImages: async () => ({
        images: [
          { image_id: "old", url: "qqbot-media://image/v1/old", file_name: "o.png", created_at: now - 7200, expires_at: now + 100 },
          { image_id: "fresh", url: "qqbot-media://image/v1/fresh", file_name: "f.png", created_at: now - 60, expires_at: now + 100 }
        ],
        next_cursor: "",
        total: 2
      }),
      deleteMediaImage: async (imageId: string) => {
        deleted.push(imageId)
      }
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger, 3600)

    expect(await host.sweep()).toBe(1)
    expect(deleted).toEqual(["old"])
  })

  it("throttles quota release attempts within the cooldown window", async () => {
    const now = Math.floor(Date.now() / 1000)
    let prepares = 0
    let lists = 0
    const api = {
      prepareImageUpload: async () => {
        prepares++
        throw new QQBotApiError("图片数量超过上限", 40035007)
      },
      completeImageUpload: async () => ({ image_id: "id", url: "", ttl: 1 }),
      listMediaImages: async () => {
        lists++
        return {
          images: [
            { image_id: "fresh", url: "qqbot-media://image/v1/f", file_name: "f.png", created_at: now - 60, expires_at: now + 100 }
          ],
          next_cursor: "",
          total: 1
        }
      },
      deleteMediaImage: async () => {}
    }
    const http = { request: async () => ({ data: undefined, headers: {}, status: 200 }) } as unknown as HttpClient
    const host = new OfficialImageHost(api as never, http, logger, 3600)

    // 第一次配额满：查一轮列表，确认无可释放项后放弃
    expect(await host.upload(Buffer.from("first"), { filename: "a.png", mime: "image/png" })).toBeNull()
    expect(lists).toBe(1)

    // 冷却期内再次配额满：不再翻页查询，直接交回调用方降级
    expect(await host.upload(Buffer.from("second"), { filename: "b.png", mime: "image/png" })).toBeNull()
    expect(lists).toBe(1)
    expect(prepares).toBe(2)
  })

  it("schedules the sweep from the save time, bounded to 5min–24h", () => {
    expect(sweepIntervalMs(14_400)).toBe(3_600_000)
    expect(sweepIntervalMs(60)).toBe(300_000)
    expect(sweepIntervalMs(7_776_000)).toBe(24 * 60 * 60 * 1000)
  })

  it("clamps the configured save time into the platform window", () => {
    expect(normalizeSaveSeconds(undefined)).toBe(DEFAULT_SAVE_SECONDS)
    expect(DEFAULT_SAVE_SECONDS).toBe(4 * 60 * 60)
    expect(normalizeSaveSeconds(0)).toBe(DEFAULT_SAVE_SECONDS)
    expect(normalizeSaveSeconds(90.7)).toBe(90)
    expect(normalizeSaveSeconds(9_999_999)).toBe(MAX_SAVE_SECONDS)
  })
})
