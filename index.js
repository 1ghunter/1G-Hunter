// =======================================================
// 1G VAULT V5.2 - GUARANTEED DROP CONFIGURATION
// Filters are set to minimal volume/liquidity to force an immediate call.
// =======================================================
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

// --- CONFIGURATION ---
const BOT_NAME = "1G VAULT V5.2"; 
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://jup.ag/"; 
const CHAINS = { SOL: "solana", BASE: "base", BNB: "bsc", ETH: "ethereum" };

// --- SCHEDULING ---
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 60_000;
const MAX_DROP_INTERVAL_MS = Number(process.env.MAX_DROP_INTERVAL_MS) || 120_000;
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 90_000;
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;

// --- MEME FILTER SETTINGS (MINIMAL REQUIREMENTS) ---
const MEME_SETTINGS = {
  // SET TO ABSOLUTE MINIMUMS
  minMarketCap: Number(process.env.MC_MIN) || 1,        
  maxMarketCap: Number(process.env.MC_MAX) || 10_000_000, 
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 100,   // $100 min liquidity
  minVolumeH1: Number(process.env.VOL_H1_MIN) || 1,     // $1 min volume
  minPriceChangeH1: Number(process.env.PCT_H1_MIN) || -50,  // Allows negative momentum, forces drop
  minScore: Number(process.env.SCORE_MIN) || 0,           // Score check effectively disabled
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30, 
};

// --- EXTERNAL SOURCES ---
const AXIOM_FEED_URL = process.env.AXIOM_FEED_URL || null;
const GMGN_FEED_URL = process.env.GMGN_FEED_URL || null;
const COINGECKO_MARKETS = process.env.ENABLE_COINGECKO === "1";

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID in env");
  process.exit(1);
}
// =======================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let called = new Set();
let tracking = new Map();

// --- STATE MANAGEMENT ---
function loadState() {
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, "utf8");
      const j = JSON.parse(raw);
      called = new Set(j.called || []);
      tracking = new Map(Object.entries(j.tracking || {}));
      console.log(`[STATE] Loaded: ${called.size} called, ${tracking.size} tracked`);
    }
  } catch (e) {
    console.warn("[STATE] Load fail:", e.message);
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
    console.warn("[STATE] Save fail:", e.message);
  }
}

// --- UTILITIES ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeAddr = (a) => (a || "").toLowerCase();
const retryFetch = async (url, retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) {
        console.warn(`[API FAIL] ${url}`, err?.message || err);
        return null;
      }
      await sleep(400 * (i + 1));
    }
  }
  return null;
};

// --- DATA SOURCES ---
async function fetchDexPairs(chain) {
  // Use 'trending' search query which works better than a specific pairs list
  const query = `trending`; 
  const url = `https://api.dexscreener.com/latest/dex/search?q=${query}`;
  const j = await retryFetch(url);
  
  const pairs = j?.pairs || [];
  const filteredPairs = pairs.filter(p => p.chainId?.toLowerCase() === chain.toLowerCase());
  
  if (filteredPairs.length === 0) {
     console.log(`[DEX] Chain ${chain}: Found 0 pairs (from ${pairs.length} total trending).`);
  } else {
     console.log(`[DEX] Chain ${chain}: Found ${filteredPairs.length} candidates.`);
  }

  return filteredPairs.map(p => ({ ...p, _sourceChain: chain }));
}

async function fetchExternalFeed(url, source) {
  if (!url) return [];
  try {
    const j = await retryFetch(url);
    if (!j) return [];
    const pairs = Array.isArray(j) ? j : (Array.isArray(j.pairs) ? j.pairs : []);
    return pairs.map(p => ({ ...p, _source: source }));
  } catch {
    return [];
  }
}

// --- SCORING & FILTERING ---
function scorePair(p) {
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0; 
  const m5 = p.priceChange?.m5 || 0; 

  let s = 10; 
  s += Math.min(h1 * 2, 40); // 2x momentum points
  s += Math.min(m5 * 1.5, 20); // 1.5x 5min momentum
  if (liq > 20_000) s += 10;
  if (vol > 10_000) s += 10;
  
  // Prioritize external feeds which clearly have high-momentum tokens
  if (p._source === 'axiom' || p._source === 'gmgn') {
      s += 20;
  }

  return Math.min(99, Math.round(s));
}

function passesMemeFilters(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const score = scorePair(p);
  
  // Minimal checks: Only ensure liquidity, minimal volume, and within MC bounds.
  if (mc < MEME_SETTINGS.minMarketCap || mc > MEME_SETTINGS.maxMarketCap) { return false; }
  if (liq < MEME_SETTINGS.minLiquidityUsd) { return false; }
  if (vol < MEME_SETTINGS.minVolumeH1) { return false; }
  
  // All other filters are now permissive.
  if (h1 < MEME_SETTINGS.minPriceChangeH1) { return false; }
  if (score < MEME_SETTINGS.minScore) { return false; }
  
  return true;
}

