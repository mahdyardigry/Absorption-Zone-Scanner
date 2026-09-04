const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ORDERFLOW-MAP-V6";

const TF = "5";
const TF15 = "15";
const TF3 = "3";
const TF1 = "1";

const KLINE_LIMIT = 240;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const CHART_LIMIT = 180;
const FOOTPRINT_MAX_LEVELS = 120;
const HEATMAP_LEVELS = 50;

const ALLOWED_INTERVALS = ["1","3","5","15","30","60"];

const cache = new Map();

function sleep(ms){
  return new Promise(r => setTimeout(r,ms));
}

function json(data,status=200,extra={}){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store,no-cache,must-revalidate",
      "access-control-allow-origin":"*",
      "access-control-allow-methods":"GET,POST,OPTIONS",
      "access-control-allow-headers":"Content-Type",
      ...extra
    }
  });
}

function n(v,d=0){
  const x=Number(v);
  return Number.isFinite(x)?x:d;
}

function clamp(v,a,b){
  return Math.max(a,Math.min(b,v));
}

function pct(a,b){
  return b?(a/b)*100:0;
}

function avg(a){
  return a?.length
    ? a.reduce((x,y)=>x+y,0)/a.length
    : 0;
}

function sum(a){
  return a?.reduce((x,y)=>x+n(y),0)||0;
}

function normalizeInterval(v){
  const x=String(v||TF);
  return ALLOWED_INTERVALS.includes(x)?x:TF;
}

function intervalMs(v){
  return Number(normalizeInterval(v))*60*1000;
}

function priceDecimals(step){
  const s=String(step??"");
  if(!s.includes("."))return 0;
  return s.split(".")[1].replace(/0+$/,"").length;
}

function roundToStep(price,step){
  const p=n(price);
  const s=n(step);
  if(!s)return p;
  return Number(
    (Math.round(p/s)*s).toFixed(priceDecimals(s))
  );
}

async function bybit(path,params={}){
  const qs=new URLSearchParams();

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined&&v!==null&&v!==""){
      qs.set(k,String(v));
    }
  }

  const r=await fetch(
    `${BYBIT}${path}?${qs.toString()}`,
    {
      method:"GET",
      headers:{accept:"application/json"}
    }
  );

  if(!r.ok){
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const data=await r.json();

  if(data.retCode!==0){
    throw new Error(
      data.retMsg||`Bybit error ${data.retCode}`
    );
  }

  return data.result;
}

async function instrumentInfo(category,symbol){
  const key=`instrument:${category}:${symbol}`;

  if(cache.has(key)){
    return cache.get(key);
  }

  const result=await bybit(
    "/v5/market/instruments-info",
    {category,symbol}
  );

  const item=result?.list?.[0];

  const info={
    symbol,
    category,
    tickSize:n(
      item?.priceFilter?.tickSize,
      0.00000001
    ),
    minPrice:n(item?.priceFilter?.minPrice),
    maxPrice:n(item?.priceFilter?.maxPrice),
    qtyStep:n(item?.lotSizeFilter?.qtyStep),
    minQty:n(item?.lotSizeFilter?.minOrderQty),
    maxQty:n(item?.lotSizeFilter?.maxOrderQty)
  };

  cache.set(key,info);
  return info;
}

async function kline(
  category,
  symbol,
  interval,
  limit=KLINE_LIMIT
){
  const result=await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval:normalizeInterval(interval),
      limit
    }
  );

  return (result?.list||[])
    .map(x=>({
      time:n(x[0]),
      open:n(x[1]),
      high:n(x[2]),
      low:n(x[3]),
      close:n(x[4]),
      volume:n(x[5]),
      turnover:n(x[6])
    }))
    .sort((a,b)=>a.time-b.time);
}

async function ticker(category,symbol){
  const result=await bybit(
    "/v5/market/tickers",
    {category,symbol}
  );

  const x=result?.list?.[0]||{};

  return{
    symbol,
    last:n(x.lastPrice),
    mark:n(x.markPrice),
    index:n(x.indexPrice),
    volume24h:n(x.volume24h),
    turnover24h:n(x.turnover24h),
    change24h:n(x.price24hPcnt)*100,
    openInterest:n(x.openInterest),
    fundingRate:n(x.fundingRate)
  };
}

async function trades(
  category,
  symbol,
  limit=TRADE_LIMIT
){
  const result=await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit:Math.min(1000,limit)
    }
  );

  return(result?.list||[])
    .map(x=>{
      const side=String(
        x.side||""
      ).trim().toUpperCase();

      return{
        id:
          x.execId||
          x.id||
          `${x.time}-${x.price}-${x.size}`,
        time:n(x.time),
        price:n(x.price),
        size:n(x.size),
        side,
        value:n(x.price)*n(x.size),
        isBlockTrade:Boolean(x.isBlockTrade),
        isRPITrade:Boolean(x.isRPITrade)
      };
    })
    .filter(x=>
      Number.isFinite(x.price)&&
      Number.isFinite(x.size)&&
      (x.side==="BUY"||x.side==="SELL")
    )
    .sort((a,b)=>a.time-b.time);
}

