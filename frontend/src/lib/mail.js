export const APP_VERSION = '1.3.1';

const STORAGE_KEY = 'outlook_accounts';
const SECURITY_RETRY_LIMIT = 1;
const OUTLOOK_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];
const PROTON_DOMAINS = ['proton.me', 'protonmail.com', 'pm.me', 'protonmail.ch'];

let apiSecuritySession = null;

export function readAccounts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function persistAccounts(accounts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

export function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  return accounts.map((account, index) => ({
    ...account,
    id: account.id || createId(),
    email: String(account.email || '').trim(),
    provider: account.provider || detectProvider(account),
    importIndex: Number.isFinite(account.importIndex) ? account.importIndex : index,
  })).filter(account => account.email.includes('@'));
}

export function parseImportText(text) {
  const accounts = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = splitImportLine(raw);
    const email = parts[0]?.trim();
    if (!email || !email.includes('@')) {
      errors.push(`第 ${index + 1} 行邮箱无效`);
      return;
    }
    const provider = detectProvider({ email });
    if (provider === 'proton') {
      if (!parts[1]) {
        errors.push(`第 ${index + 1} 行缺少 Proton 密码`);
        return;
      }
      accounts.push({
        id: createId(),
        email,
        password: parts[1]?.trim() || '',
        uid: parts[2]?.trim() || '',
        refreshToken: parts.slice(3).join('----').trim(),
        provider,
        importIndex: index,
        addedAt: new Date().toISOString(),
      });
      return;
    }
    if (parts.length < 4 || !parts[2] || !parts[3]) {
      errors.push(`第 ${index + 1} 行缺少 clientid 或 refresh_token`);
      return;
    }
    accounts.push({
      id: createId(),
      email,
      password: parts[1]?.trim() || '',
      clientId: parts[2]?.trim() || '',
      refreshToken: parts.slice(3).join('----').trim(),
      provider,
      importIndex: index,
      addedAt: new Date().toISOString(),
    });
  });
  return { accounts, errors };
}

export function formatAccountForExport(account) {
  if (detectProvider(account) === 'proton') {
    return [account.email, account.password || '', account.uid || '', account.refreshToken || ''].join('----');
  }
  return [account.email, account.password || '', account.clientId || '', account.refreshToken || ''].join('----');
}

export function detectProvider(account) {
  const domain = String(account?.email || '').split('@').pop()?.toLowerCase() || '';
  if (PROTON_DOMAINS.includes(domain)) return 'proton';
  if (OUTLOOK_DOMAINS.includes(domain)) return 'outlook';
  return account?.provider || 'outlook';
}

export function enabledProtocolsForAccount(account, toggles) {
  return detectProvider(account) === 'proton'
    ? (toggles.proton ? ['proton'] : [])
    : ['graph', 'imap'].filter(protocol => toggles[protocol]);
}

export async function secureApiFetch(url, payload, retryCount = 0) {
  const envelope = await createSecureEnvelope(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if ((response.status === 401 || response.status === 403) && retryCount < SECURITY_RETRY_LIMIT) {
    apiSecuritySession = null;
    return secureApiFetch(url, payload, retryCount + 1);
  }
  return response;
}

export async function parseFetchResponse(response, protocol) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { success: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok && data.success !== false) data.success = false;
  if (!data.success) {
    const error = new Error(data.error || `${protocolLabel(protocol)} 取件失败`);
    error.code = data.code;
    error.reason = data.reason;
    error.action = data.action;
    error.detail = data.detail;
    throw error;
  }
  return data;
}

export function normalizeFetchError(email, protocol, error) {
  const raw = error?.message || String(error || '未知错误');
  return {
    email,
    protocol,
    code: error?.code || '',
    error: simplifyError(raw),
    reason: error?.reason || '',
    action: error?.action || '',
    raw: error?.detail || raw,
  };
}

