const VERSION = "ABSORPTION-ZONE-V5-HOUR-BLOCK-80K";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const LBANK = "https://www.lbank.com";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const HOUR_MS = 60 * 60 * 1000;
const ALARM_MS = 5 * 60 * 1000;

const MAX_ROWS = 80000;
const CLEANUP_TARGET_ROWS = 76000;

const STORAGE_VERSION = "ABSORPTION-STORAGE-V5-80K-2026-09-06";

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
    throw new Error(`Bybit HTTP ${response.status}`);
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
  ) {
    return Number(price);
  }

  const n =
    Math.round(Number(price) / tick) *
    tick;

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
  const levels = new Map();

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
      level.buyVolume += t.size;
      level.buyValue += t.value;
      level.buyTrades++;
    } else if (
      t.side === "SELL"
    ) {
      level.sellVolume += t.size;
      level.sellValue += t.value;
      level.sellTrades++;
    }
  }

  return [...levels.values()]
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

    buyLiquidity += size;
    buyValue +=
      price * size;
  }

  for (const row of asks) {
    const price =
      safeNumber(row[0]);

    const size =
      safeNumber(row[1]);

    sellLiquidity += size;
    sellValue +=
      price * size;
  }

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? (buyLiquidity /
          totalLiquidity) *
        100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? (sellLiquidity /
          totalLiquidity) *
        100
      : 0;

  let pressure = "NEUTRAL";

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
        ? safeNumber(bids[0][0])
        : 0,

    bestAsk:
      asks.length
        ? safeNumber(asks[0][0])
        : 0,

    spread:
      bids.length &&
      asks.length
        ? safeNumber(asks[0][0]) -
          safeNumber(bids[0][0])
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
    candles[candles.length - 1];

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
      (candle.close -
        candle.low) /
      range;

    if (nearLow <= 0.25) {
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
      (candle.high -
        candle.close) /
      range;

    if (nearHigh <= 0.25) {
      score += 35;
      type =
        "SELL_ABSORPTION";
    }
  }

  if (bodyRatio < 0.35) {
    score += 20;
  }

  if (
    book &&
    type === "BUY_ABSORPTION" &&
    book.pressure ===
      "BUY_PRESSURE"
  ) {
    score += 20;
  }

  if (
    book &&
    type === "SELL_ABSORPTION" &&
    book.pressure ===
      "SELL_PRESSURE"
  ) {
    score += 20;
  }

  return {
    detected: score >= 50,
    type,
    score,
    bodyRatio,
    pressure:
      stats.pressure
  };
}

/* =========================================================
   SYMBOLS
========================================================= */

function isPerpetual(row) {
  const contractType =
    String(
      row.contractType || ""
    ).toUpperCase();

  const status =
    String(
      row.status || ""
    ).toUpperCase();

  const quoteCoin =
    String(
      row.quoteCoin || ""
    ).toUpperCase();

  const settleCoin =
    String(
      row.settleCoin || ""
    ).toUpperCase();

  return (
    status === "TRADING" &&
    (
      contractType ===
        "LINEAR_PERPETUAL" ||
      contractType ===
        "PERPETUAL"
    ) &&
    (
      quoteCoin === "USDT" ||
      settleCoin === "USDT"
    )
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
          category: "linear",
          status: "Trading",
          limit: SYMBOL_LIMIT,
          cursor
        }
      );

    const list =
      Array.isArray(result.list)
        ? result.list
        : [];

    for (const row of list) {
      if (!isPerpetual(row)) {
        continue;
      }

      const symbol =
        normalizeSymbol(row.symbol);

      output.push({
        symbol,

        tickSize:
          safeNumber(
            row.priceFilter?.tickSize,
            0
          ),

        minOrderQty:
          safeNumber(
            row.lotSizeFilter?.minOrderQty,
            0
          )
      });
    }

    cursor =
      result.nextPageCursor ||
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
   LBANK
========================================================= */

function isCryptoLbankInstrument(item) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return false;
  }

  const raw =
    String(
      item.symbol ||
      item.pair ||
      item.symbolName ||
      ""
    )
      .toUpperCase()
      .replace(/[-_/]/g, "");

  if (!raw) {
    return false;
  }

  return raw.endsWith("USDT");
}

async function getLbankSymbols() {
  const endpoints = [
    "/v2/currencyPairs.do",
    "/v2/accuracy.do"
  ];

  for (const endpoint of endpoints) {
    try {
      const response =
        await fetch(
          LBANK + endpoint,
          {
            headers: {
              "Accept":
                "application/json"
            }
          }
        );

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const list =
        Array.isArray(data)
          ? data
          : Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.result)
              ? data.result
              : [];

      const symbols = [];

      for (const item of list) {
        if (
          !isCryptoLbankInstrument(
            item
          )
        ) {
          continue;
        }

        const raw =
          String(
            item.symbol ||
            item.pair ||
            item.symbolName ||
            ""
          )
            .toUpperCase()
            .replace(
              /[-_/]/g,
              ""
            );

        if (
          raw &&
          raw.endsWith("USDT")
        ) {
          symbols.push(raw);
        }
      }

      if (symbols.length) {
        return [
          ...new Set(symbols)
        ];
      }
    } catch (_) {}
  }

  return [];
}

