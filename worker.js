const BYBIT = "https://api.bybit.com";
const VERSION = "ABSORPTION-ZONE-SCANNER-V4-FIX";

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
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
      "x-scanner-version": VERSION
    }
  });
}

function err(message, status = 500) {
  return json({
    ok: false,
    error: String(message || "Unknown error"),
    version: VERSION
  }, status);
}

function normalizeSymbol(value) {
  let s = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!s || s === "USDT" || s === "BUSDT") {
    return "BTCUSDT";
  }

  if (s === "BTC") {
    return "BTCUSDT";
  }

  if (!s.endsWith("USDT")) {
    s += "USDT";
  }

  return s;
}

function normalizeCategory(value) {
  const s = String(value || "").toLowerCase();

  if (s === "spot") {
    return "spot";
  }

  return "linear";
}

function normalizeInterval(value) {
  const allowed = [
    "1",
    "3",
    "5",
    "15",
    "30",
    "60"
  ];

  const s = String(value || "1");

  return allowed.includes(s)
    ? s
    : "1";
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function bybit(path, params = {}) {

  const u = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      u.searchParams.set(key, String(value));
    }
  }

  let response;

  try {
    response = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(
      "اتصال به Bybit برقرار نشد: " +
      (e?.message || "network error")
    );
  }

  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error(
      "Bybit پاسخ خالی برگرداند. HTTP " +
      response.status
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      "Bybit پاسخ JSON معتبر برنگرداند. HTTP " +
      response.status
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.retMsg ||
      `Bybit HTTP ${response.status}`
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

async function getKlines(
  category,
  symbol,
  interval
) {

  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit: KLINE_LIMIT
    }
  );

  const rows =
    data?.result?.list || [];

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
    .filter(x =>
      x.time &&
      x.open > 0 &&
      x.high > 0 &&
      x.low > 0 &&
      x.close > 0
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

async function getTrades(
  category,
  symbol
) {

  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: TRADE_LIMIT
    }
  );

  const rows =
    data?.result?.list || [];

  return rows
    .map((x, i) => {

      const price =
        num(x.price);

      const qty =
        num(x.size);

      const side =
        String(x.side || "")
          .toLowerCase() === "buy"
          ? "buy"
          : "sell";

      return {
        id:
          x.execId ||
          `${x.time}-${i}`,
        time:
          num(x.time, Date.now()),
        price,
        qty,
        side,
        value:
          price * qty
      };
    })
    .filter(x =>
      x.time &&
      x.price > 0 &&
      x.qty > 0
    );
}

async function getOrderbook(
  category,
  symbol
) {

  const data = await bybit(
    "/v5/market/orderbook",
    {
      category,
      symbol,
      limit: ORDERBOOK_LIMIT
    }
  );

  const r =
    data?.result || {};

  const bids =
    (r.b || [])
      .map(x => ({
        price: num(x[0]),
        qty: num(x[1])
      }))
      .filter(x =>
        x.price > 0 &&
        x.qty > 0
      );

  const asks =
    (r.a || [])
      .map(x => ({
        price: num(x[0]),
        qty: num(x[1])
      }))
      .filter(x =>
        x.price > 0 &&
        x.qty > 0
      );

  return {
    timestamp:
      num(r.ts, Date.now()),

    bids,

    asks,

    bestBid:
      bids[0]?.price || 0,

    bestAsk:
      asks[0]?.price || 0
  };
}

async function getTicker(
  category,
  symbol
) {

  const data = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  return (
    data?.result?.list?.[0] ||
    {}
  );
}

function median(values) {

  const a =
    values
      .filter(Number.isFinite)
      .sort((x, y) => x - y);

  if (!a.length) {
    return 0;
  }

  const m =
    Math.floor(a.length / 2);

  return a.length % 2
    ? a[m]
    : (a[m - 1] + a[m]) / 2;
}

