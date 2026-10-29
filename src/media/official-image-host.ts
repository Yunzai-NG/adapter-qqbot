/**
 * 模块职责：官方图床 —— 把图片上传到 QQ 素材库，换取 `qqbot-media://` 引用供 Markdown 使用
 * 依赖方向：依赖 api / types 与内核 HttpClient；被 bot 调用
 * 生命周期：一个账号一个实例，随 BotDriver 创建；本地去重缓存随进程存活
 * 注意事项：
 *   - 官方素材**不依赖公网地址**：图片由平台托管，内网部署也能在 Markdown 里显示
 *   - 单机器人上限 100 张、引用 90 天滑动过期，故按内容哈希做本地去重，避免重复占用配额
 *   - 保存时间只约束**本地记录**：超时后同一张图会重新上传。默认 14400 秒（4 小时），
 *     与官方上传任务的有效期对齐；调大则更省配额，但图片被平台回收前不会重新上传
 *   - 配额满（40035007）时按保存时间清理平台上超期的旧图：查询有效图片 → 删除超期项 → 重试一次
 *   - 释放动作有冷却间隔：刚释放过（或无图可释放）就再次配额满时不再翻页查询，直接交回调用方
 *     回退框架图床，避免每张图都白跑一次列表 + 删除
 *   - 平台只接受 png/jpeg/gif/webp 且单张 ≤10MB，不符合时返回 null 交由调用方降级
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html
 */
import { createHash } from "node:crypto"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import type { ApiClient } from "../transport/api.js"
import type { MediaImageItem } from "../protocol/types.js"

/** 平台允许的图片 MIME */
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** MIME → 文件扩展名（扩展名须与 content_type 一致，否则平台拒绝） */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
}

/** 单张图片大小上限：10MB */
const MAX_BYTES = 10 * 1024 * 1024

/** 平台滑动有效期上限：90 天 = 7776000 秒 */
export const MAX_SAVE_SECONDS = 7_776_000

/** 默认保存时间：官方上传任务 4 小时后自动过期 */
export const DEFAULT_SAVE_SECONDS = 4 * 60 * 60

/** 本地缓存条数上限：与平台单机器人配额（100 张）对齐 */
const CACHE_LIMIT = 100

/** 配额超限错误码：单机器人 100 张 */
const QUOTA_EXCEEDED = 40035007

/** 图片不存在错误码：清理时遇到视为已释放 */
const IMAGE_NOT_FOUND = 40035008

/** 查询有效图片的最大翻页数，防止游标异常时死循环 */
const MAX_LIST_PAGES = 20

/**
 * 配额释放的最小间隔（5 分钟）
 *
 * 配额满时每张图都去翻页查询 + 删除是一次纯浪费：超期图早在定时清理里删过了，
 * 剩下的都还在保存时间内。故释放动作按间隔节流，间隔内的配额满直接回退框架图床。
 */
export const RELEASE_COOLDOWN_MS = 5 * 60 * 1000

/** 本地缓存项 */
interface CachedImage {
  /** `qqbot-media://` 引用 */
  url: string
  /** 记录时间（毫秒） */
  time: number
}

/**
 * 归一化保存时间：非法值回落默认，超出平台窗口则截断
 * @param seconds 账号配置里的秒数
 * @returns 60～7776000 之间的整数秒
 */
export function normalizeSaveSeconds(seconds: number | undefined): number {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return DEFAULT_SAVE_SECONDS
  return Math.min(MAX_SAVE_SECONDS, Math.max(60, Math.floor(seconds)))
}

/**
 * 定时清理间隔：保存时间的四分之一，限定在 5 分钟 ~ 24 小时
 *
 * 取四分之一是为了在素材到期前后各留出余量，而不是等到刚好过期才清；
 * 上下限避免「4 小时保存时间」变成每 6 分钟查一次、或「90 天」变成半年才查一次。
 * @param saveSeconds 图片保存时间（秒）
 * @returns 间隔毫秒数
 */
export function sweepIntervalMs(saveSeconds: number | undefined): number {
  const quarter = (normalizeSaveSeconds(saveSeconds) * 1000) / 4
  return Math.min(24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, quarter))
}

function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex")
}

function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex")
}

/**
 * 判断错误是否为某个平台错误码
 * @param err 捕获到的异常
 * @param code 目标错误码
 * @returns 是否匹配
 */
function hasCode(err: unknown, code: number): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code
}

/**
 * 错误文本：优先用 Error.message，其余转字符串
 * @param err 捕获到的异常
 * @returns 可写入日志的说明
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 归一化 MIME：`image/jpg` 归到 `image/jpeg`，其余不在白名单的返回 undefined
 * @param mime 原始 MIME
 * @returns 平台接受的 MIME 或 undefined
 */
