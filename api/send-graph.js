/**
 * Graph API 发件接口
 * POST /api/send-graph
 *
 * 使用 Microsoft Graph sendMail 发送邮件
 */

const { refreshAccessToken } = require('./lib/token-helper');
const { normalizeSaveToSentItems, sendMailViaGraph } = require('./lib/send-graph-helper');
const { toPublicError } = require('./lib/error-helper');
const { unwrapSecureBody } = require('./lib/security-helper');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, protocol: 'graph', error: '仅支持 POST 请求' });
  }

  try {
    req.body = await unwrapSecureBody(req.body);
    const {
      email,
      clientId,
      refreshToken,
      accessToken,
      to,
      cc,
      bcc,
      replyTo,
      subject,
      text,
      html,
      body,
      importance,
      attachments,
      saveToSentItems,
    } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, protocol: 'graph', error: '缺少 email' });
    }

    let token = accessToken;
    if (!token) {
      if (!clientId || !refreshToken) {
        return res.status(400).json({ success: false, protocol: 'graph', error: '缺少 accessToken 或 clientId/refreshToken' });
      }
      const result = await refreshAccessToken(clientId, refreshToken, 'https://graph.microsoft.com/.default');
      token = result.accessToken;
    }

    const result = await sendMailViaGraph(token, {
      to,
      cc,
      bcc,
      replyTo,
      subject,
      text,
      html,
      body,
      importance,
      attachments,
      saveToSentItems,
    });

    return res.status(200).json({
      success: true,
      protocol: 'graph',
      from: email,
      status: result.status,
      accepted: result.accepted,
      savedToSentItems: normalizeSaveToSentItems(saveToSentItems),
    });
  } catch (err) {
    console.error('Graph 发件错误:', err);
    const publicError = toPublicError(err, 'graph');
    return res.status(err.statusCode || 200).json({
      success: false,
      protocol: 'graph',
      error: publicError.message,
      detail: publicError.detail,
    });
  }
};
