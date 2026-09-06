/**
 * 模块职责：Ed25519 签名验证
 * 依赖方向：依赖 tweetnacl 库（与 karin-plugin-adapter-qqbot 一致）
 * 生命周期：随插件加载
 * 注意事项：
 *   - 密钥种子：botSecret 重复填充至 32 字节
 *   - sign: 对 UTF-8 消息生成 detached 签名，返回 hex
 *   - verify: 重新计算签名并与传入的签名做字符串比较
 */
import nacl from "tweetnacl"

/** 从 secret 生成密钥对（不足 32 字节循环填充） */
function generateKeyPair(seed: string) {
  let finalSeed = seed
  while (finalSeed.length < 32) finalSeed = finalSeed.repeat(2)
  finalSeed = finalSeed.slice(0, 32)
  return nacl.sign.keyPair.fromSeed(Buffer.from(finalSeed, "utf-8"))
}

/** Ed25519 签名工具 */
export class Ed25519 {
  private secretKey: Uint8Array
  private publicKey: Uint8Array

  /**
   *
   */
  constructor(secret: string) {
    const keyPair = generateKeyPair(secret)
    this.secretKey = keyPair.secretKey
    this.publicKey = keyPair.publicKey
  }

  /** 对 eventTs + token 签名（hex 编码） */
  sign(eventTs: string, token: string): string {
    const messageBytes = Buffer.from(eventTs + token, "utf-8")
    const signature = nacl.sign.detached(messageBytes, this.secretKey)
    return Buffer.from(signature).toString("hex")
  }

  /** 验证 webhook 推送签名（重新计算签名并比较） */
  verify(timestamp: string, rawBody: string, ed25519Hex: string): boolean {
    const expected = this.sign(timestamp, rawBody)
    return expected === ed25519Hex
  }
}
