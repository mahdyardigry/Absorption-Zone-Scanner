const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ORDERFLOW-MAP-V1";

const TF = "5";
const TF15 = "15";
const TF3 = "3";
const TF1 = "1";

const KLINE_LIMIT = 240;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  }
});

const n = (v,d=0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

const clamp = (x,a,b) => Math.max(a,Math.min(b,x));

const pct = (a,b) => b ? (a-b)/b*100 : 0;

const avg = a => a.length
  ? a.reduce((s,x)=>s+x,0)/a.length
  : 0;

async function bybit(path, params={}) {
  const u = new URL(BYBIT + path);

  Object.entries(params).forEach(([k,v]) => {
    if(v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k,String(v));
    }
  });

  const r = await fetch(u.toString(), {
    headers: {
      "accept":"application/json"
    }
  });

  if(!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d = await r.json();

  if(n(d.retCode,0)!==0) {
    throw new Error(d.retMsg || "Bybit API error");
  }

  return d;
}


/* =========================================================
   KLINES
========================================================= */

async function kline(
  category,
  symbol,
  interval=TF,
  limit=KLINE_LIMIT
) {
  const d = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  return (d.result?.list||[])
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


/* =========================================================
   TICKER
========================================================= */

async function ticker(category,symbol) {

  const d = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  const x = d.result?.list?.[0] || {};

  return {
    lastPrice:n(x.lastPrice),
    markPrice:n(x.markPrice),
    indexPrice:n(x.indexPrice),

    turnover24h:n(x.turnover24h),
    volume24h:n(x.volume24h),

    price24hPcnt:n(x.price24hPcnt)*100,

    openInterest:n(x.openInterest),

    fundingRate:n(x.fundingRate)*100
  };
}


/* =========================================================
   REAL TRADES
========================================================= */

async function trades(
  category,
  symbol,
  limit=TRADE_LIMIT
) {

  const d = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit
    }
  );

  return (d.result?.list||[])
    .map(x=>({
      id:String(x.execId||x.id||""),
      time:n(x.time),
      price:n(x.price),
      size:n(x.size),
      side:String(x.side||"").toLowerCase(),
      isBuyerMaker:Boolean(x.isBuyerMaker)
    }))
    .sort((a,b)=>a.time-b.time);
}


/* =========================================================
   ORDER BOOK
========================================================= */

async function orderbook(
  category,
  symbol,
  limit=ORDERBOOK_LIMIT
) {

  const d = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit
    }
  );

  const r=d.result||{};

  const bids=(r.b||[])
    .map(x=>({
      price:n(x[0]),
      size:n(x[1]),
      value:n(x[0])*n(x[1])
    }))
    .filter(x=>x.price>0&&x.size>0);

  const asks=(r.a||[])
    .map(x=>({
      price:n(x[0]),
      size:n(x[1]),
      value:n(x[0])*n(x[1])
    }))
    .filter(x=>x.price>0&&x.size>0);

  return {
    bids,
    asks,
    ts:n(r.ts)||Date.now()
  };
}


/* =========================================================
   OPEN INTEREST + FUNDING
========================================================= */

async function oiFunding(symbol) {

  const [
    t,
    oi,
    f
  ] = await Promise.all([

    ticker(
      "linear",
      symbol
    ),

    bybit(
      "/v5/market/open-interest",
      {
        category:"linear",
        symbol,
        intervalTime:"5min",
        limit:50
      }
    ),

    bybit(
      "/v5/market/funding/history",
      {
        category:"linear",
        symbol,
        limit:2
      }
    )
  ]);

  const o=(oi.result?.list||[])
    .map(x=>({
      time:n(x.timestamp),
      value:n(x.openInterest)
    }))
    .sort((a,b)=>a.time-b.time);

  const fl=(f.result?.list||[])
    .map(x=>({
      time:n(x.fundingRateTimestamp),
      rate:n(x.fundingRate)*100
    }))
    .sort((a,b)=>a.time-b.time);

  const current =
    t.openInterest ||
    o.at(-1)?.value ||
    0;

  const previous =
    o.at(-2)?.value ||
    current;

  return {

    openInterest:current,

    previousOpenInterest:previous,

    changePercent:
      previous
        ? pct(current,previous)
        : 0,

    fundingRate:t.fundingRate,

    previousFundingRate:
      fl.at(-2)?.rate ??
      t.fundingRate,

    fundingHistory:
      fl.slice(-10),

    oiHistory:
      o.slice(-20)
  };
}


