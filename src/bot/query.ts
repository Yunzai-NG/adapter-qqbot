/**
 * 模块职责：信息查询 —— 自身、群、频道、成员与列表
 * 依赖方向：依赖 transport/api 与 protocol/codec 的标识归一化
 * 生命周期：随 createQQBotBot 创建一次，无内部状态
 * 注意事项：
 *   - 群聊用 group_openid，频道用「频道号-子频道号」组合，同一套接口按 id 形态分流
 *   - 查询失败一律降级（返回 undefined / 空数组 / 缓存值），不向内核抛错
 *   - 频道成员 id 带 qg_ 前缀，防止雪花 id 在 JS number 下丢精度
 */
import type { GroupInfo, MemberInfo, MemberListOptions, UserInfo } from "@yunzai-ng/types"
import {
  addGuildPrefix,
  isGroupOpenId,
  isGuildScopeId,
  mapGroupRole,
  mapGuildRole,
  plainGuildId,
  stripGuildPrefix
} from "../protocol/codec.js"
import type { BotContext } from "./context.js"

/** 查询能力面 */
export interface QueryApi {
  getSelfInfo(): Promise<UserInfo>
  getFriend(uid: string): Promise<UserInfo | undefined>
  getFriendList(): Promise<UserInfo[]>
  getGroup(gid: string): Promise<GroupInfo | undefined>
  getGroupList(): Promise<GroupInfo[]>
  getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined>
  getGroupMemberList(gid: string, opts?: MemberListOptions): Promise<MemberInfo[]>
}

