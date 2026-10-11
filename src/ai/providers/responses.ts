import type { Channel, OpenAIChatRequest, ProviderAdapter, Usage } from '../types'
import { SSE_DONE, sseLine, sseThrough, type SSEEvent } from '../../lib/stream'
import { deferred } from '../../lib/deferred'
import { openaiUrl } from './openai'

/**
 * OpenAI Responses API(/v1/responses)适配器。
 * 模式 B 对外仍是 Chat Completions 格式,这里做 chat ↔ responses 双向转换(含 SSE)。
 */

interface ResponsesItem {
  type?: string
  role?: string
  content?: { type?: string; text?: string }[]
  call_id?: string
  name?: string
  arguments?: string
  output?: unknown
}

export function toResponsesRequest(req: OpenAIChatRequest, model: string): Record<string, unknown> {
  const input: ResponsesItem[] = []
  const instructions: string[] = []

  for (const raw of req.messages) {
    const m = raw as {
      role: string
      content?: unknown
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      tool_call_id?: string
    }
    const content = m.content
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof content === 'string') instructions.push(content)
      else if (Array.isArray(content)) for (const p of content as { type?: string; text?: string }[]) if (p.type === 'text') instructions.push(p.text ?? '')
      continue
    }
    if (m.role === 'assistant') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') : ''
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id ?? '', name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' })
      }
      continue
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: typeof content === 'string' ? content : JSON.stringify(content ?? '') })
      continue
    }
    const parts: { type: string; text: string }[] = []
    if (typeof content === 'string') parts.push({ type: 'input_text', text: content })
    else if (Array.isArray(content)) {
      for (const p of content as { type?: string; text?: string }[]) if (p.type === 'text') parts.push({ type: 'input_text', text: p.text ?? '' })
    }
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts })
  }

  const body: Record<string, unknown> = { model, input }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  if (req.stream) body.stream = true
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (typeof req.top_p === 'number') body.top_p = req.top_p
  const maxTok = req.max_completion_tokens ?? req.max_tokens
  if (typeof maxTok === 'number') body.max_output_tokens = maxTok
  if (req.stop) body.text = { stop: Array.isArray(req.stop) ? req.stop : [req.stop] }
  if (req.tools?.length) {
    const tools = req.tools
      .filter((t) => t.function?.name)
      .map((t) => ({ type: 'function', name: t.function!.name, description: t.function!.description, parameters: t.function!.parameters ?? { type: 'object' } }))
    if (tools.length) body.tools = tools
  }
  const tc = mapToolChoice(req.tool_choice)
  if (tc) body.tool_choice = tc
  return body
}

function mapToolChoice(tc: unknown): unknown {
  if (!tc || tc === 'auto') return tc === 'auto' ? 'auto' : undefined
  if (tc === 'none' || tc === 'required') return tc
  const named = tc as { function?: { name?: string } }
  if (named?.function?.name) return { type: 'function', name: named.function.name }
  return undefined
}

