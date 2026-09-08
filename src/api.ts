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
  /**
   *
   */
  constructor(
    message: string,
    public code: number,
    public data?: unknown
  ) {
    super(message)
    this.name = "QQBotApiError"
  }
}

/** API 客户端 */
export class ApiClient {
  /**
   *
   */
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

    if (response.status < 200 || response.status >= 300) {
      const errorData = response.data as QQBotError | undefined
      throw new QQBotApiError(
        errorData?.message || `API 调用失败：HTTP ${response.status}`,
        errorData?.code || response.status,
        errorData?.data
      )
    }

    return response.data
  }

  /** 发送群消息 */
  async sendGroupMessage(
    groupOpenId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return this.call<SendMessageResponse>(
      "POST",
      `/v2/groups/${groupOpenId}/messages`,
      request
    )
  }

  /** 发送私聊消息 */
  async sendC2CMessage(
    openId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return this.call<SendMessageResponse>(
      "POST",
      `/v2/users/${openId}/messages`,
      request
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

  /** 发送频道消息 */
  async sendGuildMessage(
    channelId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return this.call<SendMessageResponse>(
      "POST",
      `/channels/${channelId}/messages`,
      request
    )
  }

  /** 发送频道消息（带图片，multipart/form-data） */
  async sendGuildMessageWithImage(
    channelId: string,
    request: SendMessageRequest,
    imageBuffer: Buffer
  ): Promise<SendMessageResponse> {
    const url = `${this.tokenManager.getApiBase()}/channels/${channelId}/messages`
    const authHeaders = await this.tokenManager.getAuthHeader()

    // 手动构建 multipart/form-data
    const boundary = "----YunzaiNGFormBoundary" + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    // 添加文本内容
    if (request.content) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="content"\r\n\r\n` +
        `${request.content}\r\n`
      ))
    }

    // 添加消息引用
    if (request.msg_id) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="msg_id"\r\n\r\n` +
        `${request.msg_id}\r\n`
      ))
    }
    if (request.event_id) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="event_id"\r\n\r\n` +
        `${request.event_id}\r\n`
      ))
    }

    // 添加图片文件
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_image"; filename="image.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    ))
    parts.push(imageBuffer)
    parts.push(Buffer.from("\r\n"))

    // 结束标记
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await this.http.request<SendMessageResponse>(url, {
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

    if (response.status < 200 || response.status >= 300) {
      const errorData = response.data as unknown as QQBotError | undefined
      throw new QQBotApiError(
        errorData?.message || `API 调用失败：HTTP ${response.status}`,
        errorData?.code || response.status,
        errorData?.data
      )
    }

    return response.data
  }

  /** 发送频道私信 */
  async sendDirectMessage(
    guildId: string,
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return this.call<SendMessageResponse>(
      "POST",
      `/dms/${guildId}/messages`,
      request
    )
  }

  /** 发送频道私信（带图片，multipart/form-data） */
  async sendDirectMessageWithImage(
    guildId: string,
    request: SendMessageRequest,
    imageBuffer: Buffer
  ): Promise<SendMessageResponse> {
    const url = `${this.tokenManager.getApiBase()}/dms/${guildId}/messages`
    const authHeaders = await this.tokenManager.getAuthHeader()

    // 手动构建 multipart/form-data
    const boundary = "----YunzaiNGFormBoundary" + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    // 添加文本内容
    if (request.content) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="content"\r\n\r\n` +
        `${request.content}\r\n`
      ))
    }

    // 添加消息引用
    if (request.msg_id) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="msg_id"\r\n\r\n` +
        `${request.msg_id}\r\n`
      ))
    }
    if (request.event_id) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="event_id"\r\n\r\n` +
        `${request.event_id}\r\n`
      ))
    }

    // 添加图片文件
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_image"; filename="image.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    ))
    parts.push(imageBuffer)
    parts.push(Buffer.from("\r\n"))

    // 结束标记
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await this.http.request<SendMessageResponse>(url, {
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

    if (response.status < 200 || response.status >= 300) {
      const errorData = response.data as unknown as QQBotError | undefined
      throw new QQBotApiError(
        errorData?.message || `API 调用失败：HTTP ${response.status}`,
        errorData?.code || response.status,
        errorData?.data
      )
    }

    return response.data
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

  // ── 以下为注释示例，待启用 ──

  /**
   * 获取频道详情
   * API: GET /guilds/{guild_id}
   * 返回: Guild 对象 { id, name, icon, owner_id, member_count, ... }
   */
  // async getGuildInfo(guildId: string): Promise<GuildInfo> {
  //   return this.call<GuildInfo>("GET", `/guilds/${guildId}`)
  // }

  /**
   * 获取用户频道列表
   * API: GET /users/@me/guilds
   * 参数: before?, after?, limit?
   * 返回: Guild 对象数组
   */
  // async getUserGuilds(params?: { before?: string; after?: string; limit?: number }): Promise<GuildInfo[]> {
  //   const query = params ? `?${new URLSearchParams(params as any).toString()}` : ""
  //   return this.call<GuildInfo[]>("GET", `/users/@me/guilds${query}`)
  // }

  /**
   * 获取频道成员详情
   * API: GET /guilds/{guild_id}/members/{user_id}
   * 返回: Member 对象 { user, nick, roles, joined_at }
   */
  // async getGuildMember(guildId: string, userId: string): Promise<GuildMember> {
  //   return this.call<GuildMember>("GET", `/guilds/${guildId}/members/${userId}`)
  // }

  /**
   * 获取频道成员列表
   * API: GET /guilds/{guild_id}/members
   * 参数: after?, limit?
   * 返回: Member 对象数组
   */
  // async getGuildMembers(guildId: string, params?: { after?: string; limit?: number }): Promise<GuildMember[]> {
  //   const query = params ? `?${new URLSearchParams(params as any).toString()}` : ""
  //   return this.call<GuildMember[]>("GET", `/guilds/${guildId}/members${query}`)
  // }

  /**
   * 删除频道成员（踢出）
   * API: DELETE /guilds/{guild_id}/members/{user_id}
   * 参数: add_blacklist? (是否加入黑名单)
   * 返回: 204 No Content
   */
  // async kickGuildMember(guildId: string, userId: string, addBlacklist?: boolean): Promise<void> {
  //   const body = addBlacklist ? { add_blacklist: true } : undefined
  //   await this.call("DELETE", `/guilds/${guildId}/members/${userId}`, body)
  // }

  /**
   * 机器人发表表情表态
   * API: PUT /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
   * 参数: type (1=系统表情, 2=emoji), id (表情 ID)
   * 返回: 204 No Content
   */
  // async addReaction(channelId: string, messageId: string, type: number, emojiId: string): Promise<void> {
  //   await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${type}/${emojiId}`)
  // }

  /**
   * 删除机器人发表的表情表态
   * API: DELETE /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
   * 返回: 204 No Content
   */
  // async removeReaction(channelId: string, messageId: string, type: number, emojiId: string): Promise<void> {
  //   await this.call("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${type}/${emojiId}`)
  // }
}

// ── 以下为注释示例的类型定义 ──

/** 频道信息 */
// interface GuildInfo {
//   id: string
//   name: string
//   icon: string
//   owner_id: string
//   owner?: boolean
//   joined_at: string
//   member_count: number
//   max_members: number
//   description: string
// }

/** 频道成员 */
// interface GuildMember {
//   user: {
//     id: string
//     username: string
//     avatar: string
//     bot?: boolean
//   }
//   nick: string
//   roles: string[]
//   joined_at: string
// }
