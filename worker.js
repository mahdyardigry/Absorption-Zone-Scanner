const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ZONE-SCANNER-V4";

const MAIN_TF = "5";
const TF_15M = "15";
const TF_3M = "3";
const TF_1M = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const MIN_VOLUME_RATIO = 1.5;
const MIN_ABSORPTION_SCORE = 60;

const RETEST_LOOKBACK_CANDLES = 18;
const RETEST_MAX_DISTANCE_PERCENT = 0.60;
const RETEST_CONFIRMATION_BARS = 3;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));


/* =========================================================
   BYBIT
========================================================= */

async function bybit(path, params = {}) {

  const url =
    new URL(
      BYBIT + path
    );

  for (
    const [key, value]
    of Object.entries(params)
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
    await fetch(
      url.toString(),
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "Accept":
            "application/json",
          "User-Agent":
            "Mozilla/5.0 AbsorptionZoneScanner",
          "Cache-Control":
            "no-cache"
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      `Bybit HTTP ${response.status}: ${text.slice(0,300)}`
    );

  }

  if (!response.ok) {

    throw new Error(
      `Bybit HTTP ${response.status}: ${
        data?.retMsg ||
        text.slice(0,300)
      }`
    );

  }

  if (
    data.retCode !== undefined &&
    data.retCode !== 0
  ) {

    throw new Error(
      `Bybit API ${data.retCode}: ${
        data.retMsg ||
        "خطای Bybit"
      }`
    );

  }

  return data.result;

}


/* =========================================================
   UTILS
========================================================= */

function num(
  value,
  fallback = 0
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;

}


function clamp(
  value,
  min = 0,
  max = 100
) {

  return Math.max(
    min,
    Math.min(
      max,
      num(value)
    )
  );

}


function avg(arr) {

  if (
    !Array.isArray(arr) ||
    !arr.length
  ) {
    return 0;
  }

  return (
    arr.reduce(
      (a,b) =>
        a + num(b),
      0
    ) /
    arr.length
  );

}


function sum(arr) {

  if (
    !Array.isArray(arr) ||
    !arr.length
  ) {
    return 0;
  }

  return arr.reduce(
    (a,b) =>
      a + num(b),
    0
  );

}


function pctChange(
  from,
  to
) {

  from = num(from);
  to = num(to);

  if (!from) {
    return 0;
  }

  return (
    (to - from) /
    from
  ) * 100;

}


function last(arr) {

  return arr?.length
    ? arr[arr.length - 1]
    : null;

}


function median(arr) {

  if (!arr?.length) {
    return 0;
  }

  const values =
    arr
      .map(num)
      .sort(
        (a,b) => a-b
      );

  const middle =
    Math.floor(
      values.length / 2
    );

  return values.length % 2
    ? values[middle]
    : (
        values[middle - 1] +
        values[middle]
      ) / 2;

}


function ema(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return 0;
  }

  const multiplier =
    2 /
    (period + 1);

  let result =
    avg(
      values.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      (
        values[i] -
        result
      ) *
      multiplier +
      result;

  }

  return result;

}


/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {

  const result =
    await bybit(
      "/v5/market/instruments-info",
      {
        category:"linear",
        status:"Trading",
        limit:1000
      }
    );

  const list =
    Array.isArray(
      result?.list
    )
      ? result.list
      : [];

  const symbols =
    list.filter(
      x =>
        x &&
        x.symbol &&
        x.quoteCoin === "USDT" &&
        x.contractType ===
          "LinearPerpetual"
    );

  let tickerMap = {};

  try {

    const ticker =
      await bybit(
        "/v5/market/tickers",
        {
          category:"linear"
        }
      );

    for (
      const t
      of ticker?.list || []
    ) {

      tickerMap[
        t.symbol
      ] = {

        lastPrice:
          num(t.lastPrice),

        volume24h:
          num(t.volume24h),

        turnover24h:
          num(t.turnover24h),

        price24hPcnt:
          num(t.price24hPcnt) *
          100

      };

    }

  } catch {

    tickerMap = {};

  }

  return symbols
    .map(
      s => ({
        symbol:
          s.symbol,
        baseCoin:
          s.baseCoin,
        quoteCoin:
          s.quoteCoin,
        status:
          s.status,
        ...(tickerMap[
          s.symbol
        ] || {})
      })
    )
    .sort(
      (a,b) =>
        num(b.turnover24h) -
        num(a.turnover24h)
    )
    .slice(
      0,
      MAX_SYMBOLS
    );

}


