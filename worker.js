import { DurableObject } from "cloudflare:workers";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const VERSION = "ABSORPTION-ORDERFLOW-MAP-V6";

const TF = "5";
const TF15 = "15";
const TF3 = "3";
const TF1 = "1";

const KLINE_LIMIT = 240;
const CHART_LIMIT = 180;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;
const FOOTPRINT_MAX_LEVELS = 80;
const HEATMAP_LEVELS = 50;
const RETENTION_MINUTES = 1440;
const ORDERBOOK_SNAPSHOT_MS = 5000;
const WS_RECONNECT_MIN = 3000;
const WS_RECONNECT_MAX = 30000;
const WS_SUB_CHUNK = 200;

const ALLOWED_INTERVALS = ["1","3","5","15","30","60"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "*"
    }
  });
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
  return a.length ? a.reduce((x,y) => x + y, 0) / a.length : 0;
}

function normalizeSymbol(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeInterval(v) {
  v = String(v || TF);
  return ALLOWED_INTERVALS.includes(v) ? v : TF;
}

function intervalMs(v) {
  return Number(normalizeInterval(v)) * 60000;
}

function priceDecimals(step) {
  step = n(step);
  if (!step) return 8;
  const s = String(step);
  if (!s.includes(".")) return 0;
  return Math.min(16, Math.max(0, s.split(".")[1].replace(/0+$/, "").length));
}

function roundToStep(price, step) {
  price = n(price);
  step = n(step);
  if (!price || !step) return price;
  return Number((Math.round(price / step) * step).toFixed(priceDecimals(step)));
}

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);

  const d = await r.json();
  if (d.retCode !== 0) throw new Error(d.retMsg || `Bybit error ${d.retCode}`);
  return d;
}

const instrumentCache = new Map();

async function instrumentInfo(category, symbol) {
  const key = `${category}:${symbol}`;
  if (instrumentCache.has(key)) return instrumentCache.get(key);

  const d = await bybit("/v5/market/instruments-info", { category, symbol });
  const x = d?.result?.list?.[0];

  const result = x ? {
    symbol: x.symbol,
    tickSize: n(x.priceFilter?.tickSize),
    minPrice: n(x.priceFilter?.minPrice),
    maxPrice: n(x.priceFilter?.maxPrice),
    qtyStep: n(x.lotSizeFilter?.qtyStep)
  } : {
    symbol,
    tickSize: 0,
    minPrice: 0,
    maxPrice: 0,
    qtyStep: 0
  };

  instrumentCache.set(key, result);
  return result;
}

async function kline(category, symbol, interval = TF, limit = KLINE_LIMIT) {
  interval = normalizeInterval(interval);

  const d = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  return (d?.result?.list || []).map(x => ({
    time: n(x[0]),
    open: n(x[1]),
    high: n(x[2]),
    low: n(x[3]),
    close: n(x[4]),
    volume: n(x[5]),
    turnover: n(x[6])
  })).sort((a,b) => a.time - b.time);
}

async function ticker(category, symbol) {
  const d = await bybit("/v5/market/tickers", { category, symbol });
  const x = d?.result?.list?.[0] || {};

  return {
    symbol,
    lastPrice: n(x.lastPrice),
    markPrice: n(x.markPrice),
    indexPrice: n(x.indexPrice),
    turnover24h: n(x.turnover24h),
    volume24h: n(x.volume24h),
    price24hPcnt: n(x.price24hPcnt),
    openInterest: n(x.openInterest),
    fundingRate: n(x.fundingRate)
  };
}

async function trades(category, symbol, limit = TRADE_LIMIT) {
  const d = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit
  });

  return (d?.result?.list || []).map(x => ({
    id: x.execId || x.id || `${x.time}-${x.price}-${x.size}`,
    time: n(x.time),
    price: n(x.price),
    size: n(x.size),
    side: String(x.side || "").trim().toUpperCase(),
    isBlockTrade: x.isBlockTrade === true || x.isBlockTrade === "true",
    isRPITrade: x.isRPITrade === true || x.isRPITrade === "true"
  })).filter(x =>
    x.time > 0 &&
    x.price > 0 &&
    x.size > 0 &&
    (x.side === "BUY" || x.side === "SELL")
  ).sort((a,b) => a.time - b.time);
}

function aggressorSide(x) {
  const s = String(x?.side || "").toUpperCase();
  return s === "BUY" || s === "SELL" ? s : "UNKNOWN";
}

async function orderbook(category, symbol, limit = ORDERBOOK_LIMIT) {
  const d = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit
  });

  const r = d?.result || {};

  const bids = (r.b || []).map(x => {
    const price = n(x[0]), size = n(x[1]);
    return { price, size, value: price * size };
  }).filter(x => x.price > 0 && x.size > 0);

  const asks = (r.a || []).map(x => {
    const price = n(x[0]), size = n(x[1]);
    return { price, size, value: price * size };
  }).filter(x => x.price > 0 && x.size > 0);

  return {
    bids,
    asks,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0,
    timestamp: n(d.time, Date.now())
  };
}

