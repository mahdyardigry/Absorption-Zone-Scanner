const VERSION = "ABSORPTION-ZONE-V5-HOUR-BLOCK-20K-LOWWRITE-BYBIT-FUTURES-VOLUME-TEST-V3";

const BYBIT = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_INTERVAL = "1";

const KLINE_LIMIT = 200;
const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;
const SYMBOL_LIMIT = 1000;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ALARM_MS = 60 * 60 * 1000;

const MAX_ROWS = 20000;
const CLEANUP_TARGET_ROWS = 19000;

const TABLE_NAME = "hour_blocks_v5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function normalizeSymbol(value) {
  let s = String(value || "").trim().toUpperCase();

  if (!s) return DEFAULT_SYMBOL;

  s = s.replace(/[^A-Z0-9]/g, "");

  if (s === "BTC") return "BTCUSDT";
  if (s === "BUSDT") return "BTCUSDT";

  if (!s.endsWith("USDT")) {
    s += "USDT";
  }

  return s;
}

function normalizeInterval(value) {
  const allowed = [
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
    "D",
    "W",
    "M"
  ];

  const v = String(
    value || DEFAULT_INTERVAL
  ).toUpperCase();

  return allowed.includes(v)
    ? v
    : DEFAULT_INTERVAL;
}

function hourStartOf(time) {
  const t = Number(time) || Date.now();
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

function minuteStartOf(time) {
  const t = Number(time) || Date.now();
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;

  const a = [...values].sort(
    (x, y) => x - y
  );

  const index =
    (a.length - 1) * p;

  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);

  if (lower === upper) {
    return a[lower];
  }

  return (
    a[lower] +
    (a[upper] - a[lower]) *
      (index - lower)
  );
}

/* =========================================================
   BYTE / COMPRESSION HELPERS
========================================================= */

function utf8ByteLength(value) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  return new TextEncoder().encode(text).byteLength;
}

function bytesToKB(bytes) {
  return Number(
    (Number(bytes || 0) / 1024).toFixed(3)
  );
}

function bytesToMB(bytes) {
  return Number(
    (Number(bytes || 0) / 1024 / 1024).toFixed(6)
  );
}

function bytesToGB(bytes) {
  return Number(
    (
      Number(bytes || 0) /
      1024 /
      1024 /
      1024
    ).toFixed(6)
  );
}

async function gzipByteLength(value) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  const input =
    new TextEncoder().encode(text);

  if (
    typeof CompressionStream !==
    "function"
  ) {
    return null;
  }

  const stream =
    new Blob([input])
      .stream()
      .pipeThrough(
        new CompressionStream("gzip")
      );

  const buffer =
    await new Response(
      stream
    ).arrayBuffer();

  return buffer.byteLength;
}

function compressionInfo(
  rawBytes,
  gzipBytes
) {
  if (
    !Number.isFinite(gzipBytes) ||
    gzipBytes <= 0 ||
    rawBytes <= 0
  ) {
    return {
      available: false,
      rawBytes,
      compressedBytes: null,
      savedBytes: null,
      savedPercent: null,
      ratio: null
    };
  }

  const saved =
    rawBytes - gzipBytes;

  const savedPercent =
    (saved / rawBytes) * 100;

  const ratio =
    rawBytes / gzipBytes;

  return {
    available: true,

    rawBytes,

    compressedBytes:
      gzipBytes,

    savedBytes:
      saved,

    savedPercent:
      Number(
        savedPercent.toFixed(2)
      ),

    ratio:
      Number(
        ratio.toFixed(3)
      )
  };
}

/* =========================================================
   BYBIT REST
========================================================= */

async function bybit(path, params = {}) {
  const url =
    new URL(BYBIT + path);

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {
    let detail = "";

    try {
      detail =
        await response.text();
    } catch (_) {}

    throw new Error(
      `Bybit HTTP ${response.status}${
        detail
          ? `: ${detail.slice(0, 500)}`
          : ""
      }`
    );
  }

  const data =
    await response.json();

  if (
    Number(data.retCode) !== 0
  ) {
    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data.result;
}

/* =========================================================
   BYBIT DIRECT DEBUG
========================================================= */

async function debugBybit() {
  const startedAt =
    Date.now();

  const target =
    new URL(
      BYBIT +
      "/v5/market/instruments-info"
    );

  target.searchParams.set(
    "category",
    "linear"
  );

  target.searchParams.set(
    "status",
    "Trading"
  );

  target.searchParams.set(
    "limit",
    "10"
  );

  let response = null;
  let body = "";
  let parsed = null;

  try {
    response =
      await fetch(
        target.toString(),
        {
          method: "GET",

          headers: {
            "Accept":
              "application/json",

            "User-Agent":
              "Absorption-Zone-Scanner"
          }
        }
      );

    body =
      await response.text();

    try {
      parsed =
        JSON.parse(body);
    } catch (_) {
      parsed = null;
    }

    const list =
      Array.isArray(
        parsed?.result?.list
      )
        ? parsed.result.list
        : [];

    return {
      ok: true,

      test:
        "Cloudflare Worker -> Bybit",

      reachable: true,

      httpStatus:
        response.status,

      httpOk:
        response.ok,

      bybitRetCode:
        parsed?.retCode ?? null,

      bybitRetMsg:
        parsed?.retMsg ?? null,

      symbolsReceived:
        list.length,

      sampleSymbols:
        list
          .slice(0, 10)
          .map(
            row =>
              row?.symbol || null
          )
          .filter(Boolean),

      sampleContractTypes:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.contractType ||
                  null
              )
              .filter(Boolean)
          )
        ],

      sampleQuoteCoins:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.quoteCoin ||
                  null
              )
              .filter(Boolean)
          )
        ],

      sampleSettleCoins:
        [
          ...new Set(
            list
              .map(
                row =>
                  row?.settleCoin ||
                  null
              )
              .filter(Boolean)
          )
        ],

      responseContentType:
        response.headers.get(
          "content-type"
        ) || "",

      responseServer:
        response.headers.get(
          "server"
        ) || "",

      elapsedMs:
        Date.now() -
        startedAt,

      target:
        target.toString(),

      rawBody:
        body.slice(0, 5000),

      diagnosis:
        response.status === 200 &&
        Number(parsed?.retCode) === 0
          ? (
              list.length > 0
                ? "BYBIT_OK_SYMBOLS_RECEIVED"
                : "BYBIT_REACHABLE_BUT_ZERO_SYMBOLS"
            )
          : (
              response.status === 403
                ? "BYBIT_OR_CLOUDFRONT_BLOCKED_403"
                : "BYBIT_REQUEST_FAILED"
            )
    };
  } catch (error) {
    return {
      ok: false,

      test:
        "Cloudflare Worker -> Bybit",

      reachable: false,

      httpStatus:
        response?.status ?? null,

      httpOk:
        response?.ok ?? false,

      bybitRetCode:
        parsed?.retCode ?? null,

      bybitRetMsg:
        parsed?.retMsg ?? null,

      symbolsReceived: 0,

      sampleSymbols: [],

      sampleContractTypes: [],

      sampleQuoteCoins: [],

      sampleSettleCoins: [],

      elapsedMs:
        Date.now() -
        startedAt,

      target:
        target.toString(),

      rawBody:
        body
          ? body.slice(0, 5000)
          : "",

      error:
        String(
          error?.message ||
          error
        ),

      errorName:
        error?.name ||
        "Error",

      diagnosis:
        "WORKER_TO_BYBIT_FETCH_FAILED"
    };
  }
}

/* =========================================================
   KLINES
========================================================= */

function parseKlines(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      turnover: Number(row[6])
    }))
    .filter(
      x =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.open)
    )
    .reverse();
}

/* =========================================================
   TRADES
========================================================= */

function parseTrades(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row, index) => {
      const price =
        safeNumber(row.price);

      const size =
        safeNumber(row.size);

      return {
        id: String(
          row.execId ||
          row.tradeId ||
          row.id ||
          `${row.time || Date.now()}-${index}-${price}-${size}`
        ),

        time:
          safeNumber(row.time),

        price,

        size,

        value:
          price * size,

        side:
          String(
            row.side || ""
          ).toUpperCase()
      };
    })
    .filter(
      x =>
        x.time > 0 &&
        x.price > 0 &&
        x.size > 0
    );
}

/* =========================================================
   TRADE STATS
========================================================= */

function tradeStats(trades) {
  let buyVolume = 0;
  let sellVolume = 0;

  let buyValue = 0;
  let sellValue = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  const values = [];

  for (const t of trades) {
    const value =
      safeNumber(t.value);

    values.push(value);

    if (t.side === "BUY") {
      buyVolume += t.size;
      buyValue += value;
      buyTrades++;
    } else if (
      t.side === "SELL"
    ) {
      sellVolume += t.size;
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

  const deltaPercent =
    totalVolume > 0
      ? (delta / totalVolume) * 100
      : 0;

  const p95 =
    percentile(
      values,
      0.95
    );

  const averageNotional =
    values.length
      ? values.reduce(
          (sum, value) =>
            sum + value,
          0
        ) / values.length
      : 0;

  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let blockBuyVolume = 0;
  let blockSellVolume = 0;

  for (const t of trades) {
    const value =
      safeNumber(t.value);

    if (
      value >=
      largeThreshold
    ) {
      if (
        t.side === "BUY"
      ) {
        largeBuyVolume +=
          t.size;
      } else if (
        t.side === "SELL"
      ) {
        largeSellVolume +=
          t.size;
      }
    }

    if (
      value >=
      largeThreshold * 2
    ) {
      if (
        t.side === "BUY"
      ) {
        blockBuyVolume +=
          t.size;
      } else if (
        t.side === "SELL"
      ) {
        blockSellVolume +=
          t.size;
      }
    }
  }

  let pressure =
    "NEUTRAL";

  if (
    deltaPercent >= 10
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    deltaPercent <= -10
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    tradeCount:
      trades.length,

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

    p95,

    averageNotional,

    largeThreshold,

    largeBuyVolume,

    largeSellVolume,

    blockBuyVolume,

    blockSellVolume,

    pressure
  };
}

/* =========================================================
   ORDER BOOK
========================================================= */

function parseOrderbook(result) {
  const bids =
    Array.isArray(
      result?.b
    )
      ? result.b
      : [];

  const asks =
    Array.isArray(
      result?.a
    )
      ? result.a
      : [];

  return {
    bids:
      bids
        .map(row => ({
          price:
            safeNumber(
              row?.[0]
            ),

          size:
            safeNumber(
              row?.[1]
            )
        }))
        .filter(
          row =>
            row.price > 0 &&
            row.size > 0
        ),

    asks:
      asks
        .map(row => ({
          price:
            safeNumber(
              row?.[0]
            ),

          size:
            safeNumber(
              row?.[1]
            )
        }))
        .filter(
          row =>
            row.price > 0 &&
            row.size > 0
        )
  };
}

function analyzeOrderbook(book) {
  const bids =
    Array.isArray(
      book?.bids
    )
      ? book.bids
      : [];

  const asks =
    Array.isArray(
      book?.asks
    )
      ? book.asks
      : [];

  const buyLiquidity =
    bids.reduce(
      (sum, row) =>
        sum +
        safeNumber(
          row.size
        ),
      0
    );

  const sellLiquidity =
    asks.reduce(
      (sum, row) =>
        sum +
        safeNumber(
          row.size
        ),
      0
    );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? (
          buyLiquidity /
          totalLiquidity
        ) *
        100
      : 50;

  const sellShare =
    totalLiquidity > 0
      ? (
          sellLiquidity /
          totalLiquidity
        ) *
        100
      : 50;

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    sellShare >
    buyShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  const bestBid =
    bids.length
      ? Math.max(
          ...bids.map(
            row =>
              row.price
          )
        )
      : 0;

  const bestAsk =
    asks.length
      ? Math.min(
          ...asks.map(
            row =>
              row.price
          )
        )
      : 0;

  const bidSizes =
    bids.map(
      row =>
        row.size
    );

  const askSizes =
    asks.map(
      row =>
        row.size
    );

  const bidMedian =
    percentile(
      bidSizes,
      0.5
    );

  const askMedian =
    percentile(
      askSizes,
      0.5
    );

  const bidWallThreshold =
    bidMedian * 4;

  const askWallThreshold =
    askMedian * 4;

  const buyWalls =
    bids.filter(
      row =>
        bidMedian > 0 &&
        row.size >=
          bidWallThreshold
    );

  const sellWalls =
    asks.filter(
      row =>
        askMedian > 0 &&
        row.size >=
          askWallThreshold
    );

  return {
    buyLiquidity,

    sellLiquidity,

    totalLiquidity,

    buyShare,

    sellShare,

    pressure,

    bestBid,

    bestAsk,

    spread:
      bestAsk > 0 &&
      bestBid > 0
        ? bestAsk - bestBid
        : 0,

    buyWalls,

    sellWalls,

    buyWallCount:
      buyWalls.length,

    sellWallCount:
      sellWalls.length,

    bidMedian,

    askMedian,

    bidWallThreshold,

    askWallThreshold
  };
}

/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function sma(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  let sum = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    sum +=
      safeNumber(
        values[i]
      );
  }

  return sum / period;
}

function ema(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const k =
    2 / (period + 1);

  let result = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    result +=
      safeNumber(
        values[i]
      );
  }

  result /=
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      safeNumber(
        values[i]
      ) *
        k +
      result *
        (1 - k);
  }

  return result;
}

function stddev(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const slice =
    values.slice(
      values.length -
        period
    );

  const mean =
    slice.reduce(
      (sum, value) =>
        sum +
        safeNumber(
          value
        ),
      0
    ) / period;

  const variance =
    slice.reduce(
      (sum, value) => {
        const diff =
          safeNumber(
            value
          ) - mean;

        return (
          sum +
          diff * diff
        );
      },
      0
    ) / period;

  return Math.sqrt(
    variance
  );
}

function rsi(values, period = 14) {
  if (
    !Array.isArray(values) ||
    values.length <
      period + 1
  ) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  const start =
    values.length -
    period;

  for (
    let i = start;
    i < values.length;
    i++
  ) {
    const previous =
      safeNumber(
        values[i - 1]
      );

    const current =
      safeNumber(
        values[i]
      );

    const change =
      current -
      previous;

    if (change > 0) {
      gain += change;
    } else if (
      change < 0
    ) {
      loss +=
        Math.abs(change);
    }
  }

  const averageGain =
    gain / period;

  const averageLoss =
    loss / period;

  if (
    averageLoss === 0
  ) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

function macd(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  if (
    !Array.isArray(values) ||
    values.length <
      slowPeriod +
        signalPeriod
  ) {
    return null;
  }

  const fast =
    ema(
      values,
      fastPeriod
    );

  const slow =
    ema(
      values,
      slowPeriod
    );

  if (
    fast === null ||
    slow === null
  ) {
    return null;
  }

  const macdLine =
    fast - slow;

  const points = [];

  for (
    let i = slowPeriod;
    i < values.length;
    i++
  ) {
    const slice =
      values.slice(
        0,
        i + 1
      );

    const fastValue =
      ema(
        slice,
        fastPeriod
      );

    const slowValue =
      ema(
        slice,
        slowPeriod
      );

    if (
      fastValue !== null &&
      slowValue !== null
    ) {
      points.push(
        fastValue -
          slowValue
      );
    }
  }

  const signal =
    ema(
      points,
      signalPeriod
    );

  return {
    macd:
      macdLine,

    signal,

    histogram:
      signal === null
        ? null
        : macdLine -
          signal
  };
}

function atr(
  candles,
  period = 14
) {
  if (
    !Array.isArray(candles) ||
    candles.length <
      period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const high =
      safeNumber(
        current.high
      );

    const low =
      safeNumber(
        current.low
      );

    const previousClose =
      safeNumber(
        previous.close
      );

    const tr =
      Math.max(
        high - low,

        Math.abs(
          high -
            previousClose
        ),

        Math.abs(
          low -
            previousClose
        )
      );

    trs.push(tr);
  }

  return sma(
    trs,
    period
  );
}

function bollingerWidth(
  values,
  period = 20,
  multiplier = 2
) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const middle =
    sma(
      values,
      period
    );

  const deviation =
    stddev(
      values,
      period
    );

  if (
    middle === null ||
    deviation === null ||
    middle === 0
  ) {
    return null;
  }

  const upper =
    middle +
    deviation *
      multiplier;

  const lower =
    middle -
    deviation *
      multiplier;

  return {
    middle,

    upper,

    lower,

    width:
      (
        (upper - lower) /
        middle
      ) *
      100
  };
}

/* =========================================================
   PIVOTS
========================================================= */

function pivotHigh(
  values,
  left = 2,
  right = 2
) {
  if (
    !Array.isArray(values) ||
    values.length <
      left +
        right +
        1
  ) {
    return [];
  }

  const result = [];

  for (
    let i = left;
    i <
      values.length -
        right;
    i++
  ) {
    const current =
      safeNumber(
        values[i]
      );

    let isPivot =
      true;

    for (
      let j = 1;
      j <= left;
      j++
    ) {
      if (
        safeNumber(
          values[i - j]
        ) >= current
      ) {
        isPivot = false;
        break;
      }
    }

    if (!isPivot) {
      continue;
    }

    for (
      let j = 1;
      j <= right;
      j++
    ) {
      if (
        safeNumber(
          values[i + j]
        ) >= current
      ) {
        isPivot = false;
        break;
      }
    }

    if (isPivot) {
      result.push(i);
    }
  }

  return result;
}

