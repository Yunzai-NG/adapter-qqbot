/**
 * 模块职责：WebSocket Gateway 连接管理
 * 依赖方向：依赖 auth / types 与 ws 库
 * 生命周期：一个账号对应一个 Gateway，随 BotDriver 创建
 * 注意事项：
 *   - 连接后需先发送 Identify 进行鉴权
 *   - 需定期发送心跳保活
 *   - 支持断线重连和会话恢复（Resume）
 *   - 处理 Reconnect 和 Invalid Session 事件
 */
import WebSocket from "ws"
import type { Logger } from "@yunzai-ng/types"
import type { TokenManager } from "./auth.js"
import type { QQBotAccount } from "./config.js"
import type { WSPayload, ReadyData } from "./types.js"
import { OpCode } from "./types.js"
import { parseShard } from "./config.js"

/** Gateway 事件回调 */
export interface GatewayHooks {
  onEvent: (eventType: string, data: unknown) => void
  onReady: (data: ReadyData) => void
  onClosed: (reason: string) => void
}

/** Gateway 连接 */
export class Gateway {
  private ws: WebSocket | null = null
  private sessionId = ""
  private seq = 0
  private heartbeatInterval: NodeJS.Timeout | null = null
  private heartbeatAck = true
  private reconnectTimer: NodeJS.Timeout | null = null
  private closed = false

  /** @param hooks 事件 / 就绪 / 断开回调，由 BotDriver 注入 */
  constructor(
    private account: QQBotAccount,
    private tokenManager: TokenManager,
    private hooks: GatewayHooks,
    private logger: Logger
  ) {}

  /** 建立连接 */
  async connect(): Promise<void> {
    this.closed = false

    // 获取 Gateway 地址
    const gatewayUrl = await this.getGatewayUrl()
    this.logger.debug(`正在连接 Gateway：${gatewayUrl}`)

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl)
      this.ws = ws

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("连接超时"))
      }, 30000)

      ws.on("open", () => {
        this.logger.debug("WebSocket 已连接，等待 Hello...")
      })

      ws.on("message", (data) => {
        try {
          const payload = JSON.parse(data.toString()) as WSPayload
          this.handleMessage(payload, resolve, reject, timeout)
        } catch (error) {
          this.logger.error(`消息解析失败：${error}`)
        }
      })

      ws.on("close", (code, reason) => {
        clearTimeout(timeout)
        this.stopHeartbeat()
        const reasonStr = reason.toString() || `code ${code}`
        this.logger.warn(`WebSocket 已断开：${reasonStr}`)

        if (!this.closed) {
          this.hooks.onClosed(reasonStr)
          this.scheduleReconnect()
        }
      })

      ws.on("error", (error) => {
        clearTimeout(timeout)
        this.logger.error(`WebSocket 错误：${error.message}`)
        reject(error)
      })
    })
  }

  /** 获取 Gateway URL */
  private async getGatewayUrl(): Promise<string> {
    // 根据沙箱配置返回不同的地址
    return this.account.sandbox
      ? "wss://sandbox.api.sgroup.qq.com/websocket"
      : "wss://api.sgroup.qq.com/websocket"
  }

  /** 处理消息 */
  private handleMessage(
    payload: WSPayload,
    resolve: () => void,
    reject: (error: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    if (payload.s !== undefined) {
      this.seq = payload.s
    }

    switch (payload.op) {
      case OpCode.HELLO:
        this.logger.debug("收到 Hello，发送 Identify...")
        this.sendIdentify()
        break

      case OpCode.DISPATCH:
        if (payload.t === "READY") {
          clearTimeout(timeout)
          const readyData = payload.d as ReadyData
          this.sessionId = readyData.session_id
          this.logger.debug(`已连接：${readyData.user.username} (${readyData.session_id})`)
          this.startHeartbeat(payload.d as { heartbeat_interval: number })
          this.hooks.onReady(readyData)
          resolve()
        } else {
          this.handleDispatch(payload.t || "", payload.d)
        }
        break

      case OpCode.HEARTBEAT:
        this.sendHeartbeat()
        break

      case OpCode.HEARTBEAT_ACK:
        this.heartbeatAck = true
        break

      case OpCode.RECONNECT:
        this.logger.warn("收到 Reconnect 指令")
        this.ws?.close()
        break

      case OpCode.INVALID_SESSION:
        this.logger.warn("收到 Invalid Session，将重新连接")
        this.sessionId = ""
        this.seq = 0
        setTimeout(() => this.ws?.close(), 1000)
        break

      default:
        this.logger.warn(`未知 OpCode：${payload.op}`)
    }
  }

  /** 处理 Dispatch 事件 */
  private handleDispatch(eventType: string, data: unknown): void {
    this.hooks.onEvent(eventType, data)
  }

  /** 发送 Identify */
  private async sendIdentify(): Promise<void> {
    const token = await this.tokenManager.getToken()
    const [shardId, shardCount] = parseShard(this.account.shard)

    // 使用配置中已计算好的 intents 值
    const intents = (this.account as any).intents || 0

    this.logger.debug(`发送 Identify，intents: ${intents} (0x${intents.toString(16)})`)

    const payload: WSPayload = {
      op: OpCode.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [shardId, shardCount],
        properties: {
          $os: "nodejs",
          $browser: "yunzai-ng-adapter-qqbot",
          $device: "yunzai-ng"
        }
      }
    }

    this.ws?.send(JSON.stringify(payload))
  }

  /** 发送 Resume */
  private async sendResume(): Promise<void> {
    if (!this.sessionId) {
      await this.sendIdentify()
      return
    }

    const token = await this.tokenManager.getToken()
    const payload: WSPayload = {
      op: OpCode.RESUME,
      d: {
        token: `QQBot ${token}`,
        session_id: this.sessionId,
        seq: this.seq
      }
    }

    this.ws?.send(JSON.stringify(payload))
  }

  /** 启动心跳 */
  private startHeartbeat(data: { heartbeat_interval: number }): void {
    this.stopHeartbeat()
    const interval = data.heartbeat_interval || 40000

    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAck) {
        this.logger.warn("心跳未收到 ACK，重新连接...")
        this.ws?.close()
        return
      }
      this.heartbeatAck = false
      this.sendHeartbeat()
    }, interval)
  }

  /** 停止心跳 */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  /** 发送心跳 */
  private sendHeartbeat(): void {
    const payload: WSPayload = {
      op: OpCode.HEARTBEAT,
      d: this.seq
    }
    this.ws?.send(JSON.stringify(payload))
  }

  /** 安排重连 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.logger.info("尝试重新连接...")
      this.connect().catch((error) => {
        this.logger.error(`重连失败：${error.message}`)
      })
    }, 5000)
  }

  /** 关闭连接 */
  async disconnect(): Promise<void> {
    this.closed = true
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close(1000, "正常关闭")
      this.ws = null
    }

    this.sessionId = ""
    this.seq = 0
  }

  /** 是否已连接 */
  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== ""
  }
}
