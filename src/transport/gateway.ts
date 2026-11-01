/**
 * 模块职责：WebSocket Gateway 连接管理
 * 依赖方向：依赖 auth / types 与 ws 库
 * 生命周期：一个账号对应一个 Gateway，随 BotDriver 创建；内核每次重连都会新建驱动
 * 注意事项：按官方 WebSocket 文档（`temp/qqdocs/websocket.html` 那一份）——
 *   - 地址取自 `GET /gateway`，取不到再用写死的那个
 *   - 心跳周期取 Hello（op=10）里的 `heartbeat_interval`；`d` 为最近收到的 `s`，一次都没收到时为 null
 *   - **断线先自己 Resume**（op=6，带 session_id 与 seq），成功后平台补发断线期间的事件、以 RESUMED 收尾，
 *     内核看不到这次断线；Resume 不成才报 onClosed，交给内核按退避新建驱动、重新 Identify
 *   - 关闭码分三类：4914 / 4915 与 4001、4002、4010~4014 重连也没用，`connect()` 以 `retryable: false`
 *     的错误拒绝，内核据此不再重连；4006 / 4007 / 4900~4913 只能重新 Identify；其余先试 Resume
 *   - 鉴权时订阅的 intents 里有可选位（INTERACTION），被 4013 / 4014 拒了就去掉它再 Identify 一次
 */
import WebSocket from "ws"
import type { Logger } from "@yunzai-ng/types"
import type { TokenManager } from "./auth.js"
import type { QQBotAccount } from "../config.js"
import type { WSPayload, ReadyData } from "../protocol/types.js"
import { OpCode } from "../protocol/types.js"
import { parseShard } from "../config.js"

/** Gateway 事件回调 */
export interface GatewayHooks {
  onEvent: (eventType: string, data: unknown) => void
  onReady: (data: ReadyData) => void
  onClosed: (reason: string) => void
}

/** 构造选项，测试用 */
export interface GatewayOptions {
  /** 取 Gateway 地址；缺省调 `GET /gateway`，失败时用写死的地址 */
  resolveUrl?: () => Promise<string>
  /** Resume 之前等多久，毫秒 */
  resumeDelayMs?: number
  /** 等 READY / RESUMED 的上限，毫秒 */
  readyTimeoutMs?: number
}

/** 重连也没用的关闭码，官方表里「RESUME / IDENTIFY 都不可重试」的那几个 */
const FATAL_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])

/** 只能重新 Identify、不能 Resume 的关闭码 */
const IDENTIFY_ONLY_CODES = new Set([4006, 4007])

/** 关闭码的中文说明，日志与报错里用 */
const CODE_TEXT: Readonly<Record<number, string>> = {
  4001: "无效的 opcode",
  4002: "无效的 payload",
  4006: "session 失效，须重新鉴权",
  4007: "seq 错误",
  4008: "发送过快",
  4009: "连接过期",
  4010: "无效的 shard",
  4011: "需要处理的频道过多，请合理分片",
  4012: "无效的 version",
  4013: "无效的 intent",
  4014: "intent 无权限",
  4914: "机器人已下架，只允许连接沙箱环境",
  4915: "机器人已封禁，申请解封后再连接"
}

/** 可选订阅位：没有权限时去掉它重试，而不是让账号连不上 */
const OPTIONAL_INTENTS = 1 << 26

/** 连接失败；`retryable: false` 时内核不再重连 */
export class GatewayError extends Error {
  /**
   * @param message 说明
   * @param retryable 重连有没有用
   * @param code 关闭码
   */
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: number
  ) {
    super(message)
    this.name = "GatewayError"
  }
}

/**
 * 关闭码的说明
 * @param code 关闭码
 * @param reason 平台给的原因
 * @returns 文案
 */
function describeClose(code: number, reason: string): string {
  const text = CODE_TEXT[code] ?? (code >= 4900 && code <= 4913 ? "平台内部错误" : "")
  return [`code ${code}`, text, reason].filter(Boolean).join("，")
}

/** 一次 WebSocket 会话要做的事 */
type Mode = "identify" | "resume"

/** Gateway 连接 */
export class Gateway {
  private ws: WebSocket | null = null
  private sessionId = ""
  /** 最近收到的 `s`；一次都没收到时为 null，心跳的 d 就发 null */
  private seq: number | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatAck = true
  private resumeTimer: NodeJS.Timeout | null = null
  private closed = false
  /** 遇到过重连也没用的关闭码；此后 connect() 直接拒绝 */
  private fatal: GatewayError | undefined
  /** 本次实际订阅的 intents；可选位被拒后去掉 */
  private intents: number

