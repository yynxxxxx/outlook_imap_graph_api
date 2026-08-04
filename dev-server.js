/**
 * 本地开发服务器
 * 模拟 Vercel 环境：静态文件 + Serverless Functions
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// MIME 类型映射
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 加载 API 路由处理函数
const apiHandlers = {
  '/api/security-session': require('./api/security-session'),
  '/api/refresh-token': require('./api/refresh-token'),
  '/api/fetch-graph': require('./api/fetch-graph'),
  '/api/fetch-imap': require('./api/fetch-imap'),
  '/api/fetch-proton': require('./api/fetch-proton'),
  '/api/send-graph': require('./api/send-graph'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 处理 API 路由
  if (pathname.startsWith('/api/')) {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const handler = apiHandlers[pathname];
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `API 路由 ${pathname} 不存在` }));
    }

    // 解析请求体
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }

      // 模拟 Vercel 的 res 对象
      const mockRes = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        json(data) {
          res.writeHead(this.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            ...this.headers,
          });
          res.end(JSON.stringify(data));
        },
        end() {
          res.writeHead(this.statusCode, this.headers);
          res.end();
        },
      };

      try {
        await handler(req, mockRes);
      } catch (err) {
        console.error(`API 错误 [${pathname}]:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 静态文件服务
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🚀 开发服务器已启动`);
  console.log(`  📎 地址: http://localhost:${PORT}`);
  console.log(`  📧 API:  http://localhost:${PORT}/api/*`);
  console.log(`  ⏹️  按 Ctrl+C 停止\n`);
});
