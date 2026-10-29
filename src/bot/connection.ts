/**
 * 模块职责：连接生命周期 —— WebSocket / Webhook 两种模式的上线、下线与入站事件入口
 * 依赖方向：依赖 transport（gateway / webhook）与 messaging/inbound（事件解码）
 * 生命周期：随 createQQBotBot 创建；connect() 与 disconnect() 各调用一次
 * 注意事项：
 *   - 两种模式共用同一条 ingest 管道，事件解码与提交内核只写一份
 *   - 官方素材的定时清理跟着连接走：连上后启动，断开即停
 *   - 频道私信事件要在解码前拦下，记录 uid → guildId 映射（键带 qg_ 前缀）
 */
import type { HttpClient } from "@yunzai-ng/types"
import { addGuildPrefix } from "../protocol/codec.js"
import type { Attachment, ReadyData, WSPayload } from "../protocol/types.js"
import { decodeEvent, describeAttachments, describeQuote } from "../messaging/inbound.js"
import { Gateway } from "../transport/gateway.js"
import {
  Ed25519,
  WEBHOOK_CALLBACK_PATH,
  WEBHOOK_ROUTE_PATH,
  registerWebhookHandler,
  unregisterWebhookHandler
} from "../transport/webhook.js"
import { normalizeSaveSeconds, sweepIntervalMs } from "../media/official-image-host.js"
import { isPublicHttpUrl } from "../shared/public-url.js"
import type { BotContext } from "./context.js"

/** share_info 接口地址 */
const SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
/** share_info 接口固定的 bkn 参数 */
const SHARE_INFO_BKN = 508459323

/** 连接能力面 */
export interface ConnectionApi {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** 当前是否已就绪 */
  online(): boolean
  /** 事件入口：Webhook 模式由路由处理器调用 */
  ingest(eventType: string, data: unknown): void
}

