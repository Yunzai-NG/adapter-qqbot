/**
 * 模块职责：出站媒体字节的按需整形 —— 超限图片压缩（sharp）与语音转 SILK（silk-wasm，必要时借 ffmpeg 解码）
 * 依赖方向：依赖 shared/optional-deps、node 内置模块与 media/resolve 的类型；不依赖 transport / messaging / bot
 * 生命周期：无状态；两个可选依赖由 optional-deps 记忆化，ffmpeg 可用性也只在首次调用时探测一次
 * 注意事项：
 *   - 依赖缺失、格式不支持、整形失败，一律原样返回字节：增强能力不该让发送失败
 *   - 压缩只降质量与尺寸，不改画面比例；动图与矢量图跳过，避免毁掉动画与无损特性
 *   - silk-wasm 只吃 WAV 与单声道 pcm_s16le，mp3 / ogg / amr 先经 ffmpeg 解码成 PCM 再编码
 */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Logger } from "@yunzai-ng/types"
import { loadSharp, loadSilk } from "../shared/optional-deps.js"
import type { SharpFactory } from "../shared/optional-deps.js"
import type { MediaFileType, ResolvedMedia } from "./resolve.js"

/** JPEG 质量阶梯：先降质再降尺寸，肉眼无损优先 */
const JPEG_QUALITIES = [82, 74, 66, 58] as const

/** 尺寸阶梯：质量到底仍超限才缩图，比例保持不变 */
const SCALE_STEPS = [1, 0.78, 0.6, 0.45] as const

/** 平台侧图片边长上限，超过的图先等比缩到该边长 */
const MAX_SIDE = 4096

/** SILK 编码用的采样率：QQ / 微信语音的常见规格 */
const SILK_SAMPLE_RATE = 24_000

/** ffmpeg 解码超时（毫秒）：坏文件不该把发送卡死 */
const FFMPEG_TIMEOUT = 20_000

const execFileAsync = promisify(execFile)

/** ffmpeg 可用性缓存：首次探测失败后不再反复 fork 进程 */
let ffmpegUsable: boolean | undefined

/** 图片压缩结果 */
export interface ImageShrink {
  /** 压缩后的字节 */
  buffer: Buffer
  /** 建议文件名（扩展名随新格式变化） */
  fileName: string
  /** 新格式的 MIME */
  mime: string
  /** 压缩前字节数 */
  before: number
  /** 压缩后字节数 */
  after: number
  /** 实际编码格式 */
  format: "jpeg" | "png"
}

/** 语音转码结果 */
export interface SilkTranscode {
  /** SILK 字节 */
  buffer: Buffer
  /** 时长（毫秒），平台侧可用于展示 */
  duration: number
  /** 转码前字节数 */
  before: number
  /** 转码后字节数 */
  after: number
}

/** 媒体整形选项 */
export interface MediaPrepareOptions {
  /** 图片体积上限（字节）；未设置或 <= 0 表示不压缩 */
  imageMaxBytes?: number
  /** 日志器；不传时静默降级 */
  logger?: Logger
}

/** 媒体整形结果 */
export interface PreparedMedia {
  /** 最终用于上传的字节 */
  buffer: Buffer
  /** 建议文件名；整形后扩展名可能变化 */
  fileName?: string
  /** MIME；整形后可能变化 */
  mime?: string
  /** 是否真的改写了字节 */
  changed: boolean
  /** 改写说明，供调用方记一条 debug 日志 */
  note?: string
}

/**
 * 取 URL 路径里的扩展名（小写，忽略查询串与锚点）
 * @param url 媒体地址
 * @returns 扩展名，取不到返回 undefined
 */
function extOfUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname
    const dot = path.lastIndexOf(".")
    return dot >= 0 && dot < path.length - 1 ? path.slice(dot + 1).toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/**
 * 替换文件名的扩展名
 * @param name 原文件名，可为空
 * @param ext 新扩展名（不带点）
 * @param fallback 无文件名时使用的兜底名
 * @returns 新文件名
 */
