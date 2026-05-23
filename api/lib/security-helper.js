const crypto = require('crypto');

const SESSION_TTL_MS = Number(process.env.SECURITY_SESSION_TTL_MS || 10 * 60 * 1000);
const REQUEST_WINDOW_MS = Number(process.env.SECURITY_REQUEST_WINDOW_MS || 2 * 60 * 1000);
const NONCE_TTL_MS = Number(process.env.SECURITY_NONCE_TTL_MS || 10 * 60 * 1000);
const TOKEN_VERSION = 'v1';

const runtimeSecret = crypto.randomBytes(32).toString('base64url');
const secretMaterial = process.env.API_SECURITY_SECRET || process.env.VERCEL_GIT_COMMIT_SHA || runtimeSecret;
const tokenKey = crypto.createHash('sha256').update(secretMaterial).digest();
const usedNonces = new Map();

function createSecurityError(message, statusCode = 403) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isSecurityError = true;
  return err;
}

function cleanupNonces(now = Date.now()) {
  for (const [key, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) {
      usedNonces.delete(key);
    }
  }
}

function encryptToken(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    TOKEN_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function decryptToken(token) {
  const [version, ivValue, ciphertextValue, tagValue] = String(token || '').split('.');
  if (version !== TOKEN_VERSION || !ivValue || !ciphertextValue || !tagValue) {
    throw createSecurityError('安全会话无效，请刷新页面重试');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw createSecurityError('安全会话校验失败，请刷新页面重试');
  }
}

function signRequest(keyBytes, signedText) {
  return crypto.createHmac('sha256', keyBytes).update(signedText).digest('base64url');
}

function timingSafeEqualText(a, b) {
  const aBuffer = Buffer.from(String(a || ''), 'base64url');
  const bBuffer = Buffer.from(String(b || ''), 'base64url');
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function decryptPayload(keyBytes, ivValue, ciphertextValue) {
  const encrypted = Buffer.from(String(ciphertextValue || ''), 'base64url');
  if (encrypted.length <= 16) {
    throw createSecurityError('加密请求体无效');
  }

  try {
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(String(ivValue || ''), 'base64url'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw createSecurityError('加密请求体解密失败，请刷新页面重试');
  }
}

function createSecuritySession() {
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const sessionKey = crypto.randomBytes(32).toString('base64url');
  const expiresAtMs = now + SESSION_TTL_MS;
  const sessionToken = encryptToken({
    sessionId,
    sessionKey,
    expiresAtMs,
  });

  return {
    success: true,
    sessionId,
    sessionKey,
    sessionToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

async function unwrapSecureBody(body) {
  if (!body || body.secure !== true) {
    throw createSecurityError('请求缺少安全签名，请刷新页面重试');
  }

  const {
    sessionId,
    sessionToken,
    nonce,
    timestamp,
    iv,
    ciphertext,
    signature,
  } = body;

  if (!sessionId || !sessionToken || !nonce || !timestamp || !iv || !ciphertext || !signature) {
    throw createSecurityError('安全请求参数不完整');
  }

  const now = Date.now();
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > REQUEST_WINDOW_MS) {
    throw createSecurityError('请求已过期，请重新取件');
  }

  const session = decryptToken(sessionToken);
  if (session.sessionId !== sessionId) {
    throw createSecurityError('安全会话不匹配，请刷新页面重试');
  }
  if (!session.expiresAtMs || session.expiresAtMs <= now) {
    throw createSecurityError('安全会话已过期，请刷新页面重试');
  }

  cleanupNonces(now);
  const nonceKey = `${sessionId}:${nonce}`;
  if (usedNonces.has(nonceKey)) {
    throw createSecurityError('重复请求已拦截，请重新取件', 409);
  }
  usedNonces.set(nonceKey, now + NONCE_TTL_MS);

  const keyBytes = Buffer.from(session.sessionKey, 'base64url');
  const signedText = `${sessionId}.${nonce}.${timestamp}.${iv}.${ciphertext}`;
  const expectedSignature = signRequest(keyBytes, signedText);
  if (!timingSafeEqualText(signature, expectedSignature)) {
    throw createSecurityError('请求签名校验失败');
  }

  return decryptPayload(keyBytes, iv, ciphertext);
}

module.exports = {
  createSecurityError,
  createSecuritySession,
  unwrapSecureBody,
};
