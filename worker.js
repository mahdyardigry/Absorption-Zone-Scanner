const VERSION = "ABSORPTION-ZONE-V5-HOUR-BLOCK-20K-LOWWRITE-BYBIT-FUTURES-DEBUG";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const HOUR_MS = 60 * 60 * 1000;
const ALARM_MS = 60 * 60 * 1000;

const MAX_ROWS = 20000;
const CLEANUP_TARGET_ROWS = 19000;

const TABLE_NAME = "hour_blocks_v5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function normalizeSymbol(value) {
  let s = String(value || "").trim().toUpperCase();

  if (!s) return DEFAULT_SYMBOL;

  s = s.replace(/[^A-Z0-9]/g, "");

  if (s === "BTC") return "BTCUSDT";
  if (s === "BUSDT") return "BTCUSDT";

  if (!s.endsWith("USDT")) {
    s += "USDT";
  }

  return s;
}

function normalizeInterval(value) {
  const allowed = [
    "1",
    "3",
    "5",
    "15",
    "30",
    "60",
    "120",
    "240",
    "360",
    "720",
    "D",
    "W",
    "M"
  ];

  const v = String(value || DEFAULT_INTERVAL).toUpperCase();

  return allowed.includes(v)
    ? v
    : DEFAULT_INTERVAL;
}

