# 邮箱取件系统

支持 Outlook IMAP OAuth2、Microsoft Graph API 和 Proton Mail API 的批量取件工具。

前端已重写为 React + Tailwind 工作台，批量取件会按账号渐进显示结果；同一账号只要任一协议成功，就不会再把另一协议失败展示成最终错误。

后端接口说明见 [API.md](./API.md)。

## 本地运行

```bash
npm install
npm run build
npm start
```

默认监听 `0.0.0.0:3000`，打开 `http://localhost:3000` 即可。

## 云服务器运行

```bash
git clone https://github.com/yynxxxxx/outlook_imap_graph_api.git
cd outlook_imap_graph_api
npm install --omit=dev
PORT=3000 npm start
```

建议用 `pm2` 常驻：

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

Nginx 反向代理示例：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CORS_ORIGIN` | `*` | API CORS 来源 |
| `MAX_BODY_BYTES` | `1048576` | API JSON 请求体大小限制 |
| `API_SECURITY_SECRET` | 随机生成 | 加密会话签名密钥，生产环境建议固定设置 |
| `SECURITY_SESSION_TTL_MS` | `600000` | 安全会话有效期 |
| `SECURITY_REQUEST_WINDOW_MS` | `120000` | 取件请求时间窗 |
| `SECURITY_NONCE_TTL_MS` | `600000` | 防重放 nonce 记忆时间 |
| `TOKEN_CACHE_ENABLED` | `true` | 是否启用 access token 内存缓存，设为 `false` 可关闭 |
| `TOKEN_CACHE_SAFETY_MS` | `300000` | AT 过期前多久停止复用并重新刷新 |
| `TOKEN_CACHE_MAX_TTL_MS` | `3300000` | AT 最长内存缓存时间，默认 55 分钟 |
| `TOKEN_CACHE_MAX_ENTRIES` | `2000` | AT 内存缓存最大条目数 |
| `PYTHON_BIN` | `python3` | Proton 取件适配器使用的 Python 解释器 |
| `PROTON_FETCH_TIMEOUT_MS` | `120000` | Proton 单次取件超时时间 |
| `PROTON_PROXY_URL` | 空 | 可选 Proton API 代理，例如 `socks5h://...`，不应写入仓库 |

健康检查地址：`/healthz`

生产环境建议设置一个固定密钥，重启服务后用户不容易遇到安全会话失效：

```bash
export API_SECURITY_SECRET="$(openssl rand -base64 32)"
```

access token 缓存只保存在当前 Node.js 进程内存中，不写入硬盘、浏览器或数据库。Vercel 冷启动、函数实例切换、重新部署后缓存会自动消失。

## Docker 运行

```bash
docker build -t outlook-fetcher .
docker run -d --name outlook-fetcher -p 3000:3000 outlook-fetcher
```

## Cloudflare Workers Paid / Containers 部署

IMAP 需要 TCP/TLS 出站连接，Cloudflare 普通 Worker 不能直接跑 `imapflow`，付费后应部署默认的 Containers 配置：

```bash
npm run cf:deploy
```

`wrangler.toml` 使用 `src/container-worker.js` 和 `Dockerfile`，容器内复用同一套 Node API，因此 `/api/fetch-imap`、`/api/fetch-graph`、`/api/fetch-proton`、`/api/send-graph` 行为一致。`wrangler.graph-only.toml` 仅保留为不需要 IMAP 时的 Graph-only 备用配置。

## 导入/导出格式

每行一个邮箱。Outlook：

```text
账号----密码----clientid----刷新令牌
```

Proton：

```text
账号----密码
```

Proton 也支持导出/导入 `账号----密码----uid----刷新令牌`。页面里的“导出邮箱”会按对应服务商格式导出，方便迁移或备份。

## Proton 取件

后端接口 `POST /api/fetch-proton` 复用 `proton_register.py` 里的 SRP 登录、邮件列表、单封详情和 PGP 正文解密逻辑，通过 `proton_api.py` 以 JSON stdin/stdout 接入 Node。

本地真实测试：

```bash
/Users/sky/code-tools/frida/venv/bin/python3 proton_fetch_test.py
```

测试脚本只输出成功状态、邮件数量和是否解密，不输出账号密码或 token。

## 发件接口

已提供后端接口 `POST /api/send-graph`，前台不展示发件按钮或图标。接口复用现有安全请求封装，明文 JSON 会被拒绝；如需从页面脚本调用，可复用 `public/js/app.js` 里的 `secureApiFetch` 逻辑。

解密后的业务参数：

```json
{
  "email": "sender@outlook.com",
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌",
  "to": "receiver@example.com",
  "cc": ["copy@example.com"],
  "bcc": [],
  "subject": "邮件标题",
  "text": "纯文本正文",
  "html": "<p>HTML 正文，可选</p>",
  "saveToSentItems": true
}
```

也可以直接传 `accessToken` 代替 `clientId` + `refreshToken`。`to`、`cc`、`bcc`、`replyTo` 支持字符串、字符串数组，或 `{ "email": "...", "name": "..." }` 格式对象。
