// netlify/functions/get-winners.js
// CTO wallet ONLY • Helius RPC ONLY • NO Netlify Blobs • NO legacy mode
// ✅ uses commitment:"confirmed" to catch recent payouts faster
// ✅ retries getTransaction when RPC is indexing
// ✅ no persistent state (clean + simple)
// ✅ optional ?reset=1 bypasses in-memory cache

const PAYOUT_WALLET = "5Y8ty4BuoqVUmfZcLiNkpCPpZmt5Hf653REvJz2BRUrK"; // CTO wallet

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL; // must be set in Netlify env

// Server warm-cache only (optional)
const CACHE_MS = 12_000;

// Cheap call: signatures
const SIG_LIMIT = 800;

// Expensive calls: getTransaction
const MAX_TX_FETCH = 250;

const MAX_WINNERS_HARD = 500;
const CONCURRENCY = 3;

let cache = { ts: 0, data: null };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithTimeout(url, opts, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function rpcTry(method, params) {
  if (!HELIUS_RPC_URL) throw new Error("Missing HELIUS_RPC_URL env var");

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  for (let attempt = 0; attempt < 2; attempt++) {
    const { ok, status, json } = await fetchJsonWithTimeout(
      HELIUS_RPC_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      12000
    );

    if (json?.error) throw new Error(json.error.message || "RPC error");

    if (!ok) {
      if (status === 429 || status >= 500) {
        await sleep(900 + attempt * 1200);
        continue;
      }
      throw new Error(`RPC HTTP ${status}`);
    }

    return json.result;
  }

  throw new Error("RPC rate-limited");
}

async function rpc(method, params) {
  return rpcTry(method, params);
}

function isoFromBlockTime(bt) {
  return bt ? new Date(bt * 1000).toISOString() : null;
}

function extractTransfers(tx) {
  const out = [];
  const msgIxs = tx?.transaction?.message?.instructions || [];
  for (const ix of msgIxs) out.push(ix);

  const inner = tx?.meta?.innerInstructions || [];
  for (const group of inner) {
    for (const ix of (group.instructions || [])) out.push(ix);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch {
        results[idx] = null;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function clampInt(n, lo, hi, fallback) {
  const x = Number.parseInt(n, 10);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

async function getSolUsd() {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { headers: { accept: "application/json" } }
    );
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const p = j?.solana?.usd;
    return (typeof p === "number" && p > 0) ? p : null;
  } catch {
    return null;
  }
}

function dedupeByTx(winners) {
  const m = new Map();
  for (const w of (winners || [])) {
    if (!w?.tx) continue;
    const prev = m.get(w.tx);
    if (!prev) { m.set(w.tx, w); continue; }
    const a = Date.parse(prev.whenUTC || 0);
    const b = Date.parse(w.whenUTC || 0);
    if (b > a) m.set(w.tx, w);
  }
  return Array.from(m.values());
}

function computeTotals(winners) {
  let sol = 0;
  let count = 0;
  let oldestUTC = null;

  for (const w of (winners || [])) {
    const amt = Number(w?.amountSOL);
    if (Number.isFinite(amt) && amt > 0) {
      sol += amt;
      count += 1;
      const t = w.whenUTC ? Date.parse(w.whenUTC) : NaN;
      if (Number.isFinite(t)) {
        if (!oldestUTC || t < Date.parse(oldestUTC)) oldestUTC = w.whenUTC;
      }
    }
  }
  return { sol, count, oldestUTC };
}

function buildResponse({ winners, cadenceSeconds, solUsd, totalPaidSOLTracked, trackedPayoutCount, trackedOldestUTC, stale=false, error=null, message=null, winnerLimit=200 }) {
  const lastPayoutUTC = winners[0]?.whenUTC || null;

  const nextDrawUTC = lastPayoutUTC
    ? new Date(Date.parse(lastPayoutUTC) + cadenceSeconds * 1000).toISOString()
    : null;

  const totalPaidUSDTracked =
    (typeof solUsd === "number" && typeof totalPaidSOLTracked === "number")
      ? Number((totalPaidSOLTracked * solUsd).toFixed(2))
      : null;

  const out = {
    updatedUTC: new Date().toISOString(),
    payoutWallet: PAYOUT_WALLET,
    payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
    lastPayoutUTC,
    nextDrawUTC,
    cadenceSeconds,

    solUsd,
    totalPaidSOLTracked: (typeof totalPaidSOLTracked === "number")
      ? Number(totalPaidSOLTracked.toFixed(9))
      : null,
    totalPaidUSDTracked,
    trackedPayoutCount: trackedPayoutCount || 0,
    trackedOldestUTC: trackedOldestUTC || null,

    winners: (winners || []).slice(0, winnerLimit),
    stale: !!stale,
  };

  if (error) out.error = error;
  if (message) out.message = message;
  return out;
}

// Fetch transaction with retries (helps with "recent payout not captured yet")
async function getTxWithRetry(sig) {
  // 1) confirmed first (fresh)
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await rpc("getTransaction", [
      sig,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]).catch(() => null);

    if (tx) return tx;
    await sleep(350 + attempt * 450);
  }

  // 2) fallback finalized
  const txFinal = await rpc("getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" },
  ]).catch(() => null);

  return txFinal;
}

