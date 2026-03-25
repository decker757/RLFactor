/**
 * RLFactor — Database Seed Script
 *
 * Populates a fresh database with demo users, NFTs, auction listings,
 * bids, and a maturity payment record.
 *
 * Usage:
 *   node seed.js
 *
 * Requires .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * Safe to re-run — all inserts use upsert / ON CONFLICT DO NOTHING.
 */

import './src/init.js'; // loads .env
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Same deterministic fake-address function used by the frontend demo generator. */
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

async function upsert(table, rows, conflict) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: false });
  if (error) throw new Error(`[${table}] ${error.message}`);
}

async function insert(table, rows) {
  const { error } = await supabase.from(table).insert(rows);
  // Ignore unique-violation errors (idempotent re-runs)
  if (error && !error.message.includes('duplicate') && !error.code?.includes('23505')) {
    throw new Error(`[${table}] ${error.message}`);
  }
}

// ── Seeds ──────────────────────────────────────────────────────────────────

const SEEDS = {
  investor1:  'sTestKey123456789INVESTOR1',
  investor2:  'sTestKey987654321INVESTOR2',
  business1:  'sTestKey123456789BUSINESS1',
  business2:  'sTestKey987654321BUSINESS2',
  admin:      'sTestKeyADMIN000000000001',
};

const ADDR = Object.fromEntries(
  Object.entries(SEEDS).map(([k, v]) => [k, deriveAddress(v)])
);

// ── 1. Users ───────────────────────────────────────────────────────────────

async function seedUsers() {
  console.log('👤  Seeding users...');
  await upsert('USER', [
    { publicKey: ADDR.investor1, username: 'Alice Investor',  role: 'investor'  },
    { publicKey: ADDR.investor2, username: 'Bob Investor',    role: 'investor'  },
    { publicKey: ADDR.business1, username: 'Acme Corp',       role: 'business'  },
    { publicKey: ADDR.business2, username: 'TechStart Inc',   role: 'business'  },
    { publicKey: ADDR.admin,     username: 'Platform Admin',  role: 'admin'     },
  ], 'publicKey');
  console.log('    ✓ 5 users (2 investors, 2 businesses, 1 admin)');
}

// ── 2. NFTokens ────────────────────────────────────────────────────────────

const NFTS = [
  // Business 1 invoices
  {
    nftoken_id:     'NFT001ACME2024INV001',
    created_by:     ADDR.business1,
    invoice_number: 'INV-2024-001',
    face_value:     50_000,
    image_link:     'https://images.unsplash.com/photo-1554224311-beee910c1b8a?w=800&q=80',
    maturity_date:  daysFromNow(90),
    current_owner:  ADDR.business1,
    current_state:  'listed',
  },
  {
    nftoken_id:     'NFT002ACME2024INV002',
    created_by:     ADDR.business1,
    invoice_number: 'INV-2024-002',
    face_value:     75_000,
    image_link:     'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&q=80',
    maturity_date:  daysFromNow(60),
    current_owner:  ADDR.business1,
    current_state:  'listed',
  },
  // Business 2 invoices
  {
    nftoken_id:     'NFT003TECH2024INV003',
    created_by:     ADDR.business2,
    invoice_number: 'INV-2024-003',
    face_value:     120_000,
    image_link:     'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80',
    maturity_date:  daysFromNow(120),
    current_owner:  ADDR.business2,
    current_state:  'listed',
  },
  {
    nftoken_id:     'NFT004TECH2024INV004',
    created_by:     ADDR.business2,
    invoice_number: 'INV-2024-004',
    face_value:     95_000,
    image_link:     'https://images.unsplash.com/photo-1554224154-26032ffc0d07?w=800&q=80',
    maturity_date:  daysFromNow(45),
    current_owner:  ADDR.business2,
    current_state:  'owned',   // Already accepted, not yet listed
  },
  // A matured NFT (owned by investor1, payment due)
  {
    nftoken_id:     'NFT005ACME2023MATURED',
    created_by:     ADDR.business1,
    invoice_number: 'INV-2023-005',
    face_value:     30_000,
    image_link:     'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=800&q=80',
    maturity_date:  daysAgo(5),       // Matured 5 days ago
    current_owner:  ADDR.investor1,
    current_state:  'matured',
  },
];

async function seedNFTs() {
  console.log('🖼️   Seeding NFTs...');
  await upsert('NFTOKEN', NFTS, 'nftoken_id');
  console.log(`    ✓ ${NFTS.length} NFTs`);
}

// ── 3. Auction listings ────────────────────────────────────────────────────