async function getCollectorSymbols() {
  const bybitSymbols =
    await getBybitSymbols();

  try {
    const lbankSymbols =
      await getLbankSymbols();

    if (lbankSymbols.length) {
      const lbankSet =
        new Set(
          lbankSymbols
        );

      return bybitSymbols.filter(
        x =>
          lbankSet.has(
            x.symbol
          )
      );
    }
  } catch (_) {}

  return bybitSymbols;
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
        category: "linear",
        symbol,
        interval,
        limit: KLINE_LIMIT
      }
    ),

    bybit(
      "/v5/market/tickers",
      {
        category: "linear",
        symbol
      }
    ),

    bybit(
      "/v5/market/orderbook",
      {
        category: "linear",
        symbol,
        limit: ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category: "linear",
        symbol,
        limit: TRADE_LIMIT
      }
    ),

    bybit(
      "/v5/market/instruments-info",
      {
        category: "linear",
        symbol
      }
    )
  ]);

  const candles =
    parseKlines(
      klineResult.list
    );

  const trades =
    parseTrades(
      tradeResult.list
    );

  const ticker =
    Array.isArray(
      tickerResult.list
    )
      ? tickerResult.list[0]
      : null;

  const instrument =
    Array.isArray(
      instrumentResult.list
    )
      ? instrumentResult.list[0]
      : null;

  const tickSize =
    safeNumber(
      instrument?.priceFilter?.tickSize,
      0
    );

  const stats =
    tradeStats(trades);

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
    version: VERSION,
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
          instrument?.lotSizeFilter
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
   KEEP OLD BINDING
========================================================= */

export class TradeCollector {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(request.url);

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

      message:
        "Legacy TradeCollector preserved",

      path:
        url.pathname,

