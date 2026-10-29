import { describe, expect, it } from "vitest"
import type { IncomingMessageEvent } from "@yunzai-ng/types"
import { describeMessage } from "@yunzai-ng/core"
import { decodeEvent, describeAttachments, describeQuote } from "./inbound.js"

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

describe("decodeEvent / @机器人 与核心 at 段", () => {
  // 实测报文：群聊 @机器人 时 content 用 openid，mentions 里 is_you=true，
  // 而适配器的 selfId 是真实 QQ 号（robotUin），两套 id 不同
  const groupAtBot = {
    id: "m-at",
    group_openid: "C8CAEEF5033D4701023E6C16003D2AD4",
    content: "<@5519A1A02E6BBE79C222FA4611115C66> #消息测试",
    timestamp: "2026-10-22T13:15:13+08:00",
    author: { id: "FF23DED2F67B06F46C7A23AE9BB7C5AE", username: "归途守候你", avatar: "", role: "owner" },
    mentions: [{
      bot: true,
      id: "5519A1A02E6BBE79C222FA4611115C66",
      is_you: true,
      member_openid: "5519A1A02E6BBE79C222FA4611115C66",
      username: "阿贝多"
    }]
  }

  it("把机器人的提及归一化成 selfId 并带上昵称，对齐 NapCat 的 at 段语义", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", groupAtBot, undefined, "2854196810"))
    expect(event.message).toEqual([
      { type: "at", uid: "2854196810", name: "阿贝多" },
      { type: "text", text: " #消息测试" }
    ])
    // 核心 describeMessage 取 `name ?? uid`，日志里因此是 `[@阿贝多]`，不再出现 32 位 id
    expect(describeMessage(event.message)).toBe("[@阿贝多] #消息测试")
  })

  it("不传 selfId 时保留 openid，但昵称照补", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", groupAtBot))
    expect(event.message[0]).toEqual({
      type: "at",
      uid: "5519A1A02E6BBE79C222FA4611115C66",
      name: "阿贝多"
    })
  })

  it("mentions 缺失时不做替换，退化为平台原始 id", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      ...groupAtBot,
      mentions: undefined
    }, undefined, "2854196810"))
    expect(event.message[0]).toEqual({ type: "at", uid: "5519A1A02E6BBE79C222FA4611115C66" })
  })
})

describe("decodeEvent / 群与 C2C 共用事件体", () => {
  // 官方文档 GROUP_AT_MESSAGE_CREATE 示例 1；三个事件的事件体一致
  const body = {
    id: "ROBOT1.0_x",
    author: { id: "A1", member_openid: "A1", member_role: "owner", username: "小明", bot: false },
    content: " /今日天气 ",
    group_openid: "G1",
    message_type: 0,
    timestamp: "2026-07-21T10:00:00+08:00",
    message_scene: { source: "default", ext: ["msg_idx=REFIDX_x==", "auth_token=tok"] }
  }

  it.each(["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"])("%s 按 member_role 取群角色", type => {
    const event = asMessage(decodeEvent(type, body))
    expect(event).toMatchObject({
      scene: "group",
      group: { gid: "G1" },
      sender: { uid: "A1", gid: "G1", name: "小明", role: "owner" },
      message: [{ type: "text", text: " /今日天气 " }]
    })
    expect(event.quote).toBeUndefined()
  })

  it("C2C 用同一事件体，解码出私聊", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      ...body,
      group_openid: undefined,
      author: { id: "U1", user_openid: "U1", union_openid: "", username: "", bot: false }
    }))
    expect(event).toMatchObject({ scene: "private", subType: "friend", sender: { uid: "U1" } })
    expect(event.group).toBeUndefined()
  })

  // 实际报文常常只给 member_openid / user_openid，不像文档示例那样把 id 一起给
  it.each(["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"])(
    "%s 的 author 只有 member_openid 时仍取到 uid 与昵称",
    type => {
      const event = asMessage(decodeEvent(type, {
        ...body,
        author: { member_openid: "M1", member_role: "member", username: "小明", bot: false }
      }))
      expect(event.sender).toMatchObject({ uid: "M1", name: "小明" })
    }
  )

  it("C2C 的 author 只有 user_openid 时仍取到 uid 与昵称", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      ...body,
      group_openid: undefined,
      author: { user_openid: "U1", union_openid: "", username: "旅行者", bot: false }
    }))
    expect(event.sender).toMatchObject({ uid: "U1", name: "旅行者" })
  })

  it("username 为空串或纯空白时 name 归一为 undefined，交给内核显示 uid", () => {
    const blank = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      ...body,
      group_openid: undefined,
      author: { id: "U1", username: "   ", bot: false }
    }))
    expect(blank.sender.name).toBeUndefined()

    const missing = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      ...body,
      group_openid: undefined,
      author: { id: "U2", bot: false }
    }))
    expect(missing.sender.name).toBeUndefined()
  })

  it("昵称两侧空白会被裁掉", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      ...body,
      group_openid: undefined,
      author: { id: "U1", username: "  旅行者  ", bot: false }
    }))
    expect(event.sender.name).toBe("旅行者")
  })
})

