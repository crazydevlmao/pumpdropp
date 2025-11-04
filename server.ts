import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";

/* ================== CONFIG ================== */
const PORT = Number(process.env.PORT || 4000);
const HELIUS_KEY = process.env.HELIUS_KEY || "";
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || "";
const DEV_WALLET =
  process.env.DEV_WALLET || "Bqx5ycNhbEbYtVrpA4UKuQiFZuyBEenTZJSdFz1Mb1bs";
const TOKEN_CA =
  process.env.TOKEN_CA || "8rsZxFLwy8oxV5Tea2zbekNeZR4iitoNR44mV4nDKHx1";
const PUMP_TOKEN_CA =
  process.env.PUMP_MINT || "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const VALUE_MULTIPLIER = 0.004;
const INITIAL_AIRDROP = 6469833; // 🔥 baseline airdrop
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const CACHE_FILE = "./pumpdrop_cache.json";
const LOG_FILE = "./pumpdrop_logs.json"; // ✅ persist worker + server logs

// ✅ include both program IDs (kept as-is for your stack)
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhDWQ9VgjZbQRd7fLwZbyb3QT4";

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
  totalPumpBought: INITIAL_AIRDROP,
  totalValue: INITIAL_AIRDROP * VALUE_MULTIPLIER,
  lastUpdated: 0,
};

// ✅ load cache
if (fs.existsSync(CACHE_FILE)) {
  try {
    const prev = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cache = { ...cache, ...prev };
    if (cache.totalPumpBought < INITIAL_AIRDROP) {
      cache.totalPumpBought += INITIAL_AIRDROP;
      cache.totalValue = cache.totalPumpBought * VALUE_MULTIPLIER;
      console.log(`🔁 Added baseline ${INITIAL_AIRDROP.toLocaleString()} $PUMP`);
    }
    console.log("💾 Loaded previous cache:", cache);
  } catch {}
} else {
  console.log(`🆕 Starting fresh with baseline ${INITIAL_AIRDROP.toLocaleString()} $PUMP`);
}

let BASELINE_PUMP_BOUGHT = cache.totalPumpBought;

/* ================== LOGGING ================== */
let logs: { msg: string; time: number }[] = [];

// ✅ load previous persisted logs
if (fs.existsSync(LOG_FILE)) {
  try {
    logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) || [];
    console.log(`💾 Loaded ${logs.length} previous logs`);
  } catch {}
}

function log(msg: string, tag: "server" | "worker" = "server") {
  if (!msg?.trim()) return;
  const ignore = [
    "⚠️ [AIRDROP] batch failed",
    "Transaction was not confirmed",
    "unknown if it succeeded",
  ];
  if (ignore.some((x) => msg.includes(x))) return;

  const tagged = tag === "worker" ? `[WORKER] ${msg}` : msg;
  console.log(tagged);
  logs.unshift({ msg: tagged, time: Date.now() });
  logs = logs.slice(0, 400);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
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
      vol24h = Number(pair?.volume?.h24) || Number(pair?.volume24h) || 0;
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

  const json = (await res.json().catch(() => ({}))) as any;
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

/* ================== TOKEN DECIMALS (NEW: normalize holdings) ================== */
let TOKEN_DECIMALS: number | null = null;

async function getTokenDecimals(): Promise<number> {
  if (TOKEN_DECIMALS !== null) return TOKEN_DECIMALS;
  // Use standard Solana RPC method to fetch mint supply/decimals
  const result = await rpc<any>("getTokenSupply", [TOKEN_CA]);
  const dec = Number(result?.value?.decimals ?? 0);
  TOKEN_DECIMALS = isFinite(dec) ? dec : 0;
  return TOKEN_DECIMALS;
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
  const sinceStartDistributed =
    (cache.totalPumpBought - BASELINE_PUMP_BOUGHT) * VALUE_MULTIPLIER;

  res.json({
    ...cache,
    baselinePumpBought: BASELINE_PUMP_BOUGHT,
    valueDistributedSinceStart: sinceStartDistributed,
  });
});

app.get("/api/logs", (_req, res) => {
  res.json(
    logs.map((l) => {
      let msg = l.msg.replace(/^\[WORKER\]\s*/i, ""); // remove [WORKER]

      // match both "TX:" / "Tx:" and bare base58 txids (after | or space)
      const match =
        msg.match(/T[Xx]:\s*([A-Za-z0-9]{15,})/) ||
        msg.match(/(?:[|]\s*|^)([1-9A-HJ-NP-Za-km-z]{32,100})/);

      if (match) {
        const sig = match[1];
        const link = solscanTxLink(sig);
        // add clickable [TX] at the start
        msg =
          `<a href="${link}" target="_blank" style="color:#9fff6f;text-decoration:underline;font-weight:bold;">[TX]</a> ` +
          msg;
      }

      return { msg, time: l.time };
    })
  );
});




