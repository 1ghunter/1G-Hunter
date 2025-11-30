// =======================================================
// 1G VAULT V15.8 - PURE DEXSCREENER SNIPER (STABLE)
// CHANGE: Removed all external feed dependencies (Telegram, Axiom, etc.).
//         Restored aggressive filtering to manage DexScreener's large
//         list of 'new' pairs and ensure only active tokens are called.
// =======================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
// Ensure 'node-fetch' is installed in your package.json for this to work
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
const BOT_NAME = "1G VAULT V15.8 (DEXSniper)"; 
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://jup.ag/"; 
// !!! CRITICAL: ONLY SOLANA IS ENABLED !!!
const CHAINS = { SOL: "solana" }; 
const AXIOM_REF = "https://axiom.trade/@1gvault"; // Still keep referral link in embed

// --- SCHEDULING ---
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 15_000; // Increased stability
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 90_000;
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const CALL_HISTORY_CLEAR_MS = 3 * 60 * 60 * 1000; // Reset 'called' list every 3 hours

// --- MEME FILTER SETTINGS (AGGRESSIVE TRANSACTION CHECK RESTORED) ---
const MEME_SETTINGS = {
  // REQUIRE these minimums to pass the filter (CRITICAL for pure DexScreener)
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 2000,   
  minPriceChangeH1: Number(process.env.PCT_H1_MIN) || 1, 
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30, 
  
  // AGGRESSIVE TRANSACTION FILTERS (Used for filter AND score)
  minTxnsH1: Number(process.env.TXNS_H1_MIN) || 200,     
  minBuysH1: Number(process.env.BUYS_H1_MIN) || 100,     
  minSellsH1: Number(process.env.SELLS_H1_MIN) || 100,    
};

// --- EXTERNAL SOURCES (CLEANED UP) ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || null;

// --- CRITICAL ENVIRONMENT CHECKS ---
if (!TOKEN || TOKEN.length < 50) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing or invalid.");
  process.exit(1);
}
if (!CHANNEL_ID || CHANNEL_ID.length < 15) {
  console.error("❌ CRITICAL ERROR: CHANNEL_ID is missing or invalid.");
  process.exit(1);
}

// =======================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let called = new Set();
let tracking = new Map();
let lastCallReset = Date.now(); 

// --- STATE MANAGEMENT (UNCHANGED) ---
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

// Robust fetch utility using 'node-fetch'
async function retryFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP Error Status: ${res.status}`);
      }
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
}

// --- DATA SOURCES (PURE DEXSCREENER) ---
async function fetchDexPairs(chain) {
  const query = `new`; 
  const url = `https://api.dexscreener.com/latest/dex/search?q=${query}`;
  const j = await retryFetch(url);
  
  const pairs = j?.pairs || [];
  // Filter for the specified chain (Solana)
  const filteredPairs = pairs.filter(p => p.chainId?.toLowerCase() === chain.toLowerCase());
  
  if (filteredPairs.length === 0) {
     console.log(`[DEX] Chain ${chain}: Found 0 pairs (from ${pairs.length} total active).`);
  } else {
     console.log(`[DEX] Chain ${chain}: Found ${filteredPairs.length} new candidates.`);
  }

  return filteredPairs.map(p => ({ ...p, _sourceChain: chain }));
}

async function collectCandidates() {
  const sources = [];

  // Fetch only from DexScreener's 'new' endpoint for all configured chains
  const dexPromises = Object.values(CHAINS).map(c => fetchDexPairs(c));
  const dexResults = await Promise.all(dexPromises);
  dexResults.forEach(arr => sources.push(...arr));

  const map = new Map();
  for (const s of sources) {
    const addr = normalizeAddr(s.baseToken?.address || s.pairAddress || s.address || s.id);
    if (!addr) continue;
    
    // Deduplicate: take the pair with the highest 1H change if multiple DexScreener pairs exist
    if (!map.has(addr) || (s.priceChange?.h1 || 0) > (map.get(addr).priceChange?.h1 || 0)) {
        map.set(addr, s);
    }
  }
  
  console.log(`[SCAN] Found ${map.size} unique SOLANA candidates after deduplication.`);
  return Array.from(map.values());
}

// --- SCORING & FILTERING (AGGRESSIVE FILTERING RESTORED) ---
function scorePair(p) {
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0; 
  const m5 = p.priceChange?.m5 || 0; 
  const buysH1 = p.txns?.h1?.buys || 0;
  const sellsH1 = p.txns?.h1?.sells || 0;

  let s = 10; 
  // Base score on momentum
  s += Math.min(h1 * 5, 50); 
  s += Math.min(m5 * 3, 20); 
  
  // Score boost for high transaction counts (aggressive check)
  if (buysH1 >= MEME_SETTINGS.minBuysH1 && sellsH1 >= MEME_SETTINGS.minSellsH1) {
      s += 10;
  }

  // Score boost for liquidity
  if (liq > 5000) s += 5;
  if (liq > 10000) s += 5;

  return Math.min(99, Math.round(s));
}