function replaceExt(name: string | undefined, ext: string, fallback: string): string {
  const base = (name ?? fallback).split(/[?#]/)[0]
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${stem}.${ext}`
}

/**
 * 判断语音直链是否要在本机取字节后再上传
 *
 * 已经是 SILK 的直链交给平台转存最省事；其余（含无扩展名）先下载字节，
 * 由 silk-wasm 判断能否转码 —— 语音若不是 SILK，平台侧往往当作普通文件处理。
 * @param fileType 富媒体类型
 * @param url 媒体地址
 * @returns 为 true 表示跳过平台转存，走本机分片上传
 */
export function shouldTranscodeBeforeTransfer(fileType: MediaFileType, url: string): boolean {
  if (fileType !== 3) return false
  return extOfUrl(url) !== "silk"
}

/**
 * 单次编码尝试：按需缩放后编码为目标格式
 * @param sharp sharp 工厂
 * @param buffer 原图字节
 * @param width 目标宽度；不传表示不缩放
 * @param target 目标格式
 * @param quality JPEG 质量；PNG 忽略
 * @returns 编码结果，失败返回 undefined
 */
async function encodeImage(
  sharp: SharpFactory,
  buffer: Buffer,
  width: number | undefined,
  target: "jpeg" | "png",
  quality?: number
): Promise<Buffer | undefined> {
  try {
    let image = sharp(buffer)
    if (width) image = image.resize({ width, fit: "inside", withoutEnlargement: true })
    image = target === "png"
      ? image.png({ compressionLevel: 9, palette: true })
      // JPEG 没有 alpha 通道，先压到白底，否则透明区域会变黑
      : image.flatten({ background: "#ffffff" }).jpeg(quality === undefined ? {} : { quality })
    const output = await image.toBuffer()
    return output.length ? output : undefined
  } catch {
    return undefined
  }
}

/**
 * 把超过体积上限的图片压到上限以内
 *
 * 策略是「先降质、再降尺寸」：质量从 82 逐级降到 58，仍超限才等比缩小 22% / 40% / 55% 再来一轮。
 * 带 alpha 的图先试 PNG 调色板（保住透明），装不进上限再压到白底转 JPEG。
 * @param buffer 原图字节
 * @param maxBytes 体积上限（字节），<= 0 表示不限
 * @param logger 日志器
 * @returns 压缩结果；未超限、格式不合适或 sharp 不可用时返回 undefined
 */
export async function shrinkImage(
  buffer: Buffer,
  maxBytes: number,
  logger?: Logger
): Promise<ImageShrink | undefined> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || buffer.length <= maxBytes) return undefined

  const sharp = await loadSharp(logger)
  if (!sharp) return undefined

  let meta
  try {
    meta = await sharp(buffer).metadata()
  } catch (err) {
    logger?.debug(`[qqbot] 读不出图片元信息，跳过压缩：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }

  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) return undefined

  const format = (meta.format ?? "").toLowerCase()
  if (format === "svg") {
    logger?.debug("[qqbot] 矢量图不参与压缩，按原图发送")
    return undefined
  }
  if (format === "gif" && (meta.pages ?? 1) > 1) {
    logger?.debug("[qqbot] 动图不参与压缩，按原图发送")
    return undefined
  }

  // 带 alpha 先保留透明度，装不进去再退回 JPEG
  const targets: readonly ("png" | "jpeg")[] = meta.hasAlpha === true ? ["png", "jpeg"] : ["jpeg"]
  const baseWidth = Math.min(width, MAX_SIDE)

  for (const scale of SCALE_STEPS) {
    const targetWidth = Math.max(1, Math.round(baseWidth * scale))
    const resizeTo = targetWidth < width ? targetWidth : undefined
    for (const target of targets) {
      const qualities: readonly (number | undefined)[] = target === "png" ? [undefined] : JPEG_QUALITIES
      for (const quality of qualities) {
        const output = await encodeImage(sharp, buffer, resizeTo, target, quality)
        if (output && output.length <= maxBytes) {
          return {
            buffer: output,
            fileName: replaceExt(undefined, target === "png" ? "png" : "jpg", "image.jpg"),
            mime: target === "png" ? "image/png" : "image/jpeg",
            before: buffer.length,
            after: output.length,
            format: target
          }
        }
      }
    }
  }

  logger?.warn(`[qqbot] 图片压缩后仍超过 ${maxBytes} 字节，已按原图发送`)
  return undefined
}

/**
 * 找到 ffmpeg 可执行文件
 *
 * 优先级：`FFMPEG_PATH` 环境变量（宿主自带二进制、不在 PATH 上时用）→ PATH 里的 `ffmpeg`。
 * @returns 可执行文件路径或命令名
 */
function ffmpegBin(): string {
  const configured = process.env.FFMPEG_PATH?.trim()
  return configured ? configured : "ffmpeg"
}

/**
 * 用 ffmpeg 把任意音频解码为单声道 16bit PCM
 *
 * silk-wasm 只吃 WAV 与 pcm_s16le，mp3 / ogg / amr / m4a 必须先解码。这里用 execFile 传参数数组
 * （不经 shell，避免文件名里的引号与空格变成注入面），临时文件放在系统临时目录并在 finally 清理。
 * 找不到 ffmpeg 时记一条 debug 并永久降级，不反复 fork。
 * @param buffer 原始音频字节
 * @param logger 日志器
 * @returns PCM 字节；ffmpeg 不可用或解码失败时返回 undefined
 */
