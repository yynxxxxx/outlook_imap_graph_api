# mail.dimosky.online 邮箱取件 API 文档

本文档只描述新站点 `mail.dimosky.online` 的取件接口，覆盖 Outlook/Hotmail 的 Graph、IMAP OAuth2 取件，以及 Proton Mail API 取件。

## 基础信息

```text
Base URL: https://mail.dimosky.online
Content-Type: application/json
```

接口总览：

| 接口 | 方法 | 用途 | 是否需要安全封包 |
| --- | --- | --- | --- |
| `/healthz` | `GET` | 健康检查 | 否 |
| `/api/security-session` | `POST` | 获取临时安全会话 | 否 |
| `/api/fetch-graph` | `POST` | Outlook/Hotmail Graph 取件 | 是 |
| `/api/fetch-imap` | `POST` | Outlook/Hotmail IMAP OAuth2 取件 | 是 |
| `/api/fetch-proton` | `POST` | Proton Mail API 取件 | 是 |

除 `/healthz` 和 `/api/security-session` 外，业务接口不能直接提交明文 JSON，必须先生成安全封包。

## 调用流程

1. 调用 `POST /api/security-session` 获取 `sessionId`、`sessionKey`、`sessionToken`。
2. 使用 `sessionKey` 对取件参数做 AES-256-GCM 加密。
3. 使用 `sessionKey` 对 `sessionId.nonce.timestamp.iv.ciphertext` 做 HMAC-SHA256 签名。
4. 将安全封包提交给 `/api/fetch-graph`、`/api/fetch-imap` 或 `/api/fetch-proton`。
5. 如果返回 `401` 或 `403`，重新获取安全会话后重试一次。

安全会话默认有效期为 10 分钟，请求时间窗默认 2 分钟，`nonce` 会用于防重放。

## 安全封包格式

```json
{
  "secure": true,
  "sessionId": "uuid",
  "sessionToken": "v1.iv.ciphertext.tag",
  "nonce": "base64url-random",
  "timestamp": 1785852000000,
  "iv": "base64url-12-byte-iv",
  "ciphertext": "base64url(ciphertext + authTag)",
  "signature": "base64url-hmac-sha256"
}
```

`ciphertext` 解密后的内容才是真正的业务请求体。签名原文固定为：

```text
sessionId.nonce.timestamp.iv.ciphertext
```

## POST /api/security-session

获取临时安全会话，不需要安全封包。

请求：

```bash
curl -X POST https://mail.dimosky.online/api/security-session \
  -H "Content-Type: application/json" \
  -d "{}"
```

响应：

```json
{
  "success": true,
  "sessionId": "0b6f8c8e-0000-0000-0000-000000000000",
  "sessionKey": "base64url-encoded-32-byte-key",
  "sessionToken": "v1.iv.ciphertext.tag",
  "expiresAt": "2026-08-04T14:30:00.000Z"
}
```

## Outlook 账号字段

Graph 和 IMAP 取件都支持两种鉴权方式。

方式一：传 `clientId + refreshToken`，服务端自动刷新 access token：

```json
{
  "email": "user@outlook.com",
  "clientId": "Microsoft OAuth Client ID",
  "refreshToken": "Microsoft refresh_token"
}
```

方式二：直接传已获取的 `accessToken`：

```json
{
  "email": "user@hotmail.com",
  "accessToken": "access_token"
}
```

如果未传 `accessToken`，必须传 `clientId` 和 `refreshToken`。

## POST /api/fetch-graph

通过 Microsoft Graph 获取 Outlook/Hotmail 邮件。默认读取 `inbox` 和 `junkemail`。

解密后的业务请求体：

```json
{
  "email": "user@outlook.com",
  "clientId": "Microsoft OAuth Client ID",
  "refreshToken": "Microsoft refresh_token",
  "keyword": "验证码",
  "limit": 10,
  "sender": "sender@example.com",
  "folders": ["inbox", "junkemail"]
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | Outlook/Hotmail 邮箱 |
| `clientId` | string | 条件必填 | - | 未传 `accessToken` 时必填 |
| `refreshToken` | string | 条件必填 | - | 未传 `accessToken` 时必填 |
| `accessToken` | string | 否 | - | 已有 Graph access token |
| `keyword` | string | 否 | `""` | Graph 搜索关键词 |
| `limit` | number | 否 | `10` | 最终返回邮件数量 |
| `sender` | string | 否 | `""` | 发件人过滤 |
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
      "subject": "Your verification code",
      "from": "sender@example.com",
      "fromName": "Sender Name",
      "date": "2026-08-04T12:00:00Z",
      "bodyPreview": "Your code is 123456",
      "bodyHtml": "<p>Your code is 123456</p>",
      "bodyText": "Your code is 123456",
      "hasAttachments": false,
      "folder": "inbox",
      "protocol": "graph"
    }
  ]
}
```

