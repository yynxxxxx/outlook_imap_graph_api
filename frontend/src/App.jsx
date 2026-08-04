import {
  AlertCircle,
  Archive,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  ExternalLink,
  Inbox,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_VERSION,
  copyText,
  deduplicateEmails,
  detectProvider,
  enabledProtocolsForAccount,
  extractHighlights,
  formatAccountForExport,
  formatDate,
  formatFolderName,
  normalizeAccounts,
  normalizeFetchError,
  normalizeSessionPatch,
  parseFetchResponse,
  parseImportText,
  persistAccounts,
  protocolLabel,
  providerLabel,
  readAccounts,
  relativeTime,
  runPool,
  secureApiFetch,
} from './lib/mail.js';

export default function App() {
  const [accounts, setAccounts] = useState(() => normalizeAccounts(readAccounts()));
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [accountQuery, setAccountQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sender, setSender] = useState('');
  const [limit, setLimit] = useState(10);
  const [protocols, setProtocols] = useState({ graph: true, imap: true, proton: true });
  const [status, setStatus] = useState({ tone: 'ready', text: '就绪' });
  const [fetching, setFetching] = useState(false);
  const [activeTab, setActiveTab] = useState('codes');
  const [accountResults, setAccountResults] = useState([]);
  const [issues, setIssues] = useState([]);
  const [detailEmail, setDetailEmail] = useState(null);
  const [toast, setToast] = useState(null);
  const abortRef = useRef({ cancelled: false });

  useEffect(() => {
    persistAccounts(accounts);
  }, [accounts]);

  const visibleAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return query ? accounts.filter(account => account.email.toLowerCase().includes(query)) : accounts;
  }, [accounts, accountQuery]);

  const allEmails = useMemo(() => {
    return accountResults
      .flatMap(result => result.emails.map(email => ({
        ...email,
        _account: result.email,
        _accountIndex: result.index,
        _provider: result.provider,
      })))
      .sort((a, b) => {
        const accountDelta = (a._accountIndex ?? 0) - (b._accountIndex ?? 0);
        return accountDelta || new Date(b.date) - new Date(a.date);
      });
  }, [accountResults]);

  const codeItems = useMemo(() => extractHighlights(allEmails), [allEmails]);
  const progress = accountResults.length
    ? Math.round((accountResults.filter(item => ['done', 'failed'].includes(item.status)).length / accountResults.length) * 100)
    : 0;
  const selectedAccounts = accounts.filter(account => selectedIds.has(account.id));
  const selectedCount = selectedIds.size;

  function updateAccounts(nextAccounts) {
    setAccounts(normalizeAccounts(nextAccounts));
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    const allVisibleSelected = visibleAccounts.length > 0 && visibleAccounts.every(account => selectedIds.has(account.id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      visibleAccounts.forEach(account => {
        if (allVisibleSelected) next.delete(account.id);
        else next.add(account.id);
      });
      return next;
    });
  }

  function deleteSelected() {
    if (!selectedCount) return;
    updateAccounts(accounts.filter(account => !selectedIds.has(account.id)));
    setSelectedIds(new Set());
    showToast(`已删除 ${selectedCount} 个邮箱`, 'success');
  }

  function importAccounts() {
    const parsed = parseImportText(importText);
    if (parsed.accounts.length === 0) {
      showToast(parsed.errors[0] || '未识别到有效账号', 'error');
      return;
    }

    const existing = new Set(accounts.map(account => account.email.toLowerCase()));
    const unique = parsed.accounts.filter(account => !existing.has(account.email.toLowerCase()));
    updateAccounts([...accounts, ...unique]);
    setImportText('');
    setImportOpen(false);
    showToast(`已导入 ${unique.length} 个邮箱${parsed.accounts.length - unique.length ? '，重复已跳过' : ''}`, 'success');
  }

  function exportAccounts() {
    const target = selectedAccounts.length ? selectedAccounts : accounts;
    const text = target.map(formatAccountForExport).join('\n');
    copyText(text, selectedAccounts.length ? '已复制选中账号' : '已复制全部账号', showToast);
  }

  async function startFetch(targetAccounts) {
    const runnable = targetAccounts.filter(account => enabledProtocolsForAccount(account, protocols).length > 0);
    if (!runnable.length) {
      showToast('当前选择没有可用协议', 'warning');
      return;
    }

    abortRef.current.cancelled = false;
    setFetching(true);
    setIssues([]);
    setActiveTab('codes');
    setStatus({ tone: 'loading', text: `取件中 ${runnable.length} 个邮箱` });
    setAccountResults(runnable.map((account, index) => ({
      id: account.id,
      email: account.email,
      provider: detectProvider(account),
      index,
      status: 'pending',
      emails: [],
      protocols: {},
      error: null,
    })));

    const failures = [];
    let successCount = 0;
    let failCount = 0;

    await runPool(runnable, 3, async (account, index) => {
      if (abortRef.current.cancelled) return;
      markAccount(index, { status: 'running' });
      const result = await fetchAccount(account, index);
      if (abortRef.current.cancelled) return;

      if (result.status === 'done') {
        successCount += 1;
        if (result.updatedAccount) {
          setAccounts(prev => normalizeAccounts(prev.map(item => item.id === account.id ? { ...item, ...result.updatedAccount } : item)));
        }
      } else {
        failCount += 1;
        failures.push(...result.visibleErrors);
      }

      markAccount(index, result);
      setIssues([...failures]);
      setStatus({
        tone: failCount && !successCount ? 'error' : 'loading',
        text: `已完成 ${successCount + failCount}/${runnable.length}`,
      });
    });

    setFetching(false);
    setStatus({
      tone: failures.length && !successCount ? 'error' : 'ready',
      text: failures.length ? `完成：${successCount} 成功 / ${failCount} 失败` : '就绪',
    });
    showToast(`取件完成：${successCount} 成功 / ${failCount} 失败`, failures.length ? 'warning' : 'success');
  }

  async function fetchAccount(account, index) {
    const provider = detectProvider(account);
    const enabled = enabledProtocolsForAccount(account, protocols);
    const protocolResults = await Promise.all(enabled.map(protocol => fetchProtocol(account, protocol)));
    const successful = protocolResults.filter(result => result.success);
    const failed = protocolResults.filter(result => !result.success);
    const emails = deduplicateEmails(successful.flatMap(result => result.emails || []));
    const visibleErrors = successful.length ? [] : failed.map(result => result.error).filter(Boolean);
    const updatedAccount = successful.find(result => result.session)?.session;

    return {
      id: account.id,
      email: account.email,
      provider,
      index,
      status: successful.length ? 'done' : 'failed',
      emails,
      protocols: Object.fromEntries(protocolResults.map(result => [result.protocol, result])),
      error: visibleErrors[0] || null,
      visibleErrors,
      updatedAccount,
    };
  }

  async function fetchProtocol(account, protocol) {
    try {
      const response = protocol === 'graph'
        ? await fetchViaGraph(account)
        : protocol === 'imap'
          ? await fetchViaImap(account)
          : await fetchViaProton(account);
      return {
        protocol,
        success: Boolean(response.success),
        count: response.count || response.emails?.length || 0,
        emails: response.emails || [],
        session: normalizeSessionPatch(response.session),
      };
    } catch (error) {
      return {
        protocol,
        success: false,
        count: 0,
        emails: [],
        error: normalizeFetchError(account.email, protocol, error),
      };
    }
  }

  async function fetchViaGraph(account) {
    return parseFetchResponse(await secureApiFetch('/api/fetch-graph', {
      email: account.email,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      keyword,
      limit,
      sender,
    }), 'graph');
  }

  async function fetchViaImap(account) {
    return parseFetchResponse(await secureApiFetch('/api/fetch-imap', {
      email: account.email,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      keyword,
      limit: Math.min(limit, 10),
      sender,
    }), 'imap');
  }

  async function fetchViaProton(account) {
    return parseFetchResponse(await secureApiFetch('/api/fetch-proton', {
      email: account.email,
      password: account.password,
      uid: account.uid,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresIn: account.expiresIn,
      keyword,
      limit,
      sender,
    }), 'proton');
  }

  function markAccount(index, patch) {
    setAccountResults(prev => prev.map(item => item.index === index ? { ...item, ...patch } : item));
  }

  function showToast(message, tone = 'info') {
    setToast({ message, tone, id: Date.now() });
    window.setTimeout(() => setToast(current => current?.message === message ? null : current), 2600);
  }

  const importPreview = useMemo(() => parseImportText(importText), [importText]);

  return (
    <div className="min-h-screen bg-[#f5f8f7] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-emerald-900/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-green-600 to-emerald-700 text-white shadow-sm">
            <Inbox size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold leading-tight sm:text-xl">邮箱取件系统</h1>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">v{APP_VERSION}</span>
            </div>
            <p className="truncate text-sm text-slate-500">Outlook IMAP/Graph 与 Proton Mail API</p>
          </div>
          <div className={`status-pill ${status.tone}`} aria-live="polite">
            {status.tone === 'loading' ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
            <span>{status.text}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1680px] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-3">
          <section className="panel">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-semibold">
                <Archive size={18} />
                <span>邮箱列表</span>
              </div>
              <span className="count-badge">{visibleAccounts.length}/{accounts.length}</span>
            </div>
            <div className="relative mb-3">
              <Search className="input-icon" size={17} />
              <input className="field pl-10" value={accountQuery} onChange={event => setAccountQuery(event.target.value)} placeholder="搜索邮箱" />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button className="btn primary" onClick={() => setImportOpen(true)}><Upload size={16} />导入</button>
              <button className="btn subtle" onClick={exportAccounts} disabled={!accounts.length}><Clipboard size={16} />导出</button>
            </div>
            <div className="mb-2 flex items-center justify-between">
              <button className="text-button" onClick={selectAllVisible}>{visibleAccounts.every(account => selectedIds.has(account.id)) && visibleAccounts.length ? '取消全选' : '全选'}</button>
              <button className="text-button danger" onClick={deleteSelected} disabled={!selectedCount}><Trash2 size={15} />删除 {selectedCount || ''}</button>
            </div>
            <div className="account-list">
              {visibleAccounts.length ? visibleAccounts.map(account => (
                <AccountRow
                  key={account.id}
                  account={account}
                  selected={selectedIds.has(account.id)}
                  onToggle={() => toggleSelect(account.id)}
                />
              )) : (
                <EmptyState icon={Mail} title="没有邮箱" text="导入后会显示在这里" />
              )}
            </div>
          </section>
        </aside>

        <main className="space-y-4">
          <section className="panel">
            <div className="grid gap-3 xl:grid-cols-[1fr_260px_116px]">
              <div className="relative">
                <Search className="input-icon" size={17} />
                <input className="field pl-10" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="关键词" />
              </div>
              <input className="field" value={sender} onChange={event => setSender(event.target.value)} placeholder="发件人过滤" />
              <select className="field" value={limit} onChange={event => setLimit(Number(event.target.value))}>
                {[5, 10, 20, 30].map(value => <option key={value} value={value}>{value} 封</option>)}
              </select>
            </div>
            <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="segmented" role="group" aria-label="取件协议">
                <ProtocolToggle label="Graph" value={protocols.graph} onChange={() => setProtocols(prev => ({ ...prev, graph: !prev.graph }))} tone="graph" />
                <ProtocolToggle label="IMAP" value={protocols.imap} onChange={() => setProtocols(prev => ({ ...prev, imap: !prev.imap }))} tone="imap" />
                <ProtocolToggle label="Proton" value={protocols.proton} onChange={() => setProtocols(prev => ({ ...prev, proton: !prev.proton }))} tone="proton" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                {fetching ? (
                  <button className="btn subtle" onClick={() => { abortRef.current.cancelled = true; setFetching(false); }}>
                    <X size={16} />停止
                  </button>
                ) : null}
                <button className="btn secondary" onClick={() => startFetch(selectedAccounts)} disabled={fetching || !selectedAccounts.length}>
                  <RefreshCw size={16} />选中取件
                </button>
                <button className="btn primary" onClick={() => startFetch(accounts)} disabled={fetching || !accounts.length}>
                  <RefreshCw size={16} />全部取件
                </button>
              </div>
            </div>
            {fetching || accountResults.length ? (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-sm text-slate-500">
                  <span>进度</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : null}
          </section>

          <section className="panel p-0">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="tabs" role="tablist">
                <TabButton id="codes" active={activeTab} onClick={setActiveTab} icon={KeyRound} label={`验证码 ${codeItems.codes.length}`} />
                <TabButton id="all" active={activeTab} onClick={setActiveTab} icon={Mail} label={`全部邮件 ${allEmails.length}`} />
                <TabButton id="accounts" active={activeTab} onClick={setActiveTab} icon={Archive} label={`按账号 ${accountResults.length}`} />
              </div>
              <div className="flex flex-wrap gap-2 text-sm text-slate-500">
                <ProtocolCount emails={allEmails} protocol="graph" />
                <ProtocolCount emails={allEmails} protocol="imap" />
                <ProtocolCount emails={allEmails} protocol="proton" />
              </div>
            </div>

            {issues.length ? <IssueSummary issues={issues} /> : null}

            <div className="min-h-[420px] p-3">
              {activeTab === 'codes' ? (
                <CodePanel items={codeItems} onToast={showToast} />
              ) : activeTab === 'all' ? (
                <EmailList emails={allEmails} onOpen={setDetailEmail} />
              ) : (
                <GroupedAccounts results={accountResults} onOpen={setDetailEmail} />
              )}
            </div>
          </section>
        </main>
      </div>

      {importOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold">导入邮箱</h2>
              <button className="icon-button" onClick={() => setImportOpen(false)} aria-label="关闭"><X size={18} /></button>
            </div>
            <div className="space-y-3 p-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Outlook：邮箱----密码----clientid----refresh_token；Proton：邮箱----密码
              </div>
              <textarea className="textarea" rows={10} value={importText} onChange={event => setImportText(event.target.value)} autoFocus />
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="count-badge">有效 {importPreview.accounts.length}</span>
                {importPreview.errors.length ? <span className="error-badge">错误 {importPreview.errors.length}</span> : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button className="btn subtle" onClick={() => setImportOpen(false)}>取消</button>
              <button className="btn primary" onClick={importAccounts}><Check size={16} />导入</button>
            </div>
          </div>
        </div>
      ) : null}

      {detailEmail ? <EmailDetail email={detailEmail} onClose={() => setDetailEmail(null)} /> : null}
      {toast ? <Toast key={toast.id} toast={toast} /> : null}
    </div>
  );
}

