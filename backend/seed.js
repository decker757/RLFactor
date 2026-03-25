/**
 * RLFactor — Database Seed Script
 *
 * Generates 50 users (25 investors, 24 businesses, 1 admin),
 * 50 NFTs, 50 auction listings (mix of active/completed/unlisted),
 * ~150 bids, maturity payments, and audit log entries.
 *
 * Usage:
 *   node seed.js
 *
 * Requires .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * Safe to re-run — users/NFTs upsert; auctions/bids skip if already present.
 */

import './src/init.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Helpers ────────────────────────────────────────────────────────────────

function deriveAddress(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const h = Math.abs(hash).toString(36).toUpperCase();
  return `r${h}${seed.slice(1, 4).toUpperCase()}${h.slice(0, 20)}`;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Seeded PRNG so the data is deterministic across re-runs. */
function makePrng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}
const rand = makePrng(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));

async function upsert(table, rows, conflict) {
  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: conflict, ignoreDuplicates: false });
  if (error) throw new Error(`[${table}] ${error.message}`);
}

async function insert(table, rows) {
  if (!rows.length) return;
  const { error } = await supabase.from(table).insert(rows);
  if (error && !error.message.includes('duplicate') && !error.code?.includes('23505')) {
    throw new Error(`[${table}] ${error.message}`);
  }
}

// ── User name pools ────────────────────────────────────────────────────────

const INVESTOR_NAMES = [
  'Alice Tan', 'Bob Chen', 'Clara Wong', 'David Lim', 'Eve Ng',
  'Frank Ho', 'Grace Yeo', 'Henry Koh', 'Iris Teo', 'James Ong',
  'Karen Sim', 'Leo Chan', 'Mia Lau', 'Nathan Foo', 'Olivia Wee',
  'Paul Chong', 'Quinn Yap', 'Rachel Toh', 'Samuel Goh', 'Tina Chia',
  'Umar Bin Ali', 'Vera Soo', 'Wayne Phua', 'Xin Yi Low', 'Yusuf Rashid',
];

const BUSINESS_NAMES = [
  'Acme Corp', 'TechStart Inc', 'Pinnacle Goods', 'Swift Logistics',
  'Meridian Foods', 'BlueSky Retail', 'Harbour Imports', 'NovaBuild',
  'Crestline Suppliers', 'Apex Trade Co', 'SilverLeaf Exports',
  'Redwood Manufacturing', 'Fusion Electronics', 'Atlas Wholesale',
  'Zenith Distributors', 'Falcon Supply Chain', 'Orion Commerce',
  'Cascade Traders', 'Summit Holdings', 'Pacific Merchants',
  'UrbanEdge Goods', 'GreenPath Solutions', 'Titan Fabrications', 'Nexus Partners',
];

const IMAGES = [
  'https://images.unsplash.com/photo-1554224311-beee910c1b8a?w=800&q=80',
  'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&q=80',
  'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?w=800&q=80',
  'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=800&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80',
  'https://images.unsplash.com/photo-1553729459-efe14ef6055d?w=800&q=80',
  'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&q=80',
];

// ── 1. Users ───────────────────────────────────────────────────────────────

async function seedUsers() {
  console.log('👤  Seeding users...');

  const users = [];

  // 1 admin
  users.push({
    publicKey: deriveAddress('sTestKeyADMIN000000000001'),
    username:  'Platform Admin',
    role:      'admin',
  });

  // 25 investors
  for (let i = 0; i < 25; i++) {
    users.push({
      publicKey: deriveAddress(`sTestKeyINVESTOR${String(i).padStart(3, '0')}`),
      username:  INVESTOR_NAMES[i],
      role:      'investor',
    });
  }

  // 24 businesses
  for (let i = 0; i < 24; i++) {
    users.push({
      publicKey: deriveAddress(`sTestKeyBUSINESS${String(i).padStart(3, '0')}`),
      username:  BUSINESS_NAMES[i],
      role:      'business',
    });
  }

  await upsert('USER', users, 'publicKey');
  console.log(`    ✓ ${users.length} users (25 investors, 24 businesses, 1 admin)`);
  return users;
}

// ── 2. NFTs + 3. Auctions ──────────────────────────────────────────────────

