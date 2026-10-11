import { describe, expect, it } from 'vitest'
import { takeSSEEvents, sseThrough, SSE_DONE } from '../src/lib/stream'
import { toAnthropicRequest, fromAnthropicResponse, createAnthropicStreamState, anthropicEventToOpenAI, anthropicAdapter } from '../src/ai/providers/anthropic'
import { toGeminiRequest, fromGeminiResponse, geminiEventToOpenAI, createGeminiStreamState, geminiAdapter } from '../src/ai/providers/gemini'
import { toResponsesRequest, fromResponsesResponse, responsesAdapter } from '../src/ai/providers/responses'
import type { OpenAIChatRequest } from '../src/ai/types'
import { sseStream } from './helpers'

const CH = { id: 'c1', format: 'anthropic', baseUrl: 'https://api.anthropic.com', keys: ['k'], models: ['m'], weight: 1, enabled: true }

function req(messages: unknown[], extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return { model: 'claude-test', messages, ...extra }
}

describe('anthropic request transform', () => {
  it('maps system/user/assistant/tool with tools & tool_choice', () => {
    const body = toAnthropicRequest(
      req(
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'calling',
            tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
          },
          { role: 'tool', tool_call_id: 'tu_1', content: '{"temp": 20}' },
        ],
        {
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
          tool_choice: 'auto',
          temperature: 0.5,
          max_tokens: 123,
        },
      ),
      'claude-test',
    )
    expect(body.system).toBe('You are helpful.')
    expect(body.max_tokens).toBe(123)
    expect(body.temperature).toBe(0.5)
    const msgs = body.messages as { role: string; content: { type: string; text?: string; tool_use_id?: string; name?: string; input?: unknown }[] }[]
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1]!.content[1]!.type).toBe('tool_use')
    expect(msgs[1]!.content[1]!.input).toEqual({ city: 'SF' })
    expect(msgs[2]!.content[0]!.type).toBe('tool_result')
    expect(msgs[2]!.content[0]!.tool_use_id).toBe('tu_1')
    const tools = body.tools as { name: string; input_schema: Record<string, unknown> }[]
    expect(tools[0]!.input_schema.type).toBe('object')
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('developer role joins system; consecutive tool results merge', () => {
    const body = toAnthropicRequest(
      req([
        { role: 'developer', content: 'd1' },
        { role: 'system', content: 's1' },
        { role: 'tool', tool_call_id: 'a', content: 'x' },
        { role: 'tool', tool_call_id: 'b', content: 'y' },
      ]),
      'm',
    )
    expect(body.system).toBe('d1\n\ns1')
    const msgs = body.messages as { role: string; content: unknown[] }[]
    expect(msgs).toHaveLength(1)
    expect((msgs[0]!.content as unknown[]).length).toBe(2)
  })
})

describe('anthropic response transform', () => {
  it('text response', () => {
    const out = fromAnthropicResponse(
      { id: 'msg_1', model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 5, output_tokens: 7 } },
      'claude-x',
    ) as Record<string, unknown>
    const choice = (out.choices as unknown[])[0] as { message: Record<string, unknown>; finish_reason: string }
    expect(choice.message.content).toBe('Hello')
    expect(choice.finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })
  })
  it('tool_use response', () => {
    const out = fromAnthropicResponse(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'f', input: { a: 1 } }], usage: { input_tokens: 2, output_tokens: 3 } },
      'm',
    ) as Record<string, unknown>
    const msg = (out.choices as { message: Record<string, unknown> }[])[0]!.message
    expect(msg.content).toBeNull()
    const tc = (msg.tool_calls as { id: string; function: { name: string; arguments: string } }[])[0]!
    expect(tc.id).toBe('tu_9')
    expect(tc.function.name).toBe('f')
    expect(JSON.parse(tc.function.arguments)).toEqual({ a: 1 })
    expect((out.choices as { finish_reason: string }[])[0]!.finish_reason).toBe('tool_calls')
  })
})

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","model":"claude-x","usage":{"input_tokens":4}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: ping\ndata: {"type": "ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"f"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('')

