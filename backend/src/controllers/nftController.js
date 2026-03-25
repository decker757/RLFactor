import { supabase } from '../config/supabase.js';
import { bakeryWallet, investorWallet, hotelWallet, platformWallet } from '../config/wallets.js';
import { generateUniqueInvoiceImage } from '../services/imageService.js';
import { generateMetadataJSON, validateMetadata } from '../services/metadataService.js';
import { uploadImageToStorage, uploadMetadataToStorage, downloadImageAsBuffer } from '../services/storageService.js';
import { mintAndTransferNFT } from '../services/nftMintingService.js';
import { deriveAddress } from 'ripple-keypairs';
import { connectXRPL } from '../config/xrplClient.js';

/**
 * Background worker: runs the slow parts of minting (OpenAI + XRPL) after the
 * HTTP response has already been sent.  Updates NFTOKEN in-place so that the
 * frontend Supabase real-time subscription receives the state transition
 * minting → issued (or failed).
 */
async function runMintingJob(tempNftId, { invoiceNumber, faceValue, maturityDate, creditorAddress, debtorAddress }) {
  try {
    // Step 3: Generate unique image using OpenAI DALL-E 2 (3-5s vs 10-30s for DALL-E 3)
    console.log(`\n[BG] [Step 3] Generating image for ${tempNftId}...`);
    const imageUrl = await generateUniqueInvoiceImage({ invoiceNumber, faceValue, maturityDate });
    console.log(`[BG] ✓ Image generated`);

    // Step 4: Download and upload image to Supabase Storage
    console.log(`[BG] [Step 4] Uploading image...`);
    const imageBuffer = await downloadImageAsBuffer(imageUrl);
    const imageFileName = `${invoiceNumber}-${Date.now()}.png`;
    const imageLink = await uploadImageToStorage(imageBuffer, imageFileName);
    await supabase.from('NFTOKEN').update({ image_link: imageLink }).eq('nftoken_id', tempNftId);
    console.log(`[BG] ✓ Image uploaded: ${imageLink}`);

    // Step 5: Generate + upload metadata JSON
    console.log(`[BG] [Step 5-6] Building and uploading metadata...`);
    const metadata = generateMetadataJSON({
      invoiceNumber, faceValue, maturityDate,
      imageUrl: imageLink,
      originalOwner: debtorAddress,
      creditorPublicKey: creditorAddress,
    });
    validateMetadata(metadata);
    const metadataFileName = `${invoiceNumber}-${Date.now()}.json`;
    const metadataUri = await uploadMetadataToStorage(metadata, metadataFileName);
    console.log(`[BG] ✓ Metadata uploaded: ${metadataUri}`);

    // Step 7: Mint NFT on XRPL + create sell offer (two ledger confirmations, ~8s)
    console.log(`[BG] [Step 7] Minting NFT on XRPL...`);
    const mintResult = await mintAndTransferNFT({
      metadataUri,
      recipientAddress: creditorAddress,
      issuerWallet: platformWallet,
      transferFee: 0,
    });
    console.log(`[BG] ✓ NFT minted: ${mintResult.nftokenId}`);

    // Step 8: Swap temp ID → real NFTokenID and mark as issued
    const { error: updateError } = await supabase
      .from('NFTOKEN')
      .update({ nftoken_id: mintResult.nftokenId, current_state: 'issued' })
      .eq('nftoken_id', tempNftId);

    if (updateError) {
      console.error(`[BG] Warning: failed to update NFTokenID in DB:`, updateError);
    } else {
      console.log(`[BG] ✓ NFTOKEN updated → ${mintResult.nftokenId} (state: issued)`);
    }

    console.log(`\n[BG] === Minting job complete for ${tempNftId} ===\n`);
  } catch (err) {
    console.error(`[BG] ❌ Minting job failed for ${tempNftId}:`, err.message);
    await supabase
      .from('NFTOKEN')
      .update({ current_state: 'failed' })
      .eq('nftoken_id', tempNftId);
  }
}

