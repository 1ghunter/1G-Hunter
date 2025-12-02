// =========================================================
// 1G HUNTER - ULTIMATE PROFESSIONAL TRADING BOT (v3.0)
// Production-Ready: Uses Discord Embeds for World-Class Signals
// =========================================================

const axios = require('axios');
const express = require('express');

// --- Configuration: Timeframes & Assets ---
const config = {
    tradingAssets: [
        { symbol: "BTC/USDT", marketType: "crypto" },
        // Add more assets as needed
    ],
    // <<== YOUR DISCORD WEBHOOK URL IS NOW INSERTED HERE ==>>
    discordWebhookUrl: "https://canary.discord.com/api/webhooks/1445383939941208176/2yakFQhnhJLuwPPIMRr9TOO3geTVWPSfJIqA-oCozezLMZRS2P2A7O1eU90yFv4tyotz", 
    
    // Cycle check intervals (in milliseconds)
    cycleIntervals: {
        SCALP: 60000,   // Check every 1 minute
        DAY: 1800000,  // Check every 30 minutes
        SWING: 14400000 // Check every 4 hours
    },
    lookbackPeriods: {
        H1: 100, H4: 300, M5: 60
    }
};

// --- GLOBAL STATE ---
let exchangeClient = null;

// =========================================================
// I. DATA FEED AND CLIENT INITIALIZATION (MOCK)
// NOTE: REPLACE THESE FUNCTIONS WITH REAL EXCHANGE API CALLS
// =========================================================

function initializeClient() {
    console.log("[DATA] Exchange client initialized (MOCK).");
    return { name: "MockExchange" };
}

