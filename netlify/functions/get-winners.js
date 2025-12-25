// netlify/functions/get-winners.js
// Robust + low-RPC-load payout detection for JackpotCoin
// ✅ Persistent state via Netlify Blobs (no reset/jumps across refresh/visitors)
// ✅ Wallet transition mode: show legacy payouts until new wallet has a first payout
// ✅ Dedupe + merge across runs + totals never decrease
// ✅ Reduced RPC load + safer legacy fallback + fewer "feed_unstable" false alarms

const { getStore } = require("@netlify/blobs");

const PAYOUT_WALLET = "5Y8ty4BuoqVUmfZcLiNkpCPpZmt5Hf653REvJz2BRUrK"; // CTO wallet (active)

// OPTIONAL: set this to the OLD wallet to run legacy transition mode.
// If active wallet has 0 payouts detected, we will show legacy payouts until active starts paying.
const LEGACY_PAYOUT_WALLET =
  process.env.LEGACY_PAYOUT_WALLET || "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";

const RPC_ENDPOINTS = [
  process.env.HELIUS_RPC_URL, // set in Netlify env
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

// Server-side in-memory cache (reduces RPC load per warm instance)
const CACHE_MS = 12_000;

// Cheap call: signatures (reduced)
const SIG_LIMIT = 400; // was 1000

// Expensive calls: getTransaction (reduced)
const MAX_TX_FETCH = 200; // was 500

const MAX_WINNERS_HARD = 500; // hard cap
const CONCURRENCY = 3;

// If new run finds 0 winners but we had winners recently, keep last list
const STALE_OK_MS = 10 * 60 * 1000;

// In-memory cache (still useful, but not relied on)
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

async function rpcTry(endpoint, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  for (let attempt = 0; attempt < 2; attempt++) {
    const { ok, status, json } = await fetchJsonWithTimeout(
      endpoint,
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
  let lastErr = null;
  for (const ep of RPC_ENDPOINTS) {
    try {
      return await rpcTry(ep, method, params);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All RPC endpoints failed");
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

/** Deduplicate by tx signature */
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

/** Merge new scan with prior winners */
function mergeWinners(newOnes, oldOnes) {
  const combined = dedupeByTx([...(oldOnes || []), ...(newOnes || [])]);
  combined.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));
  return combined.slice(0, MAX_WINNERS_HARD);
}

/** Compute totals from a list of winners */
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

function buildResponse({
  payoutWallet,
  payoutWalletUrl,
  winners,
  cadenceSeconds,
  solUsd,
  totalPaidSOLTracked,
  trackedPayoutCount,
  trackedOldestUTC,
  stale = false,
  error = null,
  message = null,
  winnerLimit = 20,
  mode = "active", // "active" | "legacy"
  legacyWallet = null,
}) {
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
    payoutWallet,
    payoutWalletUrl,
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

    mode,
    legacyWallet,
  };

  if (error) out.error = error;
  if (message) out.message = message;

  return out;
}

async function scanWalletForWinners(wallet) {
  const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: SIG_LIMIT }]);

  const signatures = (sigs || [])
    .filter(s => s && !s.err && s.signature)
    .map(s => s.signature);

  const toFetch = signatures.slice(0, MAX_TX_FETCH);

  const txs = await mapLimit(toFetch, CONCURRENCY, async (sig) => {
    const tx = await rpc("getTransaction", [
      sig,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
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

  // Persistent store (shared across all visitors + cold starts)
  const store = getStore("jackpot");
  const stateKey = `state_v1_${PAYOUT_WALLET}`;

  try {
    const q = event.queryStringParameters || {};
    const winnerLimit = clampInt(q.limit, 1, MAX_WINNERS_HARD, 200);

    // In-memory cache (fast path)
    if (cache.data && (now - cache.ts) < CACHE_MS) {
      const cached = { ...cache.data, winners: (cache.data.winners || []).slice(0, winnerLimit) };
      return { statusCode: 200, headers, body: JSON.stringify(cached) };
    }

    // Pull persisted ACTIVE state
    const persisted = (await store.get(stateKey, { type: "json" }).catch(() => null)) || null;

    const [solUsd, activeScan] = await Promise.all([
      getSolUsd(),
      scanWalletForWinners(PAYOUT_WALLET),
    ]);

    // Merge with persisted winners so we never lose history
    const mergedActive = persisted?.winners?.length
      ? mergeWinners(activeScan, persisted.winners)
      : activeScan;

    // Compute totals from merged list
    let totals = computeTotals(mergedActive);

    // Clamp totals so they never decrease (across cold starts too)
    if (typeof persisted?.totalPaidSOLTracked === "number") {
      totals.sol = Math.max(totals.sol, persisted.totalPaidSOLTracked);
    }
    if (typeof persisted?.trackedPayoutCount === "number") {
      totals.count = Math.max(totals.count, persisted.trackedPayoutCount);
    }
    if (!totals.oldestUTC && persisted?.trackedOldestUTC) {
      totals.oldestUTC = persisted.trackedOldestUTC;
    }

    // Cadence based on merged list (stable)
    let cadenceSeconds = null;
    if (mergedActive.length >= 3) {
      const times = mergedActive
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
    if (!cadenceSeconds) cadenceSeconds = 15 * 60;

    // WALLET TRANSITION MODE:
    // If new wallet has 0 payouts detected, show legacy payouts until new wallet starts paying.
    let mode = "active";
    let winnersToShow = mergedActive;
    let payoutWalletToShow = PAYOUT_WALLET;
    let payoutWalletUrlToShow = `https://solscan.io/account/${PAYOUT_WALLET}`;
    let legacyWallet = null;

    if ((mergedActive.length === 0) && LEGACY_PAYOUT_WALLET && LEGACY_PAYOUT_WALLET !== PAYOUT_WALLET) {
      mode = "legacy";
      legacyWallet = LEGACY_PAYOUT_WALLET;

      const legacyStateKey = `state_v1_${LEGACY_PAYOUT_WALLET}`;
      const legacyPersisted = (await store.get(legacyStateKey, { type: "json" }).catch(() => null)) || null;

      // ✅ Legacy scan MUST NOT crash response
      let legacyScan = [];
      try {
        legacyScan = await scanWalletForWinners(LEGACY_PAYOUT_WALLET);
      } catch {
        legacyScan = [];
      }

      const mergedLegacy = legacyPersisted?.winners?.length
        ? mergeWinners(legacyScan, legacyPersisted.winners)
        : legacyScan;

      winnersToShow = mergedLegacy;
      payoutWalletToShow = LEGACY_PAYOUT_WALLET;
      payoutWalletUrlToShow = `https://solscan.io/account/${LEGACY_PAYOUT_WALLET}`;

      // Persist legacy too (so it’s stable across refreshes)
      const legacyTotals = computeTotals(mergedLegacy);
      const legacyData = buildResponse({
        payoutWallet: LEGACY_PAYOUT_WALLET,
        payoutWalletUrl: payoutWalletUrlToShow,
        winners: mergedLegacy,
        cadenceSeconds: 15 * 60,
        solUsd,
        totalPaidSOLTracked: legacyTotals.sol,
        trackedPayoutCount: legacyTotals.count,
        trackedOldestUTC: legacyTotals.oldestUTC,
        winnerLimit: MAX_WINNERS_HARD,
        mode: "legacy",
        legacyWallet: null,
      });
      await store.set(legacyStateKey, legacyData, { type: "json" }).catch(() => {});
    }

    // Build final response (what UI sees)
    const data = buildResponse({
      payoutWallet: payoutWalletToShow,
      payoutWalletUrl: payoutWalletUrlToShow,
      winners: winnersToShow,
      cadenceSeconds,
      solUsd,
      totalPaidSOLTracked: totals.sol,
      trackedPayoutCount: totals.count,
      trackedOldestUTC: totals.oldestUTC,
      winnerLimit,
      mode,
      legacyWallet,
    });

    // Persist ACTIVE state (so every visitor sees stable output)
    const persistActive = buildResponse({
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      winners: mergedActive,
      cadenceSeconds,
      solUsd,
      totalPaidSOLTracked: totals.sol,
      trackedPayoutCount: totals.count,
      trackedOldestUTC: totals.oldestUTC,
      winnerLimit: MAX_WINNERS_HARD,
      mode: "active",
      legacyWallet: null,
    });

    await store.set(stateKey, persistActive, { type: "json" }).catch(() => {});

    // Update in-memory cache too
    cache = { ts: now, data };

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (e) {
    const msg = String(e?.message || e);

    // Serve persisted state if available (and don't panic the UI)
    try {
      const persisted = await store.get(stateKey, { type: "json" });
      if (persisted?.winners?.length) {
        const safe = {
          ...persisted,
          updatedUTC: new Date().toISOString(),
          stale: true,
          // If you WANT to show warnings, set these back:
          // error: "feed_unstable",
          // message: msg,
          error: null,
          message: null,
        };
        cache = { ts: now, data: safe };
        return { statusCode: 200, headers, body: JSON.stringify(safe) };
      }
    } catch {}

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
      mode: "active",
      legacyWallet: null,
    };

    cache = { ts: now, data: empty };
    return { statusCode: 200, headers, body: JSON.stringify(empty) };
  }
};
