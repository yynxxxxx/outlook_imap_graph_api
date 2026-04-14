/**
 * Outlook 快速取件 - 前端逻辑
 * 
 * 功能：
 * 1. 批量导入邮箱（localStorage 存储）
 * 2. 双协议并行取件（IMAP + Graph）
 * 3. 邮件展示与搜索
 */

// ==================== 全局状态 ====================
const STORAGE_KEY = 'outlook_accounts';

// 追踪新导入的账号ID，用于高亮动画
let _newlyAddedIds = new Set();

/**
 * 获取所有已存储的账号
 */
function getAccounts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * 保存账号列表
 */
function saveAccounts(accounts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

// ==================== 解析导入 ====================

/**
 * 解析导入文本
 * 格式：账号----密码----clientid----刷新令牌
 * 分隔符支持 1-4 个短横线
 * @param {string} text - 导入文本
 * @returns {Array} - 解析后的账号列表
 */
function parseImportText(text) {
  const lines = text.trim().split('\n');
  const accounts = [];
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return; // 跳过空行

    // 使用正则匹配 1-4 个短横线作为分隔符
    // 需要小心不要匹配 UUID 中的单个短横线
    // 策略：先尝试4个分隔，再3个，再2个，再1个
    let parts = null;

    // 尝试从最多的短横线开始分割
    for (let dashCount = 4; dashCount >= 1; dashCount--) {
      const sep = '-'.repeat(dashCount);
      // 构建正则：匹配恰好 dashCount 个短横线（前后不能是短横线）
      // 但为了简化，我们使用 split 然后验证
      const testParts = trimmed.split(sep);
      
      // 有效分割应该得到恰好 4 个部分
      if (testParts.length === 4) {
        // 验证每个部分都不为空（去除首尾空格后）
        const cleaned = testParts.map(p => p.trim());
        if (cleaned.every(p => p.length > 0)) {
          parts = cleaned;
          break;
        }
      }

      // 如果分割出超过4个部分，尝试只分割前3个分隔符
      if (testParts.length > 4) {
        const cleaned = [];
        let remaining = trimmed;
        for (let i = 0; i < 3; i++) {
          const idx = remaining.indexOf(sep);
          if (idx === -1) break;
          cleaned.push(remaining.substring(0, idx).trim());
          remaining = remaining.substring(idx + sep.length);
        }
        if (cleaned.length === 3 && remaining.trim().length > 0) {
          cleaned.push(remaining.trim());
          parts = cleaned;
          break;
        }
      }
    }

    if (!parts || parts.length !== 4) {
      errors.push(`第 ${index + 1} 行格式错误: ${trimmed.substring(0, 40)}...`);
      return;
    }

    const [email, password, clientId, refreshToken] = parts;

    // 简单验证邮箱格式
    if (!email.includes('@')) {
      errors.push(`第 ${index + 1} 行邮箱格式无效: ${email}`);
      return;
    }

    accounts.push({
      id: generateId(),
      email,
      password,
      clientId,
      refreshToken,
      addedAt: new Date().toISOString(),
    });
  });

  return { accounts, errors };
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ==================== UI 渲染 ====================

/**
 * 渲染邮箱列表
 * @param {Set} highlightIds - 需要高亮的新导入账号ID
 */
