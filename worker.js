const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ZONE-SCANNER-V4";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_CATEGORY = "linear";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "pragma": "no-cache"
    }
  });
}

function errorJson(message, status = 500, extra = {}) {
  return json({
    ok: false,
    error: String(message || "Unknown error"),
    ...extra
  }, status);
}

function normalizeCategory(value) {
  const v = String(value || "").toLowerCase();

  if (v === "spot") return "spot";
  if (v === "linear" || v === "futures" || v === "future") {
    return "linear";
  }

  return DEFAULT_CATEGORY;
}

function normalizeInterval(value) {
  const v = String(value || DEFAULT_INTERVAL);

  const allowed = new Set([
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
    "D"
  ]);

  return allowed.has(v) ? v : DEFAULT_INTERVAL;
}

function normalizeSymbol(value) {
  let s = String(value || DEFAULT_SYMBOL)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s || s === "USDT" || s === "BUSDT") {
    return DEFAULT_SYMBOL;
  }

  if (s === "BTC") {
    return "BTCUSDT";
  }

  if (!s.endsWith("USDT") && s.length >= 2) {
    s += "USDT";
  }

  return s;
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;

  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "accept": "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    throw new Error(
      `خطا در اتصال به Bybit: ${err?.message || "Network error"}`
    );
  }

  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error(
      `پاسخ خالی از Bybit دریافت شد — HTTP ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `پاسخ Bybit JSON نیست — HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.retMsg ||
      `خطای HTTP ${response.status} از Bybit`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data;
}

async function getKlines(category, symbol, interval) {
  const data = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit: KLINE_LIMIT
  });

  const rows = data?.result?.list || [];

  return rows
    .map(row => ({
      time: number(row[0]),
      open: number(row[1]),
      high: number(row[2]),
      low: number(row[3]),
      close: number(row[4]),
      volume: number(row[5]),
      turnover: number(row[6])
    }))
    .filter(x =>
      x.time > 0 &&
      x.open > 0 &&
      x.high > 0 &&
      x.low > 0 &&
      x.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

async function getTrades(category, symbol) {
  const data = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit: TRADE_LIMIT
  });

  const rows = data?.result?.list || [];

  return rows
    .map((row, index) => {
      const side =
        String(row.side || "").toLowerCase() === "buy"
          ? "buy"
          : "sell";

      return {
        id: row.execId || `${row.time || Date.now()}-${index}`,
        time: safeTime(row.time),
        price: number(row.price),
        qty: number(row.size),
        side,
        value: number(row.price) * number(row.size),
        isBlock: false
      };
    })
    .filter(x =>
      x.time > 0 &&
      x.price > 0 &&
      x.qty > 0
    );
}

async function getOrderbook(category, symbol) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit: ORDERBOOK_LIMIT
  });

  const result = data?.result || {};

  const bids = (result.b || [])
    .map(row => ({
      price: number(row[0]),
      qty: number(row[1])
    }))
    .filter(x => x.price > 0 && x.qty > 0);

  const asks = (result.a || [])
    .map(row => ({
      price: number(row[0]),
      qty: number(row[1])
    }))
    .filter(x => x.price > 0 && x.qty > 0);

  return {
    timestamp: number(result.ts, Date.now()),
    updateId: result.u || null,
    bids,
    asks,
    bestBid: bids.length ? bids[0].price : 0,
    bestAsk: asks.length ? asks[0].price : 0
  };
}

async function getTicker(category, symbol) {
  const data = await bybit("/v5/market/tickers", {
    category,
    symbol
  });

  return data?.result?.list?.[0] || {};
}

