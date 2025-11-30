// =======================================================
// 1G VAULT V15.4 - TELEGRAM GROUP STRATEGY INTEGRATION
// CHANGE: Added TG_FEED_URL, and implemented an auto-whitelist bypass
// for all tokens coming from the 'telegram' source.
// NOTE: You must set the TG_FEED_URL environment variable to your
// Telegram monitoring API endpoint for this strategy to work.
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
const BOT_NAME = "1G VAULT V15.4 (Telegram Feed Integration)"; 
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://jup.ag/"; 
const CHAINS = { SOL: "solana" }; 

// --- EXTERNAL FEED LINKS ---
const AXIOM_REF = "https://axiom.trade/@1gvault";
// !!! CRITICAL: SET THESE ENVIRONMENT VARIABLES !!!
const AXIOM_FEED_URL = process.env.AXIOM_FEED_URL || null;
const PUMPFUN_API_URL = process.env.PUMPFUN_API_URL || null; 
const GMGN_FEED_URL = process.env.GMGN_FEED_URL || null;
// NEW: TELEGRAM FEED FOR USER'S PUMPFUN SIGNALS (SET TG_FEED_URL IN ENV)
const TELEGRAM_FEED_URL = process.env.TG_FEED_URL || null; 

// --- SCHEDULING ---
const MIN_DROP_INTERVAL_MS = 1000; 
const MAX_DROP_INTERVAL_MS = 1000;
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 90_000;
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const CALL_HISTORY_CLEAR_MS = 3 * 60 * 60 * 1000; 

// --- MEME FILTER SETTINGS (MODERATE AGGRESSIVE FALLBACK) ---
// These filters are used for DexScreener/organic scans, but bypassed for the 'telegram' source.
const MEME_SETTINGS = {
  minMarketCap: 0,        
  maxMarketCap: 999999999, 
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 1000,   // $1K minimum
  minVolumeH1: 0,   
  minPriceChangeH1: Number(process.env.PCT_H1_MIN) || 0, 
  minScore: 0, 
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30, 
  
  // Transaction filters 
  minTxnsH1: Number(process.env.TXNS_H1_MIN) || 100,     
  minBuysH1: Number(process.env.BUYS_H1_MIN) || 50,     
  minSellsH1: Number(process.env.SELLS_H1_MIN) || 50,    
};

const COINGECKO_MARKETS = process.env.ENABLE_COINGECKO === "1";
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || null;

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
let lastCallReset = Date.now(); 

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
}};

// --- DATA SOURCES ---
async function fetchDexPairs(chain) {
  const query = `new`; 
  const url = `https://api.dexscreener.com/latest/dex/search?q=${query}`;
  const j = await retryFetch(url);
  
  const pairs = j?.pairs || [];
  const filteredPairs = pairs.filter(p => p.chainId?.toLowerCase() === chain.toLowerCase());
  
  if (filteredPairs.length === 0) {
     console.log(`[DEX] Chain ${chain}: Found 0 pairs (from ${pairs.length} total active).`);
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
    if (pairs.length === 0 && j) {
      console.warn(`[API FAIL] ${source}: Unexpected response format or empty list.`); 
    }
    
    return pairs.filter(p => {
        const chain = p.chainId || p.chain;
        return !chain || chain.toLowerCase() === 'solana';
    }).map(p => ({ ...p, _source: source }));
  } catch {
    return [];
  }
}

async function fetchPumpGraduations(url) {
    if (!url) return [];
    try {
        const j = await retryFetch(url);
        if (!j) return [];
        
        const tokens = Array.isArray(j) ? j : (Array.isArray(j.tokens) ? j.tokens : (Array.isArray(j.result) ? j.result : []));

        if (tokens.length === 0) {
            console.log("[PUMPFUN] Found 0 graduated tokens.");
            return [];
        }
        
        console.log(`[PUMPFUN] Found ${tokens.length} graduated tokens.`);

        return tokens.map(t => {
            const tokenAddress = t.mint_address || t.tokenAddress || t.mint || t.token_address; 
            if (!tokenAddress) return null;
            return { 
                baseToken: { address: tokenAddress, symbol: t.symbol || 'PUMP' }, 
                _source: "pumpfun",
                _sourceChain: "solana",
                priceChange: { h1: 1000 }, 
                liquidity: { usd: 100000 },
                txns: { h1: { buys: 500, sells: 500 } }
            };
        }).filter(t => t !== null);

    } catch (err) {
        console.warn("[PUMPFUN] Fetch error:", err?.message || err);
        return [];
    }
}

