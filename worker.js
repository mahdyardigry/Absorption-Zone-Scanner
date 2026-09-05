const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ZONE-SCANNER-V5";
const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_CATEGORY = "linear";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  "pragma": "no-cache",
  "x-scanner-version": VERSION
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extra
    }
  });
}

function normalizeSymbol(value) {
  let s = String(value || DEFAULT_SYMBOL)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s || s === "BUSDT" || s === "USDT") {
    s = DEFAULT_SYMBOL;
  }

  if (!s.endsWith("USDT") && /^[A-Z0-9]+$/.test(s)) {
    s += "USDT";
  }

  return s;
}

function normalizeCategory(value) {
  const v = String(value || DEFAULT_CATEGORY).toLowerCase();

  if (v === "spot") return "spot";
  if (v === "linear" || v === "futures" || v === "future") {
    return "linear";
  }

  return DEFAULT_CATEGORY;
}

function normalizeInterval(value) {
  const allowed = ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D"];

  const v = String(value || DEFAULT_INTERVAL);

  return allowed.includes(v) ? v : DEFAULT_INTERVAL;
}

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function median(values) {
  const a = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((x, y) => x - y);

  if (!a.length) return 0;

  const m = Math.floor(a.length / 2);

  return a.length % 2
    ? a[m]
    : (a[m - 1] + a[m]) / 2;
}

function sum(values) {
  return values.reduce((a, b) => a + n(b), 0);
}

async function bybit(path, params = {}) {
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      qs.set(key, String(value));
    }
  }

  const url = `${BYBIT}${path}?${qs.toString()}`;

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    });
  } catch (e) {
    throw new Error(`Bybit connection failed: ${e.message}`);
  }

  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error(`Bybit returned an empty response (${response.status})`);
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Bybit returned invalid JSON (${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.retMsg ||
      `Bybit HTTP ${response.status}`
    );
  }

  if (n(data.retCode, -1) !== 0) {
    throw new Error(
      data?.retMsg ||
      `Bybit error ${data?.retCode}`
    );
  }

  return data;
}

async function getKlines(category, symbol, interval, limit = KLINE_LIMIT) {
  const data = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  const rows = Array.isArray(data?.result?.list)
    ? data.result.list
    : [];

  return rows
    .map(row => ({
      time: n(row[0]),
      open: n(row[1]),
      high: n(row[2]),
      low: n(row[3]),
      close: n(row[4]),
      volume: n(row[5]),
      turnover: n(row[6])
    }))
    .filter(x => x.time > 0 && x.close > 0)
    .sort((a, b) => a.time - b.time);
}

async function getTrades(category, symbol, limit = TRADE_LIMIT) {
  const data = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit
  });

  const rows = Array.isArray(data?.result?.list)
    ? data.result.list
    : [];

  return rows
    .map(t => {
      const side = String(t.side || "").toLowerCase();
      const price = n(t.price);
      const size = n(t.size);
      const time = n(t.time);

      return {
        id: String(t.execId || t.id || `${time}-${price}-${size}`),
        time,
        price,
        size,
        value: price * size,
        side: side === "buy" ? "buy" : "sell"
      };
    })
    .filter(t => t.price > 0 && t.size > 0)
    .sort((a, b) => a.time - b.time);
}

async function getOrderbook(category, symbol, limit = ORDERBOOK_LIMIT) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit
  });

  const result = data?.result || {};

  const bids = Array.isArray(result.b)
    ? result.b
      .map(x => [n(x?.[0]), n(x?.[1])])
      .filter(x => x[0] > 0 && x[1] > 0)
  : [];

  const asks = Array.isArray(result.a)
    ? result.a
      .map(x => [n(x?.[0]), n(x?.[1])])
      .filter(x => x[0] > 0 && x[1] > 0)
  : [];

  return {
    bids,
    asks,
    ts: n(result.ts || Date.now()),
    updateId: result.u ?? null,
    seq: result.seq ?? null
  };
}

async function getTicker(category, symbol) {
  try {
    const data = await bybit("/v5/market/tickers", {
      category,
      symbol
    });

    const item = data?.result?.list?.[0];

    if (!item) return null;

    return {
      symbol,
      lastPrice: n(item.lastPrice),
      prevPrice24h: n(item.prevPrice24h),
      price24hPcnt: n(item.price24hPcnt),
      high24h: n(item.highPrice24h),
      low24h: n(item.lowPrice24h),
      volume24h: n(item.volume24h),
      turnover24h: n(item.turnover24h),
      fundingRate: n(item.fundingRate),
      openInterest: n(item.openInterest)
    };
  } catch {
    return null;
  }
}

