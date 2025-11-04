import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, CheckCircle } from "lucide-react";

function resolveApiBase(): string {
  const fromWindow =
    (typeof window !== "undefined" &&
      (window as any).__ENV__?.NEXT_PUBLIC_WORKER_API_BASE) ||
    (typeof window !== "undefined" && (window as any).__WORKER_API_BASE);
  const fromImportMeta =
    typeof import.meta !== "undefined" && (import.meta as any).env
      ? (import.meta as any).env.NEXT_PUBLIC_WORKER_API_BASE ||
        (import.meta as any).env.VITE_WORKER_API_BASE
      : undefined;
  const fromProcess =
    typeof process !== "undefined" && (process as any).env
      ? (process as any).env.NEXT_PUBLIC_WORKER_API_BASE ||
        (process as any).env.WORKER_API_BASE
      : undefined;
  const fallback =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:4000";
  const base = fromWindow || fromImportMeta || fromProcess || fallback;
  return String(base).replace(/\/$/, "");
}

const API_BASE = resolveApiBase();
const MINT_CA = "8rsZxFLwy8oxV5Tea2zbekNeZR4iitoNR44mV4nDKHx1";

export function formatTimeAgo(ts: number): string | null {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds >= 600) return null;
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}min ago`;
}

function kFmt(n: number) {
  if (!isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000_000)
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

interface LogEntry {
  msg: string;
  time: number;
}
interface StatsResponse {
  marketCap: number;
  volume: number;
  totalPumpBought: number;
  totalValue: number;
}
interface Holder {
  rank: number;
  wallet: string;
  amount: number;
}

export default function PumpdropDashboard() {
  const [stats, setStats] = useState<StatsResponse>({
    marketCap: 0,
    volume: 0,
    totalPumpBought: 0,
    totalValue: 0,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [copied, setCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const mounted = useRef(false);

  // ✅ NEW states for search and highlight
  const [search, setSearch] = useState<string>("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const hasScrolled = useRef(false); // prevent repeated scrolls

  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("pumpdrop_search");
      if (saved) setSearch(saved);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const fetchAll = async () => {
      try {
        const [sRes, lRes, hRes] = await Promise.all([
          fetch(`${API_BASE}/api/stats?t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/logs?t=${Date.now()}`, { cache: "no-store" }),
          fetch(`${API_BASE}/api/holders?t=${Date.now()}`, { cache: "no-store" }),
        ]);
        setApiHealthy(sRes.ok && lRes.ok && hRes.ok);

        if (sRes.ok) {
          const s = (await sRes.json()) as Partial<StatsResponse>;
          setStats((prev) => ({
            marketCap: Number(s.marketCap ?? prev.marketCap) || 0,
            volume: Number(s.volume ?? prev.volume) || 0,
            totalPumpBought: Number(s.totalPumpBought ?? prev.totalPumpBought) || 0,
            totalValue: Number(s.totalValue ?? prev.totalValue) || 0,
          }));
        }

        if (lRes.ok) {
          const arr = (await lRes.json()) as LogEntry[];
          const workerKeywords = ["[CLAIM]", "[SWAP]", "[AIRDROP]"];
          const ignoredPatterns = [
            "[UPDATE]",
            "[ERROR]",
            "[BIRDEYE]",
            "[DEXSCREENER]",
            "[HELIUS RPC ERROR]",
            "🚀 Server started",
            "Pumpdrop metrics server running",
            "[BUY]",
          ];
          const cleansed = (Array.isArray(arr) ? arr : [])
            .filter((x) => x && typeof x.msg === "string" && typeof x.time === "number")
            .filter((x) => workerKeywords.some((k) => x.msg.includes(k)))
            .filter((x) => !ignoredPatterns.some((k) => x.msg.includes(k)))
            .filter((x) => Date.now() - x.time < 600_000)
            .sort((a, b) => b.time - a.time)
            .slice(0, 200);
          setLogs(cleansed);
        }

        if (hRes.ok) {
          const json = await hRes.json();
          const list = Array.isArray(json?.holders)
            ? json.holders
            : Array.isArray(json)
            ? json
            : [];
          setHolders(list);
        }
      } catch {
        setApiHealthy(false);
      }
    };

    fetchAll();
    const id = setInterval(fetchAll, 10000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  const healthyBadge = useMemo(() => {
    if (apiHealthy === null)
      return (
        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-200">
          connecting…
        </span>
      );
    if (apiHealthy)
      return (
        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-600/40">
          live
        </span>
      );
    return (
      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-600/30">
        offline
      </span>
    );
  }, [apiHealthy]);

  const copyCA = async () => {
    try {
      await navigator.clipboard.writeText(MINT_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  // ✅ Filtered holders with range + highlight + search
  const filteredHolders = useMemo(() => {
    const min = 200_000;
    const max = 50_000_000;
    let visible = holders.filter((h) => h.amount >= min && h.amount <= max);

   if (search.trim()) {
  const query = search.trim().toLowerCase();
  localStorage.setItem("pumpdrop_search", search);
  const found = holders.find((h) => h.wallet.toLowerCase() === query);
  if (found) {
    setHighlighted(found.wallet);
    hasScrolled.current = false;
    visible = [found];
  } else {
    visible = visible.filter((h) => h.wallet.toLowerCase().includes(query));
  }
} else {
  // ✅ clear saved search when input is empty
  localStorage.removeItem("pumpdrop_search");
  setHighlighted(null);
  hasScrolled.current = true;
}


    return visible;
  }, [holders, search]);

  return (
    <div className="min-h-screen h-screen bg-[#111111] text-white flex flex-col font-sans overflow-hidden">
      {/* ✅ ORIGINAL TOP BAR */}
      <div className="w-full flex justify-between items-center p-4 border-b border-[#242424] bg-[#0f0f0f] relative">
        <h1 className="text-lg font-bold text-[#9fff6f] tracking-wide">
          $PUMPDROP Dashboard {healthyBadge}
        </h1>
        <div className="flex flex-col items-center absolute left-1/2 transform -translate-x-1/2">
          <div className="flex items-center gap-2 mb-1 relative">
            <span className="font-mono text-[#9fff6f] text-sm">{MINT_CA}</span>
            <motion.button
              onClick={copyCA}
              whileTap={{ scale: 0.94 }}
              className="flex items-center gap-1 px-2 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85] text-sm relative overflow-hidden"
            >
              <Copy size={14} /> Copy
            </motion.button>
            <AnimatePresence>
  {showInfo && (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => setShowInfo(false)}
      ></div>

      {/* modal */}
      <motion.div
        key="howItWorksModal"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.25 }}
        className="fixed top-24 right-6 w-[28rem] bg-[#121212] border border-[#242424] rounded-xl p-6 text-gray-200 shadow-2xl backdrop-blur-lg z-50"
        onClick={(e) => e.stopPropagation()} // prevent backdrop from closing
      >
        <h2 className="text-[#9fff6f] font-bold text-xl mb-2">
          How $PUMPDROP Works
        </h2>
        <p className="text-sm leading-relaxed text-gray-300">
          The bot claims creator rewards in SOL, swaps 70% into{" "}
          <span className="text-[#9fff6f]">$PUMP</span>, and airdrops
          proportionally to eligible holders of{" "}
          <span className="text-[#9fff6f]">$PUMPDROP</span>. Wallets below
          200,000 $PUMPDROP and whales above 50,000,000 $PUMPDROP are excluded
          for fair distribution.
        </p>
        <ul className="list-disc list-inside mt-3 space-y-1 text-gray-400 text-sm">
          <li>
            Token CA:{" "}
            <span className="text-[#baff85] font-mono">{MINT_CA}</span>
          </li>
          <li>Live metrics auto-updated</li>
          <li>Activity feed mirrors worker logs in near real time</li>
        </ul>
        <button
          type="button"
          onClick={() => setShowInfo(false)}
          className="mt-4 px-4 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]"
        >
          Close
        </button>
      </motion.div>
    </>
  )}
</AnimatePresence>
          </div>
        </div>
        <div className="flex gap-3 items-center">
          <button
            onClick={() =>
              window.open(`https://pump.fun/coin/${MINT_CA}`, "_blank", "noopener,noreferrer")
            }
            className="px-3 py-1 bg-[#9fff6f] text-black font-bold rounded hover:bg-[#baff85]"
          >
            BUY
          </button>
          <button
            onClick={() =>
              window.open(
                "https://x.com/i/communities/1985037307443904998",
                "_blank",
                "noopener,noreferrer"
              )
            }
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

      <div className="flex-1 flex flex-col justify-between items-center px-4 py-4 gap-3 max-w-5xl w-full mx-auto overflow-hidden">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full shrink-0">
          {[
            { title: "Market Cap", value: `$${kFmt(stats.marketCap)}` },
            { title: "Volume (24h)", value: `$${kFmt(stats.volume)}` },
            { title: "Total $PUMP Acquired", value: kFmt(stats.totalPumpBought) },
            { title: "Value Distributed", value: `$${kFmt(stats.totalValue)}` },
          ].map((item, i) => (
            <div
              key={i}
              className="bg-[#181818] border border-[#242424] rounded-xl p-4 hover:border-[#9fff6f] transition"
            >
              <div className="text-gray-400 text-sm">{item.title}</div>
              <div className="text-2xl font-bold text-[#9fff6f]">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 w-full overflow-hidden">
          {/* Activity */}
          <div className="bg-[#101010] border border-[#242424] rounded-xl p-4 flex flex-col h-full overflow-hidden">
            <h3 className="text-[#9fff6f] text-sm mb-3 font-semibold shrink-0">Recent Activity</h3>
            <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pr-2">
              {logs.map((log, i) => {
                const when = formatTimeAgo(log.time);
                if (!when) return null;
                return (
                  <div
                    key={`${log.time}-${i}`}
                    className="bg-[#181818] p-2 rounded-lg text-sm border border-[#242424] flex justify-between items-center"
                  >
                    <div className="truncate mr-3">{log.msg}</div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">{when}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Holders */}
          <div className="bg-[#101010] border border-[#242424] rounded-xl p-4 flex flex-col h-full overflow-hidden">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-[#9fff6f] text-sm font-semibold">
                Top Holders (200k–50M $PUMPDROP)
              </h3>
              <input
                type="text"
                placeholder="Search wallet..."
                value={search}
                onChange={(e) => setSearch(e.target.value.trim())}
                className="bg-[#181818] text-sm text-white border border-[#242424] rounded-lg px-2 py-1 w-48 focus:outline-none focus:border-[#9fff6f]"
              />
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-[#242424]">
                    <th className="text-left py-1">#</th>
                    <th className="text-left py-1">Wallet</th>
                    <th className="text-right py-1">Holdings</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHolders.length > 0 ? (
                    filteredHolders.map((h) => (
                      <tr
                        key={h.wallet}
                        className={`border-b border-[#1b1b1b] ${
                          h.wallet.toLowerCase() === highlighted?.toLowerCase()
                            ? "bg-[#1a1a1a]"
                            : ""
                        }`}
                        ref={(el) => {
                          if (
                            h.wallet.toLowerCase() === highlighted?.toLowerCase() &&
                            el &&
                            !hasScrolled.current
                          ) {
                            el.scrollIntoView({ behavior: "smooth", block: "center" });
                            hasScrolled.current = true;
                          }
                        }}
                      >
                        <td className="py-1">{h.rank}</td>
                        <td className="truncate font-mono text-[#baff85]">
                          {h.wallet.slice(0, 4)}...{h.wallet.slice(-4)}
                        </td>
                        <td className="text-right">
                          {Number(h.amount).toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="text-center text-gray-500 py-3">
                        No holder data
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <footer className="w-full text-center py-3 text-xs text-gray-500 border-t border-[#242424] mt-auto">
        $PUMPDROP – Built by <span className="text-[#9fff6f]">@tekdevsol</span>
      </footer>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #151515;
          border-radius: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #9fff6f;
          border-radius: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #baff85;
        }
      `}</style>
    </div>
  );
}

