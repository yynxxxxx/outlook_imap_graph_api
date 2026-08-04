import {
  AlertCircle,
  Archive,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Inbox,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_VERSION,
  copyText,
  deduplicateEmails,
  detectProvider,
  downloadTextFile,
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
  readAccounts,
  relativeTime,
  runPool,
  secureApiFetch,
} from './lib/mail.js';

const ROUTES = [
  { key: 'overview', path: '/overview', label: '概览' },
  { key: 'outlook', path: '/outlook', label: 'Outlook 取件' },
  { key: 'proton', path: '/proton', label: 'Proton 取件' },
];

const ROUTE_BY_KEY = Object.fromEntries(ROUTES.map(route => [route.key, route]));
const RESULT_TABS = ['codes', 'all', 'accounts'];

function getRouteFromLocation() {
  if (window.location.pathname === '/overview') return 'overview';
  if (window.location.pathname === '/proton') return 'proton';
  if (window.location.pathname === '/outlook') return 'outlook';
  return 'outlook';
}

function currentDayKey() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function createEmptyFetchStats() {
  return {
    totalFetches: 0,
    todayFetches: 0,
    totalAccounts: 0,
    todayAccounts: 0,
    outlookFetches: 0,
    protonFetches: 0,
    todayOutlookFetches: 0,
    todayProtonFetches: 0,
    date: currentDayKey(),
  };
}

function normalizeStats(stats = {}) {
  const fallback = createEmptyFetchStats();
  return {
    ...fallback,
    ...stats,
    totalFetches: Number(stats.totalFetches || 0),
    todayFetches: Number(stats.todayFetches || 0),
    totalAccounts: Number(stats.totalAccounts || 0),
    todayAccounts: Number(stats.todayAccounts || 0),
    outlookFetches: Number(stats.outlookFetches || 0),
    protonFetches: Number(stats.protonFetches || 0),
    todayOutlookFetches: Number(stats.todayOutlookFetches || 0),
    todayProtonFetches: Number(stats.todayProtonFetches || 0),
    date: stats.date || fallback.date,
  };
}

function readActiveResultTab(kind) {
  try {
    const value = localStorage.getItem(`mail_result_tab_${kind}`);
    return RESULT_TABS.includes(value) ? value : 'codes';
  } catch {
    return 'codes';
  }
}

function persistActiveResultTab(kind, tab) {
  if (!RESULT_TABS.includes(tab)) return;
  try {
    localStorage.setItem(`mail_result_tab_${kind}`, tab);
  } catch {
    // 页签记忆失败不影响取件。
  }
}

export default function App() {
  const [route, setRoute] = useState(getRouteFromLocation);
  const [toast, setToast] = useState(null);
  const [fetchStats, setFetchStats] = useState(createEmptyFetchStats);
  const toastTimersRef = useRef([]);

  const showToast = useCallback((message, tone = 'info') => {
    toastTimersRef.current.forEach(timer => window.clearTimeout(timer));
    toastTimersRef.current = [];

    const id = Date.now();
    setToast({ id, message, tone, leaving: false });

    const leaveTimer = window.setTimeout(() => {
      setToast(current => current?.id === id ? { ...current, leaving: true } : current);
    }, 2600);
    const removeTimer = window.setTimeout(() => {
      setToast(current => current?.id === id ? null : current);
    }, 2800);
    toastTimersRef.current = [leaveTimer, removeTimer];
  }, []);

  const recordFetch = useCallback(async (kind, accountCount) => {
    try {
      const response = await fetch('/api/track-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, accountCount, dayKey: currentDayKey() }),
      });
      const data = await response.json();
      if (response.ok && data.success !== false) {
        setFetchStats(normalizeStats(data.stats || data));
      }
    } catch {
      // 统计失败不影响真实取件。
    }
  }, []);

  const outlook = useMailboxController('outlook', showToast, recordFetch);
  const proton = useMailboxController('proton', showToast, recordFetch);
  const activeStatus = route === 'proton'
    ? proton.status
    : route === 'outlook'
      ? outlook.status
      : { tone: 'ready', text: '就绪' };

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await fetch(`/api/fetch-stats?day=${encodeURIComponent(currentDayKey())}`);
        const data = await response.json();
        if (!cancelled && response.ok && data.success !== false) {
          setFetchStats(normalizeStats(data.stats || data));
        }
      } catch {
        // 本地或网络异常时保留默认统计，不阻塞主流程。
      }
    }

    loadStats();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname === '/') {
      window.history.replaceState({ route: 'outlook' }, '', '/outlook');
      setRoute('outlook');
    } else if (!['/overview', '/outlook', '/proton'].includes(window.location.pathname)) {
      window.history.replaceState({ route: 'outlook' }, '', '/outlook');
      setRoute('outlook');
    }

    function handlePopState() {
      setRoute(getRouteFromLocation());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    document.title = route === 'overview' ? '邮箱取件系统' : `${ROUTE_BY_KEY[route]?.label || '邮箱取件系统'} - 邮箱取件系统`;
  }, [route]);

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach(timer => window.clearTimeout(timer));
    };
  }, []);

  function navigate(nextRoute) {
    if (nextRoute === route) return;
    const next = ROUTE_BY_KEY[nextRoute] || ROUTE_BY_KEY.outlook;
    window.history.pushState({ route: next.key }, '', next.path);
    setRoute(next.key);
  }

  return (
    <div className="app-shell min-h-dvh text-slate-900">
      <TopNav route={route} status={activeStatus} onNavigate={navigate} />

      <main key={route} className="route-panel mx-auto max-w-[1680px] px-3 pb-5 pt-4 sm:px-5 lg:px-6" id="main-content">
        {route === 'overview' ? (
          <OverviewPage stats={fetchStats} outlook={outlook} proton={proton} onNavigate={navigate} />
        ) : (
          <MailboxPage controller={route === 'proton' ? proton : outlook} />
        )}
      </main>

      {toast ? <Toast key={toast.id} toast={toast} /> : null}
    </div>
  );
}

