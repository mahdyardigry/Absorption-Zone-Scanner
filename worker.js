const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ZONE-SCANNER-V2";

const MAIN_TF = "5";
const CONFIRM_TF_15M = "15";
const CONFIRM_TF_3M = "3";
const CONFIRM_TF_1M = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const MIN_VOLUME_RATIO = 1.5;
const MIN_ABSORPTION_SCORE = 60;
const RETEST_TOLERANCE_PERCENT = 0.45;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));


/* =========================================================
   BYBIT
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

  const response = await fetch(
    url.toString(),
    {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; AbsorptionZoneScanner/1.0)",
        "Cache-Control": "no-cache"
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Bybit HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}: ${
        data?.retMsg ||
        data?.message ||
        text.slice(0, 300)
      }`
    );
  }

  if (
    data.retCode !== undefined &&
    data.retCode !== 0
  ) {
    throw new Error(
      `Bybit API ${data.retCode}: ${
        data.retMsg || "Unknown Bybit API error"
      }`
    );
  }

  return data.result;
}


/* =========================================================
   UTILS
========================================================= */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, num(v)));
}

function avg(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return arr.reduce((a, b) => a + num(b), 0) / arr.length;
}

function sum(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return arr.reduce((a, b) => a + num(b), 0);
}

function pctChange(from, to) {
  from = num(from);
  to = num(to);

  if (!from) return 0;

  return ((to - from) / from) * 100;
}

function safeFixed(value, digits = 4) {
  const n = num(value);

  if (!Number.isFinite(n)) return "0";

  return n.toFixed(digits);
}

function last(arr) {
  return arr?.length
    ? arr[arr.length - 1]
    : null;
}

function median(arr) {
  if (!arr?.length) return 0;

  const a = arr
    .map(num)
    .sort((x, y) => x - y);

  const mid = Math.floor(a.length / 2);

  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
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

  const list = Array.isArray(result?.list)
    ? result.list
    : [];

  const symbols = list
    .filter(x =>
      x &&
      x.symbol &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
    )
    .map(x => ({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      status: x.status
    }));

  let tickerMap = {};

  try {
    const tickerResult = await bybit(
      "/v5/market/tickers",
      {
        category: "linear"
      }
    );

    for (const t of tickerResult?.list || []) {
      tickerMap[t.symbol] = {
        lastPrice: num(t.lastPrice),
        volume24h: num(t.volume24h),
        turnover24h: num(t.turnover24h),
        price24hPcnt: num(t.price24hPcnt) * 100
      };
    }
  } catch {
    tickerMap = {};
  }

  return symbols
    .map(s => ({
      ...s,
      ...(tickerMap[s.symbol] || {})
    }))
    .sort(
      (a, b) =>
        num(b.turnover24h) -
        num(a.turnover24h)
    )
    .slice(0, MAX_SYMBOLS);
}

async function findSymbol(input) {
  const symbols = await getSymbols();

  const raw = String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!raw) return null;

  return (
    symbols.find(x => x.symbol === raw) ||
    symbols.find(
      x =>
        x.baseCoin === raw &&
        x.quoteCoin === "USDT"
    ) ||
    null
  );
}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(
  symbol,
  interval = MAIN_TF,
  limit = KLINE_LIMIT
) {
  const result = await bybit(
    "/v5/market/kline",
    {
      category: "linear",
      symbol,
      interval,
      limit
    }
  );

  const rows = Array.isArray(result?.list)
    ? result.list
    : [];

  return rows
    .map(row => ({
      startTime: num(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
      turnover: num(row[6])
    }))
    .sort(
      (a, b) =>
        a.startTime - b.startTime
    );
}


/* =========================================================
   CANDLE ANALYSIS
========================================================= */

function candleStats(c) {
  const open = num(c.open);
  const high = num(c.high);
  const low = num(c.low);
  const close = num(c.close);

  const range = Math.max(
    high - low,
    0
  );

  const body = Math.abs(close - open);

  const upperWick =
    high - Math.max(open, close);

  const lowerWick =
    Math.min(open, close) - low;

  const bodyRatio =
    range > 0
      ? body / range
      : 0;

  const upperWickRatio =
    range > 0
      ? upperWick / range
      : 0;

  const lowerWickRatio =
    range > 0
      ? lowerWick / range
      : 0;

  const change =
    open > 0
      ? ((close - open) / open) * 100
      : 0;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio,
    upperWickRatio,
    lowerWickRatio,
    change,
    bullish: close > open,
    bearish: close < open,
    neutral:
      Math.abs(change) <= 0.15
  };
}