interface ResponsesResponse {
  id?: string
  model?: string
  status?: string
  incomplete_details?: { reason?: string }
  output?: { type?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string; call_id?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export function fromResponsesResponse(json: ResponsesResponse, model: string): Record<string, unknown> {
  const output = json.output ?? []
  const text = output
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('')
  const toolCalls = output
    .filter((o) => o.type === 'function_call')
    .map((o) => ({ id: o.call_id ?? '', type: 'function', function: { name: o.name ?? '', arguments: o.arguments ?? '{}' } }))
  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  let finish = 'stop'
  if (toolCalls.length) finish = 'tool_calls'
  else if (json.status === 'incomplete') finish = json.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop'
  return {
    id: json.id ?? 'cmirror',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model ?? model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: json.usage?.input_tokens ?? 0,
      completion_tokens: json.usage?.output_tokens ?? 0,
      total_tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
    },
  }
}

export interface ResponsesStreamState {
  id: string
  created: number
  model: string
  input: number
  output: number
  toolIndex: number
  started: boolean
  settled: boolean
  settle?: (u: Usage) => void
}

/** Responses SSE 事件 → OpenAI chunk;事件名在 ev.event,数据在 ev.data(JSON) */
export function responsesEventToOpenAI(st: ResponsesStreamState, ev: SSEEvent): string | null {
  let j: {
    type?: string
    response?: ResponsesResponse
    delta?: string
    item?: { type?: string; call_id?: string; name?: string; arguments?: string }
    item_id?: string
    output_index?: number
    arguments?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  try {
    j = JSON.parse(ev.data)
  } catch {
    return null
  }
  const name = (ev.event || j.type || '') as string
  const base = () => ({ id: st.id, object: 'chat.completion.chunk', created: st.created, model: st.model })

  switch (name) {
    case 'response.created':
    case 'response.in_progress': {
      if (j.response) {
        st.id = j.response.id ?? st.id
        st.model = j.response.model ?? st.model
      }
      if (!st.started) {
        st.started = true
        return sseLine({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      }
      return null
    }
    case 'response.output_item.added': {
      if (j.item?.type === 'function_call') {
        return sseLine({
          ...base(),
          choices: [{ index: 0, delta: { tool_calls: [{ index: st.toolIndex, id: j.item.call_id ?? `call_${st.toolIndex}`, type: 'function', function: { name: j.item.name ?? '', arguments: '' } }] }, finish_reason: null }],
        })
      }
      return null
    }
    case 'response.output_text.delta': {
      if (!j.delta) return null
      return sseLine({ ...base(), choices: [{ index: 0, delta: { content: j.delta }, finish_reason: null }] })
    }
    case 'response.function_call_arguments.delta': {
      if (!j.arguments) return null
      return sseLine({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index: st.toolIndex, function: { arguments: j.arguments } }] }, finish_reason: null }] })
    }
    case 'response.output_item.done': {
      if (j.item?.type === 'function_call') st.toolIndex++
      return null
    }
    case 'response.completed': {
      const r = j.response ?? {}
      st.input = r.usage?.input_tokens ?? st.input
      st.output = r.usage?.output_tokens ?? st.output
      const hasTool = (r.output ?? []).some((o) => o.type === 'function_call') || st.toolIndex > 0
      if (st.settle && !st.settled) {
        st.settled = true
        st.settle({ input: st.input, output: st.output })
      }
      return (
        sseLine({
          ...base(),
          choices: [{ index: 0, delta: {}, finish_reason: hasTool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: st.input, completion_tokens: st.output, total_tokens: st.input + st.output },
        }) + SSE_DONE
      )
    }
    case 'response.failed':
    case 'error': {
      if (st.settle && !st.settled) {
        st.settled = true
        st.settle({ input: st.input, output: st.output })
      }
      const msg = (j as { message?: string }).message ?? j.response?.error?.message ?? 'responses stream error'
      return sseLine({ ...base(), choices: [], error: { message: msg, type: 'server_error' } }) + SSE_DONE
    }
    default:
      return null
  }
}

export const responsesAdapter: ProviderAdapter = {
  format: 'responses',

  buildChatRequest(ch: Channel, key: string, req: OpenAIChatRequest, model: string) {
    return {
      url: openaiUrl(ch.baseUrl, '/v1/responses'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(toResponsesRequest(req, model)),
    }
  },

  async nonStreamChatResponse(res: Response, model: string) {
    const json = (await res.json().catch(() => ({}))) as ResponsesResponse
    const converted = fromResponsesResponse(json, model)
    return {
      response: new Response(JSON.stringify(converted), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
      usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
    }
  },

  streamChatResponse(res: Response, _req: OpenAIChatRequest, model: string) {
    const { promise: usage, resolve } = deferred<Usage>()
    const st: ResponsesStreamState = {
      id: 'cmirror',
      created: Math.floor(Date.now() / 1000),
      model,
      input: 0,
      output: 0,
      toolIndex: 0,
      started: false,
      settled: false,
      settle: resolve,
    }
    const body = sseThrough(
      res.body as ReadableStream<Uint8Array>,
      (ev) => responsesEventToOpenAI(st, ev),
      () => {
        if (!st.settled) {
          st.settled = true
          resolve({ input: st.input, output: st.output })
        }
        return null
      },
    )
    return {
      response: new Response(body, { status: res.ok ? 200 : res.status, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } }),
      usage,
    }
  },
}
