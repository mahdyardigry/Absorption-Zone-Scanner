const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ZONE-SCANNER-V1";

const TF_MAP = {
  "1": 60,
  "3": 180,
  "5": 300,
  "15": 900,
  "30": 1800,
  "60": 3600
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS
    }
  });
}

function error(message, status = 500) {
  return json({
    ok: false,
    error: message
  }, status);
}

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

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Absorption-Zone-Scanner/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || `Bybit error ${data.retCode}`
    );
  }

  return data;
}

function normalizeCategory(value) {
  return value === "spot" ? "spot" : "linear";
}

function normalizeInterval(value) {
  return TF_MAP[value] ? value : "1";
}

function decimalsFromStep(step) {
  const text = String(step);

  if (!text.includes(".")) {
    return 0;
  }

  return text.replace(/0+$/, "").split(".")[1]?.length || 0;
}

function roundToStep(value, step) {
  const n = Number(value);
  const s = Number(step);

  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(s) || s <= 0) return n;

  return Math.round(n / s) * s;
}

function parseKlines(list) {
  return (list || [])
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      turnover: Number(row[6])
    }))
    .sort((a, b) => a.time - b.time);
}

async function getInstrument(category, symbol) {
  const data = await bybit(
    "/v5/market/instruments-info",
    {
      category,
      symbol
    }
  );

  return data.result?.list?.[0] || null;
}

async function getSymbols(category) {
  const result = [];

  let cursor = "";

  for (let page = 0; page < 5; page++) {
    const data = await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000,
        cursor
      }
    );

    const list = data.result?.list || [];

    for (const item of list) {
      const status =
        item.status ||
        item.symbolType ||
        "";

      if (
        category === "spot" &&
        item.quoteCoin === "USDT" &&
        (!status || status === "Trading")
      ) {
        result.push({
          symbol: item.symbol,
          baseCoin: item.baseCoin,
          quoteCoin: item.quoteCoin,
          status
        });
      }

      if (
        category === "linear" &&
        item.quoteCoin === "USDT" &&
        item.settleCoin === "USDT" &&
        (!status || status === "Trading")
      ) {
        result.push({
          symbol: item.symbol,
          baseCoin: item.baseCoin,
          quoteCoin: item.quoteCoin,
          status
        });
      }
    }

    cursor = data.result?.nextPageCursor || "";

    if (!cursor || !list.length) {
      break;
    }
  }

  return result.sort((a, b) =>
    a.symbol.localeCompare(b.symbol)
  );
}

async function getKlines(
  category,
  symbol,
  interval,
  limit = 1000,
  end
) {
  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit: Math.min(limit, 1000),
      end
    }
  );

  return parseKlines(data.result?.list || []);
}

async function get24hKlines(
  category,
  symbol,
  interval
) {
  const seconds = TF_MAP[interval];

  const required =
    Math.ceil(
      24 * 60 * 60 / seconds
    ) + 20;

  const output = [];
  let end = Date.now();

  while (
    output.length < required &&
    output.length < 3000
  ) {
    const batch = await getKlines(
      category,
      symbol,
      interval,
      1000,
      end
    );

    if (!batch.length) {
      break;
    }

    output.push(...batch);

    const oldest =
      Math.min(...batch.map(x => x.time));

    const nextEnd =
      oldest - 1;

    if (
      !Number.isFinite(nextEnd) ||
      nextEnd >= end
    ) {
      break;
    }

    end = nextEnd;

    if (batch.length < 1000) {
      break;
    }
  }

  const map = new Map();

  for (const candle of output) {
    map.set(candle.time, candle);
  }

  return [...map.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-required);
}

async function getOrderbook(
  category,
  symbol,
  limit = 50
) {
  const data = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit
    }
  );

  const result = data.result || {};

  const bids = (result.b || []).map(x => ({
    price: Number(x[0]),
    size: Number(x[1])
  }));

  const asks = (result.a || []).map(x => ({
    price: Number(x[0]),
    size: Number(x[1])
  }));

  return {
    ts: Number(result.ts || Date.now()),
    updateId: result.u,
    sequence: result.seq,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null
  };
}

