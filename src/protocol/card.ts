/**
 * 模块职责：把内核 `share` 段编译为 QQ 图文卡片（msg_type=8 的 card）
 * 依赖方向：仅依赖内核 Segment 类型与本地 payload 类型；不执行网络请求
 * 生命周期：无状态纯函数；outbound 决定场景是否允许调用，本模块只管字段合法性
 * 注意事项：
 *   - 卡片仅群聊 / C2C 支持，频道与频道私信由 outbound 直接降级为文本
 *   - 平台对四个字段都有硬约束（长度 / https），凑不齐就整条退回文本，绝不发半成品卡片
 */
import type { ShareSegment } from "@yunzai-ng/types"
import type { MessageCard } from "./types.js"

/** 标题上限：平台要求 1-50 字符 */
export const CARD_TITLE_MAX = 50
/** 描述上限：平台要求 1-200 字符 */
export const CARD_DESCRIPTION_MAX = 200
/** 链接上限：平台要求 url 与 pic_url 均 ≤1024 字符 */
export const CARD_URL_MAX = 1024

/** 卡片构建结果：成卡，或降级原因（交给调用方告警） */
export type CardBuildResult =
  | { ok: true; card: MessageCard }
  | { ok: false; reason: string }

/**
 * 按码点截断超长文本，超出时以省略号收尾
 *
 * 用 `Array.from` 而非 `slice`：QQ 的字符限制按「字符」计，`slice` 会把 emoji 的代理对切半，
 * 发出半个码元反而触发平台的内容校验失败。
 * @param value 原文本
 * @param max 上限（含省略号）
 * @returns 不超长的文本
 */
function truncate(value: string, max: number): string {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return `${chars.slice(0, max - 1).join("")}…`
}

/**
 * 校验链接是否为平台可接受的 https 地址
 *
 * 平台只收 https；这里额外过一遍 URL 解析，把含空白、缺主机、协议拼错的半成品挡在前面，
 * 免得整条消息在平台上失败。
 * @param value 待校验链接
 * @returns 是否为合法 https 链接
 */
function isHttpsUrl(value: string): boolean {
  if (!value || /\s/.test(value)) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * 把分享段编译为图文卡片
 *
 * 平台在 `type=tuwen` 时强制要求 title / description / url / pic_url 四项齐全且合规，
 * 缺一项整条消息就会失败（22006 消息类型与内容不匹配），所以逐项校验后要么给完整卡片，
 * 要么把降级原因交回调用方走文本通道。
 * @param segment 内核分享段
 * @returns 卡片，或无法成卡的原因
 */
export function buildTuwenCard(segment: ShareSegment): CardBuildResult {
  const url = (segment.url ?? "").trim()
  if (!isHttpsUrl(url)) return { ok: false, reason: `分享链接必须是 https 地址（当前：${url || "空"}）` }
  if (url.length > CARD_URL_MAX) return { ok: false, reason: `分享链接超过 ${CARD_URL_MAX} 字符` }

  const picture = (segment.image ?? "").trim()
  if (!picture) return { ok: false, reason: "图文卡片需要封面图，分享段缺少 image" }
  if (!isHttpsUrl(picture)) return { ok: false, reason: `封面图必须是 https 地址（当前：${picture}）` }
  if (picture.length > CARD_URL_MAX) return { ok: false, reason: `封面图地址超过 ${CARD_URL_MAX} 字符` }

  // 标题与描述平台不允许为空：标题退化到链接本身，描述退化到标题
  const title = truncate((segment.title ?? "").trim() || url, CARD_TITLE_MAX)
  const description = truncate((segment.content ?? "").trim() || title, CARD_DESCRIPTION_MAX)

  return {
    ok: true,
    card: { type: "tuwen", content: { title, description, url, pic_url: picture } }
  }
}
