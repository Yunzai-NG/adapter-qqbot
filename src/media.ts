/**
 * 模块职责：把内核 MediaRef 统一解析为可上传的字节 / URL / 富媒体类型
 * 依赖方向：依赖内核 HttpClient 与类型；被 upload / outbound / markdown 复用
 * 生命周期：无状态纯函数集合
 * 注意事项：
 *   - 下载 kind:"url" 时必须透传 ref.headers（米游社等图床防盗链），旧实现丢了它
 *   - kind:"id" 是平台已有的 file_info，无字节可取，调用 resolveMedia 即抛错
 */
import type { HttpClient, MediaRef } from "@yunzai-ng/types"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"

/** QQ 富媒体类型：1=图片 2=视频 3=语音 4=文件 */
export type MediaFileType = 1 | 2 | 3 | 4

/** 解析后的媒体字节与元信息 */
export interface ResolvedMedia {
  /** 文件二进制 */
  buffer: Buffer
  /** 建议文件名（含扩展名，可用于类型推断） */
  fileName?: string
  /** MIME 类型 */
  mime?: string
}

/** 按富媒体类型兜底的默认文件名 */
export const DEFAULT_FILE_NAMES: Record<MediaFileType, string> = {
  1: "image.png",
  2: "video.mp4",
  3: "audio.silk",
  4: "file.bin"
}

const FILE_TYPE_BY_EXT: Record<string, MediaFileType> = {
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1,
  mp4: 2, mov: 2, mkv: 2,
  silk: 3, mp3: 3, wav: 3, ogg: 3, amr: 3, m4a: 3, flac: 3
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  silk: "audio/silk", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", amr: "audio/amr", m4a: "audio/mp4"
}

function extOf(name?: string): string | undefined {
  if (!name) return undefined
  const bare = name.split(/[?#]/)[0]
  const parts = bare.split(".")
  return parts.length > 1 ? parts.pop()!.toLowerCase() : undefined
}

function urlFileName(url: string): string | undefined {
  try {
    const name = basename(new URL(url).pathname)
    return name || undefined
  } catch {
    return undefined
  }
}

/**
 * 从文件名或 MIME 推断 QQ 富媒体类型
 * @param fileName 文件名（含扩展名）
 * @param mime MIME 类型
 * @returns 富媒体类型，推断不出返回 undefined
 */
export function inferFileType(fileName?: string, mime?: string): MediaFileType | undefined {
  const ext = extOf(fileName)
  if (ext && FILE_TYPE_BY_EXT[ext]) return FILE_TYPE_BY_EXT[ext]
  if (mime) {
    if (mime.startsWith("image/")) return 1
    if (mime.startsWith("video/")) return 2
    if (mime.startsWith("audio/")) return 3
  }
  return undefined
}

/**
 * 从文件名推断 MIME
 * @param fileName 文件名（含扩展名）
 * @returns MIME 类型，推断不出返回 undefined
 */
export function guessMime(fileName?: string): string | undefined {
  const ext = extOf(fileName)
  return ext ? MIME_BY_EXT[ext] : undefined
}

/**
 * 若媒体本身就是公网 URL 则返回它，否则返回 undefined
 * @param ref 媒体引用
 * @returns 公网 URL 或 undefined（用于 URL 转存 / markdown 内联判断）
 */
export function mediaUrl(ref: MediaRef): string | undefined {
  return ref.kind === "url" ? ref.url : undefined
}

/**
 * 把 MediaRef 解析为字节。kind:"id" 无字节可取，调用即抛错
 * @param ref 媒体引用
 * @param http 内核 HTTP 客户端（下载 url 时透传 ref.headers）
 * @returns 解析后的字节与元信息
 */
export async function resolveMedia(ref: MediaRef, http: HttpClient): Promise<ResolvedMedia> {
  switch (ref.kind) {
    case "url": {
      const res = await http.request<Uint8Array>(ref.url, {
        method: "GET",
        headers: ref.headers,
        responseType: "buffer",
        timeout: 60_000
      })
      const fileName = urlFileName(ref.url)
      const contentType = res.headers["content-type"]
      const mime = contentType ? contentType.split(";")[0].trim() : guessMime(fileName)
      return { buffer: Buffer.from(res.data), fileName, mime }
    }
    case "path": {
      const buffer = await readFile(ref.path)
      const fileName = basename(ref.path)
      return { buffer, fileName, mime: guessMime(fileName) }
    }
    case "buffer":
      return { buffer: Buffer.from(ref.data), fileName: ref.name, mime: ref.mime ?? guessMime(ref.name) }
    case "base64":
      return { buffer: Buffer.from(ref.base64, "base64"), mime: ref.mime }
    case "id":
      throw new Error('kind:"id" 是平台已有的 file_info，不应调用 resolveMedia')
  }
}