app.post("/api/ingest-log", (req, res) => {
  try {
    const msg = (req.body as any)?.msg?.toString?.() ?? "";
    if (!msg.trim()) return res.json({ ok: false });

    if (
      /\[CLAIM\]|\[SWAP\]|\[AIRDROP\]/.test(msg) ||
      msg.includes("🌊 [AIRDROP]") ||
      msg.includes("✅ [AIRDROP]") ||
      msg.includes("🎉 [AIRDROP]")
    ) {
      log(msg.trim(), "worker");
    }
    res.json({ ok: true });
  } catch (err: any) {
    log(`⚠️ [INGEST ERROR] ${err.message}`);
    res.json({ ok: false });
  }
});

/* ================== HOLDERS ENDPOINT (normalize by decimals) ================== */
app.get("/api/holders", async (req, res) => {
  try {
    const walletQuery = (req.query.wallet as string)?.trim()?.toLowerCase();
    const decimals = await getTokenDecimals();
    const denom = Math.pow(10, decimals);

    let cursor: string | null = null;
    const parsed: { wallet: string; amount: number }[] = [];

    // iterate a few pages to avoid huge scans
    for (let page = 0; page < 5; page++) {
      const params: any = {
        mint: TOKEN_CA,
        limit: 1000,
      };
      if (cursor) params.cursor = cursor;

      const rpcBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccounts",
        params,
      };

      const response = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcBody),
      });

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Holders RPC HTTP ${response.status}: ${txt}`);
      }

      const data: any = await response.json();
      if (data.error) throw new Error(data.error.message || "RPC error");

      const tokenAccounts = data.result?.token_accounts || [];

      for (const account of tokenAccounts) {
        const owner = String(account.owner || account.ownerAddress || "");
        // Prefer raw integer amount when available, then normalize.
        // Fallback to any uiAmount-like field if present.
        let amountNorm = 0;

        if (account.amount !== undefined && account.amount !== null) {
          // raw integer (string or number)
          const raw = Number(account.amount);
          amountNorm = isFinite(raw) ? raw / denom : 0;
        } else if (account.tokenAmount?.amount) {
          const raw = Number(account.tokenAmount.amount);
          amountNorm = isFinite(raw) ? raw / denom : 0;
        } else if (account.uiAmount !== undefined) {
          amountNorm = Number(account.uiAmount) || 0;
        } else if (account.tokenAmount?.uiAmount !== undefined) {
          amountNorm = Number(account.tokenAmount.uiAmount) || 0;
        }

        if (owner) parsed.push({ wallet: owner, amount: amountNorm });
      }

      cursor = data.result?.cursor || null;
      if (!cursor) break;
    }

    // Aggregate by wallet (if multiple token accounts per owner)
    const byWallet: Record<string, number> = {};
    for (const p of parsed) {
      if (!p.wallet) continue;
      byWallet[p.wallet] = (byWallet[p.wallet] || 0) + (isFinite(p.amount) ? p.amount : 0);
    }

    const aggregated = Object.entries(byWallet).map(([wallet, amount]) => ({ wallet, amount }));

    // Filter > 200k, sort desc, rank
    const holders = aggregated
      .filter((h) => h.amount > 200_000)
      .sort((a, b) => b.amount - a.amount)
      .map((h, i) => ({ rank: i + 1, wallet: h.wallet, amount: h.amount }));

    // If wallet query, return rank for that wallet based on full sorted list
    if (walletQuery) {
      const allSorted = aggregated.sort((a, b) => b.amount - a.amount);
      const found = allSorted.find((h) => h.wallet.toLowerCase() === walletQuery);
      if (found) {
        const rank = allSorted.findIndex((h) => h.wallet.toLowerCase() === walletQuery) + 1;
        return res.json({ rank, wallet: found.wallet, amount: found.amount, holders });
      }
    }

    res.json({ holders });
  } catch (err: any) {
    log(`⚠️ [HOLDERS ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ================== BOOT ================== */
setInterval(updateMetrics, 10_000);
updateMetrics();

app.listen(PORT, () => {
  console.log(`🚀 Pumpdrop metrics server running on port ${PORT}`);
  log(`🚀 Server started on port ${PORT}`);
});



