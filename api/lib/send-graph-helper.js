/**
 * Graph API 发件工具
 * 使用 Microsoft Graph /me/sendMail 发送邮件
 */

const GRAPH_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

function createSendError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeAddressList(value, fieldName, required = false) {
  let values;
  if (Array.isArray(value)) {
    values = value;
  } else if (value && typeof value === 'object') {
    values = [value];
  } else {
    values = String(value || '')
      .split(/[;,]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (required && values.length === 0) {
    throw createSendError(`缺少 ${fieldName}`);
  }

  return values.map(item => normalizeRecipient(item, fieldName));
}

function normalizeRecipient(item, fieldName) {
  if (typeof item === 'string') {
    return toRecipient(item.trim(), '');
  }

  if (!item || typeof item !== 'object') {
    throw createSendError(`${fieldName} 格式无效`);
  }

  if (item.emailAddress && typeof item.emailAddress === 'object') {
    return toRecipient(item.emailAddress.address, item.emailAddress.name);
  }

  return toRecipient(item.address || item.email || item.mail, item.name || '');
}

function toRecipient(address, name = '') {
  const parsed = parseAddressWithName(address, name);
  const normalizedAddress = parsed.address;
  const normalizedName = parsed.name;

  if (!normalizedAddress || !normalizedAddress.includes('@')) {
    throw createSendError(`收件人邮箱格式无效: ${normalizedAddress || '(空)'}`);
  }

  const emailAddress = { address: normalizedAddress };
  if (normalizedName) {
    emailAddress.name = normalizedName;
  }

  return { emailAddress };
}

function parseAddressWithName(address, name = '') {
  const rawAddress = String(address || '').trim();
  const rawName = String(name || '').trim();
  const angleMatch = rawAddress.match(/^(.*?)<([^<>]+)>$/);

  if (!rawName && angleMatch) {
    return {
      name: angleMatch[1].replace(/^"|"$/g, '').trim(),
      address: angleMatch[2].trim(),
    };
  }

  return {
    name: rawName,
    address: rawAddress,
  };
}

function normalizeAttachments(attachments) {
  if (!attachments) return [];
  if (!Array.isArray(attachments)) {
    throw createSendError('attachments 必须是数组');
  }

  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') {
      throw createSendError(`第 ${index + 1} 个附件格式无效`);
    }

    const name = String(attachment.name || '').trim();
    const contentBytes = String(attachment.contentBytes || attachment.base64 || '').trim();
    if (!name || !contentBytes) {
      throw createSendError(`第 ${index + 1} 个附件缺少 name 或 contentBytes`);
    }

    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: attachment.contentType || 'application/octet-stream',
      contentBytes,
    };
  });
}

function buildSendMailPayload(options = {}) {
  const {
    to,
    cc,
    bcc,
    replyTo,
    subject = '',
    text,
    html,
    body,
    importance,
    attachments,
    saveToSentItems,
  } = options;

  const bodyContent = html || text || body || '';
  if (!String(subject || '').trim()) {
    throw createSendError('缺少 subject');
  }
  if (!String(bodyContent || '').trim()) {
    throw createSendError('缺少邮件正文，请提供 text、html 或 body');
  }

  const message = {
    subject: String(subject),
    body: {
      contentType: html ? 'HTML' : 'Text',
      content: String(bodyContent),
    },
    toRecipients: normalizeAddressList(to, 'to', true),
  };

  const ccRecipients = normalizeAddressList(cc, 'cc');
  if (ccRecipients.length > 0) {
    message.ccRecipients = ccRecipients;
  }

  const bccRecipients = normalizeAddressList(bcc, 'bcc');
  if (bccRecipients.length > 0) {
    message.bccRecipients = bccRecipients;
  }

  const replyToRecipients = normalizeAddressList(replyTo, 'replyTo');
  if (replyToRecipients.length > 0) {
    message.replyTo = replyToRecipients;
  }

  const fileAttachments = normalizeAttachments(attachments);
  if (fileAttachments.length > 0) {
    message.attachments = fileAttachments;
  }

  if (importance) {
    const normalizedImportance = String(importance).toLowerCase();
    if (!['low', 'normal', 'high'].includes(normalizedImportance)) {
      throw createSendError('importance 仅支持 low、normal、high');
    }
    message.importance = normalizedImportance;
  }

  const payload = { message };
  if (normalizeSaveToSentItems(saveToSentItems) === false) {
    payload.saveToSentItems = false;
  }

  return payload;
}

function normalizeSaveToSentItems(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no'].includes(String(value).trim().toLowerCase());
}

async function readGraphError(response) {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;

  try {
    const data = JSON.parse(text);
    return `${data.error?.code || response.status} - ${data.error?.message || text}`;
  } catch {
    return text;
  }
}

async function sendMailViaGraph(accessToken, options = {}) {
  if (!accessToken) {
    throw createSendError('缺少 accessToken', 401);
  }

  const payload = buildSendMailPayload(options);
  const response = await fetch(GRAPH_SEND_MAIL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await readGraphError(response);
    throw createSendError(`Graph 发件失败: ${message}`, response.status);
  }

  return {
    accepted: response.status === 202,
    status: response.status,
  };
}

module.exports = {
  buildSendMailPayload,
  normalizeSaveToSentItems,
  sendMailViaGraph,
};