/* =========================================================
   EMA
========================================================= */

function ema(values,p) {

  if(values.length<p) {
    return null;
  }

  let e=avg(
    values.slice(0,p)
  );

  const k=2/(p+1);

  for(
    let i=p;
    i<values.length;
    i++
  ) {
    e =
      values[i]*k +
      e*(1-k);
  }

  return e;
}


/* =========================================================
   SMA
========================================================= */

function sma(values,p) {

  if(values.length<p) {
    return null;
  }

  return avg(
    values.slice(-p)
  );
}


/* =========================================================
   ATR
========================================================= */

function atr(c,p=14) {

  if(c.length<p+1) {
    return 0;
  }

  const tr=[];

  for(
    let i=1;
    i<c.length;
    i++
  ) {

    tr.push(
      Math.max(
        c[i].high-c[i].low,

        Math.abs(
          c[i].high-c[i-1].close
        ),

        Math.abs(
          c[i].low-c[i-1].close
        )
      )
    );
  }

  return avg(
    tr.slice(-p)
  );
}


/* =========================================================
   RSI
========================================================= */

function rsi(c,p=14) {

  if(c.length<p+1) {
    return 50;
  }

  let gains=0;
  let losses=0;

  for(
    let i=1;
    i<=p;
    i++
  ) {

    const d =
      c[i].close -
      c[i-1].close;

    if(d>=0) {
      gains+=d;
    } else {
      losses-=d;
    }
  }

  let ag=gains/p;
  let al=losses/p;

  for(
    let i=p+1;
    i<c.length;
    i++
  ) {

    const d =
      c[i].close -
      c[i-1].close;

    ag =
      (
        ag*(p-1) +
        Math.max(d,0)
      )/p;

    al =
      (
        al*(p-1) +
        Math.max(-d,0)
      )/p;
  }

  return al===0
    ? 100
    : 100-(100/(1+ag/al));
}


/* =========================================================
   CANDLE
========================================================= */

function candleStats(c) {

  const x=c.at(-1);

  if(!x) {
    return null;
  }

  const range=
    Math.max(
      x.high-x.low,
      1e-12
    );

  const body=
    Math.abs(
      x.close-x.open
    );

  return {

    bullish:
      x.close>x.open,

    bearish:
      x.close<x.open,

    body,

    range,

    bodyRatio:
      body/range,

    upperWick:
      x.high-
      Math.max(
        x.open,
        x.close
      ),

    lowerWick:
      Math.min(
        x.open,
        x.close
      )-
      x.low,

    lowerWickRatio:
      (
        Math.min(
          x.open,
          x.close
        )-
        x.low
      )/range,

    upperWickRatio:
      (
        x.high-
        Math.max(
          x.open,
          x.close
        )
      )/range,

    changePercent:
      pct(
        x.close,
        x.open
      )
  };
}


/* =========================================================
   REAL ORDER FLOW

   Bybit:
   isBuyerMaker=true
   یعنی خریدار Maker است
   بنابراین فروشنده Aggressor است.

   isBuyerMaker=false
   یعنی خریدار Aggressor است.
========================================================= */

