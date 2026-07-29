const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// ---------------------------------------------------------------------------
// Signal definitions — what we fetch, how we label it, and how we evaluate it
// ---------------------------------------------------------------------------

const SIGNAL_DEFS = [
  {
    key: 'vix',
    label: 'VIX',
    symbol: '^VIX',
    decimals: 2,
    prefix: '',
    evaluate(val) {
      if (val >= 35) return { color: '#ef4444', label: 'Structural Break' };
      if (val >= 28) return { color: '#f97316', label: 'Confirmed Fear' };
      if (val >= 22) return { color: '#f59e0b', label: 'Elevated Stress' };
      if (val < 15)  return { color: '#6366f1', label: 'Complacency' };
      return { color: '#34d399', label: 'Normal' };
    },
    desc: 'Deploy SGOV reserve at your discretion when VIX signals genuine market fear.',
  },
  {
    key: 'dxy',
    label: 'DXY',
    symbol: 'DX-Y.NYB',
    decimals: 2,
    prefix: '',
    evaluate(val, ctx) {
      if (ctx.dxyExitTriggered) return { color: '#ef4444', label: 'EXIT GDXJ' };
      if (val > 105)            return { color: '#f59e0b', label: 'Strong Dollar' };
      if (val < 100)            return { color: '#34d399', label: 'Dollar Weakness' };
      return { color: '#94a3b8', label: 'Neutral' };
    },
    desc: 'GDXJ exit if DXY > 105 for 3 consecutive closes.',
  },
  {
    key: 'wti',
    label: 'WTI Crude',
    symbol: 'CL=F',
    decimals: 2,
    prefix: '$',
    evaluate(val) {
      if (val < 60)   return { color: '#ef4444', label: 'Demand Destruction' };
      if (val < 70)   return { color: '#f59e0b', label: 'Watch Exits' };
      if (val <= 90)  return { color: '#34d399', label: 'Healthy Range' };
      return { color: '#6366f1', label: 'Strong' };
    },
    desc: 'Accelerate XOP/XLE exit if WTI below $60 sustained 30+ days.',
  },
  {
    key: 'treasury',
    label: '10Y Treasury',
    symbol: '^TNX',
    decimals: 2,
    prefix: '',
    suffix: '%',
    evaluate(val) {
      if (val > 5.0)  return { color: '#ef4444', label: 'Fiscal Stress' };
      if (val < 3.5)  return { color: '#f59e0b', label: 'Recession Signal' };
      return { color: '#34d399', label: 'Normal' };
    },
    desc: 'Yield > 5% reinforces holding SGOV. Yield < 3.5% watch energy positions.',
  },
  {
    key: 'eurusd',
    label: 'EUR/USD',
    symbol: 'EURUSD=X',
    decimals: 4,
    prefix: '',
    evaluate(val) {
      if (val < 1.05) return { color: '#f59e0b', label: 'Euro Weakness' };
      if (val > 1.12) return { color: '#34d399', label: 'Euro Strength' };
      return { color: '#94a3b8', label: 'Neutral' };
    },
    desc: 'Below 1.05 watch IEFA and FAN. Above 1.12 bullish for IEFA and FAN.',
  },
  {
    key: 'sox',
    label: 'SOX',
    symbol: '^SOX',
    decimals: 2,
    prefix: '',
    evaluate(val, ctx) {
      if (ctx.soxDrawdownPct === null) return { color: '#94a3b8', label: '—' };
      if (ctx.soxDrawdownPct >= 30)   return { color: '#ef4444', label: `Down ${ctx.soxDrawdownPct.toFixed(1)}% — Review URA` };
      if (ctx.soxDrawdownPct >= 20)   return { color: '#f59e0b', label: `Down ${ctx.soxDrawdownPct.toFixed(1)}% — Watch IEMG/URA` };
      return { color: '#34d399', label: `Down ${ctx.soxDrawdownPct.toFixed(1)}%` };
    },
    desc: 'Down 20% from peak: watch IEMG and URA. Down 30%: review URA sizing.',
  },
  {
    key: 'uranium',
    label: 'Uranium (Sprott)',
    symbol: 'U-UN.TO',
    decimals: 2,
    prefix: 'C$',
    evaluate(_val) {
      return { color: '#94a3b8', label: 'Daily Monitor' };
    },
    desc: 'Sprott Physical Uranium Trust — automated daily monitoring. Confirm against Cameco/UxC/Numerco.',
  },
];

