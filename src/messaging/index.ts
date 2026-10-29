/**
 * 模块职责：messaging 领域的统一出口
 * 依赖方向：依赖 protocol / media；不依赖 bot
 * 生命周期：无状态；入站解码与出站编译都是纯函数
 * 注意事项：outbound 只产出计划、不执行网络请求；inbound 只产出内核事件、不提交
 */
export * from "./outbound.js"
export * from "./inbound.js"
