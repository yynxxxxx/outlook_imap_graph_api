/**
 * IMAP OAuth2 取件接口
 * POST /api/fetch-imap
 * 
 * 使用 IMAP + XOAUTH2 获取邮件
 */

const { refreshAccessToken } = require('./lib/token-helper');
const { fetchEmailsViaIMAP } = require('./lib/imap-helper');
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
    const { email, clientId, refreshToken, accessToken, keyword, limit, sender, folder, folders } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, protocol: 'imap', error: '缺少 email', emails: [] });
    }

    // 如果没有提供 accessToken，则使用 refreshToken 刷新
    let token = accessToken;
    if (!token) {
      if (!clientId || !refreshToken) {
        return res.status(400).json({ success: false, protocol: 'imap', error: '缺少 accessToken 或 clientId/refreshToken', emails: [] });
      }
      const result = await refreshAccessToken(clientId, refreshToken);
      token = result.accessToken;
    }

    // 获取邮件（限制数量，适配 10s 超时）
    const emails = await fetchEmailsViaIMAP(email, token, {
      keyword: keyword || '',
      limit: Math.min(limit || 5, 10), // 最多10封，建议5封
      folder,
      folders,
      sender: sender || '',
    });

    return res.status(200).json({
      success: true,
      protocol: 'imap',
      count: emails.length,
      emails,
    });
  } catch (err) {
    console.error('IMAP 取件错误:', err);
    const publicError = toPublicError(err, 'imap');
    return res.status(err.statusCode || 200).json({
      success: false,
      protocol: 'imap',
      code: publicError.code,
      error: publicError.message,
      reason: publicError.reason,
      action: publicError.action,
      detail: publicError.detail,
      emails: [],
    });
  }
};
