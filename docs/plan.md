# 聚合搜索 + 万用镜像 + AI 网关 工程规划

基于 Cloudflare Workers + Elysia 的自部署一体站点

## 1. 目标与范围

一个站点，三个模块，共用鉴权、限流、配置和日志：

- **万用镜像**：`/m/https://目标地址`，输入链接即可经 Worker 访问（如 GitHub 仓库）。
- **聚合搜索**：并行调用多个搜索源，合并去重后统一展示。
- **AI 网关**：模式 A 透明代理（只换域名）+ 模式 B 统一 OpenAI 兼容接口。

**明确不做**：不代理 Google（出口 IP 为 Cloudflare，必被风控）；不支持任何账号登录类站点的代理；不做开放代理（所有入口必须鉴权）。

## 2. 技术选型

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Cloudflare Workers | 免费版每日 10 万请求，CPU 10ms/次 |
| 框架 | Elysia + CloudflareAdapter | 需关闭 AOT，以官方文档为准 |
| 开发工具 | Bun + Wrangler | 本地 `wrangler dev`，部署 `wrangler deploy` |
| 前端 | Workers Static Assets + Vite | 一体部署，不单独拆 Pages |
| 配置/令牌 | KV | 渠道、白名单、令牌 |
| 结构化数据 | D1 | 用量、令牌额度（可后置） |
| 统计 | Analytics Engine | 请求量、耗时、状态码 |
| 缓存 | Cache API | 搜索结果、静态资源 |
| 测试 | Vitest + miniflare | 单测转换层和改写层 |

Elysia 入口最小示例：

```ts
import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'

export default new Elysia({ adapter: CloudflareAdapter })
  .get('/health', () => 'ok')
  .compile()
```

## 3. 总体架构

```text
浏览器 / SDK / 客户端
        │
  Cloudflare Worker (Elysia)
   ├─ 中间件：鉴权 → 限流 → 日志
   ├─ /m/*        万用镜像 → 目标站点
   ├─ /api/search 聚合搜索 → Brave / DDG / Bing / SearXNG
   ├─ /v1/*       AI 网关 模式 B → 各供应商
   ├─ /ai/*       AI 网关 模式 A → 各供应商（透传）
   └─ /*          静态前端 (Static Assets)
        │
   KV / D1 / Analytics Engine
```

## 4. 目录结构

```text
.
├─ wrangler.toml
├─ package.json
├─ src/
│  ├─ index.ts              # Elysia 入口，挂载各模块
│  ├─ env.ts                # Env 类型（KV、D1、Secrets）
│  ├─ middleware/
│  │  ├─ auth.ts            # 令牌校验与权限范围
│  │  ├─ ratelimit.ts       # 按令牌/IP 限流
│  │  └─ logger.ts          # 请求日志、统计
│  ├─ lib/
│  │  ├─ ssrf.ts            # 目标地址安全检查
│  │  ├─ errors.ts          # 统一错误格式
│  │  └─ stream.ts          # 流式透传工具
│  ├─ mirror/
│  │  ├─ route.ts           # /m/*
│  │  ├─ rules.ts           # 站点规则与白名单
│  │  ├─ headers.ts         # 请求/响应头清洗
│  │  ├─ rewrite.ts         # HTMLRewriter 改写
│  │  └─ github.ts          # GitHub 专项
│  ├─ search/
│  │  ├─ route.ts           # /api/search
│  │  ├─ aggregate.ts       # 并行、超时、去重、排序
│  │  └─ types.ts           # 统一结果结构
│  │  └─ providers/         # brave.ts ddg.ts bing.ts searxng.ts
│  └─ ai/
│     ├─ route.ts           # /v1/* 与 /ai/*
│     ├─ passthrough.ts     # 模式 A
│     ├─ router.ts          # 模型 → 渠道、负载均衡、降级
│     ├─ keys.ts            # Key 池
│     ├─ usage.ts           # 用量记录
│     └─ providers/         # openai.ts anthropic.ts gemini.ts ...
├─ web/                     # 前端源码（Vite），构建到 public/
├─ public/
└─ test/
```

