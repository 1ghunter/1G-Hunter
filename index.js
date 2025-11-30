// =======================================================
// 1G VAULT V18.0 - EXTREME SPAMMER (Public API Max Velocity)
// CHANGE: Max speed scan (5s), minimum filters ($50 Liq), 
//         and high base score to trigger maximum calls from
//         the public DexScreener 'new' list.
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
const BOT_NAME = "1G VAULT V18.0 (ExtremeSpammer)"; 
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://jup.ag/"; 
const CHAINS = { SOL: "solana" }; 
const AXIOM_REF = "https://axiom.trade/@1gvault"; 

// --- SCHEDULING (MAX VELOCITY) ---
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 5_000; // 5 seconds (MAXIMUM SPEED)
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 60_000; 
const SAVE_INTERVAL_MS = Number(process.env.SAVE_INTERVAL_MS) || 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const CALL_HISTORY_CLEAR_MS = 1 * 60 * 60 * 1000; // Reset 'called' list every 1 hour

// --- MEME FILTER SETTINGS (ABSOLUTE MINIMUMS) ---
const MEME_SETTINGS = {
  minLiquidityUsd: Number(process.env.LIQ_MIN) || 50,     // Only $50 required
  flexGainMinPct: Number(process.env.FLEX_PCT_MIN) || 30, // 30% to flex
  txnBoostThreshold: 10, // Very low threshold for a transaction boost
};

// --- KEYWORD CONFIGURATION ---
const KEYWORD_BOOST = 30; // Increased boost for extreme mode
const KEYWORDS = [
    "pump fun", 
    "pump.fun", 
    "solana meme", 
    "raydium", 
    "new launch", 
    "fair launch",
    "padre", 
    "axiom", 
    "gmgn",
    "bullcember",
    "normie",
    "michelle"
];

