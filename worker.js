import { DurableObject } from "cloudflare:workers";

const BYBIT_API = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "BYBIT-SMART-MONEY-ORDER-FLOW-V6";

const ORDERBOOK_DEPTH = 50;
const RETENTION_MINUTES = 24 * 60;
const SNAPSHOT_MS = 5000;
const MINUTE_MS = 60 * 1000;
const TRADE_LIMIT = 1000;

const MAX_SYMBOLS = 1000;
const WS_SUB_CHUNK = 200;

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "*"
    }
  });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "*");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}

function err(message, status = 500, extra = {}) {
  return json({
    ok: false,
    error: String(message),
    ...extra
  }, status);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeSymbol(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "");
}

function minuteTs(ts = Date.now()) {
  return Math.floor(num(ts) / MINUTE_MS) * MINUTE_MS;
}

function emptyMinute(symbol, ts) {
  return {
    symbol,
    ts,
    levels: {},

    buyVolume: 0,
    sellVolume: 0,

    buyValue: 0,
    sellValue: 0,

    buyTrades: 0,
    sellTrades: 0,

    totalVolume: 0,
    totalValue: 0,

    delta: 0,

    orderbook: {
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 0,
      bidLiquidity: 0,
      askLiquidity: 0
    },

    liquidations: {
      buy: 0,
      sell: 0,
      count: 0
    },

    blocks: []
  };
}

function ensureLevel(m, price) {
  const p = String(price);

  if (!m.levels[p]) {
    m.levels[p] = {
      price: num(price),

      bidVolume: 0,
      askVolume: 0,

      bidValue: 0,
      askValue: 0,

      bidTrades: 0,
      askTrades: 0,

      delta: 0
    };
  }

  return m.levels[p];
}

function addTrade(m, trade) {
  if (!m || !trade) return;

  const price = num(trade.price);
  const size = num(trade.size);

  if (!price || !size) return;

  const value = price * size;
  const side = String(trade.side || "").toLowerCase();

  const l = ensureLevel(m, price);

  /*
    Bybit:
    Buy  = aggressive buyer = ASK / BUY
    Sell = aggressive seller = BID / SELL
  */

  if (side === "buy") {
    l.askVolume += size;
    l.askValue += value;
    l.askTrades += 1;

    m.buyVolume += size;
    m.buyValue += value;
    m.buyTrades += 1;
  }

  if (side === "sell") {
    l.bidVolume += size;
    l.bidValue += value;
    l.bidTrades += 1;

    m.sellVolume += size;
    m.sellValue += value;
    m.sellTrades += 1;
  }

  m.totalVolume =
    m.buyVolume +
    m.sellVolume;

  m.totalValue =
    m.buyValue +
    m.sellValue;

  m.delta =
    m.buyVolume -
    m.sellVolume;

  l.delta =
    l.askVolume -
    l.bidVolume;
}

function aggregateFootprint(m) {
  if (!m) return null;

  const levels = Object.values(m.levels || {})
    .sort((a, b) => num(b.price) - num(a.price))
    .map(l => ({
      price: num(l.price),

      bidVolume: num(l.bidVolume),
      askVolume: num(l.askVolume),

      bidValue: num(l.bidValue),
      askValue: num(l.askValue),

      bidTrades: num(l.bidTrades),
      askTrades: num(l.askTrades),

      delta: num(l.delta),

      totalVolume:
        num(l.bidVolume) +
        num(l.askVolume)
    }));

  let open = 0;
  let high = 0;
  let low = 0;
  let close = 0;

  if (levels.length) {
    const prices = levels
      .map(x => num(x.price))
      .filter(Boolean);

    if (prices.length) {
      high = Math.max(...prices);
      low = Math.min(...prices);

      open = prices[prices.length - 1];
      close = prices[0];
    }
  }

  const bestBid =
    num(m.orderbook?.bestBid);

  const bestAsk =
    num(m.orderbook?.bestAsk);

  if (!open) {
    open = bestBid || bestAsk;
  }

  if (!close) {
    close = bestBid || bestAsk;
  }

  if (!high) {
    high = Math.max(bestAsk, bestBid);
  }

  if (!low) {
    low = Math.min(
      bestBid || Infinity,
      bestAsk || Infinity
    );

    if (!Number.isFinite(low)) {
      low = 0;
    }
  }

  return {
    time: num(m.ts),
    ts: num(m.ts),

    symbol: m.symbol,

    open,
    high,
    low,
    close,

    bidVolume: num(m.sellVolume),
    askVolume: num(m.buyVolume),

    sellVolume: num(m.sellVolume),
    buyVolume: num(m.buyVolume),

    bidValue: num(m.sellValue),
    askValue: num(m.buyValue),

    delta: num(m.delta),

    totalVolume: num(m.totalVolume),
    totalValue: num(m.totalValue),

    buyTrades: num(m.buyTrades),
    sellTrades: num(m.sellTrades),

    trades:
      num(m.buyTrades) +
      num(m.sellTrades),

    levels,

    orderbook: {
      bids: m.orderbook?.bids || [],
      asks: m.orderbook?.asks || [],

      bestBid,
      bestAsk,

      bidLiquidity:
        num(m.orderbook?.bidLiquidity),

      askLiquidity:
        num(m.orderbook?.askLiquidity)
    },

    liquidations:
      m.liquidations || {
        buy: 0,
        sell: 0,
        count: 0
      },

    blocks: Array.isArray(m.blocks)
      ? m.blocks
      : []
  };
}