describe('anthropic stream transform', () => {
  it('produces openai chunks with tool deltas and usage + [DONE]', async () => {
    const { response, usage } = anthropicAdapter.streamChatResponse(
      new Response(sseStream(ANTHROPIC_SSE), { headers: { 'content-type': 'text/event-stream' } }),
      { model: 'x', messages: [], stream: true },
      'claude-x',
    )
    const text = await response.text()
    const lines = text
      .split('\n\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(6))
    expect(lines[lines.length - 1]).toBe('[DONE]')
    const chunks = lines
      .slice(0, -1)
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l) as { id?: string; choices?: { delta: Record<string, unknown>; finish_reason?: string }[]; usage?: unknown })
    expect(chunks[0]!.choices![0]!.delta).toEqual({ role: 'assistant' })
    const content = chunks.map((c) => (c.choices![0]!.delta.content as string) ?? '').join('')
    expect(content).toBe('Hello')
    const toolChunks = chunks.filter((c) => c.choices![0]!.delta.tool_calls)
    expect((toolChunks[0]!.choices![0]!.delta.tool_calls as { index: number; id: string; function: { name: string } }[])[0]).toMatchObject({ index: 0, id: 'tu_1', function: { name: 'f' } })
    const args = toolChunks.slice(1).map((c) => (c.choices![0]!.delta.tool_calls as { function: { arguments?: string } }[])[0]!.function.arguments ?? '').join('')
    expect(JSON.parse(args)).toEqual({ a: 1 })
    const last = chunks[chunks.length - 1]!
    expect(last.choices![0]!.finish_reason).toBe('tool_calls')
    expect(last.usage).toEqual({ prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 })
    expect(await usage).toEqual({ input: 4, output: 9 })
  })

  it('resolves usage even when stream ends without message_stop', async () => {
    const partial = ANTHROPIC_SSE.slice(0, ANTHROPIC_SSE.indexOf('event: content_block_stop'))
    const { response, usage } = anthropicAdapter.streamChatResponse(
      new Response(sseStream(partial), { headers: { 'content-type': 'text/event-stream' } }),
      { model: 'x', messages: [], stream: true },
      'm',
    )
    await response.text()
    expect(await usage).toEqual({ input: 4, output: 0 })
  })
})

describe('anthropic url building', () => {
  it('normalizes baseUrl without duplicating /v1', () => {
    const call = anthropicAdapter.buildChatRequest(
      { ...CH, baseUrl: 'https://api.anthropic.com' },
      'sk-ant',
      req([{ role: 'user', content: 'hi' }]),
      'm',
    )
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.headers['x-api-key']).toBe('sk-ant')
    const call2 = anthropicAdapter.buildChatRequest({ ...CH, baseUrl: 'https://proxy.internal/v1/' }, 'k', req([{ role: 'user', content: 'hi' }]), 'm')
    expect(call2.url).toBe('https://proxy.internal/v1/messages')
  })
})

describe('gemini transforms', () => {
  it('request: system/roles/tools/config', () => {
    const body = toGeminiRequest(
      req(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'q' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'get_time', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '3:00' },
        ],
        {
          tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          temperature: 0.2,
          max_tokens: 64,
        },
      ),
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] })
    const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[]
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'q' }] })
    expect(contents[1]!.role).toBe('model')
    expect((contents[1]!.parts[0] as { functionCall: { name: string } }).functionCall.name).toBe('get_time')
    expect(contents[2]!.parts[0]).toHaveProperty('functionResponse')
    const resp = (contents[2]!.parts[0] as { functionResponse: { name: string; response: unknown } }).functionResponse
    expect(resp.name).toBe('get_time')
    expect(resp.response).toEqual({ result: '3:00' })
    const tools = body.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[]
    expect(tools[0]!.functionDeclarations[0]!.parameters).not.toHaveProperty('additionalProperties')
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 64 })
  })

  it('response mapping text + functionCall', () => {
    const out = fromGeminiResponse(
      {
        candidates: [{ content: { parts: [{ text: 'Hi' }, { functionCall: { name: 'f', args: { x: 1 } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
      },
      'gemini-2.0-flash',
    ) as Record<string, unknown>
    const msg = (out.choices as { message: Record<string, unknown> }[])[0]!.message
    expect(msg.content).toBe('Hi')
    expect((msg.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments).toBe('{"x":1}')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 })
  })

  it('stream conversion through adapter', async () => {
    const events = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"a":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":4}}\n\n',
    ].join('')
    const { response, usage } = geminiAdapter.streamChatResponse(
      new Response(sseStream(events), { headers: { 'content-type': 'text/event-stream' } }),
      { model: 'x', messages: [], stream: true },
      'gemini-x',
    )
    const text = await response.text()
    expect(text).toContain('data: [DONE]')
    const chunks = text
      .split('\n\n')
      .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)) as { choices?: { delta: Record<string, unknown>; finish_reason?: string }[]; usage?: unknown })
    const content = chunks.map((c) => ((c.choices?.[0]?.delta ?? {}) as Record<string, unknown>).content ?? '').join('')
    expect(content).toBe('Hello')
    const tool = chunks.find((c) => (c.choices?.[0]?.delta ?? {}).tool_calls)
    expect(tool).toBeTruthy()
    expect(await usage).toEqual({ input: 2, output: 4 })
  })

  it('url building', () => {
    const call = geminiAdapter.buildChatRequest(
      { id: 'g', format: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', keys: ['gk'], models: ['*'], weight: 1, enabled: true },
      'gk',
      req([{ role: 'user', content: 'hi' }], { stream: true }),
      'gemini-2.0-flash',
    )
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
    expect(call.headers['x-goog-api-key']).toBe('gk')
  })
})

