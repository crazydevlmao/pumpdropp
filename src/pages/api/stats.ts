import type { NextApiRequest, NextApiResponse } from "next";

const HELIUS = process.env.HELIUS_API_KEY!;
const TOKEN_CA = process.env.TOKEN_CA!;
const DEV_WALLET = process.env.DEV_WALLET!;
const PUMP_MINT = process.env.PUMP_MINT!;

// In-memory cache
let last = { t: 0, data: { marketCap: 0, volume: 0, totalPumpBought: 0, totalPumpAirdropped: 0 } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  if (now - last.t < 5000) return res.status(200).json(last.data);

  // --- TODO: CHOOSE DATA SOURCES ---
  // A) If you insist on Helius-only for mcap/volume, tell me and I'll implement
  //    a derived approach (scan trades/LP, calculate price & volume).
  // B) Otherwise, you can temporarily plug Dexscreener for mcap/volume here,
  //    while we use Helius for wallet tracking.

  // Placeholder mcap/volume (replace with your chosen source):
  const marketCap = 0; // <- replace
  const volume = 0;    // <- replace

  // Using Helius to compute TOTAL $PUMP acquired by your dev wallet:
  // We’ll scan recent txs and sum mints received (this is a simplified skeleton).
  let totalPumpBought = 0;

  try {
    // Example: Helius Enhanced Tx endpoint (skeleton; real impl parses instructions)
    // You must replace WALLET_ADDRESS and parse for SPL token transfers of PUMP_MINT to DEV_WALLET.
    // https://docs.helius.dev/ (Enhanced Transactions)
    const txResp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "pump-acquired",
        method: "getSignaturesForAddress",
        params: [DEV_WALLET, { limit: 100 }],
      }),
    });
    // NOTE: You’ll want to expand this: for each signature, call getTransaction (enhanced)
    // and sum token transfers where mint == PUMP_MINT and destination == DEV_WALLET.
    // For brevity, leaving totalPumpBought = 0 as a placeholder.
  } catch (e) {
    // keep 0 on failure
  }

  // Value Distributed = Total $PUMP acquired * 0.004095
  const totalPumpAirdropped = totalPumpBought * 0.004095;

  const data = { marketCap, volume, totalPumpBought, totalPumpAirdropped };
  last = { t: now, data };
  return res.status(200).json(data);
}
