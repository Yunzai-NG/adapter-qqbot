/**
 * 模块职责：Webhook 处理器注册表（appId → handler info）
 * 依赖方向：仅依赖 webhook 的类型定义
 * 生命周期：模块级单例，随插件加载存在
 * 注意事项：
 *   - 单独成模块，避免 bot.ts 与 index.ts 互相 import 形成循环依赖
 *   - index.ts 消费注册表构建路由，bot.ts 在连接/断开时增删条目
 */
import type { WebhookHandlerInfo } from "./webhook.js"

/** appId → handler info 的全局注册表 */
export const webhookRegistry = new Map<string, WebhookHandlerInfo>()

/** 注册 webhook 处理器 */
export function registerWebhookHandler(appId: string, info: WebhookHandlerInfo): void {
  webhookRegistry.set(appId, info)
}

/** 注销 webhook 处理器 */
export function unregisterWebhookHandler(appId: string): void {
  webhookRegistry.delete(appId)
}
