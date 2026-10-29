/**
 * 模块职责：把渲染产物（内存字节）暴露为公网可拉取的文件路由，供 Markdown 图片引用
 * 依赖方向：仅依赖类型包；被 index.ts（注册路由）与 bot.ts（发布文件）调用
 * 生命周期：模块级注册表，TTL + 容量上限，进程重启即清空
 * 注意事项：
 *   - QQ 服务器拉图不走 WebUI 鉴权，路由必须以 auth:false 注册
 *   - 索引是模块级共享的：多账号共用同一条 /file 路由，互不干扰
 */
import { randomUUID } from "node:crypto"
import type { RouteHandler } from "@yunzai-ng/types"

/** 文件在插件路由下的挂载段（完整路径为 /plugin/adapter-qqbot/file/:name） */
export const FILE_ROUTE_PATH = "/file"

/** 内核给插件路由加的 URL 前缀 */
export const PLUGIN_URL_PREFIX = "/plugin/adapter-qqbot"

/** 文件保留时长（固定 5 分钟，不做配置）：QQ 在消息渲染时即刻拉取，过期即删 */
const FILE_TTL = 5 * 60 * 1000

/** 最多驻留文件数：超过即淘汰最旧（每项通常是几百 KB 的渲染图） */
const FILE_LIMIT = 100

/** 已发布文件 */
interface PublishedFile {
  /** 文件字节 */
  buffer: Buffer
  /** MIME 类型 */
  mime: string
  /** 发布时间（毫秒） */
  time: number
}

/** name → 文件的注册表；插入序即时间序，淘汰从头删 */
const registry = new Map<string, PublishedFile>()

/** MIME → 扩展名（生成文件名用，识别不出按 png 兜底） */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp"
}

/**
 * 清扫过期文件并在超限时淘汰最旧的
 */
function sweep(): void {
  const now = Date.now()
  for (const [name, file] of registry) {
    if (now - file.time > FILE_TTL) registry.delete(name)
  }
  while (registry.size > FILE_LIMIT) {
    const oldest = registry.keys().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
}

/**
 * 把字节发布为可经 file 路由拉取的文件
 * @param buffer 文件字节
 * @param mime MIME 类型（决定响应 content-type 与文件扩展名）
 * @returns 随机文件名，如 `a1b2c3….png`
 */
export function publishFile(buffer: Buffer, mime?: string): string {
  const type = mime && EXT_BY_MIME[mime] ? mime : "image/png"
  const name = `${randomUUID()}.${EXT_BY_MIME[type]}`
  registry.set(name, { buffer, mime: type, time: Date.now() })
  sweep()
  return name
}

/**
 * 组出文件的完整公网 URL
 * @param baseUrl 对外可达基址（已去掉尾斜杠），如 `http://1.2.3.4:2536` 或穿透域名
 * @param name publishFile 返回的文件名
 * @returns 完整 URL
 */
export function fileUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${PLUGIN_URL_PREFIX}${FILE_ROUTE_PATH}/${name}`
}

/**
 * 当前注册表驻留的文件数（测试用）
 * @returns 文件数量
 */
export function publishedCount(): number {
  return registry.size
}

/**
 * 创建 file 路由的处理器：按文件名回放字节，过期/未知返回 404
 * @returns GET /file/:name 的处理函数
 */
export function createFileRouteHandler(): RouteHandler {
  return req => {
    const name = req.params.name
    const file = registry.get(name)
    if (!file || Date.now() - file.time > FILE_TTL) {
      if (file) registry.delete(name)
      return { status: 404, body: "file not found" }
    }
    return {
      headers: {
        "content-type": file.mime,
        "cache-control": "public, max-age=300"
      },
      body: file.buffer
    }
  }
}
