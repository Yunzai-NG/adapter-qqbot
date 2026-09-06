/**
 * 模块职责：从图片 Buffer 中解析宽高
 * 依赖方向：无外部依赖，纯 Node.js Buffer 操作
 * 支持格式：PNG, JPEG, GIF, WebP
 */

export interface ImageSize {
  width: number
  height: number
}

/** 解析图片尺寸 */
export function getImageSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 12) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A ... IHDR ... width(4) height(4)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return { width, height }
  }

  // JPEG: FF D8 FF ...
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xFF) break
      const marker = buffer[offset + 1]
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        const height = buffer.readUInt16BE(offset + 5)
        const width = buffer.readUInt16BE(offset + 7)
        return { width, height }
      }
      const segmentLength = buffer.readUInt16BE(offset + 2)
      offset += 2 + segmentLength
    }
    return null
  }

  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    const width = buffer.readUInt16LE(6)
    const height = buffer.readUInt16LE(8)
    return { width, height }
  }

  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    // VP8 (lossy): 30 9D 01 2A ... width(2) height(2)
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
      const width = buffer.readUInt16LE(26) & 0x3FFF
      const height = buffer.readUInt16LE(28) & 0x3FFF
      return { width, height }
    }
    // VP8L (lossless): 56 50 38 4C ...
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
      const bits = buffer.readUInt32LE(21)
      const width = (bits & 0x3FFF) + 1
      const height = ((bits >> 14) & 0x3FFF) + 1
      return { width, height }
    }
    // VP8X (extended): 56 50 38 58 ...
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x58) {
      const width = (buffer.readUInt32LE(24) & 0xFFFFFF) + 1
      const height = (buffer.readUInt32LE(27) & 0xFFFFFF) + 1
      return { width, height }
    }
  }

  return null
}
