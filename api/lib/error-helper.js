function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toPublicError(err, protocol = '') {
  const raw = normalizeWhitespace(err?.message || err || '未知错误');
  const lower = raw.toLowerCase();
  const normalizedProtocol = String(protocol || '').toLowerCase();

  let message = raw;
  let code = 'UNKNOWN_ERROR';
  let reason = '服务端返回了未分类错误';
  let action = '请查看 detail，若持续出现请记录触发账号和协议后排查服务日志';

  if (lower.includes('invalid_grant')) {
    code = 'TOKEN_EXPIRED_OR_REVOKED';
    message = '刷新令牌无效或已过期，请重新获取 refresh_token';
    reason = 'Microsoft 拒绝刷新令牌，常见原因是 refresh_token 过期、被撤销、账号改密或授权被取消';
    action = '请重新授权账号并导入新的 refresh_token';
  } else if (lower.includes('invalid_client')) {
    code = 'INVALID_CLIENT_ID';
    message = 'client_id 无效，请检查导入的 clientid';
    reason = 'Microsoft 不认可当前 client_id，可能是复制错误或应用配置不匹配';
    action = '请核对导入行里的 clientid 是否属于该 Outlook 授权应用';
  } else if (lower.includes('interaction_required') || lower.includes('consent_required')) {
    code = 'AUTHORIZATION_REQUIRED';
    message = '账号需要重新授权或补充权限';
    reason = '账号授权状态不足，Microsoft 要求用户交互确认或补充 consent';
    action = '请重新走授权流程，并确认包含取件/发件需要的权限';
  } else if (
    lower.includes('authenticate') ||
    lower.includes('authentication failed') ||
    lower.includes('invalid credentials') ||
    lower.includes('auth=') ||
    lower.includes('no authenticate failed')
  ) {
    code = 'IMAP_AUTH_FAILED';
    message = 'IMAP 认证失败，请检查账号权限和令牌 scope';
    reason = 'IMAP 服务器拒绝 XOAUTH2 登录，常见原因是令牌没有 IMAP.AccessAsUser.All 权限、账号未启用 IMAP 或令牌已失效';
    action = '请确认 Outlook 账号已启用 IMAP，并重新授权包含 IMAP 权限的 refresh_token';
  } else if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('esockettimedout')) {
    code = 'UPSTREAM_TIMEOUT';
    message = '连接超时，请稍后重试或降低取件数量';
    reason = '连接 Microsoft 服务或读取邮箱时超时';
    action = '请降低取件数量，稍后重试；如果只在 IMAP 出现，请优先使用更小 limit';
  } else if (lower.includes('econnreset') || lower.includes('socket') || lower.includes('network')) {
    code = 'UPSTREAM_NETWORK_ERROR';
    message = '连接 Microsoft 服务失败，请稍后重试';
    reason = '到 Microsoft 服务的网络连接被中断或不可达';
    action = '请稍后重试；若持续出现，请检查 Cloudflare 容器出站网络和 Microsoft 服务状态';
  } else if (lower.includes('mailboxnotenabledforrestapi') || lower.includes('errorinvaliduser')) {
    code = 'GRAPH_MAILBOX_UNAVAILABLE';
    message = 'Graph 无法访问该邮箱，请检查账号类型或权限';
    reason = 'Graph 端认为该账号不是可访问的 Exchange/Outlook 邮箱，或当前令牌无法访问邮箱';
    action = '请确认账号类型支持 Graph 邮件接口，并重新授权 Mail.Read 权限';
  } else if (lower.includes('erroraccessdenied') || lower.includes('access is denied')) {
    code = 'GRAPH_ACCESS_DENIED';
    message = normalizedProtocol === 'graph' ? 'Graph 权限不足，请检查应用是否已授权所需权限' : '权限不足，请检查应用授权范围';
    reason = 'Microsoft 返回访问拒绝，当前 access token 缺少对应接口权限';
    action = '取件请确认 Mail.Read，发件请确认 Mail.Send；更新权限后重新授权 refresh_token';
  } else if (lower.includes('too many requests') || lower.includes('429')) {
    code = 'RATE_LIMITED';
    message = 'Microsoft 接口限流，请稍后重试';
    reason = '短时间请求过多或账号/API 被 Microsoft 限流';
    action = '请降低并发和取件数量，等待一段时间后重试';
  } else if (lower.includes('安全') || lower.includes('签名') || lower.includes('nonce') || lower.includes('加密')) {
    code = 'SECURITY_ENVELOPE_INVALID';
    message = raw;
    reason = '请求安全封包校验失败，可能是页面会话过期、重复提交或请求被篡改';
    action = '请刷新页面后重试';
  } else if (raw.length > 180) {
    message = `${raw.slice(0, 180)}...`;
  }

  return {
    code,
    message: protocol ? `${protocol.toUpperCase()}: ${message}` : message,
    reason,
    action,
    detail: raw,
  };
}

module.exports = { toPublicError };