function useMailboxController(kind, showToast, recordFetch) {
  const [accounts, setAccounts] = useState(() => normalizeAccounts(readAccounts(kind)).filter(account => detectProvider(account) === kind));
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [accountQuery, setAccountQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sender, setSender] = useState('');
  const [limit, setLimit] = useState(10);
  const [protocols, setProtocols] = useState(() => (
    kind === 'proton'
      ? { graph: false, imap: false, proton: true }
      : { graph: true, imap: true, proton: false }
  ));
  const [status, setStatus] = useState({ tone: 'ready', text: '就绪' });
  const [fetching, setFetching] = useState(false);
  const [activeTab, setActiveTabState] = useState(() => readActiveResultTab(kind));
  const [accountResults, setAccountResults] = useState([]);
  const [issues, setIssues] = useState([]);
  const [detailEmail, setDetailEmail] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const abortRef = useRef({ cancelled: false });

  useEffect(() => {
    persistAccounts(accounts, kind);
  }, [accounts, kind]);

  useEffect(() => {
    persistActiveResultTab(kind, activeTab);
  }, [activeTab, kind]);

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
  const selectedAccounts = useMemo(() => accounts.filter(account => selectedIds.has(account.id)), [accounts, selectedIds]);
  const resultById = useMemo(() => {
    return new Map(accountResults.map(result => [result.id, result]));
  }, [accountResults]);
  const completedCount = accountResults.filter(item => ['done', 'failed'].includes(item.status)).length;
  const progress = accountResults.length ? Math.round((completedCount / accountResults.length) * 100) : 0;

  function updateAccounts(nextAccounts) {
    setAccounts(normalizeAccounts(nextAccounts).filter(account => detectProvider(account) === kind));
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
    if (!selectedIds.size) return;
    setDeleteConfirmOpen(true);
  }

  function confirmDeleteSelected() {
    if (!selectedIds.size) {
      setDeleteConfirmOpen(false);
      return;
    }
    const count = selectedIds.size;
    updateAccounts(accounts.filter(account => !selectedIds.has(account.id)));
    setSelectedIds(new Set());
    setDeleteConfirmOpen(false);
    showToast(`已删除 ${count} 个${pageCopy(kind).accountName}`, 'success');
  }

  function setActiveTab(tab) {
    if (RESULT_TABS.includes(tab)) setActiveTabState(tab);
  }

  function importAccounts() {
    const parsed = parseImportText(importText);
    const scoped = parsed.accounts.filter(account => detectProvider(account) === kind);
    const skipped = parsed.accounts.length - scoped.length;

    if (scoped.length === 0) {
      showToast(parsed.errors[0] || `未识别到有效${pageCopy(kind).accountName}`, 'error');
      return;
    }

    const existing = new Set(accounts.map(account => account.email.toLowerCase()));
    const unique = scoped.filter(account => !existing.has(account.email.toLowerCase()));
    updateAccounts([...accounts, ...unique]);
    setImportText('');
    setImportOpen(false);
    showToast(`已导入 ${unique.length} 个${pageCopy(kind).accountName}${skipped ? `，跳过 ${skipped} 个其他类型账号` : ''}`, 'success');
  }

  function exportAccounts() {
    const target = selectedAccounts.length ? selectedAccounts : accounts;
    const text = target.map(formatAccountForExport).join('\n');
    if (!text) return;
    const filename = `${kind}-accounts-${timestampForFilename()}.txt`;
    downloadTextFile(text, filename);
    showToast(`${selectedAccounts.length ? '选中账号' : '全部账号'}已导出为 txt`, 'success');
  }

  async function startFetch(targetAccounts) {
    const runnable = targetAccounts.filter(account => enabledProtocolsForAccount(account, protocols).length > 0);
    if (!runnable.length) {
      showToast('当前选择没有可用协议', 'warning');
      return;
    }

    abortRef.current.cancelled = false;
    recordFetch?.(kind, runnable.length);
    setFetching(true);
    setIssues([]);
    setDetailEmail(null);
    setStatus({ tone: 'loading', text: `取件中 ${runnable.length} 个账号` });
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

  function stopFetch() {
    abortRef.current.cancelled = true;
    setFetching(false);
    setStatus({ tone: 'ready', text: '已停止' });
  }

  return {
    kind,
    accounts,
    visibleAccounts,
    selectedIds,
    selectedAccounts,
    selectedCount: selectedIds.size,
    accountQuery,
    setAccountQuery,
    importOpen,
    setImportOpen,
    importText,
    setImportText,
    importPreview: parseImportText(importText),
    keyword,
    setKeyword,
    sender,
    setSender,
    limit,
    setLimit,
    protocols,
    setProtocols,
    status,
    fetching,
    activeTab,
    setActiveTab,
    accountResults,
    resultById,
    allEmails,
    codeItems,
    issues,
    detailEmail,
    setDetailEmail,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    progress,
    completedCount,
    toggleSelect,
    selectAllVisible,
    deleteSelected,
    confirmDeleteSelected,
    importAccounts,
    exportAccounts,
    startFetch,
    stopFetch,
    showToast,
  };
}

function TopNav({ route, status, onNavigate }) {
  return (
    <header className="top-nav sticky top-0 z-40">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-3 py-3 sm:px-5 lg:flex-row lg:items-center lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button className={`brand-mark ${route === 'overview' ? 'active' : ''}`} onClick={() => onNavigate('overview')} type="button" aria-label="打开概览">
            <Inbox size={22} />
          </button>
          <button className="brand-title min-w-0" onClick={() => onNavigate('overview')} type="button">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-bold leading-tight text-slate-950 sm:text-xl">邮箱取件系统</h1>
              <span className="version-badge">v{APP_VERSION}</span>
            </div>
          </button>
        </div>

        <nav className="nav-switch" aria-label="邮箱取件页面">
          {ROUTES.map(item => (
            <a
              key={item.key}
              aria-current={route === item.key ? 'page' : undefined}
              className={`nav-link ${route === item.key ? 'active' : ''}`}
              href={item.path}
              onClick={event => {
                event.preventDefault();
                onNavigate(item.key);
              }}
            >
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className={`status-pill ${status.tone}`} aria-live="polite">
          {status.tone === 'loading' ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
          <span>{status.text}</span>
        </div>
      </div>
    </header>
  );
}

function OverviewPage({ stats, outlook, proton, onNavigate }) {
  const supportItems = [
    'Outlook / Hotmail IMAP OAuth2',
    'Microsoft Graph 邮件取件',
    'Proton Mail API 取件',
  ];

  return (
    <div className="overview-layout">
      <section className="glass-panel overview-hero">
        <div className="overview-copy">
          <span className="overview-kicker">专业邮箱取件网站</span>
          <h2>统一处理 Outlook、Hotmail 与 Proton 邮箱取件</h2>
          <p>
            当前支持 Outlook、Hotmail 的 IMAP OAuth2 与 Microsoft Graph 取件协议，也支持 Proton 邮箱取件协议。
          </p>
          <div className="support-list">
            {supportItems.map(item => <span key={item}>{item}</span>)}
          </div>
        </div>
        <div className="overview-actions">
          <button className="btn primary" onClick={() => onNavigate('outlook')} type="button">Outlook 取件</button>
          <button className="btn secondary" onClick={() => onNavigate('proton')} type="button">Proton 取件</button>
        </div>
      </section>

      <section className="overview-stats" aria-label="取件统计">
        <OverviewStat label="累计取件次数" value={stats.totalFetches || 0} />
        <OverviewStat label="今日取件次数" value={stats.todayFetches || 0} />
        <OverviewStat label="累计处理账号" value={stats.totalAccounts || 0} />
        <OverviewStat label="今日处理账号" value={stats.todayAccounts || 0} />
      </section>

      <section className="overview-cards">
        <button className="overview-card" onClick={() => onNavigate('outlook')} type="button">
          <span className="overview-card-icon outlook"><Mail size={20} /></span>
          <span>
            <strong>Outlook 取件</strong>
            <small>{outlook.accounts.length} 个账号 · Graph / IMAP</small>
          </span>
        </button>
        <button className="overview-card" onClick={() => onNavigate('proton')} type="button">
          <span className="overview-card-icon proton"><ShieldCheck size={20} /></span>
          <span>
            <strong>Proton 取件</strong>
            <small>{proton.accounts.length} 个账号 · Proton API</small>
          </span>
        </button>
      </section>
    </div>
  );
}

function OverviewStat({ label, value }) {
  return (
    <div className="glass-panel overview-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MailboxPage({ controller }) {
  const copy = pageCopy(controller.kind);
  const allVisibleSelected = controller.visibleAccounts.length > 0
    && controller.visibleAccounts.every(account => controller.selectedIds.has(account.id));

  return (
    <div className="mail-layout">
      <aside className="sidebar-column">
        <section className="glass-panel account-panel">
          <div className="panel-title-row">
            <div className="title-with-icon">
              <Archive size={18} />
              <span>{copy.accountListTitle}</span>
            </div>
            <span className="count-badge">{controller.visibleAccounts.length}/{controller.accounts.length}</span>
          </div>

          <div className="relative mb-3">
            <Search className="input-icon" size={17} />
            <input
              aria-label={`搜索${copy.accountName}`}
              className="field with-icon"
              value={controller.accountQuery}
              onChange={event => controller.setAccountQuery(event.target.value)}
              placeholder={`搜索${copy.accountName}`}
            />
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <button className="btn primary" onClick={() => controller.setImportOpen(true)} type="button">
              <Upload size={16} />
              导入
            </button>
            <button className="btn subtle" onClick={controller.exportAccounts} disabled={!controller.accounts.length} type="button">
              <Download size={16} />
              导出
            </button>
          </div>

          <div className="selection-bar">
            <button className="text-button" onClick={controller.selectAllVisible} type="button">
              {allVisibleSelected ? '取消全选' : '全选'}
            </button>
            <button className="text-button danger" onClick={controller.deleteSelected} disabled={!controller.selectedCount} type="button">
              <Trash2 size={15} />
              删除 {controller.selectedCount || ''}
            </button>
          </div>

          <div className="account-list">
            {controller.visibleAccounts.length ? controller.visibleAccounts.map(account => (
              <AccountRow
                key={account.id}
                account={account}
                result={controller.resultById.get(account.id)}
                selected={controller.selectedIds.has(account.id)}
                onToggle={() => controller.toggleSelect(account.id)}
                onToast={controller.showToast}
              />
            )) : (
              <EmptyState icon={Mail} title={`没有${copy.accountName}`} text="导入后会显示在这里" compact />
            )}
          </div>
        </section>
      </aside>

      <section className="workspace-column">
        <section className="glass-panel toolbar-panel">
          <div className="toolbar-heading">
            <div>
              <h2>{copy.pageTitle}</h2>
            </div>
            <div className="toolbar-stats">
              <span>{controller.accounts.length} 个账号</span>
              <span>{controller.allEmails.length} 封邮件</span>
            </div>
          </div>

          <div className="toolbar-grid">
            <div className="relative">
              <Search className="input-icon" size={17} />
              <input
                aria-label="邮件关键词过滤"
                className="field with-icon"
                value={controller.keyword}
                onChange={event => controller.setKeyword(event.target.value)}
                placeholder="关键词"
              />
            </div>
            <input
              aria-label="发件人过滤"
              className="field"
              value={controller.sender}
              onChange={event => controller.setSender(event.target.value)}
              placeholder="发件人过滤"
            />
            <select
              aria-label="每个账号取件数量"
              className="field"
              value={controller.limit}
              onChange={event => controller.setLimit(Number(event.target.value))}
            >
              {[5, 10, 20, 30].map(value => <option key={value} value={value}>{value} 封</option>)}
            </select>
          </div>

          <div className="fetch-row">
            <ProtocolControls controller={controller} />
            <div className="fetch-actions">
              {controller.fetching ? (
                <button className="btn subtle" onClick={controller.stopFetch} type="button">
                  <X size={16} />
                  停止
                </button>
              ) : null}
              <button
                className="btn secondary"
                onClick={() => controller.startFetch(controller.selectedAccounts)}
                disabled={controller.fetching || !controller.selectedAccounts.length}
                type="button"
              >
                <RefreshCw size={16} />
                选中取件
              </button>
            </div>
          </div>

          {controller.fetching || controller.accountResults.length ? (
            <ProgressStrip progress={controller.progress} completed={controller.completedCount} total={controller.accountResults.length} loading={controller.fetching} />
          ) : null}
        </section>

        <section className="glass-panel results-panel p-0">
          <div className="results-head">
            <div className="tabs" role="tablist" aria-label={`${copy.pageTitle}结果视图`}>
              <TabButton
                id="codes"
                active={controller.activeTab}
                onClick={controller.setActiveTab}
                icon={KeyRound}
                label="服务验证码"
                count={controller.codeItems.codes.length}
              />
              <TabButton id="all" active={controller.activeTab} onClick={controller.setActiveTab} icon={Mail} label="全部邮件" count={controller.allEmails.length} />
              <TabButton id="accounts" active={controller.activeTab} onClick={controller.setActiveTab} icon={Archive} label="按账号分组" count={controller.accountResults.length} />
            </div>
          </div>

          {controller.issues.length ? <IssueSummary issues={controller.issues} /> : null}

          <div
            id={`panel-${controller.kind}-${controller.activeTab}`}
            className="result-body"
            role="tabpanel"
            aria-labelledby={`tab-${controller.kind}-${controller.activeTab}`}
            aria-live="polite"
          >
            {controller.activeTab === 'codes' ? (
              <CodePanel items={controller.codeItems} loading={controller.fetching} onToast={controller.showToast} />
            ) : controller.activeTab === 'all' ? (
              <EmailList emails={controller.allEmails} activeEmail={controller.detailEmail} loading={controller.fetching} onOpen={controller.setDetailEmail} />
            ) : (
              <GroupedAccounts results={controller.accountResults} activeEmail={controller.detailEmail} loading={controller.fetching} onOpen={controller.setDetailEmail} />
            )}
          </div>
        </section>
      </section>

      {controller.importOpen ? <ImportModal controller={controller} /> : null}
      {controller.deleteConfirmOpen ? <DeleteConfirmModal controller={controller} /> : null}
      {controller.detailEmail ? <EmailDetail email={controller.detailEmail} onClose={() => controller.setDetailEmail(null)} /> : null}
    </div>
  );
}

function ProtocolControls({ controller }) {
  if (controller.kind === 'proton') {
    return (
      <div className="segmented single" role="group" aria-label="取件协议">
        <ProtocolToggle
          label="Proton API"
          value={controller.protocols.proton}
          onChange={() => controller.setProtocols(prev => ({ ...prev, proton: !prev.proton }))}
          tone="proton"
        />
      </div>
    );
  }

  return (
    <div className="segmented" role="group" aria-label="取件协议">
      <ProtocolToggle
        label="Graph"
        value={controller.protocols.graph}
        onChange={() => controller.setProtocols(prev => ({ ...prev, graph: !prev.graph }))}
        tone="graph"
      />
      <ProtocolToggle
        label="IMAP"
        value={controller.protocols.imap}
        onChange={() => controller.setProtocols(prev => ({ ...prev, imap: !prev.imap }))}
        tone="imap"
      />
    </div>
  );
}

function AccountRow({ account, result, selected, onToggle, onToast }) {
  function handleKeyDown(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle();
  }

  function handleCopy(event) {
    event.stopPropagation();
    copyText(account.email, '邮箱已复制', onToast);
  }

  return (
    <div
      className={`account-row ${result?.status || ''} ${selected ? 'selected' : ''}`}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
    >
      <span className="checkbox">{selected ? <Check size={14} /> : null}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-semibold">{account.email}</span>
        <span className="account-subline">
          {result ? <MiniResultStatus result={result} /> : null}
        </span>
      </span>
      <button
        className="account-copy-button icon-button compact"
        onClick={handleCopy}
        type="button"
        aria-label={`复制邮箱 ${account.email}`}
        title="复制邮箱"
      >
        <Copy size={15} />
      </button>
    </div>
  );
}

function MiniResultStatus({ result }) {
  if (result.status === 'running') return <span className="mini-status running">取件中</span>;
  if (result.status === 'done') return <span className="mini-status done">{result.emails.length} 封</span>;
  if (result.status === 'failed') return <span className="mini-status failed">失败</span>;
  return <span className="mini-status pending">等待</span>;
}

function ProtocolToggle({ label, value, onChange, tone }) {
  return (
    <button className={`protocol-toggle ${tone} ${value ? 'on' : ''}`} onClick={onChange} type="button" aria-pressed={value}>
      <span className="toggle-dot" />
      {label}
    </button>
  );
}

function ProgressStrip({ progress, completed, total, loading }) {
  return (
    <div className={`progress-strip ${loading ? 'loading' : ''}`}>
      <div className="progress-copy">
        <span>取件进度</span>
        <span>{completed}/{total} · {progress}%</span>
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-bar" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function TabButton({ id, active, onClick, icon: Icon, label, count }) {
  return (
    <button
      id={`tab-${id}`}
      aria-controls={`panel-${id}`}
      aria-selected={active === id}
      className={`tab ${active === id ? 'active' : ''}`}
      onClick={() => onClick(id)}
      role="tab"
      type="button"
    >
      <Icon size={16} />
      {label}
      <span className="tab-count">{count}</span>
    </button>
  );
}

function ProtocolCount({ emails, protocol }) {
  const count = emails.filter(email => email.protocol === protocol).length;
  if (!count) return null;
  return <span className={`protocol-badge ${protocol}`}>{protocolLabel(protocol)} {count}</span>;
}

function CodePanel({ items, loading, onToast }) {
  if (!items.codes.length && !items.links.length) {
    return loading
      ? <SkeletonList rows={6} />
      : <EmptyState icon={KeyRound} title="暂无验证码" text="取件完成后，每个服务最新的验证码会展示在这里。" />;
  }
  return (
    <div className="highlight-grid">
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
    <div className={`highlight-card service-tone-${item.colorIndex ?? 0}`}>
      <div className="highlight-meta">
        <span className="truncate">{item.service || item.email.fromName || item.email.from || '邮件来源'}</span>
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
        <button
          className={`copy-button ${copied ? 'copied' : ''}`}
          onClick={handleCopy}
          type="button"
          aria-label={isLink ? '复制验证链接' : '复制验证码'}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '已复制' : isLink ? '复制链接' : '复制验证码'}
        </button>
        {isLink ? <a className="icon-button compact" href={item.value} target="_blank" rel="noreferrer" aria-label="打开链接"><ExternalLink size={17} /></a> : null}
      </div>
    </div>
  );
}

function EmailList({ emails, activeEmail, loading, onOpen }) {
  if (!emails.length) {
    return loading ? <SkeletonList rows={8} /> : <EmptyState icon={Mail} title="暂无邮件" text="账号完成后会立即显示" />;
  }

  return (
    <div className="email-table">
      {emails.map((email, index) => (
        <EmailRow
          key={`${email._account}-${email.messageId || email.id || index}`}
          email={email}
          index={index}
          selected={Boolean(activeEmail && (activeEmail.messageId || activeEmail.id) === (email.messageId || email.id))}
          onOpen={() => onOpen(email)}
        />
      ))}
    </div>
  );
}

function EmailRow({ email, index, selected, onOpen }) {
  const name = email.fromName || email.from || '?';
  const preview = email.bodyPreview || email.bodyText || '';
  const subject = email.subject || '(无主题)';
  const unread = email.isRead === false || email.read === false || email.unread === true;

  return (
    <button
      className={`email-row ${unread ? 'unread' : 'read'} ${selected ? 'selected' : ''}`}
      onClick={onOpen}
      style={{ '--row-index': Math.min(index, 12) }}
      type="button"
      aria-label={`打开邮件：${subject}，来自 ${name}`}
    >
      <span className="email-sender">
        <span className="truncate sender-name">{name}</span>
        <span className="truncate email-account">{email._account}</span>
      </span>
      <span className="email-content">
        <span className="email-subject truncate">{subject}</span>
        {preview ? <span className="email-preview truncate">{preview}</span> : null}
      </span>
      <span className="email-time">
        <time>{formatDate(email.date)}</time>
      </span>
    </button>
  );
}

function GroupedAccounts({ results, activeEmail, loading, onOpen }) {
  if (!results.length) {
    return loading ? <SkeletonList rows={7} /> : <EmptyState icon={Archive} title="暂无取件结果" text="批量取件后按账号展示" />;
  }

  return (
    <div className="grouped-results">
      {results.map(result => {
        const protocolStates = Object.values(result.protocols || {});
        const visibleStates = protocolStates.some(item => item.success)
          ? protocolStates.filter(item => item.success)
          : protocolStates;

        return (
          <section className={`account-result ${result.status}`} key={result.id}>
            <div className="account-result-header">
              <div className="min-w-0">
                <div className="account-result-title">
                  <span className="email-account-marker">#{result.index + 1}</span>
                  <span className="truncate font-semibold">{result.email}</span>
                </div>
                <div className="protocol-state-row">
                  {visibleStates.length ? visibleStates.map(item => (
                    <span key={item.protocol} className={`protocol-state ${item.success ? 'ok' : 'fail'} ${item.protocol}`}>
                      {protocolLabel(item.protocol)} {item.success ? `${item.count} 封` : '失败'}
                    </span>
                  )) : <span className="protocol-state pending">等待取件</span>}
                </div>
              </div>
              <ResultStatus status={result.status} count={result.emails.length} />
            </div>
            {result.error ? <InlineError error={result.error} /> : null}
            {result.emails.length ? (
              <EmailList
                emails={result.emails.map(email => ({ ...email, _account: result.email, _accountIndex: result.index }))}
                activeEmail={activeEmail}
                loading={false}
                onOpen={onOpen}
              />
            ) : null}
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
      <div className="issue-summary-head">
        <div className="title-with-icon text-amber-900"><AlertCircle size={17} />取件失败详情</div>
        <span className="text-sm text-amber-700">{issues.length} 个账号/协议</span>
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

function ImportModal({ controller }) {
  const copy = pageCopy(controller.kind);

  return (
    <AnimatedModal label={`导入${copy.accountName}`} onClose={() => controller.setImportOpen(false)}>
      {close => (
        <>
          <div className="modal-head">
            <h2>导入{copy.accountName}</h2>
            <button className="icon-button compact" onClick={close} aria-label="关闭" type="button"><X size={18} /></button>
          </div>
          <div className="modal-content">
            <div className="import-help">
              {copy.importHelp}
            </div>
            <textarea
              aria-label={`批量导入${copy.accountName}`}
              className="textarea"
              rows={10}
              value={controller.importText}
              onChange={event => controller.setImportText(event.target.value)}
              autoFocus
            />
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="count-badge">有效 {controller.importPreview.accounts.filter(account => detectProvider(account) === controller.kind).length}</span>
              {controller.importPreview.errors.length ? <span className="error-badge">错误 {controller.importPreview.errors.length}</span> : null}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn subtle" onClick={close} type="button">取消</button>
            <button className="btn primary" onClick={controller.importAccounts} type="button"><Check size={16} />导入</button>
          </div>
        </>
      )}
    </AnimatedModal>
  );
}

function DeleteConfirmModal({ controller }) {
  const copy = pageCopy(controller.kind);
  const preview = controller.selectedAccounts.slice(0, 6);
  const hiddenCount = Math.max(0, controller.selectedAccounts.length - preview.length);

  return (
    <AnimatedModal label={`确认删除${copy.accountName}`} onClose={() => controller.setDeleteConfirmOpen(false)}>
      {close => (
        <>
          <div className="modal-head">
            <div className="title-with-icon min-w-0 text-amber-900">
              <AlertCircle size={18} />
              <h2>确认删除{copy.accountName}</h2>
            </div>
            <button className="icon-button compact" onClick={close} aria-label="关闭" type="button"><X size={18} /></button>
          </div>
          <div className="modal-content">
            <p className="confirm-copy">
              将从当前页面删除选中的 {controller.selectedAccounts.length} 个{copy.accountName}。邮箱数据仍只保存在本地浏览器，删除后如需恢复需要重新导入。
            </p>
            <div className="delete-preview-list" aria-label="将删除的邮箱">
              {preview.map(account => <span key={account.id} className="truncate">{account.email}</span>)}
              {hiddenCount ? <span className="muted">另有 {hiddenCount} 个未显示</span> : null}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn subtle" onClick={close} type="button">取消</button>
            <button className="btn danger" onClick={controller.confirmDeleteSelected} type="button">
              <Trash2 size={16} />
              确认删除
            </button>
          </div>
        </>
      )}
    </AnimatedModal>
  );
}

function EmailDetail({ email, onClose }) {
  return (
    <AnimatedModal label="邮件详情" size="large" onClose={onClose}>
      {close => (
        <>
          <div className="modal-head detail-head">
            <div className="min-w-0">
              <h2 className="truncate">{email.subject || '(无主题)'}</h2>
              <p className="mt-1 truncate text-sm text-slate-500">{email.fromName || email.from} · {formatDate(email.date, true)}</p>
            </div>
            <button className="icon-button compact" onClick={close} aria-label="关闭" type="button"><X size={18} /></button>
          </div>
          <div className="detail-meta">
            <span className={`protocol-badge ${email.protocol}`}>{protocolLabel(email.protocol)}</span>
            <span className="truncate">{email._account}</span>
            <span>{formatFolderName(email.folder)}</span>
          </div>
          <div className="mail-body-scroll">
            {email.bodyHtml ? (
              <iframe title="邮件正文" srcDoc={email.bodyHtml} sandbox="allow-same-origin" className="mail-frame" />
            ) : (
              <pre className="mail-text">{email.bodyText || email.bodyPreview || '(无内容)'}</pre>
            )}
          </div>
        </>
      )}
    </AnimatedModal>
  );
}

function AnimatedModal({ label, size = 'standard', onClose, children }) {
  const [closing, setClosing] = useState(false);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 180);
  }, [closing, onClose]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') requestClose();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  return (
    <div
      className={`modal-backdrop ${closing ? 'closing' : 'opening'}`}
      role="dialog"
      aria-label={label}
      aria-modal="true"
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className={`modal ${size} ${closing ? 'closing' : 'opening'}`}>
        {children(requestClose)}
      </div>
    </div>
  );
}

function timestampForFilename() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function SkeletonList({ rows = 6 }) {
  return (
    <div className="email-table skeleton-table" aria-label="邮件加载中">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="email-row skeleton-row" key={index}>
          <span className="skeleton sender" />
          <span className="skeleton subject" />
          <span className="skeleton time" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, text, compact = false }) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <Icon size={compact ? 28 : 34} />
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-slate-500">{text}</p>
    </div>
  );
}

function Toast({ toast }) {
  return (
    <div className={`toast ${toast.tone} ${toast.leaving ? 'leaving' : ''}`} role="status" aria-live="polite">
      {toast.tone === 'success' ? <Check size={17} /> : <AlertCircle size={17} />}
      <span>{toast.message}</span>
    </div>
  );
}

function pageCopy(kind) {
  if (kind === 'proton') {
    return {
      pageTitle: 'Proton 取件',
      pageHint: '只显示 Proton 账号、Proton API 取件和 Proton 邮件。',
      accountName: '邮箱',
      accountListTitle: '邮箱列表',
      importHelp: 'Proton：邮箱----密码；已保存会话时也兼容 邮箱----密码----uid----refresh_token。',
      protocols: ['proton'],
    };
  }

  return {
    pageTitle: 'Outlook 取件',
    pageHint: '只显示 Outlook 邮箱、Graph/IMAP 取件和 Outlook 邮件。',
    accountName: '邮箱',
    accountListTitle: '邮箱列表',
    importHelp: 'Outlook：邮箱----密码----clientid----refresh_token。',
    protocols: ['graph', 'imap'],
  };
}