function renderAccountList(highlightIds = null) {
  const accounts = getAccounts();
  const listEl = document.getElementById('accountList');
  const countEl = document.getElementById('accountCount');

  // 更新计数，带动画
  const oldCount = parseInt(countEl.textContent) || 0;
  const newCount = accounts.length;
  countEl.textContent = newCount;
  if (newCount !== oldCount) {
    countEl.classList.add('badge-pulse');
    setTimeout(() => countEl.classList.remove('badge-pulse'), 600);
  }

  if (accounts.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <path d="M22 7L12 13L2 7"/>
        </svg>
        <p>暂无邮箱</p>
        <p class="text-muted">点击上方按钮导入</p>
      </div>
    `;
    // 隐藏批量删除按钮
    updateBulkDeleteButton(0);
    return;
  }

  // 全选容器 + 批量删除按钮
  let html = `
    <div class="select-all-wrapper">
      <input type="checkbox" class="account-checkbox" id="selectAll" />
      <label for="selectAll" style="cursor:pointer;">全选</label>
      <button class="btn btn-ghost btn-small btn-danger-ghost" id="btnDeleteSelected" style="display:none;margin-left:auto;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
        </svg>
        删除选中
      </button>
    </div>
  `;

  accounts.forEach((acc, index) => {
    const isNew = highlightIds && highlightIds.has(acc.id);
    html += `
      <div class="account-item ${isNew ? 'account-item-new' : ''}" data-id="${acc.id}" style="animation-delay: ${isNew ? index * 0.05 : 0}s">
        <input type="checkbox" class="account-checkbox account-check" data-id="${acc.id}" />
        <span class="account-email" title="${acc.email}">${acc.email}</span>
        <button class="account-delete" onclick="event.stopPropagation(); deleteAccount('${acc.id}')" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `;
  });

  listEl.innerHTML = html;

  // 清除新导入高亮（3秒后移除动画类）
  if (highlightIds && highlightIds.size > 0) {
    setTimeout(() => {
      document.querySelectorAll('.account-item-new').forEach(el => {
        el.classList.remove('account-item-new');
      });
    }, 3000);
  }

  // 全选事件
  const selectAllEl = document.getElementById('selectAll');
  if (selectAllEl) {
    selectAllEl.addEventListener('change', (e) => {
      document.querySelectorAll('.account-check').forEach(cb => {
        cb.checked = e.target.checked;
        cb.closest('.account-item')?.classList.toggle('selected', e.target.checked);
      });
      updateBulkDeleteButton();
    });
  }

  // 单个选中事件（同时支持点击行来切换选中）
  document.querySelectorAll('.account-item').forEach(item => {
    // 点击行切换选中
    item.addEventListener('click', (e) => {
      // 如果点击的是 checkbox 或删除按钮，不处理
      if (e.target.closest('.account-checkbox') || e.target.closest('.account-delete')) return;
      const cb = item.querySelector('.account-check');
      if (cb) {
        cb.checked = !cb.checked;
        item.classList.toggle('selected', cb.checked);
        updateSelectAllState();
        updateBulkDeleteButton();
      }
    });
  });

  document.querySelectorAll('.account-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.target.closest('.account-item')?.classList.toggle('selected', e.target.checked);
      updateSelectAllState();
      updateBulkDeleteButton();
    });
  });

  // 批量删除按钮事件
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');
  if (btnDeleteSelected) {
    btnDeleteSelected.addEventListener('click', deleteSelectedAccounts);
  }
}

/**
 * 更新全选复选框状态
 */
function updateSelectAllState() {
  const selectAllEl = document.getElementById('selectAll');
  if (!selectAllEl) return;
  const all = document.querySelectorAll('.account-check');
  const checked = document.querySelectorAll('.account-check:checked');
  selectAllEl.checked = all.length > 0 && all.length === checked.length;
  selectAllEl.indeterminate = checked.length > 0 && checked.length < all.length;
}

/**
 * 更新批量删除按钮显隐
 */
function updateBulkDeleteButton(count) {
  const btn = document.getElementById('btnDeleteSelected');
  if (!btn) return;
  if (count === undefined) {
    count = document.querySelectorAll('.account-check:checked').length;
  }
  if (count > 0) {
    btn.style.display = 'inline-flex';
    btn.textContent = '';
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
      </svg>
      删除选中 (${count})
    `;
  } else {
    btn.style.display = 'none';
  }
}

/**
 * 删除选中的账号
 */
