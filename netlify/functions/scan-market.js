const BYBIT_BASE = "https://api.bybit.com";
const BINANCE_BASE = "https://fapi.binance.com";

// ─── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaArray(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    result.push(e);
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function pivotLevels(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const mid = (resistance + support) / 2;
  return { support, resistance, mid };
}

function volumeAnalysis(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const vols = recent.map((c) => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const lastVol = candles[candles.length - 1].volume;
  const volRatio = lastVol / avgVol;
  // Volume trend: compare last 5 vs previous 5
  const last5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prev5 = vols.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
  const volTrend = last5 / prev5;
  return { avgVol, lastVol, volRatio, volTrend };
}

// Detect bullish candle patterns
function candlePatterns(candles) {
  const len = candles.length;
  if (len < 3) return { bullish: false, pattern: "insufficient data" };
  const c = candles[len - 1];
  const p1 = candles[len - 2];
  const p2 = candles[len - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const lowerWick = Math.min(c.close, c.open) - c.low;
  const upperWick = c.high - Math.max(c.close, c.open);

  // Bullish engulfing
  if (c.close > c.open && p1.close < p1.open && c.close > p1.open && c.open < p1.close) {
    return { bullish: true, pattern: "Bullish Engulfing" };
  }
  // Hammer
  if (lowerWick > body * 2 && upperWick < body * 0.5 && body > 0) {
    return { bullish: true, pattern: "Hammer" };
  }
  // Morning star
  if (p2.close < p2.open && Math.abs(p1.close - p1.open) < (p1.high - p1.low) * 0.3 && c.close > c.open && c.close > (p2.open + p2.close) / 2) {
    return { bullish: true, pattern: "Morning Star" };
  }
  // Strong green candle
  if (c.close > c.open && body > range * 0.6) {
    return { bullish: true, pattern: "Strong Bullish Candle" };
  }
  return { bullish: c.close > c.open, pattern: c.close > c.open ? "Bullish Close" : "Bearish Close" };
}

// ─── Binance Futures API ─────────────────────────────────────────────────────
async function getBinance24hrTickers() {
  const url = `${BINANCE_BASE}/fapi/v1/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  return res.json();
}

async function getBinanceKlines(symbol, interval, limit = 100) {
  const url = `${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.map((k) => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    time: k[0],
  }));
}

async function getBinanceOpenInterest(symbol) {
  try {
    const url = `${BINANCE_BASE}/fapi/v1/openInterest?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return parseFloat(d.openInterest);
  } catch {
    return null;
  }
}

// ─── Core Analysis ───────────────────────────────────────────────────────────
async function analyzeSymbol(symbol, priceChange24h, currentPrice) {
  // Fetch candles for 15m and 1h
  const [candles15m, candles1h] = await Promise.all([
    getBinanceKlines(symbol, "15m", 120),
    getBinanceKlines(symbol, "1h", 120),
  ]);

  if (!candles15m || !candles1h || candles15m.length < 60 || candles1h.length < 60) {
    return { symbol, status: "DISCARD", reason: "Datos de velas insuficientes" };
  }

  const closes15m = candles15m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);

  // ── EMA Alignment ──
  const ema20_15m = ema(closes15m, 20);
  const ema50_15m = ema(closes15m, 50);
  const ema200_15m = ema(closes15m, 100); // use 100 as proxy for 200 on 15m
  const ema20_1h = ema(closes1h, 20);
  const ema50_1h = ema(closes1h, 50);
  const price = currentPrice;

  const bullish15m = price > ema20_15m && ema20_15m > ema50_15m;
  const bullish1h = price > ema20_1h && ema20_1h > ema50_1h;
  const emaAligned = bullish15m && bullish1h;

  if (!emaAligned) {
    return {
      symbol,
      status: "DISCARD",
      reason: `EMAs no alineadas alcistas (15m: ${bullish15m ? "✓" : "✗"}, 1h: ${bullish1h ? "✓" : "✗"})`,
    };
  }

  // ── RSI ──
  const rsi14_15m = rsi(closes15m, 14);
  const rsi14_1h = rsi(closes1h, 14);

  if (rsi14_15m === null || rsi14_1h === null) {
    return { symbol, status: "DISCARD", reason: "RSI no calculable" };
  }

  // RSI overbought check (avoid chasing)
  if (rsi14_15m > 80) {
    return { symbol, status: "WAIT", reason: `RSI 15m sobrecomprado (${rsi14_15m.toFixed(1)}) – esperar retroceso`, rsi15m: rsi14_15m, rsi1h: rsi14_1h };
  }
  if (rsi14_15m < 40) {
    return { symbol, status: "DISCARD", reason: `RSI 15m débil (${rsi14_15m.toFixed(1)})` };
  }

  // ── Volume Analysis ──
  const vol15m = volumeAnalysis(candles15m, 20);
  const vol1h = volumeAnalysis(candles1h, 20);

  if (vol15m.volRatio < 0.8) {
    return { symbol, status: "DISCARD", reason: `Volumen 15m bajo (${vol15m.volRatio.toFixed(2)}x media)` };
  }

  // Volume should be increasing with price
  if (vol15m.volTrend < 0.9 && priceChange24h > 5) {
    return { symbol, status: "WAIT", reason: `Precio sube sin acompañamiento de volumen (tendencia vol: ${vol15m.volTrend.toFixed(2)}x)`, rsi15m: rsi14_15m, rsi1h: rsi14_1h };
  }

  // ── Open Interest ──
  const oi = await getBinanceOpenInterest(symbol);

  // ── Pivot / Support / Resistance ──
  const levels15m = pivotLevels(candles15m, 40);
  const levels1h = pivotLevels(candles1h, 60);

  const support = Math.max(levels15m.support, levels1h.support * 0.998);
  const resistance = Math.min(levels15m.resistance, levels1h.resistance * 1.002);
  const nearSupport = (price - support) / price < 0.04; // within 4% of support

  // ── ATR for volatility ──
  const atr15m = atr(candles15m, 14);
  const atr1h = atr(candles1h, 14);

  // ── Candle Patterns ──
  const pattern15m = candlePatterns(candles15m);
  const pattern1h = candlePatterns(candles1h);

  // ── EMA arrays for slope ──
  const ema20arr = emaArray(closes1h, 20);
  const emaSlope = ema20arr.length >= 3
    ? (ema20arr[ema20arr.length - 1] - ema20arr[ema20arr.length - 3]) / ema20arr[ema20arr.length - 3] * 100
    : 0;

  // ── Score System ──
  let score = 0;
  const scoreDetails = [];

  // EMA alignment (already confirmed above)
  score += 25;
  scoreDetails.push("✓ EMAs alcistas 15m+1h (+25)");

  // RSI in ideal zone 50-70
  if (rsi14_15m >= 50 && rsi14_15m <= 70) { score += 15; scoreDetails.push(`✓ RSI 15m ideal (${rsi14_15m.toFixed(1)}) (+15)`); }
  else if (rsi14_15m > 70 && rsi14_15m <= 80) { score += 8; scoreDetails.push(`~ RSI 15m alto (${rsi14_15m.toFixed(1)}) (+8)`); }

  if (rsi14_1h >= 50 && rsi14_1h <= 70) { score += 10; scoreDetails.push(`✓ RSI 1h ideal (${rsi14_1h.toFixed(1)}) (+10)`); }

  // Volume
  if (vol15m.volRatio >= 1.5) { score += 15; scoreDetails.push(`✓ Volumen 15m fuerte (${vol15m.volRatio.toFixed(2)}x) (+15)`); }
  else if (vol15m.volRatio >= 1.0) { score += 8; scoreDetails.push(`~ Volumen 15m normal (${vol15m.volRatio.toFixed(2)}x) (+8)`); }
  if (vol15m.volTrend >= 1.1) { score += 10; scoreDetails.push(`✓ Tendencia volumen alcista (+10)`); }

  // Bullish candle patterns
  if (pattern15m.bullish) { score += 10; scoreDetails.push(`✓ Patrón alcista 15m: ${pattern15m.pattern} (+10)`); }
  if (pattern1h.bullish) { score += 5; scoreDetails.push(`✓ Vela alcista 1h (+5)`); }

  // Near support (good entry zone)
  if (nearSupport) { score += 10; scoreDetails.push(`✓ Precio cerca de soporte (+10)`); }

  // EMA slope
  if (emaSlope > 0.1) { score += 5; scoreDetails.push(`✓ Pendiente EMA20 positiva (+5)`); }

  // ── Risk/Reward Calculation ──
  // Entry: current price or slight pullback
  const entry = price;

  // Stop Loss: below nearest dynamic support (EMA50_15m or support level)
  const dynamicSupport = Math.max(ema50_15m * 0.998, support);
  const stopLoss = Math.min(dynamicSupport * 0.995, entry * (1 - (atr15m / price) * 1.5));

  // TP1: Conservative – 1:1.5 R:R minimum, capped at resistance
  const risk = entry - stopLoss;
  const tp1Raw = entry + risk * 1.5;
  const tp1 = Math.min(tp1Raw, resistance * 0.998);

  // TP2: Macro target – resistance or Fibonacci extension
  const fib618 = support + (resistance - support) * 1.618;
  const tp2 = Math.min(fib618, resistance * 1.05);

  const riskReward1 = (tp1 - entry) / risk;
  const riskReward2 = (tp2 - entry) / risk;

  // Minimum R:R check
  if (riskReward1 < 1.2) {
    return { symbol, status: "DISCARD", reason: `R:R insuficiente (${riskReward1.toFixed(2)}) – spread muy estrecho` };
  }

  // Determine status
  let status;
  if (score >= 65 && pattern15m.bullish && vol15m.volRatio >= 1.0 && riskReward1 >= 1.5) {
    status = "ENTER";
  } else if (score >= 45) {
    status = "WAIT";
  } else {
    status = "DISCARD";
  }

  // Estimated profit % for TP1 (should be ~5-15%)
  const tp1Pct = ((tp1 - entry) / entry) * 100;
  const slPct = ((entry - stopLoss) / entry) * 100;

  return {
    symbol,
    status,
    score,
    scoreDetails,
    price: entry,
    priceChange24h,
    entry,
    stopLoss,
    tp1,
    tp2,
    riskReward1: parseFloat(riskReward1.toFixed(2)),
    riskReward2: parseFloat(riskReward2.toFixed(2)),
    tp1Pct: parseFloat(tp1Pct.toFixed(2)),
    slPct: parseFloat(slPct.toFixed(2)),
    rsi15m: parseFloat(rsi14_15m.toFixed(1)),
    rsi1h: parseFloat(rsi14_1h.toFixed(1)),
    volRatio: parseFloat(vol15m.volRatio.toFixed(2)),
    volTrend: parseFloat(vol15m.volTrend.toFixed(2)),
    ema20_15m: parseFloat(ema20_15m.toFixed(6)),
    ema50_15m: parseFloat(ema50_15m.toFixed(6)),
    ema20_1h: parseFloat(ema20_1h.toFixed(6)),
    ema50_1h: parseFloat(ema50_1h.toFixed(6)),
    support: parseFloat(support.toFixed(6)),
    resistance: parseFloat(resistance.toFixed(6)),
    pattern15m: pattern15m.pattern,
    pattern1h: pattern1h.pattern,
    atr15m: atr15m ? parseFloat(atr15m.toFixed(6)) : null,
    openInterest: oi,
    emaSlope: parseFloat(emaSlope.toFixed(4)),
    reason: status === "WAIT" ? "Condiciones parciales – esperar confirmación" : undefined,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    // 1. Get all futures tickers
    const tickers = await getBinance24hrTickers();

    // 2. Filter: USDT perpetuals with positive 24h change > 3%, good volume
    const candidates = tickers
      .filter((t) => {
        const change = parseFloat(t.priceChangePercent);
        const vol = parseFloat(t.quoteVolume);
        return (
          t.symbol.endsWith("USDT") &&
          change > 3 &&
          change < 50 && // avoid pump & dump
          vol > 5_000_000 && // min $5M daily volume
          !t.symbol.includes("1000") && // exclude weird tokens
          !t.symbol.includes("BUSD")
        );
      })
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, 20); // top 20 gainers

    if (candidates.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ signals: [], message: "No hay candidatos que cumplan los filtros iniciales.", scannedAt: new Date().toISOString() }),
      };
    }

    // 3. Deep analysis (with small delays to avoid rate limits)
    const signals = [];
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      try {
        const result = await analyzeSymbol(t.symbol, parseFloat(t.priceChangePercent), parseFloat(t.lastPrice));
        signals.push(result);
      } catch (err) {
        signals.push({ symbol: t.symbol, status: "DISCARD", reason: `Error: ${err.message}` });
      }
      if (i % 5 === 4) await sleep(300); // rate limit pause every 5 requests
    }

    // Sort: ENTER first, then WAIT, then DISCARD; by score desc
    signals.sort((a, b) => {
      const order = { ENTER: 0, WAIT: 1, DISCARD: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return (b.score || 0) - (a.score || 0);
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        signals,
        totalScanned: candidates.length,
        enterCount: signals.filter((s) => s.status === "ENTER").length,
        waitCount: signals.filter((s) => s.status === "WAIT").length,
        discardCount: signals.filter((s) => s.status === "DISCARD").length,
        scannedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