## 5. 路由总表

- `GET /health`：健康检查，无需鉴权
- `ALL /m/<https://目标>`：万用镜像
- `GET /api/search?q=&engines=&page=`：聚合搜索
- `GET /api/engines`：可用搜索源列表
- `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/embeddings`：AI 网关模式 B
- `ALL /ai/<provider>/*`：AI 网关模式 A（如 `/ai/openai/v1/chat/completions`）
- `/admin/*`：渠道、令牌、白名单管理（仅管理员令牌）
- `/*`：静态前端

## 6. 公共层

**鉴权**：令牌放 `Authorization: Bearer` 或 `X-Token`；浏览器端镜像访问可用 Cookie 保存令牌。令牌带权限范围（mirror / search / ai）、可用模型、额度、过期时间，存 KV。管理员令牌来自 Wrangler secret。

**限流**：按令牌和 IP 双维度；免费版优先用 Cloudflare 自带的 Rate Limiting 绑定，或 KV 计数做粗粒度限制。

**错误格式**：统一 JSON `{ error: { code, message } }`；AI 网关的错误按 OpenAI 格式返回，保证客户端兼容。

**日志**：只记录元数据（路径、令牌 ID、状态码、耗时、token 数），不记录请求体和提示词内容。

## 7. 模块一：万用镜像

**请求流程**

1. 解析 `/m/` 后的目标 URL，校验协议只能是 http/https。
2. SSRF 检查：拒绝回环、内网、链路本地、云元数据地址，拒绝非常规端口（可配置）。
3. 白名单/规则匹配：v1 只放行规则表里的站点，v2 通过令牌开放通用模式。
4. 清洗请求头：去掉 `cf-*`、`x-forwarded-*`，改写 `Host`、`Origin`、`Referer`。
5. `fetch` 回源，`redirect: manual`，自己处理跳转。
6. 清洗响应头：改写 `Location` 与 `Set-Cookie` 的域，移除 CSP、`X-Frame-Options`。
7. 按 Content-Type 分流：HTML 走 HTMLRewriter，CSS 做 `url()` 改写，其余原样流式返回。

**HTML 改写要点**

- 改写 `a[href]`、`link[href]`、`script[src]`、`img[src|srcset]`、`form[action]`、`meta[http-equiv=refresh]`。
- 相对路径按页面真实 URL 解析后再包装为 `/m/<绝对地址>`。
- 注入一小段脚本 hook `fetch`、`XMLHttpRequest`、`location` 相关调用，处理 JS 动态请求（复杂 SPA 尽力而为）。
- 注入的脚本和改写逻辑要保持轻量，避免超 CPU 限制。

**GitHub 专项**

- 仓库页面、`raw.githubusercontent.com`、release 资产下载、`codeload.github.com` 归档下载。
- `git clone` 的 smart HTTP 路径：`/info/refs`、`/git-upload-pack` 透传，不做任何改写。
- 登录、OAuth、部分 API 不保证可用，规则里标注。

**规则表示例**

```ts
export const rules = [
  { host: 'github.com', mode: 'rewrite' },
  { host: 'raw.githubusercontent.com', mode: 'stream' },
  { host: 'registry.npmjs.org', mode: 'stream' },
  { host: 'pypi.org', mode: 'rewrite' },
]
```

## 8. 模块二：聚合搜索

**搜索源**

- Brave Search API（需 key，稳定，首选）
- DuckDuckGo HTML 版（免费，需解析，易变）
- Bing（API 或解析）
- SearXNG 公共或自建实例（JSON 输出，可间接聚合更多引擎）

**统一结果结构**

```ts
type SearchResult = {
  title: string
  url: string
  snippet: string
  engines: string[]   // 命中该条的来源
  score: number
}
```

**聚合策略**

