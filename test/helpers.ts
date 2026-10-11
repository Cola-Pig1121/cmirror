import type { Env, TokenRecord } from '../src/env'
import type { Channel } from '../src/ai/types'

export class MemoryKV {
  store = new Map<string, string>()
  async get(key: string, type?: string | { type?: string } | null): Promise<unknown> {
    const t = typeof type === 'string' ? type : type?.type ?? 'text'
    const v = this.store.get(String(key))
    if (v == null) return null
    if (t === 'json') return JSON.parse(v)
    if (t === 'arrayBuffer') return new TextEncoder().encode(v).buffer
    return v
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(String(key), String(value))
  }
  async delete(key: string): Promise<void> {
    this.store.delete(String(key))
  }
  async list(opts: { prefix?: string; limit?: number } = {}): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    const keys = [...this.store.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .slice(0, opts.limit ?? 1000)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  }
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const datapoints: unknown[] = []
  const env = {
    KV: new MemoryKV(),
    ADMIN_TOKEN: 'test-admin',
    ANALYTICS: { writeDataPoint: (p?: unknown) => void datapoints.push(p) },
    ...overrides,
  } as unknown as Env
  return { env, datapoints }
}

export function makeCtx() {
  const promises: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  return { ctx, promises }
}

/** waitUntil 内部可能再链式等待;多次冲刷直到稳定 */
export async function flushPromises(promises: Promise<unknown>[]) {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await Promise.allSettled([...promises])
  }
}

export async function seedChannel(kv: MemoryKV, ch: Channel) {
  await kv.put('channel:' + ch.id, JSON.stringify(ch))
  const ids = (JSON.parse(kv.store.get('channels:list') ?? '[]') as string[]).filter((x) => x !== ch.id)
  kv.store.set('channels:list', JSON.stringify([...ids, ch.id]))
}

export async function seedToken(kv: MemoryKV, hash: string, rec: TokenRecord) {
  await kv.put('token:' + hash, JSON.stringify(rec))
}

export function sseStream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream() as ReadableStream<Uint8Array>
}