/* =========================================================
   VOLUME
========================================================= */

function volumeAnalysis(candles, index) {
  const current =
    candles[index];

  const start =
    Math.max(0, index - 20);

  const previous =
    candles
      .slice(start, index)
      .map(x => x.volume);

  const averageVolume =
    avg(previous);

  const ratio =
    averageVolume > 0
      ? current.volume /
        averageVolume
      : 0;

  return {
    currentVolume: current.volume,
    averageVolume,
    ratio,
    spike:
      ratio >= MIN_VOLUME_RATIO
  };
}


/* =========================================================
   PUMP DETECTION
========================================================= */

function detectPump(candles, index) {
  if (
    !candles ||
    index < 6
  ) {
    return null;
  }

  const current =
    candles[index];

  const lookbackStart =
    Math.max(0, index - 12);

  const base =
    candles[lookbackStart];

  const pumpPercent =
    pctChange(
      base.close,
      current.close
    );

  const bullishCandles =
    candles
      .slice(lookbackStart, index + 1)
      .filter(
        x => x.close > x.open
      ).length;

  const total =
    index -
    lookbackStart +
    1;

  const greenRatio =
    total > 0
      ? bullishCandles / total
      : 0;

  const rangeHigh =
    Math.max(
      ...candles
        .slice(
          lookbackStart,
          index + 1
        )
        .map(x => x.high)
    );

  const rangeLow =
    Math.min(
      ...candles
        .slice(
          lookbackStart,
          index + 1
        )
        .map(x => x.low)
    );

  const rangeMove =
    pctChange(
      rangeLow,
      rangeHigh
    );

  if (
    pumpPercent < 2 &&
    rangeMove < 2
  ) {
    return null;
  }

  const score = clamp(
    pumpPercent * 8 +
    greenRatio * 25 +
    Math.min(rangeMove * 2, 20)
  );

  return {
    startTime: base.startTime,
    endTime: current.startTime,
    startPrice: base.close,
    endPrice: current.close,
    pumpPercent,
    greenRatio,
    rangeMove,
    score
  };
}


/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  candles,
  index
) {
  if (
    !candles ||
    index < 20
  ) {
    return null;
  }

  const c =
    candles[index];

  const stats =
    candleStats(c);

  const volume =
    volumeAnalysis(
      candles,
      index
    );

  const previous =
    candles[index - 1];

  const previousStats =
    candleStats(previous);

  const pressure =
    candles
      .slice(
        Math.max(0, index - 5),
        index
      )
      .map(candleStats);

  const bullishPressure =
    pressure.filter(
      x => x.bullish
    ).length;

  const recentHigh =
    Math.max(
      ...candles
        .slice(
          Math.max(0, index - 8),
          index
        )
        .map(x => x.high)
    );

  const nearHigh =
    recentHigh > 0
      ? (
          (recentHigh - c.high) /
          recentHigh
        ) *
        100
      : 0;

  const weakRed =
    stats.bearish &&
    Math.abs(stats.change) <= 1.5;

  const neutral =
    stats.neutral;

  const highVolume =
    volume.ratio >=
    MIN_VOLUME_RATIO;

  const longLowerWick =
    stats.lowerWickRatio >=
    0.25;

  const smallBody =
    stats.bodyRatio <= 0.45;

  const bullishContext =
    bullishPressure >= 3 ||
    previousStats.bullish;

  const nearResistance =
    nearHigh <= 1.5;

  let score = 0;

  if (weakRed) score += 18;
  else if (neutral) score += 14;

  if (highVolume) {
    score += Math.min(
      25,
      volume.ratio * 8
    );
  }

  if (longLowerWick) score += 18;

  if (smallBody) score += 12;

  if (bullishContext) score += 12;

  if (nearResistance) score += 5;

  score = clamp(score);

  if (
    score <
    MIN_ABSORPTION_SCORE
  ) {
    return null;
  }

  const zoneHigh =
    Math.max(
      c.open,
      c.close
    );

  const zoneLow =
    c.low;

  return {
    index,
    time: c.startTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    volumeRatio: volume.ratio,
    change: stats.change,
    bodyRatio: stats.bodyRatio,
    lowerWickRatio:
      stats.lowerWickRatio,
    upperWickRatio:
      stats.upperWickRatio,
    weakRed,
    neutral,
    bullishContext,
    nearResistance,
    zoneHigh,
    zoneLow,
    score
  };
}


