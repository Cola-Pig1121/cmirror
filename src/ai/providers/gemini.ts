import type { Channel, OpenAIChatRequest, ProviderAdapter, Usage } from '../types'
import { SSE_DONE, sseLine, sseThrough, type SSEEvent } from '../../lib/stream'
import { deferred } from '../../lib/deferred'

/** Gemini 不接受 OpenAI schema 里的这些字段 */
function cleanSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: 'object' }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$defs' || k === 'definitions' || k === 'definitions') continue
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = cleanSchema(pv as Record<string, unknown>)
      out[k] = props
    } else if (k === 'items') {
      out[k] = typeof v === 'object' && v !== null ? cleanSchema(v as Record<string, unknown>) : v
    } else {
      out[k] = v
    }
  }
  return out
}

const FINISH_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  BLOCKLIST: 'content_filter',
  SPII: 'content_filter',
  OTHER: 'stop',
}

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  inlineData?: { mimeType?: string; data?: string }
  functionResponse?: { name?: string; response?: unknown }
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export function toGeminiRequest(req: OpenAIChatRequest): Record<string, unknown> {
  const systemParts: string[] = []
  const contents: GeminiContent[] = []
  const callNames = new Map<string, string>()

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
      const parts: GeminiPart[] = []
      if (typeof content === 'string') {
        if (content) parts.push({ text: content })
      } else if (Array.isArray(content)) {
        for (const p of content as { type?: string; text?: string }[]) if (p.type === 'text') parts.push({ text: p.text ?? '' })
      }
      for (const tc of m.tool_calls ?? []) {
        if (tc.id) callNames.set(tc.id, tc.function?.name ?? '')
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          /* ignore */
        }
        parts.push({ functionCall: { name: tc.function?.name ?? '', args } })
      }
      contents.push({ role: 'model', parts })
      continue
    }
    if (m.role === 'tool') {
      const name = (m.tool_call_id && callNames.get(m.tool_call_id)) || ''
      let response: unknown = content
      if (typeof content === 'string') {
        try {
          response = JSON.parse(content)
        } catch {
          response = { result: content }
        }
      }
      const prev = contents[contents.length - 1]
      if (prev && prev.role === 'user' && prev.parts.every((p) => p.functionResponse)) {
        prev.parts.push({ functionResponse: { name, response } })
      } else {
        contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] })
      }
      continue
    }
    // user
    const parts: GeminiPart[] = []
    if (typeof content === 'string') {
      if (content) parts.push({ text: content })
    } else if (Array.isArray(content)) {
      for (const p of content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
        if (p.type === 'text') parts.push({ text: p.text ?? '' })
        else if (p.type === 'image_url') {
          const u = p.image_url?.url ?? ''
          const dm = /^data:([^;]+);base64,(.*)$/s.exec(u)
          if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2] } })
          // 远程图片 URL:Gemini generateContent 不直接支持,尽力而为跳过
        }
      }
    }
    if (parts.length) contents.push({ role: 'user', parts })
  }

  const body: Record<string, unknown> = { contents }
  if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }

  const gen: Record<string, unknown> = {}
  if (typeof req.temperature === 'number') gen.temperature = req.temperature
  if (typeof req.top_p === 'number') gen.topP = req.top_p
  const maxTok = req.max_completion_tokens ?? req.max_tokens
  if (typeof maxTok === 'number') gen.maxOutputTokens = maxTok
  if (req.stop) gen.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  if (Object.keys(gen).length) body.generationConfig = gen

  if (req.tools?.length) {
    const declarations = req.tools
      .filter((t) => t.function?.name)
      .map((t) => ({
        name: t.function!.name,
        ...(t.function!.description ? { description: t.function!.description } : {}),
        parameters: cleanSchema(t.function!.parameters),
      }))
    if (declarations.length) body.tools = [{ functionDeclarations: declarations }]
  }
  const fc = mapToolChoice(req.tool_choice)
  if (fc) body.toolConfig = { functionCallingConfig: fc }
  return body
}

function mapToolChoice(tc: unknown): Record<string, unknown> | undefined {
  if (!tc || tc === 'auto') return undefined
  if (tc === 'none') return { mode: 'NONE' }
  if (tc === 'required') return { mode: 'ANY' }
  const named = tc as { function?: { name?: string } }
  if (named?.function?.name) return { mode: 'ANY', allowedFunctionNames: [named.function.name] }
  return undefined
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] }
    finishReason?: string
    index?: number
  }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
}