function deleteSelectedAccounts() {
  const checkedIds = [];
  document.querySelectorAll('.account-check:checked').forEach(cb => {
    checkedIds.push(cb.dataset.id);
  });

  if (checkedIds.length === 0) {
    showToast('请先选择要删除的邮箱', 'warning');
    return;
  }

  if (!confirm(`确定要删除选中的 ${checkedIds.length} 个邮箱吗？`)) return;

  // 播放移除动画
  checkedIds.forEach(id => {
    const item = document.querySelector(`.account-item[data-id="${id}"]`);
    if (item) {
      item.classList.add('account-item-removing');
    }
  });

  // 等动画结束后再真正删除
  setTimeout(() => {
    const accounts = getAccounts().filter(a => !checkedIds.includes(a.id));
    saveAccounts(accounts);
    renderAccountList();
    showToast(`已删除 ${checkedIds.length} 个邮箱`, 'success');
  }, 300);
}

/**
 * 删除单个账号（带动画）
 */
function deleteAccount(id) {
  const item = document.querySelector(`.account-item[data-id="${id}"]`);
  if (item) {
    item.classList.add('account-item-removing');
  }

  // 等动画结束后再真正删除
  setTimeout(() => {
    const accounts = getAccounts().filter(a => a.id !== id);
    saveAccounts(accounts);
    renderAccountList();
    showToast('已删除邮箱', 'info');
  }, 300);
}

/**
 * 获取选中的账号
 */
function getSelectedAccounts() {
  const checkedIds = [];
  document.querySelectorAll('.account-check:checked').forEach(cb => {
    checkedIds.push(cb.dataset.id);
  });
  const accounts = getAccounts();
  return accounts.filter(a => checkedIds.includes(a.id));
}

// ==================== 邮件取件 ====================

/**
 * 双协议并行取件
 * @param {Array} accounts - 要取件的账号列表
 * @param {object} options - 搜索选项
 */
async function fetchEmails(accounts, options = {}) {
  if (accounts.length === 0) {
    showToast('请先选择邮箱', 'warning');
    return;
  }

  const useImap = document.getElementById('toggleImap').checked;
  const useGraph = document.getElementById('toggleGraph').checked;

  if (!useImap && !useGraph) {
    showToast('请至少选择一种协议', 'warning');
    return;
  }

  // 计算总步骤数（每个邮箱 = 协议数个步骤）
  const protocolCount = (useImap ? 1 : 0) + (useGraph ? 1 : 0);
  const totalSteps = accounts.length * protocolCount;
  let completedSteps = 0;

  // 显示进度
  setStatus('loading', '取件中...');
  showProgress(true);
  updateProgress(0, `准备取件 ${accounts.length} 个邮箱 (${protocolCount} 种协议)...`);

  // 先显示骨架屏占位
  showSkeletonCards(3);

  const allEmails = [];
  const errors = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const emailShort = account.email.split('@')[0];
    const accountLabel = `[${i + 1}/${accounts.length}] ${emailShort}`;

    const promises = [];

    // 双协议并行请求，每个完成时更新进度
    if (useGraph) {
      promises.push(
        (async () => {
          updateProgress(
            Math.round((completedSteps / totalSteps) * 95),
            `${accountLabel} — Graph API 取件中...`
          );
          try {
            const result = await fetchViaGraph(account, options);
            completedSteps++;
            updateProgress(
              Math.round((completedSteps / totalSteps) * 95),
              `${accountLabel} — Graph ✅ ${result.count || 0} 封`
            );
            return result;
          } catch (err) {
            completedSteps++;
            errors.push({ email: account.email, protocol: 'graph', error: err.message });
            updateProgress(
              Math.round((completedSteps / totalSteps) * 95),
              `${accountLabel} — Graph ❌`
            );
            return { success: false, emails: [], protocol: 'graph' };
          }
        })()
      );
    }

    if (useImap) {
      promises.push(
        (async () => {
          updateProgress(
            Math.round((completedSteps / totalSteps) * 95),
            `${accountLabel} — IMAP 取件中...`
          );
          try {
            const result = await fetchViaIMAP(account, options);
            completedSteps++;
            updateProgress(
              Math.round((completedSteps / totalSteps) * 95),
              `${accountLabel} — IMAP ✅ ${result.count || 0} 封`
            );
            return result;
          } catch (err) {
            completedSteps++;
            errors.push({ email: account.email, protocol: 'imap', error: err.message });
            updateProgress(
              Math.round((completedSteps / totalSteps) * 95),
              `${accountLabel} — IMAP ❌`
            );
            return { success: false, emails: [], protocol: 'imap' };
          }
        })()
      );
    }

    const results = await Promise.all(promises);

    // 收集邮件并标记来源账号
    results.forEach(result => {
      if (result.emails && result.emails.length > 0) {
        result.emails.forEach(email => {
          email._account = account.email;
        });
        allEmails.push(...result.emails);
      }
    });
  }

  // 合并去重
  updateProgress(97, '去重合并中...');
  const merged = deduplicateEmails(allEmails);
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  // 渲染结果
  updateProgress(100, '取件完成 ✅');
  renderEmailList(merged);

  const imapCount = merged.filter(e => e.protocol === 'imap').length;
  const graphCount = merged.filter(e => e.protocol === 'graph').length;

  // 延迟隐藏进度条让用户看到完成状态
  setTimeout(() => showProgress(false), 2000);

  if (errors.length > 0) {
    setStatus('error', `完成 (${errors.length} 个错误)`);
    errors.forEach(err => {
      showToast(`${err.email} [${err.protocol}]: ${err.error}`, 'error', 5000);
    });
  } else {
    setStatus('ready', '就绪');
  }

  showToast(`取件完成：共 ${merged.length} 封 (IMAP: ${imapCount} / Graph: ${graphCount})`, 'success', 4000);
}

