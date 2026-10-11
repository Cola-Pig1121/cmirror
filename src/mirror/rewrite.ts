const SKIP_URL_PREFIX = /^(javascript|data|blob|mailto|tel|about|chrome|chrome-extension|file):/i

/**
 * 把页面里的相对/绝对 URL 解析为真实地址并包成 /m/<绝对地址>;
 * 锚点、特殊协议、已经是镜像路径的原样返回 null(不改写)。
 */
export function wrapMirrorUrl(value: string | null | undefined, pageUrl: URL, mirrorBase: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (!v || v.startsWith('#') || SKIP_URL_PREFIX.test(v)) return null
  if (v.startsWith(mirrorBase)) return null
  let abs: URL
  try {
    abs = new URL(v, pageUrl.href)
  } catch {
    return null
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
  const s = abs.href
  if (s.startsWith(mirrorBase)) return null
  return mirrorBase + s
}

/** srcset:逗号分隔,每段 "<url> [descriptor]" */
export function wrapSrcset(srcset: string, pageUrl: URL, mirrorBase: string): string {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return part
      const space = trimmed.search(/\s/)
      const url = space === -1 ? trimmed : trimmed.slice(0, space)
      const desc = space === -1 ? '' : trimmed.slice(space)
      const w = wrapMirrorUrl(url, pageUrl, mirrorBase)
      return w ? w + desc : part
    })
    .join(', ')
}

export function rewriteMetaRefresh(content: string, pageUrl: URL, mirrorBase: string): string | null {
  const m = content.match(/^(\d+)\s*;\s*url\s*=\s*['"]?(.+?)['"]?\s*$/i)
  if (!m) return null
  const w = wrapMirrorUrl(m[2]!, pageUrl, mirrorBase)
  return w ? `${m[1]}; url=${w}` : null
}

/** CSS 的 url() 改写(读文本替换;CSS 一般很小,CPU 安全) */
export function rewriteCSSText(css: string, cssUrl: URL, mirrorBase: string): string {
  return css.replace(/url\(\s*([^)]*?)\s*\)/gi, (whole, inner: string) => {
    const u = inner.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (SKIP_URL_PREFIX.test(u)) return whole
    const w = wrapMirrorUrl(u, cssUrl, mirrorBase)
    return w ? `url("${w}")` : whole
  })
}

/**
 * 注入的运行时 hook:把页面 JS 发起的 fetch/XHR 相对或跨源请求改写进 /m/。
 * 只覆盖最常见路径,复杂 SPA 尽力而为(docs/plan.md §7)。location 跳转无法 hook。
 */
export const INJECT_SCRIPT =
  '<script>(()=>{try{const mm=location.pathname.match(/^\\/m\\/(stream|rewrite)\\//);const M=location.origin+"/m/"+(mm?mm[1]+"/":"");const w=(u)=>{try{const x=new URL(String(u),location.href);' +
  'if(/^(javascript|data|blob|mailto|tel|about):/.test(x.protocol)||x.origin===location.origin)return u;return M+x.href}' +
  'catch{return u}};const f=window.fetch;window.fetch=(i,o)=>f((typeof i==="string"||i instanceof URL)?w(i):i,o);' +
  'const X=XMLHttpRequest.prototype,open=X.open;X.open=function(m,u,...a){return open.apply(this,[m,w(u)].concat(a))}' +
  '}catch{}})()</script>'

/** 改写这些属性:值为 http/https 时包进 /m/,并去掉 SRI/CORS 校验属性(改写后必然失配) */
const REWRITE_ATTRS: Record<string, string[]> = {
  a: ['href'],
  link: ['href'],
  script: ['src'],
  form: ['action'],
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  iframe: ['src'],
  base: ['href'],
}

/**
 * HTMLRewriter 改写:属性 URL 包装 + srcset + meta refresh + 注入脚本。
 * 只在运行时(workerd)可用;纯逻辑在上面的函数里,单测直接测函数。
 */
export function rewriteHTMLResponse(res: Response, pageUrl: URL, mirrorBase: string): Response {
  const rewriter = new HTMLRewriter()

  for (const [tag, attrs] of Object.entries(REWRITE_ATTRS)) {
    rewriter.on(`${tag}[${attrs[0]!}]`, {
      element(el: Element) {
        const wrapped = wrapMirrorUrl(el.getAttribute(attrs[0]!), pageUrl, mirrorBase)
        if (wrapped) {
          el.setAttribute(attrs[0]!, wrapped)
          el.removeAttribute('integrity')
          el.removeAttribute('crossorigin')
        }
      },
    })
  }

  rewriter.on('img[srcset], source[srcset]', {
    element(el: Element) {
      const v = el.getAttribute('srcset')
      if (v) el.setAttribute('srcset', wrapSrcset(v, pageUrl, mirrorBase))
    },
  })

  rewriter.on('meta[http-equiv]', {
    element(el: Element) {
      if (!/^refresh$/i.test(el.getAttribute('http-equiv') ?? '')) return
      const content = el.getAttribute('content')
      if (!content) return
      const rewritten = rewriteMetaRefresh(content, pageUrl, mirrorBase)
      if (rewritten) el.setAttribute('content', rewritten)
    },
  })

  rewriter.on('script[integrity]', {
    element(el: Element) {
      el.removeAttribute('integrity')
      el.removeAttribute('crossorigin')
    },
  })

  rewriter.on('head', {
    element(el: Element) {
      el.append(INJECT_SCRIPT, { html: true })
    },
  })

  return rewriter.transform(res)
}
