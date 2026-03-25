import * as xrpl from 'xrpl';

const XRPL_NETWORK = 'wss://s.altnet.rippletest.net:51233';
const PLATFORM_WALLET_ADDRESS = 'rJoESWx9ZKHpEyNrLWBTA95XLxwoKJj59u';
const RLUSD_ISSUER = 'r9EMUwedCZFW53NVfw9SNHvKoRWJ8fbgu7';
const RLUSD_CURRENCY = '524C555344000000000000000000000000000000'; // "RLUSD" in hex

// Module-level singleton — one WebSocket connection shared across all operations.
// Previously every function created + connected + disconnected its own client,
// adding ~1-2s of handshake overhead per call.
let _client: xrpl.Client | null = null;

async function getClient(): Promise<xrpl.Client> {
  if (!_client) {
    _client = new xrpl.Client(XRPL_NETWORK);
  }
  if (!_client.isConnected()) {
    await _client.connect();
  }
  return _client;
}

/**
 * Find sell offers for a specific NFT
 */
export async function findNFTSellOffers(nftokenId: string): Promise<any[]> {
  const client = await getClient();

  try {
    console.log('📡 Requesting sell offers for NFT:', nftokenId);

    const response = await client.request({
      command: 'nft_sell_offers',
      nft_id: nftokenId,
    } as any);

    console.log('📋 XRPL Response:', response);

    const offers = (response as any).result.offers || [];
    console.log(`✅ Found ${offers.length} sell offer(s)`);

    return offers;
  } catch (error: any) {
    console.error('❌ Error finding NFT sell offers:', error);
    console.error('   Error code:', error?.data?.error);
    console.error('   Error message:', error?.data?.error_message);

    // If objectNotFound, it means no offers exist - return empty array instead of throwing
    if (error?.data?.error === 'objectNotFound') {
      console.log('ℹ️  No sell offers found for this NFT');
      return [];
    }

    throw new Error(error?.data?.error_message || error?.message || 'Failed to find NFT sell offers');
  }
}

/**
 * Accept an NFT sell offer
 * User must provide their wallet seed to sign the transaction
 */
