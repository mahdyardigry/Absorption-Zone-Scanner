const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ZONE-SCANNER-V1";

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type"
    }
  });
}

function error(message, status = 500, extra = {}) {
  return json({
    ok: false,
    error: message,
    ...extra
  }, status);
}

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);

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
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data.result;
}

/* =========================================================
   UTILITIES
========================================================= */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function pctChange(a, b) {
  if (!a) return 0;
  return ((b - a) / a) * 100;
}

function safeFixed(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(digits);
}

/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {
  const result = await bybit("/v5/market/instruments-info", {
    category: "linear",
    status: "Trading",
    limit: 1000
  });

  const list = result.list || [];

  return list
    .filter(x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
    )
    .sort((a, b) => {
      const av = num(a.volume24h);
      const bv = num(b.volume24h);
      return bv - av;
    })
    .slice(0, MAX_SYMBOLS)
    .map(x => x.symbol);
}

/* =========================================================
   KLINES
========================================================= */

function parseKlines(list) {
  return (list || [])
    .map(k => ({
      time: num(k[0]),
      open: num(k[1]),
      high: num(k[2]),
      low: num(k[3]),
      close: num(k[4]),
      volume: num(k[5]),
      turnover: num(k[6])
    }))
    .sort((a, b) => a.time - b.time);
}

async function getKlines(symbol, interval, limit = KLINE_LIMIT) {
  const result = await bybit("/v5/market/kline", {
    category: "linear",
    symbol,
    interval,
    limit
  });

  return parseKlines(result.list);
}

/* =========================================================
   CANDLE ANALYSIS
========================================================= */

function candleStats(c) {
  const range = Math.max(c.high - c.low, 0);
  const body = Math.abs(c.close - c.open);

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const bodyRatio = range > 0 ? body / range : 0;

  const closePosition =
    range > 0
      ? (c.close - c.low) / range
      : 0.5;

  const direction =
    c.close > c.open
      ? "green"
      : c.close < c.open
        ? "red"
        : "neutral";

  return {
    range,
    body,
    bodyRatio,
    upperWick,
    lowerWick,
    closePosition,
    direction
  };
}

/* =========================================================
   VOLUME
========================================================= */

function volumeAnalysis(candles, index, lookback = 20) {
  const start = Math.max(0, index - lookback);
  const previous = candles
    .slice(start, index)
    .map(c => c.volume)
    .filter(v => v > 0);

  const baseline = avg(previous);
  const current = candles[index]?.volume || 0;

  const ratio = baseline > 0
    ? current / baseline
    : 0;

  return {
    current,
    baseline,
    ratio
  };
}

/* =========================================================
   PUMP DETECTION
========================================================= */

function detectPump(candles, index) {
  if (index < 8) return null;

  const current = candles[index];

  let greenCount = 0;
  let totalMove = 0;
  let strongest = 0;

  const start = Math.max(0, index - 6);

  for (let i = start; i <= index; i++) {
    const c = candles[i];

    if (c.close > c.open) {
      greenCount++;
    }

    if (i > start) {
      const prev = candles[i - 1];
      const move = pctChange(prev.close, c.close);
      totalMove += move;
      strongest = Math.max(strongest, move);
    }
  }

  const count = index - start + 1;
  const greenRatio = greenCount / count;

  const pumpPercent =
    pctChange(candles[start].close, current.close);

  if (
    pumpPercent < 4 ||
    greenRatio < 0.55 ||
    strongest < 0.5
  ) {
    return null;
  }

  return {
    startTime: candles[start].time,
    endTime: current.time,
    pumpPercent,
    greenRatio,
    strongestCandlePercent: strongest
  };
}

/* =========================================================
   ABSORPTION DETECTION
========================================================= */

