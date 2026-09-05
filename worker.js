const BYBIT = "https://api.bybit.com";

const VERSION = "ORDERFLOW-FOOTPRINT-V1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TF_MAP = {
  "1": 60,
  "3": 180,
  "5": 300,
  "15": 900,
  "30": 1800,
  "60": 3600
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function roundToStep(price, step) {
  if (!step || step <= 0) return price;
  return Math.round(price / step) * step;
}

function decimalsFromStep(step) {
  const s = String(step);
  if (s.includes("e-")) {
    return Number(s.split("e-")[1]);
  }

  const p = s.indexOf(".");
  return p === -1 ? 0 : s.length - p - 1;
}

function formatPrice(v, decimals = 8) {
  return Number(v).toFixed(decimals);
}

async function bybit(path, params = {}) {
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      qs.set(k, String(v));
    }
  }

  const url = `${BYBIT}${path}?${qs.toString()}`;

  const r = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const data = await r.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data;
}

/* -------------------------------------------------------
   SYMBOLS
------------------------------------------------------- */

async function symbols(category = "linear") {
  const data = await bybit(
    "/v5/market/instruments-info",
    {
      category,
      limit: 1000
    }
  );

  const list = data.result?.list || [];

  return list
    .filter(x => {
      if (category === "spot") {
        return x.status === "Trading" &&
          x.quoteCoin === "USDT";
      }

      return x.status === "Trading" &&
        x.quoteCoin === "USDT";
    })
    .map(x => ({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      category,
      tickSize: num(x.priceFilter?.tickSize),
      qtyStep: num(x.lotSizeFilter?.qtyStep),
      minOrderQty: num(x.lotSizeFilter?.minOrderQty)
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/* -------------------------------------------------------
   KLINES
------------------------------------------------------- */

async function klines(category, symbol, interval, limit = 500) {
  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  const rows = data.result?.list || [];

  return rows
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

/* -------------------------------------------------------
   RECENT TRADES
------------------------------------------------------- */

async function recentTrades(category, symbol, limit = 1000) {
  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: Math.min(limit, 1000)
    }
  );

  return (data.result?.list || [])
    .map(t => ({
      id: t.execId || `${t.time}-${t.price}-${t.size}`,
      time: num(t.time),
      price: num(t.price),
      size: num(t.size),
      side: String(t.side || "").toLowerCase(),
      isBlockTrade: Boolean(t.isBlockTrade),
      value: num(t.price) * num(t.size)
    }))
    .sort((a, b) => a.time - b.time);
}

/* -------------------------------------------------------
   ORDER BOOK
------------------------------------------------------- */

async function orderbook(category, symbol, limit = 50) {
  const data = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit
    }
  );

  const r = data.result || {};

  return {
    ts: num(r.ts),
    u: num(r.u),
    seq: num(r.seq),
    bids: (r.b || []).map(x => ({
      price: num(x[0]),
      size: num(x[1])
    })),
    asks: (r.a || []).map(x => ({
      price: num(x[0]),
      size: num(x[1])
    }))
  };
}

/* -------------------------------------------------------
   FOOTPRINT ENGINE
------------------------------------------------------- */

function buildFootprint(candle, trades, tickSize) {
  const map = new Map();

  const start = candle.time;
  const end = candle.time + candle.duration;

  for (const t of trades) {
    if (t.time < start || t.time >= end) continue;
    if (!t.price || !t.size) continue;

    const p = roundToStep(t.price, tickSize);
    const key = p.toFixed(12);

    if (!map.has(key)) {
      map.set(key, {
        price: p,
        bid: 0,
        ask: 0,
        buyVolume: 0,
        sellVolume: 0,
        totalVolume: 0,
        buyTrades: 0,
        sellTrades: 0,
        trades: 0,
        largeBuy: 0,
        largeSell: 0
      });
    }

    const row = map.get(key);

    if (t.side === "buy") {
      row.ask += t.size;
      row.buyVolume += t.size;
      row.buyTrades++;
      row.largeBuy += t.value;
    } else if (t.side === "sell") {
      row.bid += t.size;
      row.sellVolume += t.size;
      row.sellTrades++;
      row.largeSell += t.value;
    }

    row.totalVolume += t.size;
    row.trades++;
  }

  const levels = [...map.values()]
    .sort((a, b) => b.price - a.price)
    .map(x => ({
      ...x,
      delta: x.ask - x.bid,
      deltaPercent:
        x.totalVolume > 0
          ? ((x.ask - x.bid) / x.totalVolume) * 100
          : 0
    }));

  let buy = 0;
  let sell = 0;
  let total = 0;
  let tradesCount = 0;
  let maxVolume = 0;
  let poc = null;
  let maxPositiveDelta = null;
  let maxNegativeDelta = null;

  for (const l of levels) {
    buy += l.ask;
    sell += l.bid;
    total += l.totalVolume;
    tradesCount += l.trades;

    if (l.totalVolume > maxVolume) {
      maxVolume = l.totalVolume;
      poc = l.price;
    }

    if (!maxPositiveDelta || l.delta > maxPositiveDelta.delta) {
      maxPositiveDelta = l;
    }

    if (!maxNegativeDelta || l.delta < maxNegativeDelta.delta) {
      maxNegativeDelta = l;
    }
  }

  const delta = buy - sell;

  const sortedByVolume = [...levels]
    .sort((a, b) => b.totalVolume - a.totalVolume);

  const target = total * 0.70;

  let accumulated = 0;
  const valueLevels = [];

  for (const l of sortedByVolume) {
    accumulated += l.totalVolume;
    valueLevels.push(l);

    if (accumulated >= target) break;
  }

  const vaPrices = valueLevels.map(x => x.price);

  const vah = vaPrices.length
    ? Math.max(...vaPrices)
    : null;

  const val = vaPrices.length
    ? Math.min(...vaPrices)
    : null;

  const buyImbalances = [];
  const sellImbalances = [];

  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    const next = levels[i + 1];

    if (!next) continue;

    if (
      l.ask > 0 &&
      next.bid > 0 &&
      l.ask >= next.bid * 3
    ) {
      buyImbalances.push(l.price);
    }

    if (
      l.bid > 0 &&
      next.ask > 0 &&
      l.bid >= next.ask * 3
    ) {
      sellImbalances.push(l.price);
    }
  }

  const stackedBuy = findStacks(buyImbalances, tickSize);
  const stackedSell = findStacks(sellImbalances, tickSize);

  return {
    candleTime: candle.time,
    levels,
    summary: {
      buyVolume: buy,
      sellVolume: sell,
      volume: total,
      delta,
      deltaPercent:
        total > 0 ? (delta / total) * 100 : 0,
      trades: tradesCount,
      poc,
      vah,
      val,
      maxPositiveDelta: maxPositiveDelta
        ? {
            price: maxPositiveDelta.price,
            delta: maxPositiveDelta.delta
          }
        : null,
      maxNegativeDelta: maxNegativeDelta
        ? {
            price: maxNegativeDelta.price,
            delta: maxNegativeDelta.delta
          }
        : null
    },
    imbalance: {
      buy: buyImbalances,
      sell: sellImbalances,
      stackedBuy,
      stackedSell
    }
  };
}

