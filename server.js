// ─────────────────────────────────────────────
// RJ Terminal · Intelligence — Railway Backend
// Securely proxies Massive.com API calls.
// Your MASSIVE_API_KEY lives only here as an
// environment variable — never in the frontend.
// ─────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS — only allow your Vercel frontend
// During dev we also allow localhost:5173
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  /https:\/\/rj-terminal.*\.vercel\.app$/,
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl / server-to-server
    const ok = ALLOWED_ORIGINS.some(o =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    cb(ok ? null : new Error("Not allowed by CORS"), ok);
  }
}));

app.use(express.json());

// ── Massive API base + key from environment variable
const MASSIVE_BASE = "https://api.massive.com/v3";
const MASSIVE_KEY  = process.env.MASSIVE_API_KEY;

if (!MASSIVE_KEY) {
  console.warn("⚠️  MASSIVE_API_KEY environment variable not set");
}

// ── Helper: fetch from Massive with auth header
async function massiveFetch(path, params = {}) {
  const url = new URL(`${MASSIVE_BASE}${path}`);
  url.searchParams.set("apiKey", MASSIVE_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${MASSIVE_KEY}`,
      "Content-Type":  "application/json",
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Massive ${res.status}: ${text}`);
  }
  return res.json();
}

// ── ET date helpers
function etToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function etYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// ─────────────────────────────────────────────
// ROUTE 1 — GET /api/gappers
// Returns top 20 premarket gappers under $500M
// market cap, sorted by gap % descending.
// Called every 5 minutes by the frontend.
// ─────────────────────────────────────────────
app.get("/api/gappers", async (req, res) => {
  try {
    const today = etToday();

    // Massive snapshot endpoint — US stocks with premarket data
    // Returns tickers with pm change %, volume, market cap
    const data = await massiveFetch("/stocks/snapshots", {
      date:     today,
      market:   "premarket",
      sort:     "changePercent",
      order:    "desc",
      limit:    100,
      exchange: "US",
    });

    const results = (data.results || data.data || data || [])
      .filter(s =>
        s.marketCap && s.marketCap < 500_000_000 &&   // under $500M
        s.changePercent > 0 &&                         // positive gap
        s.symbol && s.symbol.length <= 5               // valid ticker
      )
      .slice(0, 20)
      .map((s, i) => ({
        rank:          i + 1,
        sym:           s.symbol,
        price:         s.price         || s.lastPrice  || null,
        open:          s.open          || null,
        prevClose:     s.prevClose     || s.previousClose || null,
        high:          s.high          || null,
        low:           s.low           || null,
        volume:        s.volume        || s.preMarketVolume || null,
        changePercent: s.changePercent || null,
        marketCap:     s.marketCap     || null,
        float:         s.float         || null,
        rvol:          s.rvol          || s.relativeVolume || null,
      }));

    res.json({ ok: true, data: results, timestamp: Date.now() });

  } catch (err) {
    console.error("GET /api/gappers error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2 — GET /api/quote/:symbol
// Real-time quote for a single ticker.
// Returns price, open, prevClose, high, volume.
// ─────────────────────────────────────────────
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const sym  = req.params.symbol.toUpperCase();
    const data = await massiveFetch(`/stocks/quotes/${sym}`);

    res.json({
      ok: true,
      data: {
        sym,
        price:         data.price         || data.lastPrice  || null,
        open:          data.open           || null,
        prevClose:     data.prevClose      || data.previousClose || null,
        high:          data.high           || null,
        low:           data.low            || null,
        volume:        data.volume         || null,
        changePercent: data.changePercent  || null,
        rvol:          data.rvol           || data.relativeVolume || null,
        marketCap:     data.marketCap      || null,
        float:         data.float          || null,
      },
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error(`GET /api/quote/${req.params.symbol} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 3 — GET /api/pmh/:symbol
// Premarket high painted detection.
// Uses Massive 1-min OHLCV premarket data.
// Returns pmhPrice, painted (bool), testCount.
// ─────────────────────────────────────────────
app.get("/api/pmh/:symbol", async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const today = etToday();

    // 1-minute bars for premarket session (4:00am–9:30am ET)
    const data = await massiveFetch(`/stocks/bars/${sym}`, {
      date:       today,
      resolution: "1",
      session:    "premarket",
    });

    const bars = data.results || data.bars || data || [];

    if (!bars.length) {
      return res.json({ ok: true, data: { sym, painted: false, pmhPrice: null, testCount: 0 } });
    }

    // Find the premarket high
    const pmhPrice = Math.max(...bars.map(b => b.high || b.h || 0));
    const pmhIndex = bars.findIndex(b => (b.high || b.h) === pmhPrice);
    const threshold = pmhPrice * 0.985; // within 1.5%

    // Count bars AFTER the pmhIndex that came within 1.5% of the high
    const testCount = bars
      .slice(pmhIndex + 1)
      .filter(b => (b.high || b.h || 0) >= threshold)
      .length;

    const painted = testCount >= 2;

    res.json({
      ok: true,
      data: { sym, pmhPrice, painted, testCount },
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error(`GET /api/pmh/${req.params.symbol} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4 — GET /api/intraday/:symbol
// 1-minute intraday bars for current session.
// Used for: half-spike computation, MDP base
// consolidation timer, RVOL calculation.
// ─────────────────────────────────────────────
app.get("/api/intraday/:symbol", async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const today = etToday();

    const data = await massiveFetch(`/stocks/bars/${sym}`, {
      date:       today,
      resolution: "1",
      session:    "regular",
    });

    const bars = (data.results || data.bars || data || []).map(b => ({
      t:    b.timestamp || b.t,
      open: b.open  || b.o,
      high: b.high  || b.h,
      low:  b.low   || b.l,
      close:b.close || b.c,
      vol:  b.volume|| b.v,
    }));

    if (!bars.length) {
      return res.json({ ok: true, data: { sym, bars: [], mdp: null } });
    }

    // Compute MDP signals from bars
    const sessionOpen  = bars[0].open;
    const sessionHigh  = Math.max(...bars.map(b => b.high));
    const halfSpike    = sessionOpen + (sessionHigh - sessionOpen) / 2;
    const currentPrice = bars[bars.length - 1].close;

    // Consolidation: find how many consecutive minutes price stayed
    // within a 3% range ending at the current bar
    let baseMinutes = 0;
    const rangeThreshold = 0.03;
    for (let i = bars.length - 1; i >= 1; i--) {
      const windowHigh = Math.max(...bars.slice(i - 1, bars.length).map(b => b.high));
      const windowLow  = Math.min(...bars.slice(i - 1, bars.length).map(b => b.low));
      if ((windowHigh - windowLow) / windowLow <= rangeThreshold) {
        baseMinutes = bars.length - i + 1;
      } else {
        break;
      }
    }

    res.json({
      ok: true,
      data: {
        sym,
        bars,
        mdp: {
          sessionOpen,
          sessionHigh,
          halfSpike:     parseFloat(halfSpike.toFixed(4)),
          currentPrice,
          aboveOpen:     currentPrice > sessionOpen,
          aboveHalfSpike:currentPrice > halfSpike,
          baseMinutes,
        }
      },
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error(`GET /api/intraday/${req.params.symbol} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 5 — GET /api/rvol/:symbol
// Relative volume vs 30-day average.
// ─────────────────────────────────────────────
app.get("/api/rvol/:symbol", async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const today = etToday();

    // Get today's volume
    const quoteData = await massiveFetch(`/stocks/quotes/${sym}`);
    const todayVol  = quoteData.volume || 0;

    // Get 30-day historical daily bars for average volume
    const histData = await massiveFetch(`/stocks/bars/${sym}`, {
      resolution: "D",
      limit:      30,
    });
    const histBars = histData.results || histData.bars || histData || [];
    const avgVol   = histBars.length
      ? histBars.reduce((sum, b) => sum + (b.volume || b.v || 0), 0) / histBars.length
      : 0;

    const rvol = avgVol > 0 ? parseFloat((todayVol / avgVol).toFixed(1)) : null;

    res.json({
      ok: true,
      data: { sym, todayVol, avgVol: Math.round(avgVol), rvol },
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error(`GET /api/rvol/${req.params.symbol} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK — Railway uses this to confirm
// the server is alive
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok:        true,
    service:   "RJ Terminal Backend",
    timestamp: Date.now(),
    massive:   MASSIVE_KEY ? "key set ✓" : "⚠️ key missing",
  });
});

app.listen(PORT, () => {
  console.log(`RJ Terminal backend running on port ${PORT}`);
});
