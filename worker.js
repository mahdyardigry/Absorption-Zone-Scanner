const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ZONE-SCANNER-V3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
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

function errorJson(message, status = 500, extra = {}) {
  return json({
    ok: false,
    error: String(message || "Unknown error"),
    ...extra
  }, status);
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function normalizeSymbol(v) {
  return String(v || "BTCUSDT")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeCategory(v) {
  return String(v || "linear").toLowerCase() === "spot"
    ? "spot"
    : "linear";
}

function normalizeInterval(v) {
  const x = String(v || "1").toLowerCase();

  const map = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "60m": "60"
  };

  return map[x] || x || "1";
}

function intervalMs(interval) {
  const x = Number(normalizeInterval(interval));
  return Math.max(60000, x * 60000);
}

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

  let response;

  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Absorption-Zone-Scanner"
      }
    });
  } catch (e) {
    throw new Error("خطا در اتصال به Bybit: " + e.message);
  }

  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error(
      `پاسخ خالی از Bybit دریافت شد (${response.status})`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ Bybit JSON معتبر نیست (${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.retMsg ||
      `HTTP ${response.status}`
    );
  }

  if (Number(data?.retCode) !== 0) {
    throw new Error(
      data?.retMsg ||
      `Bybit retCode=${data?.retCode}`
    );
  }

  return data;
}

async function getInstruments(category, symbol) {
  const data = await bybit(
    "/v5/market/instruments-info",
    {
      category,
      symbol
    }
  );

  return data?.result?.list?.[0] || null;
}

async function getKlines(
  category,
  symbol,
  interval,
  limit = 500,
  end = null
) {
  const params = {
    category,
    symbol,
    interval: normalizeInterval(interval),
    limit: clamp(limit, 1, 1000)
  };

  if (end) {
    params.end = end;
  }

  const data = await bybit(
    "/v5/market/kline",
    params
  );

  const list = data?.result?.list || [];

  return list
    .map(row => ({
      time: num(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
      turnover: num(row[6])
    }))
    .filter(x =>
      x.time > 0 &&
      x.open > 0 &&
      x.high > 0 &&
      x.low > 0 &&
      x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

async function getRecentTrades(
  category,
  symbol,
  limit = 1000
) {
  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: clamp(limit, 1, 1000)
    }
  );

  return (data?.result?.list || [])
    .map(t => ({
      id: String(t.execId || t.id || ""),
      time: num(t.time),
      price: num(t.price),
      qty: num(t.size),
      side: String(t.side || "").toLowerCase(),
      isBlock: Boolean(t.isBlockTrade),
      value: num(t.price) * num(t.size)
    }))
    .filter(t =>
      t.time > 0 &&
      t.price > 0 &&
      t.qty > 0 &&
      (t.side === "buy" || t.side === "sell")
    )
    .sort((a, b) => a.time - b.time);
}

async function getOrderbook(
  category,
  symbol,
  limit = 50
) {
  const data = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit: clamp(limit, 1, 200)
    }
  );

  const result = data?.result || {};

  const bids = (result.b || [])
    .map(x => ({
      price: num(x[0]),
      qty: num(x[1])
    }))
    .filter(x => x.price > 0 && x.qty > 0);

  const asks = (result.a || [])
    .map(x => ({
      price: num(x[0]),
      qty: num(x[1])
    }))
    .filter(x => x.price > 0 && x.qty > 0);

  return {
    timestamp: num(result.ts, Date.now()),
    updateId: String(result.u || ""),
    bids,
    asks,
    bestBid: bids.length ? bids[0].price : 0,
    bestAsk: asks.length ? asks[0].price : 0
  };
}

async function getTicker(category, symbol) {
  const data = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  const x = data?.result?.list?.[0] || {};

  return {
    symbol,
    lastPrice: num(x.lastPrice),
    bid1Price: num(x.bid1Price),
    ask1Price: num(x.ask1Price),
    bid1Size: num(x.bid1Size),
    ask1Size: num(x.ask1Size),
    volume24h: num(x.volume24h),
    turnover24h: num(x.turnover24h),
    price24hPcnt: num(x.price24hPcnt),
    high24h: num(x.highPrice24h),
    low24h: num(x.lowPrice24h)
  };
}

function priceStep(instrument, fallbackPrice = 0) {
  const tick = num(
    instrument?.priceFilter?.tickSize,
    0
  );

  if (tick > 0) return tick;

  if (fallbackPrice >= 10000) return 1;
  if (fallbackPrice >= 1000) return 0.1;
  if (fallbackPrice >= 100) return 0.01;
  if (fallbackPrice >= 1) return 0.001;
  if (fallbackPrice >= 0.1) return 0.0001;
  if (fallbackPrice >= 0.01) return 0.00001;
  return 0.000001;
}