function flowFromTrades(
  list,
  start=0,
  end=Infinity
) {

  const t=
    list.filter(
      x=>
        x.time>=start &&
        x.time<=end
    );

  let buyVol=0;
  let sellVol=0;

  let buyValue=0;
  let sellValue=0;

  let buyTrades=0;
  let sellTrades=0;

  let largest=0;

  for(const x of t) {

    const value=
      x.price*x.size;

    largest=
      Math.max(
        largest,
        value
      );

    const buyAgg =
      !x.isBuyerMaker &&
      x.side!=="sell";

    if(
      buyAgg ||
      x.side==="buy"
    ) {

      buyVol+=x.size;

      buyValue+=value;

      buyTrades++;

    } else {

      sellVol+=x.size;

      sellValue+=value;

      sellTrades++;
    }
  }

  const total=
    buyVol+sellVol;

  const totalValue=
    buyValue+sellValue;

  const delta=
    buyVol-sellVol;

  const deltaValue=
    buyValue-sellValue;

  return {

    tradeCount:t.length,

    buyTrades,
    sellTrades,

    buyVolume:buyVol,
    sellVolume:sellVol,

    buyValue,
    sellValue,

    totalVolume:total,
    totalValue,

    delta,
    deltaValue,

    deltaPercent:
      total
        ? delta/total*100
        : 0,

    deltaValuePercent:
      totalValue
        ? deltaValue/totalValue*100
        : 0,

    buyShare:
      totalValue
        ? buyValue/totalValue*100
        : 50,

    sellShare:
      totalValue
        ? sellValue/totalValue*100
        : 50,

    largestTradeValue:
      largest,

    firstTime:
      t[0]?.time||0,

    lastTime:
      t.at(-1)?.time||0
  };
}


/* =========================================================
   BLOCK TRADES
========================================================= */

function blockTrades(
  list
) {

  if(!list.length) {
    return {
      threshold:0,
      trades:[]
    };
  }

  const values=
    list
      .map(
        x=>x.price*x.size
      )
      .filter(
        x=>x>0
      )
      .sort(
        (a,b)=>a-b
      );

  const average=
    avg(values);

  const p95=
    values[
      Math.floor(
        values.length*.95
      )
    ] || 0;

  const threshold=
    Math.max(
      average*5,
      p95
    );

  const blocks=
    list
      .filter(
        x=>
          x.price*x.size>=threshold
      )
      .map(
        x=>({
          ...x,
          value:x.price*x.size,
          aggressor:
            (
              !x.isBuyerMaker &&
              x.side!=="sell"
            )
              ? "BUY"
              : "SELL"
        })
      )
      .sort(
        (a,b)=>b.value-a.value
      );

  return {
    threshold,
    trades:blocks.slice(0,50)
  };
}


/* =========================================================
   ORDER BOOK / WALLS
========================================================= */

function wallAnalysis(
  ob,
  price
) {

  const all=[
    ...ob.bids.map(
      x=>({
        ...x,
        side:"BUY"
      })
    ),

    ...ob.asks.map(
      x=>({
        ...x,
        side:"SELL"
      })
    )
  ];

  const values=
    all
      .map(x=>x.value)
      .sort(
        (a,b)=>a-b
      );

  const med=
    values.length
      ? values[
          Math.floor(
            values.length/2
          )
        ]
      : 0;

  const threshold=
    Math.max(
      med*4,
      price*0.00001
    );

  const buyWalls=
    ob.bids
      .filter(
        x=>
          x.value>=threshold
      )
      .map(
        x=>({
          ...x,
          distancePercent:
            Math.abs(
              pct(
                x.price,
                price
              )
            )
        })
      )
      .sort(
        (a,b)=>b.value-a.value
      );

  const sellWalls=
    ob.asks
      .filter(
        x=>
          x.value>=threshold
      )
      .map(
        x=>({
          ...x,
          distancePercent:
            Math.abs(
              pct(
                x.price,
                price
              )
            )
        })
      )
      .sort(
        (a,b)=>b.value-a.value
      );

  const nearBuy=
    buyWalls.filter(
      x=>x.distancePercent<=1.5
    );

  const nearSell=
    sellWalls.filter(
      x=>x.distancePercent<=1.5
    );

  const bidValue=
    ob.bids.reduce(
      (s,x)=>s+x.value,
      0
    );

  const askValue=
    ob.asks.reduce(
      (s,x)=>s+x.value,
      0
    );

  const total=
    bidValue+askValue;

  return {

    bestBid:
      ob.bids[0]?.price||0,

    bestAsk:
      ob.asks[0]?.price||0,

    bidValue,
    askValue,

    buyShare:
      total
        ? bidValue/total*100
        : 50,

    sellShare:
      total
        ? askValue/total*100
        : 50,

    imbalance:
      total
        ? (
            bidValue-askValue
          )/total*100
        : 0,

    buyWalls:
      buyWalls.slice(0,12),

    sellWalls:
      sellWalls.slice(0,12),

    strongestBuy:
      buyWalls[0]||null,

    strongestSell:
      sellWalls[0]||null,

    nearBuy:
      nearBuy.slice(0,8),

    nearSell:
      nearSell.slice(0,8)
  };
}