function flowFromTrades(list, start = 0, end = Infinity) {
  let buyVolume = 0;
  let sellVolume = 0;
  let buyValue = 0;
  let sellValue = 0;
  let buyTrades = 0;
  let sellTrades = 0;

  for (const x of list) {
    if (x.time < start || x.time > end) continue;

    const value = x.price * x.size;

    if (aggressorSide(x) === "BUY") {
      buyVolume += x.size;
      buyValue += value;
      buyTrades++;
    } else if (aggressorSide(x) === "SELL") {
      sellVolume += x.size;
      sellValue += value;
      sellTrades++;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const totalValue = buyValue + sellValue;

  return {
    buyVolume,
    sellVolume,
    buyValue,
    sellValue,
    buyNotional: buyValue,
    sellNotional: sellValue,
    totalVolume,
    flowVolume: totalVolume,
    totalValue,
    delta: buyVolume - sellVolume,
    deltaValue: buyValue - sellValue,
    deltaPercent: pct(buyVolume - sellVolume, totalVolume),
    deltaValuePercent: pct(buyValue - sellValue, totalValue),
    buyShare: pct(buyVolume, totalVolume),
    sellShare: pct(sellVolume, totalVolume),
    buyTrades,
    sellTrades,
    tradeCount: buyTrades + sellTrades,
    firstTime: list[0]?.time || 0,
    lastTime: list.at(-1)?.time || 0
  };
}

function createLevel(price) {
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
    side: "NEUTRAL"
  };
}

function buildFootprints(candles, tradeList, interval, tickSize) {
  const duration = intervalMs(interval);
  const maps = new Map();

  for (const c of candles) maps.set(c.time, new Map());

  for (const t of tradeList) {
    const ct = Math.floor(t.time / duration) * duration;
    const map = maps.get(ct);
    if (!map) continue;

    const price = tickSize ? roundToStep(t.price, tickSize) : t.price;
    let level = map.get(price);

    if (!level) {
      level = createLevel(price);
      map.set(price, level);
    }

    const value = t.price * t.size;

    level.totalVolume += t.size;
    level.totalValue += value;

    if (aggressorSide(t) === "BUY") {
      level.askVolume += t.size;
      level.askValue += value;
      level.askTrades++;
    } else if (aggressorSide(t) === "SELL") {
      level.bidVolume += t.size;
      level.bidValue += value;
      level.bidTrades++;
    }
  }

  const result = [];
  let cumulativeDeltaValue = 0;

  for (const candle of candles) {
    const map = maps.get(candle.time) || new Map();

    let buyVolume = 0;
    let sellVolume = 0;
    let buyValue = 0;
    let sellValue = 0;
    let buyTrades = 0;
    let sellTrades = 0;

    const levels = [];

    for (const level of map.values()) {
      level.delta = level.askVolume - level.bidVolume;
      level.deltaValue = level.askValue - level.bidValue;

      level.imbalance =
        level.bidVolume > 0
          ? level.askVolume / level.bidVolume
          : level.askVolume > 0 ? Infinity : 0;

      level.side =
        level.askVolume > level.bidVolume
          ? "BUY"
          : level.bidVolume > level.askVolume
            ? "SELL"
            : "NEUTRAL";

      buyVolume += level.askVolume;
      sellVolume += level.bidVolume;
      buyValue += level.askValue;
      sellValue += level.bidValue;
      buyTrades += level.askTrades;
      sellTrades += level.bidTrades;

      levels.push(level);
    }

    levels.sort((a,b) => b.price - a.price);

    const flowVolume = buyVolume + sellVolume;
    const totalValue = buyValue + sellValue;
    const delta = buyVolume - sellVolume;
    const deltaValue = buyValue - sellValue;

    cumulativeDeltaValue += deltaValue;

    result.push({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      flowVolume,
      buyVolume,
      sellVolume,
      buyValue,
      sellValue,
      buyTrades,
      sellTrades,
      tradeCount: buyTrades + sellTrades,
      totalValue,
      delta,
      deltaValue,
      deltaPercent: pct(delta, flowVolume),
      deltaValuePercent: pct(deltaValue, totalValue),
      cumulativeDeltaValue,
      levels: levels.slice(0, FOOTPRINT_MAX_LEVELS),
      imbalances: levels.filter(x =>
        x.imbalance >= 3 ||
        (x.bidVolume > 0 && x.askVolume / x.bidVolume <= 1/3)
      )
    });
  }

  return result;
}

function median(values) {
  if (!values.length) return 0;
  const a = [...values].sort((x,y) => x-y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

function wallAnalysis(book) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];

  const buyLiquidity = bids.reduce((s,x) => s + x.value, 0);
  const sellLiquidity = asks.reduce((s,x) => s + x.value, 0);
  const totalLiquidity = buyLiquidity + sellLiquidity;

  const buyShare = pct(buyLiquidity, totalLiquidity);
  const sellShare = pct(sellLiquidity, totalLiquidity);

  const bm = median(bids.map(x => x.value));
  const am = median(asks.map(x => x.value));

  const buyWalls = bids
    .filter(x => bm > 0 && x.value >= bm * 4)
    .sort((a,b) => b.value-a.value)
    .slice(0,20);

  const sellWalls = asks
    .filter(x => am > 0 && x.value >= am * 4)
    .sort((a,b) => b.value-a.value)
    .slice(0,20);

  const pressure =
    buyShare > sellShare + 8
      ? "BUY_PRESSURE"
      : sellShare > buyShare + 8
        ? "SELL_PRESSURE"
        : "NEUTRAL";

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    imbalance: buyShare - sellShare,
    pressure,
    buyWalls,
    sellWalls,
    nearBuyWall: buyWalls[0] || null,
    nearSellWall: sellWalls[0] || null,
    bestBid: book?.bestBid || 0,
    bestAsk: book?.bestAsk || 0
  };
}

function liquidityHeatmap(book) {
  const bids = (book?.bids || []).slice(0, HEATMAP_LEVELS);
  const asks = (book?.asks || []).slice(0, HEATMAP_LEVELS);

  const maxValue = Math.max(
    ...bids.map(x => x.value),
    ...asks.map(x => x.value),
    1
  );

  return {
    bids: bids.map(x => ({
      ...x,
      intensity: clamp(x.value / maxValue, 0, 1)
    })),
    asks: asks.map(x => ({
      ...x,
      intensity: clamp(x.value / maxValue, 0, 1)
    })),
    maxValue
  };
}

function liquidityZones(book, price = 0) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];
  const bm = median(bids.map(x => x.value));
  const am = median(asks.map(x => x.value));
  const zones = [];

  for (const x of bids) {
    if (bm > 0 && x.value >= bm * 2) {
      zones.push({
        side: "BUY",
        price: x.price,
        value: x.value,
        distancePercent: price ? Math.abs(pct(x.price-price,price)) : 0
      });
    }
  }

  for (const x of asks) {
    if (am > 0 && x.value >= am * 2) {
      zones.push({
        side: "SELL",
        price: x.price,
        value: x.value,
        distancePercent: price ? Math.abs(pct(x.price-price,price)) : 0
      });
    }
  }

  return zones.sort((a,b) => b.value-a.value).slice(0,50);
}

function candleStats(c) {
  const range = Math.max(0, c.high - c.low);
  const body = Math.abs(c.close-c.open);

  return {
    range,
    body,
    bodyPercent: pct(body,range),
    upperWick: c.high - Math.max(c.open,c.close),
    lowerWick: Math.min(c.open,c.close)-c.low,
    bullish: c.close >= c.open
  };
}

function detectSweep(candles) {
  if (candles.length < 5) {
    return { detected:false, side:"NONE", price:0, strength:0 };
  }

  const c = candles.at(-1);
  const prev = candles.slice(-6,-1);

  const ph = Math.max(...prev.map(x => x.high));
  const pl = Math.min(...prev.map(x => x.low));
  const range = c.high-c.low || 1;

  if (c.high > ph && c.close < ph) {
    return {
      detected:true,
      side:"SELL",
      type:"HIGH_SWEEP",
      price:c.high,
      strength:pct(c.high-c.close,range)
    };
  }

  if (c.low < pl && c.close > pl) {
    return {
      detected:true,
      side:"BUY",
      type:"LOW_SWEEP",
      price:c.low,
      strength:pct(c.close-c.low,range)
    };
  }

  return { detected:false, side:"NONE", price:0, strength:0 };
}

function detectTradeSweep(list) {
  const recent = list.slice(-50);
  let buy = 0, sell = 0;

  for (const x of recent) {
    const value = x.price*x.size;
    if (aggressorSide(x) === "BUY") buy += value;
    if (aggressorSide(x) === "SELL") sell += value;
  }

  if (buy > sell*2) {
    return { detected:true, side:"BUY", value:buy, ratio:sell ? buy/sell : Infinity };
  }

  if (sell > buy*2) {
    return { detected:true, side:"SELL", value:sell, ratio:buy ? sell/buy : Infinity };
  }

  return { detected:false, side:"NONE", value:Math.max(buy,sell), ratio:1 };
}

function detectAbsorption(candles, flow, book) {
  const c = candles.at(-1);
  if (!c) return { detected:false, side:"NONE", strength:0 };

  const s = candleStats(c);

  if (
    flow.deltaPercent > 20 &&
    s.bodyPercent < 35 &&
    book.buyShare < book.sellShare + 5
  ) {
    return {
      detected:true,
      side:"SELL",
      type:"BUY_ABSORPTION",
      strength:clamp(Math.abs(flow.deltaPercent)+(35-s.bodyPercent),0,100),
      price:c.close,
      range:s.range
    };
  }

  if (
    flow.deltaPercent < -20 &&
    s.bodyPercent < 35 &&
    book.sellShare < book.buyShare + 5
  ) {
    return {
      detected:true,
      side:"BUY",
      type:"SELL_ABSORPTION",
      strength:clamp(Math.abs(flow.deltaPercent)+(35-s.bodyPercent),0,100),
      price:c.close,
      range:s.range
    };
  }

  return { detected:false, side:"NONE", strength:0, price:c.close };
}

function sma(values, period) {
  if (!values.length) return 0;
  const a = values.slice(-period);
  return avg(a);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];

  for (let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    trs.push(Math.max(
      c.high-c.low,
      Math.abs(c.high-p.close),
      Math.abs(c.low-p.close)
    ));
  }

  return sma(trs,period);
}

function rsi(candles, period=14) {
  if (candles.length < period+1) return 50;

  let gain=0, loss=0;

  for (let i=candles.length-period;i<candles.length;i++) {
    const d=candles[i].close-candles[i-1].close;
    if (d >= 0) gain += d;
    else loss += Math.abs(d);
  }

  if (!loss) return 100;
  return 100 - 100/(1+gain/loss);
}