async function seedAuctions() {
  console.log('🏷️   Seeding auction listings...');

  // Insert listings and capture generated IDs
  const listings = [
    {
      nftoken_id:         'NFT001ACME2024INV001',
      face_value:         50_000,
      expiry:             daysFromNow(7),
      min_bid:            45_000,
      current_bid:        47_500,
      original_owner:     ADDR.business1,
      platform_holds_nft: true,
      status:             'active',
    },
    {
      nftoken_id:         'NFT002ACME2024INV002',
      face_value:         75_000,
      expiry:             daysFromNow(5),
      min_bid:            68_000,
      current_bid:        70_000,
      original_owner:     ADDR.business1,
      platform_holds_nft: true,
      status:             'active',
    },
    {
      nftoken_id:         'NFT003TECH2024INV003',
      face_value:         120_000,
      expiry:             daysFromNow(10),
      min_bid:            110_000,
      current_bid:        115_000,
      original_owner:     ADDR.business2,
      platform_holds_nft: true,
      status:             'active',
    },
    // A completed auction (already settled)
    {
      nftoken_id:         'NFT005ACME2023MATURED',
      face_value:         30_000,
      expiry:             daysAgo(10),
      min_bid:            25_000,
      current_bid:        28_000,
      original_owner:     ADDR.business1,
      platform_holds_nft: false,
      status:             'completed',
      winner_address:     ADDR.investor1,
      final_price:        28_000,
      completed_at:       daysAgo(10),
    },
  ];

  const { data, error } = await supabase
    .from('AUCTIONLISTING')
    .insert(listings)
    .select('aid, nftoken_id');

  if (error) {
    // Already seeded — skip bids too
    if (error.code?.includes('23505') || error.message.includes('duplicate')) {
      console.log('    ↩  Auction listings already exist, skipping.');
      return null;
    }
    throw new Error(`[AUCTIONLISTING] ${error.message}`);
  }

  console.log(`    ✓ ${data.length} auction listings`);
  return data; // [{aid, nftoken_id}, ...]
}

// ── 4. Bids ────────────────────────────────────────────────────────────────

async function seedBids(listings) {
  if (!listings) return;
  console.log('💰  Seeding bids...');

  const bids = [];
  for (const { aid, nftoken_id } of listings) {
    // Skip the completed auction — its bid is seeded separately below
    if (nftoken_id === 'NFT005ACME2023MATURED') continue;

    // Two bids per active auction (investor1 lower, investor2 higher/current)
    const listing = [
      { nftoken_id: 'NFT001ACME2024INV001', min: 45_000, cur: 47_500 },
      { nftoken_id: 'NFT002ACME2024INV002', min: 68_000, cur: 70_000 },
      { nftoken_id: 'NFT003TECH2024INV003', min: 110_000, cur: 115_000 },
    ].find(l => l.nftoken_id === nftoken_id);

    if (!listing) continue;

    bids.push(
      { aid, bid_amount: listing.min, bid_by: ADDR.investor1, check_status: 'active' },
      { aid, bid_amount: listing.cur, bid_by: ADDR.investor2, check_status: 'active' },
    );
  }

  // Completed auction — investor1 won and paid
  const completedAid = listings.find(l => l.nftoken_id === 'NFT005ACME2023MATURED')?.aid;
  if (completedAid) {
    const { data: winningBid } = await supabase
      .from('AUCTIONBIDS')
      .insert({ aid: completedAid, bid_amount: 28_000, bid_by: ADDR.investor1, check_status: 'paid' })
      .select('bid_id')
      .single();

    // Set winning_bid_id on the completed listing
    if (winningBid) {
      await supabase
        .from('AUCTIONLISTING')
        .update({ winning_bid_id: winningBid.bid_id })
        .eq('aid', completedAid);
    }
  }

  if (bids.length) await insert('AUCTIONBIDS', bids);
  console.log(`    ✓ ${bids.length + 1} bids across ${listings.length} auctions`);
}

// ── 5. Maturity payment ────────────────────────────────────────────────────

async function seedMaturityPayment() {
  console.log('📅  Seeding maturity payment...');
  await insert('MATURITY_PAYMENT', [{
    nftoken_id:      'NFT005ACME2023MATURED',
    debtor_address:  ADDR.business1,    // owes the money
    creditor_address: ADDR.investor1,   // is owed the money
    payment_amount:  30_000,
    maturity_date:   daysAgo(5),
    check_status:    'pending',
  }]);
  console.log('    ✓ 1 maturity payment (pending)');
}

// ── 6. Audit log seed entries ──────────────────────────────────────────────

async function seedAuditLog() {
  console.log('📋  Seeding audit log...');
  await insert('AUDIT_LOG', [
    {
      actor_address: ADDR.business1,
      action:        'NFT_MINTED',
      entity_type:   'NFTOKEN',
      entity_id:     'NFT001ACME2024INV001',
      metadata:      { invoice_number: 'INV-2024-001', face_value: 50000 },
    },
    {
      actor_address: ADDR.investor1,
      action:        'BID_PLACED',
      entity_type:   'AUCTIONBIDS',
      entity_id:     'seed',
      metadata:      { auction_id: 1, bid_amount: 28000, note: 'seed data' },
    },
    {
      actor_address: ADDR.investor1,
      action:        'AUCTION_SETTLED',
      entity_type:   'AUCTIONLISTING',
      entity_id:     'seed',
      metadata:      { nftoken_id: 'NFT005ACME2023MATURED', final_price: 28000 },
    },
  ]);
  console.log('    ✓ 3 audit log entries');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  RLFactor seed starting...\n');
  console.log('Derived demo addresses:');
  for (const [name, addr] of Object.entries(ADDR)) {
    console.log(`  ${name.padEnd(10)} ${addr}`);
  }
  console.log();

  try {
    await seedUsers();
    await seedNFTs();
    const listings = await seedAuctions();
    await seedBids(listings);
    await seedMaturityPayment();
    await seedAuditLog();
    console.log('\n✅  Seed complete.\n');
  } catch (err) {
    console.error('\n❌  Seed failed:', err.message);
    process.exit(1);
  }
}

main();
