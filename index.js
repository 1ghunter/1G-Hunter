/* index.js - PROFESSIONAL SMC/SNIPER BOT
   Strategy: Liquidity Sweeps + Market Structure Shift (MSS)
   Risk Management: 1:3 Fixed RR
   Platform: Render (Auto-Keep-Alive included)
*/

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Cron = require('cron').CronJob;
const express = require('express');

// --- 1. RENDER KEEPER (Prevents "Offline" Status) ---
const app = express();
const PORT = process.env.PORT || 10000; // Render usually uses 10000

app.get('/', (req, res) => {
    res.send('✅ 1G-Hunter Bot is ACTIVE. SMC Scanners running.');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Web server listening on port ${PORT}`);
});

// --- 2. CREDENTIALS DEBUGGER ---
// This block finds "hidden" spaces in your variables
const TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : null;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ? process.env.DISCORD_CHANNEL_ID.trim() : null;

console.log('--- DEBUGGING ENVIRONMENT ---');
console.log(`Token Loaded: ${TOKEN ? 'YES (Length: ' + TOKEN.length + ')' : 'NO'}`);
console.log(`Channel ID:   ${CHANNEL_ID ? 'YES' : 'NO'}`);
if (!TOKEN || !CHANNEL_ID) {
    console.error('❌ FATAL ERROR: Variables missing. Check Render Dashboard for typos/spaces.');
    // We do NOT exit process here so the web server stays alive to let you read logs.
}

// --- 3. TRADING CONFIGURATION ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
const TIMEFRAME = '15m'; 
const LOOKBACK_CANDLES = 50; // How far back to look for swing points

// --- 4. DATA FETCHING (No API Key needed for Public Data) ---
async function getCandles(symbol) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${LOOKBACK_CANDLES}`;
        const res = await axios.get(url);
        // Format: [Time, Open, High, Low, Close, Volume]
        return res.data.map(k => ({
            t: k[0],
            o: parseFloat(k[1]),
            h: parseFloat(k[2]),
            l: parseFloat(k[3]),
            c: parseFloat(k[4]),
            v: parseFloat(k[5])
        }));
    } catch (e) {
        console.error(`[API ERROR] Could not fetch ${symbol}: ${e.message}`);
        return [];
    }
}

// --- 5. SMC ALGORITHM (The "Sniper" Logic) ---
function analyzeSMC(symbol, candles) {
    if (candles.length < 30) return null;

    // Get recent price action
    const current = candles[candles.length - 1]; // Live candle (ignore)
    const trigger = candles[candles.length - 2]; // Completed candle (Signal Trigger)
    const prev = candles[candles.length - 3];    // Setup candle

    // 1. Identify Swing Highs/Lows in the last 20 candles (excluding last 3)
    const range = candles.slice(-23, -3);
    const swingHigh = Math.max(...range.map(c => c.h));
    const swingLow = Math.min(...range.map(c => c.l));

    let signal = null;

    // --- SCENARIO A: SHORT (Bearish Sweep) ---
    // Logic: Price wicked ABOVE old high (grabbed liquidity) but closed BELOW it.
    if (trigger.h > swingHigh && trigger.c < swingHigh) {
        // Confirmation: Strong displacement down (red candle)
        if (trigger.c < trigger.o) {
            const entry = trigger.c;
            const stopLoss = trigger.h * 1.0005; // Just above the wick
            const risk = Math.abs(stopLoss - entry);
            
            signal = {
                type: 'SHORT',
                setup: 'Liquidity Sweep (Bearish)',
                entry: entry,
                sl: stopLoss,
                tp1: entry - (risk * 2), // 1:2
                tp2: entry - (risk * 3), // 1:3 (Sniper)
                risk: risk
            };
        }
    }

    // --- SCENARIO B: LONG (Bullish Sweep) ---
    // Logic: Price wicked BELOW old low (grabbed liquidity) but closed ABOVE it.
    if (trigger.l < swingLow && trigger.c > swingLow) {
        // Confirmation: Strong displacement up (green candle)
        if (trigger.c > trigger.o) {
            const entry = trigger.c;
            const stopLoss = trigger.l * 0.9995; // Just below the wick
            const risk = Math.abs(entry - stopLoss);

            signal = {
                type: 'LONG',
                setup: 'Liquidity Sweep (Bullish)',
                entry: entry,
                sl: stopLoss,
                tp1: entry + (risk * 2),
                tp2: entry + (risk * 3),
                risk: risk
            };
        }
    }

    if (signal) {
        signal.symbol = symbol;
        signal.time = Date.now();
        return signal;
    }
    return null;
}

// --- 6. DISCORD SIGNAL SENDER ---
function createEmbed(s) {
    const color = s.type === 'LONG' ? 0x00FF00 : 0xFF0000;
    const emoji = s.type === 'LONG' ? '🟢' : '🔴';

    return new EmbedBuilder()
        .setTitle(`${emoji} ${s.type} SIGNAL: ${s.symbol}`)
        .setDescription(`**Strategy:** ${s.setup}\n**Timeframe:** ${TIMEFRAME}`)
        .setColor(color)
        .addFields(
            { name: 'ENTRY', value: `$${s.entry.toFixed(4)}`, inline: true },
            { name: 'STOP LOSS', value: `$${s.sl.toFixed(4)}`, inline: true },
            { name: 'RISK', value: '1.0%', inline: true },
            { name: '🎯 TP 1 (1:2)', value: `$${s.tp1.toFixed(4)}`, inline: true },
            { name: '🚀 TP 2 (1:3)', value: `$${s.tp2.toFixed(4)}`, inline: true },
        )
        .setFooter({ text: '1G-Hunter | SMC Logic | NFA' })
        .setTimestamp();
}

async function runBot(client) {
    console.log('[SCANNER] Starting market scan...');
    const channel = await client.channels.fetch(CHANNEL_ID).catch(e => console.error("Bad Channel ID"));
    
    if (!channel) return;

    for (const symbol of SYMBOLS) {
        const candles = await getCandles(symbol);
        const signal = analyzeSMC(symbol, candles);

        if (signal) {
            console.log(`[SIGNAL] Found trade for ${symbol}`);
            await channel.send({ embeds: [createEmbed(signal)] });
        }
        await new Promise(r => setTimeout(r, 500)); // Rate limit safety
    }
    console.log('[SCANNER] Scan finished.');
}

// --- 7. INITIALIZATION ---
if (TOKEN && CHANNEL_ID) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', () => {
        console.log(`[DISCORD] Online as ${client.user.tag}`);
        runBot(client); // Run immediately on start

        // Schedule cron job (Every 15 mins at XX:00, XX:15, etc.)
        new Cron('0 */15 * * * *', () => runBot(client), null, true, 'UTC');
    });

    client.login(TOKEN).catch(e => console.error("[LOGIN ERROR] Token invalid:", e.message));
} else {
    console.log("[SYSTEM] Bot waiting for valid Environment Variables...");
}
