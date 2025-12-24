// netlify/functions/get-winners.js
// Robust + low-RPC-load payout detection for JackpotCoin
// Guarantees: if we have winners once, we NEVER return empty winners due to RPC hiccups.
// Adds: totalPaidSOLTracked + SOL/USD price => totalPaidUSDTracked

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";

const RPC_ENDPOINTS = [
  process.env.HELIUS_RPC_URL, // set in Netlify env
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

// Server-side cache (reduces RPC load)
const CACHE_MS = 12_000;

// Cheap call: signatures
const SIG_LIMIT = 1000;

// Expensive calls: getTransaction
const MAX_TX_FETCH = 500;

const MAX_WINNERS_HARD = 500;     // hard cap
const CONCURRENCY = 3;

// If new run finds 0 winners but we had winners recently, keep last list
const STALE_OK_MS = 10 * 60 * 1000;

let cache = { ts: 0, data: null };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithTimeout(url, opts, timeoutMs = 9000) {
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
      9000
    );

    if (json?.error) throw new Error(json.error.message || "RPC error");

    if (!ok) {
      if (status === 429 || status >= 500) {
        await sleep(450 + attempt * 800);
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
  // CoinGecko simple price (no key). Cache will shield rate limits.
  // If it fails, return null and UI can still show SOL total.
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      headers: { "accept": "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const p = j?.solana?.usd;
    return (typeof p === "number" && p > 0) ? p : null;
  } catch {
    return null;
  }
}

function buildResponse({
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
    payoutWallet: PAYOUT_WALLET,
    payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
    lastPayoutUTC,
    nextDrawUTC,
    cadenceSeconds,

    solUsd, // ✅ NEW
    totalPaidSOLTracked: (typeof totalPaidSOLTracked === "number")
      ? Number(totalPaidSOLTracked.toFixed(9))
      : null,
    totalPaidUSDTracked, // ✅ NEW
    trackedPayoutCount: trackedPayoutCount || 0, // ✅ NEW
    trackedOldestUTC: trackedOldestUTC || null,  // ✅ NEW

    winners: winners.slice(0, winnerLimit),
    stale: !!stale,
  };

  if (error) out.error = error;
  if (message) out.message = message;

  return out;
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

  try {
    // winner limit from query (ex: ?limit=200)
    const q = event.queryStringParameters || {};
    const winnerLimit = clampInt(q.limit, 1, MAX_WINNERS_HARD, 200);

    // short server cache to reduce RPC load
    if (cache.data && (now - cache.ts) < CACHE_MS) {
      // if cached, still respect requested limit
      const cached = { ...cache.data, winners: (cache.data.winners || []).slice(0, winnerLimit) };
      return { statusCode: 200, headers, body: JSON.stringify(cached) };
    }

    const [sigs, solUsd] = await Promise.all([
      rpc("getSignaturesForAddress", [PAYOUT_WALLET, { limit: SIG_LIMIT }]),
      getSolUsd(),
    ]);

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

    const winners = [];
    let totalPaidSOLTracked = 0;
    let trackedPayoutCount = 0;
    let trackedOldestUTC = null;

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

          if (source === PAYOUT_WALLET && destination && destination !== PAYOUT_WALLET) {
            const solAmount = lamports / 1e9;

            // allow tiny payouts too
            if (solAmount >= 0.0001 && solAmount <= 1000) {
              trackedPayoutCount += 1;
              totalPaidSOLTracked += solAmount;

              winners.push({
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

      // capture oldest payout timestamp we saw in this scan (approx window)
      if (whenUTC && (!trackedOldestUTC || Date.parse(whenUTC) < Date.parse(trackedOldestUTC))) { trackedOldestUTC = whenUTC;
}

      if (winners.length >= MAX_WINNERS_HARD) break;
    }

    winners.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));

    // after: winners.sort(...)

function mergeWinners(newOnes, oldOnes) {
  const m = new Map();
  for (const w of (oldOnes || [])) {
    if (w?.tx) m.set(w.tx, w);
  }
  for (const w of (newOnes || [])) {
    if (w?.tx) m.set(w.tx, w);
  }
  return Array.from(m.values()).sort(
    (a,b) => Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)
  );
}

// ✅ never lose winners due to partial RPC fetch
if (cache.data?.winners?.length) {
  const merged = mergeWinners(winners, cache.data.winners);
  winners.length = 0;
  winners.push(...merged);
}

    // derive cadence from payout gaps
    let cadenceSeconds = null;
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
    if (!cadenceSeconds) cadenceSeconds = 15 * 60;

    const hadGoodCache = cache.data?.winners?.length > 0;
    const cacheFreshEnough = (now - (cache.ts || 0)) < STALE_OK_MS;

    // ✅ never return empty winners if we already had winners recently
    if (winners.length === 0 && hadGoodCache && cacheFreshEnough) {
      const safe = buildResponse({
        winners: cache.data.winners,
        cadenceSeconds: cache.data.cadenceSeconds || cadenceSeconds,
        solUsd: cache.data.solUsd ?? solUsd ?? null,
        totalPaidSOLTracked: cache.data.totalPaidSOLTracked ?? null,
        trackedPayoutCount: cache.data.trackedPayoutCount ?? 0,
        trackedOldestUTC: cache.data.trackedOldestUTC ?? null,
        stale: true,
        error: "feed_unstable",
        message: "RPC indexing/rate-limit — serving last known winners",
        winnerLimit,
      });
      cache = { ts: now, data: safe };
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    const data = buildResponse({
      winners,
      cadenceSeconds,
      solUsd,
      totalPaidSOLTracked,
      trackedPayoutCount,
      trackedOldestUTC,
      winnerLimit,
    });

    cache = { ts: now, data };
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (e) {
    // ✅ if error, serve last known winners (stable UI)
    const msg = String(e?.message || e);

    if (cache.data?.winners?.length) {
      const safe = {
        ...cache.data,
        updatedUTC: new Date().toISOString(),
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
