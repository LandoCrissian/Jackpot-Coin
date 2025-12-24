// netlify/functions/get-winners.js
// JackpotCoin winners feed (Helius-first) with stable caching + merge protection.
// Goals:
// 1) Always return a stable winners list (never blank due to RPC hiccups)
// 2) Return many payouts (default 100; supports ?limit=)
// 3) Keep RPC load controlled (cap expensive getTransaction calls)

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";

const RPC_ENDPOINTS = [
  process.env.HELIUS_RPC_URL,               // set this in Netlify env vars
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

// Server cache (reduces RPC load)
const CACHE_MS = 12_000;

// Cheap call: signatures list
const SIG_LIMIT_BASE = 220;  // baseline scan window
const SIG_LIMIT_MAX  = 1200; // don’t go crazy on free tier

// Expensive calls: getTransaction
const MAX_TX_FETCH_BASE = 90;
const MAX_TX_FETCH_MAX  = 420; // cap expensive calls

const CONCURRENCY = 4;

// If new run finds 0 winners but we had winners recently, keep last list
const STALE_OK_MS = 10 * 60 * 1000;

// Winners defaults/caps
const DEFAULT_LIMIT = 100;  // what your UI should use for “all recent”
const LIMIT_CAP     = 500;  // safety cap so responses don’t get huge

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

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(x)));
}

function parseLimit(event) {
  const raw = event?.queryStringParameters?.limit;
  return clampInt(raw, 5, LIMIT_CAP, DEFAULT_LIMIT);
}

function normalizeWinner(w) {
  return {
    wallet: (w.wallet || "").trim(),
    amountSOL: typeof w.amountSOL === "number" ? w.amountSOL : Number(w.amountSOL),
    whenUTC: w.whenUTC || null,
    tx: (w.tx || "").trim(),
    solscanUrl: w.solscanUrl || (w.tx ? `https://solscan.io/tx/${w.tx}` : null),
  };
}

// Merge winners so list stays stable even if a future scan is incomplete.
// Keyed by tx + wallet + amount (amount is optional but helps uniqueness if multiple transfers in one tx).
function mergeWinners(newOnes, oldOnes, limit) {
  const merged = [];
  const seen = new Set();

  function keyOf(w) {
    const tx = w.tx || "";
    const wallet = w.wallet || "";
    const amt = (typeof w.amountSOL === "number") ? w.amountSOL.toFixed(9) : "";
    return `${tx}|${wallet}|${amt}`;
  }

  // New first
  for (const w of newOnes) {
    const ww = normalizeWinner(w);
    if (!ww.tx || !ww.wallet) continue;
    const k = keyOf(ww);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ww);
  }

  // Then keep old (so you never “lose” history due to scan window)
  for (const w of oldOnes) {
    const ww = normalizeWinner(w);
    if (!ww.tx || !ww.wallet) continue;
    const k = keyOf(ww);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ww);
  }

  // Sort newest first by whenUTC; if missing, keep relative order
  merged.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));

  return merged.slice(0, limit);
}

function buildResponse({ winners, cadenceSeconds, stale = false, error = null, message = null, limit }) {
  const lastPayoutUTC = winners[0]?.whenUTC || null;

  const nextDrawUTC = lastPayoutUTC
    ? new Date(Date.parse(lastPayoutUTC) + cadenceSeconds * 1000).toISOString()
    : null;

  const out = {
    updatedUTC: new Date().toISOString(),
    payoutWallet: PAYOUT_WALLET,
    payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
    lastPayoutUTC,
    nextDrawUTC,
    cadenceSeconds,
    limit,
    winners,
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
  const limit = parseLimit(event);

  try {
    // Short server cache to reduce RPC load
    if (cache.data && (now - cache.ts) < CACHE_MS) {
      // If caller asked for a bigger limit than cached payload, we’ll try to refresh below instead.
      if ((cache.data.limit || DEFAULT_LIMIT) >= limit) {
        return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
      }
    }

    // Scale scan window slightly with limit
    const SIG_LIMIT = Math.min(SIG_LIMIT_MAX, Math.max(SIG_LIMIT_BASE, Math.ceil(limit * 3)));
    const MAX_TX_FETCH = Math.min(MAX_TX_FETCH_MAX, Math.max(MAX_TX_FETCH_BASE, Math.ceil(limit * 2)));

    const sigs = await rpc("getSignaturesForAddress", [
      PAYOUT_WALLET,
      { limit: SIG_LIMIT },
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

    const found = [];

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
              found.push({
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

      // Stop early if we already have enough winners for requested limit
      if (found.length >= limit) break;
    }

    // Sort newest-first
    found.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));

    // Merge with cache (prevents shrinking/disappearing lists)
    const cachedWinners = Array.isArray(cache.data?.winners) ? cache.data.winners : [];
    const winners = mergeWinners(found, cachedWinners, limit);

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

    const hadGoodCache = cachedWinners.length > 0;
    const cacheFreshEnough = (now - (cache.ts || 0)) < STALE_OK_MS;

    // ✅ If scan found nothing but we have cache, keep cache
    if (found.length === 0 && hadGoodCache && cacheFreshEnough) {
      const safe = buildResponse({
        winners: cachedWinners.slice(0, limit),
        cadenceSeconds: cache.data?.cadenceSeconds || cadenceSeconds,
        stale: true,
        error: "feed_unstable",
        message: "RPC indexing/rate-limit — serving last known winners",
        limit,
      });
      cache = { ts: now, data: safe };
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    const data = buildResponse({ winners, cadenceSeconds, limit });
    cache = { ts: now, data };

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    // ✅ if error, serve last known winners (stable UI)
    if (cache.data?.winners?.length) {
      const safe = buildResponse({
        winners: cache.data.winners.slice(0, limit),
        cadenceSeconds: cache.data.cadenceSeconds || (15 * 60),
        stale: true,
        error: "feed_unstable",
        message: String(e?.message || e),
        limit,
      });
      cache = { ts: now, data: safe };
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    const empty = buildResponse({
      winners: [],
      cadenceSeconds: 15 * 60,
      stale: true,
      error: "feed_unavailable",
      message: String(e?.message || e),
      limit,
    });
    cache = { ts: now, data: empty };
    return { statusCode: 200, headers, body: JSON.stringify(empty) };
  }
};
