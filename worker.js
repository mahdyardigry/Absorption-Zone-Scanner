import { DurableObject } from "cloudflare:workers";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "ABSORPTION-ORDERFLOW-MAP-V8";

const TF = "1";
const TF3 = "3";
const TF5 = "5";
const TF15 = "15";

const ALLOWED_INTERVALS = ["1", "3", "5", "15", "30", "60"];

const KLINE_LIMIT = 240;
const CHART_LIMIT = 180;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const FOOTPRINT_MAX_LEVELS = 80;
const HEATMAP_LEVELS = 50;

const RETENTION_MINUTES = 1440;
const ORDERBOOK_SNAPSHOT_MS = 5000;

const WS_RECONNECT_BASE = 2000;
const WS_RECONNECT_MAX = 30000;
const WS_SUB_CHUNK = 200;

const instrumentCache = new Map();

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

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return arr.reduce((a, b) => a + n(b), 0) / arr.length;
}

function sum(arr, fn = x => x) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((a, x) => a + n(fn(x)), 0);
}

function pct(a, b) {
  const aa = n(a);
  const bb = n(b);
  if (!bb) return 0;
  return (aa / bb) * 100;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeInterval(interval) {
  const x = String(interval || "1");
  return ALLOWED_INTERVALS.includes(x) ? x : "1";
}

function intervalMs(interval) {
  return Math.max(1, Number(interval)) * 60 * 1000;
}

function minuteStart(ts) {
  const x = n(ts, Date.now());
  return Math.floor(x / 60000) * 60000;
}

function priceDecimals(price, tickSize) {
  const tick = String(tickSize || "");
  if (tick.includes(".")) {
    return tick.split(".")[1].replace(/0+$/, "").length;
  }

  const p = n(price);

  if (p >= 1000) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 7;
  return 10;
}

function roundToStep(value, step) {
  const v = n(value);
  const s = n(step);

  if (!s) return v;

  return Math.round(v / s) * s;
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

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}`);
  }

  const data = await response.json();

  if (n(data.retCode) !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data;
}

async function instrumentInfo(
  category = "linear",
  symbol = ""
) {
  const key = `${category}:${symbol}`;

  if (instrumentCache.has(key)) {
    return instrumentCache.get(key);
  }

  const data = await bybit(
    "/v5/market/instruments-info",
    {
      category,
      symbol
    }
  );

  const item =
    data?.result?.list?.[0] || null;

  if (item) {
    instrumentCache.set(key, item);
  }

  return item;
}

async function kline(
  category,
  symbol,
  interval,
  limit = KLINE_LIMIT
) {
  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  const list =
    data?.result?.list || [];

  return list
    .map(row => ({
      time: n(row[0]),
      open: n(row[1]),
      high: n(row[2]),
      low: n(row[3]),
      close: n(row[4]),
      volume: n(row[5]),
      turnover: n(row[6])
    }))
    .sort((a, b) => a.time - b.time);
}

async function ticker(
  category,
  symbol
) {
  const data = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  return data?.result?.list?.[0] || {};
}

async function trades(
  category,
  symbol,
  limit = TRADE_LIMIT
) {
  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit
    }
  );

  return (data?.result?.list || [])
    .map(t => ({
      id: t.i || "",
      time: n(t.T),
      price: n(t.p),
      size: n(t.v),
      side: String(t.S || "").toUpperCase(),
      isBlockTrade: Boolean(t.isBlockTrade)
    }))
    .filter(x => x.price > 0 && x.size >= 0)
    .sort((a, b) => a.time - b.time);
}

function aggressorSide(trade) {
  const side =
    String(trade?.side || "")
      .toUpperCase();

  return side === "BUY" ? "BUY" : "SELL";
}

async function orderbook(
  category,
  symbol,
  limit = ORDERBOOK_LIMIT
) {
  const data = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit
    }
  );

  const result = data?.result || {};

  const bids = (result.b || [])
    .map(x => ({
      price: n(x[0]),
      size: n(x[1])
    }))
    .filter(x => x.price > 0)
    .map(x => ({
      ...x,
      value: x.price * x.size
    }));

  const asks = (result.a || [])
    .map(x => ({
      price: n(x[0]),
      size: n(x[1])
    }))
    .filter(x => x.price > 0)
    .map(x => ({
      ...x,
      value: x.price * x.size
    }));

  return {
    ts: n(result.ts, Date.now()),
    u: n(result.u),
    seq: n(result.seq),
    bids,
    asks,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0
  };
}

function flowFromTrades(list) {
  const arr = Array.isArray(list) ? list : [];

  let buyVolume = 0;
  let sellVolume = 0;

  let buyNotional = 0;
  let sellNotional = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let blockBuyVolume = 0;
  let blockSellVolume = 0;

  const notionals = arr
    .map(t => n(t.price) * n(t.size))
    .filter(x => x > 0);

  const averageNotional = avg(notionals);

  const sortedNotionals =
    [...notionals].sort((a, b) => a - b);

  const p95 =
    sortedNotionals.length
      ? sortedNotionals[
          Math.floor(
            (sortedNotionals.length - 1) * 0.95
          )
        ]
      : 0;

  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  for (const trade of arr) {
    const side = aggressorSide(trade);
    const volume = n(trade.size);
    const notional =
      n(trade.price) * volume;

    if (side === "BUY") {
      buyVolume += volume;
      buyNotional += notional;
      buyTrades++;

      if (notional >= largeThreshold) {
        largeBuyVolume += volume;
      }

      if (trade.isBlockTrade) {
        blockBuyVolume += volume;
      }
    } else {
      sellVolume += volume;
      sellNotional += notional;
      sellTrades++;

      if (notional >= largeThreshold) {
        largeSellVolume += volume;
      }

      if (trade.isBlockTrade) {
        blockSellVolume += volume;
      }
    }
  }

  const volume =
    buyVolume + sellVolume;

  const delta =
    buyVolume - sellVolume;

  const deltaPercent =
    pct(delta, volume);

  let pressure = "NEUTRAL";

  if (deltaPercent >= 10) {
    pressure = "BUY_PRESSURE";
  } else if (deltaPercent <= -10) {
    pressure = "SELL_PRESSURE";
  }

  return {
    buyVolume,
    sellVolume,
    volume,
    buyNotional,
    sellNotional,
    notional:
      buyNotional + sellNotional,
    buyTrades,
    sellTrades,
    delta,
    deltaPercent,
    pressure,
    largeBuyVolume,
    largeSellVolume,
    blockBuyVolume,
    blockSellVolume,
    averageNotional,
    largeThreshold
  };
}

function createLevel(price) {
  return {
    price: n(price),
    bidVolume: 0,
    askVolume: 0,
    delta: 0,
    volume: 0,
    buyTrades: 0,
    sellTrades: 0
  };
}

function buildFootprints(
  candles,
  tradeList,
  tickSize = 0
) {
  const result = [];

  for (const candle of candles || []) {
    const levels = new Map();

    const relevant =
      (tradeList || []).filter(
        t =>
          t.time >= candle.time &&
          t.time <
            candle.time +
              intervalMs(
                candle.interval || "1"
              )
      );

    for (const trade of relevant) {
      const rawPrice =
        n(trade.price);

      const price =
        tickSize
          ? roundToStep(
              rawPrice,
              tickSize
            )
          : rawPrice;

      const key = String(price);

      if (!levels.has(key)) {
        levels.set(
          key,
          createLevel(price)
        );
      }

      const level = levels.get(key);
      const volume = n(trade.size);

      if (
        aggressorSide(trade) ===
        "BUY"
      ) {
        level.askVolume += volume;
        level.buyTrades++;
      } else {
        level.bidVolume += volume;
        level.sellTrades++;
      }

      level.volume += volume;
      level.delta =
        level.askVolume -
        level.bidVolume;
    }

    const levelArray =
      [...levels.values()]
        .sort(
          (a, b) =>
            b.price - a.price
        )
        .slice(
          0,
          FOOTPRINT_MAX_LEVELS
        );

    const buyVolume =
      sum(
        levelArray,
        x => x.askVolume
      );

    const sellVolume =
      sum(
        levelArray,
        x => x.bidVolume
      );

    result.push({
      ...candle,
      levels: levelArray,
      footprint: levelArray,
      buyVolume,
      sellVolume,
      flowVolume:
        buyVolume + sellVolume,
      delta:
        buyVolume - sellVolume,
      deltaPercent:
        pct(
          buyVolume - sellVolume,
          buyVolume + sellVolume
        )
    });
  }

  return result;
}

function candleSeries(
  candles,
  tradeList
) {
  return (candles || []).map(c => {
    const relevant =
      (tradeList || []).filter(
        t =>
          t.time >= c.time &&
          t.time <
            c.time + 60000
      );

    const flow =
      flowFromTrades(relevant);

    return {
      ...c,
      buyVolume: flow.buyVolume,
      sellVolume: flow.sellVolume,
      flowVolume: flow.volume,
      delta: flow.delta,
      deltaPercent:
        flow.deltaPercent
    };
  });
}

function median(values) {
  const a = (values || [])
    .map(n)
    .filter(x => x > 0)
    .sort((x, y) => x - y);

  if (!a.length) return 0;

  const mid =
    Math.floor(a.length / 2);

  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
}

function wallAnalysis(book) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];

  const bidValues =
    bids.map(x => n(x.value));

  const askValues =
    asks.map(x => n(x.value));

  const bidMedian =
    median(bidValues);

  const askMedian =
    median(askValues);

  const buyThreshold =
    Math.max(
      bidMedian * 4,
      avg(bidValues) * 3
    );

  const sellThreshold =
    Math.max(
      askMedian * 4,
      avg(askValues) * 3
    );

  const buyWalls =
    bids
      .filter(
        x =>
          x.value >=
          buyThreshold
      )
      .sort(
        (a, b) =>
          b.value - a.value
      );

  const sellWalls =
    asks
      .filter(
        x =>
          x.value >=
          sellThreshold
      )
      .sort(
        (a, b) =>
          b.value - a.value
      );

  const buyLiquidity =
    sum(bids, x => x.value);

  const sellLiquidity =
    sum(asks, x => x.value);

  const totalLiquidity =
    buyLiquidity + sellLiquidity;

  const buyShare =
    pct(
      buyLiquidity,
      totalLiquidity
    );

  const sellShare =
    pct(
      sellLiquidity,
      totalLiquidity
    );

  let pressure = "NEUTRAL";

  if (buyShare > sellShare + 8) {
    pressure = "BUY_PRESSURE";
  } else if (
    sellShare >
    buyShare + 8
  ) {
    pressure = "SELL_PRESSURE";
  }

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    pressure,
    buyWalls,
    sellWalls,
    nearBuyWall:
      buyWalls[0] || null,
    nearSellWall:
      sellWalls[0] || null
  };
}

function liquidityHeatmap(book) {
  const bids =
    (book?.bids || [])
      .slice(0, HEATMAP_LEVELS);

  const asks =
    (book?.asks || [])
      .slice(0, HEATMAP_LEVELS);

  const all =
    [...bids, ...asks];

  const max =
    Math.max(
      1,
      ...all.map(x => n(x.value))
    );

  return all.map(x => ({
    price: x.price,
    size: x.size,
    value: x.value,
    side:
      bids.includes(x)
        ? "BUY"
        : "SELL",
    intensity:
      x.value / max
  }));
}

function liquidityZones(book) {
  const walls =
    wallAnalysis(book);

  const zones = [];

  for (const x of walls.buyWalls.slice(0, 20)) {
    zones.push({
      side: "BUY",
      price: x.price,
      size: x.size,
      value: x.value,
      strength: x.value
    });
  }

  for (const x of walls.sellWalls.slice(0, 20)) {
    zones.push({
      side: "SELL",
      price: x.price,
      size: x.size,
      value: x.value,
      strength: x.value
    });
  }

  return zones.sort(
    (a, b) =>
      b.strength - a.strength
  );
}

function candleStats(candles) {
  const c =
    candles?.[candles.length - 1];

  if (!c) {
    return {
      body: 0,
      range: 0,
      upperWick: 0,
      lowerWick: 0,
      bodyPercent: 0
    };
  }

  const body =
    Math.abs(
      c.close - c.open
    );

  const range =
    Math.max(
      0,
      c.high - c.low
    );

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  return {
    body,
    range,
    upperWick,
    lowerWick,
    bodyPercent:
      pct(body, range)
  };
}

function detectSweep(candles) {
  if (!candles || candles.length < 5) {
    return {
      detected: false,
      side: null,
      price: 0
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      Math.max(0, candles.length - 6),
      -1
    );

  const previousHigh =
    Math.max(
      ...previous.map(x => n(x.high))
    );

  const previousLow =
    Math.min(
      ...previous.map(x => n(x.low))
    );

  if (
    last.high > previousHigh &&
    last.close < previousHigh
  ) {
    return {
      detected: true,
      side: "SELL",
      price: last.high,
      type: "HIGH_SWEEP"
    };
  }

  if (
    last.low < previousLow &&
    last.close > previousLow
  ) {
    return {
      detected: true,
      side: "BUY",
      price: last.low,
      type: "LOW_SWEEP"
    };
  }

  return {
    detected: false,
    side: null,
    price: 0,
    type: null
  };
}

function detectTradeSweep(
  tradesList,
  book
) {
  if (!tradesList?.length) {
    return {
      detected: false
    };
  }

  const flow =
    flowFromTrades(
      tradesList.slice(-150)
    );

  const bestBid =
    n(book?.bestBid);

  const bestAsk =
    n(book?.bestAsk);

  if (
    flow.sellVolume >
      flow.buyVolume * 2 &&
    bestBid > 0
  ) {
    return {
      detected: true,
      side: "SELL",
      price: bestBid,
      delta: flow.delta
    };
  }

  if (
    flow.buyVolume >
      flow.sellVolume * 2 &&
    bestAsk > 0
  ) {
    return {
      detected: true,
      side: "BUY",
      price: bestAsk,
      delta: flow.delta
    };
  }

  return {
    detected: false
  };
}

function detectAbsorption(
  candles,
  flow
) {
  const stats =
    candleStats(candles);

  if (
    !stats.range ||
    !flow?.volume
  ) {
    return {
      detected: false,
      side: null,
      type: null
    };
  }

  const bodyRatio =
    stats.body /
    stats.range;

  const deltaPct =
    n(flow.deltaPercent);

  if (
    bodyRatio < 0.35 &&
    deltaPct <= -15
  ) {
    return {
      detected: true,
      side: "BUY",
      type: "BUY_ABSORPTION",
      strength:
        Math.abs(deltaPct)
    };
  }

  if (
    bodyRatio < 0.35 &&
    deltaPct >= 15
  ) {
    return {
      detected: true,
      side: "SELL",
      type: "SELL_ABSORPTION",
      strength:
        Math.abs(deltaPct)
    };
  }

  return {
    detected: false,
    side: null,
    type: null,
    strength: 0
  };
}

function sma(values, period) {
  const arr =
    (values || []).map(n);

  if (!arr.length) return 0;

  const p =
    Math.max(
      1,
      Math.min(
        period,
        arr.length
      )
    );

  return avg(
    arr.slice(
      arr.length - p
    )
  );
}

function ema(values, period) {
  const arr =
    (values || []).map(n);

  if (!arr.length) return 0;

  const p =
    Math.max(
      1,
      Math.min(
        period,
        arr.length
      )
    );

  const k =
    2 / (p + 1);

  let value =
    arr
      .slice(0, p)
      .reduce(
        (a, b) => a + b,
        0
      ) / p;

  for (
    let i = p;
    i < arr.length;
    i++
  ) {
    value =
      arr[i] * k +
      value * (1 - k);
  }

  return value;
}

function atr(candles, period = 14) {
  if (
    !candles ||
    candles.length < 2
  ) {
    return 0;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high - p.close
        ),
        Math.abs(
          c.low - p.close
        )
      )
    );
  }

  return sma(
    tr,
    period
  );
}

function rsi(
  candles,
  period = 14
) {
  if (
    !candles ||
    candles.length < period + 1
  ) {
    return 50;
  }

  const closes =
    candles.map(
      x => n(x.close)
    );

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const diff =
      closes[i] -
      closes[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses +=
        Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {
    const diff =
      closes[i] -
      closes[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0
        ? Math.abs(diff)
        : 0;

    avgGain =
      (avgGain * (period - 1) +
        gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) +
        loss) /
      period;
  }

  if (!avgLoss) return 100;

  const rs =
    avgGain / avgLoss;

  return 100 -
    100 / (1 + rs);
}

function structure(candles) {
  if (!candles?.length) {
    return {
      direction: "NEUTRAL",
      ma5: 0,
      ma20: 0,
      rsi: 50,
      atr: 0
    };
  }

  const closes =
    candles.map(
      x => n(x.close)
    );

  const ma5 =
    sma(closes, 5);

  const ma20 =
    sma(closes, 20);

  const current =
    closes[closes.length - 1];

  let direction =
    "NEUTRAL";

  if (
    current > ma20 &&
    ma5 > ma20
  ) {
    direction = "BULLISH";
  } else if (
    current < ma20 &&
    ma5 < ma20
  ) {
    direction = "BEARISH";
  }

  return {
    direction,
    ma5,
    ma20,
    rsi:
      rsi(candles),
    atr:
      atr(candles)
  };
}

function entry1m(candles) {
  if (!candles?.length) {
    return {
      direction: "WAIT",
      ma20: 0,
      price: 0,
      rsi: 50
    };
  }

  const closes =
    candles.map(
      x => n(x.close)
    );

  const price =
    closes[closes.length - 1];

  const ma20 =
    sma(closes, 20);

  const valueRsi =
    rsi(candles);

  let direction =
    "WAIT";

  if (
    price > ma20 &&
    valueRsi >= 45
  ) {
    direction = "BUY";
  }

  if (
    price < ma20 &&
    valueRsi <= 55
  ) {
    direction = "SELL";
  }

  return {
    direction,
    price,
    ma20,
    rsi: valueRsi
  };
}

function pressureFromFlow(
  flow,
  book
) {
  const tradePressure =
    flow?.pressure ||
    "NEUTRAL";

  const bookPressure =
    book?.pressure ||
    "NEUTRAL";

  if (
    tradePressure ===
      "BUY_PRESSURE" &&
    bookPressure ===
      "BUY_PRESSURE"
  ) {
    return "STRONG_BUY";
  }

  if (
    tradePressure ===
      "SELL_PRESSURE" &&
    bookPressure ===
      "SELL_PRESSURE"
  ) {
    return "STRONG_SELL";
  }

  if (
    tradePressure ===
      "BUY_PRESSURE" ||
    bookPressure ===
      "BUY_PRESSURE"
  ) {
    return "BUY";
  }

  if (
    tradePressure ===
      "SELL_PRESSURE" ||
    bookPressure ===
      "SELL_PRESSURE"
  ) {
    return "SELL";
  }

  return "NEUTRAL";
}

function movement(candles) {
  if (!candles?.length) {
    return {
      change: 0,
      changePercent: 0
    };
  }

  const first =
    candles[0];

  const last =
    candles[candles.length - 1];

  const change =
    last.close -
    first.open;

  return {
    change,
    changePercent:
      pct(
        change,
        first.open
      )
  };
}

function supportResistance(candles) {
  if (!candles?.length) {
    return {
      support: [],
      resistance: []
    };
  }

  const lows =
    candles
      .map(x => n(x.low))
      .filter(x => x > 0)
      .sort((a, b) => a - b);

  const highs =
    candles
      .map(x => n(x.high))
      .filter(x => x > 0)
      .sort((a, b) => a - b);

  return {
    support:
      [...new Set(lows)]
        .slice(0, 5),
    resistance:
      [...new Set(highs)]
        .reverse()
        .slice(0, 5)
  };
}

function structuralZone(
  candles,
  currentPrice
) {
  if (!candles?.length) {
    return null;
  }

  const range =
    atr(candles, 14) ||
    Math.abs(
      candles[candles.length - 1].high -
      candles[candles.length - 1].low
    );

  if (!range) return null;

  return {
    low:
      currentPrice - range,
    high:
      currentPrice + range,
    center:
      currentPrice,
    width:
      range
  };
}

function blockTrades(
  tradesList
) {
  const arr =
    tradesList || [];

  if (!arr.length) return [];

  const notionals =
    arr.map(
      t =>
        n(t.price) *
        n(t.size)
    );

  const threshold =
    Math.max(
      avg(notionals) * 5,
      median(notionals)
    );

  return arr
    .filter(
      t =>
        n(t.price) *
          n(t.size) >=
        threshold
    )
    .slice(-50)
    .map(t => ({
      time: t.time,
      price: t.price,
      size: t.size,
      value:
        t.price * t.size,
      aggressor:
        aggressorSide(t),
      isBlockTrade:
        Boolean(t.isBlockTrade)
    }));
}

async function oiFunding(
  symbol
) {
  try {
    const [
      tickerData,
      oiData,
      fundingData
    ] = await Promise.all([
      bybit(
        "/v5/market/tickers",
        {
          category: "linear",
          symbol
        }
      ),
      bybit(
        "/v5/market/open-interest",
        {
          category: "linear",
          symbol,
          intervalTime: "5min",
          limit: 1
        }
      ),
      bybit(
        "/v5/market/funding/history",
        {
          category: "linear",
          symbol,
          limit: 1
        }
      )
    ]);

    const tickerItem =
      tickerData?.result?.list?.[0] ||
      {};

    const oiItem =
      oiData?.result?.list?.[0] ||
      {};

    const fundingItem =
      fundingData?.result?.list?.[0] ||
      {};

    return {
      openInterest:
        n(oiItem.openInterest),
      openInterestTime:
        n(oiItem.timestamp),
      fundingRate:
        n(
          fundingItem.fundingRate
        ),
      fundingTime:
        n(
          fundingItem.fundingRateTimestamp
        ),
      markPrice:
        n(tickerItem.markPrice),
      indexPrice:
        n(tickerItem.indexPrice)
    };
  } catch {
    return {
      openInterest: 0,
      openInterestTime: 0,
      fundingRate: 0,
      fundingTime: 0,
      markPrice: 0,
      indexPrice: 0
    };
  }
}

function aggregateCandles(
  rows,
  interval
) {
  const ms =
    intervalMs(interval);

  const map =
    new Map();

  for (const row of rows || []) {
    const time =
      Math.floor(
        n(row.time) / ms
      ) * ms;

    if (!map.has(time)) {
      map.set(time, {
        time,
        open: n(row.open),
        high: n(row.high),
        low: n(row.low),
        close: n(row.close),
        volume: 0,
        turnover: 0,
        buyVolume: 0,
        sellVolume: 0,
        delta: 0,
        buyNotional: 0,
        sellNotional: 0,
        bidVolume: 0,
        askVolume: 0
      });
    }

    const c =
      map.get(time);

    c.high =
      Math.max(
        c.high,
        n(row.high)
      );

    c.low =
      Math.min(
        c.low,
        n(row.low)
      );

    c.close =
      n(row.close);

    c.volume +=
      n(
        row.volume ??
        row.flowVolume
      );

    c.turnover +=
      n(row.turnover);

    c.buyVolume +=
      n(row.buyVolume);

    c.sellVolume +=
      n(row.sellVolume);

    c.delta +=
      n(row.delta);

    c.buyNotional +=
      n(row.buyNotional);

    c.sellNotional +=
      n(row.sellNotional);

    c.bidVolume +=
      n(row.bidVolume);

    c.askVolume +=
      n(row.askVolume);
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        a.time - b.time
    )
    .map(c => ({
      ...c,
      flowVolume:
        c.buyVolume +
        c.sellVolume,
      deltaPercent:
        pct(
          c.delta,
          c.buyVolume +
            c.sellVolume
        )
    }));
}

async function buildChartData(
  symbol,
  interval = "1"
) {
  symbol =
    normalizeSymbol(symbol);

  interval =
    normalizeInterval(interval);

  const [
    candles1m,
    candles3m,
    candles5m,
    candles15m,
    selectedCandles,
    currentTicker,
    book,
    tradeList,
    instrument
  ] = await Promise.all([
    kline(
      "linear",
      symbol,
      TF,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF3,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF5,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF15,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      interval,
      CHART_LIMIT
    ),
    ticker(
      "linear",
      symbol
    ),
    orderbook(
      "linear",
      symbol,
      ORDERBOOK_LIMIT
    ),
    trades(
      "linear",
      symbol,
      TRADE_LIMIT
    ),
    instrumentInfo(
      "linear",
      symbol
    )
  ]);

  const tickSize =
    n(
      instrument
        ?.priceFilter
        ?.tickSize
    );

  const selectedWithFlow =
    candleSeries(
      selectedCandles,
      tradeList
    );

  for (const c of selectedWithFlow) {
    c.interval = interval;
  }

  const footprints =
    buildFootprints(
      selectedCandles.map(c => ({
        ...c,
        interval
      })),
      tradeList,
      tickSize
    );

  const currentFlow =
    flowFromTrades(
      tradeList.slice(-500)
    );

  const wall =
    wallAnalysis(book);

  const heatmap =
    liquidityHeatmap(book);

  const zones =
    liquidityZones(book);

  const sweep =
    detectSweep(
      selectedWithFlow
    );

  const tradeSweep =
    detectTradeSweep(
      tradeList,
      book
    );

  const absorption =
    detectAbsorption(
      selectedWithFlow,
      currentFlow
    );

  const blocks =
    blockTrades(
      tradeList
    );

  return {
    ok: true,
    version: VERSION,
    source: "BYBIT_REST",

    symbol,
    interval,

    ticker: {
      lastPrice:
        n(
          currentTicker.lastPrice
        ),
      markPrice:
        n(
          currentTicker.markPrice
        ),
      indexPrice:
        n(
          currentTicker.indexPrice
        ),
      volume24h:
        n(
          currentTicker.volume24h
        ),
      turnover24h:
        n(
          currentTicker.turnover24h
        ),
      price24hPcnt:
        n(
          currentTicker.price24hPcnt
        )
    },

    candles: {
      tf1:
        candleSeries(
          candles1m,
          tradeList
        ),
      tf3:
        candleSeries(
          candles3m,
          tradeList
        ),
      tf5:
        candleSeries(
          candles5m,
          tradeList
        ),
      tf15:
        candleSeries(
          candles15m,
          tradeList
        )
    },

    selectedCandles:
      selectedWithFlow,

    footprints,

    footprint: footprints,

    currentFlow,

    flow:
      currentFlow,

    cumulativeDelta:
      sum(
        selectedWithFlow,
        x => x.delta
      ),

    orderbook: {
      bids:
        book.bids.map(x => ({
          ...x,
          value:
            n(x.value)
        })),
      asks:
        book.asks.map(x => ({
          ...x,
          value:
            n(x.value)
        })),
      bestBid:
        book.bestBid,
      bestAsk:
        book.bestAsk
    },

    wall,

    heatmap,

    liquidityZones:
      zones,

    absorption,

    sweep,

    tradeSweep,

    blocks,

    trades:
      tradeList.slice(-200),

    structure: {
      tf1:
        structure(candles1m),
      tf3:
        structure(candles3m),
      tf5:
        structure(candles5m),
      tf15:
        structure(candles15m)
    },

    supportResistance:
      supportResistance(
        selectedWithFlow
      ),

    movement:
      movement(
        selectedWithFlow
      ),

    entry1m:
      entry1m(candles1m),

    zone:
      structuralZone(
        selectedWithFlow,
        n(
          currentTicker.lastPrice
        )
      ),

    instrument: {
      tickSize,
      qtyStep:
        n(
          instrument
            ?.lotSizeFilter
            ?.qtyStep
        ),
      minOrderQty:
        n(
          instrument
            ?.lotSizeFilter
            ?.minOrderQty
        )
    }
  };
}

async function analyze(
  symbol,
  selectedInterval = "1"
) {
  const chart =
    await buildChartData(
      symbol,
      selectedInterval
    );

  const s1 =
    chart.structure.tf1;

  const s5 =
    chart.structure.tf5;

  const s15 =
    chart.structure.tf15;

  const flow =
    chart.currentFlow;

  const wall =
    chart.wall;

  const absorption =
    chart.absorption;

  const sweep =
    chart.sweep;

  const tradeSweep =
    chart.tradeSweep;

  let score = 50;

  const reasons = [];

  if (
    s15.direction ===
    "BULLISH"
  ) {
    score += 10;
    reasons.push(
      "روند 15 دقیقه‌ای صعودی است"
    );
  }

  if (
    s15.direction ===
    "BEARISH"
  ) {
    score -= 10;
    reasons.push(
      "روند 15 دقیقه‌ای نزولی است"
    );
  }

  if (
    s5.direction ===
    "BULLISH"
  ) {
    score += 7;
    reasons.push(
      "ساختار 5 دقیقه‌ای صعودی است"
    );
  }

  if (
    s5.direction ===
    "BEARISH"
  ) {
    score -= 7;
    reasons.push(
      "ساختار 5 دقیقه‌ای نزولی است"
    );
  }

  if (
    flow.pressure ===
    "BUY_PRESSURE"
  ) {
    score += 10;
    reasons.push(
      "فشار خرید در معاملات واقعی"
    );
  }

  if (
    flow.pressure ===
    "SELL_PRESSURE"
  ) {
    score -= 10;
    reasons.push(
      "فشار فروش در معاملات واقعی"
    );
  }

  if (
    wall.pressure ===
    "BUY_PRESSURE"
  ) {
    score += 7;
    reasons.push(
      "نقدینگی سمت Bid قوی‌تر است"
    );
  }

  if (
    wall.pressure ===
    "SELL_PRESSURE"
  ) {
    score -= 7;
    reasons.push(
      "نقدینگی سمت Ask قوی‌تر است"
    );
  }

  if (
    absorption.detected
  ) {
    if (
      absorption.side ===
      "BUY"
    ) {
      score += 8;
      reasons.push(
        "نشانه جذب فروشندگان"
      );
    } else {
      score -= 8;
      reasons.push(
        "نشانه جذب خریداران"
      );
    }
  }

  if (
    sweep.detected
  ) {
    if (
      sweep.side ===
      "BUY"
    ) {
      score += 6;
      reasons.push(
        "Sweep نقدینگی پایین"
      );
    } else {
      score -= 6;
      reasons.push(
        "Sweep نقدینگی بالا"
      );
    }
  }

  if (
    tradeSweep.detected
  ) {
    if (
      tradeSweep.side ===
      "BUY"
    ) {
      score += 4;
    } else {
      score -= 4;
    }
  }

  score =
    Math.round(
      clamp(score, 0, 100)
    );

  let signal = "WAIT";

  if (score >= 70) {
    signal = "BUY";
  } else if (score <= 30) {
    signal = "SELL";
  }

  const oi =
    await oiFunding(
      normalizeSymbol(symbol)
    );

  return {
    ...chart,

    score,
    signal,
    reasons,

    pressure:
      pressureFromFlow(
        flow,
        wall
      ),

    oiFunding: oi,

    timeframeConfirmation: {
      "1m": s1,
      "5m": s5,
      "15m": s15
    },

    analyzedAt:
      Date.now()
  };
}

async function live(
  symbol,
  interval = "1"
) {
  return buildChartData(
    symbol,
    interval
  );
}

async function getSymbols() {
  const data =
    await bybit(
      "/v5/market/instruments-info",
      {
        category: "linear",
        status: "Trading",
        limit: 1000
      }
    );

  return (data?.result?.list || [])
    .filter(
      x =>
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType ===
          "LinearPerpetual"
    )
    .map(
      x => x.symbol
    )
    .slice(0, MAX_SYMBOLS);
}

async function scan(offset = 0) {
  const symbols =
    await getSymbols();

  const start =
    clamp(
      Number(offset) || 0,
      0,
      Math.max(
        0,
        symbols.length - 1
      )
    );

  const batch =
    symbols.slice(
      start,
      start + SCAN_BATCH
    );

  const results = [];

  for (const symbol of batch) {
    try {
      const chart =
        await buildChartData(
          symbol,
          "1"
        );

      const s15 =
        chart.structure.tf15;

      const flow =
        chart.currentFlow;

      const wall =
        chart.wall;

      const absorption =
        chart.absorption;

      let score = 50;

      if (
        s15.direction ===
        "BULLISH"
      ) {
        score += 12;
      }

      if (
        s15.direction ===
        "BEARISH"
      ) {
        score -= 12;
      }

      if (
        flow.pressure ===
        "BUY_PRESSURE"
      ) {
        score += 10;
      }

      if (
        flow.pressure ===
        "SELL_PRESSURE"
      ) {
        score -= 10;
      }

      if (
        wall.pressure ===
        "BUY_PRESSURE"
      ) {
        score += 8;
      }

      if (
        wall.pressure ===
        "SELL_PRESSURE"
      ) {
        score -= 8;
      }

      if (
        absorption.detected
      ) {
        score +=
          absorption.side ===
          "BUY"
            ? 8
            : -8;
      }

      score =
        Math.round(
          clamp(
            score,
            0,
            100
          )
        );

      let signal = "WAIT";

      if (score >= 70) {
        signal = "BUY";
      } else if (
        score <= 30
      ) {
        signal = "SELL";
      }

      if (score >= 55) {
        results.push({
          symbol,
          score,
          signal,
          delta:
            flow.delta,
          deltaPercent:
            flow.deltaPercent,
          pressure:
            flow.pressure,
          bookPressure:
            wall.pressure,
          absorption:
            absorption.detected
        });
      }
    } catch {
      // skip failed symbol
    }
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  const nextOffset =
    start + batch.length >=
    symbols.length
      ? 0
      : start + batch.length;

  return {
    ok: true,
    version: VERSION,
    offset: start,
    nextOffset,
    totalSymbols:
      symbols.length,
    results
  };
}

/* =========================================================
   DURABLE OBJECT COLLECTOR
   ========================================================= */

function newMinute(symbol, ts) {
  return {
    symbol,
    time:
      minuteStart(ts),

    open: 0,
    high: 0,
    low: 0,
    close: 0,

    volume: 0,
    turnover: 0,

    buyVolume: 0,
    sellVolume: 0,

    buyNotional: 0,
    sellNotional: 0,

    delta: 0,

    buyTrades: 0,
    sellTrades: 0,

    largeBuyVolume: 0,
    largeSellVolume: 0,

    blockBuyVolume: 0,
    blockSellVolume: 0,

    levels: {},

    bookSnapshots: [],

    liquidations: [],

    tradesCount: 0
  };
}

function ensureMinuteLevel(
  minute,
  price
) {
  const key =
    String(
      roundToStep(
        n(price),
        0.00000001
      )
    );

  if (
    !minute.levels[key]
  ) {
    minute.levels[key] = {
      price: n(price),
      bidVolume: 0,
      askVolume: 0,
      delta: 0,
      volume: 0
    };
  }

  return minute.levels[key];
}

function addTradeToMinute(
  minute,
  trade
) {
  const price =
    n(trade.price);

  const size =
    n(trade.size);

  if (
    price <= 0 ||
    size < 0
  ) {
    return;
  }

  if (!minute.open) {
    minute.open = price;
    minute.high = price;
    minute.low = price;
  }

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

  minute.volume += size;

  const notional =
    price * size;

  minute.turnover +=
    notional;

  minute.tradesCount++;

  const level =
    ensureMinuteLevel(
      minute,
      price
    );

  level.volume += size;

  if (
    aggressorSide(trade) ===
    "BUY"
  ) {
    minute.buyVolume += size;
    minute.buyNotional +=
      notional;
    minute.buyTrades++;

    level.askVolume +=
      size;
  } else {
    minute.sellVolume +=
      size;
    minute.sellNotional +=
      notional;
    minute.sellTrades++;

    level.bidVolume +=
      size;
  }

  level.delta =
    level.askVolume -
    level.bidVolume;

  minute.delta =
    minute.buyVolume -
    minute.sellVolume;

  const average =
    minute.tradesCount
      ? minute.turnover /
        minute.tradesCount
      : 0;

  if (
    notional >
    average * 5
  ) {
    if (
      aggressorSide(trade) ===
      "BUY"
    ) {
      minute.largeBuyVolume +=
        size;
    } else {
      minute.largeSellVolume +=
        size;
    }
  }

  if (trade.isBlockTrade) {
    if (
      aggressorSide(trade) ===
      "BUY"
    ) {
      minute.blockBuyVolume +=
        size;
    } else {
      minute.blockSellVolume +=
        size;
    }
  }
}

function finalizeMinute(minute) {
  const levels =
    Object.values(
      minute.levels || {}
    )
      .sort(
        (a, b) =>
          b.price - a.price
      )
      .slice(
        0,
        FOOTPRINT_MAX_LEVELS
      );

  return {
    ...minute,

    levels,

    footprint: levels,

    flowVolume:
      minute.buyVolume +
      minute.sellVolume,

    deltaPercent:
      pct(
        minute.delta,
        minute.buyVolume +
          minute.sellVolume
      )
  };
}

export class CollectorDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.sockets = new Map();
    this.books = new Map();
    this.minutes = new Map();

    this.started = false;
    this.symbols = [];

    this.reconnectTimers = new Map();
    this.snapshotTimers = new Map();

    this.wsState = new Map();

    this.initPromise =
      this.initDatabase();
  }

  async initDatabase() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS minutes (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(symbol, ts)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS
      idx_minutes_symbol_ts
      ON minutes(symbol, ts)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  }

  async fetch(request) {
    await this.initPromise;

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    if (
      path === "/init"
    ) {
      await this.startSockets();

      return json({
        ok: true,
        started: true,
        version: VERSION
      });
    }

    if (
      path === "/status"
    ) {
      return json(
        await this.status()
      );
    }

    if (
      path === "/symbols"
    ) {
      const symbols =
        await this.loadSymbols();

      return json({
        ok: true,
        symbols
      });
    }

    if (
      path === "/history"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      const minutes =
        clamp(
          Number(
            url.searchParams.get(
              "minutes"
            ) || 180
          ),
          1,
          RETENTION_MINUTES
        );

      return json({
        ok: true,
        symbol,
        minutes,
        rows:
          await this.readHistory(
            symbol,
            minutes
          )
      });
    }

    if (
      path === "/latest"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      return json({
        ok: true,
        symbol,
        row:
          this.getLatestMemory(
            symbol
          )
      });
    }

    if (
      path === "/chart"
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

      return json(
        await this.collectorChart(
          symbol,
          interval
        )
      );
    }

    if (
      path === "/cleanup"
    ) {
      const result =
        await this.cleanup();

      return json({
        ok: true,
        ...result
      });
    }

    return json(
      {
        ok: false,
        error:
          "Collector route not found"
      },
      404
    );
  }

  async loadSymbols() {
    if (
      this.symbols.length
    ) {
      return this.symbols;
    }

    try {
      this.symbols =
        await getSymbols();
    } catch {
      this.symbols = [];
    }

    return this.symbols;
  }

  async startSockets() {
    if (this.started) {
      return;
    }

    this.started = true;

    const symbols =
      await this.loadSymbols();

    if (!symbols.length) {
      this.started = false;
      return;
    }

    const chunks = [];

    for (
      let i = 0;
      i < symbols.length;
      i += WS_SUB_CHUNK
    ) {
      chunks.push(
        symbols.slice(
          i,
          i + WS_SUB_CHUNK
        )
      );
    }

    for (
      let i = 0;
      i < chunks.length;
      i++
    ) {
      this.connectShard(
        i,
        chunks[i]
      );
    }
  }

  connectShard(
    shardId,
    symbols
  ) {
    const topics = [];

    for (const symbol of symbols) {
      topics.push(
        `publicTrade.${symbol}`
      );

      topics.push(
        `orderbook.50.${symbol}`
      );
    }

    topics.push(
      "allLiquidation"
    );

    let ws;

    try {
      ws =
        new WebSocket(
          BYBIT_WS
        );
    } catch {
      this.scheduleReconnect(
        shardId,
        symbols
      );

      return;
    }

    const key =
      `shard-${shardId}`;

    this.sockets.set(
      key,
      ws
    );

    this.wsState.set(
      key,
      {
        shardId,
        symbols,
        connectedAt: 0,
        messages: 0,
        status:
          "CONNECTING"
      }
    );

    ws.addEventListener(
      "open",
      () => {
        const state =
          this.wsState.get(
            key
          );

        if (state) {
          state.status =
            "OPEN";

          state.connectedAt =
            Date.now();
        }

        for (
          let i = 0;
          i < topics.length;
          i += 100
        ) {
          const batch =
            topics.slice(
              i,
              i + 100
            );

          try {
            ws.send(
              JSON.stringify({
                op: "subscribe",
                args: batch
              })
            );
          } catch {}
        }

        for (const symbol of symbols) {
          this.startSnapshotTimer(
            symbol
          );
        }
      }
    );

    ws.addEventListener(
      "message",
      event => {
        const state =
          this.wsState.get(
            key
          );

        if (state) {
          state.messages++;
        }

        this.handleWsMessage(
          event.data
        );
      }
    );

    ws.addEventListener(
      "close",
      () => {
        this.sockets.delete(
          key
        );

        const state =
          this.wsState.get(
            key
          );

        if (state) {
          state.status =
            "CLOSED";
        }

        this.scheduleReconnect(
          shardId,
          symbols
        );
      }
    );

    ws.addEventListener(
      "error",
      () => {
        try {
          ws.close();
        } catch {}
      }
    );
  }

  scheduleReconnect(
    shardId,
    symbols
  ) {
    const key =
      `shard-${shardId}`;

    if (
      this.reconnectTimers.has(
        key
      )
    ) {
      return;
    }

    const current =
      this.wsState.get(
        key
      );

    const retry =
      n(
        current?.retry || 0
      );

    const delay =
      Math.min(
        WS_RECONNECT_MAX,
        WS_RECONNECT_BASE *
          Math.pow(
            2,
            Math.min(
              retry,
              5
            )
          )
      );

    if (current) {
      current.retry =
        retry + 1;
      current.status =
        "RECONNECTING";
    }

    const timer =
      setTimeout(
        () => {
          this.reconnectTimers.delete(
            key
          );

          this.connectShard(
            shardId,
            symbols
          );
        },
        delay
      );

    this.reconnectTimers.set(
      key,
      timer
    );
  }

  startSnapshotTimer(symbol) {
    if (
      this.snapshotTimers.has(
        symbol
      )
    ) {
      return;
    }

    const timer =
      setInterval(
        () => {
          this.captureBook(
            symbol
          );
        },
        ORDERBOOK_SNAPSHOT_MS
      );

    this.snapshotTimers.set(
      symbol,
      timer
    );
  }

  handleWsMessage(raw) {
    let msg;

    try {
      msg =
        typeof raw ===
        "string"
          ? JSON.parse(raw)
          : raw;
    } catch {
      return;
    }

    if (!msg) return;

    const topic =
      String(
        msg.topic || ""
      );

    if (
      topic.startsWith(
        "publicTrade."
      )
    ) {
      const symbol =
        normalizeSymbol(
          topic.split(".")[1]
        );

      this.handlePublicTrade(
        symbol,
        msg.data
      );

      return;
    }

    if (
      topic.startsWith(
        "orderbook."
      )
    ) {
      const parts =
        topic.split(".");

      const symbol =
        normalizeSymbol(
          parts[2]
        );

      this.updateBook(
        symbol,
        msg
      );

      return;
    }

    if (
      topic ===
      "allLiquidation"
    ) {
      this.handleLiquidation(
        msg.data
      );
    }
  }

  handlePublicTrade(
    symbol,
    rows
  ) {
    if (!symbol) return;

    const arr =
      Array.isArray(rows)
        ? rows
        : [];

    for (const row of arr) {
      const trade = {
        id:
          row.i || "",
        time:
          n(row.T, Date.now()),
        price:
          n(row.p),
        size:
          n(row.v),
        side:
          String(
            row.S || ""
          ).toUpperCase(),
        isBlockTrade:
          Boolean(
            row.isBlockTrade
          )
      };

      if (
        trade.price <= 0 ||
        trade.size < 0
      ) {
        continue;
      }

      this.addTrade(
        symbol,
        trade
      );
    }
  }

  addTrade(
    symbol,
    trade
  ) {
    const ts =
      minuteStart(
        trade.time
      );

    let minute =
      this.minutes.get(
        symbol
      );

    if (!minute) {
      minute =
        newMinute(
          symbol,
          ts
        );

      this.minutes.set(
        symbol,
        minute
      );
    }

    if (
      minute.time !== ts
    ) {
      const old =
        minute;

      this.minutes.set(
        symbol,
        newMinute(
          symbol,
          ts
        )
      );

      this.ctx.waitUntil(
        this.flushMinute(
          old
        )
      );

      minute =
        this.minutes.get(
          symbol
        );
    }

    addTradeToMinute(
      minute,
      trade
    );

    this.maybeFlush(
      symbol
    );
  }

  updateBook(
    symbol,
    msg
  ) {
    if (!symbol) return;

    const data =
      msg?.data || {};

    const type =
      msg?.type || "";

    if (
      type === "snapshot"
    ) {
      this.books.set(
        symbol,
        {
          ts:
            n(
              data.ts,
              Date.now()
            ),
          u:
            n(data.u),
          seq:
            n(data.seq),
          bids:
            (data.b || [])
              .map(x => ({
                price:
                  n(x[0]),
                size:
                  n(x[1])
              }))
              .filter(
                x =>
                  x.price > 0
              ),
          asks:
            (data.a || [])
              .map(x => ({
                price:
                  n(x[0]),
                size:
                  n(x[1])
              }))
              .filter(
                x =>
                  x.price > 0
              )
        }
      );

      return;
    }

    let book =
      this.books.get(
        symbol
      );

    if (!book) {
      return;
    }

    this.applyBookSide(
      book.bids,
      data.b
    );

    this.applyBookSide(
      book.asks,
      data.a
    );

    book.ts =
      n(
        data.ts,
        Date.now()
      );

    book.u =
      n(data.u, book.u);

    book.seq =
      n(data.seq, book.seq);
  }

  applyBookSide(
    levels,
    changes
  ) {
    if (
      !Array.isArray(changes)
    ) {
      return;
    }

    const map =
      new Map(
        levels.map(
          x => [
            String(x.price),
            x
          ]
        )
      );

    for (const row of changes) {
      const price =
        n(row[0]);

      const size =
        n(row[1]);

      if (!price) continue;

      const key =
        String(price);

      if (size <= 0) {
        map.delete(key);
      } else {
        map.set(
          key,
          {
            price,
            size
          }
        );
      }
    }

    levels.length = 0;

    levels.push(
      ...[...map.values()]
        .sort(
          (a, b) =>
            a.price - b.price
        )
        .slice(
          0,
          ORDERBOOK_LIMIT
        )
    );
  }

  handleLiquidation(
    rows
  ) {
    const arr =
      Array.isArray(rows)
        ? rows
        : [];

    for (const row of arr) {
      const symbol =
        normalizeSymbol(
          row.symbol ||
          row.s
        );

      if (!symbol) continue;

      const ts =
        n(
          row.T ||
          row.time,
          Date.now()
        );

      let minute =
        this.minutes.get(
          symbol
        );

      if (!minute) {
        minute =
          newMinute(
            symbol,
            ts
          );

        this.minutes.set(
          symbol,
          minute
        );
      }

      if (
        minute.time !==
        minuteStart(ts)
      ) {
        const old =
          minute;

        this.minutes.set(
          symbol,
          newMinute(
            symbol,
            ts
          )
        );

        this.ctx.waitUntil(
          this.flushMinute(
            old
          )
        );

        minute =
          this.minutes.get(
            symbol
          );
      }

      minute.liquidations.push({
        time: ts,
        side:
          String(
            row.side || ""
          ).toUpperCase(),
        price:
          n(row.price || row.p),
        size:
          n(row.qty || row.v)
      });

      if (
        minute.liquidations.length >
        100
      ) {
        minute.liquidations =
          minute.liquidations.slice(
            -100
          );
      }
    }
  }

  captureBook(symbol) {
    const book =
      this.books.get(
        symbol
      );

    if (!book) return;

    let minute =
      this.minutes.get(
        symbol
      );

    if (!minute) {
      minute =
        newMinute(
          symbol,
          Date.now()
        );

      this.minutes.set(
        symbol,
        minute
      );
    }

    const snapshot = {
      time:
        Date.now(),
      bestBid:
        book.bids.length
          ? Math.max(
              ...book.bids.map(
                x => x.price
              )
            )
          : 0,
      bestAsk:
        book.asks.length
          ? Math.min(
              ...book.asks.map(
                x => x.price
              )
            )
          : 0,
      bids:
        book.bids
          .slice(0, 20),
      asks:
        book.asks
          .slice(0, 20)
    };

    minute.bookSnapshots.push(
      snapshot
    );

    if (
      minute.bookSnapshots.length >
      20
    ) {
      minute.bookSnapshots =
        minute.bookSnapshots.slice(
          -20
        );
    }
  }

  maybeFlush(symbol) {
    const minute =
      this.minutes.get(
        symbol
      );

    if (!minute) return;

    if (
      Date.now() -
        minute.time >
      120000
    ) {
      this.minutes.delete(
        symbol
      );

      this.ctx.waitUntil(
        this.flushMinute(
          minute
        )
      );
    }
  }

  async flushMinute(minute) {
    if (!minute?.symbol) {
      return;
    }

    const final =
      finalizeMinute(
        minute
      );

    this.ctx.storage.sql.exec(
      `
      INSERT OR REPLACE INTO minutes
      (symbol, ts, data)
      VALUES (?, ?, ?)
      `,
      final.symbol,
      final.time,
      JSON.stringify(final)
    );

    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
        60000;

    this.ctx.storage.sql.exec(
      `
      DELETE FROM minutes
      WHERE ts < ?
      `,
      cutoff
    );
  }

  async readHistory(
    symbol,
    minutes = 180
  ) {
    if (!symbol) return [];

    const from =
      Date.now() -
      minutes * 60000;

    const cursor =
      this.ctx.storage.sql.exec(
        `
        SELECT symbol, ts, data
        FROM minutes
        WHERE symbol = ?
          AND ts >= ?
        ORDER BY ts ASC
        `,
        symbol,
        from
      );

    const rows =
      cursor.toArray();

    const result =
      rows.map(
        row => {
          try {
            return JSON.parse(
              row.data
            );
          } catch {
            return null;
          }
        }
      ).filter(Boolean);

    const current =
      this.minutes.get(
        symbol
      );

    if (
      current &&
      current.time >= from
    ) {
      result.push(
        finalizeMinute(
          current
        )
      );
    }

    const unique =
      new Map();

    for (const row of result) {
      unique.set(
        Number(row.time),
        row
      );
    }

    return [...unique.values()]
      .sort(
        (a, b) =>
          a.time - b.time
      );
  }

  getLatestMemory(symbol) {
    const minute =
      this.minutes.get(
        symbol
      );

    return minute
      ? finalizeMinute(
          minute
        )
      : null;
  }

  async aggregateRows(
    rows,
    interval
  ) {
    return aggregateCandles(
      rows,
      interval
    );
  }

  async collectorChart(
    symbol,
    interval
  ) {
    const sourceMinutes =
      Math.min(
        RETENTION_MINUTES,
        Math.max(
          300,
          180 *
            Number(interval)
        )
      );

    const rows =
      await this.readHistory(
        symbol,
        sourceMinutes
      );

    const candles =
      await this.aggregateRows(
        rows,
        interval
      );

    let cumulativeDelta = 0;

    for (const c of candles) {
      cumulativeDelta +=
        n(c.delta);

      c.cumulativeDelta =
        cumulativeDelta;
    }

    const latest =
      candles[
        candles.length - 1
      ] || null;

    return {
      ok: true,
      version: VERSION,
      source:
        "COLLECTOR_AGGREGATED_1M",

      symbol,
      interval,

      candles,

      selectedCandles:
        candles,

      footprints:
        candles.map(
          c => ({
            ...c,
            levels:
              c.levels || []
          })
        ),

      footprint:
        candles.map(
          c => ({
            ...c,
            levels:
              c.levels || []
          })
        ),

      currentFlow: latest
        ? {
            buyVolume:
              latest.buyVolume,
            sellVolume:
              latest.sellVolume,
            volume:
              latest.flowVolume,
            delta:
              latest.delta,
            deltaPercent:
              latest.deltaPercent
          }
        : {
            buyVolume: 0,
            sellVolume: 0,
            volume: 0,
            delta: 0,
            deltaPercent: 0
          },

      cumulativeDelta,

      ticker: {
        lastPrice:
          latest?.close || 0
      },

      orderbook: {
        bids: [],
        asks: [],
        bestBid: 0,
        bestAsk: 0
      },

      wall: {
        buyLiquidity: 0,
        sellLiquidity: 0,
        totalLiquidity: 0,
        buyShare: 0,
        sellShare: 0,
        pressure: "NEUTRAL",
        buyWalls: [],
        sellWalls: [],
        nearBuyWall: null,
        nearSellWall: null
      },

      liquidityZones: [],

      heatmap: [],

      absorption: {
        detected: false,
        side: null
      },

      sweep: {
        detected: false
      },

      blocks: [],

      trades: [],

      score: 50,
      signal: "WAIT",

      analyzedAt:
        Date.now()
    };
  }

  async status() {
    const sockets = [];

    for (
      const [
        key,
        state
      ] of this.wsState
    ) {
      sockets.push({
        key,
        ...state
      });
    }

    const cursor =
      this.ctx.storage.sql.exec(
        `
        SELECT COUNT(*) AS count
        FROM minutes
        `
      );

    const count =
      cursor.toArray()[0]?.count ||
      0;

    return {
      ok: true,
      version: VERSION,
      started:
        this.started,
      symbols:
        this.symbols.length,
      memoryMinutes:
        this.minutes.size,
      storedMinutes:
        n(count),
      sockets,
      books:
        this.books.size
    };
  }

  async cleanup() {
    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
        60000;

    const cursor =
      this.ctx.storage.sql.exec(
        `
        SELECT COUNT(*) AS count
        FROM minutes
        WHERE ts < ?
        `,
        cutoff
      );

    const before =
      n(
        cursor.toArray()[0]?.count
      );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM minutes
      WHERE ts < ?
      `,
      cutoff
    );

    return {
      deleted:
        before
    };
  }
}

