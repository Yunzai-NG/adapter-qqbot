/**
 * 模块职责：transport 领域的统一出口
 * 依赖方向：依赖 protocol 与 @yunzai-ng/types；不依赖 media / messaging / bot
 * 生命周期：TokenManager / ApiClient / Gateway 随账号创建，注册表为模块级单例
 * 注意事项：本目录只与平台做 IO —— HTTP、WebSocket、Webhook 与富媒体上传
 */
export * from "./auth.js"
export * from "./api.js"
export * from "./gateway.js"
export * from "./webhook.js"
export * from "./upload.js"