/* =========================================================
   LIQUIDITY ZONES
========================================================= */

function liquidityZones(
  c,
  ob,
  price
) {

  const levels=[];

  for(
    const x of ob.bids.slice(0,30)
  ) {

    levels.push({
      price:x.price,
      value:x.value,
      side:"BUY",
      source:"ORDERBOOK"
    });
  }

  for(
    const x of ob.asks.slice(0,30)
  ) {

    levels.push({
      price:x.price,
      value:x.value,
      side:"SELL",
      source:"ORDERBOOK"
    });
  }

  const lows=
    c.slice(-80)
      .map(x=>x.low);

  const highs=
    c.slice(-80)
      .map(x=>x.high);

  const zones=[

    {
      price:
        Math.min(
          ...lows.slice(-20)
        ),
      side:"BUY",
      source:"PRICE_LOW",
      value:0
    },

    {
      price:
        Math.max(
          ...highs.slice(-20)
        ),
      side:"SELL",
      source:"PRICE_HIGH",
      value:0
    }
  ];

  const merged=[
    ...levels,
    ...zones
  ]
    .sort(
      (a,b)=>
        b.value-a.value
    );

  return merged
    .slice(0,30)
    .map(
      x=>({
        ...x,
        distancePercent:
          Math.abs(
            pct(
              x.price,
              price
            )
          )
      })
    );
}


/* =========================================================
   LIQUIDITY SWEEP
========================================================= */

function detectSweep(c) {

  if(c.length<8) {

    return {
      detected:false,
      direction:"NONE",
      strength:0
    };
  }

  const x=c.at(-1);

  const prior=
    c.slice(-7,-1);

  const ph=
    Math.max(
      ...prior.map(
        z=>z.high
      )
    );

  const pl=
    Math.min(
      ...prior.map(
        z=>z.low
      )
    );

  let direction="NONE";
  let strength=0;

  const a=
    Math.max(
      atr(c),
      1e-12
    );

  if(
    x.low<pl &&
    x.close>pl
  ) {

    direction="LONG";

    strength=
      clamp(
        (
          (pl-x.low)/a
        )*35+30,
        0,
        100
      );

  } else if(
    x.high>ph &&
    x.close<ph
  ) {

    direction="SHORT";

    strength=
      clamp(
        (
          (x.high-ph)/a
        )*35+30,
        0,
        100
      );
  }

  return {
    detected:
      direction!=="NONE",

    direction,

    strength,

    priorHigh:ph,
    priorLow:pl
  };
}


/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  c,
  flow
) {

  if(c.length<20) {

    return {
      detected:false,
      direction:"NONE",
      score:0,
      real:false
    };
  }

  const x=c.at(-1);

  const s=
    candleStats(c);

  const recentVol=
    avg(
      c.slice(
        -21,
        -1
      ).map(
        z=>z.volume
      )
    );

  const volumeRatio=
    recentVol
      ? x.volume/recentVol
      : 1;

  const range=
    Math.max(
      s.range,
      1e-12
    );

  const closeLocation=
    (
      x.close-x.low
    )/range;

  const buyAgg=
    flow.buyValue;

  const sellAgg=
    flow.sellValue;

  const total=
    buyAgg+sellAgg;

  let direction="NONE";

  let score=0;

  const reason=[];

  if(total>0) {

    /* BUYER ABSORPTION
       aggressive sellers hit bids,
       but price does not continue lower.
    */

    if(
      sellAgg>buyAgg*1.35 &&
      closeLocation>=0.55 &&
      s.lowerWickRatio>=0.25
    ) {

      direction="LONG";

      score+=30;

      reason.push(
        "فشار فروش واقعی با واکنش مثبت قیمت"
      );
    }


    /* SELLER ABSORPTION
       aggressive buyers hit asks,
       but price does not continue higher.
    */

    if(
      buyAgg>sellAgg*1.35 &&
      (
        x.high-x.close
      )/range>=0.25 &&
      s.upperWickRatio>=0.25
    ) {

      direction="SHORT";

      score+=30;

      reason.push(
        "فشار خرید واقعی با رد شدن قیمت"
      );
    }
  }

  if(
    volumeRatio>=1.5
  ) {

    score+=20;

    reason.push(
      "حجم بالاتر از میانگین"
    );
  }

  if(
    s.bodyRatio<=0.45
  ) {

    score+=15;

    reason.push(
      "فشردگی بدنه"
    );
  }

  if(
    direction==="LONG" &&
    s.lowerWickRatio>=0.35
  ) {

    score+=15;
  }

  if(
    direction==="SHORT" &&
    s.upperWickRatio>=0.35
  ) {

    score+=15;
  }

  const real=
    direction!=="NONE" &&
    flow.tradeCount>=8 &&
    total>0;

  if(real) {

    score+=20;
  }

  score=
    clamp(
      score,
      0,
      100
    );

  return {

    detected:
      direction!=="NONE" &&
      score>=55,

    real,

    direction,

    score,

    tradeCount:
      flow.tradeCount,

    buyValue:
      buyAgg,

    sellValue:
      sellAgg,

    buyVolume:
      flow.buyVolume,

    sellVolume:
      flow.sellVolume,

    deltaValue:
      flow.deltaValue,

    deltaPercent:
      flow.deltaValuePercent,

    volumeRatio,

    priceMove:
      s.changePercent,

    lowerWickRatio:
      s.lowerWickRatio,

    upperWickRatio:
      s.upperWickRatio,

    reason
  };
}


