import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { MediaUploader } from "./upload.js"

/** 默认当作两个可选依赖都没装：整形原样放行，本文件只验证上传路径 */
const deps = vi.hoisted(() => ({
  sharp: undefined as unknown,
  silk: undefined as unknown
}))

vi.mock("../shared/optional-deps.js", () => ({
  loadSharp: async () => deps.sharp,
  loadSilk: async () => deps.silk
}))

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

/** 假 silk-wasm：认 WAV、不认 SILK，恒产出 128 字节 */
const silkModule = {
  isSilk: () => false,
  isWav: () => true,
  getDuration: () => 1000,
  decode: async () => ({ data: new Uint8Array(0), duration: 0 }),
  encode: async () => ({ data: new Uint8Array(128), duration: 1000 })
}

/** 假 sharp：一律产出 2000 字节 jpeg */
function fakeSharp() {
  return (_input: Buffer) => {
    const image: Record<string, unknown> = {
      metadata: async () => ({ width: 2000, height: 1200, format: "png", hasAlpha: false }),
      resize: () => image,
      flatten: () => image,
      jpeg: () => image,
      png: () => image,
      webp: () => image,
      toBuffer: async () => Buffer.alloc(2000)
    }
    return image
  }
}

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

  it("falls back from URL transfer to chunks for image / video / file", async () => {
    // 语音单独测：它可能在转存之前就被本机取回整形，见下方「可选依赖接点」
    for (const [target, fileType] of [["group", 1], ["user", 2], ["user", 4]] as const) {
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

describe("MediaUploader 与可选依赖的接点", () => {
  /** 记录 commit / prepare 的假 API */
  function createApi(options: { failTransfer?: boolean } = {}) {
    const commits: Record<string, unknown>[] = []
    const prepares: Record<string, unknown>[] = []
    const api = {
      async prepareUpload(_target: string, _id: string, request: Record<string, unknown>) {
        prepares.push(request)
        return {
          upload_id: "upload-1",
          block_size: "4096",
          upload_config: { concurrency: 1, retry_timeout: 1, retry_delay: 0.001 },
          parts: [{ index: 1, block_size: "4096", presigned_url: "https://upload.test/0" }]
        }
      },
      async finishUploadPart() {},
      async commitFile(_target: string, _id: string, request: Record<string, unknown>) {
        if (options.failTransfer === true && typeof request.url === "string") throw new Error("转存被平台拒绝")
        commits.push(request)
        return { file_uuid: "uuid", file_info: "info", ttl: 1 }
      }
    }
    return { api: api as never, commits, prepares }
  }

  /** 记录下载 / PUT 的假 HTTP */
  function createHttp(payload: Buffer, mime = "application/octet-stream") {
    const requests: { url: string; method?: string }[] = []
    const http = {
      request: async (url: string, options: { method?: string }) => {
        requests.push({ url, method: options?.method })
        if (options?.method === "PUT") return { data: undefined, headers: {} }
        return { data: payload, headers: { "content-type": mime } }
      }
    } as unknown as HttpClient
    return { http, requests }
  }

  it("取回非 silk 的语音直链，转码后当作 silk 上传", async () => {
    deps.silk = silkModule
    const { api, commits, prepares } = createApi()
    const { http, requests } = createHttp(Buffer.alloc(4096), "audio/wav")

    await new MediaUploader(api, http, logger).upload(
      { kind: "url", url: "https://cdn.test/voice.wav" },
      { target: "group", targetId: "g1", fileType: 3 }
    )

    // 语音不走平台转存：先本机下载，由 silk-wasm 转码，再按 SILK 分片上传
    expect(requests.some(item => item.url === "https://cdn.test/voice.wav")).toBe(true)
    expect(prepares).toHaveLength(1)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ upload_id: "upload-1", file_name: "voice.silk", file_type: 3 })
  })

  it("已经是 silk 的语音直链仍交给平台转存", async () => {
    deps.silk = silkModule
    const { api, commits, prepares } = createApi()
    const { http, requests } = createHttp(Buffer.alloc(64), "audio/silk")

    await new MediaUploader(api, http, logger).upload(
      { kind: "url", url: "https://cdn.test/voice.silk" },
      { target: "group", targetId: "g1", fileType: 3 }
    )

    expect(requests).toHaveLength(0)
    expect(prepares).toHaveLength(0)
    expect(commits[0]).toMatchObject({ url: "https://cdn.test/voice.silk", file_type: 3 })
  })

  it("图片超限才压缩：上限驱动，未配置时原样上传", async () => {
    deps.sharp = fakeSharp()
    const source = { kind: "buffer" as const, data: Buffer.alloc(5000), name: "big.png" }

    const capped = createApi()
    await new MediaUploader(capped.api, createHttp(Buffer.alloc(0)).http, logger, { imageMaxBytes: 3000 })
      .upload(source, { target: "group", targetId: "g1", fileType: 1 })
    expect(capped.prepares[0]).toMatchObject({ file_size: "2000", file_type: 1 })
    expect(capped.commits[0]).toMatchObject({ file_name: "big.jpg" })

    const uncapped = createApi()
    await new MediaUploader(uncapped.api, createHttp(Buffer.alloc(0)).http, logger, { imageMaxBytes: 0 })
      .upload(source, { target: "group", targetId: "g1", fileType: 1 })
    expect(uncapped.prepares[0]).toMatchObject({ file_size: "5000" })
    expect(uncapped.commits[0]).toMatchObject({ file_name: "big.png" })
  })

  it("转存失败回退本机上传时，同样先整形再上传", async () => {
    deps.sharp = fakeSharp()
    const { api, commits, prepares } = createApi({ failTransfer: true })
    const { http } = createHttp(Buffer.alloc(5000), "image/png")

    await new MediaUploader(api, http, logger, { imageMaxBytes: 3000 }).upload(
      { kind: "url", url: "https://cdn.test/big.png" },
      { target: "user", targetId: "u1", fileType: 1 }
    )

    expect(prepares[0]).toMatchObject({ file_size: "2000" })
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ upload_id: "upload-1", file_name: "big.jpg" })
  })
})
