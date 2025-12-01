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
      { name: "Source", value: `${safe(pair, "source", "gmgn")}`, inline: true },
      { name: "Age (s)", value: `${safe(pair, "ageSeconds", safe(pair, "pairAgeSeconds", "n/a"))}`, inline: true },
      { name: "On-chain check", value: `${onChainResult?.ok ? "✅" : onChainResult?.ok === false ? "❌" : "⚠️"} ${onChainResult?.reason || ""}`, inline: false },
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("View Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
    new ButtonBuilder().setLabel("View on Dexscreener").setStyle(ButtonStyle.Link).setURL(chartUrl),
    new ButtonBuilder().setLabel("SNIPE →").setStyle(ButtonStyle.Link).setURL("https://jup.ag/")
  );

  // QuickChart snapshot image (doughnut of liq)
  const quickChart = `https://quickchart.io/chart?c={type:'doughnut',data:{labels:['Liquidity','Remaining'],datasets:[{data:[${Math.round(liq)},${Math.max(1, Math.round(mc - liq || 1))}] } ]}}`;
  embed.setImage(quickChart);

  return { embeds: [embed], components: [buttons] };
}

// Rate-limit-safe queue send
function enqueueSend(payload, attempt = 0) {
  sendQueue.push({ payload, attempt });
  if (!queueRunning) processQueue();
}
async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (sendQueue.length > 0) {
    const item = sendQueue.shift();
    try {
      const channel = await bot.channels.fetch(CHANNEL_ID);
      if (!channel) throw new Error("channel-not-found");
      // send embed or text
      const sentMsg = await channel.send(item.payload);
      // small delay
      await sleep(QUEUE_BASE_DELAY_MS);
      // on success, we may want to return the sent message object to caller - but here we store in tracking when announcing
    } catch (e) {
      console.warn("[QUEUE] send failed:", e?.message || e);
      // retry with exponential backoff
      if (item.attempt < QUEUE_MAX_RETRIES) {
        item.attempt++;
        const backoff = QUEUE_BASE_DELAY_MS * Math.pow(2, item.attempt);
        await sleep(backoff);
        sendQueue.unshift(item); // put back at front
      } else {
        console.warn("[QUEUE] dropping message after max retries");
      }
    }
  }
  queueRunning = false;
}

// Announce pair (with on-chain checks & queue)
async function announcePair(pair, priority = false) {
  try {
    const addr = normalizeAddr(pair.baseToken?.address || pair.id || pair.pairAddress || pair.address);
    if (!addr) return false;
    if (sent.has(addr) && !WHITELIST.has(addr)) return false; // never repeat unless whitelisted

    // quick numeric filters
    const liq = safe(pair, "liquidity.usd", 0);
    const vol = safe(pair, "volume.h1", 0) || safe(pair, "volume24hUSD", 0) || 0;
    const mc = safe(pair, "marketCap", 0) || safe(pair, "fdv", 0) || 0;

    if (!WHITELIST.has(addr)) {
      if (liq < MIN_LIQ || liq > MAX_LIQ) { console.log(`[FILTER] liq fail ${addr}`); return false; }
      if (vol < MIN_VOL || vol > MAX_VOL) { console.log(`[FILTER] vol fail ${addr}`); return false; }
      if (mc < MIN_MC || mc > MAX_MC) { console.log(`[FILTER] mc fail ${addr}`); return false; }
    }

    const score = computeScore(pair);
    if (!WHITELIST.has(addr) && score < MIN_SCORE) { console.log(`[FILTER] score fail ${score} ${addr}`); return false; }

    // on-chain checks
    const onChainResult = await onChainSafetyChecks(pair);
    if (onChainResult?.ok === false && !WHITELIST.has(addr)) {
      console.log(`[ONCHAIN] failed for ${addr}: ${onChainResult.reason}`);
      return false;
    }

    const payload = makeEmbed(pair, score, onChainResult, priority);

    // enqueue sending; but we want the sent message id to store tracking — so we send via queue but also attempt to get the message by sending directly with backoff wrapper
    // We'll implement a send-with-retries that uses the queue delays
    const sentMsg = await sendWithRetries(payload);

    if (!sentMsg) return false;

    // mark as sent and track
    sent.add(addr);
    tracking.set(addr, {
      msgId: sentMsg.id,
      channelId: CHANNEL_ID,
      entryLiq: liq,
      entryMC: mc,
      symbol: (safe(pair, "baseToken.symbol") || "TOKEN").toUpperCase(),
      ts: Date.now(),
      score,
    });
    saveState();
    console.log(`[ANNOUNCE] ${addr} posted (score ${score})`);
    return true;
  } catch (e) {
    console.warn("[announcePair] error:", e?.message || e);
    return false;
  }
}