function bucketPrice(price, step) {
  if (!step) return price;

  return Number(
    (Math.round(price / step) * step).toFixed(
      Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2))
    )
  );
}

function makeEmptyLevel(price) {
  return {
    price,
    bid: 0,
    ask: 0,
    volume: 0,
    delta: 0,
    trades: 0,
    buyTrades: 0,
    sellTrades: 0,
    buyValue: 0,
    sellValue: 0,
    largeBuy: 0,
    largeSell: 0,
    blockBuy: 0,
    blockSell: 0
  };
}

function buildTradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;
  let buyValue = 0;
  let sellValue = 0;
  let buyTrades = 0;
  let sellTrades = 0;
  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  let blockBuyVolume = 0;
  let blockSellVolume = 0;

  const values = trades
    .map(t => t.value)
    .filter(v => v > 0)
    .sort((a, b) => a - b);

  const averageValue = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;

  const p95 = values.length
    ? values[Math.min(
        values.length - 1,
        Math.floor(values.length * 0.95)
      )]
    : 0;

  const largeThreshold = Math.max(
    averageValue * 5,
    p95,
    0
  );

  for (const t of trades) {
    if (t.side === "buy") {
      buyVolume += t.qty;
      buyValue += t.value;
      buyTrades++;

      if (t.value >= largeThreshold && largeThreshold > 0) {
        largeBuyVolume += t.qty;
      }

      if (t.isBlock) {
        blockBuyVolume += t.qty;
      }
    } else {
      sellVolume += t.qty;
      sellValue += t.value;
      sellTrades++;

      if (t.value >= largeThreshold && largeThreshold > 0) {
        largeSellVolume += t.qty;
      }

      if (t.isBlock) {
        blockSellVolume += t.qty;
      }
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;
  const delta = buyVolume - sellVolume;

  const deltaPercent =
    totalVolume > 0
      ? delta / totalVolume * 100
      : 0;

  let cvd = 0;
  let previousCvd = 0;

  for (const t of trades) {
    const d =
      t.side === "buy"
        ? t.qty
        : -t.qty;

    previousCvd = cvd;
    cvd += d;
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
    totalTrades: buyTrades + sellTrades,
    delta,
    deltaPercent,
    cvd,
    previousCvd,
    largeBuyVolume,
    largeSellVolume,
    blockBuyVolume,
    blockSellVolume,
    largeThreshold,
    averageTradeValue: averageValue,
    largestTradeValue: values.length
      ? values[values.length - 1]
      : 0
  };
}

function buildFootprint(
  trades,
  candle,
  instrument
) {
  const step = priceStep(
    instrument,
    candle?.close || trades[trades.length - 1]?.price || 0
  );

  const map = new Map();

  const values = trades
    .map(t => t.value)
    .filter(Boolean)
    .sort((a, b) => a - b);

  const averageValue = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;

  const p95 = values.length
    ? values[Math.min(
        values.length - 1,
        Math.floor(values.length * 0.95)
      )]
    : 0;

  const largeThreshold = Math.max(
    averageValue * 5,
    p95,
    0
  );

  for (const t of trades) {
    const p = bucketPrice(t.price, step);

    if (!map.has(p)) {
      map.set(p, makeEmptyLevel(p));
    }

    const l = map.get(p);

    l.volume += t.qty;
    l.trades++;

    if (t.side === "buy") {
      l.bid += t.qty;
      l.delta += t.qty;
      l.buyTrades++;
      l.buyValue += t.value;

      if (t.value >= largeThreshold && largeThreshold > 0) {
        l.largeBuy += t.qty;
      }

      if (t.isBlock) {
        l.blockBuy += t.qty;
      }
    } else {
      l.ask += t.qty;
      l.delta -= t.qty;
      l.sellTrades++;
      l.sellValue += t.value;

      if (t.value >= largeThreshold && largeThreshold > 0) {
        l.largeSell += t.qty;
      }

      if (t.isBlock) {
        l.blockSell += t.qty;
      }
    }
  }

  const levels = [...map.values()]
    .sort((a, b) => b.price - a.price);

  const stats = buildTradeStats(trades);

  const totalLevelVolume = levels.reduce(
    (s, x) => s + x.volume,
    0
  );

  let poc = null;

  for (const l of levels) {
    if (!poc || l.volume > poc.volume) {
      poc = l;
    }
  }

  const target = totalLevelVolume * 0.7;

  let vah = poc;
  let val = poc;

  if (poc && levels.length) {
    const ordered = [...levels].sort(
      (a, b) => a.price - b.price
    );

    let index = ordered.findIndex(
      x => x.price === poc.price
    );

    if (index < 0) index = 0;

    let accumulated = ordered[index].volume;

    let lo = index;
    let hi = index;

    while (
      accumulated < target &&
      (lo > 0 || hi < ordered.length - 1)
    ) {
      const left = lo > 0
        ? ordered[lo - 1].volume
        : -1;

      const right = hi < ordered.length - 1
        ? ordered[hi + 1].volume
        : -1;

      if (right >= left && hi < ordered.length - 1) {
        hi++;
        accumulated += ordered[hi].volume;
      } else if (lo > 0) {
        lo--;
        accumulated += ordered[lo].volume;
      } else {
        break;
      }
    }

    val = ordered[lo];
    vah = ordered[hi];
  }

  const sortedVolume = [...levels]
    .sort((a, b) => b.volume - a.volume);

  const hvn = sortedVolume
    .slice(0, Math.min(5, sortedVolume.length));

  const lvn = [...levels]
    .sort((a, b) => a.volume - b.volume)
    .slice(0, Math.min(5, levels.length));

  let maxPositiveDelta = null;
  let maxNegativeDelta = null;

  for (const l of levels) {
    if (
      !maxPositiveDelta ||
      l.delta > maxPositiveDelta.delta
    ) {
      maxPositiveDelta = l;
    }

    if (
      !maxNegativeDelta ||
      l.delta < maxNegativeDelta.delta
    ) {
      maxNegativeDelta = l;
    }
  }

  const stackedBuy = [];
  const stackedSell = [];

  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];

    const buy = l.bid;
    const sell = l.ask;

    if (sell > 0 && buy / sell >= 3) {
      stackedBuy.push(l.price);
    }

    if (buy > 0 && sell / buy >= 3) {
      stackedSell.push(l.price);
    }
  }

  const absorption = [];

  for (const l of levels) {
    const opposite =
      l.side === "buy"
        ? l.ask
        : l.bid;

    const imbalance =
      l.ask > 0
        ? l.bid / l.ask
        : l.bid > 0
          ? 999
          : 0;

    if (
      l.volume > 0 &&
      (
        (l.bid > 0 && l.ask > 0 && (
          imbalance >= 3 ||
          imbalance <= 1 / 3
        )) ||
        l.largeBuy > 0 ||
        l.largeSell > 0
      )
    ) {
      absorption.push({
        price: l.price,
        bid: l.bid,
        ask: l.ask,
        delta: l.delta,
        volume: l.volume,
        imbalance
      });
    }
  }

  const pressure =
    stats.deltaPercent >= 10
      ? "BUY_PRESSURE"
      : stats.deltaPercent <= -10
        ? "SELL_PRESSURE"
        : "BALANCED";

  return {
    step,
    levels,
    stats,
    poc,
    vah,
    val,
    hvn,
    lvn,
    maxPositiveDelta,
    maxNegativeDelta,
    stackedBuy,
    stackedSell,
    absorption,
    pressure,
    candle: candle || null,
    tradeCount: trades.length
  };
}

