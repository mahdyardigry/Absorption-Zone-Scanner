const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ORDERFLOW-MAP-V3";

const TF = "5";
const TF15 = "15";
const TF3 = "3";
const TF1 = "1";

const KLINE_LIMIT = 240;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const CHART_LIMIT = 180;
const FOOTPRINT_MAX_LEVELS = 80;
const HEATMAP_LEVELS = 50;

const ALLOWED_INTERVALS = ["1", "3", "5", "15", "30", "60"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "*"
    }
  });
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function pct(a, b) {
  return b ? (a / b) * 100 : 0;
}

function avg(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function sum(a) {
  return a.reduce((x, y) => x + n(y), 0);
}

function finitePositive(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function normalizeInterval(v) {
  v = String(v || TF);
  return ALLOWED_INTERVALS.includes(v) ? v : TF;
}

function intervalMs(interval) {
  return Number(normalizeInterval(interval)) * 60 * 1000;
}

function roundToStep(price, step) {
  price = n(price);
  step = n(step);
  if (!price || !step) return price;

  const decimals = Math.max(
    0,
    Math.min(16, String(step).includes(".")
      ? String(step).split(".")[1].replace(/0+$/, "").length
      : 0)
  );

  const rounded = Math.round((price / step) + Number.EPSILON) * step;
  return Number(rounded.toFixed(decimals));
}

function floorToStep(price, step) {
  price = n(price);
  step = n(step);
  if (!price || !step) return price;

  const decimals = Math.max(
    0,
    Math.min(16, String(step).includes(".")
      ? String(step).split(".")[1].replace(/0+$/, "").length
      : 0)
  );

  return Number((Math.floor(price / step + 1e-12) * step).toFixed(decimals));
}

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(u.toString(), {
    headers: {
      accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit error ${data.retCode}`);
  }

  return data;
}

/* =========================================================
   INSTRUMENT
========================================================= */

const instrumentCache = new Map();

async function instrumentInfo(category, symbol) {
  const key = `${category}:${symbol}`;

  if (instrumentCache.has(key)) {
    return instrumentCache.get(key);
  }

  const data = await bybit("/v5/market/instruments-info", {
    category,
    symbol
  });

  const item = data?.result?.list?.[0];

  if (!item) {
    const fallback = {
      symbol,
      tickSize: 0,
      minPrice: 0,
      maxPrice: 0,
      qtyStep: 0
    };

    instrumentCache.set(key, fallback);
    return fallback;
  }

  const result = {
    symbol: item.symbol,
    tickSize: n(item.priceFilter?.tickSize),
    minPrice: n(item.priceFilter?.minPrice),
    maxPrice: n(item.priceFilter?.maxPrice),
    qtyStep: n(item.lotSizeFilter?.qtyStep)
  };

  instrumentCache.set(key, result);
  return result;
}

/* =========================================================
   KLINES
========================================================= */

async function kline(
  category,
  symbol,
  interval = TF,
  limit = KLINE_LIMIT
) {
  interval = normalizeInterval(interval);

  const data = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  return (data?.result?.list || [])
    .map(x => ({
      time: n(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }))
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   TICKER
========================================================= */

async function ticker(category, symbol) {
  const data = await bybit("/v5/market/tickers", {
    category,
    symbol
  });

  const x = data?.result?.list?.[0] || {};

  return {
    symbol,
    lastPrice: n(x.lastPrice),
    markPrice: n(x.markPrice),
    indexPrice: n(x.indexPrice),
    turnover24h: n(x.turnover24h),
    volume24h: n(x.volume24h),
    price24hPcnt: n(x.price24hPcnt),
    openInterest: n(x.openInterest),
    fundingRate: n(x.fundingRate)
  };
}

/* =========================================================
   TRADES
========================================================= */

async function trades(
  category,
  symbol,
  limit = TRADE_LIMIT
) {
  const data = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit
  });

  return (data?.result?.list || [])
    .map(x => ({
      id: x.execId || x.id || `${x.time}-${x.price}-${x.size}`,
      time: n(x.time),
      price: n(x.price),
      size: n(x.size),
      side: String(x.side || "").toLowerCase(),
      isBuyerMaker:
        x.isBuyerMaker === true ||
        x.isBuyerMaker === "true"
    }))
    .filter(x => x.time && x.price > 0 && x.size > 0)
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function orderbook(
  category,
  symbol,
  limit = ORDERBOOK_LIMIT
) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit
  });

  const result = data?.result || {};

  const bids = (result.b || [])
    .map(x => {
      const price = n(x[0]);
      const size = n(x[1]);
      return {
        price,
        size,
        value: price * size
      };
    })
    .filter(x => x.price > 0 && x.size > 0);

  const asks = (result.a || [])
    .map(x => {
      const price = n(x[0]);
      const size = n(x[1]);
      return {
        price,
        size,
        value: price * size
      };
    })
    .filter(x => x.price > 0 && x.size > 0);

  return {
    bids,
    asks,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0,
    timestamp: n(data.time, Date.now())
  };
}

/* =========================================================
   OI / FUNDING
========================================================= */

async function oiFunding(symbol) {
  try {
    const [tickerData, oiData, fundingData] = await Promise.all([
      bybit("/v5/market/tickers", {
        category: "linear",
        symbol
      }),
      bybit("/v5/market/open-interest", {
        category: "linear",
        symbol,
        intervalTime: "5min",
        limit: 50
      }),
      bybit("/v5/market/funding/history", {
        category: "linear",
        symbol,
        limit: 10
      })
    ]);

    const tickerItem = tickerData?.result?.list?.[0] || {};

    const oiHistory = (oiData?.result?.list || [])
      .map(x => ({
        time: n(x.timestamp),
        oi: n(x.openInterest)
      }))
      .sort((a, b) => a.time - b.time);

    const fundingHistory = (fundingData?.result?.list || [])
      .map(x => ({
        time: n(x.fundingRateTimestamp),
        fundingRate: n(x.fundingRate)
      }))
      .sort((a, b) => a.time - b.time);

    const currentOI =
      n(tickerItem.openInterest) ||
      oiHistory.at(-1)?.oi ||
      0;

    const previousOI =
      oiHistory.length > 1
        ? oiHistory.at(-2)?.oi || 0
        : oiHistory.at(-1)?.oi || 0;

    return {
      currentOI,
      previousOI,
      changePercent: pct(currentOI - previousOI, previousOI),
      fundingRate:
        n(tickerItem.fundingRate) ||
        fundingHistory.at(-1)?.fundingRate ||
        0,
      oiHistory,
      fundingHistory
    };
  } catch {
    return {
      currentOI: 0,
      previousOI: 0,
      changePercent: 0,
      fundingRate: 0,
      oiHistory: [],
      fundingHistory: []
    };
  }
}

/* =========================================================
   INDICATORS
========================================================= */

function sma(values, period) {
  if (!values.length) return 0;
  if (values.length < period) {
    return avg(values);
  }

  let s = 0;

  for (let i = values.length - period; i < values.length; i++) {
    s += n(values[i]);
  }

  return s / period;
}

function ema(values, period) {
  if (!values.length) return 0;

  const p = Math.max(1, period);
  const k = 2 / (p + 1);

  let e = values[0];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return sma(trs.slice(-period), period);
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const diff =
      candles[i].close -
      candles[i - 1].close;

    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  if (loss === 0) return 100;

  const rs = gain / loss;

  return 100 - 100 / (1 + rs);
}

function candleStats(c) {
  const range = Math.max(0, c.high - c.low);
  const body = Math.abs(c.close - c.open);

  return {
    range,
    body,
    bodyPercent: pct(body, range),
    upperWick:
      c.high - Math.max(c.open, c.close),
    lowerWick:
      Math.min(c.open, c.close) - c.low,
    bullish: c.close >= c.open
  };
}

/* =========================================================
   AGGRESSOR
========================================================= */

function aggressorSide(x) {
  if (x.isBuyerMaker === false) return "BUY";
  if (x.isBuyerMaker === true) return "SELL";
  if (x.side === "buy") return "BUY";
  return "SELL";
}

/* =========================================================
   FLOW
========================================================= */

function flowFromTrades(list, start = 0, end = Infinity) {
  const selected = list.filter(
    x => x.time >= start && x.time <= end
  );

  let buyVolume = 0;
  let sellVolume = 0;
  let buyValue = 0;
  let sellValue = 0;
  let buyTrades = 0;
  let sellTrades = 0;
  let largestTradeValue = 0;

  for (const x of selected) {
    const value = x.price * x.size;
    largestTradeValue = Math.max(largestTradeValue, value);

    if (aggressorSide(x) === "BUY") {
      buyVolume += x.size;
      buyValue += value;
      buyTrades++;
    } else {
      sellVolume += x.size;
      sellValue += value;
      sellTrades++;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;

  const delta = buyVolume - sellVolume;
  const deltaValue = buyValue - sellValue;

  return {
    buyVolume,
    sellVolume,
    buyValue,
    sellValue,
    buyNotional: buyValue,
    sellNotional: sellValue,
    totalVolume,
    totalValue,
    delta,
    deltaValue,
    deltaPercent: pct(delta, totalVolume),
    deltaValuePercent: pct(deltaValue, totalValue),
    buyShare: pct(buyVolume, totalVolume),
    sellShare: pct(sellVolume, totalVolume),
    buyTrades,
    sellTrades,
    tradeCount: selected.length,
    largestTradeValue,
    firstTime: selected[0]?.time || 0,
    lastTime: selected.at(-1)?.time || 0
  };
}

/* =========================================================
   FOOTPRINT LEVEL
========================================================= */

function createFootprintLevel(price) {
  return {
    price,

    bidVolume: 0,
    askVolume: 0,

    bidValue: 0,
    askValue: 0,

    bidTrades: 0,
    askTrades: 0,

    totalVolume: 0,
    totalValue: 0,

    delta: 0,
    deltaValue: 0,

    imbalance: 0,
    side: "NEUTRAL",

    largestTradeValue: 0
  };
}

/* =========================================================
   FOOTPRINT ONE CANDLE
========================================================= */

function footprintForCandle(
  candle,
  list,
  candleDuration,
  tickSize = 0
) {
  const start = candle.time;
  const end = start + candleDuration - 1;

  const levels = new Map();

  let buyVolume = 0;
  let sellVolume = 0;
  let buyValue = 0;
  let sellValue = 0;
  let buyTrades = 0;
  let sellTrades = 0;

  for (const t of list) {
    if (t.time < start) continue;
    if (t.time > end) break;

    const price = tickSize
      ? roundToStep(t.price, tickSize)
      : t.price;

    let level = levels.get(price);

    if (!level) {
      level = createFootprintLevel(price);
      levels.set(price, level);
    }

    const value = t.price * t.size;

    level.totalVolume += t.size;
    level.totalValue += value;
    level.largestTradeValue =
      Math.max(level.largestTradeValue, value);

    if (aggressorSide(t) === "BUY") {
      level.askVolume += t.size;
      level.askValue += value;
      level.askTrades++;

      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else {
      level.bidVolume += t.size;
      level.bidValue += value;
      level.bidTrades++;

      sellVolume += t.size;
      sellValue += value;
      sellTrades++;
    }
  }

  const output = [];

  for (const level of levels.values()) {
    level.delta =
      level.askVolume -
      level.bidVolume;

    level.deltaValue =
      level.askValue -
      level.bidValue;

    level.imbalance =
      level.bidVolume > 0
        ? level.askVolume / level.bidVolume
        : level.askVolume > 0
          ? Infinity
          : 0;

    if (
      level.askVolume > level.bidVolume
    ) {
      level.side = "BUY";
    } else if (
      level.bidVolume > level.askVolume
    ) {
      level.side = "SELL";
    } else {
      level.side = "NEUTRAL";
    }

    output.push(level);
  }

  output.sort((a, b) => b.price - a.price);

  const totalVolume =
    buyVolume + sellVolume;

  const totalValue =
    buyValue + sellValue;

  const delta =
    buyVolume - sellVolume;

  const deltaValue =
    buyValue - sellValue;

  return {
    time: candle.time,

    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,

    volume: candle.volume,

    flowVolume: totalVolume,

    buyVolume,
    sellVolume,

    buyValue,
    sellValue,

    buyTrades,
    sellTrades,

    tradeCount:
      buyTrades + sellTrades,

    totalValue,

    delta,
    deltaValue,

    deltaPercent:
      pct(delta, totalVolume),

    deltaValuePercent:
      pct(deltaValue, totalValue),

    levels:
      output.slice(-FOOTPRINT_MAX_LEVELS),

    imbalances:
      output.filter(
        x =>
          x.imbalance >= 3 ||
          (
            x.bidVolume > 0 &&
            x.askVolume / x.bidVolume <= 1 / 3
          )
      )
  };
}

/* =========================================================
   FAST FOOTPRINT BUILDER
========================================================= */

function buildFootprints(
  candles,
  tradeList,
  interval,
  tickSize
) {
  const duration = intervalMs(interval);

  const maps = new Map();

  for (const candle of candles) {
    maps.set(candle.time, new Map());
  }

  for (const t of tradeList) {
    const candleTime =
      Math.floor(t.time / duration) *
      duration;

    const map = maps.get(candleTime);

    if (!map) continue;

    const price = tickSize
      ? roundToStep(t.price, tickSize)
      : t.price;

    let level = map.get(price);

    if (!level) {
      level = createFootprintLevel(price);
      map.set(price, level);
    }

    const value = t.price * t.size;

    level.totalVolume += t.size;
    level.totalValue += value;

    level.largestTradeValue =
      Math.max(level.largestTradeValue, value);

    if (aggressorSide(t) === "BUY") {
      level.askVolume += t.size;
      level.askValue += value;
      level.askTrades++;
    } else {
      level.bidVolume += t.size;
      level.bidValue += value;
      level.bidTrades++;
    }
  }

  const footprints = [];
  let cumulativeDeltaValue = 0;

  for (const candle of candles) {
    const map = maps.get(candle.time) || new Map();

    let buyVolume = 0;
    let sellVolume = 0;
    let buyValue = 0;
    let sellValue = 0;
    let buyTrades = 0;
    let sellTrades = 0;

    const levels = [];

    for (const level of map.values()) {
      level.delta =
        level.askVolume -
        level.bidVolume;

      level.deltaValue =
        level.askValue -
        level.bidValue;

      level.imbalance =
        level.bidVolume > 0
          ? level.askVolume / level.bidVolume
          : level.askVolume > 0
            ? Infinity
            : 0;

      if (level.askVolume > level.bidVolume) {
        level.side = "BUY";
      } else if (level.bidVolume > level.askVolume) {
        level.side = "SELL";
      } else {
        level.side = "NEUTRAL";
      }

      buyVolume += level.askVolume;
      sellVolume += level.bidVolume;

      buyValue += level.askValue;
      sellValue += level.bidValue;

      buyTrades += level.askTrades;
      sellTrades += level.bidTrades;

      levels.push(level);
    }

    levels.sort((a, b) => b.price - a.price);

    const flowVolume =
      buyVolume + sellVolume;

    const totalValue =
      buyValue + sellValue;

    const delta =
      buyVolume - sellVolume;

    const deltaValue =
      buyValue - sellValue;

    cumulativeDeltaValue += deltaValue;

    footprints.push({
      time: candle.time,

      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,

      volume: candle.volume,

      flowVolume,

      buyVolume,
      sellVolume,

      buyValue,
      sellValue,

      buyTrades,
      sellTrades,

      tradeCount:
        buyTrades + sellTrades,

      totalValue,

      delta,
      deltaValue,

      deltaPercent:
        pct(delta, flowVolume),

      deltaValuePercent:
        pct(deltaValue, totalValue),

      cumulativeDeltaValue,

      levels:
        levels.slice(-FOOTPRINT_MAX_LEVELS),

      imbalances:
        levels.filter(
          x =>
            x.imbalance >= 3 ||
            (
              x.bidVolume > 0 &&
              x.askVolume / x.bidVolume <= 1 / 3
            )
        )
    });
  }

  return footprints;
}

/* =========================================================
   CANDLE DELTA
========================================================= */

function candleDeltaSeries(
  candles,
  footprints
) {
  const map = new Map(
    footprints.map(x => [x.time, x])
  );

  return candles.map(c => {
    const fp = map.get(c.time);

    return {
      time: c.time,
      buy: fp?.buyVolume || 0,
      sell: fp?.sellVolume || 0,
      delta: fp?.delta || 0,
      deltaValue: fp?.deltaValue || 0,
      deltaPercent: fp?.deltaPercent || 0,
      trades: fp?.tradeCount || 0,
      cumulativeDeltaValue:
        fp?.cumulativeDeltaValue || 0
    };
  });
}

/* =========================================================
   IMBALANCES
========================================================= */

function detectImbalances(footprints) {
  const result = [];

  for (const fp of footprints) {
    for (const level of fp.levels || []) {
      if (
        level.imbalance >= 3 ||
        (
          level.bidVolume > 0 &&
          level.askVolume / level.bidVolume <= 1 / 3
        )
      ) {
        result.push({
          time: fp.time,
          price: level.price,
          imbalance: level.imbalance,
          side: level.side,
          bidVolume: level.bidVolume,
          askVolume: level.askVolume,
          delta: level.delta,
          deltaValue: level.deltaValue
        });
      }
    }
  }

  return result.slice(-500);
}

/* =========================================================
   BLOCK TRADES
========================================================= */

function blockTrades(list) {
  if (!list.length) return [];

  const values =
    list.map(x => x.price * x.size)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  const averageNotional = avg(values);

  const p95 =
    values.length
      ? values[Math.floor(values.length * 0.95)]
      : 0;

  const threshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  return list
    .map(x => ({
      ...x,
      value: x.price * x.size,
      aggressor: aggressorSide(x)
    }))
    .filter(x => x.value >= threshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, 50);
}

/* =========================================================
   ORDERBOOK WALLS
========================================================= */

function median(values) {
  if (!values.length) return 0;

  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);

  return a.length % 2
    ? a[m]
    : (a[m - 1] + a[m]) / 2;
}

function wallAnalysis(book) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];

  const buyLiquidity = sum(
    bids.map(x => x.value)
  );

  const sellLiquidity = sum(
    asks.map(x => x.value)
  );

  const totalLiquidity =
    buyLiquidity + sellLiquidity;

  const buyShare =
    pct(buyLiquidity, totalLiquidity);

  const sellShare =
    pct(sellLiquidity, totalLiquidity);

  const bidMedian =
    median(bids.map(x => x.value));

  const askMedian =
    median(asks.map(x => x.value));

  const bidThreshold =
    bidMedian * 4;

  const askThreshold =
    askMedian * 4;

  const buyWalls =
    bids
      .filter(x => x.value >= bidThreshold)
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);

  const sellWalls =
    asks
      .filter(x => x.value >= askThreshold)
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);

  let pressure = "NEUTRAL";

  if (buyShare > sellShare + 8) {
    pressure = "BUY_PRESSURE";
  } else if (sellShare > buyShare + 8) {
    pressure = "SELL_PRESSURE";
  }

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    imbalance:
      buyShare - sellShare,
    pressure,
    buyWalls,
    sellWalls,
    nearBuyWall: buyWalls[0] || null,
    nearSellWall: sellWalls[0] || null,
    bestBid: book?.bestBid || 0,
    bestAsk: book?.bestAsk || 0
  };
}

/* =========================================================
   HEATMAP
========================================================= */

function liquidityHeatmap(book) {
  const bids = (book?.bids || [])
    .slice(0, HEATMAP_LEVELS);

  const asks = (book?.asks || [])
    .slice(0, HEATMAP_LEVELS);

  const allValues = [
    ...bids.map(x => x.value),
    ...asks.map(x => x.value)
  ];

  const maxValue =
    Math.max(...allValues, 1);

  return {
    bids: bids.map(x => ({
      ...x,
      intensity:
        clamp(x.value / maxValue, 0, 1)
    })),

    asks: asks.map(x => ({
      ...x,
      intensity:
        clamp(x.value / maxValue, 0, 1)
    })),

    maxValue
  };
}

/* =========================================================
   LIQUIDITY ZONES
========================================================= */

function liquidityZones(book, price = 0) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];

  const zones = [];

  const bidValues =
    bids.map(x => x.value);

  const askValues =
    asks.map(x => x.value);

  const bidMedian = median(bidValues);
  const askMedian = median(askValues);

  for (const x of bids) {
    if (
      bidMedian > 0 &&
      x.value >= bidMedian * 2
    ) {
      zones.push({
        side: "BUY",
        price: x.price,
        value: x.value,
        distancePercent:
          price
            ? Math.abs(
                pct(x.price - price, price)
              )
            : 0
      });
    }
  }

  for (const x of asks) {
    if (
      askMedian > 0 &&
      x.value >= askMedian * 2
    ) {
      zones.push({
        side: "SELL",
        price: x.price,
        value: x.value,
        distancePercent:
          price
            ? Math.abs(
                pct(x.price - price, price)
              )
            : 0
      });
    }
  }

  return zones
    .sort((a, b) => b.value - a.value)
    .slice(0, 50);
}

/* =========================================================
   SWEEP
========================================================= */

function detectSweep(candles) {
  if (candles.length < 5) {
    return {
      detected: false,
      side: "NONE",
      price: 0,
      strength: 0
    };
  }

  const c = candles.at(-1);
  const prev = candles.slice(-6, -1);

  const previousHigh =
    Math.max(...prev.map(x => x.high));

  const previousLow =
    Math.min(...prev.map(x => x.low));

  if (
    c.high > previousHigh &&
    c.close < previousHigh
  ) {
    return {
      detected: true,
      side: "SELL",
      type: "HIGH_SWEEP",
      price: c.high,
      strength:
        pct(c.high - c.close, c.high - c.low || 1)
    };
  }

  if (
    c.low < previousLow &&
    c.close > previousLow
  ) {
    return {
      detected: true,
      side: "BUY",
      type: "LOW_SWEEP",
      price: c.low,
      strength:
        pct(c.close - c.low, c.high - c.low || 1)
    };
  }

  return {
    detected: false,
    side: "NONE",
    price: 0,
    strength: 0
  };
}

/* =========================================================
   TRADE SWEEP
========================================================= */

function detectTradeSweep(list) {
  if (list.length < 10) {
    return {
      detected: false,
      side: "NONE",
      value: 0
    };
  }

  const recent = list.slice(-50);

  let buy = 0;
  let sell = 0;

  for (const x of recent) {
    const v = x.price * x.size;

    if (aggressorSide(x) === "BUY") {
      buy += v;
    } else {
      sell += v;
    }
  }

  if (
    buy > sell * 2
  ) {
    return {
      detected: true,
      side: "BUY",
      value: buy,
      ratio: sell ? buy / sell : Infinity
    };
  }

  if (
    sell > buy * 2
  ) {
    return {
      detected: true,
      side: "SELL",
      value: sell,
      ratio: buy ? sell / buy : Infinity
    };
  }

  return {
    detected: false,
    side: "NONE",
    value: Math.max(buy, sell),
    ratio: 1
  };
}

/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  candles,
  flow,
  book
) {
  const c = candles.at(-1);

  if (!c) {
    return {
      detected: false,
      side: "NONE",
      strength: 0
    };
  }

  const stats = candleStats(c);

  const range = stats.range || 1;

  const deltaPressure =
    Math.abs(flow.deltaPercent);

  const bodyPercent =
    stats.bodyPercent;

  const buyBook =
    book?.buyShare || 0;

  const sellBook =
    book?.sellShare || 0;

  if (
    flow.deltaPercent > 20 &&
    bodyPercent < 35 &&
    buyBook < sellBook + 5
  ) {
    return {
      detected: true,
      side: "SELL",
      type: "BUY_ABSORPTION",
      strength:
        clamp(
          deltaPressure +
          (35 - bodyPercent),
          0,
          100
        ),
      price: c.close,
      range
    };
  }

  if (
    flow.deltaPercent < -20 &&
    bodyPercent < 35 &&
    sellBook < buyBook + 5
  ) {
    return {
      detected: true,
      side: "BUY",
      type: "SELL_ABSORPTION",
      strength:
        clamp(
          deltaPressure +
          (35 - bodyPercent),
          0,
          100
        ),
      price: c.close,
      range
    };
  }

  return {
    detected: false,
    side: "NONE",
    strength: 0,
    price: c.close
  };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structure(candles) {
  if (candles.length < 10) {
    return {
      trend: "NEUTRAL",
      direction: "NEUTRAL",
      strength: 0
    };
  }

  const closes =
    candles.map(x => x.close);

  const short =
    sma(closes.slice(-5), 5);

  const long =
    sma(closes.slice(-20), 20);

  const last =
    closes.at(-1);

  const atrValue =
    atr(candles, 14) || 1;

  const distance =
    last - long;

  const strength =
    clamp(
      Math.abs(distance) /
      atrValue *
      25,
      0,
      100
    );

  if (short > long && last > long) {
    return {
      trend: "BULLISH",
      direction: "BUY",
      strength
    };
  }

  if (short < long && last < long) {
    return {
      trend: "BEARISH",
      direction: "SELL",
      strength
    };
  }

  return {
    trend: "NEUTRAL",
    direction: "NEUTRAL",
    strength
  };
}

/* =========================================================
   ENTRY 1M
========================================================= */

function entry1m(candles) {
  if (candles.length < 20) {
    return {
      direction: "WAIT",
      price: candles.at(-1)?.close || 0,
      confidence: 0
    };
  }

  const closes =
    candles.map(x => x.close);

  const ma20 =
    sma(closes, 20);

  const last =
    closes.at(-1);

  const r =
    rsi(candles, 14);

  if (
    last > ma20 &&
    r >= 50
  ) {
    return {
      direction: "BUY",
      price: last,
      confidence:
        clamp(
          50 + (r - 50),
          0,
          100
        ),
      ma20,
      rsi: r
    };
  }

  if (
    last < ma20 &&
    r <= 50
  ) {
    return {
      direction: "SELL",
      price: last,
      confidence:
        clamp(
          50 + (50 - r),
          0,
          100
        ),
      ma20,
      rsi: r
    };
  }

  return {
    direction: "WAIT",
    price: last,
    confidence: 40,
    ma20,
    rsi: r
  };
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles) {
  if (!candles.length) {
    return {
      supports: [],
      resistances: []
    };
  }

  const lows =
    candles.map(x => x.low)
      .sort((a, b) => a - b);

  const highs =
    candles.map(x => x.high)
      .sort((a, b) => a - b);

  const supports = [
    ...new Set(
      lows.slice(0, 8).map(x => Number(x))
    )
  ].sort((a, b) => b - a);

  const resistances = [
    ...new Set(
      highs.slice(-8).map(x => Number(x))
    )
  ].sort((a, b) => a - b);

  return {
    supports,
    resistances
  };
}

/* =========================================================
   PRESSURE
========================================================= */

function pressureFromFlow(flow) {
  if (flow.deltaPercent >= 10) {
    return "BUY_PRESSURE";
  }

  if (flow.deltaPercent <= -10) {
    return "SELL_PRESSURE";
  }

  return "NEUTRAL";
}

/* =========================================================
   MOVEMENT
========================================================= */

function movement(candles) {
  if (candles.length < 2) {
    return {
      percent: 0,
      direction: "NEUTRAL"
    };
  }

  const a = candles.at(-2).close;
  const b = candles.at(-1).close;

  const change = pct(b - a, a);

  return {
    percent: change,
    direction:
      change > 0
        ? "UP"
        : change < 0
          ? "DOWN"
          : "NEUTRAL"
  };
}

/* =========================================================
   STRUCTURAL ZONE
========================================================= */

function structuralZone(candles, price) {
  if (!candles.length || !price) {
    return {
      low: 0,
      high: 0,
      type: "NONE"
    };
  }

  const last20 =
    candles.slice(-20);

  const low =
    Math.min(...last20.map(x => x.low));

  const high =
    Math.max(...last20.map(x => x.high));

  const mid =
    (low + high) / 2;

  return {
    low,
    high,
    mid,
    type:
      price >= mid
        ? "PREMIUM"
        : "DISCOUNT"
  };
}

/* =========================================================
   BUILD CHART DATA
========================================================= */

async function buildChartData(
  symbol,
  interval = TF
) {
  interval = normalizeInterval(interval);

  symbol = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!symbol) {
    throw new Error("Symbol required");
  }

  const [
    candles,
    tick,
    book,
    tr,
    instrument
  ] = await Promise.all([
    kline(
      "linear",
      symbol,
      interval,
      CHART_LIMIT
    ),
    ticker("linear", symbol),
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
    instrument.tickSize || 0;

  const footprints =
    buildFootprints(
      candles,
      tr,
      interval,
      tickSize
    );

  const fpMap =
    new Map(
      footprints.map(x => [x.time, x])
    );

  let cumulativeDelta = 0;

  const chartCandles =
    candles.map(c => {
      const fp =
        fpMap.get(c.time);

      cumulativeDelta +=
        fp?.deltaValue || 0;

      return {
        ...c,

        volume: c.volume,

        flowVolume:
          fp?.flowVolume || 0,

        buyVolume:
          fp?.buyVolume || 0,

        sellVolume:
          fp?.sellVolume || 0,

        buyValue:
          fp?.buyValue || 0,

        sellValue:
          fp?.sellValue || 0,

        delta:
          fp?.delta || 0,

        deltaValue:
          fp?.deltaValue || 0,

        deltaPercent:
          fp?.deltaPercent || 0,

        tradeCount:
          fp?.tradeCount || 0,

        cumulativeDeltaValue:
          cumulativeDelta,

        footprint:
          fp?.levels || [],

        imbalances:
          fp?.imbalances || []
      };
    });

  const candleDelta =
    candleDeltaSeries(
      candles,
      footprints
    );

  const currentFlow =
    flowFromTrades(tr);

  const wall =
    wallAnalysis(book);

  const heatmap =
    liquidityHeatmap(book);

  const zones =
    liquidityZones(
      book,
      tick.lastPrice
    );

  const sweep =
    detectSweep(candles);

  const tradeSweep =
    detectTradeSweep(tr);

  const absorption =
    detectAbsorption(
      candles,
      currentFlow,
      wall
    );

  const blocks =
    blockTrades(tr);

  return {
    ok: true,
    version: VERSION,

    category: "linear",
    symbol,

    interval,
    intervalMs:
      intervalMs(interval),

    tickSize,
    priceStep: tickSize,
    levelMode: "TICK",

    serverTime: Date.now(),

    price: tick.lastPrice,

    ticker: tick,

    candles:
      chartCandles.slice(-CHART_LIMIT),

    footprints:
      footprints.slice(-CHART_LIMIT),

    candleDelta,

    cumulativeDelta,

    currentFlow,

    flow: currentFlow,

    orderbook: book,

    wall,

    heatmap,

    liquidityZones: zones,

    sweep,

    tradeSweep,

    absorption,

    blocks,

    imbalances:
      detectImbalances(
        footprints
      ),

    trades:
      tr.slice(-250)
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyze(
  symbol,
  selectedInterval = TF
) {
  symbol = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!symbol) {
    throw new Error("Symbol required");
  }

  selectedInterval =
    normalizeInterval(
      selectedInterval
    );

  const [
    candles5,
    candles15,
    candles3,
    candles1,
    tick,
    book,
    tr,
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
      TF15,
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
      TF1,
      KLINE_LIMIT
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
    instrument.tickSize || 0;

  const current5 =
    candles5.at(-1);

  const currentStart =
    current5?.time || 0;

  const currentEnd =
    currentStart +
    intervalMs(TF) -
    1;

  const historicalFlow =
    flowFromTrades(
      tr,
      currentStart,
      currentEnd
    );

  const currentFlow =
    historicalFlow.tradeCount >= 8
      ? historicalFlow
      : flowFromTrades(tr);

  const footprints =
    buildFootprints(
      candles5.slice(-100),
      tr,
      TF,
      tickSize
    );

  let cumulativeDelta = 0;

  for (const fp of footprints) {
    cumulativeDelta +=
      fp.deltaValue || 0;

    fp.cumulativeDeltaValue =
      cumulativeDelta;
  }

  const wall =
    wallAnalysis(book);

  const heatmap =
    liquidityHeatmap(book);

  const zones =
    liquidityZones(
      book,
      tick.lastPrice
    );

  const absorption =
    detectAbsorption(
      candles5,
      currentFlow,
      wall
    );

  const sweep =
    detectSweep(candles5);

  const tradeSweep =
    detectTradeSweep(tr);

  const structure5 =
    structure(candles5);

  const structure15 =
    structure(candles15);

  const structure3 =
    structure(candles3);

  const structure1 =
    structure(candles1);

  const pressure =
    pressureFromFlow(
      currentFlow
    );

  const move =
    movement(candles5);

  const zone =
    structuralZone(
      candles5,
      tick.lastPrice
    );

  const entry =
    entry1m(candles1);

  const sr =
    supportResistance(
      candles5
    );

  const oi =
    await oiFunding(symbol);

  const blocks =
    blockTrades(tr);

  let score = 50;

  if (
    structure15.direction === "BUY"
  ) score += 10;

  if (
    structure15.direction === "SELL"
  ) score -= 10;

  if (
    structure5.direction === "BUY"
  ) score += 8;

  if (
    structure5.direction === "SELL"
  ) score -= 8;

  if (
    currentFlow.deltaPercent > 10
  ) score += 10;

  if (
    currentFlow.deltaPercent < -10
  ) score -= 10;

  if (
    wall.pressure === "BUY_PRESSURE"
  ) score += 7;

  if (
    wall.pressure === "SELL_PRESSURE"
  ) score -= 7;

  if (
    absorption.detected &&
    absorption.side === "BUY"
  ) score += 8;

  if (
    absorption.detected &&
    absorption.side === "SELL"
  ) score -= 8;

  if (
    sweep.detected &&
    sweep.side === "BUY"
  ) score += 5;

  if (
    sweep.detected &&
    sweep.side === "SELL"
  ) score -= 5;

  score = Math.round(
    clamp(score, 0, 100)
  );

  let signal = "WAIT";

  if (score >= 70) {
    signal = "BUY";
  } else if (score <= 30) {
    signal = "SELL";
  }

  const reasons = [];

  if (
    currentFlow.deltaPercent > 10
  ) {
    reasons.push(
      "فشار خرید در معاملات واقعی"
    );
  }

  if (
    currentFlow.deltaPercent < -10
  ) {
    reasons.push(
      "فشار فروش در معاملات واقعی"
    );
  }

  if (
    wall.pressure === "BUY_PRESSURE"
  ) {
    reasons.push(
      "برتری نقدینگی سمت Bid"
    );
  }

  if (
    wall.pressure === "SELL_PRESSURE"
  ) {
    reasons.push(
      "برتری نقدینگی سمت Ask"
    );
  }

  if (
    absorption.detected
  ) {
    reasons.push(
      `Absorption ${absorption.side}`
    );
  }

  if (
    sweep.detected
  ) {
    reasons.push(
      `Sweep ${sweep.side}`
    );
  }

  return {
    ok: true,
    version: VERSION,

    category: "linear",
    symbol,

    interval:
      selectedInterval,

    intervalMs:
      intervalMs(selectedInterval),

    tickSize,
    priceStep: tickSize,
    levelMode: "TICK",

    serverTime: Date.now(),

    price: tick.lastPrice,

    ticker: tick,

    candles: {
      tf5: candles5,
      tf15: candles15,
      tf3: candles3,
      tf1: candles1
    },

    selectedCandles:
      selectedInterval === "15"
        ? candles15
        : selectedInterval === "3"
          ? candles3
          : selectedInterval === "1"
            ? candles1
            : selectedInterval === "5"
              ? candles5
              : await kline(
                  "linear",
                  symbol,
                  selectedInterval,
                  CHART_LIMIT
                ),

    footprint: {
      interval: TF,
      intervalMs: intervalMs(TF),
      tickSize,
      levelMode: "TICK",
      candles: footprints,
      cumulativeDeltaValue:
        cumulativeDelta
    },

    footprints,

    candleDelta:
      candleDeltaSeries(
        candles5,
        footprints
      ),

    cumulativeDelta,

    orderbook: book,

    wall,

    heatmap,

    liquidityZones: zones,

    trades:
      tr.slice(-250),

    currentFlow,

    historicalFlow,

    flow: currentFlow,

    absorption,

    blocks,

    sweep,

    tradeSweep,

    structure: {
      tf5: structure5,
      tf15: structure15,
      tf3: structure3,
      tf1: structure1
    },

    supportResistance: sr,

    timeframes: {
      tf5: structure5,
      tf15: structure15,
      tf3: structure3,
      tf1: structure1
    },

    movement: move,

    pressure,

    oiFunding: oi,

    entry1m: entry,

    zone,

    score,

    signal,

    reasons
  };
}

/* =========================================================
   LIVE
========================================================= */

async function live(
  symbol,
  interval = TF
) {
  symbol = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  interval =
    normalizeInterval(interval);

  const [
    tick,
    book,
    tr,
    candles,
    instrument
  ] = await Promise.all([
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
    kline(
      "linear",
      symbol,
      interval,
      CHART_LIMIT
    ),
    instrumentInfo(
      "linear",
      symbol
    )
  ]);

  const tickSize =
    instrument.tickSize || 0;

  const footprints =
    buildFootprints(
      candles,
      tr,
      interval,
      tickSize
    );

  let cumulativeDelta = 0;

  const fpMap =
    new Map(
      footprints.map(x => [x.time, x])
    );

  const candleFlow =
    candles.map(c => {
      const fp =
        fpMap.get(c.time);

      cumulativeDelta +=
        fp?.deltaValue || 0;

      return {
        ...c,

        volume:
          c.volume,

        flowVolume:
          fp?.flowVolume || 0,

        buyVolume:
          fp?.buyVolume || 0,

        sellVolume:
          fp?.sellVolume || 0,

        buyValue:
          fp?.buyValue || 0,

        sellValue:
          fp?.sellValue || 0,

        delta:
          fp?.delta || 0,

        deltaValue:
          fp?.deltaValue || 0,

        deltaPercent:
          fp?.deltaPercent || 0,

        tradeCount:
          fp?.tradeCount || 0,

        cumulativeDeltaValue:
          cumulativeDelta,

        footprint:
          fp?.levels || [],

        imbalances:
          fp?.imbalances || []
      };
    });

  const currentFlow =
    flowFromTrades(tr);

  const wall =
    wallAnalysis(book);

  const heatmap =
    liquidityHeatmap(book);

  const zones =
    liquidityZones(
      book,
      tick.lastPrice
    );

  const sweep =
    detectSweep(candles);

  const tradeSweep =
    detectTradeSweep(tr);

  const absorption =
    detectAbsorption(
      candles,
      currentFlow,
      wall
    );

  const blocks =
    blockTrades(tr);

  return {
    ok: true,
    version: VERSION,

    category: "linear",
    symbol,

    interval,
    intervalMs:
      intervalMs(interval),

    tickSize,
    priceStep: tickSize,
    levelMode: "TICK",

    serverTime: Date.now(),

    price:
      tick.lastPrice,

    ticker: tick,

    candles:
      candleFlow,

    candleFlow,

    footprints,

    candleDelta:
      candleDeltaSeries(
        candles,
        footprints
      ),

    cumulativeDelta,

    orderbook: book,

    wall,

    heatmap,

    liquidityZones:
      zones,

    sweep,

    tradeSweep,

    absorption,

    blocks,

    trades:
      tr.slice(-250),

    flow:
      currentFlow,

    currentFlow
  };
}

/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {
  const data =
    await bybit(
      "/v5/market/instruments-info",
      {
        category: "linear",
        limit: 1000
      }
    );

  return (data?.result?.list || [])
    .filter(
      x =>
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType === "LinearPerpetual"
    )
    .map(x => ({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      tickSize:
        n(x.priceFilter?.tickSize),
      qtyStep:
        n(x.lotSizeFilter?.qtyStep)
    }))
    .slice(0, MAX_SYMBOLS);
}

/* =========================================================
   SCAN
========================================================= */

async function scan(
  offset = 0
) {
  const symbols =
    await getSymbols();

  const start =
    Number(offset) || 0;

  const batch =
    symbols.slice(
      start,
      start + SCAN_BATCH
    );

  const results = [];

  for (const item of batch) {
    try {
      const x =
        await analyze(
          item.symbol,
          TF
        );

      if (
        Number(x.score) >= 55
      ) {
        results.push({
          symbol: item.symbol,
          score: x.score,
          signal: x.signal,
          price: x.price,
          pressure: x.pressure,
          movement: x.movement,
          structure: x.structure,
          delta:
            x.currentFlow?.delta || 0,
          deltaPercent:
            x.currentFlow?.deltaPercent || 0,
          absorption:
            x.absorption,
          sweep:
            x.sweep
        });
      }
    } catch (e) {
      results.push({
        symbol: item.symbol,
        error: e.message
      });
    }

    await sleep(20);
  }

  return {
    ok: true,
    version: VERSION,
    offset: start,
    nextOffset:
      start + SCAN_BATCH >= symbols.length
        ? 0
        : start + SCAN_BATCH,
    totalSymbols:
      symbols.length,
    results:
      results
        .filter(x => !x.error)
        .sort(
          (a, b) =>
            b.score - a.score
        )
  };
}

/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request, env, ctx) {
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods":
            "GET,OPTIONS",
          "access-control-allow-headers":
            "*"
        }
      });
    }

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {
      if (
        path === "/api/health"
      ) {
        return json({
          ok: true,
          version: VERSION,
          service:
            "Bybit Absorption Order Flow",
          time: Date.now()
        });
      }

      if (
        path === "/api/test-bybit"
      ) {
        const x =
          await bybit(
            "/v5/market/time"
          );

        return json({
          ok: true,
          version: VERSION,
          bybit: x,
          time: Date.now()
        });
      }

      if (
        path === "/api/analyze"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) || TF
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        return json(
          await analyze(
            symbol,
            interval
          )
        );
      }

      if (
        path === "/api/chart"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) || TF
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        return json(
          await buildChartData(
            symbol,
            interval
          )
        );
      }

      if (
        path === "/api/live"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) || TF
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        return json(
          await live(
            symbol,
            interval
          )
        );
      }

      if (
        path === "/api/scan"
      ) {
        const offset =
          Number(
            url.searchParams.get(
              "offset"
            ) || 0
          );

        return json(
          await scan(offset)
        );
      }

      if (
        path === "/api/symbols"
      ) {
        return json({
          ok: true,
          version: VERSION,
          symbols:
            await getSymbols()
        });
      }

      if (
        env?.ASSETS?.fetch
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return new Response(
        "Not Found",
        {
          status: 404
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
        500
      );
    }
  }
};
