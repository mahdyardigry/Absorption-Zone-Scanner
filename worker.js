const VERSION = "ABSORPTION-ZONE-V4-HOUR-BLOCK";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const LBANK = "https://www.lbank.com";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const HISTORY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};


/* =========================================================
   COMMON
========================================================= */

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

  if (s.endsWith("USDT")) {
    return s;
  }

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

function hourStartOf(time) {
  return Math.floor(
    Number(time) / HOUR_MS
  ) * HOUR_MS;
}

function minuteStartOf(time) {
  return Math.floor(
    Number(time) / 60000
  ) * 60000;
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
      `پاسخ Bybit معتبر نیست: ${text.slice(0, 300)}`
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


/* =========================================================
   KLINES
========================================================= */

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


/* =========================================================
   TRADES
========================================================= */

function parseTrades(rows) {
  return (rows || [])
    .map(t => {
      const side =
        String(
          t.side ||
          t.S ||
          ""
        ).toLowerCase() === "buy"
          ? "buy"
          : "sell";

      const price = Number(
        t.price ??
        t.p
      );

      const size = Number(
        t.size ??
        t.v
      );

      const time = Number(
        t.time ??
        t.T ??
        Date.now()
      );

      const id =
        t.execId ||
        t.tradeId ||
        t.i ||
        t.id ||
        `${time}-${price}-${size}-${side}`;

      return {
        id: String(id),
        time,
        price,
        size,
        value: price * size,
        side
      };
    })
    .filter(t =>
      Number.isFinite(t.price) &&
      Number.isFinite(t.size) &&
      Number.isFinite(t.time) &&
      t.price > 0 &&
      t.size > 0
    );
}


/* =========================================================
   TRADE STATS
========================================================= */

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


/* =========================================================
   FOOTPRINT
========================================================= */

function decimalsFromTick(tickSize) {
  const n = Number(tickSize);

  if (!Number.isFinite(n) || n <= 0) {
    return 8;
  }

  if (n >= 1) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      12,
      Math.ceil(-Math.log10(n))
    )
  );
}

function roundToTick(price, tickSize) {
  const tick = Number(tickSize);

  if (
    !Number.isFinite(tick) ||
    tick <= 0
  ) {
    return price;
  }

  return Math.round(
    price / tick
  ) * tick;
}