function buildOrderbookAnalysis(book) {
  const buyLiquidity = book.bids.reduce(
    (s, x) => s + x.qty,
    0
  );

  const sellLiquidity = book.asks.reduce(
    (s, x) => s + x.qty,
    0
  );

  const totalLiquidity =
    buyLiquidity + sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? buyLiquidity / totalLiquidity * 100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? sellLiquidity / totalLiquidity * 100
      : 0;

  const bidMedian = median(
    book.bids.map(x => x.qty)
  );

  const askMedian = median(
    book.asks.map(x => x.qty)
  );

  const buyWallThreshold =
    bidMedian > 0 ? bidMedian * 4 : 0;

  const sellWallThreshold =
    askMedian > 0 ? askMedian * 4 : 0;

  const buyWalls = book.bids
    .filter(x =>
      buyWallThreshold > 0 &&
      x.qty >= buyWallThreshold
    )
    .map(x => ({
      ...x,
      multiple: x.qty / bidMedian
    }));

  const sellWalls = book.asks
    .filter(x =>
      sellWallThreshold > 0 &&
      x.qty >= sellWallThreshold
    )
    .map(x => ({
      ...x,
      multiple: x.qty / askMedian
    }));

  const pressure =
    buyShare > sellShare + 8
      ? "BUY_PRESSURE"
      : sellShare > buyShare + 8
        ? "SELL_PRESSURE"
        : "BALANCED";

  return {
    ...book,
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    pressure,
    buyWalls,
    sellWalls,
    spread:
      book.bestAsk > 0 &&
      book.bestBid > 0
        ? book.bestAsk - book.bestBid
        : 0,
    spreadPercent:
      book.bestAsk > 0 &&
      book.bestBid > 0
        ? (
            (book.bestAsk - book.bestBid) /
            book.bestBid
          ) * 100
        : 0
  };
}