async function findSymbol(
  input
) {

  const raw =
    String(input || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!raw) {
    return null;
  }

  const symbols =
    await getSymbols();

  return (
    symbols.find(
      x =>
        x.symbol === raw
    ) ||
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
  interval,
  limit = KLINE_LIMIT
) {

  const result =
    await bybit(
      "/v5/market/kline",
      {
        category:"linear",
        symbol,
        interval,
        limit
      }
    );

  return (
    Array.isArray(
      result?.list
    )
      ? result.list
      : []
  )
    .map(
      row => ({
        startTime:
          num(row[0]),
        open:
          num(row[1]),
        high:
          num(row[2]),
        low:
          num(row[3]),
        close:
          num(row[4]),
        volume:
          num(row[5]),
        turnover:
          num(row[6])
      })
    )
    .sort(
      (a,b) =>
        a.startTime -
        b.startTime
    );

}


/* =========================================================
   CANDLE
========================================================= */

function candleStats(c) {

  const open =
    num(c.open);

  const high =
    num(c.high);

  const low =
    num(c.low);

  const close =
    num(c.close);

  const range =
    Math.max(
      high - low,
      0
    );

  const body =
    Math.abs(
      close - open
    );

  const upperWick =
    high -
    Math.max(
      open,
      close
    );

  const lowerWick =
    Math.min(
      open,
      close
    ) - low;

  const change =
    open > 0
      ? (
          (close - open) /
          open
        ) * 100
      : 0;

  return {

    range,
    body,

    upperWick,
    lowerWick,

    bodyRatio:
      range
        ? body / range
        : 0,

    upperWickRatio:
      range
        ? upperWick / range
        : 0,

    lowerWickRatio:
      range
        ? lowerWick / range
        : 0,

    change,

    bullish:
      close > open,

    bearish:
      close < open,

    neutral:
      Math.abs(change) <=
      0.15

  };

}


/* =========================================================
   VOLUME
========================================================= */

function volumeAnalysis(
  candles,
  index
) {

  const current =
    candles[index];

  const previous =
    candles
      .slice(
        Math.max(
          0,
          index - 20
        ),
        index
      )
      .map(
        x => x.volume
      );

  const averageVolume =
    avg(previous);

  const ratio =
    averageVolume > 0
      ? current.volume /
        averageVolume
      : 0;

  return {

    currentVolume:
      current.volume,

    averageVolume,

    ratio,

    spike:
      ratio >=
      MIN_VOLUME_RATIO

  };

}


/* =========================================================
   PUMP
========================================================= */

function detectPump(
  candles,
  index
) {

  if (
    !candles ||
    index < 6
  ) {
    return null;
  }

  const current =
    candles[index];

  const start =
    Math.max(
      0,
      index - 12
    );

  const base =
    candles[start];

  const pumpPercent =
    pctChange(
      base.close,
      current.close
    );

  const window =
    candles.slice(
      start,
      index + 1
    );

  const green =
    window.filter(
      x =>
        x.close >
        x.open
    ).length;

  const greenRatio =
    window.length
      ? green /
        window.length
      : 0;

  const high =
    Math.max(
      ...window.map(
        x => x.high
      )
    );

  const low =
    Math.min(
      ...window.map(
        x => x.low
      )
    );

  const rangeMove =
    pctChange(
      low,
      high
    );

  if (
    pumpPercent < 2 &&
    rangeMove < 2
  ) {
    return null;
  }

  return {

    startTime:
      base.startTime,

    endTime:
      current.startTime,

    startPrice:
      base.close,

    endPrice:
      current.close,

    pumpPercent,

    greenRatio,

    rangeMove,

    score:
      clamp(
        pumpPercent * 8 +
        greenRatio * 25 +
        Math.min(
          rangeMove * 2,
          20
        )
      )

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
    candleStats(
      previous
    );

  const previousFive =
    candles
      .slice(
        Math.max(
          0,
          index - 5
        ),
        index
      )
      .map(candleStats);

  const bullishContext =
    previousFive.filter(
      x =>
        x.bullish
    ).length >= 3 ||
    previousStats.bullish;

  const recent =
    candles.slice(
      Math.max(
        0,
        index - 8
      ),
      index
    );

  const recentHigh =
    recent.length
      ? Math.max(
          ...recent.map(
            x => x.high
          )
        )
      : c.high;

  const nearResistance =
    recentHigh > 0 &&
    (
      (
        recentHigh -
        c.high
      ) /
      recentHigh
    ) * 100 <= 1.5;

  const weakRed =
    stats.bearish &&
    Math.abs(
      stats.change
    ) <= 1.5;

  const neutral =
    stats.neutral;

  const highVolume =
    volume.ratio >=
    MIN_VOLUME_RATIO;

  const longLowerWick =
    stats.lowerWickRatio >=
    0.25;

  const smallBody =
    stats.bodyRatio <=
    0.45;

  let score = 0;

  if (weakRed) {
    score += 18;
  } else if (neutral) {
    score += 14;
  }

  if (highVolume) {
    score += Math.min(
      25,
      volume.ratio * 8
    );
  }

  if (longLowerWick) {
    score += 18;
  }

  if (smallBody) {
    score += 12;
  }

  if (bullishContext) {
    score += 12;
  }

  if (nearResistance) {
    score += 5;
  }

  score =
    clamp(score);

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

    time:
      c.startTime,

    open:
      c.open,

    high:
      c.high,

    low:
      c.low,

    close:
      c.close,

    volume:
      c.volume,

    volumeRatio:
      volume.ratio,

    change:
      stats.change,

    bodyRatio:
      stats.bodyRatio,

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
   SETUP
========================================================= */

function findAbsorptionSetup(
  candles
) {

  if (
    !candles?.length
  ) {
    return null;
  }

  let best = null;

  const start =
    Math.max(
      20,
      candles.length - 60
    );

  for (
    let i = start;
    i < candles.length;
    i++
  ) {

    const pump =
      detectPump(
        candles,
        i
      );

    if (!pump) {
      continue;
    }

    const absorption =
      detectAbsorption(
        candles,
        i
      );

    if (!absorption) {
      continue;
    }

    const score =
      clamp(
        pump.score * 0.35 +
        absorption.score *
        0.65
      );

    const candidate = {

      pump,
      absorption,

      score

    };

    if (
      !best ||
      candidate.score >
      best.score
    ) {

      best =
        candidate;

    }

  }

  return best;

}


/* =========================================================
   RECENT TRADES
========================================================= */

async function getRecentTrades(
  symbol,
  limit = TRADE_LIMIT
) {

  const result =
    await bybit(
      "/v5/market/recent-trade",
      {
        category:"linear",
        symbol,
        limit
      }
    );

  return (
    Array.isArray(
      result?.list
    )
      ? result.list
      : []
  )
    .map(
      t => ({

        id:
          t.execId,

        price:
          num(t.price),

        size:
          num(t.size),

        side:
          t.side,

        time:
          num(t.time)

      })
    );

}


/* =========================================================
   FOOTPRINT
========================================================= */

function makeFootprint(
  trades,
  zone
) {

  if (
    !trades?.length
  ) {

    return {

      source:
        "recent-trade",

      historicalMatched:
        false,

      historicalCandleTime:
        zone?.time || null,

      selectedWindowStart:
        null,

      selectedWindowEnd:
        null,

      buyVolume:0,
      sellVolume:0,

      buyNotional:0,
      sellNotional:0,

      delta:0,
      deltaPercent:0,

      totalVolume:0,
      tradeCount:0,

      pressure:
        "neutral"

    };

  }

  let selected =
    trades;

  let historicalMatched =
    false;

  let selectedWindowStart =
    null;

  let selectedWindowEnd =
    null;

  if (
    zone?.time
  ) {

    selectedWindowStart =
      zone.time;

    selectedWindowEnd =
      zone.time +
      5 * 60 * 1000;

    const matched =
      trades.filter(
        t =>
          t.time >=
          selectedWindowStart &&
          t.time <
          selectedWindowEnd
      );

    if (
      matched.length
    ) {

      selected =
        matched;

      historicalMatched =
        true;

    }

  }

  let buyVolume = 0;
  let sellVolume = 0;

  for (
    const trade
    of selected
  ) {

    const value =
      num(trade.price) *
      num(trade.size);

    if (
      String(
        trade.side
      ).toLowerCase() ===
      "buy"
    ) {

      buyVolume +=
        value;

    } else {

      sellVolume +=
        value;

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
      ? (
          delta /
          totalVolume
        ) * 100
      : 0;

  return {

    source:
      historicalMatched
        ? "recent-trade-matched"
        : "recent-trade",

    historicalMatched,

    historicalCandleTime:
      zone?.time || null,

    selectedWindowStart,

    selectedWindowEnd,

    buyVolume,

    sellVolume,

    buyNotional:
      buyVolume,

    sellNotional:
      sellVolume,

    delta,

    deltaPercent,

    totalVolume,

    tradeCount:
      selected.length,

    pressure:
      deltaPercent >= 10
        ? "buy"
        :
      deltaPercent <= -10
        ? "sell"
        :
        "neutral"

  };

}


/* =========================================================
   ORDERBOOK
========================================================= */

async function getOrderbook(
  symbol
) {

  const result =
    await bybit(
      "/v5/market/orderbook",
      {
        category:"linear",
        symbol,
        limit:
          ORDERBOOK_LIMIT
      }
    );

  const bids =
    (
      result?.b || []
    )
      .map(
        x => [
          num(x[0]),
          num(x[1])
        ]
      );

  const asks =
    (
      result?.a || []
    )
      .map(
        x => [
          num(x[0]),
          num(x[1])
        ]
      );

  const buyLiquidity =
    sum(
      bids.map(
        x =>
          x[0] *
          x[1]
      )
    );

  const sellLiquidity =
    sum(
      asks.map(
        x =>
          x[0] *
          x[1]
      )
    );

  const total =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    total > 0
      ? (
          buyLiquidity /
          total
        ) * 100
      : 0;

  const sellShare =
    total > 0
      ? (
          sellLiquidity /
          total
        ) * 100
      : 0;

  const imbalance =
    buyShare -
    sellShare;

  const values =
    [
      ...bids.map(
        x => x[0] * x[1]
      ),
      ...asks.map(
        x => x[0] * x[1]
      )
    ];

  const wallThreshold =
    median(values) * 4;

  const buyWalls =
    bids.filter(
      x =>
        x[0] * x[1] >=
        wallThreshold
    );

  const sellWalls =
    asks.filter(
      x =>
        x[0] * x[1] >=
        wallThreshold
    );

  return {

    buyLiquidity,
    sellLiquidity,

    totalLiquidity:
      total,

    buyShare,
    sellShare,

    imbalance,

    pressure:
      imbalance > 8
        ? "buy"
        :
      imbalance < -8
        ? "sell"
        :
        "neutral",

    bestBid:
      bids[0]?.[0] || 0,

    bestAsk:
      asks[0]?.[0] || 0,

    buyWalls:
      buyWalls.length,

    sellWalls:
      sellWalls.length

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
        category:"linear",
        symbol,
        intervalTime:"5min",
        limit:2
      }
    );

  const list =
    result?.list || [];

  const current =
    num(
      list[0]?.openInterest
    );

  const previous =
    num(
      list[1]?.openInterest
    );

  return {

    current,

    previous,

    change:
      previous > 0
        ? (
            (
              current -
              previous
            ) /
            previous
          ) * 100
        : 0

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

      detected:false,
      confirmed:false,

      index:-1,

      barsSinceRetest:null,

      zoneHigh:
        absorption?.zoneHigh ||
        0,

      zoneLow:
        absorption?.zoneLow ||
        0,

      tolerance:0,

      distanceToZone:0,

      distancePercent:0,

      rejection:false,

      recent:false,

      currentNear:false,

      reason:
        "کندل کافی برای بازآزمایی وجود ندارد.",

      status:
        "NO_RETEST"

    };

  }

  const zoneHigh =
    num(
      absorption.zoneHigh
    );

  const zoneLow =
    num(
      absorption.zoneLow
    );

  const zoneWidth =
    Math.max(
      zoneHigh -
      zoneLow,
      0
    );

  const tolerance =
    Math.max(
      zoneWidth * 0.15,
      zoneHigh * 0.001
    );

  const startIndex =
    Math.max(
      absorption.index + 1,
      candles.length -
      RETEST_LOOKBACK_CANDLES
    );

  let retestIndex =
    -1;

  let rejection =
    false;

  for (
    let i = startIndex;
    i < candles.length;
    i++
  ) {

    const c =
      candles[i];

    const touches =
      c.low <=
        zoneHigh +
        tolerance &&
      c.high >=
        zoneLow -
        tolerance;

    if (!touches) {
      continue;
    }

    retestIndex =
      i;

    const stats =
      candleStats(c);

    const bullishReaction =
      c.close >
      zoneHigh ||
      (
        stats.bullish &&
        stats.lowerWickRatio >=
        0.20
      );

    const bearishReaction =
      c.close <
      zoneLow ||
      (
        stats.bearish &&
        stats.upperWickRatio >=
        0.20
      );

    if (
      bullishReaction ||
      bearishReaction
    ) {

      rejection =
        true;

    }

  }

  const current =
    last(candles);

  const currentPrice =
    num(
      current?.close
    );

  let distancePercent = 0;

  if (
    currentPrice >
    zoneHigh
  ) {

    distancePercent =
      (
        (
          currentPrice -
          zoneHigh
        ) /
        zoneHigh
      ) * 100;

  } else if (
    currentPrice <
    zoneLow
  ) {

    distancePercent =
      (
        (
          zoneLow -
          currentPrice
        ) /
        zoneLow
      ) * 100;

  }

  const currentNear =
    distancePercent <=
    RETEST_MAX_DISTANCE_PERCENT;

  if (
    retestIndex < 0
  ) {

    return {

      detected:false,
      confirmed:false,

      index:-1,

      barsSinceRetest:null,

      zoneHigh,
      zoneLow,

      tolerance,

      distanceToZone:
        distancePercent,

      distancePercent,

      rejection:false,

      recent:false,

      currentNear,

      reason:
        "در کندل‌های اخیر بازآزمایی ناحیه دیده نشد.",

      status:
        "NO_RETEST"

    };

  }

  const barsSinceRetest =
    candles.length -
    1 -
    retestIndex;

  const recent =
    barsSinceRetest <=
    RETEST_CONFIRMATION_BARS;

  const confirmed =
    recent &&
    rejection &&
    currentNear;

  let reason =
    "بازآزمایی دیده شده اما هنوز تأیید کامل نیست.";

  if (confirmed) {

    reason =
      "قیمت اخیراً به ناحیه برگشته، واکنش نشان داده و فاصله فعلی از ناحیه کم است.";

  } else if (!recent) {

    reason =
      "بازآزمایی قدیمی است و برای ورود فعلی کافی نیست.";

  } else if (!rejection) {

    reason =
      "قیمت ناحیه را لمس کرده اما واکنش واضح تأیید نشده است.";

  } else if (!currentNear) {

    reason =
      "واکنش دیده شده ولی قیمت فعلی از ناحیه فاصله گرفته است.";

  }

  return {

    detected:true,

    confirmed,

    index:
      retestIndex,

    barsSinceRetest,

    zoneHigh,
    zoneLow,

    tolerance,

    distanceToZone:
      distancePercent,

    distancePercent,

    rejection,

    recent,

    currentNear,

    reason,

    status:
      confirmed
        ? "CONFIRMED"
        : "TOUCHED"

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
      trend:"unknown",
      bos:false,
      higherHigh:false,
      higherLow:false
    };

  }

  const recent =
    candles.slice(-10);

  const current =
    last(recent);

  const previous =
    recent.slice(
      0,
      -2
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
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

    trend =
      "bullish";

  } else if (
    current.close <
    previousLow
  ) {

    trend =
      "bearish";

  }

  return {

    trend,

    bos:
      current.close >
      previousHigh,

    higherHigh,
    higherLow,

    recentHigh:
      Math.max(
        ...recent.map(
          x => x.high
        )
      ),

    recentLow:
      Math.min(
        ...recent.map(
          x => x.low
        )
      )

  };

}


/* =========================================================
   TIMEFRAME
========================================================= */

function timeframeConfirmation(
  candles
) {

  if (
    !candles ||
    candles.length < 25
  ) {

    return {

      trend:"unknown",

      score:50,

      price:0,

      ema8:0,

      ema20:0

    };

  }

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    last(candles);

  const price =
    current.close;

  const ema8 =
    ema(
      closes,
      8
    );

  const ema20 =
    ema(
      closes,
      20
    );

  let trend =
    "neutral";

  if (
    price >
    ema8 &&
    ema8 >
    ema20
  ) {

    trend =
      "bullish";

  } else if (
    price <
    ema8 &&
    ema8 <
    ema20
  ) {

    trend =
      "bearish";

  }

  return {

    trend,

    score:
      trend === "bullish"
        ? 100
        :
      trend === "bearish"
        ? 0
        : 50,

    price,

    average:
      ema20,

    ema8,
    ema20

  };

}


/* =========================================================
   SCORE
========================================================= */

function calculateFinalScore(
  setup,
  footprint,
  orderbook,
  openInterest,
  confirmations,
  retest,
  structure
) {

  let score =
    setup.absorption.score *
    0.35;

  score +=
    Math.min(
      20,
      Math.max(
        0,
        setup.pump.pumpPercent * 2
      )
    );

  if (
    footprint.historicalMatched
  ) {

    if (
      footprint.deltaPercent >=
      10
    ) {

      score += 6;

    } else if (
      footprint.deltaPercent >=
      0
    ) {

      score += 3;

    }

  } else {

    if (
      footprint.deltaPercent >=
      10
    ) {

      score += 3;

    } else if (
      footprint.deltaPercent > -15
    ) {

      score += 1;

    }

  }

  if (
    orderbook.imbalance >
    8
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
    confirmations["15m"].trend ===
    "bullish"
  ) {

    score += 8;

  }

  if (
    confirmations["3m"].trend ===
    "bullish"
  ) {

    score += 5;

  }

  if (
    confirmations["1m"].trend ===
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

  if (!setup) {
    return "NO_SETUP";
  }

  const bullish15 =
    confirmations["15m"]?.trend ===
    "bullish";

  const bullishLower =
    confirmations["3m"]?.trend ===
    "bullish" ||
    confirmations["1m"]?.trend ===
    "bullish";

  if (
    score >= 80 &&
    retest.confirmed &&
    bullish15 &&
    bullishLower
  ) {

    return "STRONG_LONG";

  }

  if (
    score >= 70 &&
    retest.confirmed &&
    bullish15 &&
    bullishLower
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
   1M ENTRY
========================================================= */

function calculateEntry1M(
  candles1,
  zone,
  retest,
  confirmation1,
  currentPrice
) {

  if (
    !candles1?.length ||
    !zone
  ) {

    return {

      status:"WAIT",
      direction:"unknown",

      entryLow:0,
      entryHigh:0,
      entryPrice:0,

      stopLoss:0,

      target1:0,
      target2:0,

      rr1:0,
      rr2:0,

      reason:
        "داده کافی برای محاسبه ورود وجود ندارد."

    };

  }

  const price =
    num(currentPrice);

  const zoneHigh =
    num(zone.zoneHigh);

  const zoneLow =
    num(zone.zoneLow);

  const zoneWidth =
    Math.max(
      zoneHigh -
      zoneLow,
      0
    );

  const recent =
    candles1.slice(-12);

  const current =
    last(recent);

  const previous =
    recent.length >= 2
      ? recent[
          recent.length - 2
        ]
      : null;

  const recentHigh =
    recent.length
      ? Math.max(
          ...recent.map(
            x => x.high
          )
        )
      : price;

  const recentLow =
    recent.length
      ? Math.min(
          ...recent.map(
            x => x.low
          )
        )
      : price;

  const bullish1M =
    confirmation1?.trend ===
    "bullish";

  const bearish1M =
    confirmation1?.trend ===
    "bearish";

  const bullishBreak =
    current &&
    current.close >
    Math.max(
      zoneHigh,
      previous?.high || 0
    );

  const bearishBreak =
    current &&
    current.close <
    Math.min(
      zoneLow,
      previous?.low ||
      zoneLow
    );

  const padding =
    Math.max(
      zoneWidth * 0.10,
      price * 0.0005
    );


  /* ---------------------------------------------------------
     BUY
  --------------------------------------------------------- */

  if (
    bullish1M ||
    (
      retest?.confirmed &&
      price >= zoneLow
    ) ||
    bullishBreak
  ) {

    let entryLow;
    let entryHigh;

    if (
      price >=
        zoneLow - padding &&
      price <=
        zoneHigh + padding
    ) {

      entryLow =
        Math.max(
          zoneLow,
          price - padding
        );

      entryHigh =
        Math.min(
          zoneHigh + padding,
          price + padding
        );

    } else if (
      price >
      zoneHigh
    ) {

      entryLow =
        zoneHigh;

      entryHigh =
        zoneHigh +
        padding;

    } else {

      entryLow =
        zoneLow;

      entryHigh =
        zoneHigh;

    }

    const entryPrice =
      (
        entryLow +
        entryHigh
      ) / 2;

    const stopBuffer =
      Math.max(
        zoneWidth * 0.20,
        entryPrice * 0.001
      );

    const stopLoss =
      Math.max(
        0,
        zoneLow -
        stopBuffer
      );

    const risk =
      Math.max(
        entryPrice -
        stopLoss,
        entryPrice *
        0.001
      );

    const target1 =
      entryPrice +
      risk * 1.5;

    const target2 =
      Math.max(
        entryPrice +
        risk * 2.5,
        recentHigh
      );

    const rr1 =
      (
        target1 -
        entryPrice
      ) / risk;

    const rr2 =
      (
        target2 -
        entryPrice
      ) / risk;

    let status =
      "WAIT";

    if (
      retest?.confirmed &&
      bullish1M
    ) {

      status =
        "READY";

    } else if (
      retest?.detected ||
      bullish1M ||
      bullishBreak
    ) {

      status =
        "CONFIRM";

    }

    return {

      status,

      direction:
        "long",

      entryLow,
      entryHigh,
      entryPrice,

      stopLoss,

      target1,
      target2,

      risk,

      rr1,
      rr2,

      currentPrice:
        price,

      zoneHigh,
      zoneLow,

      confirmation1M:
        confirmation1?.trend ||
        "unknown",

      retestConfirmed:
        !!retest?.confirmed,

      bullishBreak:
        !!bullishBreak,

      bearishBreak:
        !!bearishBreak,

      recentHigh,
      recentLow,

      reason:
        status === "READY"
          ? "بازآزمایی ناحیه و حرکت 1 دقیقه‌ای هر دو به نفع خریداران تأیید شده‌اند."
          :
        status === "CONFIRM"
          ? "شرایط ورود در حال شکل‌گیری است؛ برای ورود بهتر منتظر تأیید کامل 1 دقیقه بمان."
          :
            "هنوز تأیید کامل ورود در 1 دقیقه وجود ندارد."

    };

  }


  /* ---------------------------------------------------------
     SELL
  --------------------------------------------------------- */

  if (
    bearish1M ||
    bearishBreak
  ) {

    let entryLow =
      zoneLow;

    let entryHigh =
      zoneHigh;

    const entryPrice =
      (
        entryLow +
        entryHigh
      ) / 2;

    const stopBuffer =
      Math.max(
        zoneWidth * 0.20,
        entryPrice * 0.001
      );

    const stopLoss =
      zoneHigh +
      stopBuffer;

    const risk =
      Math.max(
        stopLoss -
        entryPrice,
        entryPrice *
        0.001
      );

    const target1 =
      entryPrice -
      risk * 1.5;

    const target2 =
      Math.min(
        entryPrice -
        risk * 2.5,
        recentLow
      );

    return {

      status:
        bearish1M
          ? "CONFIRM"
          : "WAIT",

      direction:
        "short",

      entryLow,
      entryHigh,
      entryPrice,

      stopLoss,

      target1,
      target2,

      risk,

      rr1:
        (
          entryPrice -
          target1
        ) / risk,

      rr2:
        (
          entryPrice -
          target2
        ) / risk,

      currentPrice:
        price,

      zoneHigh,
      zoneLow,

      confirmation1M:
        confirmation1?.trend ||
        "unknown",

      retestConfirmed:
        !!retest?.confirmed,

      bullishBreak:
        !!bullishBreak,

      bearishBreak:
        !!bearishBreak,

      recentHigh,
      recentLow,

      reason:
        bearish1M
          ? "تایم‌فریم 1 دقیقه نزولی است و مسیر کوتاه‌مدت فعلاً به سمت پایین است."
          : "فشار نزولی دیده می‌شود اما تأیید کامل ورود وجود ندارد."

    };

  }


  return {

    status:
      "WAIT",

    direction:
      "unknown",

    entryLow:
      zoneLow,

    entryHigh:
      zoneHigh,

    entryPrice:
      (
        zoneLow +
        zoneHigh
      ) / 2,

    stopLoss:0,

    target1:0,
    target2:0,

    rr1:0,
    rr2:0,

    currentPrice:
      price,

    zoneHigh,
    zoneLow,

    confirmation1M:
      confirmation1?.trend ||
      "unknown",

    retestConfirmed:
      !!retest?.confirmed,

    bullishBreak:false,
    bearishBreak:false,

    recentHigh,
    recentLow,

    reason:
      "جهت 1 دقیقه هنوز مشخص نیست؛ فعلاً ورود انجام نشود."

  };

}


/* =========================================================
   ANALYZE
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
      "نام ارز وارد نشده است."
    );
  }

  const [
    candles5,
    candles15,
    candles3,
    candles1
  ] =
    await Promise.all([
      getKlines(
        normalized,
        MAIN_TF,
        KLINE_LIMIT
      ),
      getKlines(
        normalized,
        TF_15M,
        100
      ),
      getKlines(
        normalized,
        TF_3M,
        100
      ),
      getKlines(
        normalized,
        TF_1M,
        100
      )
    ]);

  if (
    !candles5.length
  ) {

    throw new Error(
      "داده 5 دقیقه‌ای موجود نیست."
    );

  }

  const current =
    last(candles5);

  const setup =
    findAbsorptionSetup(
      candles5
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

  if (!setup) {

    return {

      ok:true,

      symbol:
        normalized,

      version:
        VERSION,

      signal:
        "NO_SETUP",

      score:0,

      detected:false,

      currentPrice:
        current?.close || 0,

      message:
        "ناحیه جذب معتبر پیدا نشد.",

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

  const zone =
    setup.absorption;

  const [
    trades,
    orderbook,
    openInterest
  ] =
    await Promise.all([
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

  const confirmations = {

    "15m":
      confirmation15,

    "3m":
      confirmation3,

    "1m":
      confirmation1

  };

  const retest =
    detectRetest(
      candles5,
      zone
    );

  const structure =
    structureAnalysis(
      candles5
    );

  const entry1M =
    calculateEntry1M(
      candles1,
      zone,
      retest,
      confirmation1,
      current.close
    );

  const score =
    calculateFinalScore(
      setup,
      footprint,
      orderbook,
      openInterest,
      confirmations,
      retest,
      structure
    );

  const signal =
    signalFromScore(
      score,
      setup,
      retest,
      confirmations
    );

  const distanceToZone =
    current.close >
    zone.zoneHigh
      ? (
          (
            current.close -
            zone.zoneHigh
          ) /
          zone.zoneHigh
        ) * 100
      :
    current.close <
    zone.zoneLow
      ? (
          (
            zone.zoneLow -
            current.close
          ) /
          zone.zoneLow
        ) * 100
      : 0;

  return {

    ok:true,

    symbol:
      normalized,

    version:
      VERSION,

    signal,

    score,

    detected:true,

    currentPrice:
      current.close,

    setup,

    footprint,

    orderbook,

    openInterest,

    retest,

    structure,

    confirmations,

    entry1M,

    direction:

      entry1M.direction !==
      "unknown"

        ? entry1M.direction

        :
      confirmation15.trend ===
      "bullish"

        ? "long"

        :
      confirmation15.trend ===
      "bearish"

        ? "short"

        : "unknown",

    marketPath:

      entry1M.direction ===
      "long"

        ? "up"

        :
      entry1M.direction ===
      "short"

        ? "down"

        : "unknown",

    absorptionSide:

      entry1M.direction ===
      "long"

        ? "buyer"

        :
      entry1M.direction ===
      "short"

        ? "seller"

        : "unknown",

    distanceToZone,

    analysisQuality: {

      recentRetest:
        retest.detected,

      confirmedRetest:
        retest.confirmed,

      bullish15m:
        confirmation15.trend ===
        "bullish",

      bullishLowerTF:
        confirmation3.trend ===
        "bullish" ||
        confirmation1.trend ===
        "bullish",

      currentTradePressure:
        footprint.pressure,

      entry1M:
        entry1M.status

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
    const item
    of selected
  ) {

    try {

      const result =
        await analyzeSymbol(
          item.symbol
        );

      if (
        result &&
        result.detected &&
        Number(
          result.score
        ) >= 60
      ) {

        results.push({

          ...result,

          volume24h:
            item.volume24h,

          turnover24h:
            item.turnover24h,

          price24hPcnt:
            item.price24hPcnt

        });

      }

    } catch {

    }

    await sleep(30);

  }

  results.sort(
    (a,b) =>
      num(b.score) -
      num(a.score)
  );

  return {

    ok:true,

    count:
      results.length,

    signals:
      results.length,

    results,

    timestamp:
      Date.now()

  };

}


/* =========================================================
   JSON
========================================================= */

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,
      headers: {

        "Content-Type":
          "application/json; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "GET,OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type",

        "Cache-Control":
          "no-store"

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

  if (
    request.method ===
    "OPTIONS"
  ) {

    return json({
      ok:true
    });

  }


  if (
    url.pathname ===
    "/api/health"
  ) {

    return json({

      ok:true,

      worker:
        "online",

      exchange:
        "Bybit",

      market:
        "USDT Perpetual Futures",

      version:
        VERSION,

      timestamp:
        Date.now()

    });

  }


  if (
    url.pathname ===
    "/api/config"
  ) {

    return json({

      ok:true,

      version:
        VERSION,

      exchange:
        "Bybit",

      market:
        "USDT Perpetual Futures",

      mainTimeframe:
        MAIN_TF,

      confirmations:
        [
          TF_15M,
          TF_3M,
          TF_1M
        ],

      thresholds: {

        minVolumeRatio:
          MIN_VOLUME_RATIO,

        minAbsorptionScore:
          MIN_ABSORPTION_SCORE,

        retestLookback:
          RETEST_LOOKBACK_CANDLES,

        retestMaxDistance:
          RETEST_MAX_DISTANCE_PERCENT

      }

    });

  }


  if (
    url.pathname ===
    "/api/test-bybit"
  ) {

    try {

      const result =
        await bybit(
          "/v5/market/time"
        );

      return json({

        ok:true,

        bybit:true,

        result,

        timestamp:
          Date.now()

      });

    } catch(error) {

      return json({

        ok:false,

        bybit:false,

        error:
          error.message,

        timestamp:
          Date.now()

      },502);

    }

  }


  if (
    url.pathname ===
    "/api/symbols"
  ) {

    try {

      const symbols =
        await getSymbols();

      return json({

        ok:true,

        count:
          symbols.length,

        symbols,

        timestamp:
          Date.now()

      });

    } catch(error) {

      return json({

        ok:false,

        error:
          error.message

      },502);

    }

  }


  if (
    url.pathname ===
    "/api/analyze"
  ) {

    try {

      const input =
        url.searchParams.get(
          "symbol"
        );

      const found =
        await findSymbol(
          input
        );

      if (!found) {

        return json({

          ok:false,

          error:
            "ارز موردنظر در Bybit Futures پیدا نشد."

        },404);

      }

      return json(
        await analyzeSymbol(
          found.symbol
        )
      );

    } catch(error) {

      return json({

        ok:false,

        error:
          error?.message ||
          String(error),

        timestamp:
          Date.now()

      },502);

    }

  }


  if (
    url.pathname ===
    "/api/scan"
  ) {

    try {

      return json(
        await scanMarkets()
      );

    } catch(error) {

      return json({

        ok:false,

        error:
          error?.message ||
          String(error),

        timestamp:
          Date.now()

      },502);

    }

  }


  if (
    url.pathname === "/"
  ) {

    return new Response(
      `
      <!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
      <meta charset="UTF-8">
      <title>Absorption Zone Scanner</title>
      </head>
      <body style="
        background:#07111f;
        color:white;
        font-family:tahoma;
        text-align:center;
        padding:50px;
      ">
      <h1>🔥 Absorption Zone Scanner</h1>
      <p>Worker آنلاین است.</p>
      <p>Bybit Futures</p>
      </body>
      </html>
      `,
      {
        headers:{
          "Content-Type":
            "text/html; charset=utf-8"
        }
      }
    );

  }


  return json({

    ok:false,

    error:
      "Not Found"

  },404);

}


/* =========================================================
   EXPORT
========================================================= */

export default {

  async fetch(
    request
  ) {

    try {

      return await router(
        request
      );

    } catch(error) {

      return json({

        ok:false,

        error:
          error?.message ||
          String(error)

      },500);

    }

  }

};
