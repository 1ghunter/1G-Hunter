// index.js
// Futures Signal Bot - Price Action + ICT-style heuristics
// -- configure via environment variables (see README below)

import axios from "axios";
import http from "http";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { EMA, RSI, ATR } from "technicalindicators";

//
// CONFIG (use env variables in Render)
const BOT_TOKEN = process.env.BOT_TOKEN;               // set in Render env
const CHANNEL_ID = process.env.CHANNEL_ID;             // numeric discord channel id
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 10_000; // how often to scan
const PORTFOLIO_USD = Number(process.env.PORTFOLIO_USD) || 1000; // used for suggested size
const MARGIN_PERCENT = Number(process.env.MARGIN_PERCENT) || 0.02; // default 2% of portfolio
const SIGNAL_THRESHOLD = Number(process.env.SIGNAL_THRESHOLD) || 70; // score >= threshold to send
const SCAN_SYMBOLS = (process.env.SCAN_SYMBOLS || "BTCUSDT,ETHUSDT,ADAUSDT,SOLUSDT").split(",").map(s => s.trim().toUpperCase());
const KLINE_INTERVAL = process.env.KLINE_INTERVAL || "1m"; // 1m/3m/5m/15m etc
const BAR_COUNT = Number(process.env.BAR_COUNT) || 200; // how many candles to fetch for indicators

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID in environment.");
  process.exit(1);
}

//
// Simple helper: fetch Binance futures klines (public endpoint)
async function fetchKlinesFutures(symbol, interval = "1m", limit = 200) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await axios.get(url, { timeout: 7000 });
  // returns array of arrays; map into objects
  return resp.data.map(c => ({
    openTime: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
    closeTime: c[6]
  }));
}

//
// Indicator helpers using technicalindicators
function calcEMA(values, period) {
  if (!values || values.length < period) return [];
  return EMA.calculate({ period, values });
}
function calcRSI(values, period = 14) {
  if (!values || values.length < period) return [];
  return RSI.calculate({ period, values });
}
function calcATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period) return [];
  return ATR.calculate({ high: highs, low: lows, close: closes, period });
}

//
// Score function (combine trend, momentum, volume, ICT structure heuristics)
function scoreSetup({ candles, emas, rsiArr, atrArr }) {
  // Defensive
  if (!candles || candles.length === 0) return 0;
  const last = candles[candles.length - 1];
  const price = last.close;

  // EMA trend: use EMA8 and EMA21 (on aligned arrays)
  const ema8 = emas.ema8.at(-1) ?? null;
  const ema21 = emas.ema21.at(-1) ?? null;

  let score = 0;

  // Trend (30 points)
  if (ema8 && ema21) {
    if (ema8 > ema21 && price > ema8) score += 25; // bullish trend
    else if (ema8 < ema21 && price < ema8) score += 25; // bearish trend
    else score += 8; // neutral
  }

  // Momentum via RSI (20 points)
  const rsi = rsiArr.at(-1) ?? 50;
  if (rsi > 55 && rsi < 75) score += 18; // bullish momentum
  else if (rsi < 45 && rsi > 25) score += 18; // bearish momentum
  else if (rsi >= 75 || rsi <= 25) score += 5; // extreme (less reliable)

  // ATR-based volatility & potential reward (15 points)
  const atr = atrArr.at(-1) ?? null;
  if (atr && price) {
    const atrPct = (atr / price) * 100;
    // moderate volatility preferred
    if (atrPct > 0.3 && atrPct < 3) score += 12;
    else if (atrPct >= 3) score += 6;
  }

  // Volume spike heuristic (15 points)
  const volumes = candles.slice(-20).map(c => c.volume);
  const avgVol = volumes.reduce((a,b) => a+b,0) / volumes.length;
  if (last.volume > avgVol * 1.8) score += 14;
  else if (last.volume > avgVol * 1.3) score += 8;

  // ICT / Price action structural checks (20 points)
  // - Structure: Higher highs / higher lows for bull, opposite for bear
  const lastN = candles.slice(-10);
  const highs = lastN.map(c => c.high);
  const lows = lastN.map(c => c.low);

  const isHigherHigh = highs.every((h,i) => i === 0 || h >= highs[i-1]);
  const isHigherLow = lows.every((l,i) => i === 0 || l >= lows[i-1]);
  const isLowerHigh = highs.every((h,i) => i === 0 || h <= highs[i-1]);
  const isLowerLow = lows.every((l,i) => i === 0 || l <= lows[i-1]);

  if (isHigherHigh && isHigherLow) score += 18; // strong up structure
  else if (isLowerHigh && isLowerLow) score += 18; // strong down structure
  else score += 8; // mixed

  // Cap to 100
  return Math.round(Math.min(100, score));
}

//
// Build professional embed for the signal
function buildSignalEmbed({ symbol, side, entry, sl, tp, probability, marginPct, positionSizeUsd, extraNote }) {
  const embed = new EmbedBuilder()
    .setTitle(`${symbol} — ${side.toUpperCase()} Futures Setup`)
    .setColor(side === "long" ? 0x00ff66 : 0xff5555)
    .addFields(
      { name: "Entry", value: `${entry}`, inline: true },
      { name: "Stop Loss (SL)", value: `${sl}`, inline: true },
      { name: "Take Profit (TP)", value: `${tp}`, inline: true },
      { name: "Probability", value: `${probability}%`, inline: true },
      { name: "Margin (suggested)", value: `${(marginPct * 100).toFixed(2)}% of portfolio`, inline: true },
      { name: "Position Size (USD)", value: `$${positionSizeUsd.toFixed(2)}`, inline: true }
    )
    .setFooter({ text: "Futures signal • Use risk management • Not financial advice" })
    .setTimestamp();

  if (extraNote) embed.setDescription(extraNote);
  return embed;
}

