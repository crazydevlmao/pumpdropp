import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, CheckCircle } from "lucide-react";

/**
 * Pumpdrop Dashboard (Frontend-only React file)
 * -------------------------------------------------
 * Fixes: "process is not defined" in browser builds by avoiding direct
 * access to process.env. We now resolve the API base URL safely from
 * multiple sources (window.__ENV__, import.meta.env, guarded process.env).
 *
 * Configure your API base URL in ANY of these ways:
 *   1) window.__ENV__.NEXT_PUBLIC_WORKER_API_BASE  (set in a small <script>)
 *   2) import.meta.env.VITE_WORKER_API_BASE        (Vite/CRA style)
 *   3) process.env.NEXT_PUBLIC_WORKER_API_BASE     (Next.js – server-injected)
 * If none are present, we fall back to window.location.origin (or http://localhost:4000).
 */

function resolveApiBase(): string {
  // 1) From an inline <script> that sets window.__ENV__
  const fromWindow = (typeof window !== "undefined" && (window as any).__ENV__?.NEXT_PUBLIC_WORKER_API_BASE)
                 || (typeof window !== "undefined" && (window as any).__WORKER_API_BASE);

  // 2) From import.meta.env (Vite, CRA with env exposing)
  const fromImportMeta = (typeof import.meta !== "undefined" && (import.meta as any).env)
    ? ((import.meta as any).env.NEXT_PUBLIC_WORKER_API_BASE || (import.meta as any).env.VITE_WORKER_API_BASE)
    : undefined;

  // 3) From process.env but ONLY if process exists (Next.js at build time)
  const fromProcess = (typeof process !== "undefined" && (process as any).env)
    ? ((process as any).env.NEXT_PUBLIC_WORKER_API_BASE || (process as any).env.WORKER_API_BASE)
    : undefined;

  const fallback = (typeof window !== "undefined") ? window.location.origin : "http://localhost:4000";
  const base = fromWindow || fromImportMeta || fromProcess || fallback;
  return String(base).replace(/\/$/, "");
}

const API_BASE = resolveApiBase();
const MINT_CA = "8rsZxFLwy8oxV5Tea2zbekNeZR4iitoNR44mV4nDKHx1"; // token-2022 CA to display
const AIRDROP_CA = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";   // $PUMP mint to display in header copy