说明：

| 项 | 值 |
| --- | --- |
| 自动刷新 scope | `https://graph.microsoft.com/.default` |
| Graph endpoint | `/me/mailFolders/{folder}/messages` |
| 默认排序 | `receivedDateTime desc` |
| 单文件夹最大 `$top` | `50` |

## POST /api/fetch-imap

通过 Outlook IMAP + XOAUTH2 获取邮件。默认自动识别收件箱和垃圾邮件文件夹。

解密后的业务请求体：

```json
{
  "email": "user@outlook.com",
  "clientId": "Microsoft OAuth Client ID",
  "refreshToken": "Microsoft refresh_token",
  "keyword": "验证码",
  "limit": 5,
  "sender": "sender@example.com",
  "folders": ["INBOX", "Junk Email"]
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | Outlook/Hotmail 邮箱 |
| `clientId` | string | 条件必填 | - | 未传 `accessToken` 时必填 |
| `refreshToken` | string | 条件必填 | - | 未传 `accessToken` 时必填 |
| `accessToken` | string | 否 | - | 已有 IMAP scope access token |
| `keyword` | string | 否 | `""` | IMAP 搜索主题或正文 |
| `limit` | number | 否 | `5` | 最终返回邮件数量，接口最多处理 `10` |
| `sender` | string | 否 | `""` | 发件人过滤 |
| `folder` | string 或 string[] | 否 | - | 指定单个或多个 IMAP 文件夹 |
| `folders` | string[] | 否 | 自动识别 | 指定多个 IMAP 文件夹，优先于 `folder` |

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
      "subject": "Your verification code",
      "from": "sender@example.com",
      "fromName": "Sender Name",
      "date": "2026-08-04T12:00:00.000Z",
      "bodyPreview": "Your code is 123456",
      "bodyHtml": "<p>Your code is 123456</p>",
      "bodyText": "Your code is 123456",
      "hasAttachments": false,
      "folder": "INBOX",
      "protocol": "imap"
    }
  ],
  "diagnostics": []
}
```

说明：

| 项 | 值 |
| --- | --- |
| IMAP host | `outlook.office365.com` |
| IMAP port | `993` |
| 加密方式 | TLS |
| 认证方式 | XOAUTH2 |
| 单接口最大 limit | `10` |

注意：`IMAP: Command failed` 只能说明 IMAP 服务器返回了失败状态，不能单独判断账号一定没开 IMAP。可能原因包括账号未启用 IMAP、token scope 不包含 IMAP 权限、文件夹不可访问、搜索条件触发限制或 Outlook 临时限制。

## POST /api/fetch-proton

通过 Proton Mail API 取件，内部会处理 SRP 登录、邮件列表、单封详情和 PGP 正文解密。

解密后的业务请求体：

```json
{
  "email": "user@proton.me",
  "password": "Proton password",
  "uid": "saved uid, optional",
  "accessToken": "saved access token, optional",
  "refreshToken": "saved refresh token, optional",
  "keyword": "验证码",
  "limit": 10,
  "sender": "sender@example.com",
  "folder": "0"
}
```

参数说明：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `email` | string | 是 | - | Proton 邮箱 |
| `password` | string | 是 | - | Proton 密码，用于 SRP 登录和私钥解密 |
| `uid` | string | 否 | - | 已保存 Proton 会话 UID |
| `accessToken` | string | 否 | - | 已保存 Proton access token |
| `refreshToken` | string | 否 | - | 已保存 Proton refresh token |
| `keyword` | string | 否 | `""` | 邮件关键词过滤 |
| `limit` | number | 否 | `10` | 最终返回邮件数量，最多 `30` |
| `sender` | string | 否 | `""` | 发件人过滤 |
| `folder` | string | 否 | `"0"` | Proton LabelID，`0` 为收件箱 |

成功响应：

```json
{
  "success": true,
  "protocol": "proton",
  "count": 1,
  "emails": [
    {
      "id": "<message-id>",
      "messageId": "<message-id>",
      "subject": "Your verification code",
      "from": "sender@example.com",
      "fromName": "Sender Name",
      "date": "2026-08-04T12:00:00+00:00",
      "bodyPreview": "Your code is 123456",
      "bodyHtml": "<p>Your code is 123456</p>",
      "bodyText": "Your code is 123456",
      "hasAttachments": false,
      "folder": "inbox",
      "protocol": "proton"
    }
  ],
  "session": {
    "uid": "<uid>",
    "accessToken": "<new access token>",
    "refreshToken": "<new refresh token>",
    "expiresIn": 86400,
    "updated": true
  }
}
```