function aggressorSide(x){
  const side=String(
    x?.side||""
  ).trim().toUpperCase();

  if(side==="BUY")return"BUY";
  if(side==="SELL")return"SELL";
  return"UNKNOWN";
}

async function orderbook(
  category,
  symbol,
  limit=ORDERBOOK_LIMIT
){
  const result=await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit
    }
  );

  const bids=(result?.b||[])
    .map(x=>{
      const price=n(x[0]);
      const size=n(x[1]);

      return{
        price,
        size,
        value:price*size
      };
    })
    .filter(x=>x.price>0&&x.size>0)
    .sort((a,b)=>b.price-a.price);

  const asks=(result?.a||[])
    .map(x=>{
      const price=n(x[0]);
      const size=n(x[1]);

      return{
        price,
        size,
        value:price*size
      };
    })
    .filter(x=>x.price>0&&x.size>0)
    .sort((a,b)=>a.price-b.price);

  return{
    bids,
    asks,
    bestBid:bids[0]?.price||0,
    bestAsk:asks[0]?.price||0
  };
}

async function oiFunding(symbol){
  try{
    const[
      oiResult,
      fundingResult
    ]=await Promise.all([
      bybit(
        "/v5/market/open-interest",
        {
          category:"linear",
          symbol,
          intervalTime:"5min",
          limit:1
        }
      ),
      bybit(
        "/v5/market/funding/history",
        {
          category:"linear",
          symbol,
          limit:1
        }
      )
    ]);

    return{
      openInterest:n(
        oiResult?.list?.[0]?.openInterest
      ),
      fundingRate:n(
        fundingResult?.list?.[0]?.fundingRate
      ),
      fundingTime:n(
        fundingResult?.list?.[0]?.fundingRateTimestamp
      )
    };
  }catch{
    return{
      openInterest:0,
      fundingRate:0,
      fundingTime:0
    };
  }
}

function sma(values,period){
  if(!values?.length)return[];

  const out=new Array(values.length).fill(null);
  let rolling=0;

  for(let i=0;i<values.length;i++){
    rolling+=n(values[i]);

    if(i>=period){
      rolling-=n(values[i-period]);
    }

    if(i>=period-1){
      out[i]=rolling/period;
    }
  }

  return out;
}

function ema(values,period){
  if(!values?.length)return[];

  const out=new Array(values.length).fill(null);
  const k=2/(period+1);

  let prev=n(values[0]);
  out[0]=prev;

  for(let i=1;i<values.length;i++){
    prev=n(values[i])*k+prev*(1-k);
    out[i]=prev;
  }

  return out;
}

function atr(candles,period=14){
  if(!candles?.length)return[];

  const tr=candles.map((c,i)=>{
    if(i===0){
      return c.high-c.low;
    }

    return Math.max(
      c.high-c.low,
      Math.abs(c.high-candles[i-1].close),
      Math.abs(c.low-candles[i-1].close)
    );
  });

  return ema(tr,period);
}

function rsi(values,period=14){
  if(!values?.length)return[];

  const out=new Array(values.length).fill(null);

  let gains=0;
  let losses=0;

  for(let i=1;i<values.length;i++){
    const diff=
      n(values[i])-n(values[i-1]);

    gains+=Math.max(diff,0);
    losses+=Math.max(-diff,0);

    if(i>period){
      const oldDiff=
        n(values[i-period])-
        n(values[i-period-1]);

      gains-=Math.max(oldDiff,0);
      losses-=Math.max(-oldDiff,0);
    }

    if(i>=period){
      const avgGain=gains/period;
      const avgLoss=losses/period;

      if(avgLoss===0){
        out[i]=100;
      }else{
        const rs=avgGain/avgLoss;
        out[i]=100-100/(1+rs);
      }
    }
  }

  return out;
}

function candleStats(c){
  const range=Math.max(c.high-c.low,0);
  const body=Math.abs(c.close-c.open);

  return{
    range,
    body,
    bodyPercent:
      range?body/range*100:0,
    upperWick:
      c.high-Math.max(c.open,c.close),
    lowerWick:
      Math.min(c.open,c.close)-c.low,
    bullish:c.close>=c.open,
    bearish:c.close<c.open
  };
}

