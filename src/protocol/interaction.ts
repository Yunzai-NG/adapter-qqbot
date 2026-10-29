/**
 * 模块职责：QQ 文本交互标签的构建与解析
 * 依赖方向：仅依赖本地类型，不执行网络请求
 * 生命周期：纯函数
 */

/** 可嵌入 Markdown 的指令，或频道内的子频道跳转 */
export type TextInteraction =
  | { type: "cmd-enter"; text: string }
  | { type: "cmd-input"; text: string; show?: string; reference?: boolean }
  | { type: "channel"; channelId: string }

/** 转义 XML 属性值，避免 id 突破标签边界 */
export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** 新版 @ 用户标签；id 为对应场景的 openid */
export function atUser(id: string): string {
  return `<qqbot-at-user id="${escapeXmlAttribute(id)}" />`
}

/** 新版 @全体标签，权限与每日配额由 QQ 平台校验 */
export const AT_EVERYONE = "<qqbot-at-everyone />"

/** 指令参数的 100 字符限制在 URL 编码前校验，不能截断用户指令 */
function commandAttribute(value: string): string {
  if ([...value].length > 100) throw new Error("QQ 文本交互指令参数最多 100 字符")
  return encodeURIComponent(value)
}

/**
 * 构建指令标签：text / show 按官方要求 URL 编码，不做 Markdown 转义
 * @param command 指令与显示参数
 * @returns 可直接嵌入 Markdown 的标签
 */
export function commandTag(command: Exclude<TextInteraction, { type: "channel" }>): string {
  if (!command.text) throw new Error("QQ 文本交互指令 text 不能为空")
  const text = commandAttribute(command.text)
  if (command.type === "cmd-enter") return `<qqbot-cmd-enter text="${text}" />`
  const show = command.show === undefined ? "" : ` show="${commandAttribute(command.show)}"`
  const reference = command.reference === undefined ? "" : ` reference="${command.reference}"`
  return `<qqbot-cmd-input text="${text}"${show}${reference} />`
}

/** 子频道跳转仅接受频道 id，避免拼出其他标签 */
export function channelTag(channelId: string): string {
  if (!/^\d+$/.test(channelId)) throw new Error("QQ 子频道跳转需要数字 channel_id")
  return `<#${channelId}>`
}

/** 读取一个自闭合标签的属性；不完整或重复属性不识别，留给调用方保留原文 */
export function tagAttributes(tag: string): Record<string, string> | undefined {
  const body = /^<qqbot-[\w-]+\s*([\s\S]*?)\s*\/>$/.exec(tag)?.[1]
  if (body === undefined) return undefined
  const attributes: Record<string, string> = {}
  const pattern = /\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let offset = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    if (match.index !== offset || Object.hasOwn(attributes, match[1])) return undefined
    attributes[match[1]] = (match[2] ?? match[3])
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    offset = pattern.lastIndex
  }
  return body.slice(offset).trim() ? undefined : attributes
}

/** 解码 text / show 的 URL 编码；坏编码返回 undefined，调用方保留原标签 */
export function parseCommand(tag: string): TextInteraction | undefined {
  const type = /^<qqbot-(cmd-enter|cmd-input)\b/.exec(tag)?.[1] as "cmd-enter" | "cmd-input" | undefined
  const attributes = tagAttributes(tag)
  if (!type || !attributes?.text) return undefined
  try {
    const text = decodeURIComponent(attributes.text.replace(/\+/g, " "))
    if (!text || [...text].length > 100) return undefined
    if (type === "cmd-enter") return { type, text }
    const show = attributes.show === undefined ? undefined : decodeURIComponent(attributes.show.replace(/\+/g, " "))
    if (show !== undefined && [...show].length > 100) return undefined
    if (attributes.reference !== undefined && !["true", "false"].includes(attributes.reference)) return undefined
    return {
      type,
      text,
      ...(show === undefined ? {} : { show }),
      ...(attributes.reference === undefined ? {} : { reference: attributes.reference === "true" })
    }
  } catch {
    return undefined
  }
}