function AccountRow({ account, selected, onToggle }) {
  const provider = detectProvider(account);
  return (
    <button className={`account-row ${selected ? 'selected' : ''}`} onClick={onToggle}>
      <span className="checkbox">{selected ? <Check size={14} /> : null}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{account.email}</span>
        <span className={`provider-chip ${provider}`}>{providerLabel(provider)}</span>
      </span>
    </button>
  );
}

function ProtocolToggle({ label, value, onChange, tone }) {
  return (
    <button className={`protocol-toggle ${tone} ${value ? 'on' : ''}`} onClick={onChange} type="button" aria-pressed={value}>
      <span className="toggle-dot" />
      {label}
    </button>
  );
}

function TabButton({ id, active, onClick, icon: Icon, label }) {
  return (
    <button className={`tab ${active === id ? 'active' : ''}`} onClick={() => onClick(id)} role="tab" aria-selected={active === id}>
      <Icon size={16} />
      {label}
    </button>
  );
}

function ProtocolCount({ emails, protocol }) {
  const count = emails.filter(email => email.protocol === protocol).length;
  if (!count) return null;
  return <span className={`protocol-badge ${protocol}`}>{protocolLabel(protocol)} {count}</span>;
}

function CodePanel({ items, onToast }) {
  if (!items.codes.length && !items.links.length) {
    return <EmptyState icon={KeyRound} title="暂无验证码或链接" text="取件后会自动汇总" />;
  }
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {items.codes.map(item => <HighlightCard key={item.key} item={item} onToast={onToast} />)}
      {items.links.map(item => <HighlightCard key={item.key} item={item} onToast={onToast} />)}
    </div>
  );
}