export function fromGeminiResponse(json: GeminiResponse, model: string): Record<string, unknown> {
  const cand = json.candidates?.[0]
  const parts = cand?.content?.parts ?? []
  const text = parts.filter((p) => p.text).map((p) => p.text ?? '').join('')
  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
    }))
  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  const inputTok = json.usageMetadata?.promptTokenCount ?? 0
  const outputTok = json.usageMetadata?.candidatesTokenCount ?? 0
  return {
    id: 'cmirror',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: FINISH_MAP[cand?.finishReason ?? ''] ?? 'stop' }],
    usage: {
      prompt_tokens: inputTok,
      completion_tokens: outputTok,
      total_tokens: json.usageMetadata?.totalTokenCount ?? inputTok + outputTok,
    },
  }
}

export interface GeminiStreamState {
  created: number
  model: string
  toolIndex: number
  input: number
  output: number
  finishReason?: string
  settled: boolean
  settle?: (u: Usage) => void
}

export function createGeminiStreamState(model: string): GeminiStreamState {
  return { created: Math.floor(Date.now() / 1000), model, toolIndex: 0, input: 0, output: 0, settled: false }
}

/** Gemini SSE(alt=sse)→ OpenAI chunk */
export function geminiEventToOpenAI(st: GeminiStreamState, ev: SSEEvent): string | null {
  if (!ev.data) return null
  let j: GeminiResponse
  try {
    j = JSON.parse(ev.data) as GeminiResponse
  } catch {
    return null
  }
  const cand = j.candidates?.[0]
  const base = { id: 'cmirror', object: 'chat.completion.chunk', created: st.created, model: st.model }
  let out = ''

  if (j.usageMetadata) {
    st.input = j.usageMetadata.promptTokenCount ?? st.input
    st.output = j.usageMetadata.candidatesTokenCount ?? st.output
  }

  for (const p of cand?.content?.parts ?? []) {
    if (p.text) {
      out += sseLine({ ...base, choices: [{ index: 0, delta: { content: p.text }, finish_reason: null }] })
    } else if (p.functionCall?.name) {
      out += sseLine({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: st.toolIndex,
                  id: `call_${st.toolIndex}`,
                  type: 'function',
                  function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      st.toolIndex++
    }
  }

  if (cand?.finishReason) st.finishReason = cand.finishReason
  return out || null
}

export const geminiAdapter: ProviderAdapter = {
  format: 'gemini',

  buildChatRequest(ch: Channel, key: string, req: OpenAIChatRequest, model: string) {
    const verb = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    const base = ch.baseUrl.replace(/\/+$/, '').replace(/\/v1(beta)?$/i, '')
    return {
      url: `${base}/v1beta/models/${encodeURIComponent(model)}:${verb}`,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
        accept: 'application/json',
      },
      body: JSON.stringify(toGeminiRequest(req)),
    }
  },

  async nonStreamChatResponse(res: Response, model: string) {
    const json = (await res.json().catch(() => ({}))) as GeminiResponse
    const converted = fromGeminiResponse(json, model)
    return {
      response: new Response(JSON.stringify(converted), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
      usage: {
        input: json.usageMetadata?.promptTokenCount ?? 0,
        output: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    }
  },

  streamChatResponse(res: Response, _req: OpenAIChatRequest, model: string) {
    const st = createGeminiStreamState(model)
    const { promise: usage, resolve } = deferred<Usage>()
    st.settle = resolve
    const finishChunk = (): string => {
      if (!st.settled) {
        st.settled = true
        resolve({ input: st.input, output: st.output })
      }
      return (
        sseLine({
          id: 'cmirror',
          object: 'chat.completion.chunk',
          created: st.created,
          model: st.model,
          choices: [{ index: 0, delta: {}, finish_reason: FINISH_MAP[st.finishReason ?? ''] ?? 'stop' }],
          usage: { prompt_tokens: st.input, completion_tokens: st.output, total_tokens: st.input + st.output },
        }) + SSE_DONE
      )
    }
    const body = sseThrough(
      res.body as ReadableStream<Uint8Array>,
      (ev) => geminiEventToOpenAI(st, ev),
      () => finishChunk(),
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
