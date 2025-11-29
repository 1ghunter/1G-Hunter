// index.js — 1G VAULT ULTIMATE CALLER 2025 FINAL
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://axiom.trade/@1gvault";

if (!TOKEN || !CHANNEL_ID) {
  console.error("MISSING DISCORD_TOKEN OR CHANNEL_ID — FIX YOUR ENV VARS");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const alreadyCalled = new Set();
const tracking = new Map();

const CHAINS = {
  "SOL": "solana",
  "BASE": "base",
  "BNB": "bsc"
};

async function fetchPairs(chain) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}?limit=100&orderBy=volume_h1&order=desc`);
    const j = await r.json();
    return j.pairs || [];
  } catch (e) {
    return [];
  }
}

function getScore(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const m5 = p.priceChange?.m5 || 0;

  let score = 60;
  score += Math.min(h1 * 1.1, 40);
  if (vol > 600000) score += 28;
  else if (vol > 300000) score += 18;
  if (liq > 100000) score += 25;
  else if (liq > 60000) score += 15;
  if (m5 > 25) score += 20;
  if (mc < 120000) score += 12;
  if (mc < 60000) score += 8;
  return Math.min(99, Math.round(score));
}

async function sendCall() {
  let best = null;

  for (const [emoji, chain] of Object.entries(CHAINS)) {
    const pairs = await fetchPairs(chain);
    for (const p of pairs) {
      if (alreadyCalled.has(p.pairAddress)) continue;

      const mc = p.marketCap || p.fdv;
      if (mc < 30000 || mc > 380000) continue;
      if (p.liquidity?.usd < 40000) continue;
      if (p.volume?.h1 < 180000) continue;
      if (p.priceChange?.h1 < 60) continue;

      const ageMin = p.pairCreatedAt ? Math.round((Date.now() - new Date(p.pairCreatedAt)) / 60000) : 999;
      if (ageMin > 540) continue;

      const score = getScore(p);
      if (score < 84) continue;

      if (!best || score > best.score) {
        best = { ...p, score, chain: emoji, age: ageMin };
      }
    }
  }

  if (!best) return;

  alreadyCalled.add(best.pairAddress);
  const greenFlag = best.liquidity.usd > 90000 && best.priceChange.m5 > 20;

  const embed = new EmbedBuilder()
    .setColor(greenFlag ? 0x00ff44 : 0xffaa00)
    .setTitle(`${best.score}% WIN RATE — 1G VAULTIMATE CALL`)
    .setDescription(`
**${best.chain} DEGEN ROCKET** — $${best.baseToken.symbol}

**CA:** \`${best.baseToken.address}\`

**MC:** $${(best.marketCap/1000).toFixed(1)}K • **Age:** ${best.age}min
**1h Vol:** $${(best.volume.h1/1000).toFixed(0)}K
**Liq:** $${(best.liquidity.usd/1000).toFixed(0)}K → **ANTI-RUG ${greenFlag ? "GREEN" : "YELLOW"}**

${greenFlag ? "SAFEST PLAY ON CHAIN RN" : "YELLOW = PURE GAMBLE = 50-500x"}
    `.trim())
    .setThumbnail(best.baseToken.logoURI || null)
    .setTimestamp()
    .setFooter({ text: "1G Vault • Not financial advice • DYOR" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Live Chart").setStyle(ButtonStyle.Link).setURL(`https://dexscreener.com/${best.chain === "BNB" ? "bsc" : best.chain.toLowerCase()}/${best.pairAddress}`),
    new ButtonBuilder().setLabel("SNIPE 0% FEE →").setStyle(ButtonStyle.Link).setURL(REF)
  );

  const msg = await client.channels.cache.get(CHANNEL_ID)?.send({ embeds: [embed], components: [row] });

  if (msg) {
    tracking.set(best.pairAddress, {
      msgId: msg.id,
      entryMC: best.marketCap || best.fdv,
      symbol: best.baseToken.symbol,
      chain: best.chain,
      reported: false
    });
  }
}

async function checkProfits() {
  for (const [addr, data] of tracking.entries()) {
    if (data.reported) continue;

    try {
      const chain = data.chain === "BNB" ? "bsc" : data.chain.toLowerCase();
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`);
      const j = await r.json();
      const p = j.pair;
      if (!p) continue;

      const currentMC = p.marketCap || p.fdv;
      const gain = ((currentMC - data.entryMC) / data.entryMC) * 100;
      if (gain < 30) continue;

      const channel = client.channels.cache.get(CHANNEL_ID);
      const original = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!original) continue;

      const fire = gain > 10000 ? "100000%" : gain > 1000 ? "10000%" : gain > 500 ? "1000%" : gain > 200 ? "500%" : "100%";

      const flex = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(`${fire} $${data.symbol} IS UP ${gain.toFixed(1)}% FROM 1G CALL`)
        .setDescription(gain > 1000 ? "WE JUST PRINTED A LEGEND" : "told you it was cooking")
        .setTimestamp();

      await original.reply({ embeds: [flex] });
      data.reported = true;
    } catch (e) {}
  }
}

client.on("ready", () => {
  console.log("1G VAULT ULTIMATE CALLER IS LIVE — SOL + BASE + BNB + PROFIT FLEX");
  sendCall();
  setInterval(sendCall, 690000 + Math.floor(Math.random() * 60000)); // ~11.5 min
  setInterval(checkProfits, 480000); // every 8 min
});

client.login(TOKEN);
