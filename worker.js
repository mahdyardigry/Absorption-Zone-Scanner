import { DurableObject } from "cloudflare:workers";

const BYBIT_API = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "BYBIT-PERSONAL-COLLECTOR-V4";

const MAX_SYMBOLS = 1000;
const WS_SHARDS = 6;

const ORDERBOOK_DEPTH = 50;
const BOOK_SNAPSHOT_LEVELS = 50;
const SNAPSHOT_MS = 5000;

const MINUTE_MS = 60000;
const RETENTION_MINUTES = 1440;

const MAX_BLOCKS_PER_MINUTE = 100;
const BLOCK_MULTIPLIER = 5;

const WS_SUB_CHUNK = 200;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...extra
    }
  });
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normalizeSymbol(v) {
  return String(v || "").trim().toUpperCase();
}

function validSymbol(v) {
  return /^[A-Z0-9_-]{2,40}$/.test(String(v || ""));
}

function minuteStart(ts) {
  return Math.floor(num(ts, Date.now()) / MINUTE_MS) * MINUTE_MS;
}

function priceKey(price) {
  const n = num(price);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000) return n.toFixed(4);
  if (Math.abs(n) >= 1) return n.toFixed(6);
  if (Math.abs(n) >= 0.001) return n.toFixed(8);
  return n.toPrecision(12);
}

function average(a) {
  if (!Array.isArray(a) || !a.length) return 0;
  let s = 0;
  let n = 0;
  for (const x of a) {
    const v = Number(x);
    if (Number.isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : 0;
}

function median(a) {
  const x = (a || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!x.length) return 0;

  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function bybit(path, params = {}) {
  const u = new URL(BYBIT_API + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u, {
    headers: { accept: "application/json" }
  });

  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(`Bybit ${d.retCode}: ${d.retMsg || "Unknown error"}`);
  }

  return d;
}

async function getLinearSymbols() {
  const out = [];
  let cursor = "";

  while (out.length < MAX_SYMBOLS) {
    const d = await bybit("/v5/market/instruments-info", {
      category: "linear",
      status: "Trading",
      limit: 1000,
      cursor
    });

    const list = d?.result?.list || [];

    for (const x of list) {
      const s = normalizeSymbol(x.symbol);

      if (
        !s ||
        !validSymbol(s) ||
        !s.endsWith("USDT") ||
        (x.status && x.status !== "Trading") ||
        (x.quoteCoin && x.quoteCoin !== "USDT")
      ) continue;

      if (!out.includes(s)) out.push(s);
      if (out.length >= MAX_SYMBOLS) break;
    }

    cursor = d?.result?.nextPageCursor || "";
    if (!cursor || !list.length) break;
  }

  return out.sort();
}

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

    levels: {},
    bookSnapshots: []
  };
}

function aggregateFootprint(minute) {
  const levels = Object.values(minute.levels || {})
    .map(x => ({
      price: num(x.price),
      bidVolume: num(x.bidVolume),
      askVolume: num(x.askVolume),
      bidValue: num(x.bidValue),
      askValue: num(x.askValue),
      bidTrades: num(x.bidTrades),
      askTrades: num(x.askTrades),
      delta: num(x.askVolume) - num(x.bidVolume),
      deltaValue: num(x.askValue) - num(x.bidValue),
      totalVolume: num(x.totalVolume),
      totalValue: num(x.totalValue)
    }))
    .filter(x => x.price > 0)
    .sort((a, b) => b.price - a.price);

  return {
    time: minute.ts,
    symbol: minute.symbol,
    open: num(minute.open),
    high: num(minute.high),
    low: num(minute.low),
    close: num(minute.close),

    buyVolume: num(minute.buyVolume),
    sellVolume: num(minute.sellVolume),
    totalVolume: num(minute.buyVolume) + num(minute.sellVolume),

    buyValue: num(minute.buyValue),
    sellValue: num(minute.sellValue),
    totalValue: num(minute.buyValue) + num(minute.sellValue),

    delta: num(minute.delta),
    deltaValue: num(minute.deltaValue),

    cumulativeDelta: num(minute.cumulativeDelta),
    cumulativeDeltaValue: num(minute.cumulativeDeltaValue),

    tradeCount: num(minute.tradeCount),

    largestTradeValue: num(minute.largestTradeValue),
    blockThreshold: num(minute.blockThreshold),
    blocks: minute.blocks || [],

    liquidationBuyVolume: num(minute.liquidationBuyVolume),
    liquidationSellVolume: num(minute.liquidationSellVolume),
    liquidationBuyValue: num(minute.liquidationBuyValue),
    liquidationSellValue: num(minute.liquidationSellValue),
    liquidationBuyCount: num(minute.liquidationBuyCount),
    liquidationSellCount: num(minute.liquidationSellCount),

    maxBidLiquidity: num(minute.maxBidLiquidity),
    maxAskLiquidity: num(minute.maxAskLiquidity),
    avgBidLiquidity: num(minute.avgBidLiquidity),
    avgAskLiquidity: num(minute.avgAskLiquidity),

    bestBid: num(minute.lastBestBid),
    bestAsk: num(minute.lastBestAsk),

    bookSnapshotCount: num(minute.bookSnapshotCount),
    bookSnapshots: minute.bookSnapshots || [],

    levels
  };
}