function findStacks(prices, tickSize) {
  if (!prices.length) return [];

  const sorted = [...prices].sort((a, b) => a - b);

  const result = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (
      Math.abs(
        sorted[i] - sorted[i - 1]
      ) <= tickSize * 1.01
    ) {
      current.push(sorted[i]);
    } else {
      if (current.length >= 3) {
        result.push([...current]);
      }

      current = [sorted[i]];
    }
  }

  if (current.length >= 3) {
    result.push([...current]);
  }

  return result;
}

/* -------------------------------------------------------
   BUILD 24H TRADE FOOTPRINT
------------------------------------------------------- */

async function footprintHistory(
  category,
  symbol,
  interval,
  tickSize
) {
  const seconds = TF_MAP[interval];

  if (!seconds) {
    throw new Error("Invalid timeframe");
  }

  /*
    REST recent-trade is limited.
    We therefore use the latest available trade stream
    and combine it with historical candles.

    Live WebSocket accumulation on the browser keeps
    extending the current session.
  */

  const candles = await klines(
    category,
    symbol,
    interval,
    500
  );

  const trades = await recentTrades(
    category,
    symbol,
    1000
  );

  const now = Date.now();

  const start24 = now - 24 * 60 * 60 * 1000;

  const selectedCandles = candles.filter(
    c => c.time >= start24
  );

  const result = selectedCandles.map(c => {
    const candle = {
      ...c,
      duration: seconds * 1000
    };

    return {
      ...c,
      footprint: buildFootprint(
        candle,
        trades,
        tickSize
      )
    };
  });

  return {
    candles: result,
    tradesAvailableFrom:
      trades.length
        ? trades[0].time
        : null,
    tradesAvailableTo:
      trades.length
        ? trades[trades.length - 1].time
        : null
  };
}