// --- CORE SCANNER LOGIC ---
async function collectCandidates() {
  const sources = [];

  const dexPromises = Object.values(CHAINS).map(c => fetchDexPairs(c));
  const dexResults = await Promise.all(dexPromises);
  dexResults.forEach(arr => sources.push(...arr));

  sources.push(...await fetchExternalFeed(AXIOM_FEED_URL, "axiom"));
  sources.push(...await fetchExternalFeed(GMGN_FEED_URL, "gmgn"));
  sources.push(...await fetchPumpGraduations(PUMPFUN_API_URL));
  // NEW: Add the Telegram feed source
  sources.push(...await fetchExternalFeed(TELEGRAM_FEED_URL, "telegram")); 

  const map = new Map();
  for (const s of sources) {
    const addr = normalizeAddr(s.baseToken?.address || s.pairAddress || s.address || s.id);
    if (!addr) continue;
    
    if (!map.has(addr) || (s.priceChange?.h1 || 0) > (map.get(addr).priceChange?.h1 || 0)) {
        map.set(addr, s);
    }
  }
  
  console.log(`[SCAN] Found ${map.size} unique SOLANA candidates after deduplication from all sources.`);
  return Array.from(map.values());
}

// --- SCORING & FILTERING ---

function scorePair(p) {
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0; 
  const m5 = p.priceChange?.m5 || 0; 
  const buysH1 = p.txns?.h1?.buys || 0;
  const sellsH1 = p.txns?.h1?.sells || 0;

  let s = 10; 
  s += Math.min(h1 * 5, 50); 
  s += Math.min(m5 * 3, 20); 
  
  if (buysH1 >= MEME_SETTINGS.minBuysH1 && sellsH1 >= MEME_SETTINGS.minSellsH1) {
      s += 10;
  }

  if (liq > 5000) s += 5;
  if (liq > 10000) s += 5;
  
  // High score boost for whitelisted sources
  if (p._source?.toLowerCase() === 'telegram' || p._source?.toLowerCase() === 'axiom') {
      s += 20; 
  }

  return Math.min(99, Math.round(s));
}

function passesMemeFilters(p) {
  // NEW LOGIC: BYPASS filters if the token came from the specified Telegram feed
  if (p._source?.toLowerCase() === 'telegram') {
      console.log(`[PASS] Token $${p.baseToken?.symbol || 'UNKNOWN'} (Source: Telegram) is auto-whitelisted.`);
      return true;
  }
  
  // --- Standard Filter Check (Fallback for DexScreener/GMGN/Axiom) ---
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0;
  const buysH1 = p.txns?.h1?.buys || 0;
  const sellsH1 = p.txns?.h1?.sells || 0;
  const totalTxnsH1 = p.txns?.h1?.buys + p.txns?.h1?.sells || 0;

  if (liq < MEME_SETTINGS.minLiquidityUsd) { 
      return false; 
  }
  
  if (h1 < MEME_SETTINGS.minPriceChangeH1) { 
      return false; 
  }

  if (totalTxnsH1 < MEME_SETTINGS.minTxnsH1) {
      return false;
  }
  if (buysH1 < MEME_SETTINGS.minBuysH1) { 
      return false; 
  }
  if (sellsH1 < MEME_SETTINGS.minSellsH1) { 
      return false; 
  }
  
  return true;
}