async function getRecentTrades(
  category,
  symbol,
  limit = 1000
) {
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
      id: t.execId || "",
      time: Number(t.time || 0),
      price: Number(t.price || 0),
      qty: Number(t.size || 0),
      side: String(t.side || "").toLowerCase(),
      isBlockTrade:
        t.isBlockTrade === true ||
        t.isBlockTrade === "true"
    }))
    .filter(t =>
      t.time &&
      t.price > 0 &&
      t.qty > 0 &&
      (t.side === "buy" || t.side === "sell")
    )
    .sort((a, b) => a.time - b.time);
}

function tradeNotional(t) {
  return t.price * t.qty;
}

function bucketStart(timestamp, seconds) {
  return (
    Math.floor(timestamp / (seconds * 1000)) *
    seconds *
    1000
  );
}

function aggregateTrades(
  trades,
  candleStart,
  candleEnd,
  tickSize
) {
  const levels = new Map();

  let buyVolume = 0;
  let sellVolume = 0;
  let buyNotional = 0;
  let sellNotional = 0;
  let buyTrades = 0;
  let sellTrades = 0;

  let largestTrade = null;
  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  let blockBuyVolume = 0;
  let blockSellVolume = 0;

  const notionals = [];

  for (const t of trades) {
    if (
      t.time < candleStart ||
      t.time >= candleEnd
    ) {
      continue;
    }

    const notional = tradeNotional(t);

    notionals.push(notional);

    if (
      !largestTrade ||
      notional > largestTrade.notional
    ) {
      largestTrade = {
        time: t.time,
        price: t.price,
        qty: t.qty,
        side: t.side,
        notional
      };
    }

    const price = roundToStep(
      t.price,
      tickSize
    );

    const key = String(price);

    if (!levels.has(key)) {
      levels.set(key, {
        price,
        bid: 0,
        ask: 0,
        delta: 0,
        volume: 0,
        trades: 0,
        buyTrades: 0,
        sellTrades: 0,
        largestTrade: 0
      });
    }

    const level = levels.get(key);

    level.volume += t.qty;
    level.trades += 1;
    level.largestTrade =
      Math.max(
        level.largestTrade,
        notional
      );

    if (t.side === "buy") {
      level.ask += t.qty;
      level.delta += t.qty;

      buyVolume += t.qty;
      buyNotional += notional;
      buyTrades += 1;
    } else {
      level.bid += t.qty;
      level.delta -= t.qty;

      sellVolume += t.qty;
      sellNotional += notional;
      sellTrades += 1;
    }

    if (t.side === "buy") {
      level.buyTrades += 1;
    } else {
      level.sellTrades += 1;
    }

    if (
      notionals.length &&
      notional >= 0
    ) {
      const provisionalAvg =
        notionals.reduce(
          (a, b) => a + b,
          0
        ) / notionals.length;

      if (notional >= provisionalAvg * 5) {
        if (t.side === "buy") {
          largeBuyVolume += t.qty;
        } else {
          largeSellVolume += t.qty;
        }
      }
    }

    if (t.isBlockTrade) {
      if (t.side === "buy") {
        blockBuyVolume += t.qty;
      } else {
        blockSellVolume += t.qty;
      }
    }
  }

  const levelList =
    [...levels.values()]
      .sort((a, b) =>
        b.price - a.price
      );

  for (const level of levelList) {
    level.deltaPercent =
      level.volume > 0
        ? level.delta /
          level.volume *
          100
        : 0;
  }

  const volume =
    buyVolume + sellVolume;

  const delta =
    buyVolume - sellVolume;

  const deltaPercent =
    volume > 0
      ? delta / volume * 100
      : 0;

  let poc = null;

  for (const level of levelList) {
    if (
      !poc ||
      level.volume > poc.volume
    ) {
      poc = level;
    }
  }

  const totalVolume =
    levelList.reduce(
      (sum, x) => sum + x.volume,
      0
    );

  const valueAreaTarget =
    totalVolume * 0.70;

  let valueAreaVolume = 0;

  const valueLevels = poc
    ? [poc]
    : [];

  const remaining =
    levelList
      .filter(x =>
        !poc ||
        x.price !== poc.price
      )
      .sort((a, b) => {
        const dp =
          Math.abs(
            a.price -
            (poc?.price || 0)
          );

        const dq =
          Math.abs(
            b.price -
            (poc?.price || 0)
          );

        return dp - dq;
      });

  valueAreaVolume =
    poc?.volume || 0;

  for (const level of remaining) {
    if (
      valueAreaVolume >=
      valueAreaTarget
    ) {
      break;
    }

    valueLevels.push(level);
    valueAreaVolume += level.volume;
  }

  const valuePrices =
    valueLevels.map(x => x.price);

  const vah =
    valuePrices.length
      ? Math.max(...valuePrices)
      : null;

  const val =
    valuePrices.length
      ? Math.min(...valuePrices)
      : null;

  let maxPositiveDelta = null;
  let maxNegativeDelta = null;

  for (const level of levelList) {
    if (
      !maxPositiveDelta ||
      level.delta >
      maxPositiveDelta.delta
    ) {
      maxPositiveDelta = level;
    }

    if (
      !maxNegativeDelta ||
      level.delta <
      maxNegativeDelta.delta
    ) {
      maxNegativeDelta = level;
    }
  }

  const positiveImbalances = [];
  const negativeImbalances = [];

  for (let i = 0; i < levelList.length - 1; i++) {
    const upper = levelList[i];
    const lower = levelList[i + 1];

    if (
      lower.bid > 0 &&
      upper.ask / lower.bid >= 3
    ) {
      positiveImbalances.push(
        upper.price
      );
    }

    if (
      upper.ask > 0 &&
      lower.bid / upper.ask >= 3
    ) {
      negativeImbalances.push(
        lower.price
      );
    }
  }

  return {
    levels: levelList,
    summary: {
      buyVolume,
      sellVolume,
      volume,
      delta,
      deltaPercent,
      buyNotional,
      sellNotional,
      buyTrades,
      sellTrades,
      tradeCount:
        buyTrades + sellTrades,
      buySellRatio:
        sellVolume > 0
          ? buyVolume / sellVolume
          : null,
      poc: poc?.price ?? null,
      vah,
      val,
      maxPositiveDelta:
        maxPositiveDelta?.price ?? null,
      maxNegativeDelta:
        maxNegativeDelta?.price ?? null,
      largestTrade,
      largeBuyVolume,
      largeSellVolume,
      blockBuyVolume,
      blockSellVolume
    },
    imbalance: {
      buy: positiveImbalances,
      sell: negativeImbalances,
      buyCount:
        positiveImbalances.length,
      sellCount:
        negativeImbalances.length
    }
  };
}

