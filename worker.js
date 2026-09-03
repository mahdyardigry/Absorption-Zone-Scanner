const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ZONE-SCANNER-V4-REAL-ABSORPTION";

const MAIN_TF = "5";
const CONFIRM_TF_15M = "15";
const CONFIRM_TF_3M = "3";
const CONFIRM_TF_1M = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const MIN_VOLUME_RATIO = 1.35;
const MIN_ABSORPTION_SCORE = 60;

const RETEST_LOOKBACK_CANDLES = 18;
const RETEST_MAX_DISTANCE_PERCENT = 0.60;
const RETEST_CONFIRMATION_BARS = 3;

const ABSORPTION_LOOKBACK_TRADES = 1000;
const ABSORPTION_MIN_TRADES = 30;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function avg(arr) {
  const x = arr.filter(Number.isFinite);
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0;
}

function median(arr) {
  const x = arr
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!x.length) return 0;

  const m = Math.floor(x.length / 2);

  return x.length % 2
    ? x[m]
    : (x[m - 1] + x[m]) / 2;
}

function round(v, d = 4) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

async function bybit(path, params = {}) {
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, String(value));
    }
  }

  const url = `${BYBIT}${path}?${qs.toString()}`;

  const response = await fetch(url, {
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
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data.result;
}

/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {
  const result = await bybit(
    "/v5/market/instruments-info",
    {
      category: "linear",
      status: "Trading",
      limit: 1000
    }
  );

  const list = result.list || [];

  return list
    .filter(x =>
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual" &&
      x.status === "Trading"
    )
    .map(x => ({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      tickSize: num(x.priceFilter?.tickSize),
      qtyStep: num(x.lotSizeFilter?.qtyStep),
      minQty: num(x.lotSizeFilter?.minOrderQty)
    }));
}

async function getTickers() {
  const result = await bybit(
    "/v5/market/tickers",
    {
      category: "linear"
    }
  );

  return result.list || [];
}

async function getSymbolsRanked() {
  const [symbols, tickers] = await Promise.all([
    getSymbols(),
    getTickers()
  ]);

  const tickerMap = new Map(
    tickers.map(t => [t.symbol, t])
  );

  return symbols
    .map(s => {
      const t = tickerMap.get(s.symbol);

      return {
        ...s,
        lastPrice: num(t?.lastPrice),
        turnover24h: num(t?.turnover24h),
        volume24h: num(t?.volume24h),
        price24hPcnt: num(t?.price24hPcnt) * 100
      };
    })
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, MAX_SYMBOLS);
}

/* =========================================================
   KLINES
========================================================= */

async function getKlines(symbol, interval, limit = KLINE_LIMIT) {
  const result = await bybit(
    "/v5/market/kline",
    {
      category: "linear",
      symbol,
      interval,
      limit
    }
  );

  return (result.list || [])
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }))
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   TECHNICAL
========================================================= */

function sma(values, period) {
  if (values.length < period) return null;

  return avg(
    values.slice(values.length - period)
  );
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let e = avg(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  gain /= period;
  loss /= period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);

    gain = ((gain * (period - 1)) + g) / period;
    loss = ((loss * (period - 1)) + l) / period;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

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

  return avg(trs.slice(-period));
}

function candleStats(c) {
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const body = Math.abs(c.close - c.open);

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  return {
    range,
    body,
    bodyRatio: body / range,
    upperWick,
    lowerWick,
    lowerWickRatio: lowerWick / range,
    upperWickRatio: upperWick / range,
    changePercent: pct(c.close, c.open),
    bullish: c.close > c.open,
    bearish: c.close < c.open,
    neutral: Math.abs(pct(c.close, c.open)) <= 0.15
  };
}

function volumeAnalysis(candles, index) {
  const c = candles[index];

  const previous = candles
    .slice(Math.max(0, index - 20), index)
    .map(x => x.volume);

  const average = avg(previous);

  return {
    current: c.volume,
    average,
    ratio: average ? c.volume / average : 0,
    high: average ? c.volume / average >= MIN_VOLUME_RATIO : false
  };
}

/* =========================================================
   PUMP
========================================================= */

function detectPump(candles, index) {
  if (index < 12) {
    return {
      detected: false,
      score: 0,
      pumpPercent: 0,
      rangeMove: 0
    };
  }

  const start = candles[index - 12];
  const current = candles[index];

  const pumpPercent = pct(
    current.close,
    start.close
  );

  const highest = Math.max(
    ...candles.slice(index - 12, index + 1).map(x => x.high)
  );

  const lowest = Math.min(
    ...candles.slice(index - 12, index + 1).map(x => x.low)
  );

  const rangeMove = pct(highest, lowest);

  const greenCount =
    candles
      .slice(index - 12, index)
      .filter(x => x.close > x.open)
      .length;

  let score = 0;

  if (pumpPercent >= 1) {
    score += clamp(pumpPercent * 8, 0, 35);
  }

  if (rangeMove >= 1.5) {
    score += clamp(rangeMove * 5, 0, 25);
  }

  score += clamp(greenCount / 12 * 25, 0, 25);

  const detected =
    pumpPercent >= 2 ||
    rangeMove >= 2;

  return {
    detected,
    score: round(clamp(score, 0, 100), 2),
    pumpPercent: round(pumpPercent, 3),
    rangeMove: round(rangeMove, 3),
    greenRatio: round(greenCount / 12, 3)
  };
}

/* =========================================================
   REAL TRADES
========================================================= */