/* =========================================================
   MAIN WORKER
   ========================================================= */

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods":
      "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "Content-Type"
  };
}

async function collectorRequest(
  env,
  path,
  params = {}
) {
  if (!env.COLLECTOR) {
    throw new Error(
      "COLLECTOR binding is missing"
    );
  }

  const id =
    env.COLLECTOR.idFromName(
      "MAIN"
    );

  const stub =
    env.COLLECTOR.get(id);

  const url =
    new URL(
      "https://collector.local" +
      path
    );

  for (
    const [key, value] of
    Object.entries(params)
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
    await stub.fetch(
      new Request(
        url.toString()
      )
    );

  return response.json();
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const cors =
      corsHeaders();

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: cors
        }
      );
    }

    const url =
      new URL(
        request.url
      );

    try {
      if (
        url.pathname ===
        "/api/health"
      ) {
        return json(
          {
            ok: true,
            version: VERSION,
            worker:
              "absorption-zone-scanner",
            time:
              Date.now()
          },
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/test-bybit"
      ) {
        const data =
          await bybit(
            "/v5/market/time"
          );

        return json(
          {
            ok: true,
            bybit: data,
            version: VERSION
          },
          200,
          cors
        );
      }

      if (
        url.pathname ===
          "/api/collector/init" ||
        url.pathname ===
          "/api/init"
      ) {
        const result =
          await collectorRequest(
            env,
            "/init"
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
          "/api/collector/status" ||
        url.pathname ===
          "/api/status"
      ) {
        const result =
          await collectorRequest(
            env,
            "/status"
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/collector/symbols"
      ) {
        const result =
          await collectorRequest(
            env,
            "/symbols"
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/history"
      ) {
        const result =
          await collectorRequest(
            env,
            "/history",
            {
              symbol:
                url.searchParams.get(
                  "symbol"
                ),
              minutes:
                url.searchParams.get(
                  "minutes"
                ) || 180
            }
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/latest"
      ) {
        const result =
          await collectorRequest(
            env,
            "/latest",
            {
              symbol:
                url.searchParams.get(
                  "symbol"
                )
            }
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/collector/chart"
      ) {
        const result =
          await collectorRequest(
            env,
            "/chart",
            {
              symbol:
                url.searchParams.get(
                  "symbol"
                ),
              interval:
                url.searchParams.get(
                  "interval"
                ) || "1"
            }
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/collector/cleanup"
      ) {
        const result =
          await collectorRequest(
            env,
            "/cleanup"
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/analyze"
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

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "Symbol is required"
            },
            400,
            cors
          );
        }

        const result =
          await analyze(
            symbol,
            interval
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/live"
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

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "Symbol is required"
            },
            400,
            cors
          );
        }

        const result =
          await live(
            symbol,
            interval
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/chart"
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

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "Symbol is required"
            },
            400,
            cors
          );
        }

        try {
          const result =
            await buildChartData(
              symbol,
              interval
            );

          return json(
            result,
            200,
            cors
          );
        } catch {
          const result =
            await collectorRequest(
              env,
              "/chart",
              {
                symbol,
                interval
              }
            );

          return json(
            result,
            200,
            cors
          );
        }
      }

      if (
        url.pathname ===
        "/api/scan"
      ) {
        const offset =
          Number(
            url.searchParams.get(
              "offset"
            ) || 0
          );

        const result =
          await scan(
            offset
          );

        return json(
          result,
          200,
          cors
        );
      }

      if (
        url.pathname ===
        "/api/symbols"
      ) {
        const symbols =
          await getSymbols();

        return json(
          {
            ok: true,
            symbols
          },
          200,
          cors
        );
      }

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return new Response(
        "Not Found",
        {
          status: 404,
          headers: cors
        }
      );
    } catch (error) {
      return json(
        {
          ok: false,
          version: VERSION,
          error:
            error?.message ||
            String(error)
        },
        500,
        cors
      );
    }
  }
};