/** 获取机器人真实 QQ 号 */
async function getRobotUin(appId: string, http: HttpClient): Promise<string | null> {
  try {
    const response = await http.request<{ data?: { robot_data?: { robot_uin?: string } } }>(
      `${SHARE_INFO_URL}?bkn=${SHARE_INFO_BKN}&robot_appid=${appId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36"
        },
        responseType: "json",
        throwOnError: false
      }
    )
    return response.data?.data?.robot_data?.robot_uin ?? null
  } catch {
    return null
  }
}

/**
 * 把间隔渲染成日志友好的文案
 * @param ms 间隔毫秒数
 * @returns 如「1 小时」「30 分钟」
 */
function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`
  return `${Math.round(ms / 60_000)} 分钟`
}

/** 建立连接能力 */
export function createConnection(ctx: BotContext): ConnectionApi {
  const { account, host, deps } = ctx

  /** 官方素材定时清理的计时器 */
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  /** 首轮清理的一次性计时器 */
  let sweepKickoff: ReturnType<typeof setTimeout> | undefined
  /** 正在清理：避免上一轮没跑完又叠一轮 */
  let sweeping = false

  /** 停掉定时清理（重复调用安全） */
  function stopImageSweep(): void {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer)
      sweepTimer = undefined
    }
    if (sweepKickoff !== undefined) {
      clearTimeout(sweepKickoff)
      sweepKickoff = undefined
    }
  }

  /** 跑一轮清理：删除超过保存时间的旧素材，释放配额 */
  async function runImageSweep(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      const removed = await ctx.officialImageHost.sweep()
      if (removed > 0) host.logger.info(`[qqbot] 官方素材定时清理：释放 ${removed} 张超过保存时间的旧图`)
    } catch (err) {
      host.logger.warn(`[qqbot] 官方素材定时清理失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      sweeping = false
    }
  }

  /**
   * 启动官方素材的定时清理
   *
   * 只在启用官方图床时启动：发图量大的机器人容易把 100 张配额塞满，
   * 与其等上传失败再临时清理，不如按保存时间滚动释放。连接后先补跑一轮，
   * 把停机期间积攒的旧图清掉。
   */
  function startImageSweep(): void {
    stopImageSweep()
    if (!account.officialImage) return

    const intervalMs = sweepIntervalMs(account.imageSaveSeconds)
    sweepTimer = setInterval(() => { void runImageSweep() }, intervalMs)
    sweepTimer.unref?.()
    sweepKickoff = setTimeout(() => { void runImageSweep() }, 30_000)
    sweepKickoff.unref?.()
    host.logger.info(`[qqbot] 官方素材定时清理已启用：每 ${formatInterval(intervalMs)}检查一次`)
  }

  /** 解析机器人自身 id：配置优先，否则向平台查询 */
  function resolveSelfId(fallback: string): Promise<string> {
    if (account.robotUin) return Promise.resolve(account.robotUin)
    return getRobotUin(account.appId, deps.http).then(uin => uin ?? fallback)
  }

  /** 事件入口：gateway onEvent 与 webhook handler 共用 */
  function ingest(eventType: string, data: unknown): void {
    // 拦截频道私信事件，记录 uid → guildId 映射
    // （键与 decodeDirectMessage 产出的带 qg_ 前缀 uid 保持一致）
    if (eventType === "DIRECT_MESSAGE_CREATE") {
      const dmData = data as { author?: { id?: string }; guild_id?: string }
      if (dmData.author?.id && dmData.guild_id) {
        ctx.directMessageGuildMap.set(addGuildPrefix(dmData.author.id), dmData.guild_id)
      }
    }

    // selfId 必须传：报文里 @ 机器人用的是 openid，核心的 atMe 却拿 at.uid 与真实 QQ 号比较，
    // 不归一化则群聊 / 频道里 e.atMe 恒为 false
    const event = decodeEvent(eventType, data, host.logger, ctx.selfId)
    if (!event) return

    if (event.kind === "message") {
      // 平台会把同一条消息重复推送（WebSocket 重连补发、Webhook 重试、平台侧抖动）。
      // 同一 msg_id 只处理一次，否则一次提问会触发多次回复。
      // 键里带场景：不同场景的 messageId 命名空间不同，避免理论上撞车。
      const dedupeKey = `${event.scene}:${event.messageId}`
      if (event.messageId && ctx.dedupe.seen(dedupeKey)) {
        host.logger.debug(`[qqbot] 重复推送已跳过：${dedupeKey}`)
        return
      }

      const where = event.scene === "group"
        ? `群 ${event.group?.gid ?? "?"}`
        : event.scene === "guild"
          ? `频道 ${event.channel?.channelId ?? "?"}`
          : `私聊 ${event.sender.uid}`
      const who = `${event.sender.name ?? ""}(${event.sender.uid})`

      // 附件详情（图片/语音/视频/文件）：平台下发的原始字段（含 id/size），
      // 内核那行 `[图片 …]` 只给摘要，这里补齐可核对/可抓取的细节。
      // 默认 debug 级：仅在 log.level=debug 时输出，避免刷屏
      const attachments = (data as { attachments?: Attachment[] } | null)?.attachments
      if (attachments?.length) {
        host.logger.debug(`[qqbot] 附件详情 [${where}] ${who}：${describeAttachments(attachments)}`)
      }

      // 引用详情：群 / C2C 的被引正文由平台内联下发，这里确认解析结果。
      // 默认 debug 级：仅在 log.level=debug 时输出，避免刷屏
      if (event.quote) {
        host.logger.debug(`[qqbot] 引用详情 [${where}] ${who}：${describeQuote(event.quote)}`)
      }

      const target = event.scene === "group"
        ? { scene: "group" as const, gid: event.group!.gid }
        : event.scene === "guild"
          ? { scene: "guild" as const, guildId: event.channel!.guildId, channelId: event.channel!.channelId }
          : { scene: "private" as const, uid: event.sender.uid }
      ctx.rememberReplyContext(target, event.messageId)
    }
    host.submit(event)
  }

  const gateway = new Gateway(
    account,
    ctx.tokenManager,
    {
      onEvent: (eventType, data) => ingest(eventType, data),
      onReady: async (data: ReadyData) => {
        ctx.nickname = data.user.username
        ctx.selfId = await resolveSelfId(data.user.id)
        host.logger.debug(`已连接 QQ Bot：${ctx.nickname} (${ctx.selfId})`)
        host.setStatus("online")
      },
      onClosed: (reason) => {
        host.setStatus("offline", { error: reason })
      }
    },
    host.logger
  )

  /** Webhook 模式的注册与提示 */
  function connectWebhook(): void {
    // 注册处理器到统一入口，复用同一条 ingest 管道
    registerWebhookHandler(account.appId, {
      handler: (appId: string, packet: WSPayload) => {
        if (packet.op === 0 && packet.t) ingest(packet.t, packet.d)
      },
      ed25519: new Ed25519(account.appSecret)
    })

    // 每次重连都会打，只留一行：当前 Webhook 地址，可直接复制到开放平台
    const base = host.server.publicUrl.replace(/\/+$/, "")
    host.logger.info(`[qqbot] Webhook 模式已启用，当前地址为：${base}${WEBHOOK_CALLBACK_PATH}`)

    if (!host.server.enabled) {
      host.logger.error(
        "[qqbot] 内置 HTTP 服务未启用（server.enable=false），Webhook 收不到任何回调。" +
          "请在面板开启内置服务器并配置反向代理后，再到开放平台保存回调地址"
      )
    }

    const configuredPath = account.listenPath.trim()
    if (configuredPath !== WEBHOOK_ROUTE_PATH) {
      host.logger.warn(
        `[qqbot] 「Webhook 监听路径」配成了 ${configuredPath}，该配置不参与路由（固定为 ${WEBHOOK_ROUTE_PATH}），按上面给出的地址填即可`
      )
    }

    // 自测命令放在 info：出问题时能直接从面板整条复制，不必再调日志级别。
    // AppID 取自当前账号配置；注意 cmd 不认单引号，故用 --data-raw + 转义双引号
    host.logger.info(
      `[qqbot] 本机自测：curl -i -X POST http://127.0.0.1:${host.server.port}${WEBHOOK_CALLBACK_PATH} ` +
        `-H "content-type: application/json" -H "X-Bot-Appid: ${account.appId}" ` +
        '--data-raw "{\\"op\\":13,\\"d\\":{\\"plain_token\\":\\"test\\",\\"event_ts\\":\\"1725442341\\"}}"'
    )

    host.setStatus("online")
  }

  /** 连接前的图床可用性提示 */
  function warnImageHost(): void {
    // 一级：官方素材库
    if (account.officialImage) {
      const saveSeconds = normalizeSaveSeconds(account.imageSaveSeconds)
      const humanized = saveSeconds % 3600 === 0 ? `${saveSeconds / 3600} 小时` : `${Math.round(saveSeconds / 60)} 分钟`
      host.logger.info(
        `[qqbot] 官方图床已启用：本地记录保留 ${saveSeconds} 秒（约 ${humanized}），单机器人上限 100 张`
      )
    }

    // 二级：框架文件服务；回环 / 内网地址 QQ 拉不到，提前提醒
    if (account.groupMarkdown || account.guildMarkdown) {
      const base = ctx.resolveFileBaseUrl()
      if (!base) {
        host.logger.warn(
          "[qqbot] 框架图床不可用（未填「文件服务地址」且内核面板未启用），官方图床失败时图片只能降级为文本"
        )
      } else if (!isPublicHttpUrl(base)) {
        host.logger.warn(
          `[qqbot] 文件服务地址不是公网可达地址（${base}），框架图床会被跳过；` +
            "请填公网地址或穿透域名，回环 / 内网地址 QQ 服务器拉不到"
        )
      }
    }
  }

  return {
    online(): boolean {
      return gateway.ready
    },

    ingest,

    async connect(): Promise<void> {
      // 连接前先确定 selfId（真实 QQ 号），获取失败则保持当前值
      ctx.selfId = await resolveSelfId(ctx.selfId)
      warnImageHost()

      if (account.mode === "webhook") connectWebhook()
      else await gateway.connect()

      // 连上之后再启动定时清理：官方图床按保存时间滚动释放配额
      startImageSweep()
    },

    async disconnect(): Promise<void> {
      stopImageSweep()

      if (account.mode === "webhook") {
        unregisterWebhookHandler(account.appId)
        host.logger.info(
          "[qqbot] Webhook 模式已断开；此后开放平台若重新保存回调地址将返回 404，" +
            "需先重新启动该账号"
        )
      } else {
        await gateway.disconnect()
      }
    }
  }
}
