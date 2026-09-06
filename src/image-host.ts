/**
 * 模块职责：自定义图床管理
 * 依赖方向：依赖 config
 * 生命周期：单例模式，随适配器启动加载
 * 注意事项：
 *   - 用户可编写 JS 脚本定义上传逻辑
 *   - 脚本需 export default 一个函数，接收图片数据，返回公网 URL
 *   - 支持 Buffer、base64、文件路径三种输入
 */
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import type { Logger } from "@yunzai-ng/types"

/** 图床上传函数类型 */
export type ImageUploadFn = (
  data: Buffer | string,
  options?: { filename?: string; mimeType?: string }
) => Promise<string>

/** 图床配置 */
export interface ImageHostConfig {
  /** 是否启用图床 */
  enabled: boolean
  /** 图床脚本路径 */
  scriptPath?: string
  /** 上传函数（从脚本加载） */
  uploadFn?: ImageUploadFn
}

/** 全局图床实例 */
let imageHost: ImageHostConfig = { enabled: false }
let logger: Logger | null = null

/** 加载图床脚本 */
export async function loadImageHost(scriptPath: string): Promise<ImageUploadFn | null> {
  try {
    const absolutePath = resolve(scriptPath)
    const fileUrl = pathToFileURL(absolutePath).href
    const module = await import(fileUrl)
    
    if (typeof module.default === "function") {
      return module.default
    }
    
    if (typeof module.upload === "function") {
      return module.upload
    }
    
    return null
  } catch (err: any) {
    logger?.error(`[image-host] 加载图床脚本失败: ${err.message}`)
    return null
  }
}

/** 初始化图床 */
export async function initImageHost(
  config: { enabled: boolean; scriptPath?: string },
  log: Logger
): Promise<void> {
  logger = log
  imageHost = { enabled: config.enabled }
  
  if (config.enabled && config.scriptPath) {
    const uploadFn = await loadImageHost(config.scriptPath)
    if (uploadFn) {
      imageHost.uploadFn = uploadFn
      logger.info(`[image-host] 图床已启用，脚本: ${config.scriptPath}`)
    } else {
      logger.error(`[image-host] 图床脚本加载失败，已禁用`)
      imageHost.enabled = false
    }
  }
}

/** 获取图床配置 */
export function getImageHost(): ImageHostConfig {
  return imageHost
}

/** 上传图片到图床 */
export async function uploadToImageHost(
  data: Buffer | string,
  options?: { filename?: string; mimeType?: string }
): Promise<string | null> {
  if (!imageHost.enabled || !imageHost.uploadFn) {
    return null
  }
  
  try {
    const raw = await imageHost.uploadFn(data, options)
    if (typeof raw !== "string") {
      logger?.error(`[image-host] 上传失败: 返回值不是字符串`)
      return null
    }
    // 清理返回值：去除反引号、引号、空白字符等
    const url = raw.trim().replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "")
    if (url.startsWith("http")) {
      return url
    }
    logger?.error(`[image-host] 上传失败: 返回值不是有效的 URL: ${url}`)
    return null
  } catch (err: any) {
    logger?.error(`[image-host] 上传失败: ${err.message}`)
    return null
  }
}