function tradeStats(trades) {
  const buy = trades.filter(t => t.side === "buy");
  const sell = trades.filter(t => t.side === "sell");

  const buyVolume = sum(buy.map(t => t.size));
  const sellVolume = sum(sell.map(t => t.size));

  const buyNotional = sum(buy.map(t => t.value));
  const sellNotional = sum(sell.map(t => t.value));

  const totalVolume = buyVolume + sellVolume;
  const totalNotional = buyNotional + sellNotional;

  const delta = buyVolume - sellVolume;
  const deltaNotional = buyNotional - sellNotional;

  const deltaPercent = totalVolume
    ? (delta / totalVolume) * 100
    : 0;

  const values = trades.map(t => t.value);
  const avgNotional = values.length
    ? sum(values) / values.length
    : 0;

  const p95Index = Math.max(
    0,
    Math.floor(values.length * 0.95)
  );

  const sortedValues = [...values].sort((a, b) => a - b);

  const p95 = sortedValues.length
    ? sortedValues[p95Index]
    : 0;

  const largeThreshold = Math.max(
    avgNotional * 5,
    p95,
    0
  );

  const largeBuy = buy.filter(
    t => t.value >= largeThreshold
  );

  const largeSell = sell.filter(
    t => t.value >= largeThreshold
  );

  const pressure =
    deltaPercent >= 10
      ? "BUY_PRESSURE"
      : deltaPercent <= -10
        ? "SELL_PRESSURE"
        : "BALANCED";

  return {
    trades: trades.length,

    buyVolume,
    sellVolume,
    totalVolume,

    buyNotional,
    sellNotional,
    totalNotional,

    delta,
    deltaNotional,
    deltaPercent,

    buyTrades: buy.length,
    sellTrades: sell.length,

    averageNotional: avgNotional,
    p95Notional: p95,
    largeThreshold,

    largeBuyVolume: sum(
      largeBuy.map(t => t.size)
    ),

    largeSellVolume: sum(
      largeSell.map(t => t.size)
    ),

    largeBuyNotional: sum(
      largeBuy.map(t => t.value)
    ),

    largeSellNotional: sum(
      largeSell.map(t => t.value)
    ),

    largeBuyTrades: largeBuy.length,
    largeSellTrades: largeSell.length,

    pressure
  };
}

function orderbookStats(book) {
  const bids = book.bids || [];
  const asks = book.asks || [];

  const buyLiquidity = sum(
    bids.map(([price, size]) => price * size)
  );

  const sellLiquidity = sum(
    asks.map(([price, size]) => price * size)
  );

  const totalLiquidity =
    buyLiquidity + sellLiquidity;

  const buyShare = totalLiquidity
    ? buyLiquidity / totalLiquidity * 100
    : 0;

  const sellShare = totalLiquidity
    ? sellLiquidity / totalLiquidity * 100
    : 0;

  const bestBid = bids.length
    ? Math.max(...bids.map(x => x[0]))
    : 0;

  const bestAsk = asks.length
    ? Math.min(...asks.map(x => x[0]))
    : 0;

  const spread =
    bestAsk > 0 && bestBid > 0
      ? bestAsk - bestBid
      : 0;

  const spreadPercent =
    bestBid > 0
      ? spread / bestBid * 100
      : 0;

  const bidMedian = median(
    bids.map(x => x[1])
  );

  const askMedian = median(
    asks.map(x => x[1])
  );

  const buyWallThreshold = bidMedian * 4;
  const sellWallThreshold = askMedian * 4;

  const buyWalls = bids
    .filter(([price, size]) =>
      size >= buyWallThreshold &&
      buyWallThreshold > 0
    )
    .map(([price, size]) => ({
      price,
      size,
      value: price * size
    }))
    .sort((a, b) => b.value - a.value);

  const sellWalls = asks
    .filter(([price, size]) =>
      size >= sellWallThreshold &&
      sellWallThreshold > 0
    )
    .map(([price, size]) => ({
      price,
      size,
      value: price * size
    }))
    .sort((a, b) => b.value - a.value);

  const pressure =
    buyShare > sellShare + 8
      ? "BUY_PRESSURE"
      : sellShare > buyShare + 8
        ? "SELL_PRESSURE"
        : "BALANCED";

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
    spreadPercent,

    buyWalls,
    sellWalls,

    pressure
  };
}

