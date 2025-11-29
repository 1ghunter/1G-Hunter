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
      await sleep(FETCH_RETRY_DELAY_MS * (i + 1));
    }
  }
  return null;
}

// --------- Data sources ---------
// Dexscreener correct endpoints
async function fetchDexPairs(chain) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}`;
    const j = await retryFetch(url);
    return j?.pairs || [];
  } catch {
    return [];
  }
}

// optional: fetch axiom feed if provided (must be JSON with pairs array or tokens)
async function fetchAxiomFeed() {
  if (!AXIOM_FEED_URL) return [];
  try {
    const j = await retryFetch(AXIOM_FEED_URL);
    // normalize: accept { pairs: [...] } or array
    if (!j) return [];
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.pairs)) return j.pairs;
    return [];
  } catch {
    return [];
  }
}

// optional: gmgn feed
async function fetchGmgnFeed() {
  if (!GMGN_FEED_URL) return [];
  try {
    const j = await retryFetch(GMGN_FEED_URL);
    if (!j) return [];
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.pairs)) return j.pairs;
    return [];
  } catch {
    return [];
  }
}

// optional: coinGecko markets to widen coverage (new tokens)
async function fetchCoinGeckoMarkets() {
  if (!COINGECKO_MARKETS) return [];
  try {
    // top 250 markets (may include memecoins)
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
    const arr = await retryFetch(url);
    if (!arr || !Array.isArray(arr)) return [];
    // map to Dex-like structure for scanning (best effort)
    return arr.map((c) => ({
      baseToken: { symbol: c.symbol?.toUpperCase() || c.id, address: c.contract_address || c.id },
      marketCap: c.market_cap || 0,
      liquidity: { usd: (c.total_volume || 0) / 10 }, // heuristic
      volume: { h1: c.total_volume || 0 },
      priceChange: { h1: (c.price_change_percentage_24h || 0) / 24 }, // rough per-hour
      pairAddress: c.contract_address || c.id,
      pairCreatedAt: null,
      chain: "COINGECKO",
    }));
  } catch {
    return [];
  }
}

// ---------- Scoring & filters ----------
function scorePair(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const m5 = p.priceChange?.m5 || 0;

  let s = 40;
  s += Math.min(h1 * 1.1, 30);
  if (vol > 300_000) s += 20;
  else if (vol > 100_000) s += 12;
  if (liq > 50_000) s += 18;
  else if (liq > 10_000) s += 8;
  if (m5 > 15) s += 18;
  if (mc < 200_000) s += 10;
  if (mc < 50_000) s += 8;
  return Math.min(99, Math.round(s));
}

function normalizeAddr(a) {
  return (a || "").toLowerCase();
}

function passesMemeFilters(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const score = scorePair(p);
  if (mc < MEME_SETTINGS.minMarketCap || mc > MEME_SETTINGS.maxMarketCap) return false;
  if (liq < MEME_SETTINGS.minLiquidityUsd) return false;
  if (vol < MEME_SETTINGS.minVolumeH1) return false;
  if (h1 < MEME_SETTINGS.minPriceChangeH1) return false;
  if (score < MEME_SETTINGS.minScore) return false;
  return true;
}

// ---------- Core: find & announce ----------
async function collectCandidates() {
  const sources = [];

  // Dexscreener by chain
  const chains = Object.values(CHAINS);
  const dexPromises = chains.map((c) => fetchDexPairs(c).catch(() => []));
  const dexResults = await Promise.all(dexPromises);
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i];
    const arr = dexResults[i] || [];
    for (const p of arr) {
      // attach chain
      p._sourceChain = chain;
      sources.push(p);
    }
  }

  // Axiom feed (optional)
  const ax = await fetchAxiomFeed();
  for (const p of ax) {
    p._source = "axiom";
    sources.push(p);
  }

  // GMGN feed (optional)
  const gm = await fetchGmgnFeed();
  for (const p of gm) {
    p._source = "gmgn";
    sources.push(p);
  }

  // CoinGecko markets (optional)
  const cg = await fetchCoinGeckoMarkets();
  for (const p of cg) {
    p._source = "coingecko";
    sources.push(p);
  }

  // dedupe by address
  const map = new Map();
  for (const s of sources) {
    const addr = normalizeAddr(s.pairAddress || s.baseToken?.address || s.address || s.id);
    if (!addr) continue;
    if (!map.has(addr)) map.set(addr, s);
  }
  return Array.from(map.values());
}

async function dropCall() {
  try {
    const candidates = await collectCandidates();
    if (!candidates || candidates.length === 0) return;

    let best = null;
    for (const p of candidates) {
      const addr = normalizeAddr(p.pairAddress || p.baseToken?.address || p.address || p.id);
      if (!addr) continue;
      if (called.has(addr)) continue;

      // apply hyper meme filters
      if (!passesMemeFilters(p)) continue;

      const score = scorePair(p);
      if (!best || score > best.score) best = { ...p, score, addr };
    }

    if (!best) return;

    // mark called
    called.add(best.addr);

    const baseSym = best.baseToken?.symbol || (best.baseToken && best.baseToken.name) || "TOKEN";
    const liqUsd = best.liquidity?.usd || 0;
    const volH1 = best.volume?.h1 || 0;
    const mc = best.marketCap || best.fdv || 0;
    const green = liqUsd > 50_000 && (best.priceChange?.m5 || 0) > 12;

    const embed = new EmbedBuilder()
      .setColor(green ? 0x00ff44 : 0xffaa00)
      .setTitle(`${best.score}% WIN PROBABILITY — 1G VAULT CALL`)
      .setDescription(
        [
          `**${(best._sourceChain || best._source || "multi").toString().toUpperCase()} DEGEN MOONSHOT** — $${baseSym}`,
          ``,
          `**CA:** \`${best.baseToken?.address || best.pairAddress || "unknown"}\``,
          ``,
          `**MC:** $${(mc / 1000).toFixed(1)}K • **Age:** ${best.pairCreatedAt ? Math.round((Date.now() - new Date(best.pairCreatedAt)) / 60000) + "m" : "?"}`,
          `**1h Vol:** $${(volH1 / 1000).toFixed(0)}K`,
          `**Liq:** $${(liqUsd / 1000).toFixed(0)}K → **ANTI-RUG ${green ? "GREEN" : "YELLOW"}**`,
          ``,
          `${green ? "SAFEST BANGER RIGHT NOW" : "YELLOW = VERY DEGEN - DYOR"}`
        ].join("\n")
      )
      .setThumbnail(best.baseToken?.logoURI || null)
      .setTimestamp()
      .setFooter({ text: "1G Vault • DYOR • Not financial advice" });

    const chartChain = (best._sourceChain === "bsc" || best.chain === "bsc") ? "bsc"
      : (best._sourceChain === "solana" || best.chain === "solana") ? "solana"
      : (best._sourceChain === "base" || best.chain === "base") ? "base" : "ethereum";

    const chartUrl = `https://dexscreener.com/${chartChain}/${best.addr}`;
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
      new ButtonBuilder().setLabel("SNIPE 0% FEE →").setStyle(ButtonStyle.Link).setURL(REF)
    );

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) return;

    const msg = await channel.send({ embeds: [embed], components: [buttons] }).catch(() => null);
    if (!msg) return;

    // record for flex checks
    tracking.set(best.addr, {
      msgId: msg.id,
      entryMC: mc || 1,
      entryLiq: liqUsd || 0,
      symbol: baseSym,
      reported: false,
      chain: best._sourceChain || best.chain || best._source || "unknown",
      ts: Date.now(),
    });

    saveState();
    console.log("ANNOUNCE:", best.addr, baseSym, "score", best.score);
  } catch (e) {
    console.warn("dropCall err:", e?.message || e);
  }
}

