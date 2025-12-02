/* index.js
   Discord Signal Bot — Smart Money / Price Action / Sniper Entry
   Author: (you) — professional-style code that's easy to maintain and deploy.
   Notes:
     - Uses Binance public REST klines for crypto symbols.
     - Schedules scans every 15 minutes; posts signals as Discord embeds.
     - ENV variables: DISCORD_TOKEN, DISCORD_CHANNEL_ID, SCAN_INTERVAL_MIN (optional).
*/

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Cron = require('cron').CronJob;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL_MIN || 15);
const MAX_SIGNALS_PER_RUN = Number(process.env.MAX_SIGNALS_PER_RUN || 7);

// Symbols to monitor. For XAUUSD, set the Binance symbol or external API if needed.
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','XAUUSD'];

// Timeframe choices (we use 15m for entries + 1h for context)
const TF_SHORT = '15m';
const TF_LONG = '1h';

// Utility: map timeframe string to Binance interval
const INTERVAL_MAP = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d' };

// Simple logger
function log(...args){ console.log(new Date().toISOString(), ...args); }

// Binance public klines fetcher (no API key required for public market data)
async function fetchKlines(symbol, interval, limit = 200){
  try {
    // Binance supports many symbols; if symbol unmatched, endpoint will 400
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL_MAP[interval] || interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 10000 });
    // kline format: [ openTime, open, high, low, close, ... ]
    return res.data.map(k => ({
      t: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    // return empty on error
    log('fetchKlines error', symbol, interval, err?.response?.data || err.message);
    return [];
  }
}

// Simple technical helpers
function candleBody(c){ return Math.abs(c.close - c.open); }
function upperWick(c){ return c.high - Math.max(c.open,c.close); }
function lowerWick(c){ return Math.min(c.open,c.close) - c.low; }

// Strategy heuristic: detect "liquidity grab" + retest across TFs
// Returns a signal object or null.
async function analyzeSymbol(symbol){
  // Get data
  const klShort = await fetchKlines(symbol, TF_SHORT, 200);
  const klLong = await fetchKlines(symbol, TF_LONG, 200);
  if (klShort.length < 30 || klLong.length < 30) return null;

  // We'll look for last notable "wick spike" on the short TF (liquidity hunt)
  const last = klShort[klShort.length - 1];
  const prev = klShort[klShort.length - 2];

  // Liquidity-grab up (bull trap) detection: long upper wick larger than body * 2 and wick breaks recent highs
  const recentHigh = Math.max(...klShort.slice(-12, -1).map(k => k.high));
  const recentLow = Math.min(...klShort.slice(-12, -1).map(k => k.low));

  let direction = null;
  let triggerCandle = null;

  // bullish liquidity grab (wick to downside) -> expect long
  for (let i = klShort.length - 6; i < klShort.length - 1; i++){
    if (i < 0) continue;
    const c = klShort[i];
    const lw = lowerWick(c);
    if (lw > candleBody(c) * 2 && c.low < recentLow){
      direction = 'LONG';
      triggerCandle = c;
      break;
    }
    const uw = upperWick(c);
    if (uw > candleBody(c) * 2 && c.high > recentHigh){
      direction = 'SHORT';
      triggerCandle = c;
      break;
    }
  }

  if (!direction || !triggerCandle) return null;

  // find a retest: next candles that retrace toward the trigger zone
  // We find the first candle that closes back above (for LONG) or below (for SHORT) the trigger's close
  let retestIndex = null;
  for (let i = klShort.length - 6; i < klShort.length; i++){
    const c = klShort[i];
    if (direction === 'LONG' && c.close > triggerCandle.close) { retestIndex = i; break; }
    if (direction === 'SHORT' && c.close < triggerCandle.close) { retestIndex = i; break; }
  }
  if (retestIndex === null) return null;

  const retestCandle = klShort[retestIndex];
  // Entry: conservative: place entry at small buffer beyond retest candle close
  const buffer = (direction === 'LONG') ? (retestCandle.close * 0.0006) : (retestCandle.close * 0.0006);
  const entry = (direction === 'LONG') ? retestCandle.close + buffer : retestCandle.close - buffer;

  // Stop Loss: below the trigger wick low for LONG, above trigger wick high for SHORT (safe)
  const SL = (direction === 'LONG') ? triggerCandle.low - (triggerCandle.low * 0.0006) : triggerCandle.high + (triggerCandle.high * 0.0006);

  // TPs using 1:2 and 1:3 rewards
  const risk = Math.abs(entry - SL);
  const tp1 = (direction === 'LONG') ? entry + risk * 2 : entry - risk * 2;
  const tp2 = (direction === 'LONG') ? entry + risk * 3 : entry - risk * 3;

  // Probability estimate: simple scoring system
  let score = 0;
  // 1) Long wick significance
  const wickSize = (direction === 'LONG') ? lowerWick(triggerCandle) : upperWick(triggerCandle);
  if (wickSize > candleBody(triggerCandle) * 2) score += 2;
  // 2) Volume spike? use volume vs prior avg (short TF)
  const avgVol = klShort.slice(-20, -6).reduce((s,c)=>s+c.volume,0) / 14;
  if (triggerCandle.volume > avgVol * 1.5) score += 1;
  // 3) Higher timeframe confluence: check long TF trend (close vs MA-ish)
  const longLast = klLong[klLong.length - 1];
  const longPrevClose = klLong[klLong.length - 5]?.close || longLast.close;
  if (direction === 'LONG' && longLast.close > longPrevClose) score += 1;
  if (direction === 'SHORT' && longLast.close < longPrevClose) score += 1;
  // 4) Retest quality: small retest candle body
  if (candleBody(retestCandle) < (Math.abs(retestCandle.close - retestCandle.open) * 1.5)) score += 1;

  // Normalize to probability %
  const probability = Math.min(90, 30 + score * 12); // baseline 30% plus score*12

  const explanation = [
    `Pattern: Liquidity grab (${direction}) detected on ${TF_SHORT} TF.`,
    `Trigger candle had a ${direction === 'LONG' ? 'large lower wick' : 'large upper wick'}, breaking recent ${direction === 'LONG' ? 'swing low' : 'swing high'}.`,
    `Retest candle closed back into the trigger zone — using conservative entry at retest close + small buffer.`,
    `Higher timeframe (${TF_LONG}) trend confluence: ${direction === 'LONG' ? (longLast.close > longPrevClose ? 'bullish' : 'neutral') : (longLast.close < longPrevClose ? 'bearish' : 'neutral')}.`,
    `Risk:reward plans set to 1:2 and 1:3. Suggested position sizing: risk no more than 1-2% of account per trade.`
  ].join(' ');

  return {
    symbol,
    direction,
    entry: roundPrice(entry),
    stoploss: roundPrice(SL),
    tp1: roundPrice(tp1),
    tp2: roundPrice(tp2),
    risk: roundPrice(risk),
    probability,
    explanation,
    time: Date.now(),
    triggerCandle,
    retestCandle
  };
}

function roundPrice(p){
  // round to 2 decimals for most cryptos; if price > 1000 round to 2, if low price like XRP round to 6
  if (!isFinite(p)) return p;
  if (p >= 1000) return Number(p.toFixed(2));
  if (p >= 1) return Number(p.toFixed(4));
  return Number(p.toFixed(6));
}

// Discord embed builder
function buildEmbed(signal){
  const color = signal.direction === 'LONG' ? 0x22c55e : 0xef4444;
  const embed = new EmbedBuilder()
    .setTitle(`${signal.direction} Signal — ${signal.symbol}`)
    .setColor(color)
    .addFields(
      { name: 'Entry', value: `\`${signal.entry}\``, inline: true },
      { name: 'Stop Loss', value: `\`${signal.stoploss}\``, inline: true },
      { name: 'TP 1 (1:2)', value: `\`${signal.tp1}\``, inline: true },
      { name: 'TP 2 (1:3)', value: `\`${signal.tp2}\``, inline: true },
      { name: 'Probability', value: `\`${signal.probability}%\``, inline: true },
      { name: 'Risk (price units)', value: `\`${signal.risk}\``, inline: true }
    )
    .setDescription(signal.explanation)
    .setTimestamp(signal.time)
    .setFooter({ text: 'Signals use Smart Money / Price Action / Sniper heuristics. Paper trade first.'});
  return embed;
}

// Bot runtime
async function runScanAndPost(client){
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) { log('Channel not found:', CHANNEL_ID); return; }

    const signals = [];
    for (let symbol of SYMBOLS){
      try {
        const s = await analyzeSymbol(symbol);
        if (s) signals.push(s);
      } catch (e) {
        log('analyzeSymbol error', symbol, e.message || e);
      }
      // Stop early if we reached daily desired amount per run
      if (signals.length >= MAX_SIGNALS_PER_RUN) break;
    }

    if (signals.length === 0){
      log('No valid signals this run.');
      return;
    }

    for (const sig of signals){
      const embed = buildEmbed(sig);
      await channel.send({ embeds: [embed] });
      log('Posted signal', sig.symbol, sig.direction, sig.entry, `prob=${sig.probability}%`);
      // small pause to avoid rate limiting
      await sleep(800);
    }

  } catch (err){
    log('runScanAndPost error', err.message || err);
  }
}

// small sleep utility
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Bot start */
async function startBot(){
  if (!DISCORD_TOKEN || !CHANNEL_ID) {
    log('Please set DISCORD_TOKEN and DISCORD_CHANNEL_ID in environment variables.');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    log('Discord client ready as', client.user.tag);
    // Run immediately once on start
    await runScanAndPost(client);

    // Schedule repeating job every SCAN_INTERVAL_MIN minutes using cron
    const cronPattern = `0 */${Math.max(1, SCAN_INTERVAL_MIN)} * * * *`; // every SCAN_INTERVAL_MIN minutes at 0 sec
    const job = new Cron(cronPattern, async function(){
      log('Cron run triggered');
      await runScanAndPost(client);
    }, null, true, 'UTC');

    job.start();
    log(`Scheduled scans every ${SCAN_INTERVAL_MIN} minute(s).`);
  });

  client.on('error', err => log('Discord client error', err));
  client.login(DISCORD_TOKEN);
}

startBot().catch(e => { log('startBot error', e); process.exit(1); });