function aggregateCandles(klines, intervalMinutes) {
  if (!Array.isArray(klines)) {
    return [];
  }

  const n = Number(intervalMinutes);

  if (!n || n <= 0) {
    return [];
  }

  const sorted = klines
    .map(k => ({
      ts: num(k[0]),
      open: num(k[1]),
      high: num(k[2]),
      low: num(k[3]),
      close: num(k[4]),
      volume: num(k[5]),
      turnover: num(k[6])
    }))
    .filter(k =>
      k.ts &&
      k.open &&
      k.high &&
      k.low &&
      k.close
    )
    .sort((a, b) => a.ts - b.ts);

  const bucketMs =
    n * MINUTE_MS;

  const map = new Map();

  for (const k of sorted) {
    const bucket =
      Math.floor(k.ts / bucketMs) *
      bucketMs;

    if (!map.has(bucket)) {
      map.set(bucket, {
        time: bucket,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        turnover: k.turnover
      });
    } else {
      const c = map.get(bucket);

      c.high =
        Math.max(c.high, k.high);

      c.low =
        Math.min(c.low, k.low);

      c.close = k.close;

      c.volume += k.volume;
      c.turnover += k.turnover;
    }
  }

  return Array.from(map.values())
    .sort((a, b) => a.time - b.time);
}

