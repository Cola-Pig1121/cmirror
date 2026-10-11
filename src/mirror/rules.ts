import type { Env } from '../env'
import { validateTargetUrl } from '../lib/ssrf'

/**
 * 自定义(长期)代理配置(docs/plan.md 修订 2026-10-11):
 * 镜像已开放临时代理 —— 任意公网 URL 均可直接 /m/ 代理,无需登记。
 * 规则表只承担两件事:
 *   1) 为站点固定传输模式(rewrite/stream),避免按 content-type 猜错;
 *   2) 修正防盗链 referer(如 pixiv 图片域)。
 * 命中规则时 pathPrefixes/maxBytes 仍生效(可收窄站点)。
 */
export interface MirrorRule {
  host: string
  /** rewrite:HTML/CSS 改写;stream:原样流式透传 */
  mode: 'rewrite' | 'stream'
  /** 仅放行这些路径前缀(缺省放行整个站点) */
  pathPrefixes?: string[]
  /** 流式透传时按 content-length 拒绝超大响应(字节) */
  maxBytes?: number
  /** 覆盖回源 Referer(防盗链站点必填,如 i.pximg.net) */
  referer?: string
  note?: string
}

/**
 * 默认自定义配置(公开浏览/下载场景;登录与 OAuth 不保证可用)。
 * release 资产下载会 302 到 objects.githubusercontent.com,需要一并登记。
 */
export const DEFAULT_RULES: MirrorRule[] = [
  { host: 'github.com', mode: 'rewrite', note: '仓库浏览;git clone smart HTTP 原样透传' },
  { host: 'gist.github.com', mode: 'rewrite' },
  { host: 'github.githubassets.com', mode: 'stream', note: 'GitHub 页面静态资源' },
  { host: 'raw.githubusercontent.com', mode: 'stream' },
  { host: 'gist.githubusercontent.com', mode: 'stream' },
  { host: 'api.github.com', mode: 'stream', note: 'API JSON,不改写' },
  { host: 'codeload.github.com', mode: 'stream', note: '归档下载' },
  { host: 'objects.githubusercontent.com', mode: 'stream', note: 'release 资产' },
  { host: 'registry.npmjs.org', mode: 'stream' },
  { host: 'registry.npmjs.com', mode: 'stream' },
  { host: 'pypi.org', mode: 'rewrite' },
  { host: 'files.pythonhosted.org', mode: 'stream' },
]

export async function loadRules(env: Env): Promise<MirrorRule[]> {
  const custom = await env.KV.get<MirrorRule[]>('mirror:rules', 'json')
  if (custom && Array.isArray(custom) && custom.length) return custom
  return DEFAULT_RULES
}

export function matchRule(rules: MirrorRule[], host: string): MirrorRule | undefined {
  const h = host.toLowerCase()
  return rules.find((r) => r.host === h)
}

export function ruleAllowsPath(rule: MirrorRule, pathname: string): boolean {
  if (!rule.pathPrefixes || !rule.pathPrefixes.length) return true
  return rule.pathPrefixes.some((p) => pathname.startsWith(p))
}

/** 无自定义规则时按响应类型自动选模式 */
export function autoModeFor(contentType: string): 'rewrite' | 'stream' {
  const ct = contentType.toLowerCase()
  return ct.includes('text/html') || ct.includes('text/css') ? 'rewrite' : 'stream'
}

/** 规则表写入前的安全检查:每个 host 必须是可公开解析的域名(IP 字面量、内网名等会被 SSRF 校验拒绝) */
export function validateRules(rules: MirrorRule[]): string | null {
  for (const r of rules) {
    if (!r.host || !r.mode || (r.mode !== 'rewrite' && r.mode !== 'stream')) return `invalid rule: ${JSON.stringify(r)}`
    const check = validateTargetUrl('https://' + r.host)
    if (!check.ok) return `host "${r.host}" rejected: ${check.reason}`
    if (r.referer) {
      const rc = validateTargetUrl(r.referer)
      if (!rc.ok) return `referer "${r.referer}" rejected: ${rc.reason}`
    }
  }
  return null
}
