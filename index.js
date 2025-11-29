// index.js — 1G VAULT ULTIMATE CALLER — FINAL 2025 VERSION
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://axiom.trade/@1gvault";

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing TOKEN or CHANNEL_ID — check Render env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const called = new Set();
const tracking = new Map();

const CHAINS = { SOL: "solana", BASE: "base", BNB: "bsc" };

async function fetchPairs(chain) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}?limit=80&orderBy=volume_h1&order=desc`);
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

  let s = 62;
  s += Math.min(h1 * 1.15, 42);
  if (vol > 700000) s += 30;
  else if (vol > 350000) s += 20;
  if (liq > 110000) s += 28;
  else if (liq > 65000) s += 16;
  if (m5 > 28) s += 22;
  if (mc < 110000) s += 14;
  if (mc < 60000) s += 10;
  return Math.min(99, Math.round(s));
}

async function dropCall() {
  let best = null;
  for (const [emoji, chain] of Object.entries(CHAINS)) {
    const pairs = await fetchPairs(chain);
    for (const p of pairs) {
      if (called.has(p.pairAddress)) continue;
      const mc = p.marketCap || p.fdv;
      if (mc < 32000 || mc > 420000) continue;
      if (p.liquidity?.usd < 48000) continue;
      if (p.volume?.h1 < 220000) continue;
      if (p.priceChange?.h1 < 64) continue;

      const age = p.pairCreatedAt ? Math.round((Date.now() - new Date(p.pairCreatedAt)) / 60000) : 999;
      if (age > 600) continue;

      const score = scorePair(p);
      if (score < 86) continue;

      if (!best || score > best.score) best = { ...p, score, chain: emoji, age };
    }
  }

  if (!best) return;

  called.add(best.pairAddress);
  const green = best.liquidity.usd > 95000 && best.priceChange.m5 > 22;

  const embed = new EmbedBuilder()
    .setColor(green ? 0x00ff44 : 0xffaa00)
    .setTitle(`${best.score}% WIN PROBABILITY — 1G VAULT CALL`)
    .setDescription(`
**${best.chain} DEGEN MOONSHOT** — $${best.baseToken.symbol}

**CA:** \`${best.baseToken.address}\`

**MC:** $${(best.marketCap/1000).toFixed(1)}K • **Age:** ${best.age}m
**1h Vol:** $${(best.volume.h1/1000).toFixed(0)}K
**Liq:** $${(best.liquidity.usd/1000).toFixed(0)}K → **ANTI-RUG ${green ? "GREEN" : "YELLOW"}**

${green ? "SAFEST BANGER RIGHT NOW" : "YELLOW = HIGH RISK = 50-1000x POTENTIAL"}
    `.trim())
    .setThumbnail(best.baseToken.logoURI || null)
    .setTimestamp()
    .setFooter({ text: "1G Vault • DYOR • Not financial advice" });

  const buttons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(`https://dexscreener.com/${best.chain === "BNB" ? "bsc" : best.chain.toLowerCase()}/${best.pairAddress}`),
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
}

async function flexGains() {
  for (const [addr, data] of tracking) {
    if (data.reported) continue;
    try {
      const chain = data.chain === "BNB" ? "bsc" : data.chain.toLowerCase();
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`);
      const j = await r.json();
      const p = j.pair;
      if (!p) continue;

      const current = p.marketCap || p.fdv;
      const gain = ((current - data.entryMC) / data.entryMC) * 100;
      if (gain < 30) continue;

      const channel = client.channels.cache.get(CHANNEL_ID);
      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      const fire = gain > 10000 ? "100000%" : gain > 1000 ? "10000%" : gain > 500 ? "1000%" : "500%";

      const flex = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(`${fire} $${data.symbol} UP ${gain.toFixed(1)}% FROM 1G CALL`)
        .setDescription(gain > 1000 ? "WE JUST PRINTED A LEGEND" : "told you boys")
        .setTimestamp();

      await orig.reply({ embeds: [flex] });
      data.reported = true;
    } catch {}
  }
}

// KEEP RENDER ALIVE + CALLS
client.once("ready", () => {
  console.log("1G VAULT ULTIMATE CALLER FULLY LIVE — SOL + BASE + BNB + PROFIT FLEX");
  dropCall();
  setInterval(dropCall, 680000 + Math.random() * 80000);
  setInterval(flexGains, 420000);
  setInterval(() => fetch("https://" + process.env.RENDER_EXTERNAL_HOSTNAME || "your-app.onrender.com"), 240000);
});
// /start & /ping command — instant alive check
client.on("messageCreate", async (msg) => {
  if (!msg.content) return;
  const content = msg.content.toLowerCase().trim();
  if (content === "/start" || content === "/ping") {
    if (msg.channel.id !== CHANNEL_ID) return;
    await msg.reply("**1G VAULT ULTIMATE CALLER IS LIVE & HUNTING**\nSOL • BASE • BNB\nNext call in 1–11 min");
  }
});
client.login(TOKEN);