function flowFromTrades(
  list,
  start=0,
  end=Infinity
){
  const selected=(list||[]).filter(t=>
    t.time>=start&&
    t.time<=end
  );

  let buyVolume=0;
  let sellVolume=0;
  let buyValue=0;
  let sellValue=0;
  let buyTrades=0;
  let sellTrades=0;

  for(const t of selected){
    const side=aggressorSide(t);
    const value=n(
      t.value,
      n(t.price)*n(t.size)
    );

    if(side==="BUY"){
      buyVolume+=n(t.size);
      buyValue+=value;
      buyTrades++;
    }else if(side==="SELL"){
      sellVolume+=n(t.size);
      sellValue+=value;
      sellTrades++;
    }
  }

  const totalVolume=
    buyVolume+sellVolume;

  const totalValue=
    buyValue+sellValue;

  const delta=
    buyVolume-sellVolume;

  const deltaValue=
    buyValue-sellValue;

  return{
    buyVolume,
    sellVolume,
    totalVolume,
    buyValue,
    sellValue,
    totalValue,
    delta,
    deltaValue,
    deltaPercent:pct(
      delta,
      totalVolume
    ),
    deltaValuePercent:pct(
      deltaValue,
      totalValue
    ),
    buyShare:pct(
      buyVolume,
      totalVolume
    ),
    sellShare:pct(
      sellVolume,
      totalVolume
    ),
    buyTrades,
    sellTrades,
    totalTrades:
      buyTrades+sellTrades,
    firstTime:selected[0]?.time||0,
    lastTime:
      selected[selected.length-1]?.time||0
  };
}

function createFootprintLevel(price){
  return{
    price,
    bidVolume:0,
    askVolume:0,
    bidValue:0,
    askValue:0,
    bidTrades:0,
    askTrades:0,
    totalVolume:0,
    totalValue:0,
    delta:0,
    deltaValue:0,
    imbalance:0,
    imbalanceValue:0,
    side:"NEUTRAL",
    largestTradeValue:0
  };
}

function buildFootprints(
  candles,
  tradeList,
  interval,
  tickSize
){
  const ms=intervalMs(interval);
  const result=[];

  for(const candle of candles||[]){
    const start=candle.time;
    const end=start+ms;

    const levelMap=new Map();

    const localTrades=(tradeList||[]).filter(t=>
      t.time>=start&&
      t.time<end
    );

    for(const t of localTrades){
      const price=roundToStep(
        t.price,
        tickSize
      );

      if(!levelMap.has(price)){
        levelMap.set(
          price,
          createFootprintLevel(price)
        );
      }

      const level=levelMap.get(price);
      const side=aggressorSide(t);
      const size=n(t.size);
      const value=n(
        t.value,
        n(t.price)*size
      );

      level.totalVolume+=size;
      level.totalValue+=value;

      level.largestTradeValue=
        Math.max(
          level.largestTradeValue,
          value
        );

      if(side==="BUY"){
        level.askVolume+=size;
        level.askValue+=value;
        level.askTrades++;
      }else if(side==="SELL"){
        level.bidVolume+=size;
        level.bidValue+=value;
        level.bidTrades++;
      }
    }

    const levels=[...levelMap.values()]
      .map(level=>{
        level.delta=
          level.askVolume-
          level.bidVolume;

        level.deltaValue=
          level.askValue-
          level.bidValue;

        if(level.bidVolume>0){
          level.imbalance=
            level.askVolume/
            level.bidVolume;
        }else if(level.askVolume>0){
          level.imbalance=Infinity;
        }

        if(level.bidValue>0){
          level.imbalanceValue=
            level.askValue/
            level.bidValue;
        }else if(level.askValue>0){
          level.imbalanceValue=Infinity;
        }

        if(level.delta>0){
          level.side="BUY";
        }else if(level.delta<0){
          level.side="SELL";
        }else{
          level.side="NEUTRAL";
        }

        return level;
      })
      .sort((a,b)=>b.price-a.price)
      .slice(0,FOOTPRINT_MAX_LEVELS);

    const flow=flowFromTrades(
      localTrades,
      start,
      end-1
    );

    let imbalances=0;

    for(const level of levels){
      if(
        level.imbalance>=3||
        (
          level.imbalance>0&&
          level.imbalance<=1/3
        )
      ){
        imbalances++;
      }
    }

    result.push({
      time:candle.time,
      open:candle.open,
      high:candle.high,
      low:candle.low,
      close:candle.close,
      volume:candle.volume,
      turnover:candle.turnover,

      tradeCount:localTrades.length,

      flowVolume:flow.totalVolume,
      buyVolume:flow.buyVolume,
      sellVolume:flow.sellVolume,
      buyValue:flow.buyValue,
      sellValue:flow.sellValue,
      totalValue:flow.totalValue,

      buyTrades:flow.buyTrades,
      sellTrades:flow.sellTrades,

      delta:flow.delta,
      deltaValue:flow.deltaValue,
      deltaPercent:flow.deltaPercent,
      deltaValuePercent:
        flow.deltaValuePercent,

      cumulativeDeltaValue:0,

      levels,
      imbalances
    });
  }

  let cumulative=0;

  for(const fp of result){
    cumulative+=n(fp.deltaValue);
    fp.cumulativeDeltaValue=cumulative;
  }

  return result;
}

