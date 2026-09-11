/**
 * 模块职责：QQ Bot REST API 客户端
 * 依赖方向：依赖 auth / types 与内核的 HttpClient
 * 生命周期：一个账号对应一个 ApiClient，随 BotDriver 创建
 * 注意事项：
 *   - 所有请求需携带 Authorization 头
 *   - 群消息和私聊消息使用不同的 API 端点
 *   - 支持文本、Markdown、Ark、键盘等多种消息类型
 */
import type { HttpClient, Logger } from "@yunzai-ng/types"
import type { TokenManager } from "./auth.js"
import type {
  SendMessageRequest,
  SendMessageResponse,
  UploadMediaRequest,
  UploadMediaResponse,
  UploadPrepareRequest,
  UploadPrepareResponse,
  UploadPartFinishRequest,
  FilesRequest,
  CreateDirectSessionRequest,
  CreateDirectSessionResponse,
  QQBotSelfInfo,
  QQUserInfo,
  QQBotError,
  GroupMemberInfo,
  GuildMemberInfo,
  GroupInfo,
  GuildInfo,
  ChannelInfo
} from "./types.js"


/** API 错误 */
export class QQBotApiError extends Error {
  /** @param code QQ 平台错误码，无错误体时退化为 HTTP 状态码 */
  constructor(
    message: string,
    public code: number,
    public data?: unknown
  ) {
    super(message)
    this.name = "QQBotApiError"
  }
}

/** 非 2xx 响应时抛出 QQBotApiError */
function throwIfError(status: number, data: unknown): void {
  if (status < 200 || status >= 300) {
    const errorData = data as QQBotError | undefined
    throw new QQBotApiError(
      errorData?.message || `API 调用失败：HTTP ${status}`,
      errorData?.code || status,
      errorData?.data
    )
  }
}

/** 审核中的消息没有常规消息 id，统一为可追踪的待审核结果。 */
function normalizeSendResponse(data: unknown): SendMessageResponse {
  const result = data as Partial<SendMessageResponse> & {
    message_audit?: { audit_id?: string }
  }
  if (result.message_audit?.audit_id) {
    return {
      id: result.message_audit.audit_id,
      timestamp: new Date().toISOString(),
      auditStatus: "pending",
      raw: data
    }
  }
  if (!result.id || !result.timestamp) {
    throw new QQBotApiError("发送消息响应缺少 id 或 timestamp", 0, data)
  }
  return result as SendMessageResponse
}

/** API 客户端 */
export class ApiClient {
  /** @param tokenManager 提供 API 基址与 Authorization 头 */
  constructor(
    private tokenManager: TokenManager,
    private http: HttpClient,
    private logger: Logger
  ) {}

