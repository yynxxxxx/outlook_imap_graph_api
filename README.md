# Outlook 快速取件

支持 Outlook IMAP OAuth2 和 Microsoft Graph API 双协议取件的轻量 Web 工具。

## 本地运行

```bash
npm install
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

健康检查地址：`/healthz`

生产环境建议设置一个固定密钥，重启服务后用户不容易遇到安全会话失效：

```bash
export API_SECURITY_SECRET="$(openssl rand -base64 32)"
```

## Docker 运行

```bash
docker build -t outlook-fetcher .
docker run -d --name outlook-fetcher -p 3000:3000 outlook-fetcher
```

## 导入/导出格式

每行一个邮箱：

```text
账号----密码----clientid----刷新令牌
```

页面里的“导出邮箱”会按同样格式导出，方便迁移或备份。
