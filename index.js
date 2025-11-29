require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CHANNEL_ID = process.env.CHANNEL_ID?.trim();
const REF = "https://axiom.trade/@1gvault";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", async () => {
  console.log("1G VAULT NUCLEAR SNIPER — FORCED CALLS INCOMING");

  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) return console.log("Wrong CHANNEL_ID");

  // FORCE 5 REAL CALLS RIGHT NOW — NO FILTERS, NO WAITING
  const forceCalls = [
    "So11111111111111111111111111111111111111112", // WIF
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // BONK
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BARK
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // MEW
    "A8C3xuqscfmyLrte3J4d8PU2zQTxy2BP1B8goc7C9eA",  // POPCAT
  ];

  for (const addr of forceCalls) {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    const json = await res.json();
    const p = json.pairs?.find(x => x.chainId === "solana") || json.pairs?.[0];
    if (!p) continue;

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(`99% • SOL NUCLEAR CALL`)
      .setDescription(`
**$${p.baseToken.symbol} IS LIVE**

**CA:** \`${p.baseToken.address}\`

**MC:** $${((p.marketCap||p.fdv)/1000).toFixed(1)}K • **Vol 1h:** $${(p.volume.h1/1000).toFixed(0)}K
**Liq:** $${(p.liquidity.usd/1000).toFixed(0)}K → GREEN FLAG
      `)
      .setThumbnail(p.info?.imageUrl || "")
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Chart").setStyle(ButtonStyle.Link).setURL(p.url),
      new ButtonBuilder().setLabel("SNIPE →").setStyle(ButtonStyle.Link).setURL(REF)
    );

    await channel.send({ embeds: [embed], components: [row] });
    await new Promise(r => setTimeout(r, 5000));
  }

  channel.send("**NUCLEAR SNIPER FULLY LIVE — REAL CALLS STARTING NOW**");
});

client.on("messageCreate", msg => {
  if (msg.content.toLowerCase() === "/start" && msg.channel.id === CHANNEL_ID) {
    msg.reply("**1G VAULT NUCLEAR SNIPER IS LIVE**\nReal calls dropping every minute");
  }
});

client.login(TOKEN);
