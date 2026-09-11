/**
 * 模块职责：自定义图床（每个账号一个实例）
 * 依赖方向：仅依赖类型包
 * 生命周期：随 BotDriver 创建，connect() 时加载脚本
 * 注意事项：
 *   - 用户可编写 JS 脚本定义上传逻辑
 *   - 脚本需 export default（或 export upload）一个函数，接收图片数据返回公网 URL
 *   - 支持 Buffer、base64、文件路径三种输入
 *   - 改为按账号实例，避免多账号共享单例互相覆盖
 */
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import type { Logger } from "@yunzai-ng/types"

/** 图床上传函数类型 */
export type ImageUploadFn = (
  data: Buffer | string,
  options?: { filename?: string; mimeType?: string }
) => Promise<string>

/** 从脚本加载上传函数；失败返回 null */
async function loadUploadFn(scriptPath: string, logger: Logger): Promise<ImageUploadFn | null> {
  try {
    const fileUrl = pathToFileURL(resolve(scriptPath)).href
    const module = await import(fileUrl)
    if (typeof module.default === "function") return module.default
    if (typeof module.upload === "function") return module.upload
    return null
  } catch (err: any) {
    logger.error(`[image-host] 加载图床脚本失败: ${err.message}`)
    return null
  }
}

/** 单个账号的图床 */
export class ImageHost {
  private uploadFn?: ImageUploadFn
  private logger?: Logger

  /** 图床是否可用（脚本已成功加载） */
  get enabled(): boolean {
    return this.uploadFn !== undefined
  }

  /** 加载图床脚本，失败则保持禁用 */
  async load(scriptPath: string, logger: Logger): Promise<void> {
    this.logger = logger
    const fn = await loadUploadFn(scriptPath, logger)
    if (fn) {
      this.uploadFn = fn
      logger.info(`[image-host] 图床已启用，脚本: ${scriptPath}`)
    } else {
      logger.error(`[image-host] 图床脚本加载失败，已禁用`)
    }
  }

  /** 上传图片，返回公网 URL；失败返回 null */
  async upload(
    data: Buffer | string,
    options?: { filename?: string; mimeType?: string }
  ): Promise<string | null> {
    if (!this.uploadFn) return null

    try {
      const raw = await this.uploadFn(data, options)
      if (typeof raw !== "string") {
        this.logger?.error(`[image-host] 上传失败: 返回值不是字符串`)
        return null
      }
      // 清理返回值：去除包裹的反引号、引号、空白字符
      const url = raw.trim().replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "")
      if (url.startsWith("http")) return url
      this.logger?.error(`[image-host] 上传失败: 返回值不是有效的 URL: ${url}`)
      return null
    } catch (err: any) {
      this.logger?.error(`[image-host] 上传失败: ${err.message}`)
      return null
    }
  }
}