// --- BOT INITIALIZATION (Same as previous versions) ---
if (!TOKEN || TOKEN.length < 50) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing or invalid.");
  process.exit(1);
}
if (!CHANNEL_ID || CHANNEL_ID.length < 15) {
  console.error("❌ CRITICAL ERROR: CHANNEL_ID is missing or invalid.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let called = new Set();
let tracking = new Map();
let lastCallReset = Date.now(); 

// --- STATE MANAGEMENT & UTILITIES (Same as previous versions) ---
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeAddr = (a) => (a || "").toLowerCase();

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

// --- DATA SOURCES (Using DexScreener 'search?q=new') ---
async function fetchDexPairs(chain) {
  // This is the fastest available endpoint for finding NEW tokens on Solana.
  const query = `new`; 
  const url = `https://api.dexscreener.com/latest/dex/search?q=${query}`;
  const j = await retryFetch(url);
  
  const pairs = j?.pairs || [];
  // Filter aggressively for the specified chain (Solana)
  const filteredPairs = pairs.filter(p => p.chainId?.toLowerCase() === chain.toLowerCase());
  
  return filteredPairs.map(p => ({ ...p, _sourceChain: chain }));
}

async function collectCandidates() {
  const sources = [];
  const dexPromises = Object.values(CHAINS).map(c => fetchDexPairs(c));
  const dexResults = await Promise.all(dexPromises);
  dexResults.forEach(arr => sources.push(...arr));

  const map = new Map();
  for (const s of sources) {
    const addr = normalizeAddr(s.baseToken?.address || s.pairAddress || s.address || s.id);
    if (!addr) continue;
    
    // Only keep the most relevant pair if multiple exist for the same token
    if (!map.has(addr) || (s.priceChange?.h1 || 0) > (map.get(addr).priceChange?.h1 || 0)) {
        map.set(addr, s);
    }
  }
  
  return Array.from(map.values());
}

// --- SCORING & FILTERING (ADJUSTED FOR V18.0) ---

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

  let s = 50; // HIGH BASE SCORE (50%) for being on the 'new' list
  
  // Score boost for momentum (less important now since we are aiming for the absolute start)
  s += Math.min(h1 * 2, 10); 
  s += Math.min(m5 * 3, 10); 
  
  // Score boost for transaction counts
  if (totalTxnsH1 > MEME_SETTINGS.txnBoostThreshold) {
      s += 10;
  }

  // Score boost for liquidity (adjusted tiers)
  if (liq > 100) s += 5;
  if (liq > 500) s += 5;
  if (liq > 1000) s += 5;

  // KEYWORD BOOST (The most aggressive filter left)
  if (checkKeywords(p)) {
      s += KEYWORD_BOOST; 
  }

  return Math.min(99, Math.round(s));
}

function passesMemeFilters(p) {
  const liq = p.liquidity?.usd || 0;
  
  // 1. ABSOLUTE MINIMUM LIQUIDITY ($50)
  if (liq < MEME_SETTINGS.minLiquidityUsd) { 
      return false; 
  }
  
  // 2. ONLY SOLANA
  if (p._sourceChain !== 'solana') {
      return false;
  }
  
  // 3. NO PRICE CHANGE FILTER (let it call everything that has liquidity)
  
  return true;
}

// --- ANNOUNCEMENT (Same as previous versions) ---
async function createCallEmbed(best) {
  const baseSym = best.baseToken?.symbol || "TOKEN";
  const liqUsd = best.liquidity?.usd || 0;
  const volH1 = best.volume?.h1 || 0;
  const mc = best.marketCap || best.fdv || 0;
  const score = best.score;
  const totalTxnsH1 = (best.txns?.h1?.buys || 0) + (best.txns?.h1?.sells || 0);

  const chainName = (best._sourceChain || "SOLANA").toString().toUpperCase();
  const color = score > 70 ? 0x00FF44 : score > 50 ? 0xFF9900 : 0xFF0000; 
  const safety = liqUsd > 1000 ? "⚠️ MODERATE RISK" : "🚨 HIGH RISK (Low Liq)";
  const statusEmoji = score > 70 ? "🔥🔥" : "🚀";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusEmoji} ${score}% PROBABILITY - ${BOT_NAME} CALL: $${baseSym} ${statusEmoji}`)
    .setDescription(
      [
        `**Source:** \`${chainName} (MaxVelocity Scan)\``,
        `**CA:** \`${best.baseToken?.address || best.pairAddress || "unknown"}\``,
        `---`,
        `💰 **Mkt Cap:** $${(mc / 1000).toFixed(1)}K`,
        `💧 **Liquidity:** $${(liqUsd).toFixed(0)}`,
        `📈 **1H Momentum:** ${best.priceChange?.h1?.toFixed(1) || 0}%`,
        `📊 **1H Volume:** $${(volH1 / 1000).toFixed(1)}K`, 
        `---`,
        `🔄 **1H Transactions:** ${totalTxnsH1}`,
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
      
      const now = Date.now();
      if (now - lastCallReset > CALL_HISTORY_CLEAR_MS) {
          console.log(`[RESET] Clearing called list (${called.size} entries) to re-scan.`)
          called.clear();
          lastCallReset = now;
      }

      if (called.has(addr)) continue;

      if (!passesMemeFilters(p)) {
          continue;
      }

      const score = scorePair(p);
      if (score < 50) continue; // Minimum score threshold for V18.0 is 50% base

      validCalls.push({ ...p, score, addr });
    }

    if (validCalls.length === 0) {
      console.log(`[SCAN] No new candidates passed the minimum score (Liq $${MEME_SETTINGS.minLiquidityUsd} / Score 50%).`);
      return;
    }

    validCalls.sort((a, b) => b.score - a.score);

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) {
        console.warn("[DISCORD] Failed to find channel or send messages.");
        return;
    }

    let announcements = 0;
    // Announce up to 5 of the top scored signals every cycle to increase volume
    for (const best of validCalls.slice(0, 5)) { 
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
        
        await sleep(500); // Small delay to avoid Discord rate limiting within the batch
    }

    saveState();
    console.log(`[ANNOUNCE] Successfully sent ${announcements} calls in this cycle.`);
  } catch (e) {
    console.warn("[dropCall] Runtime error:", e?.message || e);
  }
}

// --- PNL / FLEX LOGIC (Same as previous versions) ---
async function flexGains() {
    try {
        for (const [addr, data] of Array.from(tracking.entries())) {
          if (!data || data.reported || !data.entryMC || data.entryMC <= 0) {
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
      `**Current Liq:** $${(currentLiq).toFixed(0)}`,
      `*PnL reported at ${new Date().toLocaleTimeString()}*`
    ].join("\n"))
    .setTimestamp();

  await orig.reply({ embeds: [flexEmbed] }).catch(() => null);
}

function startHealthCheck() {
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || null;
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


// --- SCHEDULER & DISCORD INIT (Same as previous versions) ---
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
      const delay = MIN_DROP_INTERVAL_MS; 
      setTimeout(loop, delay);
    }
  };
  setTimeout(loop, MIN_DROP_INTERVAL_MS);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(saveState, SAVE_INTERVAL_MS);
});

// --- ADMIN COMMANDS (Same as previous versions) ---
client.on("messageCreate", async (msg) => {
  if (!msg.content || msg.channel.id !== CHANNEL_ID) return;
  const t = msg.content.toLowerCase().trim();
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  if (t === "/start" || t === "/ping") {
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🚀 ${BOT_NAME} IS ONLINE`)
      .setDescription("Solana Sniper is running in **Extreme Spammer Mode ($50 Liq / 5s Scan)**.")
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
      .setTitle(`📊 ${BOT_NAME} STATS (Extreme Scan)`)
      .setDescription(s)
      .setFooter({ text: BOT_NAME });
    await msg.reply({ embeds: [embed] });
  }
});

client.login(TOKEN).catch((e) => {
  console.error("❌ DISCORD LOGIN FAILED:", e?.message || e);
  process.exit(1);
});