// --- ANNOUNCEMENT ---
async function createCallEmbed(best) {
  const baseSym = best.baseToken?.symbol || "TOKEN";
  const liqUsd = best.liquidity?.usd || 0;
  const volH1 = best.volume?.h1 || 0;
  const mc = best.marketCap || best.fdv || 0;
  const score = best.score;
  const buysH1 = best.txns?.h1?.buys || 0;
  const sellsH1 = best.txns?.h1?.sells || 0;

  const chainName = (best._source || best._sourceChain || "SOLANA").toString().toUpperCase();
  const color = best._source?.toLowerCase() === 'telegram' ? 0x9900FF : score > 60 ? 0x00FF44 : score > 30 ? 0xFF9900 : 0xFF0000;
  const safety = liqUsd > 10000 ? "✅ LOW RISK" : liqUsd > 2000 ? "⚠️ MODERATE RISK" : "🚨 HIGH RISK";
  const statusEmoji = best._source?.toLowerCase() === 'telegram' ? "⚡" : score > 60 ? "🔥" : "🚀";
  const titlePrefix = best._source?.toLowerCase() === 'telegram' ? "⚡ TELEGRAM SNIPE" : "🚀 PROBABILITY";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusEmoji} ${titlePrefix}: $${baseSym} ${statusEmoji} (${score}%)`)
    .setDescription(
      [
        `**Source:** \`${chainName}\``,
        `**CA:** \`${best.baseToken?.address || best.pairAddress || "unknown"}\``,
        `---`,
        `💰 **Mkt Cap:** $${(mc / 1000).toFixed(1)}K`,
        `💧 **Liquidity:** $${(liqUsd / 1000).toFixed(1)}K`,
        `📈 **1H Momentum:** ${best.priceChange?.h1?.toFixed(1) || 0}%`,
        `📊 **1H Volume:** $${(volH1 / 1000).toFixed(1)}K`, 
        `---`,
        `🟢 **1H Buys:** ${buysH1}`,
        `🔴 **1H Sells:** ${sellsH1}`,
        `---`,
        `**Safety:** ${safety} - *Not financial advice. DYOR.*`,
        `**Join Our Community:** [Trade with 1G Vault on Axiom](${AXIOM_REF})`
      ].join("\n")
    )
    .setTimestamp()
    .setFooter({ text: `Powered by ${BOT_NAME} | Join Axiom: ${AXIOM_REF}` }); 

  const chartChain = best._sourceChain || best.chain || 'solana'; 
  const chartUrl = `https://dexscreener.com/${chartChain}/${best.addr}`;
  
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("View Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
    new ButtonBuilder().setLabel("SNIPE NOW →").setStyle(ButtonStyle.Link).setURL(REF)
  );
  
  return { embeds: [embed], components: [buttons] };
}

// --- CORE LOGIC ---
async function dropCall() {
  try {
    const candidates = await collectCandidates();
    if (!candidates || candidates.length === 0) return;

    const validCalls = [];

    for (const p of candidates) {
      const addr = normalizeAddr(p.baseToken?.address || p.pairAddress || p.address || p.id);
      if (!addr) continue;
      if (called.has(addr)) continue;

      if (!passesMemeFilters(p)) continue;

      const score = scorePair(p);
      validCalls.push({ ...p, score, addr });
    }
    
    if (validCalls.length === 0) {
      console.log("[SCAN] No new candidates passed the aggressive filters.");
      return;
    }

    // Prioritize by score, ensuring auto-whitelisted tokens (like Telegram) get called first
    validCalls.sort((a, b) => b.score - a.score);

    console.log(`[ANNOUNCE] Found ${validCalls.length} high-potential tokens to announce.`);
    
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) {
        console.warn("[DISCORD] Failed to find channel or send messages. Check CHANNEL_ID/Permissions.");
        return;
    }

    let announcements = 0;
    for (const best of validCalls) {
        called.add(best.addr); 
        const messagePayload = await createCallEmbed(best);

        const msg = await channel.send(messagePayload).catch((e) => {
            console.warn(`[DISCORD] Error sending $${best.baseToken?.symbol}:`, e.message);
            return null; 
        });

        if (!msg) {
            console.log("[DISCORD] Rate limit hit or message failed. Stopping announcement batch.");
            break; 
        }
        
        announcements++;

        const entryMC = best.marketCap || 0;
        if (entryMC > 0) {
            tracking.set(best.addr, {
              msgId: msg.id,
              entryMC: entryMC, 
              entryLiq: best.liquidity?.usd || 0,
              symbol: best.baseToken?.symbol,
              reported: false,
              chain: best._sourceChain || best.chain || best._source || "solana",
              ts: Date.now(),
            });
        }
        
        await sleep(500); 
    }

    saveState();
    console.log(`[ANNOUNCE] Successfully sent ${announcements} calls in this cycle.`);
  } catch (e) {
    console.warn("[dropCall] Runtime error:", e?.message || e);
  }
}