function structure(candles) {
  if (candles.length < 20) {
    return { trend:"NEUTRAL", direction:"NEUTRAL", strength:0 };
  }

  const closes=candles.map(x=>x.close);
  const short=sma(closes,5);
  const long=sma(closes,20);
  const last=closes.at(-1);
  const a=atr(candles,14)||1;
  const strength=clamp(Math.abs(last-long)/a*25,0,100);

  if (short>long && last>long)
    return {trend:"BULLISH",direction:"BUY",strength};

  if (short<long && last<long)
    return {trend:"BEARISH",direction:"SELL",strength};

  return {trend:"NEUTRAL",direction:"NEUTRAL",strength:0};
}

function entry1m(candles) {
  if (candles.length<20)
    return {direction:"WAIT",price:candles.at(-1)?.close||0,confidence:0};

  const closes=candles.map(x=>x.close);
  const ma20=sma(closes,20);
  const last=closes.at(-1);
  const r=rsi(candles,14);

  if (last>ma20 && r>=50)
    return {direction:"BUY",price:last,confidence:clamp(50+r-50,0,100),ma20,rsi:r};

  if (last<ma20 && r<=50)
    return {direction:"SELL",price:last,confidence:clamp(50+50-r,0,100),ma20,rsi:r};

  return {direction:"WAIT",price:last,confidence:40,ma20,rsi:r};
}

function pressureFromFlow(flow) {
  if (flow.deltaPercent >= 10) return "BUY_PRESSURE";
  if (flow.deltaPercent <= -10) return "SELL_PRESSURE";
  return "NEUTRAL";
}

function movement(candles) {
  if (candles.length<2) return {percent:0,direction:"NEUTRAL"};

  const a=candles.at(-2).close;
  const b=candles.at(-1).close;
  const change=pct(b-a,a);

  return {
    percent:change,
    direction:change>0?"UP":change<0?"DOWN":"NEUTRAL"
  };
}

function supportResistance(candles) {
  const lows=[...new Set(candles.map(x=>x.low))].sort((a,b)=>a-b);
  const highs=[...new Set(candles.map(x=>x.high))].sort((a,b)=>a-b);

  return {
    supports:lows.slice(0,8).sort((a,b)=>b-a),
    resistances:highs.slice(-8).sort((a,b)=>a-b)
  };
}

function structuralZone(candles,price) {
  const a=candles.slice(-20);
  if (!a.length || !price) return {low:0,high:0,type:"NONE"};

  const low=Math.min(...a.map(x=>x.low));
  const high=Math.max(...a.map(x=>x.high));

  return {
    low,
    high,
    mid:(low+high)/2,
    type:price >= (low+high)/2 ? "PREMIUM":"DISCOUNT"
  };
}

function blockTrades(list) {
  if (!list.length) return [];

  const values=list.map(x=>x.price*x.size).sort((a,b)=>a-b);
  const threshold=Math.max(avg(values)*5,values[Math.min(values.length-1,Math.floor(values.length*.95))]);

  return list.map(x=>({
    ...x,
    value:x.price*x.size,
    aggressor:aggressorSide(x)
  })).filter(x=>x.value>=threshold).sort((a,b)=>b.value-a.value).slice(0,50);
}

function candleSeries(candles, footprints) {
  const map=new Map(footprints.map(x=>[x.time,x]));
  let cumulativeDelta=0;

  return candles.map(c=>{
    const fp=map.get(c.time);
    cumulativeDelta += fp?.deltaValue ?? 0;

    return {
      ...c,
      flowVolume:fp?.flowVolume ?? 0,
      buyVolume:fp?.buyVolume ?? 0,
      sellVolume:fp?.sellVolume ?? 0,
      buyValue:fp?.buyValue ?? 0,
      sellValue:fp?.sellValue ?? 0,
      delta:fp?.delta ?? 0,
      deltaValue:fp?.deltaValue ?? 0,
      deltaPercent:fp?.deltaPercent ?? 0,
      tradeCount:fp?.tradeCount ?? 0,
      cumulativeDeltaValue:cumulativeDelta,
      footprint:fp?.levels ?? [],
      imbalances:fp?.imbalances ?? []
    };
  });
}

async function oiFunding(symbol) {
  try {
    const [t,oi,f]=await Promise.all([
      bybit("/v5/market/tickers",{category:"linear",symbol}),
      bybit("/v5/market/open-interest",{category:"linear",symbol,intervalTime:"5min",limit:50}),
      bybit("/v5/market/funding/history",{category:"linear",symbol,limit:10})
    ]);

    const ti=t?.result?.list?.[0]||{};

    const oh=(oi?.result?.list||[]).map(x=>({
      time:n(x.timestamp),
      oi:n(x.openInterest)
    })).sort((a,b)=>a.time-b.time);

    const fh=(f?.result?.list||[]).map(x=>({
      time:n(x.fundingRateTimestamp),
      fundingRate:n(x.fundingRate)
    })).sort((a,b)=>a.time-b.time);

    const currentOI=n(ti.openInterest)||oh.at(-1)?.oi||0;
    const previousOI=oh.at(-2)?.oi||currentOI;

    return {
      currentOI,
      previousOI,
      changePercent:pct(currentOI-previousOI,previousOI),
      fundingRate:n(ti.fundingRate)||fh.at(-1)?.fundingRate||0,
      oiHistory:oh,
      fundingHistory:fh
    };
  } catch {
    return {
      currentOI:0,
      previousOI:0,
      changePercent:0,
      fundingRate:0,
      oiHistory:[],
      fundingHistory:[]
    };
  }
}

/* =========================================================
   CHART
========================================================= */

