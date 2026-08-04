import { Container } from "@cloudflare/containers";

const STATS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

let statsSchemaReady = false;

export class OutlookImapGraphApi extends Container {
  defaultPort = 3000;
  requiredPorts = [3000];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "/healthz";
  envVars = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3000",
    UI_VARIANT: "modern",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/fetch-stats") {
      return handleFetchStats(request, env, url);
    }

    if (url.pathname === "/api/track-fetch") {
      return handleTrackFetch(request, env);
    }

    const revision = String(env.CONTAINER_REVISION || "current").trim() || "current";
    const container = env.OUTLOOK_API.getByName(`singleton-${revision}`);
    await container.startAndWaitForPorts({
      startOptions: {
        envVars: {
          UI_VARIANT: env.UI_VARIANT === "legacy" ? "legacy" : "modern",
        },
      },
    });
    return container.fetch(request);
  },
};

async function handleFetchStats(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: STATS_CORS_HEADERS });
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error: "统计读取接口仅支持 GET" }, 405);
  }

  try {
    await ensureStatsSchema(env.FETCH_STATS_DB);
    const stats = await readFetchStats(env.FETCH_STATS_DB, normalizeDayKey(url.searchParams.get("day")));
    return jsonResponse({ success: true, stats });
  } catch (error) {
    return jsonResponse({ success: false, error: error?.message || "统计读取失败" }, 500);
  }
}

async function handleTrackFetch(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: STATS_CORS_HEADERS });
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "统计写入接口仅支持 POST" }, 405);
  }

  try {
    await ensureStatsSchema(env.FETCH_STATS_DB);
    const body = await readJsonBody(request);
    const kind = normalizeFetchKind(body.kind);
    if (!kind) return jsonResponse({ success: false, error: "统计类型无效" }, 400);

    const dayKey = normalizeDayKey(body.dayKey);
    const accountCount = normalizeAccountCount(body.accountCount);
    await env.FETCH_STATS_DB.prepare(
      "INSERT INTO fetch_events (kind, account_count, day_key) VALUES (?, ?, ?)",
    ).bind(kind, accountCount, dayKey).run();

    const stats = await readFetchStats(env.FETCH_STATS_DB, dayKey);
    return jsonResponse({ success: true, stats });
  } catch (error) {
    return jsonResponse({ success: false, error: error?.message || "统计写入失败" }, 500);
  }
}

async function ensureStatsSchema(db) {
  if (!db) throw new Error("未绑定 FETCH_STATS_DB");
  if (statsSchemaReady) return;

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS fetch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('outlook', 'proton')),
        account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count >= 0),
        day_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_fetch_events_day_key ON fetch_events(day_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_fetch_events_kind ON fetch_events(kind)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_fetch_events_created_at ON fetch_events(created_at)"),
  ]);
  statsSchemaReady = true;
}

async function readFetchStats(db, dayKey) {
  const totals = await db.prepare(`
    SELECT
      COUNT(*) AS totalFetches,
      COALESCE(SUM(account_count), 0) AS totalAccounts,
      COALESCE(SUM(CASE WHEN kind = 'outlook' THEN 1 ELSE 0 END), 0) AS outlookFetches,
      COALESCE(SUM(CASE WHEN kind = 'proton' THEN 1 ELSE 0 END), 0) AS protonFetches
    FROM fetch_events
  `).first();
  const today = await db.prepare(`
    SELECT
      COUNT(*) AS todayFetches,
      COALESCE(SUM(account_count), 0) AS todayAccounts,
      COALESCE(SUM(CASE WHEN kind = 'outlook' THEN 1 ELSE 0 END), 0) AS todayOutlookFetches,
      COALESCE(SUM(CASE WHEN kind = 'proton' THEN 1 ELSE 0 END), 0) AS todayProtonFetches
    FROM fetch_events
    WHERE day_key = ?
  `).bind(dayKey).first();

  return {
    totalFetches: numberValue(totals?.totalFetches),
    todayFetches: numberValue(today?.todayFetches),
    totalAccounts: numberValue(totals?.totalAccounts),
    todayAccounts: numberValue(today?.todayAccounts),
    outlookFetches: numberValue(totals?.outlookFetches),
    protonFetches: numberValue(totals?.protonFetches),
    todayOutlookFetches: numberValue(today?.todayOutlookFetches),
    todayProtonFetches: numberValue(today?.todayProtonFetches),
    date: dayKey,
  };
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeFetchKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "outlook" || kind === "proton" ? kind : "";
}

function normalizeAccountCount(value) {
  const count = Math.floor(Number(value || 0));
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(count, 1000));
}

function normalizeDayKey(value) {
  const dayKey = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return dayKey;
  return new Date().toISOString().slice(0, 10);
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...STATS_CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