function HighlightCard({ item, onToast }) {
  const [copied, setCopied] = useState(false);
  const isLink = item.type === 'link';
  async function handleCopy() {
    await copyText(item.value, '已复制', onToast);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="highlight-card">
      <div className="highlight-meta">
        <span className="truncate">{item.email.fromName || item.email.from || '邮件来源'}</span>
        <span className="truncate">{item.email._account}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className={`highlight-icon ${isLink ? 'link' : 'code'}`}>{isLink ? <LinkIcon size={16} /> : <KeyRound size={16} />}</span>
        <div className="min-w-0 flex-1">
          <div className={`truncate ${isLink ? 'highlight-url' : 'highlight-code'}`}>{item.value}</div>
          <div className="truncate text-sm text-slate-500">{item.email._account} · {item.email.subject}</div>
        </div>
      </div>
      <div className="highlight-actions">
        <span className="text-xs text-slate-500">{relativeTime(item.email.date)}</span>
        <button className={`copy-button ${copied ? 'copied' : ''}`} onClick={handleCopy} aria-label="复制">
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '已复制' : '复制'}
        </button>
        {isLink ? <a className="icon-button" href={item.value} target="_blank" rel="noreferrer" aria-label="打开链接"><ExternalLink size={17} /></a> : null}
      </div>
    </div>
  );
}

