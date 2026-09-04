import { DurableObject } from "cloudflare:workers";

/* =========================================================
   BYBIT SMART MONEY ORDER FLOW
   ABSORPTION-ORDERFLOW-MAP-V5
   ========================================================= */

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "ABSORPTION-ORDERFLOW-MAP-V5";

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

const RETENTION_MINUTES = 1440;
const ORDERBOOK_SNAPSHOT_MS = 5000;
const WS_RECONNECT_MIN = 3000;
const WS_RECONNECT_MAX = 30000;
const WS_SUB_CHUNK = 200;

const ALLOWED_INTERVALS = [
  "1",
  "3",
  "5",
  "15",
  "30",
  "60"
];

const sleep = ms =>
  new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          "no-store, no-cache, must-revalidate",
        "access-control-allow-origin": "*",
        "access-control-allow-methods":
          "GET,POST,OPTIONS",
        "access-control-allow-headers": "*"
      }
    }
  );
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
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function sum(a) {
  return a.reduce((x, y) => x + n(y), 0);
}

function normalizeSymbol(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeInterval(v) {
  v = String(v || TF);
  return ALLOWED_INTERVALS.includes(v)
    ? v
    : TF;
}

function intervalMs(interval) {
  return (
    Number(normalizeInterval(interval)) *
    60 *
    1000
  );
}

function priceDecimals(step) {
  step = n(step);

  if (!step) return 8;

  const s = String(step);

  if (!s.includes(".")) return 0;

  return Math.max(
    0,
    Math.min(
      16,
      s.split(".")[1].replace(/0+$/, "").length
    )
  );
}

function roundToStep(price, step) {
  price = n(price);
  step = n(step);

  if (!price || !step) return price;

  const rounded =
    Math.round(price / step) * step;

  return Number(
    rounded.toFixed(priceDecimals(step))
  );
}

/* =========================================================
   BYBIT REST
========================================================= */

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== ""
    ) {
      u.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(u.toString(), {
    headers: {
      accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(
      `Bybit HTTP ${res.status}`
    );
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
        `Bybit error ${data.retCode}`
    );
  }

  return data;
}

/* =========================================================
   INSTRUMENT
========================================================= */

const instrumentCache = new Map();

async function instrumentInfo(
  category,
  symbol
) {
  const key =
    `${category}:${symbol}`;

  if (instrumentCache.has(key)) {
    return instrumentCache.get(key);
  }

  const data =
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        symbol
      }
    );

  const item =
    data?.result?.list?.[0];

  if (!item) {
    const fallback = {
      symbol,
      tickSize: 0,
      minPrice: 0,
      maxPrice: 0,
      qtyStep: 0
    };

    instrumentCache.set(
      key,
      fallback
    );

    return fallback;
  }

  const result = {
    symbol: item.symbol,

    tickSize:
      n(
        item.priceFilter?.tickSize
      ),

    minPrice:
      n(
        item.priceFilter?.minPrice
      ),

    maxPrice:
      n(
        item.priceFilter?.maxPrice
      ),

    qtyStep:
      n(
        item.lotSizeFilter?.qtyStep
      )
  };

  instrumentCache.set(
    key,
    result
  );

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
  interval =
    normalizeInterval(interval);

  const data =
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval,
        limit
      }
    );

  return (
    data?.result?.list || []
  )
    .map(x => ({
      time: n(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }))
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* =========================================================
   TICKER
========================================================= */

async function ticker(
  category,
  symbol
) {
  const data =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  const x =
    data?.result?.list?.[0] || {};

  return {
    symbol,

    lastPrice:
      n(x.lastPrice),

    markPrice:
      n(x.markPrice),

    indexPrice:
      n(x.indexPrice),

    turnover24h:
      n(x.turnover24h),

    volume24h:
      n(x.volume24h),

    price24hPcnt:
      n(x.price24hPcnt),

    openInterest:
      n(x.openInterest),

    fundingRate:
      n(x.fundingRate)
  };
}

/* =========================================================
   RECENT TRADES
========================================================= */

async function trades(
  category,
  symbol,
  limit = TRADE_LIMIT
) {
  const data =
    await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit
      }
    );

  return (
    data?.result?.list || []
  )
    .map(x => ({
      id:
        x.execId ||
        x.id ||
        `${x.time}-${x.price}-${x.size}`,

      time:
        n(x.time),

      price:
        n(x.price),

      size:
        n(x.size),

      side:
        String(
          x.side || ""
        )
          .trim()
          .toUpperCase(),

      isBlockTrade:
        x.isBlockTrade === true ||
        x.isBlockTrade === "true",

      isRPITrade:
        x.isRPITrade === true ||
        x.isRPITrade === "true"
    }))
    .filter(
      x =>
        x.time > 0 &&
        x.price > 0 &&
        x.size > 0 &&
        (
          x.side === "BUY" ||
          x.side === "SELL"
        )
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

function aggressorSide(x) {
  const side =
    String(x?.side || "")
      .trim()
      .toUpperCase();

  if (side === "BUY") {
    return "BUY";
  }

  if (side === "SELL") {
    return "SELL";
  }

  return "UNKNOWN";
}

/* =========================================================
   ORDERBOOK REST
========================================================= */

async function orderbook(
  category,
  symbol,
  limit = ORDERBOOK_LIMIT
) {
  const data =
    await bybit(
      "/v5/market/orderbook",
      {
        category,
        symbol,
        limit
      }
    );

  const result =
    data?.result || {};

  const bids =
    (result.b || [])
      .map(x => {
        const price = n(x[0]);
        const size = n(x[1]);

        return {
          price,
          size,
          value:
            price * size
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      );

  const asks =
    (result.a || [])
      .map(x => {
        const price = n(x[0]);
        const size = n(x[1]);

        return {
          price,
          size,
          value:
            price * size
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      );

  return {
    bids,
    asks,

    bestBid:
      bids[0]?.price || 0,

    bestAsk:
      asks[0]?.price || 0,

    timestamp:
      n(
        data.time,
        Date.now()
      )
  };
}

/* =========================================================
   OI / FUNDING
========================================================= */

async function oiFunding(symbol) {
  try {
    const [
      tickerData,
      oiData,
      fundingData
    ] =
      await Promise.all([
        bybit(
          "/v5/market/tickers",
          {
            category:
              "linear",
            symbol
          }
        ),

        bybit(
          "/v5/market/open-interest",
          {
            category:
              "linear",
            symbol,
            intervalTime:
              "5min",
            limit: 50
          }
        ),

        bybit(
          "/v5/market/funding/history",
          {
            category:
              "linear",
            symbol,
            limit: 10
          }
        )
      ]);

    const tickerItem =
      tickerData?.result?.list?.[0] ||
      {};

    const oiHistory =
      (
        oiData?.result?.list ||
        []
      )
        .map(x => ({
          time:
            n(x.timestamp),

          oi:
            n(x.openInterest)
        }))
        .sort(
          (a, b) =>
            a.time - b.time
        );

    const fundingHistory =
      (
        fundingData?.result?.list ||
        []
      )
        .map(x => ({
          time:
            n(
              x.fundingRateTimestamp
            ),

          fundingRate:
            n(
              x.fundingRate
            )
        }))
        .sort(
          (a, b) =>
            a.time - b.time
        );

    const currentOI =
      n(
        tickerItem.openInterest
      ) ||
      oiHistory.at(-1)?.oi ||
      0;

    const previousOI =
      oiHistory.length > 1
        ? oiHistory.at(-2)?.oi || 0
        : oiHistory.at(-1)?.oi || 0;

    return {
      currentOI,

      previousOI,

      changePercent:
        pct(
          currentOI -
            previousOI,
          previousOI
        ),

      fundingRate:
        n(
          tickerItem.fundingRate
        ) ||
        fundingHistory.at(-1)
          ?.fundingRate ||
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
  if (!values.length) {
    return 0;
  }

  if (
    values.length <
    period
  ) {
    return avg(values);
  }

  let s = 0;

  for (
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {
    s += n(values[i]);
  }

  return s / period;
}

function ema(values, period) {
  if (!values.length) {
    return 0;
  }

  const p =
    Math.max(
      1,
      period
    );

  const k =
    2 / (p + 1);

  let e =
    values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}

function atr(
  candles,
  period = 14
) {
  if (
    candles.length < 2
  ) {
    return 0;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,

        Math.abs(
          c.high -
            p.close
        ),

        Math.abs(
          c.low -
            p.close
        )
      )
    );
  }

  return sma(
    trs.slice(-period),
    period
  );
}

function rsi(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i =
      candles.length - period;
    i < candles.length;
    i++
  ) {
    const diff =
      candles[i].close -
      candles[i - 1].close;

    if (diff >= 0) {
      gain += diff;
    } else {
      loss +=
        Math.abs(diff);
    }
  }

  if (loss === 0) {
    return 100;
  }

  const rs =
    gain / loss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function candleStats(c) {
  const range =
    Math.max(
      0,
      c.high - c.low
    );

  const body =
    Math.abs(
      c.close -
        c.open
    );

  return {
    range,

    body,

    bodyPercent:
      pct(
        body,
        range
      ),

    upperWick:
      c.high -
      Math.max(
        c.open,
        c.close
      ),

    lowerWick:
      Math.min(
        c.open,
        c.close
      ) -
      c.low,

    bullish:
      c.close >= c.open
  };
}

/* =========================================================
   FLOW
========================================================= */

function flowFromTrades(
  list,
  start = 0,
  end = Infinity
) {
  const selected =
    list.filter(
      x =>
        x.time >= start &&
        x.time <= end
    );

  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largestTradeValue = 0;

  for (const x of selected) {
    const value =
      x.price *
      x.size;

    largestTradeValue =
      Math.max(
        largestTradeValue,
        value
      );

    const side =
      aggressorSide(x);

    if (
      side === "BUY"
    ) {
      buyVolume +=
        x.size;

      buyValue +=
        value;

      buyTrades++;
    }

    if (
      side === "SELL"
    ) {
      sellVolume +=
        x.size;

      sellValue +=
        value;

      sellTrades++;
    }
  }

  const totalVolume =
    buyVolume +
    sellVolume;

  const totalValue =
    buyValue +
    sellValue;

  const delta =
    buyVolume -
    sellVolume;

  const deltaValue =
    buyValue -
    sellValue;

  return {
    buyVolume,
    sellVolume,

    buyValue,
    sellValue,

    buyNotional:
      buyValue,

    sellNotional:
      sellValue,

    totalVolume,

    flowVolume:
      totalVolume,

    totalValue,

    delta,

    deltaValue,

    deltaPercent:
      pct(
        delta,
        totalVolume
      ),

    deltaValuePercent:
      pct(
        deltaValue,
        totalValue
      ),

    buyShare:
      pct(
        buyVolume,
        totalVolume
      ),

    sellShare:
      pct(
        sellVolume,
        totalVolume
      ),

    buyTrades,
    sellTrades,

    tradeCount:
      buyTrades +
      sellTrades,

    largestTradeValue,

    firstTime:
      selected[0]?.time ||
      0,

    lastTime:
      selected.at(-1)?.time ||
      0
  };
}

/* =========================================================
   FOOTPRINT
========================================================= */

function createFootprintLevel(
  price
) {
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

    side:
      "NEUTRAL",

    largestTradeValue:
      0
  };
}

function buildFootprints(
  candles,
  tradeList,
  interval,
  tickSize
) {
  const duration =
    intervalMs(interval);

  const maps =
    new Map();

  for (const candle of candles) {
    maps.set(
      candle.time,
      new Map()
    );
  }

  for (const t of tradeList) {
    const candleTime =
      Math.floor(
        t.time / duration
      ) * duration;

    const map =
      maps.get(
        candleTime
      );

    if (!map) {
      continue;
    }

    const price =
      tickSize
        ? roundToStep(
            t.price,
            tickSize
          )
        : t.price;

    let level =
      map.get(price);

    if (!level) {
      level =
        createFootprintLevel(
          price
        );

      map.set(
        price,
        level
      );
    }

    const value =
      t.price *
      t.size;

    level.totalVolume +=
      t.size;

    level.totalValue +=
      value;

    level.largestTradeValue =
      Math.max(
        level.largestTradeValue,
        value
      );

    const side =
      aggressorSide(t);

    if (
      side === "BUY"
    ) {
      level.askVolume +=
        t.size;

      level.askValue +=
        value;

      level.askTrades++;
    }

    if (
      side === "SELL"
    ) {
      level.bidVolume +=
        t.size;

      level.bidValue +=
        value;

      level.bidTrades++;
    }
  }

  const footprints = [];

  let cumulativeDeltaValue = 0;

  for (const candle of candles) {
    const map =
      maps.get(
        candle.time
      ) ||
      new Map();

    let buyVolume = 0;
    let sellVolume = 0;

    let buyValue = 0;
    let sellValue = 0;

    let buyTrades = 0;
    let sellTrades = 0;

    const levels = [];

    for (
      const level of map.values()
    ) {
      level.delta =
        level.askVolume -
        level.bidVolume;

      level.deltaValue =
        level.askValue -
        level.bidValue;

      if (
        level.bidVolume > 0
      ) {
        level.imbalance =
          level.askVolume /
          level.bidVolume;
      } else if (
        level.askVolume > 0
      ) {
        level.imbalance =
          Infinity;
      } else {
        level.imbalance = 0;
      }

      if (
        level.askVolume >
        level.bidVolume
      ) {
        level.side =
          "BUY";
      } else if (
        level.bidVolume >
        level.askVolume
      ) {
        level.side =
          "SELL";
      } else {
        level.side =
          "NEUTRAL";
      }

      buyVolume +=
        level.askVolume;

      sellVolume +=
        level.bidVolume;

      buyValue +=
        level.askValue;

      sellValue +=
        level.bidValue;

      buyTrades +=
        level.askTrades;

      sellTrades +=
        level.bidTrades;

      levels.push(
        level
      );
    }

    levels.sort(
      (a, b) =>
        b.price -
        a.price
    );

    const flowVolume =
      buyVolume +
      sellVolume;

    const totalValue =
      buyValue +
      sellValue;

    const delta =
      buyVolume -
      sellVolume;

    const deltaValue =
      buyValue -
      sellValue;

    cumulativeDeltaValue +=
      deltaValue;

    const imbalances =
      levels.filter(
        x =>
          x.imbalance >= 3 ||
          (
            x.bidVolume > 0 &&
            (
              x.askVolume /
              x.bidVolume
            ) <=
              1 / 3
          )
      );

    footprints.push({
      time:
        candle.time,

      open:
        candle.open,

      high:
        candle.high,

      low:
        candle.low,

      close:
        candle.close,

      volume:
        candle.volume,

      flowVolume,

      buyVolume,
      sellVolume,

      buyValue,
      sellValue,

      buyTrades,
      sellTrades,

      tradeCount:
        buyTrades +
        sellTrades,

      totalValue,

      delta,
      deltaValue,

      deltaPercent:
        pct(
          delta,
          flowVolume
        ),

      deltaValuePercent:
        pct(
          deltaValue,
          totalValue
        ),

      cumulativeDeltaValue,

      levels:
        levels.slice(
          0,
          FOOTPRINT_MAX_LEVELS
        ),

      imbalances
    });
  }

  return footprints;
}

function candleDeltaSeries(
  candles,
  footprints
) {
  const map =
    new Map(
      footprints.map(
        x => [
          x.time,
          x
        ]
      )
    );

  return candles.map(
    c => {
      const fp =
        map.get(
          c.time
        );

      return {
        time:
          c.time,

        buy:
          fp?.buyVolume ||
          0,

        sell:
          fp?.sellVolume ||
          0,

        delta:
          fp?.delta ||
          0,

        deltaValue:
          fp?.deltaValue ||
          0,

        deltaPercent:
          fp?.deltaPercent ||
          0,

        trades:
          fp?.tradeCount ||
          0,

        cumulativeDeltaValue:
          fp?.cumulativeDeltaValue ||
          0
      };
    }
  );
}

function detectImbalances(
  footprints
) {
  const result = [];

  for (
    const fp of footprints
  ) {
    for (
      const level of
        fp.levels || []
    ) {
      if (
        level.imbalance >= 3 ||
        (
          level.bidVolume > 0 &&
          (
            level.askVolume /
            level.bidVolume
          ) <=
            1 / 3
        )
      ) {
        result.push({
          time:
            fp.time,

          price:
            level.price,

          imbalance:
            level.imbalance,

          side:
            level.side,

          bidVolume:
            level.bidVolume,

          askVolume:
            level.askVolume,

          delta:
            level.delta,

          deltaValue:
            level.deltaValue
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
  if (!list.length) {
    return [];
  }

  const values =
    list
      .map(
        x =>
          x.price *
          x.size
      )
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );

  const averageNotional =
    avg(values);

  const p95 =
    values.length
      ? values[
          Math.min(
            values.length - 1,
            Math.floor(
              values.length *
              0.95
            )
          )
        ]
      : 0;

  const threshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  return list
    .map(x => ({
      ...x,

      value:
        x.price *
        x.size,

      aggressor:
        aggressorSide(x)
    }))
    .filter(
      x =>
        x.value >=
        threshold
    )
    .sort(
      (a, b) =>
        b.value -
        a.value
    )
    .slice(0, 50);
}

/* =========================================================
   MEDIAN
========================================================= */

function median(values) {
  if (!values.length) {
    return 0;
  }

  const a =
    [...values].sort(
      (x, y) =>
        x - y
    );

  const m =
    Math.floor(
      a.length / 2
    );

  return a.length % 2
    ? a[m]
    : (
        a[m - 1] +
        a[m]
      ) / 2;
}

/* =========================================================
   ORDERBOOK WALLS
========================================================= */

function wallAnalysis(book) {
  const bids =
    book?.bids || [];

  const asks =
    book?.asks || [];

  const buyLiquidity =
    sum(
      bids.map(
        x => x.value
      )
    );

  const sellLiquidity =
    sum(
      asks.map(
        x => x.value
      )
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

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

  const bidMedian =
    median(
      bids.map(
        x => x.value
      )
    );

  const askMedian =
    median(
      asks.map(
        x => x.value
      )
    );

  const buyWalls =
    bids
      .filter(
        x =>
          bidMedian > 0 &&
          x.value >=
            bidMedian * 4
      )
      .sort(
        (a, b) =>
          b.value -
          a.value
      )
      .slice(0, 20);

  const sellWalls =
    asks
      .filter(
        x =>
          askMedian > 0 &&
          x.value >=
            askMedian * 4
      )
      .sort(
        (a, b) =>
          b.value -
          a.value
      )
      .slice(0, 20);

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    sellShare >
    buyShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,

    buyShare,
    sellShare,

    imbalance:
      buyShare -
      sellShare,

    pressure,

    buyWalls,
    sellWalls,

    nearBuyWall:
      buyWalls[0] ||
      null,

    nearSellWall:
      sellWalls[0] ||
      null,

    bestBid:
      book?.bestBid ||
      0,

    bestAsk:
      book?.bestAsk ||
      0
  };
}

/* =========================================================
   HEATMAP
========================================================= */

function liquidityHeatmap(book) {
  const bids =
    (
      book?.bids || []
    ).slice(
      0,
      HEATMAP_LEVELS
    );

  const asks =
    (
      book?.asks || []
    ).slice(
      0,
      HEATMAP_LEVELS
    );

  const allValues = [
    ...bids.map(
      x => x.value
    ),
    ...asks.map(
      x => x.value
    )
  ];

  const maxValue =
    Math.max(
      ...allValues,
      1
    );

  return {
    bids:
      bids.map(
        x => ({
          ...x,

          intensity:
            clamp(
              x.value /
                maxValue,
              0,
              1
            )
        })
      ),

    asks:
      asks.map(
        x => ({
          ...x,

          intensity:
            clamp(
              x.value /
                maxValue,
              0,
              1
            )
        })
      ),

    maxValue
  };
}

/* =========================================================
   LIQUIDITY ZONES
========================================================= */

function liquidityZones(
  book,
  price = 0
) {
  const bids =
    book?.bids || [];

  const asks =
    book?.asks || [];

  const zones = [];

  const bidMedian =
    median(
      bids.map(
        x => x.value
      )
    );

  const askMedian =
    median(
      asks.map(
        x => x.value
      )
    );

  for (
    const x of bids
  ) {
    if (
      bidMedian > 0 &&
      x.value >=
        bidMedian * 2
    ) {
      zones.push({
        side: "BUY",

        price:
          x.price,

        value:
          x.value,

        distancePercent:
          price
            ? Math.abs(
                pct(
                  x.price -
                    price,
                  price
                )
              )
            : 0
      });
    }
  }

  for (
    const x of asks
  ) {
    if (
      askMedian > 0 &&
      x.value >=
        askMedian * 2
    ) {
      zones.push({
        side: "SELL",

        price:
          x.price,

        value:
          x.value,

        distancePercent:
          price
            ? Math.abs(
                pct(
                  x.price -
                    price,
                  price
                )
              )
            : 0
      });
    }
  }

  return zones
    .sort(
      (a, b) =>
        b.value -
        a.value
    )
    .slice(0, 50);
}

/* =========================================================
   SWEEP
========================================================= */

function detectSweep(
  candles
) {
  if (
    candles.length < 5
  ) {
    return {
      detected: false,
      side: "NONE",
      price: 0,
      strength: 0
    };
  }

  const c =
    candles.at(-1);

  const prev =
    candles.slice(
      -6,
      -1
    );

  const previousHigh =
    Math.max(
      ...prev.map(
        x => x.high
      )
    );

  const previousLow =
    Math.min(
      ...prev.map(
        x => x.low
      )
    );

  if (
    c.high >
      previousHigh &&
    c.close <
      previousHigh
  ) {
    return {
      detected: true,

      side: "SELL",

      type:
        "HIGH_SWEEP",

      price:
        c.high,

      strength:
        pct(
          c.high -
            c.close,

          c.high -
            c.low ||
            1
        )
    };
  }

  if (
    c.low <
      previousLow &&
    c.close >
      previousLow
  ) {
    return {
      detected: true,

      side: "BUY",

      type:
        "LOW_SWEEP",

      price:
        c.low,

      strength:
        pct(
          c.close -
            c.low,

          c.high -
            c.low ||
            1
        )
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

function detectTradeSweep(
  list
) {
  if (
    list.length < 10
  ) {
    return {
      detected: false,
      side: "NONE",
      value: 0,
      ratio: 1
    };
  }

  const recent =
    list.slice(-50);

  let buy = 0;
  let sell = 0;

  for (
    const x of recent
  ) {
    const value =
      x.price *
      x.size;

    if (
      aggressorSide(x) ===
      "BUY"
    ) {
      buy += value;
    } else if (
      aggressorSide(x) ===
      "SELL"
    ) {
      sell += value;
    }
  }

  if (
    buy >
    sell * 2
  ) {
    return {
      detected: true,
      side: "BUY",
      value: buy,
      ratio:
        sell
          ? buy / sell
          : Infinity
    };
  }

  if (
    sell >
    buy * 2
  ) {
    return {
      detected: true,
      side: "SELL",
      value: sell,
      ratio:
        buy
          ? sell / buy
          : Infinity
    };
  }

  return {
    detected: false,
    side: "NONE",
    value:
      Math.max(
        buy,
        sell
      ),
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
  const c =
    candles.at(-1);

  if (!c) {
    return {
      detected: false,
      side: "NONE",
      strength: 0
    };
  }

  const stats =
    candleStats(c);

  const range =
    stats.range || 1;

  const deltaPressure =
    Math.abs(
      flow.deltaPercent
    );

  const bodyPercent =
    stats.bodyPercent;

  const buyBook =
    book?.buyShare || 0;

  const sellBook =
    book?.sellShare || 0;

  if (
    flow.deltaPercent > 20 &&
    bodyPercent < 35 &&
    buyBook <
      sellBook + 5
  ) {
    return {
      detected: true,

      side: "SELL",

      type:
        "BUY_ABSORPTION",

      strength:
        clamp(
          deltaPressure +
            (
              35 -
              bodyPercent
            ),
          0,
          100
        ),

      price:
        c.close,

      range
    };
  }

  if (
    flow.deltaPercent < -20 &&
    bodyPercent < 35 &&
    sellBook <
      buyBook + 5
  ) {
    return {
      detected: true,

      side: "BUY",

      type:
        "SELL_ABSORPTION",

      strength:
        clamp(
          deltaPressure +
            (
              35 -
              bodyPercent
            ),
          0,
          100
        ),

      price:
        c.close,

      range
    };
  }

  return {
    detected: false,
    side: "NONE",
    strength: 0,
    price:
      c.close
  };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structure(
  candles
) {
  if (
    candles.length < 10
  ) {
    return {
      trend: "NEUTRAL",
      direction: "NEUTRAL",
      strength: 0
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const short =
    sma(
      closes.slice(-5),
      5
    );

  const long =
    sma(
      closes.slice(-20),
      20
    );

  const last =
    closes.at(-1);

  const atrValue =
    atr(
      candles,
      14
    ) || 1;

  const distance =
    last - long;

  const strength =
    clamp(
      Math.abs(
        distance
      ) /
        atrValue *
        25,
      0,
      100
    );

  if (
    short > long &&
    last > long
  ) {
    return {
      trend:
        "BULLISH",

      direction:
        "BUY",

      strength
    };
  }

  if (
    short < long &&
    last < long
  ) {
    return {
      trend:
        "BEARISH",

      direction:
        "SELL",

      strength
    };
  }

  return {
    trend: "NEUTRAL",
    direction: "NEUTRAL",
    strength: 0
  };
}

function entry1m(
  candles
) {
  if (
    candles.length < 20
  ) {
    return {
      direction:
        "WAIT",

      price:
        candles.at(-1)
          ?.close || 0,

      confidence: 0
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const ma20 =
    sma(
      closes,
      20
    );

  const last =
    closes.at(-1);

  const r =
    rsi(
      candles,
      14
    );

  if (
    last > ma20 &&
    r >= 50
  ) {
    return {
      direction: "BUY",
      price: last,

      confidence:
        clamp(
          50 +
            (r - 50),
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
          50 +
            (50 - r),
          0,
          100
        ),

      ma20,
      rsi: r
    };
  }

  return {
    direction:
      "WAIT",

    price:
      last,

    confidence:
      40,

    ma20,
    rsi: r
  };
}

function supportResistance(
  candles
) {
  if (!candles.length) {
    return {
      supports: [],
      resistances: []
    };
  }

  const lows =
    candles
      .map(x => x.low)
      .sort(
        (a, b) =>
          a - b
      );

  const highs =
    candles
      .map(x => x.high)
      .sort(
        (a, b) =>
          a - b
      );

  return {
    supports:
      [
        ...new Set(
          lows
            .slice(0, 8)
            .map(x =>
              Number(x)
            )
        )
      ].sort(
        (a, b) =>
          b - a
      ),

    resistances:
      [
        ...new Set(
          highs
            .slice(-8)
            .map(x =>
              Number(x)
            )
        )
      ].sort(
        (a, b) =>
          a - b
      )
  };
}

function pressureFromFlow(
  flow
) {
  if (
    flow.deltaPercent >=
    10
  ) {
    return "BUY_PRESSURE";
  }

  if (
    flow.deltaPercent <=
    -10
  ) {
    return "SELL_PRESSURE";
  }

  return "NEUTRAL";
}

function movement(
  candles
) {
  if (
    candles.length < 2
  ) {
    return {
      percent: 0,
      direction: "NEUTRAL"
    };
  }

  const a =
    candles.at(-2).close;

  const b =
    candles.at(-1).close;

  const change =
    pct(
      b - a,
      a
    );

  return {
    percent:
      change,

    direction:
      change > 0
        ? "UP"
        : change < 0
          ? "DOWN"
          : "NEUTRAL"
  };
}

function structuralZone(
  candles,
  price
) {
  if (
    !candles.length ||
    !price
  ) {
    return {
      low: 0,
      high: 0,
      type: "NONE"
    };
  }

  const last20 =
    candles.slice(-20);

  const low =
    Math.min(
      ...last20.map(
        x => x.low
      )
    );

  const high =
    Math.max(
      ...last20.map(
        x => x.high
      )
    );

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
   BUILD CHART
========================================================= */

async function buildChartData(
  symbol,
  interval = TF
) {
  interval =
    normalizeInterval(
      interval
    );

  symbol =
    normalizeSymbol(
      symbol
    );

  if (!symbol) {
    throw new Error(
      "Symbol required"
    );
  }

  const [
    candles,
    tick,
    book,
    tr,
    instrument
  ] =
    await Promise.all([
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
    instrument.tickSize ||
    0;

  const footprints =
    buildFootprints(
      candles,
      tr,
      interval,
      tickSize
    );

  const fpMap =
    new Map(
      footprints.map(
        x => [
          x.time,
          x
        ]
      )
    );

  let cumulativeDelta =
    0;

  const chartCandles =
    candles.map(c => {
      const fp =
        fpMap.get(
          c.time
        );

      cumulativeDelta +=
        fp?.deltaValue ||
        0;

      return {
        ...c,

        flowVolume:
          fp?.flowVolume ||
          0,

        buyVolume:
          fp?.buyVolume ||
          0,

        sellVolume:
          fp?.sellVolume ||
          0,

        buyValue:
          fp?.buyValue ||
          0,

        sellValue:
          fp?.sellValue ||
          0,

        delta:
          fp?.delta ||
          0,

        deltaValue:
          fp?.deltaValue ||
          0,

        deltaPercent:
          fp?.deltaPercent ||
          0,

        tradeCount:
          fp?.tradeCount ||
          0,

        cumulativeDeltaValue:
          cumulativeDelta,

        footprint:
          fp?.levels ||
          [],

        imbalances:
          fp?.imbalances ||
          []
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

    version:
      VERSION,

    category:
      "linear",

    symbol,

    interval,

    intervalMs:
      intervalMs(
        interval
      ),

    tickSize,

    priceStep:
      tickSize,

    levelMode:
      "TICK",

    serverTime:
      Date.now(),

    price:
      tick.lastPrice,

    ticker:
      tick,

    candles:
      chartCandles,

    footprints,

    footprint:
      footprints,

    candleDelta,

    cumulativeDelta,

    currentFlow,

    historicalFlow:
      currentFlow,

    flow:
      currentFlow,

    orderbook:
      book,

    wall,

    heatmap,

    liquidityZones:
      zones,

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
  symbol =
    normalizeSymbol(
      symbol
    );

  if (!symbol) {
    throw new Error(
      "Symbol required"
    );
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
  ] =
    await Promise.all([
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
    instrument.tickSize ||
    0;

  const current5 =
    candles5.at(-1);

  const currentStart =
    current5?.time ||
    0;

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
    historicalFlow.tradeCount >=
    8
      ? historicalFlow
      : flowFromTrades(tr);

  const footprints =
    buildFootprints(
      candles5.slice(-100),
      tr,
      TF,
      tickSize
    );

  let cumulativeDelta =
    0;

  for (
    const fp of footprints
  ) {
    cumulativeDelta +=
      fp.deltaValue ||
      0;

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
    detectSweep(
      candles5
    );

  const tradeSweep =
    detectTradeSweep(
      tr
    );

  const structure5 =
    structure(
      candles5
    );

  const structure15 =
    structure(
      candles15
    );

  const structure3 =
    structure(
      candles3
    );

  const structure1 =
    structure(
      candles1
    );

  const pressure =
    pressureFromFlow(
      currentFlow
    );

  const move =
    movement(
      candles5
    );

  const zone =
    structuralZone(
      candles5,
      tick.lastPrice
    );

  const entry =
    entry1m(
      candles1
    );

  const sr =
    supportResistance(
      candles5
    );

  const oi =
    await oiFunding(
      symbol
    );

  const blocks =
    blockTrades(tr);

  let score = 50;

  if (
    structure15.direction ===
    "BUY"
  ) {
    score += 10;
  }

  if (
    structure15.direction ===
    "SELL"
  ) {
    score -= 10;
  }

  if (
    structure5.direction ===
    "BUY"
  ) {
    score += 8;
  }

  if (
    structure5.direction ===
    "SELL"
  ) {
    score -= 8;
  }

  if (
    currentFlow.deltaPercent >
    10
  ) {
    score += 10;
  }

  if (
    currentFlow.deltaPercent <
    -10
  ) {
    score -= 10;
  }

  if (
    wall.pressure ===
    "BUY_PRESSURE"
  ) {
    score += 7;
  }

  if (
    wall.pressure ===
    "SELL_PRESSURE"
  ) {
    score -= 7;
  }

  if (
    absorption.detected &&
    absorption.side ===
      "BUY"
  ) {
    score += 8;
  }

  if (
    absorption.detected &&
    absorption.side ===
      "SELL"
  ) {
    score -= 8;
  }

  if (
    sweep.detected &&
    sweep.side ===
      "BUY"
  ) {
    score += 5;
  }

  if (
    sweep.detected &&
    sweep.side ===
      "SELL"
  ) {
    score -= 5;
  }

  score =
    Math.round(
      clamp(
        score,
        0,
        100
      )
    );

  let signal =
    "WAIT";

  if (
    score >= 70
  ) {
    signal =
      "BUY";
  } else if (
    score <= 30
  ) {
    signal =
      "SELL";
  }

  const reasons = [];

  if (
    currentFlow.deltaPercent >
    10
  ) {
    reasons.push(
      "فشار خرید در معاملات واقعی"
    );
  }

  if (
    currentFlow.deltaPercent <
    -10
  ) {
    reasons.push(
      "فشار فروش در معاملات واقعی"
    );
  }

  if (
    wall.pressure ===
    "BUY_PRESSURE"
  ) {
    reasons.push(
      "برتری نقدینگی سمت Bid"
    );
  }

  if (
    wall.pressure ===
    "SELL_PRESSURE"
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

    version:
      VERSION,

    category:
      "linear",

    symbol,

    interval:
      selectedInterval,

    intervalMs:
      intervalMs(
        selectedInterval
      ),

    tickSize,

    priceStep:
      tickSize,

    levelMode:
      "TICK",

    serverTime:
      Date.now(),

    price:
      tick.lastPrice,

    ticker:
      tick,

    candles: {
      tf5:
        candles5,

      tf15:
        candles15,

      tf3:
        candles3,

      tf1:
        candles1
    },

    selectedCandles:
      selectedInterval ===
      "15"
        ? candles15
        : selectedInterval ===
          "3"
          ? candles3
          : selectedInterval ===
            "1"
            ? candles1
            : selectedInterval ===
              "5"
              ? candles5
              : await kline(
                  "linear",
                  symbol,
                  selectedInterval,
                  CHART_LIMIT
                ),

    footprint: {
      interval:
        TF,

      intervalMs:
        intervalMs(TF),

      tickSize,

      levelMode:
        "TICK",

      candles:
        footprints,

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

    orderbook:
      book,

    wall,

    heatmap,

    liquidityZones:
      zones,

    trades:
      tr.slice(-250),

    currentFlow,

    historicalFlow,

    flow:
      currentFlow,

    absorption,

    blocks,

    sweep,

    tradeSweep,

    structure: {
      tf5:
        structure5,

      tf15:
        structure15,

      tf3:
        structure3,

      tf1:
        structure1
    },

    supportResistance:
      sr,

    timeframes: {
      tf5:
        structure5,

      tf15:
        structure15,

      tf3:
        structure3,

      tf1:
        structure1
    },

    movement:
      move,

    pressure,

    oiFunding:
      oi,

    entry1m:
      entry,

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
  symbol =
    normalizeSymbol(
      symbol
    );

  interval =
    normalizeInterval(
      interval
    );

  if (!symbol) {
    throw new Error(
      "Symbol required"
    );
  }

  const [
    tick,
    book,
    tr,
    candles,
    instrument
  ] =
    await Promise.all([
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
    instrument.tickSize ||
    0;

  const footprints =
    buildFootprints(
      candles,
      tr,
      interval,
      tickSize
    );

  let cumulativeDelta =
    0;

  const fpMap =
    new Map(
      footprints.map(
        x => [
          x.time,
          x
        ]
      )
    );

  const candleFlow =
    candles.map(c => {
      const fp =
        fpMap.get(
          c.time
        );

      cumulativeDelta +=
        fp?.deltaValue ||
        0;

      return {
        ...c,

        flowVolume:
          fp?.flowVolume ||
          0,

        buyVolume:
          fp?.buyVolume ||
          0,

        sellVolume:
          fp?.sellVolume ||
          0,

        buyValue:
          fp?.buyValue ||
          0,

        sellValue:
          fp?.sellValue ||
          0,

        delta:
          fp?.delta ||
          0,

        deltaValue:
          fp?.deltaValue ||
          0,

        deltaPercent:
          fp?.deltaPercent ||
          0,

        tradeCount:
          fp?.tradeCount ||
          0,

        cumulativeDeltaValue:
          cumulativeDelta,

        footprint:
          fp?.levels ||
          [],

        imbalances:
          fp?.imbalances ||
          []
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
    detectSweep(
      candles
    );

  const tradeSweep =
    detectTradeSweep(
      tr
    );

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

    version:
      VERSION,

    category:
      "linear",

    symbol,

    interval,

    intervalMs:
      intervalMs(interval),

    tickSize,

    priceStep:
      tickSize,

    levelMode:
      "TICK",

    serverTime:
      Date.now(),

    price:
      tick.lastPrice,

    ticker:
      tick,

    candles:
      candleFlow,

    candleFlow,

    footprints,

    footprint:
      footprints,

    candleDelta:
      candleDeltaSeries(
        candles,
        footprints
      ),

    cumulativeDelta,

    orderbook:
      book,

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
        category:
          "linear",
        limit:
          1000
      }
    );

  return (
    data?.result?.list ||
    []
  )
    .filter(
      x =>
        x.status ===
          "Trading" &&
        x.quoteCoin ===
          "USDT" &&
        x.contractType ===
          "LinearPerpetual"
    )
    .map(x => ({
      symbol:
        x.symbol,

      baseCoin:
        x.baseCoin,

      quoteCoin:
        x.quoteCoin,

      tickSize:
        n(
          x.priceFilter
            ?.tickSize
        ),

      qtyStep:
        n(
          x.lotSizeFilter
            ?.qtyStep
        )
    }))
    .slice(
      0,
      MAX_SYMBOLS
    );
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
      start +
        SCAN_BATCH
    );

  const results = [];

  for (
    const item of batch
  ) {
    try {
      const x =
        await analyze(
          item.symbol,
          TF
        );

      if (
        Number(x.score) >=
        55
      ) {
        results.push({
          symbol:
            item.symbol,

          score:
            x.score,

          signal:
            x.signal,

          price:
            x.price,

          pressure:
            x.pressure,

          movement:
            x.movement,

          structure:
            x.structure,

          delta:
            x.currentFlow
              ?.delta ||
            0,

          deltaPercent:
            x.currentFlow
              ?.deltaPercent ||
            0,

          absorption:
            x.absorption,

          sweep:
            x.sweep
        });
      }
    } catch (e) {
      results.push({
        symbol:
          item.symbol,

        error:
          e.message
      });
    }

    await sleep(20);
  }

  return {
    ok: true,

    version:
      VERSION,

    offset:
      start,

    nextOffset:
      start +
        SCAN_BATCH >=
      symbols.length
        ? 0
        : start +
          SCAN_BATCH,

    totalSymbols:
      symbols.length,

    results:
      results
        .filter(
          x => !x.error
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
  };
}

/* =========================================================
   COLLECTOR HELPERS
========================================================= */

function minuteStart(ts) {
  return (
    Math.floor(
      n(ts) / 60000
    ) * 60000
  );
}

function levelKey(price) {
  return String(
    Number(price)
  );
}

function newMinute(
  symbol,
  ts
) {
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

    buyValue: 0,
    sellValue: 0,

    buyTrades: 0,
    sellTrades: 0,

    delta: 0,
    deltaValue: 0,

    cumulativeDelta:
      0,

    levels: {},

    liquidations: {
      buy: 0,
      sell: 0,
      buyValue: 0,
      sellValue: 0,
      count: 0
    },

    blocks: [],

    bestBid: 0,
    bestAsk: 0,

    bidLiquidity: 0,
    askLiquidity: 0,

    maxBidLiquidity: 0,
    maxAskLiquidity: 0,

    snapshotCount: 0,

    lastTradeTime:
      0
  };
}

function ensureMinuteLevel(
  minute,
  price
) {
  const key =
    levelKey(price);

  if (
    !minute.levels[key]
  ) {
    minute.levels[key] = {
      price:
        Number(price),

      bidVolume: 0,
      askVolume: 0,

      bidValue: 0,
      askValue: 0,

      bidTrades: 0,
      askTrades: 0,

      totalVolume: 0,
      totalValue: 0,

      delta: 0,
      deltaValue: 0
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
    size <= 0
  ) {
    return;
  }

  const value =
    price * size;

  if (!minute.open) {
    minute.open =
      price;
    minute.high =
      price;
    minute.low =
      price;
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

  minute.close =
    price;

  minute.volume +=
    size;

  minute.turnover +=
    value;

  minute.lastTradeTime =
    n(trade.time);

  const level =
    ensureMinuteLevel(
      minute,
      price
    );

  level.totalVolume +=
    size;

  level.totalValue +=
    value;

  if (
    aggressorSide(trade) ===
    "BUY"
  ) {
    minute.buyVolume +=
      size;

    minute.buyValue +=
      value;

    minute.buyTrades++;

    level.askVolume +=
      size;

    level.askValue +=
      value;

    level.askTrades++;
  }

  if (
    aggressorSide(trade) ===
    "SELL"
  ) {
    minute.sellVolume +=
      size;

    minute.sellValue +=
      value;

    minute.sellTrades++;

    level.bidVolume +=
      size;

    level.bidValue +=
      value;

    level.bidTrades++;
  }

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
}

function finalizeMinute(
  minute
) {
  if (!minute) {
    return null;
  }

  const levels =
    Object.values(
      minute.levels || {}
    )
      .map(level => ({
        ...level,

        imbalance:
          level.bidVolume > 0
            ? level.askVolume /
              level.bidVolume
            : level.askVolume > 0
              ? Infinity
              : 0,

        side:
          level.askVolume >
          level.bidVolume
            ? "BUY"
            : level.bidVolume >
                level.askVolume
              ? "SELL"
              : "NEUTRAL"
      }))
      .sort(
        (a, b) =>
          b.price -
          a.price
      )
      .slice(
        0,
        FOOTPRINT_MAX_LEVELS
      );

  const total =
    minute.buyVolume +
    minute.sellVolume;

  return {
    ...minute,

    delta:
      minute.buyVolume -
      minute.sellVolume,

    deltaValue:
      minute.buyValue -
      minute.sellValue,

    deltaPercent:
      pct(
        minute.buyVolume -
          minute.sellVolume,
        total
      ),

    buyShare:
      pct(
        minute.buyVolume,
        total
      ),

    sellShare:
      pct(
        minute.sellVolume,
        total
      ),

    tradeCount:
      minute.buyTrades +
      minute.sellTrades,

    levels,

    footprints:
      levels
  };
}

/* =========================================================
   DURABLE OBJECT COLLECTOR
========================================================= */

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

    this.ctx =
      ctx;

    this.env =
      env;

    this.sockets =
      new Map();

    this.books =
      new Map();

    this.minutes =
      new Map();

    this.lastFlush =
      new Map();

    this.reconnectTimers =
      new Map();

    this.wsState =
      new Map();

    this.initialized =
      false;

    this.symbols =
      [];

    this.initializing =
      null;

    this.ready =
      this.initDatabase();
  }

  async initDatabase() {
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS minutes (
          symbol TEXT NOT NULL,
          ts INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY(symbol, ts)
        );

        CREATE INDEX IF NOT EXISTS
        idx_minutes_symbol_ts
        ON minutes(symbol, ts);

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    } catch (e) {
      console.error(
        "Collector DB init error",
        e
      );
    }
  }

  async fetch(request) {
    await this.ready;

    const url =
      new URL(
        request.url
      );

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

      if (
        path ===
        "/init"
      ) {
        return json(
          await this.initCollector()
        );
      }

      if (
        path ===
        "/status"
      ) {
        return json(
          this.status()
        );
      }

      if (
        path ===
        "/symbols"
      ) {
        if (
          !this.symbols.length
        ) {
          await this.loadSymbols();
        }

        return json({
          ok: true,

          version:
            VERSION,

          symbols:
            this.symbols
        });
      }

      if (
        path ===
        "/latest"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
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

        return json({
          ok: true,

          version:
            VERSION,

          symbol,

          data:
            this.getLatestMemory(
              symbol
            )
        });
      }

      if (
        path ===
        "/history"
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
              ) || 300
            ),
            1,
            RETENTION_MINUTES
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

        return json({
          ok: true,

          version:
            VERSION,

          symbol,

          minutes,

          data:
            this.readHistory(
              symbol,
              minutes
            )
        });
      }

      if (
        path ===
        "/cleanup"
      ) {
        const removed =
          this.cleanup();

        return json({
          ok: true,

          version:
            VERSION,

          removed
        });
      }

      if (
        path ===
        "/chart"
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
          this.collectorChart(
            symbol,
            interval
          )
        );
      }

      return json(
        {
          ok: false,
          error:
            "Collector route not found"
        },
        404
      );
    } catch (e) {
      return json(
        {
          ok: false,

          version:
            VERSION,

          error:
            e?.message ||
            String(e)
        },
        500
      );
    }
  }

  async initCollector() {
    if (
      this.initializing
    ) {
      return this.initializing;
    }

    this.initializing =
      (async () => {
        await this.loadSymbols();

        if (
          !this.initialized
        ) {
          await this.startSockets();
          this.initialized =
            true;
        }

        return {
          ok: true,

          version:
            VERSION,

          initialized:
            true,

          symbolCount:
            this.symbols.length,

          sockets:
            this.sockets.size
        };
      })();

    try {
      return await this.initializing;
    } finally {
      this.initializing =
        null;
    }
  }

  async loadSymbols() {
    const data =
      await bybit(
        "/v5/market/instruments-info",
        {
          category:
            "linear",
          limit:
            1000
        }
      );

    this.symbols =
      (
        data?.result?.list ||
        []
      )
        .filter(
          x =>
            x.status ===
              "Trading" &&
            x.quoteCoin ===
              "USDT" &&
            x.contractType ===
              "LinearPerpetual"
        )
        .map(
          x => x.symbol
        )
        .slice(
          0,
          MAX_SYMBOLS
        );

    this.ctx.storage.sql.exec(
      `
      INSERT OR REPLACE INTO meta
      (key,value)
      VALUES ('symbols',?)
      `,
      JSON.stringify(
        this.symbols
      )
    );

    return this.symbols;
  }

  async startSockets() {
    const shards = [];

    for (
      let i = 0;
      i < this.symbols.length;
      i += Math.ceil(
        this.symbols.length /
          6
      )
    ) {
      shards.push(
        this.symbols.slice(
          i,
          i +
            Math.ceil(
              this.symbols.length /
                6
            )
        )
      );
    }

    for (
      let i = 0;
      i < shards.length;
      i++
    ) {
      this.connectShard(
        i,
        shards[i],
        0
      );
    }
  }

  connectShard(
    shardId,
    symbols,
    attempt = 0
  ) {
    if (
      this.sockets.has(
        shardId
      )
    ) {
      try {
        this.sockets
          .get(shardId)
          .close();
      } catch {}
    }

    let ws;

    try {
      ws =
        new WebSocket(
          BYBIT_WS
        );
    } catch (e) {
      this.scheduleReconnect(
        shardId,
        symbols,
        attempt
      );

      return;
    }

    this.sockets.set(
      shardId,
      ws
    );

    this.wsState.set(
      shardId,
      {
        connected: false,
        attempt,
        openedAt: 0,
        messages: 0,
        errors: 0
      }
    );

    ws.addEventListener(
      "open",
      () => {
        const state =
          this.wsState.get(
            shardId
          );

        if (state) {
          state.connected =
            true;

          state.attempt =
            0;

          state.openedAt =
            Date.now();
        }

        const topics = [];

        for (
          const symbol of symbols
        ) {
          topics.push(
            `publicTrade.${symbol}`
          );

          topics.push(
            `orderbook.50.${symbol}`
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
          const args =
            topics.slice(
              i,
              i +
                WS_SUB_CHUNK
            );

          try {
            ws.send(
              JSON.stringify({
                op:
                  "subscribe",

                args
              })
            );
          } catch {}
        }
      }
    );

    ws.addEventListener(
      "message",
      event => {
        const state =
          this.wsState.get(
            shardId
          );

        if (state) {
          state.messages++;
        }

        this.handleWSMessage(
          event.data
        );
      }
    );

    ws.addEventListener(
      "error",
      () => {
        const state =
          this.wsState.get(
            shardId
          );

        if (state) {
          state.errors++;
        }
      }
    );

    ws.addEventListener(
      "close",
      () => {
        const state =
          this.wsState.get(
            shardId
          );

        if (state) {
          state.connected =
            false;
        }

        this.sockets.delete(
          shardId
        );

        this.scheduleReconnect(
          shardId,
          symbols,
          state?.attempt || attempt
        );
      }
    );
  }

  scheduleReconnect(
    shardId,
    symbols,
    attempt
  ) {
    if (
      this.reconnectTimers.has(
        shardId
      )
    ) {
      return;
    }

    const next =
      Math.min(
        WS_RECONNECT_MAX,
        WS_RECONNECT_MIN *
          Math.pow(
            2,
            Math.min(
              attempt,
              6
            )
          )
      );

    const timer =
      setTimeout(
        () => {
          this.reconnectTimers.delete(
            shardId
          );

          this.connectShard(
            shardId,
            symbols,
            attempt + 1
          );
        },
        next
      );

    this.reconnectTimers.set(
      shardId,
      timer
    );
  }

  handleWSMessage(
    raw
  ) {
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

    const topic =
      String(
        msg?.topic || ""
      );

    if (!topic) {
      return;
    }

    if (
      topic.startsWith(
        "publicTrade."
      )
    ) {
      const symbol =
        topic.replace(
          "publicTrade.",
          ""
        );

      const rows =
        Array.isArray(
          msg.data
        )
          ? msg.data
          : [];

      for (
        const x of rows
      ) {
        const trade = {
          id:
            x.i ||
            x.execId ||
            `${x.T}-${x.p}-${x.v}`,

          time:
            n(x.T),

          price:
            n(x.p),

          size:
            n(x.v),

          side:
            String(
              x.S || ""
            )
              .trim()
              .toUpperCase(),

          isBlockTrade:
            x.isBlockTrade ===
            true ||
            x.isBlockTrade ===
              "true",

          isRPITrade:
            x.isRPITrade ===
            true ||
            x.isRPITrade ===
              "true"
        };

        if (
          trade.time &&
          trade.price &&
          trade.size &&
          (
            trade.side ===
              "BUY" ||
            trade.side ===
              "SELL"
          )
        ) {
          this.addTrade(
            symbol,
            trade
          );
        }
      }

      return;
    }

    if (
      topic.startsWith(
        "orderbook."
      )
    ) {
      const symbol =
        topic.split(
          "."
        ).at(-1);

      this.updateBook(
        symbol,
        msg
      );

      return;
    }

    if (
      topic.startsWith(
        "allLiquidation."
      )
    ) {
      const symbol =
        topic.replace(
          "allLiquidation.",
          ""
        );

      const rows =
        Array.isArray(
          msg.data
        )
          ? msg.data
          : msg.data
            ? [msg.data]
            : [];

      for (
        const x of rows
      ) {
        this.addLiquidation(
          symbol,
          x
        );
      }
    }
  }

  addTrade(
    symbol,
    trade
  ) {
    const minute =
      minuteStart(
        trade.time
      );

    let current =
      this.minutes.get(
        symbol
      );

    if (
      current &&
      current.time !==
        minute
    ) {
      this.flushMinute(
        symbol
      );

      current =
        null;
    }

    if (!current) {
      current =
        newMinute(
          symbol,
          minute
        );

      this.minutes.set(
        symbol,
        current
      );
    }

    addTradeToMinute(
      current,
      trade
    );

    if (
      trade.isBlockTrade ||
      trade.price *
        trade.size >
        100000
    ) {
      current.blocks.push({
        id:
          trade.id,

        time:
          trade.time,

        price:
          trade.price,

        size:
          trade.size,

        value:
          trade.price *
          trade.size,

        side:
          trade.side
      });

      if (
        current.blocks.length >
        100
      ) {
        current.blocks =
          current.blocks.slice(
            -100
          );
      }
    }

    this.maybeFlush(
      symbol
    );
  }

  addLiquidation(
    symbol,
    x
  ) {
    const time =
      n(
        x.T ||
        x.time ||
        Date.now()
      );

    const minute =
      minuteStart(time);

    let current =
      this.minutes.get(
        symbol
      );

    if (
      current &&
      current.time !==
        minute
    ) {
      this.flushMinute(
        symbol
      );

      current =
        null;
    }

    if (!current) {
      current =
        newMinute(
          symbol,
          minute
        );

      this.minutes.set(
        symbol,
        current
      );
    }

    const side =
      String(
        x.S ||
        x.side ||
        x.sideType ||
        ""
      )
        .trim()
        .toUpperCase();

    const price =
      n(
        x.p ||
        x.price
      );

    const size =
      n(
        x.v ||
        x.size
      );

    const value =
      price *
      size;

    if (
      side ===
      "BUY"
    ) {
      current.liquidations.buy +=
        size;

      current.liquidations.buyValue +=
        value;
    } else if (
      side ===
      "SELL"
    ) {
      current.liquidations.sell +=
        size;

      current.liquidations.sellValue +=
        value;
    }

    current.liquidations.count++;

    this.maybeFlush(
      symbol
    );
  }

  updateBook(
    symbol,
    msg
  ) {
    let book =
      this.books.get(
        symbol
      );

    if (!book) {
      book = {
        bids: new Map(),
        asks: new Map(),

        bestBid: 0,
        bestAsk: 0,

        sequence: 0,
        updateId: 0,

        lastSnapshot: 0,
        lastUpdate: 0
      };

      this.books.set(
        symbol,
        book
      );
    }

    const data =
      msg?.data || {};

    const type =
      msg?.type || "";

    if (
      type ===
      "snapshot"
    ) {
      book.bids.clear();
      book.asks.clear();
    }

    for (
      const row of
        data.b || []
    ) {
      const price =
        n(row[0]);

      const size =
        n(row[1]);

      if (
        price <= 0
      ) {
        continue;
      }

      if (
        size <= 0
      ) {
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

    for (
      const row of
        data.a || []
    ) {
      const price =
        n(row[0]);

      const size =
        n(row[1]);

      if (
        price <= 0
      ) {
        continue;
      }

      if (
        size <= 0
      ) {
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

    book.sequence =
      n(
        data.u ||
        data.seq ||
        data.updateId ||
        msg?.cs
      );

    book.updateId =
      n(
        data.u ||
        data.updateId
      );

    book.lastUpdate =
      Date.now();

    const bidRows =
      [...book.bids.entries()]
        .sort(
          (a, b) =>
            b[0] -
            a[0]
        )
        .slice(
          0,
          ORDERBOOK_LIMIT
        );

    const askRows =
      [...book.asks.entries()]
        .sort(
          (a, b) =>
            a[0] -
            b[0]
        )
        .slice(
          0,
          ORDERBOOK_LIMIT
        );

    book.bestBid =
      bidRows[0]?.[0] ||
      0;

    book.bestAsk =
      askRows[0]?.[0] ||
      0;

    if (
      Date.now() -
        book.lastSnapshot >=
      ORDERBOOK_SNAPSHOT_MS
    ) {
      book.lastSnapshot =
        Date.now();

      this.captureBook(
        symbol,
        bidRows,
        askRows
      );
    }
  }

  captureBook(
    symbol,
    bids,
    asks
  ) {
    const current =
      this.minutes.get(
        symbol
      );

    if (!current) {
      return;
    }

    const bidLiquidity =
      bids.reduce(
        (s, x) =>
          s +
          x[0] *
            x[1],
        0
      );

    const askLiquidity =
      asks.reduce(
        (s, x) =>
          s +
          x[0] *
            x[1],
        0
      );

    current.bestBid =
      bids[0]?.[0] ||
      current.bestBid ||
      0;

    current.bestAsk =
      asks[0]?.[0] ||
      current.bestAsk ||
      0;

    current.bidLiquidity =
      bidLiquidity;

    current.askLiquidity =
      askLiquidity;

    current.maxBidLiquidity =
      Math.max(
        current.maxBidLiquidity,
        bidLiquidity
      );

    current.maxAskLiquidity =
      Math.max(
        current.maxAskLiquidity,
        askLiquidity
      );

    current.snapshotCount++;

    current.book =
      {
        bids:
          bids.map(
            x => ({
              price:
                x[0],

              size:
                x[1],

              value:
                x[0] *
                x[1]
            })
          ),

        asks:
          asks.map(
            x => ({
              price:
                x[0],

              size:
                x[1],

              value:
                x[0] *
                x[1]
            })
          ),

        bestBid:
          current.bestBid,

        bestAsk:
          current.bestAsk,

        timestamp:
          Date.now()
      };
  }

  maybeFlush(
    symbol
  ) {
    const current =
      this.minutes.get(
        symbol
      );

    if (!current) {
      return;
    }

    const now =
      Date.now();

    if (
      now -
        current.time >=
      120000
    ) {
      this.flushMinute(
        symbol
      );
    }
  }

  flushMinute(
    symbol
  ) {
    const minute =
      this.minutes.get(
        symbol
      );

    if (!minute) {
      return;
    }

    const finalized =
      finalizeMinute(
        minute
      );

    if (!finalized) {
      return;
    }

    try {
      this.ctx.storage.sql.exec(
        `
        INSERT OR REPLACE INTO minutes
        (symbol,ts,data)
        VALUES (?,?,?)
        `,
        symbol,
        finalized.time,
        JSON.stringify(
          finalized
        )
      );
    } catch (e) {
      console.error(
        "minute write error",
        e
      );
    }

    this.minutes.delete(
      symbol
    );

    this.lastFlush.set(
      symbol,
      Date.now()
    );

    this.cleanupSymbol(
      symbol
    );
  }

  getLatestMemory(
    symbol
  ) {
    const current =
      this.minutes.get(
        symbol
      );

    const rows =
      this.readHistory(
        symbol,
        1
      );

    const latestDb =
      rows.at(-1) ||
      null;

    const currentData =
      current
        ? finalizeMinute(
            current
          )
        : null;

    return {
      current:
        currentData,

      stored:
        latestDb,

      book:
        this.bookJSON(
          symbol
        )
    };
  }

  bookJSON(
    symbol
  ) {
    const book =
      this.books.get(
        symbol
      );

    if (!book) {
      return {
        bids: [],
        asks: [],
        bestBid: 0,
        bestAsk: 0,
        timestamp: 0
      };
    }

    return {
      bids:
        [...book.bids.entries()]
          .sort(
            (a, b) =>
              b[0] -
              a[0]
          )
          .slice(
            0,
            ORDERBOOK_LIMIT
          )
          .map(
            x => ({
              price:
                x[0],

              size:
                x[1],

              value:
                x[0] *
                x[1]
            })
          ),

      asks:
        [...book.asks.entries()]
          .sort(
            (a, b) =>
              a[0] -
              b[0]
          )
          .slice(
            0,
            ORDERBOOK_LIMIT
          )
          .map(
            x => ({
              price:
                x[0],

              size:
                x[1],

              value:
                x[0] *
                x[1]
            })
          ),

      bestBid:
        book.bestBid,

      bestAsk:
        book.bestAsk,

      timestamp:
        book.lastUpdate
    };
  }

  readHistory(
    symbol,
    minutes = 300
  ) {
    const limit =
      clamp(
        Number(minutes),
        1,
        RETENTION_MINUTES
      );

    const cutoff =
      Date.now() -
      limit *
        60000;

    let rows = [];

    try {
      const result =
        this.ctx.storage.sql.exec(
          `
          SELECT data
          FROM minutes
          WHERE symbol = ?
          AND ts >= ?
          ORDER BY ts ASC
          LIMIT ?
          `,
          symbol,
          cutoff,
          limit
        );

      for (
        const row of result
      ) {
        try {
          rows.push(
            JSON.parse(
              row.data
            )
          );
        } catch {}
      }
    } catch (e) {
      console.error(
        "history read error",
        e
      );
    }

    const current =
      this.minutes.get(
        symbol
      );

    if (current) {
      const data =
        finalizeMinute(
          current
        );

      if (
        data &&
        data.time >=
          cutoff
      ) {
        rows.push(
          data
        );
      }
    }

    const map =
      new Map();

    for (
      const row of rows
    ) {
      map.set(
        row.time,
        row
      );
    }

    return [
      ...map.values()
    ].sort(
      (a, b) =>
        a.time -
        b.time
    );
  }

  cleanupSymbol(
    symbol
  ) {
    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
        60000;

    try {
      this.ctx.storage.sql.exec(
        `
        DELETE FROM minutes
        WHERE symbol = ?
        AND ts < ?
        `,
        symbol,
        cutoff
      );
    } catch {}
  }

  cleanup() {
    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
        60000;

    try {
      const before =
        this.ctx.storage.sql.exec(
          `
          SELECT COUNT(*) AS c
          FROM minutes
          WHERE ts < ?
          `,
          cutoff
        );

      const removed =
        n(
          before
            ?.one?.()?.c ||
          0
        );

      this.ctx.storage.sql.exec(
        `
        DELETE FROM minutes
        WHERE ts < ?
        `,
        cutoff
      );

      return removed;
    } catch {
      return 0;
    }
  }

  collectorChart(
    symbol,
    interval
  ) {
    const rows =
      this.readHistory(
        symbol,
        180
      );

    const currentBook =
      this.bookJSON(
        symbol
      );

    const candles =
      rows.map(
        x => ({
          time:
            x.time,

          open:
            x.open,

          high:
            x.high,

          low:
            x.low,

          close:
            x.close,

          volume:
            x.volume,

          flowVolume:
            x.volume,

          buyVolume:
            x.buyVolume,

          sellVolume:
            x.sellVolume,

          buyValue:
            x.buyValue,

          sellValue:
            x.sellValue,

          delta:
            x.delta,

          deltaValue:
            x.deltaValue,

          deltaPercent:
            x.deltaPercent,

          tradeCount:
            x.tradeCount,

          cumulativeDeltaValue:
            x.cumulativeDelta,

          footprint:
            x.levels ||
            []
        })
      );

    return {
      ok: true,

      version:
        VERSION,

      category:
        "linear",

      symbol,

      interval,

      source:
        "COLLECTOR",

      serverTime:
        Date.now(),

      candles,

      footprints:
        rows.map(
          x => ({
            time:
              x.time,

            open:
              x.open,

            high:
              x.high,

            low:
              x.low,

            close:
              x.close,

            volume:
              x.volume,

            flowVolume:
              x.volume,

            buyVolume:
              x.buyVolume,

            sellVolume:
              x.sellVolume,

            buyValue:
              x.buyValue,

            sellValue:
              x.sellValue,

            buyTrades:
              x.buyTrades,

            sellTrades:
              x.sellTrades,

            tradeCount:
              x.tradeCount,

            delta:
              x.delta,

            deltaValue:
              x.deltaValue,

            deltaPercent:
              x.deltaPercent,

            levels:
              x.levels ||
              []
          })
        ),

      candleDelta:
        rows.map(
          x => ({
            time:
              x.time,

            buy:
              x.buyVolume,

            sell:
              x.sellVolume,

            delta:
              x.delta,

            deltaValue:
              x.deltaValue,

            deltaPercent:
              x.deltaPercent,

            trades:
              x.tradeCount,

            cumulativeDeltaValue:
              x.cumulativeDelta
          })
        ),

      orderbook:
        currentBook,

      heatmap:
        liquidityHeatmap(
          currentBook
        ),

      wall:
        wallAnalysis(
          currentBook
        ),

      liquidityZones:
        liquidityZones(
          currentBook,
          currentBook.bestBid
        ),

      current:
        rows.at(-1) ||
        null
    };
  }

  status() {
    const socketStates =
      [...this.wsState.entries()]
        .map(
          ([id, state]) => ({
            shard:
              id,

            ...state
          })
        );

    let minuteCount = 0;

    try {
      minuteCount =
        n(
          this.ctx.storage.sql
            .exec(
              `
              SELECT COUNT(*) AS c
              FROM minutes
              `
            )
            ?.one?.()?.c ||
          0
        );
    } catch {}

    return {
      ok: true,

      version:
        VERSION,

      initialized:
        this.initialized,

      symbols:
        this.symbols.length,

      activeBooks:
        this.books.size,

      activeMinutes:
        this.minutes.size,

      storedMinutes:
        minuteCount,

      sockets:
        socketStates,

      time:
        Date.now()
    };
  }
}

/* =========================================================
   COLLECTOR ACCESS
========================================================= */

function collectorId(
  env
) {
  return env.COLLECTOR.idFromName(
    "MAIN"
  );
}

function collectorStub(
  env
) {
  return env.COLLECTOR.get(
    collectorId(env)
  );
}

async function collectorFetch(
  env,
  path,
  params = {}
) {
  const u =
    new URL(
      "https://collector.internal" +
        path
    );

  for (
    const [k, v] of
      Object.entries(params)
  ) {
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

  return collectorStub(
    env
  ).fetch(
    new Request(
      u.toString()
    )
  );
}

/* =========================================================
   MAIN WORKER
========================================================= */

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

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {
      /* ==========================================
         HEALTH
      ========================================== */

      if (
        path ===
        "/api/health"
      ) {
        let collector =
          null;

        try {
          const r =
            await collectorFetch(
              env,
              "/status"
            );

          collector =
            await r.json();
        } catch (
          e
        ) {
          collector = {
            ok: false,
            error:
              e?.message ||
              String(e)
          };
        }

        return json({
          ok: true,

          version:
            VERSION,

          service:
            "Bybit Absorption Order Flow",

          collector,

          time:
            Date.now()
        });
      }

      /* ==========================================
         TEST BYBIT
      ========================================== */

      if (
        path ===
        "/api/test-bybit"
      ) {
        const x =
          await bybit(
            "/v5/market/time"
          );

        return json({
          ok: true,

          version:
            VERSION,

          bybit:
            x,

          time:
            Date.now()
        });
      }

      /* ==========================================
         COLLECTOR INIT
      ========================================== */

      if (
        path ===
        "/api/collector/init" ||
        path ===
        "/api/init"
      ) {
        const r =
          await collectorFetch(
            env,
            "/init"
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR STATUS
      ========================================== */

      if (
        path ===
        "/api/collector/status" ||
        path ===
        "/api/status"
      ) {
        const r =
          await collectorFetch(
            env,
            "/status"
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR HISTORY
      ========================================== */

      if (
        path ===
        "/api/history"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const minutes =
          url.searchParams.get(
            "minutes"
          ) ||
          "300";

        const r =
          await collectorFetch(
            env,
            "/history",
            {
              symbol,
              minutes
            }
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR LATEST
      ========================================== */

      if (
        path ===
        "/api/latest"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const r =
          await collectorFetch(
            env,
            "/latest",
            {
              symbol
            }
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR CHART
      ========================================== */

      if (
        path ===
        "/api/collector/chart"
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
            ) || TF
          );

        const r =
          await collectorFetch(
            env,
            "/chart",
            {
              symbol,
              interval
            }
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR SYMBOLS
      ========================================== */

      if (
        path ===
        "/api/collector/symbols"
      ) {
        const r =
          await collectorFetch(
            env,
            "/symbols"
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         COLLECTOR CLEANUP
      ========================================== */

      if (
        path ===
        "/api/collector/cleanup"
      ) {
        const r =
          await collectorFetch(
            env,
            "/cleanup"
          );

        return new Response(
          await r.text(),
          {
            status:
              r.status,

            headers:
              r.headers
          }
        );
      }

      /* ==========================================
         ANALYZE
      ========================================== */

      if (
        path ===
        "/api/analyze"
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

      /* ==========================================
         CHART
      ========================================== */

      if (
        path ===
        "/api/chart"
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

        /*
         * First try the persistent
         * collector when initialized.
         */
        try {
          const collector =
            await collectorFetch(
              env,
              "/chart",
              {
                symbol,
                interval
              }
            );

          const data =
            await collector.json();

          if (
            data?.ok &&
            data?.candles?.length
          ) {
            return json(
              data
            );
          }
        } catch {}

        return json(
          await buildChartData(
            symbol,
            interval
          )
        );
      }

      /* ==========================================
         LIVE
      ========================================== */

      if (
        path ===
        "/api/live"
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

      /* ==========================================
         SCAN
      ========================================== */

      if (
        path ===
        "/api/scan"
      ) {
        const offset =
          Number(
            url.searchParams.get(
              "offset"
            ) || 0
          );

        return json(
          await scan(
            offset
          )
        );
      }

      /* ==========================================
         SYMBOLS
      ========================================== */

      if (
        path ===
        "/api/symbols"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          symbols:
            await getSymbols()
        });
      }

      /* ==========================================
         STATIC PUBLIC
      ========================================== */

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

          version:
            VERSION,

          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