function candleDeltaSeries(footprints){
  return(footprints||[]).map(fp=>({
    time:fp.time,
    buyVolume:fp.buyVolume,
    sellVolume:fp.sellVolume,
    delta:fp.delta,
    deltaValue:fp.deltaValue,
    totalVolume:fp.flowVolume,
    totalValue:fp.totalValue,
    buyTrades:fp.buyTrades,
    sellTrades:fp.sellTrades
  }));
}

function analyzeBlocks(list){
  const values=(list||[])
    .map(x=>n(
      x.value,
      n(x.price)*n(x.size)
    ))
    .filter(x=>x>0);

  if(!values.length){
    return{
      threshold:0,
      blocks:[]
    };
  }

  const sorted=[...values].sort(
    (a,b)=>a-b
  );

  const p95=
    sorted[
      Math.floor(
        (sorted.length-1)*0.95
      )
    ];

  const averageNotional=avg(values);

  const threshold=Math.max(
    averageNotional*5,
    p95
  );

  const blocks=(list||[])
    .filter(x=>
      n(
        x.value,
        n(x.price)*x.size
      )>=threshold
    )
    .sort(
      (a,b)=>
        n(b.value,b.price*b.size)-
        n(a.value,a.price*a.size)
    )
    .slice(0,50)
    .map(x=>({
      ...x,
      value:n(
        x.value,
        x.price*x.size
      ),
      side:aggressorSide(x)
    }));

  return{
    threshold,
    blocks
  };
}

function median(values){
  const a=(values||[])
    .map(n)
    .filter(x=>x>0)
    .sort((x,y)=>x-y);

  if(!a.length)return 0;

  const m=Math.floor(a.length/2);

  return a.length%2
    ? a[m]
    : (a[m-1]+a[m])/2;
}

function analyzeWalls(book){
  const bids=book?.bids||[];
  const asks=book?.asks||[];

  const buyLiquidity=sum(
    bids.map(x=>x.value)
  );

  const sellLiquidity=sum(
    asks.map(x=>x.value)
  );

  const totalLiquidity=
    buyLiquidity+sellLiquidity;

  const buyShare=pct(
    buyLiquidity,
    totalLiquidity
  );

  const sellShare=pct(
    sellLiquidity,
    totalLiquidity
  );

  const buyMedian=median(
    bids.map(x=>x.value)
  );

  const sellMedian=median(
    asks.map(x=>x.value)
  );

  const buyThreshold=buyMedian*4;
  const sellThreshold=sellMedian*4;

  const buyWalls=bids
    .filter(x=>
      buyMedian>0&&
      x.value>=buyThreshold
    )
    .sort((a,b)=>b.value-a.value)
    .slice(0,20);

  const sellWalls=asks
    .filter(x=>
      sellMedian>0&&
      x.value>=sellThreshold
    )
    .sort((a,b)=>b.value-a.value)
    .slice(0,20);

  let pressure="NEUTRAL";

  if(buyShare>sellShare+8){
    pressure="BUY_PRESSURE";
  }else if(sellShare>buyShare+8){
    pressure="SELL_PRESSURE";
  }

  return{
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,
    buyShare,
    sellShare,
    buyMedian,
    sellMedian,
    buyThreshold,
    sellThreshold,
    buyWalls,
    sellWalls,
    pressure,
    bestBid:book?.bestBid||0,
    bestAsk:book?.bestAsk||0
  };
}

function buildHeatmap(book){
  const all=[
    ...(book?.bids||[]).map(x=>({
      ...x,
      side:"BID"
    })),
    ...(book?.asks||[]).map(x=>({
      ...x,
      side:"ASK"
    }))
  ]
  .sort((a,b)=>b.value-a.value)
  .slice(0,HEATMAP_LEVELS);

  const max=Math.max(
    1,
    ...all.map(x=>n(x.value))
  );

  return all.map(x=>({
    price:x.price,
    size:x.size,
    value:x.value,
    side:x.side,
    intensity:clamp(
      x.value/max,
      0,
      1
    )
  }));
}

function buildLiquidityZones(book){
  const bids=book?.bids||[];
  const asks=book?.asks||[];

  const bidMedian=median(
    bids.map(x=>x.value)
  );

  const askMedian=median(
    asks.map(x=>x.value)
  );

  return[
    ...bids
      .filter(x=>
        bidMedian>0&&
        x.value>=bidMedian*2
      )
      .map(x=>({
        price:x.price,
        value:x.value,
        size:x.size,
        side:"BUY",
        strength:x.value/bidMedian
      })),

    ...asks
      .filter(x=>
        askMedian>0&&
        x.value>=askMedian*2
      )
      .map(x=>({
        price:x.price,
        value:x.value,
        size:x.size,
        side:"SELL",
        strength:x.value/askMedian
      }))
  ]
  .sort((a,b)=>b.value-a.value)
  .slice(0,50);
}

