/**
 * 模块职责：把配置里的「频道图片压缩上限（MiB）」换算成三条链路的字节阈值
 * 依赖方向：不依赖任何内部模块，纯常量与纯函数
 * 生命周期：无状态
 * 注意事项：
 *   - 配置项只约束**频道**（multipart file_image）。频道接口未公开图片大小上限，
 *     只能按经验给一个保守值，故由用户决定压到多少
 *   - 群聊 / C2C 富媒体与官方素材库改用平台自身的默认最大值：
 *     群聊图片软限 20MB（超过会被降级为文件卡片），素材库单张硬限 10MB
 *   - 阈值语义是「超过才压」，不是「一律压到该值」；没超限的图片原样发送，不损画质
 *   - 配置为 0 表示关闭压缩，三条链路一并原样直传
 */
import { MAX_MEDIA_IMAGE_BYTES } from "./official-image-host.js"

/** 群聊 / C2C 富媒体图片软限：超过会被平台降级为文件卡片 */
export const GROUP_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 官方素材库单张图片硬限 */
export const MEDIA_HOST_IMAGE_MAX_BYTES = MAX_MEDIA_IMAGE_BYTES

/** 三条链路各自的图片压缩阈值（字节） */
export interface ImageLimits {
  /** 频道 multipart 图片：取配置值 */
  channel: number
  /** 群聊 / C2C 富媒体图片：平台软限 */
  group: number
  /** 官方素材库（Markdown 图床）：平台硬限 */
  mediaHost: number
}

/**
 * 按配置换算三条链路的图片阈值
 * @param configMb 配置项「频道图片压缩上限」的 MiB 值
 * @returns 各链路阈值；配置为 0 时全部为 0，即关闭压缩
 */
export function resolveImageLimits(configMb: number): ImageLimits {
  if (!(configMb > 0)) return { channel: 0, group: 0, mediaHost: 0 }
  return {
    channel: Math.round(configMb * 1024 * 1024),
    group: GROUP_IMAGE_MAX_BYTES,
    mediaHost: MEDIA_HOST_IMAGE_MAX_BYTES
  }
}
