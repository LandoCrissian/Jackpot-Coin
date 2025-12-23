// netlify/functions/get-winners.js
// Live winner feed from payout wallet System Program transfers (Solana RPC)

const fetch = require("node-fetch");

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

const CACHE_MS = 25_000;          // short cache so site feels live
const MAX_PAYOUTS = 30;           // how many payouts we try to collect
const MAX_PAGES = 7;              // pagination pages of signatures
const SIGS_PER_PAGE = 100;        // getSignaturesForAddress limit

let cache = { ts: 0, data: null };

async function rpc(method, params) {
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function isoFromBlockTime(bt) {
  if (!bt) return null;
  return new Date(bt * 1000).toISOString();
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=10",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const now = Date.now();

    if (cache.data && (now - cache.ts) < CACHE_MS) {
      return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
    }

    const winners = [];
    let before = undefined;

    for (let page = 0; page < MAX_PAGES && winners.length < MAX_PAYOUTS; page++) {
      const sigs = await rpc("getSignaturesForAddress", [
        PAYOUT_WALLET,
        { limit: SIGS_PER_PAGE, ...(before ? { before } : {}) },
      ]);

      if (!sigs || sigs.length === 0) break;
      before = sigs[sigs.length - 1].signature;

      // Fetch tx details sequentially (more reliable, less rate-limit pain)
      for (const s of sigs) {
        if (!s || s.err) continue;

        const tx = await rpc("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);

        if (!tx || !tx.transaction || !tx.meta || tx.meta.err) continue;

        const bt = tx.blockTime || s.blockTime || null;
        const whenUTC = isoFromBlockTime(bt);

        const instructions = tx.transaction.message.instructions || [];

        // Only count System Program transfer instructions from payout wallet
        for (const ix of instructions) {
          if (ix?.program === "system" && ix?.parsed?.type === "transfer") {
            const info = ix.parsed.info || {};
            const source = info.source;
            const destination = info.destination;
            const lamports = info.lamports;

            if (source === PAYOUT_WALLET && destination && destination !== PAYOUT_WALLET) {
              const solAmount = lamports / 1e9;

              // Safety range filter (keeps non-payout dust/etc out)
              if (solAmount >= 0.01 && solAmount <= 1000) {
                winners.push({
                  wallet: destination,
                  amountSOL: Number(solAmount.toFixed(9)),
                  whenUTC,
                  tx: s.signature,
                  solscanUrl: `https://solscan.io/tx/${s.signature}`,
                });
              }
            }
          }
        }

        if (winners.length >= MAX_PAYOUTS) break;
      }
    }

    // Sort newest first (null-safe)
    winners.sort((a, b) => {
      const ta = a.whenUTC ? Date.parse(a.whenUTC) : 0;
      const tb = b.whenUTC ? Date.parse(b.whenUTC) : 0;
      return tb - ta;
    });

    const lastPayoutUTC = winners[0]?.whenUTC || null;
    const nextDrawUTC = lastPayoutUTC
      ? new Date(Date.parse(lastPayoutUTC) + 10 * 60 * 1000).toISOString()
      : null;

    const data = {
      updatedUTC: new Date().toISOString(),
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      lastPayoutUTC,
      nextDrawUTC,
      winners: winners.slice(0, 20),
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
