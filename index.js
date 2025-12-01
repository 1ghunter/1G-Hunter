// index.js
// SOLANA FILTER ENGINE v2025 PRO - FULL + ONCHAIN CHECKS + QUEUE + CHARTS + EMBEDS
import fs from "fs";
import axios from "axios";
import http from "http";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Connection, PublicKey } from "@solana/web3.js";

// --------------------------
// CONFIG (inserted from you)
const BOT_TOKEN = "8264706484:AAFDzA59VQL5jv8cTXtmLZpYKjRNFibfPSI";
const CHANNEL_ID = "1443934696424603658";
// --------------------------

// Solana RPC (you can set SOLANA_RPC in env to use QuickNode/Alchemy)
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC, "confirmed");

// Filters
const CHAIN = "solana";
const ALLOWED_SOURCES = ["dex", "raydium", "pumpfun", "pumpswap"];
const MIN_LIQ = 15000;
const MAX_LIQ = 50000;
const MIN_VOL = 100000;
const MAX_VOL = 1000000;
const MIN_MC = 20000;
const MAX_MC = 80000;
const MIN_SCORE = 70;
const EARLY_ALERT_SECONDS = 10;

// Monitoring & deletes
const DELETE_IF_MC_DROP_PCT = 50;
const DELETE_IF_LIQ_DROP_PCT = 60;
const MONITOR_INTERVAL_MS = 30_000;

// Feed endpoints
const GMGN_FEED = "https://gmgn.ai/api/v2/tokens/sol/new";
const DEXSCREENER_SEARCH = (q) => `https://api.dexscreener.com/latest/dex/search?q=${q}`;

// State files
const SENT_FILE = "./sent.json";
const TRACK_FILE = "./tracking.json";

let sent = new Set();
let tracking = new Map();

// Whitelist / VIP mode (addresses that bypass filters)
const WHITELIST = new Set([
  // add lowercase addresses if you want VIP tokens to always pass
  // "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
]);

// Queue for sending messages (rate-limit safe)
const sendQueue = [];
let queueRunning = false;
const QUEUE_CONCURRENCY = 1; // single msg at a time
const QUEUE_BASE_DELAY_MS = 600; // base delay between sends
const QUEUE_MAX_RETRIES = 5;

// Discord client
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

bot.once("ready", () => {
  console.log("[BOT] Ready:", bot.user?.tag);
  loadState();
  // Start scanning intervals
  setInterval(scanLoop, 6_000); // aggressive
  setInterval(monitorPosted, MONITOR_INTERVAL_MS);
  setInterval(saveState, 60_000);
});

// --------------------------
// State helpers
function loadState() {
  try {
    if (fs.existsSync(SENT_FILE)) sent = new Set(JSON.parse(fs.readFileSync(SENT_FILE, "utf8")));
    if (fs.existsSync(TRACK_FILE)) {
      const obj = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));
      tracking = new Map(Object.entries(obj));
    }
    console.log(`[STATE] loaded sent=${sent.size} tracked=${tracking.size}`);
  } catch (e) {
    console.warn("[STATE] load error", e.message || e);
  }
}
function saveState() {
  try {
    fs.writeFileSync(SENT_FILE, JSON.stringify([...sent], null, 2));
    fs.writeFileSync(TRACK_FILE, JSON.stringify(Object.fromEntries([...tracking]), null, 2));
  } catch (e) {
    console.warn("[STATE] save error", e.message || e);
  }
}

// Utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeAddr = (a) => String(a || "").toLowerCase().trim();
const safe = (o, path, def = null) => {
  try { return path.split(".").reduce((s,k) => (s && s[k] !== undefined ? s[k] : null), o) ?? def; } catch { return def; }
};

// --------------------------
// On-chain helpers (using @solana/web3.js)
// --------------------------
async function getMintInfo(mintAddr) {
  try {
    if (!mintAddr) return null;
    const pub = new PublicKey(mintAddr);
    const info = await connection.getParsedAccountInfo(pub);
    const data = info?.value?.data;
    // The parsed data structure can vary; try to get mint info
    if (!info?.value) return null;
    const parsed = info.value?.data?.parsed?.info || {};
    return {
      mintAuthority: parsed.mintAuthority || null,
      freezeAuthority: parsed.freezeAuthority || null,
      supply: parsed.supply ? Number(parsed.supply) : null,
      decimals: parsed.decimals ?? null,
    };
  } catch (e) {
    return null;
  }
}

// return largest token accounts and approx holder count (best-effort)
async function analyzeHolders(mintAddr, maxAccounts = 10) {
  try {
    const mint = new PublicKey(mintAddr);
    const largest = await connection.getTokenLargestAccounts(mint);
    // largest returns array of { address, amount }
    const accounts = largest?.value || [];
    let total = 0;
    const top = [];
    for (const a of accounts.slice(0, maxAccounts)) {
      top.push({ address: a.address, amount: Number(a.amount) });
      total += Number(a.amount);
    }
    // approximate holder count via getTokenSupply or a coarse method
    const supplyInfo = await connection.getTokenSupply(mint).catch(() => null);
    const supply = supplyInfo?.value?.amount ? Number(supplyInfo.value.amount) : null;
    // crude holder concentration ratio top1/supply
    const top1Pct = supply && accounts[0] ? (Number(accounts[0].amount) / supply) * 100 : null;
    return { top, totalTop: total, supply, top1Pct };
  } catch (e) {
    return null;
  }
}