function pivotLow(
  values,
  left = 2,
  right = 2
) {
  if (
    !Array.isArray(values) ||
    values.length <
      left +
        right +
        1
  ) {
    return [];
  }

  const result = [];

  for (
    let i = left;
    i <
      values.length -
        right;
    i++
  ) {
    const current =
      safeNumber(
        values[i]
      );

    let isPivot =
      true;

    for (
      let j = 1;
      j <= left;
      j++
    ) {
      if (
        safeNumber(
          values[i - j]
        ) <= current
      ) {
        isPivot = false;
        break;
      }
    }

    if (!isPivot) {
      continue;
    }

    for (
      let j = 1;
      j <= right;
      j++
    ) {
      if (
        safeNumber(
          values[i + j]
        ) <= current
      ) {
        isPivot = false;
        break;
      }
    }

    if (isPivot) {
      result.push(i);
    }
  }

  return result;
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function mergeLevels(
  levels,
  tolerance
) {
  if (
    !Array.isArray(levels) ||
    !levels.length
  ) {
    return [];
  }

  const sorted =
    [...levels]
      .filter(
        value =>
          Number.isFinite(
            Number(value)
          )
      )
      .map(Number)
      .sort(
        (a, b) => a - b
      );

  const merged = [];

  for (
    const price of sorted
  ) {
    const last =
      merged[
        merged.length - 1
      ];

    if (
      !last ||
      Math.abs(
        price -
          last.price
      ) >
        tolerance
    ) {
      merged.push({
        price,
        touches: 1
      });
    } else {
      last.price =
        (
          last.price *
            last.touches +
          price
        ) /
        (last.touches + 1);

      last.touches++;
    }
  }

  return merged;
}

function supportResistance(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 10
  ) {
    return {
      supports: [],
      resistances: []
    };
  }

  const highs =
    candles.map(
      c =>
        safeNumber(
          c.high
        )
    );

  const lows =
    candles.map(
      c =>
        safeNumber(
          c.low
        )
    );

  const closes =
    candles.map(
      c =>
        safeNumber(
          c.close
        )
    );

  const lastClose =
    closes[
      closes.length - 1
    ];

  const atrValue =
    atr(
      candles,
      14
    ) ||
    Math.max(
      lastClose * 0.001,
      0.00000001
    );

  const highIndexes =
    pivotHigh(
      highs,
      2,
      2
    );

  const lowIndexes =
    pivotLow(
      lows,
      2,
      2
    );

  const resistanceLevels =
    highIndexes.map(
      index =>
        highs[index]
    );

  const supportLevels =
    lowIndexes.map(
      index =>
        lows[index]
    );

  const tolerance =
    atrValue * 0.35;

  const supports =
    mergeLevels(
      supportLevels,
      tolerance
    )
      .filter(
        level =>
          level.price <
          lastClose
      )
      .sort(
        (a, b) =>
          b.price -
          a.price
      )
      .slice(0, 8);

  const resistances =
    mergeLevels(
      resistanceLevels,
      tolerance
    )
      .filter(
        level =>
          level.price >
          lastClose
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
      )
      .slice(0, 8);

  return {
    supports,

    resistances
  };
}

/* =========================================================
   LIQUIDITY SWEEP
========================================================= */

function detectLiquiditySweep(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 5
  ) {
    return {
      type: "NONE",
      detected: false,
      strength: 0
    };
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      0,
      candles.length - 1
    );

  const recentHigh =
    Math.max(
      ...previous
        .slice(-10)
        .map(
          c =>
            safeNumber(
              c.high
            )
        )
    );

  const recentLow =
    Math.min(
      ...previous
        .slice(-10)
        .map(
          c =>
            safeNumber(
              c.low
            )
        )
    );

  const currentHigh =
    safeNumber(
      last.high
    );

  const currentLow =
    safeNumber(
      last.low
    );

  const currentClose =
    safeNumber(
      last.close
    );

  const range =
    Math.max(
      currentHigh -
        currentLow,
      0.00000001
    );

  if (
    currentHigh >
      recentHigh &&
    currentClose <
      recentHigh
  ) {
    return {
      type:
        "SELL_SIDE_SWEEP",

      detected: true,

      strength:
        Math.min(
          100,
          (
            (
              currentHigh -
              recentHigh
            ) /
            range
          ) *
            100
        )
    };
  }

  if (
    currentLow <
      recentLow &&
    currentClose >
      recentLow
  ) {
    return {
      type:
        "BUY_SIDE_SWEEP",

      detected: true,

      strength:
        Math.min(
          100,
          (
            (
              recentLow -
              currentLow
            ) /
            range
          ) *
            -100
        )
      };
  }

  return {
    type: "NONE",

    detected: false,

    strength: 0
  };
}

/* =========================================================
   DIVERGENCE
========================================================= */

function detectDivergence(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 30
  ) {
    return {
      type: "NONE",
      detected: false,
      strength: 0
    };
  }

  const closes =
    candles.map(
      c =>
        safeNumber(
          c.close
        )
    );

  const rsiValues = [];

  for (
    let i = 14;
    i < closes.length;
    i++
  ) {
    const value =
      rsi(
        closes.slice(
          0,
          i + 1
        ),
        14
      );

    if (
      value !== null
    ) {
      rsiValues.push({
        index: i,
        value
      });
    }
  }

  if (
    rsiValues.length < 10
  ) {
    return {
      type: "NONE",
      detected: false,
      strength: 0
    };
  }

  const recent =
    rsiValues.slice(-12);

  const highs =
    pivotHigh(
      recent.map(
        x =>
          x.value
      ),
      2,
      2
    );

  const lows =
    pivotLow(
      recent.map(
        x =>
          x.value
      ),
      2,
      2
    );

  if (
    highs.length >= 2
  ) {
    const a =
      highs[
        highs.length - 2
      ];

    const b =
      highs[
        highs.length - 1
      ];

    const priceA =
      closes[
        recent[a].index
      ];

    const priceB =
      closes[
        recent[b].index
      ];

    const rsiA =
      recent[a].value;

    const rsiB =
      recent[b].value;

    if (
      priceB > priceA &&
      rsiB < rsiA
    ) {
      return {
        type:
          "BEARISH_DIVERGENCE",

        detected: true,

        strength:
          Math.min(
            100,
            Math.abs(
              rsiA - rsiB
            ) * 4
          )
      };
    }
  }

  if (
    lows.length >= 2
  ) {
    const a =
      lows[
        lows.length - 2
      ];

    const b =
      lows[
        lows.length - 1
      ];

    const priceA =
      closes[
        recent[a].index
      ];

    const priceB =
      closes[
        recent[b].index
      ];

    const rsiA =
      recent[a].value;

    const rsiB =
      recent[b].value;

    if (
      priceB < priceA &&
      rsiB > rsiA
    ) {
      return {
        type:
          "BULLISH_DIVERGENCE",

        detected: true,

        strength:
          Math.min(
            100,
            Math.abs(
              rsiB - rsiA
            ) * 4
          )
      };
    }
  }

  return {
    type: "NONE",

    detected: false,

    strength: 0
  };
}

    ) {
      sellVolume += t.size;
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

  const deltaPercent =
    totalVolume > 0
      ? (delta / totalVolume) * 100
      : 0;

  const averageNotional =
    values.length
      ? values.reduce(
          (a, b) => a + b,
          0
        ) / values.length
      : 0;

  const p95 =
    percentile(
      values,
      0.95
    );

  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let largeBuyValue = 0;
  let largeSellValue = 0;

  for (const t of trades) {
    if (
      t.value <
      largeThreshold
    ) {
      continue;
    }

    if (t.side === "BUY") {
      largeBuyVolume +=
        t.size;

      largeBuyValue +=
        t.value;
    }

    if (t.side === "SELL") {
      largeSellVolume +=
        t.size;

      largeSellValue +=
        t.value;
    }
  }

  let pressure =
    "NEUTRAL";

  if (
    deltaPercent >= 10
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    deltaPercent <= -10
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    buyVolume,
    sellVolume,
    totalVolume,

    buyValue,
    sellValue,
    totalValue,

    buyTrades,
    sellTrades,

    delta,
    deltaValue,
    deltaPercent,

    averageNotional,
    p95,
    largeThreshold,

    largeBuyVolume,
    largeSellVolume,

    largeBuyValue,
    largeSellValue,

    pressure
  };
}

/* =========================================================
   TICK / FOOTPRINT
========================================================= */

function decimalsFromTick(tick) {
  const s =
    String(tick);

  if (!s.includes(".")) {
    return 0;
  }

  return s
    .split(".")[1]
    .replace(/0+$/, "")
    .length;
}

function roundToTick(
  price,
  tickSize
) {
  const tick =
    Number(tickSize);

  if (
    !Number.isFinite(tick) ||
    tick <= 0
  ) {
    return Number(price);
  }

  const n =
    Math.round(
      Number(price) / tick
    ) * tick;

  const decimals =
    decimalsFromTick(tick);

  return Number(
    n.toFixed(decimals)
  );
}

function aggregateFootprint(
  trades,
  tickSize
) {
  const levels =
    new Map();

  for (const t of trades) {
    const price =
      roundToTick(
        t.price,
        tickSize
      );

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

    const level =
      levels.get(price);

    if (t.side === "BUY") {
      level.buyVolume +=
        t.size;

      level.buyValue +=
        t.value;

      level.buyTrades++;
    } else if (
      t.side === "SELL"
    ) {
      level.sellVolume +=
        t.size;

      level.sellValue +=
        t.value;

      level.sellTrades++;
    }
  }

  return [
    ...levels.values()
  ]
    .sort(
      (a, b) =>
        a.price - b.price
    )
    .map(level => ({
      ...level,

      delta:
        level.buyVolume -
        level.sellVolume,

      deltaValue:
        level.buyValue -
        level.sellValue,

      totalVolume:
        level.buyVolume +
        level.sellVolume,

      imbalance:
        level.sellVolume > 0
          ? level.buyVolume /
            level.sellVolume
          : level.buyVolume > 0
            ? Infinity
            : 0
    }));
}

/* =========================================================
   ORDER BOOK
========================================================= */

function orderbookStats(data) {
  const bids =
    Array.isArray(data?.b)
      ? data.b
      : [];

  const asks =
    Array.isArray(data?.a)
      ? data.a
      : [];

  let buyLiquidity = 0;
  let sellLiquidity = 0;

  let buyValue = 0;
  let sellValue = 0;

  for (const row of bids) {
    const price =
      safeNumber(row[0]);

    const size =
      safeNumber(row[1]);

    buyLiquidity +=
      size;

    buyValue +=
      price * size;
  }

  for (const row of asks) {
    const price =
      safeNumber(row[0]);

    const size =
      safeNumber(row[1]);

    sellLiquidity +=
      size;

    sellValue +=
      price * size;
  }

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity > 0
      ? (
          buyLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  const sellShare =
    totalLiquidity > 0
      ? (
          sellLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
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

    buyValue,
    sellValue,

    buyShare,
    sellShare,

    bestBid:
      bids.length
        ? safeNumber(
            bids[0][0]
          )
        : 0,

    bestAsk:
      asks.length
        ? safeNumber(
            asks[0][0]
          )
        : 0,

    spread:
      bids.length &&
      asks.length
        ? safeNumber(
            asks[0][0]
          ) -
          safeNumber(
            bids[0][0]
          )
        : 0,

    pressure,

    bids,
    asks
  };
}

/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  trades,
  candles,
  book
) {
  if (!candles.length) {
    return {
      detected: false,
      type: "NONE",
      score: 0
    };
  }

  const candle =
    candles[
      candles.length - 1
    ];

  const stats =
    tradeStats(trades);

  const range =
    candle.high -
    candle.low;

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const bodyRatio =
    range > 0
      ? body / range
      : 1;

  let score = 0;
  let type = "NONE";

  if (
    stats.pressure ===
      "SELL_PRESSURE" &&
    range > 0
  ) {
    const nearLow =
      (
        candle.close -
        candle.low
      ) / range;

    if (
      nearLow <= 0.25
    ) {
      score += 35;
      type =
        "BUY_ABSORPTION";
    }
  }

  if (
    stats.pressure ===
      "BUY_PRESSURE" &&
    range > 0
  ) {
    const nearHigh =
      (
        candle.high -
        candle.close
      ) / range;

    if (
      nearHigh <= 0.25
    ) {
      score += 35;
      type =
        "SELL_ABSORPTION";
    }
  }

  if (
    bodyRatio < 0.35
  ) {
    score += 20;
  }

  if (
    book &&
    type ===
      "BUY_ABSORPTION" &&
    book.pressure ===
      "BUY_PRESSURE"
  ) {
    score += 20;
  }

  if (
    book &&
    type ===
      "SELL_ABSORPTION" &&
    book.pressure ===
      "SELL_PRESSURE"
  ) {
    score += 20;
  }

  return {
    detected:
      score >= 50,

    type,

    score,

    bodyRatio,

    pressure:
      stats.pressure
  };
}

/* =========================================================
   BYBIT FUTURES SYMBOLS
========================================================= */

function isPerpetual(row) {
  const contractType =
    String(
      row?.contractType ||
      ""
    )
      .trim()
      .toUpperCase();

  const status =
    String(
      row?.status ||
      ""
    )
      .trim()
      .toUpperCase();

  const quoteCoin =
    String(
      row?.quoteCoin ||
      ""
    )
      .trim()
      .toUpperCase();

  const settleCoin =
    String(
      row?.settleCoin ||
      ""
    )
      .trim()
      .toUpperCase();

  const perpetual =
    contractType ===
      "LINEARPERPETUAL" ||
    contractType ===
      "LINEAR_PERPETUAL" ||
    contractType ===
      "PERPETUAL" ||
    contractType.includes(
      "PERPETUAL"
    );

  const usdt =
    quoteCoin === "USDT" ||
    settleCoin === "USDT";

  return (
    status === "TRADING" &&
    perpetual &&
    usdt
  );
}

async function getBybitSymbols() {
  let cursor = "";

  const output = [];

  for (
    let page = 0;
    page < 20;
    page++
  ) {
    const result =
      await bybit(
        "/v5/market/instruments-info",
        {
          category:
            "linear",

          status:
            "Trading",

          limit:
            SYMBOL_LIMIT,

          cursor
        }
      );

    const list =
      Array.isArray(
        result?.list
      )
        ? result.list
        : [];

    for (const row of list) {
      if (
        !isPerpetual(row)
      ) {
        continue;
      }

      const symbol =
        normalizeSymbol(
          row.symbol
        );

      if (
        !symbol.endsWith(
          "USDT"
        )
      ) {
        continue;
      }

      output.push({
        symbol,

        tickSize:
          safeNumber(
            row
              ?.priceFilter
              ?.tickSize,
            0
          ),

        minOrderQty:
          safeNumber(
            row
              ?.lotSizeFilter
              ?.minOrderQty,
            0
          )
      });
    }

    cursor =
      result?.nextPageCursor ||
      "";

    if (!cursor) {
      break;
    }
  }

  const unique =
    new Map();

  for (const item of output) {
    unique.set(
      item.symbol,
      item
    );
  }

  return [
    ...unique.values()
  ].sort(
    (a, b) =>
      a.symbol.localeCompare(
        b.symbol
      )
  );
}

/* =========================================================
   VOLUME TEST
   NO DATABASE WRITE
========================================================= */

async function testVolume(
  symbol
) {
  const startedAt =
    Date.now();

  symbol =
    normalizeSymbol(symbol);

  const result =
    await bybit(
      "/v5/market/recent-trade",
      {
        category:
          "linear",

        symbol,

        limit:
          TRADE_LIMIT
      }
    );

  const trades =
    parseTrades(
      result?.list
    );

  if (!trades.length) {
    return {
      ok: false,

      test:
        "VOLUME_TEST",

      symbol,

      error:
        "No valid trades received from Bybit",

      version:
        VERSION
    };
  }

  /*
   * Original normalized trade objects.
   */
  const rawTradePayload =
    JSON.stringify(
      trades
    );

  const rawTradeBytes =
    utf8ByteLength(
      rawTradePayload
    );

  const gzipTradeBytes =
    await gzipByteLength(
      rawTradePayload
    );

  /*
   * Group trades by minute.
   */
  const minuteMap =
    new Map();

  for (const trade of trades) {
    const minute =
      minuteStartOf(
        trade.time
      );

    if (
      !minuteMap.has(minute)
    ) {
      minuteMap.set(
        minute,
        []
      );
    }

    minuteMap
      .get(minute)
      .push(trade);
  }

  const minuteTests = [];

  for (
    const [
      minute,
      minuteTrades
    ]
    of minuteMap
  ) {
    const payload =
      JSON.stringify(
        minuteTrades
      );

    const rawBytes =
      utf8ByteLength(
        payload
      );

    const gzipBytes =
      await gzipByteLength(
        payload
      );

    minuteTests.push({
      minute,

      iso:
        new Date(
          minute
        ).toISOString(),

      trades:
        minuteTrades.length,

      rawBytes,

      rawKB:
        bytesToKB(
          rawBytes
        ),

      rawMB:
        bytesToMB(
          rawBytes
        ),

      gzipBytes,

      gzipKB:
        gzipBytes === null
          ? null
          : bytesToKB(
              gzipBytes
            ),

      gzipMB:
        gzipBytes === null
          ? null
          : bytesToMB(
              gzipBytes
            ),

      compression:
        compressionInfo(
          rawBytes,
          gzipBytes
        )
    });
  }

  minuteTests.sort(
    (a, b) =>
      a.minute -
      b.minute
  );

  const coveredMinutes =
    minuteTests.length;

  const totalTrades =
    trades.length;

  const firstTradeTime =
    Math.min(
      ...trades.map(
        t => t.time
      )
    );

  const lastTradeTime =
    Math.max(
      ...trades.map(
        t => t.time
      )
    );

  const elapsedDataMinutes =
    Math.max(
      1,
      Math.ceil(
        (
          lastTradeTime -
          firstTradeTime
        ) /
          MINUTE_MS
      ) + 1
    );

  /*
   * Actual average based on received sample.
   */
  const averageRawPerMinute =
    rawTradeBytes /
    elapsedDataMinutes;

  const averageGzipPerMinute =
    gzipTradeBytes === null
      ? null
      : gzipTradeBytes /
        elapsedDataMinutes;

  /*
   * Projection for one hour.
   */
  const estimatedHourRaw =
    averageRawPerMinute *
    60;

  const estimatedHourGzip =
    averageGzipPerMinute === null
      ? null
      : averageGzipPerMinute *
        60;

  /*
   * Projection for 20,000 hour rows.
   *
   * This is only a size estimate.
   * Actual rows differ by symbol/activity.
   */
  const estimated20KRaw =
    estimatedHourRaw *
    MAX_ROWS;

  const estimated20KGzip =
    estimatedHourGzip === null
      ? null
      : estimatedHourGzip *
        MAX_ROWS;

  /*
   * Also calculate average size
   * of one minute from grouped data.
   */
  let groupedRawTotal = 0;
  let groupedGzipTotal = 0;
  let groupedGzipAvailable = true;

  let minRaw =
    Number.POSITIVE_INFINITY;

  let maxRaw = 0;

  let minGzip =
    Number.POSITIVE_INFINITY;

  let maxGzip = 0;

  for (const item of minuteTests) {
    groupedRawTotal +=
      item.rawBytes;

    if (
      Number.isFinite(
        item.gzipBytes
      )
    ) {
      groupedGzipTotal +=
        item.gzipBytes;

      minGzip =
        Math.min(
          minGzip,
          item.gzipBytes
        );

      maxGzip =
        Math.max(
          maxGzip,
          item.gzipBytes
        );
    } else {
      groupedGzipAvailable =
        false;
    }

    minRaw =
      Math.min(
        minRaw,
        item.rawBytes
      );

    maxRaw =
      Math.max(
        maxRaw,
        item.rawBytes
      );
  }

  const averageGroupedRaw =
    coveredMinutes > 0
      ? groupedRawTotal /
        coveredMinutes
      : 0;

  const averageGroupedGzip =
    coveredMinutes > 0 &&
    groupedGzipAvailable
      ? groupedGzipTotal /
        coveredMinutes
      : null;

  return {
    ok: true,

    test:
      "VOLUME_TEST",

    version:
      VERSION,

    symbol,

    source:
      "Bybit Linear Futures publicTrade",

    databaseWrite:
      false,

    databaseModified:
      false,

    compression:
      "GZIP lossless",

    compressionAvailable:
      gzipTradeBytes !== null,

    sample: {
      trades:
        totalTrades,

      firstTradeTime,

      firstTradeISO:
        new Date(
          firstTradeTime
        ).toISOString(),

      lastTradeTime,

      lastTradeISO:
        new Date(
          lastTradeTime
        ).toISOString(),

      elapsedDataMinutes,

      coveredMinutes
    },

    rawSample: {
      bytes:
        rawTradeBytes,

      KB:
        bytesToKB(
          rawTradeBytes
        ),

      MB:
        bytesToMB(
          rawTradeBytes
        )
    },

    gzipSample:
      compressionInfo(
        rawTradeBytes,
        gzipTradeBytes
      ),

    minute: {
      averageRawBytes:
        Math.round(
          averageRawPerMinute
        ),

      averageRawKB:
        bytesToKB(
          averageRawPerMinute
        ),

      averageRawMB:
        bytesToMB(
          averageRawPerMinute
        ),

      averageGzipBytes:
        averageGzipPerMinute === null
          ? null
          : Math.round(
              averageGzipPerMinute
            ),

      averageGzipKB:
        averageGzipPerMinute === null
          ? null
          : bytesToKB(
              averageGzipPerMinute
            ),

      averageGzipMB:
        averageGzipPerMinute === null
          ? null
          : bytesToMB(
              averageGzipPerMinute
            )
    },

    groupedMinuteStats: {
      averageRawBytes:
        Math.round(
          averageGroupedRaw
        ),

      averageRawKB:
        bytesToKB(
          averageGroupedRaw
        ),

      averageGzipBytes:
        averageGroupedGzip === null
          ? null
          : Math.round(
              averageGroupedGzip
            ),

      averageGzipKB:
        averageGroupedGzip === null
          ? null
          : bytesToKB(
              averageGroupedGzip
            ),

      minimumRawBytes:
        Number.isFinite(
          minRaw
        )
          ? minRaw
          : 0,

      maximumRawBytes:
        maxRaw,

      minimumGzipBytes:
        groupedGzipAvailable &&
        Number.isFinite(
          minGzip
        )
          ? minGzip
          : null,

      maximumGzipBytes:
        groupedGzipAvailable
          ? maxGzip
          : null
    },

    estimatedHour: {
      rawBytes:
        Math.round(
          estimatedHourRaw
        ),

      rawKB:
        bytesToKB(
          estimatedHourRaw
        ),

      rawMB:
        bytesToMB(
          estimatedHourRaw
        ),

      gzipBytes:
        estimatedHourGzip === null
          ? null
          : Math.round(
              estimatedHourGzip
            ),

      gzipKB:
        estimatedHourGzip === null
          ? null
          : bytesToKB(
              estimatedHourGzip
            ),

      gzipMB:
        estimatedHourGzip === null
          ? null
          : bytesToMB(
              estimatedHourGzip
            )
    },

    estimatedStorage: {
      model:
        "1 symbol + 1 hour = 1 row",

      maxRows:
        MAX_ROWS,

      rawBytes:
        Math.round(
          estimated20KRaw
        ),

      rawMB:
        bytesToMB(
          estimated20KRaw
        ),

      rawGB:
        bytesToGB(
          estimated20KRaw
        ),

      gzipBytes:
        estimated20KGzip === null
          ? null
          : Math.round(
              estimated20KGzip
            ),

      gzipMB:
        estimated20KGzip === null
          ? null
          : bytesToMB(
              estimated20KGzip
            ),

      gzipGB:
        estimated20KGzip === null
          ? null
          : bytesToGB(
              estimated20KGzip
            )
    },

    minuteTests,

    elapsedMs:
      Date.now() -
      startedAt,

    note:
      "This endpoint only measures data size. It never writes to Durable Object SQLite."
  };
}

