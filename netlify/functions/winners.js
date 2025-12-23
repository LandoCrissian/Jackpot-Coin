import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PAYOUT_WALLET = "66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

export async function handler() {
  try {
    const payoutPk = new PublicKey(PAYOUT_WALLET);
    const sigs = await connection.getSignaturesForAddress(payoutPk, { limit: 40 });

    const winners = [];
    for (const s of sigs) {
      if (s.err) continue;

      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (!tx?.meta) continue;

      const keys = tx.transaction.message.accountKeys.map(k => k.toBase58());
      const payoutIdx = keys.indexOf(PAYOUT_WALLET);
      if (payoutIdx === -1) continue;

      const pre = tx.meta.preBalances?.[payoutIdx];
      const post = tx.meta.postBalances?.[payoutIdx];
      if (typeof pre !== "number" || typeof post !== "number") continue;
      if (post >= pre) continue;

      const deltas = keys.map((addr, i) => {
        const preB = tx.meta.preBalances?.[i] ?? 0;
        const postB = tx.meta.postBalances?.[i] ?? 0;
        return { addr, delta: postB - preB };
      });

      const recipients = deltas
        .filter(d => d.addr !== PAYOUT_WALLET && d.delta > 0)
        .sort((a,b) => b.delta - a.delta);

      if (recipients.length === 0) continue;

      const winner = recipients[0];
      const amountSOL = Number((winner.delta / LAMPORTS_PER_SOL).toFixed(9));

      winners.push({
        wallet: winner.addr,
        amountSOL,
        whenUTC: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
        tx: s.signature
      });

      if (winners.length >= 12) break;
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        updatedUTC: new Date().toISOString(),
        payoutWallet: PAYOUT_WALLET,
        winners
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Failed to fetch winners", details: String(e?.message || e) })
    };
  }
}