async function scanWalletForWinners(wallet) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: SIG_LIMIT }]);

  const signatures = (sigs || [])
    .filter(s => s && !s.err && s.signature)
    .map(s => s.signature);

  const toFetch = signatures.slice(0, MAX_TX_FETCH);

  const txs = await mapLimit(toFetch, CONCURRENCY, async (sig) => {
    const tx = await getTxWithRetry(sig);
    return { sig, tx };
  });

  const scanned = [];

  for (const item of txs) {
    if (!item?.tx || item.tx?.meta?.err) continue;

    const whenUTC = isoFromBlockTime(item.tx.blockTime) || null;
    const allIxs = extractTransfers(item.tx);

    for (const ix of allIxs) {
      if (ix?.program === "system" && ix?.parsed?.type === "transfer") {
        const info = ix.parsed.info || {};
        const source = info.source;
        const destination = info.destination;
        const lamports = info.lamports;

        if (source === wallet && destination && destination !== wallet) {
          const solAmount = lamports / 1e9;
          if (solAmount >= 0.0001 && solAmount <= 1000) {
            scanned.push({
              wallet: destination,
              amountSOL: Number(solAmount.toFixed(9)),
              whenUTC,
              tx: item.sig,
              solscanUrl: `https://solscan.io/tx/${item.sig}`,
            });
          }
        }
      }
    }

    if (scanned.length >= MAX_WINNERS_HARD) break;
  }

  scanned.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));
  const deduped = dedupeByTx(scanned).slice(0, MAX_WINNERS_HARD);
  deduped.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));
  return deduped;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const now = Date.now();
  const q = event.queryStringParameters || {};
  const winnerLimit = clampInt(q.limit, 1, MAX_WINNERS_HARD, 200);
  const reset = String(q.reset || "") === "1";

  try {
    // warm-cache fast path (unless reset)
    if (!reset && cache.data && (now - cache.ts) < CACHE_MS) {
      const cached = { ...cache.data, winners: (cache.data.winners || []).slice(0, winnerLimit) };
      return { statusCode: 200, headers, body: JSON.stringify(cached) };
    }

    const [solUsd, winners] = await Promise.all([
      getSolUsd(),
      scanWalletForWinners(PAYOUT_WALLET),
    ]);

    // cadence from observed gaps (fallback 15m)
    let cadenceSeconds = 15 * 60;
    if (winners.length >= 3) {
      const times = winners
        .map(w => Date.parse(w.whenUTC))
        .filter(Number.isFinite)
        .sort((a, b) => b - a);

      const gaps = [];
      for (let i = 0; i < Math.min(times.length - 1, 12); i++) {
        const gapSec = Math.round((times[i] - times[i + 1]) / 1000);
        if (gapSec >= 120 && gapSec <= 3600) gaps.push(gapSec);
      }
      const med = median(gaps);
      if (med) cadenceSeconds = Math.round(med);
    }

    const totals = computeTotals(winners);

    const data = buildResponse({
      winners,
      cadenceSeconds,
      solUsd,
      totalPaidSOLTracked: totals.sol,
      trackedPayoutCount: totals.count,
      trackedOldestUTC: totals.oldestUTC,
      winnerLimit,
      stale: false,
      error: null,
      message: null,
    });

    cache = { ts: now, data };

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (e) {
    const msg = String(e?.message || e);

    // if we have cache, serve it as stale instead of empty
    if (cache?.data?.winners?.length) {
      const safe = {
        ...cache.data,
        updatedUTC: new Date().toISOString(),
        winners: cache.data.winners.slice(0, winnerLimit),
        stale: true,
        error: "feed_unstable",
        message: msg,
      };
      cache = { ts: now, data: safe };
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    const empty = {
      updatedUTC: new Date().toISOString(),
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      lastPayoutUTC: null,
      nextDrawUTC: null,
      cadenceSeconds: 15 * 60,
      solUsd: null,
      totalPaidSOLTracked: null,
      totalPaidUSDTracked: null,
      trackedPayoutCount: 0,
      trackedOldestUTC: null,
      winners: [],
      stale: true,
      error: "feed_unavailable",
      message: msg,
    };

    cache = { ts: now, data: empty };
    return { statusCode: 200, headers, body: JSON.stringify(empty) };
  }
};