async function createCollectorId(
  env,
  category,
  symbol
) {
  if (!env.COLLECTOR) {
    throw new Error(
      "COLLECTOR binding is missing"
    );
  }

  const id =
    env.COLLECTOR.idFromName(
      `${category}:${symbol}`
    );

  return env.COLLECTOR.get(id);
}

async function collectorFetch(
  env,
  category,
  symbol,
  request
) {
  const stub =
    await createCollectorId(
      env,
      category,
      symbol
    );

  return stub.fetch(
    new Request(
      "https://collector.internal" +
      request
    )
  );
}

export class CollectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async saveTrade(trade) {
    const stored =
      await this.state.storage.get(
        "trades"
      ) || [];

    const exists =
      trade.id &&
      stored.some(
        x => x.id === trade.id
      );

    if (!exists) {
      stored.push(trade);
    }

    const cutoff =
      Date.now() -
      25 * 60 * 60 * 1000;

    const filtered =
      stored
        .filter(x =>
          x.time >= cutoff
        )
        .sort(
          (a, b) =>
            a.time - b.time
        );

    await this.state.storage.put(
      "trades",
      filtered
    );

    return filtered.length;
  }

  async getTrades() {
    return (
      await this.state.storage.get(
        "trades"
      )
    ) || [];
  }

  async fetch(request) {
    try {
      const url =
        new URL(request.url);

      if (
        url.pathname ===
        "/trade" &&
        request.method === "POST"
      ) {
        const trade =
          await request.json();

        const count =
          await this.saveTrade(trade);

        return json({
          ok: true,
          count
        });
      }

      if (
        url.pathname ===
        "/trades"
      ) {
        const trades =
          await this.getTrades();

        return json({
          ok: true,
          trades
        });
      }

      if (
        url.pathname ===
        "/clear" &&
        request.method === "POST"
      ) {
        await this.state.storage.delete(
          "trades"
        );

        return json({
          ok: true
        });
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (err) {
      return error(
        err?.message ||
        String(err)
      );
    }
  }
}

async function handleSymbols(
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbols =
    await getSymbols(
      category
    );

  return json({
    ok: true,
    version: VERSION,
    category,
    symbols
  });
}

async function handleMarket(
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  const interval =
    normalizeInterval(
      url.searchParams.get(
        "interval"
      )
    );

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  const [
    instrument,
    candles,
    orderbook
  ] = await Promise.all([
    getInstrument(
      category,
      symbol
    ),
    get24hKlines(
      category,
      symbol,
      interval
    ),
    getOrderbook(
      category,
      symbol,
      50
    )
  ]);

  const tickSize =
    Number(
      instrument
        ?.priceFilter
        ?.tickSize || 0.00000001
    );

  return json({
    ok: true,
    version: VERSION,
    category,
    symbol,
    interval,
    tickSize,
    decimals:
      decimalsFromStep(
        tickSize
      ),
    candles,
    orderbook
  });
}

async function handleTrades(
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  const trades =
    await getRecentTrades(
      category,
      symbol,
      1000
    );

  return json({
    ok: true,
    category,
    symbol,
    trades
  });
}

async function handleOrderbook(
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  return json({
    ok: true,
    category,
    symbol,
    orderbook:
      await getOrderbook(
        category,
        symbol,
        50
      )
  });
}

async function handleCollectorTrades(
  env,
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  return collectorFetch(
    env,
    category,
    symbol,
    "/trades"
  );
}

async function handleStoreTrade(
  env,
  request
) {
  const url =
    new URL(request.url);

  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  const trade =
    await request.json();

  return collectorFetch(
    env,
    category,
    symbol,
    new Request(
      "https://collector.internal/trade",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify(trade)
      }
    )
  );
}