async function seedNFTsAndAuctions(users) {
  console.log('🖼️   Seeding NFTs...');

  const businesses = users.filter(u => u.role === 'business');
  const investors  = users.filter(u => u.role === 'investor');

  // Auction status distribution across 50 listings
  // 35 active | 10 completed | 5 unlisted
  const statusPlan = [
    ...Array(35).fill('active'),
    ...Array(10).fill('completed'),
    ...Array(5).fill('unlisted'),
  ];

  const nfts     = [];
  const listings = [];

  for (let i = 0; i < 50; i++) {
    const biz          = businesses[i % businesses.length];
    const faceValue    = between(20_000, 200_000);
    const status       = statusPlan[i];
    const invoiceNum   = `INV-2024-${String(i + 1).padStart(3, '0')}`;
    const nftId        = `SEED${String(i + 1).padStart(3, '0')}${biz.publicKey.slice(1, 9)}`;

    // NFT state mirrors auction status
    const nftState = status === 'active'    ? 'listed'
                   : status === 'completed' ? 'owned'
                   : 'issued';

    const winnerInvestor = investors[i % investors.length];

    nfts.push({
      nftoken_id:     nftId,
      created_by:     biz.publicKey,
      invoice_number: invoiceNum,
      face_value:     faceValue,
      image_link:     pick(IMAGES),
      maturity_date:  status === 'completed'
                        ? daysAgo(between(5, 60))
                        : daysFromNow(between(30, 180)),
      current_owner:  status === 'completed' ? winnerInvestor.publicKey : biz.publicKey,
      current_state:  nftState,
    });

    const minBid     = Math.round(faceValue * (0.85 + rand() * 0.05)); // 85–90% of face
    const currentBid = Math.round(minBid    * (1.00 + rand() * 0.10)); // 0–10% above min

    const base = {
      nftoken_id:         nftId,
      face_value:         faceValue,
      min_bid:            minBid,
      current_bid:        currentBid,
      original_owner:     biz.publicKey,
      platform_holds_nft: status === 'active',
    };

    if (status === 'active') {
      listings.push({
        ...base,
        expiry:  daysFromNow(between(1, 14)),
        status:  'active',
      });
    } else if (status === 'completed') {
      const finalPrice = Math.round(minBid * (1.02 + rand() * 0.12));
      listings.push({
        ...base,
        expiry:          daysAgo(between(1, 30)),
        status:          'completed',
        winner_address:  winnerInvestor.publicKey,
        final_price:     finalPrice,
        current_bid:     finalPrice,
        completed_at:    daysAgo(between(1, 30)),
        platform_holds_nft: false,
      });
    } else {
      listings.push({
        ...base,
        expiry:      daysAgo(between(1, 14)),
        status:      'unlisted',
        unlisted_at: daysAgo(between(1, 14)),
      });
    }
  }

  await upsert('NFTOKEN', nfts, 'nftoken_id');
  console.log(`    ✓ ${nfts.length} NFTs`);

  console.log('🏷️   Seeding auction listings...');
  const { data: insertedListings, error } = await supabase
    .from('AUCTIONLISTING')
    .insert(listings)
    .select('aid, nftoken_id, status, winner_address, final_price');

  if (error) {
    if (error.code?.includes('23505') || error.message.includes('duplicate')) {
      console.log('    ↩  Listings already exist, skipping bids.');
      return null;
    }
    throw new Error(`[AUCTIONLISTING] ${error.message}`);
  }

  console.log(`    ✓ ${insertedListings.length} listings (35 active, 10 completed, 5 unlisted)`);
  return { insertedListings, investors, businesses };
}

// ── 4. Bids ────────────────────────────────────────────────────────────────