  /** 调用 API */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.tokenManager.getApiBase()}${path}`
    const headers = await this.tokenManager.getAuthHeader()

    const response = await this.http.request<T>(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      json: body,
      responseType: "json",
      throwOnError: false
    })

    throwIfError(response.status, response.data)
    return response.data
  }

  /** 发送群消息 */
  async sendGroupMessage(
    groupOpenId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return normalizeSendResponse(await this.call(
      "POST",
      `/v2/groups/${groupOpenId}/messages`,
      request
    ))
  }

  /** 发送私聊消息 */
  async sendC2CMessage(
    openId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return normalizeSendResponse(await this.call(
      "POST",
      `/v2/users/${openId}/messages`,
      request
    ))
  }

  /** 获取机器人已加入的频道；after 为分页游标。 */
  async getGuildList(after?: string): Promise<GuildInfo[]> {
    const path = after
      ? `/users/@me/guilds?after=${encodeURIComponent(after)}`
      : "/users/@me/guilds"
    return this.call<GuildInfo[]>("GET", path)
  }

  /** 添加或移除频道消息表态。 */
  async setGuildMessageReaction(
    channelId: string,
    messageId: string,
    emojiId: string,
    add: boolean
  ): Promise<void> {
    const type = /^\d+$/.test(emojiId) ? 1 : 2
    await this.call(
      add ? "PUT" : "DELETE",
      `/channels/${channelId}/messages/${messageId}/reactions/${type}/${encodeURIComponent(emojiId)}`
    )
  }

  /** 获取当前机器人信息 */
  async getSelfInfo(): Promise<QQBotSelfInfo> {
    return this.call<QQBotSelfInfo>("GET", `/users/@me`)
  }

  /** 获取用户信息 */
  async getUserInfo(openId: string): Promise<QQUserInfo> {
    return this.call<QQUserInfo>("GET", `/v2/users/${openId}/info`)
  }

  /** 获取群成员信息 */
  async getGroupMemberInfo(groupOpenId: string, memberOpenId: string): Promise<GroupMemberInfo> {
    return this.call<GroupMemberInfo>("GET", `/v2/groups/${groupOpenId}/members/${memberOpenId}`)
  }

  /** 获取群成员列表 */
  async getGroupMemberListInfo(groupOpenId: string): Promise<GroupMemberInfo[]> {
    return this.call<GroupMemberInfo[]>("GET", `/v2/groups/${groupOpenId}/members`)
  }

  /** 获取频道成员信息 */
  async getGuildMemberInfo(guildId: string, userId: string): Promise<GuildMemberInfo> {
    return this.call<GuildMemberInfo>("GET", `/guilds/${guildId}/members/${userId}`)
  }

  /** 获取频道成员列表 */
  async getGuildMemberListInfo(guildId: string): Promise<GuildMemberInfo[]> {
    return this.call<GuildMemberInfo[]>("GET", `/guilds/${guildId}/members`)
  }

  /** 获取群聊信息 */
  async getGroupInfo(groupOpenId: string): Promise<GroupInfo> {
    return this.call<GroupInfo>("GET", `/v2/groups/${groupOpenId}/info`)
  }

  /** 获取频道信息 */
  async getGuildInfo(guildId: string): Promise<GuildInfo> {
    return this.call<GuildInfo>("GET", `/guilds/${guildId}`)
  }

  /** 获取子频道信息 */
  async getChannelInfo(channelId: string): Promise<ChannelInfo> {
    return this.call<ChannelInfo>("GET", `/channels/${channelId}`)
  }

  /** 撤回群消息 */
  async recallGroupMessage(groupOpenId: string, messageId: string): Promise<void> {
    await this.call("DELETE", `/v2/groups/${groupOpenId}/messages/${messageId}`)
  }

  /** 撤回私聊消息 */
  async recallC2CMessage(openId: string, messageId: string): Promise<void> {
    await this.call("DELETE", `/v2/users/${openId}/messages/${messageId}`)
  }

  /** 禁言群成员 */
  async muteGroupMember(groupOpenId: string, memberOpenId: string, muteExpireAt: string): Promise<void> {
    await this.call("POST", `/v2/groups/${groupOpenId}/restrict_chat_setting`, {
      members: [
        {
          op: "add",
          member_openid: memberOpenId,
          mute_expire_at: muteExpireAt
        }
      ]
    })
  }

  /** 禁言频道成员 */
  async muteGuildMember(guildId: string, userId: string, muteSeconds: number): Promise<void> {
    await this.call("PATCH", `/guilds/${guildId}/members/${userId}/mute`, {
      mute_seconds: muteSeconds.toString()
    })
  }

  /** 踢出群成员（批量移除，单次最多 20 个，需白名单权限） */
  async kickGroupMember(groupOpenId: string, memberOpenIds: string[], addBlacklist = false): Promise<void> {
    await this.call("POST", `/v2/groups/${groupOpenId}/batch_remove_members`, {
      member_openids: memberOpenIds,
      add_to_member_blacklist: addBlacklist
    })
  }

  /** 踢出频道成员 */
  async kickGuildMember(guildId: string, userId: string, addBlacklist = false): Promise<void> {
    await this.call("DELETE", `/guilds/${guildId}/members/${userId}`, {
      add_blacklist: addBlacklist
    })
  }

  /** 审批入群申请 */
  async handleGroupJoinRequest(
    groupOpenId: string,
    memberOpenId: string,
    op: "approve" | "decline",
    joinRequestId?: string,
    rejectReason?: string,
    addBlacklist?: boolean
  ): Promise<void> {
    const body: Record<string, unknown> = { op }
    if (joinRequestId) body.join_request_id = joinRequestId
    if (op === "decline") {
      if (rejectReason) body.reject_reason = rejectReason
      if (addBlacklist !== undefined) body.add_to_member_blacklist = addBlacklist
    }
    await this.call("POST", `/v2/groups/${groupOpenId}/approval_join_request/${memberOpenId}`, body)
  }

  /**
   * 应答互动回调（按钮点击）
   * @param interactionId INTERACTION_CREATE 事件的 id
   * @param code 应答码：0 成功；1 操作失败；2 操作频繁；3 重复操作；4 没有权限；5 仅管理员可操作
   */
  async replyInteraction(interactionId: string, code = 0): Promise<void> {
    await this.call("PUT", `/interactions/${interactionId}`, { code })
  }

  /** 上传群聊富媒体 */
  async uploadGroupMedia(
    groupOpenId: string,
    request: UploadMediaRequest
  ): Promise<UploadMediaResponse> {
    return this.call<UploadMediaResponse>(
      "POST",
      `/v2/groups/${groupOpenId}/files`,
      request
    )
  }

  /** 上传私聊富媒体 */
  async uploadC2CMedia(
    openId: string,
    request: UploadMediaRequest
  ): Promise<UploadMediaResponse> {
    return this.call<UploadMediaResponse>(
      "POST",
      `/v2/users/${openId}/files`,
      request
    )
  }

  /**
   * 富媒体分片预上传：换取 upload_id 与各分片的预签名 URL
   * @param target 上传目标类型：group=群聊，user=单聊
   * @param targetId 群 openid 或用户 openid
   * @param request 文件大小与摘要信息
   * @returns upload_id、分片列表与并发重试配置
   */
  async prepareUpload(
    target: "group" | "user",
    targetId: string,
    request: UploadPrepareRequest
  ): Promise<UploadPrepareResponse> {
    return this.call<UploadPrepareResponse>(
      "POST",
      `/v2/${target}s/${targetId}/upload_prepare`,
      request
    )
  }

  /**
   * 通知服务端某个分片已 PUT 完成
   * @param target 上传目标类型：group=群聊，user=单聊
   * @param targetId 群 openid 或用户 openid
   * @param request 分片序号、大小与 md5
   */
  async finishUploadPart(
    target: "group" | "user",
    targetId: string,
    request: UploadPartFinishRequest
  ): Promise<void> {
    await this.call(
      "POST",
      `/v2/${target}s/${targetId}/upload_part_finish`,
      request
    )
  }

  /**
   * files 接口：URL 转存（带 url）或合并分片（带 upload_id），换取 file_info
   * @param target 上传目标类型：group=群聊，user=单聊
   * @param targetId 群 openid 或用户 openid
   * @param request 转存 URL 或待合并的 upload_id
   * @returns 含 file_info 的上传结果
   */
  async commitFile(
    target: "group" | "user",
    targetId: string,
    request: FilesRequest
  ): Promise<UploadMediaResponse> {
    return this.call<UploadMediaResponse>(
      "POST",
      `/v2/${target}s/${targetId}/files`,
      request
    )
  }

  /** 发送频道消息 */
  async sendGuildMessage(
    channelId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return normalizeSendResponse(await this.call(
      "POST",
      `/channels/${channelId}/messages`,
      request
    ))
  }

  /**
   * 以 multipart/form-data 发送带图片的消息（频道消息 / 频道私信共用）
   * @param path 消息接口路径，如 `/channels/{id}/messages` 或 `/dms/{guildId}/messages`
   * @param request 消息请求（取 content / msg_id / event_id 字段）
   * @param imageBuffer 图片二进制
   */
  private async sendMultipart(
    path: string,
    request: SendMessageRequest,
    imageBuffer: Buffer
  ): Promise<SendMessageResponse> {
    const url = `${this.tokenManager.getApiBase()}${path}`
    const authHeaders = await this.tokenManager.getAuthHeader()

    const boundary = "----YunzaiNGFormBoundary" + Math.random().toString(36).slice(2)
    const field = (name: string, value: string): Buffer =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)

    const parts: Buffer[] = []
    if (request.content !== undefined) parts.push(field("content", request.content))
    if (request.msg_type !== undefined) parts.push(field("msg_type", String(request.msg_type)))
    if (request.msg_seq !== undefined) parts.push(field("msg_seq", String(request.msg_seq)))
    if (request.msg_id) parts.push(field("msg_id", request.msg_id))
    if (request.event_id) parts.push(field("event_id", request.event_id))
    if (request.message_reference) {
      parts.push(field("message_reference", JSON.stringify(request.message_reference)))
    }
    if (request.markdown) parts.push(field("markdown", JSON.stringify(request.markdown)))
    if (request.keyboard) parts.push(field("keyboard", JSON.stringify(request.keyboard)))
    if (request.ark) parts.push(field("ark", JSON.stringify(request.ark)))
    if (request.embed) parts.push(field("embed", JSON.stringify(request.embed)))

    // 图片文件段
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_image"; filename="image.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    ))
    parts.push(imageBuffer)
    parts.push(Buffer.from("\r\n"))
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await this.http.request<unknown>(url, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length)
      },
      body,
      responseType: "json",
      throwOnError: false
    })

    throwIfError(response.status, response.data)
    return normalizeSendResponse(response.data)
  }

  /** 发送频道消息（带图片，multipart/form-data） */
  async sendGuildMessageWithImage(
    channelId: string,
    request: SendMessageRequest,
    imageBuffer: Buffer
  ): Promise<SendMessageResponse> {
    return this.sendMultipart(`/channels/${channelId}/messages`, request, imageBuffer)
  }

  /** 发送频道私信 */
  async sendDirectMessage(
    guildId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return normalizeSendResponse(await this.call(
      "POST",
      `/dms/${guildId}/messages`,
      request
    ))
  }

  /** 发送频道私信（带图片，multipart/form-data） */
  async sendDirectMessageWithImage(
    guildId: string,
    request: SendMessageRequest,
    imageBuffer: Buffer
  ): Promise<SendMessageResponse> {
    return this.sendMultipart(`/dms/${guildId}/messages`, request, imageBuffer)
  }

  /** 创建频道私信会话 */
  async createDirectSession(
    guildId: string,
    userId: string
  ): Promise<CreateDirectSessionResponse> {
    return this.call<CreateDirectSessionResponse>(
      "POST",
      `/users/@me/dms`,
      {
        recipient_id: userId,
        source_guild_id: guildId
      } as CreateDirectSessionRequest
    )
  }

  /** 撤回频道消息 */
  async recallGuildMessage(channelId: string, messageId: string): Promise<void> {
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}`)
  }

  /** 撤回频道私信 */
  async recallDirectMessage(guildId: string, messageId: string): Promise<void> {
    await this.call("DELETE", `/dms/${guildId}/messages/${messageId}`)
  }
}
