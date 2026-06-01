function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toPublicError(err, protocol = '') {
  const raw = normalizeWhitespace(err?.message || err || '未知错误');
  const lower = raw.toLowerCase();

  let message = raw;

  if (lower.includes('invalid_grant')) {
    message = '刷新令牌无效或已过期，请重新获取 refresh_token';
  } else if (lower.includes('invalid_client')) {
    message = 'client_id 无效，请检查导入的 clientid';
  } else if (lower.includes('interaction_required') || lower.includes('consent_required')) {
    message = '账号需要重新授权或补充权限';
  } else if (
    lower.includes('authenticate') ||
    lower.includes('authentication failed') ||
    lower.includes('invalid credentials')
  ) {
    message = 'IMAP 认证失败，请检查账号权限和令牌 scope';
  } else if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('esockettimedout')) {
    message = '连接超时，请稍后重试或降低取件数量';
  } else if (lower.includes('mailboxnotenabledforrestapi') || lower.includes('errorinvaliduser')) {
    message = 'Graph 无法访问该邮箱，请检查账号类型或权限';
  } else if (lower.includes('erroraccessdenied') || lower.includes('access is denied')) {
    message = 'Graph 权限不足，请检查应用是否已授权 Mail.Send 等所需权限';
  } else if (raw.length > 180) {
    message = `${raw.slice(0, 180)}...`;
  }

  return {
    message: protocol ? `${protocol.toUpperCase()}: ${message}` : message,
    detail: raw,
  };
}

module.exports = { toPublicError };