async function buildChartData(symbol,interval=TF) {
  symbol=normalizeSymbol(symbol);
  interval=normalizeInterval(interval);

  const [candles,tick,book,tr,instrument]=await Promise.all([
    kline("linear",symbol,interval,CHART_LIMIT),
    ticker("linear",symbol),
    orderbook("linear",symbol,ORDERBOOK_LIMIT),
    trades("linear",symbol,TRADE_LIMIT),
    instrumentInfo("linear",symbol)
  ]);

  const footprints=buildFootprints(
    candles,
    tr,
    interval,
    instrument.tickSize||0
  );

  const chartCandles=candleSeries(candles,footprints);
  const currentFlow=flowFromTrades(tr);
  const wall=wallAnalysis(book);

  return {
    ok:true,
    version:VERSION,
    category:"linear",
    symbol,
    interval,
    intervalMs:intervalMs(interval),
    tickSize:instrument.tickSize||0,
    priceStep:instrument.tickSize||0,
    levelMode:"TICK",
    serverTime:Date.now(),
    price:tick.lastPrice,
    ticker:tick,
    candles:chartCandles,
    selectedCandles:chartCandles,
    footprints,
    footprint:footprints,
    candleDelta:chartCandles.map(x=>({
      time:x.time,
      buy:x.buyVolume,
      sell:x.sellVolume,
      delta:x.delta,
      deltaValue:x.deltaValue,
      deltaPercent:x.deltaPercent,
      trades:x.tradeCount,
      cumulativeDeltaValue:x.cumulativeDeltaValue
    })),
    currentFlow,
    historicalFlow:currentFlow,
    flow:currentFlow,
    orderbook:book,
    wall,
    heatmap:liquidityHeatmap(book),
    liquidityZones:liquidityZones(book,tick.lastPrice),
    sweep:detectSweep(candles),
    tradeSweep:detectTradeSweep(tr),
    absorption:detectAbsorption(candles,currentFlow,wall),
    blocks:blockTrades(tr),
    imbalances:footprints.flatMap(x=>
      (x.imbalances||[]).map(l=>({
        time:x.time,
        price:l.price,
        imbalance:l.imbalance,
        side:l.side,
        bidVolume:l.bidVolume,
        askVolume:l.askVolume,
        delta:l.delta,
        deltaValue:l.deltaValue
      }))
    ).slice(-500),
    trades:tr.slice(-250)
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyze(symbol,selectedInterval=TF) {
  symbol=normalizeSymbol(symbol);
  selectedInterval=normalizeInterval(selectedInterval);

  const intervals=new Set(["1","3","5","15",selectedInterval]);

  const candleRequests=[...intervals].map(i=>
    kline("linear",symbol,i,KLINE_LIMIT).then(c=>[i,c])
  );

  const [candlePairs,tick,book,tr,instrument]=await Promise.all([
    Promise.all(candleRequests),
    ticker("linear",symbol),
    orderbook("linear",symbol,ORDERBOOK_LIMIT),
    trades("linear",symbol,TRADE_LIMIT),
    instrumentInfo("linear",symbol)
  ]);

  const candleMap=new Map(candlePairs);
  const candles1=candleMap.get("1")||[];
  const candles3=candleMap.get("3")||[];
  const candles5=candleMap.get("5")||[];
  const candles15=candleMap.get("15")||[];
  const selected=candleMap.get(selectedInterval)||[];

  const tickSize=instrument.tickSize||0;

  /*
   * Footprint now ALWAYS belongs to the selected timeframe.
   */
  const selectedFootprints=buildFootprints(
    selected,
    tr,
    selectedInterval,
    tickSize
  );

  const selectedCandles=candleSeries(
    selected,
    selectedFootprints
  );

  const currentSelected=selected.at(-1);
  const currentStart=currentSelected?.time||0;
  const currentEnd=currentStart+intervalMs(selectedInterval)-1;

  const historicalFlow=flowFromTrades(tr,currentStart,currentEnd);
  const currentFlow=historicalFlow.tradeCount>=8
    ? historicalFlow
    : flowFromTrades(tr);

  const wall=wallAnalysis(book);
  const heatmap=liquidityHeatmap(book);
  const zones=liquidityZones(book,tick.lastPrice);
  const absorption=detectAbsorption(selected,currentFlow,wall);
  const sweep=detectSweep(selected);
  const tradeSweep=detectTradeSweep(tr);

  const structure1=structure(candles1);
  const structure3=structure(candles3);
  const structure5=structure(candles5);
  const structure15=structure(candles15);

  let score=50;

  if(structure15.direction==="BUY") score+=10;
  if(structure15.direction==="SELL") score-=10;
  if(structure5.direction==="BUY") score+=8;
  if(structure5.direction==="SELL") score-=8;
  if(currentFlow.deltaPercent>10) score+=10;
  if(currentFlow.deltaPercent<-10) score-=10;
  if(wall.pressure==="BUY_PRESSURE") score+=7;
  if(wall.pressure==="SELL_PRESSURE") score-=7;
  if(absorption.detected&&absorption.side==="BUY") score+=8;
  if(absorption.detected&&absorption.side==="SELL") score-=8;
  if(sweep.detected&&sweep.side==="BUY") score+=5;
  if(sweep.detected&&sweep.side==="SELL") score-=5;

  score=Math.round(clamp(score,0,100));

  const signal=score>=70?"BUY":score<=30?"SELL":"WAIT";
  const reasons=[];

  if(currentFlow.deltaPercent>10) reasons.push("فشار خرید در معاملات واقعی");
  if(currentFlow.deltaPercent<-10) reasons.push("فشار فروش در معاملات واقعی");
  if(wall.pressure==="BUY_PRESSURE") reasons.push("برتری نقدینگی سمت Bid");
  if(wall.pressure==="SELL_PRESSURE") reasons.push("برتری نقدینگی سمت Ask");
  if(absorption.detected) reasons.push(`Absorption ${absorption.side}`);
  if(sweep.detected) reasons.push(`Sweep ${sweep.side}`);

  return {
    ok:true,
    version:VERSION,
    category:"linear",
    symbol,
    interval:selectedInterval,
    intervalMs:intervalMs(selectedInterval),
    tickSize,
    priceStep:tickSize,
    levelMode:"TICK",
    serverTime:Date.now(),
    price:tick.lastPrice,
    ticker:tick,

    candles:{
      tf1:candles1,
      tf3:candles3,
      tf5:candles5,
      tf15:candles15
    },

    selectedCandles,

    /*
     * Correct selected timeframe footprint.
     */
    footprint:{
      interval:selectedInterval,
      intervalMs:intervalMs(selectedInterval),
      tickSize,
      levelMode:"TICK",
      candles:selectedFootprints,
      cumulativeDeltaValue:selectedFootprints.reduce(
        (s,x)=>s+(x.deltaValue||0),0
      )
    },

    footprints:selectedFootprints,

    candleDelta:selectedCandles.map(x=>({
      time:x.time,
      buy:x.buyVolume,
      sell:x.sellVolume,
      delta:x.delta,
      deltaValue:x.deltaValue,
      deltaPercent:x.deltaPercent,
      trades:x.tradeCount,
      cumulativeDeltaValue:x.cumulativeDeltaValue
    })),

    cumulativeDelta:selectedFootprints.reduce(
      (s,x)=>s+(x.deltaValue||0),0
    ),

    orderbook:book,
    wall,
    heatmap,
    liquidityZones:zones,
    trades:tr.slice(-250),
    currentFlow,
    historicalFlow,
    flow:currentFlow,
    absorption,
    blocks:blockTrades(tr),
    sweep,
    tradeSweep,

    structure:{
      tf1:structure1,
      tf3:structure3,
      tf5:structure5,
      tf15:structure15
    },

    timeframes:{
      tf1:structure1,
      tf3:structure3,
      tf5:structure5,
      tf15:structure15
    },

    supportResistance:supportResistance(selected),
    movement:movement(selected),
    pressure:pressureFromFlow(currentFlow),
    oiFunding:await oiFunding(symbol),
    entry1m:entry1m(candles1),
    zone:structuralZone(selected,tick.lastPrice),
    score,
    signal,
    reasons
  };
}

/* =========================================================
   LIVE
========================================================= */

async function live(symbol,interval=TF) {
  symbol=normalizeSymbol(symbol);
  interval=normalizeInterval(interval);

  const [candles,tick,book,tr,instrument]=await Promise.all([
    kline("linear",symbol,interval,CHART_LIMIT),
    ticker("linear",symbol),
    orderbook("linear",symbol,ORDERBOOK_LIMIT),
    trades("linear",symbol,TRADE_LIMIT),
    instrumentInfo("linear",symbol)
  ]);

  const footprints=buildFootprints(
    candles,
    tr,
    interval,
    instrument.tickSize||0
  );

  const candleFlow=candleSeries(candles,footprints);
  const currentFlow=flowFromTrades(tr);
  const wall=wallAnalysis(book);

  return {
    ok:true,
    version:VERSION,
    category:"linear",
    symbol,
    interval,
    intervalMs:intervalMs(interval),
    tickSize:instrument.tickSize||0,
    priceStep:instrument.tickSize||0,
    levelMode:"TICK",
    serverTime:Date.now(),
    price:tick.lastPrice,
    ticker:tick,
    candles:candleFlow,
    selectedCandles:candleFlow,
    candleFlow,
    footprints,
    footprint:footprints,
    candleDelta:candleFlow.map(x=>({
      time:x.time,
      buy:x.buyVolume,
      sell:x.sellVolume,
      delta:x.delta,
      deltaValue:x.deltaValue,
      deltaPercent:x.deltaPercent,
      trades:x.tradeCount,
      cumulativeDeltaValue:x.cumulativeDeltaValue
    })),
    cumulativeDelta:footprints.reduce((s,x)=>s+(x.deltaValue||0),0),
    orderbook:book,
    wall,
    heatmap:liquidityHeatmap(book),
    liquidityZones:liquidityZones(book,tick.lastPrice),
    sweep:detectSweep(candles),
    tradeSweep:detectTradeSweep(tr),
    absorption:detectAbsorption(candles,currentFlow,wall),
    blocks:blockTrades(tr),
    trades:tr.slice(-250),
    flow:currentFlow,
    currentFlow
  };
}

/* =========================================================
   SCAN
========================================================= */

async function getSymbols() {
  const d=await bybit("/v5/market/instruments-info",{
    category:"linear",
    limit:1000
  });

  return (d?.result?.list||[])
    .filter(x =>
      x.status==="Trading" &&
      x.quoteCoin==="USDT" &&
      x.contractType==="LinearPerpetual"
    )
    .map(x=>({
      symbol:x.symbol,
      baseCoin:x.baseCoin,
      quoteCoin:x.quoteCoin,
      tickSize:n(x.priceFilter?.tickSize),
      qtyStep:n(x.lotSizeFilter?.qtyStep)
    }))
    .slice(0,MAX_SYMBOLS);
}

async function scan(offset=0) {
  const symbols=await getSymbols();
  const start=Number(offset)||0;
  const batch=symbols.slice(start,start+SCAN_BATCH);
  const results=[];

  for(const item of batch) {
    try {
      const x=await analyze(item.symbol,TF);

      if(Number(x.score)>=55) {
        results.push({
          symbol:item.symbol,
          score:x.score,
          signal:x.signal,
          price:x.price,
          pressure:x.pressure,
          movement:x.movement,
          structure:x.structure,
          delta:x.currentFlow?.delta||0,
          deltaPercent:x.currentFlow?.deltaPercent||0,
          absorption:x.absorption,
          sweep:x.sweep
        });
      }
    } catch(e) {}

    await sleep(20);
  }

  return {
    ok:true,
    version:VERSION,
    offset:start,
    nextOffset:start+SCAN_BATCH>=symbols.length?0:start+SCAN_BATCH,
    totalSymbols:symbols.length,
    results:results.sort((a,b)=>b.score-a.score)
  };
}

/* =========================================================
   COLLECTOR
========================================================= */

function minuteStart(ts) {
  return Math.floor(n(ts)/60000)*60000;
}

function newMinute(symbol,ts) {
  return {
    symbol,
    time:minuteStart(ts),
    open:0,
    high:0,
    low:0,
    close:0,
    volume:0,
    turnover:0,
    buyVolume:0,
    sellVolume:0,
    buyValue:0,
    sellValue:0,
    buyTrades:0,
    sellTrades:0,
    delta:0,
    deltaValue:0,
    cumulativeDelta:0,
    levels:{},
    blocks:[],
    liquidations:{
      buy:0,
      sell:0,
      buyValue:0,
      sellValue:0,
      count:0
    },
    bestBid:0,
    bestAsk:0,
    bidLiquidity:0,
    askLiquidity:0,
    maxBidLiquidity:0,
    maxAskLiquidity:0,
    snapshotCount:0,
    lastTradeTime:0
  };
}

function ensureMinuteLevel(minute,price) {
  const key=String(Number(price));

  if(!minute.levels[key]) {
    minute.levels[key]={
      price:Number(price),
      bidVolume:0,
      askVolume:0,
      bidValue:0,
      askValue:0,
      bidTrades:0,
      askTrades:0,
      totalVolume:0,
      totalValue:0,
      delta:0,
      deltaValue:0
    };
  }

  return minute.levels[key];
}

function addTradeToMinute(minute,trade) {
  const price=n(trade.price);
  const size=n(trade.size);
  if(price<=0||size<=0)return;

  const value=price*size;

  if(!minute.open) {
    minute.open=price;
    minute.high=price;
    minute.low=price;
  }

  minute.high=Math.max(minute.high,price);
  minute.low=Math.min(minute.low,price);
  minute.close=price;
  minute.volume+=size;
  minute.turnover+=value;
  minute.lastTradeTime=n(trade.time);

  const level=ensureMinuteLevel(minute,price);

  level.totalVolume+=size;
  level.totalValue+=value;

  if(aggressorSide(trade)==="BUY") {
    minute.buyVolume+=size;
    minute.buyValue+=value;
    minute.buyTrades++;
    level.askVolume+=size;
    level.askValue+=value;
    level.askTrades++;
  } else if(aggressorSide(trade)==="SELL") {
    minute.sellVolume+=size;
    minute.sellValue+=value;
    minute.sellTrades++;
    level.bidVolume+=size;
    level.bidValue+=value;
    level.bidTrades++;
  }

  level.delta=level.askVolume-level.bidVolume;
  level.deltaValue=level.askValue-level.bidValue;
  minute.delta=minute.buyVolume-minute.sellVolume;
  minute.deltaValue=minute.buyValue-minute.sellValue;
}

function finalizeMinute(minute) {
  if(!minute)return null;

  const levels=Object.values(minute.levels||{})
    .map(x=>({
      ...x,
      imbalance:x.bidVolume>0
        ? x.askVolume/x.bidVolume
        : x.askVolume>0?Infinity:0,
      side:x.askVolume>x.bidVolume
        ?"BUY"
        :x.bidVolume>x.askVolume
          ?"SELL"
          :"NEUTRAL"
    }))
    .sort((a,b)=>b.price-a.price)
    .slice(0,FOOTPRINT_MAX_LEVELS);

  const total=minute.buyVolume+minute.sellVolume;

  return {
    ...minute,
    delta:minute.buyVolume-minute.sellVolume,
    deltaValue:minute.buyValue-minute.sellValue,
    deltaPercent:pct(minute.buyVolume-minute.sellVolume,total),
    buyShare:pct(minute.buyVolume,total),
    sellShare:pct(minute.sellVolume,total),
    tradeCount:minute.buyTrades+minute.sellTrades,
    levels,
    footprints:levels
  };
}

export class CollectorDO extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);

    this.ctx=ctx;
    this.env=env;
    this.sockets=new Map();
    this.books=new Map();
    this.minutes=new Map();
    this.reconnectTimers=new Map();
    this.wsState=new Map();
    this.initialized=false;
    this.symbols=[];
    this.initializing=null;
    this.ready=this.initDatabase();
  }

  async initDatabase() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS minutes (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(symbol,ts)
      );
      CREATE INDEX IF NOT EXISTS idx_minutes_symbol_ts
      ON minutes(symbol,ts);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  async fetch(request) {
    await this.ready;

    const url=new URL(request.url);
    const path=url.pathname;

    try {
      if(request.method==="OPTIONS")
        return new Response(null,{status:204,headers:{
          "access-control-allow-origin":"*",
          "access-control-allow-methods":"GET,POST,OPTIONS",
          "access-control-allow-headers":"*"
        }});

      if(path==="/init")return json(await this.initCollector());
      if(path==="/status")return json(this.status());

      if(path==="/symbols") {
        if(!this.symbols.length)await this.loadSymbols();
        return json({ok:true,version:VERSION,symbols:this.symbols});
      }

      if(path==="/history") {
        const symbol=normalizeSymbol(url.searchParams.get("symbol"));
        const minutes=clamp(Number(url.searchParams.get("minutes")||300),1,RETENTION_MINUTES);
        return json({
          ok:true,
          version:VERSION,
          symbol,
          minutes,
          data:this.readHistory(symbol,minutes)
        });
      }

      if(path==="/latest") {
        const symbol=normalizeSymbol(url.searchParams.get("symbol"));
        return json({
          ok:true,
          version:VERSION,
          symbol,
          data:this.getLatestMemory(symbol)
        });
      }

      if(path==="/chart") {
        const symbol=normalizeSymbol(url.searchParams.get("symbol"));
        const interval=normalizeInterval(url.searchParams.get("interval")||TF);

        /*
         * Collector stores 1m data only.
         * Therefore aggregate to the requested timeframe.
         */
        return json(this.collectorChart(symbol,interval));
      }

      if(path==="/cleanup")
        return json({ok:true,version:VERSION,removed:this.cleanup()});

      return json({ok:false,error:"Collector route not found"},404);
    } catch(e) {
      return json({ok:false,version:VERSION,error:e?.message||String(e)},500);
    }
  }

  async initCollector() {
    if(this.initializing)return this.initializing;

    this.initializing=(async()=>{
      await this.loadSymbols();

      if(!this.initialized) {
        await this.startSockets();
        this.initialized=true;
      }

      return {
        ok:true,
        version:VERSION,
        initialized:true,
        symbolCount:this.symbols.length,
        sockets:this.sockets.size
      };
    })();

    try {
      return await this.initializing;
    } finally {
      this.initializing=null;
    }
  }

  async loadSymbols() {
    const d=await bybit("/v5/market/instruments-info",{
      category:"linear",
      limit:1000
    });

    this.symbols=(d?.result?.list||[])
      .filter(x =>
        x.status==="Trading" &&
        x.quoteCoin==="USDT" &&
        x.contractType==="LinearPerpetual"
      )
      .map(x=>x.symbol)
      .slice(0,MAX_SYMBOLS);

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO meta(key,value) VALUES('symbols',?)`,
      JSON.stringify(this.symbols)
    );

    return this.symbols;
  }

  async startSockets() {
    const shardSize=Math.ceil(this.symbols.length/6);

    for(let i=0;i<this.symbols.length;i+=shardSize) {
      this.connectShard(
        Math.floor(i/shardSize),
        this.symbols.slice(i,i+shardSize),
        0
      );
    }
  }

  connectShard(shardId,symbols,attempt=0) {
    try {
      this.sockets.get(shardId)?.close();
    } catch {}

    let ws;

    try {
      ws=new WebSocket(BYBIT_WS);
    } catch {
      this.scheduleReconnect(shardId,symbols,attempt);
      return;
    }

    this.sockets.set(shardId,ws);
    this.wsState.set(shardId,{
      connected:false,
      attempt,
      openedAt:0,
      messages:0,
      errors:0
    });

    ws.addEventListener("open",()=>{
      const state=this.wsState.get(shardId);

      if(state) {
        state.connected=true;
        state.attempt=0;
        state.openedAt=Date.now();
      }

      const topics=[];

      for(const symbol of symbols) {
        topics.push(`publicTrade.${symbol}`);
        topics.push(`orderbook.50.${symbol}`);
        topics.push(`allLiquidation.${symbol}`);
      }

      for(let i=0;i<topics.length;i+=WS_SUB_CHUNK) {
        try {
          ws.send(JSON.stringify({
            op:"subscribe",
            args:topics.slice(i,i+WS_SUB_CHUNK)
          }));
        } catch {}
      }
    });

    ws.addEventListener("message",e=>{
      const s=this.wsState.get(shardId);
      if(s)s.messages++;
      this.handleWSMessage(e.data);
    });

    ws.addEventListener("error",()=>{
      const s=this.wsState.get(shardId);
      if(s)s.errors++;
    });

    ws.addEventListener("close",()=>{
      const s=this.wsState.get(shardId);
      if(s)s.connected=false;
      this.sockets.delete(shardId);
      this.scheduleReconnect(shardId,symbols,s?.attempt||attempt);
    });
  }

  scheduleReconnect(shardId,symbols,attempt) {
    if(this.reconnectTimers.has(shardId))return;

    const delay=Math.min(
      WS_RECONNECT_MAX,
      WS_RECONNECT_MIN*Math.pow(2,Math.min(attempt,6))
    );

    const timer=setTimeout(()=>{
      this.reconnectTimers.delete(shardId);
      this.connectShard(shardId,symbols,attempt+1);
    },delay);

    this.reconnectTimers.set(shardId,timer);
  }

  handleWSMessage(raw) {
    let msg;

    try {
      msg=typeof raw==="string"
        ?JSON.parse(raw)
        :JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return;
    }

    const topic=String(msg?.topic||"");
    if(!topic)return;

    if(topic.startsWith("publicTrade.")) {
      const symbol=topic.replace("publicTrade.","");

      for(const x of Array.isArray(msg.data)?msg.data:[]) {
        const trade={
          id:x.i||x.execId||`${x.T}-${x.p}-${x.v}`,
          time:n(x.T),
          price:n(x.p),
          size:n(x.v),
          side:String(x.S||"").toUpperCase(),
          isBlockTrade:x.isBlockTrade===true||x.isBlockTrade==="true",
          isRPITrade:x.isRPITrade===true||x.isRPITrade==="true"
        };

        if(
          trade.time>0&&
          trade.price>0&&
          trade.size>0&&
          (trade.side==="BUY"||trade.side==="SELL")
        ) {
          this.addTrade(symbol,trade);
        }
      }

      return;
    }

    if(topic.startsWith("orderbook.")) {
      this.updateBook(topic.split(".").at(-1),msg);
      return;
    }

    if(topic.startsWith("allLiquidation.")) {
      const symbol=topic.replace("allLiquidation.","");
      const rows=Array.isArray(msg.data)?msg.data:msg.data?[msg.data]:[];

      for(const x of rows)this.addLiquidation(symbol,x);
    }
  }

  addTrade(symbol,trade) {
    const minute=minuteStart(trade.time);
    let current=this.minutes.get(symbol);

    if(current&&current.time!==minute) {
      this.flushMinute(symbol);
      current=null;
    }

    if(!current) {
      current=newMinute(symbol,minute);
      this.minutes.set(symbol,current);
    }

    addTradeToMinute(current,trade);

    if(trade.isBlockTrade||trade.price*trade.size>100000) {
      current.blocks.push({
        id:trade.id,
        time:trade.time,
        price:trade.price,
        size:trade.size,
        value:trade.price*trade.size,
        side:trade.side
      });

      if(current.blocks.length>100)
        current.blocks=current.blocks.slice(-100);
    }

    this.maybeFlush(symbol);
  }

  addLiquidation(symbol,x) {
    const time=n(x.T||x.time||Date.now());
    const minute=minuteStart(time);

    let current=this.minutes.get(symbol);

    if(current&&current.time!==minute) {
      this.flushMinute(symbol);
      current=null;
    }

    if(!current) {
      current=newMinute(symbol,minute);
      this.minutes.set(symbol,current);
    }

    const side=String(x.S||x.side||x.sideType||"").toUpperCase();
    const price=n(x.p||x.price);
    const size=n(x.v||x.size);
    const value=price*size;

    if(side==="BUY") {
      current.liquidations.buy+=size;
      current.liquidations.buyValue+=value;
    } else if(side==="SELL") {
      current.liquidations.sell+=size;
      current.liquidations.sellValue+=value;
    }

    current.liquidations.count++;
    this.maybeFlush(symbol);
  }

  updateBook(symbol,msg) {
    let book=this.books.get(symbol);

    if(!book) {
      book={
        bids:new Map(),
        asks:new Map(),
        bestBid:0,
        bestAsk:0,
        sequence:0,
        updateId:0,
        lastSnapshot:0,
        lastUpdate:0
      };
      this.books.set(symbol,book);
    }

    const data=msg?.data||{};

    if(msg?.type==="snapshot") {
      book.bids.clear();
      book.asks.clear();
    }

    for(const row of data.b||[]) {
      const price=n(row[0]);
      const size=n(row[1]);
      if(price<=0)continue;
      if(size<=0)book.bids.delete(price);
      else book.bids.set(price,size);
    }

    for(const row of data.a||[]) {
      const price=n(row[0]);
      const size=n(row[1]);
      if(price<=0)continue;
      if(size<=0)book.asks.delete(price);
      else book.asks.set(price,size);
    }

    book.sequence=n(data.u||data.seq||data.updateId||msg?.cs);
    book.updateId=n(data.u||data.updateId);
    book.lastUpdate=Date.now();

    const bids=[...book.bids.entries()]
      .sort((a,b)=>b[0]-a[0])
      .slice(0,ORDERBOOK_LIMIT);

    const asks=[...book.asks.entries()]
      .sort((a,b)=>a[0]-b[0])
      .slice(0,ORDERBOOK_LIMIT);

    book.bestBid=bids[0]?.[0]||0;
    book.bestAsk=asks[0]?.[0]||0;

    if(Date.now()-book.lastSnapshot>=ORDERBOOK_SNAPSHOT_MS) {
      book.lastSnapshot=Date.now();
      this.captureBook(symbol,bids,asks);
    }
  }

  captureBook(symbol,bids,asks) {
    const current=this.minutes.get(symbol);
    if(!current)return;

    const bidLiquidity=bids.reduce((s,x)=>s+x[0]*x[1],0);
    const askLiquidity=asks.reduce((s,x)=>s+x[0]*x[1],0);

    current.bestBid=bids[0]?.[0]||current.bestBid;
    current.bestAsk=asks[0]?.[0]||current.bestAsk;
    current.bidLiquidity=bidLiquidity;
    current.askLiquidity=askLiquidity;
    current.maxBidLiquidity=Math.max(current.maxBidLiquidity,bidLiquidity);
    current.maxAskLiquidity=Math.max(current.maxAskLiquidity,askLiquidity);
    current.snapshotCount++;

    current.book={
      bids:bids.map(x=>({price:x[0],size:x[1],value:x[0]*x[1]})),
      asks:asks.map(x=>({price:x[0],size:x[1],value:x[0]*x[1]})),
      bestBid:current.bestBid,
      bestAsk:current.bestAsk,
      timestamp:Date.now()
    };
  }

  maybeFlush(symbol) {
    const current=this.minutes.get(symbol);
    if(current&&Date.now()-current.time>=120000)
      this.flushMinute(symbol);
  }

  flushMinute(symbol) {
    const minute=this.minutes.get(symbol);
    if(!minute)return;

    const finalized=finalizeMinute(minute);
    if(!finalized)return;

    try {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO minutes(symbol,ts,data) VALUES(?,?,?)`,
        symbol,
        finalized.time,
        JSON.stringify(finalized)
      );
    } catch {}

    this.minutes.delete(symbol);
    this.cleanupSymbol(symbol);
  }

  readHistory(symbol,minutes=300) {
    const limit=clamp(Number(minutes),1,RETENTION_MINUTES);
    const cutoff=Date.now()-limit*60000;
    const rows=[];

    try {
      const result=this.ctx.storage.sql.exec(
        `SELECT data FROM minutes WHERE symbol=? AND ts>=? ORDER BY ts ASC LIMIT ?`,
        symbol,cutoff,limit
      );

      for(const row of result) {
        try { rows.push(JSON.parse(row.data)); } catch {}
      }
    } catch {}

    const current=this.minutes.get(symbol);

    if(current) {
      const x=finalizeMinute(current);
      if(x&&x.time>=cutoff)rows.push(x);
    }

    const map=new Map();

    for(const x of rows)map.set(x.time,x);

    return [...map.values()].sort((a,b)=>a.time-b.time);
  }

  getLatestMemory(symbol) {
    return {
      current:this.minutes.get(symbol)
        ?finalizeMinute(this.minutes.get(symbol))
        :null,
      stored:this.readHistory(symbol,1).at(-1)||null,
      book:this.bookJSON(symbol)
    };
  }

  bookJSON(symbol) {
    const book=this.books.get(symbol);

    if(!book)
      return {bids:[],asks:[],bestBid:0,bestAsk:0,timestamp:0};

    return {
      bids:[...book.bids.entries()]
        .sort((a,b)=>b[0]-a[0])
        .slice(0,ORDERBOOK_LIMIT)
        .map(x=>({price:x[0],size:x[1],value:x[0]*x[1]})),

      asks:[...book.asks.entries()]
        .sort((a,b)=>a[0]-b[0])
        .slice(0,ORDERBOOK_LIMIT)
        .map(x=>({price:x[0],size:x[1],value:x[0]*x[1]})),

      bestBid:book.bestBid,
      bestAsk:book.bestAsk,
      timestamp:book.lastUpdate
    };
  }

  /*
   * Converts stored 1-minute collector candles into
   * the requested timeframe.
   */
  aggregateRows(rows,interval) {
    const ms=intervalMs(interval);
    const groups=new Map();

    for(const row of rows) {
      const t=Math.floor(row.time/ms)*ms;
      let g=groups.get(t);

      if(!g) {
        g={
          time:t,
          open:row.open,
          high:row.high,
          low:row.low,
          close:row.close,
          volume:0,
          turnover:0,
          buyVolume:0,
          sellVolume:0,
          buyValue:0,
          sellValue:0,
          buyTrades:0,
          sellTrades:0,
          levels:{},
          blocks:[],
          liquidations:{
            buy:0,
            sell:0,
            buyValue:0,
            sellValue:0,
            count:0
          }
        };
        groups.set(t,g);
      }

      g.high=Math.max(g.high,row.high||g.high);
      g.low=Math.min(g.low,row.low||g.low);
      g.close=row.close||g.close;
      g.volume+=row.volume||0;
      g.turnover+=row.turnover||0;
      g.buyVolume+=row.buyVolume||0;
      g.sellVolume+=row.sellVolume||0;
      g.buyValue+=row.buyValue||0;
      g.sellValue+=row.sellValue||0;
      g.buyTrades+=row.buyTrades||0;
      g.sellTrades+=row.sellTrades||0;

      for(const level of row.levels||[]) {
        const key=String(level.price);

        if(!g.levels[key]) {
          g.levels[key]={
            price:level.price,
            bidVolume:0,
            askVolume:0,
            bidValue:0,
            askValue:0,
            bidTrades:0,
            askTrades:0,
            totalVolume:0,
            totalValue:0
          };
        }

        const l=g.levels[key];

        l.bidVolume+=level.bidVolume||0;
        l.askVolume+=level.askVolume||0;
        l.bidValue+=level.bidValue||0;
        l.askValue+=level.askValue||0;
        l.bidTrades+=level.bidTrades||0;
        l.askTrades+=level.askTrades||0;
        l.totalVolume+=level.totalVolume||0;
        l.totalValue+=level.totalValue||0;
      }

      g.blocks.push(...(row.blocks||[]));
      g.liquidations.buy+=row.liquidations?.buy||0;
      g.liquidations.sell+=row.liquidations?.sell||0;
      g.liquidations.buyValue+=row.liquidations?.buyValue||0;
      g.liquidations.sellValue+=row.liquidations?.sellValue||0;
      g.liquidations.count+=row.liquidations?.count||0;
    }

    return [...groups.values()].sort((a,b)=>a.time-b.time).map(g=>{
      const levels=Object.values(g.levels)
        .map(x=>({
          ...x,
          delta:x.askVolume-x.bidVolume,
          deltaValue:x.askValue-x.bidValue,
          imbalance:x.bidVolume>0
            ?x.askVolume/x.bidVolume
            :x.askVolume>0?Infinity:0,
          side:x.askVolume>x.bidVolume
            ?"BUY"
            :x.bidVolume>x.askVolume
              ?"SELL"
              :"NEUTRAL"
        }))
        .sort((a,b)=>b.price-a.price)
        .slice(0,FOOTPRINT_MAX_LEVELS);

      const total=g.buyVolume+g.sellVolume;
      const delta=g.buyVolume-g.sellVolume;
      const deltaValue=g.buyValue-g.sellValue;

      return {
        ...g,
        delta,
        deltaValue,
        deltaPercent:pct(delta,total),
        buyShare:pct(g.buyVolume,total),
        sellShare:pct(g.sellVolume,total),
        tradeCount:g.buyTrades+g.sellTrades,
        flowVolume:total,
        totalValue:g.buyValue+g.sellValue,
        levels,
        footprints:levels,
        footprint:levels
      };
    });
  }

  collectorChart(symbol,interval) {
    /*
     * Enough 1m history is read to build 180 requested candles.
     */
    const sourceMinutes=Math.min(
      RETENTION_MINUTES,
      Math.max(
        180*Number(interval),
        300
      )
    );

    const rows=this.readHistory(symbol,sourceMinutes);
    const grouped=this.aggregateRows(rows,interval);
    const candles=grouped.slice(-CHART_LIMIT);

    let cumulative=0;

    const chartCandles=candles.map(x=>{
      cumulative+=x.deltaValue||0;

      return {
        time:x.time,
        open:x.open,
        high:x.high,
        low:x.low,
        close:x.close,
        volume:x.volume,
        flowVolume:x.flowVolume,
        buyVolume:x.buyVolume,
        sellVolume:x.sellVolume,
        buyValue:x.buyValue,
        sellValue:x.sellValue,
        delta:x.delta,
        deltaValue:x.deltaValue,
        deltaPercent:x.deltaPercent,
        tradeCount:x.tradeCount,
        cumulativeDeltaValue:cumulative,
        footprint:x.levels||[],
        imbalances:(x.levels||[]).filter(l =>
          l.imbalance>=3 ||
          (l.bidVolume>0&&l.askVolume/l.bidVolume<=1/3)
        )
      };
    });

    const book=this.bookJSON(symbol);

    return {
      ok:true,
      version:VERSION,
      category:"linear",
      symbol,
      interval,
      intervalMs:intervalMs(interval),
      source:"COLLECTOR_AGGREGATED_1M",
      serverTime:Date.now(),
      candles:chartCandles,
      selectedCandles:chartCandles,
      footprints:candles.map(x=>({
        ...x,
        levels:x.levels||[]
      })),
      candleDelta:chartCandles.map(x=>({
        time:x.time,
        buy:x.buyVolume,
        sell:x.sellVolume,
        delta:x.delta,
        deltaValue:x.deltaValue,
        deltaPercent:x.deltaPercent,
        trades:x.tradeCount,
        cumulativeDeltaValue:x.cumulativeDeltaValue
      })),
      orderbook:book,
      heatmap:liquidityHeatmap(book),
      wall:wallAnalysis(book),
      liquidityZones:liquidityZones(book,book.bestBid),
      current:candles.at(-1)||null
    };
  }

  cleanupSymbol(symbol) {
    const cutoff=Date.now()-RETENTION_MINUTES*60000;

    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM minutes WHERE symbol=? AND ts<?`,
        symbol,
        cutoff
      );
    } catch {}
  }

  cleanup() {
    const cutoff=Date.now()-RETENTION_MINUTES*60000;

    try {
      const result=this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS c FROM minutes WHERE ts<?`,
        cutoff
      );

      const count=n(result?.one?.()?.c||0);

      this.ctx.storage.sql.exec(
        `DELETE FROM minutes WHERE ts<?`,
        cutoff
      );

      return count;
    } catch {
      return 0;
    }
  }

  status() {
    let minuteCount=0;

    try {
      minuteCount=n(
        this.ctx.storage.sql
          .exec(`SELECT COUNT(*) AS c FROM minutes`)
          ?.one?.()?.c||0
      );
    } catch {}

    return {
      ok:true,
      version:VERSION,
      initialized:this.initialized,
      symbols:this.symbols.length,
      activeBooks:this.books.size,
      activeMinutes:this.minutes.size,
      storedMinutes:minuteCount,
      sockets:[...this.wsState.entries()].map(([shard,state])=>({
        shard,
        ...state
      })),
      time:Date.now()
    };
  }
}

