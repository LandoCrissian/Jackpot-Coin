const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

// Cache to reduce RPC load and keep UI stable
const CACHE_DURATION_MS = 30_000;

let cachedData = null;
let cacheTimestamp = 0;

async function rpc(method, params) {
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const json = await res.json();
  if (json?.error) throw new Error(json.error.message);
  return json.result;
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

    if (cachedData && (now - cacheTimestamp) < CACHE_DURATION_MS) {
      return { statusCode: 200, headers, body: JSON.stringify(cachedData) };
    }

    // Pull more history so winners don't “disappear”
    const winners = [];
    let before = undefined;
    let pages = 0;

    while (winners.length < 30 && pages < 6) {
      pages++;

      const sigs = await rpc("getSignaturesForAddress", [
        PAYOUT_WALLET,
        { limit: 100, ...(before ? { before } : {}) },
      ]);

      if (!sigs || sigs.length === 0) break;
      before = sigs[sigs.length - 1].signature;

      // Sequential fetch to avoid blasting RPC
      for (const s of sigs) {
        if (s.err) continue;

        const tx = await rpc("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);

        if (!tx || !tx.meta || tx.meta.err) continue;

        const blockTime = tx.blockTime || s.blockTime || null;
        const instructions = tx.transaction?.message?.instructions || [];

        for (const ix of instructions) {
          // Deterministic: System Program transfer from payout wallet
          if (ix.program === "system" && ix.parsed?.type === "transfer") {
            const info = ix.parsed.info;
            const source = info.source;
            const destination = info.destination;
            const lamports = info.lamports;

            if (source === PAYOUT_WALLET && destination && destination !== PAYOUT_WALLET) {
              const solAmount = lamports / 1e9;

              // Reasonable payout filter
              if (solAmount >= 0.01 && solAmount <= 1000) {
                winners.push({
                  wallet: destination,
                  amountSOL: Number(solAmount.toFixed(9)),
                  whenUTC: blockTime ? new Date(blockTime * 1000).toISOString() : null,
                  tx: s.signature,
                  solscanTx: `https://solscan.io/tx/${s.signature}`,
                });
              }
            }
          }
        }

        if (winners.length >= 30) break;
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

    const response = {
      updatedUTC: new Date().toISOString(),
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      lastPayoutUTC,
      nextDrawUTC,
      winners: winners.slice(0, 20),
    };

    cachedData = response;
    cacheTimestamp = now;

    return { statusCode: 200, headers, body: JSON.stringify(response) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Failed to fetch winner data",
        message: err.message || String(err),
      }),
    };
  }
};