async function bybit(path, params = {}) {
  const u =
    new URL(BYBIT_API + path);

  for (const [k, v] of Object.entries(params)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== ""
    ) {
      u.searchParams.set(
        k,
        String(v)
      );
    }
  }

  const r = await fetch(
    u.toString(),
    {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    }
  );

  const text = await r.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Bybit HTTP ${r.status}: ${text.slice(0, 300)}`
    );
  }

  if (!r.ok) {
    throw new Error(
      `Bybit HTTP ${r.status}: ${
        data?.retMsg || "request failed"
      }`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      `Bybit ${data.retCode}: ${
        data.retMsg || "API error"
      }`
    );
  }

  return data;
}

async function getKlines(
  symbol,
  interval = "1",
  limit = 200
) {
  const data = await bybit(
    "/v5/market/kline",
    {
      category: "linear",
      symbol,
      interval,
      limit
    }
  );

  return data?.result?.list || [];
}

async function getTicker(symbol) {
  const data = await bybit(
    "/v5/market/tickers",
    {
      category: "linear",
      symbol
    }
  );

  return data?.result?.list?.[0] || null;
}

async function getOrderbook(symbol) {
  const data = await bybit(
    "/v5/market/orderbook",
    {
      category: "linear",
      symbol,
      limit: ORDERBOOK_DEPTH
    }
  );

  const r =
    data?.result || {};

  const bids =
    (r.b || [])
      .map(x => ({
        price: num(x[0]),
        size: num(x[1]),
        value:
          num(x[0]) *
          num(x[1])
      }));

  const asks =
    (r.a || [])
      .map(x => ({
        price: num(x[0]),
        size: num(x[1]),
        value:
          num(x[0]) *
          num(x[1])
      }));

  return {
    bids,
    asks,

    bestBid:
      num(r.b?.[0]?.[0]),

    bestAsk:
      num(r.a?.[0]?.[0]),

    bidLiquidity:
      bids.reduce(
        (a, x) => a + num(x.value),
        0
      ),

    askLiquidity:
      asks.reduce(
        (a, x) => a + num(x.value),
        0
      )
  };
}

async function getRecentTrades(symbol) {
  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category: "linear",
      symbol,
      limit: TRADE_LIMIT
    }
  );

  return (
    data?.result?.list || []
  ).map(t => ({
    id:
      t.execId ||
      t.id ||
      "",

    time: num(t.time),

    price: num(t.price),

    size: num(t.size),

    side: t.side || "",

    isBlockTrade:
      !!t.isBlockTrade
  }));
}

function buildFootprintFromTrades(
  symbol,
  trades,
  ts = Date.now()
) {
  const m =
    emptyMinute(
      symbol,
      minuteTs(ts)
    );

  for (const t of trades || []) {
    const tradeMinute =
      minuteTs(
        num(t.time) || ts
      );

    /*
      Only keep trades belonging to
      their actual minute.
    */
    if (tradeMinute !== m.ts) {
      continue;
    }

    addTrade(
      m,
      {
        price: t.price,
        size: t.size,
        side: t.side
      }
    );
  }

  return aggregateFootprint(m);
}

function mergeLiveFootprint(
  footprint,
  orderbook
) {
  if (!footprint) {
    return null;
  }

  footprint.orderbook = {
    bids:
      orderbook?.bids || [],

    asks:
      orderbook?.asks || [],

    bestBid:
      num(orderbook?.bestBid),

    bestAsk:
      num(orderbook?.bestAsk),

    bidLiquidity:
      num(orderbook?.bidLiquidity),

    askLiquidity:
      num(orderbook?.askLiquidity)
  };

  return footprint;
}

function calculateIndicators(candles) {
  const closes =
    (candles || [])
      .map(x => num(x.close))
      .filter(Boolean);

  function sma(arr, n) {
    if (arr.length < n) {
      return null;
    }

    let s = 0;

    for (
      let i = arr.length - n;
      i < arr.length;
      i++
    ) {
      s += arr[i];
    }

    return s / n;
  }

  function ema(arr, n) {
    if (arr.length < n) {
      return null;
    }

    const k =
      2 / (n + 1);

    let e =
      sma(
        arr.slice(0, n),
        n
      );

    if (e === null) {
      return null;
    }

    for (
      let i = n;
      i < arr.length;
      i++
    ) {
      e =
        arr[i] * k +
        e * (1 - k);
    }

    return e;
  }

  function rsi(arr, n = 14) {
    if (arr.length <= n) {
      return null;
    }

    let gain = 0;
    let loss = 0;

    for (
      let i = 1;
      i <= n;
      i++
    ) {
      const d =
        arr[i] -
        arr[i - 1];

      if (d >= 0) {
        gain += d;
      } else {
        loss -= d;
      }
    }

    let avgGain =
      gain / n;

    let avgLoss =
      loss / n;

    for (
      let i = n + 1;
      i < arr.length;
      i++
    ) {
      const d =
        arr[i] -
        arr[i - 1];

      const g =
        d > 0 ? d : 0;

      const l =
        d < 0 ? -d : 0;

      avgGain =
        ((avgGain * (n - 1)) + g) /
        n;

      avgLoss =
        ((avgLoss * (n - 1)) + l) /
        n;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs =
      avgGain / avgLoss;

    return (
      100 -
      100 / (1 + rs)
    );
  }

  const last =
    closes[closes.length - 1] || 0;

  const ma20 =
    sma(closes, 20);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const r =
    rsi(closes, 14);

  let trend =
    "NEUTRAL";

  if (
    ema20 !== null &&
    ema50 !== null
  ) {
    if (ema20 > ema50) {
      trend = "BULLISH";
    }

    if (ema20 < ema50) {
      trend = "BEARISH";
    }
  }

  return {
    price: last,
    ma20,
    ema20,
    ema50,
    rsi: r,
    trend
  };
}

function calculateSignal(
  ind,
  footprint,
  orderbook
) {
  let score = 50;

  const reasons = [];

  const delta =
    num(footprint?.delta);

  const volume =
    num(footprint?.totalVolume);

  if (delta > 0) {
    score += 15;
    reasons.push("Delta مثبت");
  } else if (delta < 0) {
    score -= 15;
    reasons.push("Delta منفی");
  }

  if (ind.trend === "BULLISH") {
    score += 15;
    reasons.push("روند EMA صعودی");
  } else if (
    ind.trend === "BEARISH"
  ) {
    score -= 15;
    reasons.push("روند EMA نزولی");
  }

  if (ind.rsi !== null) {
    if (ind.rsi >= 55) {
      score += 5;
      reasons.push("RSI بالای 55");
    }

    if (ind.rsi <= 45) {
      score -= 5;
      reasons.push("RSI زیر 45");
    }
  }

  const bidL =
    num(orderbook?.bidLiquidity);

  const askL =
    num(orderbook?.askLiquidity);

  if (
    bidL > askL * 1.08
  ) {
    score += 10;
    reasons.push(
      "نقدینگی Bid بیشتر"
    );
  } else if (
    askL > bidL * 1.08
  ) {
    score -= 10;
    reasons.push(
      "نقدینگی Ask بیشتر"
    );
  }

  if (volume > 0) {
    const deltaPct =
      Math.abs(
        delta / volume
      ) * 100;

    if (deltaPct >= 10) {
      score +=
        delta > 0 ? 5 : -5;

      reasons.push(
        `Delta ${deltaPct.toFixed(1)}%`
      );
    }
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(score)
      )
    );

  let signal =
    "NEUTRAL";

  if (score >= 65) {
    signal = "BUY";
  }

  if (score <= 35) {
    signal = "SELL";
  }

  return {
    signal,
    score,
    reasons
  };
}

async function collectorJSON(
  stub,
  path,
  options = {}
) {
  const base =
    "https://collector.internal";

  const u =
    new URL(
      path,
      base
    );

  const request =
    new Request(
      u.toString(),
      {
        method:
          options.method || "GET",

        headers:
          options.headers || {},

        body:
          options.body
      }
    );

  const r =
    await stub.fetch(request);

  const text =
    await r.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Collector HTTP ${r.status}: ${text.slice(0, 500)}`
    );
  }

  if (
    !r.ok ||
    data?.ok === false
  ) {
    throw new Error(
      data?.error ||
      `Collector HTTP ${r.status}`
    );
  }

  return data;
}

async function ensureCollector(
  stub,
  symbol
) {
  try {
    const status =
      await collectorJSON(
        stub,
        "/status"
      );

    if (
      status.started &&
      num(status.symbols) > 0
    ) {
      return status;
    }
  } catch {}

  const init =
    await collectorJSON(
      stub,
      "/init",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            symbols: [
              symbol
            ]
          })
      }
    );

  return init;
}

