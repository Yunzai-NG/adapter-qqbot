/**
 * 模块职责：账号配置的 schema、类型与校验
 * 依赖方向：仅依赖内核的 schema 工具、类型包与本地 URL 判定
 * 生命周期：模块加载期构造一次 schema，之后只读
 * 注意事项：
 *   - QQ Bot 使用 AppID + AppSecret 获取 Access Token
 *   - 支持 WebSocket Gateway 和 Webhook 两种模式
 *   - WebSocket 模式需要配置 intents 和 shard
 */
import { s, SchemaError } from "@yunzai-ng/core"
import type { Infer, SchemaIssue } from "@yunzai-ng/core"
import { isPublicHttpUrl } from "./shared/public-url.js"

/** 网络模式 */
export type QQBotMode = "websocket" | "webhook"

/** 预设订阅模式（单选） */
export const SUBSCRIPTION_PRESETS = [
  { value: "guild_public", label: "频道公域", description: "仅接收频道公域消息（PUBLIC_GUILD_MESSAGES）" },
  { value: "guild_private", label: "频道私域", description: "仅接收频道私域消息（GUILD_MESSAGES + FORUMS_EVENT）" },
  { value: "group", label: "群聊", description: "仅接收群聊和单聊消息（GROUP_AND_C2C_EVENT）" },
  { value: "guild_public_group", label: "频道公域 + 群聊", description: "频道公域消息 + 群聊单聊消息" },
  { value: "guild_private_group", label: "频道私域 + 群聊", description: "频道私域消息 + 群聊单聊消息" }
] as const

/** 预设对应的 intents 值 */
export const PRESET_INTENTS: Record<string, number> = {
  // 频道公域：PUBLIC_GUILD_MESSAGES(30) + GUILDS(0) + GUILD_MEMBERS(1) + GUILD_MESSAGE_REACTIONS(10) + DIRECT_MESSAGE(12) + AUDIO_ACTION(29)
  guild_public: (1 << 30) | (1 << 0) | (1 << 1) | (1 << 10) | (1 << 12) | (1 << 29),
  // 频道私域：GUILD_MESSAGES(9) + GUILDS(0) + GUILD_MEMBERS(1) + GUILD_MESSAGE_REACTIONS(10) + DIRECT_MESSAGE(12) + AUDIO_ACTION(29) + FORUMS_EVENT(28)
  guild_private: (1 << 9) | (1 << 0) | (1 << 1) | (1 << 10) | (1 << 12) | (1 << 29) | (1 << 28),
  // 群聊：GROUP_AND_C2C_EVENT(25) + GROUP_MEMBER(24)
  group: (1 << 25) | (1 << 24),
  // 频道公域 + 群聊
  guild_public_group: (1 << 30) | (1 << 0) | (1 << 1) | (1 << 10) | (1 << 12) | (1 << 29) | (1 << 25) | (1 << 24),
  // 频道私域 + 群聊
  guild_private_group: (1 << 9) | (1 << 0) | (1 << 1) | (1 << 10) | (1 << 12) | (1 << 29) | (1 << 28) | (1 << 25) | (1 << 24),
  // 附加：INTERACTION(26) + MESSAGE_AUDIT(27)
  all: (1 << 26) | (1 << 27)
}

