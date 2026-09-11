/**
 * 模块职责：群聊 / 单聊富媒体上传 —— URL 转存与官方分片上传
 * 依赖方向：依赖 api / media 与内核 HttpClient；被 bot / outbound 调用
 * 生命周期：一个账号一个实例，随 BotDriver 创建
 * 注意事项：
 *   - 公网 URL 走平台转存，不下载到本机，最省内存
 *   - 其余来源走官方协议：upload_prepare → PUT 分片 → upload_part_finish → files 合并
 *   - kind:"id" 视为平台已有的 file_info，直接回填，不再上传
 *   - md5 / sha1 用 node:crypto，不引入新依赖
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */
import { createHash } from "node:crypto"
import type { HttpClient, Logger, MediaRef } from "@yunzai-ng/types"
import type { ApiClient } from "./api.js"
import type { UploadConfig, UploadMediaResponse } from "./types.js"
import { DEFAULT_FILE_NAMES, resolveMedia, type MediaFileType } from "./media.js"

/** 官方分片上传用：文件前 10002432 字节（约 9.54MB）的 MD5 */
const MD5_10M_SIZE = 10_002_432

/** 分片默认大小 5MiB，服务端下发的 block_size 优先 */
const DEFAULT_BLOCK_SIZE = 5 * 1024 * 1024

/** 上传参数 */
export interface UploadOptions {
  /** 上传目标类型：group=群聊，user=单聊 */
  target: "group" | "user"
  /** 群 openid 或用户 openid */
  targetId: string
  /** 富媒体类型：1=图片 2=视频 3=语音 4=文件 */
  fileType: MediaFileType
  /** 文件名，缺省按 fileType 兜底 */
  fileName?: string
  /** 是否由平台直接发送（上传即发消息），缺省 false */
  srvSendMsg?: boolean
}

/** 归一化后的并发重试配置 */
interface ResolvedUploadConfig {
  concurrency: number
  retryTimeout: number
  retryDelay: number
}

function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex")
}

function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex")
}

function md5First10M(data: Buffer): string {
  return md5Hex(data.subarray(0, Math.min(data.length, MD5_10M_SIZE)))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeConfig(config: UploadConfig | undefined): ResolvedUploadConfig {
  return {
    concurrency: Math.max(1, toNumber(config?.concurrency, 1)),
    retryTimeout: toNumber(config?.retry_timeout, 300),
    retryDelay: toNumber(config?.retry_delay, 1)
  }
}

/** 在 retryTimeout 秒内反复重试，间隔 retryDelay 秒；超时抛最后一次错误 */
async function withRetry<T>(task: () => Promise<T>, config: ResolvedUploadConfig): Promise<T> {
  const deadline = Date.now() + config.retryTimeout * 1000
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      return await task()
    } catch (err) {
      lastError = err
      if (Date.now() + config.retryDelay * 1000 > deadline) break
      await sleep(config.retryDelay * 1000)
    }
  }
  throw lastError
}

/** 以固定并发消费任务列表，任一失败即整体失败 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        await worker(items[cursor++])
      }
    }
  )
  await Promise.all(runners)
}

/** 富媒体上传器 */
export class MediaUploader {
  /**
   * @param api QQ Bot REST 客户端
   * @param http 内核 HTTP 客户端（下载源文件与 PUT 预签名分片）
   * @param logger 日志器
   */
  constructor(
    private api: ApiClient,
    private http: HttpClient,
    private logger: Logger
  ) {}

  /**
   * 上传媒体并换取 file_info
   * @param ref 媒体引用
   * @param options 上传参数
   * @returns 含 file_info 的上传结果
   */
  async upload(ref: MediaRef, options: UploadOptions): Promise<UploadMediaResponse> {
    // 平台已有的资源，零传输
    if (ref.kind === "id") {
      return { file_uuid: ref.id, file_info: ref.id, ttl: 0 }
    }

    // 公网 URL 优先交给平台转存，不占本机内存；失败时改由本机下载并分片上传。
    if (ref.kind === "url") {
      try {
        return await this.api.commitFile(options.target, options.targetId, {
          file_type: options.fileType,
          url: ref.url,
          file_name: options.fileName,
          srv_send_msg: options.srvSendMsg ?? false
        })
      } catch (transferError) {
        this.logger.warn(
          `[qqbot] QQ URL 转存失败，改用本地分片上传（类型 ${options.fileType}，目标 ${options.target}）`
        )
        try {
          const resolved = await resolveMedia(ref, this.http)
          return await this.uploadByChunks(resolved.buffer, {
            ...options,
            fileName: options.fileName ?? resolved.fileName
          })
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          throw new Error(`QQ URL 转存与本地分片上传均失败：${message}`, { cause: transferError })
        }
      }
    }

    const resolved = await resolveMedia(ref, this.http)
    return this.uploadByChunks(resolved.buffer, {
      ...options,
      fileName: options.fileName ?? resolved.fileName
    })
  }

  /**
   * 官方分片上传：预上传 → 并发 PUT 分片 → 逐片确认 → 合并
   * @param buffer 文件字节
   * @param options 上传参数
   * @returns 含 file_info 的上传结果
   */
  async uploadByChunks(buffer: Buffer, options: UploadOptions): Promise<UploadMediaResponse> {
    const fileName = options.fileName || DEFAULT_FILE_NAMES[options.fileType]
    const prepared = await this.api.prepareUpload(options.target, options.targetId, {
      file_type: options.fileType,
      file_size: String(buffer.length),
      file_name: fileName,
      md5: md5Hex(buffer),
      sha1: sha1Hex(buffer),
      md5_10m: md5First10M(buffer)
    })

    const config = normalizeConfig(prepared.upload_config)
    const blockSize = toNumber(prepared.block_size, DEFAULT_BLOCK_SIZE)
    const parts = prepared.parts ?? []

    this.logger.debug(
      `[qqbot] 分片上传 ${fileName}：${buffer.length} 字节 / ${parts.length} 片，并发 ${config.concurrency}`
    )

    await runWithConcurrency(parts, config.concurrency, async part => {
      const partSize = toNumber(part.block_size, blockSize)
      // QQ 返回的 part.index 从 1 开始（实测单分片与多分片均如此），偏移须减一
      const start = (part.index - 1) * blockSize
      const chunk = buffer.subarray(start, start + partSize)
      await withRetry(async () => {
        await this.putPart(part.presigned_url, chunk)
        await this.api.finishUploadPart(options.target, options.targetId, {
          upload_id: prepared.upload_id,
          part_index: part.index,
          block_size: String(chunk.length),
          md5: md5Hex(chunk)
        })
      }, config)
    })

    return this.api.commitFile(options.target, options.targetId, {
      file_type: options.fileType,
      upload_id: prepared.upload_id,
      file_name: fileName,
      srv_send_msg: options.srvSendMsg ?? false
    })
  }

  /**
   * 向预签名 URL 原样 PUT 一个分片
   * @param presignedUrl 服务端下发的预签名地址
   * @param chunk 分片字节
   */
  private async putPart(presignedUrl: string, chunk: Buffer): Promise<void> {
    await this.http.request(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      responseType: "none",
      timeout: 120_000
    })
  }
}