// ---------- Flex / PnL reporting ----------
async function isRugPair(addr, entryLiq, latestLiq) {
  // simple anti-rug heuristics:
  // - liquidity falling drastically (> antiRugLiqDropPct)
  // - liquidity becomes near-zero
  if (!entryLiq || !latestLiq) return false;
  const dropPct = ((entryLiq - latestLiq) / (entryLiq || 1)) * 100;
  if (dropPct >= MEME_SETTINGS.antiRugLiqDropPct) return true;
  if (latestLiq < MEME_SETTINGS.antiRugMinLiquidityAtReport) return true;
  return false;
}

async function flexGains() {
  try {
    for (const [addr, data] of Array.from(tracking.entries())) {
      if (!data || data.reported) continue;
      const chain = (data.chain === "BNB" ? "bsc" : data.chain?.toLowerCase?.()) || "bsc";
      // fetch latest pair from Dexscreener if possible
      const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`;
      const j = await retryFetch(url);
      const p = j?.pair;
      if (!p) {
        // try generic fetch across chains if specific fails
        let found = null;
        for (const c of Object.values(CHAINS)) {
          const r = await retryFetch(`https://api.dexscreener.com/latest/dex/pairs/${c}/${addr}`);
          if (r?.pair) { found = r.pair; break; }
        }
        if (found) {
          // use found
          p = found;
        } else {
          continue;
        }
      }
      const currentMC = p.marketCap || p.fdv || 0;
      const currentLiq = p.liquidity?.usd || 0;
      const gain = ((currentMC - (data.entryMC || 1)) / (data.entryMC || 1)) * 100;
      if (gain < MEME_SETTINGS.flexGainMinPct) continue;

      // anti-rug checks: ensure liquidity didn't rug-out
      const rug = await isRugPair(addr, data.entryLiq || 0, currentLiq || 0);
      if (rug) {
        console.log("Skipped flex (possible rug):", addr);
        // mark reported true to avoid repeating
        data.reported = true;
        tracking.set(addr, data);
        saveState();
        continue;
      }

      const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) continue;
      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      const fire = gain > 10000 ? "100000%" : gain > 1000 ? "10000%" : gain > 500 ? "1000%" : `${Math.round(gain)}%`;
      const pnl = gain.toFixed(1);
      const profitText = `📈 $${data.symbol} UP ${pnl}% FROM 1G CALL — ${fire} FLEX`;

      const flexEmbed = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(profitText)
        .setDescription([
          `Entry MC: $${(data.entryMC / 1000).toFixed(1)}K → Now: $${(currentMC / 1000).toFixed(1)}K`,
          `Entry Liq: $${(data.entryLiq / 1000).toFixed(1)}K → Now: $${(currentLiq / 1000).toFixed(1)}K`,
          `PNL: ${pnl}% • NOT financial advice • DYOR`
        ].join("\n"))
        .setTimestamp();

      await orig.reply({ embeds: [flexEmbed] }).catch(() => null);

      data.reported = true;
      tracking.set(addr, data);
      saveState();
      console.log("FLEX:", addr, data.symbol, "gain", pnl);
    }

    // prune old tracking entries
    const now = Date.now();
    for (const [addr, data] of Array.from(tracking.entries())) {
      const ageMin = (now - (data.ts || now)) / 60000;
      if (ageMin > MAX_TRACKING_AGE_MIN) {
        tracking.delete(addr);
        saveState();
      }
    }
  } catch (e) {
    console.warn("flexGains err:", e?.message || e);
  }
}