export function normalizeSessionPatch(session) {
  if (!session) return null;
  const patch = {
    uid: session.uid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    scope: session.scope,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export function extractHighlights(emails) {
  const codeSeen = new Set();
  const linkSeen = new Set();
  const codes = [];
  const links = [];
  emails.forEach(email => {
    const text = `${email.subject || ''}\n${email.bodyPreview || ''}\n${email.bodyText || ''}`;
    const codeMatches = text.match(/\b\d{4,8}\b/g) || [];
    codeMatches.forEach(value => {
      const key = `${email._account}:${value}`;
      if (!codeSeen.has(key)) {
        codeSeen.add(key);
        codes.push({ key: `code:${key}`, type: 'code', value, email });
      }
    });
    const linkMatches = text.match(/https?:\/\/[^\s<>"')]+/g) || [];
    linkMatches.forEach(value => {
      const clean = value.replace(/[.,;!?，。；！？]+$/, '');
      const key = `${email._account}:${clean}`;
      if (!linkSeen.has(key)) {
        linkSeen.add(key);
        links.push({ key: `link:${key}`, type: 'link', value: clean, email });
      }
    });
  });
  return { codes: codes.slice(0, 80), links: links.slice(0, 80) };
}

export function deduplicateEmails(emails) {
  const seen = new Map();
  emails.forEach(email => {
    const key = email.messageId || `${email.subject}-${email.date}-${email.protocol}`;
    if (!seen.has(key) || email.protocol === 'graph') seen.set(key, email);
  });
  return Array.from(seen.values());
}

export async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function copyText(text, successMessage, onToast) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    onToast?.(successMessage, 'success');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    onToast?.(successMessage, 'success');
  }
}

export function protocolLabel(protocol) {
  return protocol === 'graph' ? 'Graph' : protocol === 'imap' ? 'IMAP' : 'Proton';
}

export function providerLabel(provider) {
  return provider === 'proton' ? 'Proton' : 'Outlook';
}

export function formatDate(value, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return full
    ? date.toLocaleString('zh-CN', { hour12: false })
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  const diffMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function formatFolderName(folder) {
  const value = String(folder || '');
  const lower = value.toLowerCase();
  if (lower === 'inbox' || lower === '0') return '收件箱';
  if (lower.includes('junk') || lower.includes('spam') || value.includes('垃圾')) return '垃圾邮件';
  return value || '邮箱';
}

function splitImportLine(raw) {
  for (const sep of ['----', '---', '--']) {
    if (raw.includes(sep)) return raw.split(sep).map(item => item.trim());
  }
  return raw.split(/\s+/).map(item => item.trim());
}

async function createSecureEnvelope(payload) {
  if (!crypto?.subtle) throw new Error('当前浏览器不支持安全请求加密');
  const session = await getApiSecuritySession();
  const keyBytes = base64UrlToBytes(session.sessionKey);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const hmacKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const timestamp = Date.now();
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, plaintext);
  const iv = bytesToBase64Url(ivBytes);
  const ciphertext = bytesToBase64Url(new Uint8Array(encrypted));
  const signedText = `${session.sessionId}.${nonce}.${timestamp}.${iv}.${ciphertext}`;
  const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signedText));
  return {
    secure: true,
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    nonce,
    timestamp,
    iv,
    ciphertext,
    signature: bytesToBase64Url(new Uint8Array(signature)),
  };
}

async function getApiSecuritySession() {
  const now = Date.now();
  if (apiSecuritySession && apiSecuritySession.expiresAtMs - now > 60000) return apiSecuritySession;
  const response = await fetch('/api/security-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || '安全会话初始化失败');
  apiSecuritySession = {
    sessionId: data.sessionId,
    sessionToken: data.sessionToken,
    sessionKey: data.sessionKey,
    expiresAtMs: new Date(data.expiresAt).getTime(),
  };
  return apiSecuritySession;
}

function simplifyError(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/Command failed/i.test(text)) return text;
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
