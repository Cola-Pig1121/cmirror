# cmirror — 工程说明(给 ZCode Agent)

## 项目目标

**cmirror** = 万用镜像 + AI 网关 + 引擎直跳搜索,基于 Cloudflare Workers + Elysia 的自部署一体站点(Listary 风单框 UI)。

- **万用镜像**:`/m/https://目标地址`,任意公网 URL 可**临时代理**;规则表(KV `mirror:rules`)承担**自定义(长期)**配置:固定 rewrite/stream 模式、pathPrefixes、maxBytes、防盗链 `referer` 覆盖(如 `i.pximg.net` 必须带 `https://www.pixiv.net/`)。未登记站点按响应 Content-Type 自动选模式。
- **搜索**:前端按所选引擎(Bing/Google/百度/DuckDuckGo/GitHub)拼搜索 URL **直接跳转**,无服务端聚合(2026-10-11 修订,见 docs/plan.md §16;src/search 已删除)。
- **AI 网关**:模式 A 透明代理(`/ai/<provider>/*`,只换域名)+ 模式 B 统一 OpenAI 兼容接口(`/v1/*`)。

**明确不做**:不代理需要账号登录的站点(公开浏览/下载尽力而为);所有入口强制鉴权,不做无鉴权开放代理。

## 当前状态(2026-10-11)

已实现:`src/{lib,middleware,mirror,ai,admin}` + `public/`(Listary 风前端:index.html/app.js/app.css,无构建链;含 GitHub 链接识别操作条:镜像浏览/复制 clone 命令/Releases/Raw 转换)+ `test/` 126 用例;`bun run check`(tsc 零错误)与 `bun test` 全绿;`wrangler dev` 冒烟通过(首页/临时代理/SSRF 拦截/HTMLRewriter/AI 双模式错误/git 鉴权链:401 challenge → Basic → info/refs 协议广告正确)。未完成:D1 后置项、真实 Cloudflare 部署(wrangler.toml 的 KV id 是占位符,secrets 需 `wrangler secret put`);真实 `git clone` 全量 pack 流端到端受本机网络限制未验证(workerd 出站不走系统代理,GitHub 直连不可达;协议逻辑已由集成测试覆盖,部署后需复验)。

## 框架与运行时关键事实(实测,勿凭记忆改)

1. **Elysia 1.4 + Cloudflare Workers**:
   - 适配器的 `fetch` 只接收 `Request`,会丢弃 Workers 的 `env`/`ctx`。绑定经 `src/runtime.ts` 的 WeakMap(按 Request 对象引用)注入,handler 内用 `getEnv(c.request)` 取回;默认导出是 `{ fetch(request, env, ctx) }` 包装对象。
   - **不要调用 `.compile()`** — AOT 代码生成走 `new Function`,workerd 禁止;保持 `aot:false` 的动态 handler。
   - **生命周期钩子只作用于注册之后的路由**:root 的 `onRequest/onError/onAfterResponse` 必须在所有 `.use()` 之前;插件局部 onError 在该模式下不会生效,错误格式统一在 root onError 按路径分流(`/v1/*`、`/ai/*` → OpenAI 格式,其余 → 统一 JSON `{error:{code,message}}`)。
   - 动态 handler 会**先于路由逻辑消费 POST body**(按 content-type 解析),透传类路由必须用 `lib/stream.ts` 的 `outboundBody(request, c.body)` 重构请求体,不可直接转发 `request.body`(流已锁定)。
2. **Analytics Engine**:安装的 @cloudflare/workers-types v5 里 `writeDataPoint` 是旧形态字段 `indexes/doubles/blobs`(非 buckets/dimensions/measures)。
3. **Smart Placement** 需付费版,wrangler.toml 中默认注释。
4. **测试环境**:Node 无 HTMLRewriter — 改写逻辑拆为纯函数(`wrapMirrorUrl`/`wrapSrcset`/`rewriteCSSText` 等)单测,HTMLRewriter 胶水由 `wrangler dev` 冒烟覆盖;`sk-` 开头的字符串字面量会被安全扫描打码/拦截 — 测试假 key 用中性命名(如 `up-test-key-1`)。

## 技术栈与命令

Workers + Elysia(CloudflareAdapter, aot:false)+ Bun + Wrangler;前端为 `public/` 静态三件套(无构建链)。

```bash
bun install
bun run dev     # wrangler dev 本地
bun run deploy  # wrangler deploy
bun run check   # tsc --noEmit(当前零错误)
bun test        # vitest(118 用例)
```

本地 secrets 放 `.dev.vars`(参考 `.dev.vars.example`,wrangler dev 自动加载)。

## 目录结构

