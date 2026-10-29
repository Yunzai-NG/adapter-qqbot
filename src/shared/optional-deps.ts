/**
 * 模块职责：按需加载可选增强依赖（sharp / qrcode / silk-wasm），缺失则降级
 * 依赖方向：叶子模块，仅依赖内核 Logger 类型
 * 生命周期：进程级记忆化，每个依赖最多加载一次
 * 注意事项：
 *   - 三者均为 optionalDependencies，未安装时返回 undefined 而非抛错
 *   - 沿用 Yunzai 对 sharp 的懒加载降级：装了就增强，没装也能跑
 *   - 用变量做动态 import 说明符，绕开 tsc 对可选模块的静态解析报错
 */
import type { Logger } from "@yunzai-ng/types"

/** sharp 图像实例（仅声明本适配器用到的方法） */
export interface SharpImage {
  /** 读取图片元信息 */
  metadata(): Promise<{ width?: number; height?: number; format?: string; size?: number }>
  /** 缩放 */
  resize(options: { width?: number; height?: number; fit?: "inside" | "outside" | "cover"; withoutEnlargement?: boolean }): SharpImage
  /** 转 JPEG */
  jpeg(options?: { quality?: number }): SharpImage
  /** 转 PNG */
  png(options?: { quality?: number; compressionLevel?: number }): SharpImage
  /** 转 WebP */
  webp(options?: { quality?: number }): SharpImage
  /** 输出字节 */
  toBuffer(): Promise<Buffer>
}

/** sharp 工厂函数 */
export type SharpFactory = (input: Buffer | Uint8Array) => SharpImage

/** qrcode 模块（仅声明用到的方法） */
export interface QrcodeModule {
  /** 生成二维码 PNG 字节 */
  toBuffer(text: string, options?: Record<string, unknown>): Promise<Buffer>
  /** 生成二维码 data URL */
  toDataURL(text: string, options?: Record<string, unknown>): Promise<string>
}

/** silk-wasm 模块（仅声明用到的方法） */
export interface SilkModule {
  /** 编码为 silk */
  encode(input: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array }>
  /** 解码 silk */
  decode(input: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array }>
  /** 计算时长（毫秒） */
  getDuration(silk: Uint8Array, frameMs?: number): number
}

function importOptional(name: string): Promise<unknown> {
  return import(name)
}

function pickModule<T>(mod: unknown): T {
  const withDefault = mod as { default?: T }
  return withDefault.default ?? (mod as T)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let sharpPromise: Promise<SharpFactory | undefined> | undefined
let qrcodePromise: Promise<QrcodeModule | undefined> | undefined
let silkPromise: Promise<SilkModule | undefined> | undefined

/**
 * 懒加载 sharp
 * @param logger 日志器（首次缺失时告警一次）
 * @returns sharp 工厂，未安装返回 undefined（图片不压缩直传）
 */
export function loadSharp(logger?: Logger): Promise<SharpFactory | undefined> {
  if (!sharpPromise) {
    sharpPromise = importOptional("sharp")
      .then(mod => pickModule<SharpFactory>(mod))
      .catch(err => {
        logger?.warn(`[qqbot] sharp 未安装，图片压缩关闭：${errText(err)}`)
        return undefined
      })
  }
  return sharpPromise
}

/**
 * 懒加载 qrcode
 * @param logger 日志器（首次缺失时告警一次）
 * @returns qrcode 模块，未安装返回 undefined（链接保留为纯文本）
 */
export function loadQrcode(logger?: Logger): Promise<QrcodeModule | undefined> {
  if (!qrcodePromise) {
    qrcodePromise = importOptional("qrcode")
      .then(mod => pickModule<QrcodeModule>(mod))
      .catch(err => {
        logger?.warn(`[qqbot] qrcode 未安装，链接转二维码关闭：${errText(err)}`)
        return undefined
      })
  }
  return qrcodePromise
}

/**
 * 懒加载 silk-wasm
 * @param logger 日志器（首次缺失时告警一次）
 * @returns silk-wasm 模块，未安装返回 undefined（语音按原格式上传）
 */
export function loadSilk(logger?: Logger): Promise<SilkModule | undefined> {
  if (!silkPromise) {
    silkPromise = importOptional("silk-wasm")
      .then(mod => pickModule<SilkModule>(mod))
      .catch(err => {
        logger?.warn(`[qqbot] silk-wasm 未安装，语音转码关闭：${errText(err)}`)
        return undefined
      })
  }
  return silkPromise
}