/* -------------------------------------------------------
   FULL MARKET DATA
------------------------------------------------------- */

async function marketBundle(
  category,
  symbol,
  interval
) {
  const info = await symbols(category);

  const instrument =
    info.find(x => x.symbol === symbol);

  if (!instrument) {
    throw new Error(
      `Symbol ${symbol} not found`
    );
  }

  const candles = await klines(
    category,
    symbol,
    interval,
    500
  );

  const book = await orderbook(
    category,
    symbol,
    50
  );

  return {
    version: VERSION,
    category,
    symbol,
    interval,
    tickSize: instrument.tickSize,
    priceDecimals:
      decimalsFromStep(instrument.tickSize),
    candles,
    orderbook: book
  };
}

/* -------------------------------------------------------
   ROUTER
------------------------------------------------------- */

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: CORS
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/") {
        return json({
          ok: true,
          version: VERSION,
          service: "Bybit Order Flow Worker"
        });
      }

      if (path === "/api/symbols") {
        const category =
          url.searchParams.get("category") ||
          "linear";

        return json({
          ok: true,
          symbols: await symbols(category)
        });
      }

      if (path === "/api/market") {
        const category =
          url.searchParams.get("category") ||
          "linear";

        const symbol =
          url.searchParams.get("symbol") ||
          "BTCUSDT";

        const interval =
          url.searchParams.get("interval") ||
          "1";

        return json({
          ok: true,
          data: await marketBundle(
            category,
            symbol,
            interval
          )
        });
      }

      if (path === "/api/trades") {
        const category =
          url.searchParams.get("category") ||
          "linear";

        const symbol =
          url.searchParams.get("symbol") ||
          "BTCUSDT";

        return json({
          ok: true,
          trades: await recentTrades(
            category,
            symbol,
            1000
          )
        });
      }

      if (path === "/api/orderbook") {
        const category =
          url.searchParams.get("category") ||
          "linear";

        const symbol =
          url.searchParams.get("symbol") ||
          "BTCUSDT";

        return json({
          ok: true,
          orderbook:
            await orderbook(
              category,
              symbol,
              50
            )
        });
      }

      if (path === "/api/footprint") {
        const category =
          url.searchParams.get("category") ||
          "linear";

        const symbol =
          url.searchParams.get("symbol") ||
          "BTCUSDT";

        const interval =
          url.searchParams.get("interval") ||
          "1";

        const info =
          await symbols(category);

        const instrument =
          info.find(x => x.symbol === symbol);

        if (!instrument) {
          throw new Error(
            "Symbol not found"
          );
        }

        const data =
          await footprintHistory(
            category,
            symbol,
            interval,
            instrument.tickSize
          );

        return json({
          ok: true,
          data
        });
      }

      return json(
        {
          ok: false,
          error: "Route not found"
        },
        404
      );
    } catch (err) {
      return json(
        {
          ok: false,
          error:
            err?.message ||
            "Unknown Worker error"
        },
        500
      );
    }
  }
};
