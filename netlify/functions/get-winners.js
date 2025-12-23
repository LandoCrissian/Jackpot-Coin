const fetch = require('node-fetch');

const PAYOUT_WALLET = '66g5y8657nnGYcPSx8VM98C9rkre7YZLM3SpkuTDwwrw';
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const CACHE_DURATION = 60000; // 1 minute cache

let cachedData = null;
let cacheTimestamp = 0;

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // Return cached data if still fresh
    const now = Date.now();
    if (cachedData && (now - cacheTimestamp) < CACHE_DURATION) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cachedData),
      };
    }

    // Fetch recent transaction signatures
    const signaturesResponse = await fetch(RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          PAYOUT_WALLET,
          { limit: 50 }
        ],
      }),
    });

    const signaturesData = await signaturesResponse.json();
    
    if (signaturesData.error) {
      throw new Error(signaturesData.error.message);
    }

    const signatures = signaturesData.result || [];
    
    // Fetch full transaction details for each signature
    const transactionPromises = signatures.map(sig =>
      fetch(RPC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            sig.signature,
            { 
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: 0
            }
          ],
        }),
      }).then(r => r.json())
    );

    const transactions = await Promise.all(transactionPromises);

    // Parse and filter winner payouts
    const winners = [];

    for (const txData of transactions) {
      if (txData.error || !txData.result) continue;

      const tx = txData.result;
      const meta = tx.meta;
      const blockTime = tx.blockTime;
      
      if (!meta || meta.err || !blockTime) continue;

      // Look for System Program transfers in instructions
      const instructions = tx.transaction.message.instructions;
      
      for (const ix of instructions) {
        // Check if this is a System Program transfer
        if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
          const info = ix.parsed.info;
          const source = info.source;
          const destination = info.destination;
          const lamports = info.lamports;

          // Must be outbound from payout wallet to a different address
          if (source === PAYOUT_WALLET && destination !== PAYOUT_WALLET) {
            const solAmount = lamports / 1e9;
            
            // Filter for reasonable payout amounts (0.01 SOL to 1000 SOL)
            if (solAmount >= 0.01 && solAmount <= 1000) {
              winners.push({
                recipient: destination,
                amount: solAmount,
                timestamp: blockTime * 1000, // Convert to milliseconds
                signature: tx.transaction.signatures[0],
                solscanUrl: `https://solscan.io/tx/${tx.transaction.signatures[0]}`,
              });
            }
          }
        }
      }
    }

    // Sort by timestamp descending (most recent first)
    winners.sort((a, b) => b.timestamp - a.timestamp);

    // Take top 20 most recent
    const recentWinners = winners.slice(0, 20);

    const response = {
      payoutWallet: PAYOUT_WALLET,
      payoutWalletUrl: `https://solscan.io/account/${PAYOUT_WALLET}`,
      winners: recentWinners,
      lastUpdate: now,
    };

    // Cache the result
    cachedData = response;
    cacheTimestamp = now;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response),
    };

  } catch (error) {
    console.error('Error fetching winners:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch winner data',
        message: error.message,
      }),
    };
  }
};