function EmailList({ emails, onOpen }) {
  if (!emails.length) return <EmptyState icon={Mail} title="暂无邮件" text="账号完成后会立即显示" />;
  return (
    <div className="email-table">
      {emails.map((email, index) => <EmailRow key={`${email._account}-${email.messageId || index}`} email={email} onOpen={() => onOpen(email)} />)}
    </div>
  );
}

function EmailRow({ email, onOpen }) {
  const name = email.fromName || email.from || '?';
  return (
    <button className="email-row" onClick={onOpen}>
      <span className="sender-avatar" aria-hidden="true">{name.trim().slice(0, 1).toUpperCase()}</span>
      <span className="star-button" aria-hidden="true"><Star size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="email-line">
          <span className="truncate font-semibold">{name}</span>
          <span className={`protocol-badge ${email.protocol}`}>{protocolLabel(email.protocol)}</span>
          <span className="truncate text-slate-900">{email.subject || '(无主题)'}</span>
        </span>
        <span className="email-subline">
          <span className="truncate">{email._account}</span>
          <span>{formatFolderName(email.folder)}</span>
          <span className="truncate">{email.bodyPreview || email.bodyText || ''}</span>
        </span>
      </span>
      <time className="email-time">{formatDate(email.date)}</time>
    </button>
  );
}

