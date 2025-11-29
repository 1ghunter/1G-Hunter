// index.js — 1G VAULT ULTIMATE CALLER — HYPER MODE (1-2m calls)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const stateFile = path.resolve(__dirname, "state.json");

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = process.env.REF_URL || "https://axiom.trade/@1gvault";

// HYPER MODE INTERVALS (1–2 minutes)
const MIN_DROP_INTERVAL_MS = Number(process.env.MIN_DROP_INTERVAL_MS) || 60_000;   // 1 minute
const MAX_DROP_INTERVAL_MS = Number(process.env.MAX_DROP_INTERVAL_MS) || 120_000;  // 2 minutes
const FLEX_INTERVAL_MS = Number(process.env.FLEX_INTERVAL_MS) || 180_000;         // 3 minutes for flex checks
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_MS) || 240_000;               // keep alive ping
const MAX_TRACKING_AGE_MIN = Number(process.env.MAX_TRACKING_AGE_MIN) || 60 * 24 * 14; // 14 days

const FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 500;

const CHAINS = { SOL: "solana", BASE: "base", BNB: "bsc" };

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing TOKEN or CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let called = new Set();
let tracking = new Map();

function loadState() {
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, "utf8");
      const j = JSON.parse(raw);
      called = new Set(j.called || []);
      tracking = new Map(Object.entries(j.tracking || {}).map(([k, v]) => [k, v]));
      console.log("State loaded:", called.size, "called,", tracking.size, "tracking");
    }
  } catch (e) {
    console.warn("loadState failed:", e.message);
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
    console.warn("saveState failed:", e.message);
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function retryFetch(url, opts = {}, retries = FETCH_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (i === retries) {
        console.warn("fetch failed:", url, err?.message || err);
        return null;
      }
      await sleep(FETCH_RETRY_DELAY_MS * (i + 1));
    }
  }
  return null;
}

async function fetchPairs(chain) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}?limit=120&orderBy=volume_h1&order=desc`;
  const data = await retryFetch(url);
  return data?.pairs || [];
}

function scorePair(p) {
  const mc = p.marketCap || p.fdv || 0;
  const liq = p.liquidity?.usd || 0;
  const vol = p.volume?.h1 || 0;
  const h1 = p.priceChange?.h1 || 0;
  const m5 = p.priceChange?.m5 || 0;

  let s = 40;
  s += Math.min(h1 * 1.1, 30);
  if (vol > 300000) s += 20;
  else if (vol > 100000) s += 12;
  if (liq > 50000) s += 18;
  else if (liq > 10000) s += 8;
  if (m5 > 15) s += 18;
  if (mc < 200000) s += 10;
  if (mc < 50000) s += 8;
  return Math.min(99, Math.round(s));
}

function sanitizeAddr(a) {
  return (a || "").toLowerCase();
}

async function dropCall() {
  try {
    const chainList = Object.values(CHAINS);
    const results = await Promise.all(chainList.map((c) => fetchPairs(c)));
    let best = null;

    for (let i = 0; i < chainList.length; i++) {
      const chain = chainList[i];
      const pairs = results[i] || [];
      for (const p of pairs) {
        const addr = sanitizeAddr(p.pairAddress || p.address || p.id);
        if (!addr) continue;
        if (called.has(addr)) continue;

        const mc = p.marketCap || p.fdv || 0;
        // HYPER MODE FILTERS (very permissive)
        if (mc < 5000 || mc > 2_000_000) continue;
        if ((p.liquidity?.usd || 0) < 1000) continue;
        if ((p.volume?.h1 || 0) < 5_000) continue;
        if ((p.priceChange?.h1 || 0) < 5) continue; // at least some momentum

        const age = p.pairCreatedAt ? Math.round((Date.now() - new Date(p.pairCreatedAt)) / 60000) : 99999;
        if (age > 60 * 24 * 14) continue; // within 14 days

        const score = scorePair(p);
        if (score < 30) continue; // low bar to include many tokens

        if (!best || score > best.score) {
          best = { ...p, score, chain, age, addr };
        }
      }
    }

    if (!best) return;

    called.add(best.addr);

    const green = (best.liquidity?.usd || 0) > 50_000 && (best.priceChange?.m5 || 0) > 12;

    const embed = new EmbedBuilder()
      .setColor(green ? 0x00ff44 : 0xffaa00)
      .setTitle(`${best.score}% WIN PROBABILITY — 1G VAULT CALL`)
      .setDescription(
        [
          `**${best.chain.toUpperCase()} DEGEN MOONSHOT** — $${best.baseToken?.symbol || "TOKEN"}`,
          ``,
          `**CA:** \`${best.baseToken?.address || "unknown"}\``,
          ``,
          `**MC:** $${((best.marketCap || best.fdv || 0) / 1000).toFixed(1)}K • **Age:** ${best.age}m`,
          `**1h Vol:** $${((best.volume?.h1 || 0) / 1000).toFixed(0)}K`,
          `**Liq:** $${((best.liquidity?.usd || 0) / 1000).toFixed(0)}K → **ANTI-RUG ${green ? "GREEN" : "YELLOW"}**`,
          ``,
          `${green ? "SAFEST BANGER RIGHT NOW" : "YELLOW = HIGH RISK = 50-1000x POTENTIAL"}`,
        ].join("\n")
      )
      .setThumbnail(best.baseToken?.logoURI || null)
      .setTimestamp()
      .setFooter({ text: "1G Vault • DYOR • Not financial advice" });

    const chainKey = best.chain === "BNB" ? "bsc" : best.chain.toLowerCase();
    const chartUrl = `https://dexscreener.com/${chainKey}/${best.addr}`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(chartUrl),
      new ButtonBuilder().setLabel("SNIPE 0% FEE →").setStyle(ButtonStyle.Link).setURL(REF)
    );

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel || !channel.send) return;

    const msg = await channel.send({ embeds: [embed], components: [buttons] }).catch(() => null);
    if (!msg) return;

    tracking.set(best.addr, {
      msgId: msg.id,
      entryMC: best.marketCap || best.fdv || 0,
      symbol: best.baseToken?.symbol || "TOKEN",
      reported: false,
      chain: best.chain,
      ts: Date.now(),
    });

    saveState();
    console.log("HYPER CALL:", best.addr, best.baseToken?.symbol, "score", best.score);
  } catch (err) {
    console.warn("dropCall error:", err?.message || err);
  }
}

