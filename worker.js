import { DurableObject } from "cloudflare:workers";

const VERSION = "ABSORPTION-ZONE-V3";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const LBANK = "https://lbkperp.lbank.com";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const HISTORY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const LBankProductGroup = "SwapU";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};

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
  let s = String(value || DEFAULT_SYMBOL)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s) return DEFAULT_SYMBOL;

  if (
    s === "BTC" ||
    s === "BTCUSDT" ||
    s === "BUSDT"
  ) {
    return "BTCUSDT";
  }

  if (s.endsWith("USDT")) return s;

  return s + "USDT";
}

function normalizeInterval(value) {
  const v = String(value || DEFAULT_INTERVAL);

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

  return allowed.includes(v) ? v : "1";
}

function minuteStart(ts) {
  return Math.floor(Number(ts) / MINUTE_MS) * MINUTE_MS;
}

function cleanNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function bybit(path, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      query.set(key, String(value));
    }
  }

  const url =
    `${BYBIT}${path}?${query.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!text) {
    throw new Error(
      `Bybit پاسخ خالی داد (${response.status})`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ Bybit معتبر نیست: ${text.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data;
}

async function lbank(path, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      query.set(key, String(value));
    }
  }

  const url =
    `${LBANK}${path}?${query.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!text) {
    throw new Error(
      `LBank پاسخ خالی داد (${response.status})`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ LBank معتبر نیست: ${text.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    throw new Error(`LBank HTTP ${response.status}`);
  }

  return data;
}

function parseKlines(rows) {
  return (rows || [])
    .map(r => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      turnover: Number(r[6])
    }))
    .filter(x =>
      Number.isFinite(x.time) &&
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close)
    )
    .reverse();
}

function parseTrades(rows) {
  return (rows || [])
    .map(t => {
      const side =
        String(t.side || "").toLowerCase() === "buy"
          ? "buy"
          : "sell";

      const price = Number(t.price);
      const size = Number(t.size);
      const time = Number(
        t.time ||
        t.T ||
        Date.now()
      );

      return {
        id:
          t.execId ||
          t.tradeId ||
          t.i ||
          `${time}-${price}-${size}-${side}`,

        time,
        price,
        size,
        value: price * size,
        side
      };
    })
    .filter(t =>
      Number.isFinite(t.price) &&
      Number.isFinite(t.size) &&
      t.size > 0 &&
      Number.isFinite(t.time)
    );
}

function tradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  const notionals = [];

  for (const t of trades) {
    const value =
      Number(t.price) *
      Number(t.size);

    notionals.push(value);

    if (t.side === "buy") {
      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else {
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
      ? delta / totalVolume * 100
      : 0;

  const sorted =
    [...notionals].sort(
      (a, b) => a - b
    );

  const p95 =
    sorted.length
      ? sorted[
          Math.floor(
            (sorted.length - 1) * 0.95
          )
        ]
      : 0;

  const average =
    notionals.length
      ? totalValue / notionals.length
      : 0;

  const largeThreshold =
    Math.max(
      average * 5,
      p95,
      0
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let largeBuyValue = 0;
  let largeSellValue = 0;

  for (const t of trades) {
    const value =
      t.price * t.size;

    if (value >= largeThreshold) {
      if (t.side === "buy") {
        largeBuyVolume += t.size;
        largeBuyValue += value;
      } else {
        largeSellVolume += t.size;
        largeSellValue += value;
      }
    }
  }

  return {
    trades: trades.length,

    buyVolume,
    sellVolume,

    buyValue,
    sellValue,

    totalVolume,
    totalValue,

    delta,
    deltaValue,
    deltaPercent,

    buyTrades,
    sellTrades,

    largeThreshold,

    largeBuyVolume,
    largeSellVolume,

    largeBuyValue,
    largeSellValue,

    pressure:
      deltaPercent >= 10
        ? "BUY_PRESSURE"
        : deltaPercent <= -10
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}

function aggregateFootprint(
  trades,
  tickSize = 0
) {
  const levels = new Map();

  const tick =
    Number(tickSize) > 0
      ? Number(tickSize)
      : 0;

  let decimals = 8;

  if (tick >= 1) {
    decimals = 0;
  } else if (tick > 0) {
    decimals = Math.max(
      0,
      Math.ceil(-Math.log10(tick))
    );
  }

  for (const t of trades) {
    let price = Number(t.price);

    if (tick > 0) {
      price =
        Math.round(
          price / tick
        ) * tick;
    }

    const key =
      price.toFixed(decimals);

    if (!levels.has(key)) {
      levels.set(key, {
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
      levels.get(key);

    if (t.side === "buy") {
      level.buyVolume += t.size;
      level.buyValue += t.value;
      level.buyTrades++;
    } else {
      level.sellVolume += t.size;
      level.sellValue += t.value;
      level.sellTrades++;
    }
  }

  return [...levels.values()]
    .map(x => ({
      ...x,

      delta:
        x.buyVolume -
        x.sellVolume,

      deltaValue:
        x.buyValue -
        x.sellValue,

      totalVolume:
        x.buyVolume +
        x.sellVolume,

      imbalance:
        x.sellVolume > 0
          ? x.buyVolume /
            x.sellVolume
          : x.buyVolume > 0
            ? 999
            : 0
    }))
    .sort(
      (a, b) =>
        b.price - a.price
    );
}

function orderbookStats(data) {
  const bids =
    (data.b || [])
      .map(x => ({
        price: Number(x[0]),
        size: Number(x[1]),
        value:
          Number(x[0]) *
          Number(x[1])
      }))
      .filter(x =>
        Number.isFinite(x.price) &&
        Number.isFinite(x.size)
      );

  const asks =
    (data.a || [])
      .map(x => ({
        price: Number(x[0]),
        size: Number(x[1]),
        value:
          Number(x[0]) *
          Number(x[1])
      }))
      .filter(x =>
        Number.isFinite(x.price) &&
        Number.isFinite(x.size)
      );

  const buyLiquidity =
    bids.reduce(
      (sum, x) =>
        sum + x.value,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (sum, x) =>
        sum + x.value,
      0
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? buyLiquidity /
        totalLiquidity *
        100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? sellLiquidity /
        totalLiquidity *
        100
      : 0;

  const bestBid =
    bids.length
      ? bids[0].price
      : 0;

  const bestAsk =
    asks.length
      ? asks[0].price
      : 0;

  const spread =
    bestAsk > 0 &&
    bestBid > 0
      ? bestAsk - bestBid
      : 0;

  return {
    bids,
    asks,

    buyLiquidity,
    sellLiquidity,

    totalLiquidity,

    buyShare,
    sellShare,

    bestBid,
    bestAsk,
    spread,

    pressure:
      buyShare >
      sellShare + 8
        ? "BUY_PRESSURE"
        : sellShare >
          buyShare + 8
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}

function detectAbsorption(
  trades,
  candles,
  book
) {
  if (
    !trades.length ||
    !candles.length
  ) {
    return {
      detected: false,
      side: "NONE",
      score: 0,
      reason: "داده کافی نیست"
    };
  }

  const last =
    candles[candles.length - 1];

  const stats =
    tradeStats(trades);

  const range =
    Math.max(
      last.high - last.low,
      Number.EPSILON
    );

  const body =
    Math.abs(
      last.close - last.open
    );

  const bodyRatio =
    body / range;

  const nearLow =
    (last.close - last.low) /
    range;

  const nearHigh =
    (last.high - last.close) /
    range;

  const sellPressure =
    stats.deltaPercent < -10;

  const buyPressure =
    stats.deltaPercent > 10;

  let score = 0;
  let side = "NONE";

  const reasons = [];

  if (
    sellPressure &&
    nearLow < 0.35
  ) {
    score += 35;
    side = "BUY";

    reasons.push(
      "فشار فروش در کف جذب شده"
    );
  }

  if (
    buyPressure &&
    nearHigh < 0.35
  ) {
    score += 35;
    side = "SELL";

    reasons.push(
      "فشار خرید در سقف جذب شده"
    );
  }

  if (bodyRatio < 0.35) {
    score += 20;

    reasons.push(
      "بدنه کندل کوچک نسبت به محدوده"
    );
  }

  const bookPressure =
    book?.pressure ||
    "BALANCED";

  if (
    side === "BUY" &&
    bookPressure ===
      "BUY_PRESSURE"
  ) {
    score += 20;

    reasons.push(
      "حمایت سمت Bid در Order Book"
    );
  }

  if (
    side === "SELL" &&
    bookPressure ===
      "SELL_PRESSURE"
  ) {
    score += 20;

    reasons.push(
      "حمایت سمت Ask در Order Book"
    );
  }

  return {
    detected: score >= 50,
    side,
    score: Math.min(score, 100),

    reason:
      reasons.length
        ? reasons.join(" · ")
        : "Absorption معتبر شناسایی نشد"
  };
}

/* =========================================================
   BYBIT MARKET
========================================================= */

async function getMarket(
  symbol,
  interval
) {
  const [
    kline,
    ticker,
    book,
    trades,
    instruments
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
      kline.result?.list
    );

  const parsedTrades =
    parseTrades(
      trades.result?.list
    );

  const bookStats =
    orderbookStats(
      book.result?.list || {}
    );

  const instrument =
    instruments.result?.list?.[0] ||
    {};

  const tickSize =
    Number(
      instrument.priceFilter?.tickSize ||
      0
    );

  const stats =
    tradeStats(
      parsedTrades
    );

  const footprint =
    aggregateFootprint(
      parsedTrades,
      tickSize
    );

  const absorption =
    detectAbsorption(
      parsedTrades,
      candles,
      bookStats
    );

  const tickerData =
    ticker.result?.list?.[0] ||
    {};

  return {
    version: VERSION,

    symbol,

    category: "linear",

    interval,

    serverTime: Date.now(),

    tickSize,

    ticker: {
      lastPrice:
        Number(
          tickerData.lastPrice || 0
        ),

      markPrice:
        Number(
          tickerData.markPrice || 0
        ),

      indexPrice:
        Number(
          tickerData.indexPrice || 0
        ),

      price24hPcnt:
        Number(
          tickerData.price24hPcnt || 0
        ) * 100,

      volume24h:
        Number(
          tickerData.volume24h || 0
        ),

      turnover24h:
        Number(
          tickerData.turnover24h || 0
        )
    },

    candles,

    trades: parsedTrades,

    stats,

    footprint,

    orderbook: bookStats,

    absorption
  };
}

/* =========================================================
   BYBIT SYMBOLS
========================================================= */

async function getBybitSymbols() {
  const all = [];

  let cursor = "";

  for (let page = 0; page < 10; page++) {
    const params = {
      category: "linear",
      status: "Trading",
      limit: 1000
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const result =
      await bybit(
        "/v5/market/instruments-info",
        params
      );

    const list =
      result.result?.list || [];

    for (const item of list) {
      const symbol =
        String(
          item.symbol || ""
        ).toUpperCase();

      if (!symbol) continue;

      if (
        item.status !==
        "Trading"
      ) {
        continue;
      }

      if (
        item.quoteCoin &&
        item.quoteCoin !== "USDT"
      ) {
        continue;
      }

      if (
        item.settleCoin &&
        item.settleCoin !== "USDT"
      ) {
        continue;
      }

      if (
        item.contractType &&
        !String(
          item.contractType
        )
        .toLowerCase()
        .includes("perpetual")
      ) {
        continue;
      }

      all.push({
        symbol,

        baseCoin:
          item.baseCoin || "",

        quoteCoin:
          item.quoteCoin ||
          "USDT",

        settleCoin:
          item.settleCoin ||
          "USDT",

        contractType:
          item.contractType ||
          "LinearPerpetual",

        status:
          item.status ||
          "Trading",

        tickSize:
          item.priceFilter?.tickSize ||
          "0",

        minOrderQty:
          item.lotSizeFilter?.minOrderQty ||
          "0"
      });
    }

    const next =
      result.result?.nextPageCursor ||
      "";

    if (
      !next ||
      !list.length
    ) {
      break;
    }

    cursor = next;
  }

  const unique =
    new Map();

  for (const item of all) {
    unique.set(
      item.symbol,
      item
    );
  }

  return [...unique.values()]
    .sort((a, b) =>
      a.symbol.localeCompare(
        b.symbol
      )
    );
}

/* =========================================================
   LBANK SYMBOL FILTER
========================================================= */

function normalizeExternalSymbol(value) {
  let s = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s) return "";

  if (
    s.endsWith("USDT")
  ) {
    return s;
  }

  return s + "USDT";
}

function extractLBankList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    Array.isArray(payload?.data)
  ) {
    return payload.data;
  }

  if (
    Array.isArray(payload?.result)
  ) {
    return payload.result;
  }

  if (
    Array.isArray(payload?.data?.list)
  ) {
    return payload.data.list;
  }

  if (
    Array.isArray(payload?.result?.list)
  ) {
    return payload.result.list;
  }

  return [];
}

async function getLBankSymbols() {
  const data =
    await lbank(
      "/cfd/openApi/v1/pub/instrument",
      {
        productGroup:
          LBankProductGroup
      }
    );

  const list =
    extractLBankList(data);

  const symbols = [];

  for (const item of list) {
    const raw =
      item?.symbol ||
      item?.symbolName ||
      "";

    const symbol =
      normalizeExternalSymbol(
        raw
      );

    if (!symbol) continue;

    const clear =
      String(
        item?.clearCurrency ||
        ""
      ).toUpperCase();

    const price =
      String(
        item?.priceCurrency ||
        ""
      ).toUpperCase();

    /*
      LBank is only used as the
      external symbol filter.
      We keep USDT-settled / USDT-priced
      crypto contracts.
    */

    if (
      clear &&
      clear !== "USDT"
    ) {
      continue;
    }

    if (
      price &&
      price !== "USDT"
    ) {
      continue;
    }

    symbols.push({
      symbol,

      lbankSymbol:
        String(raw),

      priceTick:
        Number(
          item?.priceTick || 0
        ),

      volumeTick:
        Number(
          item?.volumeTick || 0
        ),

      baseCurrency:
        item?.baseCurrency || "",

      clearCurrency:
        item?.clearCurrency || "",

      priceCurrency:
        item?.priceCurrency || ""
    });
  }

  const unique =
    new Map();

  for (const item of symbols) {
    unique.set(
      item.symbol,
      item
    );
  }

  return [
    ...unique.values()
  ].sort((a, b) =>
    a.symbol.localeCompare(
      b.symbol
    )
  );
}

async function buildFilteredSymbols() {
  const [
    bybitSymbols,
    lbankSymbols
  ] = await Promise.all([
    getBybitSymbols(),
    getLBankSymbols()
  ]);

  const lbankMap =
    new Map(
      lbankSymbols.map(
        x => [x.symbol, x]
      )
    );

  const result = [];

  for (const bybitItem of bybitSymbols) {
    const lbankItem =
      lbankMap.get(
        bybitItem.symbol
      );

    if (!lbankItem) {
      continue;
    }

    result.push({
      ...bybitItem,

      lbank: true,

      lbankTick:
        lbankItem.priceTick || 0
    });
  }

  return result.sort(
    (a, b) =>
      a.symbol.localeCompare(
        b.symbol
      )
  );
}

/* =========================================================
   COLLECTOR DURABLE OBJECT
========================================================= */

export class TradeCollector extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.ws = null;

    this.symbols = [];

    this.running = false;

    this.reconnectTimer = null;

    this.pingTimer = null;

    this.refreshTimer = null;

    this.lastMessageAt = 0;

    this.lastConnectAt = 0;

    this.connected = false;

    this.initialized = false;

    this.initDatabase();
  }

  initDatabase() {
    const sql =
      this.ctx.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS trades_1m (
        symbol TEXT NOT NULL,
        minute INTEGER NOT NULL,
        price REAL NOT NULL,
        buy_volume REAL NOT NULL DEFAULT 0,
        sell_volume REAL NOT NULL DEFAULT 0,
        buy_value REAL NOT NULL DEFAULT 0,
        sell_value REAL NOT NULL DEFAULT 0,
        buy_trades INTEGER NOT NULL DEFAULT 0,
        sell_trades INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(symbol, minute, price)
      );

      CREATE INDEX IF NOT EXISTS idx_trades_symbol_minute
      ON trades_1m(symbol, minute);

      CREATE TABLE IF NOT EXISTS candles_1m (
        symbol TEXT NOT NULL,
        minute INTEGER NOT NULL,
        open REAL NOT NULL DEFAULT 0,
        high REAL NOT NULL DEFAULT 0,
        low REAL NOT NULL DEFAULT 0,
        close REAL NOT NULL DEFAULT 0,
        volume REAL NOT NULL DEFAULT 0,
        turnover REAL NOT NULL DEFAULT 0,
        buy_volume REAL NOT NULL DEFAULT 0,
        sell_volume REAL NOT NULL DEFAULT 0,
        buy_value REAL NOT NULL DEFAULT 0,
        sell_value REAL NOT NULL DEFAULT 0,
        buy_trades INTEGER NOT NULL DEFAULT 0,
        sell_trades INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(symbol, minute)
      );

      CREATE INDEX IF NOT EXISTS idx_candles_symbol_minute
      ON candles_1m(symbol, minute);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    this.initialized = true;
  }

  async saveMeta(
    key,
    value
  ) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO meta(key,value)
      VALUES(?,?)
      ON CONFLICT(key)
      DO UPDATE SET value=excluded.value
      `,
      key,
      String(value)
    );
  }

  getMeta(key) {
    const row =
      this.ctx.storage.sql
        .exec(
          `
          SELECT value
          FROM meta
          WHERE key=?
          `,
          key
        )
        .toArray()[0];

    return row?.value || "";
  }

  async cleanupOldData() {
    const cutoff =
      minuteStart(
        Date.now() -
        HISTORY_MS
      );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM trades_1m
      WHERE minute < ?
      `,
      cutoff
    );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM candles_1m
      WHERE minute < ?
      `,
      cutoff
    );
  }

  async refreshSymbols() {
    try {
      const filtered =
        await buildFilteredSymbols();

      if (!filtered.length) {
        throw new Error(
          "LBank/Bybit intersection is empty"
        );
      }

      const nextSymbols =
        filtered.map(
          x => x.symbol
        );

      this.symbols =
        nextSymbols;

      await this.saveMeta(
        "symbols",
        JSON.stringify(
          filtered
        )
      );

      await this.saveMeta(
        "symbolsUpdatedAt",
        Date.now()
      );

      return filtered;
    } catch (error) {
      const cached =
        this.getMeta(
          "symbols"
        );

      if (cached) {
        try {
          const parsed =
            JSON.parse(cached);

          this.symbols =
            parsed.map(
              x => x.symbol
            );

          return parsed;
        } catch {}
      }

      throw error;
    }
  }

  async loadCachedSymbols() {
    const cached =
      this.getMeta(
        "symbols"
      );

    if (!cached) {
      return [];
    }

    try {
      const parsed =
        JSON.parse(cached);

      this.symbols =
        parsed.map(
          x => x.symbol
        );

      return parsed;
    } catch {
      return [];
    }
  }

  async start() {
    if (
      this.running &&
      this.ws
    ) {
      return;
    }

    this.running = true;

    if (!this.symbols.length) {
      await this.loadCachedSymbols();
    }

    if (!this.symbols.length) {
      await this.refreshSymbols();
    }

    await this.cleanupOldData();

    await this.connectBybit();

    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    try {
      await this.ctx.storage.setAlarm(
        Date.now() + 5 * 60 * 1000
      );
    } catch {}
  }

  async alarm() {
    try {
      await this.refreshSymbols();
    } catch {}

    try {
      await this.cleanupOldData();
    } catch {}

    /*
      If the socket disappeared,
      rebuild it.
    */

    if (
      !this.ws ||
      !this.connected
    ) {
      try {
        await this.connectBybit();
      } catch {}
    }

    await this.scheduleAlarm();
  }

  async connectBybit() {
    if (!this.symbols.length) {
      return;
    }

    this.closeSocket();

    const socket =
      new WebSocket(
        BYBIT_WS
      );

    this.ws =
      socket;

    this.connected =
      false;

    this.lastConnectAt =
      Date.now();

    socket.addEventListener(
      "open",
      () => {
        this.connected =
          true;

        this.lastMessageAt =
          Date.now();

        this.subscribeSymbols();

        this.startPing();
      }
    );

    socket.addEventListener(
      "message",
      event => {
        this.lastMessageAt =
          Date.now();

        this.handleBybitMessage(
          event.data
        );
      }
    );

    socket.addEventListener(
      "error",
      () => {
        this.connected =
          false;
      }
    );

    socket.addEventListener(
      "close",
      () => {
        this.connected =
          false;

        this.stopPing();

        this.scheduleReconnect();
      }
    );
  }

  subscribeSymbols() {
    if (
      !this.ws ||
      this.ws.readyState !== 1
    ) {
      return;
    }

    /*
      Bybit allows multiple Futures
      topics in one public connection.
      We keep each request safely
      below the args size limit.
    */

    const topics =
      this.symbols.map(
        symbol =>
          `publicTrade.${symbol}`
      );

    const CHUNK = 400;

    for (
      let i = 0;
      i < topics.length;
      i += CHUNK
    ) {
      const args =
        topics.slice(
          i,
          i + CHUNK
        );

      try {
        this.ws.send(
          JSON.stringify({
            op: "subscribe",
            req_id:
              `collector-${Date.now()}-${i}`,
            args
          })
        );
      } catch {}
    }
  }

  startPing() {
    this.stopPing();

    this.pingTimer =
      setInterval(
        () => {
          if (
            this.ws &&
            this.ws.readyState === 1
          ) {
            try {
              this.ws.send(
                JSON.stringify({
                  op: "ping"
                })
              );
            } catch {}
          }
        },
        20 * 1000
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

  scheduleReconnect() {
    if (
      this.reconnectTimer
    ) {
      return;
    }

    this.reconnectTimer =
      setTimeout(
        async () => {
          this.reconnectTimer =
            null;

          if (!this.running) {
            return;
          }

          try {
            await this.connectBybit();
          } catch {
            this.scheduleReconnect();
          }
        },
        3000
      );
  }

  closeSocket() {
    this.stopPing();

    if (this.ws) {
      try {
        this.ws.close(
          1000,
          "reconnect"
        );
      } catch {}
    }

    this.ws =
      null;

    this.connected =
      false;
  }

  async handleBybitMessage(
    raw
  ) {
    let message;

    try {
      message =
        typeof raw ===
        "string"
          ? JSON.parse(raw)
          : JSON.parse(
              new TextDecoder()
                .decode(raw)
            );
    } catch {
      return;
    }

    if (
      message.op === "pong"
    ) {
      return;
    }

    if (
      !message.topic ||
      !message.data
    ) {
      return;
    }

    if (
      !String(
        message.topic
      ).startsWith(
        "publicTrade."
      )
    ) {
      return;
    }

    const symbol =
      String(
        message.topic
      ).replace(
        "publicTrade.",
        ""
      )
      .toUpperCase();

    const rows =
      Array.isArray(
        message.data
      )
        ? message.data
        : [];

    for (const row of rows) {
      await this.insertTrade(
        symbol,
        row
      );
    }
  }

  async insertTrade(
    symbol,
    row
  ) {
    const price =
      Number(
        row.p ||
        row.price
      );

    const size =
      Number(
        row.v ||
        row.size
      );

    const time =
      Number(
        row.T ||
        row.time ||
        Date.now()
      );

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      !Number.isFinite(time)
    ) {
      return;
    }

    const side =
      String(
        row.S ||
        row.side ||
        ""
      ).toLowerCase() ===
      "buy"
        ? "buy"
        : "sell";

    const minute =
      minuteStart(time);

    /*
      We deliberately keep price
      at the real trade price here.
      Tick aggregation is applied
      when Footprint is requested.
    */

    const buyVolume =
      side === "buy"
        ? size
        : 0;

    const sellVolume =
      side === "sell"
        ? size
        : 0;

    const value =
      price * size;

    const buyValue =
      side === "buy"
        ? value
        : 0;

    const sellValue =
      side === "sell"
        ? value
        : 0;

    const buyTrades =
      side === "buy"
        ? 1
        : 0;

    const sellTrades =
      side === "sell"
        ? 1
        : 0;

    this.ctx.storage.sql.exec(
      `
      INSERT INTO trades_1m(
        symbol,
        minute,
        price,
        buy_volume,
        sell_volume,
        buy_value,
        sell_value,
        buy_trades,
        sell_trades
      )
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol,minute,price)
      DO UPDATE SET
        buy_volume =
          buy_volume +
          excluded.buy_volume,

        sell_volume =
          sell_volume +
          excluded.sell_volume,

        buy_value =
          buy_value +
          excluded.buy_value,

        sell_value =
          sell_value +
          excluded.sell_value,

        buy_trades =
          buy_trades +
          excluded.buy_trades,

        sell_trades =
          sell_trades +
          excluded.sell_trades
      `,
      symbol,
      minute,
      price,
      buyVolume,
      sellVolume,
      buyValue,
      sellValue,
      buyTrades,
      sellTrades
    );

    this.updateMinuteCandle(
      symbol,
      minute,
      price,
      size,
      value,
      side
    );

    /*
      Cleanup on hour boundaries.
    */

    const currentMinute =
      minuteStart(
        Date.now()
      );

    if (
      currentMinute %
        (60 * MINUTE_MS) === 0
    ) {
      await this.cleanupOldData();
    }
  }

  updateMinuteCandle(
    symbol,
    minute,
    price,
    size,
    value,
    side
  ) {
    const row =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            open,
            high,
            low,
            close,
            volume,
            turnover,
            buy_volume,
            sell_volume,
            buy_value,
            sell_value,
            buy_trades,
            sell_trades
          FROM candles_1m
          WHERE symbol=?
            AND minute=?
          `,
          symbol,
          minute
        )
        .toArray()[0];

    if (!row) {
      this.ctx.storage.sql.exec(
        `
        INSERT INTO candles_1m(
          symbol,
          minute,
          open,
          high,
          low,
          close,
          volume,
          turnover,
          buy_volume,
          sell_volume,
          buy_value,
          sell_value,
          buy_trades,
          sell_trades
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
        symbol,
        minute,
        price,
        price,
        price,
        price,
        size,
        value,
        side === "buy"
          ? size
          : 0,
        side === "sell"
          ? size
          : 0,
        side === "buy"
          ? value
          : 0,
        side === "sell"
          ? value
          : 0,
        side === "buy"
          ? 1
          : 0,
        side === "sell"
          ? 1
          : 0
      );

      return;
    }

    const high =
      Math.max(
        Number(row.high),
        price
      );

    const low =
      Math.min(
        Number(row.low),
        price
      );

    this.ctx.storage.sql.exec(
      `
      UPDATE candles_1m
      SET
        high=?,
        low=?,
        close=?,
        volume=volume+?,
        turnover=turnover+?,
        buy_volume=buy_volume+?,
        sell_volume=sell_volume+?,
        buy_value=buy_value+?,
        sell_value=sell_value+?,
        buy_trades=buy_trades+?,
        sell_trades=sell_trades+?
      WHERE symbol=?
        AND minute=?
      `,
      high,
      low,
      price,
      size,
      value,
      side === "buy"
        ? size
        : 0,
      side === "sell"
        ? size
        : 0,
      side === "buy"
        ? value
        : 0,
      side === "sell"
        ? value
        : 0,
      side === "buy"
        ? 1
        : 0,
      side === "sell"
        ? 1
        : 0,
      symbol,
      minute
    );
  }

  async getHistory(
    symbol,
    from,
    to
  ) {
    const now =
      Date.now();

    const minimum =
      minuteStart(
        now -
        HISTORY_MS
      );

    const start =
      Math.max(
        Number(from) ||
          minimum,
        minimum
      );

    const end =
      Math.min(
        Number(to) ||
          now,
        now
      );

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            symbol,
            minute,
            open,
            high,
            low,
            close,
            volume,
            turnover,
            buy_volume,
            sell_volume,
            buy_value,
            sell_value,
            buy_trades,
            sell_trades
          FROM candles_1m
          WHERE symbol=?
            AND minute>=?
            AND minute<=?
          ORDER BY minute ASC
          `,
          symbol,
          start,
          end
        )
        .toArray();

    return rows.map(
      row => ({
        time:
          Number(row.minute),

        open:
          Number(row.open),

        high:
          Number(row.high),

        low:
          Number(row.low),

        close:
          Number(row.close),

        volume:
          Number(row.volume),

        turnover:
          Number(row.turnover),

        buyVolume:
          Number(row.buy_volume),

        sellVolume:
          Number(row.sell_volume),

        buyValue:
          Number(row.buy_value),

        sellValue:
          Number(row.sell_value),

        delta:
          Number(row.buy_volume) -
          Number(row.sell_volume),

        deltaValue:
          Number(row.buy_value) -
          Number(row.sell_value),

        buyTrades:
          Number(row.buy_trades),

        sellTrades:
          Number(row.sell_trades)
      })
    );
  }

  async getFootprint(
    symbol,
    minute,
    tickSize = 0
  ) {
    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            price,
            buy_volume,
            sell_volume,
            buy_value,
            sell_value,
            buy_trades,
            sell_trades
          FROM trades_1m
          WHERE symbol=?
            AND minute=?
          ORDER BY price DESC
          `,
          symbol,
          Number(minute)
        )
        .toArray();

    const tick =
      Number(tickSize) > 0
        ? Number(tickSize)
        : 0;

    const levels =
      new Map();

    let decimals = 8;

    if (tick >= 1) {
      decimals = 0;
    } else if (tick > 0) {
      decimals = Math.max(
        0,
        Math.ceil(
          -Math.log10(tick)
        )
      );
    }

    for (const row of rows) {
      let price =
        Number(row.price);

      if (tick > 0) {
        price =
          Math.round(
            price / tick
          ) * tick;
      }

      const key =
        price.toFixed(decimals);

      if (!levels.has(key)) {
        levels.set(key, {
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
        levels.get(key);

      level.buyVolume +=
        Number(
          row.buy_volume
        );

      level.sellVolume +=
        Number(
          row.sell_volume
        );

      level.buyValue +=
        Number(
          row.buy_value
        );

      level.sellValue +=
        Number(
          row.sell_value
        );

      level.buyTrades +=
        Number(
          row.buy_trades
        );

      level.sellTrades +=
        Number(
          row.sell_trades
        );
    }

    return [
      ...levels.values()
    ]
      .map(x => ({
        ...x,

        delta:
          x.buyVolume -
          x.sellVolume,

        deltaValue:
          x.buyValue -
          x.sellValue,

        totalVolume:
          x.buyVolume +
          x.sellVolume,

        imbalance:
          x.sellVolume > 0
            ? x.buyVolume /
              x.sellVolume
            : x.buyVolume > 0
              ? 999
              : 0
      }))
      .sort(
        (a, b) =>
          b.price - a.price
      );
  }

  async status() {
    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            COUNT(*) AS levels,
            COUNT(
              DISTINCT symbol
            ) AS symbols
          FROM trades_1m
          `
        )
        .toArray();

    const candles =
      this.ctx.storage.sql
        .exec(
          `
          SELECT
            COUNT(*) AS candles,
            MIN(minute) AS oldest,
            MAX(minute) AS newest
          FROM candles_1m
          `
        )
        .toArray()[0];

    return {
      running:
        this.running,

      connected:
        this.connected,

      symbols:
        this.symbols.length,

      storedSymbols:
        Number(
          rows[0]?.symbols || 0
        ),

      levels:
        Number(
          rows[0]?.levels || 0
        ),

      candles:
        Number(
          candles?.candles || 0
        ),

      oldest:
        Number(
          candles?.oldest || 0
        ),

      newest:
        Number(
          candles?.newest || 0
        ),

      lastMessageAt:
        this.lastMessageAt,

      lastConnectAt:
        this.lastConnectAt
    };
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    if (
      url.pathname ===
      "/start"
    ) {
      await this.start();

      return json({
        ok: true,
        started: true,
        status:
          await this.status()
      });
    }

    if (
      url.pathname ===
      "/refresh"
    ) {
      const symbols =
        await this.refreshSymbols();

      if (
        this.running
      ) {
        await this.connectBybit();
      }

      return json({
        ok: true,
        count:
          symbols.length,
        symbols,
        status:
          await this.status()
      });
    }

    if (
      url.pathname ===
      "/status"
    ) {
      return json({
        ok: true,
        status:
          await this.status()
      });
    }

    if (
      url.pathname ===
      "/symbols"
    ) {
      const symbols =
        await this.loadCachedSymbols();

      return json({
        ok: true,
        count:
          symbols.length,
        symbols
      });
    }

    if (
      url.pathname ===
      "/history"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      const from =
        Number(
          url.searchParams.get(
            "from"
          ) || 0
        );

      const to =
        Number(
          url.searchParams.get(
            "to"
          ) || Date.now()
        );

      await this.start();

      const candles =
        await this.getHistory(
          symbol,
          from,
          to
        );

      return json({
        ok: true,

        symbol,

        category:
          "linear",

        interval:
          "1",

        historyHours:
          24,

        count:
          candles.length,

        candles
      });
    }

    if (
      url.pathname ===
      "/footprint"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      const minute =
        Number(
          url.searchParams.get(
            "minute"
          ) || 0
        );

      const tick =
        Number(
          url.searchParams.get(
            "tickSize"
          ) || 0
        );

      await this.start();

      const footprint =
        await this.getFootprint(
          symbol,
          minute,
          tick
        );

      return json({
        ok: true,

        symbol,

        category:
          "linear",

        minute,

        tickSize:
          tick,

        footprint
      });
    }

    return json({
      ok: true,
      service:
        "Absorption Zone Scanner Collector",
      version: VERSION,
      status:
        await this.status()
    });
  }
}

/* =========================================================
   COLLECTOR ACCESS
========================================================= */

function collectorStub(env) {
  const id =
    env.TRADE_COLLECTOR.idFromName(
      "global-bybit-linear"
    );

  return env.TRADE_COLLECTOR.get(id);
}

async function startCollector(env) {
  const stub =
    collectorStub(env);

  return stub.fetch(
    "https://collector/start"
  );
}

/* =========================================================
   MAIN API ROUTER
========================================================= */

async function route(
  request,
  env
) {
  const url =
    new URL(request.url);

  if (
    url.pathname ===
    "/api/health"
  ) {
    return json({
      ok: true,

      version: VERSION,

      category:
        "linear",

      collector:
        Boolean(
          env.TRADE_COLLECTOR
        ),

      time:
        new Date().toISOString()
    });
  }

  if (
    url.pathname ===
    "/api/test"
  ) {
    return new Response(
      "API TEST OK - " +
      VERSION,
      {
        headers: {
          ...CORS,
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }

  if (
    url.pathname ===
    "/api/collector/start"
  ) {
    try {
      const response =
        await startCollector(
          env
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Collector start error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/collector/status"
  ) {
    try {
      const stub =
        collectorStub(
          env
        );

      const response =
        await stub.fetch(
          "https://collector/status"
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Collector status error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/collector/refresh"
  ) {
    try {
      const stub =
        collectorStub(
          env
        );

      const response =
        await stub.fetch(
          "https://collector/refresh"
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Collector refresh error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/symbols"
  ) {
    try {
      const stub =
        collectorStub(
          env
        );

      await startCollector(
        env
      );

      const response =
        await stub.fetch(
          "https://collector/symbols"
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "خطای دریافت لیست Symbols"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/history"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    try {
      const stub =
        collectorStub(
          env
        );

      await startCollector(
        env
      );

      const from =
        url.searchParams.get(
          "from"
        ) || "";

      const to =
        url.searchParams.get(
          "to"
        ) || "";

      const target =
        `https://collector/history?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

      const response =
        await stub.fetch(
          target
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "History error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/history/footprint"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    const minute =
      Number(
        url.searchParams.get(
          "minute"
        ) || 0
      );

    const tickSize =
      Number(
        url.searchParams.get(
          "tickSize"
        ) || 0
      );

    try {
      const stub =
        collectorStub(
          env
        );

      await startCollector(
        env
      );

      const target =
        `https://collector/footprint?symbol=${encodeURIComponent(symbol)}&minute=${encodeURIComponent(minute)}&tickSize=${encodeURIComponent(tickSize)}`;

      const response =
        await stub.fetch(
          target
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
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Historical footprint error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/market"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    const interval =
      normalizeInterval(
        url.searchParams.get(
          "interval"
        )
      );

    try {
      const result =
        await getMarket(
          symbol,
          interval
        );

      return json({
        ok: true,
        ...result
      });
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            "خطای دریافت اطلاعات Bybit",

          version:
            VERSION
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/footprint"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    try {
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
          result.result?.list
        );

      const instrument =
        await bybit(
          "/v5/market/instruments-info",
          {
            category:
              "linear",

            symbol
          }
        );

      const tickSize =
        Number(
          instrument.result
            ?.list?.[0]
            ?.priceFilter
            ?.tickSize ||
          0
        );

      return json({
        ok: true,

        symbol,

        category:
          "linear",

        tickSize,

        trades,

        stats:
          tradeStats(
            trades
          ),

        footprint:
          aggregateFootprint(
            trades,
            tickSize
          )
      });
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            "Footprint error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/orderbook"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    try {
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
        ok: true,

        symbol,

        category:
          "linear",

        ...orderbookStats(
          result.result?.list ||
          {}
        )
      });
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            "Order Book error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/candles"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    const interval =
      normalizeInterval(
        url.searchParams.get(
          "interval"
        )
      );

    try {
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
        ok: true,

        symbol,

        category:
          "linear",

        interval,

        candles:
          parseKlines(
            result.result?.list
          )
      });
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            "Kline error"
        },
        502
      );
    }
  }

  return json({
    ok: true,

    service:
      "Absorption Zone Scanner",

    version:
      VERSION,

    category:
      "linear"
  });
}

/* =========================================================
   WORKER
========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
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

    const url =
      new URL(request.url);

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      return route(
        request,
        env
      );
    }

    if (
      env.ASSETS
    ) {
      const response =
        await env.ASSETS.fetch(
          request
        );

      const headers =
        new Headers(
          response.headers
        );

      headers.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      return new Response(
        response.body,
        {
          status:
            response.status,

          statusText:
            response.statusText,

          headers
        }
      );
    }

    return route(
      request,
      env
    );
  }
};