function aggregateTrades(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  const values = trades
    .map(x => x.value)
    .filter(x => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);

  const avg =
    values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;

  const p95 =
    values.length
      ? values[Math.floor((values.length - 1) * 0.95)]
      : 0;

  const largeThreshold = Math.max(
    avg * 5,
    p95,
    0
  );

  for (const trade of trades) {
    if (trade.side === "buy") {
      buyVolume += trade.qty;
      buyValue += trade.value;
      buyTrades++;

      if (trade.value >= largeThreshold && largeThreshold > 0) {
        largeBuyVolume += trade.qty;
      }
    } else {
      sellVolume += trade.qty;
      sellValue += trade.value;
      sellTrades++;

      if (trade.value >= largeThreshold && largeThreshold > 0) {
        largeSellVolume += trade.qty;
      }
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;

  const delta = buyVolume - sellVolume;
  const deltaValue = buyValue - sellValue;

  const deltaPercent =
    totalVolume > 0
      ? (delta / totalVolume) * 100
      : 0;

  let pressure = "NEUTRAL";

  if (deltaPercent >= 10) {
    pressure = "BUY_PRESSURE";
  } else if (deltaPercent <= -10) {
    pressure = "SELL_PRESSURE";
  }

  return {
    buyVolume,
    sellVolume,
    totalVolume,
    buyValue,
    sellValue,
    totalValue,
    delta,
    deltaValue,
    deltaPercent,
    buyTrades,
    sellTrades,
    largeBuyVolume,
    largeSellVolume,
    largeThreshold,
    pressure
  };
}

function buildFootprint(trades, candles) {
  const result = [];

  for (const candle of candles) {
    const start = candle.time;
    const end =
      candles.indexOf(candle) < candles.length - 1
        ? candles[candles.indexOf(candle) + 1].time
        : Date.now();

    const inside = trades.filter(t =>
      t.time >= start &&
      t.time < end
    );

    const levels = new Map();

    for (const trade of inside) {
      const priceKey = trade.price.toString();

      if (!levels.has(priceKey)) {
        levels.set(priceKey, {
          price: trade.price,
          buyVolume: 0,
          sellVolume: 0,
          delta: 0,
          trades: 0
        });
      }

      const level = levels.get(priceKey);

      if (trade.side === "buy") {
        level.buyVolume += trade.qty;
      } else {
        level.sellVolume += trade.qty;
      }

      level.delta =
        level.buyVolume - level.sellVolume;

      level.trades++;
    }

    const levelsArray = Array.from(levels.values())
      .sort((a, b) => b.price - a.price);

    const stats = aggregateTrades(inside);

    result.push({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      levels: levelsArray,
      ...stats
    });
  }

  return result;
}

function analyzeOrderbook(orderbook) {
  const bids = orderbook.bids || [];
  const asks = orderbook.asks || [];

  const buyLiquidity = bids.reduce(
    (sum, x) => sum + x.qty,
    0
  );

  const sellLiquidity = asks.reduce(
    (sum, x) => sum + x.qty,
    0
  );

  const totalLiquidity =
    buyLiquidity + sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? buyLiquidity / totalLiquidity * 100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? sellLiquidity / totalLiquidity * 100
      : 0;

  let pressure = "NEUTRAL";

  if (buyShare > sellShare + 8) {
    pressure = "BUY_PRESSURE";
  } else if (sellShare > buyShare + 8) {
    pressure = "SELL_PRESSURE";
  }

  const bidValues = bids.map(x => x.qty);
  const askValues = asks.map(x => x.qty);

  const bidMedian = median(bidValues);
  const askMedian = median(askValues);

  const bidWalls = bids
    .filter(x =>
      bidMedian > 0 &&
      x.qty >= bidMedian * 4
    )
    .map(x => ({
      ...x,
      type: "BUY_WALL"
    }));

  const askWalls = asks
    .filter(x =>
      askMedian > 0 &&
      x.qty >= askMedian * 4
    )
    .map(x => ({
      ...x,
      type: "SELL_WALL"
    }));

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    pressure,
    bidWalls,
    askWalls,
    bestBid: orderbook.bestBid,
    bestAsk: orderbook.bestAsk,
    spread:
      orderbook.bestAsk > 0 &&
      orderbook.bestBid > 0
        ? orderbook.bestAsk - orderbook.bestBid
        : 0
  };
}

function median(values) {
  const arr = values
    .filter(x => Number.isFinite(x))
    .sort((a, b) => a - b);

  if (!arr.length) return 0;

  const mid = Math.floor(arr.length / 2);

  return arr.length % 2
    ? arr[mid]
    : (arr[mid - 1] + arr[mid]) / 2;
}

function calculateCVD(trades) {
  let cvd = 0;

  return trades
    .slice()
    .sort((a, b) => a.time - b.time)
    .map(t => {
      cvd +=
        t.side === "buy"
          ? t.qty
          : -t.qty;

      return {
        time: t.time,
        delta: t.side === "buy"
          ? t.qty
          : -t.qty,
        cvd
      };
    });
}

function detectAbsorption(trades, orderbook) {
  const stats = aggregateTrades(trades);

  const buyLarge = stats.largeBuyVolume;
  const sellLarge = stats.largeSellVolume;

  const bidWallQty =
    Math.max(
      0,
      ...(orderbook.bids || []).map(x => x.qty)
    );

  const askWallQty =
    Math.max(
      0,
      ...(orderbook.asks || []).map(x => x.qty)
    );

  const buyAbsorption =
    sellLarge > buyLarge &&
    bidWallQty > 0;

  const sellAbsorption =
    buyLarge > sellLarge &&
    askWallQty > 0;

  let signal = "NONE";

  if (buyAbsorption) {
    signal = "BUY_ABSORPTION";
  }

  if (sellAbsorption) {
    signal = "SELL_ABSORPTION";
  }

  return {
    signal,
    buyAbsorption,
    sellAbsorption,
    largeBuyVolume: buyLarge,
    largeSellVolume: sellLarge,
    strongestBidWall: bidWallQty,
    strongestAskWall: askWallQty
  };
}

async function marketData(category, symbol, interval) {
  const [candles, trades, orderbook, ticker] =
    await Promise.all([
      getKlines(category, symbol, interval),
      getTrades(category, symbol),
      getOrderbook(category, symbol),
      getTicker(category, symbol)
    ]);

  const tradeStats = aggregateTrades(trades);
  const orderbookStats = analyzeOrderbook(orderbook);
  const absorption = detectAbsorption(
    trades,
    orderbook
  );

  const footprint = buildFootprint(
    trades,
    candles
  );

  const cvd = calculateCVD(trades);

  return {
    ok: true,
    version: VERSION,
    timestamp: Date.now(),
    category,
    symbol,
    interval,
    candles,
    trades,
    orderbook,
    ticker,
    tradeStats,
    orderbookStats,
    absorption,
    footprint,
    cvd
  };
}

async function assetResponse(request, env) {
  if (!env || !env.ASSETS) {
    return new Response(
      "ASSETS binding is not available.",
      {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }

  const url = new URL(request.url);

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html"
  ) {
    url.pathname = "/index.html";
  }

  const assetRequest = new Request(
    url.toString(),
    request
  );

  const response =
    await env.ASSETS.fetch(assetRequest);

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
    "x-absorption-version",
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

export class CollectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (
        request.method === "POST" &&
        url.pathname === "/add"
      ) {
        const body = await request.text();

        if (!body.trim()) {
          return json({
            ok: true,
            added: 0
          });
        }

        let trades;

        try {
          trades = JSON.parse(body);
        } catch {
          return errorJson(
            "Invalid collector payload",
            400
          );
        }

        if (!Array.isArray(trades)) {
          return errorJson(
            "Trades must be an array",
            400
          );
        }

        const existing =
          (await this.state.storage.get("trades")) || [];

        const map = new Map();

        for (const trade of existing) {
          if (trade?.id) {
            map.set(String(trade.id), trade);
          }
        }

        for (const trade of trades) {
          if (trade?.id) {
            map.set(String(trade.id), trade);
          }
        }

        const cutoff =
          Date.now() - 24 * 60 * 60 * 1000;

        const merged =
          Array.from(map.values())
            .filter(t => number(t.time) >= cutoff)
            .sort((a, b) =>
              number(a.time) - number(b.time)
            )
            .slice(-20000);

        await this.state.storage.put(
          "trades",
          merged
        );

        return json({
          ok: true,
          added: trades.length,
          stored: merged.length
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/trades"
      ) {
        const trades =
          (await this.state.storage.get("trades")) || [];

        return json({
          ok: true,
          trades
        });
      }

      return errorJson(
        "Collector route not found",
        404
      );
    } catch (err) {
      return errorJson(
        err?.message || "Collector error"
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          version: VERSION,
          service: "Absorption Zone Scanner",
          timestamp: Date.now()
        });
      }

      if (url.pathname === "/api/market") {
        const category =
          normalizeCategory(
            url.searchParams.get("category")
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const interval =
          normalizeInterval(
            url.searchParams.get("interval")
          );

        const data =
          await marketData(
            category,
            symbol,
            interval
          );

        return json(data);
      }

      if (url.pathname === "/api/trades") {
        const category =
          normalizeCategory(
            url.searchParams.get("category")
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const trades =
          await getTrades(
            category,
            symbol
          );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          trades,
          stats: aggregateTrades(trades)
        });
      }

      if (url.pathname === "/api/orderbook") {
        const category =
          normalizeCategory(
            url.searchParams.get("category")
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const orderbook =
          await getOrderbook(
            category,
            symbol
          );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          orderbook,
          analysis:
            analyzeOrderbook(orderbook)
        });
      }

      if (url.pathname === "/api/footprint") {
        const category =
          normalizeCategory(
            url.searchParams.get("category")
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const interval =
          normalizeInterval(
            url.searchParams.get("interval")
          );

        const [candles, trades] =
          await Promise.all([
            getKlines(
              category,
              symbol,
              interval
            ),
            getTrades(
              category,
              symbol
            )
          ]);

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          interval,
          footprint:
            buildFootprint(
              trades,
              candles
            ),
          stats:
            aggregateTrades(trades)
        });
      }

      if (url.pathname === "/api/analyze") {
        const category =
          normalizeCategory(
            url.searchParams.get("category")
          );

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const interval =
          normalizeInterval(
            url.searchParams.get("interval")
          );

        const data =
          await marketData(
            category,
            symbol,
            interval
          );

        return json({
          ok: true,
          version: VERSION,
          symbol,
          category,
          interval,
          analysis: {
            tradePressure:
              data.tradeStats.pressure,

            orderbookPressure:
              data.orderbookStats.pressure,

            absorption:
              data.absorption,

            delta:
              data.tradeStats.delta,

            deltaPercent:
              data.tradeStats.deltaPercent,

            cvd:
              data.cvd.length
                ? data.cvd[data.cvd.length - 1].cvd
                : 0
          }
        });
      }

      return assetResponse(
        request,
        env
      );
    } catch (err) {
      return errorJson(
        err?.message ||
        "خطای ناشناخته Worker",
        500,
        {
          version: VERSION,
          path: url.pathname
        }
      );
    }
  }
};