如果响应里有 `session`，建议调用方保存 `uid/accessToken/refreshToken/expiresIn`，下次取件可复用会话；邮箱密码仍只由调用方自己保存，不会写入 Cloudflare D1 统计库。

## 邮件对象统一字段

三个取件接口返回的 `emails[]` 字段基本统一：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 邮件 ID |
| `messageId` | string | 邮件 Message ID |
| `subject` | string | 邮件主题 |
| `from` | string | 发件人邮箱 |
| `fromName` | string | 发件人显示名 |
| `date` | string | 邮件时间，ISO 字符串 |
| `bodyPreview` | string | 邮件摘要 |
| `bodyHtml` | string | HTML 正文 |
| `bodyText` | string | 纯文本正文 |
| `hasAttachments` | boolean | 是否有附件 |
| `folder` | string | 来源文件夹 |
| `protocol` | string | `graph`、`imap` 或 `proton` |

## 错误响应格式

失败时接口会尽量返回结构化错误：

```json
{
  "success": false,
  "protocol": "imap",
  "code": "IMAP_AUTH_FAILED",
  "error": "IMAP: IMAP 认证失败，令牌没有通过服务器校验",
  "reason": "XOAUTH2 登录阶段被拒绝",
  "action": "请确认账号已启用 IMAP，并重新授权包含 IMAP.AccessAsUser.All 的 refresh_token",
  "detail": "Authentication failed",
  "emails": []
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `success` | 是否成功 |
| `protocol` | `graph`、`imap` 或 `proton` |
| `code` | 稳定错误码，便于程序判断 |
| `error` | 给用户看的简短错误 |
| `reason` | 更具体的失败原因 |
| `action` | 建议处理动作 |
| `detail` | 服务端原始错误摘要，用于排查 |
| `emails` | 失败时为空数组 |

常见错误：

| 场景 | 常见 `code` / 提示 |
| --- | --- |
| 安全封包缺失 | `请求缺少安全签名，请刷新页面重试` |
| 安全会话过期 | `安全会话已过期，请刷新页面重试` |
| 请求重放 | `重复请求已拦截，请重新取件` |
| refresh token 失效 | `TOKEN_EXPIRED_OR_REVOKED` |
| client id 错误 | `INVALID_CLIENT_ID` |
| Graph 权限不足 | `GRAPH_ACCESS_DENIED` |
| IMAP 认证失败 | `IMAP_AUTH_FAILED` |
| Proton 登录或会话失效 | `PROTON_AUTH_FAILED` / `PROTON_TOKEN_INVALID` |
| Proton 超时 | `PROTON_TIMEOUT` |

## Node.js 调用示例

下面示例展示如何生成安全封包并调用 Graph、IMAP、Proton 任一取件接口。

```js
const crypto = require('crypto');

const baseUrl = 'https://mail.dimosky.online';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
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
  const nonce = b64url(crypto.randomBytes(16));
  const timestamp = Date.now();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const ciphertext = b64url(Buffer.concat([encrypted, cipher.getAuthTag()]));
  const ivValue = b64url(iv);
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

async function postSecure(path, payload) {
  const envelope = await createSecureEnvelope(payload);
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function fetchOutlookByGraph() {
  return postSecure('/api/fetch-graph', {
    email: 'user@outlook.com',
    clientId: 'Microsoft OAuth Client ID',
    refreshToken: 'Microsoft refresh_token',
    keyword: '验证码',
    limit: 10,
  });
}

async function fetchOutlookByImap() {
  return postSecure('/api/fetch-imap', {
    email: 'user@hotmail.com',
    clientId: 'Microsoft OAuth Client ID',
    refreshToken: 'Microsoft refresh_token',
    keyword: '验证码',
    limit: 5,
  });
}

async function fetchProton() {
  return postSecure('/api/fetch-proton', {
    email: 'user@proton.me',
    password: 'Proton password',
    keyword: '验证码',
    limit: 10,
  });
}

fetchOutlookByGraph()
  .then(result => console.log(result.count, result.emails))
  .catch(console.error);
```

## 批量取件建议

后端接口是单账号、单协议粒度；批量取件由调用方并发调度即可。建议：

| 项 | 建议 |
| --- | --- |
| 并发数 | `2` 到 `3` |
| Graph `limit` | `10` 到 `20` |
| IMAP `limit` | `5` 到 `10` |
| Proton `limit` | `10` 到 `20` |
| 超时处理 | Proton 可能较慢，调用方建议设置 120 秒级别超时 |
| 成功判定 | 同一 Outlook 账号如果 Graph 或 IMAP 任一成功，就可认为该账号取件成功 |

账号、密码、refresh token、邮件正文不会写入 D1 统计库。D1 只记录站点取件次数、账号数量、取件类型和日期。