/** 账号配置 schema */
export const ACCOUNT_SCHEMA = s.object({
  mode: s
    .select([
      {
        value: "websocket",
        label: "WebSocket Gateway",
        description: "框架主动连接 QQ 官方 Gateway，实时接收事件。推荐用于大多数场景"
      },
      {
        value: "webhook",
        label: "Webhook 回调",
        description: "QQ 平台将事件 POST 至框架。适用于无法建立长连接的环境"
      }
    ])
    .default("websocket")
    .title("连接方式")
    .desc("须与 QQ 开放平台的配置保持一致")
    .order(1),

  appId: s
    .string()
    .title("AppID")
    .desc("QQ 开放平台分配的机器人 AppID")
    .placeholder("请输入 AppID")
    .order(2),

  appSecret: s
    .password()
    .default("")
    .title("AppSecret")
    .desc("QQ 开放平台分配的机器人密钥，用于获取 Access Token 和签名验证")
    .order(3),

  robotUin: s
    .string()
    .default("")
    .title("机器人 QQ 号（可选）")
    .desc("机器人的真实 QQ 号，用于日志显示。留空则显示 open_id")
    .placeholder("如 2854215615")
    .order(5),

  subscription: s
    .select(SUBSCRIPTION_PRESETS)
    .default("group")
    .title("事件订阅")
    .desc("选择预设订阅模式。频道公域和私域不能同时订阅")
    .showWhen({ mode: ["websocket"] })
    .order(10),

  shard: s
    .string()
    .default("0/1")
    .title("分片配置")
    .desc("格式：分片ID/分片总数，如 0/1。多机器人部署时使用")
    .showWhen({ mode: ["websocket"] })
    .order(11),

  sandbox: s
    .boolean()
    .default(false)
    .title("沙箱模式")
    .desc("启用后将使用沙箱环境进行测试")
    .order(12),

  guildMarkdown: s
    .boolean()
    .default(false)
    .title("频道 Markdown")
    .desc("启用后频道消息将使用 Markdown 格式发送（需要原生md权限，暂不支持模板md）")
    .group("消息")
    .order(13),

  groupMarkdown: s
    .boolean()
    .default(false)
    .title("群聊 Markdown")
    .desc("启用后群聊消息将使用 Markdown 格式发送（需 Markdown 权限）")
    .group("消息")
    .order(14),

  markdownMode: s
    .select([
      { value: "raw", label: "原生 Markdown", description: "原生 Markdown + 交互键盘" },
      { value: "inline", label: "内联指令", description: "原生 Markdown + 文本指令链" },
      { value: "template", label: "模板 Markdown", description: "按配置的模板 ID 与参数键发送" },
      { value: "legacy", label: "纯文本", description: "禁用富 Markdown，按普通消息拆分" }
    ])
    .default("raw")
    .title("Markdown 模式")
    .desc("Markdown 总开关开启时采用的发送策略")
    .group("消息")
    .order(15),

  markdownTemplateId: s
    .string()
    .default("")
    .title("Markdown 模板 ID")
    .desc("template 模式使用的 custom_template_id")
    .showWhen({ markdownMode: ["template"] })
    .group("消息")
    .order(16),

  markdownTemplateKeys: s
    .string()
    .default("abcdefghij")
    .title("模板参数键")
    .desc("按顺序填写模板参数 key，例如 abcdefghij")
    .showWhen({ markdownMode: ["template"] })
    .group("消息")
    .order(17),

  keyboardTemplateId: s
    .string()
    .default("")
    .title("键盘模板 ID")
    .desc("留空时发送自定义按钮内容，填写后使用平台按钮模板")
    .showWhen({ markdownMode: ["raw", "template"] })
    .group("消息")
    .order(18),

  forwardMode: s
    .select([
      { value: "merge", label: "合并", description: "转发的多个节点合并进一条消息发送" },
      { value: "multiple", label: "多条", description: "转发的每个节点各自作为一条消息发送" }
    ])
    .default("merge")
    .title("转发消息格式")
    .desc("合并把各节点文本拼进一条消息；多条按节点拆成多条。含图片/视频等富媒体时仍会因平台单条限制单独成条")
    .group("消息")
    .order(22),

  officialImage: s
    .boolean()
    .default(true)
    .title("官方图床")
    .desc("图片上传的第一级：传到 QQ 素材库换取 qqbot-media:// 引用，不依赖公网地址；配额满且未到释放间隔时回退框架图床")
    .group("图片")
    .order(14),

  serverAddress: s
    .string()
    .default("")
    .title("文件服务地址")
    .desc("图片上传的第二级：把图片发布为临时公网链接。必须是公网可达地址，回环 / 内网地址 QQ 服务器拉不到会被跳过；留空则用内核面板地址")
    .group("图片")
    .placeholder("https://公网域名 或 http://公网IP:端口")
    .order(16),

  imageSaveSeconds: s
    .number()
    .default(14400)
    .min(60)
    .max(7776000)
    .title("图片保存时间（秒）")
    .desc("官方上传任务 4 小时（14400 秒）后自动过期，超过该时长会重新上传；适配器也会按该时间定时清理素材库里的旧图，配额满时同样触发。清理只释放配额，不影响已发送的消息。图片引用本身是滑动过期：被消息引用即顺延，90 天（7776000 秒）未被引用才失效")
    .group("图片")
    .order(18),

  imageMaxSizeMb: s
    .number()
    .default(4)
    .min(1)
    .title("图片压缩上限（MiB）")
    .desc("sharp 可用时将超限图片压缩；未安装则原样发送")
    .group("图片")
    .order(19),

  listenPath: s
    .string()
    .default("/qqbot")
    .title("Webhook 监听路径")
    .desc("Webhook 模式下接收事件的 URL 路径")
    .showWhen({ mode: ["webhook"] })
    .order(20)
})