async function analyzeSymbol(
  symbol,
  interval,
  stub
) {
  symbol =
    safeSymbol(symbol);

  interval =
    String(interval || "1");

  if (!symbol) {
    throw new Error(
      "Symbol is required"
    );
  }

  await ensureCollector(
    stub,
    symbol
  );

  const [
    k1,
    ticker,
    orderbook,
    trades,
    collector
  ] =
    await Promise.all([
      getKlines(
        symbol,
        "1",
        200
      ),

      getTicker(
        symbol
      ),

      getOrderbook(
        symbol
      ),

      getRecentTrades(
        symbol
      ),

      collectorJSON(
        stub,
        `/history-footprint?symbol=${encodeURIComponent(symbol)}&hours=24`
      )
    ]);

  const minuteCandles =
    k1
      .slice()
      .reverse()
      .map(k => ({
        time: num(k[0]),
        open: num(k[1]),
        high: num(k[2]),
        low: num(k[3]),
        close: num(k[4]),
        volume: num(k[5]),
        turnover: num(k[6])
      }));

  let candles =
    minuteCandles;

  if (
    ["3", "5", "15", "30", "60"]
      .includes(interval)
  ) {
    candles =
      aggregateCandles(
        k1,
        Number(interval)
      );
  }

  let footprints =
    Array.isArray(
      collector?.footprints
    )
      ? collector.footprints
      : [];

  /*
    Rebuild current minute from REST trades.
    This is used only as live/current-minute
    confirmation and does not overwrite older
    collector history.
  */

  const recentFootprint =
    buildFootprintFromTrades(
      symbol,
      trades,
      Date.now()
    );

  const storedLatest =
    footprints.length
      ? footprints[
          footprints.length - 1
        ]
      : null;

  if (
    !storedLatest ||
    num(storedLatest.time) !==
      num(recentFootprint.time)
  ) {
    footprints = [
      ...footprints,
      recentFootprint
    ];
  } else {
    footprints[
      footprints.length - 1
    ] = {
      ...storedLatest,
      ...recentFootprint,
      levels:
        recentFootprint.levels
    };
  }

  footprints =
    footprints
      .filter(Boolean)
      .sort(
        (a, b) =>
          num(a.time) -
          num(b.time)
      )
      .slice(-2000);

  const liveFootprint =
    mergeLiveFootprint(
      recentFootprint,
      orderbook
    );

  const indicators =
    calculateIndicators(
      minuteCandles.length
        ? minuteCandles
        : candles
    );

  const signal =
    calculateSignal(
      indicators,
      liveFootprint,
      orderbook
    );

  return {
    ok: true,

    version: VERSION,

    symbol,

    interval,

    serverTime:
      Date.now(),

    ticker: {
      lastPrice:
        num(ticker?.lastPrice),

      markPrice:
        num(ticker?.markPrice),

      indexPrice:
        num(ticker?.indexPrice),

      volume24h:
        num(ticker?.volume24h),

      turnover24h:
        num(ticker?.turnover24h),

      price24hPcnt:
        num(ticker?.price24hPcnt)
    },

    candles,

    footprints,

    liveFootprint,

    footprint:
      liveFootprint,

    trades,

    orderbook,

    currentFlow:
      liveFootprint,

    indicators,

    signal
  };
}

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

          headers: {
            "access-control-allow-origin":
              "*",

            "access-control-allow-methods":
              "GET,POST,OPTIONS",

            "access-control-allow-headers":
              "*"
          }
        }
      );
    }

    try {
      const url =
        new URL(
          request.url
        );

      const path =
        url.pathname;

      if (!env.COLLECTOR) {
        return err(
          "COLLECTOR Durable Object binding is missing",
          500
        );
      }

      const id =
        env.COLLECTOR.idFromName(
          "BYBIT-SMART-MONEY-COLLECTOR"
        );

      const stub =
        env.COLLECTOR.get(id);

      if (
        path ===
        "/api/test-bybit"
      ) {
        const server =
          await bybit(
            "/v5/market/time"
          );

        return cors(
          json({
            ok: true,
            connected: true,

            bybit: {
              retCode:
                server.retCode,

              retMsg:
                server.retMsg,

              timeSecond:
                server.result?.timeSecond,

              timeNano:
                server.result?.timeNano
            }
          })
        );
      }

      if (
        path ===
        "/api/health"
      ) {
        const d =
          await collectorJSON(
            stub,
            "/status"
          );

        return cors(
          json({
            ok: true,
            version: VERSION,
            bybit: true,
            collector: d,
            d1: true
          })
        );
      }

      if (
        path ===
        "/api/status"
      ) {
        const d =
          await collectorJSON(
            stub,
            "/status"
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/init"
      ) {
        const body =
          await request
            .json()
            .catch(
              () => ({})
            );

        let symbols =
          Array.isArray(
            body.symbols
          )
            ? body.symbols
            : [];

        symbols =
          symbols
            .map(safeSymbol)
            .filter(Boolean);

        if (!symbols.length) {
          symbols = [
            "BTCUSDT"
          ];
        }

        const r =
          await collectorJSON(
            stub,
            "/init",
            {
              method: "POST",

              headers: {
                "content-type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  symbols
                })
            }
          );

        return cors(
          json(r)
        );
      }

      if (
        path ===
        "/api/symbols"
      ) {
        const d =
          await collectorJSON(
            stub,
            "/symbols"
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/history-footprint"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        const hours =
          Math.max(
            1,
            Math.min(
              24,
              Number(
                url.searchParams.get(
                  "hours"
                ) || 24
              )
            )
          );

        await ensureCollector(
          stub,
          symbol
        );

        const d =
          await collectorJSON(
            stub,
            `/history-footprint?symbol=${encodeURIComponent(symbol)}&hours=${hours}`
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/latest"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        await ensureCollector(
          stub,
          symbol
        );

        const d =
          await collectorJSON(
            stub,
            `/latest?symbol=${encodeURIComponent(symbol)}`
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/analyze"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) ||
          "1";

        const d =
          await analyzeSymbol(
            symbol,
            interval,
            stub
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/live"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) ||
          "1";

        const d =
          await analyzeSymbol(
            symbol,
            interval,
            stub
          );

        return cors(
          json({
            ok: true,
            version: VERSION,
            symbol,
            interval,
            time: Date.now(),

            footprint:
              d.liveFootprint,

            liveFootprint:
              d.liveFootprint,

            currentFlow:
              d.liveFootprint,

            orderbook:
              d.orderbook,

            trades:
              d.trades,

            ticker:
              d.ticker,

            signal:
              d.signal
          })
        );
      }

      if (
        path ===
        "/api/collect"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        await ensureCollector(
          stub,
          symbol
        );

        const d =
          await collectorJSON(
            stub,
            `/collect?symbol=${encodeURIComponent(symbol)}`
          );

        return cors(
          json(d)
        );
      }

      if (
        path ===
        "/api/scan"
      ) {
        let symbols = [];

        try {
          const s =
            await bybit(
              "/v5/market/instruments-info",
              {
                category:
                  "linear",

                status:
                  "Trading",

                limit:
                  1000
              }
            );

          symbols =
            (
              s?.result?.list ||
              []
            )
              .map(
                x => x.symbol
              )
              .filter(Boolean)
              .slice(
                0,
                100
              );

        } catch {
          symbols = [
            "BTCUSDT",
            "ETHUSDT",
            "SOLUSDT",
            "XRPUSDT",
            "DOGEUSDT",
            "BNBUSDT",
            "ADAUSDT",
            "AVAXUSDT",
            "LINKUSDT",
            "SUIUSDT"
          ];
        }

        const results = [];

        for (
          const symbol of symbols
        ) {
          try {
            const d =
              await analyzeSymbol(
                symbol,
                "1",
                stub
              );

            results.push({
              symbol,

              price:
                d.ticker.lastPrice,

              signal:
                d.signal.signal,

              score:
                d.signal.score,

              delta:
                d.liveFootprint?.delta ||
                0,

              volume:
                d.liveFootprint?.totalVolume ||
                0,

              trend:
                d.indicators?.trend ||
                "NEUTRAL"
            });

          } catch (e) {
            results.push({
              symbol,

              error:
                String(
                  e.message || e
                )
            });
          }
        }

        results.sort(
          (a, b) =>
            num(b.score) -
            num(a.score)
        );

        return cors(
          json({
            ok: true,

            count:
              results.length,

            results
          })
        );
      }

      if (
        path.startsWith(
          "/api/"
        )
      ) {
        const target =
          new URL(
            request.url
          );

        target.pathname =
          path.replace(
            /^\/api/,
            ""
          ) || "/";

        return cors(
          await stub.fetch(
            new Request(
              target.toString(),
              request
            )
          )
        );
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(
          request
        );
      }

      return err(
        "Not Found",
        404
      );

    } catch (e) {
      console.error(
        "WORKER ERROR",
        e
      );

      return cors(
        err(
          e?.message ||
            String(e),
          502,
          {
            version:
              VERSION,

            stack:
              e?.stack
                ? String(
                    e.stack
                  ).slice(
                    0,
                    2000
                  )
                : undefined
          }
        )
      );
    }
  }
};


export class CollectorDO
  extends DurableObject {

  constructor(
    ctx,
    env
  ) {
    super(
      ctx,
      env
    );

    this.ctx = ctx;
    this.env = env;

    this.running = false;

    this.symbols = [];

    this.shards = [];

    this.minutes =
      new Map();

    this.lastTradeIds =
      new Map();

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS minutes (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(symbol, ts)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const saved =
      this.ctx.storage.sql
        .exec(
          `SELECT value FROM meta WHERE key = 'symbols' LIMIT 1`
        )
        .toArray();

    if (
      saved?.[0]?.value
    ) {
      try {
        this.symbols =
          JSON.parse(
            saved[0].value
          );
      } catch {
        this.symbols = [];
      }
    }
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {
      if (
        path === "/status"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          started:
            this.running,

          symbols:
            this.symbols.length,

          shards:
            this.shards.length,

          minutes:
            this.countMinutes()
        });
      }

      if (
        path === "/symbols"
      ) {
        return json({
          ok: true,
          symbols:
            this.symbols
        });
      }

      if (
        path === "/init"
      ) {
        let body = {};

        if (
          request.method ===
          "POST"
        ) {
          body =
            await request
              .json()
              .catch(
                () => ({})
              );
        }

        let symbols =
          Array.isArray(
            body.symbols
          )
            ? body.symbols
            : [];

        symbols =
          symbols
            .map(safeSymbol)
            .filter(Boolean);

        if (
          !symbols.length
        ) {
          symbols =
            await this.getDefaultSymbols();
        }

        symbols =
          [
            ...new Set(
              symbols
            )
          ].slice(
            0,
            MAX_SYMBOLS
          );

        await this.startCollector(
          symbols
        );

        return json({
          ok: true,

          started: true,

          symbols:
            this.symbols.length,

          shards:
            this.shards.length
        });
      }

      if (
        path ===
        "/history-footprint"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        const hours =
          Math.max(
            1,
            Math.min(
              24,
              Number(
                url.searchParams.get(
                  "hours"
                ) || 24
              )
            )
          );

        const footprints =
          this.getHistoryFootprint(
            symbol,
            hours
          );

        return json({
          ok: true,

          symbol,

          hours,

          footprints
        });
      }

      if (
        path === "/latest"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        const latest =
          this.getLatestFootprint(
            symbol
          );

        return json({
          ok: true,

          symbol,

          footprint:
            latest
        });
      }

      if (
        path === "/cleanup"
      ) {
        const removed =
          this.cleanup();

        return json({
          ok: true,
          removed
        });
      }

      if (
        path === "/collect"
      ) {
        const symbol =
          safeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            "BTCUSDT"
          );

        await this.collectSymbolREST(
          symbol
        );

        return json({
          ok: true,

          symbol,

          footprint:
            this.getLatestFootprint(
              symbol
            )
        });
      }

      return err(
        "Collector route not found",
        404
      );

    } catch (e) {
      console.error(
        "COLLECTOR ERROR",
        e
      );

      return err(
        e?.message ||
          String(e),
        500
      );
    }
  }

  countMinutes() {
    try {
      const r =
        this.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS c FROM minutes`
          )
          .toArray();

      return num(
        r?.[0]?.c
      );

    } catch {
      return 0;
    }
  }

  async getDefaultSymbols() {
    try {
      const data =
        await fetch(
          `${BYBIT_API}/v5/market/instruments-info?category=linear&status=Trading&limit=1000`
        );

      const j =
        await data.json();

      return (
        j?.result?.list ||
        []
      )
        .map(
          x => x.symbol
        )
        .filter(Boolean)
        .slice(
          0,
          MAX_SYMBOLS
        );

    } catch {
      return [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "DOGEUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "AVAXUSDT",
        "LINKUSDT",
        "SUIUSDT"
      ];
    }
  }

  async startCollector(
    symbols
  ) {
    symbols =
      [
        ...new Set(
          (symbols || [])
            .map(
              safeSymbol
            )
            .filter(Boolean)
        )
      ].slice(
        0,
        MAX_SYMBOLS
      );

    this.symbols =
      symbols;

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO meta(key,value) VALUES('symbols',?)`,
      JSON.stringify(
        this.symbols
      )
    );

    this.running =
      true;

    for (
      const ws of this.shards
    ) {
      try {
        ws.stop();
      } catch {}
    }

    this.shards = [];

    const chunks = [];

    for (
      let i = 0;
      i < this.symbols.length;
      i += WS_SUB_CHUNK
    ) {
      chunks.push(
        this.symbols.slice(
          i,
          i + WS_SUB_CHUNK
        )
      );
    }

    for (
      const chunk of chunks
    ) {
      const shard =
        new CollectorShard(
          this.ctx,
          this.env,
          this,
          chunk
        );

      this.shards.push(
        shard
      );

      this.ctx.waitUntil(
        shard.start()
      );
    }

    this.ctx.waitUntil(
      this.cleanupLoop()
    );
  }

  async cleanupLoop() {
    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          10000
        )
    );

    this.cleanup();
  }

  cleanup() {
    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
        MINUTE_MS;

    try {
      const r =
        this.ctx.storage.sql.exec(
          `DELETE FROM minutes WHERE ts < ?`,
          cutoff
        );

      return (
        r?.changes || 0
      );

    } catch {
      return 0;
    }
  }

  saveMinute(m) {
    if (
      !m ||
      !m.symbol ||
      !m.ts
    ) {
      return;
    }

    const data =
      JSON.stringify(m);

    this.ctx.storage.sql.exec(
      `
      INSERT OR REPLACE INTO minutes(symbol,ts,data)
      VALUES(?,?,?)
      `,
      m.symbol,
      m.ts,
      data
    );

    this.minutes.set(
      `${m.symbol}:${m.ts}`,
      m
    );
  }

  loadMinutes(
    symbol,
    hours
  ) {
    const cutoff =
      Date.now() -
      hours *
        60 *
        MINUTE_MS;

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT ts,data
          FROM minutes
          WHERE symbol = ?
          AND ts >= ?
          ORDER BY ts ASC
          `,
          symbol,
          cutoff
        )
        .toArray();

    return rows
      .map(row => {
        try {
          return JSON.parse(
            row.data
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  getCurrentMinute(
    symbol
  ) {
    const ts =
      minuteTs();

    const key =
      `${symbol}:${ts}`;

    const inMemory =
      this.minutes.get(
        key
      );

    if (inMemory) {
      return inMemory;
    }

    const rows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT data
          FROM minutes
          WHERE symbol = ?
          AND ts = ?
          LIMIT 1
          `,
          symbol,
          ts
        )
        .toArray();

    if (
      !rows.length
    ) {
      return null;
    }

    try {
      return JSON.parse(
        rows[0].data
      );
    } catch {
      return null;
    }
  }

  getHistoryFootprint(
    symbol,
    hours
  ) {
    const stored =
      this.loadMinutes(
        symbol,
        hours
      )
        .map(
          aggregateFootprint
        )
        .filter(Boolean);

    const current =
      this.getCurrentMinute(
        symbol
      );

    if (current) {
      const currentFp =
        aggregateFootprint(
          current
        );

      const idx =
        stored.findIndex(
          x =>
            num(x.time) ===
            num(
              currentFp.time
            )
        );

      if (idx >= 0) {
        stored[idx] =
          currentFp;
      } else {
        stored.push(
          currentFp
        );
      }
    }

    return stored
      .filter(Boolean)
      .sort(
        (a, b) =>
          num(a.time) -
          num(b.time)
      );
  }

  getLatestFootprint(
    symbol
  ) {
    const arr =
      this.getHistoryFootprint(
        symbol,
        24
      );

    return arr.length
      ? arr[arr.length - 1]
      : null;
  }

  async collectSymbolREST(
    symbol
  ) {
    try {
      const u =
        new URL(
          `${BYBIT_API}/v5/market/recent-trade`
        );

      u.searchParams.set(
        "category",
        "linear"
      );

      u.searchParams.set(
        "symbol",
        symbol
      );

      u.searchParams.set(
        "limit",
        "1000"
      );

      const r =
        await fetch(
          u.toString()
        );

      const data =
        await r.json();

      if (
        data.retCode !== 0
      ) {
        throw new Error(
          data.retMsg ||
          "Bybit error"
        );
      }

      const trades =
        data?.result?.list ||
        [];

      const grouped =
        new Map();

      for (
        const t of trades
      ) {
        const ts =
          minuteTs(
            num(t.time)
          );

        if (
          !grouped.has(ts)
        ) {
          grouped.set(
            ts,
            emptyMinute(
              symbol,
              ts
            )
          );
        }

        addTrade(
          grouped.get(ts),
          {
            price:
              num(t.price),

            size:
              num(t.size),

            side:
              t.side
          }
        );
      }

      for (
        const m of grouped.values()
      ) {
        this.saveMinute(m);
      }

      return true;

    } catch (e) {
      console.error(
        "REST COLLECT ERROR",
        symbol,
        e
      );

      return false;
    }
  }
}


