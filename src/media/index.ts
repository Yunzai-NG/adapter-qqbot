/**
 * 模块职责：media 领域的统一出口
 * 依赖方向：依赖 protocol / transport / shared；不依赖 messaging / bot
 * 生命周期：图床实例随账号创建，框架文件服务为模块级单例
 * 注意事项：图片「从哪来、传到哪去、能不能被 QQ 拉到」全部收敛在本目录
 */
export * from "./resolve.js"
export * from "./image-to-url.js"
export * from "./official-image-host.js"
export * from "./file-server.js"
export * from "./probe.js"