/** 账号配置类型 */
export type QQBotAccount = Infer<typeof ACCOUNT_SCHEMA>

/**
 * 校验账号配置
 * @param input 面板提交的原始对象
 * @returns 规范化后的配置
 * @throws SchemaError 校验不通过
 */
export function validateAccount(input: unknown): QQBotAccount {
  const inputObj = input as Record<string, unknown>

  // 如果输入已有 intents 字段，说明是第二次调用（连接时），直接返回
  if (inputObj.intents !== undefined) {
    return input as QQBotAccount
  }

  // 旧版的「图床类型」单选已改为链路取址（直链 → 官方 → 框架），「图床脚本路径」也已移除：
  // 显式选过框架图床的按「关闭官方图床」迁移，其余一律沿用链路默认值；脚本字段由 schema 丢弃
  const source: Record<string, unknown> = { ...inputObj }
  if (source.imageHostType !== undefined) {
    if (source.officialImage === undefined) source.officialImage = source.imageHostType !== "framework"
    delete source.imageHostType
  }
  delete source.imageHostScript

  const account = ACCOUNT_SCHEMA.parse(source)
  const issues: SchemaIssue[] = []

  if (!account.appId.trim()) {
    issues.push({ path: "appId", message: "AppID 不能为空", severity: "error" })
  }

  if (!account.appSecret.trim()) {
    issues.push({
      path: "appSecret",
      message: "AppSecret 不能为空",
      severity: "error"
    })
  }

  if (account.mode === "websocket") {
    const shardParts = account.shard.split("/")
    if (shardParts.length !== 2) {
      issues.push({
        path: "shard",
        message: "分片格式错误，应为 '分片ID/分片总数'，如 '0/1'",
        severity: "error"
      })
    } else {
      const [shardId, shardCount] = shardParts.map(Number)
      if (isNaN(shardId) || isNaN(shardCount) || shardId < 0 || shardCount < 1 || shardId >= shardCount) {
        issues.push({
          path: "shard",
          message: "分片 ID 必须小于分片总数，且均为非负整数",
          severity: "error"
        })
      }
    }
  }

  if (account.mode === "webhook") {
    const path = account.listenPath.trim()
    if (!path.startsWith("/")) {
      issues.push({
        path: "listenPath",
        message: "路径应以 / 开头",
        severity: "error"
      })
    }
  }

  // 文件服务地址是框架图床（最后一级）的基址，填了就必须是合法 http(s)
  const serverAddress = account.serverAddress.trim()
  if (serverAddress && !/^https?:\/\//i.test(serverAddress)) {
    issues.push({
      path: "serverAddress",
      message: "文件服务地址应以 http:// 或 https:// 开头",
      severity: "error"
    })
  } else if (serverAddress && !isPublicHttpUrl(serverAddress)) {
    // 不拦保存：内网部署常先填内网地址，配合官方图床仍可用；但框架图床那一级会被跳过
    issues.push({
      path: "serverAddress",
      message: "该地址不是公网可达地址（回环 / 内网段），框架图床会被跳过，QQ 服务器拉不到这张图",
      severity: "warn"
    })
  }

  if (issues.length > 0) throw new SchemaError(issues)

  const result = {
    ...account,
    appId: account.appId.trim(),
    appSecret: account.appSecret.trim()
  } as Record<string, unknown>

  // 根据预设订阅计算 intents 值
  if (result.mode === "websocket") {
    const preset = (result.subscription as string) || "group"
    let intents = PRESET_INTENTS[preset] || 0
    // 默认添加 INTERACTION 和 MESSAGE_AUDIT
    intents |= PRESET_INTENTS.all
    result.intents = intents
    delete result.subscription
  }

  // webhook 模式下移除 intents 字段
  if (result.mode === "webhook") {
    delete result.intents
    delete result.subscription
  }

  return result as QQBotAccount
}

/**
 * 解析分片配置
 * @param shard 分片字符串，如 "0/1"
 * @returns [shardId, shardCount]
 */
export function parseShard(shard: string): [number, number] {
  const [id, count] = shard.split("/").map(Number)
  return [id || 0, count || 1]
}
