# Outlook IMAP / Graph API 文档

本文档描述当前项目提供的后端接口。线上示例域名：

```text
https://mail.chatai.codes
```

本地默认地址：

```text
http://localhost:3000
```

## 接口总览

| 接口 | 方法 | 说明 | 是否需要安全封包 |
| --- | --- | --- | --- |
| `/healthz` | `GET` | 健康检查 | 否 |
| `/api/security-session` | `POST` | 获取安全会话，用于后续 API 加密请求 | 否 |
| `/api/refresh-token` | `POST` | 使用 refresh token 换取 access token | 是 |
| `/api/fetch-graph` | `POST` | 通过 Microsoft Graph 取件 | 是 |
| `/api/fetch-imap` | `POST` | 通过 Outlook IMAP XOAUTH2 取件 | 是 |
| `/api/send-graph` | `POST` | 通过 Microsoft Graph 发件 | 是 |

除 `/healthz` 外，API 支持 `OPTIONS` 预检请求。服务端 CORS 默认允许 `*`，可通过 `CORS_ORIGIN` 环境变量调整。

错误响应会尽量包含以下字段，页面也会按同一结构展示：

| 字段 | 说明 |
| --- | --- |
| `code` | 稳定错误码，例如 `TOKEN_EXPIRED_OR_REVOKED`、`IMAP_AUTH_FAILED`、`GRAPH_ACCESS_DENIED` |
| `error` | 面向用户的简短错误信息 |
| `reason` | 更明确的失败原因 |
| `action` | 建议处理方式 |
| `detail` | 服务端原始错误摘要，用于排查 |

## 安全请求封包

除 `/api/security-session` 外，所有业务 API 都要求使用安全封包。直接提交明文 JSON 会返回类似：

```json
{
  "success": false,
  "error": "GRAPH: 请求缺少安全签名，请刷新页面重试"
}
```

调用流程：

1. 调用 `POST /api/security-session` 获取 `sessionId`、`sessionKey`、`sessionToken`。
2. 使用 `sessionKey` 对业务 JSON 做 AES-256-GCM 加密。
3. 使用同一个 `sessionKey` 对签名串做 HMAC-SHA256 签名。
4. 将安全封包提交给目标业务 API。

安全封包格式：

```json
{
  "secure": true,
  "sessionId": "安全会话 ID",
  "sessionToken": "服务端签发的会话 token",
  "nonce": "一次性随机字符串，base64url",
  "timestamp": 1710000000000,
  "iv": "AES-GCM IV，base64url",
  "ciphertext": "AES-GCM 密文加 auth tag，base64url",
  "signature": "HMAC-SHA256 签名，base64url"
}
```

签名原文：

```text
sessionId.nonce.timestamp.iv.ciphertext
```

安全限制：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 会话有效期 | `10` 分钟 | 由 `SECURITY_SESSION_TTL_MS` 控制 |
| 请求时间窗 | `2` 分钟 | 由 `SECURITY_REQUEST_WINDOW_MS` 控制 |
| nonce 防重放记忆时间 | `10` 分钟 | 由 `SECURITY_NONCE_TTL_MS` 控制 |

前端已有可复用实现：`public/js/app.js` 里的 `secureApiFetch()`、`createSecureEnvelope()`。

## 通用账号字段

取件和发件接口都支持两种鉴权方式。

方式一：传 `clientId + refreshToken`，服务端自动刷新 access token：

```json
{
  "email": "user@outlook.com",
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌"
}
```

方式二：直接传 `accessToken`：

```json
{
  "email": "user@outlook.com",
  "accessToken": "access_token"
}
```

如果传入 `accessToken`，服务端不会刷新 token。若未传 `accessToken`，必须提供 `clientId` 和 `refreshToken`。

## Access Token 缓存

服务端会在 Node.js 进程内存中缓存 access token，减少频繁刷新。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TOKEN_CACHE_ENABLED` | `true` | 是否启用 access token 内存缓存，设为 `false` 可关闭 |
| `TOKEN_CACHE_SAFETY_MS` | `300000` | AT 过期前多久停止复用并重新刷新 |
| `TOKEN_CACHE_MAX_TTL_MS` | `3300000` | AT 最长内存缓存时间，默认 55 分钟 |
| `TOKEN_CACHE_MAX_ENTRIES` | `2000` | AT 内存缓存最大条目数 |

缓存只存在于当前函数实例内存中，不写硬盘、不写浏览器、不写数据库。Vercel 冷启动、实例切换或重新部署后缓存会消失。

## GET /healthz

健康检查接口。

请求：

```bash
curl https://mail.chatai.codes/healthz
```

成功响应：

```json
{
  "ok": true,
  "uptime": 123.45
}
```

## POST /api/security-session

获取安全会话。该接口不需要安全封包。

请求：

```bash
curl -X POST https://mail.chatai.codes/api/security-session \
  -H "Content-Type: application/json" \
  -d "{}"
