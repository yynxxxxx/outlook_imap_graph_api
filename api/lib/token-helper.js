/**
 * Token 刷新工具
 * 使用 refresh_token 向 Microsoft OAuth2 端点获取 access_token
 * IMAP: 不带 scope（使用原始授权的权限）
 * Graph: 带 scope（必须获取 JWT 格式的 token）
 */

/**
 * 刷新 access_token
 * @param {string} clientId - 应用的 Client ID
 * @param {string} refreshToken - 刷新令牌
 * @param {string} [scope] - 可选 scope，Graph API 需要传入
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function refreshAccessToken(clientId, refreshToken, scope) {
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

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    newRefreshToken: data.refresh_token || null,
  };
}

module.exports = { refreshAccessToken };