function passesMemeFilters(p) {
  const liq = p.liquidity?.usd || 0;
  const h1 = p.priceChange?.h1 || 0;
  const buysH1 = p.txns?.h1?.buys || 0;
  const sellsH1 = p.txns?.h1?.sells || 0;
  const totalTxnsH1 = buysH1 + sellsH1 || 0;

  // 1. LIQUIDITY MINIMUM
  if (liq < MEME_SETTINGS.minLiquidityUsd) { 
      return false; 
  }
  
  // 2. 1H PRICE CHANGE MINIMUM
  if (h1 < MEME_SETTINGS.minPriceChangeH1) { 
      return false; 
  }

  // 3. AGGRESSIVE TRANSACTION COUNTS MINIMUMS
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

  const chainName = (best._sourceChain || "SOLANA").toString().toUpperCase();
  const color = score > 60 ? 0x00FF44 : score > 30 ? 0xFF9900 : 0xFF0000;
  const safety = liqUsd > 10000 ? "✅ LOW RISK" : liqUsd > 2000 ? "⚠️ MODERATE RISK" : "🚨 HIGH RISK";
  const statusEmoji = score > 60 ? "🔥" : "🚀";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusEmoji} ${score}% PROBABILITY - ${BOT_NAME} CALL: $${baseSym} ${statusEmoji}`)
    .setDescription(
      [
        `**Source:** \`${chainName} (DexScreener New)\``,
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

async function dropCall() {
  try {
    const candidates = await collectCandidates();
    if (!candidates || candidates.length === 0) return;

    const validCalls = [];
    for (const p of candidates) {
      const addr = normalizeAddr(p.baseToken?.address || p.pairAddress || p.address || p.id);
      if (!addr) continue;
      
      // CRITICAL: Clear cache if token is very old (over 3 hours since last reset)
      const now = Date.now();
      if (now - lastCallReset > CALL_HISTORY_CLEAR_MS) {
          console.log(`[RESET] Clearing called list (${called.size} entries) to re-scan for potential.`)
          called.clear();
          lastCallReset = now;
      }

      if (called.has(addr)) continue;

      if (!passesMemeFilters(p)) {
          // Log discarded tokens only if they are close to the minimums
          if((p.liquidity?.usd || 0) > 100) { 
              // console.log(`[FILTER] Token $${p.baseToken?.symbol || 'Unknown'} discarded: Did not pass aggressive filters.`);
          }
          continue;
      }

      const score = scorePair(p);
      if (score < 30) continue; // Minimum score threshold required for a call

      validCalls.push({ ...p, score, addr });
    }

    if (validCalls.length === 0) {
      console.log("[SCAN] No new candidates passed the aggressive filters (Liq/Txns/H1%).");
      return;
    }

    // Prioritize by highest score
    validCalls.sort((a, b) => b.score - a.score);

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) {
        console.warn("[DISCORD] Failed to find channel or send messages. Check CHANNEL_ID/Permissions.");
        return;
    }

    let announcements = 0;
    // Announce top 3 to prevent rate limiting in single cycle
    for (const best of validCalls.slice(0, 3)) { 
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
              chain: best._sourceChain || "solana",
              ts: Date.now(),
            });
        }
        
        await sleep(500); // Small pause to avoid hitting Discord rate limits on rapid sends
    }

    saveState();
    console.log(`[ANNOUNCE] Successfully sent ${announcements} calls in this cycle.`);
  } catch (e) {
    console.warn("[dropCall] Runtime error:", e?.message || e);
  }
}

// --- PNL / FLEX LOGIC (UNCHANGED) ---
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

// --- SELF-PINGING LOGIC (UNCHANGED) ---
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
      await dropCall();
    } catch (e) {
      console.warn("Loop dropCall err:", e?.message || e);
    } finally {
      const delay = MIN_DROP_INTERVAL_MS; // Use minimal delay for high-frequency scanning
      setTimeout(loop, delay);
    }
  };
  setTimeout(loop, MIN_DROP_INTERVAL_MS);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(saveState, SAVE_INTERVAL_MS);
});

// --- ADMIN COMMANDS (UPDATED BOT NAME) ---
client.on("messageCreate", async (msg) => {
  if (!msg.content || msg.channel.id !== CHANNEL_ID) return;
  const t = msg.content.toLowerCase().trim();
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  if (t === "/start" || t === "/ping") {
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🚀 ${BOT_NAME} IS ONLINE`)
      .setDescription("Solana Sniper is running in **Pure DexScreener Sniper Mode**.")
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
      .setTitle(`📊 ${BOT_NAME} STATS (DexScreener Only)`)
      .setDescription(s)
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }
});

client.login(TOKEN).catch((e) => {
  console.error("❌ DISCORD LOGIN FAILED:", e?.message || e);
  process.exit(1);
});