/** Utils */
export function formatTimeAgo(ts: number): string | null {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds >= 600) return null; // hide entries older than 10 minutes
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}min ago`;
}

function kFmt(n: number) {
  if (!isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** Types */
interface LogEntry { msg: string; time: number }
interface StatsResponse {
  marketCap: number;
  volume: number;
  totalPumpBought: number;
  totalValue: number;
}


export default function PumpdropDashboard() {
const [stats, setStats] = useState<StatsResponse>({
  marketCap: 0,
  volume: 0,
  totalPumpBought: 0,
  totalValue: 0,
});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const mounted = useRef(false);

  // ---- Tests (keep existing, add more) ----
  useEffect(() => {
    // Existing tests
    const now = Date.now();
    console.assert(formatTimeAgo(now - 59_000) === "59s ago", "formatTimeAgo should show seconds under a minute");
    console.assert(formatTimeAgo(now - 60_000) === "1min ago", "formatTimeAgo should switch to minutes at 60s");
    console.assert(formatTimeAgo(now - 601_000) === null, "formatTimeAgo should hide older than 10min");

    const s: StatsResponse = { marketCap: 0, volume: 0, totalPumpBought: 0, totalValue: 0 };
console.assert(Object.keys(s).length === 4, "StatsResponse should have 4 keys");

    // Added tests
    console.assert(typeof API_BASE === "string" && API_BASE.length > 0, "API_BASE must be a non-empty string");
    console.assert(kFmt(999) === "999", "kFmt under 1000 should be raw integer");
    console.assert(kFmt(1_500) === "1.5K", "kFmt 1500 -> 1.5K");
    console.assert(kFmt(2_300_000) === "2.3M", "kFmt 2.3M -> 2.3M");
    console.assert(kFmt(4_600_000_000) === "4.6B", "kFmt 4.6B -> 4.6B");
    console.assert(formatTimeAgo(now - 120_000) === "2min ago", "formatTimeAgo 120s -> 2min ago");
  }, []);

  // ---- Poll backend every 5s with cache-busting, only after mount ----
  useEffect(() => {
    mounted.current = true;
    const fetchAll = async () => {
      try {
        const [sRes, lRes] = await Promise.all([
          fetch(`${API_BASE}/api/stats?t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/logs?t=${Date.now()}`, { cache: "no-store" }),
        ]);
        setApiHealthy(sRes.ok && lRes.ok);
        if (sRes.ok) {
          const s = (await sRes.json()) as Partial<StatsResponse>;
          setStats(prev => ({
  marketCap: Number(s.marketCap ?? prev.marketCap) || 0,
  volume: Number(s.volume ?? prev.volume) || 0,
  totalPumpBought: Number(s.totalPumpBought ?? prev.totalPumpBought) || 0,
  totalValue: Number(s.totalValue ?? prev.totalValue) || 0,
}));

        }
        if (lRes.ok) {
          const arr = (await lRes.json()) as LogEntry[];
          const cleansed = (Array.isArray(arr) ? arr : [])
            .filter(x => x && typeof x.msg === "string" && typeof x.time === "number")
            .filter(x => (Date.now() - x.time) < 600_000)
            .sort((a, b) => b.time - a.time)
            .slice(0, 200);
          setLogs(cleansed);
        }
      } catch (e) {
        setApiHealthy(false);
      }
    };

    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => { mounted.current = false; clearInterval(id); };
  }, []);

  const healthyBadge = useMemo(() => {
    if (apiHealthy === null) return (
      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-200">connecting…</span>
    );
    if (apiHealthy) return (
      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-600/40">live</span>
    );
    return (
      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-600/30">offline</span>
    );
  }, [apiHealthy]);

  const copyCA = async () => {
    try {
      await navigator.clipboard.writeText(MINT_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <div className="min-h-screen bg-[#111111] text-white flex flex-col items-center font-sans relative overflow-hidden">
      {/* Top Bar */}
      <div className="w-full flex justify-between items-center p-4 border-b border-[#242424] bg-[#0f0f0f] relative">
        <h1 className="text-lg font-bold text-[#9fff6f] tracking-wide">$PUMPDROP Dashboard {healthyBadge}</h1>
        <div className="flex flex-col items-center absolute left-1/2 transform -translate-x-1/2">
          <div className="flex items-center gap-2 mb-1 relative">
            <span className="font-mono text-[#9fff6f] text-sm">{MINT_CA}</span>
            <motion.button
              onClick={copyCA}
              whileTap={{ scale: 0.94 }}
              className="flex items-center gap-1 px-2 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85] text-sm relative overflow-hidden"
            >
              <Copy size={14} /> Copy
              <AnimatePresence>
                {copied && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8, y: -10 }}
                    animate={{ opacity: 1, scale: 1, y: -25 }}
                    exit={{ opacity: 0, scale: 0.8, y: -40 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className="absolute left-1/2 transform -translate-x-1/2 text-xs bg-[#9fff6f] text-black px-2 py-1 rounded-full shadow-md flex items-center gap-1"
                  >
                    <CheckCircle size={12} /> Copied!
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.button>
          </div>
        </div>
        <div className="flex gap-3 items-center">
          <button
            onClick={() => window.open(`https://pump.fun/coin/${MINT_CA}`, "_blank", "noopener,noreferrer")}
            className="px-3 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]"
          >
            BUY
          </button>
          <button
            onClick={() => window.open("https://x.com/i/communities/1985037307443904998", "_blank", "noopener,noreferrer")}
            className="px-3 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]"
          >
            X
          </button>
          <motion.button
            onClick={() => setShowInfo(!showInfo)}
            animate={{ rotate: [0, 10, -10, 0], scale: [1, 1.05, 1] }}
            transition={{ repeat: Infinity, repeatDelay: 1, duration: 1.5, ease: "easeInOut" }}
            className="px-3 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]"
          >
            How It Works
          </motion.button>
        </div>
      </div>

      <AnimatePresence>
        {showInfo && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.25 }}
            className="fixed top-24 right-6 w-[28rem] bg-[#121212] border border-[#242424] rounded-xl p-6 text-gray-200 shadow-2xl backdrop-blur-lg"
          >
            <h2 className="text-[#9fff6f] font-bold text-xl mb-2">How $PUMPDROP Works</h2>
            <p className="text-sm leading-relaxed text-gray-300">
              The bot claims creator rewards in SOL, swaps 70% into <span className="text-[#9fff6f]">$PUMP</span>,
              and airdrops proportionally to eligible holders of <span className="text-[#9fff6f]">$PUMPDROP</span>.
              Wallets below 200,000 $PUMPDROP and whales above 50,000,000 $PUMPDROP are excluded for fair distribution.
            </p>
            <ul className="list-disc list-inside mt-3 space-y-1 text-gray-400 text-sm">
              <li>Token CA: <span className="text-[#baff85] font-mono">{MINT_CA}</span></li>
              <li>Live metrics</li>
              <li>Activity feed mirrors the worker logs in near real time</li>
            </ul>
            <button onClick={() => setShowInfo(false)} className="mt-4 px-4 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]">
              Close
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 w-full max-w-5xl">
        {[
  { title: "Market Cap", value: `$${kFmt(stats.marketCap)}` },
  { title: "Volume (24h)", value: `$${kFmt(stats.volume)}` },
  { title: "Total $PUMP Acquired", value: kFmt(stats.totalPumpBought) },
  { title: "Value Distributed", value: `$${kFmt(stats.totalValue)}` },
]
.map((item, i) => (
          <div key={i} className="bg-[#181818] border border-[#242424] rounded-xl p-4 hover:border-[#9fff6f] transition">
            <div className="text-gray-400 text-sm">{item.title}</div>
            <div className="text-2xl font-bold text-[#9fff6f]">{item.value}</div>
          </div>
        ))}
      </div>

      {/* Activity */}
      <div className="w-full max-w-5xl bg-[#101010] border border-[#242424] rounded-xl p-4 mt-2">
        <h3 className="text-[#9fff6f] text-sm mb-3 font-semibold">Recent Activity</h3>
        <div className="max-h-64 overflow-y-auto space-y-2 custom-scrollbar pr-2">
          <AnimatePresence>
            {logs
              .map((log, i) => {
                const when = formatTimeAgo(log.time);
                if (!when) return null;
                return (
                  <motion.div
                    key={`${log.time}-${i}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.25 }}
                    className="bg-[#181818] p-2 rounded-lg text-sm border border-[#242424] flex justify-between items-center"
                  >
                    <div className="truncate mr-3">{log.msg}</div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">{when}</div>
                  </motion.div>
                );
              })}
          </AnimatePresence>
        </div>
      </div>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #151515; border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #9fff6f; border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #baff85; }
      `}</style>
    </div>
  );
}
