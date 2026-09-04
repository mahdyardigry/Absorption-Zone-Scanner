// worker.js

import { DurableObject } from "cloudflare:workers";

const BYBIT_API = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const VERSION = "BYBIT-PERSONAL-COLLECTOR-V2";

const MAX_SYMBOLS = 1000;
const WS_SHARDS = 6;

const ORDERBOOK_DEPTH = 50;

const SNAPSHOT_MS = 5000;
const MINUTE_MS = 60 * 1000;

const RETENTION_MINUTES = 24 * 60;

const MAX_BLOCKS_PER_MINUTE = 100;
const BLOCK_MULTIPLIER = 5;

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

function safeSymbol(v) {
  return /^[A-Z0-9._-]{2,50}$/i.test(String(v || ""));
}

function minuteStart(ts) {
  return Math.floor(Number(ts) / MINUTE_MS) * MINUTE_MS;
}

function priceKey(price) {
  return Number(price).toString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, params = {}) {
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== ""
    ) {
      q.set(k, String(v));
    }
  }

  const query = q.toString();
  const url = query
    ? `${BYBIT_API}${path}?${query}`
    : `${BYBIT_API}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      `Bybit error ${data.retCode}`
    );
  }

  return data.result || {};
}

async function getSymbols() {
  const all = [];
  let cursor = "";

  for (let page = 0; page < 10; page++) {
    const params = {
      category: "linear",
      status: "Trading",
      limit: 1000
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const result = await api(
      "/v5/market/instruments-info",
      params
    );

    const list = Array.isArray(result.list)
      ? result.list
      : [];

    all.push(...list);

    cursor =
      result.nextPageCursor || "";

    if (!cursor || !list.length) {
      break;
    }

    if (all.length >= MAX_SYMBOLS) {
      break;
    }
  }

  return [
    ...new Set(
      all
        .filter(x =>
          x.status === "Trading" &&
          x.quoteCoin === "USDT" &&
          x.contractType === "LinearPerpetual"
        )
        .map(x => x.symbol)
        .filter(safeSymbol)
    )
  ].slice(0, MAX_SYMBOLS);
}

function emptyMinute(symbol, ts) {
  return {
    symbol,
    minute: minuteStart(ts),

    open: 0,
    high: 0,
    low: 0,
    close: 0,

    tradeCount: 0,

    buyVolume: 0,
    sellVolume: 0,

    buyValue: 0,
    sellValue: 0,

    delta: 0,
    deltaValue: 0,

    cumulativeDelta: 0,
    cumulativeDeltaValue: 0,

    bidLevels: {},
    askLevels: {},
    levels: {},

    largestTradeValue: 0,

    blocks: [],

    liquidationBuyVolume: 0,
    liquidationSellVolume: 0,

    liquidationBuyValue: 0,
    liquidationSellValue: 0,

    liquidationCount: 0,

    bookSnapshots: [],

    maxBidLiquidity: 0,
    maxAskLiquidity: 0,

    avgBidLiquidity: 0,
    avgAskLiquidity: 0,

    bookSnapshotCount: 0,

    lastBestBid: 0,
    lastBestAsk: 0,

    blockThreshold: 0,

    previousCvd: 0,
    previousCvdValue: 0
  };
}

function ensureLevel(minute, price) {
  const key = priceKey(price);

  if (!minute.levels[key]) {
    minute.levels[key] = {
      price: Number(price),

      bidVolume: 0,
      askVolume: 0,

      bidValue: 0,
      askValue: 0,

      bidTrades: 0,
      askTrades: 0,

      delta: 0,
      deltaValue: 0,

      totalVolume: 0,
      totalValue: 0
    };
  }

  return minute.levels[key];
}

function applyTrade(minute, trade) {
  const price = n(trade.price);
  const size = n(trade.size);

  const value = n(
    trade.value,
    price * size
  );

  if (
    price <= 0 ||
    size <= 0
  ) {
    return;
  }

  if (!minute.open) {
    minute.open = price;
    minute.high = price;
    minute.low = price;
  }

  minute.high =
    Math.max(
      minute.high,
      price
    );

  minute.low =
    Math.min(
      minute.low,
      price
    );

  minute.close = price;

  minute.tradeCount++;

  const level =
    ensureLevel(
      minute,
      price
    );

  level.totalVolume += size;
  level.totalValue += value;

  /*
    Bybit:
    Buy  = aggressive buyer
    Sell = aggressive seller

    Footprint:
    ASK = Buy
    BID = Sell
  */

  if (
    trade.side === "Buy"
  ) {
    minute.buyVolume += size;
    minute.buyValue += value;

    level.askVolume += size;
    level.askValue += value;
    level.askTrades++;

  } else if (
    trade.side === "Sell"
  ) {
    minute.sellVolume += size;
    minute.sellValue += value;

    level.bidVolume += size;
    level.bidValue += value;
    level.bidTrades++;
  }

  level.delta =
    level.askVolume -
    level.bidVolume;

  level.deltaValue =
    level.askValue -
    level.bidValue;

  minute.delta =
    minute.buyVolume -
    minute.sellVolume;

  minute.deltaValue =
    minute.buyValue -
    minute.sellValue;

  minute.largestTradeValue =
    Math.max(
      minute.largestTradeValue,
      value
    );

  const explicitBlock =
    Boolean(trade.isBlockTrade);

  const adaptiveBlock =
    minute.blockThreshold > 0 &&
    value >= minute.blockThreshold;

  if (
    (explicitBlock || adaptiveBlock) &&
    minute.blocks.length <
      MAX_BLOCKS_PER_MINUTE
  ) {
    minute.blocks.push({
      time: trade.time,
      price,
      size,
      value,
      side: trade.side,
      id: trade.id || "",
      isBlockTrade: explicitBlock,
      isRPITrade:
        Boolean(
          trade.isRPITrade
        )
    });
  }
}

function finalizeMinute(
  minute
) {
  minute.cumulativeDelta =
    minute.previousCvd +
    minute.delta;

  minute.cumulativeDeltaValue =
    minute.previousCvdValue +
    minute.deltaValue;

  const levels =
    Object.values(
      minute.levels
    ).sort(
      (a, b) =>
        b.price - a.price
    );

  const bidLevels = {};
  const askLevels = {};

  for (
    const level of levels
  ) {
    const key =
      priceKey(
        level.price
      );

    if (
      level.bidVolume > 0
    ) {
      bidLevels[key] = {
        price:
          level.price,
        volume:
          level.bidVolume,
        value:
          level.bidValue,
        trades:
          level.bidTrades,
        delta:
          level.delta
      };
    }

    if (
      level.askVolume > 0
    ) {
      askLevels[key] = {
        price:
          level.price,
        volume:
          level.askVolume,
        value:
          level.askValue,
        trades:
          level.askTrades,
        delta:
          level.delta
      };
    }
  }

  minute.bidLevels =
    bidLevels;

  minute.askLevels =
    askLevels;

  delete minute.blockThreshold;
  delete minute.previousCvd;
  delete minute.previousCvdValue;

  return minute;
}

class CollectorShard {

  constructor(
    state,
    env
  ) {
    this.state = state;
    this.env = env;

    this.symbols = [];
    this.connections = new Map();
    this.books = new Map();
    this.minutes = new Map();

    this.cvd = new Map();
    this.cvdValue = new Map();

    this.lastSnapshot = 0;

    this.started = false;
    this.connecting = false;

    this.reconnectTimers =
      new Map();

    this.recentTradeIds =
      new Map();

    this.stats = {
      trades: 0,
      bookMessages: 0,
      liquidations: 0,
      errors: 0,
      reconnects: 0,
      duplicates: 0,
      lastMessage: 0
    };

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS minute_data (
        symbol TEXT NOT NULL,
        minute INTEGER NOT NULL,

        open REAL,
        high REAL,
        low REAL,
        close REAL,

        trade_count INTEGER,

        buy_volume REAL,
        sell_volume REAL,

        buy_value REAL,
        sell_value REAL,

        delta REAL,
        delta_value REAL,

        cumulative_delta REAL,
        cumulative_delta_value REAL,

        largest_trade_value REAL,

        liquidation_buy_volume REAL,
        liquidation_sell_volume REAL,

        liquidation_buy_value REAL,
        liquidation_sell_value REAL,

        liquidation_count INTEGER,

        max_bid_liquidity REAL,
        max_ask_liquidity REAL,

        avg_bid_liquidity REAL,
        avg_ask_liquidity REAL,

        last_best_bid REAL,
        last_best_ask REAL,

        payload TEXT,

        PRIMARY KEY (
          symbol,
          minute
        )
      )
    `);

    this.state.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_minute_symbol_time
      ON minute_data (
        symbol,
        minute
      )
    `);
  }

  async initialize() {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      const storedSymbols =
        await this.state.storage.get(
          "symbols"
        );

      if (
        Array.isArray(
          storedSymbols
        ) &&
        storedSymbols.length
      ) {
        this.symbols =
          storedSymbols;
      }

      await this.loadCvd();

      if (
        this.symbols.length
      ) {
        this.state.waitUntil(
          this.connect()
        );
      }
    } catch {
      this.stats.errors++;
    }
  }

  async loadCvd() {
    const rows =
      await this.state.storage.sql
        .exec(`
          SELECT
            m.symbol,
            m.cumulative_delta,
            m.cumulative_delta_value
          FROM minute_data m
          INNER JOIN (
            SELECT
              symbol,
              MAX(minute) AS max_minute
            FROM minute_data
            GROUP BY symbol
          ) x
          ON
            m.symbol = x.symbol
            AND m.minute = x.max_minute
        `)
        .toArray();

    for (
      const row of rows
    ) {
      this.cvd.set(
        row.symbol,
        n(
          row.cumulative_delta
        )
      );

      this.cvdValue.set(
        row.symbol,
        n(
          row.cumulative_delta_value
        )
      );
    }
  }

  async setSymbols(
    symbols
  ) {
    const normalized =
      [
        ...new Set(
          (symbols || [])
            .map(x =>
              String(x)
                .trim()
                .toUpperCase()
            )
            .filter(
              safeSymbol
            )
        )
      ];

    this.symbols =
      normalized.slice(
        0,
        MAX_SYMBOLS
      );

    await this.state.storage.put(
      "symbols",
      this.symbols
    );

    await this.disconnectAll();

    this.books.clear();
    this.minutes.clear();

    this.connecting = false;

    this.state.waitUntil(
      this.connect()
    );
  }

  shardSymbols() {
    const output =
      Array.from(
        {
          length:
            WS_SHARDS
        },
        () => []
      );

    for (
      let i = 0;
      i <
      this.symbols.length;
      i++
    ) {
      output[
        i % WS_SHARDS
      ].push(
        this.symbols[i]
      );
    }

    return output;
  }

  async connect() {
    if (
      this.connecting
    ) {
      return;
    }

    if (
      !this.symbols.length
    ) {
      return;
    }

    this.connecting = true;

    try {
      const shards =
        this.shardSymbols();

      for (
        let i = 0;
        i <
        shards.length;
        i++
      ) {
        if (
          !shards[i].length
        ) {
          continue;
        }

        try {
          await this.connectShard(
            i,
            shards[i]
          );
        } catch {
          this.stats.errors++;
        }

        await sleep(500);
      }
    } finally {
      this.connecting = false;
    }
  }

  async connectShard(
    shardId,
    symbols
  ) {
    const old =
      this.connections.get(
        shardId
      );

    if (old) {
      try {
        old.close();
      } catch {}
    }

    const ws =
      new WebSocket(
        BYBIT_WS
      );

    this.connections.set(
      shardId,
      ws
    );

    ws.addEventListener(
      "open",
      () => {
        const args = [];

        for (
          const symbol of symbols
        ) {
          args.push(
            `publicTrade.${symbol}`
          );

          args.push(
            `orderbook.${ORDERBOOK_DEPTH}.${symbol}`
          );

          args.push(
            `allLiquidation.${symbol}`
          );
        }

        const chunks = [];

        for (
          let i = 0;
          i < args.length;
          i += 200
        ) {
          chunks.push(
            args.slice(
              i,
              i + 200
            )
          );
        }

        for (
          const chunk of chunks
        ) {
          try {
            ws.send(
              JSON.stringify({
                op:
                  "subscribe",
                args:
                  chunk
              })
            );
          } catch {
            this.stats.errors++;
          }
        }

        this.stats.reconnects++;

        this.startPingLoop(
          ws,
          shardId
        );

        this.state.waitUntil(
          this.saveStatus()
        );
      }
    );

    ws.addEventListener(
      "message",
      event => {
        this.state.waitUntil(
          this.handleMessage(
            event.data
          )
        );
      }
    );

    ws.addEventListener(
      "close",
      () => {
        if (
          this.connections.get(
            shardId
          ) === ws
        ) {
          this.connections.delete(
            shardId
          );
        }

        this.scheduleReconnect(
          shardId,
          symbols
        );
      }
    );

    ws.addEventListener(
      "error",
      () => {
        this.stats.errors++;
      }
    );
  }

  startPingLoop(
    ws,
    shardId
  ) {
    const loop = async () => {
      while (
        this.connections.get(
          shardId
        ) === ws
      ) {
        await sleep(20000);

        if (
          this.connections.get(
            shardId
          ) !== ws
        ) {
          break;
        }

        try {
          ws.send(
            JSON.stringify({
              op: "ping"
            })
          );
        } catch {
          break;
        }
      }
    };

    this.state.waitUntil(
      loop()
    );
  }

  scheduleReconnect(
    shardId,
    symbols
  ) {
    if (
      this.reconnectTimers.has(
        shardId
      )
    ) {
      return;
    }

    const timer =
      setTimeout(
        () => {
          this.reconnectTimers.delete(
            shardId
          );

          this.state.waitUntil(
            this.connectShard(
              shardId,
              symbols
            )
          );
        },
        3000 +
        Math.floor(
          Math.random() * 3000
        )
      );

    this.reconnectTimers.set(
      shardId,
      timer
    );
  }

  async handleMessage(
    raw
  ) {
    let msg;

    try {
      msg =
        typeof raw === "string"
          ? JSON.parse(raw)
          : JSON.parse(
              new TextDecoder()
                .decode(raw)
            );
    } catch {
      return;
    }

    this.stats.lastMessage =
      Date.now();

    if (
      msg.op === "pong"
    ) {
      return;
    }

    if (
      msg.success === false
    ) {
      this.stats.errors++;
      return;
    }

    const topic =
      String(
        msg.topic || ""
      );

    if (
      topic.startsWith(
        "publicTrade."
      )
    ) {
      await this.handleTrades(
        msg
      );
      return;
    }

    if (
      topic.startsWith(
        "orderbook."
      )
    ) {
      await this.handleOrderbook(
        msg
      );
      return;
    }

    if (
      topic.startsWith(
        "allLiquidation."
      )
    ) {
      await this.handleLiquidation(
        msg
      );
      return;
    }
  }

  async handleTrades(
    msg
  ) {
    const list =
      Array.isArray(
        msg.data
      )
        ? msg.data
        : [];

    for (
      const t of list
    ) {
      const symbol =
        String(
          t.s || ""
        ).toUpperCase();

      if (!symbol) {
        continue;
      }

      const time =
        n(
          t.T,
          Date.now()
        );

      const id =
        String(
          t.i ||
          `${symbol}-${time}-${t.p}-${t.v}-${t.S}`
        );

      if (
        this.isDuplicateTrade(
          symbol,
          id
        )
      ) {
        this.stats.duplicates++;
        continue;
      }

      const minute =
        minuteStart(
          time
        );

      const key =
        `${symbol}:${minute}`;

      if (
        !this.minutes.has(
          key
        )
      ) {
        const m =
          emptyMinute(
            symbol,
            time
          );

        m.previousCvd =
          n(
            this.cvd.get(
              symbol
            )
          );

        m.previousCvdValue =
          n(
            this.cvdValue.get(
              symbol
            )
          );

        const history =
          await this.getRecentTradeValues(
            symbol,
            20
          );

        const average =
          history.length
            ? history.reduce(
                (a, b) =>
                  a + b,
                0
              ) /
              history.length
            : 0;

        m.blockThreshold =
          average > 0
            ? average *
              BLOCK_MULTIPLIER
            : 0;

        this.minutes.set(
          key,
          m
        );
      }

      const minuteData =
        this.minutes.get(
          key
        );

      const trade = {
        id,

        time,

        price:
          n(t.p),

        size:
          n(t.v),

        side:
          String(
            t.S || ""
          ).trim(),

        value:
          n(t.p) *
          n(t.v),

        isBlockTrade:
          Boolean(t.BT),

        isRPITrade:
          Boolean(t.RPI)
      };

      applyTrade(
        minuteData,
        trade
      );

      this.stats.trades++;
    }

    await this.flushOldMinutes();
  }

  isDuplicateTrade(
    symbol,
    id
  ) {
    let set =
      this.recentTradeIds.get(
        symbol
      );

    if (!set) {
      set = new Map();

      this.recentTradeIds.set(
        symbol,
        set
      );
    }

    if (
      set.has(id)
    ) {
      return true;
    }

    set.set(
      id,
      Date.now()
    );

    if (
      set.size > 5000
    ) {
      const entries =
        [...set.entries()]
          .sort(
            (a, b) =>
              a[1] - b[1]
          );

      const removeCount =
        entries.length -
        3000;

      for (
        let i = 0;
        i < removeCount;
        i++
      ) {
        set.delete(
          entries[i][0]
        );
      }
    }

    return false;
  }

  async getRecentTradeValues(
    symbol,
    limit = 20
  ) {
    const rows =
      await this.state.storage.sql
        .exec(
          `
          SELECT
            largest_trade_value
          FROM minute_data
          WHERE symbol = ?
          ORDER BY minute DESC
          LIMIT ?
          `,
          symbol,
          limit
        )
        .toArray();

    return rows
      .map(x =>
        n(
          x.largest_trade_value
        )
      )
      .filter(
        x => x > 0
      );
  }

  async handleOrderbook(
    msg
  ) {
    const data =
      msg.data || {};

    const symbol =
      String(
        data.s ||
        ""
      ).toUpperCase();

    if (!symbol) {
      return;
    }

    if (
      !this.books.has(
        symbol
      )
    ) {
      this.books.set(
        symbol,
        {
          bids:
            new Map(),

          asks:
            new Map(),

          updateId:
            0,

          sequence:
            0,

          lastTs:
            0,

          initialized:
            false
        }
      );
    }

    const book =
      this.books.get(
        symbol
      );

    const type =
      String(
        msg.type || ""
      );

    if (
      type ===
      "snapshot"
    ) {
      book.bids.clear();
      book.asks.clear();

      for (
        const row of
        data.b || []
      ) {
        const price =
          n(row[0]);

        const size =
          n(row[1]);

        if (
          price > 0 &&
          size > 0
        ) {
          book.bids.set(
            priceKey(price),
            {
              price,
              size
            }
          );
        }
      }

      for (
        const row of
        data.a || []
      ) {
        const price =
          n(row[0]);

        const size =
          n(row[1]);

        if (
          price > 0 &&
          size > 0
        ) {
          book.asks.set(
            priceKey(price),
            {
              price,
              size
            }
          );
        }
      }

      book.initialized =
        true;

    } else if (
      type ===
      "delta"
    ) {
      if (
        !book.initialized
      ) {
        return;
      }

      for (
        const row of
        data.b || []
      ) {
        const price =
          n(row[0]);

        const size =
          n(row[1]);

        if (
          price <= 0
        ) {
          continue;
        }

        const key =
          priceKey(price);

        if (
          size === 0
        ) {
          book.bids.delete(
            key
          );
        } else {
          book.bids.set(
            key,
            {
              price,
              size
            }
          );
        }
      }

      for (
        const row of
        data.a || []
      ) {
        const price =
          n(row[0]);

        const size =
          n(row[1]);

        if (
          price <= 0
        ) {
          continue;
        }

        const key =
          priceKey(price);

        if (
          size === 0
        ) {
          book.asks.delete(
            key
          );
        } else {
          book.asks.set(
            key,
            {
              price,
              size
            }
          );
        }
      }
    }

    book.updateId =
      n(
        data.u,
        book.updateId
      );

    book.sequence =
      n(
        data.seq,
        book.sequence
      );

    book.lastTs =
      n(
        msg.ts,
        Date.now()
      );

    this.stats.bookMessages++;

    const now =
      Date.now();

    if (
      now -
      this.lastSnapshot >=
      SNAPSHOT_MS
    ) {
      this.lastSnapshot =
        now;

      await this.recordBookSnapshot(
        symbol,
        book,
        now
      );
    }
  }

  async recordBookSnapshot(
    symbol,
    book,
    time
  ) {
    if (
      !book.initialized
    ) {
      return;
    }

    const bids =
      [
        ...book.bids.values()
      ]
        .sort(
          (a, b) =>
            b.price -
            a.price
        )
        .slice(
          0,
          ORDERBOOK_DEPTH
        );

    const asks =
      [
        ...book.asks.values()
      ]
        .sort(
          (a, b) =>
            a.price -
            b.price
        )
        .slice(
          0,
          ORDERBOOK_DEPTH
        );

    const bidLiquidity =
      bids.reduce(
        (total, x) =>
          total +
          x.price *
          x.size,
        0
      );

    const askLiquidity =
      asks.reduce(
        (total, x) =>
          total +
          x.price *
          x.size,
        0
      );

    const bestBid =
      bids[0]?.price ||
      0;

    const bestAsk =
      asks[0]?.price ||
      0;

    const minute =
      minuteStart(
        time
      );

    const key =
      `${symbol}:${minute}`;

    if (
      !this.minutes.has(
        key
      )
    ) {
      const m =
        emptyMinute(
          symbol,
          time
        );

      m.previousCvd =
        n(
          this.cvd.get(
            symbol
          )
        );

      m.previousCvdValue =
        n(
          this.cvdValue.get(
            symbol
          )
        );

      this.minutes.set(
        key,
        m
      );
    }

    const m =
      this.minutes.get(
        key
      );

    /*
      برای کاهش حجم ذخیره:
      حداکثر 12 snapshot در دقیقه
      یعنی یک snapshot هر 5 ثانیه.
    */

    if (
      m.bookSnapshots.length <
      12
    ) {
      m.bookSnapshots.push({
        time,

        bestBid,
        bestAsk,

        bidLiquidity,
        askLiquidity,

        bids:
          bids.map(
            x => [
              x.price,
              x.size
            ]
          ),

        asks:
          asks.map(
            x => [
              x.price,
              x.size
            ]
          )
      });
    } else {
      m.bookSnapshots.shift();

      m.bookSnapshots.push({
        time,

        bestBid,
        bestAsk,

        bidLiquidity,
        askLiquidity,

        bids:
          bids.map(
            x => [
              x.price,
              x.size
            ]
          ),

        asks:
          asks.map(
            x => [
              x.price,
              x.size
            ]
          )
      });
    }

    m.maxBidLiquidity =
      Math.max(
        m.maxBidLiquidity,
        bidLiquidity
      );

    m.maxAskLiquidity =
      Math.max(
        m.maxAskLiquidity,
        askLiquidity
      );

    m.bookSnapshotCount++;

    const count =
      m.bookSnapshotCount;

    m.avgBidLiquidity =
      (
        (
          m.avgBidLiquidity *
          (count - 1)
        ) +
        bidLiquidity
      ) /
      count;

    m.avgAskLiquidity =
      (
        (
          m.avgAskLiquidity *
          (count - 1)
        ) +
        askLiquidity
      ) /
      count;

    m.lastBestBid =
      bestBid;

    m.lastBestAsk =
      bestAsk;
  }

  async handleLiquidation(
    msg
  ) {
    const data =
      msg.data;

    const list =
      Array.isArray(data)
        ? data
        : data
          ? [data]
          : [];

    for (
      const x of list
    ) {
      const symbol =
        String(
          x.s || ""
        ).toUpperCase();

      if (!symbol) {
        continue;
      }

      const time =
        n(
          x.T,
          Date.now()
        );

      const minute =
        minuteStart(
          time
        );

      const key =
        `${symbol}:${minute}`;

      if (
        !this.minutes.has(
          key
        )
      ) {
        const m =
          emptyMinute(
            symbol,
            time
          );

        m.previousCvd =
          n(
            this.cvd.get(
              symbol
            )
          );

        m.previousCvdValue =
          n(
            this.cvdValue.get(
              symbol
            )
          );

        this.minutes.set(
          key,
          m
        );
      }

      const m =
        this.minutes.get(
          key
        );

      const size =
        n(x.v);

      const price =
        n(x.p);

      if (
        size <= 0 ||
        price <= 0
      ) {
        continue;
      }

      const value =
        size *
        price;

      const side =
        String(
          x.S || ""
        ).trim();

      if (
        side === "Buy"
      ) {
        m.liquidationBuyVolume +=
          size;

        m.liquidationBuyValue +=
          value;

      } else if (
        side === "Sell"
      ) {
        m.liquidationSellVolume +=
          size;

        m.liquidationSellValue +=
          value;
      }

      m.liquidationCount++;

      this.stats.liquidations++;
    }

    await this.flushOldMinutes();
  }

  async flushOldMinutes() {
    const now =
      minuteStart(
        Date.now()
      );

    const ready = [];

    for (
      const [key, m]
      of this.minutes
    ) {
      if (
        m.minute <
        now
      ) {
        ready.push(
          [key, m]
        );
      }
    }

    for (
      const [key, m]
      of ready
    ) {
      try {
        const finalized =
          finalizeMinute(
            m
          );

        this.cvd.set(
          m.symbol,
          finalized.cumulativeDelta
        );

        this.cvdValue.set(
          m.symbol,
          finalized.cumulativeDeltaValue
        );

        await this.saveMinute(
          finalized
        );

        this.minutes.delete(
          key
        );

      } catch {
        this.stats.errors++;
      }
    }

    await this.cleanup();
  }

  async saveMinute(m) {
    const payload = {
      symbol:
        m.symbol,

      minute:
        m.minute,

      open:
        m.open,

      high:
        m.high,

      low:
        m.low,

      close:
        m.close,

      tradeCount:
        m.tradeCount,

      buyVolume:
        m.buyVolume,

      sellVolume:
        m.sellVolume,

      buyValue:
        m.buyValue,

      sellValue:
        m.sellValue,

      delta:
        m.delta,

      deltaValue:
        m.deltaValue,

      cumulativeDelta:
        m.cumulativeDelta,

      cumulativeDeltaValue:
        m.cumulativeDeltaValue,

      bidLevels:
        m.bidLevels,

      askLevels:
        m.askLevels,

      levels:
        m.levels,

      largestTradeValue:
        m.largestTradeValue,

      blocks:
        m.blocks,

      liquidationBuyVolume:
        m.liquidationBuyVolume,

      liquidationSellVolume:
        m.liquidationSellVolume,

      liquidationBuyValue:
        m.liquidationBuyValue,

      liquidationSellValue:
        m.liquidationSellValue,

      liquidationCount:
        m.liquidationCount,

      bookSnapshots:
        m.bookSnapshots,

      maxBidLiquidity:
        m.maxBidLiquidity,

      maxAskLiquidity:
        m.maxAskLiquidity,

      avgBidLiquidity:
        m.avgBidLiquidity,

      avgAskLiquidity:
        m.avgAskLiquidity,

      bookSnapshotCount:
        m.bookSnapshotCount,

      lastBestBid:
        m.lastBestBid,

      lastBestAsk:
        m.lastBestAsk
    };

    await this.state.storage.sql.exec(
      `
      INSERT OR REPLACE INTO minute_data
      (
        symbol,
        minute,

        open,
        high,
        low,
        close,

        trade_count,

        buy_volume,
        sell_volume,

        buy_value,
        sell_value,

        delta,
        delta_value,

        cumulative_delta,
        cumulative_delta_value,

        largest_trade_value,

        liquidation_buy_volume,
        liquidation_sell_volume,

        liquidation_buy_value,
        liquidation_sell_value,

        liquidation_count,

        max_bid_liquidity,
        max_ask_liquidity,

        avg_bid_liquidity,
        avg_ask_liquidity,

        last_best_bid,
        last_best_ask,

        payload
      )
      VALUES (
        ?,?,?,?,?,?,
        ?,?,?,?,?,
        ?,?,
        ?,?,
        ?,
        ?,?,
        ?,?,
        ?,
        ?,?,
        ?,?,
        ?,?,
        ?
      )
      `,
      m.symbol,
      m.minute,

      m.open,
      m.high,
      m.low,
      m.close,

      m.tradeCount,

      m.buyVolume,
      m.sellVolume,

      m.buyValue,
      m.sellValue,

      m.delta,
      m.deltaValue,

      m.cumulativeDelta,
      m.cumulativeDeltaValue,

      m.largestTradeValue,

      m.liquidationBuyVolume,
      m.liquidationSellVolume,

      m.liquidationBuyValue,
      m.liquidationSellValue,

      m.liquidationCount,

      m.maxBidLiquidity,
      m.maxAskLiquidity,

      m.avgBidLiquidity,
      m.avgAskLiquidity,

      m.lastBestBid,
      m.lastBestAsk,

      JSON.stringify(payload)
    );
  }

  async cleanup() {
    const cutoff =
      Date.now() -
      RETENTION_MINUTES *
      MINUTE_MS;

    await this.state.storage.sql.exec(
      `
      DELETE FROM minute_data
      WHERE minute < ?
      `,
      cutoff
    );
  }

  async history(
    symbol,
    from,
    to
  ) {
    const rows =
      await this.state.storage.sql
        .exec(
          `
          SELECT *
          FROM minute_data
          WHERE symbol = ?
            AND minute >= ?
            AND minute <= ?
          ORDER BY minute ASC
          `,
          symbol,
          from,
          to
        )
        .toArray();

    return rows.map(
      row => {
        try {
          return JSON.parse(
            row.payload ||
            "{}"
          );
        } catch {
          return {};
        }
      }
    );
  }

  async latest(
    symbol
  ) {
    const rows =
      await this.state.storage.sql
        .exec(
          `
          SELECT payload
          FROM minute_data
          WHERE symbol = ?
          ORDER BY minute DESC
          LIMIT 1
          `,
          symbol
        )
        .toArray();

    if (
      !rows.length
    ) {
      return null;
    }

    try {
      return JSON.parse(
        rows[0].payload
      );
    } catch {
      return null;
    }
  }

  async status() {
    const rows =
      await this.state.storage.sql
        .exec(
          `
          SELECT
            COUNT(*) AS rows,
            MIN(minute) AS oldest,
            MAX(minute) AS newest,
            COUNT(DISTINCT symbol) AS symbols
          FROM minute_data
          `
        )
        .toArray();

    return {
      ok:
        true,

      version:
        VERSION,

      symbols:
        this.symbols.length,

      connections:
        this.connections.size,

      stats:
        this.stats,

      database:
        rows[0] || {}
    };
  }

  async saveStatus() {
    await this.state.storage.put(
      "collector_status",
      {
        time:
          Date.now(),

        symbols:
          this.symbols.length,

        connections:
          this.connections.size,

        stats:
          this.stats
      }
    );
  }

  async disconnectAll() {
    for (
      const ws of
      this.connections.values()
    ) {
      try {
        ws.close();
      } catch {}
    }

    this.connections.clear();

    for (
      const timer of
      this.reconnectTimers.values()
    ) {
      try {
        clearTimeout(timer);
      } catch {}
    }

    this.reconnectTimers.clear();
  }

  async fetch(
    request
  ) {
    await this.initialize();

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    if (
      path ===
      "/init"
    ) {
      try {
        const symbols =
          await getSymbols();

        await this.setSymbols(
          symbols
        );

        return json({
          ok:
            true,

          version:
            VERSION,

          symbols:
            symbols.length,

          sample:
            symbols.slice(
              0,
              20
            )
        });

      } catch (error) {
        return json(
          {
            ok:
              false,

            error:
              error?.message ||
              String(error)
          },
          500
        );
      }
    }

    if (
      path ===
      "/symbols"
    ) {
      return json({
        ok:
          true,

        symbols:
          this.symbols
      });
    }

    if (
      path ===
      "/status"
    ) {
      return json(
        await this.status()
      );
    }

    if (
      path ===
      "/latest"
    ) {
      const symbol =
        String(
          url.searchParams.get(
            "symbol"
          ) || ""
        )
          .trim()
          .toUpperCase();

      if (
        !safeSymbol(
          symbol
        )
      ) {
        return json(
          {
            ok:
              false,

            error:
              "Invalid symbol"
          },
          400
        );
      }

      return json({
        ok:
          true,

        data:
          await this.latest(
            symbol
          )
      });
    }

    if (
      path ===
      "/history"
    ) {
      const symbol =
        String(
          url.searchParams.get(
            "symbol"
          ) || ""
        )
          .trim()
          .toUpperCase();

      if (
        !safeSymbol(
          symbol
        )
      ) {
        return json(
          {
            ok:
              false,

            error:
              "Invalid symbol"
          },
          400
        );
      }

      const to =
        n(
          url.searchParams.get(
            "to"
          ),
          Date.now()
        );

      const from =
        n(
          url.searchParams.get(
            "from"
          ),
          to -
            RETENTION_MINUTES *
            MINUTE_MS
        );

      return json({
        ok:
          true,

        symbol,

        from,

        to,

        data:
          await this.history(
            symbol,
            from,
            to
          )
      });
    }

    return json({
      ok:
        true,

      collector:
        true,

      version:
        VERSION
    });
  }
}

export class CollectorDO
  extends DurableObject {

  constructor(
    ctx,
    env
  ) {
    super(
      ctx,
      env
    );

    this.collector =
      new CollectorShard(
        ctx,
        env
      );
  }

  async fetch(
    request
  ) {
    return this.collector.fetch(
      request
    );
  }
}

export default {
  async fetch(
    request,
    env
  ) {
    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status:
            204,

          headers: {
            "access-control-allow-origin":
              "*",

            "access-control-allow-methods":
              "GET,POST,OPTIONS",

            "access-control-allow-headers":
              "Content-Type"
          }
        }
      );
    }

    const url =
      new URL(
        request.url
      );

    if (
      url.pathname ===
      "/api/health"
    ) {
      return json({
        ok:
          true,

        version:
          VERSION,

        time:
          Date.now()
      });
    }

    const id =
      env.COLLECTOR.idFromName(
        "MAIN"
      );

    const stub =
      env.COLLECTOR.get(
        id
      );

    if (
      url.pathname ===
      "/api/init"
    ) {
      const target =
        new URL(
          request.url
        );

      target.pathname =
        "/init";

      return stub.fetch(
        target.toString()
      );
    }

    if (
      url.pathname ===
      "/api/status"
    ) {
      const target =
        new URL(
          request.url
        );

      target.pathname =
        "/status";

      return stub.fetch(
        target.toString()
      );
    }

    if (
      url.pathname ===
      "/api/symbols"
    ) {
      const target =
        new URL(
          request.url
        );

      target.pathname =
        "/symbols";

      return stub.fetch(
        target.toString()
      );
    }

    if (
      url.pathname ===
      "/api/latest"
    ) {
      const target =
        new URL(
          request.url
        );

      target.pathname =
        "/latest";

      return stub.fetch(
        target.toString()
      );
    }

    if (
      url.pathname ===
      "/api/history"
    ) {
      const target =
        new URL(
          request.url
        );

      target.pathname =
        "/history";

      return stub.fetch(
        target.toString()
      );
    }

    return env.ASSETS.fetch(
      request
    );
  }
};