function tradeStats(trades) {

  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  const values =
    trades
      .map(x => x.value)
      .filter(x => x > 0)
      .sort((a, b) => a - b);

  const average =
    values.length
      ? values.reduce(
          (a, b) => a + b,
          0
        ) / values.length
      : 0;

  const p95 =
    values.length
      ? values[
          Math.floor(
            (values.length - 1) *
            0.95
          )
        ]
      : 0;

  const largeThreshold =
    Math.max(
      average * 5,
      p95
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  for (const t of trades) {

    if (t.side === "buy") {

      buyVolume += t.qty;
      buyValue += t.value;
      buyTrades++;

      if (
        t.value >=
        largeThreshold &&
        largeThreshold > 0
      ) {
        largeBuyVolume += t.qty;
      }

    } else {

      sellVolume += t.qty;
      sellValue += t.value;
      sellTrades++;

      if (
        t.value >=
        largeThreshold &&
        largeThreshold > 0
      ) {
        largeSellVolume += t.qty;
      }
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  const delta =
    buyVolume - sellVolume;

  const deltaPercent =
    totalVolume > 0
      ? delta /
        totalVolume *
        100
      : 0;

  let pressure =
    "NEUTRAL";

  if (deltaPercent >= 10) {
    pressure =
      "BUY_PRESSURE";
  } else if (deltaPercent <= -10) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    buyVolume,
    sellVolume,
    totalVolume,

    buyValue,
    sellValue,

    delta,

    deltaPercent,

    buyTrades,
    sellTrades,

    largeBuyVolume,
    largeSellVolume,

    largeThreshold,

    pressure
  };
}

function orderbookStats(book) {

  const bids =
    book.bids || [];

  const asks =
    book.asks || [];

  const buyLiquidity =
    bids.reduce(
      (s, x) =>
        s + x.qty,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (s, x) =>
        s + x.qty,
      0
    );

  const total =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    total
      ? buyLiquidity /
        total *
        100
      : 0;

  const sellShare =
    total
      ? sellLiquidity /
        total *
        100
      : 0;

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

  const bidMedian =
    median(
      bids.map(x => x.qty)
    );

  const askMedian =
    median(
      asks.map(x => x.qty)
    );

  const bidWalls =
    bids.filter(x =>
      bidMedian > 0 &&
      x.qty >=
      bidMedian * 4
    );

  const askWalls =
    asks.filter(x =>
      askMedian > 0 &&
      x.qty >=
      askMedian * 4
    );

  return {
    buyLiquidity,
    sellLiquidity,
    totalLiquidity: total,

    buyShare,
    sellShare,

    pressure,

    bidWalls,
    askWalls,

    bestBid:
      book.bestBid,

    bestAsk:
      book.bestAsk,

    spread:
      book.bestAsk &&
      book.bestBid
        ? book.bestAsk -
          book.bestBid
        : 0
  };
}

function footprint(
  candles,
  trades
) {

  return candles.map(
    (candle, index) => {

      const next =
        candles[index + 1];

      const end =
        next
          ? next.time
          : Date.now();

      const inside =
        trades.filter(t =>
          t.time >= candle.time &&
          t.time < end
        );

      const levels =
        new Map();

      for (const t of inside) {

        const key =
          String(t.price);

        if (!levels.has(key)) {

          levels.set(
            key,
            {
              price: t.price,
              buyVolume: 0,
              sellVolume: 0,
              delta: 0,
              trades: 0
            }
          );
        }

        const level =
          levels.get(key);

        if (t.side === "buy") {
          level.buyVolume += t.qty;
        } else {
          level.sellVolume += t.qty;
        }

        level.delta =
          level.buyVolume -
          level.sellVolume;

        level.trades++;
      }

      const stats =
        tradeStats(inside);

      return {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,

        buyVolume:
          stats.buyVolume,

        sellVolume:
          stats.sellVolume,

        delta:
          stats.delta,

        deltaPercent:
          stats.deltaPercent,

        pressure:
          stats.pressure,

        levels:
          Array.from(
            levels.values()
          ).sort(
            (a, b) =>
              b.price - a.price
          )
      };
    }
  );
}

function makeCVD(trades) {

  let cvd = 0;

  return trades
    .slice()
    .sort(
      (a, b) =>
        a.time - b.time
    )
    .map(t => {

      const delta =
        t.side === "buy"
          ? t.qty
          : -t.qty;

      cvd += delta;

      return {
        time: t.time,
        delta,
        cvd
      };
    });
}

function absorption(
  stats,
  book
) {

  const strongestBid =
    Math.max(
      0,
      ...(book.bids || [])
        .map(x => x.qty)
    );

  const strongestAsk =
    Math.max(
      0,
      ...(book.asks || [])
        .map(x => x.qty)
    );

  const buy =
    stats.largeBuyVolume;

  const sell =
    stats.largeSellVolume;

  let signal =
    "NONE";

  if (
    sell > buy &&
    strongestBid > 0
  ) {
    signal =
      "BUY_ABSORPTION";
  }

  if (
    buy > sell &&
    strongestAsk > 0
  ) {
    signal =
      "SELL_ABSORPTION";
  }

  return {
    signal,

    buyAbsorption:
      signal ===
      "BUY_ABSORPTION",

    sellAbsorption:
      signal ===
      "SELL_ABSORPTION",

    largeBuyVolume: buy,
    largeSellVolume: sell,

    strongestBidWall:
      strongestBid,

    strongestAskWall:
      strongestAsk
  };
}

async function market(
  category,
  symbol,
  interval
) {

  const [
    candles,
    trades,
    orderbook,
    ticker
  ] = await Promise.all([
    getKlines(
      category,
      symbol,
      interval
    ),

    getTrades(
      category,
      symbol
    ),

    getOrderbook(
      category,
      symbol
    ),

    getTicker(
      category,
      symbol
    )
  ]);

  const stats =
    tradeStats(trades);

  const bookStats =
    orderbookStats(
      orderbook
    );

  return {
    ok: true,

    version: VERSION,

    timestamp:
      Date.now(),

    category,
    symbol,
    interval,

    candles,

    trades,

    orderbook,

    ticker,

    tradeStats:
      stats,

    orderbookStats:
      bookStats,

    absorption:
      absorption(
        stats,
        orderbook
      ),

    footprint:
      footprint(
        candles,
        trades
      ),

    cvd:
      makeCVD(trades)
  };
}

async function assets(
  request,
  env
) {

  if (!env?.ASSETS) {

    return new Response(
      "ASSETS binding not found",
      {
        status: 500,
        headers: {
          "content-type":
            "text/plain; charset=UTF-8"
        }
      }
    );
  }

  const url =
    new URL(request.url);

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html"
  ) {
    url.pathname =
      "/index.html";
  }

  const assetRequest =
    new Request(
      url.toString(),
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
    new Headers(
      response.headers
    );

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
      status:
        response.status,
      statusText:
        response.statusText,
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

    const url =
      new URL(request.url);

    try {

      if (
        request.method === "POST" &&
        url.pathname === "/add"
      ) {

        const text =
          await request.text();

        if (!text.trim()) {
          return json({
            ok: true,
            added: 0
          });
        }

        let incoming;

        try {
          incoming =
            JSON.parse(text);
        } catch {
          return err(
            "Collector JSON invalid",
            400
          );
        }

        if (
          !Array.isArray(incoming)
        ) {
          return err(
            "Trades array required",
            400
          );
        }

        const old =
          (await this.state.storage.get(
            "trades"
          )) || [];

        const map =
          new Map();

        for (const t of old) {
          if (t?.id) {
            map.set(
              String(t.id),
              t
            );
          }
        }

        for (const t of incoming) {
          if (t?.id) {
            map.set(
              String(t.id),
              t
            );
          }
        }

        const cutoff =
          Date.now() -
          24 * 60 * 60 * 1000;

        const result =
          Array.from(
            map.values()
          )
          .filter(
            t =>
              num(t.time) >=
              cutoff
          )
          .sort(
            (a, b) =>
              num(a.time) -
              num(b.time)
          )
          .slice(-20000);

        await this.state.storage.put(
          "trades",
          result
        );

        return json({
          ok: true,
          stored:
            result.length
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/trades"
      ) {

        const trades =
          (await this.state.storage.get(
            "trades"
          )) || [];

        return json({
          ok: true,
          trades
        });
      }

      return err(
        "Collector route not found",
        404
      );

    } catch (e) {

      return err(
        e?.message ||
        "Collector error"
      );
    }
  }
}

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    try {

      if (
        url.pathname ===
        "/api/health"
      ) {

        return json({
          ok: true,
          version: VERSION,
          service:
            "Absorption Zone Scanner",
          timestamp:
            Date.now()
        });
      }

      if (
        url.pathname ===
        "/api/market"
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

        return json(
          await market(
            category,
            symbol,
            interval
          )
        );
      }

      if (
        url.pathname ===
        "/api/trades"
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
            symbol
          );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          trades,
          stats:
            tradeStats(trades)
        });
      }

      if (
        url.pathname ===
        "/api/orderbook"
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
            symbol
          );

        return json({
          ok: true,
          version: VERSION,
          category,
          symbol,
          orderbook: book,
          analysis:
            orderbookStats(book)
        });
      }

      if (
        url.pathname ===
        "/api/footprint"
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
            footprint(
              candles,
              trades
            ),
          stats:
            tradeStats(trades)
        });
      }

      if (
        url.pathname ===
        "/api/analyze"
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

        const data =
          await market(
            category,
            symbol,
            interval
          );

        const cvd =
          data.cvd.length
            ? data.cvd[
                data.cvd.length - 1
              ].cvd
            : 0;

        return json({
          ok: true,
          version: VERSION,
          symbol,
          category,
          interval,
          analysis: {
            delta:
              data.tradeStats.delta,

            deltaPercent:
              data.tradeStats
                .deltaPercent,

            tradePressure:
              data.tradeStats.pressure,

            orderbookPressure:
              data.orderbookStats.pressure,

            absorption:
              data.absorption,

            cvd
          }
        });
      }

      return assets(
        request,
        env
      );

    } catch (e) {

      return err(
        e?.message ||
        "Worker error"
      );
    }
  }
};
