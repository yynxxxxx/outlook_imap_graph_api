const SESSION_TTL_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_VERSION = "v1";
const DEFAULT_GRAPH_FOLDERS = ["inbox", "junkemail"];
const GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
const tokenCache = new Map();
const usedNonces = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, pathname) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "仅支持 POST 请求" }, 405);
  }

  if (pathname === "/api/security-session") {
    return jsonResponse(await createSecuritySession(env));
  }

  if (pathname === "/api/fetch-imap") {
    return jsonResponse(
      {
        success: false,
        protocol: "imap",
        code: "IMAP_REQUIRES_CONTAINER",
        error: "Cloudflare Workers 免费运行时不支持当前 IMAP TCP/TLS 实现；请使用 Graph 或开通 Workers Paid 后部署 Containers 版",
        reason: "IMAP 需要连接 outlook.office365.com:993，普通 Worker 不能直接使用 imapflow 的 TCP/TLS 连接能力",
        action: "请使用默认 wrangler.toml 部署 Containers 版：npm run cf:deploy",
        emails: [],
      },
      501,
    );
  }

  let body = await readJsonBody(request);
  try {
    body = await unwrapSecureBody(body, env);

    if (pathname === "/api/refresh-token") {
      return await handleRefreshToken(body);
    }
    if (pathname === "/api/fetch-graph") {
      return await handleFetchGraph(body);
    }
    if (pathname === "/api/send-graph") {
      return await handleSendGraph(body);
    }

    return jsonResponse({ success: false, error: `API 路由 ${pathname} 不存在` }, 404);
  } catch (error) {
    const status = error.statusCode || (error.isSecurityError ? 403 : 500);
    const publicError = toPublicError(error);
    return jsonResponse({
      success: false,
      code: publicError.code,
      error: publicError.message,
      reason: publicError.reason,
      action: publicError.action,
      detail: publicError.detail,
    }, status);
  }
}

async function handleRefreshToken(body) {
  const { clientId, refreshToken } = body;
  if (!clientId || !refreshToken) {
    return jsonResponse({ error: "缺少 clientId 或 refreshToken" }, 400);
  }

  const result = await refreshAccessToken(clientId, refreshToken);
  return jsonResponse({
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
  });
}

async function handleFetchGraph(body) {
  const { email, clientId, refreshToken, accessToken, keyword, limit, sender, folder, folders } = body;
  if (!email) {
    return jsonResponse({ success: false, protocol: "graph", error: "缺少 email", emails: [] }, 400);
  }

  let token = accessToken;
  if (!token) {
    if (!clientId || !refreshToken) {
      return jsonResponse({ success: false, protocol: "graph", error: "缺少 accessToken 或 clientId/refreshToken", emails: [] }, 400);
    }
    const result = await refreshAccessToken(clientId, refreshToken, "https://graph.microsoft.com/.default");
    token = result.accessToken;
  }

  try {
    const emails = await fetchEmailsViaGraph(token, {
      keyword: keyword || "",
      limit: limit || 10,
      sender: sender || "",
      folder,
      folders,
    });
    return jsonResponse({ success: true, protocol: "graph", count: emails.length, emails });
  } catch (error) {
    const publicError = toPublicError(error, "graph");
    return jsonResponse({
      success: false,
      protocol: "graph",
      code: publicError.code,
      error: publicError.message,
      reason: publicError.reason,
      action: publicError.action,
      detail: publicError.detail,
      emails: [],
    }, error.statusCode || 200);
  }
}

async function handleSendGraph(body) {
  const { email, clientId, refreshToken, accessToken } = body;
  if (!email) {
    return jsonResponse({ success: false, protocol: "graph", error: "缺少 email" }, 400);
  }

  let token = accessToken;
  if (!token) {
    if (!clientId || !refreshToken) {
      return jsonResponse({ success: false, protocol: "graph", error: "缺少 accessToken 或 clientId/refreshToken" }, 400);
    }
    const result = await refreshAccessToken(clientId, refreshToken, "https://graph.microsoft.com/.default");
    token = result.accessToken;
  }

  try {
    const result = await sendMailViaGraph(token, body);
    return jsonResponse({
      success: true,
      protocol: "graph",
      from: email,
      status: result.status,
      accepted: result.accepted,
      savedToSentItems: normalizeSaveToSentItems(body.saveToSentItems),
    });
  } catch (error) {
    const publicError = toPublicError(error, "graph");
    return jsonResponse({
      success: false,
      protocol: "graph",
      code: publicError.code,
      error: publicError.message,
      reason: publicError.reason,
      action: publicError.action,
      detail: publicError.detail,
    }, error.statusCode || 200);
  }
}

