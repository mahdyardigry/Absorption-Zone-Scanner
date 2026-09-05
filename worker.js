const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ZONE-SCANNER-V2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-allow-headers": "*",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function categoryName(category) {
  return category === "spot" ? "Spot" : "Futures";
}

function normalizeCategory(v) {
  return String(v || "linear").toLowerCase() === "spot"
    ? "spot"
    : "linear";
}

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u.toString(), {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  const text = await r.text();

  if (!text || !text.trim()) {
    throw new Error(`Bybit پاسخ خالی داد (${r.status})`);
  }

  let d;

  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ Bybit JSON معتبر نیست (${r.status}): ${text.slice(0, 180)}`
    );
  }

  if (!r.ok) {
    throw new Error(
      d?.retMsg || `خطای HTTP از Bybit: ${r.status}`
    );
  }

  if (num(d?.retCode, 0) !== 0) {
    throw new Error(
      d?.retMsg || `خطای Bybit: ${d?.retCode}`
    );
  }

  return d;
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category) {
  const result = [];
  let cursor = "";

  for (let i = 0; i < 10; i++) {
    const d = await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000,
        ...(cursor ? { cursor } : {})
      }
    );

    const list = d?.result?.list || [];
    result.push(...list);

    cursor = d?.result?.nextPageCursor || "";

    if (!cursor || !list.length) break;
  }

  return result;
}

function validSymbols(list, category) {
  if (category === "linear") {
    return list.filter(
      x =>
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType === "LinearPerpetual"
    );
  }

  return list.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT"
  );
}

async function findSymbol(input, category) {
  const raw = String(input || "")
    .trim()
    .toUpperCase();

  if (!raw) {
    throw new Error("نماد وارد نشده است.");
  }

  const bare = raw
    .replace(/[-_/:\s]/g, "")
    .replace(/USDT$/, "");

  const list = validSymbols(
    await instruments(category),
    category
  );

  const exact =
    list.find(
      x =>
        String(x.symbol).toUpperCase() === raw
    ) ||
    list.find(
      x =>
        String(x.symbol).toUpperCase() ===
        bare + "USDT"
    );

  if (!exact) {
    throw new Error(
      `${categoryName(category)} برای ${raw} در Bybit پیدا نشد.`
    );
  }

  return exact;
}

/* =========================================================
   KLINES
========================================================= */

const TF_SECONDS = {
  "1": 60,
  "3": 180,
  "5": 300,
  "15": 900,
  "30": 1800,
  "60": 3600
};

async function klines(category, symbol, interval, limit = 500) {
  const d = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit: Math.min(1000, Math.max(1, limit))
    }
  );

  return (d?.result?.list || [])
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }))
    .filter(x => x.time > 0)
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   TRADES
========================================================= */

async function trades(category, symbol, limit = 1000) {
  const d = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: Math.min(1000, Math.max(1, limit))
    }
  );

  return (d?.result?.list || [])
    .map(x => ({
      id: String(x.execId || x.id || ""),
      time: num(x.time),
      price: num(x.price),
      size: num(x.size),
      side: String(x.side || "").toLowerCase(),
      isBlockTrade: Boolean(x.isBlockTrade)
    }))
    .filter(
      x =>
        x.time > 0 &&
        x.price > 0 &&
        x.size > 0
    )
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function orderbook(category, symbol, limit = 50) {
  const d = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit: Math.min(200, Math.max(1, limit))
    }
  );

  const r = d?.result || {};

  const bids = (r.b || []).map(x => ({
    price: num(x[0]),
    size: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  const asks = (r.a || []).map(x => ({
    price: num(x[0]),
    size: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  return {
    bids,
    asks,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0
  };
}

/* =========================================================
   TICKER
========================================================= */

async function ticker(category, symbol) {
  const d = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  const x = d?.result?.list?.[0] || {};

  return {
    price: num(x.lastPrice),
    markPrice: num(x.markPrice),
    indexPrice: num(x.indexPrice),
    high24: num(x.highPrice24h),
    low24: num(x.lowPrice24h),
    volume24: num(x.volume24h),
    turnover24: num(x.turnover24h),
    change24: num(x.price24hPcnt) * 100,
    openInterest: num(x.openInterest),
    fundingRate: num(x.fundingRate) * 100
  };
}

/* =========================================================
   FLOW
========================================================= */

function calculateFlow(list) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largeBuy = 0;
  let largeSell = 0;

  let largestTrade = 0;

  const values = list
    .map(x => x.price * x.size)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const median =
    values.length
      ? values[Math.floor(values.length / 2)]
      : 0;

  const largeThreshold =
    median > 0 ? median * 5 : Infinity;

  for (const x of list) {
    const value = x.price * x.size;

    largestTrade = Math.max(
      largestTrade,
      value
    );

    if (x.side === "buy") {
      buyVolume += x.size;
      buyValue += value;
      buyTrades++;

      if (value >= largeThreshold) {
        largeBuy += value;
      }
    } else if (x.side === "sell") {
      sellVolume += x.size;
      sellValue += value;
      sellTrades++;

      if (value >= largeThreshold) {
        largeSell += value;
      }
    }
  }

  const total =
    buyValue + sellValue;

  const delta =
    buyValue - sellValue;

  const deltaPercent =
    total
      ? delta / total * 100
      : 0;

  return {
    buyVolume,
    sellVolume,
    buyValue,
    sellValue,

    delta,
    deltaPercent,

    buyShare:
      total ? buyValue / total * 100 : 50,

    sellShare:
      total ? sellValue / total * 100 : 50,

    buyTrades,
    sellTrades,
    tradeCount:
      buyTrades + sellTrades,

    largeBuy,
    largeSell,

    largestTrade,

    pressure:
      deltaPercent >= 10
        ? "BUY_PRESSURE"
        : deltaPercent <= -10
          ? "SELL_PRESSURE"
          : "BALANCED"
  };
}

/* =========================================================
   ORDER BOOK ANALYSIS
========================================================= */

function analyzeBook(book, price) {
  const bidTotal =
    book.bids.reduce(
      (s, x) => s + x.value,
      0
    );

  const askTotal =
    book.asks.reduce(
      (s, x) => s + x.value,
      0
    );

  const total =
    bidTotal + askTotal;

  const all =
    [...book.bids, ...book.asks]
      .map(x => x.value)
      .sort((a, b) => a - b);

  const median =
    all.length
      ? all[Math.floor(all.length / 2)]
      : 0;

  const wallThreshold =
    Math.max(
      median * 4,
      price * price * 0.000001
    );

  const buyWalls =
    book.bids
      .filter(x => x.value >= wallThreshold)
      .sort((a, b) => b.value - a.value);

  const sellWalls =
    book.asks
      .filter(x => x.value >= wallThreshold)
      .sort((a, b) => b.value - a.value);

  const buyShare =
    total ? bidTotal / total * 100 : 50;

  const sellShare =
    total ? askTotal / total * 100 : 50;

  return {
    buyLiquidity: bidTotal,
    sellLiquidity: askTotal,
    totalLiquidity: total,

    buyShare,
    sellShare,

    imbalance:
      buyShare - sellShare,

    pressure:
      buyShare > sellShare + 8
        ? "BUY_PRESSURE"
        : sellShare > buyShare + 8
          ? "SELL_PRESSURE"
          : "BALANCED",

    buyWalls,
    sellWalls,

    strongestBuyWall:
      buyWalls[0] || null,

    strongestSellWall:
      sellWalls[0] || null
  };
}

/* =========================================================
   FOOTPRINT
========================================================= */

function buildFootprint(candle, tradeList, tickSize = 0) {
  const tradesInCandle =
    tradeList.filter(
      t =>
        t.time >= candle.time &&
        t.time < candle.time + candle.duration
    );

  const levels = new Map();

  let buy = 0;
  let sell = 0;

  let buyValue = 0;
  let sellValue = 0;

  for (const t of tradesInCandle) {
    let price = t.price;

    if (tickSize > 0) {
      price =
        Math.round(price / tickSize) *
        tickSize;
    }

    const key = String(price);

    if (!levels.has(key)) {
      levels.set(key, {
        price,
        bid: 0,
        ask: 0,
        delta: 0,
        volume: 0,
        trades: 0
      });
    }

    const row = levels.get(key);
    const value = t.price * t.size;

    row.volume += t.size;
    row.trades++;

    if (t.side === "buy") {
      row.ask += t.size;
      row.delta += t.size;

      buy += t.size;
      buyValue += value;
    }

    if (t.side === "sell") {
      row.bid += t.size;
      row.delta -= t.size;

      sell += t.size;
      sellValue += value;
    }
  }

  const rows =
    [...levels.values()]
      .sort((a, b) => b.price - a.price);

  const total =
    buyValue + sellValue;

  const delta =
    buyValue - sellValue;

  let poc = null;

  for (const r of rows) {
    if (!poc || r.volume > poc.volume) {
      poc = r;
    }
  }

  return {
    candle,
    rows,

    buyVolume: buy,
    sellVolume: sell,

    buyValue,
    sellValue,

    volume: buy + sell,
    value: total,

    delta,
    deltaPercent:
      total ? delta / total * 100 : 0,

    poc,

    tradeCount:
      tradesInCandle.length,

    source:
      "REAL_BYBIT_RECENT_TRADES",

    historical:
      false,

    note:
      tradesInCandle.length
        ? "بر اساس معاملات واقعی دریافت‌شده از Bybit."
        : "برای این کندل معامله‌ای در داده فعلی دریافت نشده است."
  };
}

/* =========================================================
   MARKET DATA
========================================================= */

async function marketData(
  category,
  symbol,
  interval
) {
  const tf =
    TF_SECONDS[interval] ||
    TF_SECONDS["1"];

  const [candleList, book, tick] =
    await Promise.all([
      klines(
        category,
        symbol,
        interval,
        300
      ),
      orderbook(
        category,
        symbol,
        50
      ),
      ticker(
        category,
        symbol
      )
    ]);

  return {
    ok: true,
    version: VERSION,
    category,
    symbol,
    interval,

    candles: candleList,

    orderbook: analyzeBook(
      book,
      tick.price
    ),

    rawOrderbook: book,

    ticker: tick,

    duration: tf * 1000,

    serverTime: Date.now()
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyze(
  category,
  symbol,
  interval
) {
  const data =
    await marketData(
      category,
      symbol,
      interval
    );

  const recentTrades =
    await trades(
      category,
      symbol,
      1000
    );

  const flow =
    calculateFlow(
      recentTrades
    );

  const last =
    data.candles[
      data.candles.length - 1
    ];

  const candleDuration =
    data.duration;

  let footprint = null;

  if (last) {
    footprint =
      buildFootprint(
        {
          ...last,
          duration:
            candleDuration
        },
        recentTrades
      );
  }

  return {
    ...data,

    trades: recentTrades,

    flow,

    footprint,

    price:
      data.ticker.price,

    generatedAt:
      Date.now()
  };
}

/* =========================================================
   DURABLE OBJECT
   این export برای Binding موجود CollectorDO ضروری است.
========================================================= */

export class CollectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "CollectorDO",
        version: VERSION,
        time: Date.now()
      });
    }

    if (url.pathname === "/trades") {
      try {
        const body = await request.json();

        if (!body || !Array.isArray(body.trades)) {
          return json({
            ok: false,
            error: "trades معتبر نیست."
          }, 400);
        }

        const key =
          String(body.key || "default");

        await this.state.storage.put(
          key,
          {
            updatedAt: Date.now(),
            trades: body.trades.slice(-5000)
          }
        );

        return json({
          ok: true,
          saved:
            body.trades.length
        });
      } catch (e) {
        return json({
          ok: false,
          error: e?.message || "DO error"
        }, 500);
      }
    }

    if (url.pathname === "/trades/read") {
      const key =
        String(
          url.searchParams.get("key") ||
          "default"
        );

      const data =
        await this.state.storage.get(key);

      return json({
        ok: true,
        data: data || {
          updatedAt: 0,
          trades: []
        }
      });
    }

    return json({
      ok: true,
      service: "CollectorDO",
      version: VERSION
    });
  }
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {
      /* HEALTH */

      if (path === "/api/health") {
        return json({
          ok: true,
          service:
            "Absorption Zone Scanner",
          version: VERSION,
          bybit:
            "https://api.bybit.com",
          timeframes:
            Object.keys(TF_SECONDS),
          durableObject:
            "CollectorDO",
          time: Date.now()
        });
      }

      /* SYMBOL SEARCH */

      if (path === "/api/search") {
        const symbol =
          url.searchParams.get("symbol");

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        return json({
          ok: true,
          symbol: found.symbol,
          category,
          baseCoin:
            found.baseCoin,
          quoteCoin:
            found.quoteCoin
        });
      }

      /* MARKET */

      if (path === "/api/market") {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        return json(
          await marketData(
            category,
            found.symbol,
            interval
          )
        );
      }

      /* TRADES */

      if (path === "/api/trades") {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        const list =
          await trades(
            category,
            found.symbol,
            1000
          );

        return json({
          ok: true,
          category,
          symbol:
            found.symbol,
          trades: list,
          count: list.length
        });
      }

      /* ORDER BOOK */

      if (path === "/api/orderbook") {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        const [book, tick] =
          await Promise.all([
            orderbook(
              category,
              found.symbol,
              50
            ),
            ticker(
              category,
              found.symbol
            )
          ]);

        return json({
          ok: true,
          category,
          symbol:
            found.symbol,
          price:
            tick.price,
          orderbook:
            analyzeBook(
              book,
              tick.price
            ),
          raw:
            book
        });
      }

      /* FOOTPRINT */

      if (path === "/api/footprint") {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        const candleTime =
          num(
            url.searchParams.get(
              "time"
            )
          );

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        const tf =
          TF_SECONDS[interval] ||
          60;

        let candle;

        if (candleTime) {
          const cs =
            await klines(
              category,
              found.symbol,
              interval,
              1000
            );

          candle =
            cs.find(
              x =>
                x.time ===
                candleTime
            );
        }

        if (!candle) {
          const cs =
            await klines(
              category,
              found.symbol,
              interval,
              2
            );

          candle =
            cs.at(-1);
        }

        if (!candle) {
          return json({
            ok: false,
            error:
              "کندل پیدا نشد."
          }, 404);
        }

        const list =
          await trades(
            category,
            found.symbol,
            1000
          );

        const fp =
          buildFootprint(
            {
              ...candle,
              duration:
                tf * 1000
            },
            list
          );

        return json({
          ok: true,
          category,
          symbol:
            found.symbol,
          interval,
          footprint: fp
        });
      }

      /* COMPLETE ANALYSIS */

      if (path === "/api/analyze") {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const found =
          await findSymbol(
            symbol,
            category
          );

        return json(
          await analyze(
            category,
            found.symbol,
            interval
          )
        );
      }

      /* STATIC FRONTEND */

      if (
        env &&
        env.ASSETS &&
        typeof env.ASSETS.fetch ===
          "function"
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json({
        ok: false,
        error:
          "ASSETS binding پیدا نشد."
      }, 500);

    } catch (e) {
      return json({
        ok: false,
        error:
          e?.message ||
          "خطای ناشناخته Worker",
        version: VERSION,
        time: Date.now()
      }, 500);
    }
  }
};
