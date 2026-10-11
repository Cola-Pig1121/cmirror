export interface Env {
  KV: KVNamespace
  ASSETS?: Fetcher
  ANALYTICS?: AnalyticsEngineDataset
  ADMIN_TOKEN: string
  BRAVE_API_KEY?: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GEMINI_API_KEY?: string
  /** SearXNG 实例地址,JSON 输出;不配则该源不可用 */
  SEARXNG_URL?: string
}

export type Scope = 'mirror' | 'ai' | 'admin'

export interface TokenRecord {
  id: string
  name: string
  scopes: Scope[]
  /** ai 范围可用模型;空/缺省 = 不限 */
  models?: string[]
  /** 每分钟请求上限;缺省用全局默认 */
  rpm?: number
  /** 累计可用请求次数;0/缺省 = 不限 */
  maxRequests?: number
  /** 累计可用 token 额度;0/缺省 = 不限 */
  maxTokens?: number
  usedRequests?: number
  usedTokens?: number
  /** Unix 毫秒过期时间;缺省 = 不过期 */
  expiresAt?: number
  createdAt: number
  /** 仅运行期内存携带(KV 不存明文令牌与 hash key) */
  raw?: string
  hashKey?: string
}
