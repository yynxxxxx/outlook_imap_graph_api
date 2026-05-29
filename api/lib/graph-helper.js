/**
 * Graph API 取件工具
 * 使用 Microsoft Graph API 获取邮件
 */

const DEFAULT_GRAPH_FOLDERS = ['inbox', 'junkemail'];

/**
 * 通过 Graph API 获取邮件
 * @param {string} accessToken - Graph API 的 access_token
 * @param {object} options - 查询选项
 * @param {string} [options.keyword] - 搜索关键词
 * @param {number} [options.limit=10] - 获取数量
 * @param {string} [options.sender] - 发件人过滤
 * @param {string|string[]} [options.folder] - 指定 Graph 文件夹
 * @param {string[]} [options.folders] - 指定多个 Graph 文件夹
 * @returns {Promise<Array>} - 邮件列表
 */
async function fetchEmailsViaGraph(accessToken, options = {}) {
  const { keyword = '', limit = 10, sender = '', folder, folders } = options;
  const targetFolders = normalizeFolderInput(folders || folder);
  const folderList = targetFolders.length > 0 ? targetFolders : DEFAULT_GRAPH_FOLDERS;
  const perFolderLimit = Math.max(limit, Math.ceil(limit / Math.max(folderList.length, 1)));

  const results = [];
  for (const targetFolder of folderList) {
    const folderEmails = await fetchEmailsFromGraphFolder(accessToken, targetFolder, {
      keyword,
      limit: perFolderLimit,
      sender,
    });
    results.push(...folderEmails);
  }

  return deduplicateAndLimit(results, limit);
}

async function fetchEmailsFromGraphFolder(accessToken, folder, options = {}) {
  const { keyword = '', limit = 10, sender = '' } = options;
  let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages?`;
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
  return (data.value || []).map(msg => ({
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
    folder,
    protocol: 'graph',
  }));
}

function normalizeFolderInput(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values.map(value => String(value || '').trim()).filter(Boolean);
}

function deduplicateAndLimit(emails, limit) {
  const seen = new Map();
  emails
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach(email => {
      const key = email.messageId || `${email.subject}-${email.date}-${email.folder || ''}`;
      if (!seen.has(key)) {
        seen.set(key, email);
      }
    });
  return Array.from(seen.values()).slice(0, limit);
}

module.exports = { fetchEmailsViaGraph };
