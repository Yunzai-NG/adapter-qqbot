/**
 * 模块职责：QQ Markdown 文本、模板参数、图片描述符与交互键盘构建
 * 依赖方向：依赖内核 KeyboardButton 与本地 payload 类型
 * 生命周期：无状态纯函数集合
 * 注意事项：文本中的 @ 与 <qqbot- 必须转义，否则会被平台误判为非法标签
 */
import type { KeyboardButton } from "@yunzai-ng/types"
import type { KeyboardPayload, MarkdownPayload } from "./types.js"

/** QQ Markdown 发送模式 */
export type MarkdownMode = "raw" | "inline" | "template" | "legacy"

/** QQ 键盘内容单个按钮 */
type QQKeyboardButton = NonNullable<NonNullable<KeyboardPayload["content"]>["rows"]>[number]["buttons"][number]

/** 模板槽位构建结果 */
export interface TemplateChunk {
  /** 当前消息使用的模板参数 */
  markdown: MarkdownPayload
  /** 未装入模板的剩余内容（无模板键时才有） */
  overflow?: string
}

/**
 * 转义 QQ Markdown 保留序列
 * @param text 待转义文本
 * @param template 是否模板模式（模板内换行需改为 \r）
 * @returns 可安全发送的文本
 */
export function escapeMarkdown(text: string, template = false): string {
  const escaped = text.replace(/@/g, "@​").replace(/<qqbot-/g, "<qqbot-​")
  return template ? escaped.replace(/\n/g, "\r") : escaped
}

/**
 * 构建 QQ Markdown 图片描述符（平台要求显式宽高）
 * @param url 公网图片 URL
 * @param summary 无障碍摘要
 * @param width 图片宽度，未知传 1000
 * @param height 图片高度，未知传 1000
 * @returns Markdown 图片语法
 */
export function markdownImage(
  url: string,
  summary = "图片",
  width = 1000,
  height = 1000
): string {
  return `![${summary} #${width}px #${height}px](${url})`
}

/**
 * 把内核按钮映射为 QQ 键盘按钮
 * @param button 内核按钮
 * @param index 同一消息内的稳定序号，用于生成缺省按钮 ID
 * @returns QQ 键盘按钮
 */
export function buildKeyboardButton(button: KeyboardButton, index: number): QQKeyboardButton {
  // 官方规范：0=跳转按钮 1=回调按钮 2=指令按钮
  const actionType = button.action === "link" ? 0 : button.action === "callback" ? 1 : 2
  return {
    id: button.id ?? `btn_${index}`,
    render_data: {
      label: button.label,
      visited_label: button.visitedLabel,
      // 核心按钮段不提供 style，统一使用 QQ 默认的灰色线框。
      style: 0
    },
    action: {
      type: actionType,
      permission: { type: 2 },
      data: button.data,
      ...(button.action === "input" && button.enter !== undefined ? { enter: button.enter } : {})
    }
  }
}

/**
 * 构建 QQ 键盘；每行最多 5 个按钮，多余按钮自动换行
 * @param rows 内核键盘行
 * @returns QQ 键盘 payload；空键盘返回 undefined
 */
export function buildKeyboard(rows: readonly (readonly KeyboardButton[])[]): KeyboardPayload | undefined {
  const qqRows: NonNullable<KeyboardPayload["content"]>["rows"] = []
  let index = 0
  for (const sourceRow of rows) {
    for (let offset = 0; offset < sourceRow.length; offset += 5) {
      const buttons = sourceRow.slice(offset, offset + 5).map(button => buildKeyboardButton(button, index++))
      if (buttons.length) qqRows.push({ buttons })
    }
  }
  return qqRows.length ? { content: { rows: qqRows } } : undefined
}

/**
 * 把键盘拆成平台可承载的多个 payload，每个 payload 最多 maxRows 行
 * @param rows 内核键盘行
 * @param maxRows 每条消息最多键盘行数（默认 5）
 * @returns 一个或多个键盘 payload
 */
export function splitKeyboards(
  rows: readonly (readonly KeyboardButton[])[],
  maxRows = 5
): KeyboardPayload[] {
  const keyboard = buildKeyboard(rows)
  const qqRows = keyboard?.content?.rows ?? []
  const result: KeyboardPayload[] = []
  for (let offset = 0; offset < qqRows.length; offset += maxRows) {
    result.push({ content: { rows: qqRows.slice(offset, offset + maxRows) } })
  }
  return result
}

/**
 * 把文本按模板键切成多个 Markdown 模板消息
 * @param content 已转义正文
 * @param templateId 自定义模板 id
 * @param keys 模板槽位键序列
 * @returns 每个模板消息的 payload；空内容也至少产生一条
 */
export function buildTemplateMarkdown(
  content: string,
  templateId: string,
  keys: string
): MarkdownPayload[] {
  const slots = [...keys]
  if (!slots.length) return [{ custom_template_id: templateId, params: [] }]

  // 调用方已经按照当前模式转义正文，不能在这里重复插入零宽字符。
  // 保留图片描述符的文本 / URL 边界，避免单个参数跨越模板平台限制。
  const units = content.match(/!\[[^\]]*\]\([^)]*\)|[^\r]+\r?|\r/g) ?? [content]
  const payloads: MarkdownPayload[] = []

  for (let offset = 0; offset < units.length || payloads.length === 0; offset += slots.length) {
    const chunk = units.slice(offset, offset + slots.length)
    payloads.push({
      custom_template_id: templateId,
      params: chunk.map((value, index) => ({ key: slots[index], values: [value] }))
    })
  }
  return payloads
}

/**
 * 转义 XML 属性值，避免按钮内容突破 QQ 命令标签边界
 * @param value 原始属性值
 * @returns 可安全嵌入双引号属性的值
 */
function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

/**
 * 把键盘转换为无交互能力时仍可读的普通文本
 * @param rows 内核键盘行
 * @returns 标签与参数组成的文本
 */
export function keyboardAsPlainText(rows: readonly (readonly KeyboardButton[])[]): string {
  const lines = rows.map(row => row.map(button => {
    const label = `[${button.label}]`
    return button.data ? `${label} ${button.data}` : label
  }).join(" ")).filter(Boolean)
  return lines.length ? `\n${lines.join("\n")}` : ""
}

/**
 * inline 模式下把按钮转换为可点击文本链
 * @param rows 内核键盘行
 * @returns QQ 命令输入标签文本
 */
export function keyboardAsInlineText(rows: readonly (readonly KeyboardButton[])[]): string {
  const lines = rows.map(row => row.flatMap(button => {
    if (!button.data) return []
    const text = escapeXmlAttribute(escapeMarkdown(button.data))
    const show = escapeXmlAttribute(escapeMarkdown(button.label))
    return [`<qqbot-cmd-input text="${text}" show="[${show}]" />`]
  }).join(" ")).filter(Boolean)
  return lines.length ? `\n${lines.join("\n")}` : ""
}