async function handleFootprint(
  env,
  url
) {
  const category =
    normalizeCategory(
      url.searchParams.get(
        "category"
      )
    );

  const symbol =
    String(
      url.searchParams.get(
        "symbol"
      ) || ""
    ).toUpperCase();

  const interval =
    normalizeInterval(
      url.searchParams.get(
        "interval"
      )
    );

  const selected =
    Number(
      url.searchParams.get(
        "time"
      ) || 0
    );

  if (!symbol) {
    return error(
      "symbol is required",
      400
    );
  }

  const instrument =
    await getInstrument(
      category,
      symbol
    );

  const tickSize =
    Number(
      instrument
        ?.priceFilter
        ?.tickSize ||
      0.00000001
    );

  const [
    candles,
    storedResponse,
    recentTrades
  ] = await Promise.all([
    get24hKlines(
      category,
      symbol,
      interval
    ),
    collectorFetch(
      env,
      category,
      symbol,
      "/trades"
    ),
    getRecentTrades(
      category,
      symbol,
      1000
    )
  ]);

  let stored = [];

  try {
    const data =
      await storedResponse.json();

    stored =
      data.trades || [];
  } catch {
    stored = [];
  }

  const map =
    new Map();

  for (const trade of [
    ...stored,
    ...recentTrades
  ]) {
    const key =
      trade.id ||
      `${trade.time}:${trade.price}:${trade.qty}:${trade.side}`;

    map.set(key, trade);
  }

  const trades =
    [...map.values()]
      .sort(
        (a, b) =>
          a.time - b.time
      );

  const tfSeconds =
    TF_MAP[interval];

  const footprints = [];

  for (const candle of candles) {
    const end =
      candle.time +
      tfSeconds * 1000;

    const footprint =
      aggregateTrades(
        trades,
        candle.time,
        end,
        tickSize
      );

    footprints.push({
      time: candle.time,
      candle,
      ...footprint
    });
  }

  let selectedFootprint =
    footprints[
      footprints.length - 1
    ] || null;

  if (selected) {
    selectedFootprint =
      footprints.find(
        x => x.time === selected
      ) ||
      selectedFootprint;
  }

  return json({
    ok: true,
    version: VERSION,
    category,
    symbol,
    interval,
    tickSize,
    candles,
    footprints,
    selected:
      selectedFootprint,
    storedTradeCount:
      stored.length,
    recentTradeCount:
      recentTrades.length,
    combinedTradeCount:
      trades.length,
    note:
      "Footprint is built from real executed trades stored by CollectorDO plus current Bybit recent trades."
  });
}