function detectAbsorption(candles, index) {
  if (index < 25) return null;

  const c = candles[index];
  const stats = candleStats(c);

  const vol = volumeAnalysis(candles, index, 20);

  const ranges = candles
    .slice(Math.max(0, index - 20), index)
    .map(x => x.high - x.low)
    .filter(x => x > 0);

  const averageRange = avg(ranges);

  const rangeRatio =
    averageRange > 0
      ? stats.range / averageRange
      : 0;

  /*
   * A weak red candle:
   * - red or almost neutral
   * - relatively small body
   * - price does not collapse
   * - volume is elevated
   */

  const weakBody =
    stats.bodyRatio <= 0.45;

  const weakRange =
    rangeRatio <= 1.35;

  const redOrNeutral =
    stats.direction === "red" ||
    stats.direction === "neutral";

  const highVolume =
    vol.ratio >= MIN_VOLUME_RATIO;

  if (!highVolume || !weakBody || !redOrNeutral) {
    return null;
  }

  let score = 0;

  /* Volume */
  if (vol.ratio >= 3) score += 20;
  else if (vol.ratio >= 2) score += 16;
  else if (vol.ratio >= 1.5) score += 12;

  /* Weak body */
  if (stats.bodyRatio <= 0.20) score += 18;
  else if (stats.bodyRatio <= 0.30) score += 15;
  else if (stats.bodyRatio <= 0.45) score += 10;

  /* Small range */
  if (weakRange) score += 10;

  /* Long lower wick */
  if (stats.lowerWick > stats.body * 1.5) {
    score += 12;
  } else if (stats.lowerWick > stats.body) {
    score += 7;
  }

  /* Close location */
  if (stats.closePosition >= 0.55) {
    score += 10;
  }

  /* Previous bullish pressure */
  const previous = candles.slice(
    Math.max(0, index - 5),
    index
  );

  const previousGreen =
    previous.length
      ? previous.filter(x => x.close > x.open).length /
        previous.length
      : 0;

  if (previousGreen >= 0.6) {
    score += 10;
  }

  /* Price did not fall aggressively */
  const previousClose =
    candles[index - 1]?.close || c.open;

  const drop =
    pctChange(previousClose, c.close);

  if (drop > -1) score += 10;
  if (drop > -0.5) score += 5;

  score = clamp(score, 0, 100);

  const zoneLow = c.low;
  const zoneHigh = Math.max(c.open, c.close);

  return {
    index,
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,

    direction: stats.direction,

    range: stats.range,
    body: stats.body,
    bodyRatio: stats.bodyRatio,
    lowerWick: stats.lowerWick,
    upperWick: stats.upperWick,
    closePosition: stats.closePosition,

    volume: vol.current,
    averageVolume: vol.baseline,
    volumeRatio: vol.ratio,

    rangeRatio,

    zoneLow,
    zoneHigh,

    score
  };
}

/* =========================================================
   DELTA / TRADES
========================================================= */

async function getRecentTrades(symbol) {
  const result = await bybit("/v5/market/recent-trade", {
    category: "linear",
    symbol,
    limit: TRADE_LIMIT
  });

  return (result.list || []).map(t => ({
    time: num(t.time),
    price: num(t.price),
    size: num(t.size),
    side: String(t.side || "").toLowerCase(),
    value: num(t.price) * num(t.size)
  }));
}

