const VERSION = "ABSORPTION-ZONE-V5-HOUR-BLOCK-20K-LOWWRITE-BYBIT-FUTURES-VOLUME-TEST-V3";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
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

  const v = String(
    value || DEFAULT_INTERVAL
  ).toUpperCase();

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
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;

  const a = [...values].sort(
    (x, y) => x - y
  );

  const index =
    (a.length - 1) * p;

  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);

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
   BYTE / COMPRESSION HELPERS
========================================================= */

function utf8ByteLength(value) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  return new TextEncoder().encode(text).byteLength;
}

function bytesToKB(bytes) {
  return Number(
    (Number(bytes || 0) / 1024).toFixed(3)
  );
}

function bytesToMB(bytes) {
  return Number(
    (Number(bytes || 0) / 1024 / 1024).toFixed(6)
  );
}

function bytesToGB(bytes) {
  return Number(
    (
      Number(bytes || 0) /
      1024 /
      1024 /
      1024
    ).toFixed(6)
  );
}

async function gzipByteLength(value) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  const input =
    new TextEncoder().encode(text);

  if (
    typeof CompressionStream !==
    "function"
  ) {
    return null;
  }

  const stream =
    new Blob([input])
      .stream()
      .pipeThrough(
        new CompressionStream("gzip")
      );

  const buffer =
    await new Response(
      stream
    ).arrayBuffer();

  return buffer.byteLength;
}

function compressionInfo(
  rawBytes,
  gzipBytes
) {
  if (
    !Number.isFinite(gzipBytes) ||
    gzipBytes <= 0 ||
    rawBytes <= 0
  ) {
    return {
      available: false,
      rawBytes,
      compressedBytes: null,
      savedBytes: null,
      savedPercent: null,
      ratio: null
    };
  }

  const saved =
    rawBytes - gzipBytes;

  const savedPercent =
    (saved / rawBytes) * 100;

  const ratio =
    rawBytes / gzipBytes;

  return {
    available: true,

    rawBytes,

    compressedBytes:
      gzipBytes,

    savedBytes:
      saved,

    savedPercent:
      Number(
        savedPercent.toFixed(2)
      ),

    ratio:
      Number(
        ratio.toFixed(3)
      )
  };
}

/* =========================================================
   BYBIT REST
========================================================= */

