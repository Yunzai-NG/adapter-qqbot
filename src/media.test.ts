import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { HttpClient, MediaRef } from "@yunzai-ng/types"
import { inferFileType, mediaUrl, resolveMedia } from "./media.js"

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