/** 建立查询能力 */
export function createQuery(ctx: BotContext): QueryApi {
  const { account, api } = ctx

  return {
    async getSelfInfo(): Promise<UserInfo> {
      // QQ Bot API: GET /users/@me
      // 返回: { id, username, avatar, bot }
      try {
        const user = await api.getSelfInfo()
        return {
          uid: user.id,
          name: user.username,
          avatar: user.avatar
        }
      } catch {
        // API 调用失败时返回缓存值
        return {
          uid: ctx.selfId,
          name: ctx.nickname,
          avatar: ""
        }
      }
    },

    async getFriend(uid: string): Promise<UserInfo | undefined> {
      // QQ Bot API: GET /v2/users/{openid}/info
      // 返回: { openid, nickname, head_url }
      try {
        const user = await api.getUserInfo(uid)
        return {
          uid: user.openid,
          name: user.nickname,
          avatar: user.head_url
        }
      } catch {
        return undefined
      }
    },

    async getFriendList(): Promise<UserInfo[]> {
      // QQ Bot API 不支持获取好友列表
      // 群聊和 C2C 私聊均无好友列表 API
      return []
    },

    async getGroup(gid: string): Promise<GroupInfo | undefined> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/info
      //   返回: { group_openid, name, avatar, owner_id, admin_count, member_count }
      //   selfRole: GET /v2/groups/{group_openid}/members/{member_openid}
      //   返回: { member_openid, join_type, role }
      // - 频道+子频道: GET /guilds/{guild_id} + GET /channels/{channel_id}
      //   返回: gid="qg_频道id-子频道id"（qg_ 前缀防止丢精度，兼容无前缀格式）, name="频道名-子频道名",
      //   avatar=频道icon, memberCount=频道member_count, maxMemberCount=频道max_members, owner=频道owner_id
      //   selfRole: GET /guilds/{guild_id}/members/{user_id}
      //   返回: roles 数组，4=owner, 2=admin, 1=member
      //
      // 判断 ID 类型：
      // - 群聊 ID (group_openid): 32位大写十六进制字符串
      // - 频道+子频道: "qg_guild_id-channel_id" 格式（如 "qg_123456-789012"）
      // - 注意：不支持单独的频道 ID，必须是组合格式

      // 检查是否是 "频道号-子频道号" 格式
      const plainGid = stripGuildPrefix(gid)
      if (plainGid.includes("-")) {
        const [guildId, channelId] = plainGid.split("-")
        try {
          const [guildInfo, channelInfo] = await Promise.all([
            api.getGuildInfo(guildId),
            api.getChannelInfo(channelId)
          ])
          // 查询机器人在频道内的角色
          let selfRole: "owner" | "admin" | "member" | undefined
          try {
            const memberInfo = await api.getGuildMemberInfo(guildId, ctx.selfId)
            selfRole = mapGuildRole(memberInfo.roles)
          } catch {
            // 查询失败时不设置 selfRole
          }
          return {
            gid: addGuildPrefix(`${guildId}-${channelId}`),
            name: `${guildInfo.name}-${channelInfo.name}`,
            avatar: guildInfo.icon,
            memberCount: guildInfo.member_count,
            maxMemberCount: guildInfo.max_members,
            owner: guildInfo.owner_id,
            selfRole
          }
        } catch {
          return undefined
        }
      }

      // 判断是群聊还是频道+子频道
      const isGroup = isGroupOpenId(gid)

      if (isGroup) {
        // 群聊 API
        try {
          const groupInfo = await api.getGroupInfo(gid)
          // 查询机器人在群内的角色
          let selfRole: "owner" | "admin" | "member" | undefined
          try {
            const memberInfo = await api.getGroupMemberInfo(gid, ctx.selfId)
            selfRole = mapGroupRole(memberInfo.role)
          } catch {
            // 查询失败时不设置 selfRole
          }
          return {
            gid: groupInfo.group_openid,
            name: groupInfo.name || "未知群",
            avatar: groupInfo.avatar,
            memberCount: groupInfo.member_count,
            owner: groupInfo.owner_id,
            selfRole
          }
        } catch {
          return undefined
        }
      } else {
        // 纯数字 ID 不支持，必须是 "频道id-子频道id" 格式
        return undefined
      }
    },

    async getGroupList(): Promise<GroupInfo[]> {
      const guilds: GroupInfo[] = []
      const seen = new Set<string>()
      let after: string | undefined

      while (true) {
        const page = await api.getGuildList(after)
        if (!page.length) break
        for (const guild of page) {
          guilds.push({
            gid: addGuildPrefix(guild.id),
            name: guild.name,
            avatar: guild.icon,
            memberCount: guild.member_count,
            maxMemberCount: guild.max_members,
            owner: guild.owner_id
          })
        }
        if (page.length < 100) break
        const next = page.at(-1)?.id
        if (!next || seen.has(next)) {
          throw new Error("QQ Bot 频道列表分页游标重复或缺失")
        }
        seen.add(next)
        after = next
      }
      return guilds
    },

    async getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/members/{member_openid}
      //   返回: { member_openid, join_type, role }
      // - 频道: GET /guilds/{guild_id}/members/{user_id}
      //   返回: { user: { id, username, avatar, bot? }, nick, roles, joined_at }
      //
      // 通过 ID 格式判断是群聊还是频道
      // 群聊 ID (group_openid): 32位大写十六进制字符串
      // 频道 ID: qg_ 前缀、数字或「频道号-子频道」组合格式
      if (isGuildScopeId(gid)) {
        // 频道 API
        try {
          const memberInfo = await api.getGuildMemberInfo(plainGuildId(gid), stripGuildPrefix(uid))
          return {
            uid: addGuildPrefix(memberInfo.user.id),
            gid,
            name: memberInfo.user.username,
            avatar: memberInfo.user.avatar,
            card: memberInfo.nick,
            role: mapGuildRole(memberInfo.roles),
            joinTime: memberInfo.joined_at ? Math.floor(new Date(memberInfo.joined_at).getTime() / 1000) : undefined
          }
        } catch {
          return undefined
        }
      } else {
        // 群聊 API
        try {
          const memberInfo = await api.getGroupMemberInfo(gid, uid)
          return {
            uid: memberInfo.member_openid,
            gid,
            name: memberInfo.username,
            avatar: `https://q.qlogo.cn/qqapp/${account.appId}/${uid}/100`,
            role: mapGroupRole(memberInfo.role),
            joinTime: memberInfo.joined_at ? Math.floor(new Date(memberInfo.joined_at).getTime() / 1000) : undefined
          }
        } catch {
          return undefined
        }
      }
    },

    async getGroupMemberList(gid: string, _opts?: MemberListOptions): Promise<MemberInfo[]> {
      // QQ Bot API:
      // - 群聊: GET /v2/groups/{group_openid}/members
      //   返回: [{ member_openid, join_type, role }]
      // - 频道: GET /guilds/{guild_id}/members
      //   返回: [{ user: { id, username, avatar }, nick, roles, joined_at }]
      if (isGuildScopeId(gid)) {
        // 频道 API
        try {
          const members = await api.getGuildMemberListInfo(plainGuildId(gid))
          return members.map(m => ({
            uid: addGuildPrefix(m.user.id),
            gid,
            name: m.user.username,
            avatar: m.user.avatar,
            card: m.nick,
            role: mapGuildRole(m.roles),
            joinTime: m.joined_at ? Math.floor(new Date(m.joined_at).getTime() / 1000) : undefined
          }))
        } catch {
          return []
        }
      } else {
        // 群聊 API
        try {
          const members = await api.getGroupMemberListInfo(gid)
          return members.map(m => ({
            uid: m.member_openid,
            gid,
            role: mapGroupRole(m.role)
          }))
        } catch {
          return []
        }
      }
    }
  }
}
