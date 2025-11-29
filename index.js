// index.js — 1G VAULT ULTIMATE CALLER — HYPER MODE + MULTI-SOURCE MEME SCANNER (2025)
// FULL CODE (paste into your project). Requires Node 18+ for global fetch.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const stateFile = path.resolve(__dirname, "state.json");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// =========== CONFIG ===========
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = process.env.REF_URL || "https://axiom.trade/@1gvault";

// Hyper mode: 1-2 min default, adjustable via env
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 60_000;
const MAX_DROP_INTERVAL_MS = Number(process.env.MAX_DROP_INTERVAL_MS) || 120_000;
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 120_000; // check gains fast
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_MS) || 240_000;
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;
const MAX_TRACKING_AGE_MIN = Number(process.env.MAX_TRACKING_AGE_MIN) || 60 * 24 * 21; // 21 days

// Meme-coin tuned thresholds ("best of the best meme coin settings")
const MEME_SETTINGS = {
  minMarketCap: Number(process.env.MC_MIN) || 5_000,        // very low MC allowed
  maxMarketCap: Number(process.env.MC_MAX) || 2_000_000,
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 1_000,    // allow tiny liquidity
  minVolumeH1: Number(process.env.VOL_H1_MIN) || 1_000,     // low volume OK
  minPriceChangeH1: Number(process.env.PCT_H1_MIN) || 5,    // minimum 1h momentum
  minScore: Number(process.env.SCORE_MIN) || 30,            // permissive score
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30,   // send pnl alerts >= this
  antiRugLiqDropPct: Number(process.env.ANTIRUG_LIQ_DROP_PCT) || 70, // liquidity drop threshold
  antiRugMinLiquidityAtReport: Number(process.env.ANTIRUG_MIN_LIQ_AT_REPORT) || 500, // require some liq
};

// API retries
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES) || 2;
const FETCH_RETRY_DELAY_MS = Number(process.env.FETCH_RETRY_DELAY_MS) || 400;

const CHAINS = { SOL: "solana", BASE: "base", BNB: "bsc", ETH: "ethereum" };

// Optional extra sources (provide in env if available)
const AXIOM_FEED_URL = process.env.AXIOM_FEED_URL || null; // ex: https://axiom.trade/api/... (if you have)
const GMGN_FEED_URL = process.env.GMGN_FEED_URL || null;   // ex: custom feed URL
const COINGECKO_MARKETS = process.env.ENABLE_COINGECKO === "1"; // optional extra scan

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID in env");
  process.exit(1);
}
// ==============================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// state
let called = new Set();
let tracking = new Map(); // addr -> { msgId, entryMC, symbol, reported, chain, ts, entryLiq }

// persist
function loadState() {
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, "utf8");
      const j = JSON.parse(raw);
      called = new Set(j.called || []);
      tracking = new Map(Object.entries(j.tracking || {}).map(([k, v]) => [k, v]));
      console.log("State loaded:", called.size, "called,", tracking.size, "tracked");
    }
  } catch (e) {
    console.warn("loadState fail:", e.message);
  }
}
function saveState() {
  try {
    const obj = {
      called: [...called],
      tracking: Object.fromEntries([...tracking.entries()]),
      ts: Date.now(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(obj));
  } catch (e) {
    console.warn("saveState fail:", e.message);
  }
}

// utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retryFetch(url, opts = {}, retries = FETCH_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return await res.json();
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { return txt; }
    } catch (err) {
      if (i === retries) {
        console.warn("fetch failed:", url, err?.message || err);
        return null;
      }
      await
