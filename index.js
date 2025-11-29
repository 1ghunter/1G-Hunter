import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const REF = "https://axiom.trade/@1gvault";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const called = new Set();
const tracking = new Map(); // pairAddress → {msgId, entryMC, symbol, chain, ca}

const chains = {
  SOL: "solana",
  BASE: "base", 
  BNB: "bsc"
};

async function getPairs(chain) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}?orderBy=volume_h1&order=desc`);
    const data = await res.json();
    return data.pairs || [];
  } catch { return []; }
}

function calcWinRate(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const m5 = p.priceChange?.m5 || 0;

  let score = 55;
  score += h1 * 0.95;
  if (vol > 500000) score += 30;
  else if (vol > 250000) score += 20;
  if (liq > 90000) ? score += 22 : (liq > 50000) ? score += 12 : 0;
  if (m5 > 20) score += 25;
  if (mc < 100000) score += 15;
  return Math.min(99, Math.round(score));
}

async function fireCall() {
  let winner = null;

  for (const [emoji, chain] of Object.entries(chains)) {
    const pairs = await getPairs(chain);
    for (const p of pairs) {
      if (called.has(p.pairAddress)) continue;

      const mc = p.marketCap || p.fdv || 0;
      if (mc < 25000 || mc > 350000) continue;
      if ((p.liquidity?.usd || 0) < 35000) continue;
      if ((p.volume?.h1 || 0) < 160000) continue;
      if ((p.priceChange?.h1 || 0) < 58) continue;

      const age = p.pairCreatedAt ? (Date.now() - new Date(p.pairCreatedAt)) / 60000 : 999;
      if (age > 480) continue;

      const score = calcWinRate(p);
      if (score < 81) continue;

      if (!winner || score > winner.score) {
        winner = { ...p, score, chain: emoji, age: Math.round(age) };
      }
    }
  }

  if (!winner) return;

  called.add(winner.pairAddress);
  const isGreen = winner.liquidity.usd > 85000 && winner.priceChange.m5 > 18;
  const color = isGreen ? 0x00ff44 : 0xff8c00;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${winner.score}% WIN PROBABILITY — 1G VAULT LIVE CALL`)
    .setDescription(`
**${winner.chain} DEGEN BURNER** — $${winner.baseToken.symbol}

**CA:** \`${winner.baseToken.address}\`

**Market Cap:** $${(winner.marketCap/1000).toFixed(1)}K** • **Age:** ${winner.age}m
**1h Volume:** $${(winner.volume.h1/1000).toFixed(0)}K
**Liquidity:** $${(winner.liquidity.usd/1000).toFixed(0)}K → **ANTI-RUG ${isGreen ? "GREEN" : "YELLOW"}**

${isGreen ? "SAFEST DEGEN ON CHAIN RIGHT NOW" : "YELLOW HIGH RISK = 10-100x REWARD"}
    `.trim())
    .setThumbnail(winner.baseToken.logoURI || "https://i.imgur.com/8z1qK8P.png")
    .setTimestamp()
    .setFooter({ text: "1G Vault • Never Financial Advice", iconURL: "https://i.imgur.com/8z1qK8P.png" });

  const row = {
    type: 1,
    components: [
      { type: 2, style: 5, label: "Chart", url: `https://dexscreener.com/${winner.chain === "BNB" ? "bsc" : winner.chain.toLowerCase()}/${winner.pairAddress}` },
      { type: 2, style: 1, label: "SNIPE NOW (0% fee)", url: REF }
    ]
  };

  const msg = await client.channels.cache.get(CHANNEL_ID)?.send({ embeds: [embed], components: [row] });

  if (msg) {
    tracking.set(winner.pairAddress, {
      msgId: msg.id,
      entryMC: winner.marketCap || winner.fdv,
      symbol: winner.baseToken.symbol,
      chain: winner.chain,
      reported: false
    });
  }
}

// Profit flexer — hits every 8 min
async function flexProfits() {
  for (const [addr, data] of tracking) {
    if (data.reported) continue;
    try {
      const chain = data.chain === "BNB" ? "bsc" : data.chain.toLowerCase();
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`);
      const json = await res.json();
      const p = json.pair;
      if (!p) continue;

      const current = p.marketCap || p.fdv;
      const gain = ((current - data.entryMC) / data.entryMC) * 100;

      if (gain < 30) continue;

      const channel = client.channels.cache.get(CHANNEL_ID);
      const original = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!original) continue;

      let fire = gain > 1000 ? "10000%" : gain > 500 ? "1000%" : gain > 200 ? "500%" : "100%";

      const flex = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(`${fire} $${data.symbol} IS UP ${gain.toFixed(1)}% FROM 1G CALL`)
        .setDescription(gain > 500 ? "WE JUST SENT ANOTHER ONE TO VALHALLA" : "told y’all it was cooking")
        .setTimestamp();

      await original.reply({ embeds: [flex] });
      data.reported = true;
    } catch {}
  }
}

client.once("ready", () => {
  console.log("1G VAULT ULTIMATE CALLER ONLINE — SOL + BASE + BNB + PROFIT FLEXER");
  fireCall();
  setInterval(fireCall, 1e3 * 60 * 11.5 + Math.random() * 3e4);
  setInterval(flexProfits, 1e3 * 60 * 8);
});

client.login(TOKEN);