/* =========================================================
   ON-DEMAND MARKET DATA
========================================================= */

async function getMarket(
  symbol,
  interval
) {
  symbol =
    normalizeSymbol(symbol);

  interval =
    normalizeInterval(interval);

  const [
    klineResult,
    tickerResult,
    orderbookResult,
    tradeResult,
    instrumentResult
  ] = await Promise.all([
    bybit(
      "/v5/market/kline",
      {
        category:
          "linear",

        symbol,

        interval,

        limit:
          KLINE_LIMIT
      }
    ),

    bybit(
      "/v5/market/tickers",
      {
        category:
          "linear",

        symbol
      }
    ),

    bybit(
      "/v5/market/orderbook",
      {
        category:
          "linear",

        symbol,

        limit:
          ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category:
          "linear",

        symbol,

        limit:
          TRADE_LIMIT
      }
    ),

    bybit(
      "/v5/market/instruments-info",
      {
        category:
          "linear",

        symbol
      }
    )
  ]);

  const candles =
    parseKlines(
      klineResult?.list
    );

  const trades =
    parseTrades(
      tradeResult?.list
    );

  const orderbook =
    orderbookResult || {};

  const ticker =
    Array.isArray(
      tickerResult?.list
    )
      ? tickerResult.list[0]
      : null;

  const instrument =
    Array.isArray(
      instrumentResult?.list
    )
      ? instrumentResult.list[0]
      : null;

  const tickSize =
    safeNumber(
      instrument
        ?.priceFilter
        ?.tickSize,
      0
    );

  const stats =
    tradeStats(
      trades
    );

  const footprint =
    aggregateFootprint(
      trades,
      tickSize
    );

  const orderbookData =
    orderbookStats(
      orderbook
    );

  const absorption =
    detectAbsorption(
      trades,
      candles,
      orderbookData
    );

  const closes =
    candles.map(
      candle =>
        candle.close
    );

  const technical = {
    sma20:
      sma(
        closes,
        20
      ),

    ema20:
      ema(
        closes,
        20
      ),

    rsi:
      rsi(
        closes,
        14
      ),

    macd:
      macd(
        closes
      ),

    atr:
      atr(
        candles,
        14
      ),

    bollinger:
      bollingerWidth(
        closes,
        20,
        2
      ),

    supportResistance:
      supportResistance(
        candles
      ),

    liquiditySweep:
      detectLiquiditySweep(
        candles
      ),

    divergence:
      detectDivergence(
        candles
      )
  };

  return {
    version:
      VERSION,

    symbol,

    interval,

    candles,

    trades,

    ticker,

    stats,

    footprint,

    orderbook:
      orderbookData,

    absorption,

    technical,

    instrument: {
      tickSize,

      minOrderQty:
        safeNumber(
          instrument
            ?.lotSizeFilter
            ?.minOrderQty,
          0
        )
    }
  };
}

/* =========================================================
   DURABLE OBJECT BINDINGS
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR_V5
  ) {
    throw new Error(
      "TRADE_COLLECTOR_V5 binding پیدا نشد"
    );
  }

  return env
    .TRADE_COLLECTOR_V5
    .idFromName(
      "absorption-storage-v5-global"
    );
}

function collectorStub(env) {
  return env
    .TRADE_COLLECTOR_V5
    .get(
      collectorId(env)
    );
}

/* =========================================================
   LEGACY TRADE COLLECTOR
========================================================= */

export class TradeCollector {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    return json({
      ok: true,

      legacy: true,

      collector:
        "TradeCollector",

      writeEnabled:
        false,

      message:
        "Legacy storage preserved. New writes disabled.",

      path:
        url.pathname,

      version:
        VERSION
    });
  }

  async alarm() {
    return;
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];

    this.symbolMeta =
      new Map();

    this.subscribed =
      new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;
    this.wsStartedAt = 0;

    this.lastError = "";

    this.reconnectAttempt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.alarmScheduled = false;

    this.dbInitialized = false;
    this.tableExists = null;

    this.hourBlocks =
      new Map();

    this.dedupe =
      new Map();

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks =
      false;

    this.checkpointRunning =
      false;

    this.lastCheckpointAt = 0;

    this.totalMessages = 0;
    this.totalTrades = 0;
    this.totalDuplicates = 0;
    this.totalInvalidTrades = 0;
    this.totalPersistedBlocks = 0;
    this.totalDeletedRows = 0;
  }

    const stats =
      tradeStats(
        trades
      );

    const footprint =
      aggregateFootprint(
        trades,
        tickSize
      );

    const orderbookData =
      orderbookStats(
        orderbook
      );

    const absorption =
      detectAbsorption(
        trades,
        candles,
        orderbookData
      );

    const closes =
      candles.map(
        candle =>
          candle.close
      );

    const technical = {
      sma20:
        sma(
          closes,
          20
        ),

      ema20:
        ema(
          closes,
          20
        ),

      rsi:
        rsi(
          closes,
          14
        ),

      macd:
        macd(
          closes
        ),

      atr:
        atr(
          candles,
          14
        ),

      bollinger:
        bollingerWidth(
          closes,
          20,
          2
        ),

      supportResistance:
        supportResistance(
          candles
        ),

      liquiditySweep:
        detectLiquiditySweep(
          candles
        ),

      divergence:
        detectDivergence(
          candles
        )
    };

    return {
      version:
        VERSION,

      symbol,

      interval,

      candles,

      trades,

      ticker,

      stats,

      footprint,

      orderbook:
        orderbookData,

      absorption,

      technical,

      instrument: {
        tickSize,

        minOrderQty:
          safeNumber(
            instrument
              ?.lotSizeFilter
              ?.minOrderQty,
            0
          )
      }
    };
}

/* =========================================================
   DURABLE OBJECT BINDINGS
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR_V5
  ) {
    throw new Error(
      "TRADE_COLLECTOR_V5 binding پیدا نشد"
    );
  }

  return env
    .TRADE_COLLECTOR_V5
    .idFromName(
      "absorption-storage-v5-global"
    );
}

function collectorStub(env) {
  return env
    .TRADE_COLLECTOR_V5
    .get(
      collectorId(env)
    );
}

/* =========================================================
   LEGACY TRADE COLLECTOR
========================================================= */

export class TradeCollector {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    return json({
      ok: true,

      legacy: true,

      collector:
        "TradeCollector",

      writeEnabled:
        false,

      message:
        "Legacy storage preserved. New writes disabled.",

      path:
        url.pathname,

      version:
        VERSION
    });
  }

  async alarm() {
    return;
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];

    this.symbolMeta =
      new Map();

    this.subscribed =
      new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;
    this.wsStartedAt = 0;

    this.lastError = "";

    this.reconnectAttempt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.alarmScheduled = false;

    this.dbInitialized = false;
    this.tableExists = null;

    this.hourBlocks =
      new Map();

    this.dedupe =
      new Map();

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks =
      false;

    this.checkpointRunning =
      false;

    this.lastCheckpointAt = 0;

    this.totalMessages = 0;
    this.totalTrades = 0;
    this.totalDuplicates = 0;
    this.totalInvalidTrades = 0;
    this.totalPersistedBlocks = 0;
    this.totalDeletedRows = 0;
  }

  /* =======================================================
     DATABASE
  ======================================================= */

  ensureDB() {
    if (
      this.dbInitialized
    ) {
      return;
    }

    this.state.storage.sql.exec(
      `
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, hour_start)
      )
      `
    );

    this.state.storage.sql.exec(
      `
      CREATE INDEX IF NOT EXISTS
      idx_${TABLE_NAME}_hour
      ON ${TABLE_NAME}(hour_start)
      `
    );

    this.dbInitialized = true;
    this.tableExists = true;
  }

  ensureDBForWrite() {
    this.ensureDB();
  }

  getRowCount() {
    this.ensureDB();

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT COUNT(*) AS count
          FROM ${TABLE_NAME}
          `
        )
        .toArray();

    return Number(
      rows?.[0]?.count || 0
    );
  }

  cleanupOldRows() {
    this.ensureDB();

    const count =
      this.getRowCount();

    if (
      count <= MAX_ROWS
    ) {
      return {
        before:
          count,

        deleted: 0,

        after:
          count
      };
    }

    const deleteCount =
      count -
      CLEANUP_TARGET_ROWS;

    if (
      deleteCount <= 0
    ) {
      return {
        before:
          count,

        deleted: 0,

        after:
          count
      };
    }

    this.state.storage.sql.exec(
      `
      DELETE FROM ${TABLE_NAME}
      WHERE rowid IN (
        SELECT rowid
        FROM ${TABLE_NAME}
        ORDER BY hour_start ASC
        LIMIT ?
      )
      `,
      deleteCount
    );

    const after =
      this.getRowCount();

    const deleted =
      Math.max(
        0,
        count - after
      );

    this.totalDeletedRows +=
      deleted;

    this.lastCleanupAt =
      Date.now();

    return {
      before:
        count,

      deleted,

      after
    };
  }

  /* =======================================================
     SERIALIZATION
  ======================================================= */

  serializeBlock(
    block
  ) {
    const candles = [];

    for (
      const candle
      of block.candles.values()
    ) {
      const levels = [];

      for (
        const level
        of candle.levels.values()
      ) {
        levels.push({
          price:
            level.price,

          buyVolume:
            level.buyVolume,

          sellVolume:
            level.sellVolume,

          buyValue:
            level.buyValue,

          sellValue:
            level.sellValue,

          buyTrades:
            level.buyTrades,

          sellTrades:
            level.sellTrades
        });
      }

      candles.push({
        m:
          candle.m,

        o:
          candle.o,

        h:
          candle.h,

        l:
          candle.l,

        c:
          candle.c,

        v:
          candle.v,

        t:
          candle.t,

        b:
          candle.b,

        s:
          candle.s,

        bv:
          candle.bv,

        sv:
          candle.sv,

        bt:
          candle.bt,

        st:
          candle.st,

        ot:
          candle.ot,

        ct:
          candle.ct,

        levels
      });
    }

    return JSON.stringify({
      v:
        block.v || 1,

      symbol:
        block.symbol,

      hourStart:
        block.hourStart,

      hourEnd:
        block.hourEnd,

      candles
    });
  }

  deserializeBlock(
    row
  ) {
    const raw =
      typeof row.data ===
      "string"
        ? row.data
        : String(
            row.data || ""
          );

    const parsed =
      JSON.parse(raw);

    const candles =
      new Map();

    for (
      const item
      of Array.isArray(
        parsed.candles
      )
        ? parsed.candles
        : []
    ) {
      const levels =
        new Map();

      for (
        const level
        of Array.isArray(
          item.levels
        )
          ? item.levels
          : []
      ) {
        levels.set(
          Number(
            level.price
          ),
          {
            price:
              safeNumber(
                level.price
              ),

            buyVolume:
              safeNumber(
                level.buyVolume
              ),

            sellVolume:
              safeNumber(
                level.sellVolume
              ),

            buyValue:
              safeNumber(
                level.buyValue
              ),

            sellValue:
              safeNumber(
                level.sellValue
              ),

            buyTrades:
              safeNumber(
                level.buyTrades
              ),

            sellTrades:
              safeNumber(
                level.sellTrades
              )
          }
        );
      }

      const candle = {
        m:
          safeNumber(
            item.m
          ),

        o:
          safeNumber(
            item.o
          ),

        h:
          safeNumber(
            item.h
          ),

        l:
          safeNumber(
            item.l
          ),

        c:
          safeNumber(
            item.c
          ),

        v:
          safeNumber(
            item.v
          ),

        t:
          safeNumber(
            item.t
          ),

        b:
          safeNumber(
            item.b
          ),

        s:
          safeNumber(
            item.s
          ),

        bv:
          safeNumber(
            item.bv
          ),

        sv:
          safeNumber(
            item.sv
          ),

        bt:
          safeNumber(
            item.bt
          ),

        st:
          safeNumber(
            item.st
          ),

        ot:
          safeNumber(
            item.ot
          ),

        ct:
          safeNumber(
            item.ct
          ),

        levels
      };

      candles.set(
        candle.m,
        candle
      );
    }

    return {
      v:
        safeNumber(
          parsed.v,
          1
        ),

      symbol:
        parsed.symbol ||
        row.symbol,

      hourStart:
        safeNumber(
          parsed.hourStart,
          row.hour_start
        ),

      hourEnd:
        safeNumber(
          parsed.hourEnd
        ),

      candles,

      dirty: false,

      loaded: true
    };
  }

  /* =======================================================
     BLOCK CREATION
  ======================================================= */

  createHourBlock(
    symbol,
    hourStart
  ) {
    return {
      v: 1,

      symbol,

      hourStart,

      hourEnd:
        hourStart +
        HOUR_MS,

      candles:
        new Map(),

      dirty: false,

      loaded: false
    };
  }

  getOrCreateHourBlock(
    symbol,
    hourStart
  ) {
    const key =
      `${symbol}:${hourStart}`;

    let block =
      this.hourBlocks.get(
        key
      );

    if (!block) {
      block =
        this.createHourBlock(
          symbol,
          hourStart
        );

      this.hourBlocks.set(
        key,
        block
      );
    }

    return block;
  }

  getOrCreateCandle(
    block,
    minute
  ) {
    let candle =
      block.candles.get(
        minute
      );

    if (!candle) {
      candle = {
        m:
          minute,

        o: 0,
        h: 0,
        l: 0,
        c: 0,

        v: 0,
        t: 0,

        b: 0,
        s: 0,

        bv: 0,
        sv: 0,

        bt: 0,
        st: 0,

        ot: 0,
        ct: 0,

        levels:
          new Map()
      };

      block.candles.set(
        minute,
        candle
      );
    }

    return candle;
  }

  /* =======================================================
     TRADE APPLY
  ======================================================= */

  applyTrade(
    symbol,
    trade
  ) {
    const time =
      safeNumber(
        trade.time
      );

    const price =
      safeNumber(
        trade.price
      );

    const size =
      safeNumber(
        trade.size
      );

    if (
      !time ||
      price <= 0 ||
      size <= 0
    ) {
      this.totalInvalidTrades++;
      return false;
    }

    const hour =
      hourStartOf(
        time
      );

    const minute =
      minuteStartOf(
        time
      );

    const block =
      this.getOrCreateHourBlock(
        symbol,
        hour
      );

    const candle =
      this.getOrCreateCandle(
        block,
        minute
      );

    if (
      !candle.ot ||
      time < candle.ot
    ) {
      candle.ot =
        time;
    }

    if (
      !candle.ct ||
      time > candle.ct
    ) {
      candle.ct =
        time;
    }

    if (
      candle.o === 0
    ) {
      candle.o =
        price;
    }

    if (
      candle.h === 0 ||
      price >
        candle.h
    ) {
      candle.h =
        price;
    }

    if (
      candle.l === 0 ||
      price <
        candle.l
    ) {
      candle.l =
        price;
    }

    candle.c =
      price;

    candle.v +=
      size;

    candle.t +=
      price * size;

    const levelPrice =
      roundToTick(
        price,
        this.symbolMeta
          .get(symbol)
          ?.tickSize || 0
      );

    let level =
      candle.levels.get(
        levelPrice
      );

    if (!level) {
      level = {
        price:
          levelPrice,

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        buyTrades: 0,
        sellTrades: 0
      };

      candle.levels.set(
        levelPrice,
        level
      );
    }

    if (
      trade.side ===
      "BUY"
    ) {
      candle.b +=
        size;

      candle.bv +=
        size;

      candle.bt +=
        1;

      level.buyVolume +=
        size;

      level.buyValue +=
        price * size;

      level.buyTrades++;
    } else if (
      trade.side ===
      "SELL"
    ) {
      candle.s +=
        size;

      candle.sv +=
        size;

      candle.st +=
        1;

      level.sellVolume +=
        size;

      level.sellValue +=
        price * size;

      level.sellTrades++;
    }

    block.dirty =
      true;

    return true;
  }

  /* =======================================================
     DEDUPE
  ======================================================= */

  isDuplicate(
    symbol,
    trade
  ) {
    const id =
      String(
        trade.id ||
        `${symbol}-${trade.time}-${trade.price}-${trade.size}-${trade.side}`
      );

    const key =
      `${symbol}:${id}`;

    if (
      this.dedupe.has(key)
    ) {
      this.totalDuplicates++;
      return true;
    }

    this.dedupe.set(
      key,
      Date.now()
    );

    return false;
  }

  cleanupDedupe() {
    const cutoff =
      Date.now() -
      10 * 60 * 1000;

    for (
      const [
        key,
        timestamp
      ]
      of this.dedupe
    ) {
      if (
        timestamp <
        cutoff
      ) {
        this.dedupe.delete(
          key
        );
      }
    }
  }

  /* =======================================================
     STORAGE WRITE TEST
     Writes one isolated test row and immediately reads it back.
     This does NOT touch live trade aggregation or live symbols.
  ======================================================= */

  testStorageWrite() {
    const testSymbol =
      "STORAGETESTUSDT";

    const now =
      Date.now();

    const testHour =
      hourStartOf(
        now
      );

    this.ensureDBForWrite();

    const testBlock = {
      v: 1,

      symbol:
        testSymbol,

      hourStart:
        testHour,

      hourEnd:
        testHour +
        HOUR_MS,

      candles:
        new Map([
          [
            minuteStartOf(
              now
            ),
            {
              m:
                minuteStartOf(
                  now
                ),

              o: 1,
              h: 2,
              l: 1,
              c: 1.5,

              v: 1,
              t: 1.5,

              b: 1,
              s: 0.5,

              bv: 1,
              sv: 0.5,

              bt: 1,
              st: 1,

              ot: now,
              ct: now,

              levels:
                new Map([
                  [
                    1.5,
                    {
                      price: 1.5,

                      buyVolume:
                        1,

                      sellVolume:
                        0.5,

                      buyValue:
                        1,

                      sellValue:
                        0.5,

                      buyTrades:
                        1,

                      sellTrades:
                        1
                    }
                  ]
                ])
            }
          ]
        ]),

      dirty: true,

      loaded: false
    };

    const data =
      this.serializeBlock(
        testBlock
      );

    this.state.storage.sql.exec(
      `
      INSERT INTO ${TABLE_NAME}
      (symbol, hour_start, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol, hour_start)
      DO UPDATE SET
        data=excluded.data,
        updated_at=excluded.updated_at
      `,
      testSymbol,
      testHour,
      data,
      now
    );

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM ${TABLE_NAME}
          WHERE symbol = ?
            AND hour_start = ?
          LIMIT 1
          `,
          testSymbol,
          testHour
        )
        .toArray();

    const readBack =
      rows.length
        ? this.deserializeBlock(
            rows[0]
          )
        : null;

    const readBackCandle =
      readBack
        ? readBack.candles.get(
            minuteStartOf(
              now
            )
          )
        : null;

    const verified =
      Boolean(
        readBack &&
        readBack.symbol ===
          testSymbol &&
        readBack.hourStart ===
          testHour &&
        readBackCandle &&
        readBackCandle.c ===
          1.5
      );

    this.totalPersistedBlocks +=
      1;

    this.lastCheckpointAt =
      now;

    return {
      ok:
        verified,

      test:
        "STORAGE_WRITE_READBACK",

      database:
        "Durable Object SQLite",

      table:
        TABLE_NAME,

      write:
        true,

      readBack:
        verified,

      testSymbol,

      testHour,

      testHourISO:
        new Date(
          testHour
        ).toISOString(),

      rowCount:
        this.getRowCount(),

      persisted:
        verified,

      message:
        verified
          ? "Storage write and read-back verified successfully."
          : "Storage write/read-back verification failed.",

      version:
        VERSION
    };
  }

    const stats =
      tradeStats(
        trades
      );

    const footprint =
      aggregateFootprint(
        trades,
        tickSize
      );

    const orderbookData =
      orderbookStats(
        orderbook
      );

    const absorption =
      detectAbsorption(
        trades,
        candles,
        orderbookData
      );

    const closes =
      candles.map(
        candle =>
          candle.close
      );

    const technical = {
      sma20:
        sma(
          closes,
          20
        ),

      ema20:
        ema(
          closes,
          20
        ),

      rsi:
        rsi(
          closes,
          14
        ),

      macd:
        macd(
          closes
        ),

      atr:
        atr(
          candles,
          14
        ),

      bollinger:
        bollingerWidth(
          closes,
          20,
          2
        ),

      supportResistance:
        supportResistance(
          candles
        ),

      liquiditySweep:
        detectLiquiditySweep(
          candles
        ),

      divergence:
        detectDivergence(
          candles
        )
    };

    return {
      version:
        VERSION,

      symbol,

      interval,

      candles,

      trades,

      ticker,

      stats,

      footprint,

      orderbook:
        orderbookData,

      absorption,

      technical,

      instrument: {
        tickSize,

        minOrderQty:
          safeNumber(
            instrument
              ?.lotSizeFilter
              ?.minOrderQty,
            0
          )
      }
    };
}

