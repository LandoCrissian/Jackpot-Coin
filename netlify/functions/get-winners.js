// netlify/functions/get-winners.js
// Winner detection from System Program SOL transfers
// + derives observed cadence (median gaps)
// + returns deeper history so ALL browsers see it (no localStorage needed)
// + disables caching so payouts show faster

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

// Tune these:
const CACHE_MS = 8_000;      // small in-function cache to protect RPC
const SIG_LIMIT = 300;       // deeper history so new browsers still see winners
const MAX_WINNERS = 80;      // how many winners you return to the site
const CONCURRENCY = 8;

let cache = { ts: 0, data: null };

async function rpc(method, params) {
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json?.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function isoFromBlockTime(bt) {
  return bt ? new Date(bt * 1000).toISOString() : null;
}

function extractAllInstructions(tx) {
  // Top-level + inner instructions
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
  const results = [];
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

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",

    // IMPORTANT: reduce caching so payouts show quickly
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
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
      .filter(s => s && !s.err)
      .map(s => s.signature);

    const txs = await mapLimit(signatures, CONCURRENCY, async (sig) => {
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
      const ixs = extractAllInstructions(item.tx);

      for (const ix of ixs) {
        if (ix?.program === "system" && ix?.parsed?.type === "transfer") {
          const info = ix.parsed.info || {};
          const source = info.source;
          const destination = info.destination;
          const lamports = info.lamports;

          if (source === PAYOUT_WALLET && destination && destination !== PAYOUT_WALLET) {
            const solAmount = lamports / 1e9;

            // Filter to "winner-looking" payouts
            if (solAmount >= 0.01 && solAmount <= 1000) {
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
    }

    // newest first
    winners.sort((a, b) => (Date.parse(b.whenUTC || 0) - Date.parse(a.whenUTC || 0)));

    const lastPayoutUTC = winners[0]?.whenUTC || null;

    // Observed cadence from recent payout gaps (median)
    let cadenceSeconds = null;
    if (winners.length >= 4) {
      const times = winners
        .map(w => Date.parse(w.whenUTC))
        .filter(Number.isFinite)
        .sort((a, b) => b - a); // newest -> older

      const gaps = [];
      for (let i = 0; i < Math.min(times.length - 1, 20); i++) {
        const gapSec = Math.round((times[i] - times[i + 1]) / 1000);
        if (gapSec >= 120 && gapSec <= 3600) gaps.push(gapSec);
      }

      const med = median(gaps);
      if (med) cadenceSeconds = Math.round(med);
    }

    // fallback if inference fails
    if (!cadenceSeconds) cadenceSeconds = 15 * 60;

    const nextDrawUTC = lastPayoutUTC
      ? new Date(Date.parse(lastPayoutUTC) + cadenceSeconds * 1000).toISOString()
      : null;

    const data = {
      updatedUTC: new Date().toISOString(),
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      lastPayoutUTC,
      nextDrawUTC,
      cadenceSeconds,
      winners: winners.slice(0, MAX_WINNERS),
    };

    cache = { ts: now, data };

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Failed to fetch winner data",
        message: String(e?.message || e),
      }),
    };
  }
};
