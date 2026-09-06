/**
 * 模块职责：插件入口 - 将 QQ Bot 适配器注册至内核
 * 依赖方向：仅依赖 @yunzai-ng/core 的公开入口与 @yunzai-ng/types
 * 生命周期：setup 在插件加载时执行一次，返回后适配器即可被账号引用
 * 注意事项：
 *   - QQ Bot 的登录在 QQ 开放平台完成，不属于本框架流程
 *   - 账号配置中填写的是 AppID 和 AppSecret
 */
import { definePlugin } from "@yunzai-ng/core"
import type { AdapterHost, AdapterProvider, BotDriver, PluginDefinition } from "@yunzai-ng/types"
import { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
import type { QQBotAccount } from "./config.js"
import { createQQBotBot } from "./bot.js"
import { PLATFORM } from "./codec.js"
import { createWebhookHandler } from "./webhook.js"
import type { WebhookHandlerInfo } from "./webhook.js"

/** 适配器 id */
export const ADAPTER_ID = "qqbot"

export { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
export type { QQBotAccount, QQBotMode } from "./config.js"

/** Webhook 处理器注册表：appId → handler info */
const webhookHandlers = new Map<string, WebhookHandlerInfo>()

/** 注册 webhook 处理器 */
export function registerWebhookHandler(appId: string, info: WebhookHandlerInfo): void {
  webhookHandlers.set(appId, info)
}

/** 注销 webhook 处理器 */
export function unregisterWebhookHandler(appId: string): void {
  webhookHandlers.delete(appId)
}

/** 插件定义 */
const plugin: PluginDefinition<Record<string, never>> = definePlugin({
  name: "adapter-qqbot",
  version: "0.1.0",
  description: "QQ Bot 官方机器人适配器：WebSocket Gateway / Webhook 双模式",
  priority: 10,

  setup(ctx) {
    // 注册 webhook 路由：/qqbot（统一入口，通过 header 区分账号）
    ctx.route("POST", "/qqbot", createWebhookHandler(webhookHandlers), {
      auth: false,
      rawBody: true,
      bodyLimit: 2 * 1024 * 1024
    })
    ctx.logger.info("QQ Bot Webhook 路由已注册：/plugin/adapter-qqbot/qqbot")

    const provider: AdapterProvider<QQBotAccount> = {
      id: ADAPTER_ID,
      name: "QQ Bot (官方机器人)",
      description: "连接 QQ 官方机器人平台。需在 QQ 开放平台注册并获取 AppID 和 AppSecret",
      platform: PLATFORM,
      accountSchema: ACCOUNT_SCHEMA.describe(),
      validateAccount,

      createBot(account: QQBotAccount, host: AdapterHost): BotDriver {
        return createQQBotBot(account, host, { adapterId: ADAPTER_ID, http: ctx.http })
      }
    }

    ctx.registerAdapter(provider as unknown as AdapterProvider)
    ctx.logger.info("QQ Bot 适配器已注册，可在面板的账号页面添加账号")
  }
})

export default plugin