```text
src/index.ts        # Elysia 入口(钩子在前,use 模块在后)
src/env.ts          # Env / TokenRecord / Scope(mirror|ai|admin)
src/runtime.ts      # WeakMap 绑定注入
src/middleware/     # auth.ts / ratelimit.ts / logger.ts
src/lib/            # ssrf.ts / errors.ts / stream.ts / deferred.ts
src/mirror/         # route.ts rules.ts headers.ts rewrite.ts github.ts
src/ai/             # route.ts passthrough.ts router.ts keys.ts usage.ts channels.ts providers/
src/admin/route.ts  # 令牌/渠道/镜像规则/别名 管理
public/             # index.html + app.js + app.css(Listary 风前端)
test/               # vitest
```

路由:`GET /health`(免鉴权)、`ALL /m/*`、`GET /v1/models` + `POST /v1/chat/completions` + `POST /v1/embeddings`、`ALL /ai/<provider>/*`、`/admin/*`(仅管理员)、`/*` 静态前端。

## 架构分层规则

1. **公共层优先**:鉴权、限流、错误、日志在 `middleware/` 统一做;`/health` 与静态资源之外所有模块入口必须鉴权。
2. **模块间不互相 import**:`mirror/` `ai/` 只依赖 `lib/` 与 `middleware/`;共享逻辑下沉 `lib/`。
3. **错误格式**:统一 JSON `{ error: { code, message } }`;AI 网关路径按 OpenAI 错误格式(root 分流)。
4. **流式优先**:AI 透传直接回 `resp.body` 不解析;HTML 改写用 HTMLRewriter 保持轻量,警惕 CPU 10ms。

## 红线(明确不做,勿在实现中违反)

- **SSRF 防护是回源硬性前提**(镜像临时代理同样生效):仅 http/https、拒绝凭据 URL、拒绝回环/私有/链路本地/CGNAT/云元数据/组播保留地址(含十进制/八进制/十六进制/IPv6 映射等遗留写法)、非常规端口白名单;重定向经 `/m/` 复检。
- **日志只记元数据**(路径、令牌 ID、状态码、耗时、token 数),不记请求体与提示词;上游 key 只存 secrets/KV,与自有令牌分离;明文令牌不落 KV。
- 流式 AI 请求**一旦开始输出就不再切换渠道**(降级只发生在首块之前)。
- 搜索是浏览器直跳,不要"顺手"把 Google 加回服务端代理目标列表(出口 IP 风控);登录类站点不承诺可用。

## 关键设计速查

- 令牌:`Authorization: Bearer` / `X-Token` / Cookie `cmirror_token` / **`Basic`(token 放密码位,用户名任意 — git 客户端只发 Basic)**;范围 mirror/ai(+admin),可用模型、rpm、请求/token 额度、过期时间,存 KV `token:<hash>`;管理员令牌来自 secret `ADMIN_TOKEN`。前端把令牌存 localStorage 并同步写 Cookie,镜像跳转自动带鉴权。
- git smart HTTP 的 401 必须带 `WWW-Authenticate: Basic realm="cmirror"`(root onError 仅对 `/m/…/info/refs|git-upload-pack` 路径加;普通路径不加,否则浏览器弹登录框)。
- 渠道:`{ id, provider, baseUrl, keys[], models[], weight, enabled }` 存 KV;Key 池轮询 + 连续 3 次失败熔断 60s;模型别名 `alias:<name>`;env key 兜底渠道(env-openai/env-anthropic/env-gemini)。
- 镜像改写:改写 `a/link/script/img[srcset]/form/meta[refresh]/base`,相对路径按页面真实 URL 解析再包 `/m/<abs>`;响应头改写 `Location`/`Set-Cookie`(去 Domain、Path=/)、移除 CSP/XFO;注入 fetch/XHR hook 脚本;GitHub smart HTTP(`/info/refs`、`/git-upload-pack`)与下载路径强制 stream 原样透传。
- 前端命令:`/mirror <url>`、`/mirror-github <url>`、`/settings`、`/engine <id>`、`/help`;输入 `/` 弹前缀匹配列表(↑↓/Tab/Enter);URL 形态输入回车 → 临时代理,普通词 → 引擎跳转。

## 已知设计局限(非 bug,改动前先确认)

- Host 头无法在 Workers fetch 中手工设置(由目标 URL 推导);只清洗 Origin/Referer 与 `cf-*`/`x-forwarded-*`。
- Set-Cookie 收敛到本域 Path=/,跨站 cookie 互踩 — 自用场景可接受。
- 域名目标 DNS 重绑定无法回源前拦截;临时代理模式下攻击者可诱导入站令牌用户访问解析到内网的域名(令牌用户自负责,管理员令牌建议只发 mirror/ai 最小范围)。
- git push(receive-pack)与超大流式文件不在支持面。

## 测试要求

- 单测必覆盖:SSRF 判定(含遗留 IP 写法)、镜像头清洗/URL 包装/规则、供应商格式转换(请求/响应/SSE 流)、Key 池熔断、渠道降级、鉴权/限流/额度。
- 集成:直接 `worker.fetch(request, env, ctx)` + MemoryKV + stub global fetch;HTMLRewriter 相关由 `wrangler dev` 冒烟(curl /m/、/health、/admin)。
