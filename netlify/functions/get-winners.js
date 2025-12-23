// netlify/functions/get-winners.js
// Robust + low-RPC-load payout detection for JackpotCoin
// FIX: never replace a good cached winner list with empty winners due to RPC hiccups
// FIX: scan enough signatures to actually find payouts (without exploding RPC calls)

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";

const RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana.public-rpc.com",
];

const CACHE_MS = 8_000;

// We can safely pull more signatures (cheap)...
const SIG_LIMIT = 140;

// ...but hard-cap getTransaction calls (expensive) to avoid 429s.
const MAX_TX_FETCH = 60;

const MAX_WINNERS = 20;
const CONCURRENCY = 4;

// If we have a good cached list, and the new run finds 0 winners,
// keep old list for this long before we believe "no winners".
const STALE_OK_MS = 5 * 60 * 1000;

let cache = { ts: 0, data: null };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithTimeout(url, opts, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const json = await res.json();
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
      continue;
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

function buildResponse({ winners, cadenceSeconds }) {
  const lastPayoutUTC = winners[0]?.whenUTC || null;

  const nextDrawUTC = lastPayoutUTC
    ? new Date(Date.parse(lastPayoutUTC) + cadenceSeconds * 1000).toISOString()
    : null;

  return {
    updatedUTC: new Date().toISOString(),
    payoutWallet: PAYOUT_WALLET,
    payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
    lastPayoutUTC,
    nextDrawUTC,
    cadenceSeconds,
    winners: winners.slice(0, MAX_WINNERS),
  };
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

  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_MS) {
      return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
    }

    const sigs = await rpc("getSignaturesForAddress", [
      PAYOUT_WALLET,
      { limit: SIG_LIMIT },
    ]);

    const signatures = (sigs || [])
      .filter(s => s && !s.err && s.signature)
      .map(s => s.signature);

    // Fetch up to MAX_TX_FETCH transactions (expensive)
    const toFetch = signatures.slice(0, MAX_TX_FETCH);

    const txs = await mapLimit(toFetch, CONCURRENCY, async (sig) => {
      const tx = await rpc("getTransaction", [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      return { sig, tx };
    });

    const winners = [];

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
            if (solAmount >= 0.001 && solAmount <= 1000) {
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

      if (winners.length >= MAX_WINNERS) break;
    }

    winners.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));

    // derive cadence
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

    // ✅ CRITICAL FIX:
    // If new result is empty BUT we had good winners recently, return cached winners instead
    // (prevents “appears then disappears”)
    const hadGoodCache = cache.data?.winners?.length > 0;
    const cacheFreshEnough = (now - (cache.ts || 0)) < STALE_OK_MS;

    if (winners.length === 0 && hadGoodCache && cacheFreshEnough) {
      const safe = {
        ...cache.data,
        updatedUTC: new Date().toISOString(),
        stale: true,
        note: "Using last known winners (RPC indexing/rate-limit)",
      };
      // do not overwrite cache with empty
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    const data = buildResponse({ winners, cadenceSeconds });

    // Only cache if it looks sane (either we have winners, or we truly have no history yet)
    cache = { ts: now, data };

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    // ✅ also do not blow away cache on errors
    if (cache.data?.winners?.length) {
      const safe = {
        ...cache.data,
        updatedUTC: new Date().toISOString(),
        stale: true,
        error: "feed_unavailable",
        message: String(e?.message || e),
      };
      return { statusCode: 200, headers, body: JSON.stringify(safe) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        updatedUTC: new Date().toISOString(),
        payoutWallet: PAYOUT_WALLET,
        payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
        lastPayoutUTC: null,
        nextDrawUTC: null,
        cadenceSeconds: 15 * 60,
        winners: [],
        error: "feed_unavailable",
        message: String(e?.message || e),
      }),
    };
  }
};