1. 对选中的搜索源并行请求，每个源独立超时（建议 3 秒），失败不影响其他源。
2. URL 规范化后去重（去掉追踪参数、统一协议和尾斜杠），多个源命中的条目合并并提升分数。
3. 排序：各源名次倒数加权求和，可配置源权重。
4. 结果缓存：key 为 `q + engines + page`，Cache API 缓存数分钟。
5. 结果页每条提供“通过镜像打开”按钮，直接跳到 `/m/<url>`。

## 9. 模块三：AI 网关

### 模式 A：透明代理

- `/ai/<provider>/*` 映射到上游基础地址，如 `openai → api.openai.com`、`anthropic → api.anthropic.com`。
- 网关校验自有令牌后，换成上游真实 key，其余请求头和请求体原样转发。
- 响应体 `resp.body` 直接流式返回，不做解析，CPU 开销最小。
- 客户端使用官方 SDK，只改 `baseURL` 与 key。

### 模式 B：统一 OpenAI 兼容

- 对外只暴露 OpenAI 格式接口，`model` 字段决定渠道。
- 每个供应商一个适配器：请求转换（messages、tools、参数映射）、响应转换（含 SSE 逐块转换）、错误映射。
- 先支持：OpenAI 及兼容类（DeepSeek、OpenRouter、各类中转）直通，其次 Anthropic，再其次 Gemini。
- 工具调用、图片输入、`stream_options.include_usage` 等特性逐项验证后再开放。

### 渠道、Key 池与降级

- 渠道：`{ id, provider, baseUrl, keys[], models[], weight, enabled }`，存 KV。
- Key 池：同渠道多 key 加权轮询；某 key 连续失败则临时熔断。
- 降级：429 / 5xx / 超时时切换到同模型的备用渠道，或按配置回退到备用模型；流式请求一旦开始输出就不再切换。
- 模型别名：支持把自定义名称映射到真实模型名。

### 令牌与用量

- 令牌字段：ID、名称、权限范围、可用模型、额度（token 或次数）、过期时间。
- 用量：每次请求记录令牌 ID、模型、渠道、输入/输出 token、耗时、状态码，写入 Analytics Engine，额度扣减写 D1 或 KV。
- 提示词与回复内容默认不落盘。

### 地区与稳定性

部分供应商会拒绝来自不支持地区的出口，而 Worker 可能在这些地区的节点执行。开启 Smart Placement，或把这类渠道改走自己的中转服务，并在渠道上标注“需中转”。

## 10. 数据模型

**KV**

- `token:<hash>` → 令牌配置（范围、模型、额度、过期）
- `channel:<id>` → 渠道配置
- `alias:<name>` → 模型别名
- `mirror:rules` → 镜像规则与白名单
- `rl:<token|ip>:<window>` → 限流计数

**D1（可后置）**

- `usage(id, token_id, model, channel_id, input_tokens, output_tokens, status, latency_ms, ts)`
- `quota(token_id, used, limit, reset_at)`

## 11. 配置与部署

```toml
name = "omni-hub"
main = "src/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-id>"

[placement]
mode = "smart"
```

Secrets（用 `wrangler secret put`）：`ADMIN_TOKEN`、`BRAVE_API_KEY`，以及各供应商上游 key（若不放 KV）。

部署建议：绑定自己的域名（`workers.dev` 在部分网络环境下不稳定），CI 用 GitHub Actions 执行测试后 `wrangler deploy`。

## 12. 里程碑

**M0 骨架（0.5 天）** Elysia + Wrangler 跑通，`/health` 部署成功，Static Assets 出首页。 验收：线上可访问，本地热更新正常。

**M1 公共层（1 天）** 鉴权、令牌、限流、统一错误、日志，`/admin` 基础接口。 验收：无令牌请求被拒，限流生效。

**M2 镜像 v1（1–2 天）** SSRF 防护、白名单、请求/响应头清洗、重定向处理、流式透传。 验收：raw 文件、npm 包、release 下载可经镜像获取。

**M3 GitHub 专项（1 天）** 仓库页面改写、codeload、`git clone` smart HTTP。 验收：`git clone https://域名/m/https://github.com/用户/仓库` 成功。

