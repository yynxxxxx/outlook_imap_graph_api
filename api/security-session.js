/**
 * Security session bootstrap.
 * POST /api/security-session
 */

const { createSecuritySession } = require('./lib/security-helper');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '仅支持 POST 请求' });
  }

  return res.status(200).json(createSecuritySession());
};
