import { Elysia } from 'elysia'
import type { Env, TokenRecord, Scope } from '../env'
import { getEnv } from '../runtime'
import { requireAdmin, resolveToken, isAdmin, newTokenId, sha256hex } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { loadRules, validateRules, DEFAULT_RULES } from '../mirror/rules'
import { validateChannel, putChannel, removeChannel, listUserChannels, putAlias, getAlias, removeAlias, listAliases, type ModelAlias } from '../ai/channels'

const VALID_SCOPES: Scope[] = ['mirror', 'ai']

/** /admin 基础管理:令牌、渠道、镜像规则、模型别名(仅管理员令牌) */
export const adminModule = new Elysia({ name: 'admin' })
  /** 当前令牌身份探测:前端据此隐藏/放行管理入口(无令牌也 200,便于匿名查询) */
  .get('/api/whoami', async (c) => {
    const env = getEnv(c.request)
    const t = await resolveToken(env, c.request)
    if (!t) return Response.json({ authed: false })
    return Response.json({ authed: true, id: t.id, name: t.name, scopes: t.scopes, admin: isAdmin(t) })
  })

  .post('/admin/tokens', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const b = (c.body ?? {}) as {
      name?: string
      scopes?: string[]
      models?: string[]
      rpm?: number
      maxRequests?: number
      maxTokens?: number
      expiresDays?: number
    }
    const scopes = (b.scopes ?? []).filter((s): s is Scope => VALID_SCOPES.includes(s as Scope))
    if (!scopes.length) throw new ApiError(400, 'bad_request', 'at least one of scopes [mirror,ai] required')
    const raw = newTokenId()
    const rec: TokenRecord = {
      id: (await sha256hex(raw)).slice(0, 16),
      name: b.name ?? 'untitled',
      scopes,
      models: b.models?.length ? b.models : undefined,
      rpm: b.rpm && b.rpm > 0 ? b.rpm : undefined,
      maxRequests: b.maxRequests && b.maxRequests > 0 ? b.maxRequests : undefined,
      maxTokens: b.maxTokens && b.maxTokens > 0 ? b.maxTokens : undefined,
      expiresAt: b.expiresDays && b.expiresDays > 0 ? Date.now() + b.expiresDays * 86400_000 : undefined,
      createdAt: Date.now(),
    }
    await env.KV.put('token:' + (await sha256hex(raw)), JSON.stringify(rec))
    return Response.json({ token: raw, record: rec }, { status: 201 })
  })

  .get('/admin/tokens', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const { keys } = await env.KV.list({ prefix: 'token:' })
    const out = await Promise.all(
      keys.map(async (k) => ({ key: k.name, record: await env.KV.get(k.name, 'json') })),
    )
    return Response.json(out)
  })

  .delete('/admin/tokens/:hash', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    await env.KV.delete('token:' + c.params.hash)
    return Response.json({ ok: true })
  })

  .get('/admin/channels', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const user = await listUserChannels(env)
    return Response.json({ user, envDefaults: env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY })
  })

  .put('/admin/channels/:id', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const body = (c.body ?? {}) as Record<string, unknown>
    const channel = { ...body, id: c.params.id as string }
    const err = validateChannel(channel)
    if (err) throw new ApiError(400, 'bad_channel', err)
    await putChannel(env, channel as never)
    return Response.json({ ok: true })
  })

  .delete('/admin/channels/:id', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    await removeChannel(env, c.params.id as string)
    return Response.json({ ok: true })
  })

  .get('/admin/mirror-rules', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    return Response.json(await loadRules(env))
  })

  .put('/admin/mirror-rules', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const rules = c.body
    if (!Array.isArray(rules)) throw new ApiError(400, 'bad_rules', 'body must be an array of rules')
    const err = validateRules(rules as never)
    if (err) throw new ApiError(400, 'bad_rules', err)
    await env.KV.put('mirror:rules', JSON.stringify(rules))
    return Response.json({ ok: true, count: rules.length })
  })

  .delete('/admin/mirror-rules', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    await env.KV.delete('mirror:rules')
    return Response.json({ ok: true, resetTo: DEFAULT_RULES.map((r) => r.host) })
  })

  .get('/admin/aliases', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    return Response.json(await listAliases(env))
  })

  .put('/admin/aliases/:name', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const name = c.params.name as string
    const body = (c.body ?? {}) as Partial<ModelAlias>
    if (typeof body.model !== 'string' || !body.model) throw new ApiError(400, 'bad_alias', "'model' is required")
    await putAlias(env, name, { model: body.model, channel: body.channel })
    return Response.json({ ok: true })
  })

  .get('/admin/aliases/:name', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    const alias = await getAlias(env, c.params.name as string)
    if (!alias) throw new ApiError(404, 'not_found', 'alias not found')
    return Response.json(alias)
  })

  .delete('/admin/aliases/:name', async (c) => {
    const env = getEnv(c.request)
    await requireAdmin(c.request, env)
    await removeAlias(env, c.params.name as string)
    return Response.json({ ok: true })
  })