async function seedBids({ insertedListings, investors }) {
  console.log('💰  Seeding bids...');

  const bids        = [];
  const winnerUpdates = [];

  for (const listing of insertedListings) {
    const { aid, status, winner_address, final_price } = listing;

    if (status === 'active') {
      // 2–5 bids per active auction from random investors
      const numBids   = between(2, 5);
      const bidAmounts = [];
      for (let b = 0; b < numBids; b++) {
        const investor = investors[between(0, investors.length - 1)];
        const amount   = between(
          Math.round(listing.min_bid ?? 20_000),
          Math.round((listing.min_bid ?? 20_000) * 1.15)
        );
        // Avoid duplicate active bid from same investor on same auction
        if (!bidAmounts.find(x => x.bid_by === investor.publicKey)) {
          bids.push({ aid, bid_amount: amount, bid_by: investor.publicKey, check_status: 'active' });
          bidAmounts.push({ bid_by: investor.publicKey });
        }
      }
    } else if (status === 'completed' && winner_address) {
      // Insert winning bid and capture id to set winning_bid_id
      const { data: wb, error: wbErr } = await supabase
        .from('AUCTIONBIDS')
        .insert({ aid, bid_amount: final_price, bid_by: winner_address, check_status: 'paid' })
        .select('bid_id')
        .single();

      if (!wbErr && wb) {
        winnerUpdates.push({ aid, winning_bid_id: wb.bid_id });
      }
    }
  }

  if (bids.length) await insert('AUCTIONBIDS', bids);

  // Back-fill winning_bid_id on completed listings
  for (const { aid, winning_bid_id } of winnerUpdates) {
    await supabase.from('AUCTIONLISTING').update({ winning_bid_id }).eq('aid', aid);
  }

  console.log(`    ✓ ${bids.length} active bids + ${winnerUpdates.length} winning bids`);
}

// ── 5. Maturity payments ───────────────────────────────────────────────────

async function seedMaturityPayments() {
  console.log('📅  Seeding maturity payments...');

  // Fetch completed listings to create maturity payments for their NFTs
  const { data: completed } = await supabase
    .from('AUCTIONLISTING')
    .select('nftoken_id, winner_address, final_price, original_owner')
    .eq('status', 'completed')
    .limit(10);

  if (!completed?.length) {
    console.log('    ↩  No completed listings found, skipping.');
    return;
  }

  const payments = completed.map(l => ({
    nftoken_id:       l.nftoken_id,
    debtor_address:   l.original_owner,   // business owes payment at maturity
    creditor_address: l.winner_address,   // investor is owed payment
    payment_amount:   l.final_price,
    maturity_date:    daysAgo(between(1, 10)),
    check_status:     pick(['pending', 'pending', 'created', 'completed']), // weighted towards pending
  }));

  await insert('MATURITY_PAYMENT', payments);
  console.log(`    ✓ ${payments.length} maturity payments`);
}

// ── 6. Audit log ───────────────────────────────────────────────────────────

async function seedAuditLog(users) {
  console.log('📋  Seeding audit log...');

  const businesses = users.filter(u => u.role === 'business');
  const investors  = users.filter(u => u.role === 'investor');

  const entries = [];

  // NFT_MINTED entries for businesses
  for (let i = 0; i < 20; i++) {
    entries.push({
      actor_address: pick(businesses).publicKey,
      action:        'NFT_MINTED',
      entity_type:   'NFTOKEN',
      entity_id:     `SEED${String(i + 1).padStart(3, '0')}`,
      metadata:      { invoice_number: `INV-2024-${String(i + 1).padStart(3, '0')}`, face_value: between(20_000, 200_000) },
    });
  }

  // BID_PLACED entries for investors
  for (let i = 0; i < 20; i++) {
    entries.push({
      actor_address: pick(investors).publicKey,
      action:        'BID_PLACED',
      entity_type:   'AUCTIONBIDS',
      entity_id:     String(i + 1),
      metadata:      { auction_id: i + 1, bid_amount: between(20_000, 180_000) },
    });
  }

  // AUCTION_SETTLED entries
  for (let i = 0; i < 10; i++) {
    entries.push({
      actor_address: pick(investors).publicKey,
      action:        'AUCTION_SETTLED',
      entity_type:   'AUCTIONLISTING',
      entity_id:     String(i + 36),
      metadata:      { final_price: between(20_000, 180_000) },
    });
  }

  await insert('AUDIT_LOG', entries);
  console.log(`    ✓ ${entries.length} audit log entries`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  RLFactor seed starting (50 users / 50 NFTs / 50 listings)...\n');

  try {
    const users = await seedUsers();
    const result = await seedNFTsAndAuctions(users);
    if (result) {
      await seedBids(result);
      await seedMaturityPayments();
    }
    await seedAuditLog(users);
    console.log('\n✅  Seed complete.\n');
  } catch (err) {
    console.error('\n❌  Seed failed:', err.message);
    process.exit(1);
  }
}

main();