// --- CORE SCANNER LOGIC ---
async function collectCandidates() {
  const sources = [];

  const dexPromises = Object.values(CHAINS).map(c => fetchDexPairs(c));
  const dexResults = await Promise.all(dexPromises);
  dexResults.forEach(arr => sources.push(...arr));

  sources.push(...await fetchExternalFeed(AXIOM_FEED_URL, "axiom"));
  sources.push(...await fetchExternalFeed(GMGN_FEED_URL, "gmgn"));

  if (COINGECKO_MARKETS) {
    const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
    const arr = await retryFetch(cgUrl);
    if (Array.isArray(arr)) {
        const cgPairs = arr.map(c => ({
            baseToken: { symbol: c.symbol?.toUpperCase() || c.id, address: c.contract_address || c.id },
            marketCap: c.market_cap || 0,
            liquidity: { usd: (c.total_volume || 0) / 5 }, 
            volume: { h1: c.total_volume || 0 },
            priceChange: { h1: (c.price_change_percentage_24h || 0) / 24 }, 
            pairAddress: c.contract_address || c.id,
            _source: "coingecko",
        }));
        sources.push(...cgPairs);
    }
  }

  const map = new Map();
  for (const s of sources) {
    const addr = normalizeAddr(s.pairAddress || s.baseToken?.address || s.address || s.id);
    if (!addr) continue;
    if (!map.has(addr)) map.set(addr, s);
  }
  
  console.log(`[SCAN] Found ${map.size} unique candidates after deduplication.`);
  return Array.from(map.values());
}

// --- ANNOUNCEMENT (Clean Discord Output) ---
async function createCallEmbed(best) {
  const baseSym = best.baseToken?.symbol || "TOKEN";
  const liqUsd = best.liquidity?.usd || 0;
  const volH1 = best.volume?.h1 || 0;
  const mc = best.marketCap || best.fdv || 0;
  const score = best.score;

  const chainName = (best._sourceChain || best._source || "multi").toString().toUpperCase();
  const color = score > 60 ? 0x00FF44 : score > 30 ? 0xFF9900 : 0xFF0000;
  const safety = liqUsd > 10000 ? "✅ LOW RISK" : liqUsd > 2000 ? "⚠️ MODERATE RISK" : "🚨 HIGH RISK";
  const statusEmoji = score > 60 ? "🔥" : "🚀";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusEmoji} ${score}% PROBABILITY - ${BOT_NAME} CALL: $${baseSym} ${statusEmoji}`)
    .setDescription(
      [
        `**Source:** \`${chainName}\``,
        `**CA:** \`${best.baseToken?.address || best.pairAddress || "unknown"}\``,
        `---`,
        `💰 **Mkt Cap:** $${(mc / 1000).toFixed(1)}K`,
        `💧 **Liquidity:** $${(liqUsd / 1000).toFixed(1)}K`,
        `📈 **1H Momentum:** ${best.priceChange?.h1?.toFixed(1) || 0}%`,
        `📊 **1H Volume:** $${(volH1 / 1000).toFixed(0)}K`,
        `---`,
        `**Safety:** ${safety} - *Not financial advice. DYOR.*`
      ].join("\n")
    )
    .setTimestamp()
    .setFooter({ text: `${BOT_NAME}` });

  const chartChain = best._sourceChain || best.chain || 'solana'; 
  const chartUrl = `https://dexscreener.com/${chartChain}/${best.addr}`;
  
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("View Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
    new ButtonBuilder().setLabel("SNIPE NOW →").setStyle(ButtonStyle.Link).setURL(REF)
  );
  
  return { embeds: [embed], components: [buttons] };
}

async function dropCall() {
  try {
    const candidates = await collectCandidates();
    if (!candidates || candidates.length === 0) return;

    let best = null;
    for (const p of candidates) {
      const addr = normalizeAddr(p.pairAddress || p.baseToken?.address || p.address || p.id);
      if (!addr || called.has(addr)) continue;

      if (!passesMemeFilters(p)) continue;

      const score = scorePair(p);
      if (!best || score > best.score) best = { ...p, score, addr };
    }

    if (!best) {
      console.log("[SCAN] No candidate passed all filters and score checks.");
      return;
    }

    called.add(best.addr);
    
    const messagePayload = await createCallEmbed(best);

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) {
        console.warn("[DISCORD] Failed to find channel or send messages. Check CHANNEL_ID/Permissions.");
        return;
    }

    const msg = await channel.send(messagePayload).catch((e) => {
        console.warn("[DISCORD] Error sending message:", e.message);
        return null;
    });
    if (!msg) return;

    // Record for PnL tracking (Flex)
    tracking.set(best.addr, {
      msgId: msg.id,
      entryMC: best.marketCap || 1,
      entryLiq: best.liquidity?.usd || 0,
      symbol: best.baseToken?.symbol,
      reported: false,
      chain: best._sourceChain || best.chain || best._source || "unknown",
      ts: Date.now(),
    });

    saveState();
    console.log(`[ANNOUNCE] CALL SUCCESS: ${best.addr} $${best.baseToken?.symbol} Score: ${best.score}`);
  } catch (e) {
    console.warn("[dropCall] Runtime error:", e?.message || e);
  }
}