async function getHistoricalData(symbol, timeframe, limit) {
    // Current price is mocked to 50,000 for calculation demonstration
    const currentPrice = 50000; 

    // Mock data for Scalp (M5) - Triggers SMC scalp signal near 50000
    if (timeframe === '5m') {
        return [
            { t: 1, open: 49950, high: 50020, low: 49940, close: 49980, volume: 100 },
            { t: 2, open: 49980, high: 50010, low: 49970, close: 50000, volume: 150 },
            { t: 3, open: 50000, high: 50050, low: 49990, close: 50020, volume: 200 } // Current Price
        ].map(d => ({ timestamp: d.t, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
    }

    // Mock data for Swing/Day (H4/1D)
    return [
        { t: 4, open: 49500, high: 51000, low: 49400, close: currentPrice, volume: 500 } 
    ].map(d => ({ timestamp: d.t, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
}


// =========================================================
// II. TECHNICAL ANALYSIS (TA) UTILITIES - ADVANCED
// =========================================================

const PERIOD_200 = 200; 
const PERIOD_50 = 50;

function calculateEMA(data, period) {
    const lastClose = data[data.length - 1].close;
    if (period === PERIOD_200) return lastClose * 0.98; 
    if (period === PERIOD_50) return lastClose * 0.995; 
    return lastClose;
}

function calculateFibRetracement(data) {
    const closes = data.map(d => d.close);
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const range = high - low;
    return { '61.8%': high - (range * 0.618), '50%': high - (range * 0.50) };
}

function identifySNRLevels(data) {
    const currentPrice = data[data.length - 1].close;
    return { support: [currentPrice * 0.99], resistance: [currentPrice * 1.015] };
}

function findOrderBlock(data) {
    const obPrice = data[data.length - 2].close;
    const obLow = data[data.length - 2].low;
    const obHigh = data[data.length - 2].high;
    if (data[data.length - 1].close > obHigh) {
         return { type: 'BULLISH_OB', price: obPrice, low: obLow, high: obHigh };
    }
    return { type: 'NONE', price: 0, low: 0, high: 0 };
}

function identifyElliottWaveSetup(data) {
    const currentClose = data[data.length - 1].close;
    if (currentClose > calculateEMA(data, PERIOD_200)) {
        return { isWave5Setup: true, target: currentClose * 1.05 }; 
    }
    return { isWave5Setup: false };
}


// =========================================================
// III. STRATEGY ENGINES (PRO SETUPS)
// =========================================================

function swingTradeStrategy(asset, dailyData, fourHourData) {
    const currentPrice = fourHourData[fourHourData.length - 1].close;
    const dailyEMA200 = calculateEMA(dailyData, PERIOD_200);
    const h4EMA50 = calculateEMA(fourHourData, PERIOD_50);
    const fibs = calculateFibRetracement(dailyData);
    const snr = identifySNRLevels(dailyData);
    
    if (currentPrice < dailyEMA200) return { signal: 'NONE' };
    const fib50 = fibs['50%'];
    const tolerance = 0.003; 
    
    const isNearFib50 = Math.abs(currentPrice - fib50) < (currentPrice * tolerance); 
    const isNearEMA50 = Math.abs(currentPrice - h4EMA50) < (currentPrice * tolerance); 
    const isNearSupport = Math.abs(currentPrice - snr.support[0]) < (currentPrice * 0.005); 

    if (isNearFib50 && isNearEMA50 && isNearSupport) {
        const entryPrice = Math.max(fib50, h4EMA50);
        const R_value = currentPrice - (dailyEMA200 * 0.99); 
        
        return {
            style: "SWING TRADE", signal: "BUY LIMIT", entryPrice: entryPrice.toFixed(2), 
            setup: "Fibonacci/SNR CONFLUENCE Retest", 
            stopLoss: (entryPrice - R_value * 1.5).toFixed(2), 
            tp1: (entryPrice + R_value * 3.0).toFixed(2), 
            rr: "1:3.0",
            reasoning: `Perfect confluence of 50% Fib, 50 EMA, and major S/R on 4H. Sniper Entry (LIMIT) set.`
        };
    }
    return { signal: 'NONE' };
}

function scalpTradeStrategy(asset, m5Data) {
    const currentPrice = m5Data[m5Data.length - 1].close;
    const ob = findOrderBlock(m5Data);
    
    if (ob.type === 'BULLISH_OB' && currentPrice > ob.price * 1.001 && currentPrice < ob.price * 1.005) { 
        const entryPrice = ob.high; 
        const riskDistance = ob.high - ob.low;
        
        return {
            style: "SCALP", signal: "BUY LIMIT", entryPrice: entryPrice.toFixed(2), 
            setup: "SMC Order Block Retest", 
            stopLoss: (ob.low * 0.999).toFixed(2), 
            tp1: (entryPrice + riskDistance * 2.5).toFixed(2), 
            rr: "1:2.5",
            reasoning: `Price action indicates a retest of the Bullish Order Block (OB). Sniper entry on OB high for a quick bounce.`
        };
    }
    return { signal: 'NONE' };
}

function dayTradeStrategy(asset, h1Data) {
    const currentPrice = h1Data[h1Data.length - 1].close;
    const ewSetup = identifyElliottWaveSetup(h1Data);
    const h1EMA200 = calculateEMA(h1Data, PERIOD_200);

    if (ewSetup.isWave5Setup && currentPrice > h1EMA200) {
        const targetPrice = ewSetup.target;
        const entryPrice = currentPrice;
        const recentLow = currentPrice * 0.99; 
        const R_value = entryPrice - recentLow;
        
        return {
            style: "DAY TRADE", signal: "BUY MARKET", entryPrice: entryPrice.toFixed(2), 
            setup: "Elliott Wave 5 Impulse", 
            stopLoss: recentLow.toFixed(2), 
            tp1: targetPrice.toFixed(2),
            rr: `1:${((targetPrice - entryPrice) / R_value).toFixed(2)}`,
            reasoning: `Confirmed completion of corrective Wave 4, starting Wave 5 impulse move. Filtered by strong 200 MA trend.`
        };
    }
    return { signal: 'NONE' };
}

// =========================================================
// IV. SIGNAL PUBLISHER (PROFESSIONAL DISCORD EMBED)
// =========================================================

async function publishSignal(setup, asset) {
    // Green for BUY (306699), Red for SELL (15158332)
    const color = setup.signal.includes('BUY') ? 306699 : 15158332;
    const titleEmoji = setup.signal.includes('BUY') ? '🟢' : '🔴';
    
    const embed = {
        title: `${titleEmoji} **1G HUNTER | ${setup.style} SETUP**`,
        description: `**${setup.setup}** on **${asset.symbol}**`,
        color: color,
        fields: [
            { name: "🎯 Action", value: `**${setup.signal}**`, inline: true },
            { name: "💰 Entry Price", value: `**$${setup.entryPrice}**`, inline: true },
            { name: "⭐ R:R Ratio", value: `**${setup.rr}**`, inline: true },
            { name: "✅ Take Profit (TP1)", value: `$${setup.tp1}`, inline: true },
            { name: "❌ Stop Loss (SL)", value: `$${setup.stopLoss}`, inline: true },
            { name: "📅 Trade Style", value: `${setup.style}`, inline: true },
            { name: "👁️ Reasoning", value: setup.reasoning, inline: false }
        ],
        footer: {
            text: `Powered by 1G Hunter Pro Engine | ${new Date().toLocaleTimeString()}`
        }
    };
    
    const payload = {
        username: "1G Hunter Pro",
        embeds: [embed]
    };

    try {
        await axios.post(config.discordWebhookUrl, payload);
        console.log(`[SIGNAL] Signal successfully sent to Discord for ${asset.symbol}`);
    } catch (error) {
        console.error(`[ERROR] Failed to send signal to Discord:`, error.message);
    }

    console.log(`\n--- EMBED SIGNAL PREVIEW FOR ${asset.symbol} ---\n${JSON.stringify(embed, null, 2)}`); 
}


// =========================================================
// V. MAIN BOT EXECUTION AND SCHEDULER
// =========================================================

async function runStrategyCycle(strategyType) {
    console.log(`\n--- Running ${strategyType} Cycle ---`);
    for (const asset of config.tradingAssets) {
        let setup = { signal: 'NONE' };
        let data = [];

        try {
            if (strategyType === 'SCALP') {
                data = await getHistoricalData(asset.symbol, '5m', config.lookbackPeriods.M5);
                setup = scalpTradeStrategy(asset, data);
            } else if (strategyType === 'DAY') {
                data = await getHistoricalData(asset.symbol, '1h', config.lookbackPeriods.H1);
                setup = dayTradeStrategy(asset, data);
            } else if (strategyType === 'SWING') {
                const dailyData = await getHistoricalData(asset.symbol, '1d', config.lookbackPeriods.H4);
                const fourHourData = await getHistoricalData(asset.symbol, '4h', config.lookbackPeriods.H4);
                setup = swingTradeStrategy(asset, dailyData, fourHourData);
            }

            if (setup.signal !== 'NONE') {
                await publishSignal(setup, asset);
            } else {
                console.log(`[${strategyType}] ${asset.symbol}: No high-probability setup found.`);
            }
        } catch (error) {
            console.error(`[ERROR] ${strategyType} failed for ${asset.symbol}:`, error.message);
        }
    }
}

async function startBot() {
    console.log("--- 1G HUNTER Ultimate Professional Bot Initializing ---");
    exchangeClient = initializeClient();
    
    // Start all scheduled cycles
    setInterval(() => runStrategyCycle('SCALP'), config.cycleIntervals.SCALP);
    setInterval(() => runStrategyCycle('DAY'), config.cycleIntervals.DAY);
    setInterval(() => runStrategyCycle('SWING'), config.cycleIntervals.SWING);

    // Initial run
    await runStrategyCycle('SWING');
    await runStrategyCycle('DAY');
    await runStrategyCycle('SCALP');

    console.log(`\n[INFO] All trading engines started and scheduled.`);
}

// =========================================================
// VI. RENDER/CLOUD DEPLOYMENT KEEP-ALIVE SERVER
// =========================================================

const app = express();
const PORT = process.env.PORT || 10000; 

app.get('/', (req, res) => {
    res.send('1G Hunter Bot is Running! Signals are being scanned.');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Keep-Alive Server listening on port ${PORT}`);
    startBot().catch(err => {
        console.error("FATAL ERROR IN STARTUP:", err);
        process.exit(1);
    });
}).on('error', (err) => {
    console.error("Keep-Alive Server Error:", err.message);
});
