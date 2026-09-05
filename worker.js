const VERSION = "ORDERFLOW-ROOT-V1";
const BYBIT = "https://api.bybit.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TF = {
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

function text(data, status = 200, type = "text/plain") {
  return new Response(data, {
    status,
    headers: {
      ...CORS,
      "Content-Type": `${type}; charset=utf-8`
    }
  });
}

function normalizeCategory(value) {
  return value === "spot" ? "spot" : "linear";
}

function normalizeInterval(value) {
  return TF[String(value)] ? String(value) : "1";
}

function normalizeSymbol(value) {
  let s = String(value || "BTCUSDT")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s) s = "BTCUSDT";

  return s;
}

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data;
}

function decimals(step) {
  const s = String(step);

  if (!s.includes(".")) return 0;

  return s
    .replace(/0+$/, "")
    .split(".")[1]?.length || 0;
}

function roundToStep(price, step) {
  const n = Number(price);
  const s = Number(step);

  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(s) || s <= 0) return n;

  return Number((Math.round(n / s) * s).toFixed(decimals(s)));
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

async function getInstrument(category, symbol) {
  const data = await bybit("/v5/market/instruments-info", {
    category,
    symbol
  });

  return data.result?.list?.[0] || null;
}

async function getKlines(category, symbol, interval, limit = 1000, end = null) {
  const params = {
    category,
    symbol,
    interval,
    limit
  };

  if (end) {
    params.end = end;
  }

  const data = await bybit("/v5/market/kline", params);

  return parseKlines(data.result?.list || []);
}

async function getOrderbook(category, symbol, limit = 50) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit
  });

  const result = data.result || {};

  return {
    ts: Number(result.ts || Date.now()),
    u: Number(result.u || 0),
    seq: Number(result.seq || 0),
    bids: (result.b || []).map(x => ({
      price: Number(x[0]),
      size: Number(x[1])
    })),
    asks: (result.a || []).map(x => ({
      price: Number(x[0]),
      size: Number(x[1])
    })),
    bestBid: Number(result.b?.[0]?.[0] || 0),
    bestAsk: Number(result.a?.[0]?.[0] || 0)
  };
}

async function getTrades(category, symbol, limit = 1000) {
  const data = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit
  });

  return (data.result?.list || [])
    .map(t => ({
      id: t.execId || "",
      time: Number(t.time || 0),
      price: Number(t.price || 0),
      size: Number(t.size || 0),
      side: String(t.side || "").toLowerCase(),
      isBlockTrade: Boolean(t.isBlockTrade),
      isRPITrade: Boolean(t.isRPITrade)
    }))
    .filter(t =>
      t.time > 0 &&
      t.price > 0 &&
      t.size > 0 &&
      (t.side === "buy" || t.side === "sell")
    );
}

function tradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;
  let buyNotional = 0;
  let sellNotional = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largestTrade = 0;
  let largestNotional = 0;

  for (const t of trades) {
    const notional = t.price * t.size;

    largestTrade = Math.max(largestTrade, t.size);
    largestNotional = Math.max(largestNotional, notional);

    if (t.side === "buy") {
      buyVolume += t.size;
      buyNotional += notional;
      buyTrades++;
    } else {
      sellVolume += t.size;
      sellNotional += notional;
      sellTrades++;
    }
  }

  const volume = buyVolume + sellVolume;
  const notional = buyNotional + sellNotional;
  const delta = buyVolume - sellVolume;

  return {
    buyVolume,
    sellVolume,
    volume,
    buyNotional,
    sellNotional,
    notional,
    delta,
    deltaPercent: volume ? delta / volume * 100 : 0,
    buyTrades,
    sellTrades,
    trades: trades.length,
    largestTrade,
    largestNotional
  };
}

