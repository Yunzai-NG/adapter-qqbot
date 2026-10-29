/**
 * 模块职责：bot 领域的统一出口
 * 依赖方向：组合同目录的 context / connection / send / query / manage
 * 生命周期：createQQBotBot 由适配器入口在账号启用时调用一次
 * 注意事项：外部只认这个出口，能力模块的具体位置属于实现细节
 */
export { createQQBotBot } from "./driver.js"
export { MESSAGE_TARGET_TTL } from "./context.js"
export { MSG_SEQ_MAX, REPLY_WINDOW_MS } from "./reply-guard.js"
export type { BotContext, BotDeps } from "./context.js"
export type { MessageDeduper, SequenceTracker } from "./reply-guard.js"
export type { ConnectionApi } from "./connection.js"
export type { SendApi } from "./send.js"
export type { QueryApi } from "./query.js"
export type { ManageApi } from "./manage.js"