/* =========================================================
   DURABLE OBJECT BINDINGS
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR_V5
  ) {
    throw new Error(
      "TRADE_COLLECTOR_V5 binding پیدا نشد"
    );
  }

  return env
    .TRADE_COLLECTOR_V5
    .idFromName(
      "absorption-storage-v5-global"
    );
}

function collectorStub(env) {
  return env
    .TRADE_COLLECTOR_V5
    .get(
      collectorId(env)
    );
}

/* =========================================================
   LEGACY TRADE COLLECTOR
========================================================= */

export class TradeCollector {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    return json({
      ok: true,

      legacy: true,

      collector:
        "TradeCollector",

      writeEnabled:
        false,

      message:
        "Legacy storage preserved. New writes disabled.",

      path:
        url.pathname,

      version:
        VERSION
    });
  }

  async alarm() {
    return;
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];

    this.symbolMeta =
      new Map();

    this.subscribed =
      new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;
    this.wsStartedAt = 0;

    this.lastError = "";

    this.reconnectAttempt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.alarmScheduled = false;

    this.dbInitialized = false;
    this.tableExists = null;

    this.hourBlocks =
      new Map();

    this.dedupe =
      new Map();

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks =
      false;

    this.checkpointRunning =
      false;

    this.lastCheckpointAt = 0;

    this.totalMessages = 0;
    this.totalTrades = 0;
    this.totalDuplicates = 0;
    this.totalInvalidTrades = 0;
    this.totalPersistedBlocks = 0;
    this.totalDeletedRows = 0;
  }

  /* =======================================================
     DATABASE
  ======================================================= */

  ensureDB() {
    if (
      this.dbInitialized
    ) {
      return;
    }

    this.state.storage.sql.exec(
      `
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, hour_start)
      )
      `
    );

    this.state.storage.sql.exec(
      `
      CREATE INDEX IF NOT EXISTS
      idx_${TABLE_NAME}_hour
      ON ${TABLE_NAME}(hour_start)
      `
    );

    this.dbInitialized = true;
    this.tableExists = true;
  }

  ensureDBForWrite() {
    this.ensureDB();
  }

  getRowCount() {
    this.ensureDB();

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT COUNT(*) AS count
          FROM ${TABLE_NAME}
          `
        )
        .toArray();

    return Number(
      rows?.[0]?.count || 0
    );
  }

  cleanupOldRows() {
    this.ensureDB();

    const count =
      this.getRowCount();

    if (
      count <= MAX_ROWS
    ) {
      return {
        before:
          count,

        deleted: 0,

        after:
          count
      };
    }

    const deleteCount =
      count -
      CLEANUP_TARGET_ROWS;

    if (
      deleteCount <= 0
    ) {
      return {
        before:
          count,

        deleted: 0,

        after:
          count
      };
    }

    this.state.storage.sql.exec(
      `
      DELETE FROM ${TABLE_NAME}
      WHERE rowid IN (
        SELECT rowid
        FROM ${TABLE_NAME}
        ORDER BY hour_start ASC
        LIMIT ?
      )
      `,
      deleteCount
    );

    const after =
      this.getRowCount();

    const deleted =
      Math.max(
        0,
        count - after
      );

    this.totalDeletedRows +=
      deleted;

    this.lastCleanupAt =
      Date.now();

    return {
      before:
        count,

      deleted,

      after
    };
  }

  /* =======================================================
     SERIALIZATION
  ======================================================= */

  serializeBlock(
    block
  ) {
    const candles = [];

    for (
      const candle
      of block.candles.values()
    ) {
      const levels = [];

      for (
        const level
        of candle.levels.values()
      ) {
        levels.push({
          price:
            level.price,

          buyVolume:
            level.buyVolume,

          sellVolume:
            level.sellVolume,

          buyValue:
            level.buyValue,

          sellValue:
            level.sellValue,

          buyTrades:
            level.buyTrades,

          sellTrades:
            level.sellTrades
        });
      }

      candles.push({
        m:
          candle.m,

        o:
          candle.o,

        h:
          candle.h,

        l:
          candle.l,

        c:
          candle.c,

        v:
          candle.v,

        t:
          candle.t,

        b:
          candle.b,

        s:
          candle.s,

        bv:
          candle.bv,

        sv:
          candle.sv,

        bt:
          candle.bt,

        st:
          candle.st,

        ot:
          candle.ot,

        ct:
          candle.ct,

        levels
      });
    }

    return JSON.stringify({
      v:
        block.v || 1,

      symbol:
        block.symbol,

      hourStart:
        block.hourStart,

      hourEnd:
        block.hourEnd,

      candles
    });
  }

  deserializeBlock(
    row
  ) {
    const raw =
      typeof row.data ===
      "string"
        ? row.data
        : String(
            row.data || ""
          );

    const parsed =
      JSON.parse(raw);

    const candles =
      new Map();

    for (
      const item
      of Array.isArray(
        parsed.candles
      )
        ? parsed.candles
        : []
    ) {
      const levels =
        new Map();

      for (
        const level
        of Array.isArray(
          item.levels
        )
          ? item.levels
          : []
      ) {
        levels.set(
          Number(
            level.price
          ),
          {
            price:
              safeNumber(
                level.price
              ),

            buyVolume:
              safeNumber(
                level.buyVolume
              ),

            sellVolume:
              safeNumber(
                level.sellVolume
              ),

            buyValue:
              safeNumber(
                level.buyValue
              ),

            sellValue:
              safeNumber(
                level.sellValue
              ),

            buyTrades:
              safeNumber(
                level.buyTrades
              ),

            sellTrades:
              safeNumber(
                level.sellTrades
              )
          }
        );
      }

      const candle = {
        m:
          safeNumber(
            item.m
          ),

        o:
          safeNumber(
            item.o
          ),

        h:
          safeNumber(
            item.h
          ),

        l:
          safeNumber(
            item.l
          ),

        c:
          safeNumber(
            item.c
          ),

        v:
          safeNumber(
            item.v
          ),

        t:
          safeNumber(
            item.t
          ),

        b:
          safeNumber(
            item.b
          ),

        s:
          safeNumber(
            item.s
          ),

        bv:
          safeNumber(
            item.bv
          ),

        sv:
          safeNumber(
            item.sv
          ),

        bt:
          safeNumber(
            item.bt
          ),

        st:
          safeNumber(
            item.st
          ),

        ot:
          safeNumber(
            item.ot
          ),

        ct:
          safeNumber(
            item.ct
          ),

        levels
      };

      candles.set(
        candle.m,
        candle
      );
    }

    return {
      v:
        safeNumber(
          parsed.v,
          1
        ),

      symbol:
        parsed.symbol ||
        row.symbol,

      hourStart:
        safeNumber(
          parsed.hourStart,
          row.hour_start
        ),

      hourEnd:
        safeNumber(
          parsed.hourEnd
        ),

      candles,

      dirty: false,

      loaded: true
    };
  }

  /* =======================================================
     BLOCK CREATION
  ======================================================= */

  createHourBlock(
    symbol,
    hourStart
  ) {
    return {
      v: 1,

      symbol,

      hourStart,

      hourEnd:
        hourStart +
        HOUR_MS,

      candles:
        new Map(),

      dirty: false,

      loaded: false
    };
  }

  getOrCreateHourBlock(
    symbol,
    hourStart
  ) {
    const key =
      `${symbol}:${hourStart}`;

    let block =
      this.hourBlocks.get(
        key
      );

    if (!block) {
      block =
        this.createHourBlock(
          symbol,
          hourStart
        );

      this.hourBlocks.set(
        key,
        block
      );
    }

    return block;
  }

  getOrCreateCandle(
    block,
    minute
  ) {
    let candle =
      block.candles.get(
        minute
      );

    if (!candle) {
      candle = {
        m:
          minute,

        o: 0,
        h: 0,
        l: 0,
        c: 0,

        v: 0,
        t: 0,

        b: 0,
        s: 0,

        bv: 0,
        sv: 0,

        bt: 0,
        st: 0,

        ot: 0,
        ct: 0,

        levels:
          new Map()
      };

      block.candles.set(
        minute,
        candle
      );
    }

    return candle;
  }

  /* =======================================================
     TRADE APPLY
  ======================================================= */

  applyTrade(
    symbol,
    trade
  ) {
    const time =
      safeNumber(
        trade.time
      );

    const price =
      safeNumber(
        trade.price
      );

    const size =
      safeNumber(
        trade.size
      );

    if (
      !time ||
      price <= 0 ||
      size <= 0
    ) {
      this.totalInvalidTrades++;
      return false;
    }

    const hour =
      hourStartOf(
        time
      );

    const minute =
      minuteStartOf(
        time
      );

    const block =
      this.getOrCreateHourBlock(
        symbol,
        hour
      );

    const candle =
      this.getOrCreateCandle(
        block,
        minute
      );

    if (
      !candle.ot ||
      time < candle.ot
    ) {
      candle.ot =
        time;
    }

    if (
      !candle.ct ||
      time > candle.ct
    ) {
      candle.ct =
        time;
    }

    if (
      candle.o === 0
    ) {
      candle.o =
        price;
    }

    if (
      candle.h === 0 ||
      price >
        candle.h
    ) {
      candle.h =
        price;
    }

    if (
      candle.l === 0 ||
      price <
        candle.l
    ) {
      candle.l =
        price;
    }

    candle.c =
      price;

    candle.v +=
      size;

    candle.t +=
      price * size;

    const levelPrice =
      roundToTick(
        price,
        this.symbolMeta
          .get(symbol)
          ?.tickSize || 0
      );

    let level =
      candle.levels.get(
        levelPrice
      );

    if (!level) {
      level = {
        price:
          levelPrice,

        buyVolume: 0,
        sellVolume: 0,

        buyValue: 0,
        sellValue: 0,

        buyTrades: 0,
        sellTrades: 0
      };

      candle.levels.set(
        levelPrice,
        level
      );
    }

    if (
      trade.side ===
      "BUY"
    ) {
      candle.b +=
        size;

      candle.bv +=
        size;

      candle.bt +=
        1;

      level.buyVolume +=
        size;

      level.buyValue +=
        price * size;

      level.buyTrades++;
    } else if (
      trade.side ===
      "SELL"
    ) {
      candle.s +=
        size;

      candle.sv +=
        size;

      candle.st +=
        1;

      level.sellVolume +=
        size;

      level.sellValue +=
        price * size;

      level.sellTrades++;
    }

    block.dirty =
      true;

    return true;
  }

  /* =======================================================
     DEDUPE
  ======================================================= */

  isDuplicate(
    symbol,
    trade
  ) {
    const id =
      String(
        trade.id ||
        `${symbol}-${trade.time}-${trade.price}-${trade.size}-${trade.side}`
      );

    const key =
      `${symbol}:${id}`;

    if (
      this.dedupe.has(key)
    ) {
      this.totalDuplicates++;
      return true;
    }

    this.dedupe.set(
      key,
      Date.now()
    );

    return false;
  }

  cleanupDedupe() {
    const cutoff =
      Date.now() -
      10 * 60 * 1000;

    for (
      const [
        key,
        timestamp
      ]
      of this.dedupe
    ) {
      if (
        timestamp <
        cutoff
      ) {
        this.dedupe.delete(
          key
        );
      }
    }
  }

  /* =======================================================
     STORAGE WRITE TEST
     Writes one isolated test row and immediately reads it back.
     This does NOT touch live trade aggregation or live symbols.
  ======================================================= */

  testStorageWrite() {
    const testSymbol =
      "STORAGETESTUSDT";

    const now =
      Date.now();

    const testHour =
      hourStartOf(
        now
      );

    this.ensureDBForWrite();

    const testBlock = {
      v: 1,

      symbol:
        testSymbol,

      hourStart:
        testHour,

      hourEnd:
        testHour +
        HOUR_MS,

      candles:
        new Map([
          [
            minuteStartOf(
              now
            ),
            {
              m:
                minuteStartOf(
                  now
                ),

              o: 1,
              h: 2,
              l: 1,
              c: 1.5,

              v: 1,
              t: 1.5,

              b: 1,
              s: 0.5,

              bv: 1,
              sv: 0.5,

              bt: 1,
              st: 1,

              ot: now,
              ct: now,

              levels:
                new Map([
                  [
                    1.5,
                    {
                      price: 1.5,

                      buyVolume:
                        1,

                      sellVolume:
                        0.5,

                      buyValue:
                        1,

                      sellValue:
                        0.5,

                      buyTrades:
                        1,

                      sellTrades:
                        1
                    }
                  ]
                ])
            }
          ]
        ]),

      dirty: true,

      loaded: false
    };

    const data =
      this.serializeBlock(
        testBlock
      );

    this.state.storage.sql.exec(
      `
      INSERT INTO ${TABLE_NAME}
      (symbol, hour_start, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol, hour_start)
      DO UPDATE SET
        data=excluded.data,
        updated_at=excluded.updated_at
      `,
      testSymbol,
      testHour,
      data,
      now
    );

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM ${TABLE_NAME}
          WHERE symbol = ?
            AND hour_start = ?
          LIMIT 1
          `,
          testSymbol,
          testHour
        )
        .toArray();

    const readBack =
      rows.length
        ? this.deserializeBlock(
            rows[0]
          )
        : null;

    const readBackCandle =
      readBack
        ? readBack.candles.get(
            minuteStartOf(
              now
            )
          )
        : null;

    const verified =
      Boolean(
        readBack &&
        readBack.symbol ===
          testSymbol &&
        readBack.hourStart ===
          testHour &&
        readBackCandle &&
        readBackCandle.c ===
          1.5
      );

    this.totalPersistedBlocks +=
      1;

    this.lastCheckpointAt =
      now;

    return {
      ok:
        verified,

      test:
        "STORAGE_WRITE_READBACK",

      database:
        "Durable Object SQLite",

      table:
        TABLE_NAME,

      write:
        true,

      readBack:
        verified,

      testSymbol,

      testHour,

      testHourISO:
        new Date(
          testHour
        ).toISOString(),

      rowCount:
        this.getRowCount(),

      persisted:
        verified,

      message:
        verified
          ? "Storage write and read-back verified successfully."
          : "Storage write/read-back verification failed.",

      version:
        VERSION
    };
  }

