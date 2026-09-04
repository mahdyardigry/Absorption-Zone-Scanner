import { DurableObject } from "cloudflare:workers";

/* =========================================================
   BYBIT PERSONAL ORDER FLOW COLLECTOR
   ========================================================= */

const BYBIT_API = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "BYBIT-PERSONAL-COLLECTOR-V3";

const MAX_SYMBOLS = 1000;
const WS_SHARDS = 6;

const ORDERBOOK_DEPTH = 50;
const BOOK_SNAPSHOT_LEVELS = 50;
const SNAPSHOT_MS = 5000;

const MINUTE_MS = 60 * 1000;
const RETENTION_MINUTES = 24 * 60;

const MAX_BLOCKS_PER_MINUTE = 100;
const BLOCK_MULTIPLIER = 5;

const WS_SUB_CHUNK = 200;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

const SYMBOL_CACHE_MS = 10 * 60 * 1000;

/* =========================================================
   UTILS
   ========================================================= */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

function nowMs() {
  return Date.now();
}

function minuteStart(ts) {
  return Math.floor(Number(ts) / MINUTE_MS) * MINUTE_MS;
}

function priceKey(price) {
  const n = Number(price);

  if (!Number.isFinite(n)) return "0";

  if (Math.abs(n) >= 1000) return n.toFixed(4);
  if (Math.abs(n) >= 1) return n.toFixed(6);
  if (Math.abs(n) >= 0.001) return n.toFixed(8);

  return n.toPrecision(12);
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function median(values) {
  if (!values.length) return 0;

  const a = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((x, y) => x - y);

  if (!a.length) return 0;

  const mid = Math.floor(a.length / 2);

  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isValidSymbol(symbol) {
  return /^[A-Z0-9_-]{2,40}$/.test(String(symbol || ""));
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
   BYBIT REST
   ========================================================= */

async function bybit(path, params = {}) {
  const url = new URL(BYBIT_API + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      `Bybit ${data.retCode}: ${data.retMsg || "Unknown error"}`
    );
  }

  return data;
}

/* =========================================================
   SYMBOL DISCOVERY
   ========================================================= */

async function getLinearSymbols() {
  const result = [];

  let cursor = "";

  while (result.length < MAX_SYMBOLS) {
    const data = await bybit("/v5/market/instruments-info", {
      category: "linear",
      status: "Trading",
      limit: 1000,
      cursor
    });

    const list = data?.result?.list || [];

    for (const item of list) {
      const symbol = normalizeSymbol(item.symbol);

      if (!symbol) continue;

      if (item.status && item.status !== "Trading") {
        continue;
      }

      if (item.quoteCoin && item.quoteCoin !== "USDT") {
        continue;
      }

      if (!symbol.endsWith("USDT")) {
        continue;
      }

      if (!result.includes(symbol)) {
        result.push(symbol);
      }

      if (result.length >= MAX_SYMBOLS) {
        break;
      }
    }

    cursor = data?.result?.nextPageCursor || "";

    if (!cursor || !list.length) {
      break;
    }
  }

  return result.sort();
}

/* =========================================================
   MINUTE DATA
   ========================================================= */

function emptyMinute(symbol, ts) {
  return {
    symbol,
    ts,

    open: 0,
    high: 0,
    low: 0,
    close: 0,

    tradeCount: 0,

    buyVolume: 0,
    sellVolume: 0,

    buyValue: 0,
    sellValue: 0,

    delta: 0,
    deltaValue: 0,

    cumulativeDelta: 0,
    cumulativeDeltaValue: 0,

    largestTradeValue: 0,

    blockThreshold: 0,

    blocks: [],

    liquidationBuyVolume: 0,
    liquidationSellVolume: 0,

    liquidationBuyValue: 0,
    liquidationSellValue: 0,

    liquidationBuyCount: 0,
    liquidationSellCount: 0,

    maxBidLiquidity: 0,
    maxAskLiquidity: 0,

    avgBidLiquidity: 0,
    avgAskLiquidity: 0,

    bookSnapshotCount: 0,

    lastBestBid: 0,
    lastBestAsk: 0,

    /*
      Canonical footprint storage.

      Every price level is stored ONCE.

      Buy aggressor  = ASK
      Sell aggressor = BID

      Example:

      price 100
      10 Buy trades -> askVolume is sum of all 10
      7 Sell trades -> bidVolume is sum of all 7
    */
    levels: {},

    /*
      Compact orderbook history.
      Snapshots are only stored every SNAPSHOT_MS.
    */
    bookSnapshots: []
  };
}

/* =========================================================
   DURABLE OBJECT
   ========================================================= */

export class CollectorDO extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.shards = new Map();

    this.symbols = [];

    this.started = false;

    this.startedAt = Date.now();

    this.stats = {
      messages: 0,
      trades: 0,
      orderbookMessages: 0,
      liquidations: 0,
      reconnects: 0,
      errors: 0
    };

    this.ensureSchema();
  }

  /* =======================================================
     SQLITE
     ======================================================= */

  ensureSchema() {
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS minutes (
          symbol TEXT NOT NULL,
          ts INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY(symbol, ts)
        )
      `);

      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_minutes_symbol_ts
        ON minutes(symbol, ts)
      `);

      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
    } catch (err) {
      console.error("SCHEMA ERROR", err);
    }
  }

  sqlSaveMeta(key, value) {
    try {
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
    } catch (err) {
      console.error("META SAVE ERROR", err);
    }
  }

  sqlGetMeta(key, fallback = null) {
    try {
      const rows = this.ctx.storage.sql.exec(
        `SELECT value FROM meta WHERE key = ? LIMIT 1`,
        key
      ).toArray();

      if (!rows.length) return fallback;

      return rows[0].value;
    } catch (err) {
      console.error("META GET ERROR", err);
      return fallback;
    }
  }

  sqlSaveMinute(minute) {
    try {
      this.ctx.storage.sql.exec(
        `
        INSERT INTO minutes(symbol,ts,data)
        VALUES(?,?,?)
        ON CONFLICT(symbol,ts)
        DO UPDATE SET data=excluded.data
        `,
        minute.symbol,
        minute.ts,
        JSON.stringify(minute)
      );
    } catch (err) {
      console.error("MINUTE SAVE ERROR", err);
      this.stats.errors++;
    }
  }

  sqlDeleteOld(symbol, beforeTs) {
    try {
      this.ctx.storage.sql.exec(
        `
        DELETE FROM minutes
        WHERE symbol = ?
        AND ts < ?
        `,
        symbol,
        beforeTs
      );
    } catch (err) {
      console.error("RETENTION ERROR", err);
    }
  }

  sqlLatest(symbol) {
    try {
      const rows = this.ctx.storage.sql.exec(
        `
        SELECT data
        FROM minutes
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT 1
        `,
        symbol
      ).toArray();

      if (!rows.length) return null;

      return JSON.parse(rows[0].data);
    } catch (err) {
      console.error("LATEST ERROR", err);
      return null;
    }
  }

  sqlHistory(symbol, from, to, limit = 1440) {
    try {
      const rows = this.ctx.storage.sql.exec(
        `
        SELECT data
        FROM minutes
        WHERE symbol = ?
        AND ts >= ?
        AND ts <= ?
        ORDER BY ts ASC
        LIMIT ?
        `,
        symbol,
        from,
        to,
        limit
      ).toArray();

      return rows
        .map(row => {
          try {
            return JSON.parse(row.data);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      console.error("HISTORY ERROR", err);
      return [];
    }
  }

  sqlSymbols() {
    try {
      const rows = this.ctx.storage.sql.exec(
        `
        SELECT DISTINCT symbol
        FROM minutes
        ORDER BY symbol
        `
      ).toArray();

      return rows.map(x => x.symbol);
    } catch {
      return [];
    }
  }

  /* =======================================================
     SHARD MANAGEMENT
     ======================================================= */

  async setSymbols(symbols) {

    const clean = [
      ...new Set(
        symbols
          .map(normalizeSymbol)
          .filter(isValidSymbol)
          .filter(x => x.endsWith("USDT"))
      )
    ].slice(0, MAX_SYMBOLS);

    this.symbols = clean;

    this.sqlSaveMeta(
      "symbols",
      JSON.stringify(clean)
    );

    if (!this.started) {
      await this.startShards();
      return;
    }

    await this.stopShards();
    await this.startShards();
  }

  async startShards() {

    if (!this.symbols.length) {
      return;
    }

    this.started = true;

    const shardCount = Math.min(
      WS_SHARDS,
      Math.max(1, this.symbols.length)
    );

    const groups = Array.from(
      { length: shardCount },
      () => []
    );

    this.symbols.forEach((symbol, index) => {
      groups[index % shardCount].push(symbol);
    });

    for (let i = 0; i < groups.length; i++) {

      const shard = new CollectorShard(
        this,
        i,
        groups[i]
      );

      this.shards.set(i, shard);

      this.ctx.waitUntil(
        shard.start().catch(err => {
          console.error(
            `SHARD ${i} START ERROR`,
            err
          );
        })
      );
    }

    this.sqlSaveMeta(
      "startedAt",
      String(Date.now())
    );
  }

  async stopShards() {

    const list = [...this.shards.values()];

    this.shards.clear();

    await Promise.allSettled(
      list.map(shard => shard.stop())
    );
  }

  /* =======================================================
     ROUTER
     ======================================================= */

  async fetch(request) {

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (path === "/init") {

      let body = {};

      try {
        body = await request.json();
      } catch {}

      let symbols = Array.isArray(body.symbols)
        ? body.symbols
        : [];

      if (!symbols.length) {
        symbols = await getLinearSymbols();
      }

      await this.setSymbols(symbols);

      return json({
        ok: true,
        version: VERSION,
        symbols: this.symbols.length,
        shards: this.shards.size
      });
    }

    if (path === "/symbols") {

      if (!this.symbols.length) {
        const saved = this.sqlGetMeta(
          "symbols",
          "[]"
        );

        try {
          this.symbols = JSON.parse(saved);
        } catch {
          this.symbols = [];
        }
      }

      return json({
        ok: true,
        count: this.symbols.length,
        symbols: this.symbols
      });
    }

    if (path === "/status") {

      const shardStatus = [];

      for (const shard of this.shards.values()) {
        shardStatus.push(
          shard.status()
        );
      }

      return json({
        ok: true,
        version: VERSION,

        started: this.started,

        startedAt: this.startedAt,

        uptimeMs: Date.now() - this.startedAt,

        symbols: this.symbols.length,

        shards: this.shards.size,

        stats: this.stats,

        shardStatus
      });
    }

    if (path === "/latest") {

      const symbol = normalizeSymbol(
        url.searchParams.get("symbol")
      );

      if (!symbol) {
        return json({
          ok: false,
          error: "symbol required"
        }, 400);
      }

      const latest = this.sqlLatest(symbol);

      return json({
        ok: true,
        symbol,
        data: latest
      });
    }

    if (path === "/history") {

      const symbol = normalizeSymbol(
        url.searchParams.get("symbol")
      );

      if (!symbol) {
        return json({
          ok: false,
          error: "symbol required"
        }, 400);
      }

      const now = Date.now();

      const from = safeNumber(
        url.searchParams.get("from"),
        now - RETENTION_MINUTES * MINUTE_MS
      );

      const to = safeNumber(
        url.searchParams.get("to"),
        now
      );

      const limit = clamp(
        safeNumber(
          url.searchParams.get("limit"),
          RETENTION_MINUTES
        ),
        1,
        RETENTION_MINUTES
      );

      const data = this.sqlHistory(
        symbol,
        from,
        to,
        limit
      );

      return json({
        ok: true,
        symbol,
        from,
        to,
        count: data.length,
        data
      });
    }

    if (path === "/cleanup") {

      const before =
        Date.now() -
        RETENTION_MINUTES * MINUTE_MS;

      const symbols =
        this.symbols.length
          ? this.symbols
          : this.sqlSymbols();

      for (const symbol of symbols) {
        this.sqlDeleteOld(
          symbol,
          before
        );
      }

      return json({
        ok: true,
        before,
        symbols: symbols.length
      });
    }

    return json({
      ok: true,
      service: "Bybit Personal Collector",
      version: VERSION,
      routes: [
        "/init",
        "/symbols",
        "/status",
        "/latest?symbol=BTCUSDT",
        "/history?symbol=BTCUSDT",
        "/cleanup"
      ]
    });
  }
}

/* =========================================================
   COLLECTOR SHARD
   ========================================================= */

class CollectorShard {

  constructor(owner, id, symbols) {

    this.owner = owner;

    this.id = id;

    this.symbols = symbols;

    this.ws = null;

    this.running = false;

    this.connecting = false;

    this.reconnectTimer = null;

    this.reconnectDelay = RECONNECT_MIN_MS;

    this.books = new Map();

    this.minutes = new Map();

    this.lastTradeId = new Map();

    this.lastSeq = new Map();

    this.connectedAt = 0;

    this.messageCount = 0;

    this.tradeCount = 0;

    this.orderbookCount = 0;

    this.liquidationCount = 0;

    this.errors = 0;
  }

  /* =======================================================
     START
     ======================================================= */

  async start() {

    if (this.running) {
      return;
    }

    this.running = true;

    await this.connect();
  }

  /* =======================================================
     STOP
     ======================================================= */

  async stop() {

    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close(
          1000,
          "collector stopping"
        );
      } catch {}
    }

    this.ws = null;
  }

  /* =======================================================
     STATUS
     ======================================================= */

  status() {

    return {
      id: this.id,

      symbols: this.symbols.length,

      connected:
        !!this.ws &&
        this.ws.readyState === WebSocket.OPEN,

      connectedAt: this.connectedAt,

      messageCount: this.messageCount,

      tradeCount: this.tradeCount,

      orderbookCount: this.orderbookCount,

      liquidationCount:
        this.liquidationCount,

      errors: this.errors,

      books: this.books.size,

      activeMinutes:
        this.minutes.size
    };
  }

  /* =======================================================
     CONNECT
     ======================================================= */

  async connect() {

    if (!this.running) {
      return;
    }

    if (this.connecting) {
      return;
    }

    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      return;
    }

    this.connecting = true;

    try {

      const ws = new WebSocket(
        BYBIT_WS
      );

      this.ws = ws;

      ws.addEventListener(
        "open",
        () => {
          this.onOpen().catch(err => {
            console.error(
              "WS OPEN ERROR",
              err
            );
          });
        }
      );

      ws.addEventListener(
        "message",
        event => {
          this.onMessage(
            event.data
          ).catch(err => {
            this.errors++;
            this.owner.stats.errors++;

            console.error(
              "WS MESSAGE ERROR",
              err
            );
          });
        }
      );

      ws.addEventListener(
        "error",
        () => {
          this.errors++;
          this.owner.stats.errors++;
        }
      );

      ws.addEventListener(
        "close",
        () => {
          this.connecting = false;

          this.ws = null;

          if (this.running) {
            this.scheduleReconnect();
          }
        }
      );

    } catch (err) {

      this.errors++;

      this.owner.stats.errors++;

      this.connecting = false;

      this.scheduleReconnect();
    }
  }

  /* =======================================================
     OPEN
     ======================================================= */

  async onOpen() {

    this.connecting = false;

    this.connectedAt = Date.now();

    this.owner.stats.reconnects++;

    this.reconnectDelay =
      RECONNECT_MIN_MS;

    const topics = [];

    for (const symbol of this.symbols) {

      topics.push(
        `publicTrade.${symbol}`
      );

      topics.push(
        `orderbook.${ORDERBOOK_DEPTH}.${symbol}`
      );

      topics.push(
        `allLiquidation.${symbol}`
      );
    }

    for (
      let i = 0;
      i < topics.length;
      i += WS_SUB_CHUNK
    ) {

      const chunk =
        topics.slice(
          i,
          i + WS_SUB_CHUNK
        );

      if (
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      this.ws.send(
        JSON.stringify({
          op: "subscribe",
          args: chunk
        })
      );

      await sleep(100);
    }
  }

  /* =======================================================
     RECONNECT
     ======================================================= */

  scheduleReconnect() {

    if (!this.running) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay =
      this.reconnectDelay +
      Math.floor(
        Math.random() * 1000
      );

    this.reconnectDelay =
      Math.min(
        RECONNECT_MAX_MS,
        this.reconnectDelay * 2
      );

    this.reconnectTimer =
      setTimeout(() => {

        this.reconnectTimer = null;

        this.connect().catch(err => {
          this.errors++;
          this.owner.stats.errors++;
        });

      }, delay);
  }

  /* =======================================================
     MESSAGE
     ======================================================= */

  async onMessage(raw) {

    this.messageCount++;

    this.owner.stats.messages++;

    let msg;

    try {
      msg =
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw;
    } catch {
      return;
    }

    if (!msg) {
      return;
    }

    if (msg.op === "ping") {

      if (
        this.ws &&
        this.ws.readyState === WebSocket.OPEN
      ) {

        this.ws.send(
          JSON.stringify({
            op: "pong"
          })
        );
      }

      return;
    }

    if (
      msg.success === false
    ) {

      console.error(
        "BYBIT WS ERROR",
        msg
      );

      this.errors++;

      this.owner.stats.errors++;

      return;
    }

    const topic =
      String(msg.topic || "");

    if (!topic) {
      return;
    }

    if (
      topic.startsWith("publicTrade.")
    ) {

      await this.handleTrades(
        msg
      );

      return;
    }

    if (
      topic.startsWith("orderbook.")
    ) {

      await this.handleOrderbook(
        msg
      );

      return;
    }

    if (
      topic.startsWith("allLiquidation.")
    ) {

      await this.handleLiquidation(
        msg
      );
    }
  }

  /* =======================================================
     TRADE DEDUP
     ======================================================= */

  isDuplicateTrade(
    symbol,
    trade
  ) {

    const id =
      trade?.i ??
      `${trade?.T}-${trade?.p}-${trade?.v}-${trade?.S}`;

    const key = String(id);

    const previous =
      this.lastTradeId.get(symbol);

    if (previous === key) {
      return true;
    }

    this.lastTradeId.set(
      symbol,
      key
    );

    return false;
  }

  /* =======================================================
     MINUTE
     ======================================================= */

  getMinute(symbol, ts) {

    const ms =
      minuteStart(ts);

    const key =
      `${symbol}:${ms}`;

    let minute =
      this.minutes.get(key);

    if (!minute) {

      minute =
        emptyMinute(
          symbol,
          ms
        );

      const previous =
        this.owner.sqlLatest(
          symbol
        );

      if (previous) {

        minute.cumulativeDelta =
          safeNumber(
            previous.cumulativeDelta
          );

        minute.cumulativeDeltaValue =
          safeNumber(
            previous.cumulativeDeltaValue
          );
      }

      this.minutes.set(
        key,
        minute
      );
    }

    return minute;
  }

  /* =======================================================
     PRICE LEVEL
     ======================================================= */

  ensureLevel(
    minute,
    price
  ) {

    const key =
      priceKey(price);

    if (
      !minute.levels[key]
    ) {

      minute.levels[key] = {

        price:
          Number(price),

        /*
          BID = aggressive sell
          ASK = aggressive buy
        */

        bidVolume: 0,
        askVolume: 0,

        bidValue: 0,
        askValue: 0,

        bidTrades: 0,
        askTrades: 0,

        delta: 0,
        deltaValue: 0,

        totalVolume: 0,
        totalValue: 0
      };
    }

    return minute.levels[key];
  }

  /* =======================================================
     APPLY TRADE
     ======================================================= */

  applyTrade(
    symbol,
    trade
  ) {

    const ts =
      safeNumber(
        trade.T,
        Date.now()
      );

    const price =
      safeNumber(
        trade.p
      );

    const size =
      safeNumber(
        trade.v
      );

    const side =
      String(
        trade.S || ""
      );

    if (
      price <= 0 ||
      size <= 0
    ) {
      return;
    }

    const value =
      price * size;

    const minute =
      this.getMinute(
        symbol,
        ts
      );

    /* =====================================================
       OHLC
       ===================================================== */

    if (!minute.open) {
      minute.open = price;
      minute.high = price;
      minute.low = price;
      minute.close = price;
    } else {

      minute.high =
        Math.max(
          minute.high,
          price
        );

      minute.low =
        Math.min(
          minute.low,
          price
        );

      minute.close = price;
    }

    /* =====================================================
       TOTAL TRADE COUNT
       ===================================================== */

    minute.tradeCount++;

    /* =====================================================
       CANONICAL PRICE LEVEL
       ===================================================== */

    const level =
      this.ensureLevel(
        minute,
        price
      );

    level.totalVolume += size;

    level.totalValue += value;

    /* =====================================================
       BUY AGGRESSOR = ASK
       ===================================================== */

    if (side === "Buy") {

      minute.buyVolume += size;

      minute.buyValue += value;

      level.askVolume += size;

      level.askValue += value;

      level.askTrades++;

    }

    /* =====================================================
       SELL AGGRESSOR = BID
       ===================================================== */

    else if (side === "Sell") {

      minute.sellVolume += size;

      minute.sellValue += value;

      level.bidVolume += size;

      level.bidValue += value;

      level.bidTrades++;
    }

    /* =====================================================
       DELTA
       ===================================================== */

    level.delta =
      level.askVolume -
      level.bidVolume;

    level.deltaValue =
      level.askValue -
      level.bidValue;

    minute.delta =
      minute.buyVolume -
      minute.sellVolume;

    minute.deltaValue =
      minute.buyValue -
      minute.sellValue;

    minute.cumulativeDelta +=
      side === "Buy"
        ? size
        : side === "Sell"
          ? -size
          : 0;

    minute.cumulativeDeltaValue +=
      side === "Buy"
        ? value
        : side === "Sell"
          ? -value
          : 0;

    /* =====================================================
       LARGEST TRADE
       ===================================================== */

    if (
      value >
      minute.largestTradeValue
    ) {

      minute.largestTradeValue =
        value;
    }
  }

  /* =======================================================
     HANDLE TRADES
     ======================================================= */

  async handleTrades(msg) {

    const list =
      Array.isArray(msg.data)
        ? msg.data
        : [];

    for (const trade of list) {

      const symbol =
        normalizeSymbol(
          trade.s
        );

      if (
        !symbol ||
        !isValidSymbol(symbol)
      ) {
        continue;
      }

      if (
        this.isDuplicateTrade(
          symbol,
          trade
        )
      ) {
        continue;
      }

      this.applyTrade(
        symbol,
        trade
      );

      this.tradeCount++;

      this.owner.stats.trades++;
    }

    await this.flushOldMinutes();
  }

  /* =======================================================
     ORDERBOOK OBJECT
     ======================================================= */

  ensureBook(symbol) {

    let book =
      this.books.get(symbol);

    if (!book) {

      book = {

        symbol,

        bids: new Map(),

        asks: new Map(),

        initialized: false,

        lastUpdateId: 0,

        lastSeq: 0,

        lastSnapshot: 0,

        snapshotCount: 0,

        bestBid: 0,

        bestAsk: 0,

        bidLiquidity: 0,

        askLiquidity: 0,

        bidSamples: [],

        askSamples: []
      };

      this.books.set(
        symbol,
        book
      );
    }

    return book;
  }

  /* =======================================================
     ORDERBOOK APPLY
     ======================================================= */

  applyBookSide(
    sideMap,
    levels
  ) {

    if (!Array.isArray(levels)) {
      return;
    }

    for (
      const row of levels
    ) {

      if (
        !Array.isArray(row) ||
        row.length < 2
      ) {
        continue;
      }

      const price =
        safeNumber(
          row[0]
        );

      const size =
        safeNumber(
          row[1]
        );

      if (
        price <= 0
      ) {
        continue;
      }

      if (
        size <= 0
      ) {

        sideMap.delete(
          priceKey(price)
        );

      } else {

        sideMap.set(
          priceKey(price),
          {
            price,
            size
          }
        );
      }
    }
  }

  /* =======================================================
     ORDERBOOK GAP DETECTION
     ======================================================= */

  checkBookSequence(
    symbol,
    book,
    data
  ) {

    const u =
      safeNumber(
        data.u
      );

    const seq =
      safeNumber(
        data.seq
      );

    let gap = false;

    if (
      seq &&
      book.lastSeq &&
      seq < book.lastSeq
    ) {
      gap = true;
    }

    if (
      u &&
      book.lastUpdateId &&
      u < book.lastUpdateId
    ) {
      gap = true;
    }

    if (gap) {

      book.bids.clear();
      book.asks.clear();

      book.initialized = false;

      book.lastUpdateId = 0;
      book.lastSeq = 0;
    }

    if (u) {
      book.lastUpdateId = u;
    }

    if (seq) {
      book.lastSeq = seq;
    }

    return !gap;
  }

  /* =======================================================
     ORDERBOOK METRICS
     ======================================================= */

  calculateBookMetrics(
    book
  ) {

    const bids =
      [...book.bids.values()]
        .sort(
          (a, b) =>
            b.price - a.price
        );

    const asks =
      [...book.asks.values()]
        .sort(
          (a, b) =>
            a.price - b.price
        );

    book.bestBid =
      bids.length
        ? bids[0].price
        : 0;

    book.bestAsk =
      asks.length
        ? asks[0].price
        : 0;

    let bidLiquidity = 0;
    let askLiquidity = 0;

    for (
      const x of bids
    ) {

      bidLiquidity +=
        x.price * x.size;
    }

    for (
      const x of asks
    ) {

      askLiquidity +=
        x.price * x.size;
    }

    book.bidLiquidity =
      bidLiquidity;

    book.askLiquidity =
      askLiquidity;

    book.bidSamples.push(
      bidLiquidity
    );

    book.askSamples.push(
      askLiquidity
    );

    if (
      book.bidSamples.length > 60
    ) {
      book.bidSamples.shift();
    }

    if (
      book.askSamples.length > 60
    ) {
      book.askSamples.shift();
    }

    return {
      bids,
      asks,
      bidLiquidity,
      askLiquidity
    };
  }

  /* =======================================================
     COMPACT BOOK SNAPSHOT
     ======================================================= */

  makeBookSnapshot(
    metrics,
    ts
  ) {

    const bids =
      metrics.bids
        .slice(
          0,
          BOOK_SNAPSHOT_LEVELS
        )
        .map(x => [
          x.price,
          x.size
        ]);

    const asks =
      metrics.asks
        .slice(
          0,
          BOOK_SNAPSHOT_LEVELS
        )
        .map(x => [
          x.price,
          x.size
        ]);

    return {

      ts,

      bestBid:
        metrics.bids.length
          ? metrics.bids[0].price
          : 0,

      bestAsk:
        metrics.asks.length
          ? metrics.asks[0].price
          : 0,

      bidLiquidity:
        metrics.bidLiquidity,

      askLiquidity:
        metrics.askLiquidity,

      bids,

      asks
    };
  }

  /* =======================================================
     HANDLE ORDERBOOK
     ======================================================= */

  async handleOrderbook(msg) {

    this.orderbookCount++;

    this.owner.stats.orderbookMessages++;

    const topic =
      String(
        msg.topic || ""
      );

    const symbol =
      normalizeSymbol(
        topic.split(".").pop()
      );

    if (!symbol) {
      return;
    }

    const data =
      msg.data || {};

    const type =
      String(
        msg.type || ""
      );

    const book =
      this.ensureBook(
        symbol
      );

    /*
      Snapshot initializes the local book.
    */

    if (
      type === "snapshot"
    ) {

      book.bids.clear();
      book.asks.clear();

      this.applyBookSide(
        book.bids,
        data.b
      );

      this.applyBookSide(
        book.asks,
        data.a
      );

      book.initialized = true;

      book.lastUpdateId =
        safeNumber(
          data.u
        );

      book.lastSeq =
        safeNumber(
          data.seq
        );
    }

    /*
      Delta modifies the existing local book.
    */

    else if (
      type === "delta"
    ) {

      if (
        !book.initialized
      ) {
        return;
      }

      this.checkBookSequence(
        symbol,
        book,
        data
      );

      this.applyBookSide(
        book.bids,
        data.b
      );

      this.applyBookSide(
        book.asks,
        data.a
      );
    }

    else {
      return;
    }

    const metrics =
      this.calculateBookMetrics(
        book
      );

    const ts =
      safeNumber(
        data.ts,
        Date.now()
      );

    const minute =
      this.getMinute(
        symbol,
        ts
      );

    minute.bookSnapshotCount++;

    minute.lastBestBid =
      metrics.bids.length
        ? metrics.bids[0].price
        : 0;

    minute.lastBestAsk =
      metrics.asks.length
        ? metrics.asks[0].price
        : 0;

    minute.maxBidLiquidity =
      Math.max(
        minute.maxBidLiquidity,
        metrics.bidLiquidity
      );

    minute.maxAskLiquidity =
      Math.max(
        minute.maxAskLiquidity,
        metrics.askLiquidity
      );

    minute.avgBidLiquidity =
      average(
        book.bidSamples
      );

    minute.avgAskLiquidity =
      average(
        book.askSamples
      );

    /*
      IMPORTANT:
      Snapshot timer is PER SYMBOL,
      not global.
    */

    if (
      Date.now() -
      book.lastSnapshot >=
      SNAPSHOT_MS
    ) {

      book.lastSnapshot =
        Date.now();

      const snapshot =
        this.makeBookSnapshot(
          metrics,
          ts
        );

      minute.bookSnapshots.push(
        snapshot
      );

      /*
        Keep a hard safety limit
        inside one minute.
      */

      if (
        minute.bookSnapshots.length >
        12
      ) {

        minute.bookSnapshots =
          minute.bookSnapshots.slice(-12);
      }

      book.snapshotCount++;
    }

    await this.flushOldMinutes();
  }

  /* =======================================================
     LIQUIDATION
     ======================================================= */

  async handleLiquidation(msg) {

    const topic =
      String(
        msg.topic || ""
      );

    const symbol =
      normalizeSymbol(
        topic.split(".").pop()
      );

    if (!symbol) {
      return;
    }

    const list =
      Array.isArray(msg.data)
        ? msg.data
        : [];

    for (
      const item of list
    ) {

      const ts =
        safeNumber(
          item.T,
          Date.now()
        );

      const price =
        safeNumber(
          item.p
        );

      const size =
        safeNumber(
          item.v
        );

      const side =
        String(
          item.S || ""
        );

      if (
        price <= 0 ||
        size <= 0
      ) {
        continue;
      }

      const value =
        price * size;

      const minute =
        this.getMinute(
          symbol,
          ts
        );

      /*
        Bybit liquidation side:
        Sell = long liquidation
        Buy  = short liquidation

        Stored separately so frontend
        can display liquidation direction.
      */

      if (
        side === "Sell"
      ) {

        minute.liquidationSellVolume +=
          size;

        minute.liquidationSellValue +=
          value;

        minute.liquidationSellCount++;

      } else if (
        side === "Buy"
      ) {

        minute.liquidationBuyVolume +=
          size;

        minute.liquidationBuyValue +=
          value;

        minute.liquidationBuyCount++;
      }

      this.liquidationCount++;

      this.owner.stats.liquidations++;
    }

    await this.flushOldMinutes();
  }

  /* =======================================================
     BLOCK DETECTION
     ======================================================= */

  calculateBlocks(
    minute
  ) {

    const trades =
      minute.tradeCount;

    if (!trades) {
      return;
    }

    const avgValue =
      (
        minute.buyValue +
        minute.sellValue
      ) / trades;

    const threshold =
      Math.max(
        avgValue * BLOCK_MULTIPLIER,
        minute.largestTradeValue * 0.5
      );

    minute.blockThreshold =
      threshold;

    if (
      threshold <= 0
    ) {
      return;
    }

    const blocks = [];

    for (
      const level
      of Object.values(
        minute.levels
      )
    ) {

      const total =
        level.totalValue;

      if (
        total >= threshold
      ) {

        blocks.push({

          price:
            level.price,

          value:
            total,

          volume:
            level.totalVolume,

          bidVolume:
            level.bidVolume,

          askVolume:
            level.askVolume,

          delta:
            level.delta,

          deltaValue:
            level.deltaValue,

          bidTrades:
            level.bidTrades,

          askTrades:
            level.askTrades
        });
      }
    }

    blocks.sort(
      (a, b) =>
        b.value - a.value
    );

    minute.blocks =
      blocks.slice(
        0,
        MAX_BLOCKS_PER_MINUTE
      );
  }

  /* =======================================================
     FINALIZE MINUTE
     ======================================================= */

  finalizeMinute(
    minute
  ) {

    if (
      !minute
    ) {
      return;
    }

    minute.delta =
      minute.buyVolume -
      minute.sellVolume;

    minute.deltaValue =
      minute.buyValue -
      minute.sellValue;

    this.calculateBlocks(
      minute
    );

    /*
      Ensure numeric integrity.
    */

    minute.buyVolume =
      safeNumber(
        minute.buyVolume
      );

    minute.sellVolume =
      safeNumber(
        minute.sellVolume
      );

    minute.buyValue =
      safeNumber(
        minute.buyValue
      );

    minute.sellValue =
      safeNumber(
        minute.sellValue
      );

    minute.delta =
      safeNumber(
        minute.delta
      );

    minute.deltaValue =
      safeNumber(
        minute.deltaValue
      );

    /*
      Keep only canonical `levels`.

      No duplicate bidLevels / askLevels
      are stored.
    */

    return minute;
  }

  /* =======================================================
     FLUSH OLD MINUTES
     ======================================================= */

  async flushOldMinutes() {

    if (
      !this.minutes.size
    ) {
      return;
    }

    const current =
      minuteStart(
        Date.now()
      );

    const cutoff =
      current -
      MINUTE_MS;

    const retentionCutoff =
      current -
      RETENTION_MINUTES *
      MINUTE_MS;

    const toFlush = [];

    for (
      const [
        key,
        minute
      ] of this.minutes
    ) {

      if (
        minute.ts <= cutoff
      ) {

        toFlush.push([
          key,
          minute
        ]);
      }
    }

    for (
      const [
        key,
        minute
      ] of toFlush
    ) {

      this.finalizeMinute(
        minute
      );

      this.owner.sqlSaveMinute(
        minute
      );

      this.minutes.delete(
        key
      );
    }

    /*
      Retention cleanup is performed
      per symbol.
    */

    const symbols =
      new Set(
        toFlush.map(
          x => x[1].symbol
        )
      );

    for (
      const symbol
      of symbols
    ) {

      this.owner.sqlDeleteOld(
        symbol,
        retentionCutoff
      );
    }
  }
}