/* =========================================================
   PUMP + ABSORPTION SEARCH
========================================================= */

function findAbsorptionSetup(
  candles
) {
  if (!candles?.length) {
    return null;
  }

  let best = null;

  for (
    let i = 20;
    i < candles.length;
    i++
  ) {
    const pump =
      detectPump(
        candles,
        i
      );

    if (!pump) continue;

    const absorption =
      detectAbsorption(
        candles,
        i
      );

    if (!absorption) continue;

    const combinedScore =
      clamp(
        pump.score * 0.35 +
        absorption.score * 0.65
      );

    const candidate = {
      pump,
      absorption,
      score:
        combinedScore
    };

    if (
      !best ||
      candidate.score >
        best.score
    ) {
      best = candidate;
    }
  }

  return best;
}


/* =========================================================
   TRADES / DELTA
========================================================= */

async function getRecentTrades(
  symbol,
  limit = TRADE_LIMIT
) {
  const result = await bybit(
    "/v5/market/recent-trade",
    {
      category: "linear",
      symbol,
      limit
    }
  );

  return Array.isArray(result?.list)
    ? result.list.map(t => ({
        id: t.execId,
        price: num(t.price),
        size: num(t.size),
        side: t.side,
        time: num(t.time)
      }))
    : [];
}

function makeFootprint(
  trades,
  zone = null
) {
  if (!trades?.length) {
    return {
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      deltaPercent: 0,
      totalVolume: 0,
      tradeCount: 0
    };
  }

  let selected =
    trades;

  if (zone?.time) {
    const start =
      zone.time;

    const end =
      start +
      5 * 60 * 1000;

    const filtered =
      trades.filter(
        t =>
          t.time >= start &&
          t.time < end
      );

    if (filtered.length) {
      selected =
        filtered;
    }
  }

  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of selected) {
    const value =
      num(trade.size) *
      num(trade.price);

    if (
      String(trade.side)
        .toLowerCase() ===
      "buy"
    ) {
      buyVolume += value;
    } else {
      sellVolume += value;
    }
  }

  const totalVolume =
    buyVolume +
    sellVolume;

  const delta =
    buyVolume -
    sellVolume;

  const deltaPercent =
    totalVolume > 0
      ? (delta / totalVolume) *
        100
      : 0;

  return {
    buyVolume,
    sellVolume,
    delta,
    deltaPercent,
    totalVolume,
    tradeCount:
      selected.length
  };
}


/* =========================================================
   ORDER BOOK
========================================================= */

async function getOrderbook(
  symbol
) {
  const result = await bybit(
    "/v5/market/orderbook",
    {
      category: "linear",
      symbol,
      limit: ORDERBOOK_LIMIT
    }
  );

  const bids =
    (result?.b || [])
      .map(x => [
        num(x[0]),
        num(x[1])
      ]);

  const asks =
    (result?.a || [])
      .map(x => [
        num(x[0]),
        num(x[1])
      ]);

  const bidValue =
    sum(
      bids.map(
        x => x[0] * x[1]
      )
    );

  const askValue =
    sum(
      asks.map(
        x => x[0] * x[1]
      )
    );

  const total =
    bidValue +
    askValue;

  const imbalance =
    total > 0
      ? (
          (bidValue - askValue) /
          total
        ) *
        100
      : 0;

  const strongestBid =
    bids.length
      ? Math.max(
          ...bids.map(
            x => x[0] * x[1]
          )
        )
      : 0;

  const strongestAsk =
    asks.length
      ? Math.max(
          ...asks.map(
            x => x[0] * x[1]
          )
        )
      : 0;

  return {
    bidValue,
    askValue,
    imbalance,
    strongestBid,
    strongestAsk,
    bidCount: bids.length,
    askCount: asks.length
  };
}