async function refreshAccessToken(clientId, refreshToken, scope) {
  const cacheKey = await sha256Base64Url(`${clientId || ""}\n${refreshToken || ""}\n${scope || ""}`);
  const cached = getCachedAccessToken(cacheKey);
  if (cached) {
    return {
      accessToken: cached.accessToken,
      expiresIn: Math.max(0, Math.floor((cached.expiresAtMs - Date.now()) / 1000)),
      fromCache: true,
    };
  }

  const params = {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (scope) params.scope = scope;

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token 刷新失败: ${data.error || "unknown"} - ${data.error_description || JSON.stringify(data)}`);
  }

  setCachedAccessToken(cacheKey, data.access_token, data.expires_in);
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    newRefreshToken: data.refresh_token || null,
    fromCache: false,
  };
}

async function fetchEmailsViaGraph(accessToken, options = {}) {
  const { keyword = "", limit = 10, sender = "", folder, folders } = options;
  const targetFolders = normalizeFolderInput(folders || folder);
  const folderList = targetFolders.length > 0 ? targetFolders : DEFAULT_GRAPH_FOLDERS;
  const perFolderLimit = Math.max(limit, Math.ceil(limit / Math.max(folderList.length, 1)));
  const results = [];

  for (const targetFolder of folderList) {
    const folderEmails = await fetchEmailsFromGraphFolder(accessToken, targetFolder, {
      keyword,
      limit: perFolderLimit,
      sender,
    });
    results.push(...folderEmails);
  }

  return deduplicateAndLimit(results, limit);
}

async function fetchEmailsFromGraphFolder(accessToken, folder, options = {}) {
  const { keyword = "", limit = 10, sender = "" } = options;
  const params = new URLSearchParams();
  params.set("$select", "id,subject,from,receivedDateTime,bodyPreview,body,internetMessageId,hasAttachments");
  params.set("$top", String(Math.min(limit, 50)));
  params.set("$orderby", "receivedDateTime desc");
  if (keyword) params.set("$search", `"${keyword}"`);
  if (sender) params.set("$filter", `from/emailAddress/address eq '${sender}'`);

  const response = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages?${params}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Graph API 错误: ${data.error?.code || response.status} - ${data.error?.message || JSON.stringify(data)}`);
  }

  return (data.value || []).map((msg) => ({
    id: msg.internetMessageId || msg.id,
    messageId: msg.internetMessageId || msg.id,
    subject: msg.subject || "(无主题)",
    from: msg.from?.emailAddress?.address || "未知",
    fromName: msg.from?.emailAddress?.name || "",
    date: msg.receivedDateTime,
    bodyPreview: msg.bodyPreview || "",
    bodyHtml: msg.body?.contentType === "html" ? msg.body?.content : "",
    bodyText: msg.body?.contentType === "text" ? msg.body?.content : msg.bodyPreview,
    hasAttachments: msg.hasAttachments || false,
    folder,
    protocol: "graph",
  }));
}

async function sendMailViaGraph(accessToken, options = {}) {
  if (!accessToken) throw createStatusError("缺少 accessToken", 401);

  const response = await fetch(GRAPH_SEND_MAIL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendMailPayload(options)),
  });

  if (!response.ok) {
    const message = await readGraphError(response);
    throw createStatusError(`Graph 发件失败: ${message}`, response.status);
  }

  return { accepted: response.status === 202, status: response.status };
}

