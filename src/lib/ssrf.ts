export interface SsrfOptions {
  /** 允许的端口;默认 [80, 443];'all' 表示不限制 */
  allowedPorts?: number[] | 'all'
  /** 放行内网/私有地址(仅内部场景或测试显式开启) */
  allowPrivate?: boolean
}

export type SsrfResult = { ok: true; url: URL } | { ok: false; reason: string }

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.localdomain', '.cloudnet']
const BLOCKED_HOST_EXACT = ['localhost', 'metadata', 'metadata.google.internal']

/**
 * WHATWG 风格遗留 IPv4 字面量解析:支持 a.b.c.d、1~4 段、十进制/八进制(0 前缀)/十六进制(0x 前缀)、
 * 以及 "2130706433" 这类整数写法。返回 32 位无符号整数;不是合法 IPv4 字面量则返回 null。
 */
export function parseLegacyIpv4(input: string): number | null {
  let s = input
  if (s.endsWith('.')) s = s.slice(0, -1)
  if (!s) return null
  const parts = s.split('.')
  if (parts.length > 4 || parts.some((p) => p === '')) return null
  const nums: number[] = []
  for (const part of parts) {
    let radix = 10
    let t = part
    if (/^0x/i.test(t)) {
      radix = 16
      t = t.slice(2)
    } else if (t.length > 1 && t.startsWith('0')) {
      radix = 8
    }
    if (!t) return null
    const valid =
      radix === 16
        ? /^[0-9a-f]+$/i.test(t)
        : radix === 8
          ? /^[0-7]+$/.test(t)
          : /^[0-9]+$/.test(t)
    if (!valid) return null
    const n = parseInt(t, radix)
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  const MAX = (bits: number) => 2 ** bits - 1
  if (nums.length === 1) {
    if (nums[0]! > MAX(32)) return null
    return nums[0] >>> 0
  }
  if (nums.length === 2) {
    if (nums[0]! > MAX(8) || nums[1]! > MAX(24)) return null
    return ((nums[0]! << 24) | nums[1]!) >>> 0
  }
  if (nums.length === 3) {
    if (nums[0]! > MAX(8) || nums[1]! > MAX(8) || nums[2]! > MAX(16)) return null
    return ((nums[0]! << 24) | (nums[1]! << 16) | nums[2]!) >>> 0
  }
  if (nums.some((p) => p > MAX(8))) return null
  return ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0
}

export function isBlockedIpv4(n: number): boolean {
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  const c = (n >>> 8) & 0xff
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark 198.18/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved
  return false
}

/** 解析 IPv6 字面量(可带 []、可含内嵌 IPv4 尾段)。返回 8 组 16 位数;非法返回 null。 */
export function parseIpv6Groups(input: string): number[] | null {
  let s = input
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (!s) return null

  // 内嵌 IPv4 尾段转两组
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseLegacyIpv4(tail)
    if (v4 === null) return null
    s = s.slice(0, lastColon + 1) + (((v4 >>> 16) & 0xffff).toString(16)) + ':' + (v4 & 0xffff).toString(16)
  }

  let groups: number[]
  if (s.includes('::')) {
    const parts = s.split('::')
    if (parts.length > 2) return null
    const head = parts[0] === '' ? [] : parts[0]!.split(':')
    const rawTail = parts[1] ?? ''
    const t = rawTail === '' ? [] : rawTail.split(':')
    const total = head.length + t.length
    if (total > 7) return null
    const parsedHead: number[] = []
    for (const g of head) {
      const v = parseHexGroup(g)
      if (v === null) return null
      parsedHead.push(v)
    }
    const parsedTail: number[] = []
    for (const g of t) {
      const v = parseHexGroup(g)
      if (v === null) return null
      parsedTail.push(v)
    }
    groups = [...parsedHead, ...new Array(8 - total).fill(0), ...parsedTail]
  } else {
    const parts = s.split(':')
    if (parts.length !== 8) return null
    groups = []
    for (const g of parts) {
      const v = parseHexGroup(g)
      if (v === null) return null
      groups.push(v)
    }
  }
  return groups.length === 8 ? groups : null
}

function parseHexGroup(g: string): number | null {
  if (!g || !/^[0-9a-f]{1,4}$/i.test(g)) return null
  return parseInt(g, 16)
}

export function isBlockedIpv6(groups: number[]): boolean {
  const allZero = groups.every((g) => g === 0)
  if (allZero) return true // :: 未指定
  const restZero = groups.slice(0, 6).every((g) => g === 0)
  if (restZero && groups[6] === 0) {
    if (groups[7] === 1) return true // ::1 loopback
  }
  if ((groups[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((groups[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0]! & 0xff00) === 0xff00) return true // ff00::/8 multicast
  // ::ffff:<v4>
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    if (isBlockedIpv4(((groups[6]! << 16) | groups[7]!) >>> 0)) return true
  }
  // 2002::<v4> 6to4 内嵌地址
  if (groups[0] === 0x2002) {
    if (isBlockedIpv4(((groups[1]! << 16) | groups[2]!) >>> 0)) return true
  }
  return false
}

function checkHost(hostname: string, allowPrivate: boolean): SsrfResult | null {
  let host = hostname.toLowerCase().replace(/\.+$/, '')
  if (!host) return { ok: false, reason: 'empty_host' }

  if (host.startsWith('[') && host.endsWith(']')) {
    if (allowPrivate) return null
    const groups = parseIpv6Groups(host)
    if (!groups) return { ok: false, reason: 'invalid_ipv6_literal' }
    if (isBlockedIpv6(groups)) return { ok: false, reason: 'ipv6_private_or_reserved' }
    return null
  }

  // IPv4 字面量(含遗留八进制/十六进制与单段整数写法,如 0x7f000001、2130706433、0177.0.0.1)
  // 仅由 0-9a-fx. 组成且含数字时才尝试解析,普通域名不受影响
  if (/^[0-9a-fxX.]+$/.test(host) && /\d/.test(host)) {
    const n = parseLegacyIpv4(host)
    if (n !== null) {
      if (!allowPrivate && isBlockedIpv4(n)) return { ok: false, reason: 'ipv4_private_or_reserved' }
      return null
    }
    // 看起来是 IPv4 但越界/畸形(如 1.2.3.999)
    if (/^[0-9.]+$/.test(host)) return { ok: false, reason: 'invalid_ipv4_literal' }
  }

  if (!allowPrivate) {
    if (BLOCKED_HOST_EXACT.includes(host)) return { ok: false, reason: 'blocked_hostname' }
    if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: 'blocked_hostname' }
  }
  return null
}

/**
 * 镜像/回源前的目标地址安全检查(docs/plan.md §7 步骤 2)。
 * 限制:协议仅 http/https、拒绝凭据、常规端口白名单、拒绝回环/私有/链路本地/组播/云元数据等字面量地址。
 * 已知局限:域名形式目标在 fetch 时才解析,无法在此拦截 DNS 解析到内网(重绑定);
 * v1 通过镜像白名单(仅放行规则表内站点)规避该风险。
 */
export function validateTargetUrl(raw: string, opts: SsrfOptions = {}): SsrfResult {
  const allowedPorts = opts.allowedPorts ?? [80, 443]
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' }
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' }

  if (url.port) {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: 'invalid_port' }
    if (allowedPorts !== 'all' && !allowedPorts.includes(port)) {
      return { ok: false, reason: 'port_not_allowed' }
    }
  }

  return checkHost(url.hostname, !!opts.allowPrivate) ?? { ok: true, url }
}
