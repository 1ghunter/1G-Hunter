/* index.js - Render Ready Version */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Cron = require('cron').CronJob;
const express = require('express'); // Added for Render

// --- PART 1: KEEP ALIVE SERVER (Required for Render Web Services) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('1G-Hunter Bot is running actively!');
});

app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}`);
});
// --------------------------------------------------------------------

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL_MIN || 15);
const MAX_SIGNALS_PER_RUN = Number(process.env.MAX_SIGNALS_PER_RUN || 7);

// Symbols to monitor
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','XAUUSD'];

// Timeframes
const TF_SHORT = '15m';
const TF_LONG = '1h';

// Binance Interval Map
const INTERVAL_MAP = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d' };

// Logger
function log(...args){ console.log(new Date().toISOString(), ...args); }

// --- DATA FETCHING ---
async function fetchKlines(symbol, interval, limit = 200){
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL_MAP[interval] || interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data.map(k => ({
      t: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    log(`fetchKlines error for ${symbol}:`, err?.message);
    return [];
  }
}

// --- HELPERS ---
function candleBody(c){ return Math.abs(c.close - c.open); }
function upperWick(c){ return c.high - Math.max(c.open,c.close); }
function lowerWick(c){ return Math.min(c.open,c.close) - c.low; }

function roundPrice(p){
  if (!isFinite(p)) return p;
  if (p >= 1000) return Number(p.toFixed(2));
  if (p >= 1) return Number(p.toFixed(4));
  return Number(p.toFixed(6));
}

// --- STRATEGY LOGIC ---
async function analyzeSymbol(symbol){
  const klShort = await fetchKlines(symbol, TF_SHORT, 200);
  const klLong = await fetchKlines(symbol, TF_LONG, 200);
  
  // Need enough data
  if (klShort.length < 30 || klLong.length < 30) return null;

  // Recent highs/lows for context
  const recentHigh = Math.max(...klShort.slice(-12, -1).map(k => k.high));
  const recentLow = Math.min(...klShort.slice(-12, -1).map(k => k.low));

  let direction = null;
  let triggerCandle = null;

  // Check last 6 candles for a Liquidity Grab (Wick)
  for (let i = klShort.length - 6; i < klShort.length - 1; i++){
    if (i < 0) continue;
    const c = klShort[i];
    
    // Bullish Grab (Long lower wick taking out lows)
    if (lowerWick(c) > candleBody(c) * 2 && c.low < recentLow){
      direction = 'LONG';
      triggerCandle = c;
      break;
    }
    // Bearish Grab (Long upper wick taking out highs)
    if (upperWick(c) > candleBody(c) * 2 && c.high > recentHigh){
      direction = 'SHORT';
      triggerCandle = c;
      break;
    }
  }

  if (!direction || !triggerCandle) return null;

  // Look for Retest
  let retestIndex = null;
  for (let i = klShort.length - 6; i < klShort.length; i++){
    const c = klShort[i];
    if (direction === 'LONG' && c.close > triggerCandle.close) { retestIndex = i; break; }
    if (direction === 'SHORT' && c.close < triggerCandle.close) { retestIndex = i; break; }
  }
  if (retestIndex === null) return null;

  const retestCandle = klShort[retestIndex];
  const buffer = retestCandle.close * 0.0006;
  const entry = (direction === 'LONG') ? retestCandle.close + buffer : retestCandle.close - buffer;
  
  // Conservative Stop Loss
  const SL = (direction === 'LONG') 
    ? triggerCandle.low * 0.9994 
    : triggerCandle.high * 1.0006;

  const risk = Math.abs(entry - SL);
  const tp1 = (direction === 'LONG') ? entry + risk * 2 : entry - risk * 2;
  const tp2 = (direction === 'LONG') ? entry + risk * 3 : entry - risk * 3;

  // Scoring
  let score = 0;
  if (direction === 'LONG') {
    if (lowerWick(triggerCandle) > candleBody(triggerCandle) * 2.5) score += 2;
  } else {
    if (upperWick(triggerCandle) > candleBody(triggerCandle) * 2.5) score += 2;
  }
  
  // Trend Confluence
  const longLast = klLong[klLong.length - 1];
  const longPrev = klLong[klLong.length - 5] || longLast;
  if (direction === 'LONG' && longLast.close > longPrev.close) score += 1;
  if (direction === 'SHORT' && longLast.close < longPrev.close) score += 1;

  const probability = Math.min(95, 40 + score * 15);

  return {
    symbol, direction, 
    entry: roundPrice(entry), 
    stoploss: roundPrice(SL), 
    tp1: roundPrice(tp1), tp2: roundPrice(tp2), 
    probability, 
    time: Date.now()
  };
}

// --- DISCORD EMBED ---
function buildEmbed(signal){
  const color = signal.direction === 'LONG' ? 0x22c55e : 0xef4444;
  return new EmbedBuilder()
    .setTitle(`⚡ ${signal.direction} SETUP: ${signal.symbol}`)
    .setColor(color)
    .addFields(
      { name: 'Entry Zone', value: `${signal.entry}`, inline: true },
      { name: 'Stop Loss', value: `${signal.stoploss}`, inline: true },
      { name: 'Probability', value: `${signal.probability}%`, inline: true },
      { name: 'TP 1 (2R)', value: `${signal.tp1}`, inline: true },
      { name: 'TP 2 (3R)', value: `${signal.tp2}`, inline: true },
    )
    .setFooter({ text: '1G-Hunter | Smart Money Concepts' })
    .setTimestamp();
}

// --- MAIN RUNNER ---
async function runScanAndPost(client){
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) { log('CRITICAL: Channel not found!'); return; }

    let count = 0;
    for (let symbol of SYMBOLS){
      if (count >= MAX_SIGNALS_PER_RUN) break;
      const s = await analyzeSymbol(symbol);
      
      if (s) {
        log(`Signal found: ${s.symbol} ${s.direction}`);
        await channel.send({ embeds: [buildEmbed(s)] });
        count++;
        await new Promise(r => setTimeout(r, 1000)); // Prevent rate limits
      }
    }
    log(`Scan complete. Signals sent: ${count}`);
  } catch (err){
    log('runScanAndPost error:', err.message);
  }
}

// --- BOT STARTUP ---
async function startBot(){
  // CRITICAL CHECK: If this fails, the variables are missing in Render Dashboard
  if (!DISCORD_TOKEN || !CHANNEL_ID) {
    console.error('\n!!! ERROR: MISSING ENVIRONMENT VARIABLES !!!');
    console.error('You must set DISCORD_TOKEN and DISCORD_CHANNEL_ID in Render Dashboard > Environment.\n');
    return; // We return instead of exit(1) so the web server stays alive to show logs
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    log(`Logged in as ${client.user.tag}`);
    
    // Run once on startup
    await runScanAndPost(client);

    // Schedule: Runs every 15 minutes
    const job = new Cron(`0 */${SCAN_INTERVAL_MIN} * * * *`, async () => {
      log('Starting scheduled scan...');
      await runScanAndPost(client);
    }, null, true, 'UTC');

    job.start();
  });

  client.login(DISCORD_TOKEN);
}

startBot();