// Best-effort liquidity lock detection: look for common lock program owners in LP token holders
// This is heuristic only.
async function detectLiquidityLock(lpMintAddr) {
  try {
    if (!lpMintAddr) return { locked: null, reason: "no-lp" };
    const analysis = await analyzeHolders(lpMintAddr, 20);
    if (!analysis) return { locked: null, reason: "no-data" };
    // If top holder is a known lock/wallet or >90% held by one address, suspicious/unlocked
    const top1 = analysis.top?.[0];
    if (!top1) return { locked: null, reason: "no-top" };
    const top1Pct = analysis.top1Pct ?? 0;
    // Heuristic: if top1Pct < 5% -> likely distributed (safer). If >75% -> likely not locked.
    if (top1Pct < 5) return { locked: true, reason: "distributed-LP (likely locked/owned by many)" };
    if (top1Pct > 75) return { locked: false, reason: "LP concentrated in one wallet (not locked)" };
    return { locked: null, reason: `top1 ${Math.round(top1Pct)}%` };
  } catch (e) {
    return { locked: null, reason: "err" };
  }
}

// Best-effort tax detection & honeypot heuristics (on-chain + feed)
async function onChainSafetyChecks(pair) {
  // pair should have baseToken.address (token mint) and pairAddress (pair/pair id). Best-effort.
  try {
    const tokenMint = normalizeAddr(pair.baseToken?.address || pair.id || pair.pairAddress);
    if (!tokenMint) return { ok: false, reason: "no-token-mint" };

    // mint info
    const mintInfo = await getMintInfo(tokenMint);
    const holderInfo = await analyzeHolders(tokenMint, 10);

    // Basic checks
    if (mintInfo) {
      // if mintAuthority is null (no more mint) => safer
      if (!mintInfo.mintAuthority) {
        // good
      }
      // freezeAuthority presence could be suspicious
    }

    // Holder concentration
    if (holderInfo?.top1Pct !== null) {
      if (holderInfo.top1Pct > 80) {
        return { ok: false, reason: `Top holder owns ${Math.round(holderInfo.top1Pct)}%` };
      }
    }

    // Liquidity lock detection (if pair has LP mint - we can't always know LP mint from feed; try pair.pairAddress as LP mint)
    const lpMint = pair.pairAddress || null;
    const lpLock = lpMint ? await detectLiquidityLock(lpMint) : { locked: null, reason: "no-lp-mint" };

    // Basic price/tx heuristics from feed
    const buysH1 = safe(pair, "txns.h1.buys", 0);
    const sellsH1 = safe(pair, "txns.h1.sells", 0);
    if (buysH1 === 0 && sellsH1 > 0) return { ok: false, reason: "no-buys-but-sells" };

    // Can't detect "tax" reliably on Solana with simple RPC; we can check for large transfer-only patterns by fetching recent txns
    // But that would require parsing transactions (expensive). We'll skip deep tax detection here, returning best-effort pass.
    return { ok: true, reason: "on-chain heuristics passed", lpLock };
  } catch (e) {
    return { ok: null, reason: "onchain-check-error" };
  }
}

// --------------------------
// Score function (GMGN score fallback + heuristic)
function computeScore(pair) {
  const gmgnScore = safe(pair, "score", null) || safe(pair, "gmgnScore", null);
  if (gmgnScore) return Math.min(100, Math.round(gmgnScore));
  const liq = safe(pair, "liquidity.usd", 0);
  const vol1h = safe(pair, "volume.h1", 0) || safe(pair, "volume24hUSD", 0) || 0;
  const h1p = safe(pair, "priceChange.h1", 0) || 0;
  const buys = safe(pair, "txns.h1.buys", 0);
  const sells = safe(pair, "txns.h1.sells", 0);
  let s = 10;
  s += Math.min(30, liq / 10000);
  s += Math.min(30, vol1h / 100000);
  s += Math.max(0, Math.min(20, h1p * 1.5));
  if (buys > sells) s += 10;
  return Math.round(Math.min(99, s));
}

// Chart builder using QuickChart or Dexscreener URL
function buildChartUrl(pair) {
  const chain = (pair._sourceChain || pair.chain || "solana").toLowerCase();
  const addr = normalizeAddr(pair.baseToken?.address || pair.pairAddress || pair.id || pair.address);
  if (addr) return `https://dexscreener.com/${chain}/${addr}`;
  return `https://quickchart.io/chart?c={type:'doughnut',data:{labels:['Liq','Free'],datasets:[{data:[${Math.round(safe(pair,'liquidity.usd',0))},1}]}}`;
}

// Compose embed and buttons
function makeEmbed(pair, score, onChainResult, priority = false) {
  const addr = normalizeAddr(pair.baseToken?.address || pair.id || pair.pairAddress);
  const liq = safe(pair, "liquidity.usd", 0);
  const vol = safe(pair, "volume.h1", 0) || safe(pair, "volume24hUSD", 0) || 0;
  const mc = safe(pair, "marketCap", 0) || safe(pair, "fdv", 0) || 0;
  const symbol = (safe(pair, "baseToken.symbol", "TOKEN") || "TOKEN").toUpperCase();
  const chartUrl = buildChartUrl(pair);

  const color = score > 80 ? 0x00ff00 : score > 60 ? 0xffa500 : 0xff0000;

  const embed = new EmbedBuilder()
    .setTitle(`${priority ? "⚡ EARLY ALERT" : "📈 New SOL Token" } - ${symbol}`)
    .setDescription(`**CA:** \`${addr}\`\n**Score:** ${score}\n**Liquidity:** $${liq.toLocaleString()} • **Volume:** $${vol.toLocaleString()}\n**Marketcap:** $${mc.toLocaleString()}`)
    .setURL(chartUrl)
    .setColor(color)
    .setTimestamp()
    .addFields(
      { name: "Source", value: `${safe(pair,