/**
 * 显示骨架屏卡片
 */
function showSkeletonCards(count) {
  const listEl = document.getElementById('emailList');
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="skeleton skeleton-card"></div>`;
  }
  listEl.innerHTML = html;
}

/**
 * 通过 Graph API 取件
 */
async function fetchViaGraph(account, options) {
  const response = await fetch('/api/fetch-graph', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: account.email,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      keyword: options.keyword || '',
      limit: options.limit || 10,
      sender: options.sender || '',
    }),
  });

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'Graph API 取件失败');
  }
  return data;
}

/**
 * 通过 IMAP 取件
 */
async function fetchViaIMAP(account, options) {
  const response = await fetch('/api/fetch-imap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: account.email,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      keyword: options.keyword || '',
      limit: Math.min(options.limit || 5, 10),
      sender: options.sender || '',
    }),
  });

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'IMAP 取件失败');
  }
  return data;
}

/**
 * 邮件去重
 */
function deduplicateEmails(emails) {
  const seen = new Map();
  emails.forEach(email => {
    const key = email.messageId || `${email.subject}-${email.date}`;
    if (!seen.has(key)) {
      seen.set(key, email);
    }
    // 如果已存在，保留 graph 的（通常内容更完整）
  });
  return Array.from(seen.values());
}

// ==================== 邮件渲染 ====================

/**
 * 渲染邮件列表
 */
function renderEmailList(emails) {
  const listEl = document.getElementById('emailList');
  const headerEl = document.getElementById('resultsHeader');
  const imapCountEl = document.getElementById('imapCount');
  const graphCountEl = document.getElementById('graphCount');
  const totalCountEl = document.getElementById('totalCount');

  headerEl.style.display = 'flex';

  const imapEmails = emails.filter(e => e.protocol === 'imap');
  const graphEmails = emails.filter(e => e.protocol === 'graph');

  imapCountEl.style.display = imapEmails.length > 0 ? 'inline' : 'none';
  graphCountEl.style.display = graphEmails.length > 0 ? 'inline' : 'none';
  imapCountEl.textContent = `IMAP: ${imapEmails.length}`;
  graphCountEl.textContent = `Graph: ${graphEmails.length}`;
  totalCountEl.textContent = `共 ${emails.length} 封`;

  if (emails.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <path d="M22 7L12 13L2 7"/>
        </svg>
        <p>未获取到邮件</p>
        <p class="text-muted">请检查关键词或协议设置</p>
      </div>
    `;
    return;
  }

  let html = '';
  emails.forEach((email, index) => {
    const date = formatDate(email.date);
    const fromDisplay = email.fromName || email.from;
    const preview = (email.bodyPreview || email.bodyText || '').substring(0, 120);

    html += `
      <div class="email-card" style="animation-delay: ${index * 0.04}s" onclick="showEmailDetail(${index})">
        <div class="email-card-header">
          <span class="email-from">
            ${escapeHtml(fromDisplay)}
            <span class="email-protocol ${email.protocol}">${email.protocol}</span>
          </span>
          <span class="email-date">${date}</span>
        </div>
        <div class="email-subject">${escapeHtml(email.subject)}</div>
        <div class="email-preview">${escapeHtml(preview)}</div>
        <div class="email-account-tag">📬 ${escapeHtml(email._account || '')}</div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  // 存储当前邮件列表供详情查看
  window._currentEmails = emails;
}

/**
 * 显示邮件详情
 */
function showEmailDetail(index) {
  const email = window._currentEmails?.[index];
  if (!email) return;

  document.getElementById('emailDetailSubject').textContent = email.subject;

  const metaEl = document.getElementById('emailDetailMeta');
  metaEl.innerHTML = `
    <span><span class="meta-label">发件人</span> ${escapeHtml(email.fromName ? `${email.fromName} <${email.from}>` : email.from)}</span>
    <span><span class="meta-label">时间</span> ${formatDate(email.date, true)}</span>
    <span><span class="meta-label">协议</span> <span class="email-protocol ${email.protocol}" style="display:inline;font-size:0.75rem;">${email.protocol.toUpperCase()}</span></span>
    <span><span class="meta-label">账号</span> ${escapeHtml(email._account || '')}</span>
  `;

  const bodyEl = document.getElementById('emailDetailBody');
  if (email.bodyHtml) {
    // 使用 iframe 隔离 HTML 内容安全风险
    bodyEl.innerHTML = `<iframe srcdoc="${escapeAttr(email.bodyHtml)}" style="width:100%;min-height:300px;border:none;border-radius:8px;background:white;" sandbox="allow-same-origin"></iframe>`;
  } else {
    bodyEl.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(email.bodyText || email.bodyPreview || '(无内容)')}</pre>`;
  }

  document.getElementById('emailDetailModal').classList.add('active');
}