```

成功响应：

```json
{
  "success": true,
  "sessionId": "uuid",
  "sessionKey": "base64url-encoded-32-byte-key",
  "sessionToken": "v1.iv.ciphertext.tag",
  "expiresAt": "2026-06-01T12:00:00.000Z"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `sessionId` | 安全会话 ID |
| `sessionKey` | 前端加密和签名用的临时密钥 |
| `sessionToken` | 服务端签发的加密会话凭证 |
| `expiresAt` | 会话过期时间 |

## POST /api/refresh-token

使用 `clientId + refreshToken` 获取 access token。该接口主要用于调试或前端需要显式拿 AT 的场景。

解密后的业务请求体：

```json
{
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌"
}
```

成功响应：

```json
{
  "accessToken": "access_token",
  "expiresIn": 3600
}
```

错误响应示例：

```json
{
  "success": false,
  "error": "TOKEN: 刷新令牌无效或已过期，请重新获取 refresh_token",
  "detail": "Token 刷新失败: invalid_grant - ..."
}
```

说明：

| 项 | 值 |
| --- | --- |
| OAuth endpoint | `https://login.microsoftonline.com/common/oauth2/v2.0/token` |
| grant_type | `refresh_token` |
| scope | 不传，使用原始授权范围 |

## POST /api/fetch-graph

通过 Microsoft Graph API 获取邮件。默认读取 `inbox` 和 `junkemail`。

解密后的业务请求体：

```json
{
  "email": "user@outlook.com",
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌",
  "keyword": "搜索关键词，可选",
  "limit": 10,
  "sender": "sender@example.com",
  "folder": "inbox",
  "folders": ["inbox", "junkemail"]
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | 邮箱地址 |
| `clientId` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `refreshToken` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `accessToken` | string | 否 | - | 直接使用已有 Graph access token |
| `keyword` | string | 否 | `""` | Graph `$search` 关键词 |
| `limit` | number | 否 | `10` | 最终返回数量 |
| `sender` | string | 否 | `""` | 按发件人邮箱过滤 |
| `folder` | string 或 string[] | 否 | - | 指定单个或多个 Graph 文件夹 |
| `folders` | string[] | 否 | `["inbox","junkemail"]` | 指定多个 Graph 文件夹，优先于 `folder` |

成功响应：

```json
{
  "success": true,
  "protocol": "graph",
  "count": 1,
  "emails": [
    {
      "id": "<message-id>",
      "messageId": "<message-id>",
      "subject": "邮件主题",
      "from": "sender@example.com",
      "fromName": "Sender Name",
      "date": "2026-06-01T12:00:00Z",
      "bodyPreview": "预览文本",
      "bodyHtml": "<p>HTML 内容</p>",
      "bodyText": "纯文本内容",
      "hasAttachments": false,
      "folder": "inbox",
      "protocol": "graph"
    }
  ]
}
```

错误响应：

```json
{
  "success": false,
  "protocol": "graph",
  "error": "GRAPH: Graph 无法访问该邮箱，请检查账号类型或权限",
  "detail": "Graph API 错误: ...",
  "emails": []
}
```

实现说明：

| 项 | 说明 |
| --- | --- |
| Graph scope | 自动刷新时使用 `https://graph.microsoft.com/.default` |
| Graph endpoint | `/me/mailFolders/{folder}/messages` |
| 返回字段 | `id,subject,from,receivedDateTime,bodyPreview,body,internetMessageId,hasAttachments` |
| 单文件夹 `$top` | 最多 `50` |
| 排序 | `receivedDateTime desc` |
| 去重 | 按 `messageId` 或 `subject + date + folder` |

## POST /api/fetch-imap

通过 Outlook IMAP + XOAUTH2 获取邮件。默认读取收件箱和垃圾邮件文件夹。

解密后的业务请求体：

```json
{
  "email": "user@outlook.com",
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌",
  "keyword": "搜索关键词，可选",
  "limit": 5,
  "sender": "sender@example.com",
  "folder": "INBOX",
  "folders": ["INBOX", "Junk Email"]
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | 邮箱地址 |
| `clientId` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `refreshToken` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `accessToken` | string | 否 | - | 直接使用已有 IMAP scope access token |
| `keyword` | string | 否 | `""` | IMAP 搜索主题或正文 |
| `limit` | number | 否 | `5` | 最终返回数量，接口最多按 `10` 处理 |
| `sender` | string | 否 | `""` | 按发件人过滤 |
| `folder` | string 或 string[] | 否 | - | 指定单个或多个 IMAP 文件夹 |
| `folders` | string[] | 否 | 自动识别收件箱和垃圾邮件 | 指定多个 IMAP 文件夹，优先于 `folder` |

成功响应：

```json
{
  "success": true,
  "protocol": "imap",
  "count": 1,
  "emails": [
    {
      "id": "<message-id>",
      "messageId": "<message-id>",
      "subject": "邮件主题",
      "from": "sender@example.com",
      "fromName": "Sender Name",
      "date": "2026-06-01T12:00:00.000Z",
      "bodyPreview": "预览文本",
      "bodyHtml": "<p>HTML 内容</p>",
      "bodyText": "纯文本内容",
      "hasAttachments": false,
      "folder": "INBOX",
      "protocol": "imap"
    }
  ]
}
```

错误响应：

```json
{
  "success": false,
  "protocol": "imap",
  "error": "IMAP: IMAP 认证失败，请检查账号权限和令牌 scope",
  "detail": "Authentication failed",
  "emails": []
}
```

实现说明：

| 项 | 说明 |
| --- | --- |
| IMAP host | `outlook.office365.com` |
| IMAP port | `993` |
| 加密 | TLS |
| 认证 | XOAUTH2 |
| 默认文件夹 | 自动识别 `\\Inbox` 和 `\\Junk`，失败时回退到 `INBOX` 和 `JUNK` |
| 单接口最大 limit | `10` |
| 去重 | 按 `messageId` 或 `subject + date + folder` |

## POST /api/send-graph

通过 Microsoft Graph `/me/sendMail` 发件。前台不暴露按钮或图标，但接口可供外部或内部调用。

解密后的业务请求体：

```json
{
  "email": "sender@outlook.com",
  "clientId": "应用 Client ID",
  "refreshToken": "刷新令牌",
  "to": "receiver@example.com",
  "cc": ["copy@example.com"],
  "bcc": [],
  "replyTo": "reply@example.com",
  "subject": "邮件标题",
  "text": "纯文本正文",
  "html": "<p>HTML 正文，可选</p>",
  "importance": "normal",
  "attachments": [
    {
      "name": "hello.txt",
      "contentType": "text/plain",
      "contentBytes": "aGVsbG8="
    }
  ],
  "saveToSentItems": true
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | 发件账号，用于标记响应和刷新 token |
| `clientId` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `refreshToken` | string | 条件必填 | - | 未提供 `accessToken` 时必填 |
| `accessToken` | string | 否 | - | 直接使用已有 Graph access token |
| `to` | string / array / object | 是 | - | 收件人 |
| `cc` | string / array / object | 否 | - | 抄送 |
| `bcc` | string / array / object | 否 | - | 密送 |
| `replyTo` | string / array / object | 否 | - | 回复地址 |
| `subject` | string | 是 | - | 邮件主题 |
| `text` | string | 条件必填 | - | 纯文本正文 |
| `html` | string | 条件必填 | - | HTML 正文，优先级高于 `text` |
| `body` | string | 条件必填 | - | 正文兜底字段，优先级低于 `html` 和 `text` |
| `importance` | string | 否 | - | `low`、`normal`、`high` |
| `attachments` | array | 否 | - | 文件附件数组 |
| `saveToSentItems` | boolean/string | 否 | `true` | 是否保存到已发送；传 `false`、`"false"`、`"0"`、`"no"` 表示不保存 |

收件人格式支持：

```json
"user@example.com"
```

```json
"User Name <user@example.com>; second@example.com"
```

```json
["user@example.com", "second@example.com"]
```

```json
{
  "email": "user@example.com",
  "name": "User Name"
}
```

```json
{
  "emailAddress": {
    "address": "user@example.com",
    "name": "User Name"
  }
}
```

附件格式：

```json
{
  "name": "file.txt",
  "contentType": "text/plain",
  "contentBytes": "base64 文件内容"
}
```

也可使用 `base64` 字段代替 `contentBytes`：

```json
{
  "name": "file.txt",
  "base64": "base64 文件内容"
}
```

成功响应：

```json
{
  "success": true,
  "protocol": "graph",
  "from": "sender@outlook.com",
  "status": 202,
  "accepted": true,
  "savedToSentItems": true
}
```

错误响应：

```json
{
  "success": false,
  "protocol": "graph",
  "error": "GRAPH: Graph 权限不足，请检查应用是否已授权 Mail.Send 等所需权限",
  "detail": "Graph 发件失败: ErrorAccessDenied - Access is denied."
}
```

实现说明：

| 项 | 说明 |
| --- | --- |
| Graph scope | 自动刷新时使用 `https://graph.microsoft.com/.default` |
| Graph endpoint | `/me/sendMail` |
| 成功状态 | Microsoft Graph 返回 `202 Accepted` |
| 正文类型 | 传 `html` 时为 `HTML`，否则为 `Text` |
| 附件类型 | `#microsoft.graph.fileAttachment` |

## 邮件对象字段

取件接口返回的 `emails[]` 字段结构统一如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 邮件 ID，优先使用 Internet Message ID |
| `messageId` | string | 邮件 Message ID |
| `subject` | string | 邮件主题 |
| `from` | string | 发件人邮箱 |
| `fromName` | string | 发件人显示名 |
| `date` | string | 邮件时间，ISO 字符串 |
| `bodyPreview` | string | 邮件预览 |
| `bodyHtml` | string | HTML 正文 |
| `bodyText` | string | 纯文本正文 |
| `hasAttachments` | boolean | 是否有附件 |
| `folder` | string | 来源文件夹 |
| `protocol` | string | `graph` 或 `imap` |

## 常见错误

| 场景 | 返回提示 |
| --- | --- |
| refresh token 失效 | `刷新令牌无效或已过期，请重新获取 refresh_token` |
| client id 错误 | `client_id 无效，请检查导入的 clientid` |
| 需要重新授权 | `账号需要重新授权或补充权限` |
| IMAP 认证失败 | `IMAP 认证失败，请检查账号权限和令牌 scope` |
| 请求超时 | `连接超时，请稍后重试或降低取件数量` |
| Graph 访问邮箱失败 | `Graph 无法访问该邮箱，请检查账号类型或权限` |
| Graph 发件权限不足 | `Graph 权限不足，请检查应用是否已授权 Mail.Send 等所需权限` |
| 安全请求缺失 | `请求缺少安全签名，请刷新页面重试` |
| 重放请求 | `重复请求已拦截，请重新取件` |

## Node.js 调用示例

下面示例演示如何生成安全封包并调用发件接口。

```js
const crypto = require('crypto');

const baseUrl = 'https://mail.chatai.codes';

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

async function createSecureEnvelope(payload) {
  const sessionRes = await fetch(`${baseUrl}/api/security-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const session = await sessionRes.json();

  if (!sessionRes.ok || !session.success) {
    throw new Error(session.error || 'security-session failed');
  }

  const key = Buffer.from(session.sessionKey, 'base64url');
  const iv = crypto.randomBytes(12);
  const nonce = toBase64Url(crypto.randomBytes(16));
  const timestamp = Date.now();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertextRaw = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const ciphertext = toBase64Url(Buffer.concat([ciphertextRaw, cipher.getAuthTag()]));
  const ivValue = toBase64Url(iv);
  const signedText = `${session.sessionId}.${nonce}.${timestamp}.${ivValue}.${ciphertext}`;
  const signature = crypto.createHmac('sha256', key).update(signedText).digest('base64url');

  return {
    secure: true,
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    nonce,
    timestamp,
    iv: ivValue,
    ciphertext,
    signature,
  };
}

async function sendMail() {
  const envelope = await createSecureEnvelope({
    email: 'sender@outlook.com',
    clientId: '应用 Client ID',
    refreshToken: '刷新令牌',
    to: 'receiver@example.com',
    subject: 'test graph 发件',
    text: 'test',
  });

  const response = await fetch(`${baseUrl}/api/send-graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  console.log(await response.json());
}

sendMail().catch(console.error);
```

## 部署注意事项

生产环境建议配置：

```bash
API_SECURITY_SECRET="固定随机密钥"
```

如果不配置，服务会优先使用 `VERCEL_GIT_COMMIT_SHA`，再退回运行时随机密钥。随机密钥会导致服务重启后旧安全会话失效，用户刷新页面即可恢复。

Vercel 函数超时配置在 `vercel.json` 中，当前业务接口均为 `10` 秒。