function makeFootprint(trades, candles) {
  const levels = new Map();

  for (const trade of trades) {
    const key = trade.price.toFixed(8);

    if (!levels.has(key)) {
      levels.set(key, {
        price: trade.price,
        buyVolume: 0,
        sellVolume: 0,
        buyValue: 0,
        sellValue: 0,
        buyTrades: 0,
        sellTrades: 0
      });
    }

    const level = levels.get(key);

    if (trade.side === "buy") {
      level.buyVolume += trade.size;
      level.buyValue += trade.value;
      level.buyTrades++;
    } else {
      level.sellVolume += trade.size;
      level.sellValue += trade.value;
      level.sellTrades++;
    }
  }

  const rows = [...levels.values()]
    .map(x => ({
      ...x,
      delta: x.buyVolume - x.sellVolume,
      deltaValue: x.buyValue - x.sellValue,
      totalVolume: x.buyVolume + x.sellVolume,
      totalValue: x.buyValue + x.sellValue
    }))
    .sort((a, b) => b.price - a.price);

  const totalBuy = sum(
    rows.map(x => x.buyVolume)
  );

  const totalSell = sum(
    rows.map(x => x.sellVolume)
  );

  const totalDelta = totalBuy - totalSell;

  return {
    levels: rows,
    totalBuy,
    totalSell,
    totalVolume: totalBuy + totalSell,
    totalDelta,
    candle: candles?.length
      ? candles[candles.length - 1]
      : null
  };
}

function makeCVD(trades) {
  let cvd = 0;

  const points = [];

  for (const trade of trades) {
    cvd += trade.side === "buy"
      ? trade.size
      : -trade.size;

    points.push({
      time: trade.time,
      value: cvd
    });
  }

  return {
    value: cvd,
    points
  };
}

function detectAbsorption(trades, book) {
  const stats = tradeStats(trades);
  const ob = orderbookStats(book);

  const result = [];

  if (
    stats.sellVolume > stats.buyVolume &&
    ob.buyShare > 55 &&
    ob.buyWalls.length
  ) {
    result.push({
      type: "BUY_ABSORPTION",
      strength: Math.min(
        100,
        Math.round(
          50 +
          Math.abs(stats.deltaPercent) * 1.5 +
          (ob.buyShare - 50)
        )
      ),
      message: "فروشندگان فعال هستند اما نقدینگی خرید در حال جذب فروش است."
    });
  }

  if (
    stats.buyVolume > stats.sellVolume &&
    ob.sellShare > 55 &&
    ob.sellWalls.length
  ) {
    result.push({
      type: "SELL_ABSORPTION",
      strength: Math.min(
        100,
        Math.round(
          50 +
          Math.abs(stats.deltaPercent) * 1.5 +
          (ob.sellShare - 50)
        )
      ),
      message: "خریداران فعال هستند اما نقدینگی فروش در حال جذب خرید است."
    });
  }

  if (!result.length) {
    result.push({
      type: "NONE",
      strength: 0,
      message: "جذب معناداری در داده فعلی شناسایی نشد."
    });
  }

  return result;
}

function candleStats(candles) {
  if (!candles.length) {
    return {
      last: null,
      previous: null,
      trend: "UNKNOWN"
    };
  }

  const last = candles[candles.length - 1];
  const previous =
    candles.length > 1
      ? candles[candles.length - 2]
      : null;

  const trend =
    !previous
      ? "UNKNOWN"
      : last.close > previous.close
        ? "UP"
        : last.close < previous.close
          ? "DOWN"
          : "FLAT";

  return {
    last,
    previous,
    trend
  };
}

async function buildMarket({
  category,
  symbol,
  interval
}) {
  const [candles, trades, book, ticker] =
    await Promise.all([
      getKlines(
        category,
        symbol,
        interval,
        KLINE_LIMIT
      ),
      getTrades(
        category,
        symbol,
        TRADE_LIMIT
      ),
      getOrderbook(
        category,
        symbol,
        ORDERBOOK_LIMIT
      ),
      getTicker(
        category,
        symbol
      )
    ]);

  const tradesInfo = tradeStats(trades);
  const orderbookInfo = orderbookStats(book);
  const footprintInfo =
    makeFootprint(trades, candles);
  const cvdInfo =
    makeCVD(trades);
  const absorptionInfo =
    detectAbsorption(trades, book);
  const candleInfo =
    candleStats(candles);

  return {
    ok: true,
    version: VERSION,

    market: {
      category,
      symbol,
      interval
    },

    timestamp: Date.now(),

    candles,
    trades,

    orderbook: orderbookInfo,

    footprint: footprintInfo,

    cvd: cvdInfo,

    absorption: absorptionInfo,

    tradeStats: tradesInfo,

    candleStats: candleInfo,

    ticker,

    summary: {
      pressure: tradesInfo.pressure,
      orderbookPressure:
        orderbookInfo.pressure,

      delta:
        tradesInfo.delta,

      deltaPercent:
        tradesInfo.deltaPercent,

      cvd:
        cvdInfo.value,

      buyLiquidity:
        orderbookInfo.buyLiquidity,

      sellLiquidity:
        orderbookInfo.sellLiquidity
    }
  };
}

