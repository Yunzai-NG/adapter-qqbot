import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SharpMeta } from "../shared/optional-deps.js"

/** 被 mock 掉的可选依赖装载器：每个用例自行决定装没装 */
const deps = vi.hoisted(() => ({
  sharp: undefined as unknown,
  silk: undefined as unknown
}))

/** 被 mock 掉的 ffmpeg 调用：默认当作本机没装 */
const ffmpeg = vi.hoisted(() => ({ calls: 0 }))

vi.mock("../shared/optional-deps.js", () => ({
  loadSharp: async () => deps.sharp,
  loadSilk: async () => deps.silk
}))

vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void
  ) => {
    ffmpeg.calls++
    callback(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }))
  }
}))

const { prepareMediaForSend, shrinkImage, shouldTranscodeBeforeTransfer, transcodeToSilk } =
  await import("./transform.js")

/** 记录一次编码尝试的形态，供 fake sharp 决定产物大小 */
interface FakeState {
  width?: number
  quality?: number
  format: "jpeg" | "png" | "webp"
  flattened: boolean
}

/**
 * 造一个假 sharp：只记录「缩到多宽 / 什么格式 / 多少质量」，产出字节数由用例给定
 * @param meta metadata() 返回值
 * @param sizeOf 按当次编码形态给出产物字节数
 * @returns sharp 工厂与调用次数探针
 */
function fakeSharp(meta: Partial<SharpMeta>, sizeOf: (state: FakeState) => number) {
  const calls: FakeState[] = []
  const factory = (_input: Buffer) => {
    const state: FakeState = { format: "jpeg", flattened: false }
    const image: Record<string, unknown> = {
      metadata: async () => ({ width: 2000, height: 1000, format: "png", ...meta }),
      resize: (options: { width?: number }) => {
        state.width = options?.width
        return image
      },
      flatten: () => {
        state.flattened = true
        return image
      },
      jpeg: (options?: { quality?: number }) => {
        state.format = "jpeg"
        state.quality = options?.quality
        return image
      },
      png: () => {
        state.format = "png"
        return image
      },
      webp: () => {
        state.format = "webp"
        return image
      },
      toBuffer: async () => {
        calls.push({ ...state })
        return Buffer.alloc(sizeOf(state))
      }
    }
    return image
  }
  return { factory, calls }
}

/** 假 silk-wasm：默认认 WAV、不认 SILK，编码产出固定长度 */
function fakeSilk(options: { silk?: boolean; wav?: boolean; encoded?: number } = {}) {
  const encodes: { sampleRate: number; length: number }[] = []
  return {
    encodes,
    module: {
      isSilk: () => options.silk === true,
      isWav: () => options.wav !== false,
      encode: async (input: Uint8Array, sampleRate: number) => {
        encodes.push({ sampleRate, length: input.length })
        return { data: new Uint8Array(options.encoded ?? 64), duration: 1200 }
      }
    }
  }
}

beforeEach(() => {
  deps.sharp = undefined
  deps.silk = undefined
})