// ==================== 工具函数 ====================

/**
 * 格式化日期
 */
function formatDate(dateStr, full = false) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;

    const now = new Date();
    const today = now.toDateString();
    const dateDay = d.toDateString();

    if (full) {
      return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }

    if (today === dateDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 属性值转义
 */
function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Toast 通知（支持成功大横幅模式）
 */
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
  };

  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  // 点击 toast 提前关闭
  toast.addEventListener('click', () => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  });
  toast.style.cursor = 'pointer';

  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * 显示导入成功大横幅
 */
function showImportSuccessBanner(uniqueCount, duplicateCount) {
  const banner = document.createElement('div');
  banner.className = 'import-success-banner';
  
  let msg = `🎉 成功导入 <strong>${uniqueCount}</strong> 个邮箱`;
  if (duplicateCount > 0) {
    msg += `，跳过 <strong>${duplicateCount}</strong> 个重复`;
  }

  banner.innerHTML = `
    <div class="import-success-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    </div>
    <div class="import-success-text">${msg}</div>
  `;

  document.body.appendChild(banner);

  // 触发动画
  requestAnimationFrame(() => {
    banner.classList.add('active');
  });

  // 3秒后移除
  setTimeout(() => {
    banner.classList.add('exit');
    setTimeout(() => banner.remove(), 400);
  }, 2500);
}

/**
 * 状态栏更新
 */
function setStatus(state, text) {
  const badge = document.getElementById('statusBadge');
  badge.className = `status-badge ${state === 'loading' ? 'loading' : state === 'error' ? 'error' : ''}`;
  badge.querySelector('.status-text').textContent = text;
}

/**
 * 进度条控制
 */
