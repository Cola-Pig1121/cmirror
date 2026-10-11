import type { Env } from './env'

interface Bindings {
  env: Env
  ctx: ExecutionContext
}

// Elysia 的 web-standard/cloudflare 适配器 fetch 只接收 Request,会丢弃 Workers 的
// env / ctx;因此按 Request 对象引用用 WeakMap 注入绑定,handler 通过 getBindings(c.request)
// 取回。Request 对象每次调用唯一,WeakMap 随 GC 自动回收。
const bindings = new WeakMap<Request, Bindings>()

export function attachBindings(request: Request, env: Env, ctx: ExecutionContext) {
  bindings.set(request, { env, ctx })
}

export function getBindings(request: Request): Bindings {
  const b = bindings.get(request)
  if (!b) throw new Error('request bindings missing (did you call app.fetch directly?)')
  return b
}

export function getEnv(request: Request): Env {
  return getBindings(request).env
}

export function getCtx(request: Request): ExecutionContext {
  return getBindings(request).ctx
}

/** 测试/本地用:attach 后调用 app.fetch */
export function bindAndFetch<T extends { fetch: (req: Request) => Response | Promise<Response> }>(
  app: T,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  attachBindings(request, env, ctx)
  return app.fetch(request)
}