function makeButtons(symbol) {
  const qs = encodeURIComponent(symbol);
  const chartUrl = `https://www.tradingview.com/symbols/${symbol}/`; // quick link for chart (may not exist for every alt)
  const binanceFutures = `https://www.binance.com/en/futures/${symbol}`;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Open Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
    new ButtonBuilder().setLabel("Binance Futures").setStyle(ButtonStyle.Link).setURL(binanceFutures),
    new ButtonBuilder().setLabel("Quick Info").setStyle(ButtonStyle.Link).setURL(`https://www.binance.com/en/futures/${symbol}`)
  );
  return buttons;
}

//
// Position sizing helper:
// For futures, if user uses X% margin of portfolio, we'll display USD exposure.
// (Real position sizing with leverage requires more inputs.)
function calcPositionSizeUSD(portfolioUsd, marginPercent) {
  return portfolioUsd * marginPercent;
}

//
// Generate entries/SL/TP using ATR-based levels + price action
function proposeLevels({ candles, side, atrMultiplier = 1.5, rewardRisk = 2 }) {
  const last = candles.at(-1);
  const price = last.close;
  // calculate ATR (we assume atrArr already computed)
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const atrArr = calcATR(highs, lows, closes, 14);
  const atr = atrArr.at(-1) || (Math.max(...highs.slice(-14)) - Math.min(...lows.slice(-14))) / 14;

  const slDistance = atr * atrMultiplier;
  let sl = side === "long" ? +(price - slDistance).toFixed(2) : +(price + slDistance).toFixed(2);
  // ensure SL not equal entry
  if (sl === price) sl = side === "long" ? +(price - 1).toFixed(2) : +(price + 1).toFixed(2);

  // TP = entry + rewardRisk * distance (for long), opposite for short
  const tp = side === "long" ? +(price + rewardRisk * slDistance).toFixed(2) : +(price - rewardRisk * slDistance).toFixed(2);

  return { entry: price, sl, tp, atr: +atr.toFixed(6) };
}

//
// Main scanner for a single symbol
async function scanSymbol(symbol) {
  try {
    const klines = await fetchKlinesFutures(symbol, KLINE_INTERVAL, BAR_COUNT);
    if (!klines || klines.length < 60) return null;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);

    // compute EMAs and RSI
    const ema8arr = calcEMA(closes, 8);
    const ema21arr = calcEMA(closes, 21);
    const rsiArr = calcRSI(closes, 14);
    const atrArr = calcATR(highs, lows, closes, 14);

    // align arrays into object
    const datos = {
      candles: klines,
      emas: { ema8: ema8arr, ema21: ema21arr },
      rsiArr,
      atrArr
    };

    const score = scoreSetup(datos);

    // Determine bias: EMA8 vs EMA21 (simple)
    const ema8 = ema8arr.at(-1) ?? null;
    const ema21 = ema21arr.at(-1) ?? null;
    let bias = "neutral";
    if (ema8 && ema21) bias = ema8 > ema21 ? "long" : "short";

    // If score passes threshold, propose levels
    if (score >= SIGNAL_THRESHOLD) {
      const side = bias === "neutral" ? (rsiArr.at(-1) >= 50 ? "long" : "short") : bias;
      const { entry, sl, tp, atr } = proposeLevels({ candles: klines, side, atrMultiplier: 1.5, rewardRisk: 2 });

      // position sizing (USD exposure)
      const posUsd = calcPositionSizeUSD(PORTFOLIO_USD, MARGIN_PERCENT);
      const extraNote = `Strategy: Price Action + ICT heuristics. ATR=${atr}. EMA8/EMA21 bias=${bias}. Confirm on your chart.`;

      return {
        symbol,
        side,
        entry: +entry.toFixed(2),
        sl,
        tp,
        probability: score,
        marginPct: MARGIN_PERCENT,
        positionSizeUsd: posUsd,
        extraNote
      };
    }
    return null;
  } catch (e) {
    console.warn(`[scanSymbol] ${symbol} error:`, e?.message || e);
    return null;
  }
}

//
// Scan loop (scans all symbols and posts signals)
let isScanning = false;
async function scanLoop() {
  if (isScanning) return;
  isScanning = true;
  try {
    for (const s of SCAN_SYMBOLS) {
      const sig = await scanSymbol(s);
      if (sig) {
        // build embed + send
        const embed = buildSignalEmbed(sig);
        const buttons = makeButtons(sig.symbol);
        try {
          const channel = await client.channels.fetch(CHANNEL_ID);
          await channel.send({ embeds: [embed], components: [buttons] });
          console.log(`[SIGNAL] posted ${sig.symbol} ${sig.side} prob ${sig.probability}%`);
          // small delay for rate safety
          await new Promise(r => setTimeout(r, 800));
        } catch (e) {
          console.warn("[SEND] failed:", e?.message || e);
        }
      } else {
        console.log(`[SCAN] no signal ${s}`);
      }
      // tiny sleep between symbols
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    console.warn("[scanLoop] error:", e?.message || e);
  } finally {
    isScanning = false;
  }
}

//
// Discord client + start
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", () => {
  console.log("[BOT] ready", client.user?.tag);
  // start periodic scanning
  setInterval(scanLoop, POLL_INTERVAL_MS);
  // run first immediately
  scanLoop().catch(() => {});
});

client.login(BOT_TOKEN).catch(err => {
  console.error("[LOGIN] failed:", err?.message || err);
  process.exit(1);
});

// Render keepalive endpoint
const APP_PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end("Futures Signal Bot OK")).listen(APP_PORT, () => console.log(`[HTTP] listening ${APP_PORT}`));

//
// End of file
