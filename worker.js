const BYBIT = "https://api.bybit.com";

const VERSION = "ABSORPTION-ORDERFLOW-24H-V6";

const TF = "5";
const TF15 = "15";
const TF3 = "3";
const TF1 = "1";

const KLINE_LIMIT = 1500;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const SCAN_BATCH = 20;
const MAX_SYMBOLS = 200;

const CHART_LIMIT = 1500;

const FOOTPRINT_HISTORY_HOURS = 24;
const FOOTPRINT_MAX_LEVELS = 500;

const ALLOWED_INTERVALS = [
  "1",
  "3",
  "5",
  "15",
  "30",
  "60"
];

const cache = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type"
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
  return a?.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function sum(a) {
  return a?.reduce((x, y) => x + n(y), 0) || 0;
}

function normalizeInterval(v) {
  const x = String(v || TF);
  return ALLOWED_INTERVALS.includes(x) ? x : TF;
}

function intervalMs(v) {
  return Number(normalizeInterval(v)) * 60 * 1000;
}

function floorTime(time, interval) {
  const ms = intervalMs(interval);
  return Math.floor(Number(time) / ms) * ms;
}

function priceDecimals(step) {
  const s = String(step ?? "");

  if (!s.includes(".")) return 0;

  return s.split(".")[1]
    .replace(/0+$/, "")
    .length;
}

function roundToStep(price, step) {
  const p = n(price);
  const s = n(step);

  if (!s) return p;

  return Number(
    (Math.round(p / s) * s)
      .toFixed(priceDecimals(s))
  );
}

