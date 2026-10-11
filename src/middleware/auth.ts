import type { Env, Scope, TokenRecord } from '../env'
import { ApiError } from '../lib/errors'

export const TOKEN_COOKIE = 'cmirror_token'

const ADMIN_RECORD: TokenRecord = {
  id: 'admin',
  name: 'admin',
  scopes: ['mirror', 'ai', 'admin'],
  createdAt: 0,
}

export async function sha256hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function extractRawToken(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null
  // git smart HTTP 只发 Basic:约定 token 放密码位(用户名任意,如 git clone http://x:<token>@host/m/...)
  if (auth && /^Basic\s+/i.test(auth)) {
    try {
      const decoded = atob(auth.replace(/^Basic\s+/i, '').trim())
      const idx = decoded.indexOf(':')
      const user = idx === -1 ? decoded : decoded.slice(0, idx)
      const pass = idx === -1 ? '' : decoded.slice(idx + 1)
      return pass || user || null
    } catch {
      return null
    }
  }
  const xt = request.headers.get('x-token')
  if (xt) return xt.trim() || null
  const cookie = request.headers.get('cookie')
  if (cookie) {
    for (const pair of cookie.split(';')) {
      const idx = pair.indexOf('=')
      if (idx === -1) continue
      const k = pair.slice(0, idx).trim()
      if (k === TOKEN_COOKIE) return decodeURIComponent(pair.slice(idx + 1).trim()) || null
    }
  }
  return null
}

/** 校验令牌;无效返回 null。管理员令牌来自 Wrangler secret,不落 KV。 */
export async function resolveToken(env: Env, request: Request): Promise<TokenRecord | null> {
  const raw = extractRawToken(request)?.trim()
  if (!raw) return null
  // trim 两侧:wrangler secret put 经管道输入会带尾部换行,避免因此永远对不上
  if (env.ADMIN_TOKEN && constantTimeEquals(raw, env.ADMIN_TOKEN.trim())) return { ...ADMIN_RECORD }
  const hashKey = 'token:' + (await sha256hex(raw))
  const rec = await env.KV.get<TokenRecord>(hashKey, 'json')
  if (!rec) return null
  if (rec.expiresAt && rec.expiresAt < Date.now()) return null
  return { ...rec, raw, hashKey }
}

/** 写入 KV 前剔除明文令牌 */
export function serializeTokenRecord(record: TokenRecord): string {
  const { raw, hashKey, ...rest } = record
  return JSON.stringify(rest)
}

export function isAdmin(t: TokenRecord): boolean {
  return t.scopes.includes('admin')
}

/** 模块入口守卫:缺令牌 401,范围不足 403,额度用尽 402 */
export async function requireScope(request: Request, env: Env, scope: Scope): Promise<TokenRecord> {
  const t = await resolveToken(env, request)
  if (!t) throw new ApiError(401, 'unauthorized', 'missing or invalid token')
  if (scope !== 'admin' && t.maxRequests && (t.usedRequests ?? 0) >= t.maxRequests) {
    throw new ApiError(402, 'quota_exhausted', 'request quota exhausted')
  }
  if (isAdmin(t)) return t
  if (!t.scopes.includes(scope)) throw new ApiError(403, 'forbidden', `token lacks "${scope}" scope`)
  return t
}

export async function requireAdmin(request: Request, env: Env): Promise<TokenRecord> {
  const t = await resolveToken(env, request)
  if (!t) throw new ApiError(401, 'unauthorized', 'missing or invalid token')
  if (!isAdmin(t)) throw new ApiError(403, 'forbidden', 'admin scope required')
  return t
}

export function newTokenId(bytes = 32): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return toBase64Url(a)
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
