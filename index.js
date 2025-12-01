//
// ================================
//  SOLANA FILTER ENGINE v2025 PRO
//  (TOKEN + CHANNEL ID INSERTED)
// ================================
//

import fs from "fs";
import axios from "axios";
import { Client, GatewayIntentBits } from "discord.js";

// --------------------------
// DISCORD BOT INIT
// --------------------------
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --------------------------
// YOUR TOKEN + CHANNEL ID
// --------------------------
const BOT_TOKEN = "8264706484:AAFDzA59VQL5jv8cTXtmLZpYKjRNFibfPSI";
const CHANNEL_ID = "1443934696424603658";

// --------------------------
// Load sent tokens (no repeat)
// --------------------------
let sent = new Set();
const sentFile = "./sent.json";

if (fs.existsSync(sentFile)) {
  sent = new Set(JSON.parse(fs.readFileSync(sentFile)));
}

function storeSent(ca) {
  sent.add(ca);
  fs.writeFileSync(sentFile, JSON.stringify([...sent], null, 2));
}

// --------------------------
// FILTER SETTINGS
// --------------------------
const MIN_LIQ = 15000;
const MAX_LIQ = 50000;

const MIN_VOL = 100000;
const MAX_VOL = 1000000;

const MIN_MC = 20000;
const MAX_MC = 80000;

const ALLOWED_SOURCES = ["dex", "raydium", "pumpfun", "pumpswap"];

// --------------------------
// MAIN FILTER ENGINE
// --------------------------
async function processToken(token) {
  try {
    const ca = token.ca;

    // no CA or already sent = skip
    if (!ca || sent.has(ca)) return;

    // source filter
    const src = token.source?.toLowerCase();
    if (!ALLOWED_SOURCES.includes(src)) return;

    // solana only
    if (token.chain?.toLowerCase() !== "solana") return;

    // newest pairs only
    if (token.pairAgeMinutes > 2) return;

    const liq = token.liquidityUSD || 0;
    const vol = token.volume24hUSD || 0;
    const mc = token.marketCapUSD || 0;

    // liquidity filter
    if (liq < MIN_LIQ || liq > MAX_LIQ) return;

    // volume filter
    if (vol < MIN_VOL || vol > MAX_VOL) return;

    // marketcap filter
    if (mc < MIN_MC || mc > MAX_MC) return;

    // ---------------------
    // FORMAT ALERT MESSAGE
    // ---------------------
    const msg = `
📈 **SOLANA Token Matched Your Filters**
Source: **${token.source}**
CA: \`${ca}\`

💧 Liquidity: $${liq.toLocaleString()}
📊 Volume: $${vol.toLocaleString()}
🏦 Marketcap: $${mc.toLocaleString()}
⏱ Age: ${token.pairAgeMinutes}m
    `;

    // send to Discord channel
    const channel = await bot.channels.fetch(CHANNEL_ID);
    channel.send(msg);

    // store so it never repeats
    storeSent(ca);

  } catch (err) {
    console.log("Token process error:", err);
  }
}

// --------------------------
// GMGN FEED
// --------------------------
async function fetchFeed() {
  try {
    const { data } = await axios.get("https://gmgn.ai/api/v2/tokens/sol/new");
    for (const t of data.tokens) {
      await processToken(t);
    }
  } catch (err) {
    console.log("GMGN feed error:", err);
  }
}

setInterval(fetchFeed, 6000); // every 6 sec

// --------------------------
// START BOT
// --------------------------
bot.login(BOT_TOKEN);

// --------------------------
// RENDER FIX (prevents timeout)
// --------------------------
import http from "http";
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot running OK");
  })
  .listen(PORT);
