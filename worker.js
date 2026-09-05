const VERSION = "ABSORPTION-ZONE-V2";

const BYBIT = "https://api.bybit.com";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate"
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

function normalizeSymbol(value) {
  let s = String(value || DEFAULT_SYMBOL)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s) return DEFAULT_SYMBOL;

  if (
    s === "BTC" ||
    s === "BTCUSDT" ||
    s === "BUSDT"
  ) {
    return "BTCUSDT";
  }

  if (s.endsWith("USDT")) return s;

  return s + "USDT";
}

function normalizeInterval(value) {
  const v = String(value || DEFAULT_INTERVAL);

  const allowed = [
    "1",
    "3",
    "5",
    "15",
    "30",
    "60",
    "120",
    "240",
    "360",
    "720",
    "D",
    "W",
    "M"
  ];

  return allowed.includes(v) ? v : "1";
}

async function bybit(path, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      query.set(key, String(value));
    }
  }

  const url =
    `${BYBIT}${path}?${query.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!text) {
    throw new Error(
      `Bybit پاسخ خالی داد (${response.status})`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ Bybit معتبر نیست: ${text.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data;
}

function parseKlines(rows) {
  return (rows || [])
    .map(r => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      turnover: Number(r[6])
    }))
    .filter(x =>
      Number.isFinite(x.time) &&
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close)
    )
    .reverse();
}

function parseTrades(rows) {
  return (rows || [])
    .map(t => {
      const side =
        String(t.side || "").toLowerCase() === "buy"
          ? "buy"
          : "sell";

      const price = Number(t.price);
      const size = Number(t.size);

      return {
        id:
          t.execId ||
          t.tradeId ||
          t.i ||
          `${t.time}-${price}-${size}`,

        time:
          Number(t.time || t.T || Date.now()),

        price,
        size,
        value: price * size,
        side
      };
    })
    .filter(t =>
      Number.isFinite(t.price) &&
      Number.isFinite(t.size) &&
      Number.isFinite(t.time)
    );
}

function tradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  const notionals = [];

  for (const t of trades) {
    const value =
      Number(t.price) *
      Number(t.size);

    notionals.push(value);

    if (t.side === "buy") {
      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else {
      sellVolume += t.size;
      sellValue += value;
      sellTrades++;
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  const totalValue =
    buyValue + sellValue;

  const delta =
    buyVolume - sellVolume;

  const deltaValue =
    buyValue - sellValue;

  const deltaPercent =
    totalVolume > 0
      ? delta / totalVolume * 100
      : 0;

  const sorted =
    [...notionals].sort(
      (a, b) => a - b
    );

  const p95 =
    sorted.length
      ? sorted[
          Math.floor(
            (sorted.length - 1) * 0.95
          )
        ]
      : 0;

  const average =
    notionals.length
      ? totalValue / notionals.length
      : 0;

  const largeThreshold =
    Math.max(
      average * 5,
      p95,
      0
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  let largeBuyValue = 0;
  let largeSellValue = 0;

  for (const t of trades) {
    const value =
      t.price * t.size;

    if (value >= largeThreshold) {
      if (t.side === "buy") {
        largeBuyVolume += t.size;
        largeBuyValue += value;
      } else {
        largeSellVolume += t.size;
        largeSellValue += value;
      }
    }
  }

  return {
    trades: trades.length,

    buyVolume,
    sellVolume,

    buyValue,
    sellValue,

    totalVolume,
    totalValue,

    delta,
    deltaValue,
    deltaPercent,

    buyTrades,
    sellTrades,

    largeThreshold,

    largeBuyVolume,
    largeSellVolume,

    largeBuyValue,
    largeSellValue,

    pressure:
      deltaPercent >= 10
        ? "BUY_PRESSURE"
        : deltaPercent <= -10
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}

function aggregateFootprint(
  trades,
  tickSize = 0
) {
  const levels = new Map();

  for (const t of trades) {
    let price = t.price;

    if (tickSize > 0) {
      price =
        Math.round(price / tickSize) *
        tickSize;
    }

    const decimals =
      tickSize >= 1
        ? 0
        : tickSize > 0
          ? Math.max(
              0,
              Math.ceil(
                -Math.log10(tickSize)
              )
            )
          : 8;

    const key =
      price.toFixed(decimals);

    if (!levels.has(key)) {
      levels.set(key, {
        price,
        buyVolume: 0,
        sellVolume: 0,
        buyValue: 0,
        sellValue: 0,
        buyTrades: 0,
        sellTrades: 0
      });
    }

    const level =
      levels.get(key);

    if (t.side === "buy") {
      level.buyVolume += t.size;
      level.buyValue += t.value;
      level.buyTrades++;
    } else {
      level.sellVolume += t.size;
      level.sellValue += t.value;
      level.sellTrades++;
    }
  }

  return [...levels.values()]
    .map(x => ({
      ...x,

      delta:
        x.buyVolume -
        x.sellVolume,

      deltaValue:
        x.buyValue -
        x.sellValue,

      totalVolume:
        x.buyVolume +
        x.sellVolume,

      imbalance:
        x.sellVolume > 0
          ? x.buyVolume /
            x.sellVolume
          : x.buyVolume > 0
            ? 999
            : 0
    }))
    .sort(
      (a, b) =>
        b.price - a.price
    );
}

function orderbookStats(data) {
  const bids =
    (data.b || [])
      .map(x => ({
        price: Number(x[0]),
        size: Number(x[1]),
        value:
          Number(x[0]) *
          Number(x[1])
      }))
      .filter(x =>
        Number.isFinite(x.price) &&
        Number.isFinite(x.size)
      );

  const asks =
    (data.a || [])
      .map(x => ({
        price: Number(x[0]),
        size: Number(x[1]),
        value:
          Number(x[0]) *
          Number(x[1])
      }))
      .filter(x =>
        Number.isFinite(x.price) &&
        Number.isFinite(x.size)
      );

  const buyLiquidity =
    bids.reduce(
      (sum, x) =>
        sum + x.value,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (sum, x) =>
        sum + x.value,
      0
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? buyLiquidity /
        totalLiquidity *
        100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? sellLiquidity /
        totalLiquidity *
        100
      : 0;

  const bestBid =
    bids.length
      ? bids[0].price
      : 0;

  const bestAsk =
    asks.length
      ? asks[0].price
      : 0;

  const spread =
    bestAsk > 0 &&
    bestBid > 0
      ? bestAsk - bestBid
      : 0;

  return {
    bids,
    asks,

    buyLiquidity,
    sellLiquidity,

    totalLiquidity,

    buyShare,
    sellShare,

    bestBid,
    bestAsk,
    spread,

    pressure:
      buyShare >
      sellShare + 8
        ? "BUY_PRESSURE"
        : sellShare >
          buyShare + 8
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}

function detectAbsorption(
  trades,
  candles,
  book
) {
  if (
    !trades.length ||
    !candles.length
  ) {
    return {
      detected: false,
      side: "NONE",
      score: 0,
      reason: "داده کافی نیست"
    };
  }

  const last =
    candles[candles.length - 1];

  const stats =
    tradeStats(trades);

  const range =
    Math.max(
      last.high - last.low,
      Number.EPSILON
    );

  const body =
    Math.abs(
      last.close - last.open
    );

  const bodyRatio =
    body / range;

  const nearLow =
    (last.close - last.low) /
    range;

  const nearHigh =
    (last.high - last.close) /
    range;

  const sellPressure =
    stats.deltaPercent < -10;

  const buyPressure =
    stats.deltaPercent > 10;

  let score = 0;
  let side = "NONE";

  const reasons = [];

  if (
    sellPressure &&
    nearLow < 0.35
  ) {
    score += 35;
    side = "BUY";

    reasons.push(
      "فشار فروش در کف جذب شده"
    );
  }

  if (
    buyPressure &&
    nearHigh < 0.35
  ) {
    score += 35;
    side = "SELL";

    reasons.push(
      "فشار خرید در سقف جذب شده"
    );
  }

  if (bodyRatio < 0.35) {
    score += 20;

    reasons.push(
      "بدنه کندل کوچک نسبت به محدوده"
    );
  }

  const bookPressure =
    book?.pressure ||
    "BALANCED";

  if (
    side === "BUY" &&
    bookPressure ===
      "BUY_PRESSURE"
  ) {
    score += 20;

    reasons.push(
      "حمایت سمت Bid در Order Book"
    );
  }

  if (
    side === "SELL" &&
    bookPressure ===
      "SELL_PRESSURE"
  ) {
    score += 20;

    reasons.push(
      "حمایت سمت Ask در Order Book"
    );
  }

  return {
    detected: score >= 50,
    side,
    score: Math.min(
      score,
      100
    ),

    reason:
      reasons.length
        ? reasons.join(" · ")
        : "Absorption معتبر شناسایی نشد"
  };
}

async function getMarket(
  symbol,
  interval
) {
  const [
    kline,
    ticker,
    book,
    trades
  ] = await Promise.all([
    bybit(
      "/v5/market/kline",
      {
        category: "linear",
        symbol,
        interval,
        limit: KLINE_LIMIT
      }
    ),

    bybit(
      "/v5/market/tickers",
      {
        category: "linear",
        symbol
      }
    ),

    bybit(
      "/v5/market/orderbook",
      {
        category: "linear",
        symbol,
        limit: ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category: "linear",
        symbol,
        limit: TRADE_LIMIT
      }
    )
  ]);

  const candles =
    parseKlines(
      kline.result?.list
    );

  const parsedTrades =
    parseTrades(
      trades.result?.list
    );

  const bookStats =
    orderbookStats(
      book.result?.list || {}
    );

  const stats =
    tradeStats(
      parsedTrades
    );

  const footprint =
    aggregateFootprint(
      parsedTrades
    );

  const absorption =
    detectAbsorption(
      parsedTrades,
      candles,
      bookStats
    );

  const tickerData =
    ticker.result?.list?.[0] ||
    {};

  return {
    version: VERSION,

    symbol,

    category: "linear",

    interval,

    serverTime: Date.now(),

    ticker: {
      lastPrice:
        Number(
          tickerData.lastPrice || 0
        ),

      markPrice:
        Number(
          tickerData.markPrice || 0
        ),

      indexPrice:
        Number(
          tickerData.indexPrice || 0
        ),

      price24hPcnt:
        Number(
          tickerData.price24hPcnt ||
          0
        ) * 100,

      volume24h:
        Number(
          tickerData.volume24h || 0
        ),

      turnover24h:
        Number(
          tickerData.turnover24h || 0
        )
    },

    candles,

    trades: parsedTrades,

    stats,

    footprint,

    orderbook: bookStats,

    absorption
  };
}

async function getSymbols() {
  const all = [];

  let cursor = "";

  for (let page = 0; page < 10; page++) {
    const params = {
      category: "linear",
      status: "Trading",
      limit: SYMBOL_LIMIT
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const result =
      await bybit(
        "/v5/market/instruments-info",
        params
      );

    const list =
      result.result?.list || [];

    for (const item of list) {
      const symbol =
        String(
          item.symbol || ""
        ).toUpperCase();

      if (!symbol) continue;

      if (
        item.status !== "Trading"
      ) {
        continue;
      }

      if (
        item.quoteCoin &&
        item.quoteCoin !== "USDT"
      ) {
        continue;
      }

      if (
        item.settleCoin &&
        item.settleCoin !== "USDT"
      ) {
        continue;
      }

      if (
        item.contractType &&
        !String(
          item.contractType
        ).toLowerCase()
        .includes("perpetual")
      ) {
        continue;
      }

      all.push({
        symbol,
        baseCoin:
          item.baseCoin || "",
        quoteCoin:
          item.quoteCoin || "USDT",
        settleCoin:
          item.settleCoin || "USDT",
        contractType:
          item.contractType ||
          "LinearPerpetual",
        status:
          item.status || "Trading",
        tickSize:
          item.priceFilter?.tickSize ||
          "0",
        minOrderQty:
          item.lotSizeFilter?.minOrderQty ||
          "0"
      });
    }

    const next =
      result.result?.nextPageCursor ||
      "";

    if (!next || !list.length) {
      break;
    }

    cursor = next;
  }

  all.sort((a, b) =>
    a.symbol.localeCompare(
      b.symbol
    )
  );

  return all;
}

async function route(request) {
  const url =
    new URL(request.url);

  if (
    url.pathname ===
    "/api/health"
  ) {
    return json({
      ok: true,
      version: VERSION,
      category: "linear",
      time:
        new Date().toISOString()
    });
  }

  if (
    url.pathname ===
    "/api/test"
  ) {
    return new Response(
      "API TEST OK - " +
      VERSION,
      {
        headers: {
          ...CORS,
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }

  if (
    url.pathname ===
    "/api/symbols"
  ) {
    try {
      const symbols =
        await getSymbols();

      return json({
        ok: true,
        version: VERSION,
        category: "linear",
        count: symbols.length,
        symbols
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "خطای دریافت لیست Futures",
          version: VERSION
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/market"
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

    try {
      const result =
        await getMarket(
          symbol,
          interval
        );

      return json({
        ok: true,
        ...result
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "خطای دریافت اطلاعات Bybit",
          version: VERSION
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/footprint"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    try {
      const result =
        await bybit(
          "/v5/market/recent-trade",
          {
            category: "linear",
            symbol,
            limit: TRADE_LIMIT
          }
        );

      const trades =
        parseTrades(
          result.result?.list
        );

      return json({
        ok: true,

        symbol,

        category: "linear",

        trades,

        stats:
          tradeStats(trades),

        footprint:
          aggregateFootprint(
            trades
          )
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Footprint error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/orderbook"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    try {
      const result =
        await bybit(
          "/v5/market/orderbook",
          {
            category: "linear",
            symbol,
            limit: ORDERBOOK_LIMIT
          }
        );

      return json({
        ok: true,

        symbol,

        category: "linear",

        ...orderbookStats(
          result.result?.list || {}
        )
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Order Book error"
        },
        502
      );
    }
  }

  if (
    url.pathname ===
    "/api/candles"
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

    try {
      const result =
        await bybit(
          "/v5/market/kline",
          {
            category: "linear",
            symbol,
            interval,
            limit: KLINE_LIMIT
          }
        );

      return json({
        ok: true,

        symbol,

        category: "linear",

        interval,

        candles:
          parseKlines(
            result.result?.list
          )
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Kline error"
        },
        502
      );
    }
  }

  return json({
    ok: true,
    service:
      "Absorption Zone Scanner",
    version: VERSION,
    category: "linear"
  });
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
          headers: CORS
        }
      );
    }

    const url =
      new URL(request.url);

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      return route(request);
    }

    if (env.ASSETS) {
      const response =
        await env.ASSETS.fetch(
          request
        );

      const headers =
        new Headers(
          response.headers
        );

      headers.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      return new Response(
        response.body,
        {
          status:
            response.status,
          statusText:
            response.statusText,
          headers
        }
      );
    }

    return route(request);
  }
};