function detectSweep(candles){
  if(!candles||candles.length<7){
    return{
      detected:false,
      type:"NONE",
      price:0,
      time:0
    };
  }

  const c=candles[candles.length-1];
  const previous=candles.slice(-6,-1);

  const previousHigh=Math.max(
    ...previous.map(x=>x.high)
  );

  const previousLow=Math.min(
    ...previous.map(x=>x.low)
  );

  if(
    c.high>previousHigh&&
    c.close<previousHigh
  ){
    return{
      detected:true,
      type:"SELL_SWEEP",
      price:c.high,
      time:c.time
    };
  }

  if(
    c.low<previousLow&&
    c.close>previousLow
  ){
    return{
      detected:true,
      type:"BUY_SWEEP",
      price:c.low,
      time:c.time
    };
  }

  return{
    detected:false,
    type:"NONE",
    price:0,
    time:c.time
  };
}

function detectTradeSweep(list){
  const recent=(list||[]).slice(-50);

  let buy=0;
  let sell=0;

  for(const t of recent){
    const value=n(
      t.value,
      n(t.price)*n(t.size)
    );

    if(aggressorSide(t)==="BUY")buy+=value;
    if(aggressorSide(t)==="SELL")sell+=value;
  }

  if(
    buy>0&&
    buy>=sell*2
  ){
    return{
      detected:true,
      type:"BUY_TRADE_SWEEP",
      buyValue:buy,
      sellValue:sell
    };
  }

  if(
    sell>0&&
    sell>=buy*2
  ){
    return{
      detected:true,
      type:"SELL_TRADE_SWEEP",
      buyValue:buy,
      sellValue:sell
    };
  }

  return{
    detected:false,
    type:"NONE",
    buyValue:buy,
    sellValue:sell
  };
}

function detectAbsorption(
  flow,
  candle,
  wall
){
  const stats=candleStats(candle);

  let type="NONE";
  let detected=false;

  if(
    flow.deltaPercent>=10&&
    stats.bodyPercent<=35&&
    wall.sellShare>=wall.buyShare
  ){
    detected=true;
    type="SELL_ABSORPTION";
  }

  if(
    flow.deltaPercent<=-10&&
    stats.bodyPercent<=35&&
    wall.buyShare>=wall.sellShare
  ){
    detected=true;
    type="BUY_ABSORPTION";
  }

  return{
    detected,
    type,
    deltaPercent:flow.deltaPercent,
    bodyPercent:stats.bodyPercent
  };
}

function structureAnalysis(candles){
  if(!candles?.length){
    return{
      trend:"NEUTRAL",
      strength:0,
      sma5:0,
      sma20:0,
      price:0
    };
  }

  const closes=candles.map(x=>x.close);
  const ma5=sma(closes,5);
  const ma20=sma(closes,20);
  const a=atr(candles,14);

  const i=candles.length-1;
  const price=candles[i].close;

  const sma5=n(ma5[i]);
  const sma20=n(ma20[i]);
  const atrValue=n(a[i]);

  let trend="NEUTRAL";

  if(sma5>sma20&&price>sma20){
    trend="BULLISH";
  }else if(
    sma5<sma20&&
    price<sma20
  ){
    trend="BEARISH";
  }

  const distance=atrValue
    ? Math.abs(price-sma20)/atrValue
    : 0;

  return{
    trend,
    strength:clamp(
      distance*25,
      0,
      100
    ),
    sma5,
    sma20,
    price,
    atr:atrValue
  };
}

function entry1m(candles){
  if(!candles?.length){
    return{
      signal:"WAIT",
      rsi:0,
      ma20:0
    };
  }

  const closes=candles.map(x=>x.close);
  const ma=sma(closes,20);
  const rs=rsi(closes,14);

  const i=candles.length-1;

  const price=closes[i];
  const ma20=n(ma[i]);
  const rsiValue=n(rs[i],50);

  let signal="WAIT";

  if(
    price>ma20&&
    rsiValue>=50
  ){
    signal="LONG";
  }else if(
    price<ma20&&
    rsiValue<=50
  ){
    signal="SHORT";
  }

  return{
    signal,
    rsi:rsiValue,
    ma20
  };
}

function supportResistance(candles){
  const recent=(candles||[]).slice(-30);

  if(!recent.length){
    return{
      support:0,
      resistance:0
    };
  }

  return{
    support:Math.min(
      ...recent.map(x=>x.low)
    ),
    resistance:Math.max(
      ...recent.map(x=>x.high)
    )
  };
}

function movement(candles){
  if(!candles||candles.length<2){
    return{
      percent:0,
      direction:"NEUTRAL"
    };
  }

  const previous=
    candles[candles.length-2].close;

  const current=
    candles[candles.length-1].close;

  const change=pct(
    current-previous,
    previous
  );

  return{
    percent:change,
    direction:
      change>0
        ?"UP"
        :change<0
          ?"DOWN"
          :"NEUTRAL"
  };
}