async function decodeToPcm(buffer: Buffer, logger?: Logger): Promise<Buffer | undefined> {
  if (ffmpegUsable === false) return undefined

  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), "qqbot-audio-"))
    const source = join(dir, "input")
    const output = join(dir, "output.pcm")
    await writeFile(source, buffer)
    await execFileAsync(
      ffmpegBin(),
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", source,
        "-f", "s16le", "-ac", "1", "-ar", String(SILK_SAMPLE_RATE),
        output
      ],
      { timeout: FFMPEG_TIMEOUT }
    )
    ffmpegUsable = true
    const pcm = await readFile(output)
    return pcm.length ? pcm : undefined
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      ffmpegUsable = false
      logger?.debug("[qqbot] 未找到 ffmpeg，非 WAV 语音无法转 SILK（可设 FFMPEG_PATH 指向二进制；仅 WAV / PCM 可直接转码）")
    } else {
      logger?.debug(`[qqbot] ffmpeg 解码音频失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return undefined
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 把语音转成 QQ 语音所需的 SILK
 *
 * 已经是 SILK 的原样返回 undefined（上层不会重复编码）。WAV 直接交给 silk-wasm（采样率传 0 由它读头部），
 * 其余格式先经 ffmpeg 解成 24 kHz 单声道 PCM 再编码；两条路都不通时原样上传并记日志。
 * @param buffer 原始音频字节
 * @param logger 日志器
 * @returns 转码结果；无需转码或无法转码时返回 undefined
 */
export async function transcodeToSilk(buffer: Buffer, logger?: Logger): Promise<SilkTranscode | undefined> {
  const silk = await loadSilk(logger)
  if (!silk) return undefined

  try {
    if (silk.isSilk(buffer)) return undefined

    let encoded
    if (silk.isWav(buffer)) {
      // 输入为 WAV 时采样率传 0，由 silk-wasm 自行解析头部
      encoded = await silk.encode(buffer, 0)
    } else {
      const pcm = await decodeToPcm(buffer, logger)
      if (!pcm) {
        logger?.debug("[qqbot] 语音无法解码为 PCM，按原格式上传")
        return undefined
      }
      encoded = await silk.encode(pcm, SILK_SAMPLE_RATE)
    }

    const data = encoded?.data
    if (!data?.length) return undefined
    return { buffer: Buffer.from(data), duration: encoded.duration, before: buffer.length, after: data.length }
  } catch (err) {
    logger?.warn(`[qqbot] 语音转 SILK 失败，按原样上传：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * 按富媒体类型整形待发送的字节
 *
 * 图片按 `imageMaxBytes` 压到上限内；语音尽量转成 SILK；其余类型（视频 / 文件）原样返回。
 * @param media 已解析出的字节与元信息
 * @param fileType 富媒体类型：1=图片 2=视频 3=语音 4=文件
 * @param options 整形选项
 * @returns 整形结果，`changed` 表明字节是否被改写
 */
export async function prepareMediaForSend(
  media: ResolvedMedia,
  fileType: MediaFileType,
  options: MediaPrepareOptions = {}
): Promise<PreparedMedia> {
  const unchanged: PreparedMedia = {
    buffer: media.buffer,
    changed: false,
    ...(media.fileName ? { fileName: media.fileName } : {}),
    ...(media.mime ? { mime: media.mime } : {})
  }

  if (fileType === 1) {
    const shrunk = await shrinkImage(media.buffer, options.imageMaxBytes ?? 0, options.logger)
    if (!shrunk) return unchanged
    return {
      buffer: shrunk.buffer,
      fileName: replaceExt(media.fileName, shrunk.format === "png" ? "png" : "jpg", shrunk.fileName),
      mime: shrunk.mime,
      changed: true,
      note: `图片压缩 ${shrunk.before} → ${shrunk.after} 字节（${shrunk.format}）`
    }
  }

  if (fileType === 3) {
    const silk = await transcodeToSilk(media.buffer, options.logger)
    if (!silk) return unchanged
    return {
      buffer: silk.buffer,
      fileName: replaceExt(media.fileName, "silk", "audio.silk"),
      mime: "audio/silk",
      changed: true,
      note: `语音转 SILK ${silk.before} → ${silk.after} 字节（${silk.duration} ms）`
    }
  }

  return unchanged
}
