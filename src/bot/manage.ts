/**
 * 模块职责：群管操作 —— 禁言、踢人、入群申请处理与群文件上传
 * 依赖方向：依赖 transport/api 与 protocol/codec 的标识归一化
 * 生命周期：随 createQQBotBot 创建一次，无内部状态
 * 注意事项：
 *   - 群聊与频道是两套接口，按 id 形态分流；频道 id 要先剥掉 qg_ 前缀
 *   - 踢人与入群申请接口需要平台白名单权限，失败时把原始错误交给内核
 */
import { isGroupOpenId, plainGuildId, stripGuildPrefix } from "../protocol/codec.js"
import type { BotContext } from "./context.js"

/** 群管能力面 */
export interface ManageApi {
  muteGroupMember(gid: string, uid: string, seconds: number): Promise<void>
  kickGroupMember(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void>
  handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<void>
  uploadGroupFile(gid: string, file: string, name: string, folder?: string): Promise<void>
}

/** 建立群管能力 */
export function createManager(ctx: BotContext): ManageApi {
  const { api, host, uploader } = ctx

  return {
    async muteGroupMember(gid: string, uid: string, seconds: number): Promise<void> {
      // 判断是群聊还是频道
      if (isGroupOpenId(gid)) {
        // 群聊：POST /v2/groups/{group_openid}/restrict_chat_setting
        // 需要 RFC3339 格式的到期时间
        const expireAt = new Date(Date.now() + seconds * 1000).toISOString()
        await api.muteGroupMember(gid, uid, expireAt)
      } else {
        // 频道：PATCH /guilds/{guild_id}/members/{user_id}/mute
        await api.muteGuildMember(plainGuildId(gid), stripGuildPrefix(uid), seconds)
      }
    },

    async kickGroupMember(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void> {
      // 判断是群聊还是频道
      if (isGroupOpenId(gid)) {
        // 群聊：POST /v2/groups/{group_openid}/batch_remove_members
        // 注意：该接口需白名单权限，且正在内邀接入中
        await api.kickGroupMember(gid, [uid], rejectAddAgain)
      } else {
        // 频道：DELETE /guilds/{guild_id}/members/{user_id}
        await api.kickGuildMember(plainGuildId(gid), stripGuildPrefix(uid), rejectAddAgain)
      }
    },

    async handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<void> {
      // flag 格式: group_openid:member_openid:join_request_id
      const parts = flag.split(":")
      if (parts.length < 2) {
        host.logger.warn(`handleGroupRequest: flag 格式错误，期望 group_openid:member_openid[:join_request_id]，实际: ${flag}`)
        return
      }

      const [groupOpenId, memberOpenId, joinRequestId] = parts
      const op = approve ? "approve" : "decline"

      await api.handleGroupJoinRequest(groupOpenId, memberOpenId, op, joinRequestId, reason)
    },

    async uploadGroupFile(gid: string, file: string, name: string, _folder?: string): Promise<void> {
      if (!isGroupOpenId(gid)) {
        throw new Error("QQ Bot 仅支持向群聊上传文件")
      }
      await uploader.upload({ kind: "path", path: file }, {
        target: "group",
        targetId: gid,
        fileType: 4,
        fileName: name,
        srvSendMsg: true
      })
    }
  }
}