function buildSendMailPayload(options = {}) {
  const { to, cc, bcc, replyTo, subject = "", text, html, body, importance, attachments, saveToSentItems } = options;
  const bodyContent = html || text || body || "";
  if (!String(subject || "").trim()) throw createStatusError("缺少 subject", 400);
  if (!String(bodyContent || "").trim()) throw createStatusError("缺少邮件正文，请提供 text、html 或 body", 400);

  const message = {
    subject: String(subject),
    body: { contentType: html ? "HTML" : "Text", content: String(bodyContent) },
    toRecipients: normalizeAddressList(to, "to", true),
  };

  const ccRecipients = normalizeAddressList(cc, "cc");
  if (ccRecipients.length > 0) message.ccRecipients = ccRecipients;
  const bccRecipients = normalizeAddressList(bcc, "bcc");
  if (bccRecipients.length > 0) message.bccRecipients = bccRecipients;
  const replyToRecipients = normalizeAddressList(replyTo, "replyTo");
  if (replyToRecipients.length > 0) message.replyTo = replyToRecipients;
  const fileAttachments = normalizeAttachments(attachments);
  if (fileAttachments.length > 0) message.attachments = fileAttachments;

  if (importance) {
    const normalizedImportance = String(importance).toLowerCase();
    if (!["low", "normal", "high"].includes(normalizedImportance)) throw createStatusError("importance 仅支持 low、normal、high", 400);
    message.importance = normalizedImportance;
  }

  const payload = { message };
  if (normalizeSaveToSentItems(saveToSentItems) === false) payload.saveToSentItems = false;
  return payload;
}

async function createSecuritySession(env) {
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const sessionKey = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAtMs = now + SESSION_TTL_MS;
  const sessionToken = await encryptSessionToken({ sessionId, sessionKey, expiresAtMs }, env);

  return {
    success: true,
    sessionId,
    sessionKey,
    sessionToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

async function unwrapSecureBody(body, env) {
  if (!body || body.secure !== true) throw createSecurityError("请求缺少安全签名，请刷新页面重试");

  const { sessionId, sessionToken, nonce, timestamp, iv, ciphertext, signature } = body;
  if (!sessionId || !sessionToken || !nonce || !timestamp || !iv || !ciphertext || !signature) {
    throw createSecurityError("安全请求参数不完整");
  }

  const now = Date.now();
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > REQUEST_WINDOW_MS) {
    throw createSecurityError("请求已过期，请重新取件");
  }

  const session = await decryptSessionToken(sessionToken, env);
  if (session.sessionId !== sessionId) throw createSecurityError("安全会话不匹配，请刷新页面重试");
  if (!session.expiresAtMs || session.expiresAtMs <= now) throw createSecurityError("安全会话已过期，请刷新页面重试");

  cleanupNonces(now);
  const nonceKey = `${sessionId}:${nonce}`;
  if (usedNonces.has(nonceKey)) throw createSecurityError("重复请求已拦截，请重新取件", 409);
  usedNonces.set(nonceKey, now + NONCE_TTL_MS);

  const keyBytes = base64UrlToBytes(session.sessionKey);
  const signedText = `${sessionId}.${nonce}.${timestamp}.${iv}.${ciphertext}`;
  const expectedSignature = await hmacBase64Url(keyBytes, signedText);
  if (!timingSafeEqualText(signature, expectedSignature)) throw createSecurityError("请求签名校验失败");

  return decryptJsonPayload(keyBytes, iv, ciphertext);
}

async function encryptSessionToken(payload, env) {
  const key = await getTokenKey(env);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, key, plaintext);
  return [TOKEN_VERSION, bytesToBase64Url(ivBytes), bytesToBase64Url(new Uint8Array(encrypted))].join(".");
}

async function decryptSessionToken(token, env) {
  const [version, ivValue, ciphertextValue] = String(token || "").split(".");
  if (version !== TOKEN_VERSION || !ivValue || !ciphertextValue) throw createSecurityError("安全会话无效，请刷新页面重试");

  try {
    const key = await getTokenKey(env);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivValue) },
      key,
      base64UrlToBytes(ciphertextValue),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw createSecurityError("安全会话校验失败，请刷新页面重试");
  }
}

async function decryptJsonPayload(keyBytes, ivValue, ciphertextValue) {
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivValue) },
      key,
      base64UrlToBytes(ciphertextValue),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw createSecurityError("加密请求体解密失败，请刷新页面重试");
  }
}