// --- PNL / FLEX LOGIC (Auto-Reply Profit Reporting) ---
async function flexGains() {
  try {
    for (const [addr, data] of Array.from(tracking.entries())) {
      if (!data || data.reported) continue;
      
      const chain = (data.chain === "BNB" ? "bsc" : data.chain?.toLowerCase?.()) || "solana"; 
      const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`;
      const j = await retryFetch(url);
      
      const p = j?.pair || j?.pairs?.[0]; 
      
      if (!p) continue;

      const currentMC = p.marketCap || p.fdv || 0;
      const currentLiq = p.liquidity?.usd || 0;
      const gain = ((currentMC - (data.entryMC || 1)) / (data.entryMC || 1)) * 100;
      
      if (gain < MEME_SETTINGS.flexGainMinPct) continue;

      const isRug = (data.entryLiq > 5000 && currentLiq < data.entryLiq * 0.3); 
      if (isRug) {
        console.log(`[FLEX] Skipped flex (possible rug, Liq drop): ${addr}`);
        data.reported = true;
        tracking.set(addr, data);
        saveState();
        continue;
      }

      const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) continue;
      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      // Format the flex message
      const fire = gain > 10000 ? "🔥 10000%" : gain > 1000 ? "⭐ 1000%" : gain > 500 ? "🚀 500%" : `${Math.round(gain)}%`;
      const pnl = gain.toFixed(1);
      const profitText = `${fire} GAIN! $${data.symbol} UP ${pnl}% FROM ${BOT_NAME} CALL!`;

      const flexEmbed = new EmbedBuilder()
        .setColor(0x00FF44) 
        .setTitle(profitText)
        .setDescription([
          `**Entry MC:** $${(data.entryMC / 1000).toFixed(1)}K → **Current MC:** $${(currentMC / 1000).toFixed(1)}K`,
          `**Current Liq:** $${(currentLiq / 1000).toFixed(1)}K`,
          `*PnL reported at ${new Date().toLocaleTimeString()}*`
        ].join("\n"))
        .setTimestamp();

      await orig.reply({ embeds: [flexEmbed] }).catch(() => null);

      data.reported = true;
      tracking.set(addr, data);
      saveState();
      console.log(`[FLEX] PnL REPORTED: ${addr} $${data.symbol}, ${pnl}%`);
    }

    const now = Date.now();
    for (const [addr, data] of Array.from(tracking.entries())) {
      const MAX_TRACKING_AGE_MIN = 60 * 24 * 7; 
      const ageMin = (now - (data.ts || now)) / 60000;
      if (ageMin > MAX_TRACKING_AGE_MIN) {
        tracking.delete(addr);
        saveState();
      }
    }
  } catch (e) {
    console.warn("[flexGains] Error:", e?.message || e);
  }
}


// --- SCHEDULER & DISCORD INIT ---
client.once("ready", async () => {
  console.log(`[BOT] ${BOT_NAME} LIVE — ${new Date().toISOString()}`);
  loadState();

  await dropCall();

  const loop = async () => {
    try {
      await dropCall();
    } catch (e) {
      console.warn("Loop dropCall err:", e?.message || e);
    } finally {
      const min = Math.max(1000, MIN_DROP_INTERVAL_MS);
      const max = Math.max(min, MAX_DROP_INTERVAL_MS);
      const delay = min + Math.floor(Math.random() * (max - min + 1));
      setTimeout(loop, delay);
    }
  };
  setTimeout(loop, MIN_DROP_INTERVAL_MS);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(saveState, SAVE_INTERVAL_MS);
});

// --- ADMIN COMMANDS (All output is now embedded) ---
client.on("messageCreate", async (msg) => {
  if (!msg.content || msg.channel.id !== CHANNEL_ID) return;
  const t = msg.content.toLowerCase().trim();
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  if (t === "/start" || t === "/ping") {
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🚀 ${BOT_NAME} IS ONLINE`)
      .setDescription("Multi-Source Sniper is now active. Expect frequent memecoin calls.")
      .setFooter({ text: `Status Check: ${BOT_NAME}` });
    await msg.reply({ embeds: [embed] });
  }

  if (t === "/reset_called" || t === "/clear_called") {
    called.clear();
    saveState();
    const embed = new EmbedBuilder()
      .setColor(0xFF9900)
      .setTitle(`✅ HISTORY CLEARED`)
      .setDescription("Called list has been reset. Next scan will check all tokens.")
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }

  if (t === "/status" || t === "/state") {
    const s = `Called: ${called.size}, Tracked: ${tracking.size}`;
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle(`📊 ${BOT_NAME} STATS`)
      .setDescription(s)
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }
});

client.login(TOKEN).catch((e) => {
  console.error("Login failed:", e?.message || e);
  process.exit(1);
});
