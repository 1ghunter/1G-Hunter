/* index.js - FINAL DEFINITIVE VERSION
   Strategy: Fair Value Gap (FVG) Retracement (1:3 RR)
   Platform: Robust Deployment on Render
*/

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Cron = require('cron').CronJob;
const express = require('express');

// --- 1. RENDER KEEPER (Essential for 24/7 Uptime) ---
const app = express();
const PORT = process.env.PORT || 10000; 

app.get('/', (req, res) => {
    res.send('✅ 1G-Hunter Bot is ACTIVE. SMC FVG Scanners operational.');
});

// Use 0.0.0.0 for compatibility across cloud platforms
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Keep-Alive Server listening on port ${PORT}`);
});
// ---------------------------------------------------

// --- 2. CREDENTIALS AND CONFIG (Robust Check) ---
// .trim() removes any potential invisible spaces from Render dashboard input
const TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : null;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ? process.env.DISCORD_CHANNEL_ID.trim() : null;

// Trading Configuration
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'LTCUSDT'];
const TIMEFRAME = '15m'; 
const RR_RATIO = 3.0; // Fixed Risk/Reward target of 1:3

// Logger
function log(...args){ console.log(new Date().toLocaleTimeString('en-US'), ...args); }

// --- 3. DATA FETCHING (451 API FIX) ---
// Using data.binance.com bypasses regional restrictions (Status 451)
const BASE_URL = 'https://data.binance.com/api/v3'; 

async function getCandles(symbol, interval = TIMEFRAME, limit = 100) {
    try {
        const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url, { timeout: 15000 });
        
        // Map the array to a cleaner object structure
        return res.data.map(k => ({
            t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), 
            l: parseFloat(k[3]), c: parseFloat(k[4]),
        }));
    } catch (e) {
        // Report error but do not crash the scanner
        log(`❌ [API ERROR] Failed to fetch ${symbol}. Check logs for Status 451: ${e.message}`);
        return [];
    }
}

// --- 4. PROFESSIONAL SMC/FVG ALGORITHM ---
// This logic finds the high-probability gap left by institutional displacement.
function analyzeFVG(symbol, candles) {
    if (candles.length < 5) return null;

    // Define the three key candles for FVG detection
    const c1 = candles[candles.length - 4]; // The candle before the gap
    const c2 = candles[candles.length - 3]; // The Displacement/Order Block candle
    const c3 = candles[candles.length - 2]; // The most recent closed candle

    let signal = null;

    // --- BEARISH FVG CHECK (SHORT) ---
    // Condition: C2 is bearish displacement AND a gap exists (C1 Low > C3 High)
    if (c2.c < c2.o && c2.l < c1.l) { 
        if (c1.l > c3.h) { 
            const entryZoneTop = c1.l;
            const entryZoneBottom = c3.h;
            
            // ENTRY: 50% Retracement of the FVG (The Sniper Entry)
            const entry = (entryZoneTop + entryZoneBottom) / 2; 

            // STOP LOSS: Above the High of the Order Block (C2)
            const stopLoss = c2.h * 1.001; 
            const risk = Math.abs(stopLoss - entry);
            
            if (risk > 0) {
                signal = {
                    type: 'SHORT',
                    setup: 'Bearish FVG Retracement',
                    entry: entry,
                    sl: stopLoss,
                    tp: entry - (risk * RR_RATIO), 
                    risk: risk
                };
            }
        }
    }

    // --- BULLISH FVG CHECK (LONG) ---
    // Condition: C2 is bullish displacement AND a gap exists (C1 High < C3 Low)
    if (c2.c > c2.o && c2.h > c1.h) { 
        if (c1.h < c3.l) { 
            const entryZoneTop = c3.l;
            const entryZoneBottom = c1.h;

            // ENTRY: 50% Retracement of the FVG 
            const entry = (entryZoneTop + entryZoneBottom) / 2; 

            // STOP LOSS: Below the Low of the Order Block (C2)
            const stopLoss = c2.l * 0.999;
            const risk = Math.abs(entry - stopLoss);
            
            if (risk > 0) {
                signal = {
                    type: 'LONG',
                    setup: 'Bullish FVG Retracement',
                    entry: entry,
                    sl: stopLoss,
                    tp: entry + (risk * RR_RATIO),
                    risk: risk
                };
            }
        }
    }

    if (signal) {
        signal.symbol = symbol;
        signal.time = Date.now();
        return signal;
    }
    return null;
}

// --- 5. DISCORD SENDER ---
function createEmbed(s) {
    const color = s.type === 'LONG' ? 0x00FF00 : 0xFF0000;
    const emoji = s.type === 'LONG' ? '🟢' : '🔴';

    return new EmbedBuilder()
        .setTitle(`${emoji} SNIPER ${s.type} FVG SETUP: ${s.symbol} `)
        .setDescription(`**Strategy:** ${s.setup} (${TIMEFRAME} TF)`)
        .setColor(color)
        .addFields(
            { name: '✅ Entry (50% FVG)', value: `$${s.entry.toFixed(4)}`, inline: true },
            { name: '🛑 Stop Loss', value: `$${s.sl.toFixed(4)}`, inline: true },
            { name: '🔥 R:R Ratio', value: `1:${RR_RATIO.toFixed(1)}`, inline: true },
            { name: '🎯 Take Profit (3R)', value: `$${s.tp.toFixed(4)}`, inline: true },
        )
        .setFooter({ text: '1G-Hunter | Smart Money Concepts | NFA' })
        .setTimestamp(s.time);
}

async function runBot(client) {
    log('[SCANNER] Starting FVG market scan...');
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) { log(`❌ CRITICAL: Channel ID ${CHANNEL_ID} not found or inaccessible.`); return; }

        for (const symbol of SYMBOLS) {
            const candles = await getCandles(symbol);
            const signal = analyzeFVG(symbol, candles);

            if (signal) {
                log(`[SIGNAL] FVG trade found for ${symbol} - ${signal.type}`);
                await channel.send({ embeds: [createEmbed(signal)] });
            }
            // Small pause for rate limit safety and cleaner logs
            await new Promise(r => setTimeout(r, 700)); 
        }
        log('[SCANNER] Scan finished.');
    } catch (err) {
        log(`❌ [DISCORD ERROR] Failed to send signal: ${err.message}`);
    }
}

// --- 6. INITIALIZATION & ENVIRONMENT CHECK ---
if (TOKEN && CHANNEL_ID) {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', () => {
        log(`[DISCORD] Online as ${client.user.tag}`);
        runBot(client); 

        // Schedule cron job to run every 15 minutes
        new Cron('0 */15 * * * *', () => runBot(client), null, true, 'UTC');
    });

    client.login(TOKEN).catch(e => log(`❌ [LOGIN ERROR] Invalid Token/Permissions. Check Discord Token: ${e.message}`));
} else {
    // Definitive error log if environment variables are STILL missing
    log('!!! 🛑 CRITICAL ERROR: MISSING ENVIRONMENT VARIABLES !!!');
    log(`Token set: ${!!TOKEN}. Channel ID set: ${!!CHANNEL_ID}.`);
    log('Action REQUIRED: You must fix the variable names in the Render Dashboard.');
}
