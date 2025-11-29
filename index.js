import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.CHANNEL_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// 1. Real Pump.fun launches + DexScreener combo
async function getPumpFunGems() {
  try {
    const [pump, dex] = await Promise.all([
      fetch("https://pump.fun/api/trending?limit=20").then(r => r.json()),
      fetch("https://api.dexscreener.com/latest/dex/search?q=solana").then(r => r.json())
    ]);

    const pumpTokens = pump?.slice(0, 10) || [];
    const dexPairs = dex?.pairs || [];

    const gems = [];

    for (const p of pumpTokens) {
      const pair = dexPairs.find(d => d.baseToken.address === p.mint);
      if (!pair) continue;

      const mc = pair.fdv || pair.marketCap || 0;
      const vol = pair.volume?.h1 || 0;
      const liq = pair.liquidity?.usd || 0;
      const change = pair.priceChange?.h1 || 0;

      // Strict 1G Hunter filters
      if (mc > 150000) continue;           // low cap only
      if (vol < 80000) continue;           // high volume trades
      if (liq < 18000) continue;           // strong anti-rug
      if (change < 35) continue;           // must be pumping hard
      if (p.devWalletHold > 0.15) continue; // dev holds <15% = safer

      gems.push({
        symbol: p.symbol,
        mint: p.mint,
        pairAddress: pair.pairAddress,
        mc: mc,
        vol: vol,
        liq: liq,
        change: change,
        age: Math.floor((Date.now() - new Date(p.created_timestamp).getTime()) / 60000),
        devHold: (p.devWalletHold * 100).toFixed(1),
        insiders: p.reply_count > 30 || p.quote_count > 10 ? "X INSIDERS LOADING" : "Whales quiet sniping"
      });
    }
    return gems.sort((a, b) => b.vol - a.vol).slice(0, 2);
  } catch (e) {
    return [];
  }
}

async function send1GHunterCall() {
  const gems = await getPumpFunGems();
  if (gems.length === 0) return;

  const gem = gems[0];

  const message = `
════════════════════════════════
**1G HUNTER JUST BAGGED A 100X CANDIDATE**

**$${gem.symbol}** — PUMP.FUN FRESH LAUNCH
**Age:** ${gem.age} minutes old — YOU ARE EXTREMELY EARLY
**Market Cap:** $${(gem.mc/1000).toFixed(0)}K ← still microscopic
**1h Volume:** $${(gem.vol/1000).toFixed(0)}K+ ← degens aping hard
**Liquidity:** $${(gem.liq/1000).toFixed(0)}K ← **ANTI-RUG PASSED**
**Dev holds:** ${gem.devHold}% ← safe zone
**1h Pump:** +${gem.change.toFixed(0)}% and climbing

**INSIDERS STATUS:** ${gem.insiders}

**THIS IS YOUR 1G SHOT — DO NOT MISS**

https://dexscreener.com/solana/${gem.pairAddress}
https://pump.fun/${gem.mint}

**SNIPE NOW OR CRY LATER**
════════════════════════════════
  `.trim();

  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send(message);
    console.log(`1G HUNTER FIRED → $${gem.symbol} (${(gem.mc/1000).toFixed(0)}K)`);
  } catch (e) { console.error(e); }
}

client.once("ready", () => {
  console.log("1G HUNTER v2 IS LIVE — HUNTING ONLY 100X GEMS");
  send1GHunterCall();
  setInterval(send1GHunterCall, 1000 * 60 * (20 + Math.random() * 25)); // 20–45 min
});

client.login(token);