/* =======================================================
   LOAD RECENT BLOCKS
======================================================= */

  loadRecentBlocks() {
    this.ensureDB();

    if (
      this.loadedRecentBlocks
    ) {
      return;
    }

    const currentHour =
      hourStartOf(
        Date.now()
      );

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM ${TABLE_NAME}
          WHERE hour_start >= ?
          ORDER BY
            hour_start DESC
          LIMIT ?
          `,
          currentHour -
            (
              24 *
              HOUR_MS
            ),
          MAX_ROWS
        )
        .toArray();

    for (
      const row
      of rows
    ) {
      try {
        const block =
          this.deserializeBlock(
            row
          );

        const key =
          `${block.symbol}:${block.hourStart}`;

        this.hourBlocks.set(
          key,
          block
        );
      } catch (error) {
        console.error(
          "deserialize block error",
          error
        );
      }
    }

    this.loadedRecentBlocks =
      true;
  }

  /* =======================================================
     PERSIST CLOSED BLOCKS
  ======================================================= */

  persistClosedBlocks() {
    this.ensureDB();

    if (
      this.checkpointRunning
    ) {
      return {
        ok: false,
        skipped: true,
        reason:
          "checkpoint already running"
      };
    }

    this.checkpointRunning =
      true;

    try {
      const currentHour =
        hourStartOf(
          Date.now()
        );

      let persisted = 0;

      for (
        const [
          key,
          block
        ]
        of this.hourBlocks
      ) {
        if (
          !block ||
          !block.dirty
        ) {
          continue;
        }

        if (
          block.hourStart >=
          currentHour
        ) {
          continue;
        }

        const data =
          this.serializeBlock(
            block
          );

        this.state.storage.sql.exec(
          `
          INSERT INTO ${TABLE_NAME}
          (
            symbol,
            hour_start,
            data,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(symbol, hour_start)
          DO UPDATE SET
            data=excluded.data,
            updated_at=excluded.updated_at
          `,
          block.symbol,
          block.hourStart,
          data,
          Date.now()
        );

        block.dirty =
          false;

        block.loaded =
          true;

        persisted++;
      }

      if (
        persisted > 0
      ) {
        this.totalPersistedBlocks +=
          persisted;
      }

      const cleanup =
        this.cleanupOldRows();

      this.lastCheckpointAt =
        Date.now();

      return {
        ok: true,

        persisted,

        cleanup,

        rowCount:
          this.getRowCount(),

        timestamp:
          this.lastCheckpointAt
      };
    } finally {
      this.checkpointRunning =
        false;
    }
  }

  /* =======================================================
     DROP OLD RAM BLOCKS
  ======================================================= */

  dropOldRamBlocks() {
    const currentHour =
      hourStartOf(
        Date.now()
      );

    const keepFrom =
      currentHour -
      (
        3 *
        HOUR_MS
      );

    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (
        block.hourStart <
        keepFrom
      ) {
        if (
          block.dirty
        ) {
          continue;
        }

        this.hourBlocks.delete(
          key
        );
      }
    }
  }

  /* =======================================================
     SUBSCRIBE SYMBOLS
  ======================================================= */

  buildTradeSubscriptions(
    symbols
  ) {
    return symbols.map(
      symbol => ({
        op:
          "subscribe",

        args: [
          `publicTrade.${symbol}`
        ]
      })
    );
  }

  async connectWebSocket() {
    if (
      this.ws
    ) {
      try {
        this.ws.close();
      } catch (_) {}
    }

    this.connected =
      false;

    this.wsStartedAt =
      Date.now();

    this.lastError =
      "";

    const ws =
      new WebSocket(
        BYBIT_WS
      );

    this.ws =
      ws;

    ws.addEventListener(
      "open",
      () => {
        this.connected =
          true;

        this.reconnectAttempt =
          0;

        this.lastMessageAt =
          Date.now();

        this.subscribeAll();

        this.startPing();

        this.scheduleAlarm();
      }
    );

    ws.addEventListener(
      "message",
      event => {
        this.handleWebSocketMessage(
          event.data
        );
      }
    );

    ws.addEventListener(
      "error",
      event => {
        this.lastError =
          "WebSocket error";

        console.error(
          "WebSocket error",
          event
        );
      }
    );

    ws.addEventListener(
      "close",
      () => {
        this.connected =
          false;

        this.stopPing();

        this.scheduleReconnect();
      }
    );
  }

  subscribeAll() {
    if (
      !this.ws ||
      !this.connected
    ) {
      return;
    }

    const args =
      this.symbols.map(
        symbol =>
          `publicTrade.${symbol}`
      );

    if (!args.length) {
      return;
    }

    try {
      this.ws.send(
        JSON.stringify({
          op:
            "subscribe",

          args
        })
      );

      this.subscribed =
        new Set(
          this.symbols
        );
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }
  }

  startPing() {
    this.stopPing();

    this.pingTimer =
      setInterval(
        () => {
          if (
            !this.ws ||
            !this.connected
          ) {
            return;
          }

          try {
            this.ws.send(
              JSON.stringify({
                op:
                  "ping"
              })
            );
          } catch (_) {}
        },
        20000
      );
  }

  stopPing() {
    if (
      this.pingTimer
    ) {
      clearInterval(
        this.pingTimer
      );

      this.pingTimer =
        null;
    }
  }

  scheduleReconnect() {
    if (
      this.reconnectTimer
    ) {
      return;
    }

    this.reconnectAttempt++;

    const delay =
      Math.min(
        60000,
        1000 *
          Math.pow(
            2,
            Math.min(
              this.reconnectAttempt,
              6
            )
          )
      );

    this.reconnectTimer =
      setTimeout(
        async () => {
          this.reconnectTimer =
            null;

          try {
            await this.connectWebSocket();
          } catch (error) {
            this.lastError =
              String(
                error?.message ||
                error
              );

            this.scheduleReconnect();
          }
        },
        delay
      );
  }

  /* =======================================================
     WEBSOCKET MESSAGE
  ======================================================= */

  handleWebSocketMessage(
    raw
  ) {
    this.lastMessageAt =
      Date.now();

    this.totalMessages++;

    let message;

    try {
      message =
        typeof raw ===
        "string"
          ? JSON.parse(raw)
          : raw;
    } catch (error) {
      this.lastError =
        "Invalid WebSocket JSON";

      return;
    }

    if (
      message?.op ===
        "pong" ||
      message?.ret_msg ===
        "pong"
    ) {
      return;
    }

    const topic =
      String(
        message?.topic ||
        ""
      );

    if (
      !topic.startsWith(
        "publicTrade."
      )
    ) {
      return;
    }

    const symbol =
      normalizeSymbol(
        topic.replace(
          "publicTrade.",
          ""
        )
      );

    const list =
      Array.isArray(
        message?.data
      )
        ? message.data
        : [];

    for (
      const item
      of list
    ) {
      const trade =
        this.normalizeWsTrade(
          item
        );

      if (!trade) {
        this.totalInvalidTrades++;
        continue;
      }

      if (
        this.isDuplicate(
          symbol,
          trade
        )
      ) {
        continue;
      }

      if (
        this.applyTrade(
          symbol,
          trade
        )
      ) {
        this.totalTrades++;

        this.lastTradeAt =
          trade.time;
      }
    }

    this.cleanupDedupe();
  }

  normalizeWsTrade(
    item
  ) {
    if (!item) {
      return null;
    }

    const price =
      safeNumber(
        item.p
      );

    const size =
      safeNumber(
        item.v
      );

    const time =
      safeNumber(
        item.T
      );

    const side =
      String(
        item.S ||
        ""
      )
        .trim()
        .toUpperCase();

    if (
      !price ||
      !size ||
      !time ||
      (
        side !==
          "BUY" &&
        side !==
          "SELL"
      )
    ) {
      return null;
    }

    return {
      id:
        String(
          item.i ||
          `${time}-${price}-${size}-${side}`
        ),

      time,

      price,

      size,

      value:
        price * size,

      side
    };
  }

  /* =======================================================
     SYMBOL MANAGEMENT
  ======================================================= */

  setSymbols(
    symbols
  ) {
    const unique =
      new Set();

    for (
      const value
      of Array.isArray(
        symbols
      )
        ? symbols
        : []
    ) {
      const symbol =
        normalizeSymbol(
          value
        );

      if (
        symbol &&
        symbol.endsWith(
          "USDT"
        )
      ) {
        unique.add(
          symbol
        );
      }
    }

    this.symbols =
      [
        ...unique
      ];

    if (
      this.connected
    ) {
      this.subscribeAll();
    }
  }

  async refreshSymbols() {
    const rows =
      await getBybitSymbols();

    this.symbolMeta =
      new Map(
        rows.map(
          row => [
            row.symbol,
            row
          ]
        )
      );

    this.setSymbols(
      rows.map(
        row =>
          row.symbol
      )
    );

    return rows;
  }

  /* =======================================================
     START COLLECTOR
  ======================================================= */

  async start() {
    if (
      this.started
    ) {
      return {
        ok: true,
        alreadyStarted:
          true
      };
    }

    this.started =
      true;

    this.ensureDB();

    this.loadRecentBlocks();

    try {
      await this.refreshSymbols();
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }

    try {
      await this.connectWebSocket();
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      this.scheduleReconnect();
    }

    this.scheduleAlarm();

    return {
      ok: true,

      started:
        true,

      symbols:
        this.symbols.length,

      rowCount:
        this.getRowCount()
    };
  }

  /* =======================================================
     ALARM
  ======================================================= */

  scheduleAlarm() {
    if (
      this.alarmScheduled
    ) {
      return;
    }

    this.alarmScheduled =
      true;

    try {
      this.state.storage.setAlarm(
        Date.now() +
          ALARM_MS
      );
    } catch (error) {
      this.alarmScheduled =
        false;

      this.lastError =
        String(
          error?.message ||
          error
        );
    }
  }

  async alarm() {
    this.alarmScheduled =
      false;

    try {
      this.persistClosedBlocks();
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      console.error(
        "checkpoint error",
        error
      );
    }

    this.dropOldRamBlocks();

    if (
      !this.connected
    ) {
      try {
        await this.connectWebSocket();
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );

        this.scheduleReconnect();
      }
    }

    this.scheduleAlarm();
  }

  /* =======================================================
     STATUS
  ======================================================= */

  getStatus() {
    const now =
      Date.now();

    const currentHour =
      hourStartOf(
        now
      );

    let ramBlocks = 0;
    let dirtyBlocks = 0;

    let currentHourBlocks = 0;

    for (
      const block
      of this.hourBlocks.values()
    ) {
      ramBlocks++;

      if (
        block.dirty
      ) {
        dirtyBlocks++;
      }

      if (
        block.hourStart ===
        currentHour
      ) {
        currentHourBlocks++;
      }
    }

    let currentHourProtected =
      false;

    for (
      const block
      of this.hourBlocks.values()
    ) {
      if (
        block.hourStart ===
          currentHour &&
        block.dirty
      ) {
        currentHourProtected =
          true;

        break;
      }
    }

    return {
      ok: true,

      version:
        VERSION,

      collector:
        "AbsorptionStorageV5",

      started:
        this.started,

      connected:
        this.connected,

      websocket:
        Boolean(
          this.ws
        ),

      symbols:
        this.symbols.length,

      subscribed:
        this.subscribed.size,

      lastMessageAt:
        this.lastMessageAt,

      lastMessageAgeMs:
        this.lastMessageAt
          ? now -
            this.lastMessageAt
          : null,

      lastTradeAt:
        this.lastTradeAt,

      lastTradeAgeMs:
        this.lastTradeAt
          ? now -
            this.lastTradeAt
          : null,

      wsStartedAt:
        this.wsStartedAt,

      reconnectAttempt:
        this.reconnectAttempt,

      lastError:
        this.lastError,

      messages:
        this.totalMessages,

      trades:
        this.totalTrades,

      duplicates:
        this.totalDuplicates,

      invalidTrades:
        this.totalInvalidTrades,

      persistedBlocks:
        this.totalPersistedBlocks,

      deletedRows:
        this.totalDeletedRows,

      database:
        {
          initialized:
            this.dbInitialized,

          tableExists:
            this.tableExists,

          table:
            TABLE_NAME,

          rowCount:
            this.getRowCount(),

          maxRows:
            MAX_ROWS,

          cleanupTarget:
            CLEANUP_TARGET_ROWS,

          storage:
            "Durable Object SQLite",

          storageName:
            "AbsorptionStorageV5",

          storageModel:
            "1 row = 1 symbol + 1 hour",

          checkpoint:
            "closed hour only",

          currentHour:
            "RAM only until hour closes",

          history:
            "rolling 20000 hour blocks",

          currentHourProtected,

          oldStorage:
            "preserved / new writes disabled",

          writePolicy:
            "no startup DB write; closed hour only"
        },

      ram:
        {
          blocks:
            ramBlocks,

          dirtyBlocks,

          currentHourBlocks,

          currentHour,

          currentHourISO:
            new Date(
              currentHour
            ).toISOString()
        }
    };
  }

  /* =======================================================
     HISTORY
  ======================================================= */

  getHistory(
    symbol,
    limit = 200
  ) {
    this.ensureDB();

    const normalized =
      symbol
        ? normalizeSymbol(
            symbol
          )
        : null;

    const safeLimit =
      Math.min(
        1000,
        Math.max(
          1,
          Number(limit) || 200
        )
      );

    let rows;

    if (normalized) {
      rows =
        this.state.storage.sql
          .exec(
            `
            SELECT
              symbol,
              hour_start,
              data,
              updated_at
            FROM ${TABLE_NAME}
            WHERE symbol = ?
            ORDER BY
              hour_start DESC
            LIMIT ?
            `,
            normalized,
            safeLimit
          )
          .toArray();
    } else {
      rows =
        this.state.storage.sql
          .exec(
            `
            SELECT
              symbol,
              hour_start,
              data,
              updated_at
            FROM ${TABLE_NAME}
            ORDER BY
              hour_start DESC
            LIMIT ?
            `,
            safeLimit
          )
          .toArray();
    }

    return rows.map(
      row => {
        let block = null;

        try {
          block =
            this.deserializeBlock(
              row
            );
        } catch (_) {}

        return {
          symbol:
            row.symbol,

          hourStart:
            Number(
              row.hour_start
            ),

          hourStartISO:
            new Date(
              Number(
                row.hour_start
              )
            ).toISOString(),

          updatedAt:
            Number(
              row.updated_at
            ),

          candleCount:
            block
              ? block.candles.size
              : null,

          data:
            block
              ? block
              : null
        };
      }
    );
  }

  /* =======================================================
     CURRENT HOUR
  ======================================================= */

  getCurrentHour(
    symbol
  ) {
    const normalized =
      normalizeSymbol(
        symbol
      );

    const hour =
      hourStartOf(
        Date.now()
      );

    const key =
      `${normalized}:${hour}`;

    const block =
      this.hourBlocks.get(
        key
      );

    if (!block) {
      return {
        ok: true,

        exists: false,

        symbol:
          normalized,

        hourStart:
          hour,

        hourStartISO:
          new Date(
            hour
          ).toISOString(),

        protected:
          true
      };
    }

    return {
      ok: true,

      exists: true,

      symbol:
        normalized,

      hourStart:
        hour,

      hourStartISO:
        new Date(
          hour
        ).toISOString(),

      protected:
        true,

      dirty:
        Boolean(
          block.dirty
        ),

      candleCount:
        block.candles.size,

      data:
        block
    };
  }
    const estimated20KRaw =
      estimatedHourRaw *
      MAX_ROWS;

    const estimated20KGzip =
      estimatedHourGzip === null
        ? null
        : estimatedHourGzip *
          MAX_ROWS;

    /*
     * Also calculate average size
     * of one minute from grouped data.
     */
    let groupedRawTotal = 0;
    let groupedGzipTotal = 0;
    let groupedGzipAvailable = true;

    let minRaw =
      Number.POSITIVE_INFINITY;

    let maxRaw = 0;

    let minGzip =
      Number.POSITIVE_INFINITY;

    let maxGzip = 0;

    for (const item of minuteTests) {
      groupedRawTotal +=
        item.rawBytes;

      if (
        Number.isFinite(
          item.gzipBytes
        )
      ) {
        groupedGzipTotal +=
          item.gzipBytes;

        minGzip =
          Math.min(
            minGzip,
            item.gzipBytes
          );

        maxGzip =
          Math.max(
            maxGzip,
            item.gzipBytes
          );
      } else {
        groupedGzipAvailable =
          false;
      }

      minRaw =
        Math.min(
          minRaw,
          item.rawBytes
        );

      maxRaw =
        Math.max(
          maxRaw,
          item.rawBytes
        );
    }

    const averageGroupedRaw =
      coveredMinutes > 0
        ? groupedRawTotal /
          coveredMinutes
        : 0;

    const averageGroupedGzip =
      coveredMinutes > 0 &&
      groupedGzipAvailable
        ? groupedGzipTotal /
          coveredMinutes
        : null;

    return {
      ok: true,

      test:
        "VOLUME_TEST",

      version:
        VERSION,

      symbol,

      source:
        "Bybit Linear Futures publicTrade",

      databaseWrite:
        false,

      databaseModified:
        false,

      compression:
        "GZIP lossless",

      compressionAvailable:
        gzipTradeBytes !== null,

      sample: {
        trades:
          totalTrades,

        firstTradeTime,

        firstTradeISO:
          new Date(
            firstTradeTime
          ).toISOString(),

        lastTradeTime,

        lastTradeISO:
          new Date(
            lastTradeTime
          ).toISOString(),

        elapsedDataMinutes,

        coveredMinutes
      },

      rawSample: {
        bytes:
          rawTradeBytes,

        KB:
          bytesToKB(
            rawTradeBytes
          ),

        MB:
          bytesToMB(
            rawTradeBytes
          )
      },

      gzipSample:
        compressionInfo(
          rawTradeBytes,
          gzipTradeBytes
        ),

      minute: {
        averageRawBytes:
          Math.round(
            averageRawPerMinute
          ),

        averageRawKB:
          bytesToKB(
            averageRawPerMinute
          ),

        averageRawMB:
          bytesToMB(
            averageRawPerMinute
          ),

        averageGzipBytes:
          averageGzipPerMinute === null
            ? null
            : Math.round(
                averageGzipPerMinute
              ),

        averageGzipKB:
          averageGzipPerMinute === null
            ? null
            : bytesToKB(
                averageGzipPerMinute
              ),

        averageGzipMB:
          averageGzipPerMinute === null
            ? null
            : bytesToMB(
                averageGzipPerMinute
              )
      },

      groupedMinuteStats: {
        averageRawBytes:
          Math.round(
            averageGroupedRaw
          ),

        averageRawKB:
          bytesToKB(
            averageGroupedRaw
          ),

        averageGzipBytes:
          averageGroupedGzip === null
            ? null
            : Math.round(
                averageGroupedGzip
              ),

        averageGzipKB:
          averageGroupedGzip === null
            ? null
            : bytesToKB(
                averageGroupedGzip
              ),

        minimumRawBytes:
          Number.isFinite(
            minRaw
          )
            ? minRaw
            : 0,

        maximumRawBytes:
          maxRaw,

        minimumGzipBytes:
          groupedGzipAvailable &&
          Number.isFinite(
            minGzip
          )
            ? minGzip
            : null,

        maximumGzipBytes:
          groupedGzipAvailable
            ? maxGzip
            : null
      },

      estimatedHour: {
        rawBytes:
          Math.round(
            estimatedHourRaw
          ),

        rawKB:
          bytesToKB(
            estimatedHourRaw
          ),

        rawMB:
          bytesToMB(
            estimatedHourRaw
          ),

        gzipBytes:
          estimatedHourGzip === null
            ? null
            : Math.round(
                estimatedHourGzip
              ),

        gzipKB:
          estimatedHourGzip === null
            ? null
            : bytesToKB(
                estimatedHourGzip
              ),

        gzipMB:
          estimatedHourGzip === null
            ? null
            : bytesToMB(
                estimatedHourGzip
              )
      },

      estimatedStorage: {
        model:
          "1 symbol + 1 hour = 1 row",

        maxRows:
          MAX_ROWS,

        rawBytes:
          Math.round(
            estimated20KRaw
          ),

        rawMB:
          bytesToMB(
            estimated20KRaw
          ),

        rawGB:
          bytesToGB(
            estimated20KRaw
          ),

        gzipBytes:
          estimated20KGzip === null
            ? null
            : Math.round(
                estimated20KGzip
              ),

        gzipMB:
          estimated20KGzip === null
            ? null
            : bytesToMB(
                estimated20KGzip
              ),

        gzipGB:
          estimated20KGzip === null
            ? null
            : bytesToGB(
                estimated20KGzip
              )
      },

      minuteTests,

      elapsedMs:
        Date.now() -
        startedAt,

      note:
        "This endpoint only measures data size. It never writes to Durable Object SQLite."
    };
  }

/* =========================================================
   ON-DEMAND MARKET DATA
========================================================= */

async function getMarket(
  symbol,
  interval
) {
  symbol =
    normalizeSymbol(symbol);

  interval =
    normalizeInterval(interval);

  const [
    klineResult,
    tickerResult,
    orderbookResult,
    tradeResult,
    instrumentResult
  ] = await Promise.all([
    bybit(
      "/v5/market/kline",
      {
        category:
          "linear",

        symbol,

        interval,

        limit:
          KLINE_LIMIT
      }
    ),

    bybit(
      "/v5/market/tickers",
      {
        category:
          "linear",

        symbol
      }
    ),

    bybit(
      "/v5/market/orderbook",
      {
        category:
          "linear",

        symbol,

        limit:
          ORDERBOOK_LIMIT
      }
    ),

    bybit(
      "/v5/market/recent-trade",
      {
        category:
          "linear",

        symbol,

        limit:
          TRADE_LIMIT
      }
    ),

    bybit(
      "/v5/market/instruments-info",
      {
        category:
          "linear",

        symbol
      }
    )
  ]);

  const candles =
    parseKlines(
      klineResult?.list
    );

  const trades =
    parseTrades(
      tradeResult?.list
    );

  const ticker =
    Array.isArray(
      tickerResult?.list
    )
      ? tickerResult.list[0]
      : null;

  const instrument =
    Array.isArray(
      instrumentResult?.list
    )
      ? instrumentResult.list[0]
      : null;

  const tickSize =
    safeNumber(
      instrument
        ?.priceFilter
        ?.tickSize,
      0
    );

  const stats =
    tradeStats(
      trades
    );

  const footprint =
    aggregateFootprint(
      trades,
      tickSize
    );

  const orderbook =
    orderbookStats(
      orderbookResult
    );

  const absorption =
    detectAbsorption(
      trades,
      candles,
      orderbook
    );

  return {
    version:
      VERSION,

    symbol,

    interval,

    candles,

    trades,

    ticker,

    stats,

    footprint,

    orderbook,

    absorption,

    instrument: {
      tickSize,

      minOrderQty:
        safeNumber(
          instrument
            ?.lotSizeFilter
            ?.minOrderQty,
          0
        )
    }
  };
}

/* =========================================================
   DURABLE OBJECT BINDINGS
========================================================= */

function collectorId(env) {
  if (
    !env ||
    !env.TRADE_COLLECTOR_V5
  ) {
    throw new Error(
      "TRADE_COLLECTOR_V5 binding پیدا نشد"
    );
  }

  return env
    .TRADE_COLLECTOR_V5
    .idFromName(
      "absorption-storage-v5-global"
    );
}

function collectorStub(env) {
  return env
    .TRADE_COLLECTOR_V5
    .get(
      collectorId(env)
    );
}

/* =========================================================
   LEGACY TRADE COLLECTOR
========================================================= */

export class TradeCollector {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    return json({
      ok: true,

      legacy: true,

      collector:
        "TradeCollector",

      writeEnabled:
        false,

      message:
        "Legacy storage preserved. New writes disabled.",

      path:
        url.pathname,

      version:
        VERSION
    });
  }

  async alarm() {
    return;
  }
}

/* =========================================================
   ABSORPTION STORAGE V5
========================================================= */

export class AbsorptionStorageV5 {
  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.ws = null;

    this.started = false;
    this.connected = false;

    this.symbols = [];

    this.symbolMeta =
      new Map();

    this.subscribed =
      new Set();

    this.lastMessageAt = 0;
    this.lastTradeAt = 0;
    this.wsStartedAt = 0;

    this.lastError = "";

    this.reconnectAttempt = 0;

    this.reconnectTimer = null;
    this.pingTimer = null;

    this.alarmScheduled = false;

    this.dbInitialized = false;
    this.tableExists = null;

    this.hourBlocks =
      new Map();

    this.dedupe =
      new Map();

    this.lastCleanupAt = 0;

    this.loadedRecentBlocks =
      false;

    this.checkpointRunning =
      false;

    this.lastCheckpointAt = 0;

    this.totalMessages = 0;
    this.totalTrades = 0;
    this.totalDuplicates = 0;
    this.totalInvalidTrades = 0;
    this.totalPersistedBlocks = 0;
    this.totalDeletedRows = 0;
  }

  /* =======================================================
     DATABASE DETECTION
  ======================================================= */

  initDB() {
    if (
      this.dbInitialized
    ) {
      return;
    }

    const sql =
      this.state.storage.sql;

    try {
      const rows =
        sql
          .exec(
            `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            AND name = ?
            LIMIT 1
            `,
            TABLE_NAME
          )
          .toArray();

      this.tableExists =
        rows.length > 0;
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      this.tableExists =
        false;
    }

    this.dbInitialized =
      true;
  }

  /* =======================================================
     CREATE STORAGE ONLY ON REAL CHECKPOINT
  ======================================================= */

  ensureDBForWrite() {
    if (
      this.tableExists === true
    ) {
      return;
    }

    const sql =
      this.state.storage.sql;

    sql.exec(
      `
      CREATE TABLE IF NOT EXISTS hour_blocks_v5 (
        symbol TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, hour_start)
      )
      `
    );

    this.tableExists =
      true;

    this.dbInitialized =
      true;
  }

  /* =======================================================
     ROW COUNT
  ======================================================= */

  getRowCount() {
    this.initDB();

    if (
      this.tableExists !== true
    ) {
      return 0;
    }

    try {
      const rows =
        this.state.storage.sql
          .exec(
            `
            SELECT COUNT(*) AS count
            FROM hour_blocks_v5
            `
          )
          .toArray();

      return Number(
        rows[0]?.count || 0
      );
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      return 0;
    }
  }

  /* =======================================================
     CAPACITY
  ======================================================= */

  enforceCapacity() {
    this.initDB();

    if (
      this.tableExists !== true
    ) {
      return {
        deleted: 0,
        rows: 0,
        tableExists: false,
        protectedCurrentHour: true
      };
    }

    const count =
      this.getRowCount();

    if (
      count < MAX_ROWS
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    const target =
      Math.max(
        0,
        Math.min(
          CLEANUP_TARGET_ROWS,
          MAX_ROWS - 1
        )
      );

    const deleteCount =
      Math.max(
        0,
        count - target
      );

    if (
      deleteCount <= 0
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    const currentHour =
      hourStartOf(
        Date.now()
      );

    const availableRows =
      this.state.storage.sql
        .exec(
          `
          SELECT COUNT(*) AS count
          FROM hour_blocks_v5
          WHERE hour_start < ?
          `,
          currentHour
        )
        .toArray();

    const deletable =
      Number(
        availableRows[0]?.count ||
        0
      );

    const actualDelete =
      Math.min(
        deleteCount,
        deletable
      );

    if (
      actualDelete <= 0
    ) {
      return {
        deleted: 0,
        rows: count,
        protectedCurrentHour: true
      };
    }

    this.state.storage.sql.exec(
      `
      DELETE FROM hour_blocks_v5
      WHERE rowid IN (
        SELECT rowid
        FROM hour_blocks_v5
        WHERE hour_start < ?
        ORDER BY hour_start ASC, rowid ASC
        LIMIT ${actualDelete}
      )
      `,
      currentHour
    );

    this.totalDeletedRows +=
      actualDelete;

    this.lastCleanupAt =
      Date.now();

    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (

  sellShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  const bestBid =
    bids.length
      ? safeNumber(
          bids[0][0]
        )
      : 0;

  const bestAsk =
    asks.length
      ? safeNumber(
          asks[0][0]
        )
      : 0;

  const spread =
    bestBid > 0 &&
    bestAsk > 0
      ? bestAsk - bestBid
      : 0;

  const spreadPercent =
    bestBid > 0
      ? (
          spread /
          bestBid
        ) * 100
      : 0;

  const bidWalls =
    detectWalls(
      bids,
      "BUY"
    );

  const askWalls =
    detectWalls(
      asks,
      "SELL"
    );

  return {
    bids,
    asks,

    buyLiquidity,
    sellLiquidity,

    buyValue,
    sellValue,

    totalLiquidity,

    buyShare,
    sellShare,

    bestBid,
    bestAsk,

    spread,
    spreadPercent,

    pressure,

    buyWalls:
      bidWalls,

    sellWalls:
      askWalls
  };
}

/* =========================================================
   ORDER BOOK WALLS
========================================================= */

function detectWalls(
  rows,
  side
) {
  if (
    !Array.isArray(rows) ||
    !rows.length
  ) {
    return [];
  }

  const sizes =
    rows
      .map(row =>
        safeNumber(row[1])
      )
      .filter(
        x =>
          Number.isFinite(x) &&
          x > 0
      );

  if (!sizes.length) {
    return [];
  }

  const sorted =
    [...sizes].sort(
      (a, b) =>
        a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  const median =
    sorted.length % 2
      ? sorted[middle]
      : (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2;

  const wallThreshold =
    median * 4;

  return rows
    .map(row => ({
      price:
        safeNumber(row[0]),

      size:
        safeNumber(row[1])
    }))
    .filter(
      row =>
        row.size >=
        wallThreshold
    )
    .map(row => ({
      ...row,

      side,

      multiple:
        median > 0
          ? row.size / median
          : 0
    }))
    .sort(
      (a, b) =>
        b.size - a.size
    )
    .slice(
      0,
      20
    );
}

/* =========================================================
   ABSORPTION
========================================================= */

function detectAbsorption(
  trades,
  candles,
  orderbook
) {
  if (
    !trades.length
  ) {
    return {
      detected: false,
      type: "NONE",
      score: 0,
      reason:
        "No recent trades"
    };
  }

  const stats =
    tradeStats(
      trades
    );

  const lastCandle =
    candles?.length
      ? candles[
          candles.length - 1
        ]
      : null;

  const lastPrice =
    trades[
      trades.length - 1
    ]?.price || 0;

  let score = 0;

  let type =
    "NONE";

  const reasons = [];

  const delta =
    stats.deltaPercent;

  if (
    Math.abs(delta) >= 20
  ) {
    score += 25;

    reasons.push(
      `Delta ${delta.toFixed(1)}%`
    );
  } else if (
    Math.abs(delta) >= 10
  ) {
    score += 15;

    reasons.push(
      `Delta ${delta.toFixed(1)}%`
    );
  }

  const largeBuy =
    stats.largeBuyValue;

  const largeSell =
    stats.largeSellValue;

  if (
    largeBuy > 0 &&
    largeSell > 0
  ) {
    const largeTotal =
      largeBuy +
      largeSell;

    const imbalance =
      Math.abs(
        largeBuy -
        largeSell
      ) /
      largeTotal;

    if (
      imbalance < 0.35
    ) {
      score += 20;

      reasons.push(
        "Large-order absorption"
      );
    }
  }

  if (
    orderbook?.buyWalls?.length
  ) {
    score += 10;

    reasons.push(
      "Bid wall"
    );
  }

  if (
    orderbook?.sellWalls?.length
  ) {
    score += 10;

    reasons.push(
      "Ask wall"
    );
  }

  if (
    lastCandle &&
    lastPrice > 0
  ) {
    const candleRange =
      lastCandle.high -
      lastCandle.low;

    if (
      candleRange > 0
    ) {
      const closePosition =
        (
          lastCandle.close -
          lastCandle.low
        ) /
        candleRange;

      if (
        delta < -10 &&
        closePosition > 0.6
      ) {
        score += 20;

        type =
          "BUY_ABSORPTION";

        reasons.push(
          "Selling absorbed near lows"
        );
      }

      if (
        delta > 10 &&
        closePosition < 0.4
      ) {
        score += 20;

        type =
          "SELL_ABSORPTION";

        reasons.push(
          "Buying absorbed near highs"
        );
      }
    }
  }

  if (
    type === "NONE"
  ) {
    if (
      delta < -15 &&
      orderbook?.buyShare >
        orderbook?.sellShare
    ) {
      type =
        "BUY_ABSORPTION";
    } else if (
      delta > 15 &&
      orderbook?.sellShare >
        orderbook?.buyShare
    ) {
      type =
        "SELL_ABSORPTION";
    }
  }

  return {
    detected:
      score >= 40 &&
      type !== "NONE",

    type,

    score,

    deltaPercent:
      delta,

    lastPrice,

    reasons
  };
}

/* =========================================================
   INDICATORS
========================================================= */

function sma(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    period <= 0
  ) {
    return [];
  }

  const result = [];

  let sum = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    sum +=
      safeNumber(
        values[i]
      );

    if (
      i >= period
    ) {
      sum -=
        safeNumber(
          values[
            i - period
          ]
        );
    }

    result.push(
      i + 1 >= period
        ? sum / period
        : null
    );
  }

  return result;
}

function ema(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    period <= 0 ||
    values.length < period
  ) {
    return [];
  }

  const result =
    new Array(
      values.length
    ).fill(null);

  const multiplier =
    2 /
    (period + 1);

  let seed = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    seed +=
      safeNumber(
        values[i]
      );
  }

  let previous =
    seed / period;

  result[
    period - 1
  ] = previous;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    const value =
      safeNumber(
        values[i]
      );

    previous =
      (
        value -
        previous
      ) *
        multiplier +
      previous;

    result[i] =
      previous;
  }

  return result;
}

function stddev(
  values,
  period
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    period <= 0
  ) {
    return result;
  }

  for (
    let i = period - 1;
    i < values.length;
    i++
  ) {
    let sum = 0;

    for (
      let j =
        i - period + 1;
      j <= i;
      j++
    ) {
      sum +=
        safeNumber(
          values[j]
        );
    }

    const mean =
      sum / period;

    let variance = 0;

    for (
      let j =
        i - period + 1;
      j <= i;
      j++
    ) {
      const diff =
        safeNumber(
          values[j]
        ) - mean;

      variance +=
        diff * diff;
    }

    result[i] =
      Math.sqrt(
        variance / period
      );
  }

  return result;
}

/* =========================================================
   RSI
========================================================= */

function rsi(
  values,
  period = 14
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <= period
  ) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  result[period] =
    avgLoss === 0
      ? 100
      : 100 -
        (
          100 /
          (
            1 +
            avgGain /
              avgLoss
          )
        );

  for (
    let i =
      period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? -change
        : 0;

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) /
      period;

    result[i] =
      avgLoss === 0
        ? 100
        : 100 -
          (
            100 /
            (
              1 +
              avgGain /
                avgLoss
            )
          );
  }

  return result;
}

/* =========================================================
   MACD
========================================================= */

function macd(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  const fast =
    ema(
      values,
      fastPeriod
    );

  const slow =
    ema(
      values,
      slowPeriod
    );

  const line =
    new Array(
      values.length
    ).fill(null);

  const compact = [];

  const compactIndexes = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      fast[i] !== null &&
      slow[i] !== null
    ) {
      line[i] =
        fast[i] -
        slow[i];

      compact.push(
        line[i]
      );

      compactIndexes.push(
        i
      );
    }
  }

  const signalCompact =
    ema(
      compact,
      signalPeriod
    );

  const signal =
    new Array(
      values.length
    ).fill(null);

  const histogram =
    new Array(
      values.length
    ).fill(null);

  for (
    let i = 0;
    i < compactIndexes.length;
    i++
  ) {
    const originalIndex =
      compactIndexes[i];

    if (
      signalCompact[i] !==
      null
    ) {
      signal[
        originalIndex
      ] =
        signalCompact[i];

      histogram[
        originalIndex
      ] =
        line[
          originalIndex
        ] -
        signalCompact[i];
    }
  }

  return {
    line,
    signal,
    histogram
  };
}

/* =========================================================
   ATR
========================================================= */

function atr(
  candles,
  period = 14
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 2
  ) {
    return [];
  }

  const tr =
    new Array(
      candles.length
    ).fill(null);

  tr[0] =
    candles[0].high -
    candles[0].low;

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    tr[i] =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );
  }

  const result =
    new Array(
      candles.length
    ).fill(null);

  if (
    candles.length <= period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    sum +=
      tr[i];
  }

  let current =
    sum / period;

  result[period] =
    current;

  for (
    let i =
      period + 1;
    i < candles.length;
    i++
  ) {
    current =
      (
        current *
          (period - 1) +
        tr[i]
      ) /
      period;

    result[i] =
      current;
  }

  return result;
}

  /* =======================================================
   DESERIALIZE
======================================================= */

  deserializeBlock(
    row
  ) {
    if (!row) {
      return null;
    }

    const parsed =
      typeof row.data === "string"
        ? JSON.parse(row.data)
        : row.data;

    if (!parsed) {
      return null;
    }

    const block = {
      v:
        Number(
          parsed.v || 1
        ),

      symbol:
        normalizeSymbol(
          parsed.s ||
          row.symbol
        ),

      hourStart:
        Number(
          parsed.h ||
          row.hour_start
        ),

      hourEnd:
        Number(
          parsed.h ||
          row.hour_start
        ) +
        HOUR_MS,

      candles:
        new Map(),

      dirty: false,

      loaded: true
    };

    const candles =
      Array.isArray(
        parsed.c
      )
        ? parsed.c
        : [];

    for (
      const item
      of candles
    ) {
      if (
        !Array.isArray(item) ||
        item.length < 4
      ) {
        continue;
      }

      const minute =
        Number(
          item.m ??
          item[0]
        );

      const candle = {
        m:
          minute,

        o:
          Number(
            item.o ??
            item[1]
          ),

        h:
          Number(
            item.h ??
            item[2]
          ),

        l:
          Number(
            item.l ??
            item[3]
          ),

        c:
          Number(
            item.c ??
            item[4]
          ),

        v:
          Number(
            item.v ??
            item[5] ??
            0
          ),

        t:
          Number(
            item.t ??
            item[6] ??
            0
          ),

        b:
          Number(
            item.b ??
            item[7] ??
            0
          ),

        s:
          Number(
            item.s ??
            item[8] ??
            0
          ),

        bv:
          Number(
            item.bv ??
            item[9] ??
            0
          ),

        sv:
          Number(
            item.sv ??
            item[10] ??
            0
          ),

        bt:
          Number(
            item.bt ??
            item[11] ??
            0
          ),

        st:
          Number(
            item.st ??
            item[12] ??
            0
          ),

        ot:
          Number(
            item.ot ??
            item[13] ??
            0
          ),

        ct:
          Number(
            item.ct ??
            item[14] ??
            0
          ),

        levels:
          new Map()
      };

      const levels =
        Array.isArray(
          item.lvs
        )
          ? item.lvs
          : Array.isArray(
              item[15]
            )
            ? item[15]
            : [];

      for (
        const levelRow
        of levels
      ) {
        if (
          !Array.isArray(
            levelRow
          )
        ) {
          continue;
        }

        const price =
          Number(
            levelRow[0]
          );

        if (
          !Number.isFinite(
            price
          )
        ) {
          continue;
        }

        candle.levels.set(
          price,
          {
            price,

            buyVolume:
              Number(
                levelRow[1] ||
                0
              ),

            sellVolume:
              Number(
                levelRow[2] ||
                0
              ),

            buyValue:
              Number(
                levelRow[3] ||
                0
              ),

            sellValue:
              Number(
                levelRow[4] ||
                0
              ),

            buyTrades:
              Number(
                levelRow[5] ||
                0
              ),

            sellTrades:
              Number(
                levelRow[6] ||
                0
              )
          }
        );
      }

      if (
        Number.isFinite(
          candle.m
        )
      ) {
        block.candles.set(
          candle.m,
          candle
        );
      }
    }

    return block;
  }

/* =======================================================
   PERSIST CLOSED BLOCK
======================================================= */

  persistBlock(
    block
  ) {
    if (
      !block ||
      !block.symbol
    ) {
      return false;
    }

    const now =
      Date.now();

    const currentHour =
      hourStartOf(
        now
      );

    /*
     * Current hour is RAM-only.
     * It must never be written here.
     */
    if (
      block.hourStart >=
      currentHour
    ) {
      return false;
    }

    this.ensureDBForWrite();

    const data =
      this.serializeBlock(
        block
      );

    this.state.storage.sql.exec(
      `
      INSERT INTO hour_blocks_v5
      (symbol, hour_start, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol, hour_start)
      DO UPDATE SET
        data=excluded.data,
        updated_at=excluded.updated_at
      `,
      block.symbol,
      block.hourStart,
      data,
      now
    );

    block.dirty =
      false;

    block.loaded =
      true;

    this.totalPersistedBlocks +=
      1;

    this.lastCheckpointAt =
      now;

    return true;
  }

/* =======================================================
   PERSIST CLOSED HOURS
======================================================= */

  persistClosedBlocks() {
    if (
      this.checkpointRunning
    ) {
      return {
        persisted: 0,
        skipped: true
      };
    }

    this.checkpointRunning =
      true;

    let persisted = 0;

    try {
      const currentHour =
        hourStartOf(
          Date.now()
        );

      for (
        const [
          key,
          block
        ]
        of this.hourBlocks
      ) {
        if (
          !block ||
          block.hourStart >=
            currentHour
        ) {
          continue;
        }

        if (
          !block.dirty
        ) {
          continue;
        }

        if (
          this.persistBlock(
            block
          )
        ) {
          persisted++;
        }
      }

      /*
       * After successful persistence,
       * old closed blocks can be removed
       * from RAM. Current hour remains protected.
       */
      for (
        const [
          key,
          block
        ]
        of this.hourBlocks
      ) {
        if (
          block &&
          block.hourStart <
            currentHour &&
          !block.dirty
        ) {
          this.hourBlocks.delete(
            key
          );
        }
      }

      if (
        persisted > 0
      ) {
        this.enforceCapacity();
      }

      return {
        persisted,

        skipped:
          false,

        rowCount:
          this.getRowCount(),

        currentHour,

        currentHourProtected:
          true
      };
    } finally {
      this.checkpointRunning =
        false;
    }
  }

/* =======================================================
   EXPIRE OLD BLOCKS
======================================================= */

  expireClosedHours() {
    const currentHour =
      hourStartOf(
        Date.now()
      );

    for (
      const [
        key,
        block
      ]
      of this.hourBlocks
    ) {
      if (
        !block
      ) {
        this.hourBlocks.delete(
          key
        );

        continue;
      }

      if (
        block.hourStart <
        currentHour &&
        !block.dirty
      ) {
        this.hourBlocks.delete(
          key
        );
      }
    }
  }

/* =======================================================
   CHECKPOINT
======================================================= */

  checkpoint() {
    return this.persistClosedBlocks();
  }

/* =======================================================
   TRADE DEDUPLICATION
======================================================= */

  isDuplicateTrade(
    trade
  ) {
    if (
      !trade
    ) {
      return true;
    }

    const id =
      trade.id ||
      [
        trade.symbol,
        trade.time,
        trade.price,
        trade.size,
        trade.side
      ].join(":");

    if (
      this.dedupe.has(id)
    ) {
      this.totalDuplicates +=
        1;

      return true;
    }

    this.dedupe.set(
      id,
      Date.now()
    );

    return false;
  }

  cleanupDedupe() {
    const now =
      Date.now();

    const ttl =
      10 * MINUTE_MS;

    for (
      const [
        id,
        timestamp
      ]
      of this.dedupe
    ) {
      if (
        now - timestamp >
        ttl
      ) {
        this.dedupe.delete(
          id
        );
      }
    }

    /*
     * Hard cap as an additional
     * memory protection.
     */
    if (
      this.dedupe.size >
      50000
    ) {
      const entries =
        [
          ...this.dedupe.entries()
        ]
          .sort(
            (a, b) =>
              a[1] - b[1]
          );

      const remove =
        Math.floor(
          entries.length *
          0.25
        );

      for (
        let i = 0;
        i < remove;
        i++
      ) {
        this.dedupe.delete(
          entries[i][0]
        );
      }
    }
  }

/* =======================================================
   PROCESS TRADE
======================================================= */

  processTrade(
    trade
  ) {
    if (
      !trade
    ) {
      this.totalInvalidTrades +=
        1;

      return false;
    }

    if (
      !trade.symbol ||
      !Number.isFinite(
        trade.time
      ) ||
      !Number.isFinite(
        trade.price
      ) ||
      !Number.isFinite(
        trade.size
      )
    ) {
      this.totalInvalidTrades +=
        1;

      return false;
    }

    if (
      this.isDuplicateTrade(
        trade
      )
    ) {
      return false;
    }

    this.aggregateTrade(
      trade
    );

    this.totalTrades +=
      1;

    this.lastTradeAt =
      trade.time;

    return true;
  }

/* =======================================================
   PARSE WEBSOCKET TRADE MESSAGE
======================================================= */

  handleTradeMessage(
    message
  ) {
    if (
      !message
    ) {
      return 0;
    }

    const topic =
      message.topic ||
      "";

    if (
      !topic.startsWith(
        "publicTrade."
      )
    ) {
      return 0;
    }

    const list =
      Array.isArray(
        message.data
      )
        ? message.data
        : [];

    let processed = 0;

    for (
      const item
      of list
    ) {
      const trade =
        parseWsTrade(
          item
        );

      if (
        this.processTrade(
          trade
        )
      ) {
        processed++;
      }
    }

    return processed;
  }

/* =======================================================
   WEBSOCKET MESSAGE
======================================================= */

  onMessage(
    event
  ) {
    this.lastMessageAt =
      Date.now();

    this.totalMessages +=
      1;

    try {
      const message =
        typeof event.data ===
        "string"
          ? JSON.parse(
              event.data
            )
          : event.data;

      if (
        message?.op ===
        "pong"
      ) {
        return;
      }

      if (
        message?.success ===
        false
      ) {
        this.lastError =
          String(
            message.ret_msg ||
            message.retCode ||
            "WebSocket subscription failed"
          );

        return;
      }

      this.handleTradeMessage(
        message
      );
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }
  }

        if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result?.list
            )
        });
      }

      /* ===================================================
         TRADES
      =================================================== */

      if (
        url.pathname ===
        "/api/trades"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/recent-trade",
            {
              category:
                "linear",

              symbol,

              limit:
                TRADE_LIMIT
            }
          );

        const trades =
          parseTrades(
            result?.list
          );

        return json({
          version:
            VERSION,

          symbol,

          trades,

          stats:
            tradeStats(
              trades
            )
        });
      }

      /* ===================================================
         TICKER
      =================================================== */

      if (
        url.pathname ===
        "/api/ticker"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/tickers",
            {
              category:
                "linear",

              symbol
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          ticker:
            Array.isArray(
              result?.list
            )
              ? result.list[0] ||
                null
              : null
        });
      }

      /* ===================================================
         SCAN
      =================================================== */

      if (
        url.pathname ===
        "/api/scan"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await scanSymbol(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         DEBUG
      =================================================== */

      if (
        url.pathname ===
        "/api/debug"
      ) {
        return json({
          ok: true,

          version:
            VERSION,

          time:
            Date.now(),

          iso:
            new Date()
              .toISOString(),

          environment:
            {
              bybit:
                BYBIT,

              websocket:
                BYBIT_WS,

              defaultSymbol:
                DEFAULT_SYMBOL,

              defaultInterval:
                DEFAULT_INTERVAL
            },

          storage:
            {
              table:
                TABLE_NAME,

              maxRows:
                MAX_ROWS,

              cleanupTarget:
                CLEANUP_TARGET_ROWS,

              model:
                "1 symbol + 1 hour = 1 row",

              currentHour:
                "RAM only until hour closes",

              writePolicy:
                "closed hour only"
            }
        });
      }

      /* ===================================================
         404
      =================================================== */

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION,

          path:
            url.pathname
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};

      =================================================== */

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

      /* ===================================================
         MARKET
      =================================================== */

      if (
        url.pathname ===
        "/api/market"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await getMarket(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const market =
          await getMarket(
            symbol,
            "1"
          );

        return json({
          version:
            VERSION,

          symbol,

          footprint:
            market.footprint,

          stats:
            market.stats,

          absorption:
            market.absorption
        });
      }

      /* ===================================================
         ORDERBOOK
      =================================================== */

      if (
        url.pathname ===
        "/api/orderbook"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/orderbook",
            {
              category:
                "linear",

              symbol,

              limit:
                ORDERBOOK_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          orderbook:
            orderbookStats(
              result
            )
        });
      }

      /* ===================================================
         CANDLES
      =================================================== */

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result.list
            )
        });
      }

      /* ===================================================
         ASSETS
      =================================================== */

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION,

          path:
            url.pathname
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};

      =================================================== */

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

      /* ===================================================
         MARKET
      =================================================== */

      if (
        url.pathname ===
        "/api/market"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await getMarket(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const market =
          await getMarket(
            symbol,
            "1"
          );

        return json({
          version:
            VERSION,

          symbol,

          footprint:
            market.footprint,

          stats:
            market.stats,

          absorption:
            market.absorption
        });
      }

      /* ===================================================
         ORDERBOOK
      =================================================== */

      if (
        url.pathname ===
        "/api/orderbook"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/orderbook",
            {
              category:
                "linear",

              symbol,

              limit:
                ORDERBOOK_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          orderbook:
            orderbookStats(
              result
            )
        });
      }

      /* ===================================================
         CANDLES
      =================================================== */

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result.list
            )
        });
      }

      /* ===================================================
         ASSETS
      =================================================== */

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};

      if (
        block &&
        block.hourStart <
          currentHour &&
        !block.dirty
      ) {
        this.hourBlocks.delete(
          key
        );
      }
    }

    return {
      deleted:
        actualDelete,

      rows:
        this.getRowCount(),

      protectedCurrentHour:
        true
    };
  }

/* =======================================================
   LOAD RECENT BLOCKS
======================================================= */

  loadRecentBlocks() {
    if (
      this.loadedRecentBlocks
    ) {
      return;
    }

    this.initDB();

    if (
      this.tableExists !== true
    ) {
      this.loadedRecentBlocks =
        true;

      return;
    }

    const currentHour =
      hourStartOf(
        Date.now()
      );

    const rows =
      this.state.storage.sql
        .exec(
          `
          SELECT
            symbol,
            hour_start,
            data,
            updated_at
          FROM hour_blocks_v5
          WHERE hour_start <= ?
          ORDER BY hour_start DESC
          LIMIT 500
          `,
          currentHour
        )
        .toArray();

    for (
      const row
      of rows
    ) {
      try {
        const block =
          this.deserializeBlock(
            row
          );

        if (
          !block ||
          !block.symbol
        ) {
          continue;
        }

        const key =
          this.blockKey(
            block.symbol,
            block.hourStart
          );

        this.hourBlocks.set(
          key,
          block
        );
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );
      }
    }

    this.loadedRecentBlocks =
      true;
  }

/* =======================================================
   BLOCK KEY
======================================================= */

  blockKey(
    symbol,
    hourStart
  ) {
    return (
      normalizeSymbol(
        symbol
      ) +
      ":" +
      String(
        hourStart
      )
    );
  }

/* =======================================================
   GET / CREATE HOUR BLOCK
======================================================= */

  getHourBlock(
    symbol,
    timestamp
  ) {
    symbol =
      normalizeSymbol(
        symbol
      );

    const hourStart =
      hourStartOf(
        timestamp
      );

    const key =
      this.blockKey(
        symbol,
        hourStart
      );

    let block =
      this.hourBlocks.get(
        key
      );

    if (
      block
    ) {
      return block;
    }

    block = {
      v: 1,

      symbol,

      hourStart,

      hourEnd:
        hourStart +
        HOUR_MS,

      candles:
        new Map(),

      dirty:
        true,

      loaded:
        false
    };

    this.hourBlocks.set(
      key,
      block
    );

    return block;
  }

/* =======================================================
   GET / CREATE MINUTE CANDLE
======================================================= */

  getMinuteCandle(
    block,
    timestamp,
    price
  ) {
    const minute =
      minuteStartOf(
        timestamp
      );

    let candle =
      block.candles.get(
        minute
      );

    if (
      candle
    ) {
      return candle;
    }

    candle = {
      m:
        minute,

      o:
        price,

      h:
        price,

      l:
        price,

      c:
        price,

      v:
        0,

      t:
        0,

      b:
        0,

      s:
        0,

      bv:
        0,

      sv:
        0,

      bt:
        0,

      st:
        0,

      ot:
        timestamp,

      ct:
        timestamp,

      levels:
        new Map()
    };

    block.candles.set(
      minute,
      candle
    );

    return candle;
  }

/* =======================================================
   GET / CREATE PRICE LEVEL
======================================================= */

  getPriceLevel(
    candle,
    price
  ) {
    const key =
      normalizePriceKey(
        price
      );

    let level =
      candle.levels.get(
        key
      );

    if (
      level
    ) {
      return level;
    }

    level = {
      price:

        key,

      buyVolume:
        0,

      sellVolume:
        0,

      buyValue:
        0,

      sellValue:
        0,

      buyTrades:
        0,

      sellTrades:
        0
    };

    candle.levels.set(
      key,
      level
    );

    return level;
  }

/* =======================================================
   AGGREGATE TRADE
======================================================= */

  aggregateTrade(
    trade
  ) {
    const block =
      this.getHourBlock(
        trade.symbol,
        trade.time
      );

    const candle =
      this.getMinuteCandle(
        block,
        trade.time,
        trade.price
      );

    const price =
      safeNumber(
        trade.price
      );

    const size =
      safeNumber(
        trade.size
      );

    const value =
      safeNumber(
        trade.value,
        price * size
      );

    candle.h =
      Math.max(
        candle.h,
        price
      );

    candle.l =
      Math.min(
        candle.l,
        price
      );

    candle.c =
      price;

    candle.v +=
      size;

    candle.t +=
      value;

    candle.ct =
      trade.time;

    if (
      trade.side ===
      "Buy"
    ) {
      candle.b +=
        size;

      candle.bv +=
        value;

      candle.bt +=
        1;
    } else {
      candle.s +=
        size;

      candle.sv +=
        value;

      candle.st +=
        1;
    }

    const level =
      this.getPriceLevel(
        candle,
        price
      );

    if (
      trade.side ===
      "Buy"
    ) {
      level.buyVolume +=
        size;

      level.buyValue +=
        value;

      level.buyTrades +=
        1;
    } else {
      level.sellVolume +=
        size;

      level.sellValue +=
        value;

      level.sellTrades +=
        1;
    }

    block.dirty =
      true;

    return block;
  }

/* =======================================================
   SERIALIZE BLOCK
======================================================= */

  serializeBlock(
    block
  ) {
    const candles =
      [];

    const sortedCandles =
      [
        ...block.candles.values()
      ].sort(
        (a, b) =>
          a.m - b.m
      );

    for (
      const candle
      of sortedCandles
    ) {
      const levels =
        [];

      const sortedLevels =
        [
          ...candle.levels.values()
        ].sort(
          (a, b) =>
            a.price -
            b.price
        );

      for (
        const level
        of sortedLevels
      ) {
        levels.push([
          level.price,

          level.buyVolume,

          level.sellVolume,

          level.buyValue,

          level.sellValue,

          level.buyTrades,

          level.sellTrades
        ]);
      }

      candles.push({
        m:
          candle.m,

        o:
          candle.o,

        h:
          candle.h,

        l:
          candle.l,

        c:
          candle.c,

        v:
          candle.v,

        t:
          candle.t,

        b:
          candle.b,

        s:
          candle.s,

        bv:
          candle.bv,

        sv:
          candle.sv,

        bt:
          candle.bt,

        st:
          candle.st,

        ot:
          candle.ot,

        ct:
          candle.ct,

        lvs:
          levels
      });
    }

    return JSON.stringify({
      v:
        block.v || 1,

      s:
        block.symbol,

      h:
        block.hourStart,

      c:
        candles
    });
  }

/* =======================================================
   SOCKET START
======================================================= */

  async startSocket() {
    if (
      this.started &&
      this.ws
    ) {
      return;
    }

    this.started = true;
    this.wsStartedAt =
      Date.now();

    this.loadRecentBlocks();

    await this.loadSymbols();

    this.connectSocket();
  }

/* =======================================================
   LOAD SYMBOLS
======================================================= */

  async loadSymbols() {
    try {
      const result =
        await bybit(
          "/v5/market/instruments-info",
          {
            category:
              "linear",

            limit:
              SYMBOL_LIMIT
          }
        );

      const list =
        Array.isArray(
          result?.list
        )
          ? result.list
          : [];

      this.symbols =
        list
          .filter(
            item =>
              item?.status ===
              "Trading"
          )
          .map(
            item =>
              normalizeSymbol(
                item.symbol
              )
          )
          .filter(
            symbol =>
              symbol.endsWith(
                "USDT"
              )
          );

      this.symbolMeta.clear();

      for (
        const item
        of list
      ) {
        const symbol =
          normalizeSymbol(
            item?.symbol
          );

        if (!symbol) {
          continue;
        }

        this.symbolMeta.set(
          symbol,
          {
            symbol,

            tickSize:
              safeNumber(
                item
                  ?.priceFilter
                  ?.tickSize,
                0
              ),

            minOrderQty:
              safeNumber(
                item
                  ?.lotSizeFilter
                  ?.minOrderQty,
                0
              )
          }
        );
      }

      return this.symbols;
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      return [];
    }
  }

/* =======================================================
   SUBSCRIPTION CHUNKS
======================================================= */

  buildSubscriptions() {
    const subscriptions =
      [];

    for (
      const symbol
      of this.symbols
    ) {
      if (
        !symbol
      ) {
        continue;
      }

      subscriptions.push(
        `publicTrade.${symbol}`
      );
    }

    return subscriptions;
  }

/* =======================================================
   CONNECT WEBSOCKET
======================================================= */

  connectSocket() {
    if (
      !this.started
    ) {
      return;
    }

    if (
      this.ws
    ) {
      try {
        this.ws.close();
      } catch {}
    }

    this.connected =
      false;

    this.subscribed.clear();

    try {
      this.ws =
        new WebSocket(
          BYBIT_WS
        );

      this.ws.addEventListener(
        "open",
        () =>
          this.onOpen()
      );

      this.ws.addEventListener(
        "message",
        event =>
          this.onMessage(
            event
          )
      );

      this.ws.addEventListener(
        "error",
        event =>
          this.onSocketError(
            event
          )
      );

      this.ws.addEventListener(
        "close",
        event =>
          this.onClose(
            event
          )
      );
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );

      this.scheduleReconnect();
    }
  }

/* =======================================================
   SOCKET OPEN
======================================================= */

  onOpen() {
    this.connected =
      true;

    this.reconnectAttempt =
      0;

    this.lastError =
      "";

    this.subscribeAll();

    this.startPing();

    this.scheduleAlarm();
  }

/* =======================================================
   SUBSCRIBE ALL
======================================================= */

  subscribeAll() {
    if (
      !this.ws ||
      !this.connected
    ) {
      return;
    }

    const topics =
      this.buildSubscriptions();

    if (
      !topics.length
    ) {
      return;
    }

    /*
     * Bybit accepts subscription
     * messages with multiple args.
     * Keep batches moderate.
     */
    const batchSize =
      100;

    for (
      let i = 0;
      i < topics.length;
      i += batchSize
    ) {
      const batch =
        topics.slice(
          i,
          i + batchSize
        );

      try {
        this.ws.send(
          JSON.stringify({
            op:
              "subscribe",

            args:
              batch
          })
        );

        for (
          const topic
          of batch
        ) {
          this.subscribed.add(
            topic
          );
        }
      } catch (error) {
        this.lastError =
          String(
            error?.message ||
            error
          );

        break;
      }
    }
  }

/* =======================================================
   PING
======================================================= */

  startPing() {
    this.stopPing();

    this.pingTimer =
      setInterval(
        () => {
          if (
            !this.ws ||
            !this.connected
          ) {
            return;
          }

          try {
            this.ws.send(
              JSON.stringify({
                op:
                  "ping"
              })
            );
          } catch (error) {
            this.lastError =
              String(
                error?.message ||
                error
              );
          }
        },
        20000
      );
  }

  stopPing() {
    if (
      this.pingTimer
    ) {
      clearInterval(
        this.pingTimer
      );

      this.pingTimer =
        null;
    }
  }

/* =======================================================
   SOCKET ERROR
======================================================= */

  onSocketError(
    event
  ) {
    this.connected =
      false;

    this.lastError =
      "WebSocket error";
  }

/* =======================================================
   SOCKET CLOSE
======================================================= */

  onClose(
    event
  ) {
    this.connected =
      false;

    this.stopPing();

    this.ws =
      null;

    if (
      this.started
    ) {
      this.scheduleReconnect();
    }
  }

/* =======================================================
   RECONNECT
======================================================= */

  scheduleReconnect() {
    if (
      !this.started
    ) {
      return;
    }

    if (
      this.reconnectTimer
    ) {
      return;
    }

    const attempt =
      this.reconnectAttempt++;

    const delay =
      Math.min(
        60000,
        1000 *
          Math.pow(
            2,
            Math.min(
              attempt,
              6
            )
          )
      );

    this.reconnectTimer =
      setTimeout(
        () => {
          this.reconnectTimer =
            null;

          this.connectSocket();
        },
        delay
      );
  }

/* =======================================================
   ALARM
======================================================= */

  scheduleAlarm() {
    if (
      this.alarmScheduled
    ) {
      return;
    }

    this.alarmScheduled =
      true;

    try {
      this.state.storage.setAlarm(
        Date.now() +
          ALARM_MS
      );
    } catch (error) {
      this.alarmScheduled =
        false;

      this.lastError =
        String(
          error?.message ||
          error
        );
    }
  }

/* =======================================================
   ALARM HANDLER
======================================================= */

  async alarm() {
    this.alarmScheduled =
      false;

    try {
      this.cleanupDedupe();

      /*
       * Only closed hours are
       * written to SQLite.
       */
      this.persistClosedBlocks();

      this.expireClosedHours();

      /*
       * Capacity cleanup is also
       * restricted to old rows.
       */
      this.enforceCapacity();
    } catch (error) {
      this.lastError =
        String(
          error?.message ||
          error
        );
    }

    this.scheduleAlarm();
  }

  async fetch(request) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    try {
      if (
        url.pathname ===
        "/internal/start"
      ) {
        await this.startSocket();

        return json({
          ok: true,

          started:
            this.started,

          connected:
            this.connected,

          symbols:
            this.symbols.length,

          version:
            VERSION
        });
      }

      if (
        url.pathname ===
        "/internal/stop"
      ) {
        this.started =
          false;

        this.stopPing();

        if (
          this.reconnectTimer
        ) {
          clearTimeout(
            this.reconnectTimer
          );

          this.reconnectTimer =
            null;
        }

        if (
          this.ws
        ) {
          try {
            this.ws.close();
          } catch {}
        }

        this.ws =
          null;

        this.connected =
          false;

        return json({
          ok: true,

          stopped:
            true,

          version:
            VERSION
        });
      }

      if (
        url.pathname ===
        "/internal/test/storage"
      ) {
        return json(
          this.testStorageWrite()
        );
      }

      if (
        url.pathname ===
        "/internal/status"
      ) {
        this.loadRecentBlocks();

        const currentHour =
          hourStartOf(
            Date.now()
          );

        let currentHourBlocks =
          0;

        let dirtyBlocks =
          0;

        for (
          const block
          of this.hourBlocks.values()
        ) {
          if (
            !block
          ) {
            continue;
          }

          if (
            block.hourStart ===
            currentHour
          ) {
            currentHourBlocks++;
          }

          if (
            block.dirty
          ) {
            dirtyBlocks++;
          }
        }

        return json({
          ok: true,

          version:
            VERSION,

          collector:
            "AbsorptionStorageV5",

          started:
            this.started,

          connected:
            this.connected,

          symbols:
            this.symbols.length,

          subscribed:
            this.subscribed.size,

          wsStartedAt:
            this.wsStartedAt,

          lastMessageAt:
            this.lastMessageAt,

          lastTradeAt:
            this.lastTradeAt,

          lastError:
            this.lastError,

          totalMessages:
            this.totalMessages,

          totalTrades:
            this.totalTrades,

          totalDuplicates:
            this.totalDuplicates,

          totalInvalidTrades:
            this.totalInvalidTrades,

          totalPersistedBlocks:
            this.totalPersistedBlocks,

          totalDeletedRows:
            this.totalDeletedRows,

          ramBlocks:
            this.hourBlocks.size,

          currentHourBlocks,

          dirtyBlocks,

          rowCount:
            this.getRowCount(),

          storage:
            "Durable Object SQLite",

          storageName:
            "AbsorptionStorageV5",

          table:
            TABLE_NAME,

          storageModel:
            "1 row = 1 symbol + 1 hour",

          maxRows:
            MAX_ROWS,

          cleanupTarget:
            CLEANUP_TARGET_ROWS,

          checkpoint:
            "closed hour only",

          currentHour:
            "RAM only until hour closes",

          currentHourStart:
            currentHour,

          currentHourISO:
            new Date(
              currentHour
            ).toISOString(),

          history:
            "rolling 20000 hour blocks",

          currentHourProtected:
            true,

          oldStorage:
            "preserved / new writes disabled",

          writePolicy:
            "no startup DB write; closed hour only",

          lastCheckpointAt:
            this.lastCheckpointAt,

          lastCleanupAt:
            this.lastCleanupAt,

          databaseInitialized:
            this.dbInitialized,

          tableExists:
            this.tableExists
        });
      }

      if (
        url.pathname ===
        "/internal/history"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const limit =
          Math.min(
            200,
            Math.max(
              1,
              Number(
                url.searchParams.get(
                  "limit"
                ) ||
                50
              )
            )
          );

        return json(
          this.getHistory(
            symbol,
            limit
          )
        );
      }

      if (
        url.pathname ===
        "/internal/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const hourStart =
          Number(
            url.searchParams.get(
              "hour"
            ) ||
            hourStartOf(
              Date.now()
            )
          );

        return json(
          this.getFootprintHistory(
            symbol,
            hourStart
          )
        );
      }

      return json(
        {
          ok: false,

          error:
            "Internal route not found",

          path:
            url.pathname,

          version:
            VERSION
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          path:
            url.pathname,

          version:
            VERSION
        },
        500
      );
    }
  }
}

/* =========================================================
   COLLECTOR START
========================================================= */

async function startCollector(
  env
) {
  try {
    const stub =
      collectorStub(
        env
      );

    const target =
      new URL(
        "https://collector/internal/start"
      );

    return await stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

/* =========================================================
   COLLECTOR STATUS
========================================================= */

async function collectorStatus(
  env
) {
  try {
    const stub =
      collectorStub(
        env
      );

    const target =
      new URL(
        "https://collector/internal/status"
      );

    return await stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        version:
          VERSION
      },
      500
    );
  }
}

/* =========================================================
   COLLECTOR STORAGE TEST
========================================================= */

async function collectorStorageTest(
  env
) {
  try {
    const stub =
      collectorStub(
        env
      );

    const target =
      new URL(
        "https://collector/internal/test/storage"
      );

    return stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        stack:
          error?.stack ||
          "",

        version:
          VERSION
      },
      500
    );
  }
}

/* =========================================================
   COLLECTOR HISTORY
========================================================= */

async function collectorHistory(
  env,
  url
) {
  try {
    const stub =
      collectorStub(
        env
      );

    const target =
      new URL(
        "https://collector/internal/history"
      );

    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        ) ||
        DEFAULT_SYMBOL
      );

    const limit =
      Math.min(
        200,
        Math.max(
          1,
          Number(
            url.searchParams.get(
              "limit"
            ) ||
            50
          )
        )
      );

    target.searchParams.set(
      "symbol",
      symbol
    );

    target.searchParams.set(
      "limit",
      String(
        limit
      )
    );

    return stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        version:
          VERSION
      },
      500
    );
  }
}

/* =========================================================
   COLLECTOR FOOTPRINT
========================================================= */

async function collectorFootprint(
  env,
  url
) {
  try {
    const stub =
      collectorStub(
        env
      );

    const target =
      new URL(
        "https://collector/internal/footprint"
      );

    const symbol =
      normalizeSymbol(
        url.searchParams.get(
          "symbol"
        ) ||
        DEFAULT_SYMBOL
      );

    const hour =
      Number(
        url.searchParams.get(
          "hour"
        ) ||
        hourStartOf(
          Date.now()
        )
      );

    target.searchParams.set(
      "symbol",
      symbol
    );

    target.searchParams.set(
      "hour",
      String(
        hour
      )
    );

    return stub.fetch(
      target.toString()
    );
  } catch (error) {
    return json(
      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          ),

        errorName:
          error?.name ||
          "Error",

        version:
          VERSION
      },
      500
    );
  }
}

          storageTest:
            "/api/test/storage"
        });
      }

      /* ===================================================
         STORAGE WRITE / READ-BACK TEST
      =================================================== */

      if (
        url.pathname ===
        "/api/test/storage"
      ) {
        return collectorStorageTest(env);
      }

      /* ===================================================
         SYMBOLS
      =================================================== */

      if (
        url.pathname ===
        "/api/symbols"
      ) {
        const symbols =
          await getBybitSymbols();

        return json({
          ok: true,

          count:
            symbols.length,

          source:
            "Bybit Linear USDT Perpetual",

          symbols
        });
      }

      /* ===================================================
         COLLECTOR START
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/start"
      ) {
        return startCollector(
          env
        );
      }

      /* ===================================================
         COLLECTOR STATUS
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/status"
      ) {
        return collectorStatus(
          env
        );
      }

      /* ===================================================
         COLLECTOR REFRESH
      =================================================== */

      if (
        url.pathname ===
        "/api/collector/refresh"
      ) {
        return collectorRefresh(
          env
        );
      }

      /* ===================================================
         HISTORY
      =================================================== */

      if (
        url.pathname ===
        "/api/history"
      ) {
        return collectorHistory(
          env,
          url
        );
      }

      /* ===================================================
         FOOTPRINT HISTORY
      =================================================== */

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

      /* ===================================================
         MARKET
      =================================================== */

      if (
        url.pathname ===
        "/api/market"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await getMarket(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const market =
          await getMarket(
            symbol,
            "1"
          );

        return json({
          version:
            VERSION,

          symbol,

          footprint:
            market.footprint,

          stats:
            market.stats,

          absorption:
            market.absorption
        });
      }

      /* ===================================================
         ORDERBOOK
      =================================================== */

      if (
        url.pathname ===
        "/api/orderbook"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/orderbook",
            {
              category:
                "linear",

              symbol,

              limit:
                ORDERBOOK_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          orderbook:
            orderbookStats(
              result
            )
        });
      }

      /* ===================================================
         CANDLES
      =================================================== */

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result.list
            )
        });
      }

      /* ===================================================
         ASSETS
      =================================================== */

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};

      /* ===================================================
         HISTORY / FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/history/footprint"
      ) {
        return collectorFootprint(
          env,
          url
        );
      }

      /* ===================================================
         MARKET
      =================================================== */

      if (
        url.pathname ===
        "/api/market"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        return json(
          await getMarket(
            symbol,
            interval
          )
        );
      }

      /* ===================================================
         FOOTPRINT
      =================================================== */

      if (
        url.pathname ===
        "/api/footprint"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const market =
          await getMarket(
            symbol,
            "1"
          );

        return json({
          version:
            VERSION,

          symbol,

          footprint:
            market.footprint,

          stats:
            market.stats,

          absorption:
            market.absorption
        });
      }

      /* ===================================================
         ORDERBOOK
      =================================================== */

      if (
        url.pathname ===
        "/api/orderbook"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const result =
          await bybit(
            "/v5/market/orderbook",
            {
              category:
                "linear",

              symbol,

              limit:
                ORDERBOOK_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          orderbook:
            orderbookStats(
              result
            )
        });
      }

      /* ===================================================
         CANDLES
      =================================================== */

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            ) ||
            DEFAULT_SYMBOL
          );

        const interval =
          normalizeInterval(
            url.searchParams.get(
              "interval"
            ) ||
            DEFAULT_INTERVAL
          );

        const result =
          await bybit(
            "/v5/market/kline",
            {
              category:
                "linear",

              symbol,

              interval,

              limit:
                KLINE_LIMIT
            }
          );

        return json({
          version:
            VERSION,

          symbol,

          interval,

          candles:
            parseKlines(
              result.list
            )
        });
      }

      /* ===================================================
         ASSETS
      =================================================== */

      if (
        env.ASSETS
      ) {
        return env.ASSETS.fetch(
          request
        );
      }

      return json(
        {
          ok: false,

          error:
            "Route not found",

          version:
            VERSION
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            String(
              error?.message ||
              error
            ),

          errorName:
            error?.name ||
            "Error",

          stack:
            error?.stack ||
            "",

          version:
            VERSION,

          path:
            url.pathname
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      startCollector(env)
    );
  }
};

