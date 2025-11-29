// index.js — 1G VAULT ULTRA DEGEN CALLER 2025 — 40-80 CALLS/DAY
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://axiom.trade/@1gvault";

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing TOKEN or CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const called = new Set();
const tracking = new Map();
const CHAINS = { "SOL": "solana", "BASE": "base", "BNB": "bsc" };

async function fetchPairs(chain) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}?limit=100&orderBy=volume_h1&order=desc`);
    const j = await r.json();
    return j.pairs || [];
  } catch { return []; }
}

function scorePair(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const m5 = p.priceChange?.m5 || 0;

  let s = 60;
  s += Math.min(h1 * 1.2, 45);
  if (vol > 800000) s += 32;
  else if (vol > 300000) s += 22;
  else if (vol > 90000) s += 12;
  if (liq > 100000) s += 28;
  else if (liq > 50000) s += 15;
  if (m5 > 25) s += 20;
  if (mc < 80000) s += 12;
  return Math.min(99, Math.round(s));
}

// =========== ULTRA DEGEN DROP CALL ===========
async function dropCall() {
  let candidates = [];

  for (const [emoji, chain] of Object.entries(CHAINS)) {
    const pairs = await fetchPairs(chain);
    for (const p of pairs) {
      if (called.has(p.pairAddress)) continue;

      const mc = p.marketCap || p.fdv || 0;
      const liq = p.liquidity?.usd || 0;
      const vol = p.volume?.h1 || 0;
      const change = p.priceChange?.h1 || 0;

      if (mc < 15000 || mc > 900000) continue;
      if (liq < 20000) continue;
      if (vol < 90000) continue;
      if (change < 30) continue;

      const age = p.pairCreatedAt ? Math.round((Date.now() - new Date(p.pairCreatedAt)) / 60000) : 999;
      if (age > 1440) continue;

      const score = scorePair(p);
      if (score < 68) continue;

      candidates.push({ ...p, score, chain: emoji, age });
    }
  }

  if (candidates.length === 0) return;

  candidates.sort((a, b) => b.volume.h1 - a.volume.h1);
  const toCall = candidates.slice(0, Math.min(6, candidates.length));

  for (const best of toCall) {
    called.add(best.pairAddress);
    const green = best.liquidity.usd > 80000;

    const embed = new EmbedBuilder()
      .setColor(green ? 0x00ff44 : 0xffaa00)
      .setTitle(`${best.score}% • ${best.chain} ULTRA DEGEN CALL`)
      .setDescription(`
**$${best.baseToken.symbol} IS PRINTING HARD**

**CA:** \`${best.baseToken.address}\`

**MC:** $${(best.marketCap/1000).toFixed(1)}K • **1h Vol:** $${(best.volume.h1/1000).toFixed(0)}K
**Liq:** $${(best.liquidity.usd/1000).toFixed(0)}K → ${green ? "GREEN FLAG" : "YELLOW = GAMBLE"}
      `.trim())
      .setThumbnail(best.baseToken.logoURI || null)
      .setTimestamp();

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(`https://dexscreener.com/${best.chain.toLowerCase() === "bnb" ? "bsc" : best.chain.toLowerCase()}/${best.pairAddress}`),
        new ButtonBuilder().setLabel("SNIPE 0% FEE →").setStyle(ButtonStyle.Link).setURL(REF)
      );

    const msg = await client.channels.cache.get(CHANNEL_ID)?.send({ embeds: [embed], components: [buttons] });
    if (msg) {
      tracking.set(best.pairAddress, {
        msgId: msg.id,
        entryMC: best.marketCap || best.fdv,
        symbol: best.baseToken.symbol,
        reported: false
      });
    }
    await new Promise(r => setTimeout(r, 4000));
  }
}

// =========== PROFIT FLEX ===========
async function flexGains() {
  for (const [addr, data] of tracking.entries()) {
    if (data.reported) continue;
    try {
      const chain = data.chain?.toLowerCase() === "bnb" ? "bsc" : data.chain?.toLowerCase();
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`);
      const j = await r.json();
      const p = j.pair;
      if (!p) continue;

      const current = p.marketCap || p.fdv;
      const gain = ((current - data.entryMC) / data.entryMC) * 100;
      if (gain < 35) continue;

      const channel = client.channels.cache.get(CHANNEL_ID);
      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      const fire = gain > 1000 ? "10000%" : gain > 500 ? "1000%" : gain > 200 ? "500%" : "100%";
      const flex = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(`${fire} UP FROM 1G CALL — $${data.symbol}`)
        .setDescription(`+${gain.toFixed(1)}% since call`)
        .setTimestamp();

      await orig.reply({ embeds: [flex] });
      data.reported = true;
    } catch {}
  }
}

// =========== /start COMMAND ===========
client.on("messageCreate", async (msg) => {
  if (!msg.content) return;
  const content = msg.content.toLowerCase().trim();
  if (content === "/start" || content === "/ping") {
    if (msg.channel.id !== CHANNEL_ID) return;
    await msg.reply("**1G VAULT ULTRA DEGEN CALLER IS LIVE**\nSOL • BASE • BNB\n40–80 calls/day mode activated");
  }
});

// =========== STARTUP ===========
client.once("ready", () => {
  console.log("1G VAULT ULTRA DEGEN CALLER FULLY LIVE — 40-80 CALLS/DAY MODE");
  dropCall();
  setInterval(dropCall, 300000 + Math.random() * 60000); // 5–6 min
  setInterval(flexGains, 360000);
  setInterval(() => fetch("https://" + process.env.RENDER_EXTERNAL_HOSTNAME || "your-app.onrender.com/ping"), 240000);
});

client.login(TOKEN);
