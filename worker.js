/*
FINAL COMPREHENSIVE DATA BENCHMARK — READ ONLY

Purpose:
  One-shot real-data benchmark before moving persistence to Supabase.

IMPORTANT:
  - NO Durable Object
  - NO SQLite
  - NO database writes
  - NO Supabase writes
  - NO RAM collector dependency
  - Every /api/test/full request is independent
  - Uses current real Bybit REST data
  - Large trades, Footprint, Delta and Absorption are DERIVED from real trades
  - Liquidation is reported as REST_UNAVAILABLE because Bybit's public liquidation
    stream is WebSocket-based; this test does not fake liquidation data.

Main endpoint:
  /api/test/full?symbol=BTCUSDT

Optional:
  /api/test/full?symbol=BTCUSDT&tradeLimit=1000&bookLimit=50
  /api/test/volume?symbol=BTCUSDT
  /api/health

The result reports:
  Trades
  Footprint / price levels
  Delta
  Large / Whale trades
  Order Book / Liquidity
  Absorption
  OI
  Funding
  Klines
  Ticker
  Instrument metadata
  Raw/GZIP size for every category
  1m / 1h / 24h / 7d / 30d projections
  20k / 100k / 200k hour-block projections
  Coverage: REAL API vs DERIVED vs UNAVAILABLE
*/

const VERSION = "ABSORPTION-ZONE-V5-FINAL-COMPREHENSIVE-BENCHMARK-V1";
const BYBIT = "https://api.bybit.com";
const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_TRADE_LIMIT = 1000;
const DEFAULT_BOOK_LIMIT = 50;
const DEFAULT_KLINE_LIMIT = 200;
const MAX_TRADE_LIMIT = 1000;
const MAX_BOOK_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(value) {
  let s = String(value || DEFAULT_SYMBOL)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s) s = DEFAULT_SYMBOL;
  if (s === "BTC") s = "BTCUSDT";
  if (!s.endsWith("USDT")) s += "USDT";
  return s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

async function gzipBytes(text) {
  try {
    const input = new TextEncoder().encode(text);
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    const buffer = await new Response(cs.readable).arrayBuffer();
    return buffer.byteLength;
  } catch (e) {
    return null;
  }
}

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const started = Date.now();
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bybit non-JSON response ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  if (safeNumber(data?.retCode, 0) !== 0) {
    throw new Error(`Bybit retCode ${data?.retCode}: ${data?.retMsg || "unknown"}`);
  }

  return {
    data: data?.result || {},
    elapsedMs: Date.now() - started
  };
}

