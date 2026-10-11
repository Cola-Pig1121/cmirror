# cmirror

**万用镜像 + AI 网关 + 引擎直跳搜索**,基于 Cloudflare Workers 的自部署一体站点。一个 Worker、一个域名,浏览器里一个 Listary 风搜索框搞定三件事。

## 功能

### 🪞 万用镜像 `/m/<url>`

- 任意公网 URL 直接代理浏览;**HTML/CSS 深度改写**(链接、图片、srcset、表单、meta refresh 全部包装),页面内跳转自动留在镜像里,并注入轻量 hook 处理 JS 发起的请求。
- **临时 / 自定义两级**:不登记即临时代理(按 Content-Type 自动选模式);规则表(KV)可固定站点的 rewrite/stream 模式、路径收窄、大小限制、防盗链 `referer` 覆盖(如 GitHub 静态域、npm、PyPI 已内置)。
- **手动模式**:URL 路径段 `/m/stream/…`、`/m/rewrite/…` 强制透传或改写,页面内链接全程继承。
- **GitHub 专项**:`git clone https://你的域名/m/https://github.com/用户/仓库.git` 直接可用(smart HTTP 协议原样透传),仓库页/Releases/Raw 均有快捷入口。
- 安全:强制鉴权(不做开放代理)、SSRF 防护(拒绝回环/私有/保留地址与云元数据,含十进制/八进制/十六进制/IPv6 各种遗留写法)、目标站 Cookie 一律不回传浏览器。

### 🤖 AI 网关

- **模式 A 透明代理**:`/ai/<provider>/*` → 上游(如 `/ai/openai/v1/chat/completions`)。官方 SDK 只改 `baseURL` 和 key,响应流式零解析。
- **模式 B 统一接口**:`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`,OpenAI 格式进,任意供应商出(Anthropic / Gemini 完整适配含 SSE 逐块转换,OpenAI 兼容系直通)。
- 渠道管理(KV)、多 Key 轮询 + 连续失败熔断、429/5xx 自动降级换渠道、模型别名、令牌级模型白名单与额度(token 数 / 请求数)。

### 🔍 搜索

前端按所选引擎(Bing / Google / 百度 / DuckDuckGo / GitHub)拼 URL 直接跳转,零服务端成本;输入 URL 则自动识别走镜像。

### 🎛 统一入口 UI

纯白背景、居中圆角搜索框(Listary 风):输入 `/` 弹出命令补全(`/mirror`、`/mirror-github`、`/settings`、`/engine`、`/help`);URL 识别操作条带模式三选;`/settings` 管理令牌、默认引擎与自定义代理站点。

### 🔐 公共层

令牌(Bearer / X-Token / Cookie / Basic 四种携带方式,git 客户端原生兼容)、按令牌+IP 双维度限流、统一错误格式(AI 路径 OpenAI 兼容)、Analytics Engine 元数据统计(不落盘任何请求体/提示词)。管理员可在网页后台签发限权令牌并生成**分享链接**(`/#setup=<token>`,对方打开自动完成配置)。

## 快速部署

```bash
bun install
npx wrangler login
npx wrangler kv namespace create KV        # 把输出的 id 填进 wrangler.toml
npx wrangler secret put ADMIN_TOKEN        # 一个强随机串
npx wrangler deploy
```

完整指南(绑定自有域名、令牌签发、渠道配置、CI)见 **[docs/deploy.md](docs/deploy.md)**,原始工程规划见 **[docs/plan.md](docs/plan.md)**。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填本地 ADMIN_TOKEN
bun run dev                      # wrangler dev,默认 http://127.0.0.1:8787
bun run check                    # tsc --noEmit
bun test                         # vitest,130 用例
```

## 技术栈

Cloudflare Workers · Elysia(CloudflareAdapter)· KV · Analytics Engine · Static Assets · Bun · Vitest

## 限制与边界

- 需要登录的站点不保证可用(设计上不支持);对数据中心 IP 风控的站点(如 pixiv 网页端、x.com)可能被上游拦截。
- 免费版 CPU 10ms/请求:流式透传为主,重度改写站点建议升级 Basic。
- `workers.dev` 在部分网络环境不稳定,正式使用请绑定自有域名。