async function storeTrades(env, category, symbol, trades) {
  if (!env.CollectorDO || !trades?.length) {
    return;
  }

  try {
    const id =
      env.CollectorDO.idFromName(
        `${category}:${symbol}`
      );

    const stub =
      env.CollectorDO.get(id);

    await stub.fetch(
      "https://collector/add",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(trades)
      }
    );
  } catch {
    // Collection must never break market API.
  }
}

async function serveAssets(request, env) {
  if (!env.ASSETS) {
    return new Response(
      "Assets binding is not configured.",
      {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }

  const incoming =
    new URL(request.url);

  let pathname =
    incoming.pathname;

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    pathname = "/index.html";
  }

  if (
    pathname === "/index.html"
  ) {
    const assetUrl =
      new URL(request.url);

    assetUrl.pathname =
      "/index.html";

    const assetRequest =
      new Request(
        assetUrl.toString(),
        {
          method: "GET",
          headers: request.headers
        }
      );

    const response =
      await env.ASSETS.fetch(
        assetRequest
      );

    const headers =
      new Headers(response.headers);

    headers.set(
      "cache-control",
      "no-store, no-cache, must-revalidate, max-age=0"
    );

    headers.set(
      "pragma",
      "no-cache"
    );

    headers.set(
      "expires",
      "0"
    );

    headers.set(
      "x-scanner-version",
      VERSION
    );

    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers
      }
    );
  }

  const assetUrl =
    new URL(request.url);

  assetUrl.pathname =
    pathname;

  const response =
    await env.ASSETS.fetch(
      new Request(
        assetUrl.toString(),
        request
      )
    );

  const headers =
    new Headers(response.headers);

  headers.set(
    "x-scanner-version",
    VERSION
  );

  if (
    pathname.endsWith(".html") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css")
  ) {
    headers.set(
      "cache-control",
      "no-store, no-cache, must-revalidate, max-age=0"
    );
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}

export class CollectorDO {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/add"
    ) {
      let incoming;

      try {
        incoming =
          await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON"
        }, 400);
      }

      if (!Array.isArray(incoming)) {
        return json({
          ok: false,
          error: "Expected trade array"
        }, 400);
      }

      const current =
        await this.storage.get("trades") ||
        [];

      const map =
        new Map();

      for (const t of [
        ...current,
        ...incoming
      ]) {
        const id =
          String(
            t.id ||
            `${t.time}-${t.price}-${t.size}-${t.side}`
          );

        map.set(id, t);
      }

      const trades =
        [...map.values()]
          .sort(
            (a, b) =>
              n(a.time) - n(b.time)
          )
          .slice(-20000);

      await this.storage.put(
        "trades",
        trades
      );

      return json({
        ok: true,
        count: trades.length
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/trades"
    ) {
      const trades =
        await this.storage.get("trades") ||
        [];

      return json({
        ok: true,
        trades
      });
    }

    if (
      request.method === "DELETE"
    ) {
      await this.storage.deleteAll();

      return json({
        ok: true
      });
    }

    return json({
      ok: false,
      error: "Not found"
    }, 404);
  }
}

export default {
  async fetch(request, env) {
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
          online: true,
          version: VERSION,
          worker: "absorption-zone-scanner",
          time: Date.now()
        });
      }

      if (
        path === "/api/market"
      ) {
        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

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

        const market =
          await buildMarket({
            category,
            symbol,
            interval
          });

        await storeTrades(
          env,
          category,
          symbol,
          market.trades
        );

        return json(market);
      }

      if (
        path === "/api/trades"
      ) {
        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const trades =
          await getTrades(
            category,
            symbol,
            TRADE_LIMIT
          );

        await storeTrades(
          env,
          category,
          symbol,
          trades
        );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          trades
        });
      }

      if (
        path === "/api/orderbook"
      ) {
        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const book =
          await getOrderbook(
            category,
            symbol,
            ORDERBOOK_LIMIT
          );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          ...orderbookStats(book)
        });
      }

      if (
        path === "/api/footprint"
      ) {
        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

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

        const [
          candles,
          trades
        ] = await Promise.all([
          getKlines(
            category,
            symbol,
            interval,
            KLINE_LIMIT
          ),
          getTrades(
            category,
            symbol,
            TRADE_LIMIT
          )
        ]);

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          interval,
          ...makeFootprint(
            trades,
            candles
          )
        });
      }

      if (
        path === "/api/analyze"
      ) {
        const category =
          normalizeCategory(
            url.searchParams.get(
              "category"
            )
          );

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

        const market =
          await buildMarket({
            category,
            symbol,
            interval
          });

        await storeTrades(
          env,
          category,
          symbol,
          market.trades
        );

        return json(market);
      }

      return await serveAssets(
        request,
        env
      );

    } catch (error) {
      return json({
        ok: false,
        version: VERSION,
        error:
          error?.message ||
          "Unknown server error"
      }, 500);
    }
  }
};
