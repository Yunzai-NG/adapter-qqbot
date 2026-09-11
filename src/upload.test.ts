import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { MediaUploader } from "./upload.js"

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

function hash(data: Buffer): string {
  return createHash("md5").update(data).digest("hex")
}

describe("MediaUploader", () => {
  it("uses the official prepare, PUT, finish and commit sequence", async () => {
    const calls: string[] = []
    const finished: Array<{ index: number; size: string; md5: string }> = []
    const api = {
      prepareUpload: async () => {
        calls.push("prepare")
        return {
          upload_id: "upload-id",
          block_size: "3",
          // QQ 返回的 part.index 从 1 开始，末片 block_size 为实际剩余字节数
          parts: [
            { index: 1, presigned_url: "https://upload.test/0", block_size: "3" },
            { index: 2, presigned_url: "https://upload.test/1", block_size: "2" }
          ],
          upload_config: { concurrency: 1, retry_timeout: 1, retry_delay: 0.001 }
        }
      },
      finishUploadPart: async (_target: string, _id: string, request: { part_index: number; block_size: string; md5: string }) => {
        calls.push(`finish:${request.part_index}`)
        finished.push({ index: request.part_index, size: request.block_size, md5: request.md5 })
      },
      commitFile: async () => {
        calls.push("commit")
        return { file_uuid: "uuid", file_info: "info", ttl: 1 }
      }
    }
    const http = {
      request: async (url: string, options: { body?: Uint8Array }) => {
        calls.push(`put:${url}:${Buffer.from(options.body ?? []).toString()}`)
        return { data: undefined, headers: {}, status: 200 }
      }
    } as unknown as HttpClient
    const uploader = new MediaUploader(api as never, http, logger)

    const result = await uploader.uploadByChunks(Buffer.from("abcde"), {
      target: "group",
      targetId: "group-id",
      fileType: 4,
      fileName: "sample.bin"
    })

    expect(result.file_info).toBe("info")
    expect(calls).toEqual([
      "prepare",
      "put:https://upload.test/0:abc",
      "finish:1",
      "put:https://upload.test/1:de",
      "finish:2",
      "commit"
    ])
    expect(finished).toEqual([
      { index: 1, size: "3", md5: hash(Buffer.from("abc")) },
      { index: 2, size: "2", md5: hash(Buffer.from("de")) }
    ])
  })

  it("uploads the whole single-part file instead of an empty slice", async () => {
    const put: string[] = []
    const api = {
      prepareUpload: async () => ({
        upload_id: "upload-id",
        // 单分片时服务器返回的 block_size 等于文件大小，part.index 为 1
        block_size: "5",
        parts: [{ index: 1, presigned_url: "https://upload.test/single", block_size: "5" }],
        upload_config: { concurrency: 1, retry_timeout: 1, retry_delay: 0.001 }
      }),
      finishUploadPart: async () => undefined,
      commitFile: async () => ({ file_uuid: "uuid", file_info: "info", ttl: 1 })
    }
    const http = {
      request: async (url: string, options: { body?: Uint8Array }) => {
        put.push(`${url}:${Buffer.from(options.body ?? []).toString()}`)
        return { data: undefined, headers: {}, status: 200 }
      }
    } as unknown as HttpClient
    const uploader = new MediaUploader(api as never, http, logger)

    await uploader.uploadByChunks(Buffer.from("abcde"), {
      target: "user", targetId: "user-id", fileType: 1, fileName: "a.png"
    })

    expect(put).toEqual(["https://upload.test/single:abcde"])
  })

  it("uses URL transfer and existing file_info without downloading", async () => {
    const commits: unknown[] = []
    const api = { commitFile: async (...args: unknown[]) => {
      commits.push(args)
      return { file_uuid: "uuid", file_info: "info", ttl: 1 }
    } }
    const http = { request: async () => { throw new Error("should not download") } } as unknown as HttpClient
    const uploader = new MediaUploader(api as never, http, logger)
    await expect(uploader.upload({ kind: "id", id: "known-info" }, {
      target: "group", targetId: "group", fileType: 1
    })).resolves.toMatchObject({ file_info: "known-info" })
    await uploader.upload({ kind: "url", url: "https://example.test/a.png" }, {
      target: "group", targetId: "group", fileType: 1
    })
    expect(commits).toHaveLength(1)
  })

  it("falls back from URL transfer to chunks for every rich-media type", async () => {
    for (const [target, fileType] of [["group", 1], ["user", 2], ["group", 3], ["user", 4]] as const) {
      const calls: string[] = []
      const prepared: Array<{ file_type: number; file_name: string }> = []
      const api = {
        commitFile: async (_target: string, _id: string, request: { url?: string; upload_id?: string }) => {
          calls.push(request.url ? "transfer" : "commit")
          if (request.url) throw new Error("QQ cannot fetch source")
          return { file_uuid: "uuid", file_info: "chunk-info", ttl: 1 }
        },
        prepareUpload: async (_target: string, _id: string, request: { file_type: number; file_name: string }) => {
          calls.push("prepare"); prepared.push(request)
          return { upload_id: "upload", block_size: "2", parts: [{ index: 1, presigned_url: "https://upload.test/part", block_size: "2" }] }
        },
        finishUploadPart: async () => { calls.push("finish") }
      }
      const headers = { Referer: "https://origin.test" }
      const http = { request: async (_url: string, options: { method?: string; headers?: unknown }) => {
        if (options.method === "GET") { calls.push("download"); expect(options.headers).toEqual(headers); return { data: Uint8Array.from([1, 2]), headers: {} } }
        calls.push("put"); return { data: undefined, headers: {} }
      } } as unknown as HttpClient
      const fileName = fileType === 4 ? "named.bin" : undefined
      const result = await new MediaUploader(api as never, http, logger).upload({ kind: "url", url: "https://example.test/fallback.mp4", headers }, { target, targetId: "id", fileType, fileName })
      expect(result.file_info).toBe("chunk-info")
      expect(calls).toEqual(["transfer", "download", "prepare", "put", "finish", "commit"])
      expect(prepared).toMatchObject([{ file_type: fileType, file_name: fileName ?? "fallback.mp4" }])
    }
  })

  it("surfaces a local fallback failure", async () => {
    const api = { commitFile: async () => { throw new Error("transfer failed") } }
    const http = { request: async () => { throw new Error("download failed") } } as unknown as HttpClient
    const uploader = new MediaUploader(api as never, http, logger)
    await expect(uploader.upload({ kind: "url", url: "https://example.test/a.mp4" }, {
      target: "group", targetId: "group", fileType: 2
    })).rejects.toThrow("QQ URL 转存与本地分片上传均失败：download failed")
  })
})
