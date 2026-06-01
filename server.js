/**
 * Production server for cloud/VPS deployment.
 * Serves static files from /public and reuses the existing API handlers.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const PUBLIC_DIR = path.join(__dirname, 'public');

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
  '/api/send-graph': require('./api/send-graph'),
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
      sendJson(res, 500, { success: false, error: err.message || '服务器内部错误' });
    }
  }
}

function safePublicPath(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return filePath;
}

function handleStatic(req, res, pathname) {
  const filePath = safePublicPath(pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    const shouldRevalidate = ['.html', '.css', '.js'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': shouldRevalidate ? 'no-cache' : 'public, max-age=3600',
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