function structuralZone(
  candles,
  price
){
  const recent=(candles||[]).slice(-20);

  if(!recent.length){
    return{
      low:0,
      high:0,
      position:"NEUTRAL",
      premiumDiscount:50
    };
  }

  const low=Math.min(
    ...recent.map(x=>x.low)
  );

  const high=Math.max(
    ...recent.map(x=>x.high)
  );

  const range=high-low;

  const position=range
    ?(price-low)/range
    :0.5;

  return{
    low,
    high,
    position:
      position>=0.66
        ?"PREMIUM"
        :position<=0.33
          ?"DISCOUNT"
          :"EQUILIBRIUM",
    premiumDiscount:
      position*100
  };
}

function flowPressure(flow){
  if(flow.deltaPercent>=10){
    return"BUY_PRESSURE";
  }

  if(flow.deltaPercent<=-10){
    return"SELL_PRESSURE";
  }

  return"NEUTRAL";
}

async function buildChartData(
  symbol,
  interval
){
  const selectedInterval=
    normalizeInterval(interval);

  const[
    candles,
    tick,
    book,
    tradeList,
    info
  ]=await Promise.all([
    kline(
      "linear",
      symbol,
      selectedInterval,
      CHART_LIMIT
    ),
    ticker("linear",symbol),
    orderbook(
      "linear",
      symbol,
      ORDERBOOK_LIMIT
    ),
    trades(
      "linear",
      symbol,
      TRADE_LIMIT
    ),
    instrumentInfo(
      "linear",
      symbol
    )
  ]);

  const footprints=buildFootprints(
    candles,
    tradeList,
    selectedInterval,
    info.tickSize
  );

  const candleFlow=
    candleDeltaSeries(
      footprints
    );

  const enrichedCandles=
    candles.map((c,i)=>({
      ...c,
      ...(candleFlow[i]||{
        buyVolume:0,
        sellVolume:0,
        delta:0,
        deltaValue:0,
        totalVolume:0,
        totalValue:0
      })
    }));

  const current=
    candles[candles.length-1];

  const currentFlow=current
    ?flowFromTrades(
      tradeList,
      current.time,
      current.time+
        intervalMs(selectedInterval)-1
    )
    :flowFromTrades([]);

  const wall=analyzeWalls(book);
  const heatmap=buildHeatmap(book);
  const zones=buildLiquidityZones(book);
  const sweep=detectSweep(candles);
  const tradeSweep=
    detectTradeSweep(tradeList);

  const absorption=detectAbsorption(
    currentFlow,
    current||{
      open:0,
      high:0,
      low:0,
      close:0
    },
    wall
  );

  const blocks=analyzeBlocks(
    tradeList
  );

  return{
    version:VERSION,
    symbol,
    category:"linear",
    interval:selectedInterval,

    ticker:tick,
    instrument:info,

    candles:enrichedCandles,
    footprints,
    candleDelta:candleFlow,

    currentFlow,
    flowPressure:
      flowPressure(currentFlow),

    orderbook:book,
    wall,
    heatmap,
    zones,

    sweep,
    tradeSweep,
    absorption,
    blocks,

    trades:tradeList.slice(-250),

    lastPrice:tick.last,
    serverTime:Date.now()
  };
}