function normalizeMime(mime?: string): string | undefined {
  if (!mime) return undefined
  const bare = mime.split(";")[0].trim().toLowerCase()
  const normalized = bare === "image/jpg" ? "image/jpeg" : bare
  return ALLOWED_MIME.has(normalized) ? normalized : undefined
}

/**
 * 组出与 MIME 扩展名一致的文件名
 *
 * 平台会校验「扩展名与 content_type 是否匹配」，原始文件名带了别的后缀（如 .bmp）
 * 直接上报会被拒，故只在后缀匹配时沿用原名。
 * @param mime 已归一化的 MIME
 * @param original 原始文件名
 * @param hash 内容哈希（兜底文件名的区分度）
 * @returns 平台可接受的文件名
 */
function buildFileName(mime: string, original: string | undefined, hash: string): string {
  const ext = EXT_BY_MIME[mime]
  const base = original?.split(/[?#]/)[0].split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot > 0) {
    const suffix = base.slice(dot + 1).toLowerCase()
    const matches = suffix === ext || (ext === "jpg" && suffix === "jpeg")
    if (matches) return base
  }
  return `image-${hash.slice(0, 12)}.${ext}`
}

/** 官方素材库图床 */
export class OfficialImageHost {
  /** 内容哈希 → 已上传的引用 */
  private readonly cache = new Map<string, CachedImage>()

  /** 保存时间（秒）：既是本地记录 TTL，也是配额满时的清理依据 */
  private readonly saveSeconds: number

  /** 本地记录保留时长（毫秒） */
  private readonly ttlMs: number

  /** 上次尝试释放配额的时刻（毫秒）；0 表示本次进程内还没试过 */
  private lastReleaseAt = 0

  /**
   * @param api QQ Bot REST 客户端
   * @param http 内核 HTTP 客户端（向预签名地址直传字节）
   * @param logger 日志器
   * @param saveSeconds 图片保存时间（秒），缺省 14400（官方上传任务 4 小时过期），上限 7776000
   */
  constructor(
    private readonly api: ApiClient,
    private readonly http: HttpClient,
    private readonly logger: Logger,
    saveSeconds?: number
  ) {
    this.saveSeconds = normalizeSaveSeconds(saveSeconds)
    this.ttlMs = this.saveSeconds * 1000
  }

  /**
   * 上传图片并返回 `qqbot-media://` 引用；不支持或失败时返回 null
   *
   * 配额满（40035007）时按「图片保存时间」清理平台上超期的旧图，然后重试一次。
   * @param buffer 图片字节
   * @param options 原始文件名与 MIME
   * @returns 可写入 Markdown 的引用链接，失败返回 null
   */
  async upload(buffer: Buffer, options?: { filename?: string; mime?: string }): Promise<string | null> {
    const mime = normalizeMime(options?.mime)
    if (!mime) {
      this.logger.warn(`[qqbot] 官方图床不支持该图片格式（${options?.mime ?? "未知"}），仅接受 png/jpeg/gif/webp`)
      return null
    }
    if (buffer.length > MAX_BYTES) {
      this.logger.warn(`[qqbot] 官方图床单张上限 10MB，当前 ${(buffer.length / 1024 / 1024).toFixed(2)}MB`)
      return null
    }

    const hash = md5Hex(buffer)
    const cached = this.cache.get(hash)
    if (cached && Date.now() - cached.time < this.ttlMs) return cached.url

    const fileName = buildFileName(mime, options?.filename, hash)
    const task = { buffer, mime, hash, fileName }

    try {
      return await this.push(task)
    } catch (err) {
      if (!hasCode(err, QUOTA_EXCEEDED)) {
        this.logger.warn(`[qqbot] 官方图床上传失败：${describeError(err)}`)
        return null
      }
      this.logger.warn(`[qqbot] 官方素材配额已满（40035007），按保存时间 ${this.saveSeconds} 秒清理旧图`)
      const sinceLastRelease = Date.now() - this.lastReleaseAt
      if (this.lastReleaseAt > 0 && sinceLastRelease < RELEASE_COOLDOWN_MS) {
        this.logger.warn(
          `[qqbot] 距上次释放仅 ${Math.round(sinceLastRelease / 1000)} 秒（间隔 ${RELEASE_COOLDOWN_MS / 60_000} 分钟），` +
            "本次不重复清理，交由框架图床兜底"
        )
        return null
      }
      this.lastReleaseAt = Date.now()
      const removed = await this.releaseExpired()
      if (removed === 0) {
        this.logger.warn("[qqbot] 有效图片均在保存时间内，无可清理项，已回退框架图床；可调小「图片保存时间」或等待平台过期")
        return null
      }
      try {
        return await this.push(task)
      } catch (retryError) {
        this.logger.warn(`[qqbot] 清理 ${removed} 张旧图后仍上传失败：${describeError(retryError)}`)
        return null
      }
    }
  }

  /**
   * 执行一次 prepare → 预签名直传 → complete，并写入本地缓存
   * @param task 图片字节、MIME、内容哈希与文件名
   * @returns `qqbot-media://` 引用
   */
  private async push(task: { buffer: Buffer; mime: string; hash: string; fileName: string }): Promise<string> {
    const prepared = await this.api.prepareImageUpload({
      file_name: task.fileName,
      file_size: task.buffer.length,
      content_type: task.mime,
      md5: task.hash,
      sha1: sha1Hex(task.buffer)
    })

    // 预签名地址直传：Content-Type 必须与 prepare 声明的一致，否则 COS 返回 403
    await this.http.request(prepared.presigned_url, {
      method: "PUT",
      headers: { "Content-Type": task.mime },
      body: task.buffer,
      responseType: "none",
      timeout: 120_000
    })

    const completed = await this.api.completeImageUpload({
      upload_id: prepared.upload_id,
      md5: task.hash
    })

    this.remember(task.hash, completed.url)
    this.logger.debug(`[qqbot] 官方图床上传成功：${task.fileName} → ${completed.image_id}`)
    return completed.url
  }

  /**
   * 按保存时间清理平台上的超期图片
   *
   * 定时任务入口：与「上传失败后自动清理」共用同一套规则 —— 只删上传时间早于
   * 「现在 − 保存时间」的图片，不影响已发送的消息。
   * @returns 实际释放的张数
   */
  async sweep(): Promise<number> {
    return this.releaseExpired()
  }

  /**
   * 按保存时间清理平台上的旧图
   *
   * 规则：`created_at` 早于「现在 - 保存时间」的图片视为超期，逐张删除并释放配额；
   * 已发送的消息不受影响（平台在发送时已转存副本），本地缓存里对应的引用同时失效，
   * 避免后续消息引用已删除的链接（40035009）。
   * @returns 实际释放的张数
   */
  private async releaseExpired(): Promise<number> {
    let images: MediaImageItem[]
    try {
      images = await this.listAll()
    } catch (err) {
      this.logger.warn(`[qqbot] 查询有效图片失败，无法清理配额：${describeError(err)}`)
      return 0
    }

    const now = Math.floor(Date.now() / 1000)
    const expired = images.filter(item => now - item.created_at > this.saveSeconds)
    let removed = 0

    for (const item of expired) {
      try {
        await this.api.deleteMediaImage(item.image_id)
      } catch (err) {
        // 已被删除/过期：视作已释放，继续处理下一张
        if (!hasCode(err, IMAGE_NOT_FOUND)) {
          this.logger.warn(`[qqbot] 删除素材 ${item.image_id} 失败：${describeError(err)}`)
          continue
        }
      }
      removed++
      this.forget(item.url)
    }

    if (removed > 0) {
      this.logger.info(`[qqbot] 官方素材配额清理：删除 ${removed} 张超过保存时间的旧图（清理前共 ${images.length} 张）`)
    }
    return removed
  }

  /**
   * 拉取全部有效图片（自动翻页）
   * @returns 图片列表
   */
  private async listAll(): Promise<MediaImageItem[]> {
    const all: MediaImageItem[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.api.listMediaImages(cursor)
      all.push(...(response.images ?? []))
      if (!response.next_cursor) break
      cursor = response.next_cursor
    }
    return all
  }

  /**
   * 写入本地去重缓存，并清扫过期项、淘汰最旧记录
   * @param hash 内容哈希
   * @param url 平台返回的引用链接
   */
  private remember(hash: string, url: string): void {
    const now = Date.now()
    this.cache.set(hash, { url, time: now })

    for (const [key, item] of this.cache) {
      if (now - item.time > this.ttlMs) this.cache.delete(key)
    }
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /**
   * 丢弃某个引用对应的本地缓存，避免继续引用已删除的素材
   *
   * 供插件在主动删除素材（`DELETE /v2/media-images/{id}/delete`）后调用，
   * 否则本地缓存仍会返回已失效的 `qqbot-media://` 链接（平台报 40035009）。
   * @param url 已删除素材的引用链接
   */
  forget(url: string): void {
    if (!url) return
    for (const [key, item] of this.cache) {
      if (item.url === url) this.cache.delete(key)
    }
  }
}