class CollectorShard {

  constructor(
    ctx,
    env,
    owner,
    symbols
  ) {
    this.ctx = ctx;
    this.env = env;
    this.owner = owner;
    this.symbols = symbols;

    this.ws = null;

    this.connected =
      false;

    this.retry =
      RECONNECT_MIN_MS;

    this.lastSnapshot =
      0;

    this.minutes =
      new Map();

    this.books =
      new Map();

    this.reconnectScheduled =
      false;
  }

  async start() {
    await this.connect();
  }

  stop() {
    this.connected =
      false;

    this.reconnectScheduled =
      true;

    try {
      this.ws?.close();
    } catch {}

    this.ws = null;
  }

  async connect() {
    if (
      this.connected
    ) {
      return;
    }

    try {
      const response =
        await fetch(
          BYBIT_WS,
          {
            headers: {
              Upgrade:
                "websocket"
            }
          }
        );

      if (
        response.status !== 101 ||
        !response.webSocket
      ) {
        throw new Error(
          `WebSocket HTTP ${response.status}`
        );
      }

      this.ws =
        response.webSocket;

      this.ws.accept();

      this.connected =
        true;

      this.reconnectScheduled =
        false;

      this.retry =
        RECONNECT_MIN_MS;

      this.subscribe();

      this.ws.addEventListener(
        "message",
        event => {
          this.onMessage(
            event.data
          );
        }
      );

      this.ws.addEventListener(
        "close",
        () => {
          this.connected =
            false;

          this.reconnect();
        }
      );

      this.ws.addEventListener(
        "error",
        () => {
          this.connected =
            false;

          try {
            this.ws.close();
          } catch {}

          this.reconnect();
        }
      );

      this.ctx.waitUntil(
        this.heartbeat()
      );

      this.ctx.waitUntil(
        this.flushLoop()
      );

    } catch (e) {
      console.error(
        "WS CONNECT ERROR",
        e
      );

      this.connected =
        false;

      this.reconnect();
    }
  }

