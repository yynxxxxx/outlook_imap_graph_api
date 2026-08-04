function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getRawErrorDetail(err) {
  const parts = [
    err?.message || err || '未知错误',
    err?.imapStage ? `IMAP stage: ${err.imapStage}` : '',
    err?.imapFolder ? `IMAP folder: ${err.imapFolder}` : '',
    err?.responseText ? `IMAP response: ${err.responseText}` : '',
    err?.responseStatus ? `IMAP status: ${err.responseStatus}` : '',
    err?.executedCommand ? `IMAP command: ${err.executedCommand}` : '',
  ];
  return normalizeWhitespace(parts.filter(Boolean).join(' | '));
}

function toPublicError(err, protocol = '') {
  const raw = getRawErrorDetail(err);
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
    lower.includes('no authenticate failed') ||
    lower.includes('login is disabled')
  ) {
    if (lower.includes('login is disabled')) {
      code = 'IMAP_NOT_AVAILABLE';
      message = 'IMAP 登录被服务器禁用';
      reason = '服务器明确返回 Login is disabled，当前账号或租户没有开放 IMAP 登录';
      action = '请在 Outlook/Exchange 管理设置中启用 IMAP；Graph 成功时无需处理此错误';
    } else {
      code = 'IMAP_AUTH_FAILED';
      message = 'IMAP 认证失败，令牌没有通过服务器校验';
      reason = 'XOAUTH2 登录阶段被拒绝，常见原因是令牌缺少 IMAP.AccessAsUser.All、账号未启用 IMAP，或令牌已失效';
      action = '请确认账号已启用 IMAP，并重新授权包含 IMAP.AccessAsUser.All 的 refresh_token';
    }
  } else if (lower.includes('ethrottle') || lower.includes('request is throttled') || lower.includes('backoff time')) {
    code = 'IMAP_RATE_LIMITED';
    message = 'IMAP 被 Microsoft 限流，请稍后重试';
    reason = 'Outlook IMAP 返回了限流或退避提示，通常是短时间批量账号/批量命令过多';
    action = '请降低批量取件数量或间隔后重试；Graph 成功的账号可以忽略 IMAP 失败';
  } else if (lower.includes('command failed') && normalizedProtocol === 'imap') {
    const stage = err?.imapStage || (lower.match(/imap stage: ([a-z]+)/)?.[1] || '');
    code = stage === 'list' ? 'IMAP_FOLDER_LIST_REJECTED' : 'IMAP_COMMAND_REJECTED';
    if (stage === 'select') {
      message = 'IMAP 打开邮箱文件夹被服务器拒绝';
      reason = '失败发生在打开文件夹阶段，不能仅凭此错误认定 IMAP 未开通；也可能是文件夹名称、邮箱权限或服务器临时策略导致';
      action = '优先检查收件箱/垃圾邮件文件夹和 IMAP 权限；如果 Graph 已成功取件，可以忽略这条 IMAP 失败';
    } else if (stage === 'search') {
      message = 'IMAP 搜索命令被服务器拒绝';
      reason = '失败发生在 SEARCH 阶段，常见原因是 IMAP 未开放、令牌缺少 IMAP.AccessAsUser.All、搜索条件不被服务器接受或 Microsoft 临时限制';
      action = '不能仅凭 Command failed 断言 IMAP 未开通；请查看服务器响应文本，必要时重新授权 IMAP scope 或稍后重试';
    } else if (stage === 'list') {
      message = 'IMAP 文件夹列表命令被服务器拒绝';
      reason = '失败发生在 LIST 阶段，可能是 IMAP 权限、邮箱策略或服务器不允许列出文件夹；这不等同于已确认 IMAP 未开通';
      action = '如果收件箱仍能读取可以忽略；否则检查 IMAP 设置和令牌权限';
    } else {
      message = 'IMAP 命令被 Outlook 服务器拒绝';
      reason = '服务器返回 NO/BAD，但当前只提供了 Command failed，无法单独确认是未开通 IMAP；也可能是权限、文件夹访问、搜索命令或临时限制';
      action = '请查看详细响应判断具体阶段；Graph 已成功取件时无需处理另一协议错误';
    }
  } else if (normalizedProtocol === 'proton') {
    code = err?.code || 'PROTON_FETCH_FAILED';
    message = raw;
    reason = 'Proton API 登录、令牌、邮箱读取或正文解密失败';
    action = '请检查 Proton 邮箱和密码；若使用会话令牌，请更新 access_token/refresh_token 后重试';
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
