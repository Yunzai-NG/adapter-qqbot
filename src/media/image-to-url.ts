/**
 * 模块职责：`imageToUrl` —— 适配器向插件索取图片地址的第一级图床
 * 依赖方向：依赖 media（解析字节）/ file-server（发布字节）与由 bot 注入的自定义图床取用函数
 * 生命周期：随 BotDriver 创建；自定义图床每次取址时现查服务表，故插件后加载/热重载即时生效
 * 注意事项：
 *   - **方向是适配器调用插件**：插件在自己的 `setup` 里 `ctx.provide(CUSTOM_IMAGE_KEY, fn)`，
 *     函数最后 `return` 一个地址；适配器取不到或处理失败才走官方素材库与框架文件服务
 *   - `file` 原样交给插件（公网链接 / 绝对路径 / `base64://` / Buffer），插件自己判断怎么处理
 *   - 直链直用是内建兜底：插件没装或没处理时，公网 http(s) 地址原样返回，不下载也不占配额
 *   - 框架通道要求公网可达，这是「QQ 服务器来拉图」的硬约束
 */
import type { Logger, MediaRef } from "@yunzai-ng/types"
import type { ResolvedMedia } from "./resolve.js"
import { fileUrl, publishFile } from "./file-server.js"
import { isPublicHttpUrl } from "../shared/public-url.js"

/**
 * 自定义图床的服务键
 *
 * 插件通过 `ctx.provide(CUSTOM_IMAGE_KEY, imageToUrl)` 把函数交给适配器，
 * 多个插件同时提供时后注册者覆盖先注册者。
 */
export const CUSTOM_IMAGE_KEY = "qqbot.imageToUrl"

/** 交给自定义图床的文件：链接 / 绝对路径 / `base64://` 原样传，字节传 Buffer */
export type ImageFileInput = string | Buffer

/** 自定义图床的附加信息 */
export interface ImageFileOptions {
  /** 建议文件名（含扩展名） */
  filename?: string
  /** MIME 类型 */
  mime?: string
}

/**
 * 插件实现的 `imageToUrl`
 *
 * 返回可直接写进消息的地址（`http(s)://` 或 `qqbot-media://`）；
 * 返回空串 / `null` / `undefined` 表示「这一张我处理不了」，适配器继续往下走。
 */
export type ImageToUrlFn = (
  file: ImageFileInput,
  opts: ImageFileOptions
) => string | null | undefined | Promise<string | null | undefined>

/** 图床通道 */
export type ImageChannel = "custom" | "official" | "framework"

/** 通道的中文名（日志用） */
const CHANNEL_LABEL: Record<ImageChannel, string> = {
  custom: "自定义图床",
  official: "官方图床",
  framework: "框架图床"
}

/** 上传结果 */
export interface ImageUrlResult {
  /** 图片地址：公网 http(s) URL 或 `qqbot-media://` 引用 */
  url: string
  /** 实际生效的通道，便于排障与日志 */
  channel: ImageChannel
}

/** 传给图床的媒体元信息 */
export interface ImageMeta {
  /** 建议文件名（含扩展名） */
  filename?: string
  /** MIME 类型 */
  mime?: string
}

/** 单级图床的上传函数：返回可用地址，失败返回 null（不抛错） */
export type ImageUploadAttempt = (buffer: Buffer, meta: ImageMeta) => Promise<string | null>

/** 链路依赖；除 resolve / logger 外都可省略，省略即该级不可用 */
export interface ImageResolverDeps {
  /** 媒体引用 → 字节 */
  resolve: (ref: MediaRef) => Promise<ResolvedMedia>
  /**
   * 取插件注册的自定义图床
   *
   * 传函数而不是实例：服务表随时可变，每次取址现查才能反映插件的加载、重载与卸载。
   */
  custom?: () => ImageToUrlFn | undefined
  /** 官方素材库，未启用时省略 */
  official?: ImageUploadAttempt
  /** 框架文件服务的对外基址；返回空串表示不可用 */
  frameworkBase?: () => string
  /** 发布字节到文件路由，缺省用内核文件服务；测试可替换 */
  publish?: (buffer: Buffer, mime?: string) => string
  /** 日志器 */
  logger: Logger
}

/**
 * 判断一个地址能否直接当图床地址用
 * @param value 候选地址
 * @returns 是否是可从公网访问的 http(s) 直链
 */
function usableDirectUrl(value: string | undefined): string | undefined {
  return value && isPublicHttpUrl(value) ? value : undefined
}

/**
 * 校验插件返回的地址是否可用
 *
 * 只认这两类协议：发给 QQ 的图片地址最终要么是互联网地址，要么是官方素材引用。
 * 插件写错（返回相对路径、忘写协议、返回 `undefined`）一律当作「没处理」，
 * 否则会把坏地址写进消息，表现为一张裂图且报错指向平台。
 * @param url 插件返回值
 * @returns 修剪后的地址；不可用时 undefined
 */
function usableAddress(url: string | null | undefined): string | undefined {
  const trimmed = typeof url === "string" ? url.trim() : ""
  if (!trimmed) return undefined
  return /^(?:https?|qqbot-media):\/\//i.test(trimmed) ? trimmed : undefined
}

/**
 * 取出媒体引用里能直接交给插件的部分，不触发下载
 * @param ref 内核媒体引用
 * @returns 链接 / 绝对路径 / `base64://` / 字节；`id` 类没有字节可取，返回 undefined
 */
function directSource(ref: MediaRef): ImageFileInput | undefined {
  switch (ref.kind) {
    case "url":
      return ref.url
    case "path":
      return ref.path
    case "base64":
      return ref.base64.startsWith("base64://") ? ref.base64 : `base64://${ref.base64}`
    case "buffer":
      return Buffer.from(ref.data)
    default:
      return undefined
  }
}