/* =========================================================
   OPEN INTEREST
========================================================= */

async function getOpenInterest(
  symbol
) {
  const result =
    await bybit(
      "/v5/market/open-interest",
      {
        category: "linear",
        symbol,
        intervalTime: "5min",
        limit: 20
      }
    );

  const list =
    Array.isArray(
      result?.list
    )
      ? result.list
          .map(x => ({
            time: num(x.timestamp),
            oi: num(
              x.openInterest
            )
          }))
          .sort(
            (a, b) =>
              a.time - b.time
          )
      : [];

  const current =
    last(list);

  const previous =
    list.length >= 2
      ? list[list.length - 2]
      : null;

  const change =
    previous &&
    previous.oi
      ? (
          (current.oi -
            previous.oi) /
          previous.oi
        ) *
        100
      : 0;

  return {
    current: current?.oi || 0,
    previous:
      previous?.oi || 0,
    change,
    points: list
  };
}


/* =========================================================
   RETEST
========================================================= */

function detectRetest(
  candles,
  absorption
) {
  if (
    !absorption ||
    absorption.index >=
      candles.length - 1
  ) {
    return {
      detected: false,
      confirmed: false
    };
  }

  const zoneHigh =
    absorption.zoneHigh;

  const zoneLow =
    absorption.zoneLow;

  const tolerance =
    (
      (zoneHigh -
        zoneLow) *
      RETEST_TOLERANCE_PERCENT
    ) / 100;

  let touched = false;
  let bounced = false;
  let retestIndex = -1;

  for (
    let i =
      absorption.index + 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const touches =
      c.low <=
        zoneHigh + tolerance &&
      c.high >=
        zoneLow - tolerance;

    if (touches) {
      touched = true;
      retestIndex = i;

      if (
        c.close >
        zoneHigh
      ) {
        bounced = true;
      }

      if (
        i + 1 <
        candles.length
      ) {
        const next =
          candles[i + 1];

        if (
          next.close >
          c.close
        ) {
          bounced = true;
        }
      }
    }
  }

  return {
    detected: touched,
    confirmed:
      touched && bounced,
    index: retestIndex,
    zoneHigh,
    zoneLow,
    tolerance
  };
}


/* =========================================================
   STRUCTURE
========================================================= */

function structureAnalysis(
  candles
) {
  if (
    !candles ||
    candles.length < 10
  ) {
    return {
      trend: "unknown",
      bos: false,
      higherHigh: false,
      higherLow: false
    };
  }

  const recent =
    candles.slice(-10);

  const highs =
    recent.map(
      x => x.high
    );

  const lows =
    recent.map(
      x => x.low
    );

  const current =
    last(recent);

  const previousHigh =
    Math.max(
      ...recent.slice(
        0,
        -2
      ).map(
        x => x.high
      )
    );

  const previousLow =
    Math.min(
      ...recent.slice(
        0,
        -2
      ).map(
        x => x.low
      )
    );

  const higherHigh =
    current.high >
    previousHigh;

  const higherLow =
    current.low >
    previousLow;

  let trend =
    "neutral";

  if (
    higherHigh &&
    higherLow
  ) {
    trend = "bullish";
  } else if (
    current.close <
    previousLow
  ) {
    trend = "bearish";
  }

  return {
    trend,
    bos:
      current.close >
      previousHigh,
    higherHigh,
    higherLow,
    recentHigh:
      Math.max(...highs),
    recentLow:
      Math.min(...lows)
  };
}


/* =========================================================
   TIMEFRAME CONFIRMATION
========================================================= */

