import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";

/* ================== CONFIG ================== */
const PORT = Number(process.env.PORT || 4000);
const HELIUS_KEY = process.env.HELIUS_KEY || "";
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || "";
const DEV_WALLET = process.env.DEV_WALLET || "Bqx5ycNhbEbYtVrpA4UKuQiFZuyBEenTZJSdFz1Mb1bs";
const TOKEN_CA = process.env.TOKEN_CA || "8rsZxFLwy8oxV5Tea2zbekNeZR4iitoNR44mV4nDKHx1";
const PUMP_TOKEN_CA = process.env.PUMP_MINT || "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const VALUE_MULTIPLIER = 0.004;
const INITIAL_AIRDROP = 6469833; // 🔥 baseline airdrop
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const CACHE_FILE = "./pumpdrop_cache.json";

const app = express();
app.use(cors());
app.use(express.json());

/* ================== STATE ================== */
type Cache = {
  marketCap: number;
  volume: number;
  totalPumpBought: number;
  totalValue: number;
  lastUpdated: number;
};

let cache: Cache = {
  marketCap: 0,
  volume: 0,
  totalPumpBought: INITIAL_AIRDROP,               // start from your manual base
  totalValue: INITIAL_AIRDROP * VALUE_MULTIPLIER, // base * 0.004
  lastUpdated: 0,
};

// ✅ load previous saved data (and add your baseline if not yet included)
if (fs.existsSync(CACHE_FILE)) {
  try {
    const prev = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cache = { ...cache, ...prev };

    // If the saved total is smaller than your baseline, add it once
    if (cache.totalPumpBought < INITIAL_AIRDROP) {
      cache.totalPumpBought += INITIAL_AIRDROP;
      cache.totalValue = cache.totalPumpBought * VALUE_MULTIPLIER;
      console.log(`🔁 Added baseline ${INITIAL_AIRDROP.toLocaleString()} $PUMP to saved cache.`);
    }

    console.log("💾 Loaded previous cache:", cache);
  } catch {}
} else {
  console.log(`🆕 Starting fresh with baseline ${INITIAL_AIRDROP.toLocaleString()} $PUMP`);
}


// ✅ baseline starts AFTER loading cache, not before
let BASELINE_PUMP_BOUGHT = cache.totalPumpBought;


let logs: { msg: string; time: number }[] = [];

/* ================== HELPERS ================== */
function log(msg: string) {
  const ignore = [
    "⚠️ [AIRDROP] batch failed",
    "Transaction was not confirmed",
    "unknown if it succeeded",
  ];
  if (ignore.some((x) => msg.includes(x))) return;
  console.log(msg);
  logs.unshift({ msg, time: Date.now() });
  logs = logs.slice(0, 200);
}