async function bybit(path, params = {}) {
  const url =
    new URL(BYBIT + path);

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {
    let detail = "";

    try {
      detail =
        await response.text();
    } catch (_) {}

    throw new Error(
      `Bybit HTTP ${response.status}${
        detail
          ? `: ${detail.slice(0, 500)}`
          : ""
      }`
    );
  }

  const data =
    await response.json();

  if (
    Number(data.retCode) !== 0
  ) {
    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data.result;
}

/* =========================================================
   BYBIT DIRECT DEBUG
========================================================= */

async function debugBybit() {
  const startedAt =
    Date.now();

  const target =
    new URL(
      BYBIT +
      "/v5/market/instruments-info"
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
    response =
      await fetch(
        target.toString(),
        {
          method: "GET",

          headers: {
            "Accept":
              "application/json",

            "User-Agent":
              "Absorption-Zone-Scanner"
          }
        }
      );

    body =
      await response.text();

    try {
      parsed =
        JSON.parse(body);
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

      reachable: true,

      httpStatus:
        response.status,

      httpOk:
        response.ok,

      bybitRetCode:
        parsed?.retCode ?? null,

      bybitRetMsg:
        parsed?.retMsg ?? null,

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

      sampleContractTypes:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.contractType ||
                  null
              )
              .filter(Boolean)
          )
        ],

      sampleQuoteCoins:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.quoteCoin ||
                  null
              )
              .filter(Boolean)
          )
        ],

      sampleSettleCoins:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.settleCoin ||
                  null
              )
              .filter(Boolean)
          )
        ],

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

      reachable: false,

      httpStatus:
        response?.status ?? null,

      httpOk:
        response?.ok ?? false,

      bybitRetCode:
        parsed?.retCode ?? null,

      bybitRetMsg:
        parsed?.retMsg ?? null,

      symbolsReceived: 0,

      sampleSymbols: [],

      sampleContractTypes: [],

      sampleQuoteCoins: [],

      sampleSettleCoins: [],

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
  if (!Array.isArray(rows)) {
    return [];
  }

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
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row, index) => {
      const price =
        safeNumber(row.price);

      const size =
        safeNumber(row.size);

      return {
        id: String(
          row.execId ||
          row.tradeId ||
          row.id ||
          `${row.time || Date.now()}-${index}-${price}-${size}`
        ),

        time:
          safeNumber(row.time),

        price,

        size,

        value:
          price * size,

        side:
          String(
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
    const value =
      safeNumber(t.value);

    values.push(value);

    if (t.side === "BUY") {
      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else if (
      t.side === "SELL"
    ) {
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
      ? values.reduce(
          (a, b) => a + b,
          0
        ) / values.length
      : 0;

  const p95 =
    percentile(
      values,
      0.95
    );

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
    if (
      t.value <
      largeThreshold
    ) {
      continue;
    }

    if (t.side === "BUY") {
      largeBuyVolume +=
        t.size;

      largeBuyValue +=
        t.value;
    }

    if (t.side === "SELL") {
      largeSellVolume +=
        t.size;

      largeSellValue +=
        t.value;
    }
  }

  let pressure =
    "NEUTRAL";

  if (
    deltaPercent >= 10
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    deltaPercent <= -10
  ) {
    pressure =
      "SELL_PRESSURE";
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
  const s =
    String(tick);

  if (!s.includes(".")) {
    return 0;
  }

  return s
    .split(".")[1]
    .replace(/0+$/, "")
    .length;
}

function roundToTick(
  price,
  tickSize
) {
  const tick =
    Number(tickSize);

  if (
    !Number.isFinite(tick) ||
    tick <= 0
  ) {
    return Number(price);
  }

  const n =
    Math.round(
      Number(price) / tick
    ) * tick;

  const decimals =
    decimalsFromTick(tick);

  return Number(
    n.toFixed(decimals)
  );
}

function aggregateFootprint(
  trades,
  tickSize
) {
  const levels =
    new Map();

  for (const t of trades) {
    const price =
      roundToTick(
        t.price,
        tickSize
      );

    if (!levels.has(price)) {
      levels.set(price, {
        price,

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        buyTrades: 0,
        sellTrades: 0
      });
    }

    const level =
      levels.get(price);

    if (t.side === "BUY") {
      level.buyVolume +=
        t.size;

      level.buyValue +=
        t.value;

      level.buyTrades++;
    } else if (
      t.side === "SELL"
    ) {
      level.sellVolume +=
        t.size;

      level.sellValue +=
        t.value;

      level.sellTrades++;
    }
  }

  return [
    ...levels.values()
  ]
    .sort(
      (a, b) =>
        a.price - b.price
    )
    .map(level => ({
      ...level,

      delta:
        level.buyVolume -
        level.sellVolume,

      deltaValue:
        level.buyValue -
        level.sellValue,

      totalVolume:
        level.buyVolume +
        level.sellVolume,

      imbalance:
        level.sellVolume > 0
          ? level.buyVolume /
            level.sellVolume
          : level.buyVolume > 0
            ? Infinity
            : 0
    }));
}

/* =========================================================
   ORDER BOOK
========================================================= */

function orderbookStats(data) {
  const bids =
    Array.isArray(data?.b)
      ? data.b
      : [];

  const asks =
    Array.isArray(data?.a)
      ? data.a
      : [];

  let buyLiquidity = 0;
  let sellLiquidity = 0;

  let buyValue = 0;
  let sellValue = 0;

  for (const row of bids) {
    const price =
      safeNumber(row[0]);

    const size =
      safeNumber(row[1]);

    buyLiquidity +=
      size;

    buyValue +=
      price * size;
  }

  for (const row of asks) {
    const price =
      safeNumber(row[0]);

    const size =
      safeNumber(row[1]);

    sellLiquidity +=
      size;

    sellValue +=
      price * size;
  }

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? (
          buyLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? (
          sellLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    sellShare >
    buyShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,

    buyValue,
    sellValue,

    buyShare,
    sellShare,

    bestBid:
      bids.length
        ? safeNumber(
            bids[0][0]
          )
        : 0,

    bestAsk:
      asks.length
        ? safeNumber(
            asks[0][0]
          )
        : 0,

    spread:
      bids.length &&
      asks.length
        ? safeNumber(
            asks[0][0]
          ) -
          safeNumber(
            bids[0][0]
          )
        : 0,

    pressure,

    bids,
    asks
  };
}

/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  trades,
  candles,
  book
) {
  if (!candles.length) {
    return {
      detected: false,
      type: "NONE",
      score: 0
    };
  }

  const candle =
    candles[
      candles.length - 1
    ];

  const stats =
    tradeStats(trades);

  const range =
    candle.high -
    candle.low;

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const bodyRatio =
    range > 0
      ? body / range
      : 1;

  let score = 0;
  let type = "NONE";

  if (
    stats.pressure ===
      "SELL_PRESSURE" &&
    range > 0
  ) {
    const nearLow =
      (
        candle.close -
        candle.low
      ) / range;

    if (
      nearLow <= 0.25
    ) {
      score += 35;
      type =
        "BUY_ABSORPTION";
    }
  }

  if (
    stats.pressure ===
      "BUY_PRESSURE" &&
    range > 0
  ) {
    const nearHigh =
      (
        candle.high -
        candle.close
      ) / range;

    if (
      nearHigh <= 0.25
    ) {
      score += 35;
      type =
        "SELL_ABSORPTION";
    }
  }

  if (
    bodyRatio < 0.35
  ) {
    score += 20;
  }

  if (
    book &&
    type ===
      "BUY_ABSORPTION" &&
    book.pressure ===
      "BUY_PRESSURE"
  ) {
    score += 20;
  }

  if (
    book &&
    type ===
      "SELL_ABSORPTION" &&
    book.pressure ===
      "SELL_PRESSURE"
  ) {
    score += 20;
  }

  return {
    detected:
      score >= 50,

    type,

    score,

    bodyRatio,

    pressure:
      stats.pressure
  };
}

/* =========================================================
   BYBIT FUTURES SYMBOLS
========================================================= */

function isPerpetual(row) {
  const contractType =
    String(
      row?.contractType ||
      ""
    )
      .trim()
      .toUpperCase();

  const status =
    String(
      row?.status ||
      ""
    )
      .trim()
      .toUpperCase();

  const quoteCoin =
    String(
      row?.quoteCoin ||
      ""
    )
      .trim()
      .toUpperCase();

  const settleCoin =
    String(
      row?.settleCoin ||
      ""
    )
      .trim()
      .toUpperCase();

  const perpetual =
    contractType ===
      "LINEARPERPETUAL" ||
    contractType ===
      "LINEAR_PERPETUAL" ||
    contractType ===
      "PERPETUAL" ||
    contractType.includes(
      "PERPETUAL"
    );

  const usdt =
    quoteCoin === "USDT" ||
    settleCoin === "USDT";

  return (
    status === "TRADING" &&
    perpetual &&
    usdt
  );
}

async function getBybitSymbols() {
  let cursor = "";

  const output = [];

  for (
    let page = 0;
    page < 20;
    page++
  ) {
    const result =
      await bybit(
        "/v5/market/instruments-info",
        {
          category:
            "linear",

          status:
            "Trading",

          limit:
            SYMBOL_LIMIT,

          cursor
        }
      );

    const list =
      Array.isArray(
        result?.list
      )
        ? result.list
        : [];

    for (const row of list) {
      if (
        !isPerpetual(row)
      ) {
        continue;
      }

      const symbol =
        normalizeSymbol(
          row.symbol
        );

      if (
        !symbol.endsWith(
          "USDT"
        )
      ) {
        continue;
      }

      output.push({
        symbol,

        tickSize:
          safeNumber(
            row
              ?.priceFilter
              ?.tickSize,
            0
          ),

        minOrderQty:
          safeNumber(
            row
              ?.lotSizeFilter
              ?.minOrderQty,
            0
          )
      });
    }

    cursor =
      result?.nextPageCursor ||
      "";

    if (!cursor) {
      break;
    }
  }

  const unique =
    new Map();

  for (const item of output) {
    unique.set(
      item.symbol,
      item
    );
  }

  return [
    ...unique.values()
  ].sort(
    (a, b) =>
      a.symbol.localeCompare(
        b.symbol
      )
  );
}
/* =========================================================
   VOLUME TEST
   REAL PROJECT FOOTPRINT STORAGE TEST
   NO DATABASE WRITE
========================================================= */

async function testVolume(
  symbol
) {
  const startedAt =
    Date.now();

  symbol =
    normalizeSymbol(symbol);

  /*
   * -------------------------------------------------------
   * دریافت معاملات واقعی Bybit
   * -------------------------------------------------------
   */

  const result =
    await bybit(
      "/v5/market/recent-trade",
      {
        category:
          "linear",

        symbol,

        limit:
          TRADE_LIMIT
      }
    );

  const trades =
    parseTrades(
      result?.list
    );

  if (!trades.length) {
    return {
      ok:
        false,

      test:
        "FOOTPRINT_STORAGE_TEST",

      symbol,

      error:
        "No valid trades received from Bybit",

      version:
        VERSION
    };
  }

  /*
   * -------------------------------------------------------
   * دریافت tickSize واقعی نماد
   * -------------------------------------------------------
   */

  let tickSize =
    0;

  try {
    const instrumentResult =
      await bybit(
        "/v5/market/instruments-info",
        {
          category:
            "linear",

          symbol
        }
      );

    const instrument =
      Array.isArray(
        instrumentResult?.list
      )
        ? instrumentResult.list[0]
        : null;

    tickSize =
      safeNumber(
        instrument
          ?.priceFilter
          ?.tickSize,
        0
      );
  } catch (
    error
  ) {
    tickSize = 0;
  }

  /*
   * -------------------------------------------------------
   * Footprint واقعی پروژه
   *
   * دقیقاً همان تابعی که Scanner اصلی استفاده می‌کند.
   * -------------------------------------------------------
   */

  const fullFootprint =
    aggregateFootprint(
      trades,
      tickSize
    );

  /*
   * -------------------------------------------------------
   * گروه‌بندی معاملات بر اساس دقیقه
   * -------------------------------------------------------
   */

  const minuteMap =
    new Map();

  for (
    const trade of trades
  ) {
    const minute =
      minuteStartOf(
        trade.time
      );

    if (
      !minuteMap.has(
        minute
      )
    ) {
      minuteMap.set(
        minute,
        []
      );
    }

    minuteMap
      .get(minute)
      .push(trade);
  }

  /*
   * -------------------------------------------------------
   * Footprint واقعی هر دقیقه
   * -------------------------------------------------------
   */

  const minuteTests =
    [];

  let footprintRawTotal =
    0;

  let footprintGzipTotal =
    0;

  let gzipAvailable =
    true;

  let totalLevels =
    0;

  let totalMinutes =
    0;

  for (
    const [
      minute,
      minuteTrades
    ]
    of minuteMap
  ) {
    const minuteFootprint =
      aggregateFootprint(
        minuteTrades,
        tickSize
      );

    /*
     * این همان ساختار واقعی Footprint
     * است که پروژه برای تحلیل استفاده می‌کند.
     */

    const payload =
      JSON.stringify(
        {
          t:
            minute,

          f:
            minuteFootprint
        }
      );

    const rawBytes =
      utf8ByteLength(
        payload
      );

    const gzipBytes =
      await gzipByteLength(
        payload
      );

    totalMinutes++;

    totalLevels +=
      minuteFootprint.length;

    footprintRawTotal +=
      rawBytes;

    if (
      Number.isFinite(
        gzipBytes
      )
    ) {
      footprintGzipTotal +=
        gzipBytes;
    } else {
      gzipAvailable =
        false;
    }

    minuteTests.push({
      minute,

      iso:
        new Date(
          minute
        ).toISOString(),

      trades:
        minuteTrades.length,

      levels:
        minuteFootprint.length,

      rawBytes,

      rawKB:
        bytesToKB(
          rawBytes
        ),

      rawMB:
        bytesToMB(
          rawBytes
        ),

      gzipBytes:
        Number.isFinite(
          gzipBytes
        )
          ? gzipBytes
          : null,

      gzipKB:
        Number.isFinite(
          gzipBytes
        )
          ? bytesToKB(
              gzipBytes
            )
          : null,

      gzipMB:
        Number.isFinite(
          gzipBytes
        )
          ? bytesToMB(
              gzipBytes
            )
          : null,

      compression:
        compressionInfo(
          rawBytes,
          gzipBytes
        )
    });
  }

  minuteTests.sort(
    (a, b) =>
      a.minute -
      b.minute
  );

  /*
   * -------------------------------------------------------
   * زمان نمونه
   * -------------------------------------------------------
   */

  const firstTradeTime =
    Math.min(
      ...trades.map(
        t =>
          t.time
      )
    );

  const lastTradeTime =
    Math.max(
      ...trades.map(
        t =>
          t.time
      )
    );

  const hourStart =
    hourStartOf(
      firstTradeTime
    );

  /*
   * -------------------------------------------------------
   * ساخت Payload کامل یک ساعت
   *
   * مهم:
   * اینجا خود Footprint levelها ذخیره می‌شوند،
   * نه فقط اندازه آنها.
   * -------------------------------------------------------
   */

  const hourMinutes =
    [];

  let hourRawBytesFromMinutes =
    0;

  for (
    const [
      minute,
      minuteTrades
    ]
    of minuteMap
  ) {
    const minuteFootprint =
      aggregateFootprint(
        minuteTrades,
        tickSize
      );

    hourMinutes.push({
      t:
        minute,

      f:
        minuteFootprint
    });
  }

  hourMinutes.sort(
    (a, b) =>
      a.t -
      b.t
  );

  const hourPayload =
    {
      v:
        1,

      s:
        symbol,

      h:
        hourStart,

      ts:
        tickSize,

      m:
        hourMinutes
    };

  const hourPayloadText =
    JSON.stringify(
      hourPayload
    );

  const hourRawBytes =
    utf8ByteLength(
      hourPayloadText
    );

  const hourGzipBytes =
    await gzipByteLength(
      hourPayloadText
    );

  /*
   * -------------------------------------------------------
   * آمار واقعی Footprint
   * -------------------------------------------------------
   */

  const averageLevelsPerMinute =
    totalMinutes > 0
      ? totalLevels /
        totalMinutes
      : 0;

  const averageRawPerMinute =
    totalMinutes > 0
      ? footprintRawTotal /
        totalMinutes
      : 0;

  const averageGzipPerMinute =
    totalMinutes > 0 &&
    gzipAvailable
      ? footprintGzipTotal /
        totalMinutes
      : null;

  /*
   * -------------------------------------------------------
   * برآورد یک ساعت
   *
   * بر اساس Footprint واقعی دریافت‌شده
   * -------------------------------------------------------
   */

  const estimatedHourRaw =
    averageRawPerMinute *
    60;

  const estimatedHourGzip =
    averageGzipPerMinute ===
    null
      ? null
      : averageGzipPerMinute *
        60;

  /*
   * -------------------------------------------------------
   * برآورد 20,000 ردیف
   * -------------------------------------------------------
   */

  const estimated20KRaw =
    hourRawBytes *
    MAX_ROWS;

  const estimated20KGzip =
    Number.isFinite(
      hourGzipBytes
    )
      ? hourGzipBytes *
        MAX_ROWS
      : null;

  /*
   * -------------------------------------------------------
   * برآورد تعداد نمادها
   * -------------------------------------------------------
   */

  const symbolCounts = [
    10,
    20,
    50,
    100,
    200,
    500
  ];

  const symbolStorage =
    symbolCounts.map(
      count => {
        const oneHourRaw =
          hourRawBytes *
          count;

        const oneHourGzip =
          Number.isFinite(
            hourGzipBytes
          )
            ? hourGzipBytes *
              count
            : null;

        return {
          symbols:
            count,

          oneHourRawBytes:
            oneHourRaw,

          oneHourRawMB:
            bytesToMB(
              oneHourRaw
            ),

          oneHourGzipBytes:
            oneHourGzip,

          oneHourGzipMB:
            oneHourGzip === null
              ? null
              : bytesToMB(
                  oneHourGzip
                ),

          oneDayRawGB:
            bytesToGB(
              oneHourRaw *
              24
            ),

          oneDayGzipGB:
            oneHourGzip === null
              ? null
              : bytesToGB(
                  oneHourGzip *
                  24
                ),

          oneMonthRawGB:
            bytesToGB(
              oneHourRaw *
              24 *
              30
            ),

          oneMonthGzipGB:
            oneHourGzip === null
              ? null
              : bytesToGB(
                  oneHourGzip *
                  24 *
                  30
                )
        };
      }
    );

  /*
   * -------------------------------------------------------
   * خروجی
   * -------------------------------------------------------
   */

  return {
    ok:
      true,

    test:
      "FOOTPRINT_STORAGE_TEST",

    version:
      VERSION,

    symbol,

    source:
      "Bybit Linear Futures publicTrade",

    databaseWrite:
      false,

    databaseModified:
      false,

    readOnly:
      true,

    tickSize,

    compression:
      "GZIP lossless",

    compressionAvailable:
      gzipAvailable,

    sample: {
      trades:
        trades.length,

      firstTradeTime,

      firstTradeISO:
        new Date(
          firstTradeTime
        ).toISOString(),

      lastTradeTime,

      lastTradeISO:
        new Date(
          lastTradeTime
        ).toISOString(),

      coveredMinutes:
        totalMinutes,

      footprintLevels:
        totalLevels,

      averageLevelsPerMinute:
        Number(
          averageLevelsPerMinute.toFixed(
            2
          )
        )
    },

    /*
     * Footprint واقعی تمام دقیقه‌های نمونه
     */
    actualFootprint: {
      rawBytes:
        footprintRawTotal,

      rawKB:
        bytesToKB(
          footprintRawTotal
        ),

      rawMB:
        bytesToMB(
          footprintRawTotal
        ),

      gzipBytes:
        gzipAvailable
          ? footprintGzipTotal
          : null,

      gzipKB:
        gzipAvailable
          ? bytesToKB(
              footprintGzipTotal
            )
          : null,

      gzipMB:
        gzipAvailable
          ? bytesToMB(
              footprintGzipTotal
            )
          : null,

      compression:
        compressionInfo(
          footprintRawTotal,
          gzipAvailable
            ? footprintGzipTotal
            : null
        )
    },

    /*
     * اندازه واقعی Payload کامل ساعت
     */
    actualHourPayload: {
      hourStart,

      hourISO:
        new Date(
          hourStart
        ).toISOString(),

      minutes:
        hourMinutes.length,

      levels:
        totalLevels,

      rawBytes:
        hourRawBytes,

      rawKB:
        bytesToKB(
          hourRawBytes
        ),

      rawMB:
        bytesToMB(
          hourRawBytes
        ),

      gzipBytes:
        Number.isFinite(
          hourGzipBytes
        )
          ? hourGzipBytes
          : null,

      gzipKB:
        Number.isFinite(
          hourGzipBytes
        )
          ? bytesToKB(
              hourGzipBytes
            )
          : null,

      gzipMB:
        Number.isFinite(
          hourGzipBytes
        )
          ? bytesToMB(
              hourGzipBytes
            )
          : null,

      compression:
        compressionInfo(
          hourRawBytes,
          hourGzipBytes
        )
    },

    /*
     * برآورد یک ساعت کامل
     */
    estimatedHour: {
      model:
        "Actual project Footprint minute structure projected to 60 minutes",

      rawBytes:
        Math.round(
          estimatedHourRaw
        ),

      rawKB:
        bytesToKB(
          estimatedHourRaw
        ),

      rawMB:
        bytesToMB(
          estimatedHourRaw
        ),

      gzipBytes:
        estimatedHourGzip ===
        null
          ? null
          : Math.round(
              estimatedHourGzip
            ),

      gzipKB:
        estimatedHourGzip ===
        null
          ? null
          : bytesToKB(
              estimatedHourGzip
            ),

      gzipMB:
        estimatedHourGzip ===
        null
          ? null
          : bytesToMB(
              estimatedHourGzip
            )
    },

    /*
     * اندازه بر اساس Payload واقعی یک ساعت
     */
    estimatedStorage: {
      model:
        "1 symbol + 1 hour = 1 complete Footprint row",

      maxRows:
        MAX_ROWS,

      rawBytes:
        Math.round(
          estimated20KRaw
        ),

      rawMB:
        bytesToMB(
          estimated20KRaw
        ),

      rawGB:
        bytesToGB(
          estimated20KRaw
        ),

      gzipBytes:
        estimated20KGzip ===
        null
          ? null
          : Math.round(
              estimated20KGzip
            ),

      gzipMB:
        estimated20KGzip ===
        null
          ? null
          : bytesToMB(
              estimated20KGzip
            ),

      gzipGB:
        estimated20KGzip ===
        null
          ? null
          : bytesToGB(
              estimated20KGzip
            )
    },

    /*
     * ظرفیت بر اساس تعداد نماد
     */
    symbolStorage,

    /*
     * جزئیات هر دقیقه
     */
    minuteTests,

    elapsedMs:
      Date.now() -
      startedAt,

    note:
      "Read-only test. Uses the project's real parseTrades() and aggregateFootprint() functions. Builds complete minute/hour Footprint payloads in memory. No Durable Object SQLite or external database is accessed."
  };
}

  /*
   * =======================================================
   * BUILD REAL FOOTPRINT STRUCTURE
   *
   * hour
   *   └── minute
   *        └── price level
   *
   * Each price level contains:
   * - buy volume
   * - sell volume
   * - total volume
   * - delta
   * - trade count
   * =======================================================
   */

  const minuteMap =
    new Map();

  for (
    const trade of trades
  ) {
    const minute =
      minuteStartOf(
        trade.time
      );

    if (
      !minuteMap.has(
        minute
      )
    ) {
      minuteMap.set(
        minute,
        new Map()
      );
    }

    const price =
      Number(
        trade.price
      );

    const qty =
      Number(
        trade.qty
      );

    if (
      !Number.isFinite(
        price
      ) ||
      !Number.isFinite(
        qty
      ) ||
      qty <= 0
    ) {
      continue;
    }

    /*
     * Keep the original price precision.
     */
    const priceKey =
      String(
        trade.price
      );

    const levels =
      minuteMap.get(
        minute
      );

    if (
      !levels.has(
        priceKey
      )
    ) {
      levels.set(
        priceKey,
        {
          p:
            trade.price,

          buy:
            0,

          sell:
            0,

          total:
            0,

          trades:
            0
        }
      );
    }

    const level =
      levels.get(
        priceKey
      );

    /*
     * Bybit public trade side:
     * Buy  = aggressive buyer
     * Sell = aggressive seller
     */
    if (
      String(
        trade.side
      ).toLowerCase() ===
      "buy"
    ) {
      level.buy +=
        qty;
    } else {
      level.sell +=
        qty;
    }

    level.total +=
      qty;

    level.trades++;
  }

  /*
   * =======================================================
   * SERIALIZE FOOTPRINT MINUTES
   * =======================================================
   */

  const minuteTests = [];

  let footprintRawTotal =
    0;

  let footprintGzipTotal =
    0;

  let gzipAvailable =
    true;

  let totalLevels =
    0;

  let totalMinutes =
    0;

  for (
    const [
      minute,
      levels
    ]
    of minuteMap
  ) {
    const levelArray =
      Array.from(
        levels.values()
      )
      .sort(
        (a, b) =>
          Number(a.p) -
          Number(b.p)
      )
      .map(
        level => ({
          p:
            level.p,

          buy:
            Number(
              level.buy.toFixed(
                8
              )
            ),

          sell:
            Number(
              level.sell.toFixed(
                8
              )
            ),

          total:
            Number(
              level.total.toFixed(
                8
              )
            ),

          delta:
            Number(
              (
                level.buy -
                level.sell
              ).toFixed(
                8
              )
            ),

          trades:
            level.trades
        })
      );

    const footprint =
      {
        m:
          minute,

        l:
          levelArray
      };

    const payload =
      JSON.stringify(
        footprint
      );

    const rawBytes =
      utf8ByteLength(
        payload
      );

    const gzipBytes =
      await gzipByteLength(
        payload
      );

    totalLevels +=
      levelArray.length;

    totalMinutes++;

    footprintRawTotal +=
      rawBytes;

    if (
      Number.isFinite(
        gzipBytes
      )
    ) {
      footprintGzipTotal +=
        gzipBytes;
    } else {
      gzipAvailable =
        false;
    }

    minuteTests.push({
      minute,

      iso:
        new Date(
          minute
        ).toISOString(),

      trades:
        levelArray.reduce(
          (
            sum,
            level
          ) =>
            sum +
            level.trades,
          0
        ),

      levels:
        levelArray.length,

      rawBytes,

      rawKB:
        bytesToKB(
          rawBytes
        ),

      rawMB:
        bytesToMB(
          rawBytes
        ),

      gzipBytes:
        Number.isFinite(
          gzipBytes
        )
          ? gzipBytes
          : null,

      gzipKB:
        Number.isFinite(
          gzipBytes
        )
          ? bytesToKB(
              gzipBytes
            )
          : null,

      gzipMB:
        Number.isFinite(
          gzipBytes
        )
          ? bytesToMB(
              gzipBytes
            )
          : null,

      compression:
        compressionInfo(
          rawBytes,
          gzipBytes
        )
    });
  }

  minuteTests.sort(
    (a, b) =>
      a.minute -
      b.minute
  );

  /*
   * =======================================================
   * BUILD COMPLETE HOUR PAYLOAD
   *
   * This represents the structure that can later be
   * stored as one hourly object/row.
   * =======================================================
   */

  const firstTradeTime =
    Math.min(
      ...trades.map(
        t =>
          t.time
      )
    );

  const lastTradeTime =
    Math.max(
      ...trades.map(
        t =>
          t.time
      )
    );

  const hourStart =
    hourStartOf(
      firstTradeTime
    );

  const hourPayload =
    {
      v:
        1,

      s:
        symbol,

      h:
        hourStart,

      m:
        minuteTests.map(
          item => ({
            t:
              item.minute,

            l:
              item.levels,

            b:
              item.rawBytes,

            g:
              item.gzipBytes
          })
        )
    };

  const hourPayloadText =
    JSON.stringify(
      hourPayload
    );

  const hourRawBytes =
    utf8ByteLength(
      hourPayloadText
    );

  const hourGzipBytes =
    await gzipByteLength(
      hourPayloadText
    );

  /*
   * =======================================================
   * AVERAGES
   * =======================================================
   */

  const averageLevelsPerMinute =
    totalMinutes > 0
      ? totalLevels /
        totalMinutes
      : 0;

  const averageRawPerMinute =
    totalMinutes > 0
      ? footprintRawTotal /
        totalMinutes
      : 0;

  const averageGzipPerMinute =
    totalMinutes > 0 &&
    gzipAvailable
      ? footprintGzipTotal /
        totalMinutes
      : null;

  /*
   * =======================================================
   * HOUR PROJECTION
   *
   * Uses actual Footprint minute data.
   * =======================================================
   */

  const estimatedHourRaw =
    averageRawPerMinute *
    60;

  const estimatedHourGzip =
    averageGzipPerMinute ===
    null
      ? null
      : averageGzipPerMinute *
        60;

  /*
   * =======================================================
   * 20,000 HOURLY ROW PROJECTION
   * =======================================================
   */

  const estimated20KRaw =
    estimatedHourRaw *
    MAX_ROWS;

  const estimated20KGzip =
    estimatedHourGzip ===
    null
      ? null
      : estimatedHourGzip *
        MAX_ROWS;

  /*
   * =======================================================
   * MULTI SYMBOL PROJECTION
   * =======================================================
   */

  const symbolCounts = [
    10,
    20,
    50,
    100,
    200,
    500
  ];

  const symbolStorage =
    symbolCounts.map(
      count => ({
        symbols:
          count,

        oneHourRawBytes:
          Math.round(
            estimatedHourRaw *
            count
          ),

        oneHourRawMB:
          bytesToMB(
            estimatedHourRaw *
            count
          ),

        oneHourGzipBytes:
          estimatedHourGzip ===
          null
            ? null
            : Math.round(
                estimatedHourGzip *
                count
              ),

        oneHourGzipMB:
          estimatedHourGzip ===
          null
            ? null
            : bytesToMB(
                estimatedHourGzip *
                count
              ),

        oneDayRawGB:
          bytesToGB(
            estimatedHourRaw *
            count *
            24
          ),

        oneDayGzipGB:
          estimatedHourGzip ===
          null
            ? null
            : bytesToGB(
                estimatedHourGzip *
                count *
                24
              ),

        oneMonthRawGB:
          bytesToGB(
            estimatedHourRaw *
            count *
            24 *
            30
          ),

        oneMonthGzipGB:
          estimatedHourGzip ===
          null
            ? null
            : bytesToGB(
                estimatedHourGzip *
                count *
                24 *
                30
              )
      })
    );

  /*
   * =======================================================
   * RETURN
   * =======================================================
   */

  return {
    ok:
      true,

    test:
      "FOOTPRINT_STORAGE_TEST",

    version:
      VERSION,

    symbol,

    source:
      "Bybit Linear Futures publicTrade",

    databaseWrite:
      false,

    databaseModified:
      false,

    readOnly:
      true,

    compression:
      "GZIP lossless",

    compressionAvailable:
      gzipAvailable,

    sample: {
      trades:
        trades.length,

      firstTradeTime,

      firstTradeISO:
        new Date(
          firstTradeTime
        ).toISOString(),

      lastTradeTime,

      lastTradeISO:
        new Date(
          lastTradeTime
        ).toISOString(),

      coveredMinutes:
        totalMinutes,

      footprintLevels:
        totalLevels,

      averageLevelsPerMinute:
        Number(
          averageLevelsPerMinute.toFixed(
            2
          )
        )
    },

    actualFootprint: {
      rawBytes:
        footprintRawTotal,

      rawKB:
        bytesToKB(
          footprintRawTotal
        ),

      rawMB:
        bytesToMB(
          footprintRawTotal
        ),

      gzipBytes:
        gzipAvailable
          ? footprintGzipTotal
          : null,

      gzipKB:
        gzipAvailable
          ? bytesToKB(
              footprintGzipTotal
            )
          : null,

      gzipMB:
        gzipAvailable
          ? bytesToMB(
              footprintGzipTotal
            )
          : null,

      compression:
        compressionInfo(
          footprintRawTotal,
          gzipAvailable
            ? footprintGzipTotal
            : null
        )
    },

    actualHourPayload: {
      hourStart,

      hourISO:
        new Date(
          hourStart
        ).toISOString(),

      rawBytes:
        hourRawBytes,

      rawKB:
        bytesToKB(
          hourRawBytes
        ),

      rawMB:
        bytesToMB(
          hourRawBytes
        ),

      gzipBytes:
        hourGzipBytes,

      gzipKB:
        hourGzipBytes === null
          ? null
          : bytesToKB(
              hourGzipBytes
            ),

      gzipMB:
        hourGzipBytes === null
          ? null
          : bytesToMB(
              hourGzipBytes
            ),

      compression:
        compressionInfo(
          hourRawBytes,
          hourGzipBytes
        )
    },

    estimatedHour: {
      model:
        "Actual Footprint minute structure projected to 60 minutes",

      rawBytes:
        Math.round(
          estimatedHourRaw
        ),

      rawKB:
        bytesToKB(
          estimatedHourRaw
        ),

      rawMB:
        bytesToMB(
          estimatedHourRaw
        ),

      gzipBytes:
        estimatedHourGzip ===
        null
          ? null
          : Math.round(
              estimatedHourGzip
            ),

      gzipKB:
        estimatedHourGzip ===
        null
          ? null
          : bytesToKB(
              estimatedHourGzip
            ),

      gzipMB:
        estimatedHourGzip ===
        null
          ? null
          : bytesToMB(
              estimatedHourGzip
            )
    },

    estimatedStorage: {
      model:
        "1 symbol + 1 hour = 1 row",

      maxRows:
        MAX_ROWS,

      rawBytes:
        Math.round(
          estimated20KRaw
        ),

      rawMB:
        bytesToMB(
          estimated20KRaw
        ),

      rawGB:
        bytesToGB(
          estimated20KRaw
        ),

      gzipBytes:
        estimated20KGzip ===
        null
          ? null
          : Math.round(
              estimated20KGzip
            ),

      gzipMB:
        estimated20KGzip ===
        null
          ? null
          : bytesToMB(
              estimated20KGzip
            ),

      gzipGB:
        estimated20KGzip ===
        null
          ? null
          : bytesToGB(
              estimated20KGzip
            )
    },

    symbolStorage,

    minuteTests,

    elapsedMs:
      Date.now() -
      startedAt,

    note:
      "Read-only test. Builds a real Footprint structure from Bybit trades in memory and measures serialized Raw/GZIP size. No Durable Object SQLite or external database is accessed."
  };
}

/* =========================================================
   ON-DEMAND MARKET DATA
========================================================= */

async function getMarket(
  symbol,
  interval
) {
  symbol =
    normalizeSymbol(symbol);

  interval =
    normalizeInterval(interval);

  const [
    klineResult,
    tickerResult,
    orderbookResult,
    tradeResult,
    instrumentResult
  ] = await Promise.all([
    bybit(
      "/v5/market/kline",
      {
        category:
          "linear",

        symbol,

        interval,

        limit:
          KLINE_LIMIT
      }
    ),

    bybit(
      "/v5/market/tickers",
      {
        category:
          "linear",

        symbol
      }
    ),

    bybit(
      "/v5/market/orderbook",
      {
        category:
          "linear",

        symbol,

        limit:
          ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category:
          "linear",

        symbol,

        limit:
          TRADE_LIMIT
      }
    ),

    bybit(
      "/v5/market/instruments-info",
      {
        category:
          "linear",

        symbol
      }
    )
  ]);

  const candles =
    parseKlines(
      klineResult?.list
    );

  const trades =
    parseTrades(
      tradeResult?.list
    );

  const ticker =
    Array.isArray(
      tickerResult?.list
    )
      ? tickerResult.list[0]
      : null;

  const instrument =
    Array.isArray(
      instrumentResult?.list
    )
      ? instrumentResult.list[0]
      : null;

  const tickSize =
    safeNumber(
      instrument
        ?.priceFilter
        ?.tickSize,
      0
    );

  const stats =
    tradeStats(
      trades
    );

  const footprint =
    aggregateFootprint(
      trades,
      tickSize
    );

  const orderbook =
    orderbookStats(
      orderbookResult
    );

  const absorption =
    detectAbsorption(
      trades,
      candles,
      orderbook
    );

  return {
    version:
      VERSION,

    symbol,

    interval,

    candles,

    trades,

    ticker,

    stats,

    footprint,

    orderbook,

    absorption,

    instrument: {
      tickSize,

      minOrderQty:
        safeNumber(
          instrument
            ?.lotSizeFilter
            ?.minOrderQty,
          0
        )
    }
  };
}

/* =========================================================
   DURABLE OBJECT BINDINGS
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR_V5
  ) {
    throw new Error(
      "TRADE_COLLECTOR_V5 binding پیدا نشد"
    );
  }

  return env
    .TRADE_COLLECTOR_V5
    .idFromName(
      "absorption-storage-v5-global"
    );
}

function collectorStub(env) {
  return env
    .TRADE_COLLECTOR_V5
    .get(
      collectorId(env)
    );
}

/* =========================================================
   LEGACY TRADE COLLECTOR
========================================================= */

export class TradeCollector {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    return json({
      ok: true,

      legacy: true,

      collector:
        "TradeCollector",

      writeEnabled:
        false,

      message:
        "Legacy storage preserved. New writes disabled.",

      path:
        url.pathname,

      version:
        VERSION
    });
  }

  async alarm() {
    return;
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];

    this.symbolMeta =
      new Map();

    this.subscribed =
      new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;
    this.wsStartedAt = 0;

    this.lastError = "";

    this.reconnectAttempt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.alarmScheduled = false;

    this.dbInitialized = false;
    this.tableExists = null;

    this.hourBlocks =
      new Map();

    this.dedupe =
      new Map();

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks =
      false;

    this.checkpointRunning =
      false;

    this.lastCheckpointAt = 0;

    this.totalMessages = 0;
    this.totalTrades = 0;
    this.totalDuplicates = 0;
    this.totalInvalidTrades = 0;
    this.totalPersistedBlocks = 0;
    this.totalDeletedRows = 0;
  }

  /* =======================================================
     DATABASE DETECTION
  ======================================================= */

  initDB() {
    if (
      this.dbInitialized
    ) {
      return;
    }

    const sql =
      this.state.storage.sql;

    try {
      const rows =
        sql
          .exec(
            `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            AND name = ?
            LIMIT 1
            `,
            TABLE_NAME
          )
          .toArray();

      this.tableExists =
        rows.length > 0;
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      this.tableExists =
        false;
    }

    this.dbInitialized =
      true;
  }

  /* =======================================================
     CREATE STORAGE ONLY ON REAL CHECKPOINT
======================================================= */

  ensureDBForWrite() {
    if (
      this.tableExists === true
    ) {
      return;
    }

    const sql =
      this.state.storage.sql;

    sql.exec(
      `
      CREATE TABLE IF NOT EXISTS hour_blocks_v5 (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, hour_start)
      )
      `
    );

    this.tableExists =
      true;

    this.dbInitialized =
      true;
  }

  /* =======================================================
     ROW COUNT
======================================================= */

  getRowCount() {
    this.initDB();

    if (
      this.tableExists !== true
    ) {
      return 0;
    }

    try {
      const rows =
        this.state.storage.sql
          .exec(
            `
            SELECT COUNT(*) AS count
            FROM hour_blocks_v5
            `
          )
          .toArray();

      return Number(
        rows[0]?.count || 0
      );
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      return 0;
    }
  }

  /* =======================================================
     CAPACITY
======================================================= */

  enforceCapacity() {
    this.initDB();

    if (
      this.tableExists !== true
    ) {
      return {
        deleted: 0,
        rows: 0,
        tableExists: false,
        protectedCurrentHour: true
      };
    }

    const count =
      this.getRowCount();

    if (
      count < MAX_ROWS
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    const target =
      Math.max(
        0,
        Math.min(
          CLEANUP_TARGET_ROWS,
          MAX_ROWS - 1
        )
      );

    const deleteCount =
      Math.max(
        0,
        count - target
      );

    if (
      deleteCount <= 0
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    const currentHour =
      hourStartOf(
        Date.now()
      );

    const availableRows =
      this.state.storage.sql
        .exec(
          `
          SELECT COUNT(*) AS count
          FROM hour_blocks_v5
          WHERE hour_start < ?
          `,
          currentHour
        )
        .toArray();

    const deletable =
      Number(
        availableRows[0]?.count ||
        0
      );

    const actualDelete =
      Math.min(
        deleteCount,
        deletable
      );

    if (
      actualDelete <= 0
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    this.state.storage.sql.exec(
      `
      DELETE FROM hour_blocks_v5
      WHERE rowid IN (
        SELECT rowid
        FROM hour_blocks_v5
        WHERE hour_start < ?
        ORDER BY hour_start ASC, rowid ASC
        LIMIT ${actualDelete}
      )
      `,
      currentHour
    );

    this.totalDeletedRows +=
      actualDelete;

    this.lastCleanupAt =
      Date.now();

    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (
        block.hourStart <
        currentHour
      ) {
        this.hourBlocks.delete(
          key
        );
      }
    }

    const newCount =
      this.getRowCount();

    return {
      deleted:
        actualDelete,

      rows:
        newCount,

      protectedCurrentHour:
        true
    };
  }

  /* =======================================================
     LOAD RECENT BLOCKS
======================================================= */

  loadRecentBlocks() {
    if (
      this.loadedRecentBlocks
    ) {
      return;
    }

    this.initDB();

    if (
      this.tableExists !== true
    ) {
      this.loadedRecentBlocks =
        true;

      return;
    }

    const now =
      Date.now();

    const currentHour =
      hourStartOf(now);

    const from =
      currentHour -
      2 * HOUR_MS;

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM hour_blocks_v5
          WHERE hour_start >= ?
          ORDER BY hour_start ASC
          `,
          from
        )
        .toArray();

    for (const row of rows) {
      try {
        const block =
          this.deserializeBlock(
            row
          );

        if (!block) {
          continue;
        }

        this.hourBlocks.set(
          `${block.symbol}:${block.hourStart}`,
          block
        );
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }
    }

    this.loadedRecentBlocks =
      true;
  }

  /* =======================================================
     BLOCKS
======================================================= */

  createBlock(
    symbol,
    hourStart
  ) {
    return {
      v: 1,

      symbol,

      hourStart,

      hourEnd:
        hourStart +
        HOUR_MS,

      candles:
        new Map(),

      dirty: true,

      loaded: false
    };
  }

  getOrCreateBlock(
    symbol,
    hourStart
  ) {
    const key =
      `${symbol}:${hourStart}`;

    let block =
      this.hourBlocks.get(
        key
      );

    if (!block) {
      block =
        this.createBlock(
          symbol,
          hourStart
        );

      this.hourBlocks.set(
        key,
        block
      );
    }

    return block;
  }

  currentHourForSymbol(
    symbol
  ) {
    let latest = null;

    for (
      const block
      of this.hourBlocks.values()
    ) {
      if (
        block.symbol !==
        symbol
      ) {
        continue;
      }

      if (
        latest === null ||
        block.hourStart >
          latest
      ) {
        latest =
          block.hourStart;
      }
    }

    return latest;
  }

  /* =======================================================
     TRADE AGGREGATION
======================================================= */

  aggregateTrade(
    trade
  ) {
    const symbol =
      normalizeSymbol(
        trade.symbol
      );

    const hourStart =
      hourStartOf(
        trade.time
      );

    const minuteStart =
      minuteStartOf(
        trade.time
      );

    const block =
      this.getOrCreateBlock(
        symbol,
        hourStart
      );

    let candle =
      block.candles.get(
        minuteStart
      );

    if (!candle) {
      candle = {
        m: minuteStart,

        o: trade.price,
        h: trade.price,
        l: trade.price,
        c: trade.price,

        v: 0,
        t: 0,

        b: 0,
        s: 0,

        bv: 0,
        sv: 0,

        bt: 0,
        st: 0,

        ot: trade.time,
        ct: trade.time,

        levels:
          new Map()
      };

      block.candles.set(
        minuteStart,
        candle
      );
    }

    candle.h =
      Math.max(
        candle.h,
        trade.price
      );

    candle.l =
      Math.min(
        candle.l,
        trade.price
      );

    candle.c =
      trade.price;

    candle.v +=
      trade.size;

    candle.t +=
      trade.value;

    candle.ct =
      Math.max(
        candle.ct,
        trade.time
      );

    if (
      trade.side === "BUY"
    ) {
      candle.b +=
        trade.value;

      candle.bv +=
        trade.size;

      candle.bt++;
    } else if (
      trade.side === "SELL"
    ) {
      candle.s +=
        trade.value;

      candle.sv +=
        trade.size;

      candle.st++;
    }

    const meta =
      this.symbolMeta.get(
        symbol
      );

    const tickSize =
      safeNumber(
        meta?.tickSize,
        0
      );

    const price =
      roundToTick(
        trade.price,
        tickSize
      );

    let level =
      candle.levels.get(
        price
      );

    if (!level) {
      level = {
        price,

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        buyTrades: 0,
        sellTrades: 0
      };

      candle.levels.set(
        price,
        level
      );
    }

    if (
      trade.side === "BUY"
    ) {
      level.buyVolume +=
        trade.size;

      level.buyValue +=
        trade.value;

      level.buyTrades++;
    } else if (
      trade.side === "SELL"
    ) {
      level.sellVolume +=
        trade.size;

      level.sellValue +=
        trade.value;

      level.sellTrades++;
    }

    block.dirty =
      true;
  }

  /* =======================================================
     SERIALIZE
======================================================= */

  serializeBlock(
    block
  ) {
    const candles =
      [
        ...block.candles.values()
      ]
        .sort(
          (a, b) =>
            a.m - b.m
        )
        .map(
          candle => ({
            m: candle.m,

            o: candle.o,
            h: candle.h,
            l: candle.l,
            c: candle.c,

            v: candle.v,
            t: candle.t,

            b: candle.b,
            s: candle.s,

            bv: candle.bv,
            sv: candle.sv,

            bt: candle.bt,
            st: candle.st,

            ot: candle.ot,
            ct: candle.ct,

            lvs:
              [
                ...candle.levels.values()
              ]
                .sort(
                  (a, b) =>
                    a.price -
                    b.price
                )
                .map(
                  level => [
                    level.price,

                    level.buyVolume,
                    level.sellVolume,

                    level.buyValue,
                    level.sellValue,

                    level.buyTrades,
                    level.sellTrades
                  ]
                )
          })
        );

    return JSON.stringify({
      v: 1,

      s:
        block.symbol,

      h:
        block.hourStart,

      c:
        candles
    });
  }

  /* =======================================================
     DESERIALIZE
======================================================= */

  deserializeBlock(
    row
  ) {
    const raw =
      typeof row.data ===
      "string"
        ? JSON.parse(
            row.data
          )
        : row.data;

    const block = {
      v:
        Number(
          raw.v || 1
        ),

      symbol:
        normalizeSymbol(
          raw.s ||
          row.symbol
        ),

      hourStart:
        Number(
          raw.h ||
          row.hour_start
        ),

      hourEnd:
        Number(
          raw.h ||
          row.hour_start
        ) +
        HOUR_MS,

      candles:
        new Map(),

      dirty: false,

      loaded: true
    };

    const candles =
      Array.isArray(raw.c)
        ? raw.c
        : [];

    for (
      const item
      of candles
    ) {
      const candle = {
        m:
          Number(item.m),

        o:
          Number(item.o),

        h:
          Number(item.h),

        l:
          Number(item.l),

        c:
          Number(item.c),

        v:
          Number(item.v || 0),

        t:
          Number(item.t || 0),

        b:
          Number(item.b || 0),

        s:
          Number(item.s || 0),

        bv:
          Number(item.bv || 0),

        sv:
          Number(item.sv || 0),

        bt:
          Number(item.bt || 0),

        st:
          Number(item.st || 0),

        ot:
          Number(
            item.ot ||
            item.m
          ),

        ct:
          Number(
            item.ct ||
            item.m
          ),

        levels:
          new Map()
      };

      const levels =
        Array.isArray(
          item.lvs
        )
          ? item.lvs
          : [];

      for (
        const lv
        of levels
      ) {
        if (
          !Array.isArray(lv)
        ) {
          continue;
        }

        const price =
          Number(lv[0]);

        candle.levels.set(
          price,
          {
            price,

            buyVolume:
              Number(
                lv[1] || 0
              ),

            sellVolume:
              Number(
                lv[2] || 0
              ),

            buyValue:
              Number(
                lv[3] || 0
              ),

            sellValue:
              Number(
                lv[4] || 0
              ),

            buyTrades:
              Number(
                lv[5] || 0
              ),

            sellTrades:
              Number(
                lv[6] || 0
              )
          }
        );
      }

      block.candles.set(
        candle.m,
        candle
      );
    }

    return block;
  }

  /* =======================================================
     CLOSED HOUR CHECKPOINT
======================================================= */

  persistClosedBlocks() {
    if (
      this.checkpointRunning
    ) {
      return {
        written: 0,
        rows:
          this.getRowCount()
      };
    }

    this.checkpointRunning =
      true;

    try {
      this.initDB();

      const now =
        Date.now();

      const currentHour =
        hourStartOf(now);

      const sql =
        this.state.storage.sql;

      let written = 0;

      let writeTableReady =
        this.tableExists === true;

      for (
        const [
          key,
          block
        ]
        of this.hourBlocks
      ) {
        if (
          block.hourStart >=
          currentHour
        ) {
          continue;
        }

        if (!block.dirty) {
          continue;
        }

        if (
          !block.candles.size
        ) {
          block.dirty =
            false;

          continue;
        }

        if (
          !writeTableReady
        ) {
          this.ensureDBForWrite();

          writeTableReady =
            true;
        }

        const data =
          this.serializeBlock(
            block
          );

        sql.exec(
          `
          INSERT INTO hour_blocks_v5
          (
            symbol,
            hour_start,
            data,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(symbol, hour_start)
          DO UPDATE SET
            data=excluded.data,
            updated_at=excluded.updated_at
          `,
          block.symbol,
          block.hourStart,
          data,
          now
        );

        block.dirty =
          false;

        written++;

        this.totalPersistedBlocks++;
      }

      this.lastCheckpointAt =
        now;

      const removeBefore =
        currentHour -
        HOUR_MS;

      for (
        const [
          key,
          block
        ]
        of this.hourBlocks
      ) {
        if (
          block.hourStart <
          removeBefore
        ) {
          this.hourBlocks.delete(
            key
          );
        }
      }

      if (written > 0) {
        this.enforceCapacity();
      }

      return {
        written,

        rows:
          this.getRowCount()
      };
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      return {
        written: 0,

        rows:
          this.getRowCount(),

        error:
          this.lastError
      };
    } finally {
      this.checkpointRunning =
        false;
    }
  }

  /* =======================================================
     DEDUPE
======================================================= */

  isDuplicate(
    trade
  ) {
    const id =
      String(
        trade.id || ""
      );

    if (!id) {
      return false;
    }

    if (
      this.dedupe.has(id)
    ) {
      this.totalDuplicates++;

      return true;
    }

    this.dedupe.set(
      id,
      Date.now()
    );

    if (
      this.dedupe.size >
      60000
    ) {
      const cutoff =
        Date.now() -
        5 * 60 * 1000;

      for (
        const [
          key,
          time
        ]
        of this.dedupe
      ) {
        if (
          time < cutoff
        ) {
          this.dedupe.delete(
            key
          );
        }
      }

      if (
        this.dedupe.size >
        60000
      ) {
        const first =
          this.dedupe
            .keys()
            .next()
            .value;

        if (first) {
          this.dedupe.delete(
            first
          );
        }
      }
    }

    return false;
  }

  /* =======================================================
     WS TRADE PARSER
======================================================= */

  parseWsTrade(row) {
    const price =
      safeNumber(row.p);

    const size =
      safeNumber(row.v);

    const time =
      safeNumber(
        row.T ||
        row.ts ||
        Date.now()
      );

    return {
      symbol:
        normalizeSymbol(
          row.s
        ),

      id:
        String(
          row.i ||
          row.execId ||
          `${time}-${price}-${size}-${row.S || ""}`
        ),

      time,

      price,

      size,

      value:
        price * size,

      side:
        String(
          row.S || ""
        ).toUpperCase()
    };
  }

  /* =======================================================
     WS MESSAGE
======================================================= */

  handleMessage(
    raw
  ) {
    this.lastMessageAt =
      Date.now();

    this.totalMessages++;

    let message;

    try {
      message =
        JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (
      message.op ===
      "pong"
    ) {
      return;
    }

    if (
      message.success ===
      false
    ) {
      this.lastError =
        message.ret_msg ||
        message.retMsg ||
        "WebSocket error";

      return;
    }

    const topic =
      String(
        message.topic || ""
      );

    if (
      !topic.startsWith(
        "publicTrade."
      )
    ) {
      return;
    }

    const rows =
      Array.isArray(
        message.data
      )
        ? message.data
        : [];

    let crossedHour =
      false;

    for (
      const row
      of rows
    ) {
      const trade =
        this.parseWsTrade(
          row
        );

      if (
        !trade.symbol ||
        !trade.time ||
        trade.price <= 0 ||
        trade.size <= 0 ||
        ![
          "BUY",
          "SELL"
        ].includes(
          trade.side
        )
      ) {
        this.totalInvalidTrades++;

        continue;
      }

      if (
        this.isDuplicate(
          trade
        )
      ) {
        continue;
      }

      const before =
        this.currentHourForSymbol(
          trade.symbol
        );

      this.aggregateTrade(
        trade
      );

      const after =
        hourStartOf(
          trade.time
        );

      if (
        before !== null &&
        before !== after
      ) {
        crossedHour =
          true;
      }

      this.lastTradeAt =
        Date.now();

      this.totalTrades++;
    }

    if (crossedHour) {
      try {
        this.persistClosedBlocks();
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }
    }
  }

  /* =======================================================
     SUBSCRIBE
======================================================= */

  async subscribeAll() {
    if (
      !this.ws ||
      this.ws.readyState !== 1
    ) {
      return;
    }

    this.subscribed.clear();

    const args =
      this.symbols.map(
        item =>
          `publicTrade.${item.symbol}`
      );

    const chunks = [];

    let current = [];
    let length = 0;

    for (
      const topic
      of args
    ) {
      const extra =
        topic.length + 3;

      if (
        current.length >= 100 ||
        length + extra > 16000
      ) {
        chunks.push(
          current
        );

        current = [];
        length = 0;
      }

      current.push(topic);

      length += extra;
    }

    if (
      current.length
    ) {
      chunks.push(
        current
      );
    }

    for (
      const chunk
      of chunks
    ) {
      try {
        this.ws.send(
          JSON.stringify({
            op:
              "subscribe",

            args:
              chunk
          })
        );

        for (
          const topic
          of chunk
        ) {
          this.subscribed.add(
            topic
          );
        }

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              100
            )
        );
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }
    }
  }

  /* =======================================================
     PING
======================================================= */

  startPing() {
    this.stopPing();

    this.pingTimer =
      setInterval(
        () => {
          try {
            if (
              this.ws &&
              this.ws.readyState ===
                1
            ) {
              this.ws.send(
                JSON.stringify({
                  op:
                    "ping"
                })
              );
            }
          } catch (_) {}
        },
        20000
      );
  }

  stopPing() {
    if (
      this.pingTimer
    ) {
      clearInterval(
        this.pingTimer
      );

      this.pingTimer =
        null;
    }
  }

  /* =======================================================
     CONNECT
======================================================= */

  async connect() {
    if (!this.started) {
      return;
    }

    if (
      this.ws &&
      (
        this.ws.readyState === 0 ||
        this.ws.readyState === 1
      )
    ) {
      return;
    }

    try {
      this.symbols =
        await getBybitSymbols();

      this.symbolMeta.clear();

      for (
        const item
        of this.symbols
      ) {
        this.symbolMeta.set(
          item.symbol,
          item
        );
      }

      if (
        !this.symbols.length
      ) {
        throw new Error(
          "هیچ قرارداد Futures USDT در Bybit پیدا نشد"
        );
      }

      this.ws =
        new WebSocket(
          BYBIT_WS
        );

      this.wsStartedAt =
        Date.now();

      this.ws.addEventListener(
        "open",
        async () => {
          this.connected =
            true;

          this.reconnectAttempt =
            0;

          this.lastError =
            "";

          try {
            await this.subscribeAll();
          } catch (error) {
            this.lastError =
              String(
                error?.message ||
                error
              );
          }

          this.startPing();

          this.scheduleAlarm();
        }
      );

      this.ws.addEventListener(
        "message",
        event => {
          try {
            this.handleMessage(
              event.data
            );
          } catch (error) {
            this.lastError =
              String(
                error?.message ||
                error
              );
          }
        }
      );

      this.ws.addEventListener(
        "close",
        () => {
          this.connected =
            false;

          this.stopPing();

          if (
            this.started
          ) {
            this.scheduleReconnect();
          }
        }
      );

      this.ws.addEventListener(
        "error",
        () => {
          this.lastError =
            "Bybit WebSocket error";

          this.connected =
            false;
        }
      );
    } catch (error) {
      this.connected =
        false;

      this.lastError =
        String(
          error?.message ||
          error
        );

      this.scheduleReconnect();
    }
  }

  /* =======================================================
     RECONNECT
======================================================= */

  scheduleReconnect() {
    if (!this.started) {
      return;
    }

    if (
      this.reconnectTimer
    ) {
      return;
    }

    this.reconnectAttempt++;

    const delay =
      Math.min(
        30000,
        1000 *
          Math.pow(
            2,
            Math.min(
              this.reconnectAttempt,
              5
            )
          )
      );

    this.reconnectTimer =
      setTimeout(
        async () => {
          this.reconnectTimer =
            null;

          await this.connect();
        },
        delay
      );
  }

  /* =======================================================
     REFRESH SYMBOLS
======================================================= */

  async refreshSymbols() {
    const list =
      await getBybitSymbols();

    this.symbols =
      list;

    this.symbolMeta.clear();

    for (
      const item
      of list
    ) {
      this.symbolMeta.set(
        item.symbol,
        item
      );
    }

    if (
      this.connected
    ) {
      try {
        await this.subscribeAll();
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }
    }

    return {
      count:
        this.symbols.length
    };
  }

  /* =======================================================
     ALARM
======================================================= */

  scheduleAlarm() {
    if (
      this.alarmScheduled
    ) {
      return;
    }

    this.alarmScheduled =
      true;

    try {
      this.state.storage.setAlarm(
        Date.now() +
          ALARM_MS
      );
    } catch (error) {
      this.alarmScheduled =
        false;

      this.lastError =
        String(
          error?.message ||
          error
        );
    }
  }

  async alarm() {
    this.alarmScheduled =
      false;

    try {
      this.initDB();

      this.loadRecentBlocks();

      this.persistClosedBlocks();

      try {
        await this.refreshSymbols();
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }

      if (
        !this.connected &&
        this.started
      ) {
        await this.connect();
      }

      if (
        this.connected &&
        this.ws &&
        this.ws.readyState === 1
      ) {
        await this.subscribeAll();
      }
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }

    this.scheduleAlarm();
  }

  /* =======================================================
     START
======================================================= */

  async start() {
    this.started =
      true;

    this.initDB();

    this.loadRecentBlocks();

    try {
      await this.refreshSymbols();
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }

    if (
      !this.connected
    ) {
      await this.connect();
    }

    if (
      this.tableExists === true
    ) {
      this.enforceCapacity();
    }

    this.scheduleAlarm();

    return this.statusObject();
  }

/* ======================================================
   STATUS
======================================================= */

  async storageTest() {
    const now =
      Date.now();

    const currentHour =
      hourStartOf(now);

    const currentMinute =
      minuteStartOf(now);

    const currentBlocks = [];
    const dataSymbols =
      new Set();

    let totalCandles = 0;
    let totalLevels = 0;

    const minuteSet =
      new Set();

    /*
      فقط RAM:
      هیچ initDB()
      هیچ SQL
      هیچ write
      هیچ mutation
    */
    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (
        !block ||
        block.hourStart !==
          currentHour
      ) {
        continue;
      }

      if (
        !block.candles ||
        !block.candles.size
      ) {
        continue;
      }

      dataSymbols.add(
        block.symbol
      );

      totalCandles +=
        block.candles.size;

      for (
        const [
          minute,
          candle
        ]
        of block.candles
      ) {
        minuteSet.add(
          Number(minute)
        );

        if (
          candle &&
          candle.levels
        ) {
          totalLevels +=
            candle.levels.size;
        }
      }

      let serialized;

      try {
        serialized =
          this.serializeBlock(
            block
          );

        if (
          typeof serialized ===
          "string"
        ) {
          serialized =
            JSON.parse(
              serialized
            );
        }
      } catch (error) {
        serialized = {
          error:
            String(
              error?.message ||
              error
            )
        };
      }

      currentBlocks.push(
        serialized
      );
    }

    /*
      PAYLOAD واقعی ساعت جاری
    */
    const hourPayload =
      JSON.stringify({
        v: 1,

        type:
          "RAM_HOUR_TEST",

        hour:
          currentHour,

        blocks:
          currentBlocks
      });

    const hourRawBytes =
      utf8ByteLength(
        hourPayload
      );

    const hourGzipBytes =
      await gzipByteLength(
        hourPayload
      );

    /*
      PAYLOAD دقیقه جاری
      با همان serializeBlock واقعی
    */
    const currentMinuteBlocks =
      [];

    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (
        !block ||
        block.hourStart !==
          currentHour
      ) {
        continue;
      }

      if (
        !block.candles ||
        !block.candles.has(
          currentMinute
        )
      ) {
        continue;
      }

      const candle =
        block.candles.get(
          currentMinute
        );

      if (!candle) {
        continue;
      }

      const tempBlock = {
        ...block,

        candles:
          new Map([
            [
              currentMinute,
              candle
            ]
          ])
      };

      try {
        let serialized =
          this.serializeBlock(
            tempBlock
          );

        if (
          typeof serialized ===
          "string"
        ) {
          serialized =
            JSON.parse(
              serialized
            );
        }

        currentMinuteBlocks.push(
          serialized
        );
      } catch (error) {
        currentMinuteBlocks.push({
          error:
            String(
              error?.message ||
              error
            )
        });
      }
    }

    let minuteRawBytes = 0;
    let minuteGzipBytes = 0;

    if (
      currentMinuteBlocks.length
    ) {
      const minutePayload =
        JSON.stringify({
          v: 1,

          type:
            "RAM_MINUTE_TEST",

          minute:
            currentMinute,

          blocks:
            currentMinuteBlocks
        });

      minuteRawBytes =
        utf8ByteLength(
          minutePayload
        );

      minuteGzipBytes =
        await gzipByteLength(
          minutePayload
        );
    }

    /*
      اندازه واقعی RAM از دید payload
    */
    const observedMinutes =
      Math.max(
        1,
        minuteSet.size
      );

    const hourElapsedMinutes =
      Math.max(
        1,
        Math.min(
          60,
          Math.ceil(
            (
              now -
              currentHour
            ) /
            MINUTE_MS
          )
        )
      );

    /*
      تخمین یک ساعت کامل بر اساس
      داده واقعی جمع‌شده تا این لحظه
    */
    const estimatedFullHourRaw =
      Math.ceil(
        hourRawBytes *
        (
          60 /
          hourElapsedMinutes
        )
      );

    const estimatedFullHourGzip =
      Math.ceil(
        hourGzipBytes *
        (
          60 /
          hourElapsedMinutes
        )
      );

    const projected24hRaw =
      estimatedFullHourRaw *
      24;

    const projected24hGzip =
      estimatedFullHourGzip *
      24;

    const projected7dRaw =
      estimatedFullHourRaw *
      24 *
      7;

    const projected7dGzip =
      estimatedFullHourGzip *
      24 *
      7;

    const projected30dRaw =
      estimatedFullHourRaw *
      24 *
      30;

    const projected30dGzip =
      estimatedFullHourGzip *
      24 *
      30;

    const compressionRatio =
      hourGzipBytes > 0
        ? (
            hourRawBytes /
            hourGzipBytes
          )
        : 0;

    const compressionSavingPercent =
      hourRawBytes > 0
        ? (
            1 -
            (
              hourGzipBytes /
              hourRawBytes
            )
          ) *
          100
        : 0;

    return {
      ok: true,

      test:
        "ABSORPTION-RAM-STORAGE-TEST",

      source:
        "AbsorptionStorageV5.hourBlocks",

      timestamp:
        now,

      databaseWrite:
        false,

      databaseModified:
        false,

      readOnly:
        true,

      collector: {
        started:
          this.started,

        connected:
          this.connected,

        configuredSymbols:
          this.symbols.length,

        subscribedTopics:
          this.subscribed.size,

        symbolsWithCurrentHourData:
          dataSymbols.size,

        symbols:
          Array.from(
            dataSymbols
          )
      },

      currentHour: {
        hourStart:
          currentHour,

        hourStartISO:
          new Date(
            currentHour
          ).toISOString(),

        hourBlocks:
          currentBlocks.length,

        minutesWithData:
          minuteSet.size,

        candles:
          totalCandles,

        footprintLevels:
          totalLevels,

        elapsedMinutes:
          hourElapsedMinutes,

        observedMinutes:
          observedMinutes
      },

      currentMinute: {
        minuteStart:
          currentMinute,

        minuteStartISO:
          new Date(
            currentMinute
          ).toISOString(),

        blocks:
          currentMinuteBlocks.length,

        rawBytes:
          minuteRawBytes,

        gzipBytes:
          minuteGzipBytes,

        rawKB:
          bytesToKB(
            minuteRawBytes
          ),

        gzipKB:
          bytesToKB(
            minuteGzipBytes
          )
      },

      measuredCurrentHour: {
        rawBytes:
          hourRawBytes,

        gzipBytes:
          hourGzipBytes,

        rawKB:
          bytesToKB(
            hourRawBytes
          ),

        rawMB:
          bytesToMB(
            hourRawBytes
          ),

        gzipKB:
          bytesToKB(
            hourGzipBytes
          ),

        gzipMB:
          bytesToMB(
            hourGzipBytes
          ),

        compressionRatio:
          Number(
            compressionRatio.toFixed(
              3
            )
          ),

        compressionSavingPercent:
          Number(
            compressionSavingPercent.toFixed(
              2
            )
          )
      },

      estimatedFullHour: {
        rawBytes:
          estimatedFullHourRaw,

        gzipBytes:
          estimatedFullHourGzip,

        rawMB:
          bytesToMB(
            estimatedFullHourRaw
          ),

        gzipMB:
          bytesToMB(
            estimatedFullHourGzip
          )
      },

      projection: {
        basis:
          "measured RAM current-hour data",

        warning:
          "Projection is an estimate because the current hour may be incomplete.",

        hours24: {
          rawBytes:
            projected24hRaw,

          gzipBytes:
            projected24hGzip,

          rawMB:
            bytesToMB(
              projected24hRaw
            ),

          gzipMB:
            bytesToMB(
              projected24hGzip
            )
        },

        days7: {
          rawBytes:
            projected7dRaw,

          gzipBytes:
            projected7dGzip,

          rawMB:
            bytesToMB(
              projected7dRaw
            ),

          gzipMB:
            bytesToMB(
              projected7dGzip
            ),

          gzipGB:
            bytesToGB(
              projected7dGzip
            )
        },

        days30: {
          rawBytes:
            projected30dRaw,

          gzipBytes:
            projected30dGzip,

          rawMB:
            bytesToMB(
              projected30dRaw
            ),

          gzipMB:
            bytesToMB(
              projected30dGzip
            ),

          gzipGB:
            bytesToGB(
              projected30dGzip
            )
        }
      }
    };
  }


  statusObject() {
    let rows = 0;
    let dbError = "";

    try {
      rows =
        this.getRowCount();
    } catch (error) {
      dbError =
        String(
          error?.message ||
          error
        );
    }

    return {
      ok: true,

      version:
        VERSION,

      collector:
        "AbsorptionStorageV5",

      started:
        this.started,

      connected:
        this.connected,

      symbols:
        this.symbols.length,

      subscribed:
        this.subscribed.size,

      lastMessageAt:
        this.lastMessageAt,

      lastTradeAt:
        this.lastTradeAt,

      wsStartedAt:
        this.wsStartedAt,

      reconnectAttempt:
        this.reconnectAttempt,

      lastError:
        this.lastError,

      dbError,

      counters: {
        totalMessages:
          this.totalMessages,

        totalTrades:
          this.totalTrades,

        totalDuplicates:
          this.totalDuplicates,

        totalInvalidTrades:
          this.totalInvalidTrades,

        totalPersistedBlocks:
          this.totalPersistedBlocks,

        totalDeletedRows:
          this.totalDeletedRows
      },

      storage:
        "Durable Object SQLite",

      storageName:
        "AbsorptionStorageV5",

      table:
        TABLE_NAME,

      tableExists:
        this.tableExists === true,

      storageModel:
        "1 row = 1 symbol + 1 hour",

      maxRows:
        MAX_ROWS,

      currentRows:
        rows,

      cleanupTarget:
        CLEANUP_TARGET_ROWS,

      checkpoint:
        "closed hour only",

      currentHour:
        "RAM only until hour closes",

      history:
        "rolling 20000 hour blocks",

      currentHourProtected:
        true,

      oldStorage:
        "preserved / new writes disabled",

      symbolSource:
        "Bybit Linear USDT Perpetual",

      marketData:
        "Bybit",

      hourBlocksInMemory:
        this.hourBlocks.size,

      lastCleanupAt:
        this.lastCleanupAt,

      lastCheckpointAt:
        this.lastCheckpointAt,

      alarmIntervalMs:
        ALARM_MS,

      writePolicy:
        "no startup DB write; closed hour only",

      now:
        Date.now()
    };
  }

  /* =======================================================
     HISTORY
======================================================= */

  getHistory(
    symbol,
    from,
    to
  ) {
    this.initDB();

    symbol =
      normalizeSymbol(
        symbol
      );

    const start =
      Number(from) ||
      Date.now() -
        24 * HOUR_MS;

    const end =
      Number(to) ||
      Date.now();

    const firstHour =
      hourStartOf(start);

    const lastHour =
      hourStartOf(end);

    const blocks =
      new Map();

    if (
      this.tableExists === true
    ) {
      const rows =
        this.state.storage.sql
          .exec(
            `
            SELECT
              symbol,
              hour_start,
              data,
              updated_at
            FROM hour_blocks_v5
            WHERE symbol = ?
            AND hour_start >= ?
            AND hour_start <= ?
            ORDER BY hour_start ASC
            `,
            symbol,
            firstHour,
            lastHour
          )
          .toArray();

      for (
        const row
        of rows
      ) {
        try {
          const block =
            this.deserializeBlock(
              row
            );

          blocks.set(
            block.hourStart,
            block
          );
        } catch (_) {}
      }
    }

    for (
      const block
      of this.hourBlocks.values()
    ) {
      if (
        block.symbol !==
        symbol
      ) {
        continue;
      }

      if (
        block.hourStart <
          firstHour ||
        block.hourStart >
          lastHour
      ) {
        continue;
      }

      blocks.set(
        block.hourStart,
        block
      );
    }

    const candles = [];

    for (
      const block
      of [
        ...blocks.values()
      ].sort(
        (a, b) =>
          a.hourStart -
          b.hourStart
      )
    ) {
      for (
        const candle
        of block.candles.values()
      ) {
        if (
          candle.m < start ||
          candle.m > end
        ) {
          continue;
        }

        const buyVolume =
          candle.bv;

        const sellVolume =
          candle.sv;

        candles.push({
          time:
            candle.m,

          open:
            candle.o,

          high:
            candle.h,

          low:
            candle.l,

          close:
            candle.c,

          volume:
            candle.v,

          turnover:
            candle.t,

          buyVolume,

          sellVolume,

          buyValue:
            candle.b,

          sellValue:
            candle.s,

          buyTrades:
            candle.bt,

          sellTrades:
            candle.st,

          delta:
            buyVolume -
            sellVolume,

          deltaValue:
            candle.b -
            candle.s
        });
      }
    }

    candles.sort(
      (a, b) =>
        a.time -
        b.time
    );

    return {
      version:
        VERSION,

      symbol,

      from:
        start,

      to:
        end,

      candles
    };
  }

  /* =======================================================
     FOOTPRINT HISTORY
======================================================= */

  getFootprint(
    symbol,
    minute
  ) {
    this.initDB();

    symbol =
      normalizeSymbol(
        symbol
      );

    const target =
      minuteStartOf(
        Number(minute)
      );

    const hour =
      hourStartOf(
        target
      );

    const key =
      `${symbol}:${hour}`;

    let block =
      this.hourBlocks.get(
        key
      );

    if (
      !block &&
      this.tableExists === true
    ) {
      const rows =
        this.state.storage.sql
          .exec(
            `
            SELECT
              symbol,
              hour_start,
              data,
              updated_at
            FROM hour_blocks_v5
            WHERE symbol = ?
            AND hour_start = ?
            LIMIT 1
            `,
            symbol,
            hour
          )
          .toArray();

      if (rows.length) {
        block =
          this.deserializeBlock(
            rows[0]
          );
      }
    }

    if (!block) {
      return {
        version:
          VERSION,

        symbol,

        minute:
          target,

        found:
          false,

        candle:
          null,

        levels: []
      };
    }

    const candle =
      block.candles.get(
        target
      );

    if (!candle) {
      return {
        version:
          VERSION,

        symbol,

        minute:
          target,

        found:
          false,

        candle:
          null,

        levels: []
      };
    }

    const levels =
      [
        ...candle.levels.values()
      ]
        .sort(
          (a, b) =>
            a.price -
            b.price
        )
        .map(
          level => ({
            price:
              level.price,

            buyVolume:
              level.buyVolume,

            sellVolume:
              level.sellVolume,

            buyValue:
              level.buyValue,

            sellValue:
              level.sellValue,

            buyTrades:
              level.buyTrades,

            sellTrades:
              level.sellTrades,

            delta:
              level.buyVolume -
              level.sellVolume,

            deltaValue:
              level.buyValue -
              level.sellValue,

            totalVolume:
              level.buyVolume +
              level.sellVolume
          })
        );

    const buyVolume =
      candle.bv;

    const sellVolume =
      candle.sv;

    return {
      version:
        VERSION,

      symbol,

      minute:
        target,

      found:
        true,

      candle: {
        time:
          candle.m,

        open:
          candle.o,

        high:
          candle.h,

        low:
          candle.l,

        close:
          candle.c,

        volume:
          candle.v,

        turnover:
          candle.t,

        buyVolume,

        sellVolume,

        buyValue:
          candle.b,

        sellValue:
          candle.s,

        buyTrades:
          candle.bt,

        sellTrades:
          candle.st,

        delta:
          buyVolume -
          sellVolume,

        deltaValue:
          candle.b -
          candle.s
      },

      levels
    };
  }

    /* =======================================================
   INTERNAL FETCH
======================================================= */

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {

      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,
            headers: CORS
          }
        );
      }

      /*
        RAM STORAGE TEST
        ----------------
        کاملاً Read-Only
        بدون initDB()
        بدون SQL
        بدون Database Write
      */
      if (
        path ===
        "/internal/storage-test"
      ) {
        return json(
          await this.storageTest()
        );
      }

      /*
        مسیرهای عادی از اینجا به بعد
        می‌توانند از SQLite استفاده کنند.
      */
      this.initDB();

      if (
        path ===
        "/internal/start"
      ) {
        return json(
          await this.start()
        );
      }

      if (
        path ===
        "/internal/status"
      ) {
        return json(
          this.statusObject()
        );
      }

      if (
        path ===
        "/internal/refresh"
      ) {
        const result =
          await this.refreshSymbols();

        return json({
          ok: true,

          ...result,

          status:
            this.statusObject()
        });
      }

      if (
        path ===
        "/internal/history"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const from =
          url.searchParams.get(
            "from"
          );

        const to =
          url.searchParams.get(
            "to"
          );

        return json(
          this.getHistory(
            symbol,
            from,
            to
          )
        );
      }

      if (
        path ===
        "/internal/history/footprint"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const minute =
          url.searchParams.get(
            "minute"
          );

        return json(
          this.getFootprint(
            symbol,
            minute
          )
        );
      }

      return json(
        {
          ok: false,

          error:
            "Internal route not found"
        },
        404
      );

    } catch (error) {

      this.lastError =
        String(
          error?.message ||
          error
        );

      return json(
        {
          ok: false,

          error:
            this.lastError,

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path
        },
        500
      );
    }
  }
}  


/* =========================================================
   PUBLIC COLLECTOR FUNCTIONS
========================================================= */

async function startCollector(
  env
) {
  try {
    const stub =
      collectorStub(env);

    return stub.fetch(
      "https://collector/internal/start"
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

async function collectorStatus(
  env
) {
  try {
    const stub =
      collectorStub(env);

    return stub.fetch(
      "https://collector/internal/status"
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

async function collectorRefresh(
  env
) {
  try {
    const stub =
      collectorStub(env);

    return stub.fetch(
      "https://collector/internal/refresh"
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

async function collectorHistory(
  env,
  url
) {
  try {
    const stub =
      collectorStub(env);

    const target =
      new URL(
        "https://collector/internal/history"
      );

    for (
      const key of [
        "symbol",
        "from",
        "to"
      ]
    ) {
      const value =
        url.searchParams.get(
          key
        );

      if (
        value !== null
      ) {
        target.searchParams.set(
          key,
          value
        );
      }
    }

    return stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

async function collectorFootprint(
  env,
  url
) {
  try {
    const stub =
      collectorStub(env);

    const target =
      new URL(
        "https://collector/internal/history/footprint"
      );

    for (
      const key of [
        "symbol",
        "minute"
      ]
    ) {
      const value =
        url.searchParams.get(
          key
        );

      if (
        value !== null
      ) {
        target.searchParams.set(
          key,
          value
        );
      }
    }

    return stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

/* =========================================================
   DEFAULT EXPORT
========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(
        request.url
      );

    try {
      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,
            headers: CORS
          }
        );
      }

      /* ===================================================
         HEALTH
      =================================================== */

      if (
        url.pathname ===
        "/api/health"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          storage:
            "AbsorptionStorageV5",

          table:
            TABLE_NAME,

          maxRows:
            MAX_ROWS,

          cleanupTarget:
            CLEANUP_TARGET_ROWS,

          storageModel:
            "1 symbol + 1 hour = 1 row",

          currentHour:
            "RAM only until hour closes",

          currentHourProtected:
            true,

          oldStorage:
            "preserved / new writes disabled",

          symbolSource:
            "Bybit Linear USDT Perpetual",

          marketData:
            "Bybit",

          lbankFilter:
            "disabled",

          writePolicy:
            "no startup DB write; closed hour only",

          volumeTest:
            "/api/test/volume?symbol=BTCUSDT",

          compression:
            "GZIP lossless"
        });
      }

      /* ===================================================
         DIRECT BYBIT DEBUG
      =================================================== */

      if (
        url.pathname ===
        "/api/debug/bybit"
      ) {
        return json(
          await debugBybit()
        );
      }

      /* ===================================================
         VOLUME TEST
      =================================================== */

      if (
        url.pathname ===
        "/api/test/volume"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        return json(
          await testVolume(
            symbol
          )
        );
      }

      /* ===================================================
   TEST
=================================================== */

      if (
        url.pathname ===
        "/api/test"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          time:
            Date.now(),

          volumeTest:
            "/api/test/volume?symbol=BTCUSDT",

          storageTest:
            "/api/storage-test"
        });
      }

      /* ===================================================
         STORAGE TEST
      =================================================== */

      if (
        url.pathname ===
        "/api/storage-test"
      ) {
        const id =
          env.TRADE_COLLECTOR_V5.idFromName(
            "ABSORPTION-STORAGE-V5"
          );

        const stub =
          env.TRADE_COLLECTOR_V5.get(
            id
          );

        const response =
          await stub.fetch(
            new Request(
              new URL(
                "/internal/storage-test",
                url.origin
              ),
              {
                method:
                  "GET"
              }
            )
          );

        return new Response(
          response.body,
          {
            status:
              response.status,

            headers:
              response.headers
          }
        );
      }
      
      /* ===================================================
         SYMBOLS
      =================================================== */

      if (
        url.pathname ===
        "/api/symbols"
      ) {
        const symbols =
          await getBybitSymbols();

        return json({
          ok: true,

          count:
            symbols.length,

          source:
            "Bybit Linear USDT Perpetual",

          symbols
        });
      }

      /* ===================================================
         COLLECTOR START
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/start"
      ) {
        return startCollector(
          env
        );
      }

      /* ===================================================
         COLLECTOR STATUS
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/status"
      ) {
        return collectorStatus(
          env
        );
      }

      /* ===================================================
         COLLECTOR REFRESH
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/refresh"
      ) {
        return collectorRefresh(
          env
        );
      }

      /* ===================================================
         HISTORY
      =================================================== */

      if (
        url.pathname ===
        "/api/history"
      ) {
        return collectorHistory(
          env,
          url
        );
      }

      /* ===================================================
         FOOTPRINT HISTORY
      =================================================== */

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

      /* ===================================================
         MARKET
      =================================================== */

      if (
        url.pathname ===
        "/api/market"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await getMarket(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const market =
          await getMarket(
            symbol,
            "1"
          );

        return json({
          version:
            VERSION,

          symbol,

          footprint:
            market.footprint,

          stats:
            market.stats,

          absorption:
            market.absorption
        });
      }

      /* ===================================================
         ORDERBOOK
      =================================================== */

      if (
        url.pathname ===
        "/api/orderbook"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/orderbook",
            {
              category:
                "linear",

              symbol,

              limit:
                ORDERBOOK_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          orderbook:
            orderbookStats(
              result
            )
        });
      }

      /* ===================================================
         CANDLES
      =================================================== */

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result.list
            )
        });
      }

      /* ===================================================
         ASSETS
      =================================================== */

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};
