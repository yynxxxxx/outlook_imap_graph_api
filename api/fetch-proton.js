/**
 * Proton Mail API 取件接口
 * POST /api/fetch-proton
 *
 * Uses the existing Python Proton protocol implementation for SRP login,
 * mailbox fetching and PGP body decryption.
 */

const path = require('path');
const { spawn } = require('child_process');
const { toPublicError } = require('./lib/error-helper');
const { unwrapSecureBody } = require('./lib/security-helper');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PROTON_TIMEOUT_MS = Number(process.env.PROTON_FETCH_TIMEOUT_MS || 120000);
const ADAPTER_PATH = path.join(__dirname, '..', 'proton_api.py');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, protocol: 'proton', error: '仅支持 POST 请求', emails: [] });
  }

  try {
    req.body = await unwrapSecureBody(req.body);
    const data = await runProtonAdapter(req.body);

    if (!data.success) {
      return res.status(data.statusCode || 200).json({
        success: false,
        protocol: 'proton',
        code: data.code || 'PROTON_FETCH_FAILED',
        error: data.error || 'Proton API 取件失败',
        reason: data.reason || 'Proton API 返回了失败结果',
        action: data.action || '请检查 Proton 账号、密码、会话令牌和网络代理设置后重试',
        emails: [],
      });
    }

    return res.status(200).json({
      success: true,
      protocol: 'proton',
      count: data.emails?.length || 0,
      emails: data.emails || [],
      session: data.session || null,
    });
  } catch (err) {
    console.error('Proton 取件错误:', err);
    const publicError = toPublicError(err, 'proton');
    return res.status(err.statusCode || 200).json({
      success: false,
      protocol: 'proton',
      code: publicError.code,
      error: publicError.message,
      reason: publicError.reason,
      action: publicError.action,
      detail: publicError.detail,
      emails: [],
    });
  }
};

function runProtonAdapter(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [ADAPTER_PATH], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const err = new Error('Proton API 取件超时');
      err.code = 'PROTON_TIMEOUT';
      reject(err);
    }, PROTON_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const output = stdout.trim();
      if (!output) {
        const err = new Error(`Proton adapter 没有返回 JSON${stderr ? `: ${redact(stderr)}` : ''}`);
        err.code = 'PROTON_ADAPTER_EMPTY';
        reject(err);
        return;
      }

      try {
        const lines = output.split(/\r?\n/).filter(Boolean);
        const data = JSON.parse(lines[lines.length - 1]);
        if (code !== 0 && data.success !== false) {
          const err = new Error(`Proton adapter 退出码 ${code}`);
          err.code = 'PROTON_ADAPTER_EXIT';
          reject(err);
          return;
        }
        resolve(data);
      } catch (parseErr) {
        const err = new Error(`Proton adapter 返回非 JSON: ${redact(output).slice(0, 500)}`);
        err.code = 'PROTON_ADAPTER_BAD_JSON';
        err.cause = parseErr;
        reject(err);
      }
    });

    child.stdin.end(JSON.stringify(payload || {}));
  });
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:password|access_token|refresh_token|accessToken|refreshToken)["']?\s*[:=]\s*)["']?[^,"'\s}]+/gi, '$1[redacted]');
}