function solscanTxLink(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

/* ================== BIRDEYE ================== */
async function fetchBirdeye<T = any>(endpoint: string): Promise<T> {
  const url = `https://public-api.birdeye.so/${endpoint}`;
  const res = await fetch(url, {
    headers: {
      "X-API-KEY": BIRDEYE_KEY,
      "x-chain": "solana",
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    log(`⚠️ [BIRDEYE] ${endpoint} failed: ${res.status} | ${text}`);
    return {} as T;
  }
  return res.json() as Promise<T>;
}

async function getBirdeyeMarketData(): Promise<{ mcap: number; vol24h: number }> {
  const overview = await fetchBirdeye<any>(
    `defi/token_overview?address=${TOKEN_CA}&ui_amount_mode=scaled`
  );

  const mcap =
    Number(overview?.data?.marketCap) ||
    Number(overview?.data?.market_cap) ||
    0;

  let vol24h =
    Number(overview?.data?.v24hUSD) ||
    Number(overview?.data?.volume24hUSD) ||
    0;

  if (!vol24h) {
    try {
      const dex = (await fetch(
  `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_CA}`
).then((r) => r.json().catch(() => ({})))) as { pairs?: any[] };

const pair = dex.pairs?.[0];
      vol24h =
        Number(pair?.volume?.h24) ||
        Number(pair?.volume24h) ||
        0;
    } catch (err) {
      log(`⚠️ [DEXSCREENER] fallback failed: ${(err as any)?.message}`);
    }
  }
  return { mcap, vol24h };
}

/* ================== HELIUS ================== */
async function rpc<T = any>(method: string, params: any[]): Promise<T> {
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const json = (await res.json().catch(() => ({}))) as any;   // ← cast to any
  if (!res.ok || json.error) throw new Error(json.error?.message || res.statusText);
  return json.result as T;
}


function pumpCreditFromParsedTx(tx: any): number {
  if (!tx?.meta) return 0;
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  let credited = 0;
  for (const postBal of post) {
    const preBal = pre.find((p: any) => p.accountIndex === postBal.accountIndex);
    if (postBal.mint !== PUMP_TOKEN_CA) continue;
    if (postBal.owner !== DEV_WALLET) continue;
    const postAmt = Number(postBal.uiTokenAmount?.uiAmount || 0);
    const preAmt = Number(preBal?.uiTokenAmount?.uiAmount || 0);
    const delta = postAmt - preAmt;
    if (delta > 0) credited += delta;
  }
  return credited;
}

const seenTxs = new Set<string>();

async function accumulateNewPumpBuys(): Promise<number> {
  try {
    const sigs = await rpc<any[]>("getSignaturesForAddress", [DEV_WALLET, { limit: 50 }]);
    for (const s of sigs) {
      const sig = s?.signature;
      if (!sig || seenTxs.has(sig)) continue;

      const tx = await rpc<any>("getTransaction", [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]).catch(() => null);

      if (!tx) continue;
      const credited = pumpCreditFromParsedTx(tx);
      if (credited > 0) {
        cache.totalPumpBought += credited;
        cache.totalValue = cache.totalPumpBought * VALUE_MULTIPLIER;
        seenTxs.add(sig);
        log(`💧 [BUY] Dev wallet received ${credited.toFixed(6)} $PUMP — TX: ${sig}`);
      }
    }
    return cache.totalPumpBought;
  } catch (err: any) {
    log(`⚠️ [HELIUS RPC ERROR] ${err.message}`);
    return cache.totalPumpBought;
  }
}

/* ================== UPDATE LOOP ================== */
async function updateMetrics() {
  try {
    const [{ mcap, vol24h }] = await Promise.all([getBirdeyeMarketData()]);
    await accumulateNewPumpBuys();

    cache.marketCap = mcap;
    cache.volume = vol24h;
    cache.totalValue = cache.totalPumpBought * VALUE_MULTIPLIER;
    cache.lastUpdated = Date.now();

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    log(
  `✅ [UPDATE] Mcap $${mcap.toFixed(2)} | Vol24h $${vol24h.toFixed(
    2
  )} | Dev $PUMP ${cache.totalPumpBought.toFixed(6)} | Value Distributed $${(
    cache.totalPumpBought * VALUE_MULTIPLIER
  ).toFixed(2)}`
);

  } catch (err: any) {
    log(`⚠️ [ERROR] ${err.message}`);
  }
}

/* ================== ENDPOINTS ================== */
app.get("/api/stats", (_req, res) => {
  // calculate current 24h distributed value dynamically
  const sinceStartDistributed = (cache.totalPumpBought - BASELINE_PUMP_BOUGHT) * VALUE_MULTIPLIER;

  res.json({
    ...cache,
    baselinePumpBought: BASELINE_PUMP_BOUGHT,
    valueDistributedSinceStart: sinceStartDistributed,
  });
});

app.get("/api/logs", (_req, res) => {
  res.json(
    logs.map((l) => {
      const m = l.msg.match(/TX:\s*([A-Za-z0-9]{15,})/);
      if (m) {
        const sig = m[1];
        const link = solscanTxLink(sig);
        return {
          msg: l.msg.replace(
            `TX: ${sig}`,
            `🔗 <a href="${link}" target="_blank" style="color:#9fff6f;text-decoration:underline;">TRANSACTION</a>`
          ),
          time: l.time,
        };
      }
      return l;
    })
  );
});

// ✅ optional endpoint for workers to push live console logs from Render
app.post("/api/ingest-log", (req, res) => {
  const msg = (req.body as any)?.msg?.toString?.() ?? "";
  if (msg.trim()) log(msg.trim());
  res.json({ ok: true });
});

/* ================== BOOT ================== */
setInterval(updateMetrics, 10_000);
updateMetrics();

app.listen(PORT, () => {
  console.log(`🚀 Pumpdrop metrics server running on port ${PORT}`);
  log(`🚀 Server started on port ${PORT}`);
});