/* =========================================================
   AVERAGE
   ========================================================= */

function average(values) {

  if (
    !Array.isArray(values) ||
    !values.length
  ) {
    return 0;
  }

  let total = 0;
  let count = 0;

  for (
    const value
    of values
  ) {

    const n =
      Number(value);

    if (
      Number.isFinite(n)
    ) {

      total += n;
      count++;
    }
  }

  return count
    ? total / count
    : 0;
}

/* =========================================================
   DEFAULT WORKER
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

    /*
      Health
    */

    if (
      url.pathname ===
      "/api/health"
    ) {

      return json({
        ok: true,
        service:
          "Bybit Personal Collector",
        version:
          VERSION,
        time:
          Date.now()
      });
    }

    /*
      Test Bybit REST
    */

    if (
      url.pathname ===
      "/api/test-bybit"
    ) {

      try {

        const data =
          await bybit(
            "/v5/market/time"
          );

        return json({
          ok: true,
          bybit: data
        });

      } catch (err) {

        return json({
          ok: false,
          error:
            String(
              err?.message ||
              err
            )
        }, 502);
      }
    }

    /*
      Get Durable Object
    */

    const id =
      env.COLLECTOR.idFromName(
        "MAIN"
      );

    const stub =
      env.COLLECTOR.get(id);

    /*
      Collector API
    */

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {

      const collectorPath =
        url.pathname.replace(
          /^\/api/,
          ""
        ) || "/";

      const target =
        new URL(
          request.url
        );

      target.pathname =
        collectorPath;

      const forwarded =
        new Request(
          target.toString(),
          request
        );

      return stub.fetch(
        forwarded
      );
    }

    /*
      Existing public frontend
    */

    return env.ASSETS.fetch(
      request
    );
  }
};