/**
 * POST /nft/mint
 *
 * Returns 202 immediately after creating the DB record (state: 'minting').
 * Heavy work — OpenAI image generation, Supabase uploads, two XRPL ledger
 * confirmations — runs in the background via runMintingJob().
 *
 * The frontend should subscribe to real-time changes on the NFTOKEN row and
 * react when current_state transitions from 'minting' → 'issued' | 'failed'.
 */
export async function mintInvoiceNFT(req, res) {
  try {
    const {
      invoiceNumber,
      faceValue,
      maturityDate,
      creditorPublicKey,
      debtorPublicKey,
    } = req.body;

    if (!invoiceNumber || !faceValue || !maturityDate || !creditorPublicKey || !debtorPublicKey) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['invoiceNumber', 'faceValue', 'maturityDate', 'creditorPublicKey', 'debtorPublicKey'],
      });
    }

    // Derive XRPL addresses from public keys (or pass-through if already an address)
    let debtorAddress, creditorAddress;
    try {
      debtorAddress = debtorPublicKey.startsWith('r') ? debtorPublicKey : deriveAddress(debtorPublicKey);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid debtor public key or address', details: err.message });
    }
    try {
      creditorAddress = creditorPublicKey.startsWith('r') ? creditorPublicKey : deriveAddress(creditorPublicKey);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid creditor public key or address', details: err.message });
    }

    // Create DB record immediately with state 'minting'
    const tempNftId = `NFT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const { error: dbError } = await supabase
      .from('NFTOKEN')
      .insert([{
        nftoken_id: tempNftId,
        created_by: debtorAddress,
        invoice_number: invoiceNumber,
        face_value: faceValue,
        image_link: null,
        maturity_date: maturityDate,
        current_owner: creditorAddress,
        current_state: 'minting',
      }]);

    if (dbError) {
      throw new Error(`Database error: ${dbError.message}`);
    }

    // Kick off background job — do NOT await.
    // The client gets a 202 immediately; the Supabase real-time subscription
    // on the frontend will fire when current_state changes to 'issued' or 'failed'.
    runMintingJob(tempNftId, { invoiceNumber, faceValue, maturityDate, creditorAddress, debtorAddress })
      .catch(err => console.error('[BG] Unhandled minting job error:', err));

    console.log(`[mint] 202 returned for ${tempNftId} — background job started`);

    return res.status(202).json({
      success: true,
      message: 'Minting started. Subscribe to real-time updates for completion.',
      data: { tempNftId, invoiceNumber, faceValue, maturityDate, status: 'minting' },
    });

  } catch (error) {
    console.error('\n❌ NFT Minting Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to initiate NFT minting',
      message: error.message,
    });
  }
}

/**
 * Get NFT details by NFTokenID
 */
export async function getNFTDetails(req, res) {
  try {
    const { nftokenId } = req.params;

    const { data, error } = await supabase
      .from('NFTOKEN')
      .select('*')
      .eq('nftoken_id', nftokenId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'NFT not found' });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Get NFT details error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch NFT details',
      message: error.message
    });
  }
}

/**
 * Verify NFT ownership transfer and update state to 'owned'
 * Called by creditor after accepting the NFT offer on-chain
 */
export async function verifyNFTOwnership(req, res) {
  try {
    const { nftokenId, txHash } = req.body;
    const userAddress = req.user.address;

    console.log('\n🔍 Verifying NFT ownership...');
    console.log('  NFToken ID:', nftokenId);
    console.log('  TX Hash:', txHash);
    console.log('  User Address:', userAddress);

    // Validate inputs
    if (!nftokenId || !txHash) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: nftokenId, txHash'
      });
    }

    // Get NFT from database
    const { data: nft, error: fetchError } = await supabase
      .from('NFTOKEN')
      .select('*')
      .eq('nftoken_id', nftokenId)
      .single();

    if (fetchError || !nft) {
      return res.status(404).json({
        success: false,
        error: 'NFT not found in database'
      });
    }

    // Verify NFT state is 'issued' (pending acceptance)
    if (nft.current_state !== 'issued') {
      return res.status(400).json({
        success: false,
        error: `NFT is in state '${nft.current_state}', expected 'issued'`
      });
    }

    // Verify ownership on-chain
    console.log('  Verifying on-chain ownership...');
    const client = await connectXRPL();

    const response = await client.request({
      command: 'account_nfts',
      account: userAddress
    });

    const nfts = response.result.account_nfts || [];
    const ownsNFT = nfts.some((nft) => nft.NFTokenID === nftokenId);

    if (!ownsNFT) {
      return res.status(400).json({
        success: false,
        error: 'NFT ownership not confirmed on-chain. Please try again after transaction is validated.'
      });
    }

    console.log('  ✅ On-chain ownership verified!');

    // Update NFT state to 'owned' and set current_owner to the real acceptor address
    const { error: updateError } = await supabase
      .from('NFTOKEN')
      .update({
        current_state: 'owned',
        current_owner: userAddress,
      })
      .eq('nftoken_id', nftokenId);

    if (updateError) {
      throw updateError;
    }

    console.log('  ✅ NFT state updated to "owned"');

    return res.status(200).json({
      success: true,
      message: 'NFT ownership verified and state updated to "owned"',
      data: {
        nftokenId,
        newState: 'owned',
        txHash
      }
    });

  } catch (error) {
    console.error('\n❌ Verify ownership error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify NFT ownership',
      message: error.message
    });
  }
}

/**
 * List NFT on auction by transferring custody to platform
 *
 * Flow:
 * 1. User creates NFTokenCreateOffer (sell to platform for 0 XRP) on frontend
 * 2. User sends offerIndex to this endpoint
 * 3. Platform automatically accepts the offer
 * 4. NFT transfers from user → platform wallet
 * 5. Update database: state 'owned' → 'listed', owner → platform
 * 6. Create auction listing record
 */
export async function listNFTOnAuction(req, res) {
  try {
    const { nftokenId, offerIndex, minBid, expiry } = req.body;
    const userAddress = req.user.address;

    console.log('\n🎯 Starting List NFT on Auction Process');
    console.log('  NFToken ID:', nftokenId);
    console.log('  Offer Index:', offerIndex);
    console.log('  Min Bid:', minBid);
    console.log('  Expiry:', expiry);
    console.log('  User Address:', userAddress);

    // Validate inputs
    if (!nftokenId || !offerIndex || !minBid || !expiry) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: nftokenId, offerIndex, minBid, expiry'
      });
    }

    // Step 1: Get NFT from database and verify ownership
    console.log('\n[Step 1] Verifying NFT ownership in database...');
    const { data: nft, error: fetchError } = await supabase
      .from('NFTOKEN')
      .select('*')
      .eq('nftoken_id', nftokenId)
      .single();

    if (fetchError || !nft) {
      return res.status(404).json({
        success: false,
        error: 'NFT not found in database'
      });
    }

    // Verify user is the current owner
    if (nft.current_owner !== userAddress) {
      return res.status(403).json({
        success: false,
        error: 'You are not the owner of this NFT',
        debug: {
          nftOwner: nft.current_owner,
          yourAddress: userAddress
        }
      });
    }

    // Verify NFT state is 'owned'
    if (nft.current_state !== 'owned') {
      return res.status(400).json({
        success: false,
        error: `NFT is in state '${nft.current_state}', expected 'owned'. You can only list NFTs that you own.`
      });
    }

    console.log('✓ NFT ownership verified in database');

    // Step 2: Platform wallet accepts the sell offer
    // (XRPL will reject the tx if the offer is invalid — no redundant pre-check needed)
    console.log('\n[Step 2] Platform accepting NFT offer...');
    console.log('  Platform Address:', platformWallet.address);

    const client = await connectXRPL();

    const acceptOfferTx = {
      TransactionType: 'NFTokenAcceptOffer',
      Account: platformWallet.address,
      NFTokenSellOffer: offerIndex,
    };

    console.log('  Submitting NFTokenAcceptOffer transaction...');

    let result;
    try {
      result = await client.submitAndWait(acceptOfferTx, { wallet: platformWallet });
    } catch (error) {
      console.error('❌ Failed to accept NFT offer:', error);
      throw new Error(`Platform failed to accept NFT offer: ${error.message}. The offer may have expired or been cancelled.`);
    }

    console.log('✓ Transaction validated:', result.result.hash);

    // Check if transaction was successful
    if (result.result.meta && typeof result.result.meta === 'object') {
      const meta = result.result.meta;
      if (meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`NFT transfer failed: ${meta.TransactionResult}. Please try listing again.`);
      }
    } else {
      throw new Error('NFT transfer result unclear. Please verify manually before listing.');
    }

    const acceptTxHash = result.result.hash;
    console.log('✓ NFT offer accepted! TX Hash:', acceptTxHash);

    // Step 4: Verify NFT is now in platform wallet
    console.log('\n[Step 4] Verifying NFT transferred to platform...');
    const platformNFTsResponse = await client.request({
      command: 'account_nfts',
      account: platformWallet.address
    });

    const platformNFTs = platformNFTsResponse.result.account_nfts || [];
    const platformOwnsNFT = platformNFTs.some((nft) => nft.NFTokenID === nftokenId);

    if (!platformOwnsNFT) {
      // CRITICAL: NFT not in platform wallet - DO NOT proceed with listing
      console.error('❌ CRITICAL: NFT not found in platform wallet!');
      console.error('   Expected NFT:', nftokenId);
      console.error('   Platform wallet:', platformWallet.address);
      console.error('   Platform owns:', platformNFTs.length, 'NFTs');

      throw new Error('❌ FAILED: NFT did not transfer to platform wallet. Listing cancelled. Please try again.');
    }

    console.log('✓ NFT successfully transferred to platform wallet');
    console.log(`   Platform now owns ${platformNFTs.length} NFT(s)`);

    // Step 5: Update NFT state in database
    console.log('\n[Step 5] Updating NFT state in database...');
    const { error: updateNFTError } = await supabase
      .from('NFTOKEN')
      .update({
        current_state: 'listed',
        current_owner: platformWallet.address // Platform now owns it
      })
      .eq('nftoken_id', nftokenId);

    if (updateNFTError) {
      throw new Error(`Failed to update NFT state: ${updateNFTError.message}`);
    }

    console.log('✓ NFT state updated to "listed"');

    // Step 6: Create auction listing record
    console.log('\n[Step 6] Creating auction listing...');
    const { data: auction, error: auctionError } = await supabase
      .from('AUCTIONLISTING')
      .insert([{
        nftoken_id: nftokenId,
        face_value: nft.face_value,
        expiry: expiry,
        min_bid: minBid,
        current_bid: minBid,
        original_owner: userAddress, // Track who listed this NFT
        platform_holds_nft: true,
        status: 'active'
      }])
      .select()
      .single();

    if (auctionError) {
      throw new Error(`Failed to create auction listing: ${auctionError.message}`);
    }

    console.log('✓ Auction listing created with ID:', auction.aid);

    console.log('\n=== NFT Listed on Auction Successfully! ===\n');

    return res.status(200).json({
      success: true,
      message: 'NFT successfully listed on auction',
      data: {
        nftokenId,
        auctionId: auction.aid,
        minBid,
        expiry,
        acceptTxHash,
        platformAddress: platformWallet.address
      }
    });

  } catch (error) {
    console.error('\n❌ List NFT on auction error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to list NFT on auction',
      message: error.message,
      details: error.stack
    });
  }
}
