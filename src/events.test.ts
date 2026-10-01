import { describe, expect, it } from "vitest"
import type { IncomingMessageEvent } from "@yunzai-ng/types"
import { decodeEvent, describeAttachments, describeQuote } from "./events.js"

/** decodeEvent 返回联合类型；消息场景的用例统一收敛到消息事件 */
function asMessage(event: ReturnType<typeof decodeEvent>): IncomingMessageEvent {
  return event as IncomingMessageEvent
}

describe("describeAttachments", () => {
  it("renders the documented detailed format for an image", () => {
    expect(describeAttachments([
      {
        content_type: "image/jpeg",
        filename: "185F09D9174467A6F4F80128D605C9E5.jpg",
        height: 351,
        width: 1206,
        size: 48809,
        id: "2216239210",
        url: "gchat.qpic.cn/qmeetpic/1/0"
      }
    ])).toBe(
      "image,height=351,id=2216239210,size=48809,url=https://gchat.qpic.cn/qmeetpic/1/0," +
        "width=1206,file=https://gchat.qpic.cn/qmeetpic/1/0,name=185F09D9174467A6F4F80128D605C9E5.jpg"
    )
  })

  it("skips fields the platform did not send", () => {
    expect(describeAttachments([
      { content_type: "image/png", filename: "a.png", url: "https://e.test/a.png" }
    ])).toBe("image,url=https://e.test/a.png,file=https://e.test/a.png,name=a.png")
  })

  it("classifies audio / video / other and joins multiple attachments", () => {
    expect(describeAttachments([
      { content_type: "audio/ogg", filename: "a.ogg", url: "https://e.test/a.ogg" },
      { content_type: "video/mp4", filename: "a.mp4", url: "https://e.test/a.mp4" },
      { content_type: "application/pdf", filename: "a.pdf", url: "https://e.test/a.pdf", size: 100 }
    ])).toBe(
      "record,url=https://e.test/a.ogg,file=https://e.test/a.ogg,name=a.ogg" +
        " | video,url=https://e.test/a.mp4,file=https://e.test/a.mp4,name=a.mp4" +
        " | file,size=100,url=https://e.test/a.pdf,file=https://e.test/a.pdf,name=a.pdf"
    )
  })

  it("renders a group video attachment (no id field there)", () => {
    expect(describeAttachments([
      {
        content_type: "video/mp4",
        filename: "a1cd3bbbea25eeb5346cb80bd3b150c4.mp4",
        height: 1080,
        width: 1920,
        size: 3905543,
        url: "https://multimedia.nt.qq.com.cn/download?appid=1415"
      }
    ])).toBe(
      "video,height=1080,size=3905543,url=https://multimedia.nt.qq.com.cn/download?appid=1415," +
        "width=1920,file=https://multimedia.nt.qq.com.cn/download?appid=1415," +
        "name=a1cd3bbbea25eeb5346cb80bd3b150c4.mp4"
    )
  })

  it("renders QQ's bare `voice` content type as record, not file", () => {
    expect(describeAttachments([
      { content_type: "voice", filename: "fb8fa19c.amr", size: 2469, url: "https://multimedia.nt.qq.com.cn/download?appid=1403" }
    ])).toBe(
      "record,size=2469,url=https://multimedia.nt.qq.com.cn/download?appid=1403," +
        "file=https://multimedia.nt.qq.com.cn/download?appid=1403,name=fb8fa19c.amr"
    )
  })

  it("appends the voice-only asr / wav fields when the platform sends them", () => {
    expect(describeAttachments([{
      content_type: "voice",
      filename: "fb8fa19c.amr",
      size: 2469,
      url: "multimedia.nt.qq.com.cn/download?appid=1403",
      voice_wav_url: "multimedia.nt.qq.com.cn/wav/1403.wav",
      asr_refer_text: "今天天气不错"
    }])).toBe(
      "record,size=2469,url=https://multimedia.nt.qq.com.cn/download?appid=1403," +
        "file=https://multimedia.nt.qq.com.cn/download?appid=1403,name=fb8fa19c.amr," +
        "asr=今天天气不错,wav=https://multimedia.nt.qq.com.cn/wav/1403.wav"
    )
  })

  it("returns an empty string when there is nothing to describe", () => {
    expect(describeAttachments(undefined)).toBe("")
    expect(describeAttachments([])).toBe("")
  })
})