function timeframeConfirmation(
  candles
) {
  if (
    !candles ||
    candles.length < 25
  ) {
    return {
      trend: "unknown",
      score: 0,
      price: 0,
      average: 0
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    last(candles);

  const currentPrice =
    current.close;

  const short =
    avg(
      closes.slice(-8)
    );

  const medium =
    avg(
      closes.slice(-20)
    );

  let trend =
    "neutral";

  if (
    currentPrice >
      short &&
    short >
      medium
  ) {
    trend = "bullish";
  } else if (
    currentPrice <
      short &&
    short <
      medium
  ) {
    trend = "bearish";
  }

  let score = 0;

  if (
    trend === "bullish"
  ) {
    score = 100;
  } else if (
    trend === "neutral"
  ) {
    score = 50;
  }

  return {
    trend,
    score,
    price: currentPrice,
    average: medium,
    shortAverage: short
  };
}


/* =========================================================
   FINAL SCORE
========================================================= */

function calculateFinalScore({
  setup,
  footprint,
  orderbook,
  openInterest,
  confirmation15,
  confirmation3,
  confirmation1,
  retest,
  structure
}) {
  let score = 0;

  score +=
    setup.absorption.score *
    0.35;

  score +=
    Math.min(
      20,
      Math.max(
        0,
        setup.pump.pumpPercent *
        2
      )
    );

  if (
    footprint.delta >= 0
  ) {
    score += 8;
  } else if (
    footprint.deltaPercent >
      -15
  ) {
    score += 4;
  }

  if (
    orderbook.imbalance >
    5
  ) {
    score += 8;
  } else if (
    orderbook.imbalance >
    0
  ) {
    score += 4;
  }

  if (
    openInterest.change >
    0
  ) {
    score += 4;
  }

  if (
    confirmation15.trend ===
    "bullish"
  ) {
    score += 8;
  }

  if (
    confirmation3.trend ===
    "bullish"
  ) {
    score += 5;
  }

  if (
    confirmation1.trend ===
    "bullish"
  ) {
    score += 4;
  }

  if (
    structure.trend ===
    "bullish"
  ) {
    score += 5;
  }

  if (
    retest.detected
  ) {
    score += 5;
  }

  if (
    retest.confirmed
  ) {
    score += 8;
  }

  return clamp(score);
}


/* =========================================================
   SIGNAL
========================================================= */

function signalFromScore(
  score,
  setup,
  retest,
  confirmations
) {
  if (
    !setup
  ) {
    return "NO_SETUP";
  }

  if (
    score >= 80 &&
    retest.confirmed &&
    confirmations
  ) {
    return "STRONG_LONG";
  }

  if (
    score >= 70
  ) {
    return "LONG";
  }

  if (
    score >= 60
  ) {
    return "WATCH";
  }

  return "WEAK";
}


/* =========================================================
   SINGLE SYMBOL
========================================================= */

async function analyzeSymbol(
  symbol
) {
  const normalized =
    String(symbol || "")
      .trim()
      .toUpperCase();

  if (!normalized) {
    throw new Error(
      "Symbol is required"
    );
  }

  const [
    candles5,
    candles15,
    candles3,
    candles1
  ] = await Promise.all([
    getKlines(
      normalized,
      MAIN_TF,
      KLINE_LIMIT
    ),
    getKlines(
      normalized,
      CONFIRM_TF_15M,
      100
    ),
    getKlines(
      normalized,
      CONFIRM_TF_3M,
      100
    ),
    getKlines(
      normalized,
      CONFIRM_TF_1M,
      100
    )
  ]);

  if (
    !candles5.length
  ) {
    throw new Error(
      "No 5m candle data"
    );
  }

  const setup =
    findAbsorptionSetup(
      candles5
    );

  const current =
    last(candles5);

  if (!setup) {
    return {
      ok: true,
      symbol: normalized,
      version: VERSION,
      signal: "NO_SETUP",
      score: 0,
      detected: false,
      currentPrice:
        current?.close || 0,
      message:
        "No absorption zone detected",
      timeframe: {
        primary: MAIN_TF,
        confirmations: [
          CONFIRM_TF_15M,
          CONFIRM_TF_3M,
          CONFIRM_TF_1M
        ]
      }
    };
  }

  const zone =
    setup.absorption;

  const [
    trades,
    orderbook,
    openInterest
  ] = await Promise.all([
    getRecentTrades(
      normalized,
      TRADE_LIMIT
    ),
    getOrderbook(
      normalized
    ),
    getOpenInterest(
      normalized
    )
  ]);

  const footprint =
    makeFootprint(
      trades,
      zone
    );

  const confirmation15 =
    timeframeConfirmation(
      candles15
    );

  const confirmation3 =
    timeframeConfirmation(
      candles3
    );

  const confirmation1 =
    timeframeConfirmation(
      candles1
    );

  const retest =
    detectRetest(
      candles5,
      zone
    );

  const structure =
    structureAnalysis(
      candles5
    );

  const score =
    calculateFinalScore({
      setup,
      footprint,
      orderbook,
      openInterest,
      confirmation15,
      confirmation3,
      confirmation1,
      retest,
      structure
    });

  const bullishConfirmations =
    confirmation15.trend ===
      "bullish" &&
    (
      confirmation3.trend ===
        "bullish" ||
      confirmation1.trend ===
        "bullish"
    );

  const signal =
    signalFromScore(
      score,
      setup,
      retest,
      bullishConfirmations
    );

  const currentPrice =
    current.close;

  const distanceToZone =
    zone.zoneHigh > 0
      ? (
          (
            currentPrice -
            zone.zoneHigh
          ) /
          zone.zoneHigh
        ) *
        100
      : 0;

  return {
    ok: true,
    detected: true,
    symbol: normalized,
    version: VERSION,

    signal,
    score: Number(
      score.toFixed(2)
    ),

    currentPrice,

    timeframe: {
      primary: MAIN_TF,
      confirmations: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ]
    },

    setup: {
      pump: {
        startTime:
          setup.pump.startTime,
        endTime:
          setup.pump.endTime,
        startPrice:
          setup.pump.startPrice,
        endPrice:
          setup.pump.endPrice,
        pumpPercent:
          setup.pump.pumpPercent,
        greenRatio:
          setup.pump.greenRatio,
        rangeMove:
          setup.pump.rangeMove,
        score:
          setup.pump.score
      },

      absorption: {
        time: zone.time,
        open: zone.open,
        high: zone.high,
        low: zone.low,
        close: zone.close,
        change: zone.change,
        volume: zone.volume,
        volumeRatio:
          zone.volumeRatio,
        bodyRatio:
          zone.bodyRatio,
        lowerWickRatio:
          zone.lowerWickRatio,
        upperWickRatio:
          zone.upperWickRatio,
        weakRed:
          zone.weakRed,
        neutral:
          zone.neutral,
        bullishContext:
          zone.bullishContext,
        zoneHigh:
          zone.zoneHigh,
        zoneLow:
          zone.zoneLow,
        score:
          zone.score
      }
    },

    footprint: {
      buyVolume:
        footprint.buyVolume,
      sellVolume:
        footprint.sellVolume,
      delta:
        footprint.delta,
      deltaPercent:
        footprint.deltaPercent,
      totalVolume:
        footprint.totalVolume,
      tradeCount:
        footprint.tradeCount
    },

    orderbook,

    openInterest: {
      current:
        openInterest.current,
      previous:
        openInterest.previous,
      change:
        openInterest.change
    },

    retest: {
      detected:
        retest.detected,
      confirmed:
        retest.confirmed,
      index:
        retest.index,
      zoneHigh:
        retest.zoneHigh,
      zoneLow:
        retest.zoneLow,
      tolerance:
        retest.tolerance,
      distanceToZone
    },

    structure,

    confirmations: {
      "15m":
        confirmation15,
      "3m":
        confirmation3,
      "1m":
        confirmation1
    },

    generatedAt:
      Date.now()
  };
}


/* =========================================================
   SCAN
========================================================= */

async function scanMarkets() {
  const symbols =
    await getSymbols();

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
      const result =
        await analyzeSymbol(
          item.symbol
        );

      if (
        result.detected &&
        result.score >=
          MIN_ABSORPTION_SCORE
      ) {
        results.push(
          {
            ...result,
            volume24h:
              item.volume24h || 0,
            turnover24h:
              item.turnover24h || 0,
            price24hPcnt:
              item.price24hPcnt || 0
          }
        );
      }
    } catch (error) {
      results.push({
        ok: false,
        symbol:
          item.symbol,
        error:
          error?.message ||
          String(error)
      });
    }

    await sleep(30);
  }

  results.sort(
    (a, b) =>
      num(b.score) -
      num(a.score)
  );

  return {
    ok: true,
    version: VERSION,
    count:
      results.filter(
        x => x.ok
      ).length,
    signals:
      results.filter(
        x =>
          x.ok &&
          x.detected
      ).length,
    results,
    timestamp:
      Date.now()
  };
}


