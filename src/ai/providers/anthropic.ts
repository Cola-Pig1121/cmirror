import type { Channel, OpenAIChatRequest, ProviderAdapter, Usage } from '../types'
import { sseThrough, type SSEEvent } from '../../lib/stream'
import { deferred } from '../../lib/deferred'
import { sseLine, SSE_DONE } from '../../lib/stream'
import { openaiUrl } from './openai'

const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicBlock {
  type: string
  [k: string]: unknown
}
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

const FINISH_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
}

export function toAnthropicRequest(req: OpenAIChatRequest, model: string): Record<string, unknown> {
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []
  let lastUserToolResult: AnthropicMessage | null = null

  const push = (m: AnthropicMessage) => {
    lastUserToolResult = null
    messages.push(m)
  }

  for (const raw of req.messages) {
    const m = raw as {
      role: string
      content?: unknown
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      tool_call_id?: string
    }
    const content = m.content
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof content === 'string') systemParts.push(content)
      else if (Array.isArray(content)) for (const p of content as { type?: string; text?: string }[]) if (p.type === 'text') systemParts.push(p.text ?? '')
      continue
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (typeof content === 'string') {
        if (content) blocks.push({ type: 'text', text: content })
      } else if (Array.isArray(content)) {
        for (const p of content as { type?: string; text?: string }[]) if (p.type === 'text') blocks.push({ type: 'text', text: p.text ?? '' })
      }
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          /* 参数非法按空对象处理 */
        }
        blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.function?.name ?? '', input })
      }
      push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      }
      if (lastUserToolResult && lastUserToolResult.content[0]?.type === 'tool_result') {
        lastUserToolResult.content.push(block)
      } else {
        lastUserToolResult = { role: 'user', content: [block] }
        messages.push(lastUserToolResult)
      }
      continue
    }
    const blocks: AnthropicBlock[] = []
    if (typeof content === 'string') {
      if (content) blocks.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const p of content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text ?? '' })
        else if (p.type === 'image_url') {
          const u = p.image_url?.url ?? ''
          const dm = /^data:([^;]+);base64,(.*)$/s.exec(u)
          blocks.push(
            dm
              ? { type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } }
              : { type: 'image', source: { type: 'url', url: u } },
          )
        }
      }
    }
    if (blocks.length) push({ role: 'user', content: blocks })
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? 4096,
  }
  if (systemParts.length) body.system = systemParts.join('\n\n')
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (typeof req.top_p === 'number') body.top_p = req.top_p
  if (req.stream) body.stream = true
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  if (req.tools?.length) {
    const tools = req.tools
      .filter((t) => t.function?.name)
      .map((t) => ({
        name: t.function!.name,
        ...(t.function!.description ? { description: t.function!.description } : {}),
        input_schema: { type: 'object', ...(t.function!.parameters ?? {}) },
      }))
    if (tools.length) body.tools = tools
  }
  const mapped = mapToolChoice(req.tool_choice)
  if (mapped) body.tool_choice = mapped
  return body
}

function mapToolChoice(tc: unknown): Record<string, unknown> | undefined {
  if (!tc || tc === 'auto') return tc ? { type: 'auto' } : undefined
  if (tc === 'required') return { type: 'any' }
  if (tc === 'none') return undefined
  const named = tc as { function?: { name?: string } }
  if (named?.function?.name) return { type: 'tool', name: named.function.name }
  return { type: 'auto' }
}

export interface AnthropicResponse {
  id?: string
  model?: string
  stop_reason?: string
  content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

export function fromAnthropicResponse(json: AnthropicResponse, model: string): Record<string, unknown> {
  const content = json.content ?? []
  const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  const toolCalls = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } }))
  const input = (json.usage?.input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0)
  const output = json.usage?.output_tokens ?? 0
  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: json.id ?? 'cmirror',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model ?? model,
    choices: [{ index: 0, message, finish_reason: FINISH_MAP[json.stop_reason ?? ''] ?? 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  }
}

export interface AnthropicStreamState {
  id: string
  created: number
  model: string
  blockTypeByIndex: Map<number, string>
  toolIndex: number
  input: number
  output: number
  stopReason?: string
  started: boolean
  settled: boolean
  settle?: (u: Usage) => void
}

export function createAnthropicStreamState(model: string): AnthropicStreamState {
  return {
    id: 'cmirror',
    created: Math.floor(Date.now() / 1000),
    model,
    blockTypeByIndex: new Map(),
    toolIndex: 0,
    input: 0,
    output: 0,
    started: false,
    settled: false,
  }
}