**M4 AI 网关模式 A（0.5–1 天）** 供应商映射、令牌换 key、流式透传。 验收：官方 SDK 改 `baseURL` 后流式对话正常。

**M5 AI 网关模式 B（3–4 天）** OpenAI 兼容层、渠道管理、Anthropic 与 Gemini 适配器、SSE 转换、Key 池与降级。 验收：同一个 OpenAI 客户端可切换多个供应商的模型，含流式与工具调用。

**M6 聚合搜索（2 天）** Brave + DDG 起步，再加 Bing 与 SearXNG；并行、超时、去重、缓存。 验收：单源故障不影响整体，结果去重正确。

**M7 前端（2–3 天）** 统一入口（关键词 / URL 自动识别）、结果页、镜像按钮、AI 网关与令牌管理页。 验收：手机和桌面均可用，暗色模式正常。

**M8 镜像 v2 与加固（2 天）** 通用站点改写、注入脚本 hook、CSS 改写、用量统计与额度、安全回归。 验收：SSRF 测试集全部拦截，常见站点可正常浏览。

## 13. 测试策略

- **单元测试**：URL 规范化、SSRF 判定、HTML 改写、搜索去重排序、各供应商格式转换。
- **快照/录制测试**：用录制好的上游响应（含 SSE 流）回放，验证转换层。
- **集成测试**：miniflare 启动 Worker，端到端跑镜像、搜索、网关。
- **安全测试**：构造内网地址、DNS 重绑定、重定向到内网、超大响应、畸形 URL。

## 14. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 被当作开放代理滥用 | 全入口强制鉴权，白名单默认开启，SSRF 防护 |
| Cloudflare 服务条款对大流量代理敏感 | 限制大文件与视频，控制流量规模，自用为主 |
| 免费版 CPU 10ms 限制 | 流式透传为主，改写与转换保持轻量，必要时升级付费版 |
| 搜索页面解析源易失效 | 以官方 API 为主，解析源作为补充并隔离故障 |
| 上游 key 泄露 | 只存 secrets/KV，日志脱敏，令牌与上游 key 分离 |
| 供应商地区限制 | Smart Placement 或自建中转 |
| SPA 站点镜像不完整 | 明确“尽力而为”，在规则表标注兼容性 |

## 15. 后续扩展

- 镜像结果缓存与离线下载加速。
- 搜索结果摘要(调用自家 AI 网关生成)。
- 多管理员与使用统计面板。
- 渠道健康检查与自动下线。
- 自建 SearXNG 或中转 VPS 作为可选后端。

## 16. 修订记录(2026-10-11,实现期变更)

1. **聚合搜索 → 引擎直跳**:删除服务端聚合(§8 的 `/api/search`、多源去重),前端按所选引擎(Bing/Google/百度/DuckDuckGo/GitHub)拼搜索 URL 直接跳转;不再需要 BRAVE_API_KEY 与 search 令牌范围。
2. **镜像白名单 → 临时/自定义两级**:任意公网 URL 可直接 `/m/` 代理(临时);规则表(KV `mirror:rules`)只用于自定义(长期)配置——固定 rewrite/stream 模式、pathPrefixes、maxBytes、防盗链 `referer` 覆盖(如 `i.pximg.net` 必须带 `https://www.pixiv.net/`)。未登记站点按响应 Content-Type 自动选模式。SSRF 校验与"仅 http/https、拒绝回环/私有/保留地址"不变。
3. **UI 定稿(Listary 风)**:纯白背景、居中圆角长搜索框;输入 URL 回车即临时代理,普通词回车走所选引擎;输入 `/` 弹出命令补全列表(前缀匹配、↑↓/Tab/Enter):`/mirror <url>`、`/mirror-github <url>`、`/settings`、`/engine <id>`、`/help`;`/settings` 页管理令牌(localStorage+Cookie 自动携带)、默认引擎、自定义代理站点。
4. 令牌范围收敛为 mirror / ai(/admin 保留给管理员)。