// ---------- Scheduler ----------
client.once("ready", async () => {
  console.log("1G VAULT HYPER MULTI-SOURCE LIVE —", new Date().toISOString());
  loadState();

  // initial quick-run
  await dropCall();

  // schedule loop with jitter
  const loop = async () => {
    try {
      await dropCall();
    } catch (e) {
      console.warn("loop dropCall err:", e?.message || e);
    } finally {
      const min = Math.max(1000, MIN_DROP_INTERVAL_MS);
      const max = Math.max(min, MAX_DROP_INTERVAL_MS);
      const delay = min + Math.floor(Math.random() * (max - min + 1));
      setTimeout(loop, delay);
    }
  };
  const firstDelay = Math.max(100, MIN_DROP_INTERVAL_MS) + Math.floor(Math.random() * Math.max(1, MAX_DROP_INTERVAL_MS - MIN_DROP_INTERVAL_MS + 1));
  setTimeout(loop, firstDelay);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(() => { // keep alive ping if host provided
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.KEEP_ALIVE_HOST;
    if (host) fetch(host.startsWith("http") ? host : `https://${host}`).catch(() => null);
  }, KEEP_ALIVE_MS);

  setInterval(saveState, SAVE_INTERVAL_MS);
});

// ---------- Basic admin commands ----------
client.on("messageCreate", async (msg) => {
  if (!msg.content) return;
  const t = msg.content.toLowerCase().trim();

  if ((t === "/start" || t === "/ping") && msg.channel.id === CHANNEL_ID) {
    await msg.reply("**1G VAULT HYPER MULTI-SOURCE IS LIVE**\nExpect frequent memecoin calls. DYOR.");
  }

  if ((t === "/reset_called" || t === "/clear_called") && msg.channel.id === CHANNEL_ID) {
    called.clear();
    saveState();
    await msg.reply("Called list cleared.");
  }

  if ((t === "/state" || t === "/status") && msg.channel.id === CHANNEL_ID) {
    const s = `called=${called.size} tracked=${tracking.size}`;
    await msg.reply("State: " + s);
  }
});

client.login(TOKEN).catch((e) => {
  console.error("login failed:", e?.message || e);
  process.exit(1);
});