function showProgress(show) {
  document.getElementById('progressContainer').style.display = show ? 'block' : 'none';
}

function updateProgress(percent, text) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressPercent').textContent = `${percent}%`;
}

/**
 * Textarea 输入验证震动效果
 */
function shakeElement(el) {
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 500);
}

/**
 * 按钮加载状态
 */
function setButtonLoading(btn, loading, originalText = '') {
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <span class="btn-spinner"></span>
      处理中...
    `;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalHtml || originalText;
  }
}

// ==================== 事件绑定 ====================

document.addEventListener('DOMContentLoaded', () => {
  // 初次渲染邮箱列表
  renderAccountList();

  // 导入弹窗
  const importModal = document.getElementById('importModal');
  const emailDetailModal = document.getElementById('emailDetailModal');
  const importTextarea = document.getElementById('importTextarea');
  const btnConfirmImport = document.getElementById('btnConfirmImport');

  document.getElementById('btnOpenImport').addEventListener('click', () => {
    importModal.classList.add('active');
    importTextarea.focus();
    // 重置 textarea 状态
    importTextarea.classList.remove('textarea-error');
    updateImportPreview();
  });

  document.getElementById('btnCloseModal').addEventListener('click', () => {
    importModal.classList.remove('active');
  });

  document.getElementById('btnCancelImport').addEventListener('click', () => {
    importModal.classList.remove('active');
  });

  // 点击背景关闭弹窗
  importModal.addEventListener('click', (e) => {
    if (e.target === importModal) importModal.classList.remove('active');
  });

  emailDetailModal.addEventListener('click', (e) => {
    if (e.target === emailDetailModal) emailDetailModal.classList.remove('active');
  });

  document.getElementById('btnCloseDetail').addEventListener('click', () => {
    emailDetailModal.classList.remove('active');
  });

  // 实时预览导入数据
  importTextarea.addEventListener('input', () => {
    importTextarea.classList.remove('textarea-error');
    updateImportPreview();
  });

  // 确认导入
  btnConfirmImport.addEventListener('click', () => {
    const text = importTextarea.value;
    if (!text.trim()) {
      showToast('请输入邮箱信息', 'warning');
      importTextarea.classList.add('textarea-error');
      shakeElement(importTextarea);
      importTextarea.focus();
      return;
    }

    // 按钮加载状态
    setButtonLoading(btnConfirmImport, true);

    // 模拟微小延迟让用户感知处理过程
    setTimeout(() => {
      const { accounts: newAccounts, errors } = parseImportText(text);

      if (errors.length > 0) {
        errors.forEach(err => showToast(err, 'error', 5000));
      }

      if (newAccounts.length > 0) {
        const existing = getAccounts();
        // 去重（基于邮箱地址）
        const existingEmails = new Set(existing.map(a => a.email.toLowerCase()));
        const unique = newAccounts.filter(a => !existingEmails.has(a.email.toLowerCase()));
        const duplicates = newAccounts.length - unique.length;

        if (unique.length === 0 && duplicates > 0) {
          // 全部重复
          setButtonLoading(btnConfirmImport, false);
          showToast(`所有 ${duplicates} 个邮箱都已存在，跳过导入`, 'warning');
          return;
        }

        saveAccounts([...existing, ...unique]);
        
        // 记录新导入的ID用于高亮
        const newIds = new Set(unique.map(a => a.id));
        renderAccountList(newIds);

        // 清空输入
        importTextarea.value = '';
        updateImportPreview();

        // 关闭弹窗
        importModal.classList.remove('active');
        
        // 恢复按钮
        setButtonLoading(btnConfirmImport, false);

        // 显示成功横幅
        showImportSuccessBanner(unique.length, duplicates);

        // 滚动账号列表到底部以显示新导入的账号
        setTimeout(() => {
          const accountList = document.getElementById('accountList');
          accountList.scrollTop = accountList.scrollHeight;
        }, 100);

      } else if (errors.length === 0) {
        setButtonLoading(btnConfirmImport, false);
        showToast('未解析到有效的邮箱数据', 'warning');
        importTextarea.classList.add('textarea-error');
        shakeElement(importTextarea);
      } else {
        setButtonLoading(btnConfirmImport, false);
      }
    }, 200);
  });

  // 清空全部
  document.getElementById('btnClearAll').addEventListener('click', () => {
    const accounts = getAccounts();
    if (accounts.length === 0) {
      showToast('没有可清空的邮箱', 'info');
      return;
    }
    if (confirm(`确定要清空全部 ${accounts.length} 个邮箱吗？`)) {
      // 播放移除动画
      document.querySelectorAll('.account-item').forEach(item => {
        item.classList.add('account-item-removing');
      });
      setTimeout(() => {
        saveAccounts([]);
        renderAccountList();
        showToast('已清空全部邮箱', 'info');
      }, 300);
    }
  });

  // 选中取件
  document.getElementById('btnFetchSelected').addEventListener('click', () => {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
      showToast('请先在左侧勾选要取件的邮箱', 'warning');
      // 闪烁左侧面板提示
      const sidebar = document.querySelector('.sidebar');
      sidebar.classList.add('sidebar-highlight');
      setTimeout(() => sidebar.classList.remove('sidebar-highlight'), 1500);
      return;
    }
    startFetch(selected);
  });

  // 全部取件
  document.getElementById('btnFetchAll').addEventListener('click', () => {
    const accounts = getAccounts();
    if (accounts.length === 0) {
      showToast('请先导入邮箱', 'warning');
      return;
    }
    startFetch(accounts);
  });

  // Ctrl+Enter 快捷键提交导入
  importTextarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      btnConfirmImport.click();
    }
  });

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      importModal.classList.remove('active');
      emailDetailModal.classList.remove('active');
    }
  });
});

/**
 * 更新导入预览：实时显示解析了多少行
 */
function updateImportPreview() {
  const textarea = document.getElementById('importTextarea');
  let previewEl = document.getElementById('importPreview');
  
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.id = 'importPreview';
    previewEl.className = 'import-preview';
    textarea.parentElement.appendChild(previewEl);
  }

  const text = textarea.value.trim();
  if (!text) {
    previewEl.innerHTML = '<span class="preview-hint">💡 粘贴邮箱数据后将自动预览，支持 Ctrl+Enter 快捷导入</span>';
    return;
  }

  const lines = text.split('\n').filter(l => l.trim());
  const { accounts, errors } = parseImportText(text);
  
  // 检查与现有邮箱的重复
  const existing = getAccounts();
  const existingEmails = new Set(existing.map(a => a.email.toLowerCase()));
  const duplicates = accounts.filter(a => existingEmails.has(a.email.toLowerCase()));
  const unique = accounts.length - duplicates.length;

  let html = `<span class="preview-count">📋 识别 ${lines.length} 行`;
  
  if (accounts.length > 0) {
    html += ` → <span class="preview-valid">✅ ${accounts.length} 个有效</span>`;
  }
  
  if (unique < accounts.length && duplicates.length > 0) {
    html += ` <span class="preview-dup">⚠️ ${duplicates.length} 个重复</span>`;
  }
  
  if (errors.length > 0) {
    html += ` <span class="preview-error">❌ ${errors.length} 个错误</span>`;
  }
  
  html += '</span>';
  previewEl.innerHTML = html;
}

/**
 * 启动取件流程
 */
function startFetch(accounts) {
  const keyword = document.getElementById('searchKeyword').value.trim();
  const sender = document.getElementById('searchSender').value.trim();
  const limit = parseInt(document.getElementById('fetchLimit').value);

  // 禁用按钮
  const btnSelected = document.getElementById('btnFetchSelected');
  const btnAll = document.getElementById('btnFetchAll');
  btnSelected.disabled = true;
  btnAll.disabled = true;

  fetchEmails(accounts, { keyword, sender, limit })
    .finally(() => {
      btnSelected.disabled = false;
      btnAll.disabled = false;
    });
}
