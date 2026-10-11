import type { Env } from '../env'
import type { Channel } from './types'

const CH_LIST_KEY = 'channels:list'
const CH_PREFIX = 'channel:'
export const ALIAS_PREFIX = 'alias:'

export interface ModelAlias {
  /** 真实模型名 */
  model: string
  /** 可选:指定渠道 */
  channel?: string
}

/** 环境变量 key 兜底渠道(未配置 KV 渠道时的默认直通) */
export function defaultChannels(env: Env): Channel[] {
  const out: Channel[] = []
  if (env.OPENAI_API_KEY) {
    out.push({ id: 'env-openai', format: 'openai', baseUrl: 'https://api.openai.com', keys: [env.OPENAI_API_KEY], models: ['*'], weight: 10, enabled: true, note: 'env key' })
  }
  if (env.ANTHROPIC_API_KEY) {
    out.push({ id: 'env-anthropic', format: 'anthropic', baseUrl: 'https://api.anthropic.com', keys: [env.ANTHROPIC_API_KEY], models: ['*'], weight: 10, enabled: true, note: 'env key' })
  }
  if (env.GEMINI_API_KEY) {
    out.push({ id: 'env-gemini', format: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', keys: [env.GEMINI_API_KEY], models: ['*'], weight: 10, enabled: true, note: 'env key' })
  }
  return out
}

export async function getChannelIds(env: Env): Promise<string[]> {
  return (await env.KV.get<string[]>(CH_LIST_KEY, 'json')) ?? []
}

export async function listUserChannels(env: Env): Promise<Channel[]> {
  const ids = await getChannelIds(env)
  const got = await Promise.all(ids.map((id) => env.KV.get<Channel>(CH_PREFIX + id, 'json')))
  return got.filter((c): c is Channel => !!c && Array.isArray(c.keys) && typeof c.baseUrl === 'string')
}

/** 渠道全集 = KV 用户渠道 + env 兜底;id 冲突以用户渠道为准 */
export async function loadChannels(env: Env): Promise<Channel[]> {
  const user = await listUserChannels(env)
  const seen = new Set(user.map((c) => c.id))
  return [...user, ...defaultChannels(env).filter((c) => !seen.has(c.id))]
}

export function validateChannel(c: unknown): string | null {
  const ch = c as Channel
  if (!ch || typeof ch !== 'object') return 'body must be a JSON object'
  if (typeof ch.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(ch.id)) return 'invalid id'
  if (typeof ch.format !== 'string' || !ch.format) return 'invalid format'
  if (typeof ch.baseUrl !== 'string' || !/^https?:\/\//i.test(ch.baseUrl)) return 'invalid baseUrl'
  if (!Array.isArray(ch.keys) || !ch.keys.length || ch.keys.some((k) => typeof k !== 'string' || !k)) return 'invalid keys'
  if (!Array.isArray(ch.models)) return 'invalid models'
  if (typeof ch.weight !== 'number') ch.weight = 1
  if (typeof ch.enabled !== 'boolean') ch.enabled = true
  return null
}

export async function putChannel(env: Env, ch: Channel): Promise<void> {
  await env.KV.put(CH_PREFIX + ch.id, JSON.stringify(ch))
  const ids = new Set(await getChannelIds(env))
  ids.add(ch.id)
  await env.KV.put(CH_LIST_KEY, JSON.stringify([...ids]))
}

export async function removeChannel(env: Env, id: string): Promise<void> {
  await env.KV.delete(CH_PREFIX + id)
  const ids = new Set(await getChannelIds(env))
  ids.delete(id)
  await env.KV.put(CH_LIST_KEY, JSON.stringify([...ids]))
}

export async function getAlias(env: Env, name: string): Promise<ModelAlias | null> {
  return await env.KV.get<ModelAlias>(ALIAS_PREFIX + name, 'json')
}

export async function putAlias(env: Env, name: string, alias: ModelAlias): Promise<void> {
  await env.KV.put(ALIAS_PREFIX + name, JSON.stringify(alias))
}

export async function removeAlias(env: Env, name: string): Promise<void> {
  await env.KV.delete(ALIAS_PREFIX + name)
}

export async function listAliases(env: Env): Promise<{ name: string; alias: ModelAlias }[]> {
  const keys = await env.KV.list({ prefix: ALIAS_PREFIX })
  const out: { name: string; alias: ModelAlias }[] = []
  for (const k of keys.keys) {
    const alias = await env.KV.get<ModelAlias>(k.name, 'json')
    if (alias) out.push({ name: k.name.slice(ALIAS_PREFIX.length), alias })
  }
  return out
}
