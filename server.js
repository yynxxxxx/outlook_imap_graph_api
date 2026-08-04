/**
 * Production server for cloud/VPS deployment.
 * Serves the built frontend from /dist and reuses the existing API handlers.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { toPublicError } = require('./api/lib/error-helper');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UI_VARIANT = process.env.UI_VARIANT === 'legacy' ? 'legacy' : 'modern';
const STATIC_DIR = UI_VARIANT === 'legacy' || !fs.existsSync(DIST_DIR) ? PUBLIC_DIR : DIST_DIR;
const APP_VERSION = require('./package.json').version;
const runtimeFetchEvents = [];
const MAX_RUNTIME_EVENTS = 50000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const apiHandlers = {
  '/api/security-session': require('./api/security-session'),
  '/api/refresh-token': require('./api/refresh-token'),
  '/api/fetch-graph': require('./api/fetch-graph'),
  '/api/fetch-imap': require('./api/fetch-imap'),
  '/api/fetch-proton': require('./api/fetch-proton'),
  '/api/send-graph': require('./api/send-graph'),
  '/api/fetch-stats': handleFetchStats,
  '/api/track-fetch': handleTrackFetch,
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function createVercelLikeResponse(res) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      res.writeHead(this.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        ...this.headers,
      });
      res.end(JSON.stringify(data));
    },
    end(data = '') {
      res.writeHead(this.statusCode, this.headers);
      res.end(data);
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过限制 ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求体不是有效的 JSON'));
      }
    });

    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const handler = apiHandlers[pathname];
  if (!handler) {
    sendJson(res, 404, { success: false, error: `API 路由 ${pathname} 不存在` });
    return;
  }

  try {
    req.body = await readJsonBody(req);
    await handler(req, createVercelLikeResponse(res));
  } catch (err) {
    console.error(`API 错误 [${pathname}]:`, err);
    if (!res.headersSent) {
      const publicError = toPublicError(err);
      sendJson(res, err.statusCode || 500, {
        success: false,
        code: publicError.code,
        error: publicError.message,
        reason: publicError.reason,
        action: publicError.action,
        detail: publicError.detail,
      });
    }
  }
}

function handleFetchStats(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const dayKey = normalizeStatsDayKey(url.searchParams.get('day'));
  res.status(200).json({ success: true, stats: readRuntimeFetchStats(dayKey) });
}

function handleTrackFetch(req, res) {
  const kind = normalizeFetchKind(req.body?.kind);
  if (!kind) {
    res.status(400).json({ success: false, error: '统计类型无效' });
    return;
  }

  const dayKey = normalizeStatsDayKey(req.body?.dayKey);
  runtimeFetchEvents.push({
    kind,
    accountCount: normalizeAccountCount(req.body?.accountCount),
    dayKey,
    createdAt: new Date().toISOString(),
  });
  if (runtimeFetchEvents.length > MAX_RUNTIME_EVENTS) {
    runtimeFetchEvents.splice(0, runtimeFetchEvents.length - MAX_RUNTIME_EVENTS);
  }

  res.status(200).json({ success: true, stats: readRuntimeFetchStats(dayKey) });
}

function readRuntimeFetchStats(dayKey) {
  const totals = runtimeFetchEvents.reduce((acc, event) => {
    acc.totalFetches += 1;
    acc.totalAccounts += event.accountCount;
    if (event.kind === 'outlook') acc.outlookFetches += 1;
    if (event.kind === 'proton') acc.protonFetches += 1;
    if (event.dayKey === dayKey) {
      acc.todayFetches += 1;
      acc.todayAccounts += event.accountCount;
      if (event.kind === 'outlook') acc.todayOutlookFetches += 1;
      if (event.kind === 'proton') acc.todayProtonFetches += 1;
    }
    return acc;
  }, {
    totalFetches: 0,
    todayFetches: 0,
    totalAccounts: 0,
    todayAccounts: 0,
    outlookFetches: 0,
    protonFetches: 0,
    todayOutlookFetches: 0,
    todayProtonFetches: 0,
  });

  return { ...totals, date: dayKey };
}

function normalizeFetchKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'outlook' || kind === 'proton' ? kind : '';
}

function normalizeAccountCount(value) {
  const count = Math.floor(Number(value || 0));
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(count, 1000));
}

function normalizeStatsDayKey(value) {
  const dayKey = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return dayKey;
  return new Date().toISOString().slice(0, 10);
}

function safeStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.normalize(path.join(STATIC_DIR, requestedPath));

  if (!filePath.startsWith(STATIC_DIR)) {
    return null;
  }

  return filePath;
}

function handleStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname);
  const fallbackPath = path.join(STATIC_DIR, 'index.html');
  const resolvedPath = filePath && fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()
    ? filePath
    : (fs.existsSync(fallbackPath) ? fallbackPath : null);

  if (!resolvedPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(resolvedPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(resolvedPath);
    const shouldRevalidate = ext === '.html';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': shouldRevalidate ? 'no-store, max-age=0' : 'public, max-age=31536000, immutable',
      'X-App-Version': APP_VERSION,
      'X-UI-Variant': UI_VARIANT,
    });
    res.end(data);
  } catch (err) {
    console.error('静态文件读取失败:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  handleStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Outlook fetcher is running at http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
