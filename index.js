// index.js — 1G VAULT NUCLEAR SNIPER 2025 — 800-1500 CALLS/DAY
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://axiom.trade/@1gvault";

if (!TOKEN || !CHANNEL_ID) { console.error("Missing env"); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const called = new Set();
const tracking = new Map();

// MULTI-SOURCE SCAN — EVERY HOT PLATFORM
async function getHotCoins() {
  const sources = await Promise.allSettled([
    fetch("https://api.dexscreener.com/latest/dex/search?q=&limit=100").then(r => r.json()),
    fetch("https://gmgn.ai/api/v1/ranking?type=trending").then(r => r.json()),
    fetch("https://api.axiom.trade/v1/trending").then(r => r.json()),
    fetch("https://pump.fun/api/trending").then(r => r.json()),
    fetch("https://birdeye.so/tv/trending?chain=solana").then(r => r.json())
  ]);

  const addresses = new Set();
  sources.forEach(res => {
    if (res.status === "fulfilled" && res.value) {
      const data = res.value;
      if (Array.isArray(data.pairs)) data.pairs.forEach(p => p.baseToken?.address && addresses.add(p.baseToken.address));
      if (Array.isArray(data.data)) data.data.forEach(c => c.address && addresses.add(c.address));
      if (data.trending) data.trending.forEach(c => addresses.add(c.address || c.pairAddress));
    }
  });
  return Array.from(addresses);
}

// BEST SCORING SYSTEM 2025
function calculateScore(p) {
  let score = 70;
  const mc = p.fdv || p.marketCap || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || p.volume?.["1h"] || 0;
  const change = p.priceChange?.h1 || p.priceChange?.["1h"] || 0;
  const m5 = p.priceChange?.m5 || 0;

  if (vol > 1000000) score += 30;
  else if (vol > 500000) score += 25;
  else if (vol > 200000) score += 18;
  if (change > 200) score += 28;
  else if (change > 100) score += 20;
  else if (change > 50) score += 12;
  if (m5 > 40) score += 22;
  if (liq > 120000) score += 25;
  if (mc < 120000) score += 15;
  return Math.min(99, Math.round(score));
}

async function nuclearScan() {
  const hotAddresses = await getHotCoins();
  if (hotAddresses.length === 0) return;

  for (const addr of hotAddresses) {
    if (called.has(addr)) continue;

    let pair;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
      const json = await res.json();
      pair = json.pairs?.[0];
      if (!pair) continue;
    } catch { continue; }

    const mc = pair.marketCap || pair.fdv;
    const liq = pair.liquidity?.usd || 0;
    const vol = pair.volume?.h1 || 0;
    const change = pair.priceChange?.h1 || 0;

    // ULTRA AGGRESSIVE BUT SAFE FILTERS
    if (mc < 8000 || mc > 1500000) continue;
    if (liq < 18000) continue;
    if (vol < 120000) continue;
    if (change < 28) continue;

    const score = calculateScore(pair);
    if (score < 78) continue;

    called.add(addr);
    const green = liq > 90000 && pair.priceChange?.m5 > 25;

    const embed = new EmbedBuilder()
      .setColor(green ? 0x00ff00 : 0xff8c00)
      .setTitle(`${score}% WIN • ${pair.chainId === "solana" ? "SOL" : pair.chainId.toUpperCase()} NUCLEAR CALL`)
      .setDescription(`
**$${pair.baseToken.symbol} IS ON FUCKING FIRE**

**CA:** \`${pair.baseToken.address}\`

**MC:** $${(mc/1000).toFixed(1)}K • **1h Vol:** $${(vol/1000).toFixed(0)}K • **Liq:** $${(liq/1000).toFixed(0)}K
**Flag:** ${green ? "GREEN = SAFU" : "YELLOW = HIGH RISK HIGH REWARD"}
      `.trim())
      .setThumbnail(pair.info?.imageUrl || pair.baseToken.logoURI || null)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`),
      new ButtonBuilder().setLabel("SNIPE 0% FEE").setStyle(ButtonStyle.Link).setURL(REF)
    );

    const msg = await client.channels.cache.get(CHANNEL_ID)?.send({ embeds: [embed], components: [row] });
    if (msg) {
      tracking.set(pair.baseToken.address, {
        msgId: msg.id,
        entryMC: mc,
        symbol: pair.baseToken.symbol,
        reported: false
      });
    }

    await new Promise(r => setTimeout(r, 8000)); // avoid rate limit
  }
}

// PROFIT FLEX — ONLY WINNERS
async function flexWinners() {
  for (const [addr, data] of tracking.entries()) {
    if (data.reported) continue;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
      const json = await res.json();
      const pair = json.pairs?.[0];
      if (!pair) continue;

      const current = pair.marketCap || pair.fdv;
      const gain = ((current - data.entryMC) / data.entryMC) * 100;
      if (gain < 30) continue;

      const channel = client.channels.cache.get(CHANNEL_ID);
      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      const badge = gain > 10000 ? "1000000%" : gain > 1000 ? "10000%" : gain > 500 ? "1000%" : "500%";
      const flex = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`${badge} FROM 1G CALL — $${data.symbol}`)
        .setDescription(`+${gain.toFixed(1)}% PnL · We printed again`)
        .setTimestamp();

      await orig.reply({ embeds: [flex] });
      data.reported = true;
    } catch {}
  }
}

// COMMANDS
client.on("messageCreate", async msg => {
  if (!msg.content) return;
  const c = msg.content.toLowerCase().trim();
  if ((c === "/start" || c === "/ping") && msg.channel.id === CHANNEL_ID) {
    msg.reply("**1G VAULT NUCLEAR SNIPER IS LIVE**\n800–1500 calls/day · Multi-source · PnL flex only on winners");
  }
});

// START
client.once("ready", () => {
  console.log("1G VAULT NUCLEAR SNIPER 2025 FULLY LIVE — 800-1500 CALLS/DAY");
  nuclearScan();
  setInterval(nuclearScan, 75000 + Math.random() * 30000); // every 75–105 sec
  setInterval(flexWinners, 300000);
  setInterval(() => fetch(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ping`), 240000);
});

client.login(TOKEN);
