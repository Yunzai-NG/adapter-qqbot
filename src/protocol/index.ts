/**
 * 模块职责：protocol 领域的统一出口
 * 依赖方向：本目录内部只依赖 @yunzai-ng/types，不依赖 transport / media / bot
 * 生命周期：无状态；全部是类型定义与纯函数
 * 注意事项：本目录只做「数据 ↔ 数据」的变换，任何网络与文件 IO 都不属于这里
 */
export * from "./types.js"
export * from "./codec.js"
export * from "./markdown.js"
export * from "./card.js"
export * from "./interaction.js"