export async function acceptNFTOffer(params: {
  nftokenId: string;
  offerIndex: string;
  walletSeed: string;
}): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  const client = await getClient();

  try {
    // Create wallet from seed
    const wallet = xrpl.Wallet.fromSeed(params.walletSeed);
    console.log('👛 Wallet address:', wallet.address);

    // Create NFTokenAcceptOffer transaction
    const acceptOfferTx: xrpl.NFTokenAcceptOffer = {
      TransactionType: 'NFTokenAcceptOffer',
      Account: wallet.address,
      NFTokenSellOffer: params.offerIndex,
    };

    console.log('📝 Submitting NFTokenAcceptOffer transaction...');

    // Submit and wait for validation
    const result = await client.submitAndWait(acceptOfferTx, { wallet });

    console.log('✅ Transaction validated:', result.result.hash);

    // Check if transaction was successful
    if (result.result.meta && typeof result.result.meta === 'object') {
      const meta = result.result.meta as any;
      if (meta.TransactionResult === 'tesSUCCESS') {
        return {
          success: true,
          txHash: result.result.hash,
        };
      }
    }

    return {
      success: false,
      error: 'Transaction failed to execute successfully',
    };

  } catch (error) {
    console.error('❌ Error accepting NFT offer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Get NFT ownership information
 */
export async function getNFTOwner(nftokenId: string, ownerAddress: string): Promise<boolean> {
  const client = await getClient();

  try {
    const response = await client.request({
      command: 'account_nfts',
      account: ownerAddress,
    });

    const nfts = response.result.account_nfts || [];
    return nfts.some((nft: any) => nft.NFTokenID === nftokenId);

  } catch (error) {
    console.error('Error checking NFT ownership:', error);
    return false;
  }
}

/**
 * Create a sell offer to transfer NFT to platform wallet
 * User must provide their wallet seed to sign the transaction
 */
export async function createSellOfferToPlatform(params: {
  nftokenId: string;
  walletSeed: string;
  platformAddress: string;
}): Promise<{
  success: boolean;
  offerIndex?: string;
  txHash?: string;
  error?: string;
}> {
  const client = await getClient();

  try {
    // Create wallet from seed
    const wallet = xrpl.Wallet.fromSeed(params.walletSeed);
    console.log('👛 Wallet address:', wallet.address);

    // Create NFTokenCreateOffer transaction (sell offer to platform for 0 XRP)
    const createOfferTx: xrpl.NFTokenCreateOffer = {
      TransactionType: 'NFTokenCreateOffer',
      Account: wallet.address,
      NFTokenID: params.nftokenId,
      Amount: '0', // Platform takes custody for free
      Destination: params.platformAddress, // Only platform can accept this offer
      Flags: 1, // tfSellNFToken flag
    };

    console.log('📝 Creating sell offer to platform...');
    console.log('  Platform destination:', params.platformAddress);

    // Submit and wait for validation
    const result = await client.submitAndWait(createOfferTx, { wallet });

    console.log('✅ Transaction validated:', result.result.hash);

    // Extract offer index from transaction metadata
    let offerIndex: string | undefined;

    if (result.result.meta && typeof result.result.meta === 'object') {
      const meta = result.result.meta as any;

      // Check transaction success
      if (meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`Transaction failed: ${meta.TransactionResult}`);
      }

      // Find the created offer in AffectedNodes
      if (meta.AffectedNodes) {
        for (const node of meta.AffectedNodes) {
          if (node.CreatedNode && node.CreatedNode.LedgerEntryType === 'NFTokenOffer') {
            offerIndex = node.CreatedNode.LedgerIndex;
            break;
          }
        }
      }
    }

    if (!offerIndex) {
      throw new Error('Could not extract offer index from transaction result');
    }

    console.log('✅ Sell offer created! Offer Index:', offerIndex);

    return {
      success: true,
      offerIndex,
      txHash: result.result.hash,
    };

  } catch (error) {
    console.error('❌ Error creating sell offer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Transfer RLUSD from user wallet to platform wallet
 * User must provide their wallet seed to sign the transaction
 */
export async function transferRLUSDToPlatform(params: {
  walletSeed: string;
  amount: number;
}): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  const client = await getClient();

  try {
    // Create wallet from seed
    const wallet = xrpl.Wallet.fromSeed(params.walletSeed);
    console.log('👛 Wallet address:', wallet.address);
    console.log('💰 Sending', params.amount, 'RLUSD to platform wallet:', PLATFORM_WALLET_ADDRESS);

    // Create RLUSD payment transaction
    const paymentTx: xrpl.Payment = {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: PLATFORM_WALLET_ADDRESS,
      Amount: {
        currency: RLUSD_CURRENCY,
        value: params.amount.toString(),
        issuer: RLUSD_ISSUER,
      },
    };

    console.log('📝 Submitting RLUSD payment transaction...');

    // Submit and wait for validation
    const result = await client.submitAndWait(paymentTx, { wallet });

    console.log('✅ Transaction validated:', result.result.hash);

    // Check if transaction was successful
    if (result.result.meta && typeof result.result.meta === 'object') {
      const meta = result.result.meta as any;
      if (meta.TransactionResult === 'tesSUCCESS') {
        return {
          success: true,
          txHash: result.result.hash,
        };
      } else {
        return {
          success: false,
          error: `Transaction failed: ${meta.TransactionResult}`,
        };
      }
    }

    return {
      success: false,
      error: 'Transaction failed to execute successfully',
    };

  } catch (error) {
    console.error('❌ Error transferring RLUSD:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Create NFT sell offer to platform for maturity redemption
 * Investor creates this offer so platform can facilitate NFT return to hotel
 * @param walletSeed - Investor's wallet seed
 * @param nftokenId - NFT ID to sell
 * @param destination - Platform wallet address (optional, defaults to platform)
 * @returns Promise with success status and offer index
 */
export async function createNFTRedemptionOffer(params: {
  walletSeed: string;
  nftokenId: string;
  destination?: string;
}): Promise<{
  success: boolean;
  offerIndex?: string;
  txHash?: string;
  error?: string;
}> {
  const client = await getClient();

  try {
    const wallet = xrpl.Wallet.fromSeed(params.walletSeed);
    const destination = params.destination || PLATFORM_WALLET_ADDRESS;

    console.log('📝 Creating NFT sell offer for redemption:');
    console.log('  Seller:', wallet.address);
    console.log('  NFT ID:', params.nftokenId);
    console.log('  Destination:', destination);
    console.log('  Amount: 0 XRP (free transfer for redemption)');

    // Create NFT sell offer
    const offerTx: xrpl.NFTokenCreateOffer = {
      TransactionType: 'NFTokenCreateOffer',
      Account: wallet.address,
      NFTokenID: params.nftokenId,
      Amount: '0', // 0 XRP for maturity redemption
      Destination: destination, // Sell specifically to platform
      Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken
    };

    console.log('  📤 Submitting NFT sell offer...');

    const result = await client.submitAndWait(offerTx, { wallet });

    if (result.result.meta && typeof result.result.meta === 'object') {
      const meta = result.result.meta as any;
      if (meta.TransactionResult === 'tesSUCCESS') {
        // Extract offer index from created node
        const createdNode = meta.CreatedNode || meta.AffectedNodes?.find(
          (node: any) => node.CreatedNode?.LedgerEntryType === 'NFTokenOffer'
        )?.CreatedNode;

        const offerIndex = createdNode?.LedgerIndex;

        console.log('✅ NFT sell offer created!');
        console.log('  Offer Index:', offerIndex);
        console.log('  TX Hash:', result.result.hash);

        return {
          success: true,
          offerIndex,
          txHash: result.result.hash
        };
      } else {
        return {
          success: false,
          error: `Transaction failed: ${meta.TransactionResult}`
        };
      }
    }

    return {
      success: false,
      error: 'Transaction failed to execute'
    };

  } catch (error) {
    console.error('❌ Error creating NFT redemption offer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };

  }
}
