import type { NextApiRequest, NextApiResponse } from "next";

const BASE = process.env.NEXT_PUBLIC_WORKER_API_BASE || "";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!BASE) return res.status(200).json([]);
    const r = await fetch(`${BASE.replace(/\/$/, "")}/api/logs?t=${Date.now()}`, { cache: "no-store" });
    const arr = r.ok ? await r.json() : [];
    const now = Date.now();
    const cleaned = (Array.isArray(arr) ? arr : [])
      .filter((x) => x && typeof x.msg === "string" && typeof x.time === "number")
      .filter((x) => now - x.time < 600_000)
      .sort((a, b) => b.time - a.time)
      .slice(0, 200);
    return res.status(200).json(cleaned);
  } catch {
    return res.status(200).json([]);
  }
}