function aggregateFootprint(
  trades,
  tickSize = 0
) {
  const levels = new Map();

  const decimals =
    decimalsFromTick(tickSize);

  for (const t of trades) {
    let price = Number(t.price);

    if (
      Number(tickSize) > 0
    ) {
      price =
        roundToTick(
          price,
          tickSize
        );
    }

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


/* =========================================================
   ORDER BOOK
========================================================= */

function orderbookStats(data) {
  const bids =
    (data?.b || [])
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
    (data?.a || [])
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


/* =========================================================
   ABSORPTION
========================================================= */

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
    detected:
      score >= 50,

    side,

    score:
      Math.min(
        score,
        100
      ),

    reason:
      reasons.length
        ? reasons.join(" · ")
        : "Absorption معتبر شناسایی نشد"
  };
}


/* =========================================================
   BYBIT SYMBOLS
========================================================= */

async function getBybitSymbols() {
  const all = [];

  let cursor = "";

  for (
    let page = 0;
    page < 20;
    page++
  ) {
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
      result.result?.list ||
      [];

    for (const item of list) {
      const symbol =
        String(
          item.symbol || ""
        ).toUpperCase();

      if (!symbol) {
        continue;
      }

      if (
        item.status !==
        "Trading"
      ) {
        continue;
      }

      if (
        item.quoteCoin &&
        item.quoteCoin !==
          "USDT"
      ) {
        continue;
      }

      if (
        item.settleCoin &&
        item.settleCoin !==
          "USDT"
      ) {
        continue;
      }

      if (
        item.contractType &&
        !String(
          item.contractType
        )
          .toLowerCase()
          .includes(
            "perpetual"
          )
      ) {
        continue;
      }

      all.push({
        symbol,

        baseCoin:
          item.baseCoin ||
          "",

        quoteCoin:
          item.quoteCoin ||
          "USDT",

        settleCoin:
          item.settleCoin ||
          "USDT",

        contractType:
          item.contractType ||
          "LinearPerpetual",

        status:
          item.status ||
          "Trading",

        tickSize:
          item.priceFilter?.tickSize ||
          "0",

        minOrderQty:
          item.lotSizeFilter?.minOrderQty ||
          "0"
      });
    }

    const next =
      result.result
        ?.nextPageCursor ||
      "";

    if (
      !next ||
      !list.length
    ) {
      break;
    }

    cursor = next;
  }

  const unique =
    new Map();

  for (const item of all) {
    unique.set(
      item.symbol,
      item
    );
  }

  return [
    ...unique.values()
  ].sort((a, b) =>
    a.symbol.localeCompare(
      b.symbol
    )
  );
}


/* =========================================================
   LBANK SYMBOL SOURCE
========================================================= */

function isCryptoLbankInstrument(item) {
  const symbol =
    String(
      item?.symbol ||
      item?.contractCode ||
      item?.pair ||
      ""
    )
      .toUpperCase()
      .replace(
        /[-_/]/g,
        ""
      );

  const base =
    String(
      item?.baseCurrency ||
      item?.baseCoin ||
      ""
    )
      .toUpperCase();

  const clear =
    String(
      item?.clearCurrency ||
      item?.settleCurrency ||
      item?.quoteCurrency ||
      ""
    )
      .toUpperCase();

  const quote =
    String(
      item?.quoteCurrency ||
      item?.quoteCoin ||
      item?.marginCoin ||
      ""
    )
      .toUpperCase();

  if (
    !symbol &&
    !base
  ) {
    return null;
  }

  const stable =
    clear === "USDT" ||
    quote === "USDT" ||
    symbol.endsWith("USDT");

  if (!stable) {
    return null;
  }

  if (
    !symbol.endsWith("USDT") &&
    !base
  ) {
    return null;
  }

  let finalSymbol =
    symbol;

  if (
    !finalSymbol &&
    base
  ) {
    finalSymbol =
      base + "USDT";
  }

  if (
    !finalSymbol.endsWith(
      "USDT"
    )
  ) {
    finalSymbol +=
      "USDT";
  }

  if (
    !/^[A-Z0-9]+USDT$/.test(
      finalSymbol
    )
  ) {
    return null;
  }

  return finalSymbol;
}

async function getLbankSymbols() {
  const urls = [
    `${LBANK}/cfd/openApi/v1/pub/instrument`,
    `${LBANK}/api/v2/cfd/openApi/v1/pub/instrument`
  ];

  let lastError =
    null;

  for (const url of urls) {
    try {
      const response =
        await fetch(
          url,
          {
            method: "GET",
            headers: {
              Accept:
                "application/json"
            }
          }
        );

      const text =
        await response.text();

      if (
        !response.ok ||
        !text
      ) {
        throw new Error(
          `LBank HTTP ${response.status}`
        );
      }

      const data =
        JSON.parse(text);

      const list =
        Array.isArray(data)
          ? data
          : Array.isArray(
              data?.data
            )
            ? data.data
            : Array.isArray(
                data?.result
              )
              ? data.result
              : Array.isArray(
                  data?.data?.list
                )
                ? data.data.list
                : [];

      const symbols =
        new Set();

      for (const item of list) {
        const symbol =
          isCryptoLbankInstrument(
            item
          );

        if (symbol) {
          symbols.add(
            symbol
          );
        }
      }

      if (symbols.size > 0) {
        return [
          ...symbols
        ].sort();
      }

      throw new Error(
        "LBank لیست قرارداد معتبر برنگرداند"
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      "LBank unavailable"
    )
  );
}


/* =========================================================
   FINAL COLLECTOR SYMBOL LIST
========================================================= */

async function getCollectorSymbols() {
  const bybitSymbols =
    await getBybitSymbols();

  let lbankSymbols = [];

  try {
    lbankSymbols =
      await getLbankSymbols();
  } catch {
    lbankSymbols = [];
  }

  let selected;

  if (
    lbankSymbols.length
  ) {
    const allowed =
      new Set(
        lbankSymbols
      );

    selected =
      bybitSymbols.filter(
        x =>
          allowed.has(
            x.symbol
          )
      );
  } else {
    selected =
      bybitSymbols;
  }

  return {
    symbols: selected,
    bybitCount:
      bybitSymbols.length,
    lbankCount:
      lbankSymbols.length,
    filteredCount:
      selected.length,
    lbankAvailable:
      lbankSymbols.length >
      0
  };
}


/* =========================================================
   MARKET
========================================================= */

async function getMarket(
  symbol,
  interval
) {
  const [
    kline,
    ticker,
    book,
    trades,
    instrument
  ] = await Promise.all([
    bybit(
      "/v5/market/kline",
      {
        category: "linear",
        symbol,
        interval,
        limit:
          KLINE_LIMIT
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
        limit:
          ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category: "linear",
        symbol,
        limit:
          TRADE_LIMIT
      }
    ),

    bybit(
      "/v5/market/instruments-info",
      {
        category: "linear",
        symbol
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
      book.result?.list ||
      {}
    );

  const stats =
    tradeStats(
      parsedTrades
    );

  const tickSize =
    instrument.result?.list?.[0]
      ?.priceFilter?.tickSize ||
    "0";

  const footprint =
    aggregateFootprint(
      parsedTrades,
      tickSize
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

    category:
      "linear",

    interval,

    serverTime:
      Date.now(),

    tickSize,

    ticker: {
      lastPrice:
        Number(
          tickerData.lastPrice ||
          0
        ),

      markPrice:
        Number(
          tickerData.markPrice ||
          0
        ),

      indexPrice:
        Number(
          tickerData.indexPrice ||
          0
        ),

      price24hPcnt:
        Number(
          tickerData.price24hPcnt ||
          0
        ) * 100,

      volume24h:
        Number(
          tickerData.volume24h ||
          0
        ),

      turnover24h:
        Number(
          tickerData.turnover24h ||
          0
        )
    },

    candles,

    trades:
      parsedTrades,

    stats,

    footprint,

    orderbook:
      bookStats,

    absorption
  };
}


/* =========================================================
   DURABLE OBJECT HELPER
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR
  ) {
    throw new Error(
      "TRADE_COLLECTOR binding پیدا نشد"
    );
  }

  return env.TRADE_COLLECTOR.idFromName(
    "global-bybit-trade-collector"
  );
}

function collectorStub(env) {
  return env.TRADE_COLLECTOR.get(
    collectorId(env)
  );
}


/* =========================================================
   COLLECTOR START
========================================================= */

async function startCollector(env) {
  const stub =
    collectorStub(env);

  const response =
    await stub.fetch(
      "https://collector/internal/start"
    );

  return response.json();
}


/* =========================================================
   API ROUTER
========================================================= */

async function route(
  request,
  env
) {
  const url =
    new URL(request.url);

  if (
    url.pathname ===
    "/api/health"
  ) {
    return json({
      ok: true,
      version: VERSION,
      category:
        "linear",
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
      const result =
        await getCollectorSymbols();

      return json({
        ok: true,

        version:
          VERSION,

        category:
          "linear",

        count:
          result.symbols.length,

        bybitCount:
          result.bybitCount,

        lbankCount:
          result.lbankCount,

        lbankAvailable:
          result.lbankAvailable,

        symbols:
          result.symbols
      });
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            "خطای دریافت لیست Futures",

          version:
            VERSION
        },
        502
      );
    }
  }


  if (
    url.pathname ===
    "/api/collector/start"
  ) {
    try {
      const result =
        await startCollector(
          env
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
            "Collector start error"
        },
        500
      );
    }
  }


  if (
    url.pathname ===
    "/api/collector/status"
  ) {
    try {
      const stub =
        collectorStub(env);

      const response =
        await stub.fetch(
          "https://collector/internal/status"
        );

      const data =
        await response.json();

      return json({
        ok: true,
        ...data
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Collector status error"
        },
        500
      );
    }
  }


  if (
    url.pathname ===
    "/api/collector/refresh"
  ) {
    try {
      const stub =
        collectorStub(env);

      const response =
        await stub.fetch(
          "https://collector/internal/refresh"
        );

      const data =
        await response.json();

      return json({
        ok: true,
        ...data
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Collector refresh error"
        },
        500
      );
    }
  }


  if (
    url.pathname ===
    "/api/history"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    const fromParam =
      Number(
        url.searchParams.get(
          "from"
        ) || 0
      );

    const toParam =
      Number(
        url.searchParams.get(
          "to"
        ) || Date.now()
      );

    try {
      const stub =
        collectorStub(env);

      const target =
        new URL(
          "https://collector/internal/history"
        );

      target.searchParams.set(
        "symbol",
        symbol
      );

      if (
        Number.isFinite(
          fromParam
        ) &&
        fromParam > 0
      ) {
        target.searchParams.set(
          "from",
          String(fromParam)
        );
      }

      if (
        Number.isFinite(
          toParam
        )
      ) {
        target.searchParams.set(
          "to",
          String(toParam)
        );
      }

      const response =
        await stub.fetch(
          target.toString()
        );

      const data =
        await response.json();

      return json(data);
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "History error"
        },
        500
      );
    }
  }


  if (
    url.pathname ===
    "/api/history/footprint"
  ) {
    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        )
      );

    const minute =
      Number(
        url.searchParams.get(
          "time"
        ) || 0
      );

    try {
      const stub =
        collectorStub(env);

      const target =
        new URL(
          "https://collector/internal/history/footprint"
        );

      target.searchParams.set(
        "symbol",
        symbol
      );

      if (
        Number.isFinite(
          minute
        ) &&
        minute > 0
      ) {
        target.searchParams.set(
          "time",
          String(minute)
        );
      }

      const response =
        await stub.fetch(
          target.toString()
        );

      const data =
        await response.json();

      return json(data);
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "History footprint error"
        },
        500
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

          version:
            VERSION
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
      const [
        tradesResult,
        instrumentResult
      ] = await Promise.all([
        bybit(
          "/v5/market/recent-trade",
          {
            category:
              "linear",
            symbol,
            limit:
              TRADE_LIMIT
          }
        ),

        bybit(
          "/v5/market/instruments-info",
          {
            category:
              "linear",
            symbol
          }
        )
      ]);

      const trades =
        parseTrades(
          tradesResult.result?.list
        );

      const tickSize =
        instrumentResult.result
          ?.list?.[0]
          ?.priceFilter
          ?.tickSize ||
        "0";

      return json({
        ok: true,

        symbol,

        category:
          "linear",

        tickSize,

        trades,

        stats:
          tradeStats(
            trades
          ),

        footprint:
          aggregateFootprint(
            trades,
            tickSize
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
            category:
              "linear",
            symbol,
            limit:
              ORDERBOOK_LIMIT
          }
        );

      return json({
        ok: true,

        symbol,

        category:
          "linear",

        ...orderbookStats(
          result.result?.list ||
          {}
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
            category:
              "linear",
            symbol,
            interval,
            limit:
              KLINE_LIMIT
          }
        );

      return json({
        ok: true,

        symbol,

        category:
          "linear",

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

    version:
      VERSION,

    category:
      "linear"
  });
}


/* =========================================================
   DURABLE OBJECT
   HOUR BLOCK STORAGE
========================================================= */

export class TradeCollector {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];
    this.symbolMeta = new Map();

    this.subscribed = new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;

    this.wsStartedAt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.reconnectAttempt = 0;

    this.lastError = "";

    /*
      فقط Hour Blockهای فعال در RAM.
      SQLite داده‌های پایدار را نگه می‌دارد.
    */
    this.hourBlocks = new Map();

    this.dedupe = new Map();

    this.alarmScheduled = false;

    this.lastCheckpointAt = 0;

    this.checkpointRunning = false;

    this.boundaryCheckpointScheduled = false;

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks = false;
  }


  /* =======================================================
     DB
  ======================================================= */

  initDB() {
    const sql =
      this.state.storage.sql;

    /*
      یک رکورد = یک Symbol + یک Hour
    */
    sql.exec(`
      CREATE TABLE IF NOT EXISTS hour_blocks (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,

        PRIMARY KEY (
          symbol,
          hour_start
        )
      )
    `);

    sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hour_blocks_time
      ON hour_blocks (
        symbol,
        hour_start
      )
    `);

    /*
      جداول معماری قبلی دیگر استفاده نمی‌شوند.
      حذف آن‌ها باعث می‌شود نوشتن تک‌تک
      کندل/سطح/Trade دیگر انجام نشود.
    */
    try {
      sql.exec(`
        DROP TABLE IF EXISTS candles_1m
      `);
    } catch {}

    try {
      sql.exec(`
        DROP TABLE IF EXISTS trades_1m
      `);
    } catch {}

    try {
      sql.exec(`
        DROP TABLE IF EXISTS trade_ids
      `);
    } catch {}
  }


  /* =======================================================
     ALARM
  ======================================================= */

  async scheduleAlarm() {
    try {
      await this.state.storage.setAlarm(
        Date.now() +
        5 * 60 * 1000
      );

      this.alarmScheduled =
        true;
    } catch {
      this.alarmScheduled =
        false;
    }
  }


  /* =======================================================
     FETCH
  ======================================================= */

  async fetch(request) {
    this.initDB();

    if (
      !this.loadedRecentBlocks
    ) {
      this.loadRecentBlocks();

      this.loadedRecentBlocks =
        true;
    }

    const url =
      new URL(request.url);


    if (
      url.pathname ===
      "/internal/start"
    ) {
      await this.start();

      return new Response(
        JSON.stringify(
          this.statusObject()
        ),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }


    if (
      url.pathname ===
      "/internal/status"
    ) {
      return new Response(
        JSON.stringify(
          this.statusObject()
        ),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }


    if (
      url.pathname ===
      "/internal/refresh"
    ) {
      await this.refreshSymbols();

      if (
        !this.ws ||
        !this.connected
      ) {
        await this.connect();
      } else {
        await this.resubscribe();
      }

      return new Response(
        JSON.stringify(
          this.statusObject()
        ),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }


    if (
      url.pathname ===
      "/internal/history"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      const from =
        Number(
          url.searchParams.get(
            "from"
          ) ||
          Date.now() -
            HISTORY_MS
        );

      const to =
        Number(
          url.searchParams.get(
            "to"
          ) ||
          Date.now()
        );

      const rows =
        this.getHistory(
          symbol,
          from,
          to
        );

      return new Response(
        JSON.stringify({
          ok: true,

          symbol,

          from,

          to,

          count:
            rows.length,

          candles:
            rows
        }),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }


    if (
      url.pathname ===
      "/internal/history/footprint"
    ) {
      const symbol =
        normalizeSymbol(
          url.searchParams.get(
            "symbol"
          )
        );

      let minute =
        Number(
          url.searchParams.get(
            "time"
          ) || 0
        );

      if (
        minute <= 0
      ) {
        minute =
          minuteStartOf(
            Date.now()
          );
      }

      const result =
        this.getFootprint(
          symbol,
          minute
        );

      return new Response(
        JSON.stringify({
          ok: true,

          symbol,

          minute,

          ...result
        }),
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }


    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "Collector endpoint not found"
      }),
      {
        status: 404,
        headers: {
          "Content-Type":
            "application/json"
        }
      }
    );
  }


  /* =======================================================
     STATUS
  ======================================================= */

  statusObject() {
    return {
      version:
        VERSION,

      collector:
        "TradeCollector",

      connected:
        this.connected,

      started:
        this.started,

      symbols:
        this.symbols.length,

      subscribed:
        this.subscribed.size,

      lastMessageAt:
        this.lastMessageAt,

      lastTradeAt:
        this.lastTradeAt,

      wsStartedAt:
        this.wsStartedAt,

      reconnectAttempt:
        this.reconnectAttempt,

      lastError:
        this.lastError,

      storage:
        "Durable Object SQLite · Hour Blocks",

      storageModel:
        "1 row = 1 symbol + 1 hour",

      checkpoint:
        "15 minutes",

      history:
        "24h rolling",

      marketData:
        "Bybit",

      symbolSource:
        "LBank ∩ Bybit",

      hourBlocksInMemory:
        this.hourBlocks.size
    };
  }


  /* =======================================================
     START
  ======================================================= */

  async start() {
    this.started =
      true;

    this.initDB();

    if (
      !this.loadedRecentBlocks
    ) {
      this.loadRecentBlocks();

      this.loadedRecentBlocks =
        true;
    }

    await this.refreshSymbols();

    if (
      !this.ws ||
      !this.connected
    ) {
      await this.connect();
    }

    const now =
      Date.now();

    if (
      now -
      this.lastCleanupAt >=
      CLEANUP_INTERVAL_MS
    ) {
      this.cleanup();

      this.lastCleanupAt =
        now;
    }

    await this.scheduleAlarm();

    return this.statusObject();
  }


  /* =======================================================
     SYMBOL REFRESH
  ======================================================= */

  async refreshSymbols() {
    const result =
      await getCollectorSymbols();

    this.symbols =
      result.symbols.map(
        x => x.symbol
      );

    this.symbolMeta.clear();

    for (const item of result.symbols) {
      this.symbolMeta.set(
        item.symbol,
        item
      );
    }

    return result;
  }


  /* =======================================================
     WEBSOCKET CONNECT
  ======================================================= */

  async connect() {
    if (
      this.ws &&
      this.connected
    ) {
      return;
    }

    if (
      !this.symbols.length
    ) {
      await this.refreshSymbols();
    }

    if (
      !this.symbols.length
    ) {
      throw new Error(
        "هیچ Symbol معتبری برای Collector پیدا نشد"
      );
    }

    this.closeSocket();

    const ws =
      new WebSocket(
        BYBIT_WS
      );

    this.ws =
      ws;

    this.connected =
      false;

    this.wsStartedAt =
      Date.now();

    this.subscribed.clear();

    ws.addEventListener(
      "open",
      () => {
        this.connected =
          true;

        this.lastError =
          "";

        this.reconnectAttempt =
          0;

        this.subscribeAll();

        this.startPing();

        this.scheduleAlarm();
      }
    );

    ws.addEventListener(
      "message",
      event => {
        this.handleMessage(
          event.data
        );
      }
    );

    ws.addEventListener(
      "close",
      () => {
        this.connected =
          false;

        this.stopPing();

        this.scheduleReconnect();
      }
    );

    ws.addEventListener(
      "error",
      () => {
        this.lastError =
          "Bybit WebSocket error";

        this.connected =
          false;

        try {
          ws.close();
        } catch {}
      }
    );
  }


  /* =======================================================
     CLOSE
  ======================================================= */

  closeSocket() {
    this.stopPing();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    this.ws =
      null;

    this.connected =
      false;

    this.subscribed.clear();
  }


  /* =======================================================
     PING
  ======================================================= */

  startPing() {
    this.stopPing();

    this.pingTimer =
      setInterval(
        () => {
          if (
            this.ws &&
            this.connected
          ) {
            try {
              this.ws.send(
                JSON.stringify({
                  op:
                    "ping"
                })
              );
            } catch {}
          }
        },
        20000
      );
  }


  stopPing() {
    if (
      this.pingTimer
    ) {
      clearInterval(
        this.pingTimer
      );

      this.pingTimer =
        null;
    }
  }


  /* =======================================================
     RECONNECT
  ======================================================= */

  scheduleReconnect() {
    if (
      this.reconnectTimer
    ) {
      return;
    }

    const delay =
      Math.min(
        30000,
        Math.max(
          1000,
          1000 *
            Math.pow(
              2,
              this.reconnectAttempt
            )
        )
      );

    this.reconnectAttempt++;

    this.reconnectTimer =
      setTimeout(
        async () => {
          this.reconnectTimer =
            null;

          try {
            await this.refreshSymbols();

            await this.connect();
          } catch (error) {
            this.lastError =
              error?.message ||
              "Reconnect error";

            this.scheduleReconnect();
          }
        },
        delay
      );
  }


  /* =======================================================
     SUBSCRIBE
  ======================================================= */

  subscribeAll() {
    if (
      !this.ws ||
      !this.connected ||
      !this.symbols.length
    ) {
      return;
    }

    const topics =
      this.symbols.map(
        symbol =>
          `publicTrade.${symbol}`
      );

    const chunks = [];

    let current = [];
    let length = 0;

    for (const topic of topics) {
      const extra =
        topic.length + 3;

      if (
        current.length > 0 &&
        length + extra >
          18000
      ) {
        chunks.push(
          current
        );

        current = [];
        length = 0;
      }

      current.push(topic);

      length += extra;
    }

    if (
      current.length
    ) {
      chunks.push(
        current
      );
    }

    for (const args of chunks) {
      try {
        this.ws.send(
          JSON.stringify({
            op:
              "subscribe",
            args
          })
        );

        for (const topic of args) {
          const symbol =
            topic.replace(
              "publicTrade.",
              ""
            );

          this.subscribed.add(
            symbol
          );
        }
      } catch (error) {
        this.lastError =
          error?.message ||
          "Subscribe error";
      }
    }
  }


  async resubscribe() {
    if (
      !this.ws ||
      !this.connected
    ) {
      return;
    }

    this.subscribed.clear();

    this.subscribeAll();
  }


  /* =======================================================
     WS MESSAGE
========================================================= */

  handleMessage(raw) {
    this.lastMessageAt =
      Date.now();

    let data;

    try {
      data =
        typeof raw ===
        "string"
          ? JSON.parse(raw)
          : raw;
    } catch {
      return;
    }

    if (
      data?.op ===
        "pong" ||
      data?.op ===
        "ping"
    ) {
      return;
    }

    const topic =
      String(
        data?.topic ||
        ""
      );

    if (
      !topic.startsWith(
        "publicTrade."
      )
    ) {
      return;
    }

    const symbol =
      topic.replace(
        "publicTrade.",
        ""
      );

    const list =
      Array.isArray(
        data?.data
      )
        ? data.data
        : [];

    if (
      !list.length
    ) {
      return;
    }

    let newHourDetected =
      false;

    for (const rawTrade of list) {
      const trade =
        this.parseWsTrade(
          symbol,
          rawTrade
        );

      if (!trade) {
        continue;
      }

      if (
        this.isDuplicate(
          symbol,
          trade.id
        )
      ) {
        continue;
      }

      this.lastTradeAt =
        trade.time;

      const before =
        this.currentHourForSymbol(
          symbol
        );

      this.aggregateTrade(
        trade
      );

      const after =
        hourStartOf(
          trade.time
        );

      if (
        before !== null &&
        before !== after
      ) {
        newHourDetected =
          true;
      }
    }

    /*
      در عبور از ساعت،
      Hour Block قبلی را ذخیره می‌کنیم.
    */
    if (
      newHourDetected
    ) {
      this.scheduleClosedBlockCheckpoint();
    }
  }


  /* =======================================================
     WS TRADE PARSER
========================================================= */

  parseWsTrade(
    symbol,
    raw
  ) {
    const price =
      Number(
        raw.p ??
        raw.price
      );

    const size =
      Number(
        raw.v ??
        raw.size
      );

    const time =
      Number(
        raw.T ??
        raw.time ??
        Date.now()
      );

    const side =
      String(
        raw.S ??
        raw.side ??
        ""
      ).toLowerCase();

    const id =
      raw.i ??
      raw.execId ??
      raw.tradeId ??
      `${time}-${price}-${size}-${side}`;

    if (
      !Number.isFinite(
        price
      ) ||
      !Number.isFinite(
        size
      ) ||
      !Number.isFinite(
        time
      ) ||
      price <= 0 ||
      size <= 0
    ) {
      return null;
    }

    return {
      symbol,

      id:
        String(id),

      time,

      price,

      size,

      value:
        price * size,

      side:
        side === "buy"
          ? "buy"
          : "sell"
    };
  }


  /* =======================================================
     DEDUPE
========================================================= */

  isDuplicate(
    symbol,
    id
  ) {
    const key =
      `${symbol}:${id}`;

    if (
      this.dedupe.has(key)
    ) {
      return true;
    }

    this.dedupe.set(
      key,
      Date.now()
    );

    if (
      this.dedupe.size >
      50000
    ) {
      const cutoff =
        Date.now() -
        5 * 60 * 1000;

      for (
        const [
          k,
          t
        ] of this.dedupe
      ) {
        if (
          t < cutoff
        ) {
          this.dedupe.delete(
            k
          );
        }
      }

      if (
        this.dedupe.size >
        60000
      ) {
        const first =
          this.dedupe.keys()
            .next()
            .value;

        if (first) {
          this.dedupe.delete(
            first
          );
        }
      }
    }

    return false;
  }


  /* =======================================================
     MEMORY BLOCK HELPERS
========================================================= */

  currentHourForSymbol(
    symbol
  ) {
    let latest =
      null;

    for (
      const block of
      this.hourBlocks.values()
    ) {
      if (
        block.symbol ===
        symbol
      ) {
        if (
          latest === null ||
          block.hourStart >
            latest
        ) {
          latest =
            block.hourStart;
        }
      }
    }

    return latest;
  }


  createBlock(
    symbol,
    hourStart
  ) {
    return {
      symbol,

      hourStart,

      hourEnd:
        hourStart +
        HOUR_MS,

      candles:
        new Map(),

      dirty:
        true,

      loaded:
        false
    };
  }


  getOrCreateBlock(
    symbol,
    hourStart
  ) {
    const key =
      `${symbol}:${hourStart}`;

    let block =
      this.hourBlocks.get(
        key
      );

    if (!block) {
      block =
        this.createBlock(
          symbol,
          hourStart
        );

      this.hourBlocks.set(
        key,
        block
      );
    }

    return block;
  }


  /* =======================================================
     AGGREGATE IN MEMORY
========================================================= */

  aggregateTrade(
    trade
  ) {
    const minute =
      minuteStartOf(
        trade.time
      );

    const hourStart =
      hourStartOf(
        trade.time
      );

    const block =
      this.getOrCreateBlock(
        trade.symbol,
        hourStart
      );

    let candle =
      block.candles.get(
        minute
      );

    if (!candle) {
      candle = {
        minute,

        open:
          trade.price,

        high:
          trade.price,

        low:
          trade.price,

        close:
          trade.price,

        volume:
          trade.size,

        turnover:
          trade.value,

        buyVolume:
          trade.side ===
          "buy"
            ? trade.size
            : 0,

        sellVolume:
          trade.side ===
          "sell"
            ? trade.size
            : 0,

        buyValue:
          trade.side ===
          "buy"
            ? trade.value
            : 0,

        sellValue:
          trade.side ===
          "sell"
            ? trade.value
            : 0,

        buyTrades:
          trade.side ===
          "buy"
            ? 1
            : 0,

        sellTrades:
          trade.side ===
          "sell"
            ? 1
            : 0,

        openTime:
          trade.time,

        closeTime:
          trade.time,

        levels:
          new Map()
      };

      block.candles.set(
        minute,
        candle
      );
    } else {
      if (
        trade.time <
        candle.openTime
      ) {
        candle.openTime =
          trade.time;

        candle.open =
          trade.price;
      }

      if (
        trade.time >=
        candle.closeTime
      ) {
        candle.closeTime =
          trade.time;

        candle.close =
          trade.price;
      }

      candle.high =
        Math.max(
          candle.high,
          trade.price
        );

      candle.low =
        Math.min(
          candle.low,
          trade.price
        );

      candle.volume +=
        trade.size;

      candle.turnover +=
        trade.value;

      if (
        trade.side ===
        "buy"
      ) {
        candle.buyVolume +=
          trade.size;

        candle.buyValue +=
          trade.value;

        candle.buyTrades++;
      } else {
        candle.sellVolume +=
          trade.size;

        candle.sellValue +=
          trade.value;

        candle.sellTrades++;
      }
    }

    const meta =
      this.symbolMeta.get(
        trade.symbol
      );

    const tickSize =
      Number(
        meta?.tickSize ||
        0
      );

    let levelPrice =
      trade.price;

    if (
      tickSize > 0
    ) {
      levelPrice =
        roundToTick(
          trade.price,
          tickSize
        );
    }

    const decimals =
      decimalsFromTick(
        tickSize
      );

    const levelKey =
      levelPrice.toFixed(
        decimals
      );

    let level =
      candle.levels.get(
        levelKey
      );

    if (!level) {
      level = {
        price:
          levelPrice,

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        buyTrades: 0,
        sellTrades: 0
      };

      candle.levels.set(
        levelKey,
        level
      );
    }

    if (
      trade.side ===
      "buy"
    ) {
      level.buyVolume +=
        trade.size;

      level.buyValue +=
        trade.value;

      level.buyTrades++;
    } else {
      level.sellVolume +=
        trade.size;

      level.sellValue +=
        trade.value;

      level.sellTrades++;
    }

    block.dirty =
      true;
  }


  /* =======================================================
     SERIALIZE HOUR BLOCK
========================================================= */

  serializeBlock(
    block
  ) {
    const candles =
      [...block.candles.values()]
        .sort(
          (a, b) =>
            a.minute -
            b.minute
        )
        .map(candle => ({
          m:
            candle.minute,

          o:
            candle.open,

          h:
            candle.high,

          l:
            candle.low,

          c:
            candle.close,

          v:
            candle.volume,

          t:
            candle.turnover,

          b:
            candle.buyVolume,

          s:
            candle.sellVolume,

          bv:
            candle.buyValue,

          sv:
            candle.sellValue,

          bt:
            candle.buyTrades,

          st:
            candle.sellTrades,

          ot:
            candle.openTime,

          ct:
            candle.closeTime,

          lvs:
            [...candle.levels.values()]
              .sort(
                (a, b) =>
                  b.price -
                  a.price
              )
              .map(level => [
                level.price,
                level.buyVolume,
                level.sellVolume,
                level.buyValue,
                level.sellValue,
                level.buyTrades,
                level.sellTrades
              ])
        }));

    return JSON.stringify(
      {
        v: 1,

        s:
          block.symbol,

        h:
          block.hourStart,

        c:
          candles
      }
    );
  }


  /* =======================================================
     DESERIALIZE HOUR BLOCK
========================================================= */

  deserializeBlock(
    row
  ) {
    let parsed;

    try {
      parsed =
        typeof row.data ===
        "string"
          ? JSON.parse(
              row.data
            )
          : row.data;
    } catch {
      return null;
    }

    if (
      !parsed ||
      !Array.isArray(
        parsed.c
      )
    ) {
      return null;
    }

    const symbol =
      normalizeSymbol(
        parsed.s ||
        row.symbol
      );

    const hourStart =
      Number(
        parsed.h ??
        row.hour_start
      );

    if (
      !Number.isFinite(
        hourStart
      )
    ) {
      return null;
    }

    const block =
      this.createBlock(
        symbol,
        hourStart
      );

    block.dirty =
      false;

    block.loaded =
      true;

    for (const c of parsed.c) {
      const minute =
        Number(c.m);

      if (
        !Number.isFinite(
          minute
        )
      ) {
        continue;
      }

      const candle = {
        minute,

        open:
          Number(c.o),

        high:
          Number(c.h),

        low:
          Number(c.l),

        close:
          Number(c.c),

        volume:
          Number(c.v || 0),

        turnover:
          Number(c.t || 0),

        buyVolume:
          Number(c.b || 0),

        sellVolume:
          Number(c.s || 0),

        buyValue:
          Number(c.bv || 0),

        sellValue:
          Number(c.sv || 0),

        buyTrades:
          Number(c.bt || 0),

        sellTrades:
          Number(c.st || 0),

        openTime:
          Number(c.ot || minute),

        closeTime:
          Number(c.ct || minute),

        levels:
          new Map()
      };

      const levels =
        Array.isArray(
          c.lvs
        )
          ? c.lvs
          : [];

      for (const item of levels) {
        if (
          !Array.isArray(item) ||
          item.length < 7
        ) {
          continue;
        }

        const price =
          Number(item[0]);

        if (
          !Number.isFinite(
            price
          )
        ) {
          continue;
        }

        const decimals =
          decimalsFromTick(
            this.symbolMeta.get(
              symbol
            )?.tickSize ||
            0
          );

        const key =
          price.toFixed(
            decimals
          );

        candle.levels.set(
          key,
          {
            price,

            buyVolume:
              Number(
                item[1] || 0
              ),

            sellVolume:
              Number(
                item[2] || 0
              ),

            buyValue:
              Number(
                item[3] || 0
              ),

            sellValue:
              Number(
                item[4] || 0
              ),

            buyTrades:
              Number(
                item[5] || 0
              ),

            sellTrades:
              Number(
                item[6] || 0
              )
          }
        );
      }

      block.candles.set(
        minute,
        candle
      );
    }

    return block;
  }


  /* =======================================================
     LOAD RECENT BLOCKS
========================================================= */

  loadRecentBlocks() {
    const now =
      Date.now();

    const currentHour =
      hourStartOf(
        now
      );

    const from =
      currentHour -
      HOUR_MS;

    try {
      const rows =
        this.state.storage.sql.exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at

          FROM hour_blocks

          WHERE
            hour_start >= ?
            AND hour_start <= ?

          ORDER BY
            hour_start ASC
          `,
          from,
          currentHour
        ).toArray();

      for (const row of rows) {
        const block =
          this.deserializeBlock(
            row
          );

        if (!block) {
          continue;
        }

        const key =
          `${block.symbol}:${block.hourStart}`;

        this.hourBlocks.set(
          key,
          block
        );
      }
    } catch (error) {
      this.lastError =
        error?.message ||
        "Load hour blocks error";
    }
  }


  /* =======================================================
     CHECKPOINT
========================================================= */

  checkpointBlocks(
    force = false
  ) {
    if (
      this.checkpointRunning
    ) {
      return;
    }

    this.checkpointRunning =
      true;

    try {
      const now =
        Date.now();

      const currentHour =
        hourStartOf(
          now
        );

      const sql =
        this.state.storage.sql;

      for (
        const [
          key,
          block
        ] of this.hourBlocks
      ) {
        const closed =
          block.hourStart <
          currentHour;

        if (
          !force &&
          !block.dirty &&
          !closed
        ) {
          continue;
        }

        if (
          !block.candles.size
        ) {
          continue;
        }

        const data =
          this.serializeBlock(
            block
          );

        sql.exec(
          `
          INSERT INTO hour_blocks (
            symbol,
            hour_start,
            data,
            updated_at
          )
          VALUES (?, ?, ?, ?)

          ON CONFLICT (
            symbol,
            hour_start
          )

          DO UPDATE SET

            data =
              excluded.data,

            updated_at =
              excluded.updated_at
          `,
          block.symbol,
          block.hourStart,
          data,
          now
        );

        block.dirty =
          false;
      }

      this.lastCheckpointAt =
        now;

      /*
        فقط ساعت جاری و در صورت نیاز
        ساعت قبلی در RAM باقی می‌ماند.
      */
      for (
        const [
          key,
          block
        ] of this.hourBlocks
      ) {
        if (
          block.hourStart <
          currentHour -
          HOUR_MS
        ) {
          this.hourBlocks.delete(
            key
          );
        }
      }
    } catch (error) {
      this.lastError =
        error?.message ||
        "Hour block checkpoint error";
    } finally {
      this.checkpointRunning =
        false;
    }
  }


  /* =======================================================
     CLOSED BLOCK CHECKPOINT
========================================================= */

  scheduleClosedBlockCheckpoint() {
    if (
      this.boundaryCheckpointScheduled
    ) {
      return;
    }

    this.boundaryCheckpointScheduled =
      true;

    queueMicrotask(
      () => {
        try {
          this.checkpointBlocks(
            false
          );
        } catch (error) {
          this.lastError =
            error?.message ||
            "Boundary checkpoint error";
        } finally {
          this.boundaryCheckpointScheduled =
            false;
        }
      }
    );
  }


  /* =======================================================
     GET HISTORY FROM MEMORY + SQLITE
========================================================= */

  getHistory(
    symbol,
    from,
    to
  ) {
    const fromHour =
      hourStartOf(
        from
      );

    const toHour =
      hourStartOf(
        to
      );

    const blocks =
      new Map();

    try {
      const rows =
        this.state.storage.sql.exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at

          FROM hour_blocks

          WHERE
            symbol = ?
            AND hour_start >= ?
            AND hour_start <= ?

          ORDER BY
            hour_start ASC
          `,
          symbol,
          fromHour,
          toHour
        ).toArray();

      for (const row of rows) {
        const block =
          this.deserializeBlock(
            row
          );

        if (!block) {
          continue;
        }

        blocks.set(
          block.hourStart,
          block
        );
      }
    } catch (error) {
      this.lastError =
        error?.message ||
        "History block read error";
    }

    /*
      RAM نسخه جدیدتر را روی SQLite می‌گذارد.
    */
    for (
      const block of
      this.hourBlocks.values()
    ) {
      if (
        block.symbol !==
        symbol
      ) {
        continue;
      }

      if (
        block.hourStart <
        fromHour ||
        block.hourStart >
        toHour
      ) {
        continue;
      }

      blocks.set(
        block.hourStart,
        block
      );
    }

    const candles =
      [];

    for (
      const block of
      [...blocks.values()]
        .sort(
          (a, b) =>
            a.hourStart -
            b.hourStart
        )
    ) {
      for (
        const candle of
        block.candles.values()
      ) {
        if (
          candle.minute <
          from ||
          candle.minute >
          to
        ) {
          continue;
        }

        candles.push({
          time:
            Number(
              candle.minute
            ),

          open:
            Number(
              candle.open
            ),

          high:
            Number(
              candle.high
            ),

          low:
            Number(
              candle.low
            ),

          close:
            Number(
              candle.close
            ),

          volume:
            Number(
              candle.volume
            ),

          turnover:
            Number(
              candle.turnover
            ),

          buyVolume:
            Number(
              candle.buyVolume
            ),

          sellVolume:
            Number(
              candle.sellVolume
            ),

          buyValue:
            Number(
              candle.buyValue
            ),

          sellValue:
            Number(
              candle.sellValue
            ),

          buyTrades:
            Number(
              candle.buyTrades
            ),

          sellTrades:
            Number(
              candle.sellTrades
            ),

          delta:
            Number(
              candle.buyVolume
            ) -
            Number(
              candle.sellVolume
            ),

          deltaValue:
            Number(
              candle.buyValue
            ) -
            Number(
              candle.sellValue
            ),

          trades:
            Number(
              candle.buyTrades
            ) +
            Number(
              candle.sellTrades
            )
        });
      }
    }

    candles.sort(
      (a, b) =>
        a.time -
        b.time
    );

    return candles;
  }


  /* =======================================================
     FOOTPRINT HISTORY
========================================================= */

  getFootprint(
    symbol,
    minute
  ) {
    const hourStart =
      hourStartOf(
        minute
      );

    let block =
      null;

    /*
      اول RAM
    */
    for (
      const item of
      this.hourBlocks.values()
    ) {
      if (
        item.symbol ===
        symbol &&
        item.hourStart ===
        hourStart
      ) {
        block =
          item;

        break;
      }
    }

    /*
      سپس SQLite
    */
    if (!block) {
      try {
        const rows =
          this.state.storage.sql.exec(
            `
            SELECT
              symbol,
              hour_start,
              data,
              updated_at

            FROM hour_blocks

            WHERE
              symbol = ?
              AND hour_start = ?

            LIMIT 1
            `,
            symbol,
            hourStart
          ).toArray();

        if (rows.length) {
          block =
            this.deserializeBlock(
              rows[0]
            );
        }
      } catch (error) {
        this.lastError =
          error?.message ||
          "Footprint block read error";
      }
    }

    if (!block) {
      return {
        candle: null,

        stats: {
          trades: 0,

          buyVolume: 0,
          sellVolume: 0,

          buyValue: 0,
          sellValue: 0,

          totalVolume: 0,
          totalValue: 0,

          delta: 0,
          deltaValue: 0,
          deltaPercent: 0,

          buyTrades: 0,
          sellTrades: 0
        },

        footprint: []
      };
    }

    const candle =
      block.candles.get(
        minute
      );

    if (!candle) {
      return {
        candle: null,

        stats: {
          trades: 0,

          buyVolume: 0,
          sellVolume: 0,

          buyValue: 0,
          sellValue: 0,

          totalVolume: 0,
          totalValue: 0,

          delta: 0,
          deltaValue: 0,
          deltaPercent: 0,

          buyTrades: 0,
          sellTrades: 0
        },

        footprint: []
      };
    }

    const footprint =
      [...candle.levels.values()]
        .map(level => ({
          price:
            Number(
              level.price
            ),

          buyVolume:
            Number(
              level.buyVolume
            ),

          sellVolume:
            Number(
              level.sellVolume
            ),

          buyValue:
            Number(
              level.buyValue
            ),

          sellValue:
            Number(
              level.sellValue
            ),

          buyTrades:
            Number(
              level.buyTrades
            ),

          sellTrades:
            Number(
              level.sellTrades
            ),

          delta:
            Number(
              level.buyVolume
            ) -
            Number(
              level.sellVolume
            ),

          deltaValue:
            Number(
              level.buyValue
            ) -
            Number(
              level.sellValue
            ),

          totalVolume:
            Number(
              level.buyVolume
            ) +
            Number(
              level.sellVolume
            ),

          imbalance:
            Number(
              level.sellVolume
            ) > 0
              ? Number(
                  level.buyVolume
                ) /
                Number(
                  level.sellVolume
                )
              : Number(
                  level.buyVolume
                ) > 0
                  ? 999
                  : 0
        }))
        .sort(
          (a, b) =>
            b.price -
            a.price
        );

    const buyVolume =
      Number(
        candle.buyVolume
      );

    const sellVolume =
      Number(
        candle.sellVolume
      );

    const buyValue =
      Number(
        candle.buyValue
      );

    const sellValue =
      Number(
        candle.sellValue
      );

    const totalVolume =
      buyVolume +
      sellVolume;

    const totalValue =
      buyValue +
      sellValue;

    const stats = {
      trades:
        Number(
          candle.buyTrades
        ) +
        Number(
          candle.sellTrades
        ),

      buyVolume,

      sellVolume,

      buyValue,

      sellValue,

      totalVolume,

      totalValue,

      delta:
        buyVolume -
        sellVolume,

      deltaValue:
        buyValue -
        sellValue,

      deltaPercent:
        totalVolume > 0
          ? (
              buyVolume -
              sellVolume
            ) /
            totalVolume *
            100
          : 0,

      buyTrades:
        Number(
          candle.buyTrades
        ),

      sellTrades:
        Number(
          candle.sellTrades
        )
    };

    return {
      candle: {
        time:
          Number(
            candle.minute
          ),

        open:
          Number(
            candle.open
          ),

        high:
          Number(
            candle.high
          ),

        low:
          Number(
            candle.low
          ),

        close:
          Number(
            candle.close
          ),

        volume:
          Number(
            candle.volume
          ),

        turnover:
          Number(
            candle.turnover
          )
      },

      stats,

      footprint
    };
  }


  /* =======================================================
     CLEANUP
========================================================= */

  cleanup() {
    const cutoff =
      Date.now() -
      HISTORY_MS;

    /*
      چون ذخیره‌سازی ساعتی است،
      کل Blockهای تمام‌شده قدیمی حذف می‌شوند.
    */
    const cutoffHour =
      hourStartOf(
        cutoff
      );

    try {
      this.state.storage.sql.exec(
        `
        DELETE FROM hour_blocks
        WHERE hour_start < ?
        `,
        cutoffHour
      );

      this.lastCleanupAt =
        Date.now();
    } catch (error) {
      this.lastError =
        error?.message ||
        "Hour block cleanup error";
    }

    /*
      RAM قدیمی هم حذف شود.
    */
    for (
      const [
        key,
        block
      ] of this.hourBlocks
    ) {
      if (
        block.hourStart <
        cutoffHour
      ) {
        this.hourBlocks.delete(
          key
        );
      }
    }
  }


  /* =======================================================
     ALARM
========================================================= */

  async alarm() {
    this.initDB();

    try {
      if (
        !this.loadedRecentBlocks
      ) {
        this.loadRecentBlocks();

        this.loadedRecentBlocks =
          true;
      }

      const now =
        Date.now();

      /*
        Checkpoint فقط هر 15 دقیقه.
        بنابراین به‌جای نوشتن هر Trade،
        فقط Blockهای تغییرکرده ذخیره می‌شوند.
      */
      if (
        now -
        this.lastCheckpointAt >=
        CHECKPOINT_INTERVAL_MS
      ) {
        this.checkpointBlocks(
          false
        );
      }

      if (
        now -
        this.lastCleanupAt >=
        CLEANUP_INTERVAL_MS
      ) {
        this.cleanup();
      }

      await this.refreshSymbols();

      if (
        !this.ws ||
        !this.connected
      ) {
        await this.connect();
      } else {
        await this.resubscribe();
      }
    } catch (error) {
      this.lastError =
        error?.message ||
        "Alarm error";

      this.scheduleReconnect();
    }

    await this.scheduleAlarm();
  }
}


/* =========================================================
   SCHEDULED
========================================================= */

async function scheduled(
  event,
  env,
  ctx
) {
  ctx.waitUntil(
    (async () => {
      try {
        await startCollector(
          env
        );
      } catch (error) {
        console.error(
          "Scheduled collector error:",
          error
        );
      }
    })()
  );
}


/* =========================================================
   DEFAULT WORKER
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
      return route(
        request,
        env
      );
    }

    if (
      env.ASSETS
    ) {
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

    return route(
      request,
      env
    );
  },

  scheduled
};
