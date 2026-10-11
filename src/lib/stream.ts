export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: string
}

/**
 * 从缓冲区取出完整的 SSE 事件(块以空行分隔;字段行 `name: value`)。
 * flush=true 时把残留内容也按事件处理。返回未形成完整块的剩余缓冲。
 */
export function takeSSEEvents(buf: string, flush = false): { events: SSEEvent[]; rest: string } {
  const normalized = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const events: SSEEvent[] = []
  let rest = normalized
  for (;;) {
    const sep = rest.indexOf('\n\n')
    if (sep === -1) break
    const block = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    const ev = parseSSEBlock(block)
    if (ev) events.push(ev)
  }
  if (flush && rest) {
    const ev = parseSSEBlock(rest)
    rest = ''
    if (ev) events.push(ev)
  }
  return { events, rest }
}

function parseSSEBlock(block: string): SSEEvent | null {
  if (!block) return null
  const ev: SSEEvent = { data: '' }
  const dataParts: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // 注释/心跳
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataParts.push(value)
    else if (field === 'event') ev.event = value
    else if (field === 'id') ev.id = value
    else if (field === 'retry') ev.retry = value
  }
  ev.data = dataParts.join('\n')
  if (!ev.data && !ev.event) return null
  return ev
}

/**
 * 把上游 SSE 流经 `map` 逐事件转换后重新输出(用于供应商 SSE → OpenAI SSE 的流式转换)。
 * map 返回 null/undefined 表示该事件不输出;返回的字符串原样写入(调用方负责含结尾换行)。
 * onDone 在输入流正常结束时调用一次,可追加尾块(如 [DONE]、usage)。
 * 注意:消费者断开时 flush 不执行,onDone 与 map 只在正常读完时运行。
 */
export function sseThrough(
  input: ReadableStream<Uint8Array>,
  map: (ev: SSEEvent) => string | null | undefined,
  onDone?: () => string | null | undefined,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  let doneFired = false
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true })
        const { events, rest } = takeSSEEvents(buf)
        buf = rest
        let out = ''
        for (const ev of events) {
          const s = map(ev)
          if (s != null) out += s
        }
        if (out) controller.enqueue(encoder.encode(out))
      },
      flush(controller) {
        buf += decoder.decode()
        const { events } = takeSSEEvents(buf, true)
        let out = ''
        for (const ev of events) {
          const s = map(ev)
          if (s != null) out += s
        }
        if (onDone && !doneFired) {
          doneFired = true
          const s = onDone()
          if (s != null) out += s
        }
        if (out) controller.enqueue(encoder.encode(out))
      },
    }),
  )
}

export function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export const SSE_DONE = 'data: [DONE]\n\n'

/**
 * 转发用的请求体:Elysia 动态 handler 会先按 content-type 消费 request.body
 * (json 解析 / octet-stream 读 arrayBuffer),透传时基于已解析的 context.body 重新构造,
 * 避免对已锁定的流二次读取。GET/HEAD 无请求体。
 */
export function outboundBody(request: Request, parsed: unknown): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  if (parsed === undefined || parsed === null) return request.body ?? undefined
  if (typeof parsed === 'string') return parsed
  if (parsed instanceof ArrayBuffer) return parsed
  if (ArrayBuffer.isView(parsed)) return parsed
  if (typeof FormData !== 'undefined' && parsed instanceof FormData) return parsed
  try {
    return JSON.stringify(parsed)
  } catch {
    return undefined
  }
}