function median(values) {
  if (!values.length) return 0;

  const a = [...values]
    .filter(Number.isFinite)
    .sort((x, y) => x - y);

  if (!a.length) return 0;

  const m = Math.floor(a.length / 2);

  return a.length % 2
    ? a[m]
    : (a[m - 1] + a[m]) / 2;
}

function candleFromTrades(
  trades,
  start,
  end
) {
  const list = trades.filter(
    t => t.time >= start && t.time < end
  );

  if (!list.length) return null;

  const prices = list.map(t => t.price);

  return {
    time: start,
    open: list[0].price,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: list[list.length - 1].price,
    volume: list.reduce(
      (s, x) => s + x.qty,
      0
    ),
    turnover: list.reduce(
      (s, x) => s + x.value,
      0
    )
  };
}

async function marketData(
  category,
  symbol,
  interval
) {
  const [instrument, candles, book, ticker, trades] =
    await Promise.all([
      getInstruments(category, symbol),
      getKlines(category, symbol, interval, 300),
      getOrderbook(category, symbol, 50),
      getTicker(category, symbol),
      getRecentTrades(category, symbol, 1000)
    ]);

  const orderbook = buildOrderbookAnalysis(book);

  const stats = buildTradeStats(trades);

  const latestCandle =
    candles[candles.length - 1] || null;

  return {
    ok: true,
    version: VERSION,
    serverTime: Date.now(),
    category,
    symbol,
    interval: normalizeInterval(interval),
    instrument,
    candles,
    trades,
    tradeStats: stats,
    orderbook,
    ticker,
    latestCandle
  };
}

async function footprintData(
  category,
  symbol,
  interval,
  candleTime
) {
  const [instrument, candles, trades] =
    await Promise.all([
      getInstruments(category, symbol),
      getKlines(category, symbol, interval, 1000),
      getRecentTrades(category, symbol, 1000)
    ]);

  const ms = intervalMs(interval);

  let selectedTime = num(candleTime, 0);

  if (!selectedTime) {
    selectedTime =
      candles[candles.length - 1]?.time || 0;
  }

  const candle =
    candles.find(
      x => x.time === selectedTime
    ) ||
    candleFromTrades(
      trades,
      selectedTime,
      selectedTime + ms
    );

  const selectedTrades = trades.filter(
    t =>
      t.time >= selectedTime &&
      t.time < selectedTime + ms
  );

  const footprint = buildFootprint(
    selectedTrades,
    candle,
    instrument
  );

  return {
    ok: true,
    version: VERSION,
    category,
    symbol,
    interval: normalizeInterval(interval),
    candleTime: selectedTime,
    candle,
    trades: selectedTrades,
    footprint
  };
}

async function scanAnalyze(
  category,
  symbol,
  interval
) {
  const data = await marketData(
    category,
    symbol,
    interval
  );

  const candles = data.candles;

  if (!candles.length) {
    return {
      ...data,
      analysis: {
        state: "NO_DATA",
        score: 0
      }
    };
  }

  const last = candles[candles.length - 1];

  const previous =
    candles[candles.length - 2] || last;

  const change =
    previous.close > 0
      ? (
          (last.close - previous.close) /
          previous.close
        ) * 100
      : 0;

  const flow = data.tradeStats;

  let score = 50;

  if (flow.deltaPercent >= 10) {
    score += 20;
  } else if (flow.deltaPercent <= -10) {
    score -= 20;
  }

  if (
    data.orderbook.buyShare >
    data.orderbook.sellShare + 8
  ) {
    score += 15;
  }

  if (
    data.orderbook.sellShare >
    data.orderbook.buyShare + 8
  ) {
    score -= 15;
  }

  if (change > 0) score += 5;
  if (change < 0) score -= 5;

  score = clamp(score, 0, 100);

  const state =
    score >= 70
      ? "BUY"
      : score <= 30
        ? "SELL"
        : "NEUTRAL";

  return {
    ...data,
    analysis: {
      state,
      score,
      priceChange: change,
      deltaPercent: flow.deltaPercent,
      cvd: flow.cvd,
      buyShare: data.orderbook.buyShare,
      sellShare: data.orderbook.sellShare
    }
  };
}