describe("decodeEvent / MESSAGE_CREATE", () => {
  const base = {
    id: "m1",
    channel_id: "2022350",
    guild_id: "14412030824541310936",
    timestamp: "2026-10-01T21:35:11+08:00",
    author: { id: "2492083538938174755", username: "归途守候你", avatar: "http://a" }
  }

  it("parses an image-only guild message (platform omits content)", () => {
    const event = decodeEvent("MESSAGE_CREATE", {
      ...base,
      attachments: [{ content_type: "image/png", filename: "a.png", url: "gchat.qpic.cn/x.png", width: 774, height: 476 }]
    })
    expect(event).toMatchObject({
      kind: "message",
      scene: "guild",
      message: [
        { type: "image", file: { kind: "url", url: "https://gchat.qpic.cn/x.png" }, summary: "a.png", width: 774, height: 476 }
      ]
    })
  })

  it("parses a text + image guild message keeping text first", () => {
    const event = decodeEvent("MESSAGE_CREATE", {
      ...base,
      content: "1",
      attachments: [{ content_type: "image/png", filename: "a.png", url: "https://e.test/a.png" }]
    })
    expect(event).toMatchObject({
      kind: "message",
      scene: "guild",
      message: [{ type: "text", text: "1" }, { type: "image" }]
    })
  })
})

describe("decodeEvent / 群聊与 C2C 的图片消息", () => {
  // 群聊下发的附件 URL 已是完整 https，且不带 id 字段
  const groupAttachment = {
    content: "",
    content_type: "image/jpeg",
    filename: "185F09D9174467A6F4F80128D605C9E5.jpg",
    height: 351,
    size: 48809,
    url: "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc",
    width: 1206
  }

  it("parses a group message with an image attachment", () => {
    const event = decodeEvent("GROUP_AT_MESSAGE_CREATE", {
      id: "m1",
      group_openid: "C8CAEEF5033D4701023E6C16003D2AD4",
      content: " ",
      timestamp: "2026-10-01T21:43:55+08:00",
      author: { id: "FF23", username: "归途守候你", avatar: "http://a", role: "owner" },
      attachments: [groupAttachment]
    })
    expect(event).toMatchObject({ kind: "message", scene: "group" })
    // content 为 " "，故先有一个空白文本段，其后是图片段
    expect((event as { message: unknown[] }).message).toContainEqual({
      type: "image",
      file: { kind: "url", url: groupAttachment.url },
      summary: groupAttachment.filename,
      width: 1206,
      height: 351
    })
  })

  it("parses a C2C message with an image-only payload", () => {
    const event = decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m2",
      timestamp: "2026-10-01T21:43:55+08:00",
      author: { id: "FF23", username: "归途守候你", avatar: "http://a" },
      attachments: [{ content_type: "image/png", filename: "a.png", url: "gchat.qpic.cn/a.png" }]
    })
    expect(event).toMatchObject({
      kind: "message",
      scene: "private",
      subType: "friend",
      message: [{ type: "image", file: { kind: "url", url: "https://gchat.qpic.cn/a.png" } }]
    })
  })

  it("renders a group attachment without id (platform omits it there)", () => {
    expect(describeAttachments([groupAttachment])).toBe(
      "image,height=351,size=48809,url=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc," +
        "width=1206,file=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc," +
        "name=185F09D9174467A6F4F80128D605C9E5.jpg"
    )
  })
})

describe("describeQuote", () => {
  it("renders the quoted body with sender and a truncated index", () => {
    expect(describeQuote({
      messageId: "REFIDX_X50iYj1Fv3B0jXJ5lwrZR+230P0xUq4dQA",
      sender: { uid: "FF23", name: "归途守候你" },
      text: "2",
      message: [{ type: "text", text: "2" }]
    })).toBe("引用 [REFIDX_X50iYj1Fv3B0jXJ5l…] 归途守候你(FF23): 2")
  })

  it("summarises media carried inside the quoted message", () => {
    expect(describeQuote({
      messageId: "REFIDX_IMG",
      message: [
        { type: "text", text: "看这个" },
        { type: "image", file: { kind: "url", url: "https://e.test/a.png" }, summary: "a.png" }
      ]
    })).toBe("引用 [REFIDX_IMG]: 看这个[图片 a.png]")
  })

  it("renders a channel quote that only carries an id", () => {
    expect(describeQuote({ messageId: "08d89f8fe6d3b5f480c80110c1d28f5e38f405489bd4f9d506" }))
      .toBe("引用 [08d89f8fe6d3b5f480c80110…]")
  })

  it("returns an empty string without a quote", () => {
    expect(describeQuote(undefined)).toBe("")
  })
})

