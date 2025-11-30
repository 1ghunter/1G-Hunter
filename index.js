// =======================================================
// 1G VAULT V16.1 - EXTREME SENSITIVITY FLEX SNIPER
// CHANGE: Filters lowered to the absolute minimum ($100 Liq) 
//         to capture the earliest possible signals on DexScreener.
// =======================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = require('node-fetch'); 
const stateFile = path.resolve(__dirname, "state.json");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// --- CONFIGURATION ---
const BOT_NAME = "1G VAULT V16.1 (ExtremeSniper)"; 
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://jup.ag/"; 
const CHAINS = { SOL: "solana" }; 
const AXIOM_REF = "https://axiom.trade/@1gvault"; 

// --- SCHEDULING ---
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 10_000; 
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 60_000; 
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const CALL_HISTORY_CLEAR_MS = 1 * 60 * 60 * 1000; 

// --- MEME FILTER SETTINGS (EXTREME MINIMUMS) ---
const MEME_SETTINGS = {
  // EXTREME MINIMUMS 
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 100,     // Only $100 required
  minPriceChangeH1: Number(process.env.PCT_H1_MIN) || -10, // Allows 10% dump
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30, 
  
  txnBoostThreshold: 100, 
};

// --- KEYWORD CONFIGURATION ---
const KEYWORD_BOOST = 25; // Increased boost for extreme mode
const KEYWORDS = [
    "pump fun", 
    "pump.fun", 
    "solana meme", 
    "raydium", 
    "new launch", 
    "fair launch",
    "padre", // Added common words from the video
    "axiom", 
    "gmgn"
];

// ... (Rest of the boilerplate code: loadState, saveState, utilities, fetchDexPairs, collectCandidates - UNCHANGED from V16.0)

// --- SCORING & FILTERING (ADJUSTED FOR V16.1) ---

function checkKeywords(p) {
    const name = (p.baseToken?.name || "").toLowerCase();
    const symbol = (p.baseToken?.symbol || "").toLowerCase();
    const info = (p.pairAddress || "").toLowerCase(); 
    
    for (const keyword of KEYWORDS) {
        if (name.includes(keyword) || symbol.includes(keyword) || info.includes(keyword)) {
            return true;
        }
    }
    return false;
}

function scorePair(p) {
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0; 
  const m5 = p.priceChange?.m5 || 0; 
  const totalTxnsH1 = (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0);

  let s = 25; // Higher base score
  
  // Base score on momentum
  s += Math.min(h1 * 4, 30); 
  s += Math.min(m5 * 5, 20); 
  
  // Score boost for transaction counts
  if (totalTxnsH1 > MEME_SETTINGS.txnBoostThreshold) {
      s += 10;
  }

  // Score boost for liquidity (adjusted tiers)
  if (liq > 500) s += 5;
  if (liq > 1000) s += 5;

  // KEYWORD BOOST (Increased for V16.1)
  if (checkKeywords(p)) {
      s += KEYWORD_BOOST; 
  }

  return Math.min(99, Math.round(s));
}

function passesMemeFilters(p) {
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0;
  
  // 1. MINIMUM LIQUIDITY (EXTREME MINIMUM)
  if (liq < MEME_SETTINGS.minLiquidityUsd) { 
      return false; 
  }
  
  // 2. MINIMUM 1H PRICE CHANGE (EXTREME MINIMUM)
  if (h1 < MEME_SETTINGS.minPriceChangeH1) { 
      return false; 
  }

  if (p._sourceChain !== 'solana') {
      return false;
  }
  
  return true;
}

async function dropCall() {
  // ... (unchanged logic for dropCall, BUT change the minimum score)
  // ...
  // Find where this line is and adjust the score:
  // if (score < 40) continue; // V16.0

  // CHANGE IN V16.1:
  // if (score < 30) continue; // Allows easier calls
  // ...
  
  // The rest of the functions (createCallEmbed, flexGains, etc.) are UNCHANGED from V16.0
}


// --- SCHEDULER & DISCORD INIT ---
// (The rest of the code is the same as V16.0, just ensure you update the BOT_NAME and the core logic functions above)