// ---------------------------------------------------------------------------
// Alert rules (static — rendered client-side but included in payload)
// ---------------------------------------------------------------------------

const ALERT_RULES = [
  { color: '#ef4444', if: 'DXY above 105 for 3 consecutive closes',           then: 'Sell ALL GDXJ across all accounts.' },
  { color: '#f59e0b', if: 'VIX elevated — your judgment',                      then: 'Deploy SGOV reserve into IEFA and IEMG at discount. IRA reserve: $76,343. Brokerage 2 reserve: $60,000.' },
  { color: '#f59e0b', if: 'WTI below $60 sustained 30+ days',                  then: 'Accelerate XOP and XLE exits immediately. Rotate into IEFA.' },
  { color: '#f59e0b', if: 'Uranium spot below $50/lb',                         then: 'Review URA sizing across all accounts. Check manually at tradingeconomics.com/commodity/uranium.' },
  { color: '#6366f1', if: 'VIX rising AND DXY falling simultaneously',         then: 'Maximum conviction deployment signal. Deploy SGOV reserve aggressively into IEFA and IEMG.' },
  { color: '#ef4444', if: 'WTI below $60 AND VIX above 35 sustained 30+ days', then: 'No energy positions remaining. Monitor IEMG for emerging market secondary impact.' },
];

// ---------------------------------------------------------------------------
// Historical data helpers (stateless — compute peak + streak from Yahoo Finance)
// ---------------------------------------------------------------------------

/**
 * Returns the 52-week high close price for a symbol.
 */