function parseTrades(list) {
  if (!Array.isArray(list)) return [];

  return list.map((row, index) => {
    const price = safeNumber(row?.p);
    const size = safeNumber(row?.v);
    const side = String(row?.S || "").toUpperCase() === "BUY" ? "BUY" : "SELL";
    const time = safeNumber(row?.T, Date.now());
    const value = price * size;

    return {
      id: String(row?.i || row?.execId || `${time}-${index}`),
      time,
      price,
      size,
      value,
      side
    };
  }).filter(t => t.price > 0 && t.size > 0);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const index = (a.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (index - lo);
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
    notionals.push(t.value);
    if (t.side === "BUY") {
      buyVolume += t.size;
      buyValue += t.value;
      buyTrades++;
    } else {
      sellVolume += t.size;
      sellValue += t.value;
      sellTrades++;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;
  const delta = buyVolume - sellVolume;
  const deltaValue = buyValue - sellValue;
  const deltaPercent = totalVolume ? (delta / totalVolume) * 100 : 0;
  const averageNotional = notionals.length
    ? notionals.reduce((a, b) => a + b, 0) / notionals.length
    : 0;
  const p95 = percentile(notionals, 0.95);
  const largeThreshold = Math.max(averageNotional * 5, p95);

  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  let largeBuyValue = 0;
  let largeSellValue = 0;
  let largeBuyTrades = 0;
  let largeSellTrades = 0;

  for (const t of trades) {
    if (t.value < largeThreshold) continue;
    if (t.side === "BUY") {
      largeBuyVolume += t.size;
      largeBuyValue += t.value;
      largeBuyTrades++;
    } else {
      largeSellVolume += t.size;
      largeSellValue += t.value;
      largeSellTrades++;
    }
  }

  return {
    tradeCount: trades.length,
    buyTrades,
    sellTrades,
    buyVolume,
    sellVolume,
    totalVolume,
    buyValue,
    sellValue,
    totalValue,
    delta,
    deltaValue,
    deltaPercent,
    averageNotional,
    p95Notional: p95,
    largeThreshold,
    largeBuyTrades,
    largeSellTrades,
    largeBuyVolume,
    largeSellVolume,
    largeBuyValue,
    largeSellValue,
    pressure:
      deltaPercent >= 10
        ? "BUY_PRESSURE"
        : deltaPercent <= -10
          ? "SELL_PRESSURE"
          : "NEUTRAL"
  };
}

function tickDecimals(tick) {
  const s = String(tick || "");
  if (!s.includes(".")) return 0;
  return s.split(".")[1].replace(/0+$/, "").length;
}

function roundToTick(price, tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return Number(price);
  return Number((Math.round(Number(price) / t) * t).toFixed(tickDecimals(t)));
}

function aggregateFootprint(trades, tickSize) {
  const levels = new Map();

  for (const t of trades) {
    const price = roundToTick(t.price, tickSize);
    if (!levels.has(price)) {
      levels.set(price, {
        price,
        buyVolume: 0,
        sellVolume: 0,
        buyValue: 0,
        sellValue: 0,
        buyTrades: 0,
        sellTrades: 0
      });
    }

    const level = levels.get(price);
    if (t.side === "BUY") {
      level.buyVolume += t.size;
      level.buyValue += t.value;
      level.buyTrades++;
    } else {
      level.sellVolume += t.size;
      level.sellValue += t.value;
      level.sellTrades++;
    }
  }

  return [...levels.values()].sort((a, b) => a.price - b.price).map(x => ({
    ...x,
    delta: x.buyVolume - x.sellVolume,
    deltaValue: x.buyValue - x.sellValue,
    totalVolume: x.buyVolume + x.sellVolume,
    imbalance: x.sellVolume > 0 ? x.buyVolume / x.sellVolume : x.buyVolume > 0 ? null : 0
  }));
}

function orderbookStats(book) {
  const bids = Array.isArray(book?.b) ? book.b : [];
  const asks = Array.isArray(book?.a) ? book.a : [];

  let buyLiquidity = 0;
  let sellLiquidity = 0;
  let buyValue = 0;
  let sellValue = 0;

  for (const row of bids) {
    const price = safeNumber(row?.[0]);
    const size = safeNumber(row?.[1]);
    buyLiquidity += size;
    buyValue += price * size;
  }

  for (const row of asks) {
    const price = safeNumber(row?.[0]);
    const size = safeNumber(row?.[1]);
    sellLiquidity += size;
    sellValue += price * size;
  }

  const totalLiquidity = buyLiquidity + sellLiquidity;
  const buyShare = totalLiquidity ? buyLiquidity / totalLiquidity * 100 : 0;
  const sellShare = totalLiquidity ? sellLiquidity / totalLiquidity * 100 : 0;
  const bestBid = bids.length ? safeNumber(bids[0][0]) : 0;
  const bestAsk = asks.length ? safeNumber(asks[0][0]) : 0;

  return {
    bidLevels: bids.length,
    askLevels: asks.length,
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyValue,
    sellValue,
    buyShare,
    sellShare,
    bestBid,
    bestAsk,
    spread: bestBid && bestAsk ? bestAsk - bestBid : 0,
    pressure:
      buyShare > sellShare + 8
        ? "BUY_PRESSURE"
        : sellShare > buyShare + 8
          ? "SELL_PRESSURE"
          : "NEUTRAL",
    bids,
    asks
  };
}

function parseKlines(list) {
  if (!Array.isArray(list)) return [];
  return list.map(row => ({
    time: safeNumber(row?.[0]),
    open: safeNumber(row?.[1]),
    high: safeNumber(row?.[2]),
    low: safeNumber(row?.[3]),
    close: safeNumber(row?.[4]),
    volume: safeNumber(row?.[5]),
    turnover: safeNumber(row?.[6])
  })).sort((a, b) => a.time - b.time);
}

function detectAbsorption(trades, candles, bookStats) {
  if (!trades.length || !candles.length) {
    return { detected: false, type: "NONE", score: 0 };
  }

  const c = candles[candles.length - 1];
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const bodyRatio = range > 0 ? body / range : 1;
  const stats = tradeStats(trades);

  let score = 0;
  let type = "NONE";

  if (stats.deltaPercent > 15 && bodyRatio < 0.35) {
    score += 50;
    type = "SELL_ABSORPTION";
  }
  if (stats.deltaPercent < -15 && bodyRatio < 0.35) {
    score += 50;
    type = "BUY_ABSORPTION";
  }
  if (bookStats.pressure !== "NEUTRAL") score += 20;
  if (stats.totalValue > 0 && stats.largeThreshold > 0) score += 10;

  return {
    detected: score >= 50,
    type,
    score: Math.min(100, score),
    candleBodyRatio: bodyRatio,
    deltaPercent: stats.deltaPercent,
    orderbookPressure: bookStats.pressure
  };
}

function sizeOf(name, value) {
  const text = JSON.stringify(value);
  return {
    name,
    rawBytes: utf8Bytes(text),
    rawKB: utf8Bytes(text) / 1024,
    rawMB: utf8Bytes(text) / 1024 / 1024,
    text
  };
}

async function measure(name, value) {
  const x = sizeOf(name, value);
  const gzipBytesValue = await gzipBytes(x.text);
  return {
    name,
    rawBytes: x.rawBytes,
    rawKB: x.rawKB,
    rawMB: x.rawMB,
    gzipBytes: gzipBytesValue,
    gzipKB: gzipBytesValue == null ? null : gzipBytesValue / 1024,
    gzipMB: gzipBytesValue == null ? null : gzipBytesValue / 1024 / 1024,
    gzipSavedPercent:
      gzipBytesValue == null || !x.rawBytes
        ? null
        : (1 - gzipBytesValue / x.rawBytes) * 100,
    gzipRatio:
      gzipBytesValue == null || !gzipBytesValue
        ? null
        : x.rawBytes / gzipBytesValue
  };
}

function projection(bytesPerSample, sampleMinutes) {
  const perMinute = bytesPerSample / Math.max(1, sampleMinutes);
  const hours = perMinute * 60;
  const day = hours * 24;
  const week = day * 7;
  const month = day * 30;

  return {
    basisSampleMinutes: sampleMinutes,
    perMinute: bytesPerSample,
    perHour: hours,
    per24h: day,
    per7d: week,
    per30d: month
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(3)} ${units[i]}`;
}

function storageScaling(perHourBytes) {
  const rows = [20000, 100000, 200000];
  return rows.map(rowCount => ({
    hourBlocks: rowCount,
    rawBytes: perHourBytes.raw * rowCount,
    rawHuman: formatBytes(perHourBytes.raw * rowCount),
    gzipBytes: perHourBytes.gzip == null ? null : perHourBytes.gzip * rowCount,
    gzipHuman: perHourBytes.gzip == null ? null : formatBytes(perHourBytes.gzip * rowCount)
  }));
}

async function fetchInstrument(symbol) {
  try {
    const r = await bybit("/v5/market/instruments-info", {
      category: "linear",
      symbol
    });
    const row = Array.isArray(r.data?.list) ? r.data.list[0] : null;
    return {
      ok: true,
      elapsedMs: r.elapsedMs,
      data: row ? {
        symbol: row.symbol,
        status: row.status,
        baseCoin: row.baseCoin,
        quoteCoin: row.quoteCoin,
        settleCoin: row.settleCoin,
        tickSize: row.priceFilter?.tickSize,
        minOrderQty: row.lotSizeFilter?.minOrderQty,
        maxOrderQty: row.lotSizeFilter?.maxOrderQty
      } : null
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function fetchOiFunding(symbol) {
  const out = {
    openInterest: null,
    funding: null,
    ticker: null,
    errors: []
  };

  try {
    const r = await bybit("/v5/market/open-interest", {
      category: "linear",
      symbol,
      intervalTime: "5min",
      limit: 2
    });
    const list = Array.isArray(r.data?.list) ? r.data.list : [];
    const latest = list[0] || {};
    const previous = list[1] || {};
    out.openInterest = {
      latest: safeNumber(latest.openInterest),
      previous: safeNumber(previous.openInterest),
      change: safeNumber(latest.openInterest) - safeNumber(previous.openInterest),
      rawRows: list
    };
  } catch (error) {
    out.errors.push(`openInterest: ${String(error?.message || error)}`);
  }

  try {
    const r = await bybit("/v5/market/funding/history", {
      category: "linear",
      symbol,
      limit: 2
    });
    const list = Array.isArray(r.data?.list) ? r.data.list : [];
    const latest = list[0] || {};
    const previous = list[1] || {};
    out.funding = {
      latest: safeNumber(latest.fundingRate),
      previous: safeNumber(previous.fundingRate),
      change: safeNumber(latest.fundingRate) - safeNumber(previous.fundingRate),
      rawRows: list
    };
  } catch (error) {
    out.errors.push(`funding: ${String(error?.message || error)}`);
  }

  try {
    const r = await bybit("/v5/market/tickers", {
      category: "linear",
      symbol
    });
    const row = Array.isArray(r.data?.list) ? r.data.list[0] : null;
    out.ticker = row ? {
      lastPrice: safeNumber(row.lastPrice),
      markPrice: safeNumber(row.markPrice),
      indexPrice: safeNumber(row.indexPrice),
      turnover24h: safeNumber(row.turnover24h),
      volume24h: safeNumber(row.volume24h),
      price24hPcnt: safeNumber(row.price24hPcnt)
    } : null;
  } catch (error) {
    out.errors.push(`ticker: ${String(error?.message || error)}`);
  }

  return out;
}

async function fetchLiquidationCoverage(symbol) {
  return {
    available: false,
    mode: "REST_UNAVAILABLE",
    symbol,
    reason: "Public liquidation events are not included in this REST snapshot benchmark. They must be collected from the Bybit public liquidation WebSocket stream for real historical/live storage.",
    fakeDataUsed: false
  };
}

async function testFull(symbol, tradeLimit, bookLimit) {
  const startedAt = Date.now();
  symbol = normalizeSymbol(symbol);

  const tasks = await Promise.allSettled([
    bybit("/v5/market/recent-trade", { category: "linear", symbol, limit: tradeLimit }),
    bybit("/v5/market/orderbook", { category: "linear", symbol, limit: bookLimit }),
    bybit("/v5/market/kline", { category: "linear", symbol, interval: "1", limit: DEFAULT_KLINE_LIMIT }),
    bybit("/v5/market/tickers", { category: "linear", symbol }),
    fetchInstrument(symbol),
    fetchOiFunding(symbol),
    fetchLiquidationCoverage(symbol)
  ]);

  const unwrap = (i, fallback) => {
    if (i.status === "fulfilled") return i.value;
    return fallback;
  };

  const tradeResponse = unwrap(tasks[0], { data: {}, error: "recent-trade failed" });
  const bookResponse = unwrap(tasks[1], { data: {}, error: "orderbook failed" });
  const klineResponse = unwrap(tasks[2], { data: {}, error: "kline failed" });
  const tickerResponse = unwrap(tasks[3], { data: {}, error: "ticker failed" });
  const instrumentResponse = unwrap(tasks[4], { ok: false, error: "instrument failed" });
  const oiFundingResponse = unwrap(tasks[5], { openInterest: null, funding: null, ticker: null, errors: ["OI/Funding failed"] });
  const liquidationResponse = unwrap(tasks[6], { available: false, mode: "REST_UNAVAILABLE", fakeDataUsed: false });

  const trades = parseTrades(tradeResponse?.data?.list);
  const klines = parseKlines(klineResponse?.data?.list);
  const book = orderbookStats(bookResponse?.data);
  const stats = tradeStats(trades);
  const tickSize = instrumentResponse?.data?.tickSize || "0.01";
  const footprint = aggregateFootprint(trades, tickSize);
  const absorption = detectAbsorption(trades, klines, book);
  const ticker = Array.isArray(tickerResponse?.data?.list) ? tickerResponse.data.list[0] : null;

  const minTime = trades.length ? Math.min(...trades.map(t => t.time)) : Date.now();
  const maxTime = trades.length ? Math.max(...trades.map(t => t.time)) : Date.now();
  const sampleMinutes = Math.max(1, Math.ceil((maxTime - minTime + 1) / 60000));

  const rawCategories = {
    trades,
    footprint,
    largeTrades: {
      threshold: stats.largeThreshold,
      buyTrades: stats.largeBuyTrades,
      sellTrades: stats.largeSellTrades,
      buyVolume: stats.largeBuyVolume,
      sellVolume: stats.largeSellVolume,
      buyValue: stats.largeBuyValue,
      sellValue: stats.largeSellValue
    },
    orderBook: book,
    absorption,
    oi: oiFundingResponse.openInterest,
    funding: oiFundingResponse.funding,
    ticker: ticker ? {
      lastPrice: ticker.lastPrice,
      markPrice: ticker.markPrice,
      indexPrice: ticker.indexPrice,
      volume24h: ticker.volume24h,
      turnover24h: ticker.turnover24h,
      price24hPcnt: ticker.price24hPcnt
    } : oiFundingResponse.ticker,
    klines,
    instrument: instrumentResponse?.data || null,
    liquidation: liquidationResponse
  };

  const measured = {};
  for (const [name, value] of Object.entries(rawCategories)) {
    measured[name] = await measure(name, value);
  }

  const totalPayload = JSON.stringify(rawCategories);
  const totalRaw = utf8Bytes(totalPayload);
  const totalGzip = await gzipBytes(totalPayload);

  const tradeRawPerMinute = measured.trades.rawBytes / sampleMinutes;
  const tradeGzipPerMinute = measured.trades.gzipBytes == null ? null : measured.trades.gzipBytes / sampleMinutes;
  const totalRawPerMinute = totalRaw / sampleMinutes;
  const totalGzipPerMinute = totalGzip == null ? null : totalGzip / sampleMinutes;

  const rawPerHour = totalRawPerMinute * 60;
  const gzipPerHour = totalGzipPerMinute == null ? null : totalGzipPerMinute * 60;

  const categoryProjection = {};
  for (const [name, m] of Object.entries(measured)) {
    categoryProjection[name] = {
      raw: projection(m.rawBytes, sampleMinutes),
      gzip: m.gzipBytes == null ? null : projection(m.gzipBytes, sampleMinutes)
    };
  }

  const errors = [];
  for (const [index, task] of tasks.entries()) {
    if (task.status === "rejected") {
      errors.push({ task: index, error: String(task.reason?.message || task.reason) });
    }
  }
  if (oiFundingResponse.errors?.length) errors.push(...oiFundingResponse.errors.map(error => ({ task: "oiFunding", error })));
  if (instrumentResponse?.error) errors.push({ task: "instrument", error: instrumentResponse.error });

  const allDataCoverage = {
    trades: "REAL_BYBIT_REST",
    footprint: "DERIVED_FROM_REAL_TRADES",
    delta: "DERIVED_FROM_REAL_TRADES",
    largeTrades: "DERIVED_FROM_REAL_TRADES",
    orderBook: "REAL_BYBIT_REST",
    liquidity: "DERIVED_FROM_REAL_ORDERBOOK",
    heatmap: "DERIVED_FROM_ORDERBOOK_SNAPSHOTS; NOT_HISTORICAL_IN_THIS_ONE_SHOT_TEST",
    absorption: "DERIVED_FROM_REAL_TRADES_AND_ORDERBOOK",
    openInterest: "REAL_BYBIT_REST",
    funding: "REAL_BYBIT_REST",
    liquidation: liquidationResponse.available ? "REAL_BYBIT" : "UNAVAILABLE_IN_REST_TEST",
    klines: "REAL_BYBIT_REST",
    ticker: "REAL_BYBIT_REST",
    instrument: "REAL_BYBIT_REST"
  };

  return {
    ok: true,
    version: VERSION,
    test: "FINAL_COMPREHENSIVE_READONLY",
    databaseWrite: false,
    databaseRead: false,
    databaseModified: false,
    symbol,
    elapsedMs: Date.now() - startedAt,
    sample: {
      tradeCount: trades.length,
      firstTradeAt: minTime,
      lastTradeAt: maxTime,
      firstTradeISO: new Date(minTime).toISOString(),
      lastTradeISO: new Date(maxTime).toISOString(),
      coveredMinutes: sampleMinutes,
      requestedTradeLimit: tradeLimit,
      requestedOrderBookLevels: bookLimit,
      klineCount: klines.length,
      footprintLevels: footprint.length
    },
    coverage: allDataCoverage,
    stats,
    footprint,
    orderBook: book,
    absorption,
    oi: oiFundingResponse.openInterest,
    funding: oiFundingResponse.funding,
    ticker: rawCategories.ticker,
    instrument: instrumentResponse?.data || null,
    liquidation: liquidationResponse,
    measurements: measured,
    total: {
      rawBytes: totalRaw,
      rawKB: totalRaw / 1024,
      rawMB: totalRaw / 1024 / 1024,
      gzipBytes: totalGzip,
      gzipKB: totalGzip == null ? null : totalGzip / 1024,
      gzipMB: totalGzip == null ? null : totalGzip / 1024 / 1024,
      gzipSavedPercent: totalGzip == null ? null : (1 - totalGzip / totalRaw) * 100,
      gzipRatio: totalGzip ? totalRaw / totalGzip : null
    },
    projections: {
      basis: "The current Bybit recent-trade sample is scaled linearly to time. This is an estimate, not a guarantee of future market activity.",
      tradePayload: {
        raw: projection(tradeRawPerMinute, 1),
        gzip: tradeGzipPerMinute == null ? null : projection(tradeGzipPerMinute, 1)
      },
      allCategories: {
        raw: projection(totalRawPerMinute, 1),
        gzip: totalGzipPerMinute == null ? null : projection(totalGzipPerMinute, 1)
      },
      categories: categoryProjection
    },
    storageScaling: storageScaling({
      raw: rawPerHour,
      gzip: gzipPerHour
    }),
    notes: [
      "This test is independent of Cloudflare Durable Object lifetime.",
      "No SQLite read/write occurs.",
      "No Supabase read/write occurs.",
      "Footprint, Delta, Large Trades and Absorption are derived calculations, not extra API streams.",
      "A true historical heatmap requires repeated order-book snapshots or a WebSocket order-book collector; one REST snapshot cannot represent historical heatmap storage.",
      "Liquidation is not fabricated. It is explicitly marked unavailable in this REST-only benchmark because public liquidation collection requires the Bybit WebSocket stream.",
      "The 20k/100k/200k figures are storage scaling for serialized hour-block equivalents using the measured complete payload size per hour; they are not a claim that Bybit sends exactly one such payload per hour."
    ],
    errors
  };
}

async function testVolume(symbol) {
  symbol = normalizeSymbol(symbol);
  const r = await bybit("/v5/market/recent-trade", {
    category: "linear",
    symbol,
    limit: DEFAULT_TRADE_LIMIT
  });
  const trades = parseTrades(r.data?.list);
  const payload = JSON.stringify(trades);
  const raw = utf8Bytes(payload);
  const gzip = await gzipBytes(payload);
  const first = trades.length ? Math.min(...trades.map(t => t.time)) : Date.now();
  const last = trades.length ? Math.max(...trades.map(t => t.time)) : Date.now();
  const minutes = Math.max(1, Math.ceil((last - first + 1) / 60000));

  return {
    ok: true,
    version: VERSION,
    test: "TRADE_VOLUME_READONLY",
    symbol,
    tradeCount: trades.length,
    coveredMinutes: minutes,
    rawBytes: raw,
    gzipBytes: gzip,
    gzipSavedPercent: gzip == null ? null : (1 - gzip / raw) * 100,
    estimated: {
      rawPerHour: raw / minutes * 60,
      gzipPerHour: gzip == null ? null : gzip / minutes * 60,
      raw24h: raw / minutes * 60 * 24,
      gzip24h: gzip == null ? null : gzip / minutes * 60 * 24,
      raw7d: raw / minutes * 60 * 24 * 7,
      gzip7d: gzip == null ? null : gzip / minutes * 60 * 24 * 7,
      raw30d: raw / minutes * 60 * 24 * 30,
      gzip30d: gzip == null ? null : gzip / minutes * 60 * 24 * 30
    },
    databaseWrite: false,
    databaseRead: false
  };
}

async function health() {
  return {
    ok: true,
    version: VERSION,
    mode: "READ_ONLY",
    databaseWrite: false,
    databaseRead: false,
    databaseModified: false,
    bybit: BYBIT,
    endpoints: {
      full: "/api/test/full?symbol=BTCUSDT",
      volume: "/api/test/volume?symbol=BTCUSDT",
      health: "/api/health"
    }
  };
}

export default {
  async fetch(request) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      const url = new URL(request.url);

      if (url.pathname === "/api/health") {
        return json(await health());
      }

      if (url.pathname === "/api/test/volume") {
        const symbol = normalizeSymbol(url.searchParams.get("symbol"));
        return json(await testVolume(symbol));
      }

      if (url.pathname === "/api/test/full") {
        const symbol = normalizeSymbol(url.searchParams.get("symbol"));
        const tradeLimit = clampInt(
          url.searchParams.get("tradeLimit"),
          100,
          MAX_TRADE_LIMIT,
          DEFAULT_TRADE_LIMIT
        );
        const bookLimit = clampInt(
          url.searchParams.get("bookLimit"),
          10,
          MAX_BOOK_LIMIT,
          DEFAULT_BOOK_LIMIT
        );

        return json(await testFull(symbol, tradeLimit, bookLimit));
      }

      return json({
        ok: false,
        version: VERSION,
        error: "NOT_FOUND",
        available: [
          "/api/health",
          "/api/test/volume?symbol=BTCUSDT",
          "/api/test/full?symbol=BTCUSDT"
        ]
      }, 404);
    } catch (error) {
      return json({
        ok: false,
        version: VERSION,
        error: String(error?.message || error),
        databaseWrite: false,
        databaseRead: false,
        databaseModified: false
      }, 500);
    }
  }
};
