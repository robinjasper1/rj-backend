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
const MASSIVE_BASE = "https://api.massive.com";
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
// DEBUG — GET /api/debug
// Shows exact URL being called + raw response
// from Massive. Remove after fixing endpoints.
// ─────────────────────────────────────────────
app.get("/api/debug", async (req, res) => {
  const testUrl = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`;
  try {
    const r    = await fetch(testUrl, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    const text = await r.text();
    res.json({
      urlCalled:  testUrl.replace(MASSIVE_KEY, "KEY_HIDDEN"),
      status:     r.status,
      statusText: r.statusText,
      body:       text.slice(0, 500), // first 500 chars of response
    });
  } catch(e) {
    res.json({ urlCalled: testUrl.replace(MASSIVE_KEY,"KEY_HIDDEN"), error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 1 — GET /api/gappers
// Uses Massive Top Market Movers endpoint —
// returns top 20 gainers directly, no filtering.
// Cleared at 3:30am ET, repopulates from 4am ET.
// ─────────────────────────────────────────────
app.get("/api/gappers", async (req, res) => {
  try {
    const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`;
    const r   = await fetch(url, {
      headers: { "Authorization": `Bearer ${MASSIVE_KEY}` }
    });
    if (!r.ok) throw new Error(`Massive ${r.status}: ${await r.text()}`);
    const data = await r.json();

    const tickers = data.tickers || data.results || [];

    const results = tickers
      .filter(s => s.ticker && s.ticker.length <= 5 && /^[A-Z]+$/.test(s.ticker))
      .map((s, i) => ({
        rank:          i + 1,
        sym:           s.ticker,
        price:         s.lastTrade?.p || s.day?.c || null,
        open:          s.day?.o       || null,
        prevClose:     s.prevDay?.c   || null,
        high:          s.day?.h       || null,
        low:           s.day?.l       || null,
        volume:        s.day?.v       || s.min?.v || null,
        changePercent: s.todaysChangePerc || null,
        marketCap:     null,
        float:         null,
        rvol:          null,
      }));

    res.json({ ok: true, data: results, count: results.length, timestamp: Date.now() });

  } catch (err) {
    console.error("GET /api/gappers error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2 — GET /api/quote/:symbol
// Real-time snapshot for a single ticker.
// ─────────────────────────────────────────────
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${sym}?apiKey=${MASSIVE_KEY}`;
    const r   = await fetch(url, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    if (!r.ok) throw new Error(`Massive ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const s = data.ticker || data;

    res.json({
      ok: true,
      data: {
        sym,
        price:         s.lastTrade?.p || s.day?.c || null,
        open:          s.day?.o       || null,
        prevClose:     s.prevDay?.c   || null,
        high:          s.day?.h       || null,
        low:           s.day?.l       || null,
        volume:        s.day?.v       || null,
        changePercent: s.todaysChangePerc || null,
        rvol:          null,
        marketCap:     null,
        float:         null,
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
// Uses Massive 1-min aggregate bars.
// ─────────────────────────────────────────────
app.get("/api/pmh/:symbol", async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const today = etToday();

    // Massive aggregate bars: /v2/aggs/ticker/{sym}/range/1/minute/{from}/{to}
    // Premarket = 4:00am–9:30am ET = UTC 08:00–13:30
    const fromMs = new Date(`${today}T08:00:00Z`).getTime();
    const toMs   = new Date(`${today}T13:30:00Z`).getTime();

    const url = `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=300&apiKey=${MASSIVE_KEY}`;
    const r   = await fetch(url, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    if (!r.ok) throw new Error(`Massive ${r.status}: ${await r.text()}`);
    const data = await r.json();

    const bars = data.results || [];

    if (!bars.length) {
      return res.json({ ok: true, data: { sym, painted: false, pmhPrice: null, testCount: 0 } });
    }

    const pmhPrice = Math.max(...bars.map(b => b.h || 0));
    const pmhIndex = bars.findIndex(b => b.h === pmhPrice);
    const threshold = pmhPrice * 0.985;

    const testCount = bars
      .slice(pmhIndex + 1)
      .filter(b => (b.h || 0) >= threshold)
      .length;

    res.json({
      ok: true,
      data: { sym, pmhPrice, painted: testCount >= 2, testCount },
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error(`GET /api/pmh/${req.params.symbol} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4 — GET /api/intraday/:symbol
// 1-minute regular session bars + MDP signals.
// ─────────────────────────────────────────────
app.get("/api/intraday/:symbol", async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const today = etToday();

    // Regular session: 9:30am–4:00pm ET = UTC 13:30–20:00
    const fromMs = new Date(`${today}T13:30:00Z`).getTime();
    const toMs   = new Date(`${today}T20:00:00Z`).getTime();

    const url = `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=400&apiKey=${MASSIVE_KEY}`;
    const r   = await fetch(url, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    if (!r.ok) throw new Error(`Massive ${r.status}: ${await r.text()}`);
    const data = await r.json();

    const bars = (data.results || []).map(b => ({
      t: b.t, open: b.o, high: b.h, low: b.l, close: b.c, vol: b.v,
    }));

    if (!bars.length) {
      return res.json({ ok: true, data: { sym, bars: [], mdp: null } });
    }

    const sessionOpen  = bars[0].open;
    const sessionHigh  = Math.max(...bars.map(b => b.high));
    const halfSpike    = sessionOpen + (sessionHigh - sessionOpen) / 2;
    const currentPrice = bars[bars.length - 1].close;

    // Consolidation: consecutive minutes within 3% range from current bar backwards
    let baseMinutes = 0;
    for (let i = bars.length - 1; i >= 1; i--) {
      const slice     = bars.slice(i - 1);
      const wHigh     = Math.max(...slice.map(b => b.high));
      const wLow      = Math.min(...slice.map(b => b.low));
      if ((wHigh - wLow) / wLow <= 0.03) baseMinutes = bars.length - i + 1;
      else break;
    }

    res.json({
      ok: true,
      data: {
        sym, bars,
        mdp: {
          sessionOpen,
          sessionHigh,
          halfSpike:      parseFloat(halfSpike.toFixed(4)),
          currentPrice,
          aboveOpen:      currentPrice > sessionOpen,
          aboveHalfSpike: currentPrice > halfSpike,
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

    // Today's snapshot for current volume
    const snapUrl = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${sym}?apiKey=${MASSIVE_KEY}`;
    const snapR   = await fetch(snapUrl, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    const snapData= await snapR.json();
    const todayVol= snapData.ticker?.day?.v || 0;

    // 30-day daily bars for average
    const toDate   = today;
    const fromDate = new Date(Date.now() - 30*86400000).toLocaleDateString("en-CA",{timeZone:"America/New_York"});
    const histUrl  = `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=30&apiKey=${MASSIVE_KEY}`;
    const histR    = await fetch(histUrl, { headers: { "Authorization": `Bearer ${MASSIVE_KEY}` } });
    const histData = await histR.json();
    const histBars = histData.results || [];
    const avgVol   = histBars.length ? histBars.reduce((s,b)=>s+(b.v||0),0)/histBars.length : 0;
    const rvol     = avgVol > 0 ? parseFloat((todayVol/avgVol).toFixed(1)) : null;

    res.json({ ok:true, data:{sym, todayVol, avgVol:Math.round(avgVol), rvol}, timestamp:Date.now() });
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