describe("decodeEvent / 引用消息", () => {
  // 实测报文：群 / C2C 的引用正文内联在 msg_elements，索引在 message_scene.ext
  const groupRefIdx =
    "REFIDX_X50iYj1Fv3B0jXJ5lwrZR+230P0xUq4dQA799s4fAHEF4CUPmpMV71cgwy6hd/uWAcSBvVb9bzIKq4JyXOci7O84" +
    "+3ecboeYK8bgz2vB+2XgpX7Ja5dcOe7V+7exWWdY"

  it("inlines the quoted text of a group reply", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "ROBOT1.0_group",
      group_openid: "C8CAEEF5033D4701023E6C16003D2AD4",
      content: " 1",
      timestamp: "2026-10-01T22:09:13+08:00",
      author: { id: "FF23DED2F67B06F46C7A23AE9BB7C5AE", username: "归途守候你", member_role: "owner" },
      message_type: 103,
      message_scene: {
        source: "default",
        ext: [`ref_msg_idx=${groupRefIdx}`, "msg_idx=REFIDX_ElUn", "auth_token=tok"]
      },
      msg_elements: [{ content: "2", message_type: 103, msg_idx: groupRefIdx }]
    }))

    expect(event.message).toEqual([{ type: "text", text: " 1" }])
    expect(event.quote).toEqual({
      messageId: groupRefIdx,
      text: "2",
      message: [{ type: "text", text: "2" }]
    })
  })

  it("inlines the quoted text of a C2C reply", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "ROBOT1.0_c2c",
      content: "2",
      timestamp: "2026-10-01T22:10:47+08:00",
      author: { id: "FF23DED2F67B06F46C7A23AE9BB7C5AE", username: "" },
      message_type: 103,
      message_scene: { source: "default", ext: ["ref_msg_idx=REFIDX_6isKsjKe", "msg_idx=REFIDX_d34I6"] },
      msg_elements: [{ content: "1", message_type: 103, msg_idx: "REFIDX_6isKsjKe" }]
    }))

    expect(event.quote).toMatchObject({
      messageId: "REFIDX_6isKsjKe",
      text: "1",
      message: [{ type: "text", text: "1" }]
    })
  })

  it("falls back to parallel_message.msg_nodes when msg_elements is absent", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      content: "2",
      timestamp: "2026-10-01T22:10:47+08:00",
      author: { id: "FF23", username: "" },
      message_type: 103,
      message_scene: { ext: ["ref_msg_idx=REFIDX_ONLY"] },
      parallel_message: { msg_nodes: [{ content: "1", message_type: 0 }] }
    }))

    expect(event.quote).toMatchObject({
      messageId: "REFIDX_ONLY",
      message: [{ type: "text", text: "1" }]
    })
  })

  it("decodes a quoted image so `images` can pick it up", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "m",
      group_openid: "G1",
      content: "这是什么",
      timestamp: "2026-10-01T22:09:13+08:00",
      author: { id: "FF23", username: "归途守候你" },
      message_type: 103,
      message_scene: { ext: ["ref_msg_idx=REFIDX_IMG"] },
      msg_elements: [{
        message_type: 103,
        msg_idx: "REFIDX_IMG",
        attachments: [{
          content_type: "image/jpeg",
          filename: "q.jpg",
          url: "multimedia.nt.qq.com.cn/q.jpg",
          width: 100,
          height: 200
        }]
      }]
    }))

    expect(event.quote?.message).toEqual([
      {
        type: "image",
        file: { kind: "url", url: "https://multimedia.nt.qq.com.cn/q.jpg" },
        summary: "q.jpg",
        width: 100,
        height: 200
      }
    ])
  })

  it("keeps only the message id for a guild reply (platform sends no body)", () => {
    const event = asMessage(decodeEvent("MESSAGE_CREATE", {
      id: "08d89f8fe6d3b5f480c80110c1d28f5e38f50548a1d4f9d506",
      channel_id: "197388609",
      guild_id: "14412030824541310936",
      content: "2",
      timestamp: "2026-10-01T22:11:45+08:00",
      author: { id: "2492083538938174755", username: "归途守候你" },
      message_reference: { message_id: "08d89f8fe6d3b5f480c80110c1d28f5e38f405489bd4f9d506" }
    }))

    expect(event.quote).toEqual({
      messageId: "08d89f8fe6d3b5f480c80110c1d28f5e38f405489bd4f9d506"
    })
  })

  it("leaves quote undefined when the message is not a reply", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "m",
      group_openid: "G1",
      content: "2",
      timestamp: "2026-10-01T22:09:05+08:00",
      author: { id: "FF23", username: "归途守候你" },
      message_scene: { source: "default", ext: ["msg_idx=REFIDX_ElUn", "auth_token=tok"] }
    }))

    expect(event.quote).toBeUndefined()
  })
})
