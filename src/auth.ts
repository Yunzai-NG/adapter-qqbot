/**
 * 模块职责：Access Token 的获取与自动刷新
 */
import type { HttpClient, KvNamespace, Logger } from "@yunzai-ng/types"
import type { TokenResponse } from "./types.js"
import type { QQBotAccount } from "./config.js"

const API_BASE = "https://api.sgroup.qq.com"
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com"
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

/** KV 中缓存的 token 结构 */
interface CachedToken {
  token: string
  expiresAt: number
}

export class TokenManager {
  private token = ""
  private expiresAt = 0
  private refreshPromise: Promise<string> | null = null

  constructor(
    private account: QQBotAccount,
    private http: HttpClient,
    private logger: Logger,
    private kv?: KvNamespace
  ) {}

  async getToken(): Promise<string> {
    if (this.account.token) {
      return this.account.token
    }

    // 内存缓存有效
    if (this.token && Date.now() < this.expiresAt - 60 * 1000) {
      return this.token
    }

    // 尝试从 KV 恢复
    if (!this.token && this.kv) {
      const cached = await this.kv.get<CachedToken>(`token:${this.account.appId}`)
      if (cached && Date.now() < cached.expiresAt - 60 * 1000) {
        this.token = cached.token
        this.expiresAt = cached.expiresAt
        const expireTime = new Date(this.expiresAt).toLocaleString("zh-CN")
      this.logger.debug(`Access Token 从缓存恢复，有效期至 ${expireTime}`)
      return this.token
      }
    }

    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshToken()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async refreshToken(): Promise<string> {
    this.logger.debug("正在获取 Access Token...")

    try {
      const response = await this.http.request<TokenResponse>(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        json: {
          appId: this.account.appId,
          clientSecret: this.account.appSecret
        },
        responseType: "json"
      })

      if (response.status !== 200) {
        throw new Error(`获取 Token 失败：HTTP ${response.status}`)
      }

      const data = response.data

      if (!data.access_token) {
        throw new Error("获取 Token 失败：响应中缺少 access_token")
      }

      this.token = data.access_token
      this.expiresAt = Date.now() + data.expires_in * 1000

      // 持久化到 KV，TTL 设为过期时间
      if (this.kv) {
        await this.kv.set<CachedToken>(
          `token:${this.account.appId}`,
          { token: this.token, expiresAt: this.expiresAt },
          { ttl: data.expires_in * 1000 }
        )
      }

      const expireTime = new Date(this.expiresAt).toLocaleString("zh-CN")
      this.logger.debug(`Access Token 已获取，有效期至 ${expireTime}`)
      return this.token
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.logger.warn(`获取 Access Token 失败：${msg}`)
      throw error
    }
  }

  getApiBase(): string {
    return this.account.sandbox ? SANDBOX_API_BASE : API_BASE
  }

  async getAuthHeader(): Promise<Record<string, string>> {
    const token = await this.getToken()
    return { Authorization: `QQBot ${token}` }
  }
}
