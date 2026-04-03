/**
 * IMAP OAuth2 取件工具
 * 使用 imapflow + XOAUTH2 连接 Outlook IMAP 获取邮件
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

/**
 * 生成 XOAUTH2 token 字符串
 * 格式: base64("user=" + email + "\x01auth=Bearer " + accessToken + "\x01\x01")
 */
function buildXOAuth2Token(email, accessToken) {
  const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(authString).toString('base64');
}

/**
 * 通过 IMAP OAuth2 获取邮件
 * @param {string} email - 邮箱地址
 * @param {string} accessToken - IMAP scope 的 access_token
 * @param {object} options - 查询选项
 * @param {string} [options.keyword] - 搜索关键词
 * @param {number} [options.limit=5] - 获取数量（Hobby 计划建议不超过5）
 * @param {string} [options.folder='INBOX'] - 文件夹
 * @param {string} [options.sender] - 发件人过滤
 * @returns {Promise<Array>} - 邮件列表
 */
async function fetchEmailsViaIMAP(email, accessToken, options = {}) {
  const { keyword = '', limit = 5, folder = 'INBOX', sender = '' } = options;

  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      accessToken: accessToken,
    },
    logger: false, // 关闭日志减少开销
    maxIdleTime: 5000, // 5秒无操作自动断开
  });

  const emails = [];

  try {
    // 连接并认证
    await client.connect();

    // 打开指定文件夹
    const mailbox = await client.getMailboxLock(folder);

    try {
      // 构建 IMAP 搜索条件
      const searchCriteria = {};

      if (keyword) {
        // IMAP SEARCH 支持 OR 搜索主题和正文
        searchCriteria.or = [
          { subject: keyword },
          { body: keyword },
        ];
      }

      if (sender) {
        searchCriteria.from = sender;
      }

      // 搜索邮件，默认获取所有，然后取最新的 N 封
      let messageIds;
      if (Object.keys(searchCriteria).length > 0) {
        messageIds = await client.search(searchCriteria);
      } else {
        // 无搜索条件时获取所有邮件 UID
        messageIds = await client.search({ all: true });
      }

      if (!messageIds || messageIds.length === 0) {
        return [];
      }

      // 取最新的 N 封（UID 大的是新邮件）
      const latestIds = messageIds.slice(-Math.min(limit, messageIds.length));
      latestIds.reverse(); // 最新的在前

      // 逐个获取邮件内容
      for (const uid of latestIds) {
        try {
          const message = await client.fetchOne(uid, {
            source: true, // 获取完整邮件源码
            envelope: true,
          });

          if (message && message.source) {
            const parsed = await simpleParser(message.source);

            emails.push({
              id: parsed.messageId || `imap-${uid}`,
              messageId: parsed.messageId || `imap-${uid}`,
              subject: parsed.subject || '(无主题)',
              from: parsed.from?.value?.[0]?.address || '未知',
              fromName: parsed.from?.value?.[0]?.name || '',
              date: parsed.date?.toISOString() || new Date().toISOString(),
              bodyPreview: (parsed.text || '').substring(0, 200),
              bodyHtml: parsed.html || '',
              bodyText: parsed.text || '',
              hasAttachments: (parsed.attachments || []).length > 0,
              protocol: 'imap',
            });
          }
        } catch (msgErr) {
          // 单封邮件获取失败不影响其他邮件
          console.error(`获取邮件 UID ${uid} 失败:`, msgErr.message);
        }
      }
    } finally {
      mailbox.release();
    }
  } finally {
    // 务必关闭连接
    try {
      await client.logout();
    } catch (e) {
      // 忽略登出错误
    }
  }

  return emails;
}

module.exports = { fetchEmailsViaIMAP };