function GroupedAccounts({ results, onOpen }) {
  if (!results.length) return <EmptyState icon={Archive} title="暂无取件结果" text="批量取件后按账号展示" />;
  return (
    <div className="space-y-3">
      {results.map(result => {
        const protocolStates = Object.values(result.protocols || {});
        const visibleStates = protocolStates.some(item => item.success)
          ? protocolStates.filter(item => item.success)
          : protocolStates;

        return (
        <section className="account-result" key={result.id}>
          <div className="account-result-header">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="email-account-marker">#{result.index + 1}</span>
                <span className="truncate font-semibold">{result.email}</span>
                <span className={`provider-chip ${result.provider}`}>{providerLabel(result.provider)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {visibleStates.map(item => (
                  <span key={item.protocol} className={`protocol-state ${item.success ? 'ok' : 'fail'} ${item.protocol}`}>
                    {protocolLabel(item.protocol)} {item.success ? `${item.count} 封` : '失败'}
                  </span>
                ))}
              </div>
            </div>
            <ResultStatus status={result.status} count={result.emails.length} />
          </div>
          {result.error ? <InlineError error={result.error} /> : null}
          {result.emails.length ? <EmailList emails={result.emails.map(email => ({ ...email, _account: result.email, _accountIndex: result.index }))} onOpen={onOpen} /> : null}
        </section>
        );
      })}
    </div>
  );
}

function ResultStatus({ status, count }) {
  if (status === 'running') return <span className="result-status running"><Loader2 className="animate-spin" size={15} />取件中</span>;
  if (status === 'failed') return <span className="result-status failed"><AlertCircle size={15} />失败</span>;
  if (status === 'done') return <span className="result-status done"><Check size={15} />{count} 封</span>;
  return <span className="result-status pending">等待中</span>;
}

function IssueSummary({ issues }) {
  return (
    <div className="issue-summary">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-amber-800"><AlertCircle size={17} />取件失败详情</div>
        <span className="text-sm text-amber-700">{issues.length} 个邮箱/协议</span>
      </div>
      <div className="space-y-2">
        {issues.map((issue, index) => <InlineError key={`${issue.email}-${issue.protocol}-${index}`} error={issue} />)}
      </div>
    </div>
  );
}

function InlineError({ error }) {
  return (
    <details className="inline-error">
      <summary>
        <span className={`protocol-badge ${error.protocol}`}>{protocolLabel(error.protocol)}</span>
        <span className="truncate">{error.email}</span>
        <span className="truncate text-slate-600">{error.error}</span>
        <ChevronDown size={15} />
      </summary>
      <div className="error-body">
        {error.code ? <p><strong>错误码：</strong>{error.code}</p> : null}
        {error.reason ? <p><strong>原因：</strong>{error.reason}</p> : null}
        {error.action ? <p><strong>建议：</strong>{error.action}</p> : null}
        {error.raw ? <pre>{error.raw}</pre> : null}
      </div>
    </details>
  );
}

function EmailDetail({ email, onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal large">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-semibold">{email.subject || '(无主题)'}</h2>
            <p className="mt-1 text-sm text-slate-500">{email.fromName || email.from} · {formatDate(email.date, true)}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-3 text-sm text-slate-600">
          <span className={`protocol-badge ${email.protocol}`}>{protocolLabel(email.protocol)}</span>
          <span>{email._account}</span>
          <span>{formatFolderName(email.folder)}</span>
        </div>
        <div className="max-h-[68vh] overflow-auto p-4">
          {email.bodyHtml ? (
            <iframe title="邮件正文" srcDoc={email.bodyHtml} sandbox="allow-same-origin" className="h-[560px] w-full rounded-md border border-slate-200 bg-white" />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-slate-800">{email.bodyText || email.bodyPreview || '(无内容)'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, text }) {
  return (
    <div className="empty-state">
      <Icon size={34} />
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-slate-500">{text}</p>
    </div>
  );
}

function Toast({ toast }) {
  return (
    <div className={`toast ${toast.tone}`}>
      {toast.tone === 'success' ? <Check size={17} /> : <AlertCircle size={17} />}
      <span>{toast.message}</span>
    </div>
  );
}
