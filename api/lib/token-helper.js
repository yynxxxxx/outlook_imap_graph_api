/**
 * Token 刷新工具
 * 使用 refresh_token 向 Microsoft OAuth2 端点获取 access_token
 * IMAP: 不带 scope（使用原始授权的权限）
 * Graph: 带 scope（必须获取 JWT 格式的 token）
 */

const crypto = require('crypto');

const TOKEN_CACHE_ENABLED = process.env.TOKEN_CACHE_ENABLED !== 'false';
const TOKEN_CACHE_SAFETY_MS = Number(process.env.TOKEN_CACHE_SAFETY_MS || 5 * 60 * 1000);
const TOKEN_CACHE_MAX_TTL_MS = Number(process.env.TOKEN_CACHE_MAX_TTL_MS || 55 * 60 * 1000);
const TOKEN_CACHE_MAX_ENTRIES = Number(process.env.TOKEN_CACHE_MAX_ENTRIES || 2000);
const tokenCache = new Map();

/**
 * 刷新 access_token
 * @param {string} clientId - 应用的 Client ID
 * @param {string} refreshToken - 刷新令牌
 * @param {string} [scope] - 可选 scope，Graph API 需要传入
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function refreshAccessToken(clientId, refreshToken, scope) {
  const cacheKey = createTokenCacheKey(clientId, refreshToken, scope);
  const cached = getCachedAccessToken(cacheKey);
  if (cached) {
    return {
      accessToken: cached.accessToken,
      expiresIn: Math.max(0, Math.floor((cached.expiresAtMs - Date.now()) / 1000)),
      fromCache: true,
    };
  }

  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const params = {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };

  // 仅在传入 scope 时添加
  if (scope) {
    params.scope = scope;
  }

  const body = new URLSearchParams(params);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Token 刷新失败: ${data.error || 'unknown'} - ${data.error_description || JSON.stringify(data)}`
    );
  }

  const result = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    newRefreshToken: data.refresh_token || null,
    fromCache: false,
  };

  setCachedAccessToken(cacheKey, result.accessToken, result.expiresIn);
  return result;
}

function createTokenCacheKey(clientId, refreshToken, scope = '') {
  return crypto
    .createHash('sha256')
    .update(`${clientId || ''}\n${refreshToken || ''}\n${scope || ''}`)
    .digest('base64url');
}

function getCachedAccessToken(cacheKey) {
  if (!TOKEN_CACHE_ENABLED) return null;

  const cached = tokenCache.get(cacheKey);
  if (!cached) return null;

  if (cached.expiresAtMs <= Date.now() + TOKEN_CACHE_SAFETY_MS) {
    tokenCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function setCachedAccessToken(cacheKey, accessToken, expiresIn) {
  if (!TOKEN_CACHE_ENABLED || !accessToken) return;

  const ttlMs = Math.max(0, Math.min(Number(expiresIn || 0) * 1000, TOKEN_CACHE_MAX_TTL_MS));
  if (ttlMs <= TOKEN_CACHE_SAFETY_MS) return;

  pruneTokenCache();
  tokenCache.set(cacheKey, {
    accessToken,
    expiresAtMs: Date.now() + ttlMs,
  });
}

function pruneTokenCache() {
  const now = Date.now();
  for (const [key, value] of tokenCache.entries()) {
    if (value.expiresAtMs <= now + TOKEN_CACHE_SAFETY_MS) {
      tokenCache.delete(key);
    }
  }

  while (tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (!oldestKey) break;
    tokenCache.delete(oldestKey);
  }
}

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  clearTokenCache,
  refreshAccessToken,
};