  subscribe() {
    if (!this.ws) {
      return;
    }

    const args = [];

    for (
      const symbol of this.symbols
    ) {
      args.push(
        `publicTrade.${symbol}`
      );

      args.push(
        `orderbook.50.${symbol}`
      );

      args.push(
        `allLiquidation.${symbol}`
      );
    }

    for (
      let i = 0;
      i < args.length;
      i += 200
    ) {
      const chunk =
        args.slice(
          i,
          i + 200
        );

      try {
        this.ws.send(
          JSON.stringify({
            op:
              "subscribe",

            args:
              chunk
          })
        );
      } catch {}
    }
  }

  async heartbeat() {
    while (
      this.connected &&
      this.ws
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            20000
          )
      );

      if (
        !this.connected ||
        !this.ws
      ) {
        break;
      }

      try {
        this.ws.send(
          JSON.stringify({
            op: "ping"
          })
        );
      } catch {
        break;
      }
    }
  }

  async reconnect() {
    if (
      this.reconnectScheduled
    ) {
      return;
    }

    this.reconnectScheduled =
      true;

    const wait =
      this.retry;

    this.retry =
      Math.min(
        RECONNECT_MAX_MS,
        this.retry * 2
      );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          wait
        )
    );

    this.reconnectScheduled =
      false;

    if (
      !this.connected
    ) {
      await this.connect();
    }
  }

  onMessage(raw) {
    let msg;

    try {
      msg =
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
      msg.op === "pong"
    ) {
      return;
    }

    if (
      msg.success === true &&
      !msg.topic
    ) {
      return;
    }

    const topic =
      String(
        msg.topic || ""
      );

    if (
      topic.startsWith(
        "publicTrade."
      )
    ) {
      this.handleTrades(
        msg
      );

      return;
    }

    if (
      topic.startsWith(
        "orderbook."
      )
    ) {
      this.handleOrderbook(
        msg
      );

      return;
    }

    if (
      topic.startsWith(
        "allLiquidation."
      )
    ) {
      this.handleLiquidation(
        msg
      );
    }
  }

  handleTrades(msg) {
    const topic =
      String(
        msg.topic || ""
      );

    const symbol =
      topic
        .split(".")
        .pop();

    const list =
      msg.data || [];

    if (!symbol) {
      return;
    }

    for (
      const t of list
    ) {
      const id =
        t.i ||
        t.execId ||
        `${t.T}:${t.p}:${t.v}:${t.S}`;

      const last =
        this.owner.lastTradeIds
          .get(symbol);

      if (
        last === id
      ) {
        continue;
      }

      this.owner.lastTradeIds
        .set(
          symbol,
          id
        );

      const price =
        num(t.p);

      const size =
        num(t.v);

      const side =
        t.S ||
        t.side ||
        "";

      if (
        !price ||
        !size
      ) {
        continue;
      }

      const m =
        this.getMinute(
          symbol,
          num(t.T) ||
          Date.now()
        );

      addTrade(
        m,
        {
          price,
          size,
          side
        }
      );
    }
  }

  handleOrderbook(msg) {
    const topic =
      String(
        msg.topic || ""
      );

    const symbol =
      topic
        .split(".")
        .pop();

    if (!symbol) {
      return;
    }

    const data =
      msg.data || {};

    const book =
      this.getBook(
        symbol
      );

    if (
      data.u !== undefined
    ) {
      book.updateId =
        num(data.u);
    }

    if (
      Array.isArray(
        data.b
      )
    ) {
      for (
        const row of data.b
      ) {
        const price =
          String(row[0]);

        const size =
          num(row[1]);

        if (!price) {
          continue;
        }

        if (size === 0) {
          book.bids.delete(
            price
          );
        } else {
          book.bids.set(
            price,
            size
          );
        }
      }
    }

    if (
      Array.isArray(
        data.a
      )
    ) {
      for (
        const row of data.a
      ) {
        const price =
          String(row[0]);

        const size =
          num(row[1]);

        if (!price) {
          continue;
        }

        if (size === 0) {
          book.asks.delete(
            price
          );
        } else {
          book.asks.set(
            price,
            size
          );
        }
      }
    }

    const bids =
      Array.from(
        book.bids.entries()
      )
        .map(
          ([price, size]) => ({
            price:
              num(price),

            size,

            value:
              num(price) *
              size
          })
        )
        .sort(
          (a, b) =>
            b.price -
            a.price
        )
        .slice(
          0,
          ORDERBOOK_DEPTH
        );

    const asks =
      Array.from(
        book.asks.entries()
      )
        .map(
          ([price, size]) => ({
            price:
              num(price),

            size,

            value:
              num(price) *
              size
          })
        )
        .sort(
          (a, b) =>
            a.price -
            b.price
        )
        .slice(
          0,
          ORDERBOOK_DEPTH
        );

    const m =
      this.getMinute(
        symbol
      );

    m.orderbook = {
      bids,
      asks,

      bestBid:
        bids[0]?.price ||
        0,

      bestAsk:
        asks[0]?.price ||
        0,

      bidLiquidity:
        bids.reduce(
          (a, x) =>
            a + num(x.value),
          0
        ),

      askLiquidity:
        asks.reduce(
          (a, x) =>
            a + num(x.value),
          0
        )
    };
  }

  getMinute(
    symbol,
    ts = Date.now()
  ) {
    const mt =
      minuteTs(ts);

    const key =
      `${symbol}:${mt}`;

    if (
      !this.minutes.has(
        key
      )
    ) {
      this.minutes.set(
        key,
        emptyMinute(
          symbol,
          mt
        )
      );
    }

    return this.minutes.get(
      key
    );
  }

  getBook(symbol) {
    if (
      !this.books.has(
        symbol
      )
    ) {
      this.books.set(
        symbol,
        {
          bids:
            new Map(),

          asks:
            new Map(),

          updateId:
            0
        }
      );
    }

    return this.books.get(
      symbol
    );
  }

  handleLiquidation(msg) {
    const topic =
      String(
        msg.topic || ""
      );

    const symbol =
      topic
        .split(".")
        .pop();

    if (!symbol) {
      return;
    }

    const list =
      Array.isArray(
        msg.data
      )
        ? msg.data
        : [msg.data];

    const m =
      this.getMinute(
        symbol
      );

    for (
      const x of list
    ) {
      if (!x) {
        continue;
      }

      const side =
        String(
          x.S ||
          x.side ||
          ""
        ).toLowerCase();

      const qty =
        num(
          x.v ||
          x.qty ||
          x.size
        );

      if (
        side === "buy"
      ) {
        m.liquidations.buy +=
          qty;
      }

      if (
        side === "sell"
      ) {
        m.liquidations.sell +=
          qty;
      }

      m.liquidations.count +=
        1;
    }
  }

  async flushLoop() {
    let lastMinute =
      minuteTs();

    while (
      this.connected
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            SNAPSHOT_MS
          )
      );

      if (
        !this.connected
      ) {
        break;
      }

      const current =
        minuteTs();

      for (
        const [
          key,
          m
        ] of this.minutes
      ) {
        if (
          m.ts < current
        ) {
          this.owner.saveMinute(
            m
          );

          this.minutes.delete(
            key
          );
        }
      }

      if (
        current !==
        lastMinute
      ) {
        lastMinute =
          current;
      }

      if (
        Date.now() -
        this.lastSnapshot >
        60000
      ) {
        this.owner.cleanup();

        this.lastSnapshot =
          Date.now();
      }
    }
  }
}