/* =========================================================
   MARKET STRUCTURE
========================================================= */

function structure(c) {

  const x=c.at(-1);

  const e8=
    ema(
      c.map(z=>z.close),
      8
    );

  const e20=
    ema(
      c.map(z=>z.close),
      20
    );

  const highs=
    c.slice(-30)
      .map(z=>z.high);

  const lows=
    c.slice(-30)
      .map(z=>z.low);

  const rh=
    Math.max(
      ...highs.slice(-10)
    );

  const ph=
    Math.max(
      ...highs.slice(
        -20,
        -10
      )
    );

  const rl=
    Math.min(
      ...lows.slice(-10)
    );

  const pl=
    Math.min(
      ...lows.slice(
        -20,
        -10
      )
    );

  const trend=
    x.close>e8 &&
    e8>e20

      ? "BULLISH"

      : x.close<e8 &&
        e8<e20

        ? "BEARISH"

        : "NEUTRAL";

  return {

    trend,

    ema8:e8,
    ema20:e20,

    higherHigh:
      rh>ph,

    higherLow:
      rl>pl,

    recentHigh:rh,
    recentLow:rl
  };
}


/* =========================================================
   1M ENTRY
========================================================= */

function entry1m(
  c,
  zone,
  direction
) {

  if(
    !c.length ||
    direction==="NONE" ||
    direction==="WAIT"
  ) {

    return {
      status:"WAIT",
      direction:"NONE"
    };
  }

  const x=c.at(-1);

  const e8=
    ema(
      c.map(z=>z.close),
      8
    );

  const e20=
    ema(
      c.map(z=>z.close),
      20
    );

  const a=
    atr(c,14) ||
    Math.abs(
      x.high-x.low
    );

  const bullish=
    x.close>x.open;

  const bearish=
    x.close<x.open;


  if(
    direction==="LONG"
  ) {

    const ready=
      x.close>e8 &&
      e8>e20 &&
      bullish &&
      (
        zone?.low
          ? x.close>=zone.low*.995
          : true
      );

    const entryLow=
      Math.min(
        x.close,
        zone?.high||x.close
      );

    const entryHigh=
      Math.max(
        x.close,
        zone?.high||x.close
      );

    const sl=
      (
        zone?.low||
        x.low
      )-
      a*.35;

    const risk=
      Math.max(
        x.close-sl,
        a*.4
      );

    return {

      status:
        ready
          ? "READY"
          : "WAIT",

      direction:"LONG",

      currentPrice:
        x.close,

      entryLow,

      entryHigh,

      trigger:
        x.high+a*.08,

      stopLoss:
        sl,

      target1:
        x.close+risk,

      target2:
        x.close+risk*2,

      riskPercent:
        risk/x.close*100,

      ema8:e8,
      ema20:e20,

      reason:
        ready
          ? "تأیید روند ۱ دقیقه و کندل صعودی"
          : "منتظر تأیید ۱ دقیقه"
    };
  }


  const ready=
    x.close<e8 &&
    e8<e20 &&
    bearish &&
    (
      zone?.high
        ? x.close<=zone.high*1.005
        : true
    );

  const entryLow=
    Math.min(
      x.close,
      zone?.low||x.close
    );

  const entryHigh=
    Math.max(
      x.close,
      zone?.low||x.close
    );

  const sl=
    (
      zone?.high||
      x.high
    )+
    a*.35;

  const risk=
    Math.max(
      sl-x.close,
      a*.4
    );

  return {

    status:
      ready
        ? "READY"
        : "WAIT",

    direction:"SHORT",

    currentPrice:
      x.close,

    entryLow,

    entryHigh,

    trigger:
      x.low-a*.08,

    stopLoss:
      sl,

    target1:
      x.close-risk,

    target2:
      x.close-risk*2,

    riskPercent:
      risk/x.close*100,

    ema8:e8,
    ema20:e20,

    reason:
      ready
        ? "تأیید روند ۱ دقیقه و کندل نزولی"
        : "منتظر تأیید ۱ دقیقه"
  };
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(c) {

  const highs=
    c.slice(-100)
      .map(x=>x.high);

  const lows=
    c.slice(-100)
      .map(x=>x.low);

  return {

    resistance:
      Math.max(...highs),

    support:
      Math.min(...lows),

    recentResistance:
      Math.max(
        ...highs.slice(-20)
      ),

    recentSupport:
      Math.min(
        ...lows.slice(-20)
      )
  };
}


/* =========================================================
   MAIN ANALYSIS
========================================================= */

async function analyze(symbol) {

  symbol=
    String(symbol)
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  const [

    c5,
    c15,
    c3,
    c1,

    t,
    ob,
    of

  ] = await Promise.all([

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
      120
    ),

    kline(
      "linear",
      symbol,
      TF3,
      160
    ),

    kline(
      "linear",
      symbol,
      TF1,
      200
    ),

    ticker(
      "linear",
      symbol
    ),

    orderbook(
      "linear",
      symbol,
      ORDERBOOK_LIMIT
    ),

    trades(
      "linear",
      symbol,
      TRADE_LIMIT
    )
  ]);


  const x=c5.at(-1);

  const start=
    x?.time||0;

  const end=
    start+
    5*60*1000-
    1;


  /* تلاش برای تطبیق معاملات واقعی
     با همان کندل */

  const historical=
    flowFromTrades(
      of,
      start,
      end
    );


  /* فشار لحظه‌ای */

  const current=
    flowFromTrades(
      of,
      0,
      Infinity
    );


  const flow=
    historical.tradeCount>=8
      ? historical
      : current;


  const historicalMatched=
    historical.tradeCount>=8;


  const wall=
    wallAnalysis(
      ob,
      x.close
    );


  const absorption=
    detectAbsorption(
      c5,
      flow
    );


  const sweep=
    detectSweep(
      c5
    );


  const st=
    structure(c5);


  const zone=
    absorption.detected

      ? {
          low:x.low,
          high:
            Math.max(
              x.open,
              x.close
            )
        }

      : {
          low:
            Math.min(
              ...c5
                .slice(-12)
                .map(z=>z.low)
            ),

          high:
            Math.max(
              ...c5
                .slice(-12)
                .map(z=>z.high)
            )
        };


  const f15=
    structure(c15);

  const f3=
    structure(c3);

  const f1=
    structure(c1);


  const pressure=
    current.deltaValue>0
      ? "BUY"
      : current.deltaValue<0
        ? "SELL"
        : "NEUTRAL";


  const movement=

    f15.trend==="BULLISH" &&
    f3.trend!=="BEARISH"

      ? "LONG"

      : f15.trend==="BEARISH" &&
        f3.trend!=="BULLISH"

        ? "SHORT"

        : "WAIT";


  /* =====================================================
     SMART MONEY SCORE
  ===================================================== */

  let score=0;


  if(
    absorption.detected
  ) {

    score+=
      absorption.score*.40;
  }


  score+=
    clamp(
      Math.abs(
        current.deltaValuePercent
      )*.18,
      0,
      15
    );


  score+=
    clamp(
      Math.abs(
        wall.imbalance
      )*.12,
      0,
      12
    );


  score+=
    f15.trend==="BULLISH"
      ? 8
      : f15.trend==="BEARISH"
        ? 0
        : 4;


  score+=
    f3.trend==="BULLISH"
      ? 6
      : f3.trend==="BEARISH"
        ? 0
        : 3;


  if(
    sweep.detected
  ) {
    score+=8;
  }


  if(
    (
      movement==="LONG" &&
      absorption.direction==="LONG"
    ) ||
    (
      movement==="SHORT" &&
      absorption.direction==="SHORT"
    )
  ) {

    score+=10;
  }


  score=
    clamp(
      score,
      0,
      100
    );


  const direction=
    score>=70

      ? (
          movement==="WAIT"
            ? absorption.direction
            : movement
        )

      : "WAIT";


  const signal=
    score>=85
      ? "STRONG"

      : score>=70
        ? "SIGNAL"

        : score>=55
          ? "WATCH"

          : "NO_SIGNAL";


  const entry=
    entry1m(
      c1,
      zone,
      direction
    );


  const oiFundingData=
    await oiFunding(
      symbol
    );


  const blocks=
    blockTrades(
      of
    );


  const sr=
    supportResistance(
      c5
    );


  return {

    ok:true,

    version:VERSION,

    category:"linear",

    symbol,

    serverTime:
      Date.now(),

    price:
      x.close,

    ticker:t,


    candles:{

      tf5:
        c5.slice(-100),

      tf15:
        c15.slice(-80),

      tf3:
        c3.slice(-80),

      tf1:
        c1.slice(-120)
    },


    orderbook:ob,

    wall,


    liquidityZones:
      liquidityZones(
        c5,
        ob,
        x.close
      ),


    trades:
      of.slice(-250),


    currentFlow:
      current,


    historicalFlow:{

      ...historical,

      candleTime:start,

      matched:
        historicalMatched
    },


    absorption:{

      ...absorption,

      source:
        historicalMatched
          ? "REAL_BYBIT_TRADES"
          : "STRUCTURAL_CANDLE_ONLY"
    },


    blocks,


    sweep,


    structure:st,


    supportResistance:sr,


    timeframes:{

      "15m":f15,
      "3m":f3,
      "1m":f1
    },


    movement:{

      direction:movement,

      label:
        movement==="LONG"
          ? "مسیر صعودی"

          : movement==="SHORT"
            ? "مسیر نزولی"

            : "خنثی/نامشخص"
    },


    pressure,


    oiFunding:
      oiFundingData,


    entry1m:
      entry,


    zone,


    score:
      Math.round(score),


    signal,


    signalLabel:

      signal==="STRONG"

        ? "سیگنال بسیار قوی"

        : signal==="SIGNAL"

          ? "سیگنال"

          : signal==="WATCH"

            ? "در حال رصد"

            : "بدون سیگنال",


    reasons:[

      ...(absorption.reason||[]),

      sweep.detected

        ? (
            sweep.direction==="LONG"
              ? "جمع‌آوری نقدینگی زیر کف"
              : "جمع‌آوری نقدینگی بالای سقف"
          )

        : null,

      `فشار لحظه‌ای: ${
        pressure==="BUY"
          ? "خرید"
          : pressure==="SELL"
            ? "فروش"
            : "خنثی"
      }`,

      `مسیر: ${
        movement==="LONG"
          ? "صعودی"
          : movement==="SHORT"
            ? "نزولی"
            : "نامشخص"
      }`,

      historicalMatched
        ? "معاملات واقعی با بازه کندل تطبیق داده شد"
        : "معاملات تاریخی کافی برای تطبیق با کندل در دسترس نبود"
    ]
  };
}


