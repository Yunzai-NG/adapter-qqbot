import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { HttpClient, MediaRef } from "@yunzai-ng/types"
import { decodeMedia, inferFileType, mediaUrl, normalizeUrl, resolveMedia } from "./resolve.js"

describe("decodeMedia / QQ 附件 → MediaRef", () => {
  it("takes the native url and adds a missing scheme", () => {
    expect(decodeMedia({
      content_type: "image/jpeg",
      filename: "a.jpg",
      url: "gchat.qpic.cn/qmeetpic/1/0"
    })).toEqual({ kind: "url", url: "https://gchat.qpic.cn/qmeetpic/1/0" })
  })

  it("leaves an already-absolute url untouched", () => {
    expect(decodeMedia({
      content_type: "video/mp4",
      filename: "a.mp4",
      url: "https://multimedia.nt.qq.com.cn/download?appid=1407"
    })).toEqual({ kind: "url", url: "https://multimedia.nt.qq.com.cn/download?appid=1407" })
  })

  it("keeps the native voice url rather than the derived wav one", () => {
    // 语音再转发时走的是 url；把它换成 wav 会让 QQ 的语音上传拿到非 SILK 系格式
    expect(decodeMedia({
      content_type: "voice",
      filename: "v.amr",
      url: "https://multimedia.nt.qq.com.cn/download?appid=1403",
      voice_wav_url: "https://multimedia.nt.qq.com.cn/wav/1403.wav",
      asr_refer_text: "今天天气不错"
    })).toEqual({ kind: "url", url: "https://multimedia.nt.qq.com.cn/download?appid=1403" })
  })

  it("falls back to the wav url when the native url is absent", () => {
    expect(decodeMedia({
      content_type: "voice",
      filename: "v.amr",
      url: "",
      voice_wav_url: "multimedia.nt.qq.com.cn/wav/1403.wav"
    })).toEqual({ kind: "url", url: "https://multimedia.nt.qq.com.cn/wav/1403.wav" })
  })

  it("returns an empty id instead of a broken url when no source exists", () => {
    // 返回 `https://` 会被下游当成一个合法地址，比空 id 更糟
    expect(decodeMedia({
      content_type: "file",
      filename: "a.bin",
      url: ""
    })).toEqual({ kind: "id", id: "" })
  })
})

describe("normalizeUrl", () => {
  it("only prepends the scheme when one is missing", () => {
    expect(normalizeUrl("https://a.test/x")).toBe("https://a.test/x")
    expect(normalizeUrl("http://a.test/x")).toBe("http://a.test/x")
    expect(normalizeUrl("a.test/x")).toBe("https://a.test/x")
  })
})

describe("media helpers", () => {
  it("infers QQ media types from names and MIME types", () => {
    expect(inferFileType("image.webp")).toBe(1)
    expect(inferFileType("movie.mp4")).toBe(2)
    expect(inferFileType("voice.unknown", "audio/ogg")).toBe(3)
    expect(inferFileType("archive.zip")).toBeUndefined()
  })

  it("resolves URL, path, buffer and base64 references", async () => {
    const http = {
      request: async () => ({
        data: Uint8Array.from([1, 2]),
        headers: { "content-type": "image/png" }
      })
    } as unknown as HttpClient
    const dir = await mkdtemp(join(tmpdir(), "qqbot-media-"))
    const path = join(dir, "sample.txt")
    await writeFile(path, "path-data")

    try {
      const refs: MediaRef[] = [
        { kind: "url", url: "https://example.test/a.png", headers: { Referer: "https://example.test" } },
        { kind: "path", path },
        { kind: "buffer", data: Buffer.from("buffer-data"), name: "sample.bin" },
        { kind: "base64", base64: Buffer.from("base64-data").toString("base64") }
      ]
      const values = await Promise.all(refs.map(ref => resolveMedia(ref, http)))
      expect(values.map(value => value.buffer.toString())).toEqual(["", "path-data", "buffer-data", "base64-data"])
      expect(values[0].mime).toBe("image/png")
      expect(mediaUrl(refs[0])).toBe("https://example.test/a.png")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects attempts to resolve existing QQ file_info values", async () => {
    await expect(resolveMedia({ kind: "id", id: "file-info" }, {} as HttpClient))
      .rejects.toThrow("不应调用 resolveMedia")
  })
})
