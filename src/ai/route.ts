import { Elysia } from 'elysia'
import { getEnv, getCtx } from '../runtime'
import { requireScope } from '../middleware/auth'
import { enforceRateLimit } from '../middleware/ratelimit'
import { noteMetric } from '../middleware/logger'
import { ApiError, OpenAIError } from '../lib/errors'
import { getAlias, listAliases, loadChannels } from './channels'
import { checkModelAllowed, executeChat, executeEmbeddings } from './router'
import { trackAIUsage } from './usage'
import { passthroughUpstream } from './passthrough'
import type { OpenAIChatRequest } from './types'

// 注意:错误格式由 root index.ts 的 onError 统一分流(OpenAIError → OpenAI 格式)
export const aiModule = new Elysia({ name: 'ai' })
  .all('/ai/:provider/*', async (c) => {
    const env = getEnv(c.request)
    const ctx = getCtx(c.request)
    const token = await requireScope(c.request, env, 'ai')
    noteMetric(c.request, { tokenId: token.id, scope: 'ai' })
    await enforceRateLimit(env, ctx, c.request, token.id, { perToken: token.rpm })
    const provider = c.params.provider as string
    const result = await passthroughUpstream(c.request, provider, c.body)
    return result
  })

  .get('/v1/models', async (c) => {
    const env = getEnv(c.request)
    const ctx = getCtx(c.request)
    const token = await requireScope(c.request, env, 'ai')
    await enforceRateLimit(env, ctx, c.request, token.id, { perToken: token.rpm })
    const models = new Map<string, string>()
    for (const ch of await loadChannels(env)) {
      if (!ch.enabled || !ch.keys.length) continue
      if (ch.models.includes('*')) continue
      for (const m of ch.models) models.set(m, ch.provider)
    }
    for (const { name } of await listAliases(env)) models.set(name, 'alias')
    return Response.json({
      object: 'list',
      data: [...models.entries()].map(([id, owned_by]) => ({ id, object: 'model', created: 0, owned_by })),
    })
  })

  .post('/v1/chat/completions', async (c) => {
    const env = getEnv(c.request)
    const ctx = getCtx(c.request)
    const token = await requireScope(c.request, env, 'ai')
    noteMetric(c.request, { tokenId: token.id, scope: 'ai' })
    await enforceRateLimit(env, ctx, c.request, token.id, { perToken: token.rpm })

    const body = c.body as OpenAIChatRequest
    if (!body || typeof body.model !== 'string' || !body.model) {
      throw new OpenAIError(400, 'invalid_request_error', 'bad_request', "'model' is required")
    }
    if (!Array.isArray(body.messages)) {
      throw new OpenAIError(400, 'invalid_request_error', 'bad_request', "'messages' must be an array")
    }
    checkModelAllowed(token, body.model)
    const alias = await getAlias(env, body.model)
    if (alias) checkModelAllowed(token, alias.model)

    const result = await executeChat(env, body, body.model)
    trackAIUsage(env, ctx, c.request, token, result.channel, result.model, result.usage)
    return result.response
  })

  .post('/v1/embeddings', async (c) => {
    const env = getEnv(c.request)
    const ctx = getCtx(c.request)
    const token = await requireScope(c.request, env, 'ai')
    noteMetric(c.request, { tokenId: token.id, scope: 'ai' })
    await enforceRateLimit(env, ctx, c.request, token.id, { perToken: token.rpm })
    const body = c.body as Record<string, unknown>
    if (!body || typeof body.model !== 'string') throw new OpenAIError(400, 'invalid_request_error', 'bad_request', "'model' is required")
    checkModelAllowed(token, body.model)
    const result = await executeEmbeddings(env, body)
    return Response.json(result.openaiBody)
  })