async function getTokenKey(env) {
  const secret = env.API_SECURITY_SECRET || "outlook-imap-graph-api-worker-fallback-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function getCachedAccessToken(cacheKey) {
  const cached = tokenCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now() + 5 * 60 * 1000) {
    tokenCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function setCachedAccessToken(cacheKey, accessToken, expiresIn) {
  if (!accessToken) return;
  const ttlMs = Math.max(0, Math.min(Number(expiresIn || 0) * 1000, 55 * 60 * 1000));
  if (ttlMs <= 5 * 60 * 1000) return;
  tokenCache.set(cacheKey, { accessToken, expiresAtMs: Date.now() + ttlMs });
}

function cleanupNonces(now = Date.now()) {
  for (const [key, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) usedNonces.delete(key);
  }
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeFolderInput(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function deduplicateAndLimit(emails, limit) {
  const seen = new Map();
  emails
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach((email) => {
      const key = email.messageId || `${email.subject}-${email.date}-${email.folder || ""}`;
      if (!seen.has(key)) seen.set(key, email);
    });
  return Array.from(seen.values()).slice(0, limit);
}

function normalizeAddressList(value, fieldName, required = false) {
  let values;
  if (Array.isArray(value)) values = value;
  else if (value && typeof value === "object") values = [value];
  else values = String(value || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean);

  if (required && values.length === 0) throw createStatusError(`缺少 ${fieldName}`, 400);
  return values.map((item) => normalizeRecipient(item, fieldName));
}

function normalizeRecipient(item, fieldName) {
  if (typeof item === "string") return toRecipient(item.trim(), "");
  if (!item || typeof item !== "object") throw createStatusError(`${fieldName} 格式无效`, 400);
  if (item.emailAddress && typeof item.emailAddress === "object") return toRecipient(item.emailAddress.address, item.emailAddress.name);
  return toRecipient(item.address || item.email || item.mail, item.name || "");
}

function toRecipient(address, name = "") {
  const parsed = parseAddressWithName(address, name);
  if (!parsed.address || !parsed.address.includes("@")) throw createStatusError(`收件人邮箱格式无效: ${parsed.address || "(空)"}`, 400);
  const emailAddress = { address: parsed.address };
  if (parsed.name) emailAddress.name = parsed.name;
  return { emailAddress };
}

function parseAddressWithName(address, name = "") {
  const rawAddress = String(address || "").trim();
  const rawName = String(name || "").trim();
  const angleMatch = rawAddress.match(/^(.*?)<([^<>]+)>$/);
  if (!rawName && angleMatch) {
    return { name: angleMatch[1].replace(/^"|"$/g, "").trim(), address: angleMatch[2].trim() };
  }
  return { name: rawName, address: rawAddress };
}

function normalizeAttachments(attachments) {
  if (!attachments) return [];
  if (!Array.isArray(attachments)) throw createStatusError("attachments 必须是数组", 400);
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") throw createStatusError(`第 ${index + 1} 个附件格式无效`, 400);
    const name = String(attachment.name || "").trim();
    const contentBytes = String(attachment.contentBytes || attachment.base64 || "").trim();
    if (!name || !contentBytes) throw createStatusError(`第 ${index + 1} 个附件缺少 name 或 contentBytes`, 400);
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name,
      contentType: attachment.contentType || "application/octet-stream",
      contentBytes,
    };
  });
}

function normalizeSaveToSentItems(value) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no"].includes(String(value).trim().toLowerCase());
}

