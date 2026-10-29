/**
 * 模块职责：BotDriver 组装 —— 把四个能力模块拼成内核要求的统一接口
 * 依赖方向：依赖同目录的 context / connection / send / query / manage，无其他内部依赖
 * 生命周期：一个账号对应一个实例，connect() 与 disconnect() 各调用一次
 * 注意事项：
 *   - QQ Bot 使用 open_id 标识用户、group_openid 标识群、qg_ 前缀标识频道
 *   - 本文件只做装配与 callApi 透传，不承载任何业务分支
 *   - 能力划分：connection（连接/入站）、send（出站）、query（查询）、manage（群管）
 */
import type { AdapterHost, BotCapability, BotDriver } from "@yunzai-ng/types"
import type { QQBotAccount } from "../config.js"
import { PLATFORM } from "../protocol/codec.js"
import { createBotContext } from "./context.js"
import type { BotDeps } from "./context.js"
import { createConnection } from "./connection.js"
import { createSender } from "./send.js"
import { createQuery } from "./query.js"
import { createManager } from "./manage.js"

/** 声明支持的能力 */
const CAPS: readonly BotCapability[] = [
  "recall",
  "forward",
  "groupMute",
  "groupKick",
  "groupRequest",
  "groupFile",
  "reaction",
  "markdown",
  "keyboard",
  "guild"
]

/**
 * 把参数对象拼成查询串（GET / DELETE 用）
 * @param params 调用参数
 * @returns 形如 `cursor=abc&limit=10` 的查询串；无有效参数时为空串
 */
function toQueryString(params?: Record<string, unknown>): string {
  if (!params) return ""
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    search.set(key, String(value))
  }
  return search.toString()
}

/** 创建 BotDriver */
export function createQQBotBot(account: QQBotAccount, host: AdapterHost, deps: BotDeps): BotDriver {
  const ctx = createBotContext(account, host, deps)
  const connection = createConnection(ctx)
  const sender = createSender(ctx)
  const query = createQuery(ctx)
  const manager = createManager(ctx)

  return {
    platform: PLATFORM,
    adapterId: deps.adapterId,
    caps: new Set(CAPS),

    get selfId(): string {
      return ctx.selfId
    },
    get nickname(): string {
      return ctx.nickname
    },
    get online(): boolean {
      return connection.online()
    },

    connect: () => connection.connect(),
    disconnect: () => connection.disconnect(),

    ...sender,
    ...query,
    ...manager,

    callApi<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      // 互动回调应答（按钮点击）：PUT /interactions/{interaction_id}
      if (action === "replyInteraction") {
        return ctx.api.replyInteraction(
          String(params?.interactionId ?? params?.interaction_id ?? ""),
          Number(params?.code ?? 0)
        ) as Promise<T>
      }

      // 插件主动删除官方素材后，同步失效本地缓存，避免继续引用已删链接（40035009）
      if (action === "forgetOfficialImage") {
        ctx.officialImageHost.forget(String(params?.url ?? ""))
        return Promise.resolve(undefined as T)
      }

      // 支持 "GET /v2/media-images" 这类「方法 + 路径」写法：素材查询 / 删除需要 GET 与 DELETE，
      // 而通用出口默认只发 POST。参数在 GET / DELETE 下拼进查询串
      const routed = /^([A-Za-z]+)\s+(\/\S*)$/.exec(action.trim())
      if (routed) {
        const method = routed[1].toUpperCase()
        const path = routed[2]
        if (method === "GET" || method === "DELETE") {
          const query = toQueryString(params)
          return ctx.api.call<T>(method, query ? `${path}?${query}` : path)
        }
        return ctx.api.call<T>(method, path, params)
      }

      return ctx.api.call<T>("POST", action, params)
    }
  }
}
