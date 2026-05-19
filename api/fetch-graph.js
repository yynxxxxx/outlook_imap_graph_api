/**
 * Graph API 取件接口
 * POST /api/fetch-graph
 * 
 * 使用 Graph API 获取邮件
 */

const { refreshAccessToken } = require('./lib/token-helper');
const { fetchEmailsViaGraph } = require('./lib/graph-helper');
const { toPublicError } = require('./lib/error-helper');

module.exports = async function handler(req, res) {
  // CORS 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  try {
    const { email, clientId, refreshToken, accessToken, keyword, limit, sender } = req.body;

    if (!email) {
      return res.status(400).json({ error: '缺少 email' });
    }

    // 如果没有提供 accessToken，则使用 refreshToken 刷新
    let token = accessToken;
    if (!token) {
      if (!clientId || !refreshToken) {
        return res.status(400).json({ error: '缺少 accessToken 或 clientId/refreshToken' });
      }
      const result = await refreshAccessToken(clientId, refreshToken, 'https://graph.microsoft.com/.default');
      token = result.accessToken;
    }

    // 获取邮件
    const emails = await fetchEmailsViaGraph(token, {
      keyword: keyword || '',
      limit: limit || 10,
      sender: sender || '',
    });

    return res.status(200).json({
      success: true,
      protocol: 'graph',
      count: emails.length,
      emails,
    });
  } catch (err) {
    console.error('Graph 取件错误:', err);
    const publicError = toPublicError(err, 'graph');
    return res.status(200).json({
      success: false,
      protocol: 'graph',
      error: publicError.message,
      detail: publicError.detail,
      emails: [],
    });
  }
};
