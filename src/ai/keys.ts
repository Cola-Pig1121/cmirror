import type { Channel } from './types'

/**
 * Key 池:同渠道多 key 轮询 + 连续失败临时熔断(进程内,见 docs/plan.md §9)。
 * 熔断状态只存 key 指纹与失败次数,不落明文 key。
 */
const COOLDOWN_MS = 60_000
const FAIL_THRESHOLD = 3

interface KeyState {
  fails: number
  cooldownUntil: number
  rr: number
}

const states = new Map<string, KeyState>()

function fingerprint(key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0
  return h.toString(36) + ':' + key.length
}

function state(channelId: string, key: string): KeyState {
  const k = channelId + '|' + fingerprint(key)
  let s = states.get(k)
  if (!s) {
    s = { fails: 0, cooldownUntil: 0, rr: 0 }
    states.set(k, s)
  }
  return s
}

/** 该 key 当前是否可用(熔断中则不可用) */
export function keyAvailable(channelId: string, key: string, now = Date.now()): boolean {
  return state(channelId, key).cooldownUntil <= now
}

/**
 * 轮转挑选一个可用 key(跳过本次请求已失败的与熔断中的);全部不可用返回 null。
 */
export function pickKey(channel: Channel, exclude?: Set<string>, now = Date.now()): string | null {
  if (!channel.keys.length) return null
  const rr = state(channel.id, '__rr__')
  const start = rr.rr++ % channel.keys.length
  for (let i = 0; i < channel.keys.length; i++) {
    const key = channel.keys[(start + i) % channel.keys.length]!
    if (exclude?.has(key)) continue
    if (keyAvailable(channel.id, key, now)) return key
  }
  return null
}

export function reportKeyResult(channelId: string, key: string, ok: boolean, now = Date.now()): void {
  const s = state(channelId, key)
  if (ok) {
    s.fails = 0
    s.cooldownUntil = 0
    return
  }
  s.fails += 1
  if (s.fails >= FAIL_THRESHOLD) s.cooldownUntil = now + COOLDOWN_MS
}

/** 测试用 */
export function __resetKeyStates(): void {
  states.clear()
}