async function flexGains() {
  try {
    for (const [addr, data] of Array.from(tracking.entries())) {
      if (data.reported) continue;

      const chain = data.chain === "BNB" ? "bsc" : (data.chain || "bsc").toLowerCase();
      const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${addr}`;
      const j = await retryFetch(url);
      const p = j?.pair;
      if (!p) continue;

      const current = p.marketCap || p.fdv || 0;
      const entryMC = data.entryMC || 1;
      const gain = ((current - entryMC) / entryMC) * 100;
      if (gain < 25) continue; // flex threshold slightly lower in hyper mode

      const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) continue;

      const orig = await channel.messages.fetch(data.msgId).catch(() => null);
      if (!orig) continue;

      const fire = gain > 10000 ? "100000%" : gain > 1000 ? "10000%" : gain > 500 ? "1000%" : "500%";

      const flexEmbed = new EmbedBuilder()
        .setColor(0x00ff44)
        .setTitle(`${fire} $${data.symbol} UP ${gain.toFixed(1)}% FROM 1G CALL`)
        .setDescription(gain > 1000 ? "WE JUST PRINTED A LEGEND" : "told you boys")
        .setTimestamp();

      await orig.reply({ embeds: [flexEmbed] }).catch(() => null);

      data.reported = true;
      tracking.set(addr, data);
      saveState();
      console.log("HYPER FLEX:", addr, "gain", gain.toFixed(1));
    }

    const now = Date.now();
    for (const [addr, data] of Array.from(tracking.entries())) {
      const ageMin = (now - (data.ts || now)) / 60000;
      if (ageMin > MAX_TRACKING_AGE_MIN) {
        tracking.delete(addr);
        saveState();
      }
    }
  } catch (err) {
    console.warn("flexGains error:", err?.message || err);
  }
}

async function keepAlive() {
  try {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.KEEP_ALIVE_HOST;
    if (!host) return;
    const url = host.startsWith("http") ? host : `https://${host}`;
    await fetch(url).catch(() => null);
  } catch {}
}

client.once("ready", async () => {
  console.log("1G VAULT HYPER MODE LIVE —", new Date().toISOString());
  loadState();

  await dropCall();

  const scheduleDrop = async () => {
    try {
      await dropCall();
    } catch (e) {
      console.warn("scheduleDrop err:", e?.message || e);
    } finally {
      const delay = MIN_DROP_INTERVAL_MS + Math.floor(Math.random() * (Math.max(0, MAX_DROP_INTERVAL_MS - MIN_DROP_INTERVAL_MS) + 1));
      setTimeout(scheduleDrop, delay);
    }
  };

  const initialDelay = MIN_DROP_INTERVAL_MS + Math.floor(Math.random() * (Math.max(0, MAX_DROP_INTERVAL_MS - MIN_DROP_INTERVAL_MS) + 1));
  setTimeout(scheduleDrop, initialDelay);

  setInterval(flexGains, FLEX_INTERVAL_MS);
  setInterval(keepAlive, KEEP_ALIVE_MS);
  setInterval(saveState, 60_000);
});

client.on("messageCreate", async (msg) => {
  if (!msg.content) return;
  const t = msg.content.toLowerCase().trim();

  if (t === "/start" || t === "/ping") {
    if (msg.channel.id !== CHANNEL_ID) return;
    await msg.reply("**1G VAULT HYPER MODE IS LIVE**\nExpect frequent calls. DYOR.");
  }

  if ((t === "/reset_called" || t === "/clear_called") && msg.channel.id === CHANNEL_ID) {
    called.clear();
    saveState();
    await msg.reply("Called list cleared.");
  }
});

client.login(TOKEN).catch((e) => {
  console.error("login failed:", e?.message || e);
  process.exit(1);
});