describe("shrinkImage", () => {
  it("leaves an image under the cap untouched and never loads sharp", async () => {
    const { factory, calls } = fakeSharp({}, () => 1)
    deps.sharp = factory

    expect(await shrinkImage(Buffer.alloc(1000), 2048)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("degrades quality step by step until the image fits", async () => {
    // 82 → 5000，74 → 4000，66 → 2000：上限 3000，应在质量 66 命中
    const { factory, calls } = fakeSharp({ hasAlpha: false }, state => {
      if (state.quality === 82) return 5000
      if (state.quality === 74) return 4000
      return 2000
    })
    deps.sharp = factory

    const shrunk = await shrinkImage(Buffer.alloc(10_000), 3000)

    expect(shrunk).toBeDefined()
    expect(shrunk!.after).toBe(2000)
    expect(shrunk!.before).toBe(10_000)
    expect(shrunk!.format).toBe("jpeg")
    expect(shrunk!.mime).toBe("image/jpeg")
    expect(shrunk!.fileName).toBe("image.jpg")
    expect(calls.map(call => call.quality)).toEqual([82, 74, 66])
    expect(calls[0].flattened).toBe(true)
    expect(calls[0].width).toBeUndefined()
  })

  it("shrinks the long side only after every quality still overflows", async () => {
    const { factory, calls } = fakeSharp({ hasAlpha: false }, state => state.width === undefined ? 9000 : 2500)
    deps.sharp = factory

    const shrunk = await shrinkImage(Buffer.alloc(20_000), 3000)

    expect(shrunk).toBeDefined()
    expect(shrunk!.after).toBe(2500)
    // 2000 宽按 0.78 缩一档 = 1560
    expect(calls.at(-1)!.width).toBe(1560)
  })

  it("returns undefined when sharp is missing", async () => {
    expect(await shrinkImage(Buffer.alloc(10_000), 1000)).toBeUndefined()
  })

  it("skips animated gif and svg instead of destroying them", async () => {
    for (const meta of [{ format: "gif", pages: 7 }, { format: "svg" }]) {
      const { factory, calls } = fakeSharp(meta, () => 100)
      deps.sharp = factory
      expect(await shrinkImage(Buffer.alloc(10_000), 1000)).toBeUndefined()
      expect(calls).toHaveLength(0)
    }
  })

  it("keeps transparency by trying png first when alpha exists", async () => {
    const { factory, calls } = fakeSharp({ hasAlpha: true }, state => state.format === "png" ? 2000 : 100)
    deps.sharp = factory

    const shrunk = await shrinkImage(Buffer.alloc(10_000), 3000)

    expect(shrunk!.format).toBe("png")
    expect(shrunk!.mime).toBe("image/png")
    expect(calls).toHaveLength(1)
    expect(calls[0].flattened).toBe(false)
  })

  it("falls back to jpeg on white when png cannot fit", async () => {
    const { factory, calls } = fakeSharp({ hasAlpha: true }, state => state.format === "png" ? 9000 : 2000)
    deps.sharp = factory

    const shrunk = await shrinkImage(Buffer.alloc(10_000), 3000)

    expect(shrunk!.format).toBe("jpeg")
    expect(calls.every(call => call.format === "jpeg" ? call.flattened : true)).toBe(true)
    expect(calls.some(call => call.format === "jpeg" && call.flattened)).toBe(true)
  })

  it("gives up and reports the original when nothing fits", async () => {
    const { factory } = fakeSharp({ hasAlpha: false }, () => 9000)
    deps.sharp = factory

    expect(await shrinkImage(Buffer.alloc(10_000), 1000)).toBeUndefined()
  })

  it("treats a zero or negative cap as 'no compression'", async () => {
    const { factory, calls } = fakeSharp({ hasAlpha: false }, () => 1)
    deps.sharp = factory

    expect(await shrinkImage(Buffer.alloc(10_000), 0)).toBeUndefined()
    expect(await shrinkImage(Buffer.alloc(10_000), -1)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe("transcodeToSilk", () => {
  it("encodes wav input with sampleRate 0 and reports duration", async () => {
    const { module, encodes } = fakeSilk({ encoded: 128 })
    deps.silk = module

    const result = await transcodeToSilk(Buffer.alloc(2048))

    expect(result).toBeDefined()
    expect(result!.buffer).toHaveLength(128)
    expect(result!.duration).toBe(1200)
    expect(encodes).toEqual([{ sampleRate: 0, length: 2048 }])
  })

  it("leaves an existing silk untouched", async () => {
    const { module, encodes } = fakeSilk({ silk: true })
    deps.silk = module

    expect(await transcodeToSilk(Buffer.alloc(64))).toBeUndefined()
    expect(encodes).toHaveLength(0)
  })

  it("asks ffmpeg for non-wav input, then stops retrying once it is missing", async () => {
    const { module, encodes } = fakeSilk({ wav: false })
    deps.silk = module
    const tried = ffmpeg.calls

    expect(await transcodeToSilk(Buffer.alloc(64))).toBeUndefined()
    expect(encodes).toHaveLength(0)
    // 先试一次 ffmpeg；ENOENT 之后可用性被记忆，后续语音不再 fork
    expect(ffmpeg.calls).toBe(tried + 1)
    expect(await transcodeToSilk(Buffer.alloc(64))).toBeUndefined()
    expect(ffmpeg.calls).toBe(tried + 1)
  })

  it("returns undefined when silk-wasm is missing", async () => {
    expect(await transcodeToSilk(Buffer.alloc(64))).toBeUndefined()
  })
})

describe("shouldTranscodeBeforeTransfer", () => {
  it("localizes voice unless the url is already silk", () => {
    expect(shouldTranscodeBeforeTransfer(3, "https://a.test/v.wav")).toBe(true)
    expect(shouldTranscodeBeforeTransfer(3, "https://a.test/v.amr?x=1")).toBe(true)
    expect(shouldTranscodeBeforeTransfer(3, "https://a.test/v")).toBe(true)
    expect(shouldTranscodeBeforeTransfer(3, "https://a.test/v.silk")).toBe(false)
    expect(shouldTranscodeBeforeTransfer(3, "https://a.test/v.SILK")).toBe(false)
  })

  it("never blocks image / video / file transfer", () => {
    expect(shouldTranscodeBeforeTransfer(1, "https://a.test/i.png")).toBe(false)
    expect(shouldTranscodeBeforeTransfer(2, "https://a.test/v.mp4")).toBe(false)
    expect(shouldTranscodeBeforeTransfer(4, "https://a.test/a.bin")).toBe(false)
  })
})

describe("prepareMediaForSend", () => {
  it("shrinks images and fixes the extension", async () => {
    const { factory } = fakeSharp({ hasAlpha: false }, () => 2000)
    deps.sharp = factory

    const prepared = await prepareMediaForSend(
      { buffer: Buffer.alloc(10_000), fileName: "cat.png", mime: "image/png" },
      1,
      { imageMaxBytes: 3000 }
    )

    expect(prepared.changed).toBe(true)
    expect(prepared.buffer).toHaveLength(2000)
    expect(prepared.fileName).toBe("cat.jpg")
    expect(prepared.mime).toBe("image/jpeg")
    expect(prepared.note).toContain("图片压缩")
  })

  it("transcodes wav voice to silk and renames it", async () => {
    const { module } = fakeSilk({ encoded: 128 })
    deps.silk = module

    const prepared = await prepareMediaForSend(
      { buffer: Buffer.alloc(2048), fileName: "hello.wav", mime: "audio/wav" },
      3
    )

    expect(prepared.changed).toBe(true)
    expect(prepared.buffer).toHaveLength(128)
    expect(prepared.fileName).toBe("hello.silk")
    expect(prepared.mime).toBe("audio/silk")
  })

  it("passes video and file bytes through untouched", async () => {
    const buffer = Buffer.from("binary")
    for (const fileType of [2, 4] as const) {
      const prepared = await prepareMediaForSend({ buffer, fileName: "a.bin" }, fileType, { imageMaxBytes: 1 })
      expect(prepared.changed).toBe(false)
      expect(prepared.buffer).toBe(buffer)
      expect(prepared.fileName).toBe("a.bin")
    }
  })

  it("keeps the caller's file name when nothing had to change", async () => {
    const { factory } = fakeSharp({ hasAlpha: false }, () => 100)
    deps.sharp = factory

    const prepared = await prepareMediaForSend(
      { buffer: Buffer.alloc(1000), fileName: "small.png", mime: "image/png" },
      1,
      { imageMaxBytes: 3000 }
    )

    expect(prepared.changed).toBe(false)
    expect(prepared.fileName).toBe("small.png")
    expect(prepared.mime).toBe("image/png")
  })
})