/**
 * 取出媒体引用自带的元信息
 * @param ref 内核媒体引用
 * @returns 文件名与 MIME
 */
function directMeta(ref: MediaRef): ImageFileOptions {
  if (ref.kind === "buffer") return { filename: ref.name, mime: ref.mime }
  if (ref.kind === "base64") return { mime: ref.mime }
  return {}
}

/**
 * 图片转地址链路
 *
 * 为什么是链而不是单选：插件手里可能已经是外链（自家图床 / 平台 CDN），直接用最省事；
 * 官方素材库不依赖公网、内网部署也能用，但单机器人只有 100 张配额；框架文件服务总在，
 * 却要求公网可达。三级串起来后，插件只需实现一个 `imageToUrl`。
 */
export class ImageResolver {
  /**
   * @param deps 链路依赖
   */
  constructor(private readonly deps: ImageResolverDeps) {}

  /**
   * 把媒体引用转成可用地址
   * @param ref 内核媒体引用（url / path / buffer / base64）
   * @returns 地址与实际通道；全部不可用时返回 null
   */
  async toUrl(ref: MediaRef): Promise<ImageUrlResult | null> {
    // 第一级：先问自定义图床。链接与路径直接传，省掉一次下载
    const source = directSource(ref)
    if (source !== undefined) {
      const custom = await this.custom(source, directMeta(ref))
      if (custom) return { url: custom, channel: "custom" }
    }

    // 直链兜底：插件没装或没处理时，公网地址原样用 —— QQ 自己拉得到，不必下载也不占配额
    const reusable = ref.kind === "url" ? usableDirectUrl(ref.url) : undefined
    if (reusable) return { url: reusable, channel: "custom" }

    const media = await this.deps.resolve(ref)
    return this.upload(media)
  }

  /**
   * 把已解析的字节转成可用地址（发送路径已拿到字节时用，避免重复下载）
   * @param media 字节与元信息
   * @param directUrl 原始就是公网 http(s) 时可以直传该地址
   * @returns 地址与实际通道；全部不可用时返回 null
   */
  async toUrlFromMedia(media: ResolvedMedia, directUrl?: string): Promise<ImageUrlResult | null> {
    // 插件拿到的是原始链接（有的话），与它自己的入参约定一致：字符串按链接、Buffer 按字节
    const custom = await this.custom(directUrl ?? media.buffer, {
      filename: media.fileName,
      mime: media.mime
    })
    if (custom) return { url: custom, channel: "custom" }

    const reusable = usableDirectUrl(directUrl)
    if (reusable) return { url: reusable, channel: "custom" }

    return this.upload(media)
  }

  /**
   * 问一次插件注册的自定义图床
   * @param file 交给插件的文件
   * @param opts 元信息
   * @returns 可用地址；未注册、返回空或抛错时 undefined
   */
  private async custom(file: ImageFileInput, opts: ImageFileOptions): Promise<string | undefined> {
    const fn = this.deps.custom?.()
    if (!fn) return undefined

    try {
      const url = usableAddress(await fn(file, opts))
      if (url) return url
      this.deps.logger.warn(`[qqbot] ${CHANNEL_LABEL.custom}未返回可用地址，尝试下一级`)
      return undefined
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.logger.warn(`[qqbot] ${CHANNEL_LABEL.custom}处理失败（${reason}），尝试下一级`)
      return undefined
    }
  }

  /**
   * 官方素材库 → 框架文件服务
   * @param media 字节与元信息
   * @returns 地址与实际通道；全部不可用时返回 null
   */
  private async upload(media: ResolvedMedia): Promise<ImageUrlResult | null> {
    const meta: ImageMeta = { filename: media.fileName, mime: media.mime }

    if (this.deps.official) {
      const url = await this.attempt("official", this.deps.official, media.buffer, meta)
      if (url) return { url, channel: "official" }
    }

    return this.framework(media)
  }

  /**
   * 执行一级图床，把异常与空返回统一收敛成 undefined
   * @param channel 通道名
   * @param attempt 上传函数
   * @param buffer 图片字节
   * @param meta 元信息
   * @returns 地址或 undefined
   */
  private async attempt(
    channel: ImageChannel,
    attempt: ImageUploadAttempt,
    buffer: Buffer,
    meta: ImageMeta
  ): Promise<string | undefined> {
    try {
      const url = await attempt(buffer, meta)
      const trimmed = typeof url === "string" ? url.trim() : ""
      if (trimmed) return trimmed
      this.deps.logger.warn(`[qqbot] ${CHANNEL_LABEL[channel]}未返回可用地址，尝试下一级`)
      return undefined
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.logger.warn(`[qqbot] ${CHANNEL_LABEL[channel]}上传异常（${reason}），尝试下一级`)
      return undefined
    }
  }

  /**
   * 框架文件服务通道：发布字节并拼出公网 URL
   * @param media 字节与元信息
   * @returns 地址或 null（基址缺失 / 不可公网访问）
   */
  private framework(media: ResolvedMedia): ImageUrlResult | null {
    const base = (this.deps.frameworkBase?.() ?? "").replace(/\/+$/, "")
    if (!base) {
      this.deps.logger.warn("[qqbot] 框架图床不可用：未配置文件服务地址，且内核面板未启用对外地址")
      return null
    }
    if (!isPublicHttpUrl(base)) {
      this.deps.logger.warn(`[qqbot] 框架图床地址不是公网可达地址（${base}），QQ 服务器拉不到，已跳过`)
      return null
    }
    const publish = this.deps.publish ?? publishFile
    return { url: fileUrl(base, publish(media.buffer, media.mime)), channel: "framework" }
  }
}
