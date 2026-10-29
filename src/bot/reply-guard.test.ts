import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MSG_SEQ_MAX,
  REPLY_WINDOW_MS,
  createMessageDeduper,
  createSequenceTracker
} from "./reply-guard.js"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createMessageDeduper", () => {
  it("accepts the first push and rejects the duplicate", () => {
    const dedupe = createMessageDeduper()

    expect(dedupe.seen("group:MSG_1")).toBe(false)
    expect(dedupe.seen("group:MSG_1")).toBe(true)
    expect(dedupe.seen("group:MSG_1")).toBe(true)
    expect(dedupe.size).toBe(1)
  })

  it("keeps different messages in the same scene independent", () => {
    const dedupe = createMessageDeduper()

    expect(dedupe.seen("group:MSG_1")).toBe(false)
    expect(dedupe.seen("group:MSG_2")).toBe(false)
    expect(dedupe.seen("private:MSG_1")).toBe(false)
    expect(dedupe.size).toBe(3)
  })

  it("accepts the message again once the reply window has passed", () => {
    const dedupe = createMessageDeduper()

    expect(dedupe.seen("group:MSG_1")).toBe(false)
    vi.advanceTimersByTime(REPLY_WINDOW_MS - 1)
    expect(dedupe.seen("group:MSG_1")).toBe(true)

    vi.advanceTimersByTime(2)
    // 超出窗口后平台已不接受该 msg_id 的被动回复，重推按新消息处理
    expect(dedupe.seen("group:MSG_1")).toBe(false)
  })

  it("evicts the oldest entry when exceeding the limit", () => {
    const dedupe = createMessageDeduper({ limit: 2 })

    dedupe.seen("a")
    dedupe.seen("b")
    dedupe.seen("c")

    expect(dedupe.size).toBe(2)
    // a 已被淘汰，再出现按新消息处理
    expect(dedupe.seen("a")).toBe(false)
    expect(dedupe.size).toBe(2)
  })

  it("drops expired entries while inserting, so the map does not grow forever", () => {
    const dedupe = createMessageDeduper({ limit: 100 })

    for (let i = 0; i < 5; i++) dedupe.seen(`group:MSG_${i}`)
    expect(dedupe.size).toBe(5)

    vi.advanceTimersByTime(REPLY_WINDOW_MS + 1)
    dedupe.seen("group:MSG_NEW")

    // 之前 5 条全部过期，插入新键时被清掉
    expect(dedupe.size).toBe(1)
  })
})

describe("createSequenceTracker", () => {
  it("increments msg_seq for repeated replies to the same message", () => {
    const sequence = createSequenceTracker()

    expect(sequence.next("MSG_1")).toBe(1)
    expect(sequence.next("MSG_1")).toBe(2)
    expect(sequence.next("MSG_1")).toBe(3)
  })

  it("counts each message independently", () => {
    const sequence = createSequenceTracker()

    expect(sequence.next("MSG_1")).toBe(1)
    expect(sequence.next("MSG_2")).toBe(1)
    expect(sequence.next("MSG_1")).toBe(2)
    expect(sequence.next("MSG_2")).toBe(2)
  })

  it("restarts from 1 after the reply window when the anchor is reused", () => {
    const sequence = createSequenceTracker()

    expect(sequence.next("MSG_1")).toBe(1)
    expect(sequence.next("MSG_1")).toBe(2)

    vi.advanceTimersByTime(REPLY_WINDOW_MS + 1)
    // 窗口外同一 msg_id 不可能再被被动回复，从头计数
    expect(sequence.next("MSG_1")).toBe(1)
  })

  it("returns an in-range random seq for active pushes without an anchor", () => {
    const sequence = createSequenceTracker()

    for (let i = 0; i < 20; i++) {
      const seq = sequence.next()
      expect(seq).toBeGreaterThanOrEqual(1)
      expect(seq).toBeLessThanOrEqual(MSG_SEQ_MAX)
    }
    // 主动推送不落表，避免污染按 msg_id 索引的计数
    expect(sequence.size).toBe(0)
  })

  it("wraps to 1 instead of exceeding the platform limit", () => {
    const sequence = createSequenceTracker()

    for (let i = 0; i < MSG_SEQ_MAX; i++) sequence.next("MSG_1")
    expect(sequence.next("MSG_1")).toBe(1)
  })

  it("keeps the map bounded by evicting expired anchors", () => {
    const sequence = createSequenceTracker({ limit: 2 })

    sequence.next("MSG_1")
    sequence.next("MSG_2")
    sequence.next("MSG_3")

    expect(sequence.size).toBe(2)
  })
})