      version:
        VERSION
    });
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(state, env) {
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
     DATABASE
  ======================================================= */

  initDB() {
    if (this.dbInitialized) {
      return;
    }

    const sql =
      this.state.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS hour_blocks_v5 (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, hour_start)
      )
    `);

    sql.exec(`
      CREATE INDEX IF NOT EXISTS
      idx_hour_blocks_v5_time
      ON hour_blocks_v5(symbol, hour_start)
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS
      storage_meta_v5 (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const rows =
      sql.exec(`
        SELECT value
        FROM storage_meta_v5
        WHERE key = 'storage_version'
        LIMIT 1
      `).toArray();

    const current =
      rows.length
        ? String(rows[0].value)
        : "";

    if (
      current !==
      STORAGE_VERSION
    ) {
      sql.exec(`
        DELETE FROM hour_blocks_v5
      `);

      sql.exec(`
        INSERT INTO storage_meta_v5
        (key, value)
        VALUES
        ('storage_version', ?)
        ON CONFLICT(key)
        DO UPDATE SET
        value = excluded.value
      `, STORAGE_VERSION);
    }

    this.dbInitialized = true;
  }

  getRowCount() {
    this.initDB();

    const rows =
      this.state.storage.sql
        .exec(`
          SELECT COUNT(*) AS count
          FROM hour_blocks_v5
        `)
        .toArray();

    return Number(
      rows[0]?.count || 0
    );
  }

  enforceCapacity() {
    this.initDB();

    const count =
      this.getRowCount();

    if (
      count < MAX_ROWS
    ) {
      return {
        deleted: 0,
        rows: count
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
        rows: count
      };
    }

    this.state.storage.sql.exec(`
      DELETE FROM hour_blocks_v5
      WHERE rowid IN (
        SELECT rowid
        FROM hour_blocks_v5
        ORDER BY hour_start ASC
        LIMIT ${deleteCount}
      )
    `);

    this.totalDeletedRows +=
      deleteCount;

    const currentHour =
      hourStartOf(
        Date.now()
      );

    for (
      const [key, block]
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
      deleted: deleteCount,
      rows: newCount
    };
  }

  loadRecentBlocks() {
    if (
      this.loadedRecentBlocks
    ) {
      return;
    }

    this.initDB();

    const now =
      Date.now();

    const currentHour =
      hourStartOf(now);

    const from =
      currentHour -
      2 * HOUR_MS;

    const rows =
      this.state.storage.sql
        .exec(`
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM hour_blocks_v5
          WHERE hour_start >= ?
          ORDER BY hour_start ASC
        `, from)
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
      trade.side ===
      "BUY"
    ) {
      candle.b +=
        trade.value;

      candle.bv +=
        trade.size;

      candle.bt++;
    } else if (
      trade.side ===
      "SELL"
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
      trade.side ===
      "BUY"
    ) {
      level.buyVolume +=
        trade.size;

      level.buyValue +=
        trade.value;

      level.buyTrades++;
    } else if (
      trade.side ===
      "SELL"
    ) {
      level.sellVolume +=
        trade.size;

      level.sellValue +=
        trade.value;

      level.sellTrades++;
    }

    block.dirty = true;
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
        .map(candle => ({
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
              .map(level => [
                level.price,

                level.buyVolume,
                level.sellVolume,

                level.buyValue,
                level.sellValue,

                level.buyTrades,
                level.sellTrades
              ])
        }));

    return JSON.stringify({
      v: 1,
      s: block.symbol,
      h: block.hourStart,
      c: candles
    });
  }

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
      v: Number(
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
        m: Number(item.m),

        o: Number(item.o),
        h: Number(item.h),
        l: Number(item.l),
        c: Number(item.c),

        v: Number(
          item.v || 0
        ),

        t: Number(
          item.t || 0
        ),

        b: Number(
          item.b || 0
        ),

        s: Number(
          item.s || 0
        ),

        bv: Number(
          item.bv || 0
        ),

        sv: Number(
          item.sv || 0
        ),

        bt: Number(
          item.bt || 0
        ),

        st: Number(
          item.st || 0
        ),

        ot: Number(
          item.ot ||
          item.m
        ),

        ct: Number(
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
     CLOSED-HOUR CHECKPOINT
======================================================= */

  persistClosedBlocks() {
    if (
      this.checkpointRunning
    ) {
      return {
        written: 0,
        rows: this.getRowCount()
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

      for (
        const [key, block]
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
          block.dirty = false;
          continue;
        }

        const data =
          this.serializeBlock(
            block
          );

        sql.exec(`
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

        block.dirty = false;

        written++;
        this.totalPersistedBlocks++;
      }

      this.lastCheckpointAt =
        now;

      const removeBefore =
        currentHour -
        HOUR_MS;

      for (
        const [key, block]
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
        const [key, time]
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
          this.dedupe.keys()
            .next().value;

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
        !["BUY", "SELL"].includes(
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
      this.persistClosedBlocks();
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
            op: "subscribe",
            args: chunk
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
      setInterval(() => {
        try {
          if (
            this.ws &&
            this.ws.readyState ===
              1
          ) {
            this.ws.send(
              JSON.stringify({
                op: "ping"
              })
            );
          }
        } catch (_) {}
      }, 20000);
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
        await getCollectorSymbols();

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
          "هیچ Symbol مشترک بین LBank و Bybit پیدا نشد"
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

          if (this.started) {
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
      await getCollectorSymbols();

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

    this.state.storage.setAlarm(
      Date.now() +
        ALARM_MS
    );
  }

  async alarm() {
    this.alarmScheduled =
      false;

    try {
      this.initDB();

      this.loadRecentBlocks();

      this.persistClosedBlocks();

      this.enforceCapacity();

      if (
        !this.symbols.length ||
        !this.connected
      ) {
        await this.refreshSymbols();
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
        this.ws.readyState ===
          1
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

    this.enforceCapacity();

    this.scheduleAlarm();

    return this.statusObject();
  }

  /* =======================================================
     STATUS
  ======================================================= */

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

      version: VERSION,

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
        "hour_blocks_v5",

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
        "capacity based rolling history",

      symbolSource:
        "LBank ∩ Bybit",

      marketData:
        "Bybit",

      hourBlocksInMemory:
        this.hourBlocks.size,

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

    const rows =
      this.state.storage.sql
        .exec(`
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

    const blocks =
      new Map();

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

    if (!block) {
      const rows =
        this.state.storage.sql
          .exec(`
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

      if (!rows.length) {
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

      block =
        this.deserializeBlock(
          rows[0]
        );
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
        .map(level => ({
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
        }));

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
      new URL(request.url);

    const path =
      url.pathname;

    try {
      this.initDB();

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
      new URL(request.url);

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
            "hour_blocks_v5",

          maxRows:
            MAX_ROWS,

          storageModel:
            "1 symbol + 1 hour = 1 row"
        });
      }

      if (
        url.pathname ===
        "/api/test"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          time:
            Date.now()
        });
      }

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

          symbols
        });
      }

      if (
        url.pathname ===
        "/api/collector/start"
      ) {
        return startCollector(
          env
        );
      }

      if (
        url.pathname ===
        "/api/collector/status"
      ) {
        return collectorStatus(
          env
        );
      }

      if (
        url.pathname ===
        "/api/collector/refresh"
      ) {
        return collectorRefresh(
          env
        );
      }

      if (
        url.pathname ===
        "/api/history"
      ) {
        return collectorHistory(
          env,
          url
        );
      }

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

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

      if (env.ASSETS) {
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