// sendWithRetries: does exponential backoff and returns the sent message object
async function sendWithRetries(payload) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= QUEUE_MAX_RETRIES) {
    try {
      const channel = await bot.channels.fetch(CHANNEL_ID);
      if (!channel) throw new Error("channel-missing");
      const sentMsg = await channel.send(payload);
      // short pause
      await sleep(QUEUE_BASE_DELAY_MS);
      return sentMsg;
    } catch (e) {
      lastErr = e;
      attempt++;
      const backoff = QUEUE_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[SEND] attempt ${attempt} failed: ${e?.message || e}. backoff ${backoff}ms`);
      await sleep(backoff);
    }
  }
  console.warn("[SEND] all attempts failed:", lastErr?.message || lastErr);
  return null;
}

// Fetch candidates (GMGN + Dexscreener)
async function fetchGmgnCandidates() {
  try {
    const resp = await axios.get(GMGN_FEED, { timeout: 8000 });
    const tokens = safe(resp, "data.tokens", []) || [];
    return tokens.map(t => ({
      baseToken: { address: t.ca || t.address || t.tokenAddress, symbol: t.symbol || t.name },
      liquidity: { usd: t.liquidity || t.liqUsd || 0 },
      volume: { h1: t.volumeH1 || t.vol24h || 0 },
      marketCap: t.marketCap || t.mc || 0,
      score: t.score || t.rating || 0,
      source: (t.source || "gmgn").toLowerCase(),
      chain: (t.chain || "solana").toLowerCase(),
      ageSeconds: t.ageSeconds || (t.ageMinutes ? t.ageMinutes * 60 : 9999),
      txns: t.txns || {},
      pairAddress: t.pair || t.pairAddress || null,
      id: t.ca || t.tokenAddress || t.address,
    }));
  } catch (e) {
    console.warn("[GMGN] err", e?.message || e);
    return [];
  }
}

async function fetchDexScreenerNew() {
  try {
    const q = "new";
    const resp = await axios.get(DEXSCREENER_SEARCH(q), { timeout: 8000 });
    const pairs = safe(resp, "data.pairs", []) || safe(resp, "data", []) || [];
    return pairs
      .filter(p => (p.chainId || p.chain || "").toString().toLowerCase().includes("solana"))
      .map(p => ({
        baseToken: { address: p.baseToken?.address || p.baseToken?.tokenAddress || p.id, symbol: p.baseToken?.symbol || p.baseSymbol },
        liquidity: { usd: p.liquidity?.usd || p.liquidity || 0 },
        volume: { h1: p.volume?.h1 || p.volume || p.volume24hUSD || 0 },
        marketCap: p.marketCap || p.fdv || 0,
        score: p.score || 0,
        source: (p._source || p.source || "dex").toLowerCase(),
        chain: (p.chainId || p.chain || "solana").toLowerCase(),
        ageSeconds: p.ageSeconds || p.pairAgeSeconds || 9999,
        txns: p.txns || {},
        pairAddress: p.pairAddress || p.pair || p.id,
        id: p.baseToken?.address || p.baseToken?.tokenAddress || p.baseSymbol || p.id,
      }));
  } catch (e) {
    console.warn("[DEXSCR] err", e?.message || e);
    return [];
  }
}

async function collectCandidates() {
  const [g, d] = await Promise.all([fetchGmgnCandidates(), fetchDexScreenerNew()]);
  const combined = [...g, ...d];
  const map = new Map();
  for (const p of combined) {
    const addr = normalizeAddr(p.baseToken?.address || p.id || p.pairAddress);
    if (!addr) continue;
    if ((p.chain || "").toLowerCase() !== CHAIN) continue;
    const src = (p.source || "").toLowerCase();
    if (!ALLOWED_SOURCES.includes(src)) continue;
    const existing = map.get(addr);
    if (!existing) map.set(addr, p);
    else {
      const eLiq = safe(existing, "liquidity.usd", 0);
      const pLiq = safe(p, "liquidity.usd", 0);
      if (pLiq > eLiq) map.set(addr, p);
    }
  }
  const results = Array.from(map.values());
  console.log(`[COLLECT] ${results.length} candidates`);
  return results;
}

// Main scan loop
let scanning = false;
async function scanLoop() {
  if (scanning) return;
  scanning = true;
  try {
    const candidates = await collectCandidates();
    const early = [];
    const normal = [];
    for (const c of candidates) {
      const age = Number(safe(c, "ageSeconds", safe(c, "pairAgeSeconds", 9999)));
      if (age <= EARLY_ALERT_SECONDS) early.push(c);
      else normal.push(c);
    }
    // early first
    for (const p of early) {
      try { await announcePair(p, true); } catch (e) { console.warn("[SCAN] early err", e.message || e); }
      await sleep(400);
    }
    // normal
    for (const p of normal) {
      try { await announcePair(p, false); } catch (e) { console.warn("[SCAN] normal err", e.message || e); }
      await sleep(600);
    }
  } catch (e) {
    console.warn("[scanLoop] err", e?.message || e);
  } finally {
    scanning = false;
  }
}

// Monitor posted messages and auto-delete if MC/Liq collapse
async function monitorPosted() {
  try {
    if (tracking.size === 0) return;
    for (const [addr, tdata] of Array.from(tracking.entries())) {
      // dexscreener token endpoint
      const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
      const res = await axios.get(url, { timeout: 7000 }).catch(() => null);
      const pairs = safe(res, "data.pairs", []) || [];
      const p = pairs.find(pair => normalizeAddr(pair.baseToken?.address || pair.baseToken?.tokenAddress) === normalizeAddr(addr)) || pairs[0];
      if (!p) continue;
      const currentLiq = safe(p, "liquidity.usd", 0);
      const currentMC = safe(p, "marketCap", 0) || safe(p, "fdv", 0) || 0;
      const entryLiq = Number(tdata.entryLiq || 0);
      const entryMC = Number(tdata.entryMC || 0);
      if (entryMC > 0 && currentMC > 0) {
        const mcDropPct = ((entryMC - currentMC) / entryMC) * 100;
        if (mcDropPct >= DELETE_IF_MC_DROP_PCT) {
          // delete
          try {
            const channel = await bot.channels.fetch(tdata.channelId);
            const orig = await channel.messages.fetch(tdata.msgId).catch(() => null);
            if (orig) {
              await orig.delete().catch(() => null);
              console.log(`[DELETE] removed ${addr} due to MC drop ${Math.round(mcDropPct)}%`);
            }
            tracking.delete(addr);
            saveState();
            continue;
          } catch (e) { console.warn("[MON DEL] err", e.message || e); }
        }
      }
      if (entryLiq > 0) {
        const liqDropPct = ((entryLiq - currentLiq) / entryLiq) * 100;
        if (liqDropPct >= DELETE_IF_LIQ_DROP_PCT) {
          try {
            const channel = await bot.channels.fetch(tdata.channelId);
            const orig = await channel.messages.fetch(tdata.msgId).catch(() => null);
            if (orig) {
              await orig.delete().catch(() => null);
              console.log(`[DELETE] removed ${addr} due to Liq drop ${Math.round(liqDropPct)}%`);
            }
            tracking.delete(addr);
            saveState();
            continue;
          } catch (e) { console.warn("[MON DEL] err", e.message || e); }
        }
      }
      // refresh timestamp
      tdata.lastChecked = Date.now();
      tracking.set(addr, tdata);
    }
  } catch (e) {
    console.warn("[monitorPosted] err", e.message || e);
  }
}

// Start listening
bot.login(BOT_TOKEN).catch(e => {
  console.error("[LOGIN] failed:", e?.message || e);
  process.exit(1);
});

// Render keepalive
const APP_PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot running OK");
}).listen(APP_PORT, () => console.log(`[HTTP] listening on ${APP_PORT}`));