describe('responses adapter', () => {
  it('chat request → responses input items', () => {
    const body = toResponsesRequest(
      req(
        [
          { role: 'system', content: 'instr' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
        { max_tokens: 64 },
      ),
      'gpt-5',
    )
    expect(body.instructions).toBe('instr')
    const input = body.input as Record<string, unknown>[]
    expect(input[0]).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' })
    expect(input[2]).toMatchObject({ type: 'function_call_output', call_id: 'c1', output: 'ok' })
    expect(body.max_output_tokens).toBe(64)
  })

  it('responses output → chat completion', () => {
    const out = fromResponsesResponse(
      {
        id: 'resp_1',
        model: 'gpt-5',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
          { type: 'function_call', call_id: 'c9', name: 'f', arguments: '{"x":2}' },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      },
      'gpt-5',
    ) as Record<string, unknown>
    const msg = (out.choices as { message: Record<string, unknown> }[])[0]!.message
    expect(msg.content).toBe('Hello')
    expect((msg.tool_calls as { id: string }[])[0]!.id).toBe('c9')
    expect((out.choices as { finish_reason: string }[])[0]!.finish_reason).toBe('tool_calls')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 })
  })

  it('stream SSE → openai chunks + [DONE]', async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","model":"gpt-5"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"tc1","name":"f"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","arguments":"{\\"a\\":1}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":4}}}\n\n',
    ].join('')
    const { response, usage } = responsesAdapter.streamChatResponse(
      new Response(sseStream(sse), { headers: { 'content-type': 'text/event-stream' } }),
      { model: 'x', messages: [], stream: true },
      'gpt-5',
    )
    const text = await response.text()
    expect(text).toContain('data: [DONE]')
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)) as { choices?: { delta: Record<string, unknown>; finish_reason?: string }[] })
    const content = chunks.map((c) => ((c.choices?.[0]?.delta ?? {}) as Record<string, unknown>).content ?? '').join('')
    expect(content).toBe('Hello')
    expect(chunks.some((c) => (c.choices?.[0]?.delta ?? {}).tool_calls)).toBe(true)
    expect(chunks[chunks.length - 1]!.choices?.[0]!.finish_reason).toBe('tool_calls')
    expect(await usage).toEqual({ input: 2, output: 4 })
  })

  it('url uses /v1/responses', () => {
    const call = responsesAdapter.buildChatRequest(
      { id: 'r', format: 'responses', baseUrl: 'https://api.openai.com', keys: ['k'], models: ['*'], weight: 1, enabled: true },
      'k',
      req([{ role: 'user', content: 'hi' }]),
      'gpt-5',
    )
    expect(call.url).toBe('https://api.openai.com/v1/responses')
    expect(call.headers.authorization).toBe('Bearer k')
  })
})

describe('sse utilities', () => {
  it('takeSSEEvents handles chunked lines', () => {
    const r = takeSSEEvents('data: a\n')
    expect(r.events).toHaveLength(0)
    expect(r.rest).toBe('data: a\n')
    const r2 = takeSSEEvents('data: a\n\ndata: b\n\n')
    expect(r2.events.map((e) => e.data)).toEqual(['a', 'b'])
    const r3 = takeSSEEvents('event: x\ndata: 1\ndata: 2\n\n', true)
    expect(r3.events[0]).toMatchObject({ event: 'x', data: '1\n2' })
  })
})