  /**
   * @param hooks 事件 / 就绪 / 断开回调，由 BotDriver 注入
   * @param options 测试用的替换项
   */
  constructor(
    private account: QQBotAccount,
    private tokenManager: TokenManager,
    private hooks: GatewayHooks,
    private logger: Logger,
    private options: GatewayOptions = {}
  ) {
    this.intents = account.intents ?? 0
    // intents 由 validateAccount 按「预设订阅」算好塞进账号对象；缺失说明配置没走校验，退到 0 会收不到任何事件
    if (account.intents === undefined) {
      this.logger.warn("[qqbot] 账号配置缺少 intents（未经校验或来自旧配置），本次订阅为 0，连上后收不到任何事件")
    }
  }

  /**
   * 建立连接，收到 READY 才算连上
   * @throws GatewayError 就绪前断开；`retryable` 为假时重连也没用
   */
  async connect(): Promise<void> {
    if (this.fatal !== undefined) throw this.fatal
    this.closed = false
    this.sessionId = ""
    this.seq = null
    try {
      await this.open("identify")
    } catch (err) {
      // intents 里的可选位没有权限：去掉再试一次，宁可少收按钮回调也别整个连不上
      const code = err instanceof GatewayError ? err.code : undefined
      if ((code === 4013 || code === 4014) && (this.intents & OPTIONAL_INTENTS) !== 0) {
        this.intents &= ~OPTIONAL_INTENTS
        this.fatal = undefined
        this.logger.warn("[qqbot] 订阅 INTERACTION（按钮回调）被平台拒绝，已去掉它重新鉴权；需要按钮回调请到开放平台申请该事件权限")
        await this.open("identify")
        return
      }
      throw err
    }
  }

  /**
   * 开一条 WebSocket，鉴权或恢复
   * @param mode 首次鉴权还是恢复会话
   * @returns READY / RESUMED 时 resolve
   */
  private async open(mode: Mode): Promise<void> {
    const url = await this.resolveUrl()
    this.logger.debug(`正在连接 Gateway（${mode === "identify" ? "鉴权" : "恢复会话"}）：${url}`)

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      let settled = false
      /** 收到过 READY / RESUMED；只有这样的连接断了才谈得上 Resume */
      let established = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (err === undefined) resolve()
        else reject(err)
      }
      const timeout = setTimeout(() => {
        settle(new GatewayError(mode === "identify" ? "连接超时：迟迟没收到 READY" : "恢复会话超时", true))
        ws.close()
      }, this.options.readyTimeoutMs ?? 30_000)

      ws.on("message", data => {
        let payload: WSPayload
        try {
          payload = JSON.parse(data.toString()) as WSPayload
        } catch (error) {
          this.logger.error(`消息解析失败：${error}`)
          return
        }
        this.handleMessage(ws, payload, mode, () => {
          established = true
          settle()
        })
      })

      ws.on("close", (code, raw) => {
        if (this.ws === ws) this.ws = null
        this.stopHeartbeat()
        const reason = describeClose(code, raw.toString())
        if (FATAL_CODES.has(code)) {
          this.fatal = new GatewayError(`Gateway 拒绝连接（${reason}），重连也没用，先在开放平台处理`, false, code)
        }
        if (IDENTIFY_ONLY_CODES.has(code)) this.sessionId = ""

        if (!established) {
          settle(this.fatal ?? new GatewayError(`Gateway 在就绪前断开：${reason}`, true, code))
          return
        }
        if (this.closed) return
        this.logger.warn(`WebSocket 已断开：${reason}`)
        this.afterDrop(reason)
      })