function buildFootprint(candle, trades, tickSize) {
  const map = new Map();

  for (const t of trades) {
    if (
      t.time < candle.time ||
      t.time >= candle.time + candle.duration
    ) {
      continue;
    }

    const price = roundToStep(t.price, tickSize);

    if (!map.has(price)) {
      map.set(price, {
        price,
        bid: 0,
        ask: 0,
        bidNotional: 0,
        askNotional: 0,
        trades: 0,
        buyTrades: 0,
        sellTrades: 0
      });
    }

    const row = map.get(price);

    row.trades++;

    if (t.side === "buy") {
      row.ask += t.size;
      row.askNotional += t.price * t.size;
      row.buyTrades++;
    } else {
      row.bid += t.size;
      row.bidNotional += t.price * t.size;
      row.sellTrades++;
    }
  }

  const levels = [...map.values()]
    .map(x => {
      const volume = x.bid + x.ask;
      const delta = x.ask - x.bid;

      return {
        ...x,
        volume,
        delta,
        deltaPercent: volume ? delta / volume * 100 : 0,
        imbalance:
          x.bid > 0
            ? x.ask / x.bid
            : x.ask > 0
              ? Infinity
              : 0
      };
    })
    .sort((a, b) => b.price - a.price);

  let totalBid = 0;
  let totalAsk = 0;
  let totalVolume = 0;
  let totalDelta = 0;
  let totalTrades = 0;

  let poc = null;
  let maxVolume = -Infinity;

  let maxPositiveDelta = null;
  let maxNegativeDelta = null;

  for (const x of levels) {
    totalBid += x.bid;
    totalAsk += x.ask;
    totalVolume += x.volume;
    totalDelta += x.delta;
    totalTrades += x.trades;

    if (x.volume > maxVolume) {
      maxVolume = x.volume;
      poc = x.price;
    }

    if (
      !maxPositiveDelta ||
      x.delta > maxPositiveDelta.delta
    ) {
      maxPositiveDelta = x;
    }

    if (
      !maxNegativeDelta ||
      x.delta < maxNegativeDelta.delta
    ) {
      maxNegativeDelta = x;
    }
  }

  const sortedByVolume = [...levels]
    .sort((a, b) => b.volume - a.volume);

  const valueTarget = totalVolume * 0.7;

  let valueVolume = 0;
  const valueLevels = [];

  for (const x of sortedByVolume) {
    if (valueVolume >= valueTarget) break;

    valueVolume += x.volume;
    valueLevels.push(x.price);
  }

  const vah = valueLevels.length
    ? Math.max(...valueLevels)
    : null;

  const val = valueLevels.length
    ? Math.min(...valueLevels)
    : null;

  const imbalanceLevels = levels.filter(x => {
    if (x.bid <= 0 && x.ask <= 0) return false;

    if (x.ask > 0 && x.bid > 0) {
      return x.ask / x.bid >= 3 || x.bid / x.ask >= 3;
    }

    return true;
  });

  let stackedBuy = 0;
  let stackedSell = 0;
  let bestBuyStack = 0;
  let bestSellStack = 0;

  for (const x of levels) {
    if (x.ask > x.bid * 3 && x.ask > 0) {
      stackedBuy++;
      bestBuyStack = Math.max(bestBuyStack, stackedBuy);
    } else {
      stackedBuy = 0;
    }

    if (x.bid > x.ask * 3 && x.bid > 0) {
      stackedSell++;
      bestSellStack = Math.max(bestSellStack, stackedSell);
    } else {
      stackedSell = 0;
    }
  }

  return {
    candle,
    levels,
    summary: {
      bid: totalBid,
      ask: totalAsk,
      volume: totalVolume,
      delta: totalDelta,
      deltaPercent:
        totalVolume
          ? totalDelta / totalVolume * 100
          : 0,
      trades: totalTrades,
      buyShare:
        totalVolume
          ? totalAsk / totalVolume * 100
          : 0,
      sellShare:
        totalVolume
          ? totalBid / totalVolume * 100
          : 0,
      poc,
      vah,
      val,
      maxPositiveDelta,
      maxNegativeDelta,
      stackedBuy,
      stackedSell,
      bestBuyStack,
      bestSellStack
    }
  };
}

async function getMarketBundle(category, symbol, interval) {
  const instrument = await getInstrument(category, symbol);

  if (!instrument) {
    throw new Error("Symbol not found");
  }

  const tickSize = Number(
    instrument.priceFilter?.tickSize || 0.00000001
  );

  const klines = await getKlines(
    category,
    symbol,
    interval,
    1000
  );

  const orderbook = await getOrderbook(
    category,
    symbol,
    50
  );

  const tickerData = await bybit("/v5/market/tickers", {
    category,
    symbol
  });

  const ticker = tickerData.result?.list?.[0] || {};

  return {
    version: VERSION,
    category,
    symbol,
    interval,
    tickSize,
    priceDecimals: decimals(tickSize),
    instrument: {
      baseCoin: instrument.baseCoin || "",
      quoteCoin: instrument.quoteCoin || "",
      status: instrument.status || "",
      minOrderQty:
        instrument.lotSizeFilter?.minOrderQty || "",
      qtyStep:
        instrument.lotSizeFilter?.qtyStep || ""
    },
    ticker: {
      lastPrice: Number(ticker.lastPrice || 0),
      markPrice: Number(ticker.markPrice || 0),
      indexPrice: Number(ticker.indexPrice || 0),
      fundingRate: Number(ticker.fundingRate || 0),
      openInterest: Number(ticker.openInterest || 0),
      volume24h: Number(ticker.volume24h || 0),
      turnover24h: Number(ticker.turnover24h || 0),
      price24hPcnt: Number(ticker.price24hPcnt || 0)
    },
    klines,
    orderbook
  };
}