async function route(
  request,
  env
) {
  const url =
    new URL(request.url);

  const path =
    url.pathname;

  if (
    path === "/" ||
    path === "/index.html"
  ) {
    return new Response(
      INDEX_HTML,
      {
        headers: {
          "Content-Type":
            "text/html; charset=utf-8",
          ...CORS
        }
      }
    );
  }

  if (
    path === "/api/health"
  ) {
    return json({
      ok: true,
      version: VERSION,
      worker: "online",
      durableObject:
        !!env.COLLECTOR
    });
  }

  if (
    path === "/api/symbols"
  ) {
    return handleSymbols(url);
  }

  if (
    path === "/api/market"
  ) {
    return handleMarket(url);
  }

  if (
    path === "/api/trades"
  ) {
    return handleTrades(url);
  }

  if (
    path === "/api/orderbook"
  ) {
    return handleOrderbook(url);
  }

  if (
    path === "/api/collector/trades"
  ) {
    return handleCollectorTrades(
      env,
      url
    );
  }

  if (
    path === "/api/collector/trade" &&
    request.method === "POST"
  ) {
    return handleStoreTrade(
      env,
      request
    );
  }

  if (
    path === "/api/footprint"
  ) {
    return handleFootprint(
      env,
      url
    );
  }

  return error(
    "Not found",
    404
  );
}

export default {
  async fetch(request, env) {
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        headers: CORS
      });
    }

    try {
      return await route(
        request,
        env
      );
    } catch (err) {
      return error(
        err?.message ||
        String(err),
        500
      );
    }
  }
};

/*
  index.html را فعلاً از فایل جداگانه
  سرو می‌کنیم؛ این خط توسط Build Script
  جایگزین خواهد شد.
*/
const INDEX_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Absorption Zone Scanner</title>
<style>
body{
margin:0;
background:#071018;
color:#e8eef5;
font-family:Arial,sans-serif;
}
main{
max-width:1200px;
margin:auto;
padding:20px;
}
h1{
font-size:22px;
}
.box{
background:#0d1822;
border:1px solid #203241;
border-radius:14px;
padding:16px;
margin-bottom:14px;
}
.status{
padding:10px;
border-radius:10px;
background:#102330;
}
</style>
</head>
<body>
<main>
<div class="box">
<h1>📊 Absorption Zone Scanner</h1>
<div class="status">🟢 Worker Online</div>
</div>
</main>
</body>
</html>`;