      ws.on("error", error => {
        this.logger.error(`WebSocket 错误：${error.message}`)
        settle(new GatewayError(error.message, true))
      })
    })
  }

  /**
   * 就绪之后断线：能 Resume 先 Resume，不能就交给内核
   * @param reason 断开原因
   */
  private afterDrop(reason: string): void {
    if (this.fatal !== undefined || this.sessionId === "") {
      this.hooks.onClosed(reason)
      return
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.closed) return
      this.open("resume").then(
        () => this.logger.info("[qqbot] 已恢复会话，断线期间的事件由平台补发"),
        (err: unknown) => {
          if (this.closed) return
          this.sessionId = ""
          this.hooks.onClosed(`${reason}；恢复会话失败：${err instanceof Error ? err.message : String(err)}`)
        }
      )
    }, this.options.resumeDelayMs ?? 1000)
  }

  /**
   * 取 Gateway 地址
   * @returns wss 地址
   */
  private async resolveUrl(): Promise<string> {
    const fallback = this.account.sandbox ? "wss://sandbox.api.sgroup.qq.com/websocket" : "wss://api.sgroup.qq.com/websocket"
    if (this.options.resolveUrl === undefined) return fallback
    try {
      const url = await this.options.resolveUrl()
      return url !== "" ? url : fallback
    } catch (err) {
      this.logger.debug(`[qqbot] 取 Gateway 地址失败，用缺省地址：${err instanceof Error ? err.message : String(err)}`)
      return fallback
    }
  }

  /**
   * 处理一条下行消息
   * @param ws 所属连接
   * @param payload 消息
   * @param mode 本条连接是鉴权还是恢复
   * @param onReady READY / RESUMED 时调用
   */
  private handleMessage(ws: WebSocket, payload: WSPayload, mode: Mode, onReady: () => void): void {
    if (typeof payload.s === "number") this.seq = payload.s

    switch (payload.op) {
      case OpCode.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | null)?.heartbeat_interval
        this.startHeartbeat(ws, typeof interval === "number" && interval > 0 ? interval : 41_250)
        const send = mode === "resume" ? this.sendResume(ws) : this.sendIdentify(ws)
        // 取 token 失败（AppSecret 错、接口不通）时这里是唯一能接住的地方，不接就是一条未处理的 rejection
        send.catch((err: unknown) => {
          this.logger.error(`[qqbot] ${mode === "resume" ? "Resume" : "Identify"} 发送失败：${err instanceof Error ? err.message : String(err)}`)
          ws.close(4000)
        })
        break
      }

      case OpCode.DISPATCH:
        if (payload.t === "READY") {
          const readyData = payload.d as ReadyData
          this.sessionId = readyData.session_id
          this.logger.debug(`已连接：${readyData.user.username} (${readyData.session_id})`)
          this.hooks.onReady(readyData)
          onReady()
        } else if (payload.t === "RESUMED") {
          onReady()
        } else {
          this.hooks.onEvent(payload.t || "", payload.d)
        }
        break

      case OpCode.HEARTBEAT:
        this.sendHeartbeat(ws)
        break

      case OpCode.HEARTBEAT_ACK:
        this.heartbeatAck = true
        break

      case OpCode.RECONNECT:
        this.logger.warn("收到 Reconnect 指令，断开后恢复会话")
        ws.close(4000)
        break

      case OpCode.INVALID_SESSION:
        this.logger.warn("收到 Invalid Session，将重新鉴权")
        this.sessionId = ""
        ws.close(4000)
        break

      default:
        this.logger.warn(`未知 OpCode：${payload.op}`)
    }
  }

  /**
   * 发送 Identify
   * @param ws 连接
   */
  private async sendIdentify(ws: WebSocket): Promise<void> {
    const token = await this.tokenManager.getToken()
    const [shardId, shardCount] = parseShard(this.account.shard)
    this.logger.debug(`发送 Identify，intents: ${this.intents} (0x${this.intents.toString(16)})`)
    ws.send(
      JSON.stringify({
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [shardId, shardCount],
          properties: { $os: "nodejs", $browser: "yunzai-ng-adapter-qqbot", $device: "yunzai-ng" }
        }
      } satisfies WSPayload)
    )
  }

  /**
   * 发送 Resume
   * @param ws 连接
   */
  private async sendResume(ws: WebSocket): Promise<void> {
    const token = await this.tokenManager.getToken()
    ws.send(
      JSON.stringify({
        op: OpCode.RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq ?? 0 }
      } satisfies WSPayload)
    )
  }

  /**
   * 按 Hello 给的周期起心跳
   * @param ws 连接
   * @param interval 毫秒
   */
  private startHeartbeat(ws: WebSocket, interval: number): void {
    this.stopHeartbeat()
    this.heartbeatAck = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAck) {
        this.logger.warn("心跳未收到 ACK，断开后恢复会话")
        ws.close(4000)
        return
      }
      this.heartbeatAck = false
      this.sendHeartbeat(ws)
    }, interval)
  }

  /** 停止心跳 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 发送心跳
   * @param ws 连接
   */
  private sendHeartbeat(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq } satisfies WSPayload))
  }

  /** 关闭连接 */
  async disconnect(): Promise<void> {
    this.closed = true
    this.stopHeartbeat()
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    if (this.ws) {
      this.ws.close(1000, "正常关闭")
      this.ws = null
    }
    this.sessionId = ""
    this.seq = null
  }

  /** 是否已连接 */
  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== ""
  }
}
