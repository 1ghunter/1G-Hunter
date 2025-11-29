import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.CHANNEL_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const coins = ["SOLPEPE", "DOGESOL", "DEGENDUCK", "MOONCAT", "APESOL", "CUMROCK", "SHITCOIN", "PEPEKING"];

async function sendCall() {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const message = `
🔥 **DEGEN CALL – AUTO SNIPER** 🔥
💎 $${coin}
📈 MC: ${Math.floor(Math.random()*80+20)}K
📊 Volume: ${Math.floor(Math.random()*900+600)}K+
⚡ LIVE ENTRY – PUMPING NOW
🛡️ 99% anti-rug
🚀 Fast in, faster out!
  `;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(message.trim());
    console.log("Call sent!");
  } catch (e) { console.log("Error:", e.message); }
}

client.once("ready", () => {
  console.log("Bot is online!");
  setInterval(sendCall, 1000 * 60 * 5); // every 5 minutes
  sendCall(); // send one immediately
});

client.login(token);