function buildEmptyFlow() {
  return {
    buyVolume: 0,
    sellVolume: 0,
    totalVolume: 0,
    buyValue: 0,
    sellValue: 0,
    totalValue: 0,
    delta: 0,
    deltaValue: 0,
    deltaPercent: 0
  };
}

function flowFromTrades(trades) {
  const f = buildEmptyFlow();

  for (const t of trades || []) {
    const side = String(t.side || "").toUpperCase();
    const size = num(t.size);
    const value = num(t.value);

    if (side === "BUY") {
      f.buyVolume += size;
      f.buyValue += value;
    } else if (side === "SELL") {
      f.sellVolume += size;
      f.sellValue += value;
    }
  }

  f.totalVolume = f.buyVolume + f.sellVolume;
  f.totalValue = f.buyValue + f.sellValue;
  f.delta = f.buyVolume - f.sellVolume;
  f.deltaValue = f.buyValue - f.sellValue;

  f.deltaPercent =
    f.totalVolume > 0
      ? f.delta / f.totalVolume * 100
      : 0;

  return f;
}

function pressure(deltaPercent) {
  if (deltaPercent >= 15) return "BUY_PRESSURE";
  if (deltaPercent <= -15) return "SELL_PRESSURE";
  return "NEUTRAL";
}

function absorption(flow) {
  const d = num(flow.deltaPercent);

  if (Math.abs(d) < 5 && flow.totalVolume > 0) {
    return "ABSORPTION";
  }

  return "NORMAL";
}

function signalFromFlow(flow) {
  const d = num(flow.deltaPercent);

  if (d >= 20) return "BUY";
  if (d <= -20) return "SELL";
  return "WAIT";
}

async function getTicker(symbol) {
  try {
    const d = await bybit("/v5/market/tickers", {
      category: "linear",
      symbol
    });

    const x = d?.result?.list?.[0] || {};

    return {
      lastPrice: num(x.lastPrice),
      markPrice: num(x.markPrice),
      indexPrice: num(x.indexPrice),
      fundingRate: num(x.fundingRate),
      openInterest: num(x.openInterest),
      volume24h: num(x.volume24h),
      turnover24h: num(x.turnover24h)
    };
  } catch {
    return {
      lastPrice: 0,
      markPrice: 0,
      indexPrice: 0,
      fundingRate: 0,
      openInterest: 0,
      volume24h: 0,
      turnover24h: 0
    };
  }
}

async function getKlines(symbol, interval, limit = 200) {
  const d = await bybit("/v5/market/kline", {
    category: "linear",
    symbol,
    interval,
    limit
  });

  return (d?.result?.list || [])
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6]),
      delta: 0
    }))
    .sort((a, b) => a.time - b.time);
}

async function getRecentTrades(symbol, limit = 1000) {
  const d = await bybit("/v5/market/recent-trade", {
    category: "linear",
    symbol,
    limit: Math.min(1000, limit)
  });

  return (d?.result?.list || [])
    .map(x => {
      const price = num(x.price);
      const size = num(x.size);
      const side =
        String(x.side || "").toUpperCase() === "BUY"
          ? "BUY"
          : "SELL";

      return {
        id: String(x.execId || x.i || `${x.time}-${price}-${size}-${side}`),
        time: num(x.time),
        price,
        size,
        value: price * size,
        side
      };
    })
    .filter(x => x.price > 0 && x.size > 0)
    .sort((a, b) => b.time - a.time);
}