/** Anthropic SSE 事件 → OpenAI chunk(s);返回 null 表示不输出 */
export function anthropicEventToOpenAI(st: AnthropicStreamState, ev: SSEEvent): string | null {
  if (ev.event === 'ping' || !ev.data) return null
  let j: {
    type?: string
    message?: { id?: string; model?: string; usage?: { input_tokens?: number } }
    index?: number
    content_block?: { type?: string; id?: string; name?: string }
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
    usage?: { output_tokens?: number }
    stop_reason?: string
    error?: { message?: string; type?: string }
  }
  try {
    j = JSON.parse(ev.data)
  } catch {
    return null
  }
  const base = () => ({ id: st.id, object: 'chat.completion.chunk', created: st.created, model: st.model })

  switch (j.type) {
    case 'message_start': {
      if (j.message) {
        st.id = j.message.id ?? st.id
        st.model = j.message.model ?? st.model
        st.input = j.message.usage?.input_tokens ?? st.input
      }
      st.started = true
      return sseLine({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    }
    case 'content_block_start': {
      const t = j.content_block?.type ?? 'text'
      st.blockTypeByIndex.set(j.index ?? 0, t)
      if (t === 'tool_use') {
        const toolIndex = st.toolIndex
        return sseLine({
          ...base(),
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: toolIndex, id: j.content_block?.id ?? `call_${toolIndex}`, type: 'function', function: { name: j.content_block?.name ?? '', arguments: '' } }] },
              finish_reason: null,
            },
          ],
        })
      }
      return null
    }
    case 'content_block_delta': {
      const d = j.delta
      if (d?.type === 'text_delta' && d.text != null) {
        return sseLine({ ...base(), choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] })
      }
      if (d?.type === 'input_json_delta' && d.partial_json) {
        return sseLine({
          ...base(),
          choices: [{ index: 0, delta: { tool_calls: [{ index: st.toolIndex, function: { arguments: d.partial_json } }] }, finish_reason: null }],
        })
      }
      return null // thinking_delta 等暂不透出
    }
    case 'content_block_stop': {
      if (st.blockTypeByIndex.get(j.index ?? 0) === 'tool_use') st.toolIndex++
      return null
    }
    case 'message_delta': {
      if (j.delta?.stop_reason) st.stopReason = j.delta.stop_reason
      if (j.usage?.output_tokens != null) st.output = j.usage.output_tokens
      return null
    }
    case 'message_stop': {
      const usage = { prompt_tokens: st.input, completion_tokens: st.output, total_tokens: st.input + st.output }
      if (st.settle && !st.settled) {
        st.settled = true
        st.settle({ input: st.input, output: st.output })
      }
      return (
        sseLine({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: FINISH_MAP[st.stopReason ?? ''] ?? 'stop' }], usage }) + SSE_DONE
      )
    }
    case 'error': {
      if (st.settle && !st.settled) {
        st.settled = true
        st.settle({ input: st.input, output: st.output })
      }
      return sseLine({ ...base(), choices: [], error: { message: j.error?.message ?? 'upstream stream error', type: j.error?.type ?? 'server_error' } }) + SSE_DONE
    }
    default:
      return null
  }
}

export const anthropicAdapter: ProviderAdapter = {
  format: 'anthropic',

  buildChatRequest(ch: Channel, key: string, req: OpenAIChatRequest, model: string) {
    return {
      url: openaiUrl(ch.baseUrl, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(toAnthropicRequest(req, model)),
    }
  },

  async nonStreamChatResponse(res: Response, model: string) {
    const json = (await res.json().catch(() => ({}))) as AnthropicResponse
    const converted = fromAnthropicResponse(json, model)
    return {
      response: new Response(JSON.stringify(converted), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
      usage: {
        input: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0),
        output: json.usage?.output_tokens ?? 0,
      },
    }
  },

  streamChatResponse(res: Response, _req: OpenAIChatRequest, model: string) {
    const st = createAnthropicStreamState(model)
    const { promise: usage, resolve } = deferred<Usage>()
    st.settle = resolve
    const body = sseThrough(
      res.body as ReadableStream<Uint8Array>,
      (ev) => anthropicEventToOpenAI(st, ev),
      () => {
        if (!st.settled) {
          st.settled = true
          resolve({ input: st.input, output: st.output })
        }
        return null
      },
    )
    return {
      response: new Response(body, {
        status: res.ok ? 200 : res.status,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      }),
      usage,
    }
  },
}