/* =========================================================
   SYMBOLS
========================================================= */

async function getSymbols() {

  const d=
    await bybit(
      "/v5/market/instruments-info",
      {
        category:"linear",
        limit:1000
      }
    );


  return (
    d.result?.list||[]
  )

    .filter(
      x=>
        x.status==="Trading" &&
        x.quoteCoin==="USDT" &&
        x.contractType==="LinearPerpetual"
    )

    .map(
      x=>x.symbol
    )

    .slice(
      0,
      MAX_SYMBOLS
    );
}


/* =========================================================
   SCAN
========================================================= */

async function scan(
  offset=0
) {

  const symbols=
    await getSymbols();

  const batch=[];

  for(
    let i=0;
    i<
      Math.min(
        SCAN_BATCH,
        symbols.length
      );
    i++
  ) {

    const symbol=
      symbols[
        (offset+i)%
        symbols.length
      ];

    try {

      const a=
        await analyze(
          symbol
        );

      if(
        a.score>=55
      ) {

        batch.push({

          symbol:a.symbol,

          price:a.price,

          score:a.score,

          signal:a.signal,

          movement:
            a.movement,

          absorption:
            a.absorption,

          pressure:
            a.pressure,

          oiChange:
            a.oiFunding
              .changePercent
        });
      }

    } catch(e) {}
  }


  batch.sort(
    (a,b)=>
      b.score-a.score
  );


  return {

    ok:true,

    version:VERSION,

    totalSymbols:
      symbols.length,

    offset,

    nextOffset:
      (
        offset+SCAN_BATCH
      )%
      Math.max(
        symbols.length,
        1
      ),

    results:batch
  };
}


