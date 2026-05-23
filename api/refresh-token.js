/**
 * Token 刷新 API
 * POST /api/refresh-token
 * 
 * 接收 clientId 和 refreshToken，返回 accessToken
 * 支持同时获取 IMAP 和 Graph 两种 scope 的 token
 */

const { refreshAccessToken } = require('./lib/token-helper');
const { toPublicError } = require('./lib/error-helper');
const { unwrapSecureBody } = require('./lib/security-helper');

module.exports = async function handler(req, res) {
  // CORS 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  try {
    req.body = await unwrapSecureBody(req.body);
    const { clientId, refreshToken } = req.body;

    if (!clientId || !refreshToken) {
      return res.status(400).json({ error: '缺少 clientId 或 refreshToken' });
    }

    const result = await refreshAccessToken(clientId, refreshToken);

    return res.status(200).json({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  } catch (err) {
    console.error('Token 刷新错误:', err);
    const publicError = toPublicError(err, 'token');
    return res.status(err.statusCode || 500).json({ success: false, error: publicError.message, detail: publicError.detail });
  }
};