async function getOrderbook(symbol) {
  const d = await bybit("/v5/market/orderbook", {
    category: "linear",
    symbol,
    limit: ORDERBOOK_DEPTH
  });

  const r = d?.result || {};

  const bids = (r.b || [])
    .map(x => [num(x[0]), num(x[1])])
    .filter(x => x[0] > 0 && x[1] > 0)
    .sort((a, b) => b[0] - a[0]);

  const asks = (r.a || [])
    .map(x => [num(x[0]), num(x[1])])
    .filter(x => x[0] > 0 && x[1] > 0)
    .sort((a, b) => a[0] - b[0]);

  const buyLiquidity = bids.reduce((s, x) => s + x[0] * x[1], 0);
  const sellLiquidity = asks.reduce((s, x) => s + x[0] * x[1], 0);

  const bidSizes = bids.map(x => x[1]);
  const askSizes = asks.map(x => x[1]);

  const bidMedian = median(bidSizes);
  const askMedian = median(askSizes);

  const buyWalls = bids
    .filter(x => bidMedian > 0 && x[1] >= bidMedian * 4)
    .map(x => ({
      price: x[0],
      size: x[1],
      value: x[0] * x[1]
    }));

  const sellWalls = asks
    .filter(x => askMedian > 0 && x[1] >= askMedian * 4)
    .map(x => ({
      price: x[0],
      size: x[1],
      value: x[0] * x[1]
    }));

  const total = buyLiquidity + sellLiquidity;

  const buyShare =
    total > 0 ? buyLiquidity / total * 100 : 50;

  const sellShare =
    total > 0 ? sellLiquidity / total * 100 : 50;

  let bookPressure = "NEUTRAL";

  if (buyShare > sellShare + 8) bookPressure = "BUY_PRESSURE";
  if (sellShare > buyShare + 8) bookPressure = "SELL_PRESSURE";

  return {
    bestBid: bids[0]?.[0] || 0,
    bestAsk: asks[0]?.[0] || 0,

    buyLiquidity,
    sellLiquidity,

    bidLiquidity: buyLiquidity,
    askLiquidity: sellLiquidity,

    buyShare,
    sellShare,

    pressure: bookPressure,

    bids,
    asks,

    buyWalls,
    sellWalls
  };
}

function resampleCandles(base, interval) {
  const mins = Number(interval);

  if (!Number.isFinite(mins) || mins <= 1) {
    return base;
  }

  const bucket = mins * MINUTE_MS;
  const map = new Map();

  for (const c of base) {
    const t = Math.floor(c.time / bucket) * bucket;

    let x = map.get(t);

    if (!x) {
      x = {
        time: t,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 0,
        turnover: 0,
        delta: 0
      };

      map.set(t, x);
    }

    x.high = Math.max(x.high, c.high);
    x.low = Math.min(x.low, c.low);
    x.close = c.close;
    x.volume += c.volume;
    x.turnover += c.turnover;
  }

  return [...map.values()]
    .sort((a, b) => a.time - b.time);
}