async function handleFootprint(url) {
  const category = normalizeCategory(
    url.searchParams.get("category")
  );

  const symbol = normalizeSymbol(
    url.searchParams.get("symbol")
  );

  const interval = normalizeInterval(
    url.searchParams.get("interval")
  );

  const instrument = await getInstrument(
    category,
    symbol
  );

  if (!instrument) {
    throw new Error("Symbol not found");
  }

  const tickSize = Number(
    instrument.priceFilter?.tickSize || 0.00000001
  );

  const klines = await getKlines(
    category,
    symbol,
    interval,
    1000
  );

  const trades = await getTrades(
    category,
    symbol,
    1000
  );

  const duration =
    TF[interval] * 1000;

  const candles = klines.map(k => ({
    ...k,
    duration
  }));

  const footprints = candles.map(candle =>
    buildFootprint(
      candle,
      trades,
      tickSize
    )
  );

  return {
    version: VERSION,
    category,
    symbol,
    interval,
    tickSize,
    generatedAt: Date.now(),
    tradeSource: "Bybit recent-trade",
    candles: footprints
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }

  if (path === "/api/health") {
    return json({
      ok: true,
      version: VERSION,
      time: Date.now()
    });
  }

  if (path === "/api/symbols") {
    const category = normalizeCategory(
      url.searchParams.get("category")
    );

    const data = await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000
      }
    );

    const symbols = (data.result?.list || [])
      .filter(x =>
        x.status === "Trading" &&
        (
          category === "spot"
            ? x.quoteCoin === "USDT"
            : x.quoteCoin === "USDT"
        )
      )
      .map(x => ({
        symbol: x.symbol,
        baseCoin: x.baseCoin,
        quoteCoin: x.quoteCoin,
        status: x.status,
        tickSize:
          x.priceFilter?.tickSize || "",
        qtyStep:
          x.lotSizeFilter?.qtyStep || ""
      }))
      .sort((a, b) =>
        a.symbol.localeCompare(b.symbol)
      );

    return json({
      version: VERSION,
      category,
      symbols
    });
  }

  if (path === "/api/market") {
    const category = normalizeCategory(
      url.searchParams.get("category")
    );

    const symbol = normalizeSymbol(
      url.searchParams.get("symbol")
    );

    const interval = normalizeInterval(
      url.searchParams.get("interval")
    );

    return json(
      await getMarketBundle(
        category,
        symbol,
        interval
      )
    );
  }

  if (path === "/api/trades") {
    const category = normalizeCategory(
      url.searchParams.get("category")
    );

    const symbol = normalizeSymbol(
      url.searchParams.get("symbol")
    );

    const trades = await getTrades(
      category,
      symbol,
      1000
    );

    return json({
      version: VERSION,
      category,
      symbol,
      generatedAt: Date.now(),
      stats: tradeStats(trades),
      trades
    });
  }

  if (path === "/api/orderbook") {
    const category = normalizeCategory(
      url.searchParams.get("category")
    );

    const symbol = normalizeSymbol(
      url.searchParams.get("symbol")
    );

    return json(
      await getOrderbook(
        category,
        symbol,
        50
      )
    );
  }

  if (path === "/api/footprint") {
    return json(
      await handleFootprint(url)
    );
  }

  if (
    path === "/" ||
    path === "/index.html"
  ) {
    return new Response(
      `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Bybit Order Flow</title>
<style>
*{
  box-sizing:border-box;
  -webkit-tap-highlight-color:transparent
}
html,body{
  margin:0;
  padding:0;
  background:#080b10;
  color:#e8edf3;
  font-family:Arial,sans-serif
}
body{
  min-height:100vh
}
.app{
  width:100%;
  max-width:1500px;
  margin:auto;
  padding:10px
}
.header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  margin-bottom:10px
}
.title{
  font-size:20px;
  font-weight:800
}
.status{
  font-size:12px;
  padding:7px 10px;
  border-radius:8px;
  background:#111722
}
.controls{
  display:grid;
  grid-template-columns:1fr 1fr 1fr auto;
  gap:8px;
  margin-bottom:10px
}
select,input,button{
  min-height:42px;
  border:1px solid #202936;
  border-radius:9px;
  background:#10151d;
  color:#eef3f8;
  padding:8px 10px;
  font-size:14px;
  outline:none
}
button{
  cursor:pointer;
  font-weight:700
}
button:active{
  transform:scale(.98)
}
.chart-wrap{
  position:relative;
  width:100%;
  height:55vh;
  min-height:330px;
  border:1px solid #202936;
  border-radius:12px;
  overflow:hidden;
  background:#0b0f15;
  touch-action:none
}
canvas{
  display:block;
  width:100%;
  height:100%
}
.nav{
  display:flex;
  overflow-x:auto;
  gap:7px;
  padding:9px 0;
  scrollbar-width:none
}
.nav::-webkit-scrollbar{
  display:none
}
.nav button{
  flex:0 0 auto;
  min-width:74px;
  min-height:52px;
  display:flex;
  flex-direction:column;
  justify-content:center;
  align-items:center;
  gap:3px;
  font-size:11px
}
.nav button.active{
  border-color:#4a9eff;
  background:#142033
}
.panel{
  background:#0d1219;
  border:1px solid #202936;
  border-radius:12px;
  padding:10px;
  min-height:220px
}
.panel-title{
  font-size:17px;
  font-weight:800;
  margin-bottom:10px
}
.selected{
  background:#111821;
  border:1px solid #273444;
  border-radius:10px;
  padding:10px;
  margin-bottom:10px
}
.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:7px
}
.stat{
  background:#10161f;
  border:1px solid #202936;
  border-radius:8px;
  padding:8px;
  text-align:center
}
.stat b{
  display:block;
  margin-top:4px;
  font-size:13px
}
.green{
  color:#39d98a
}
.red{
  color:#ff5f68
}
.muted{
  color:#8491a1
}
.fp{
  overflow:auto;
  max-height:600px
}
.fp table{
  width:100%;
  border-collapse:collapse;
  direction:ltr;
  font-size:12px
}
.fp th,.fp td{
  border-bottom:1px solid #1d2631;
  padding:6px 5px;
  text-align:center;
  white-space:nowrap
}
.fp th{
  position:sticky;
  top:0;
  background:#121923;
  z-index:2
}
.buy{
  color:#39d98a
}
.sell{
  color:#ff5f68
}
.bar{
  height:7px;
  border-radius:5px;
  min-width:2px
}
.buybar{
  background:#39d98a
}
.sellbar{
  background:#ff5f68
}
.empty{
  color:#768394;
  padding:30px;
  text-align:center
}
@media(max-width:800px){
  .controls{
    grid-template-columns:1fr 1fr
  }
  .stats{
    grid-template-columns:repeat(2,1fr)
  }
  .chart-wrap{
    height:52vh
  }
}
@media(orientation:landscape) and (max-height:600px){
  .chart-wrap{
    height:72vh
  }
}
</style>
</head>
<body>

<div class="app">

  <div class="header">
    <div class="title">📊 Bybit Order Flow</div>
    <div id="status" class="status">در حال اتصال...</div>
  </div>

  <div class="controls">
    <select id="category">
      <option value="linear">Futures</option>
      <option value="spot">Spot</option>
    </select>

    <select id="symbol"></select>

    <select id="interval">
      <option value="1">1m</option>
      <option value="3">3m</option>
      <option value="5">5m</option>
      <option value="15">15m</option>
      <option value="30">30m</option>
      <option value="60">1H</option>
    </select>

    <button id="reload">↻</button>
  </div>

  <div class="chart-wrap" id="chartWrap">
    <canvas id="chart"></canvas>
  </div>

  <div class="nav">
    <button data-panel="footprint" class="active">
      🧱<span>Footprint</span>
    </button>
    <button data-panel="heatmap">
      🔥<span>Heatmap</span>
    </button>
    <button data-panel="liquidity">
      💧<span>Liquidity</span>
    </button>
    <button data-panel="absorption">
      🧲<span>Absorption</span>
    </button>
    <button data-panel="orderbook">
      📖<span>Order Book</span>
    </button>
    <button data-panel="delta">
      Δ<span>Delta/CVD</span>
    </button>
    <button data-panel="large">
      🐋<span>Large Trades</span>
    </button>
  </div>

  <div id="panel" class="panel"></div>

</div>

<script>
const state = {
  category:"linear",
  symbol:"BTCUSDT",
  interval:"1",
  market:null,
  footprints:null,
  selectedIndex:-1,
  panel:"footprint",
  ws:null,
  liveTrades:[],
  zoom:1,
  offset:0,
  dragging:false,
  lastX:0,
  pinchDistance:0
};

const $ = id => document.getElementById(id);

function esc(v){
  return String(v ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

function fmt(v,n=2){
  const x=Number(v);
  if(!Number.isFinite(x)) return "-";
  return x.toLocaleString("en-US",{
    maximumFractionDigits:n
  });
}

function roundToStep(price,step){
  const p=Number(price);
  const s=Number(step);
  if(!Number.isFinite(p)) return 0;
  if(!Number.isFinite(s)||s<=0) return p;
  const d=String(s).includes(".")
    ? String(s).replace(/0+$/,"").split(".")[1]?.length||0
    : 0;
  return Number((Math.round(p/s)*s).toFixed(d));
}

function setStatus(text,ok=false){
  $("status").textContent=text;
  $("status").className="status";
  if(ok) $("status").classList.add("green");
}

async function api(path,params={}){
  const u=new URL(path,location.origin);
  for(const [k,v] of Object.entries(params)){
    u.searchParams.set(k,v);
  }
  const r=await fetch(u);
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||"API error");
  return j;
}

async function loadSymbols(){
  const category=state.category;

  const data=await api("/api/symbols",{category});

  const select=$("symbol");
  select.innerHTML="";

  for(const s of data.symbols){
    const o=document.createElement("option");
    o.value=s.symbol;
    o.textContent=s.symbol;
    select.appendChild(o);
  }

  const exists=data.symbols.some(
    x=>x.symbol===state.symbol
  );

  if(!exists && data.symbols.length){
    state.symbol=data.symbols[0].symbol;
  }

  select.value=state.symbol;
}

async function loadMarket(){
  setStatus("در حال دریافت بازار...");

  state.market=await api("/api/market",{
    category:state.category,
    symbol:state.symbol,
    interval:state.interval
  });

  state.selectedIndex=
    state.market.klines.length-1;

  drawChart();
  setStatus("🟢 Bybit متصل است",true);

  await loadFootprint();

  connectWS();
}

async function loadFootprint(){
  try{
    const data=await api("/api/footprint",{
      category:state.category,
      symbol:state.symbol,
      interval:state.interval
    });

    state.footprints=data.candles||[];
    renderPanel();
  }catch(e){
    state.footprints=[];
    renderPanel();
  }
}

function resizeCanvas(){
  const canvas=$("chart");
  const box=$("chartWrap");
  const dpr=window.devicePixelRatio||1;

  canvas.width=box.clientWidth*dpr;
  canvas.height=box.clientHeight*dpr;

  const ctx=canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);

  drawChart();
}

function drawChart(){
  const canvas=$("chart");
  const box=$("chartWrap");

  if(!state.market?.klines?.length) return;

  const ctx=canvas.getContext("2d");
  const w=box.clientWidth;
  const h=box.clientHeight;

  ctx.clearRect(0,0,w,h);

  const candles=state.market.klines;
  const priceWidth=65;
  const bottom=25;

  const visibleCount=Math.max(
    20,
    Math.floor(
      candles.length/state.zoom
    )
  );

  let end=candles.length;
  let start=Math.max(0,end-visibleCount);

  const shift=Math.round(state.offset);

  start=Math.max(
    0,
    Math.min(
      candles.length-visibleCount,
      start-shift
    )
  );

  end=Math.min(
    candles.length,
    start+visibleCount
  );

  const visible=candles.slice(start,end);

  let min=Infinity;
  let max=-Infinity;

  for(const c of visible){
    min=Math.min(min,c.low);
    max=Math.max(max,c.high);
  }

  if(!Number.isFinite(min)||!Number.isFinite(max)) return;

  const pad=(max-min)*0.08||1;
  min-=pad;
  max+=pad;

  const chartW=w-priceWidth;
  const chartH=h-bottom;

  const py=p =>
    chartH-(p-min)/(max-min)*chartH;

  const gap=chartW/visible.length;
  const cw=Math.max(2,gap*.62);

  ctx.strokeStyle="#17202b";
  ctx.lineWidth=1;

  for(let i=0;i<6;i++){
    const y=i*chartH/5;
    ctx.beginPath();
    ctx.moveTo(0,y+.5);
    ctx.lineTo(chartW,y+.5);
    ctx.stroke();

    const p=max-(max-min)*i/5;

    ctx.fillStyle="#778392";
    ctx.font="11px Arial";
    ctx.textAlign="left";
    ctx.fillText(fmt(p,4),chartW+5,y+4);
  }

  for(let i=0;i<visible.length;i++){
    const c=visible[i];
    const x=i*gap+gap/2;

    const yOpen=py(c.open);
    const yClose=py(c.close);
    const yHigh=py(c.high);
    const yLow=py(c.low);

    const up=c.close>=c.open;

    ctx.strokeStyle=up
      ? "#39d98a"
      : "#ff5f68";

    ctx.fillStyle=ctx.strokeStyle;

    ctx.beginPath();
    ctx.moveTo(x,yHigh);
    ctx.lineTo(x,yLow);
    ctx.stroke();

    const top=Math.min(yOpen,yClose);
    const bh=Math.max(1,Math.abs(yClose-yOpen));

    ctx.fillRect(
      x-cw/2,
      top,
      cw,
      bh
    );

    const actual=start+i;

    if(actual===state.selectedIndex){
      ctx.strokeStyle="#ffffff";
      ctx.lineWidth=2;
      ctx.strokeRect(
        x-cw/2-3,
        top-3,
        cw+6,
        bh+6
      );
      ctx.lineWidth=1;
    }

    if(i%Math.ceil(visible.length/6)===0){
      const d=new Date(c.time);
      const label=
        String(d.getHours()).padStart(2,"0")
        +":"
        +String(d.getMinutes()).padStart(2,"0");

      ctx.fillStyle="#778392";
      ctx.font="10px Arial";
      ctx.textAlign="center";
      ctx.fillText(
        label,
        x,
        h-7
      );
    }
  }
}

function selectedFootprint(){
  if(
    !state.footprints ||
    state.selectedIndex<0
  ) return null;

  const candle=state.market?.klines?.[
    state.selectedIndex
  ];

  if(!candle) return null;

  let fp=state.footprints.find(
    x=>Number(x.candle?.time)===Number(candle.time)
  );

  if(!fp) return null;

  return fp;
}

function renderPanel(){
  const p=$("panel");

  if(state.panel==="footprint"){
    renderFootprint(p);
    return;
  }

  if(state.panel==="heatmap"){
    p.innerHTML=
      '<div class="panel-title">🔥 Heatmap</div>'+
      '<div class="empty">ماژول Heatmap روی همین موتور داده ساخته می‌شود.</div>';
    return;
  }

  if(state.panel==="liquidity"){
    renderLiquidity(p);
    return;
  }

  if(state.panel==="absorption"){
    renderAbsorption(p);
    return;
  }

  if(state.panel==="orderbook"){
    renderOrderbook(p);
    return;
  }

  if(state.panel==="delta"){
    renderDelta(p);
    return;
  }

  if(state.panel==="large"){
    renderLargeTrades(p);
  }
}

function renderFootprint(p){
  const fp=selectedFootprint();

  if(!fp){
    p.innerHTML=
      '<div class="panel-title">🧱 Footprint</div>'+
      '<div class="empty">Footprint این کندل در داده‌های قابل دریافت Bybit موجود نیست.</div>';
    return;
  }

  const s=fp.summary||{};
  const candle=fp.candle||{};

  const deltaClass=
    Number(s.delta)>=0
      ? "green"
      : "red";

  let rows="";

  const levels=fp.levels||[];

  let maxV=0;

  for(const x of levels){
    maxV=Math.max(
      maxV,
      Number(x.volume)||0
    );
  }

  for(const x of levels){
    const buyPct=maxV
      ? Number(x.ask)/maxV*100
      : 0;

    const sellPct=maxV
      ? Number(x.bid)/maxV*100
      : 0;

    rows+=`
      <tr>
        <td class="sell">${fmt(x.bid,4)}</td>
        <td>${fmt(x.price,6)}</td>
        <td class="buy">${fmt(x.ask,4)}</td>
        <td class="${Number(x.delta)>=0?"buy":"sell"}">
          ${Number(x.delta)>=0?"+":""}${fmt(x.delta,4)}
        </td>
        <td>
          <div class="bar sellbar" style="width:${sellPct}%"></div>
          <div class="bar buybar" style="width:${buyPct}%"></div>
        </td>
      </tr>
    `;
  }

  p.innerHTML=`
    <div class="panel-title">
      🧱 Footprint ·
      ${esc(state.symbol)}
    </div>

    <div class="selected">
      <b>
        ${new Date(candle.time).toLocaleString("fa-IR")}
      </b>
      <br>
      O ${fmt(candle.open,6)}
      · H ${fmt(candle.high,6)}
      · L ${fmt(candle.low,6)}
      · C ${fmt(candle.close,6)}
    </div>

    <div class="stats">
      <div class="stat">
        Buy
        <b class="green">${fmt(s.ask,4)}</b>
      </div>

      <div class="stat">
        Sell
        <b class="red">${fmt(s.bid,4)}</b>
      </div>

      <div class="stat">
        Delta
        <b class="${deltaClass}">
          ${Number(s.delta)>=0?"+":""}${fmt(s.delta,4)}
        </b>
      </div>

      <div class="stat">
        Volume
        <b>${fmt(s.volume,4)}</b>
      </div>

      <div class="stat">
        POC
        <b>${fmt(s.poc,6)}</b>
      </div>

      <div class="stat">
        VAH
        <b>${fmt(s.vah,6)}</b>
      </div>

      <div class="stat">
        VAL
        <b>${fmt(s.val,6)}</b>
      </div>

      <div class="stat">
        Trades
        <b>${fmt(s.trades,0)}</b>
      </div>
    </div>

    <div class="fp" style="margin-top:10px">
      <table>
        <thead>
          <tr>
            <th>Bid</th>
            <th>Price</th>
            <th>Ask</th>
            <th>Delta</th>
            <th>Volume</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `
            <tr>
              <td colspan="5" class="empty">
                معامله‌ای برای این سطح دریافت نشده
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>
  `;
}

function renderLiquidity(p){
  const ob=state.market?.orderbook;

  if(!ob){
    p.innerHTML=
      '<div class="panel-title">💧 Liquidity</div>'+
      '<div class="empty">داده Order Book موجود نیست.</div>';
    return;
  }

  const bids=ob.bids||[];
  const asks=ob.asks||[];

  const buy=bids.reduce(
    (a,x)=>a+Number(x.price)*Number(x.size),0
  );

  const sell=asks.reduce(
    (a,x)=>a+Number(x.price)*Number(x.size),0
  );

  p.innerHTML=`
    <div class="panel-title">💧 Liquidity</div>

    <div class="stats">
      <div class="stat">
        Buy Liquidity
        <b class="green">${fmt(buy,2)}</b>
      </div>
      <div class="stat">
        Sell Liquidity
        <b class="red">${fmt(sell,2)}</b>
      </div>
      <div class="stat">
        Best Bid
        <b>${fmt(ob.bestBid,6)}</b>
      </div>
      <div class="stat">
        Best Ask
        <b>${fmt(ob.bestAsk,6)}</b>
      </div>
    </div>
  `;
}

function renderAbsorption(p){
  const fp=selectedFootprint();

  if(!fp){
    p.innerHTML=
      '<div class="panel-title">🧲 Absorption</div>'+
      '<div class="empty">کندل انتخابی Footprint ندارد.</div>';
    return;
  }

  const levels=fp.levels||[];

  const zones=levels
    .filter(x=>
      Number(x.volume)>0 &&
      Math.abs(Number(x.delta))<Number(x.volume)*.12
    )
    .sort((a,b)=>b.volume-a.volume)
    .slice(0,10);

  p.innerHTML=`
    <div class="panel-title">🧲 Absorption</div>
    <div class="empty">
      ${zones.length
        ? zones.map(x=>`
          <div style="padding:7px;border-bottom:1px solid #202936">
            Price:
            <b>${fmt(x.price,6)}</b>
            · Volume:
            <b>${fmt(x.volume,4)}</b>
            · Delta:
            <b class="${x.delta>=0?"green":"red"}">
              ${fmt(x.delta,4)}
            </b>
          </div>
        `).join("")
        : "Absorption zone قابل تشخیص پیدا نشد."
      }
    </div>
  `;
}

function renderOrderbook(p){
  const ob=state.market?.orderbook;

  if(!ob){
    p.innerHTML=
      '<div class="panel-title">📖 Order Book</div>'+
      '<div class="empty">داده موجود نیست.</div>';
    return;
  }

  const asks=(ob.asks||[])
    .slice(0,15)
    .reverse();

  const bids=(ob.bids||[])
    .slice(0,15);

  let html=`
    <div class="panel-title">📖 Order Book</div>
    <div class="fp">
    <table>
      <thead>
        <tr>
          <th>Side</th>
          <th>Price</th>
          <th>Size</th>
          <th>Notional</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const x of asks){
    html+=`
      <tr>
        <td class="sell">ASK</td>
        <td>${fmt(x.price,6)}</td>
        <td>${fmt(x.size,4)}</td>
        <td>${fmt(x.price*x.size,2)}</td>
      </tr>
    `;
  }

  for(const x of bids){
    html+=`
      <tr>
        <td class="buy">BID</td>
        <td>${fmt(x.price,6)}</td>
        <td>${fmt(x.size,4)}</td>
        <td>${fmt(x.price*x.size,2)}</td>
      </tr>
    `;
  }

  html+=`
      </tbody>
    </table>
    </div>
  `;

  p.innerHTML=html;
}

function renderDelta(p){
  const fp=selectedFootprint();

  if(!fp){
    p.innerHTML=
      '<div class="panel-title">Δ Delta / CVD</div>'+
      '<div class="empty">Footprint موجود نیست.</div>';
    return;
  }

  const s=fp.summary||{};

  p.innerHTML=`
    <div class="panel-title">Δ Delta / CVD</div>

    <div class="stats">
      <div class="stat">
        Delta
        <b class="${s.delta>=0?"green":"red"}">
          ${s.delta>=0?"+":""}${fmt(s.delta,4)}
        </b>
      </div>

      <div class="stat">
        Delta %
        <b class="${s.deltaPercent>=0?"green":"red"}">
          ${s.deltaPercent>=0?"+":""}${fmt(s.deltaPercent,2)}%
        </b>
      </div>

      <div class="stat">
        Buy %
        <b class="green">
          ${fmt(s.buyShare,2)}%
        </b>
      </div>

      <div class="stat">
        Sell %
        <b class="red">
          ${fmt(s.sellShare,2)}%
        </b>
      </div>
    </div>

    <div class="selected" style="margin-top:10px">
      CVD تاریخی کامل برای گذشته فقط زمانی دقیق است که
      معاملات به‌صورت پیوسته ذخیره شده باشند.
    </div>
  `;
}

async function renderLargeTrades(p){
  try{
    const data=await api("/api/trades",{
      category:state.category,
      symbol:state.symbol
    });

    const trades=data.trades||[];

    const sorted=trades
      .sort(
        (a,b)=>
          b.price*b.size-
          a.price*a.size
      )
      .slice(0,20);

    p.innerHTML=`
      <div class="panel-title">🐋 Large Trades</div>
      <div class="fp">
      <table>
        <thead>
          <tr>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(t=>`
            <tr>
              <td class="${t.side==="buy"?"buy":"sell"}">
                ${t.side.toUpperCase()}
              </td>
              <td>${fmt(t.price,6)}</td>
              <td>${fmt(t.size,4)}</td>
              <td>${fmt(t.price*t.size,2)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      </div>
    `;
  }catch(e){
    p.innerHTML=
      '<div class="panel-title">🐋 Large Trades</div>'+
      '<div class="empty">خطا در دریافت معاملات.</div>';
  }
}

function connectWS(){
  if(state.ws){
    try{
      state.ws.close();
    }catch{}
  }

  const stream=
    state.category==="spot"
      ? "wss://stream.bybit.com/v5/public/spot"
      : "wss://stream.bybit.com/v5/public/linear";

  const ws=new WebSocket(stream);
  state.ws=ws;

  ws.onopen=()=>{
    const args=[
      "publicTrade."+state.symbol,
      "kline."+state.interval+"."+state.symbol
    ];

    ws.send(JSON.stringify({
      op:"subscribe",
      args
    }));
  };

  ws.onmessage=e=>{
    try{
      const msg=JSON.parse(e.data);

      if(
        msg.topic &&
        msg.topic.startsWith("publicTrade.")
      ){
        const list=msg.data||[];

        for(const t of list){
          state.liveTrades.push({
            id:t.i||"",
            time:Number(t.T||Date.now()),
            price:Number(t.p||0),
            size:Number(t.v||0),
            side:String(t.S||"").toLowerCase(),
            isBlockTrade:Boolean(t.BT)
          });
        }

        const cutoff=
          Date.now()-24*60*60*1000;

        state.liveTrades=
          state.liveTrades.filter(
            t=>t.time>=cutoff
          );

        updateLiveFootprint();
      }

      if(
        msg.topic &&
        msg.topic.startsWith("kline.")
      ){
        const item=msg.data?.[0];

        if(!item) return;

        const candle={
          time:Number(item.start),
          open:Number(item.open),
          high:Number(item.high),
          low:Number(item.low),
          close:Number(item.close),
          volume:Number(item.volume),
          turnover:Number(item.turnover)
        };

        const arr=state.market.klines;

        const index=arr.findIndex(
          x=>x.time===candle.time
        );

        if(index>=0){
          arr[index]=candle;
        }else{
          arr.push(candle);
          if(arr.length>1500){
            arr.shift();
          }
          state.selectedIndex=arr.length-1;
        }

        drawChart();
      }
    }catch{}
  };

  ws.onerror=()=>{
    setStatus("🟡 WebSocket خطا دارد");
  };

  ws.onclose=()=>{
    if(state.ws===ws){
      setTimeout(connectWS,3000);
    }
  };
}

function updateLiveFootprint(){
  if(
    state.selectedIndex<0 ||
    !state.market?.klines?.length
  ) return;

  const candle=
    state.market.klines[state.selectedIndex];

  if(!candle) return;

  const duration=
    Number(TF[state.interval])*1000;

  const fp=buildClientFootprint(
    {
      ...candle,
      duration
    },
    state.liveTrades,
    state.market.tickSize
  );

  if(!fp) return;

  if(!state.footprints){
    state.footprints=[];
  }

  const index=state.footprints.findIndex(
    x=>x.candle.time===candle.time
  );

  if(index>=0){
    state.footprints[index]=fp;
  }else{
    state.footprints.push(fp);
  }

  if(state.panel==="footprint"){
    renderPanel();
  }
}

function buildClientFootprint(
  candle,
  trades,
  tickSize
){
  const map=new Map();

  for(const t of trades){
    if(
      t.time<candle.time ||
      t.time>=candle.time+candle.duration
    ) continue;

    const price=roundToStep(
      t.price,
      tickSize
    );

    if(!map.has(price)){
      map.set(price,{
        price,
        bid:0,
        ask:0,
        trades:0
      });
    }

    const x=map.get(price);

    x.trades++;

    if(t.side==="buy"){
      x.ask+=t.size;
    }else{
      x.bid+=t.size;
    }
  }

  const levels=[...map.values()]
    .map(x=>{
      const volume=x.bid+x.ask;
      const delta=x.ask-x.bid;

      return {
        ...x,
        volume,
        delta,
        deltaPercent:
          volume
            ? delta/volume*100
            : 0
      };
    })
    .sort((a,b)=>b.price-a.price);

  let bid=0;
  let ask=0;
  let volume=0;
  let delta=0;
  let poc=null;
  let maxVolume=-1;

  for(const x of levels){
    bid+=x.bid;
    ask+=x.ask;
    volume+=x.volume;
    delta+=x.delta;

    if(x.volume>maxVolume){
      maxVolume=x.volume;
      poc=x.price;
    }
  }

  return {
    candle,
    levels,
    summary:{
      bid,
      ask,
      volume,
      delta,
      deltaPercent:
        volume
          ? delta/volume*100
          : 0,
      trades:levels.reduce(
        (a,x)=>a+x.trades,0
      ),
      buyShare:
        volume
          ? ask/volume*100
          : 0,
      sellShare:
        volume
          ? bid/volume*100
          : 0,
      poc
    }
  };
}

$("category").addEventListener(
  "change",
  async e=>{
    state.category=e.target.value;

    await loadSymbols();

    await loadMarket();
  }
);

$("symbol").addEventListener(
  "change",
  async e=>{
    state.symbol=e.target.value;
    await loadMarket();
  }
);

$("interval").addEventListener(
  "change",
  async e=>{
    state.interval=e.target.value;
    await loadMarket();
  }
);

$("reload").addEventListener(
  "click",
  async ()=>{
    await loadMarket();
  }
);

document
  .querySelectorAll(".nav button")
  .forEach(btn=>{
    btn.addEventListener(
      "click",
      ()=>{
        document
          .querySelectorAll(".nav button")
          .forEach(x=>x.classList.remove("active"));

        btn.classList.add("active");

        state.panel=
          btn.dataset.panel;

        renderPanel();
      }
    );
  });

const canvas=$("chart");

canvas.addEventListener(
  "pointerdown",
  e=>{
    canvas.setPointerCapture(e.pointerId);
    state.dragging=true;
    state.lastX=e.clientX;
  }
);

canvas.addEventListener(
  "pointermove",
  e=>{
    if(!state.dragging) return;

    const dx=e.clientX-state.lastX;

    state.lastX=e.clientX;

    const count=
      state.market?.klines?.length||1;

    state.offset-=
      dx/(canvas.clientWidth||1)*count;

    state.offset=Math.max(
      -count+20,
      Math.min(0,state.offset)
    );

    drawChart();
  }
);

canvas.addEventListener(
  "pointerup",
  ()=>{
    state.dragging=false;
  }
);

canvas.addEventListener(
  "pointercancel",
  ()=>{
    state.dragging=false;
  }
);

canvas.addEventListener(
  "wheel",
  e=>{
    e.preventDefault();

    state.zoom*=
      e.deltaY<0
        ? 1.15
        : .87;

    state.zoom=Math.max(
      1,
      Math.min(20,state.zoom)
    );

    drawChart();
  },
  {passive:false}
);

canvas.addEventListener(
  "click",
  e=>{
    if(!state.market?.klines?.length) return;

    const rect=canvas.getBoundingClientRect();

    const x=e.clientX-rect.left;

    const priceWidth=65;
    const chartW=rect.width-priceWidth;

    const visibleCount=Math.max(
      20,
      Math.floor(
        state.market.klines.length/state.zoom
      )
    );

    const start=Math.max(
      0,
      state.market.klines.length-visibleCount
    );

    const gap=
      chartW/visibleCount;

    const i=
      Math.floor(x/gap);

    const index=
      Math.max(
        0,
        Math.min(
          state.market.klines.length-1,
          start+i
        )
      );

    state.selectedIndex=index;

    drawChart();
    renderPanel();
  }
);

let touchStartDistance=0;
let touchStartZoom=1;

canvas.addEventListener(
  "touchstart",
  e=>{
    if(e.touches.length===2){
      const a=e.touches[0];
      const b=e.touches[1];

      touchStartDistance=
        Math.hypot(
          a.clientX-b.clientX,
          a.clientY-b.clientY
        );

      touchStartZoom=state.zoom;
    }
  },
  {passive:true}
);

canvas.addEventListener(
  "touchmove",
  e=>{
    if(e.touches.length!==2) return;

    e.preventDefault();

    const a=e.touches[0];
    const b=e.touches[1];

    const distance=
      Math.hypot(
        a.clientX-b.clientX,
        a.clientY-b.clientY
      );

    if(touchStartDistance>0){
      state.zoom=
        touchStartZoom*
        distance/touchStartDistance;

      state.zoom=Math.max(
        1,
        Math.min(20,state.zoom)
      );

      drawChart();
    }
  },
  {passive:false}
);

window.addEventListener(
  "resize",
  resizeCanvas
);

(async function init(){
  try{
    await api("/api/health");

    state.category=
      $("category").value;

    state.interval=
      $("interval").value;

    await loadSymbols();

    await loadMarket();

    resizeCanvas();
  }catch(e){
    console.error(e);
    setStatus(
      "🔴 خطا: "+e.message
    );
  }
})();
</script>

</body>
</html>`,
      200,
      "text/html"
    );
  }

  return text("Not Found", 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(
        request,
        env
      );
    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error:
          error?.message ||
          "Internal error",
        version: VERSION
      }, 500);
    }
  }
};
