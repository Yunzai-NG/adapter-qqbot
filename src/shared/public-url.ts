/**
 * 模块职责：判断一个地址能否被公网访问（QQ 服务器来拉图，拉不到就等于发不出去）
 * 依赖方向：仅依赖运行时 URL
 * 生命周期：无状态纯函数
 * 注意事项：只做「公网可达性」判定，不校验 https —— 卡片的 url / pic_url 需要 https 是另一层规则
 */

/**
 * 判断主机名是否落在回环 / 内网 / 链路本地段
 * @param host URL 里的 hostname（IPv6 可能带方括号）
 * @returns 是否属于无法从公网访问的地址
 */
function isPrivateHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (!hostname) return true

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  if (/\.(local|internal|lan|home\.arpa|localdomain)$/.test(hostname)) return true

  // IPv6：回环、未指定、ULA（fc00::/7）、链路本地（fe80::/10）、IPv4 映射
  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1") return true
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true
    if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname)
    return mapped ? isPrivateHost(mapped[1]) : false
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  // 单标签主机名（如 `myserver`）只在内网可解析，公网拉不到
  return !hostname.includes(".")
}

/**
 * 判断地址是否为公网可达的 http(s) 链接
 * @param value 待判定的基址或链接
 * @returns 是否可从公网访问
 */
export function isPublicHttpUrl(value: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return !isPrivateHost(url.hostname)
  } catch {
    return false
  }
}