async function readGraphError(response) {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const data = JSON.parse(text);
    return `${data.error?.code || response.status} - ${data.error?.message || text}`;
  } catch {
    return text;
  }
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hmacBase64Url(keyBytes, value) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqualText(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getRawErrorDetail(err) {
  const parts = [
    err?.message || err || "未知错误",
    err?.responseText ? `IMAP response: ${err.responseText}` : "",
    err?.responseStatus ? `IMAP status: ${err.responseStatus}` : "",
    err?.executedCommand ? `IMAP command: ${err.executedCommand}` : "",
  ];
  return normalizeWhitespace(parts.filter(Boolean).join(" | "));
}

function toPublicError(err, protocol = "") {
  const raw = getRawErrorDetail(err);
  const lower = raw.toLowerCase();
  const normalizedProtocol = String(protocol || "").toLowerCase();
  let message = raw;
  let code = "UNKNOWN_ERROR";
  let reason = "服务端返回了未分类错误";
  let action = "请查看 detail，若持续出现请记录触发账号和协议后排查服务日志";

  if (lower.includes("invalid_grant")) {
    code = "TOKEN_EXPIRED_OR_REVOKED";
    message = "刷新令牌无效或已过期，请重新获取 refresh_token";
    reason = "Microsoft 拒绝刷新令牌，常见原因是 refresh_token 过期、被撤销、账号改密或授权被取消";
    action = "请重新授权账号并导入新的 refresh_token";
  } else if (lower.includes("invalid_client")) {
    code = "INVALID_CLIENT_ID";
    message = "client_id 无效，请检查导入的 clientid";
    reason = "Microsoft 不认可当前 client_id，可能是复制错误或应用配置不匹配";
    action = "请核对导入行里的 clientid 是否属于该 Outlook 授权应用";
  } else if (lower.includes("interaction_required") || lower.includes("consent_required")) {
    code = "AUTHORIZATION_REQUIRED";
    message = "账号需要重新授权或补充权限";
    reason = "账号授权状态不足，Microsoft 要求用户交互确认或补充 consent";
    action = "请重新走授权流程，并确认包含取件/发件需要的权限";
  } else if (lower.includes("ethrottle") || lower.includes("request is throttled") || lower.includes("backoff time")) {
    code = "IMAP_RATE_LIMITED";
    message = "IMAP 被 Microsoft 限流，请稍后重试";
    reason = "Outlook IMAP 返回了限流或退避提示，通常是短时间批量账号/批量命令过多";
    action = "请降低批量取件数量或间隔后重试；Graph 成功的账号可以忽略 IMAP 失败";
  } else if (lower.includes("command failed") && normalizedProtocol === "imap") {
    code = "IMAP_COMMAND_REJECTED";
    message = "IMAP 命令被 Outlook 服务器拒绝";
    reason = "服务器返回 NO/BAD，常见原因是账号未启用 IMAP、令牌缺少 IMAP 权限、邮箱文件夹不可访问或 IMAP 临时限制";
    action = "如果 Graph 已成功取件可以忽略；如果需要 IMAP，请确认账号开启 IMAP 并重新授权包含 IMAP.AccessAsUser.All 的 refresh_token";
  } else if (lower.includes("mailboxnotenabledforrestapi") || lower.includes("errorinvaliduser")) {
    code = "GRAPH_MAILBOX_UNAVAILABLE";
    message = "Graph 无法访问该邮箱，请检查账号类型或权限";
    reason = "Graph 端认为该账号不是可访问的 Exchange/Outlook 邮箱，或当前令牌无法访问邮箱";
    action = "请确认账号类型支持 Graph 邮件接口，并重新授权 Mail.Read 权限";
  } else if (lower.includes("erroraccessdenied") || lower.includes("access is denied")) {
    code = "GRAPH_ACCESS_DENIED";
    message = normalizedProtocol === "graph" ? "Graph 权限不足，请检查应用是否已授权所需权限" : "权限不足，请检查应用授权范围";
    reason = "Microsoft 返回访问拒绝，当前 access token 缺少对应接口权限";
    action = "取件请确认 Mail.Read，发件请确认 Mail.Send；更新权限后重新授权 refresh_token";
  } else if (lower.includes("too many requests") || lower.includes("429")) {
    code = "RATE_LIMITED";
    message = "Microsoft 接口限流，请稍后重试";
    reason = "短时间请求过多或账号/API 被 Microsoft 限流";
    action = "请降低并发和取件数量，等待一段时间后重试";
  } else if (lower.includes("安全") || lower.includes("签名") || lower.includes("nonce") || lower.includes("加密")) {
    code = "SECURITY_ENVELOPE_INVALID";
    reason = "请求安全封包校验失败，可能是页面会话过期、重复提交或请求被篡改";
    action = "请刷新页面后重试";
  } else if (raw.length > 180) {
    message = `${raw.slice(0, 180)}...`;
  }

  return { code, message: protocol ? `${protocol.toUpperCase()}: ${message}` : message, reason, action, detail: raw };
}

function createSecurityError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isSecurityError = true;
  return error;
}

function createStatusError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