async function bybit(path, params = {}) {
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== ""
    ) {
      qs.set(k, String(v));
    }
  }

  const url =
    `${BYBIT}${path}?${qs.toString()}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(
      `Bybit HTTP ${r.status}`
    );
  }

  const data = await r.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data.result;
}

async function instrumentInfo(category, symbol) {
  const key =
    `instrument:${category}:${symbol}`;

  if (cache.has(key)) {
    return cache.get(key);
  }

  const result =
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        symbol
      }
    );

  const item =
    result?.list?.[0];

  const info = {
    symbol,
    category,
    tickSize: n(
      item?.priceFilter?.tickSize,
      0.00000001
    ),
    minPrice: n(
      item?.priceFilter?.minPrice
    ),
    maxPrice: n(
      item?.priceFilter?.maxPrice
    ),
    qtyStep: n(
      item?.lotSizeFilter?.qtyStep
    ),
    minQty: n(
      item?.lotSizeFilter?.minOrderQty
    ),
    maxQty: n(
      item?.lotSizeFilter?.maxOrderQty
    )
  };

  cache.set(key, info);

  return info;
}

async function kline(
  category,
  symbol,
  interval,
  limit = KLINE_LIMIT
) {
  const result =
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval:
          normalizeInterval(interval),
        limit:
          Math.min(1000, limit)
      }
    );

  return (result?.list || [])
    .map(x => ({
      time: n(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }))
    .sort(
      (a, b) => a.time - b.time
    );
}

async function ticker(
  category,
  symbol
) {
  const result =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  const x =
    result?.list?.[0] || {};

  return {
    symbol,
    last: n(x.lastPrice),
    mark: n(x.markPrice),
    index: n(x.indexPrice),
    volume24h: n(x.volume24h),
    turnover24h: n(x.turnover24h),
    change24h:
      n(x.price24hPcnt) * 100,
    openInterest:
      n(x.openInterest),
    fundingRate:
      n(x.fundingRate)
  };
}

async function trades(
  category,
  symbol,
  limit = TRADE_LIMIT
) {
  const result =
    await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit:
          Math.min(1000, limit)
      }
    );

  return (result?.list || [])
    .map(x => {
      const side =
        String(x.side || "")
          .trim()
          .toUpperCase();

      return {
        id:
          x.execId ||
          x.id ||
          `${x.time}-${x.price}-${x.size}`,
        time: n(x.time),
        price: n(x.price),
        size: n(x.size),
        side,
        value:
          n(x.price) *
          n(x.size),
        isBlockTrade:
          Boolean(x.isBlockTrade),
        isRPITrade:
          Boolean(x.isRPITrade)
      };
    })
    .filter(x =>
      x.price > 0 &&
      x.size > 0 &&
      (
        x.side === "BUY" ||
        x.side === "SELL"
      )
    )
    .sort(
      (a, b) => a.time - b.time
    );
}

function aggressorSide(x) {
  const side =
    String(x?.side || "")
      .trim()
      .toUpperCase();

  if (side === "BUY") return "BUY";
  if (side === "SELL") return "SELL";

  return "UNKNOWN";
}

async function orderbook(
  category,
  symbol,
  limit = ORDERBOOK_LIMIT
) {
  const result =
    await bybit(
      "/v5/market/orderbook",
      {
        category,
        symbol,
        limit
      }
    );

  const bids =
    (result?.b || [])
      .map(x => {
        const price = n(x[0]);
        const size = n(x[1]);

        return {
          price,
          size,
          value:
            price * size
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      )
      .sort(
        (a, b) =>
          b.price - a.price
      );

  const asks =
    (result?.a || [])
      .map(x => {
        const price = n(x[0]);
        const size = n(x[1]);

        return {
          price,
          size,
          value:
            price * size
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      )
      .sort(
        (a, b) =>
          a.price - b.price
      );

  return {
    bids,
    asks,
    bestBid:
      bids[0]?.price || 0,
    bestAsk:
      asks[0]?.price || 0
  };
}

function flowFromTrades(
  list,
  start = 0,
  end = Infinity
) {
  const selected =
    (list || []).filter(t =>
      t.time >= start &&
      t.time <= end
    );

  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  for (const t of selected) {
    const side =
      aggressorSide(t);

    const value =
      n(
        t.value,
        n(t.price) *
        n(t.size)
      );

    if (side === "BUY") {
      buyVolume += n(t.size);
      buyValue += value;
      buyTrades++;
    }

    if (side === "SELL") {
      sellVolume += n(t.size);
      sellValue += value;
      sellTrades++;
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  const totalValue =
    buyValue + sellValue;

  const delta =
    buyVolume - sellVolume;

  const deltaValue =
    buyValue - sellValue;

  return {
    buyVolume,
    sellVolume,
    totalVolume,

    buyValue,
    sellValue,
    totalValue,

    delta,
    deltaValue,

    deltaPercent:
      pct(delta, totalVolume),

    deltaValuePercent:
      pct(deltaValue, totalValue),

    buyShare:
      pct(buyVolume, totalVolume),

    sellShare:
      pct(sellVolume, totalVolume),

    buyTrades,
    sellTrades,

    totalTrades:
      buyTrades + sellTrades,

    firstTime:
      selected[0]?.time || 0,

    lastTime:
      selected[selected.length - 1]?.time || 0
  };
}

function createFootprintLevel(price) {
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
    imbalanceValue: 0,

    side: "NEUTRAL",

    largestTradeValue: 0
  };
}

function buildFootprintForTrades(
  candle,
  tradeList,
  tickSize
) {
  const map = new Map();

  const start =
    candle.time;

  const end =
    candle.time +
    intervalMs(candle.interval) -
    1;

  for (const t of tradeList) {
    if (
      t.time < start ||
      t.time > end
    ) continue;

    const price =
      roundToStep(
        t.price,
        tickSize
      );

    if (!map.has(price)) {
      map.set(
        price,
        createFootprintLevel(
          price
        )
      );
    }

    const level =
      map.get(price);

    const size =
      n(t.size);

    const value =
      n(
        t.value,
        t.price * size
      );

    level.totalVolume += size;
    level.totalValue += value;

    level.largestTradeValue =
      Math.max(
        level.largestTradeValue,
        value
      );

    if (
      aggressorSide(t) === "BUY"
    ) {
      level.askVolume += size;
      level.askValue += value;
      level.askTrades++;
    }

    if (
      aggressorSide(t) === "SELL"
    ) {
      level.bidVolume += size;
      level.bidValue += value;
      level.bidTrades++;
    }
  }

  return [...map.values()]
    .map(level => {
      level.delta =
        level.askVolume -
        level.bidVolume;

      level.deltaValue =
        level.askValue -
        level.bidValue;

      if (
        level.bidVolume > 0
      ) {
        level.imbalance =
          level.askVolume /
          level.bidVolume;
      } else if (
        level.askVolume > 0
      ) {
        level.imbalance =
          Infinity;
      }

      if (
        level.delta > 0
      ) {
        level.side = "BUY";
      } else if (
        level.delta < 0
      ) {
        level.side = "SELL";
      } else {
        level.side = "NEUTRAL";
      }

      return level;
    })
    .sort(
      (a, b) =>
        b.price - a.price
    );
}

function buildFootprints(
  candles,
  tradeList,
  interval,
  tickSize
) {
  const ms =
    intervalMs(interval);

  const result = [];

  for (const candle of candles || []) {

    const start =
      candle.time;

    const end =
      start + ms;

    const localTrades =
      (tradeList || [])
        .filter(t =>
          t.time >= start &&
          t.time < end
        );

    const levels =
      buildFootprintForTrades(
        {
          ...candle,
          interval
        },
        localTrades,
        tickSize
      );

    const flow =
      flowFromTrades(
        localTrades,
        start,
        end - 1
      );

    result.push({
      time: candle.time,

      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,

      volume: candle.volume,
      turnover: candle.turnover,

      tradeCount:
        localTrades.length,

      flowVolume:
        flow.totalVolume,

      buyVolume:
        flow.buyVolume,

      sellVolume:
        flow.sellVolume,

      buyValue:
        flow.buyValue,

      sellValue:
        flow.sellValue,

      totalValue:
        flow.totalValue,

      buyTrades:
        flow.buyTrades,

      sellTrades:
        flow.sellTrades,

      delta:
        flow.delta,

      deltaValue:
        flow.deltaValue,

      deltaPercent:
        flow.deltaPercent,

      deltaValuePercent:
        flow.deltaValuePercent,

      cumulativeDeltaValue: 0,

      levels,

      imbalances:
        levels.filter(
          x =>
            x.imbalance >= 3 ||
            (
              x.imbalance > 0 &&
              x.imbalance <= 1 / 3
            )
        ).length
    });
  }

  let cumulative = 0;

  for (const fp of result) {
    cumulative +=
      n(fp.deltaValue);

    fp.cumulativeDeltaValue =
      cumulative;
  }

  return result;
}

/* =========================================================
   D1 FOOTPRINT STORAGE
========================================================= */

async function saveFootprintToD1(
  db,
  symbol,
  interval,
  footprints
) {
  if (!db) {
    return {
      saved: false,
      reason: "D1 binding missing"
    };
  }

  if (!footprints?.length) {
    return {
      saved: false,
      reason: "No footprint"
    };
  }

  const statements = [];

  for (const fp of footprints) {

    const candleTime =
      Number(fp.time);

    for (const level of fp.levels || []) {

      if (
        n(level.bidVolume) === 0 &&
        n(level.askVolume) === 0
      ) {
        continue;
      }

      statements.push(
        db.prepare(`
          INSERT INTO footprint_levels
          (
            symbol,
            interval,
            candle_time,
            price,
            bid_volume,
            ask_volume,
            bid_value,
            ask_value,
            bid_trades,
            ask_trades,
            delta,
            delta_value,
            total_volume,
            total_value,
            updated_at
          )
          VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT
          (
            symbol,
            interval,
            candle_time,
            price
          )
          DO UPDATE SET

            bid_volume =
              excluded.bid_volume,

            ask_volume =
              excluded.ask_volume,

            bid_value =
              excluded.bid_value,

            ask_value =
              excluded.ask_value,

            bid_trades =
              excluded.bid_trades,

            ask_trades =
              excluded.ask_trades,

            delta =
              excluded.delta,

            delta_value =
              excluded.delta_value,

            total_volume =
              excluded.total_volume,

            total_value =
              excluded.total_value,

            updated_at =
              excluded.updated_at
        `).bind(
          symbol,
          interval,
          candleTime,
          n(level.price),

          n(level.bidVolume),
          n(level.askVolume),

          n(level.bidValue),
          n(level.askValue),

          n(level.bidTrades),
          n(level.askTrades),

          n(level.delta),
          n(level.deltaValue),

          n(level.totalVolume),
          n(level.totalValue),

          Date.now()
        )
      );
    }
  }

  for (
    let i = 0;
    i < statements.length;
    i += 50
  ) {
    await db.batch(
      statements.slice(i, i + 50)
    );
  }

  return {
    saved: true,
    rows: statements.length
  };
}

async function readHistoricalFootprint(
  db,
  symbol,
  interval,
  hours = 24
) {
  if (!db) {
    return {
      available: false,
      reason: "D1 binding missing",
      footprints: []
    };
  }

  const now = Date.now();

  const from =
    now -
    Number(hours) *
    60 *
    60 *
    1000;

  const result =
    await db.prepare(`
      SELECT
        candle_time,
        price,
        bid_volume,
        ask_volume,
        bid_value,
        ask_value,
        bid_trades,
        ask_trades,
        delta,
        delta_value,
        total_volume,
        total_value
      FROM footprint_levels
      WHERE
        symbol = ?
        AND interval = ?
        AND candle_time >= ?
      ORDER BY
        candle_time ASC,
        price DESC
    `)
    .bind(
      symbol,
      interval,
      from
    )
    .all();

  const map = new Map();

  for (
    const row of result.results || []
  ) {

    const key =
      String(row.candle_time);

    if (!map.has(key)) {
      map.set(key, {
        time:
          Number(row.candle_time),

        levels: [],

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        totalVolume: 0,
        totalValue: 0,

        delta: 0,
        deltaValue: 0
      });
    }

    const fp =
      map.get(key);

    const level = {
      price:
        Number(row.price),

      bidVolume:
        Number(row.bid_volume),

      askVolume:
        Number(row.ask_volume),

      bidValue:
        Number(row.bid_value),

      askValue:
        Number(row.ask_value),

      bidTrades:
        Number(row.bid_trades),

      askTrades:
        Number(row.ask_trades),

      totalVolume:
        Number(row.total_volume),

      totalValue:
        Number(row.total_value),

      delta:
        Number(row.delta),

      deltaValue:
        Number(row.delta_value),

      side:
        Number(row.delta) > 0
          ? "BUY"
          : Number(row.delta) < 0
            ? "SELL"
            : "NEUTRAL"
    };

    fp.levels.push(level);

    fp.buyVolume +=
      level.askVolume;

    fp.sellVolume +=
      level.bidVolume;

    fp.buyValue +=
      level.askValue;

    fp.sellValue +=
      level.bidValue;

    fp.totalVolume +=
      level.totalVolume;

    fp.totalValue +=
      level.totalValue;

    fp.delta +=
      level.delta;

    fp.deltaValue +=
      level.deltaValue;
  }

  const candles =
    await kline(
      "linear",
      symbol,
      interval,
      1000
    );

  const candleMap =
    new Map(
      candles.map(
        c => [String(c.time), c]
      )
    );

  const footprints =
    [...map.values()]
      .map(fp => {

        const candle =
          candleMap.get(
            String(fp.time)
          );

        return {
          time: fp.time,

          open:
            candle?.open || 0,

          high:
            candle?.high || 0,

          low:
            candle?.low || 0,

          close:
            candle?.close || 0,

          volume:
            candle?.volume || 0,

          turnover:
            candle?.turnover || 0,

          buyVolume:
            fp.buyVolume,

          sellVolume:
            fp.sellVolume,

          totalVolume:
            fp.totalVolume,

          buyValue:
            fp.buyValue,

          sellValue:
            fp.sellValue,

          totalValue:
            fp.totalValue,

          delta:
            fp.delta,

          deltaValue:
            fp.deltaValue,

          deltaPercent:
            pct(
              fp.delta,
              fp.totalVolume
            ),

          deltaValuePercent:
            pct(
              fp.deltaValue,
              fp.totalValue
            ),

          levels:
            fp.levels.sort(
              (a,b) =>
                b.price-a.price
            )
        };
      })
      .sort(
        (a,b) =>
          a.time-b.time
      );

  return {
    available: true,
    hours,
    symbol,
    interval,
    count:
      footprints.length,
    footprints
  };
}

async function collectAndStore(
  env,
  symbol,
  interval
) {
  if (!env.FOOTPRINT_DB) {
    return {
      saved: false,
      reason:
        "FOOTPRINT_DB binding missing"
    };
  }

  const [
    candles,
    tradeList,
    info
  ] = await Promise.all([
    kline(
      "linear",
      symbol,
      interval,
      100
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

  const footprints =
    buildFootprints(
      candles,
      tradeList,
      interval,
      info.tickSize
    );

  return saveFootprintToD1(
    env.FOOTPRINT_DB,
    symbol,
    interval,
    footprints.slice(-5)
  );
}

/* =========================================================
   ORDERBOOK
========================================================= */

function median(values) {
  const a =
    (values || [])
      .map(n)
      .filter(x => x > 0)
      .sort(
        (x,y)=>x-y
      );

  if (!a.length) return 0;

  const m =
    Math.floor(a.length/2);

  return a.length % 2
    ? a[m]
    : (a[m-1]+a[m])/2;
}

function analyzeWalls(book) {
  const bids =
    book?.bids || [];

  const asks =
    book?.asks || [];

  const buyLiquidity =
    sum(
      bids.map(
        x=>x.value
      )
    );

  const sellLiquidity =
    sum(
      asks.map(
        x=>x.value
      )
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    pct(
      buyLiquidity,
      totalLiquidity
    );

  const sellShare =
    pct(
      sellLiquidity,
      totalLiquidity
    );

  const buyMedian =
    median(
      bids.map(
        x=>x.value
      )
    );

  const sellMedian =
    median(
      asks.map(
        x=>x.value
      )
    );

  const buyWalls =
    bids
      .filter(
        x =>
          buyMedian > 0 &&
          x.value >=
          buyMedian * 4
      )
      .sort(
        (a,b)=>
          b.value-a.value
      )
      .slice(0,20);

  const sellWalls =
    asks
      .filter(
        x =>
          sellMedian > 0 &&
          x.value >=
          sellMedian * 4
      )
      .sort(
        (a,b)=>
          b.value-a.value
      )
      .slice(0,20);

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  }

  if (
    sellShare >
    buyShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity,

    buyShare,
    sellShare,

    buyMedian,
    sellMedian,

    buyWalls,
    sellWalls,

    pressure,

    bestBid:
      book?.bestBid || 0,

    bestAsk:
      book?.bestAsk || 0
  };
}

function buildHeatmap(book) {
  const all = [
    ...(book?.bids || [])
      .map(x => ({
        ...x,
        side:"BID"
      })),

    ...(book?.asks || [])
      .map(x => ({
        ...x,
        side:"ASK"
      }))
  ]
  .sort(
    (a,b)=>
      b.value-a.value
  )
  .slice(0,50);

  const max =
    Math.max(
      1,
      ...all.map(
        x=>n(x.value)
      )
    );

  return all.map(x=>({
    price:x.price,
    size:x.size,
    value:x.value,
    side:x.side,
    intensity:
      clamp(
        x.value/max,
        0,
        1
      )
  }));
}

/* =========================================================
   TECHNICALS
========================================================= */

function sma(values, period) {
  if (!values?.length) return [];

  const out =
    new Array(
      values.length
    ).fill(null);

  let rolling = 0;

  for (
    let i=0;
    i<values.length;
    i++
  ) {
    rolling +=
      n(values[i]);

    if(i>=period){
      rolling -=
        n(values[i-period]);
    }

    if(
      i>=period-1
    ){
      out[i]=
        rolling/period;
    }
  }

  return out;
}

function ema(values, period) {
  if (!values?.length) return [];

  const out =
    new Array(
      values.length
    ).fill(null);

  const k =
    2/(period+1);

  let prev =
    n(values[0]);

  out[0]=prev;

  for(
    let i=1;
    i<values.length;
    i++
  ){
    prev =
      n(values[i])*k +
      prev*(1-k);

    out[i]=prev;
  }

  return out;
}

function atr(candles, period=14){
  if(!candles?.length)return [];

  const tr =
    candles.map(
      (c,i)=>{
        if(i===0){
          return c.high-c.low;
        }

        return Math.max(
          c.high-c.low,

          Math.abs(
            c.high-
            candles[i-1].close
          ),

          Math.abs(
            c.low-
            candles[i-1].close
          )
        );
      }
    );

  return ema(
    tr,
    period
  );
}

function rsi(values,period=14){
  if(!values?.length)return [];

  const out =
    new Array(
      values.length
    ).fill(null);

  let gains=0;
  let losses=0;

  for(
    let i=1;
    i<values.length;
    i++
  ){
    const diff =
      n(values[i])-
      n(values[i-1]);

    gains+=Math.max(
      diff,
      0
    );

    losses+=Math.max(
      -diff,
      0
    );

    if(i>period){
      const oldDiff =
        n(values[i-period])-
        n(values[i-period-1]);

      gains-=Math.max(
        oldDiff,
        0
      );

      losses-=Math.max(
        -oldDiff,
        0
      );
    }

    if(i>=period){
      const avgGain=
        gains/period;

      const avgLoss=
        losses/period;

      if(avgLoss===0){
        out[i]=100;
      }else{
        const rs=
          avgGain/avgLoss;

        out[i]=
          100-
          100/(1+rs);
      }
    }
  }

  return out;
}

function candleStats(c){
  const range=
    Math.max(
      c.high-c.low,
      0
    );

  const body=
    Math.abs(
      c.close-c.open
    );

  return {
    range,
    body,
    bodyPercent:
      range
        ? body/range*100
        : 0,

    upperWick:
      c.high-
      Math.max(
        c.open,
        c.close
      ),

    lowerWick:
      Math.min(
        c.open,
        c.close
      )-
      c.low,

    bullish:
      c.close>=c.open,

    bearish:
      c.close<c.open
  };
}

function structureAnalysis(candles){
  if(!candles?.length){
    return {
      trend:"NEUTRAL",
      strength:0,
      sma5:0,
      sma20:0,
      price:0
    };
  }

  const closes=
    candles.map(
      x=>x.close
    );

  const ma5=
    sma(closes,5);

  const ma20=
    sma(closes,20);

  const a=
    atr(candles,14);

  const i=
    candles.length-1;

  const price=
    candles[i].close;

  const sma5=
    n(ma5[i]);

  const sma20=
    n(ma20[i]);

  const atrValue=
    n(a[i]);

  let trend=
    "NEUTRAL";

  if(
    sma5>sma20 &&
    price>sma20
  ){
    trend="BULLISH";
  }

  if(
    sma5<sma20 &&
    price<sma20
  ){
    trend="BEARISH";
  }

  const distance=
    atrValue
      ? Math.abs(
          price-sma20
        )/atrValue
      : 0;

  return {
    trend,
    strength:
      clamp(
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
    return {
      signal:"WAIT",
      rsi:0,
      ma20:0
    };
  }

  const closes=
    candles.map(
      x=>x.close
    );

  const ma=
    sma(closes,20);

  const rs=
    rsi(closes,14);

  const i=
    candles.length-1;

  const price=
    closes[i];

  const ma20=
    n(ma[i]);

  const rsiValue=
    n(rs[i],50);

  let signal=
    "WAIT";

  if(
    price>ma20 &&
    rsiValue>=50
  ){
    signal="LONG";
  }

  if(
    price<ma20 &&
    rsiValue<=50
  ){
    signal="SHORT";
  }

  return {
    signal,
    rsi:rsiValue,
    ma20
  };
}

function detectSweep(candles){
  if(
    !candles ||
    candles.length<7
  ){
    return {
      detected:false,
      type:"NONE",
      price:0,
      time:0
    };
  }

  const c=
    candles[candles.length-1];

  const previous=
    candles.slice(-6,-1);

  const previousHigh=
    Math.max(
      ...previous.map(
        x=>x.high
      )
    );

  const previousLow=
    Math.min(
      ...previous.map(
        x=>x.low
      )
    );

  if(
    c.high>previousHigh &&
    c.close<previousHigh
  ){
    return {
      detected:true,
      type:"SELL_SWEEP",
      price:c.high,
      time:c.time
    };
  }

  if(
    c.low<previousLow &&
    c.close>previousLow
  ){
    return {
      detected:true,
      type:"BUY_SWEEP",
      price:c.low,
      time:c.time
    };
  }

  return {
    detected:false,
    type:"NONE",
    price:0,
    time:c.time
  };
}

function detectAbsorption(
  flow,
  candle,
  wall
){
  const stats=
    candleStats(candle);

  let type="NONE";
  let detected=false;

  if(
    flow.deltaPercent>=10 &&
    stats.bodyPercent<=35 &&
    wall.sellShare>=wall.buyShare
  ){
    detected=true;
    type="SELL_ABSORPTION";
  }

  if(
    flow.deltaPercent<=-10 &&
    stats.bodyPercent<=35 &&
    wall.buyShare>=wall.sellShare
  ){
    detected=true;
    type="BUY_ABSORPTION";
  }

  return {
    detected,
    type,
    deltaPercent:
      flow.deltaPercent,
    bodyPercent:
      stats.bodyPercent
  };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyze(
  symbol,
  selectedInterval,
  env
){
  const interval=
    normalizeInterval(
      selectedInterval
    );

  const [
    candles5,
    candles15,
    candles3,
    candles1,
    tick,
    book,
    tradeList,
    info
  ] =
    await Promise.all([
      kline(
        "linear",
        symbol,
        TF,
        300
      ),

      kline(
        "linear",
        symbol,
        TF15,
        300
      ),

      kline(
        "linear",
        symbol,
        TF3,
        300
      ),

      kline(
        "linear",
        symbol,
        TF1,
        300
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
      ),

      instrumentInfo(
        "linear",
        symbol
      )
    ]);

  let baseCandles;

  if(interval==="1"){
    baseCandles=candles1;
  }else if(interval==="3"){
    baseCandles=candles3;
  }else if(interval==="15"){
    baseCandles=candles15;
  }else if(
    interval==="30" ||
    interval==="60"
  ){
    baseCandles=
      await kline(
        "linear",
        symbol,
        interval,
        300
      );
  }else{
    baseCandles=candles5;
  }

  const footprints=
    buildFootprints(
      baseCandles,
      tradeList,
      interval,
      info.tickSize
    );

  const candleFlow=
    footprints.map(fp=>({
      time:fp.time,
      buyVolume:fp.buyVolume,
      sellVolume:fp.sellVolume,
      delta:fp.delta,
      deltaValue:fp.deltaValue,
      totalVolume:fp.flowVolume,
      totalValue:fp.totalValue
    }));

  const selectedCandles=
    baseCandles.map(
      (c,i)=>({
        ...c,
        ...(candleFlow[i]||{})
      })
    );

  const current=
    selectedCandles[
      selectedCandles.length-1
    ];

  const currentFlow=
    current
      ? flowFromTrades(
          tradeList,
          current.time,
          current.time+
          intervalMs(interval)-1
        )
      : flowFromTrades([]);

  const wall=
    analyzeWalls(book);

  const heatmap=
    buildHeatmap(book);

  const sweep=
    detectSweep(
      selectedCandles
    );

  const absorption=
    detectAbsorption(
      currentFlow,
      current||{
        open:0,
        high:0,
        low:0,
        close:0
      },
      wall
    );

  const structure5=
    structureAnalysis(
      candles5
    );

  const structure15=
    structureAnalysis(
      candles15
    );

  const structure1=
    structureAnalysis(
      candles1
    );

  const entry=
    entry1m(candles1);

  let score=50;

  if(
    structure5.trend==="BULLISH"
  )score+=8;

  if(
    structure5.trend==="BEARISH"
  )score-=8;

  if(
    structure15.trend==="BULLISH"
  )score+=8;

  if(
    structure15.trend==="BEARISH"
  )score-=8;

  if(
    currentFlow.deltaPercent>=10
  )score+=12;

  if(
    currentFlow.deltaPercent<=-10
  )score-=12;

  if(
    wall.pressure==="BUY_PRESSURE"
  )score+=8;

  if(
    wall.pressure==="SELL_PRESSURE"
  )score-=8;

  if(
    absorption.type==="BUY_ABSORPTION"
  )score+=10;

  if(
    absorption.type==="SELL_ABSORPTION"
  )score-=10;

  if(
    sweep.type==="BUY_SWEEP"
  )score+=8;

  if(
    sweep.type==="SELL_SWEEP"
  )score-=8;

  score=
    clamp(score,0,100);

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

  return {
    version:VERSION,

    symbol,

    category:"linear",

    interval,

    ticker:tick,

    instrument:info,

    candles:selectedCandles,

    footprints,

    candleDelta:candleFlow,

    candles5,
    candles15,
    candles3,
    candles1,

    currentFlow,

    historicalFlow:candleFlow,

    flowPressure:
      currentFlow.deltaPercent>=10
        ?"BUY_PRESSURE"
        :currentFlow.deltaPercent<=-10
          ?"SELL_PRESSURE"
          :"NEUTRAL",

    orderbook:book,

    wall,

    heatmap,

    sweep,

    absorption,

    trades:
      tradeList.slice(-250),

    structure:{
      tf5:structure5,
      tf15:structure15,
      tf1:structure1
    },

    entry,

    score,

    signal,

    lastPrice:tick.last,

    serverTime:Date.now()
  };
}

/* =========================================================
   LIVE
========================================================= */

async function live(
  symbol,
  interval
){
  const [
    tick,
    book,
    tradeList,
    candles,
    info
  ] =
    await Promise.all([
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
      ),

      kline(
        "linear",
        symbol,
        interval,
        300
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
      interval,
      info.tickSize
    );

  const current=
    candles[
      candles.length-1
    ];

  const currentFlow=
    current
      ? flowFromTrades(
          tradeList,
          current.time,
          current.time+
          intervalMs(interval)-1
        )
      : flowFromTrades([]);

  const wall=
    analyzeWalls(book);

  return {
    version:VERSION,
    symbol,
    category:"linear",
    interval,

    ticker:tick,

    instrument:info,

    candles,

    footprints,

    currentFlow,

    flowPressure:
      currentFlow.deltaPercent>=10
        ?"BUY_PRESSURE"
        :currentFlow.deltaPercent<=-10
          ?"SELL_PRESSURE"
          :"NEUTRAL",

    orderbook:book,

    wall,

    heatmap:
      buildHeatmap(book),

    trades:
      tradeList.slice(-250),

    lastPrice:tick.last,

    serverTime:Date.now()
  };
}

/* =========================================================
   SCAN
========================================================= */

async function getSymbols(){
  const result=
    await bybit(
      "/v5/market/instruments-info",
      {
        category:"linear",
        status:"Trading",
        limit:1000
      }
    );

  return (
    result?.list||[]
  )
  .filter(x=>
    x.quoteCoin==="USDT" &&
    x.contractType===
      "LinearPerpetual" &&
    x.status==="Trading"
  )
  .map(
    x=>x.symbol
  )
  .slice(
    0,
    MAX_SYMBOLS
  );
}

async function scan(offset=0){
  const symbols=
    await getSymbols();

  const start=
    Math.max(
      0,
      Number(offset)||0
    );

  const batch=
    symbols.slice(
      start,
      start+SCAN_BATCH
    );

  const results=[];

  for(
    const symbol of batch
  ){
    try{

      const a=
        await analyze(
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
            a.currentFlow
              ?.deltaPercent||0,

          pressure:
            a.flowPressure,

          absorption:
            a.absorption
              ?.type||"NONE",

          sweep:
            a.sweep
              ?.type||"NONE"
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
    (a,b)=>
      b.score-a.score
  );

  return {
    version:VERSION,

    offset:start,

    nextOffset:
      start+SCAN_BATCH>=
      symbols.length
        ?0
        :start+SCAN_BATCH,

    totalSymbols:
      symbols.length,

    results
  };
}

function validSymbol(value){
  return /^[A-Z0-9._-]{2,40}$/i
    .test(
      String(value||"")
    );
}

/* =========================================================
   WORKER
========================================================= */

export default {

  async scheduled(
    controller,
    env,
    ctx
  ){

    /*
      این بخش هر بار که Cron اجرا شود
      Footprint کندل جاری را ذخیره می‌کند.
    */

    const symbols = [
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "XRPUSDT",
      "DOGEUSDT"
    ];

    for(
      const symbol of symbols
    ){

      for(
        const interval of
        ["1","3","5","15","30","60"]
      ){

        ctx.waitUntil(
          collectAndStore(
            env,
            symbol,
            interval
          )
        );
      }
    }
  },

  async fetch(
    request,
    env
  ){

    if(
      request.method==="OPTIONS"
    ){
      return new Response(
        null,
        {
          status:204,
          headers:{
            "access-control-allow-origin":"*",
            "access-control-allow-methods":
              "GET,POST,OPTIONS",
            "access-control-allow-headers":
              "Content-Type"
          }
        }
      );
    }

    const url=
      new URL(
        request.url
      );

    const path=
      url.pathname;

    try{

      if(
        path==="/api/health"
      ){
        return json({
          ok:true,
          online:true,
          bybit:BYBIT,
          version:VERSION,
          d1:Boolean(
            env.FOOTPRINT_DB
          ),
          time:Date.now()
        });
      }

      if(
        path==="/api/test-bybit"
      ){

        const t=
          await ticker(
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

      if(
        path==="/api/collect"
      ){

        const symbol=
          String(
            url.searchParams.get(
              "symbol"
            )||"BTCUSDT"
          )
          .trim()
          .toUpperCase();

        const interval=
          normalizeInterval(
            url.searchParams.get(
              "interval"
            )||"1"
          );

        if(
          !validSymbol(symbol)
        ){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        const result=
          await collectAndStore(
            env,
            symbol,
            interval
          );

        return json({
          ok:true,
          symbol,
          interval,
          result,
          time:Date.now()
        });
      }

      if(
        path==="/api/history-footprint"
      ){

        const symbol=
          String(
            url.searchParams.get(
              "symbol"
            )||"BTCUSDT"
          )
          .trim()
          .toUpperCase();

        const interval=
          normalizeInterval(
            url.searchParams.get(
              "interval"
            )||"1"
          );

        const hours=
          clamp(
            Number(
              url.searchParams.get(
                "hours"
              )||24
            ),
            1,
            24
          );

        if(
          !validSymbol(symbol)
        ){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        const result=
          await readHistoricalFootprint(
            env.FOOTPRINT_DB,
            symbol,
            interval,
            hours
          );

        return json({
          ok:true,
          ...result
        });
      }

      if(
        path==="/api/symbols"
      ){

        return json({
          ok:true,
          symbols:
            await getSymbols()
        });
      }

      if(
        path==="/api/analyze"
      ){

        const symbol=
          String(
            url.searchParams.get(
              "symbol"
            )||"BTCUSDT"
          )
          .trim()
          .toUpperCase();

        const interval=
          normalizeInterval(
            url.searchParams.get(
              "interval"
            )||TF
          );

        if(
          !validSymbol(symbol)
        ){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        return json(
          await analyze(
            symbol,
            interval,
            env
          )
        );
      }

      if(
        path==="/api/live"
      ){

        const symbol=
          String(
            url.searchParams.get(
              "symbol"
            )||"BTCUSDT"
          )
          .trim()
          .toUpperCase();

        const interval=
          normalizeInterval(
            url.searchParams.get(
              "interval"
            )||TF
          );

        if(
          !validSymbol(symbol)
        ){
          return json({
            ok:false,
            error:"Invalid symbol"
          },400);
        }

        return json(
          await live(
            symbol,
            interval
          )
        );
      }

      if(
        path==="/api/scan"
      ){

        const offset=
          Number(
            url.searchParams.get(
              "offset"
            )||0
          );

        return json(
          await scan(offset)
        );
      }

      return env.ASSETS.fetch(
        request
      );

    }catch(error){

      return json({
        ok:false,
        error:
          error?.message ||
          String(error),
        version:VERSION
      },500);
    }
  }
};