// --- PNL / FLEX LOGIC ---
async function flexGains() {
  try {
    for (const [addr, data] of Array.from(tracking.entries())) {
      if (!data || data.reported || !data.entryMC || data.entryMC <= 0) {
        if (data && data.entryMC <= 0) console.warn(`[FLEX SKIP] Tracking data for ${addr} has invalid Entry MC.`);
        continue;
      }
      
      const chain = data.chain?.toLowerCase?.() || "solana"; 
      
      const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
      const j = await retryFetch(url);
      
      const p = j?.pairs?.find(pair => 
          pair.baseToken?.address?.toLowerCase() === addr
          && pair.chainId?.toLowerCase() === chain
      ); 
      
      if (!p) {
        const fallback = j?.pairs?.find(pair => pair.baseToken?.address?.toLowerCase() === addr);
        if(fallback) {
             const currentMC = fallback.marketCap || fallback.fdv || 0;
             const currentLiq = fallback.liquidity?.usd || 0;
             
             if (data.entryMC === 0) continue; 

             const gain = ((currentMC - data.entryMC) / data.entryMC) * 100;

             if (gain < MEME_SETTINGS.flexGainMinPct) continue;

             await postFlexReply(data, currentMC, currentLiq, gain);
             tracking.get(addr).reported = true;
             saveState();
        }
        continue;
      }

      const currentMC = p.marketCap || p.fdv || 0;
      const currentLiq = p.liquidity?.usd || 0;
      
      if (data.entryMC === 0) continue; 
      
      const gain = ((currentMC - data.entryMC) / data.entryMC) * 100;
      
      if (gain < MEME_SETTINGS.flexGainMinPct) continue;
      
      await postFlexReply(data, currentMC, currentLiq, gain);

      tracking.get(addr).reported = true;
      saveState();
      console.log(`[FLEX] PnL REPORTED: ${addr} $${data.symbol}, ${gain.toFixed(1)}%`);
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

async function postFlexReply(data, currentMC, currentLiq, gain) {
  const isRug = (data.entryLiq > 5000 && currentLiq < data.entryLiq * 0.3); 
  if (isRug) {
    console.log(`[FLEX] Skipped flex (possible rug, Liq drop): ${data.addr}`);
    return;
  }

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const orig = await channel.messages.fetch(data.msgId).catch(() => null);
  if (!orig) return;

  const fire = gain > 1000000 ? "🔥🔥🔥 +1000000% GAIN 🔥🔥🔥" : gain > 10000 ? "🔥 10000%" : gain > 1000 ? "⭐ 1000%" : gain > 500 ? "🚀 500%" : `${Math.round(gain)}%`;
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
}

// --- SELF-PINGING LOGIC ---
function startHealthCheck() {
    if (!SELF_URL) {
        console.warn("[HEALTH] SELF_URL environment variable is not set. Bot may go idle.");
        return;
    }
    console.log(`[HEALTH] Starting self-ping to ${SELF_URL} every ${HEALTH_CHECK_INTERVAL_MS / 60000} minutes.`);
    setInterval(async () => {
        try {
            await fetch(SELF_URL);
        } catch (e) {
            console.warn("[HEALTH] Self-ping failed:", e.message);
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}


// --- SCHEDULER & DISCORD INIT ---
client.once("ready", async () => {
  console.log(`[BOT] ${BOT_NAME} LIVE — ${new Date().toISOString()}`);
  loadState();

  startHealthCheck();

  const loop = async () => {
    try {
      if (Date.now() - lastCallReset > CALL_HISTORY_CLEAR_MS) {
          console.log(`[RESET] Clearing called list (${called.size} entries) to re-scan for potential.`)
          called.clear();
          lastCallReset = Date.now();
          saveState();
      }
      
      await dropCall();
    } catch (e) {
      console.warn("Loop dropCall err:", e?.message || e);
    } finally {
      const delay = MIN_DROP_INTERVAL_MS;
      setTimeout(loop, delay);
    }
  };
  setTimeout(loop, MIN_DROP_INTERVAL_MS);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(saveState, SAVE_INTERVAL_MS);
});

// --- ADMIN COMMANDS ---
client.on("messageCreate", async (msg) => {
  if (!msg.content || msg.channel.id !== CHANNEL_ID) return;
  const t = msg.content.toLowerCase().trim();
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  if (t === "/start" || t === "/ping") {
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🚀 ${BOT_NAME} IS ONLINE`)
      .setDescription("Solana Sniper is now in **Telegram Integration Mode**.")
      .setFooter({ text: `Status Check: ${BOT_NAME}` });
    await msg.reply({ embeds: [embed] });
  }

  if (t === "/reset_called" || t === "/clear_called") {
    called.clear();
    tracking.clear();
    lastCallReset = Date.now(); 
    saveState();
    const embed = new EmbedBuilder()
      .setColor(0xFF9900)
      .setTitle(`✅ HISTORY CLEARED`)
      .setDescription("Called list and tracking list have been reset. Next scan will check all tokens.")
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }

  if (t === "/status" || t === "/state") {
    const s = `Called: ${called.size}, Tracked: ${tracking.size}`;
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle(`📊 ${BOT_NAME} STATS (Solana Only - TELEGRAM MODE)`)
      .setDescription(s)
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }
});

client.login(TOKEN).catch((e) => {
  console.error("Login failed:", e?.message || e);
  process.exit(1);
});