describe("decodeEvent / 结构化卡片与消息元素", () => {
  // 官方文档 C2C_MESSAGE_CREATE 示例 2
  const miniapp = {
    ark_type: "miniapp",
    ark_name: "小程序",
    prompt: "[每日打卡]快来完成今日学习打卡",
    fields: {
      title: "快来完成今日学习打卡",
      source: "学习助手",
      tag: "微信小程序",
      preview: "https://pubminishare-30161.picsz.qpic.cn/preview_a1b2c3d4"
    }
  }

  it("保留卡片摘要文本，并附上完整 ark_data", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      author: { id: "B2C3", user_openid: "B2C3", username: "" },
      content: "[卡片消息] 小程序\n摘要: [每日打卡]快来完成今日学习打卡",
      message_type: 3,
      ark_data: miniapp,
      message_scene: { source: "default", ext: ["msg_idx=REFIDX_y=="] },
      timestamp: "2026-07-21T10:01:00+08:00"
    }))
    expect(event.message).toEqual([
      { type: "text", text: "[卡片消息] 小程序\n摘要: [每日打卡]快来完成今日学习打卡" },
      { type: "raw", platform: "qqbot", platformType: "ark_data", data: miniapp }
    ])
    expect(event.quote).toBeUndefined()
  })

  it("带跳转链接的卡片额外给出 share 段", () => {
    const tuwen = {
      ark_type: "tuwen",
      prompt: "[分享]某视频",
      fields: { title: "某视频", desc: "简介", jump_url: "https://example.com/v", preview: "https://example.com/p.jpg" }
    }
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "m",
      group_openid: "G1",
      author: { id: "A1", member_openid: "A1", member_role: "member", username: "小明" },
      content: "[卡片消息] 图文 H5",
      message_type: 3,
      ark_data: tuwen,
      timestamp: "2026-07-21T10:01:00+08:00"
    }))
    expect(event.message).toContainEqual({
      type: "share",
      url: "https://example.com/v",
      title: "某视频",
      content: "简介",
      image: "https://example.com/p.jpg"
    })
  })

  it("引用里的卡片也会解码进 quote.message", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      author: { id: "C3", username: "" },
      content: "这是什么",
      message_type: 103,
      msg_elements: [{ msg_idx: "REFIDX_a", message_type: 3, content: "[卡片消息] 小程序", ark_data: miniapp }],
      message_scene: { ext: ["ref_msg_idx=REFIDX_a"] },
      timestamp: "2026-07-21T10:02:00+08:00"
    }))
    expect(event.quote?.message).toEqual([
      { type: "text", text: "[卡片消息] 小程序" },
      { type: "raw", platform: "qqbot", platformType: "ark_data", data: miniapp }
    ])
  })

  it("引用的元素带 author 时填上被引发送者", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "m",
      group_openid: "G1",
      author: { id: "A1", username: "小明" },
      content: "同意",
      message_type: 103,
      msg_elements: [{ msg_idx: "REFIDX_b", author: { member_openid: "B2", username: "小红" }, content: "开会吗" }],
      message_scene: { ext: ["ref_msg_idx=REFIDX_b"] },
      timestamp: "2026-07-21T10:02:00+08:00"
    }))
    expect(event.quote?.sender).toEqual({ uid: "B2", name: "小红", avatar: undefined })
  })

  it("聊天记录（102）收成 forward 段，不当作引用", () => {
    const event = asMessage(decodeEvent("GROUP_MESSAGE_CREATE", {
      id: "m",
      group_openid: "G1",
      author: { id: "A1", username: "小明" },
      content: "[聊天记录]",
      message_type: 102,
      msg_elements: [
        { author: { id: "U1", username: "甲" }, content: "今天的学习计划已完成" },
        { author: { id: "U2", username: "乙" }, content: "很棒" }
      ],
      timestamp: "2026-07-21T10:10:00+08:00"
    }))
    expect(event.quote).toBeUndefined()
    expect(event.message).toEqual([
      { type: "text", text: "[聊天记录]" },
      {
        type: "forward",
        nodes: [
          { uid: "U1", name: "甲", message: [{ type: "text", text: "今天的学习计划已完成" }] },
          { uid: "U2", name: "乙", message: [{ type: "text", text: "很棒" }] }
        ]
      }
    ])
  })

  it("引用一条聊天记录时，嵌套的 102 元素在 quote 里收成 forward", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      author: { id: "C3", username: "" },
      content: "总结一下",
      message_type: 103,
      msg_elements: [{
        msg_idx: "REFIDX_c",
        message_type: 102,
        msg_elements: [{ content: "=== 消息 1 ===\n[消息内容] 你好" }]
      }],
      message_scene: { ext: ["ref_msg_idx=REFIDX_c"] },
      timestamp: "2026-07-21T10:02:00+08:00"
    }))
    expect(event.message).toEqual([{ type: "text", text: "总结一下" }])
    expect(event.quote?.message).toEqual([
      { type: "forward", nodes: [{ message: [{ type: "text", text: "=== 消息 1 ===\n[消息内容] 你好" }] }] }
    ])
  })

  it("报文自身无正文时，非引用的消息元素展开为正文", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      author: { id: "C3", username: "" },
      message_type: 101,
      msg_elements: [{ content: "并行内容" }],
      timestamp: "2026-07-21T10:02:00+08:00"
    }))
    expect(event.message).toEqual([{ type: "text", text: "并行内容" }])
    expect(event.quote).toBeUndefined()
  })

  it("报文已有正文时不重复展开消息元素", () => {
    const event = asMessage(decodeEvent("C2C_MESSAGE_CREATE", {
      id: "m",
      author: { id: "C3", username: "" },
      content: "并行内容",
      message_type: 101,
      msg_elements: [{ content: "并行内容" }],
      timestamp: "2026-07-21T10:02:00+08:00"
    }))
    expect(event.message).toEqual([{ type: "text", text: "并行内容" }])
  })
})
