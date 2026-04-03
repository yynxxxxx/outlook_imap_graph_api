/**
 * Graph API 取件工具
 * 使用 Microsoft Graph API 获取邮件
 */

/**
 * 通过 Graph API 获取邮件
 * @param {string} accessToken - Graph API 的 access_token
 * @param {object} options - 查询选项
 * @param {string} [options.keyword] - 搜索关键词
 * @param {number} [options.limit=10] - 获取数量
 * @param {string} [options.sender] - 发件人过滤
 * @returns {Promise<Array>} - 邮件列表
 */
async function fetchEmailsViaGraph(accessToken, options = {}) {
  const { keyword = '', limit = 10, sender = '' } = options;

  // 构建查询参数
  let url = 'https://graph.microsoft.com/v1.0/me/messages?';
  const params = new URLSearchParams();

  // 选择返回的字段
  params.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,body,internetMessageId,hasAttachments');
  params.set('$top', String(Math.min(limit, 50))); // 最多50封
  params.set('$orderby', 'receivedDateTime desc');

  // 搜索/过滤
  const filters = [];
  if (keyword) {
    // 使用 $search 进行全文搜索
    params.set('$search', `"${keyword}"`);
  }
  if (sender) {
    filters.push(`from/emailAddress/address eq '${sender}'`);
  }
  if (filters.length > 0) {
    params.set('$filter', filters.join(' and '));
  }

  url += params.toString();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Graph API 错误: ${data.error?.code || response.status} - ${data.error?.message || JSON.stringify(data)}`
    );
  }

  // 标准化邮件格式
  const emails = (data.value || []).map(msg => ({
    id: msg.internetMessageId || msg.id,
    messageId: msg.internetMessageId || msg.id,
    subject: msg.subject || '(无主题)',
    from: msg.from?.emailAddress?.address || '未知',
    fromName: msg.from?.emailAddress?.name || '',
    date: msg.receivedDateTime,
    bodyPreview: msg.bodyPreview || '',
    bodyHtml: msg.body?.contentType === 'html' ? msg.body?.content : '',
    bodyText: msg.body?.contentType === 'text' ? msg.body?.content : msg.bodyPreview,
    hasAttachments: msg.hasAttachments || false,
    protocol: 'graph',
  }));

  return emails;
}

module.exports = { fetchEmailsViaGraph };
