/**
 * 模块职责：媒体在「QQ 附件 / 内核 MediaRef / 可上传字节」之间的双向转换
 * 依赖方向：依赖内核 HttpClient 与类型；被 codec / upload / outbound / markdown 复用
 * 生命周期：无状态纯函数集合
 * 注意事项：
 *   - 下载 kind:"url" 时必须透传 ref.headers（米游社等图床防盗链），旧实现丢了它
 *   - kind:"id" 是平台已有的 file_info，无字节可取，调用 resolveMedia 即抛错
 *   - **本文件是双向的**：`decodeMedia` 是入站（QQ 附件 → MediaRef），
 *     `resolveMedia` 是出站（MediaRef → 字节）。两者放在一起，是为了让「QQ 的媒体长什么样」
 *     只有一处定义 —— 与 adapter-napcat 的 media.ts 同一结构
 */
import type { HttpClient, MediaRef } from "@yunzai-ng/types"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type { Attachment } from "../protocol/types.js"

/** QQ 富媒体类型：1=图片 2=视频 3=语音 4=文件 */
export type MediaFileType = 1 | 2 | 3 | 4

/* ────────────────────────────── 入站：QQ 附件 → MediaRef ────────────────────────────── */

/**
 * 补全附件 URL 的协议头
 *
 * 频道（含频道私信）的附件 URL 常省略协议（如 `gchat.qpic.cn/...`），
 * 下游按原样下载会失败；群聊 / C2C 一般已是完整 URL，此处为无副作用的兜底。
 * @param url 平台下发的附件地址
 * @returns 带协议的绝对地址
 */
export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

/**
 * 把 QQ 附件转换为内核媒体引用
 *
 * 与 adapter-napcat 的 `decodeMedia` 同一结构：一个函数、一条写明的优先级链、一个安全兜底。
 *
 * 优先级按「对下游最有用」排序：
 * 1. `url` —— 平台的原生来源，任何下游都能原样回传（插件把收到的语音再发一次时走的即是它）。
 * 2. `voice_wav_url` —— 语音专有的派生直链，播放/识别更省事，但**不作为首选**：把它当主来源会让
 *    「收到语音再转发」这条链路把 WAV 当语音上传，而 QQ 的语音上传期望的是 SILK 系格式。
 *    需要它时读附件的该字段即可（详情日志里也有）。
 *
 * **拿不到来源时返回空 id 而非抛错**：该消息的其余部分仍然可用，插件真正取用这个附件时才会失败，
 * 那时的报错更贴近现场。返回 `https://` 这类残缺地址更糟 —— 它会被下游当成一个合法 URL。
 * @param attachment 平台下发的附件
 * @returns 媒体引用
 */
export function decodeMedia(attachment: Attachment): MediaRef {
  if (attachment.url) return { kind: "url", url: normalizeUrl(attachment.url) }
  if (attachment.voice_wav_url) return { kind: "url", url: normalizeUrl(attachment.voice_wav_url) }
  return { kind: "id", id: "" }
}

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