async function getRecentTrades(symbol) {
  const result = await bybit(
    "/v5/market/recent-trade",
    {
      category: "linear",
      symbol,
      limit: TRADE_LIMIT
    }
  );

  return (result.list || [])
    .map(t => ({
      id: t.execId || t.id || "",
      time: num(t.time),
      price: num(t.price),
      qty: num(t.size),
      side: String(t.side || "").toLowerCase(),
      value: num(t.price) * num(t.size)
    }))
    .filter(t =>
      t.price > 0 &&
      t.qty > 0
    )
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   REAL ABSORPTION
=========================================================

اصل تشخیص:

فشار یک طرفه واقعی
+
حجم بالا
+
حرکت کم قیمت
+
حفظ محدوده
+
برگشت قیمت
=
جذب احتمالی قوی

BUYER ABSORPTION:

فروش زیاد
+
قیمت پایین نمی‌رود
+
کف حفظ می‌شود
+
برگشت بالا

SELLER ABSORPTION:

خرید زیاد
+
قیمت بالا نمی‌رود
+
سقف حفظ می‌شود
+
برگشت پایین
========================================================= */

function tradesInWindow(trades, startTime, endTime) {
  return trades.filter(
    t =>
      t.time >= startTime &&
      t.time <= endTime
  );
}

function analyzeTradePressure(trades) {
  const buy = trades.filter(
    t => t.side === "buy"
  );

  const sell = trades.filter(
    t => t.side === "sell"
  );

  const buyVolume = buy.reduce(
    (s, t) => s + t.qty,
    0
  );

  const sellVolume = sell.reduce(
    (s, t) => s + t.qty,
    0
  );

  const buyValue = buy.reduce(
    (s, t) => s + t.value,
    0
  );

  const sellValue = sell.reduce(
    (s, t) => s + t.value,
    0
  );

  const totalValue =
    buyValue + sellValue;

  const totalVolume =
    buyVolume + sellVolume;

  const deltaValue =
    buyValue - sellValue;

  const deltaPercent =
    totalValue
      ? deltaValue / totalValue * 100
      : 0;

  return {
    buyTrades: buy.length,
    sellTrades: sell.length,

    buyVolume,
    sellVolume,

    buyValue,
    sellValue,

    totalVolume,
    totalValue,

    deltaValue,
    deltaPercent
  };
}

function realAbsorptionAtCandle(
  candles,
  index,
  trades
) {
  if (
    index < 1 ||
    !trades.length
  ) {
    return {
      detected: false,
      score: 0,
      direction: "UNKNOWN",
      label: "جذب قطعی نیست"
    };
  }

  const candle = candles[index];

  const previous = candles[
    Math.max(0, index - 4)
  ];

  const startTime = previous.time;
  const endTime =
    candle.time + 5 * 60 * 1000;

  const windowTrades =
    tradesInWindow(
      trades,
      startTime,
      endTime
    );

  if (
    windowTrades.length <
    ABSORPTION_MIN_TRADES
  ) {
    return {
      detected: false,
      score: 0,
      direction: "UNKNOWN",
      label: "معاملات کافی برای تشخیص جذب وجود ندارد",
      tradeCount: windowTrades.length
    };
  }

  const pressure =
    analyzeTradePressure(
      windowTrades
    );

  const stats =
    candleStats(candle);

  const previousClose =
    candles[Math.max(0, index - 1)].close;

  const priceMove =
    pct(candle.close, previousClose);

  const rangePercent =
    pct(candle.high, candle.low);

  const buyShare =
    pressure.totalValue
      ? pressure.buyValue /
        pressure.totalValue
      : 0;

  const sellShare =
    pressure.totalValue
      ? pressure.sellValue /
        pressure.totalValue
      : 0;

  /*
   * BUYER ABSORPTION
   *
   * فروشندگان فعال هستند
   * ولی قیمت نمی‌تواند پایین برود.
   */

  const sellerPressure =
    sellShare >= 0.55;

  const buyerPressure =
    buyShare >= 0.55;

  const lowHolding =
    priceMove > -0.80;

  const highHolding =
    priceMove < 0.80;

  const strongLowerWick =
    stats.lowerWickRatio >= 0.25;

  const strongUpperWick =
    stats.upperWickRatio >= 0.25;

  const smallBody =
    stats.bodyRatio <= 0.50;

  let buyerScore = 0;
  let sellerScore = 0;

  if (sellerPressure) {
    buyerScore += clamp(
      (sellShare - 0.50) * 100,
      0,
      20
    );
  }

  if (lowHolding) {
    buyerScore += 18;
  }

  if (strongLowerWick) {
    buyerScore += 18;
  }

  if (smallBody) {
    buyerScore += 10;
  }

  if (candle.close >= candle.open) {
    buyerScore += 15;
  }

  /*
   * SELLER ABSORPTION
   */

  if (buyerPressure) {
    sellerScore += clamp(
      (buyShare - 0.50) * 100,
      0,
      20
    );
  }

  if (highHolding) {
    sellerScore += 18;
  }

  if (strongUpperWick) {
    sellerScore += 18;
  }

  if (smallBody) {
    sellerScore += 10;
  }

  if (candle.close <= candle.open) {
    sellerScore += 15;
  }

  /*
   * حجم واقعی معاملات
   */

  const notionalValues =
    windowTrades.map(
      t => t.value
    );

  const medianValue =
    median(notionalValues);

  const totalValue =
    pressure.totalValue;

  const highActivity =
    medianValue > 0 &&
    totalValue >
    medianValue *
    windowTrades.length *
    1.2;

  if (highActivity) {
    buyerScore += 10;
    sellerScore += 10;
  }

  buyerScore =
    clamp(buyerScore, 0, 100);

  sellerScore =
    clamp(sellerScore, 0, 100);

  let direction = "UNKNOWN";
  let score = 0;
  let label = "جهت جذب قطعی نیست";

  if (
    buyerScore >= 60 &&
    buyerScore > sellerScore + 8
  ) {
    direction = "BUYER";
    score = buyerScore;
    label =
      "جذب فروشندگان توسط خریداران";
  }

  if (
    sellerScore >= 60 &&
    sellerScore > buyerScore + 8
  ) {
    direction = "SELLER";
    score = sellerScore;
    label =
      "جذب خریداران توسط فروشندگان";
  }

  return {
    detected:
      score >= MIN_ABSORPTION_SCORE,

    score: round(score, 2),

    direction,
    label,

    tradeCount:
      windowTrades.length,

    buyTrades:
      pressure.buyTrades,

    sellTrades:
      pressure.sellTrades,

    buyVolume:
      round(pressure.buyVolume, 6),

    sellVolume:
      round(pressure.sellVolume, 6),

    buyValue:
      round(pressure.buyValue, 2),

    sellValue:
      round(pressure.sellValue, 2),

    deltaValue:
      round(pressure.deltaValue, 2),

    deltaPercent:
      round(pressure.deltaPercent, 2),

    buyShare:
      round(buyShare * 100, 2),

    sellShare:
      round(sellShare * 100, 2),

    priceMove:
      round(priceMove, 3),

    rangePercent:
      round(rangePercent, 3),

    lowerWickRatio:
      round(stats.lowerWickRatio, 3),

    upperWickRatio:
      round(stats.upperWickRatio, 3),

    bodyRatio:
      round(stats.bodyRatio, 3),

    historicalMatched: true,

    startTime,
    endTime
  };
}

/* =========================================================
   ABSORPTION SETUP
========================================================= */

function findAbsorptionSetup(
  candles,
  trades
) {
  let best = null;

  const start =
    Math.max(20, candles.length - 60);

  for (
    let i = start;
    i < candles.length - 1;
    i++
  ) {
    const pump =
      detectPump(candles, i);

    const stats =
      candleStats(candles[i]);

    const volume =
      volumeAnalysis(candles, i);

    const real =
      realAbsorptionAtCandle(
        candles,
        i,
        trades
      );

    const weakRed =
      stats.bearish &&
      Math.abs(stats.changePercent) <= 1.5;

    const neutral =
      stats.neutral;

    const bullishContext =
      candles
        .slice(Math.max(0, i - 5), i)
        .filter(
          x => x.close > x.open
        ).length >= 3;

    const technicalScore =
      (
        (weakRed ? 18 : 0) +
        (neutral ? 12 : 0) +
        clamp(
          volume.ratio * 10,
          0,
          20
        ) +
        clamp(
          stats.lowerWickRatio * 30,
          0,
          18
        ) +
        (stats.bodyRatio <= 0.45 ? 10 : 0) +
        (bullishContext ? 10 : 0)
      );

    /*
     * مهم:
     *
     * جذب واقعی وزن بسیار بیشتری از
     * شکل کندل دارد.
     */

    const combined =
      technicalScore * 0.35 +
      real.score * 0.65;

    if (
      !real.detected
    ) {
      continue;
    }

    if (
      !pump.detected &&
      combined < 70
    ) {
      continue;
    }

    const zoneLow =
      candles[i].low;

    const zoneHigh =
      Math.max(
        candles[i].open,
        candles[i].close
      );

    const candidate = {
      index: i,
      time: candles[i].time,

      pump,

      candle: stats,

      volume,

      technicalScore:
        round(technicalScore, 2),

      realAbsorption: real,

      score:
        round(
          clamp(combined, 0, 100),
          2
        ),

      zone: {
        low: zoneLow,
        high: zoneHigh,
        width: zoneHigh - zoneLow
      }
    };

    if (
      !best ||
      candidate.score > best.score
    ) {
      best = candidate;
    }
  }

  return best;
}

/* =========================================================
   ORDERBOOK
========================================================= */

async function getOrderbook(symbol) {
  const result = await bybit(
    "/v5/market/orderbook",
    {
      category: "linear",
      symbol,
      limit: ORDERBOOK_LIMIT
    }
  );

  const bids =
    result.b || [];

  const asks =
    result.a || [];

  const bidValue =
    bids.reduce(
      (s, x) =>
        s +
        num(x[0]) *
        num(x[1]),
      0
    );

  const askValue =
    asks.reduce(
      (s, x) =>
        s +
        num(x[0]) *
        num(x[1]),
      0
    );

  const total =
    bidValue + askValue;

  const imbalance =
    total
      ? (bidValue - askValue) /
        total * 100
      : 0;

  const strongestBid =
    bids
      .map(x => ({
        price: num(x[0]),
        qty: num(x[1]),
        value:
          num(x[0]) *
          num(x[1])
      }))
      .sort((a, b) =>
        b.value - a.value
      )[0] || null;

  const strongestAsk =
    asks
      .map(x => ({
        price: num(x[0]),
        qty: num(x[1]),
        value:
          num(x[0]) *
          num(x[1])
      }))
      .sort((a, b) =>
        b.value - a.value
      )[0] || null;

  let pressure =
    "NEUTRAL";

  if (imbalance >= 8) {
    pressure = "BUY";
  }

  if (imbalance <= -8) {
    pressure = "SELL";
  }

  return {
    bidValue,
    askValue,
    totalLiquidity: total,
    imbalance,
    pressure,

    bestBid:
      bids.length
        ? num(bids[0][0])
        : 0,

    bestAsk:
      asks.length
        ? num(asks[0][0])
        : 0,

    strongestBid,
    strongestAsk,

    bidCount: bids.length,
    askCount: asks.length
  };
}

/* =========================================================
   OPEN INTEREST
========================================================= */

async function getOpenInterest(symbol) {
  try {
    const result =
      await bybit(
        "/v5/market/open-interest",
        {
          category: "linear",
          symbol,
          intervalTime: "5min",
          limit: 10
        }
      );

    const list =
      result.list || [];

    if (!list.length) {
      return {
        current: 0,
        previous: 0,
        change: 0,
        changePercent: 0
      };
    }

    const current =
      num(list[0].openInterest);

    const previous =
      num(
        list[1]?.openInterest
      );

    const change =
      current - previous;

    const changePercent =
      previous
        ? change / previous * 100
        : 0;

    return {
      current,
      previous,
      change,
      changePercent
    };
  } catch {
    return {
      current: 0,
      previous: 0,
      change: 0,
      changePercent: 0
    };
  }
}

/* =========================================================
   TIMEFRAME CONFIRMATION
========================================================= */

function timeframeConfirmation(candles) {
  if (candles.length < 25) {
    return {
      trend: "NEUTRAL",
      score: 50,
      ema8: 0,
      ema20: 0,
      price: candles.at(-1)?.close || 0
    };
  }

  const closes =
    candles.map(x => x.close);

  const price =
    closes.at(-1);

  const ema8 =
    ema(closes, 8);

  const ema20 =
    ema(closes, 20);

  if (
    price > ema8 &&
    ema8 > ema20
  ) {
    return {
      trend: "BULLISH",
      score: 100,
      ema8,
      ema20,
      price
    };
  }

  if (
    price < ema8 &&
    ema8 < ema20
  ) {
    return {
      trend: "BEARISH",
      score: 0,
      ema8,
      ema20,
      price
    };
  }

  return {
    trend: "NEUTRAL",
    score: 50,
    ema8,
    ema20,
    price
  };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structureAnalysis(candles) {
  if (candles.length < 10) {
    return {
      trend: "NEUTRAL",
      bos: false,
      higherHigh: false,
      higherLow: false
    };
  }

  const recent =
    candles.slice(-10);

  const highs =
    recent.map(x => x.high);

  const lows =
    recent.map(x => x.low);

  const previousHigh =
    Math.max(...highs.slice(0, 5));

  const currentHigh =
    Math.max(...highs.slice(5));

  const previousLow =
    Math.min(...lows.slice(0, 5));

  const currentLow =
    Math.min(...lows.slice(5));

  const higherHigh =
    currentHigh > previousHigh;

  const higherLow =
    currentLow > previousLow;

  const lowerHigh =
    currentHigh < previousHigh;

  const lowerLow =
    currentLow < previousLow;

  let trend = "NEUTRAL";

  if (
    higherHigh &&
    higherLow
  ) {
    trend = "BULLISH";
  }

  if (
    lowerHigh &&
    lowerLow
  ) {
    trend = "BEARISH";
  }

  return {
    trend,

    bos:
      higherHigh ||
      lowerLow,

    higherHigh,
    higherLow,

    lowerHigh,
    lowerLow,

    recentHigh:
      currentHigh,

    recentLow:
      currentLow
  };
}

/* =========================================================
   RETEST
========================================================= */

function detectRetest(
  candles,
  zone
) {
  if (
    !zone ||
    candles.length < 5
  ) {
    return {
      detected: false,
      confirmed: false,
      reason: "ناحیه جذب موجود نیست"
    };
  }

  const zoneWidth =
    Math.max(
      zone.high - zone.low,
      zone.high * 0.0005
    );

  const tolerance =
    Math.max(
      zoneWidth * 0.15,
      zone.high * 0.001
    );

  const start =
    Math.max(
      0,
      candles.length -
      RETEST_LOOKBACK_CANDLES
    );

  let detectedIndex = -1;
  let rejection = false;

  for (
    let i = start;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const near =
      c.low <=
        zone.high + tolerance &&
      c.high >=
        zone.low - tolerance;

    if (!near) continue;

    detectedIndex = i;

    if (
      c.close > zone.high &&
      c.close > c.open
    ) {
      rejection = true;
    }
  }

  const current =
    candles.at(-1);

  const currentNear =
    current.low <=
      zone.high + tolerance &&
    current.high >=
      zone.low - tolerance;

  const above =
    current.close >
    zone.high;

  const confirmed =
    detectedIndex >= 0 &&
    (
      rejection &&
      currentNear
    ) ||
    (
      rejection &&
      above
    );

  const distance =
    Math.min(
      Math.abs(
        current.close -
        zone.low
      ),
      Math.abs(
        current.close -
        zone.high
      )
    );

  const distancePercent =
    zone.high
      ? distance /
        zone.high *
        100
      : 0;

  let reason =
    "ری‌تست هنوز تأیید نشده است";

  if (confirmed) {
    reason =
      "قیمت ناحیه جذب را مجدداً لمس کرده و واکنش تأییدکننده نشان داده است";
  } else if (currentNear) {
    reason =
      "قیمت در محدوده ناحیه جذب است؛ منتظر تأیید واکنش هستیم";
  }

  return {
    detected:
      detectedIndex >= 0,

    confirmed,

    index:
      detectedIndex,

    barsSinceRetest:
      detectedIndex >= 0
        ? candles.length -
          1 -
          detectedIndex
        : null,

    zoneHigh:
      zone.high,

    zoneLow:
      zone.low,

    tolerance,

    distanceToZone:
      distance,

    distancePercent,

    rejection,

    currentNear,

    currentPrice:
      current.close,

    reason,

    status:
      confirmed
        ? "CONFIRMED"
        : currentNear
          ? "WAITING"
          : "NONE"
  };
}

/* =========================================================
   1 MINUTE ENTRY
========================================================= */

function calculateEntry1M(
  candles,
  zone,
  direction
) {
  if (
    !candles?.length ||
    !zone
  ) {
    return {
      status: "INVALID",
      direction: "WAIT",
      reason:
        "اطلاعات کافی برای نقطه ورود وجود ندارد"
    };
  }

  const current =
    candles.at(-1);

  const closes =
    candles.map(x => x.close);

  const ema8 =
    ema(closes, 8);

  const ema20 =
    ema(closes, 20);

  const atrValue =
    atr(candles, 14) ||
    current.close * 0.002;

  const bullish =
    ema8 > ema20 &&
    current.close > ema8;

  const bearish =
    ema8 < ema20 &&
    current.close < ema8;

  const latestBullish =
    current.close > current.open;

  const latestBearish =
    current.close < current.open;

  const nearZone =
    current.low <=
      zone.high +
      atrValue * 0.35 &&
    current.high >=
      zone.low -
      atrValue * 0.35;

  const trigger =
    current.high +
    atrValue * 0.10;

  const stopLoss =
    zone.low -
    atrValue * 0.25;

  const risk =
    trigger - stopLoss;

  if (direction === "LONG") {
    if (
      bearish &&
      current.close < zone.low
    ) {
      return {
        status: "INVALID",
        direction: "LONG",
        currentPrice: current.close,
        reason:
          "قیمت زیر ناحیه جذب قرار گرفته و ورود خرید معتبر نیست",
        ema8,
        ema20
      };
    }

    if (
      bullish &&
      nearZone &&
      latestBullish
    ) {
      const target1 =
        trigger + risk * 1.5;

      const target2 =
        trigger + risk * 2.5;

      return {
        status: "READY",
        direction: "LONG",

        currentPrice:
          current.close,

        entryLow:
          zone.low,

        entryHigh:
          zone.high,

        trigger,

        stopLoss,

        target1,
        target2,

        riskPercent:
          trigger
            ? risk /
              trigger *
              100
            : 0,

        ema8,
        ema20,

        reason:
          "روند 1 دقیقه‌ای صعودی است، قیمت به ناحیه جذب نزدیک است و کندل تأیید صعودی تشکیل شده است"
      };
    }

    return {
      status: "WAIT",
      direction: "LONG",

      currentPrice:
        current.close,

      entryLow:
        zone.low,

      entryHigh:
        zone.high,

      trigger,

      stopLoss,

      ema8,
      ema20,

      reason:
        bullish
          ? "روند 1 دقیقه‌ای مناسب است؛ منتظر ورود قیمت به ناحیه و شکست سقف کندل تأیید باشید"
          : "تأیید 1 دقیقه‌ای هنوز صعودی نیست"
    };
  }

  if (direction === "SHORT") {
    if (
      bullish &&
      current.close > zone.high
    ) {
      return {
        status: "INVALID",
        direction: "SHORT",
        currentPrice: current.close,
        reason:
          "قیمت بالای ناحیه جذب قرار گرفته و ورود فروش معتبر نیست",
        ema8,
        ema20
      };
    }

    if (
      bearish &&
      nearZone &&
      latestBearish
    ) {
      const shortTrigger =
        current.low -
        atrValue * 0.10;

      const shortSL =
        zone.high +
        atrValue * 0.25;

      const shortRisk =
        shortSL -
        shortTrigger;

      return {
        status: "READY",
        direction: "SHORT",

        currentPrice:
          current.close,

        entryLow:
          zone.low,

        entryHigh:
          zone.high,

        trigger:
          shortTrigger,

        stopLoss:
          shortSL,

        target1:
          shortTrigger -
          shortRisk * 1.5,

        target2:
          shortTrigger -
          shortRisk * 2.5,

        riskPercent:
          shortTrigger
            ? shortRisk /
              shortTrigger *
              100
            : 0,

        ema8,
        ema20,

        reason:
          "روند 1 دقیقه‌ای نزولی است، قیمت به ناحیه جذب نزدیک است و کندل تأیید نزولی تشکیل شده است"
      };
    }

    return {
      status: "WAIT",
      direction: "SHORT",

      currentPrice:
        current.close,

      ema8,
      ema20,

      reason:
        bearish
          ? "روند 1 دقیقه‌ای مناسب است؛ منتظر شکست کف کندل تأیید باشید"
          : "تأیید 1 دقیقه‌ای هنوز نزولی نیست"
    };
  }

  return {
    status: "WAIT",
    direction: "WAIT",
    currentPrice: current.close,
    ema8,
    ema20,
    reason:
      "جهت معامله هنوز مشخص نیست"
  };
}

/* =========================================================
   MOVEMENT PATH
========================================================= */

function determineMovementPath({
  absorption,
  tf15,
  tf3,
  tf1,
  structure,
  orderbook
}) {
  let long = 0;
  let short = 0;

  if (
    absorption.direction === "BUYER"
  ) {
    long += 35;
  }

  if (
    absorption.direction === "SELLER"
  ) {
    short += 35;
  }

  if (
    tf15.trend === "BULLISH"
  ) {
    long += 20;
  }

  if (
    tf15.trend === "BEARISH"
  ) {
    short += 20;
  }

  if (
    tf3.trend === "BULLISH"
  ) {
    long += 15;
  }

  if (
    tf3.trend === "BEARISH"
  ) {
    short += 15;
  }

  if (
    tf1.trend === "BULLISH"
  ) {
    long += 15;
  }

  if (
    tf1.trend === "BEARISH"
  ) {
    short += 15;
  }

  if (
    structure.trend === "BULLISH"
  ) {
    long += 10;
  }

  if (
    structure.trend === "BEARISH"
  ) {
    short += 10;
  }

  if (
    orderbook.pressure === "BUY"
  ) {
    long += 5;
  }

  if (
    orderbook.pressure === "SELL"
  ) {
    short += 5;
  }

  if (
    long >= short + 15
  ) {
    return {
      direction: "LONG",
      label: "مسیر صعودی",
      long,
      short
    };
  }

  if (
    short >= long + 15
  ) {
    return {
      direction: "SHORT",
      label: "مسیر نزولی",
      long,
      short
    };
  }

  return {
    direction: "WAIT",
    label: "مسیر خنثی / نامشخص",
    long,
    short
  };
}

/* =========================================================
   FINAL SCORE
========================================================= */

function calculateFinalScore({
  absorption,
  pump,
  footprint,
  orderbook,
  oi,
  tf15,
  tf3,
  tf1,
  structure,
  retest
}) {
  let score = 0;

  /*
   * جذب واقعی مهم‌ترین بخش
   */

  score +=
    absorption.score * 0.35;

  /*
   * Pump
   */

  score +=
    pump.score * 0.12;

  /*
   * فشار معاملات واقعی
   */

  if (
    footprint &&
    footprint.totalValue > 0
  ) {
    const delta =
      Math.abs(
        footprint.deltaPercent
      );

    score +=
      clamp(delta * 0.20, 0, 8);
  }

  /*
   * Orderbook
   */

  score +=
    clamp(
      Math.abs(
        orderbook.imbalance
      ) * 0.08,
      0,
      8
    );

  /*
   * OI
   */

  score +=
    clamp(
      Math.abs(
        oi.changePercent
      ) * 0.08,
      0,
      6
    );

  /*
   * Timeframes
   */

  score +=
    tf15.score * 0.06;

  score +=
    tf3.score * 0.04;

  score +=
    tf1.score * 0.04;

  /*
   * Structure
   */

  if (
    structure.trend !== "NEUTRAL"
  ) {
    score += 5;
  }

  /*
   * Retest
   */

  if (retest.detected) {
    score += 5;
  }

  if (retest.confirmed) {
    score += 8;
  }

  return round(
    clamp(score, 0, 100),
    2
  );
}

/* =========================================================
   SIGNAL
========================================================= */

function signalFromScore(
  score,
  movement,
  retest,
  absorption
) {
  if (
    absorption.score < 60
  ) {
    return {
      code: "WEAK",
      label: "ضعیف"
    };
  }

  if (
    score >= 82 &&
    movement.direction === "LONG" &&
    retest.confirmed &&
    absorption.direction === "BUYER"
  ) {
    return {
      code: "STRONG_LONG",
      label: "خرید بسیار قوی"
    };
  }

  if (
    score >= 72 &&
    movement.direction === "LONG" &&
    retest.confirmed &&
    absorption.direction === "BUYER"
  ) {
    return {
      code: "LONG",
      label: "خرید قوی"
    };
  }

  if (
    score >= 82 &&
    movement.direction === "SHORT" &&
    retest.confirmed &&
    absorption.direction === "SELLER"
  ) {
    return {
      code: "STRONG_SHORT",
      label: "فروش بسیار قوی"
    };
  }

  if (
    score >= 72 &&
    movement.direction === "SHORT" &&
    retest.confirmed &&
    absorption.direction === "SELLER"
  ) {
    return {
      code: "SHORT",
      label: "فروش قوی"
    };
  }

  if (score >= 60) {
    return {
      code: "WATCH",
      label: "زیر نظر"
    };
  }

  return {
    code: "WEAK",
    label: "ضعیف"
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyzeSymbol(symbol) {
  symbol =
    String(symbol || "")
      .trim()
      .toUpperCase();

  if (!symbol) {
    throw new Error(
      "نماد وارد نشده است"
    );
  }

  const [
    candles5,
    candles15,
    candles3,
    candles1,
    trades,
    orderbook,
    oi
  ] = await Promise.all([
    getKlines(
      symbol,
      MAIN_TF
    ),
    getKlines(
      symbol,
      CONFIRM_TF_15M
    ),
    getKlines(
      symbol,
      CONFIRM_TF_3M
    ),
    getKlines(
      symbol,
      CONFIRM_TF_1M
    ),
    getRecentTrades(symbol),
    getOrderbook(symbol),
    getOpenInterest(symbol)
  ]);

  if (
    candles5.length < 30
  ) {
    throw new Error(
      "داده کافی برای تحلیل وجود ندارد"
    );
  }

  const setup =
    findAbsorptionSetup(
      candles5,
      trades
    );

  if (!setup) {
    return {
      ok: true,
      symbol,
      detected: false,
      message:
        "جذب واقعی با قدرت کافی پیدا نشد",
      version: VERSION
    };
  }

  /*
   * فشار معاملات فعلی
   */

  const recentTrades =
    trades.slice(-200);

  const footprint =
    analyzeTradePressure(
      recentTrades
    );

  footprint.source =
    "recent-trade";

  footprint.historicalMatched =
    setup.realAbsorption
      .historicalMatched;

  /*
   * تایم‌فریم‌ها
   */

  const tf15 =
    timeframeConfirmation(
      candles15
    );

  const tf3 =
    timeframeConfirmation(
      candles3
    );

  const tf1 =
    timeframeConfirmation(
      candles1
    );

  /*
   * ساختار
   */

  const structure =
    structureAnalysis(
      candles5
    );

  /*
   * Retest
   */

  const retest =
    detectRetest(
      candles5,
      setup.zone
    );

  /*
   * مسیر حرکت
   */

  const movement =
    determineMovementPath({
      absorption:
        setup.realAbsorption,
      tf15,
      tf3,
      tf1,
      structure,
      orderbook
    });

  /*
   * جهت معامله
   */

  let direction =
    movement.direction;

  if (
    setup.realAbsorption.direction ===
    "BUYER"
  ) {
    direction = "LONG";
  }

  if (
    setup.realAbsorption.direction ===
    "SELLER"
  ) {
    direction = "SHORT";
  }

  /*
   * امتیاز نهایی
   */

  const finalScore =
    calculateFinalScore({
      absorption:
        setup.realAbsorption,

      pump:
        setup.pump,

      footprint,

      orderbook,

      oi,

      tf15,
      tf3,
      tf1,

      structure,

      retest
    });

  /*
   * سیگنال
   */

  const signal =
    signalFromScore(
      finalScore,
      movement,
      retest,
      setup.realAbsorption
    );

  /*
   * نقطه ورود 1 دقیقه
   */

  const entry1m =
    calculateEntry1M(
      candles1,
      setup.zone,
      direction
    );

  const current =
    candles5.at(-1);

  return {
    ok: true,

    version: VERSION,

    symbol,

    detected: true,

    timestamp:
      Date.now(),

    currentPrice:
      current.close,

    signal,

    direction,

    movement,

    finalScore,

    /*
     * جذب
     */

    absorption: {
      score:
        setup.realAbsorption.score,

      direction:
        setup.realAbsorption.direction,

      label:
        setup.realAbsorption.label,

      detected:
        setup.realAbsorption.detected,

      buyVolume:
        setup.realAbsorption.buyVolume,

      sellVolume:
        setup.realAbsorption.sellVolume,

      buyValue:
        setup.realAbsorption.buyValue,

      sellValue:
        setup.realAbsorption.sellValue,

      buyShare:
        setup.realAbsorption.buyShare,

      sellShare:
        setup.realAbsorption.sellShare,

      deltaValue:
        setup.realAbsorption.deltaValue,

      deltaPercent:
        setup.realAbsorption.deltaPercent,

      tradeCount:
        setup.realAbsorption.tradeCount,

      priceMove:
        setup.realAbsorption.priceMove,

      lowerWickRatio:
        setup.realAbsorption.lowerWickRatio,

      upperWickRatio:
        setup.realAbsorption.upperWickRatio,

      bodyRatio:
        setup.realAbsorption.bodyRatio,

      historicalMatched:
        setup.realAbsorption.historicalMatched,

      explanation:
        setup.realAbsorption.direction ===
        "BUYER"
          ? "فشار فروش واقعی بالا بوده اما قیمت نتوانسته پایین برود؛ این رفتار به نفع جذب فروشندگان توسط خریداران است."
          : setup.realAbsorption.direction ===
            "SELLER"
            ? "فشار خرید واقعی بالا بوده اما قیمت نتوانسته بالا برود؛ این رفتار به نفع جذب خریداران توسط فروشندگان است."
            : "شواهد معاملات برای تعیین جهت جذب کافی نیست."
    },

    pump: {
      ...setup.pump
    },

    volume: {
      ...setup.volume
    },

    zone: {
      low:
        setup.zone.low,

      high:
        setup.zone.high,

      width:
        setup.zone.width
    },

    footprint: {
      ...footprint
    },

    orderbook: {
      ...orderbook
    },

    openInterest: {
      ...oi
    },

    retest,

    structure,

    timeframes: {
      "15m": tf15,
      "3m": tf3,
      "1m": tf1
    },

    entry1m,

    reasons: buildReasons({
      setup,
      movement,
      tf15,
      tf3,
      tf1,
      structure,
      retest,
      entry1m
    }),

    warnings:
      buildWarnings({
        setup,
        movement,
        retest,
        entry1m
      })
  };
}

/* =========================================================
   REASONS
========================================================= */

function buildReasons({
  setup,
  movement,
  tf15,
  tf3,
  tf1,
  structure,
  retest,
  entry1m
}) {
  const reasons = [];

  if (
    setup.realAbsorption.direction ===
    "BUYER"
  ) {
    reasons.push(
      "فروش واقعی در محدوده بالا بوده اما قیمت افت متناسب نکرده و جذب توسط خریداران تشخیص داده شده است."
    );
  }

  if (
    setup.realAbsorption.direction ===
    "SELLER"
  ) {
    reasons.push(
      "خرید واقعی در محدوده بالا بوده اما قیمت رشد متناسب نکرده و جذب توسط فروشندگان تشخیص داده شده است."
    );
  }

  if (
    setup.pump.detected
  ) {
    reasons.push(
      `قبل از جذب، حرکت صعودی با رشد تقریبی ${setup.pump.pumpPercent.toFixed(2)}٪ مشاهده شده است.`
    );
  }

  if (
    setup.volume.ratio >=
    MIN_VOLUME_RATIO
  ) {
    reasons.push(
      `حجم کندل جذب حدود ${setup.volume.ratio.toFixed(2)} برابر میانگین ۲۰ کندل قبل بوده است.`
    );
  }

  if (
    structure.trend ===
    "BULLISH"
  ) {
    reasons.push(
      "ساختار کوتاه‌مدت بازار صعودی است."
    );
  }

  if (
    structure.trend ===
    "BEARISH"
  ) {
    reasons.push(
      "ساختار کوتاه‌مدت بازار نزولی است."
    );
  }

  if (
    tf15.trend ===
    "BULLISH"
  ) {
    reasons.push(
      "تأیید ۱۵ دقیقه‌ای صعودی است."
    );
  }

  if (
    tf3.trend ===
    "BULLISH"
  ) {
    reasons.push(
      "تأیید ۳ دقیقه‌ای صعودی است."
    );
  }

  if (
    tf1.trend ===
    "BULLISH"
  ) {
    reasons.push(
      "تأیید ۱ دقیقه‌ای صعودی است."
    );
  }

  if (
    retest.confirmed
  ) {
    reasons.push(
      "ری‌تست ناحیه جذب تأیید شده است."
    );
  }

  if (
    entry1m.status ===
    "READY"
  ) {
    reasons.push(
      "شرایط نقطه ورود پیشنهادی ۱ دقیقه‌ای آماده شده است."
    );
  }

  return reasons;
}

function buildWarnings({
  setup,
  movement,
  retest,
  entry1m
}) {
  const warnings = [];

  if (
    setup.realAbsorption.score < 70
  ) {
    warnings.push(
      "قدرت جذب واقعی متوسط است."
    );
  }

  if (
    setup.realAbsorption.direction ===
    "UNKNOWN"
  ) {
    warnings.push(
      "جهت جذب قطعی نیست."
    );
  }

  if (
    !retest.confirmed
  ) {
    warnings.push(
      "ری‌تست هنوز تأیید نشده است."
    );
  }

  if (
    movement.direction ===
    "WAIT"
  ) {
    warnings.push(
      "مسیر حرکت بین تایم‌فریم‌ها هم‌جهت نیست."
    );
  }

  if (
    entry1m.status ===
    "WAIT"
  ) {
    warnings.push(
      "برای ورود ۱ دقیقه‌ای هنوز تأیید نهایی وجود ندارد."
    );
  }

  if (
    entry1m.status ===
    "INVALID"
  ) {
    warnings.push(
      "نقطه ورود ۱ دقیقه‌ای فعلاً نامعتبر است."
    );
  }

  return warnings;
}

/* =========================================================
   SCANNER
========================================================= */

async function scanMarkets() {
  const symbols =
    await getSymbolsRanked();

  const selected =
    symbols.slice(
      0,
      SCAN_BATCH
    );

  const results = [];

  for (
    const item of selected
  ) {
    try {
      const analysis =
        await analyzeSymbol(
          item.symbol
        );

      if (
        analysis?.detected &&
        analysis.finalScore >=
        MIN_ABSORPTION_SCORE
      ) {
        results.push({
          ...analysis,

          ticker: {
            lastPrice:
              item.lastPrice,

            turnover24h:
              item.turnover24h,

            volume24h:
              item.volume24h,

            change24h:
              item.price24hPcnt
          }
        });
      }
    } catch (error) {
      console.error(
        item.symbol,
        error.message
      );
    }

    await sleep(50);
  }

  results.sort(
    (a, b) =>
      b.finalScore -
      a.finalScore
  );

  return {
    ok: true,

    version: VERSION,

    scanned:
      selected.length,

    detected:
      results.length,

    timestamp:
      Date.now(),

    results
  };
}

/* =========================================================
   HEALTH
========================================================= */

async function health() {
  try {
    await bybit(
      "/v5/market/time"
    );

    return {
      ok: true,
      connected: true,
      exchange: "Bybit",
      version: VERSION,
      timestamp: Date.now()
    };
  } catch (error) {
    return {
      ok: false,
      connected: false,
      exchange: "Bybit",
      version: VERSION,
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request) {
    const url =
      new URL(request.url);

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
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-methods":
                "GET,OPTIONS",
              "access-control-allow-headers":
                "Content-Type"
            }
          }
        );
      }

      if (
        path ===
        "/api/health"
      ) {
        return json(
          await health()
        );
      }

      if (
        path ===
        "/api/config"
      ) {
        return json({
          ok: true,
          version: VERSION,

          mainTimeframe:
            MAIN_TF,

          confirmationTimeframes: [
            CONFIRM_TF_15M,
            CONFIRM_TF_3M,
            CONFIRM_TF_1M
          ],

          scanBatch:
            SCAN_BATCH,

          maxSymbols:
            MAX_SYMBOLS,

          minAbsorptionScore:
            MIN_ABSORPTION_SCORE,

          logic:
            "REAL-TRADE-ABSORPTION"
        });
      }

      if (
        path ===
        "/api/symbols"
      ) {
        const symbols =
          await getSymbolsRanked();

        return json({
          ok: true,
          symbols
        });
      }

      if (
        path ===
        "/api/test-bybit"
      ) {
        const result =
          await bybit(
            "/v5/market/time"
          );

        return json({
          ok: true,
          bybit: result
        });
      }

      if (
        path ===
        "/api/analyze"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "نماد وارد نشده است"
            },
            400
          );
        }

        return json(
          await analyzeSymbol(
            symbol
          )
        );
      }

      if (
        path ===
        "/api/scan"
      ) {
        return json(
          await scanMarkets()
        );
      }

      return new Response(
        await envAsset(request),
        {
          status: 200,
          headers: {
            "content-type":
              "text/html; charset=UTF-8"
          }
        }
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error:
            error.message ||
            "خطای نامشخص"
        },
        500
      );
    }
  }
};

/* =========================================================
   ASSET FALLBACK
========================================================= */

async function envAsset(request) {
  /*
   * Cloudflare Assets معمولاً قبل از رسیدن
   * به این مسیر فایل را سرو می‌کند.
   *
   * این fallback فقط برای جلوگیری از خطای
   * undefined باقی گذاشته شده.
   */

  return `
<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<title>Absorption Zone Scanner</title>
</head>
<body>
<h2>Absorption Zone Scanner</h2>
<p>Worker آنلاین است.</p>
</body>
</html>
`;
}