/* =========================================================
   RESPONSE
========================================================= */

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8",
        "cache-control":
          "no-store, no-cache, must-revalidate",
        "access-control-allow-origin":
          "*",
        "access-control-allow-methods":
          "GET, OPTIONS",
        "access-control-allow-headers":
          "*"
      }
    }
  );
}


/* =========================================================
   ROUTER
========================================================= */

async function router(
  request
) {
  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

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
            "GET, OPTIONS",
          "access-control-allow-headers":
            "*"
        }
      }
    );
  }

  if (
    path === "/" ||
    path === ""
  ) {
    return new Response(
      `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Absorption Zone Scanner</title>
</head>
<body>
<h2>🔥 Absorption Zone Scanner</h2>
<p>Worker آنلاین است.</p>
<p>Version: ${VERSION}</p>
</body>
</html>`,
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8"
        }
      }
    );
  }

  if (
    path === "/api/health"
  ) {
    return json({
      ok: true,
      online: true,
      version: VERSION,
      exchange: "Bybit",
      market:
        "USDT Perpetual Futures",
      primaryTimeframe:
        MAIN_TF,
      confirmationTimeframes: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ],
      timestamp:
        Date.now()
    });
  }

  if (
    path === "/api/config"
  ) {
    return json({
      ok: true,
      version: VERSION,
      exchange: "Bybit",
      market:
        "USDT Perpetual Futures",
      mainTimeframe:
        MAIN_TF,
      confirmations: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ],
      limits: {
        kline:
          KLINE_LIMIT,
        trades:
          TRADE_LIMIT,
        orderbook:
          ORDERBOOK_LIMIT,
        scanBatch:
          SCAN_BATCH,
        maxSymbols:
          MAX_SYMBOLS
      },
      thresholds: {
        minVolumeRatio:
          MIN_VOLUME_RATIO,
        minAbsorptionScore:
          MIN_ABSORPTION_SCORE,
        retestTolerancePercent:
          RETEST_TOLERANCE_PERCENT
      }
    });
  }

  if (
    path === "/api/symbols"
  ) {
    try {
      const symbols =
        await getSymbols();

      return json({
        ok: true,
        count:
          symbols.length,
        symbols,
        timestamp:
          Date.now()
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error),
          timestamp:
            Date.now()
        },
        502
      );
    }
  }

  if (
    path === "/api/test-bybit"
  ) {
    try {
      const result =
        await bybit(
          "/v5/market/time"
        );

      return json({
        ok: true,
        bybit: true,
        result,
        timestamp:
          Date.now()
      });
    } catch (error) {
      return json(
        {
          ok: false,
          bybit: false,
          error:
            error?.message ||
            String(error),
          timestamp:
            Date.now()
        },
        502
      );
    }
  }

  if (
    path === "/api/analyze"
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
            "symbol is required"
        },
        400
      );
    }

    try {
      return json(
        await analyzeSymbol(
          symbol
        )
      );
    } catch (error) {
      return json(
        {
          ok: false,
          symbol,
          error:
            error?.message ||
            String(error),
          timestamp:
            Date.now()
        },
        502
      );
    }
  }

  if (
    path === "/api/scan"
  ) {
    try {
      return json(
        await scanMarkets()
      );
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error),
          timestamp:
            Date.now()
        },
        502
      );
    }
  }

  return json(
    {
      ok: false,
      error: "Not Found",
      path
    },
    404
  );
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
    try {
      return await router(
        request
      );
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error),
          version: VERSION,
          timestamp:
            Date.now()
        },
        500
      );
    }
  }
};