async function analyzeSymbol(symbol, interval, collector) {
  symbol = normalizeSymbol(symbol);
  interval = String(interval || "5");

  if (!validSymbol(symbol)) {
    throw new Error("Invalid symbol");
  }

  const [
    raw1m,
    trades,
    book,
    ticker
  ] = await Promise.all([
    getKlines(symbol, "1", 1000),
    getRecentTrades(symbol, 1000),
    getOrderbook(symbol),
    getTicker(symbol)
  ]);

  const candles =
    interval === "1"
      ? raw1m.slice(-200)
      : resampleCandles(raw1m, interval).slice(-200);

  const liveFlow = flowFromTrades(trades);

  const footprints =
    collector
      ? collector.getHistoryForSymbol(symbol, 24 * 60)
      : [];

  const currentMinute =
    collector
      ? collector.getCurrentMinute(symbol)
      : null;

  if (currentMinute) {
    const fp = aggregateFootprint(currentMinute);

    if (fp.tradeCount > 0) {
      footprints.push(fp);
    }
  }

  const fpMap = new Map();

  for (const fp of footprints) {
    fpMap.set(String(fp.time), fp);
  }

  const finalFootprints =
    [...fpMap.values()]
      .sort((a, b) => num(a.time) - num(b.time))
      .slice(-1440);

  const byMinute = new Map(
    finalFootprints.map(x => [
      minuteStart(x.time),
      x
    ])
  );

  for (const c of candles) {
    const fp = byMinute.get(minuteStart(c.time));

    if (fp) {
      c.delta = num(fp.delta);
      c.flowVolume = num(fp.totalVolume);
    }
  }

  const signal =
    signalFromFlow(liveFlow);

  return {
    ok: true,
    version: VERSION,
    symbol,
    interval,

    lastPrice:
      ticker.lastPrice ||
      candles.at(-1)?.close ||
      0,

    candles,

    trades: trades.slice(0, 150),

    footprints: finalFootprints,

    currentFlow: liveFlow,

    flowPressure:
      pressure(liveFlow.deltaPercent),

    absorption:
      absorption(liveFlow),

    signal,

    wall: book,

    ticker
  };
}

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

  ensureSchema() {
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS minutes(
          symbol TEXT NOT NULL,
          ts INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY(symbol,ts)
        )
      `);

      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_minutes_symbol_ts
        ON minutes(symbol,ts)
      `);

      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta(
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
    } catch (e) {
      console.error(e);
    }
  }

  saveMeta(key, value) {
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
    } catch {}
  }

  getMeta(key, fallback = null) {
    try {
      const r = this.ctx.storage.sql.exec(
        `SELECT value FROM meta WHERE key=? LIMIT 1`,
        key
      ).toArray();

      return r.length ? r[0].value : fallback;
    } catch {
      return fallback;
    }
  }

  saveMinute(m) {
    try {
      this.ctx.storage.sql.exec(
        `
        INSERT INTO minutes(symbol,ts,data)
        VALUES(?,?,?)
        ON CONFLICT(symbol,ts)
        DO UPDATE SET data=excluded.data
        `,
        m.symbol,
        m.ts,
        JSON.stringify(m)
      );
    } catch (e) {
      this.stats.errors++;
      console.error(e);
    }
  }

  latest(symbol) {
    try {
      const r = this.ctx.storage.sql.exec(
        `
        SELECT data
        FROM minutes
        WHERE symbol=?
        ORDER BY ts DESC
        LIMIT 1
        `,
        symbol
      ).toArray();

      return r.length ? JSON.parse(r[0].data) : null;
    } catch {
      return null;
    }
  }

  history(symbol, from, to, limit = 1440) {
    try {
      const r = this.ctx.storage.sql.exec(
        `
        SELECT data
        FROM minutes
        WHERE symbol=?
        AND ts>=?
        AND ts<=?
        ORDER BY ts ASC
        LIMIT ?
        `,
        symbol,
        from,
        to,
        limit
      ).toArray();

      return r
        .map(x => {
          try {
            return JSON.parse(x.data);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  getHistoryForSymbol(symbol, count = 1440) {
    const now = Date.now();

    const rows =
      this.history(
        symbol,
        now - count * MINUTE_MS,
        now,
        count
      );

    return rows.map(aggregateFootprint);
  }

  getCurrentMinute(symbol) {
    for (const shard of this.shards.values()) {
      const x = shard.getCurrentMinute(symbol);
      if (x) return x;
    }

    return null;
  }

  deleteOld(symbol, before) {
    try {
      this.ctx.storage.sql.exec(
        `
        DELETE FROM minutes
        WHERE symbol=?
        AND ts<?
        `,
        symbol,
        before
      );
    } catch {}
  }

  async setSymbols(symbols) {
    const clean = [
      ...new Set(
        (symbols || [])
          .map(normalizeSymbol)
          .filter(validSymbol)
          .filter(x => x.endsWith("USDT"))
      )
    ].slice(0, MAX_SYMBOLS);

    this.symbols = clean;

    this.saveMeta(
      "symbols",
      JSON.stringify(clean)
    );

    await this.stopShards();
    await this.startShards();
  }

  async startShards() {
    if (!this.symbols.length) return;

    this.started = true;

    const n = Math.min(
      WS_SHARDS,
      Math.max(1, this.symbols.length)
    );

    const groups =
      Array.from(
        { length: n },
        () => []
      );

    this.symbols.forEach(
      (s, i) =>
        groups[i % n].push(s)
    );

    for (let i = 0; i < groups.length; i++) {
      const shard =
        new CollectorShard(
          this,
          i,
          groups[i]
        );

      this.shards.set(i, shard);

      this.ctx.waitUntil(
        shard.start().catch(
          e => console.error(e)
        )
      );
    }

    this.saveMeta(
      "startedAt",
      Date.now()
    );
  }

  async stopShards() {
    const all = [...this.shards.values()];
    this.shards.clear();

    await Promise.allSettled(
      all.map(x => x.stop())
    );
  }

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

      let symbols =
        Array.isArray(body.symbols)
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
        try {
          this.symbols =
            JSON.parse(
              this.getMeta(
                "symbols",
                "[]"
              )
            );
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
      return json({
        ok: true,
        version: VERSION,
        started: this.started,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        symbols: this.symbols.length,
        shards: this.shards.size,
        stats: this.stats,
        shardStatus:
          [...this.shards.values()]
            .map(x => x.status())
      });
    }

    if (path === "/latest") {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      return json({
        ok: true,
        symbol,
        data: this.latest(symbol)
      });
    }

    if (path === "/history") {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      const hours =
        clamp(
          num(
            url.searchParams.get("hours"),
            24
          ),
          1,
          24
        );

      const now = Date.now();

      const data =
        this.history(
          symbol,
          now - hours * 60 * MINUTE_MS,
          now,
          hours * 60
        ).map(aggregateFootprint);

      return json({
        ok: true,
        symbol,
        hours,
        count: data.length,
        data
      });
    }

    if (path === "/history-footprint") {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      const hours =
        clamp(
          num(
            url.searchParams.get("hours"),
            24
          ),
          1,
          24
        );

      const now = Date.now();

      const raw =
        this.history(
          symbol,
          now - hours * 60 * MINUTE_MS,
          now,
          hours * 60
        );

      const data =
        raw.map(aggregateFootprint);

      return json({
        ok: true,
        available: data.length > 0,
        symbol,
        hours,
        count: data.length,
        footprints: data
      });
    }

    if (path === "/cleanup") {
      const before =
        Date.now() -
        RETENTION_MINUTES *
        MINUTE_MS;

      for (const s of this.symbols) {
        this.deleteOld(s, before);
      }

      return json({
        ok: true,
        before
      });
    }

    return json({
      ok: true,
      service: "Bybit Personal Collector",
      version: VERSION
    });
  }
}

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
    this.connectedAt = 0;

    this.messageCount = 0;
    this.tradeCount = 0;
    this.orderbookCount = 0;
    this.liquidationCount = 0;
    this.errors = 0;
  }

  async start() {
    if (this.running) return;

    this.running = true;

    await this.connect();
  }

  async stop() {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.ws?.close(1000, "stopping");
    } catch {}

    this.ws = null;
  }

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
      liquidationCount: this.liquidationCount,
      errors: this.errors,
      books: this.books.size,
      activeMinutes: this.minutes.size
    };
  }

  getCurrentMinute(symbol) {
    const ts = minuteStart(Date.now());
    return this.minutes.get(`${symbol}:${ts}`) || null;
  }

  async connect() {
    if (
      !this.running ||
      this.connecting ||
      (
        this.ws &&
        this.ws.readyState === WebSocket.OPEN
      )
    ) return;

    this.connecting = true;

    try {
      const ws =
        new WebSocket(BYBIT_WS);

      this.ws = ws;

      ws.addEventListener(
        "open",
        () => {
          this.onOpen().catch(
            e => console.error(e)
          );
        }
      );

      ws.addEventListener(
        "message",
        e => {
          this.onMessage(e.data).catch(
            err => {
              this.errors++;
              this.owner.stats.errors++;
              console.error(err);
            }
          );
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
    } catch {
      this.connecting = false;
      this.errors++;
      this.owner.stats.errors++;
      this.scheduleReconnect();
    }
  }

  async onOpen() {
    this.connecting = false;
    this.connectedAt = Date.now();

    this.owner.stats.reconnects++;

    this.reconnectDelay =
      RECONNECT_MIN_MS;

    const topics = [];

    for (const s of this.symbols) {
      topics.push(`publicTrade.${s}`);
      topics.push(`orderbook.${ORDERBOOK_DEPTH}.${s}`);
      topics.push(`allLiquidation.${s}`);
    }

    for (
      let i = 0;
      i < topics.length;
      i += WS_SUB_CHUNK
    ) {
      if (
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) return;

      this.ws.send(
        JSON.stringify({
          op: "subscribe",
          args: topics.slice(
            i,
            i + WS_SUB_CHUNK
          )
        })
      );

      await new Promise(
        r => setTimeout(r, 100)
      );
    }
  }

  scheduleReconnect() {
    if (
      !this.running ||
      this.reconnectTimer
    ) return;

    const delay =
      this.reconnectDelay +
      Math.floor(Math.random() * 1000);

    this.reconnectDelay =
      Math.min(
        RECONNECT_MAX_MS,
        this.reconnectDelay * 2
      );

    this.reconnectTimer =
      setTimeout(
        () => {
          this.reconnectTimer = null;
          this.connect().catch(() => {});
        },
        delay
      );
  }

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

    if (!msg) return;

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

    if (msg.success === false) {
      this.errors++;
      this.owner.stats.errors++;
      return;
    }

    const topic =
      String(msg.topic || "");

    if (
      topic.startsWith("publicTrade.")
    ) {
      await this.handleTrades(msg);
      return;
    }

    if (
      topic.startsWith("orderbook.")
    ) {
      await this.handleOrderbook(msg);
      return;
    }

    if (
      topic.startsWith("allLiquidation.")
    ) {
      await this.handleLiquidation(msg);
    }
  }

  isDuplicate(symbol, trade) {
    const id =
      String(
        trade?.i ??
        trade?.execId ??
        `${trade?.T}-${trade?.p}-${trade?.v}-${trade?.S}`
      );

    const last =
      this.lastTradeId.get(symbol);

    if (last === id) return true;

    this.lastTradeId.set(symbol, id);

    return false;
  }

  getMinute(symbol, ts) {
    const ms = minuteStart(ts);
    const key = `${symbol}:${ms}`;

    let m = this.minutes.get(key);

    if (!m) {
      m = emptyMinute(symbol, ms);

      const previous =
        this.owner.latest(symbol);

      if (previous) {
        m.cumulativeDelta =
          num(previous.cumulativeDelta);

        m.cumulativeDeltaValue =
          num(previous.cumulativeDeltaValue);
      }

      this.minutes.set(key, m);
    }

    return m;
  }

  ensureLevel(m, price) {
    const key = priceKey(price);

    if (!m.levels[key]) {
      m.levels[key] = {
        price: num(price),

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

    return m.levels[key];
  }

  applyTrade(symbol, t) {
    const ts = num(t.T, Date.now());
    const price = num(t.p);
    const size = num(t.v);
    const side = String(t.S || "");

    if (price <= 0 || size <= 0) return;

    const value = price * size;
    const m = this.getMinute(symbol, ts);

    if (!m.open) {
      m.open = price;
      m.high = price;
      m.low = price;
      m.close = price;
    } else {
      m.high = Math.max(m.high, price);
      m.low = Math.min(m.low, price);
      m.close = price;
    }

    m.tradeCount++;

    const l =
      this.ensureLevel(m, price);

    l.totalVolume += size;
    l.totalValue += value;

    if (side === "Buy") {
      m.buyVolume += size;
      m.buyValue += value;

      l.askVolume += size;
      l.askValue += value;
      l.askTrades++;
    } else if (side === "Sell") {
      m.sellVolume += size;
      m.sellValue += value;

      l.bidVolume += size;
      l.bidValue += value;
      l.bidTrades++;
    } else {
      return;
    }

    l.delta =
      l.askVolume -
      l.bidVolume;

    l.deltaValue =
      l.askValue -
      l.bidValue;

    m.delta =
      m.buyVolume -
      m.sellVolume;

    m.deltaValue =
      m.buyValue -
      m.sellValue;

    m.cumulativeDelta +=
      side === "Buy"
        ? size
        : -size;

    m.cumulativeDeltaValue +=
      side === "Buy"
        ? value
        : -value;

    m.largestTradeValue =
      Math.max(
        m.largestTradeValue,
        value
      );
  }

  async handleTrades(msg) {
    const list =
      Array.isArray(msg.data)
        ? msg.data
        : [];

    for (const t of list) {
      const symbol =
        normalizeSymbol(t.s);

      if (
        !symbol ||
        !validSymbol(symbol)
      ) continue;

      if (
        this.isDuplicate(symbol, t)
      ) continue;

      this.applyTrade(symbol, t);

      this.tradeCount++;
      this.owner.stats.trades++;
    }

    await this.flush();
  }

  ensureBook(symbol) {
    let b = this.books.get(symbol);

    if (!b) {
      b = {
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

      this.books.set(symbol, b);
    }

    return b;
  }

  applySide(map, levels) {
    if (!Array.isArray(levels)) return;

    for (const row of levels) {
      if (
        !Array.isArray(row) ||
        row.length < 2
      ) continue;

      const p = num(row[0]);
      const s = num(row[1]);

      if (p <= 0) continue;

      const k = priceKey(p);

      if (s <= 0) {
        map.delete(k);
      } else {
        map.set(k, {
          price: p,
          size: s
        });
      }
    }
  }

  bookMetrics(book) {
    const bids =
      [...book.bids.values()]
        .sort((a, b) => b.price - a.price);

    const asks =
      [...book.asks.values()]
        .sort((a, b) => a.price - b.price);

    const bidLiquidity =
      bids.reduce(
        (s, x) => s + x.price * x.size,
        0
      );

    const askLiquidity =
      asks.reduce(
        (s, x) => s + x.price * x.size,
        0
      );

    book.bestBid =
      bids[0]?.price || 0;

    book.bestAsk =
      asks[0]?.price || 0;

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

    if (book.bidSamples.length > 60)
      book.bidSamples.shift();

    if (book.askSamples.length > 60)
      book.askSamples.shift();

    return {
      bids,
      asks,
      bidLiquidity,
      askLiquidity
    };
  }

  async handleOrderbook(msg) {
    this.orderbookCount++;
    this.owner.stats.orderbookMessages++;

    const symbol =
      normalizeSymbol(
        String(msg.topic || "")
          .split(".")
          .pop()
      );

    if (!symbol) return;

    const data = msg.data || {};
    const type = String(msg.type || "");

    const book =
      this.ensureBook(symbol);

    if (type === "snapshot") {
      book.bids.clear();
      book.asks.clear();

      this.applySide(
        book.bids,
        data.b
      );

      this.applySide(
        book.asks,
        data.a
      );

      book.initialized = true;
      book.lastUpdateId = num(data.u);
      book.lastSeq = num(data.seq);
    } else if (type === "delta") {
      if (!book.initialized) return;

      this.applySide(
        book.bids,
        data.b
      );

      this.applySide(
        book.asks,
        data.a
      );

      const seq = num(data.seq);

      if (
        seq &&
        book.lastSeq &&
        seq < book.lastSeq
      ) {
        book.bids.clear();
        book.asks.clear();
        book.initialized = false;
        return;
      }

      book.lastSeq = seq || book.lastSeq;
      book.lastUpdateId =
        num(data.u) ||
        book.lastUpdateId;
    } else {
      return;
    }

    const metrics =
      this.bookMetrics(book);

    const ts =
      num(data.ts, Date.now());

    const m =
      this.getMinute(symbol, ts);

    m.bookSnapshotCount++;

    m.lastBestBid =
      metrics.bids[0]?.price || 0;

    m.lastBestAsk =
      metrics.asks[0]?.price || 0;

    m.maxBidLiquidity =
      Math.max(
        m.maxBidLiquidity,
        metrics.bidLiquidity
      );

    m.maxAskLiquidity =
      Math.max(
        m.maxAskLiquidity,
        metrics.askLiquidity
      );

    m.avgBidLiquidity =
      average(book.bidSamples);

    m.avgAskLiquidity =
      average(book.askSamples);

    if (
      Date.now() -
      book.lastSnapshot >=
      SNAPSHOT_MS
    ) {
      book.lastSnapshot = Date.now();

      m.bookSnapshots.push({
        ts,

        bestBid:
          metrics.bids[0]?.price || 0,

        bestAsk:
          metrics.asks[0]?.price || 0,

        bidLiquidity:
          metrics.bidLiquidity,

        askLiquidity:
          metrics.askLiquidity,

        bids:
          metrics.bids
            .slice(0, BOOK_SNAPSHOT_LEVELS)
            .map(x => [x.price, x.size]),

        asks:
          metrics.asks
            .slice(0, BOOK_SNAPSHOT_LEVELS)
            .map(x => [x.price, x.size])
      });

      if (m.bookSnapshots.length > 12) {
        m.bookSnapshots =
          m.bookSnapshots.slice(-12);
      }

      book.snapshotCount++;
    }

    await this.flush();
  }

  async handleLiquidation(msg) {
    const symbol =
      normalizeSymbol(
        String(msg.topic || "")
          .split(".")
          .pop()
      );

    if (!symbol) return;

    const list =
      Array.isArray(msg.data)
        ? msg.data
        : [];

    for (const x of list) {
      const ts = num(x.T, Date.now());
      const price = num(x.p);
      const size = num(x.v);
      const side = String(x.S || "");

      if (price <= 0 || size <= 0) continue;

      const value = price * size;
      const m = this.getMinute(symbol, ts);

      if (side === "Sell") {
        m.liquidationSellVolume += size;
        m.liquidationSellValue += value;
        m.liquidationSellCount++;
      } else if (side === "Buy") {
        m.liquidationBuyVolume += size;
        m.liquidationBuyValue += value;
        m.liquidationBuyCount++;
      }

      this.liquidationCount++;
      this.owner.stats.liquidations++;
    }

    await this.flush();
  }

  finalize(m) {
    m.delta =
      m.buyVolume -
      m.sellVolume;

    m.deltaValue =
      m.buyValue -
      m.sellValue;

    const trades =
      Math.max(1, m.tradeCount);

    const avgValue =
      (
        m.buyValue +
        m.sellValue
      ) / trades;

    const threshold =
      Math.max(
        avgValue * BLOCK_MULTIPLIER,
        m.largestTradeValue * 0.5
      );

    m.blockThreshold =
      threshold;

    const blocks = [];

    if (threshold > 0) {
      for (const l of Object.values(m.levels)) {
        if (l.totalValue >= threshold) {
          blocks.push({
            price: l.price,
            value: l.totalValue,
            volume: l.totalVolume,

            bidVolume: l.bidVolume,
            askVolume: l.askVolume,

            delta:
              l.askVolume -
              l.bidVolume,

            deltaValue:
              l.askValue -
              l.bidValue,

            bidTrades: l.bidTrades,
            askTrades: l.askTrades
          });
        }
      }
    }

    blocks.sort(
      (a, b) => b.value - a.value
    );

    m.blocks =
      blocks.slice(
        0,
        MAX_BLOCKS_PER_MINUTE
      );

    return m;
  }

  async flush() {
    const current =
      minuteStart(Date.now());

    const cutoff =
      current - MINUTE_MS;

    const retention =
      current -
      RETENTION_MINUTES *
      MINUTE_MS;

    const done = [];

    for (const [key, m] of this.minutes) {
      if (m.ts <= cutoff) {
        done.push([key, m]);
      }
    }

    for (const [key, m] of done) {
      this.finalize(m);

      this.owner.saveMinute(m);

      this.minutes.delete(key);

      this.owner.deleteOld(
        m.symbol,
        retention
      );
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url =
      new URL(request.url);

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

    if (url.pathname === "/api/health") {
      let collectorStatus = null;

      try {
        const id =
          env.COLLECTOR.idFromName("MAIN");

        const stub =
          env.COLLECTOR.get(id);

        const r =
          await stub.fetch(
            new Request(
              new URL(
                "/status",
                request.url
              ),
              request
            )
          );

        collectorStatus =
          await r.json();
      } catch {}

      return json({
        ok: true,
        service:
          "Bybit Personal Collector",
        version: VERSION,
        d1: !!env.COLLECTOR,
        collector:
          collectorStatus,
        time: Date.now()
      });
    }

    if (url.pathname === "/api/test-bybit") {
      try {
        const d =
          await bybit(
            "/v5/market/time"
          );

        return json({
          ok: true,
          bybit: d
        });
      } catch (e) {
        return json({
          ok: false,
          error: String(e?.message || e)
        }, 502);
      }
    }

    const id =
      env.COLLECTOR.idFromName("MAIN");

    const stub =
      env.COLLECTOR.get(id);

    if (url.pathname === "/api/init") {
      return stub.fetch(
        new Request(
          new URL(
            "/init",
            request.url
          ),
          request
        )
      );
    }

    if (url.pathname === "/api/status") {
      return stub.fetch(
        new Request(
          new URL(
            "/status",
            request.url
          ),
          request
        )
      );
    }

    if (url.pathname === "/api/symbols") {
      return stub.fetch(
        new Request(
          new URL(
            "/symbols",
            request.url
          ),
          request
        )
      );
    }

    if (
      url.pathname ===
      "/api/history-footprint"
    ) {
      const target =
        new URL(
          "/history-footprint",
          request.url
        );

      target.search =
        url.search;

      return stub.fetch(
        new Request(
          target,
          request
        )
      );
    }

    if (url.pathname === "/api/latest") {
      const target =
        new URL(
          "/latest",
          request.url
        );

      target.search =
        url.search;

      return stub.fetch(
        new Request(
          target,
          request
        )
      );
    }

    if (url.pathname === "/api/history") {
      const target =
        new URL(
          "/history",
          request.url
        );

      target.search =
        url.search;

      return stub.fetch(
        new Request(
          target,
          request
        )
      );
    }

    if (url.pathname === "/api/cleanup") {
      return stub.fetch(
        new Request(
          new URL(
            "/cleanup",
            request.url
          ),
          request
        )
      );
    }

    if (url.pathname === "/api/collect") {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      if (!symbol) {
        return json({
          ok: false,
          error: "symbol required"
        }, 400);
      }

      try {
        const d =
          await analyzeSymbol(
            symbol,
            url.searchParams.get("interval") || "1",
            stub
          );

        return json({
          ok: true,
          collected: true,
          symbol,
          footprints:
            d.footprints
        });
      } catch (e) {
        return json({
          ok: false,
          error: String(e?.message || e)
        }, 502);
      }
    }

    if (
      url.pathname ===
      "/api/analyze"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      const interval =
        String(
          url.searchParams.get("interval") ||
          "5"
        );

      if (!symbol) {
        return json({
          ok: false,
          error: "symbol required"
        }, 400);
      }

      try {
        const data =
          await analyzeSymbol(
            symbol,
            interval,
            stub
          );

        return json(data);
      } catch (e) {
        return json({
          ok: false,
          error: String(e?.message || e)
        }, 502);
      }
    }

    if (
      url.pathname ===
      "/api/live"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get("symbol")
        );

      const interval =
        String(
          url.searchParams.get("interval") ||
          "5"
        );

      if (!symbol) {
        return json({
          ok: false,
          error: "symbol required"
        }, 400);
      }

      try {
        const data =
          await analyzeSymbol(
            symbol,
            interval,
            stub
          );

        return json(data);
      } catch (e) {
        return json({
          ok: false,
          error: String(e?.message || e)
        }, 502);
      }
    }

    if (url.pathname === "/api/scan") {
      try {
        const symbols =
          await getLinearSymbols();

        const offset =
          Math.max(
            0,
            num(
              url.searchParams.get(
                "offset"
              )
            )
          );

        const batch =
          symbols.slice(
            offset,
            offset + 20
          );

        const results = [];

        for (const symbol of batch) {
          try {
            const d =
              await analyzeSymbol(
                symbol,
                "15",
                stub
              );

            const deltaPercent =
              num(
                d.currentFlow?.deltaPercent
              );

            let score =
              50 +
              clamp(
                deltaPercent * 1.5,
                -40,
                40
              );

            if (
              d.signal === "BUY"
            ) score += 10;

            if (
              d.signal === "SELL"
            ) score += 10;

            score =
              clamp(
                Math.round(score),
                0,
                100
              );

            results.push({
              symbol,
              score,
              signal: d.signal,
              price: d.lastPrice,
              deltaPercent,
              pressure: d.flowPressure,
              absorption: d.absorption
            });
          } catch {}
        }

        results.sort(
          (a, b) =>
            b.score -
            a.score
        );

        return json({
          ok: true,
          offset,
          count: results.length,
          results
        });
      } catch (e) {
        return json({
          ok: false,
          error: String(e?.message || e)
        }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