function routeInfo(url) {
  return {
    path: url.pathname,
    category: normalizeCategory(
      url.searchParams.get("category")
    ),
    symbol: normalizeSymbol(
      url.searchParams.get("symbol")
    ),
    interval: normalizeInterval(
      url.searchParams.get("interval")
    )
  };
}

export class CollectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    const existing =
      await this.state.storage.get("trades");

    if (!Array.isArray(existing)) {
      await this.state.storage.put(
        "trades",
        []
      );
    }

    this.initialized = true;
  }

  async fetch(request) {
    await this.init();

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: CORS
      });
    }

    if (url.pathname === "/clear") {
      await this.state.storage.put(
        "trades",
        []
      );

      return json({
        ok: true,
        cleared: true
      });
    }

    if (url.pathname === "/trades") {
      const trades =
        await this.state.storage.get("trades") || [];

      return json({
        ok: true,
        count: trades.length,
        trades
      });
    }

    if (
      url.pathname === "/add" &&
      request.method === "POST"
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return errorJson(
          "JSON نامعتبر",
          400
        );
      }

      const incoming =
        Array.isArray(body)
          ? body
          : [body];

      const old =
        await this.state.storage.get("trades") || [];

      const map = new Map();

      for (const t of old) {
        if (t?.id) {
          map.set(String(t.id), t);
        }
      }

      for (const t of incoming) {
        if (!t) continue;

        const id =
          String(
            t.id ||
            `${t.time}-${t.price}-${t.qty}-${t.side}`
          );

        map.set(id, {
          id,
          time: num(t.time),
          price: num(t.price),
          qty: num(t.qty),
          side: t.side === "sell"
            ? "sell"
            : "buy",
          isBlock: Boolean(t.isBlock),
          value:
            num(t.value) ||
            num(t.price) * num(t.qty)
        });
      }

      const cutoff =
        Date.now() -
        24 * 60 * 60 * 1000;

      const result = [...map.values()]
        .filter(x => x.time >= cutoff)
        .sort((a, b) => a.time - b.time)
        .slice(-200000);

      await this.state.storage.put(
        "trades",
        result
      );

      return json({
        ok: true,
        count: result.length
      });
    }

    return errorJson(
      "CollectorDO route not found",
      404
    );
  }
}

async function assetResponse(request, env) {
  if (
    env &&
    env.ASSETS &&
    typeof env.ASSETS.fetch === "function"
  ) {
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return errorJson(
        "خطا در سرویس فایل‌های سایت: " +
        e.message,
        500
      );
    }
  }

  return errorJson(
    "ASSETS binding پیدا نشد.",
    500
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: CORS
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          version: VERSION,
          service: "Absorption Zone Scanner",
          bybit: true,
          time: Date.now()
        });
      }

      if (url.pathname === "/api/market") {
        const r = routeInfo(url);

        return json(
          await marketData(
            r.category,
            r.symbol,
            r.interval
          )
        );
      }

      if (url.pathname === "/api/trades") {
        const r = routeInfo(url);

        const trades =
          await getRecentTrades(
            r.category,
            r.symbol,
            1000
          );

        return json({
          ok: true,
          version: VERSION,
          category: r.category,
          symbol: r.symbol,
          trades,
          stats: buildTradeStats(trades)
        });
      }

      if (url.pathname === "/api/orderbook") {
        const r = routeInfo(url);

        const book =
          await getOrderbook(
            r.category,
            r.symbol,
            50
          );

        return json({
          ok: true,
          version: VERSION,
          category: r.category,
          symbol: r.symbol,
          orderbook:
            buildOrderbookAnalysis(book)
        });
      }

      if (url.pathname === "/api/footprint") {
        const r = routeInfo(url);

        return json(
          await footprintData(
            r.category,
            r.symbol,
            r.interval,
            url.searchParams.get("candleTime")
          )
        );
      }

      if (url.pathname === "/api/analyze") {
        const r = routeInfo(url);

        return json(
          await scanAnalyze(
            r.category,
            r.symbol,
            r.interval
          )
        );
      }

      return assetResponse(request, env);

    } catch (e) {
      return errorJson(
        e?.message || "خطای نامشخص Worker",
        500,
        {
          path: url.pathname,
          time: Date.now()
        }
      );
    }
  }
};