async function analyze(
  symbol,
  selectedInterval
){
  const interval=
    normalizeInterval(
      selectedInterval
    );

  const[
    candles5,
    candles15,
    candles3,
    candles1,
    tick,
    book,
    tradeList,
    info,
    oi
  ]=await Promise.all([
    kline(
      "linear",
      symbol,
      TF,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF15,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF3,
      KLINE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      TF1,
      KLINE_LIMIT
    ),
    ticker("linear",symbol),
    orderbook(
      "linear",
      symbol,
      ORDERBOOK_LIMIT
    ),
    trades(
      "linear",
      symbol,
      TRADE_LIMIT
    ),
    instrumentInfo(
      "linear",
      symbol
    ),
    oiFunding(symbol)
  ]);

  const baseCandles=
    interval==="1"
      ?candles1
      :interval==="3"
        ?candles3
        :interval==="15"
          ?candles15
          :interval==="30"||
            interval==="60"
            ?await kline(
              "linear",
              symbol,
              interval,
              KLINE_LIMIT
            )
            :candles5;

  const footprints=buildFootprints(
    baseCandles,
    tradeList,
    interval,
    info.tickSize
  );

  const candleDelta=
    candleDeltaSeries(
      footprints
    );

  const selectedCandles=
    baseCandles.map((c,i)=>({
      ...c,
      ...(candleDelta[i]||{})
    }));

  const currentCandle=
    selectedCandles[
      selectedCandles.length-1
    ];

  let currentFlow=
    currentCandle
      ?flowFromTrades(
        tradeList,
        currentCandle.time,
        currentCandle.time+
          intervalMs(interval)-1
      )
      :flowFromTrades([]);

  if(currentFlow.totalTrades<8){
    currentFlow=
      flowFromTrades(tradeList);
  }

  const wall=analyzeWalls(book);
  const heatmap=buildHeatmap(book);
  const zones=buildLiquidityZones(book);

  const sweep=
    detectSweep(selectedCandles);

  const tradeSweep=
    detectTradeSweep(tradeList);

  const absorption=
    detectAbsorption(
      currentFlow,
      currentCandle||{
        open:0,
        high:0,
        low:0,
        close:0
      },
      wall
    );

  const blocks=
    analyzeBlocks(tradeList);

  const structure5=
    structureAnalysis(candles5);

  const structure15=
    structureAnalysis(candles15);

  const structure1=
    structureAnalysis(candles1);

  const entry=
    entry1m(candles1);

  const sr=
    supportResistance(
      selectedCandles
    );

  const move=
    movement(selectedCandles);

  const zone=
    structuralZone(
      selectedCandles,
      tick.last
    );

  let score=50;
  const reasons=[];

  if(structure5.trend==="BULLISH"){
    score+=8;
    reasons.push("ساختار 5m صعودی");
  }

  if(structure5.trend==="BEARISH"){
    score-=8;
    reasons.push("ساختار 5m نزولی");
  }

  if(structure15.trend==="BULLISH"){
    score+=8;
    reasons.push("تأیید 15m صعودی");
  }

  if(structure15.trend==="BEARISH"){
    score-=8;
    reasons.push("تأیید 15m نزولی");
  }

  if(currentFlow.deltaPercent>=10){
    score+=12;
    reasons.push("Aggressor Buy قوی");
  }

  if(currentFlow.deltaPercent<=-10){
    score-=12;
    reasons.push("Aggressor Sell قوی");
  }

  if(wall.pressure==="BUY_PRESSURE"){
    score+=8;
    reasons.push("فشار نقدینگی سمت Bid");
  }

  if(wall.pressure==="SELL_PRESSURE"){
    score-=8;
    reasons.push("فشار نقدینگی سمت Ask");
  }

  if(absorption.type==="BUY_ABSORPTION"){
    score+=10;
    reasons.push("Buy Absorption");
  }

  if(absorption.type==="SELL_ABSORPTION"){
    score-=10;
    reasons.push("Sell Absorption");
  }

  if(sweep.type==="BUY_SWEEP"){
    score+=8;
    reasons.push("Liquidity Sweep پایین");
  }

  if(sweep.type==="SELL_SWEEP"){
    score-=8;
    reasons.push("Liquidity Sweep بالا");
  }

  score=clamp(score,0,100);

  let signal="WAIT";

  if(score>=70){
    signal="BUY";
  }else if(score<=30){
    signal="SELL";
  }else if(score>=55){
    signal="WATCH_BUY";
  }else if(score<=45){
    signal="WATCH_SELL";
  }

  return{
    version:VERSION,
    symbol,
    category:"linear",
    interval,

    ticker:tick,
    instrument:info,

    candles:selectedCandles,
    footprints,
    candleDelta,

    candles5,
    candles15,
    candles3,
    candles1,

    currentFlow,
    historicalFlow:candleDelta,
    flowPressure:
      flowPressure(currentFlow),

    orderbook:book,
    wall,
    heatmap,
    zones,

    sweep,
    tradeSweep,
    absorption,
    blocks,

    trades:tradeList.slice(-250),

    structure:{
      tf5:structure5,
      tf15:structure15,
      tf1:structure1
    },

    supportResistance:sr,
    movement:move,
    pressure:
      flowPressure(currentFlow),
    oiFunding:oi,
    entry,
    zone,

    score,
    signal,
    reasons,

    lastPrice:tick.last,
    serverTime:Date.now()
  };
}

async function live(
  symbol,
  interval
){
  const selectedInterval=
    normalizeInterval(interval);

  const[
    tick,
    book,
    tradeList,
    candles,
    info
  ]=await Promise.all([
    ticker("linear",symbol),
    orderbook(
      "linear",
      symbol,
      ORDERBOOK_LIMIT
    ),
    trades(
      "linear",
      symbol,
      TRADE_LIMIT
    ),
    kline(
      "linear",
      symbol,
      selectedInterval,
      180
    ),
    instrumentInfo(
      "linear",
      symbol
    )
  ]);

  const footprints=
    buildFootprints(
      candles,
      tradeList,
      selectedInterval,
      info.tickSize
    );

  const delta=
    candleDeltaSeries(
      footprints
    );

  const enriched=
    candles.map((c,i)=>({
      ...c,
      ...(delta[i]||{})
    }));

  const current=
    candles[candles.length-1];

  const currentFlow=current
    ?flowFromTrades(
      tradeList,
      current.time,
      current.time+
        intervalMs(selectedInterval)-1
    )
    :flowFromTrades([]);

  const wall=analyzeWalls(book);

  return{
    version:VERSION,
    symbol,
    category:"linear",
    interval:selectedInterval,

    ticker:tick,
    instrument:info,

    candles:enriched,
    footprints,
    candleDelta:delta,

    currentFlow,
    flowPressure:
      flowPressure(currentFlow),

    orderbook:book,
    wall,
    heatmap:buildHeatmap(book),
    zones:buildLiquidityZones(book),

    sweep:detectSweep(candles),
    tradeSweep:
      detectTradeSweep(tradeList),

    absorption:detectAbsorption(
      currentFlow,
      current||{
        open:0,
        high:0,
        low:0,
        close:0
      },
      wall
    ),

    blocks:analyzeBlocks(tradeList),

    trades:tradeList.slice(-250),

    lastPrice:tick.last,
    serverTime:Date.now()
  };
}