/* =========================================================
   COLLECTOR ACCESS
========================================================= */

function collectorId(env) {
  return env.COLLECTOR.idFromName("MAIN");
}

function collectorStub(env) {
  return env.COLLECTOR.get(collectorId(env));
}

async function collectorFetch(env,path,params={}) {
  const u=new URL("https://collector.internal"+path);

  for(const [k,v] of Object.entries(params)) {
    if(v!==undefined&&v!==null&&v!=="")
      u.searchParams.set(k,String(v));
  }

  return collectorStub(env).fetch(new Request(u.toString()));
}

/* =========================================================
   MAIN
========================================================= */

export default {
  async fetch(request,env,ctx) {
    if(request.method==="OPTIONS") {
      return new Response(null,{
        status:204,
        headers:{
          "access-control-allow-origin":"*",
          "access-control-allow-methods":"GET,POST,OPTIONS",
          "access-control-allow-headers":"*"
        }
      });
    }

    const url=new URL(request.url);
    const path=url.pathname;

    try {
      if(path==="/api/health") {
        let collector=null;

        try {
          const r=await collectorFetch(env,"/status");
          collector=await r.json();
        } catch(e) {
          collector={ok:false,error:e?.message||String(e)};
        }

        return json({
          ok:true,
          version:VERSION,
          service:"Bybit Smart Money Order Flow",
          collector,
          time:Date.now()
        });
      }

      if(path==="/api/test-bybit") {
        return json({
          ok:true,
          version:VERSION,
          bybit:await bybit("/v5/market/time"),
          time:Date.now()
        });
      }

      if(path==="/api/collector/init"||path==="/api/init") {
        const r=await collectorFetch(env,"/init");
        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/collector/status"||path==="/api/status") {
        const r=await collectorFetch(env,"/status");
        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/history") {
        const r=await collectorFetch(env,"/history",{
          symbol:normalizeSymbol(url.searchParams.get("symbol")),
          minutes:url.searchParams.get("minutes")||"300"
        });

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/latest") {
        const r=await collectorFetch(env,"/latest",{
          symbol:normalizeSymbol(url.searchParams.get("symbol"))
        });

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/collector/chart") {
        const r=await collectorFetch(env,"/chart",{
          symbol:normalizeSymbol(url.searchParams.get("symbol")),
          interval:normalizeInterval(url.searchParams.get("interval")||TF)
        });

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/collector/symbols") {
        const r=await collectorFetch(env,"/symbols");

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/collector/cleanup") {
        const r=await collectorFetch(env,"/cleanup");

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/analyze") {
        const symbol=url.searchParams.get("symbol");
        if(!symbol)
          return json({ok:false,error:"symbol required"},400);

        return json(await analyze(
          symbol,
          normalizeInterval(url.searchParams.get("interval")||TF)
        ));
      }

      if(path==="/api/chart") {
        const symbol=url.searchParams.get("symbol");
        if(!symbol)
          return json({ok:false,error:"symbol required"},400);

        const interval=normalizeInterval(
          url.searchParams.get("interval")||TF
        );

        /*
         * REST Bybit is the source for the requested timeframe.
         * Collector is used only as fallback because its historical
         * raw data is 1m and may have incomplete early history.
         */
        try {
          const result=await buildChartData(symbol,interval);

          if(result?.candles?.length)
            return json(result);
        } catch {}

        const r=await collectorFetch(env,"/chart",{
          symbol:normalizeSymbol(symbol),
          interval
        });

        return new Response(await r.text(),{
          status:r.status,
          headers:r.headers
        });
      }

      if(path==="/api/live") {
        const symbol=url.searchParams.get("symbol");
        if(!symbol)
          return json({ok:false,error:"symbol required"},400);

        return json(await live(
          symbol,
          normalizeInterval(url.searchParams.get("interval")||TF)
        ));
      }

      if(path==="/api/scan") {
        return json(await scan(
          Number(url.searchParams.get("offset")||0)
        ));
      }

      if(path==="/api/symbols") {
        return json({
          ok:true,
          version:VERSION,
          symbols:await getSymbols()
        });
      }

      if(env?.ASSETS?.fetch)
        return env.ASSETS.fetch(request);

      return new Response("Not Found",{status:404});
    } catch(error) {
      return json({
        ok:false,
        version:VERSION,
        error:error?.message||String(error)
      },500);
    }
  }
};
