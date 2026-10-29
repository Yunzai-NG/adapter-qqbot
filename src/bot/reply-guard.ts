/**
 * 模块职责：被动回复的两道防线 —— 入站消息去重 与 出站 msg_seq 递增
 * 依赖方向：只依赖 Node 内置能力，不依赖本项目任何其他模块
 * 生命周期：随 BotContext 创建，与账号同寿
 * 注意事项：
 *   - 平台会把同一条入站消息重复推送（WebSocket 重连补发、Webhook 重试、平台侧抖动），
 *     同 `msg_id` 只应处理一次，否则一次提问会触发多次回复
 *   - 被动回复的 `msg_id` + `msg_seq` 是平台侧的幂等键：同一对值重复发送会被判为重复请求而失败，
 *     因此对同一条入站消息的多次回复必须递增 `msg_seq`
 *   - 两个窗口都取 5 分钟：平台只认 5 分钟内的 `msg_id` / `event_id` 作被动回复，
 *     更早的记录既不会再被回复，也没有去重价值
 */

/** 被动回复的有效窗口：平台只认 5 分钟内的 msg_id / event_id */
export const REPLY_WINDOW_MS = 5 * 60 * 1000

/** msg_seq 上限：平台接受 1~60000，超出后回绕（同一条消息回复 6 万次不现实，回绕只为不越界） */
export const MSG_SEQ_MAX = 60_000

/** 去重表默认上限，超出按插入顺序淘汰最旧 */
const DEFAULT_SEEN_LIMIT = 2_000

/** 序号表默认上限，超出按插入顺序淘汰最旧 */
const DEFAULT_SEQ_LIMIT = 1_000

/** 入站消息去重表 */
export interface MessageDeduper {
  /**
   * 判断该消息是否已经处理过
   * @param key 去重键（场景 + messageId）
   * @returns `true` 表示窗口内已见过，这次应跳过；`false` 表示首次出现，已记录
   */
  seen(key: string): boolean
  /** 当前记录条数，供日志与测试观察 */
  readonly size: number
}

/** 出站 msg_seq 分配器 */
export interface SequenceTracker {
  /**
   * 取下一条回复序号
   * @param messageId 被动回复的锚点（`msg_id` 或 `event_id`）
   * @returns 同一锚点从 1 开始递增；无锚点（主动推送）时返回随机值
   */
  next(messageId?: string): number
  /** 当前记录条数 */
  readonly size: number
}

/**
 * 创建入站去重表
 *
 * 用 Map 的插入顺序充当 LRU：写入前把过期项从头部删掉，超出上限时同样从头部淘汰，
 * 因此不需要额外维护链表，单次写入的开销是均摊常数。
 */
export function createMessageDeduper(options: { windowMs?: number; limit?: number } = {}): MessageDeduper {
  const windowMs = options.windowMs ?? REPLY_WINDOW_MS
  const limit = options.limit ?? DEFAULT_SEEN_LIMIT
  const seenAt = new Map<string, number>()

  /** 从头部淘汰过期与超限的记录 */
  function evict(now: number): void {
    for (const [key, time] of seenAt) {
      if (now - time <= windowMs) break
      seenAt.delete(key)
    }
    while (seenAt.size > limit) {
      const oldest = seenAt.keys().next().value
      if (oldest === undefined) break
      seenAt.delete(oldest)
    }
  }

  return {
    seen(key: string): boolean {
      const now = Date.now()
      const previous = seenAt.get(key)
      if (previous !== undefined && now - previous <= windowMs) return true
      // 过期后重新出现（或首次出现）：删掉再插，保证 Map 顺序与时间顺序一致
      seenAt.delete(key)
      seenAt.set(key, now)
      evict(now)
      return false
    },
    get size(): number {
      return seenAt.size
    }
  }
}

/**
 * 创建 msg_seq 分配器
 *
 * 同一锚点的序号在窗口内必须严格递增，否则平台会以「重复请求」拒掉第二条回复。
 * 窗口外的旧锚点不再可能被被动回复，直接从头计数即可。
 */
export function createSequenceTracker(options: { windowMs?: number; limit?: number } = {}): SequenceTracker {
  const windowMs = options.windowMs ?? REPLY_WINDOW_MS
  const limit = options.limit ?? DEFAULT_SEQ_LIMIT
  const counters = new Map<string, { seq: number; time: number }>()

  /** 从头部淘汰过期与超限的记录 */
  function evict(now: number): void {
    for (const [key, value] of counters) {
      if (now - value.time <= windowMs) break
      counters.delete(key)
    }
    while (counters.size > limit) {
      const oldest = counters.keys().next().value
      if (oldest === undefined) break
      counters.delete(oldest)
    }
  }

  return {
    next(messageId?: string): number {
      // 主动推送没有被动回复锚点，随便取一个不会与已有回复撞车的起点
      if (!messageId) return Math.floor(Math.random() * MSG_SEQ_MAX) + 1

      const now = Date.now()
      const current = counters.get(messageId)
      if (current && now - current.time <= windowMs) {
        // 触顶后回绕：真实场景不可能对同一条消息回复 6 万次，这里只为不越出平台允许区间
        const seq = current.seq >= MSG_SEQ_MAX ? 1 : current.seq + 1
        current.seq = seq
        current.time = now
        return seq
      }

      counters.set(messageId, { seq: 1, time: now })
      evict(now)
      return 1
    },
    get size(): number {
      return counters.size
    }
  }
}