/* =========================================================
   ROUTER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const u=
      new URL(
        request.url
      );

    const p=
      u.pathname;


    try {

      if(
        request.method==="OPTIONS"
      ) {

        return new Response(
          "",
          {
            headers:{
              "access-control-allow-origin":"*",
              "access-control-allow-methods":"GET,OPTIONS",
              "access-control-allow-headers":"*"
            }
          }
        );
      }


      if(
        p==="/api/health"
      ) {

        return json({

          ok:true,

          service:
            "Bybit Order Flow Map",

          version:VERSION,

          dataSource:
            "Bybit",

          features:[

            "کندل",

            "عمق سفارش",

            "Buy Wall",

            "Sell Wall",

            "نقدینگی",

            "معاملات واقعی",

            "حجم",

            "ارزش معاملات",

            "Delta",

            "Buy Pressure",

            "Sell Pressure",

            "Liquidity Sweep",

            "Absorption",

            "Block Trades",

            "Open Interest",

            "Funding",

            "حمایت",

            "مقاومت",

            "Smart Money Score"
          ]
        });
      }


      if(
        p==="/api/analyze"
      ) {

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        if(!symbol) {

          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }


        return json(
          await analyze(
            symbol
          )
        );
      }


      if(
        p==="/api/live"
      ) {

        const symbol=
          u.searchParams.get(
            "symbol"
          );


        if(!symbol) {

          return json(
            {
              ok:false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }


        const s=
          symbol.toUpperCase();


        const [
          t,
          ob,
          tr
        ] =
          await Promise.all([

            ticker(
              "linear",
              s
            ),

            orderbook(
              "linear",
              s,
              ORDERBOOK_LIMIT
            ),

            trades(
              "linear",
              s,
              TRADE_LIMIT
            )
          ]);


        const flow=
          flowFromTrades(
            tr
          );


        return json({

          ok:true,

          version:VERSION,

          symbol:s,

          serverTime:
            Date.now(),

          price:
            t.lastPrice,

          ticker:t,

          orderbook:ob,

          wall:
            wallAnalysis(
              ob,
              t.lastPrice
            ),

          trades:
            tr.slice(-250),

          flow,

          blocks:
            blockTrades(tr)
        });
      }


      if(
        p==="/api/scan"
      ) {

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            )
          )
        );
      }


      if(
        p==="/api/symbols"
      ) {

        return json({

          ok:true,

          symbols:
            await getSymbols()
        });
      }


      if(
        p==="/api/test-bybit"
      ) {

        return json(
          await ticker(
            "linear",
            "BTCUSDT"
          )
        );
      }


      return env.ASSETS.fetch(
        request
      );


    } catch(e) {

      return json(

        {
          ok:false,

          error:e.message,

          detail:
            String(
              e.stack||""
            ).slice(
              0,
              1600
            )
        },

        500
      );
    }
  }
};