async function getSymbols(){
  const result=await bybit(
    "/v5/market/instruments-info",
    {
      category:"linear",
      status:"Trading",
      limit:1000
    }
  );

  return(result?.list||[])
    .filter(x=>
      x.quoteCoin==="USDT"&&
      x.contractType==="LinearPerpetual"&&
      x.status==="Trading"
    )
    .map(x=>x.symbol)
    .slice(0,MAX_SYMBOLS);
}

async function scan(offset=0){
  const symbols=await getSymbols();

  const start=Math.max(
    0,
    Number(offset)||0
  );

  const batch=symbols.slice(
    start,
    start+SCAN_BATCH
  );

  const results=[];

  for(const symbol of batch){
    try{
      const a=await analyze(
        symbol,
        TF
      );

      if(a.score>=55){
        results.push({
          symbol,
          score:a.score,
          signal:a.signal,
          price:a.lastPrice,
          deltaPercent:
            a.currentFlow?.deltaPercent||0,
          pressure:a.pressure,
          absorption:
            a.absorption?.type||"NONE",
          sweep:
            a.sweep?.type||"NONE"
        });
      }
    }catch(e){
      results.push({
        symbol,
        score:0,
        signal:"ERROR",
        error:e.message
      });
    }

    await sleep(25);
  }

  results.sort(
    (a,b)=>b.score-a.score
  );

  return{
    version:VERSION,
    offset:start,
    nextOffset:
      start+SCAN_BATCH>=symbols.length
        ?0
        :start+SCAN_BATCH,
    totalSymbols:symbols.length,
    results
  };
}

function validSymbol(value){
  return/^[A-Z0-9._-]{2,40}$/i.test(
    String(value||"")
  );
}

export default{
  async fetch(request,env){
    if(request.method==="OPTIONS"){
      return new Response(null,{
        status:204,
        headers:{
          "access-control-allow-origin":"*",
          "access-control-allow-methods":
            "GET,POST,OPTIONS",
          "access-control-allow-headers":
            "Content-Type"
        }
      });
    }

    const url=new URL(request.url);
    const path=url.pathname;

    try{
      if(path==="/api/health"){
        return json({
          ok:true,
          online:true,
          bybit:BYBIT,
          version:VERSION,
          time:Date.now()
        });
      }

      if(path==="/api/test-bybit"){
        const t=await ticker(
          "linear",
          "BTCUSDT"
        );

        return json({
          ok:true,
          bybit:true,
          ticker:t,
          version:VERSION
        });
      }

      if(path==="/api/symbols"){
        return json({
          ok:true,
          symbols:await getSymbols()
        });
      }

      if(path==="/api/analyze"){
        const symbol=String(
          url.searchParams.get("symbol")||
          "BTCUSDT"
        )
        .trim()
        .toUpperCase();

        const selectedInterval=
          normalizeInterval(
            url.searchParams.get("interval")||
            TF
          );

        if(!validSymbol(symbol)){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        return json(
          await analyze(
            symbol,
            selectedInterval
          )
        );
      }

      if(path==="/api/chart"){
        const symbol=String(
          url.searchParams.get("symbol")||
          "BTCUSDT"
        )
        .trim()
        .toUpperCase();

        const selectedInterval=
          normalizeInterval(
            url.searchParams.get("interval")||
            TF
          );

        if(!validSymbol(symbol)){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        return json(
          await buildChartData(
            symbol,
            selectedInterval
          )
        );
      }

      if(path==="/api/live"){
        const symbol=String(
          url.searchParams.get("symbol")||
          "BTCUSDT"
        )
        .trim()
        .toUpperCase();

        const selectedInterval=
          normalizeInterval(
            url.searchParams.get("interval")||
            TF
          );

        if(!validSymbol(symbol)){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        return json(
          await live(
            symbol,
            selectedInterval
          )
        );
      }

      if(path==="/api/scan"){
        const offset=Number(
          url.searchParams.get("offset")||0
        );

        return json(
          await scan(offset)
        );
      }

      return env.ASSETS.fetch(request);

    }catch(error){
      return json({
        ok:false,
        error:error?.message||String(error),
        version:VERSION
      },500);
    }
  }
};
