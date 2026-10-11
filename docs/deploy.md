# cmirror 部署指南(Cloudflare Workers)

前提:有一个 Cloudflare 账号(免费版即可,每日 10 万请求)。

## 1. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出 OAuth 授权页,点 Allow。凭证存在本机,只需一次。

## 2. 创建 KV 命名空间并回填 id

```bash
npx wrangler kv namespace create KV
```

输出里的 `id = "..."` 替换 `wrangler.toml` 中的 `id = "local-dev-placeholder"`。

## 3. 配置 secrets(不要写进任何文件或提交)

```bash
npx wrangler secret put ADMIN_TOKEN        # 粘贴一个强随机串,如 openssl rand -hex 24 或 密码管理器生成
npx wrangler secret put ANTHROPIC_API_KEY  # 可选:env 兜底渠道
npx wrangler secret put GEMINI_API_KEY     # 可选
npx wrangler secret put OPENAI_API_KEY     # 可选
npx wrangler secret put BRAVE_API_KEY      # 可选(聚合搜索已废弃,不需要)
```

`ADMIN_TOKEN` 就是你在 /settings 里填的管理员令牌;泄露即可管理全站,请只用随机串。

## 4. 部署

```bash
npx wrangler deploy
```

得到 `https://cmirror.<你的子域>.workers.dev`。

## 5. 绑定自有域名(强烈建议)

`workers.dev` 在部分网络环境不可达/不稳定。CF 控制台 → Workers & Pages → cmirror → **Domains & Routes** → Add Custom Domain,绑一个你托管在 CF 的域名(如 `cm.example.com`)。绑定后镜像/clone 体验都走自己的域名。

## 6. 部署后验收

```bash
curl https://cm.example.com/health
# 浏览器打开首页 → /settings 填 ADMIN_TOKEN 值 → 试 /m/https://example.com 与 GitHub 仓库镜像
git clone https://cmirror:<ADMIN_TOKEN>@cm.example.com/m/https://github.com/octocat/Hello-World.git
```

## 7. 令牌与渠道管理(部署后)

```bash
# 签发普通用户令牌(scope 最小化)
curl -X POST https://cm.example.com/admin/tokens \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"name":"me","scopes":["mirror","ai"],"rpm":60}'

# 添加 AI 渠道(多 key 轮询 + 熔断降级)
curl -X PUT https://cm.example.com/admin/channels/deepseek \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"provider":"deepseek","baseUrl":"https://api.deepseek.com","keys":["<key1>","<key2>"],"models":["deepseek-chat"],"weight":1,"enabled":true}'
```

## 8. 本地开发代理说明

`wrangler dev` 的 worker 出站由 workerd 直连,**不走** `http_proxy` 环境变量(wrangler 的代理提示只作用于它自己访问 Cloudflare API)。本机直连不可达的站点(如 GitHub/pixiv)在本地会 502 `Network connection lost`,属预期;要让本地也通,在代理软件(如 Clash)开启 **TUN 模式**或把 `workerd.exe` 加入进程代理,部署到 Cloudflare 后无此问题。

## 9. 升级付费版的场景

- CPU 10ms/请求 不够(重度 HTML 改写)→ Basic($5/月,30s CPU)。
- 需要 Smart Placement(供应商地区风控)→ 取消 `wrangler.toml` 里 `[placement]` 注释。