function hourStartOf(time) {
  const t = Number(time) || Date.now();
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

function minuteStartOf(time) {
  const t = Number(time) || Date.now();
  return Math.floor(t / 60000) * 60000;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;

  const a = [...values].sort((x, y) => x - y);

  const index = (a.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return a[lower];
  }

  return (
    a[lower] +
    (a[upper] - a[lower]) *
      (index - lower)
  );
}

/* =========================================================
   BYBIT REST
========================================================= */

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    let detail = "";

    try {
      detail = await response.text();
    } catch (_) {}

    throw new Error(
      `Bybit HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }

  const data = await response.json();

  if (Number(data.retCode) !== 0) {
    throw new Error(
      data.retMsg || "Bybit API error"
    );
  }

  return data.result;
}

/* =========================================================
   BYBIT DIRECT DEBUG
   Cloudflare Worker -> Bybit
========================================================= */

async function debugBybit() {
  const startedAt = Date.now();

  const target =
    new URL(
      BYBIT + "/v5/market/instruments-info"
    );

  target.searchParams.set(
    "category",
    "linear"
  );

  target.searchParams.set(
    "status",
    "Trading"
  );

  target.searchParams.set(
    "limit",
    "10"
  );

  let response = null;
  let body = "";
  let parsed = null;

  try {
    response = await fetch(
      target.toString(),
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent":
            "Absorption-Zone-Scanner"
        }
      }
    );

    body = await response.text();

    try {
      parsed = JSON.parse(body);
    } catch (_) {
      parsed = null;
    }

    const list =
      Array.isArray(
        parsed?.result?.list
      )
        ? parsed.result.list
        : [];

    return {
      ok: true,

      test:
        "Cloudflare Worker -> Bybit",

      reachable:
        true,

      httpStatus:
        response.status,

      httpOk:
        response.ok,

      bybitRetCode:
        parsed?.retCode ??
        null,

      bybitRetMsg:
        parsed?.retMsg ??
        null,

      symbolsReceived:
        list.length,

      sampleSymbols:
        list
          .slice(0, 10)
          .map(
            row =>
              row?.symbol || null
          )
          .filter(Boolean),

      responseContentType:
        response.headers.get(
          "content-type"
        ) || "",

      responseServer:
        response.headers.get(
          "server"
        ) || "",

      elapsedMs:
        Date.now() -
        startedAt,

      target:
        target.toString(),

      rawBody:
        body.slice(0, 5000),

      diagnosis:
        response.status === 200 &&
        Number(parsed?.retCode) === 0
          ? (
              list.length > 0
                ? "BYBIT_OK_SYMBOLS_RECEIVED"
                : "BYBIT_REACHABLE_BUT_ZERO_SYMBOLS"
            )
          : (
              response.status === 403
                ? "BYBIT_OR_CLOUDFRONT_BLOCKED_403"
                : "BYBIT_REQUEST_FAILED"
            )
    };
  } catch (error) {
    return {
      ok: false,

      test:
        "Cloudflare Worker -> Bybit",

      reachable:
        false,

      httpStatus:
        response?.status ??
        null,

      httpOk:
        response?.ok ??
        false,

      bybitRetCode:
        parsed?.retCode ??
        null,

      bybitRetMsg:
        parsed?.retMsg ??
        null,

      symbolsReceived:
        0,

      sampleSymbols:
        [],

      elapsedMs:
        Date.now() -
        startedAt,

      target:
        target.toString(),

      rawBody:
        body
          ? body.slice(0, 5000)
          : "",

      error:
        String(
          error?.message ||
          error
        ),

      errorName:
        error?.name ||
        "Error",

      diagnosis:
        "WORKER_TO_BYBIT_FETCH_FAILED"
    };
  }
}

/* =========================================================
   KLINES
========================================================= */

function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      turnover: Number(row[6])
    }))
    .filter(
      x =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.open)
    )
    .reverse();
}

/* =========================================================
   TRADES
========================================================= */

function parseTrades(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row, index) => {
      const price = safeNumber(row.price);
      const size = safeNumber(row.size);

      return {
        id: String(
          row.execId ||
          row.tradeId ||
          row.id ||
          `${row.time || Date.now()}-${index}-${price}-${size}`
        ),

        time: safeNumber(row.time),
        price,
        size,
        value: price * size,

        side: String(
          row.side || ""
        ).toUpperCase()
      };
    })
    .filter(
      x =>
        x.time > 0 &&
        x.price > 0 &&
        x.size > 0
    );
}

/* =========================================================
   TRADE STATS
========================================================= */

function tradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  const values = [];

  for (const t of trades) {
    const value = safeNumber(t.value);

    values.push(value);

    if (t.side === "BUY") {
      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else if (t.side === "SELL") {
      sellVolume += t.size;
      sellValue += value;
      sellTrades++;
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  const totalValue =
    buyValue + sellValue;

  const delta =
    buyVolume - sellVolume;

  const deltaValue =
    buyValue - sellValue;

  const deltaPercent =
    totalVolume > 0
      ? (delta / totalVolume) * 100
      : 0;

  const averageNotional =
    values.length
      ? values.reduce((a, b) => a + b, 0) /
        values.length
      : 0;

  const p95 =
    percentile(values, 0.95);

  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let largeBuyValue = 0;
  let largeSellValue = 0;

  for (const t of trades) {
    if (t.value < largeThreshold) {
      continue;
    }

    if (t.side === "BUY") {
      largeBuyVolume += t.size;
      largeBuyValue += t.value;
    }

    if (t.side === "SELL") {
      largeSellVolume += t.size;
      largeSellValue += t.value;
    }
  }

  let pressure = "NEUTRAL";

  if (deltaPercent >= 10) {
    pressure = "BUY_PRESSURE";
  } else if (deltaPercent <= -10) {
    pressure = "SELL_PRESSURE";
  }

  return {
    buyVolume,
    sellVolume,
    totalVolume,

    buyValue,
    sellValue,
    totalValue,

    buyTrades,
    sellTrades,

    delta,
    deltaValue,
    deltaPercent,

    averageNotional,
    p95,
    largeThreshold,

    largeBuyVolume,
    largeSellVolume,

    largeBuyValue,
    largeSellValue,

    pressure
  };
}

/* =========================================================
   TICK / FOOTPRINT
========================================================= */

function decimalsFromTick(tick) {
  const s = String(tick);

  if (!s.includes(".")) {
    return 0;
  }

  return s
    .split(".")[1]
    .replace(/0+$/, "")
    .length;
}

function roundToTick(price, tickSize) {
  const tick = Number(tickSize);

  if (
    !Number.isFinite(tick) ||
    tick <= 0
  )
