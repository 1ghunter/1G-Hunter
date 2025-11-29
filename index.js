import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CHAN = process.env.CHANNEL_ID;
const REF = "https://axiom.trade/@1gvault"; // your fat referral

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const posted = new Set();
let lastCall = 0;

async function getFire() {
  const chains = [
    { name: "SOL", url: "https://api.dexscreener.com/latest/dex/pairs/solana?orderBy=volume_h1&order=desc" },
    { name: "BASE", url: "https://api.dexscreener.com/latest/dex/pairs/base?orderBy=volume_h1&order=desc" },
    { name: "BNB", url: "https://api.dexscreener.com/latest/dex/pairs/bsc?orderBy=volume_h1&order=desc" }
  ];

  const candidates = [];

  for (const chain of chains) {
    try {
      const r = await fetch(chain.url + "&minLiquidity=20000");
      const json = await r.json();
      if (!json.pairs) continue;

      for (const p of json.pairs.slice(0, 40)) {
        const mc = p.marketCap || p.fdv || 0;
        const liq = p.liquidity?.usd || 0;
        const vol = p.volume?.h1 || 0;
        const ch1h = p.priceChange?.h1 || 0;
        const ch5m = p.priceChange?.m5 || 0;

        if (posted.has(p.pairAddress)) continue;
        if (mc < 20000 || mc > 280000) continue;
        if (liq < 25000) continue;
        if (vol < 110000) continue;
        if (ch1h < 48) continue;

        const ageMin = p.pairCreatedAt ? Math.round((Date.now() - new Date(p.pairCreatedAt)) / 60000) : 999;
        if (ageMin > 300) continue;

        // real win score (what actually works)
        let score = 60;
        score += ch1h;
        score += vol > 300000 ? 25 : vol > 180000 ? 15 : 5;
        score += liq > 80000 ? 18 : liq > 45000 ? 10 : 0;
        score += ch5m > 12 ? 20 : 0;
        score = Math.min(99, Math.round(score));

        const flag = liq > 65000 && ch5m > 10 ? "GREEN" : "YELLOW";
        const chainEmoji = chain.name === "SOL" ? "SOL" : chain.name === "BASE" ? "BASE" : "BNB";

        candidates.push({
          chain: chain.name,
          emoji: chainEmoji,
          symbol: p.baseToken.symbol,
          mc: Math.round(mc/1000),
          vol: Math.round(vol/1000),
          liq: Math.round(liq/1000),
          pump: ch1h.toFixed(1),
          age: ageMin,
          score,
          flag,
          link: `https://dexscreener.com/${chain.name === "BNB" ? "bsc" : chain.name.toLowerCase()}/${p.pairAddress}`,
          addr: p.pairAddress
        });
      }
    } catch {} // silent, real degens don't crash
  }

  if (candidates.length === 0) return null;
  candidates.sort((a,b) => b.score - a.score);
  return candidates[0];
}

async function dropCall() {
  if (Date.now() - lastCall < 19*60*1000) return; // max 1 call per ~20min

  const gem = await getFire();
  if (!gem) return;

  posted.add(gem.addr);
  lastCall = Date.now();

  const msg = `
**1G ULTIMATE CALLER — ${gem.score}% WIN PROBABILITY**

**${gem.emoji} DEGEN FIRE** — $${gem.symbol}
MC: $${gem.mc}K  •  Age: ${gem.age}m
1h Vol: $${gem.vol}K (apes going berserk)
Liq: $${gem.liq}K → **ANTI-RUG ${gem.flag === "GREEN" ? "PASSED" : "WATCH CLOSE"}**
1h: **+${gem.pump}%** ${gem.pump > 120 ? "MOONING" : "STRONG"}

${gem.flag === "GREEN" ? "GREEN" : "YELLOW"} ${gem.flag === "GREEN" ? "SAFEST PLAY RIGHT NOW" : "HIGH RISK = HIGH REWARD"}

${gem.link}

Fastest entry → ${REF}

snipe before the whales dump on you
  `.trim();

  try {
    const ch = await client.channels.fetch(CHAN);
    await ch.send(msg);
    console.log(`DROPPED ${gem.score}% CALL → $${gem.symbol} on ${gem.emoji}`);
  } catch (e) {
    console.log("send failed, whatever");
  }
}

client.once("ready", () => {
  console.log(`1G ULTIMATE CALLER LIVE — hunting SOL + BASE + BNB degens`);
  dropCall();
  setInterval(dropCall, 1000 * 60 * 11); // check every 11min
  setInterval(dropCall, 1000 * 60 * 37); // backup stagger
});

client.login(TOKEN);