async function get52WeekHigh(symbol) {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 1);

    const result = await yahooFinance.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });
    // chart() returns { meta, quotes } — extract quotes array
    const rows = Array.isArray(result) ? result : (result?.quotes ?? []);

    if (!rows || rows.length === 0) return null;

    let peak = -Infinity;
    for (const row of rows) {
      const close = row.close ?? row.adjClose;
      if (typeof close === 'number' && close > peak) {
        peak = close;
      }
    }
    return peak !== -Infinity ? peak : null;
  } catch (err) {
    console.error(`[signals] 52-week high fetch failed for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Returns the number of consecutive trading days (most recent first) where
 * the daily close was above the threshold.
 */
async function getConsecutiveCloseStreak(symbol, threshold, lookbackDays = 60) {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);

    const result = await yahooFinance.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });
    // chart() returns { meta, quotes } — extract quotes array
    const rows = Array.isArray(result) ? result : (result?.quotes ?? []);

    if (!rows || rows.length === 0) return 0;

    // Sort by date descending (most recent first)
    const sorted = [...rows].sort((a, b) => new Date(b.date) - new Date(a.date));

    let streak = 0;
    for (const row of sorted) {
      const close = row.close ?? row.adjClose;
      if (typeof close === 'number' && close > threshold) {
        streak++;
      } else {
        break; // streak broken
      }
    }
    return streak;
  } catch (err) {
    console.error(`[signals] streak fetch failed for ${symbol}:`, err.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// DeepSeek AI Market Brief
// ---------------------------------------------------------------------------

async function getDeepSeekBrief(signalSummary) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a factual market observer for a personal trading dashboard. Describe conditions without instructing action.

Current signals:
${signalSummary}

The standing alert rules are: DXY > 105 for 3 consecutive closes triggers a GDXJ exit signal. WTI below $60 sustained signals energy position review. VIX thresholds are: 22 elevated, 28 confirmed fear, 35 structural break. SOX drawdowns of 20% and 30% are monitoring levels. EUR/USD below 1.05 or above 1.12 are notable thresholds. 10Y Treasury yield above 5% or below 3.5% are notable thresholds.

Write 3–4 sentences describing what conditions are present and which thresholds are currently triggered or approaching. Do not recommend or instruct any action. Do not use words like "should," "consider," "deploy," or "sell." Simply state what the numbers show relative to the thresholds.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a factual market observer. You describe conditions — you never give instructions, advice, or recommendations.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      console.error(`[signals] DeepSeek API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[signals] DeepSeek fetch failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless function handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Fetch all real-time quotes in parallel
    const symbols = SIGNAL_DEFS.map((s) => s.symbol);
    const quoteResult = await yahooFinance.quote(symbols);
    const quotes = Array.isArray(quoteResult) ? quoteResult : [quoteResult];

    const priceBySymbol = {};
    for (const q of quotes) {
      const price =
        q.regularMarketPrice ??
        (q.bid && q.ask ? (q.bid + q.ask) / 2 : null) ??
        q.regularMarketPreviousClose ??
        null;
      priceBySymbol[q.symbol] = typeof price === 'number' ? price : null;
    }

    // 2. Fetch historical data for SOX peak and DXY streak in parallel
    const [soxPeak, dxyStreak] = await Promise.all([
      get52WeekHigh('^SOX'),
      getConsecutiveCloseStreak('DX-Y.NYB', 105, 60),
    ]);

    // 3. Compute SOX drawdown
    const currentSoxPrice = priceBySymbol['^SOX'];
    let soxDrawdownPct = null;

    if (currentSoxPrice !== null && currentSoxPrice !== undefined && soxPeak !== null) {
      soxDrawdownPct = ((soxPeak - currentSoxPrice) / soxPeak) * 100;
    } else if (currentSoxPrice !== null && currentSoxPrice !== undefined) {
      // No historical data — seed peak to current price (drawdown = 0%)
      soxDrawdownPct = 0;
    }

    // 4. Determine DXY exit trigger
    const dxyExitTriggered = dxyStreak >= 3;

    // 5. Build context for threshold evaluation
    const evalCtx = { soxPeak, soxDrawdownPct, dxyExitTriggered };

    // 6. Assemble signals array
    const signals = SIGNAL_DEFS.map((def) => {
      const rawVal = priceBySymbol[def.symbol];
      const value = rawVal !== null && rawVal !== undefined ? rawVal : null;
      const { color, label } = def.evaluate(value, evalCtx);
      const display =
        value !== null
          ? `${def.prefix}${value.toFixed(def.decimals)}${def.suffix || ''}`
          : '--';

      const entry = {
        key: def.key,
        label: def.label,
        symbol: def.symbol,
        value,
        display,
        status_color: color,
        status_label: label,
        desc: def.desc,
      };

      // Attach SOX-specific extras
      if (def.key === 'sox' && value !== null) {
        entry.sox_peak = soxPeak;
        entry.sox_drawdown_pct = soxDrawdownPct;
      }

      return entry;
    });

    // 7. DeepSeek AI Market Brief
    let aiBrief = null;
    try {
      const summaryLines = signals.map((s) => {
        const valStr = s.value !== null ? s.display : 'N/A';
        return `- ${s.label}: ${valStr} (${s.status_label})`;
      });
      aiBrief = await getDeepSeekBrief(summaryLines.join('\n'));
    } catch (_err) {
      // DeepSeek failure is non-fatal
    }

    // 8. Response — 60-second CDN cache to prevent rapid-fire DeepSeek calls
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
    res.status(200).json({
      updated_at: new Date().toISOString(),
      signals,
      dxy_streak: dxyStreak,
      dxy_exit_triggered: dxyExitTriggered,
      alert_rules: ALERT_RULES,
      ai_brief: aiBrief,
    });
  } catch (err) {
    console.error('[signals] Unhandled error:', err);
    res.status(502).json({ error: 'Signal fetch failed' });
  }
};