function makeDelta(trades) {
  let buyVolume = 0;
  let sellVolume = 0;
  let buyValue = 0;
  let sellValue = 0;

  for (const t of trades) {
    if (t.side === "buy") {
      buyVolume += t.size;
      buyValue += t.value;
    } else if (t.side === "sell") {
      sellVolume += t.size;
      sellValue += t.value;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;

  const deltaVolume =
    buyVolume - sellVolume;

  const deltaValue =
    buyValue - sellValue;

  const deltaPercent =
    totalVolume > 0
      ? (deltaVolume / totalVolume) * 100
      : 0;

  return {
    buyVolume,
    sellVolume,
    totalVolume,
    buyValue,
    sellValue,
    totalValue,
    deltaVolume,
    deltaValue,
    deltaPercent,
    buyRatio:
      totalVolume > 0
        ? buyVolume / totalVolume
        : 0
  };
}

/* =========================================================
   CVD
========================================================= */

function calculateCVD(trades) {
  let cvd = 0;

  const points = [];

  for (const t of trades) {
    if (t.side === "buy") {
      cvd += t.size;
    } else if (t.side === "sell") {
      cvd -= t.size;
    }

    points.push({
      time: t.time,
      cvd
    });
  }

  const first = points[0]?.cvd || 0;
  const last = points.at(-1)?.cvd || 0;

  return {
    start: first,
    end: last,
    change: last - first,
    points
  };
}

/* =========================================================
   OPEN INTEREST
========================================================= */

async function getOpenInterest(symbol) {
  const result = await bybit("/v5/market/open-interest", {
    category: "linear",
    symbol,
    intervalTime: "5min",
    limit: 20
  });

  const list = (result.list || [])
    .map(x => ({
      time: num(x.timestamp),
      oi: num(x.openInterest)
    }))
    .sort((a, b) => a.time - b.time);

  if (!list.length) {
    return {
      current: 0,
      previous: 0,
      changePercent: 0
    };
  }

  const current = list.at(-1).oi;
  const previous = list.length > 1
    ? list.at(-2).oi
    : current;

  return {
    current,
    previous,
    changePercent:
      previous > 0
        ? ((current - previous) / previous) * 100
        : 0
  };
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function getOrderBook(symbol) {
  const result = await bybit("/v5/market/orderbook", {
    category: "linear",
    symbol,
    limit: ORDERBOOK_LIMIT
  });

  const bids = (result.b || []).map(x => ({
    price: num(x[0]),
    size: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  const asks = (result.a || []).map(x => ({
    price: num(x[0]),
    size: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  const bidValue = sum(bids.map(x => x.value));
  const askValue = sum(asks.map(x => x.value));

  const total = bidValue + askValue;

  return {
    bids,
    asks,
    bidValue,
    askValue,
    imbalance:
      total > 0
        ? ((bidValue - askValue) / total) * 100
        : 0
  };
}

/* =========================================================
   RETEST DETECTION
========================================================= */

function isPriceNearZone(price, zone) {
  if (!price || !zone) return false;

  const distance =
    price < zone.low
      ? ((zone.low - price) / zone.low) * 100
      : price > zone.high
        ? ((price - zone.high) / zone.high) * 100
        : 0;

  return distance <= RETEST_TOLERANCE_PERCENT;
}

function detectRetest(candles, zone, absorptionIndex) {
  let retest = null;

  for (
    let i = absorptionIndex + 1;
    i < candles.length;
    i++
  ) {
    const c = candles[i];

    const touches =
      isPriceNearZone(c.low, zone) ||
      isPriceNearZone(c.close, zone) ||
      (
        c.low <= zone.high &&
        c.high >= zone.low
      );

    if (!touches) continue;

    const bullish =
      c.close > c.open;

    const rejection =
      bullish &&
      c.close >= zone.high;

    retest = {
      found: true,
      time: c.time,
      price: c.close,
      bullish,
      rejection
    };

    if (rejection) {
      return {
        ...retest,
        success: true
      };
    }
  }

  return retest
    ? {
        ...retest,
        success: false
      }
    : {
        found: false,
        success: false
      };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structureConfirmation(candles) {
  if (candles.length < 20) {
    return {
      bullish: false,
      bearish: false,
      score: 0
    };
  }

  const recent = candles.slice(-10);

  const highs = recent.map(x => x.high);
  const lows = recent.map(x => x.low);

  const highest = Math.max(...highs);
  const lowest = Math.min(...lows);

  const last = recent.at(-1);

  let score = 0;

  if (last.close > recent[0].close) {
    score += 15;
  }

  if (last.close > avg(recent.map(x => x.close))) {
    score += 10;
  }

  const bullish =
    score >= 15 &&
    last.close > lowest;

  return {
    bullish,
    bearish: !bullish,
    score,
    highest,
    lowest
  };
}

/* =========================================================
   TIMEFRAME CONFIRMATION
========================================================= */

async function timeframeConfirmation(symbol, interval) {
  const candles = await getKlines(
    symbol,
    interval,
    80
  );

  const structure =
    structureConfirmation(candles);

  const last = candles.at(-1);

  if (!last) {
    return {
      interval,
      bullish: false,
      score: 0
    };
  }

  const ema20 = avg(
    candles.slice(-20).map(x => x.close)
  );

  let score = structure.score;

  if (last.close > ema20) {
    score += 10;
  }

  const recent = candles.slice(-5);

  const greenRatio =
    recent.filter(x => x.close > x.open).length /
    recent.length;

  if (greenRatio >= 0.6) {
    score += 10;
  }

  return {
    interval,
    bullish: score >= 20,
    score: clamp(score, 0, 35),
    close: last.close,
    ema20
  };
}

/* =========================================================
   ABSORPTION SCORING
========================================================= */

function calculateFinalScore({
  absorption,
  delta,
  cvd,
  oi,
  orderbook,
  confirmations,
  retest
}) {
  let score = absorption.score;

  /*
   * Negative delta while price remains stable
   * is one of the strongest clues for seller absorption.
   */

  if (delta.deltaPercent <= -35) {
    score += 12;
  } else if (delta.deltaPercent <= -20) {
    score += 8;
  } else if (delta.deltaPercent < 0) {
    score += 4;
  }

  /* CVD */
  if (cvd.change < 0 && delta.deltaPercent < 0) {
    score += 5;
  }

  /*
   * Rising OI can indicate fresh positions entering.
   * It does NOT by itself identify longs.
   */

  if (oi.changePercent >= 3) {
    score += 7;
  } else if (oi.changePercent >= 1) {
    score += 4;
  }

  /* Bid-side liquidity */
  if (orderbook.imbalance >= 15) {
    score += 6;
  } else if (orderbook.imbalance >= 5) {
    score += 3;
  }

  /* Higher timeframe confirmation */
  for (const c of confirmations) {
    if (c.bullish) {
      score += Math.min(6, c.score * 0.2);
    }
  }

  /* Retest */
  if (retest.success) {
    score += 15;
  } else if (retest.found) {
    score += 5;
  }

  return clamp(Math.round(score), 0, 100);
}

/* =========================================================
   SINGLE SYMBOL ANALYSIS
========================================================= */

async function analyzeSymbol(symbol, options = {}) {
  const candles =
    options.candles ||
    await getKlines(
      symbol,
      MAIN_TF,
      KLINE_LIMIT
    );

  if (candles.length < 40) {
    return {
      ok: false,
      symbol,
      reason: "Not enough candles"
    };
  }

  /*
   * Search backwards for the most recent absorption
   * that follows meaningful bullish pressure.
   */

  let absorption = null;
  let pump = null;

  const start =
    Math.max(25, candles.length - 70);

  for (
    let i = candles.length - 5;
    i >= start;
    i--
  ) {
    const detected =
      detectAbsorption(candles, i);

    if (!detected) continue;

    const detectedPump =
      detectPump(candles, i);

    if (!detectedPump) continue;

    absorption = detected;
    pump = detectedPump;
    break;
  }

  if (!absorption) {
    return {
      ok: true,
      found: false,
      symbol
    };
  }

  const zone = {
    low: absorption.zoneLow,
    high: absorption.zoneHigh
  };

  const trades = await getRecentTrades(symbol);

  const delta = makeDelta(trades);

  const cvd = calculateCVD(trades);

  const oi = await getOpenInterest(symbol);

  const orderbook = await getOrderBook(symbol);

  const retest =
    detectRetest(
      candles,
      zone,
      absorption.index
    );

  const confirmations = await Promise.all([
    timeframeConfirmation(symbol, CONFIRM_TF_15M),
    timeframeConfirmation(symbol, CONFIRM_TF_3M),
    timeframeConfirmation(symbol, CONFIRM_TF_1M)
  ]);

  const finalScore =
    calculateFinalScore({
      absorption,
      delta,
      cvd,
      oi,
      orderbook,
      confirmations,
      retest
    });

  const currentPrice =
    candles.at(-1).close;

  const inZone =
    isPriceNearZone(
      currentPrice,
      zone
    );

  let signal = "WATCH";

  if (
    finalScore >= 80 &&
    (retest.success || inZone)
  ) {
    signal = "STRONG_LONG";
  } else if (
    finalScore >= 70 &&
    (retest.success || inZone)
  ) {
    signal = "LONG";
  } else if (
    finalScore >= MIN_ABSORPTION_SCORE
  ) {
    signal = "ABSORPTION_WATCH";
  }

  return {
    ok: true,
    found: true,

    version: VERSION,

    symbol,

    direction: "LONG",

    signal,

    score: finalScore,

    currentPrice,

    timeframe: {
      primary: MAIN_TF,
      confirmations: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ]
    },

    pump: {
      percent: pump.pumpPercent,
      greenRatio: pump.greenRatio,
      strongestCandlePercent:
        pump.strongestCandlePercent,
      startTime: pump.startTime,
      endTime: pump.endTime
    },

    absorption: {
      time: absorption.time,

      open: absorption.open,
      high: absorption.high,
      low: absorption.low,
      close: absorption.close,

      bodyRatio: absorption.bodyRatio,
      rangeRatio: absorption.rangeRatio,

      volume: absorption.volume,
      averageVolume:
        absorption.averageVolume,
      volumeRatio:
        absorption.volumeRatio,

      score: absorption.score
    },

    zone: {
      low: zone.low,
      high: zone.high,

      widthPercent:
        zone.low > 0
          ? ((zone.high - zone.low) /
             zone.low) * 100
          : 0,

      currentPriceInOrNear:
        inZone
    },

    delta: {
      buyVolume:
        delta.buyVolume,
      sellVolume:
        delta.sellVolume,
      deltaVolume:
        delta.deltaVolume,
      deltaPercent:
        delta.deltaPercent,
      buyRatio:
        delta.buyRatio
    },

    cvd: {
      start:
        cvd.start,
      end:
        cvd.end,
      change:
        cvd.change
    },

    openInterest: {
      current:
        oi.current,
      previous:
        oi.previous,
      changePercent:
        oi.changePercent
    },

    orderBook: {
      bidValue:
        orderbook.bidValue,
      askValue:
        orderbook.askValue,
      imbalance:
        orderbook.imbalance
    },

    retest,

    confirmations,

    candles: {
      latest:
        candles.slice(-20)
    },

    timestamp:
      Date.now()
  };
}

/* =========================================================
   SCAN
========================================================= */

async function scanMarkets() {
  const symbols =
    await getSymbols();

  const results = [];

  for (
    let i = 0;
    i < symbols.length;
    i += SCAN_BATCH
  ) {
    const batch =
      symbols.slice(
        i,
        i + SCAN_BATCH
      );

    const batchResults =
      await Promise.all(
        batch.map(async symbol => {
          try {
            return await analyzeSymbol(symbol);
          } catch (e) {
            return {
              ok: false,
              symbol,
              error: e.message
            };
          }
        })
      );

    results.push(...batchResults);

    if (
      i + SCAN_BATCH <
      symbols.length
    ) {
      await sleep(150);
    }
  }

  return results
    .filter(x =>
      x.ok &&
      x.found
    )
    .sort((a, b) =>
      b.score - a.score
    );
}

/* =========================================================
   ROUTER
========================================================= */

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Absorption Zone Scanner</title>
</head>
<body>
<h2>Absorption Zone Scanner</h2>
<p>Frontend is not installed yet.</p>
</body>
</html>`;
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "Content-Type"
      }
    });
  }

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html"
  ) {
    return new Response(
      htmlPage(),
      {
        headers: {
          "content-type":
            "text/html; charset=utf-8"
        }
      }
    );
  }

  if (
    url.pathname === "/api/health"
  ) {
    return json({
      ok: true,
      online: true,
      version: VERSION,
      exchange: "Bybit",
      market: "USDT Perpetual Futures",
      primaryTimeframe: MAIN_TF,
      confirmationTimeframes: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ],
      timestamp: Date.now()
    });
  }

  if (
    url.pathname === "/api/symbols"
  ) {
    try {
      const symbols =
        await getSymbols();

      return json({
        ok: true,
        count: symbols.length,
        symbols
      });
    } catch (e) {
      return error(
        e.message,
        500
      );
    }
  }

  if (
    url.pathname === "/api/analyze"
  ) {
    const symbol =
      (
        url.searchParams.get("symbol") ||
        ""
      )
      .trim()
      .toUpperCase();

    if (!symbol) {
      return error(
        "Symbol is required",
        400
      );
    }

    try {
      const result =
        await analyzeSymbol(
          symbol
        );

      return json(result);
    } catch (e) {
      return error(
        e.message,
        500,
        { symbol }
      );
    }
  }

  if (
    url.pathname === "/api/scan"
  ) {
    try {
      const results =
        await scanMarkets();

      return json({
        ok: true,
        version: VERSION,
        count: results.length,
        scannedAt: Date.now(),
        results
      });
    } catch (e) {
      return error(
        e.message,
        500
      );
    }
  }

  if (
    url.pathname === "/api/config"
  ) {
    return json({
      ok: true,

      version: VERSION,

      primaryTimeframe:
        MAIN_TF,

      confirmationTimeframes: [
        CONFIRM_TF_15M,
        CONFIRM_TF_3M,
        CONFIRM_TF_1M
      ],

      settings: {
        klineLimit:
          KLINE_LIMIT,

        tradeLimit:
          TRADE_LIMIT,

        orderbookLimit:
          ORDERBOOK_LIMIT,

        scanBatch:
          SCAN_BATCH,

        maxSymbols:
          MAX_SYMBOLS,

        minVolumeRatio:
          MIN_VOLUME_RATIO,

        minAbsorptionScore:
          MIN_ABSORPTION_SCORE,

        retestTolerancePercent:
          RETEST_TOLERANCE_PERCENT
      }
    });
  }

  return error(
    "Not Found",
    404
  );
}

/* =========================================================
   WORKER
========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(
        request
      );
    } catch (e) {
      return error(
        e.message || "Internal error",
        500
      );
    }
  }
};
