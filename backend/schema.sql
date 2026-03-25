-- ============================================================
-- RLFactor — Consolidated Database Schema
-- Single source of truth for fresh database provisioning.
-- Run this file once on a new Supabase / PostgreSQL instance.
-- Replaces all incremental migration files 003–009.
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ============================================================
-- TABLE: USER
-- Stores all platform users regardless of role.
-- publicKey is the XRPL address, used as the natural PK so
-- it doubles as the on-chain identity (no surrogate UUID needed).
-- ============================================================

CREATE TABLE IF NOT EXISTS "USER" (
  "publicKey"  VARCHAR(100) PRIMARY KEY,
  role         VARCHAR(20)  NOT NULL,
  username     VARCHAR(100) NOT NULL UNIQUE,

  CONSTRAINT check_user_role
    CHECK (role IN ('investor', 'business', 'admin'))
);

COMMENT ON TABLE  "USER"            IS 'Platform users identified by their XRPL wallet address';
COMMENT ON COLUMN "USER"."publicKey" IS 'XRPL wallet address — serves as both PK and on-chain identity';
COMMENT ON COLUMN "USER".role        IS 'investor: bidder, business: invoice issuer, admin: platform operator';

-- ============================================================
-- TABLE: NFTOKEN
-- Represents a tokenized invoice NFT on the XRP Ledger.
-- Lifecycle: minting → issued → owned → listed → matured → redeemed
--            (or failed if minting background job errors out)
-- ============================================================

CREATE TABLE IF NOT EXISTS "NFTOKEN" (
  nftoken_id    VARCHAR(100) PRIMARY KEY,          -- Real NFTokenID from XRPL (or temp ID while minting)
  created_by    VARCHAR(100) REFERENCES "USER"("publicKey") ON DELETE SET NULL,
  invoice_number VARCHAR(100),
  face_value    DECIMAL(20, 2),
  image_link    TEXT,
  maturity_date TIMESTAMP WITHOUT TIME ZONE,
  current_owner VARCHAR(100) REFERENCES "USER"("publicKey") ON DELETE SET NULL,
  current_state VARCHAR(20) NOT NULL DEFAULT 'minting',

  CONSTRAINT check_nft_state
    CHECK (current_state IN ('minting', 'issued', 'owned', 'listed', 'matured', 'redeemed', 'failed'))
);

COMMENT ON TABLE  "NFTOKEN"               IS 'Invoice NFTs; row created at minting-start, nftoken_id swapped to real XRPL ID once confirmed';
COMMENT ON COLUMN "NFTOKEN".current_state  IS 'minting: background job running | issued: minted, offer open | owned: accepted by creditor | listed: on auction | matured: payment due | redeemed: paid | failed: mint error';

CREATE INDEX IF NOT EXISTS idx_nftoken_owner_state  ON "NFTOKEN"(current_owner, current_state);
CREATE INDEX IF NOT EXISTS idx_nftoken_creator       ON "NFTOKEN"(created_by);
CREATE INDEX IF NOT EXISTS idx_nftoken_maturity      ON "NFTOKEN"(maturity_date) WHERE current_state IN ('owned', 'matured');

-- ============================================================
-- TABLE: AUCTIONLISTING
-- One row per auction event for an NFT.
-- An NFT can be listed more than once (e.g. re-listed after no bids),
-- but only one active listing per NFT at a time (partial unique index).
-- ============================================================

CREATE TABLE IF NOT EXISTS "AUCTIONLISTING" (
  aid                   BIGSERIAL    PRIMARY KEY,
  nftoken_id            VARCHAR(100) REFERENCES "NFTOKEN"(nftoken_id) ON DELETE SET NULL,
  face_value            DECIMAL(20, 2),
  expiry                TIMESTAMP WITHOUT TIME ZONE,
  min_bid               DECIMAL(20, 2),
  current_bid           DECIMAL(20, 2),
  time_created          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Ownership / custody
  original_owner        VARCHAR(100) REFERENCES "USER"("publicKey") ON DELETE SET NULL,
  platform_holds_nft    BOOLEAN      NOT NULL DEFAULT FALSE,
  nft_received_tx_hash  VARCHAR(100),           -- TX hash when NFT entered platform custody

  -- Lifecycle
  status                VARCHAR(20)  NOT NULL DEFAULT 'active',
  winner_address        VARCHAR(100),
  final_price           DECIMAL(20, 2),
  winning_bid_id        BIGINT,                 -- FK added after AUCTIONBIDS is created (see below)
  completed_at          TIMESTAMPTZ,
  unlisted_at           TIMESTAMPTZ,

  -- XRPL settlement hashes
  payment_tx_hash       VARCHAR(100),
  nft_transfer_tx_hash  VARCHAR(100),

  CONSTRAINT check_auction_status
    CHECK (status IN ('active', 'completed', 'unlisted'))
);

COMMENT ON TABLE  "AUCTIONLISTING"                  IS 'Auction events for invoice NFTs; one active listing per NFT enforced by partial unique index';
COMMENT ON COLUMN "AUCTIONLISTING".original_owner    IS 'XRPL address of the business that listed the NFT; used to return NFT if all bids fail';
COMMENT ON COLUMN "AUCTIONLISTING".platform_holds_nft IS 'TRUE while platform wallet has custody; FALSE after NFT is returned or transferred to winner';
COMMENT ON COLUMN "AUCTIONLISTING".winning_bid_id     IS 'FK to AUCTIONBIDS.bid_id of the winning bid once auction is completed';

-- Only one active listing per NFT at any given time
CREATE UNIQUE INDEX IF NOT EXISTS uq_auctionlisting_active_nft
  ON "AUCTIONLISTING"(nftoken_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_auction_status        ON "AUCTIONLISTING"(status);
CREATE INDEX IF NOT EXISTS idx_auction_expiry_status ON "AUCTIONLISTING"(expiry, status);
CREATE INDEX IF NOT EXISTS idx_auction_owner         ON "AUCTIONLISTING"(original_owner);

-- ============================================================
-- TABLE: AUCTIONBIDS
-- One row per bid attempt. A user may rebid (their existing active
-- bid is updated by place_bid_atomic). Partial unique index
-- enforces at most one active bid per (auction, bidder) pair at
-- the DB level, complementing the SELECT FOR UPDATE in the RPC.
-- ============================================================

CREATE TABLE IF NOT EXISTS "AUCTIONBIDS" (
  bid_id              BIGSERIAL    PRIMARY KEY,
  aid                 BIGINT       NOT NULL REFERENCES "AUCTIONLISTING"(aid) ON DELETE CASCADE,
  bid_amount          DECIMAL(20, 2) NOT NULL,
  bid_by              VARCHAR(100) NOT NULL REFERENCES "USER"("publicKey") ON DELETE CASCADE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Lifecycle
  check_status        VARCHAR(20)  NOT NULL DEFAULT 'active',

  -- XRPL Check tracking (current payment mechanism)
  xrpl_check_id       VARCHAR(100),
  xrpl_check_tx_hash  VARCHAR(100),

  -- Legacy XRPL Escrow columns (kept for historical rows; unused in new bids)
  xrpl_escrow_sequence  INTEGER,
  xrpl_escrow_tx_hash   VARCHAR(100),
  escrow_finish_after   TIMESTAMPTZ,
  escrow_cancel_after   TIMESTAMPTZ,
  escrow_status         VARCHAR(20) DEFAULT 'active',

  CONSTRAINT check_bid_status
    CHECK (check_status IN ('active', 'won_unpaid', 'paid', 'cashed', 'pending_cash', 'cancelled'))
);

COMMENT ON TABLE  "AUCTIONBIDS"                IS 'Bids on auction listings; place_bid_atomic RPC enforces concurrency safety';
COMMENT ON COLUMN "AUCTIONBIDS".check_status    IS 'active: bidding open | won_unpaid: winner selected, awaiting payment | paid: NFT claimed | pending_cash: owner must cash Check | cancelled: bid withdrawn';
COMMENT ON COLUMN "AUCTIONBIDS".xrpl_check_id   IS 'XRPL Check LedgerIndex, used to cash/cancel at settlement';

-- At most one active bid per (auction, bidder) — enforces the upsert logic at DB level
CREATE UNIQUE INDEX IF NOT EXISTS uq_auctionbids_active_per_bidder
  ON "AUCTIONBIDS"(aid, bid_by)
  WHERE check_status = 'active';

CREATE INDEX IF NOT EXISTS idx_bid_auction_status   ON "AUCTIONBIDS"(aid, check_status);
CREATE INDEX IF NOT EXISTS idx_bid_bidder_status    ON "AUCTIONBIDS"(bid_by, check_status);

-- Back-reference FK from AUCTIONLISTING → AUCTIONBIDS (deferred until AUCTIONBIDS exists)
ALTER TABLE "AUCTIONLISTING"
  ADD CONSTRAINT fk_winning_bid
  FOREIGN KEY (winning_bid_id) REFERENCES "AUCTIONBIDS"(bid_id) ON DELETE SET NULL;

-- ============================================================
-- TABLE: MATURITY_PAYMENT
-- Tracks the payment a debtor owes an investor when an invoice
-- NFT reaches its maturity date.
--
-- Idempotency:
--   • UNIQUE(nftoken_id) — one payment record per NFT, ever.
--     The scheduler checks this at the app layer too, but the
--     constraint is the definitive guard against race conditions
--     and duplicate scheduler runs.
--   • idempotency_key — client-supplied UUID for the "create
--     payment" API call; lets the client safely retry on network
--     failure without creating duplicate rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS "MATURITY_PAYMENT" (
  payment_id          BIGSERIAL    PRIMARY KEY,
  nftoken_id          VARCHAR(100) NOT NULL UNIQUE    -- one payment per NFT, enforced at DB level
                        REFERENCES "NFTOKEN"(nftoken_id) ON DELETE CASCADE,

  -- Idempotency key supplied by the caller (scheduler or API client).
  -- If the same key is submitted twice, the second INSERT fails with a
  -- unique violation, which the caller can treat as "already created".
  idempotency_key     UUID         NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  -- Payment parties
  debtor_address      VARCHAR(100) NOT NULL,          -- NFT creator — owes payment
  creditor_address    VARCHAR(100) NOT NULL,          -- Current NFT holder — is owed payment

  -- Payment details
  payment_amount      DECIMAL(20, 2) NOT NULL,        -- Face value of invoice
  maturity_date       TIMESTAMP    NOT NULL,

  -- Lifecycle
  check_status        VARCHAR(20)  NOT NULL DEFAULT 'pending',

  -- XRPL Check tracking
  xrpl_check_id       VARCHAR(100),
  xrpl_check_tx_hash  VARCHAR(100),

  -- Timestamps
  notified_at         TIMESTAMP,
  check_created_at    TIMESTAMP,
  paid_at             TIMESTAMP,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT check_payment_amount_positive
    CHECK (payment_amount > 0),

  CONSTRAINT check_payment_status
    CHECK (check_status IN ('pending', 'created', 'cashed', 'overdue', 'completed'))
);

COMMENT ON TABLE  "MATURITY_PAYMENT"                  IS 'Invoice maturity payments owed by debtors to NFT-holding investors';
COMMENT ON COLUMN "MATURITY_PAYMENT".idempotency_key   IS 'Client-supplied UUID; retry-safe — duplicate key = already created, return existing row';
COMMENT ON COLUMN "MATURITY_PAYMENT".nftoken_id        IS 'UNIQUE — one payment record per NFT for its entire lifecycle';
COMMENT ON COLUMN "MATURITY_PAYMENT".check_status      IS 'pending → created → cashed/completed | overdue if past maturity without payment';

CREATE INDEX IF NOT EXISTS idx_maturity_debtor    ON "MATURITY_PAYMENT"(debtor_address, check_status);
CREATE INDEX IF NOT EXISTS idx_maturity_creditor  ON "MATURITY_PAYMENT"(creditor_address, check_status);
CREATE INDEX IF NOT EXISTS idx_maturity_overdue   ON "MATURITY_PAYMENT"(maturity_date, check_status)
  WHERE check_status IN ('pending', 'created');

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_maturity_payment_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maturity_payment_updated_at ON "MATURITY_PAYMENT";
CREATE TRIGGER trg_maturity_payment_updated_at
  BEFORE UPDATE ON "MATURITY_PAYMENT"
  FOR EACH ROW EXECUTE FUNCTION update_maturity_payment_timestamp();

-- ============================================================
-- TABLE: AUDIT_LOG
-- Immutable append-only compliance trail for all platform actions.
-- No UPDATE or DELETE should ever touch this table in production.
-- ============================================================

CREATE TABLE IF NOT EXISTS "AUDIT_LOG" (
  log_id        BIGSERIAL    PRIMARY KEY,
  actor_address VARCHAR(100) NOT NULL,              -- XRPL address of the user who triggered the action
  action        VARCHAR(50)  NOT NULL,              -- Uppercase snake_case: BID_PLACED, AUCTION_FINALIZED, etc.
  entity_type   VARCHAR(50),                        -- Table name of the affected row, e.g. AUCTIONBIDS
  entity_id     VARCHAR(100),                       -- PK of the affected row (cast to TEXT)
  metadata      JSONB        NOT NULL DEFAULT '{}', -- Event-specific payload
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  "AUDIT_LOG"            IS 'Append-only compliance trail — never UPDATE or DELETE rows';
COMMENT ON COLUMN "AUDIT_LOG".action      IS 'Uppercase snake_case label, e.g. BID_PLACED, AUCTION_FINALIZED, NFT_MINTED, ADMIN_FINALIZE';
COMMENT ON COLUMN "AUDIT_LOG".metadata    IS 'JSON payload with event-specific fields (bid_amount, tx_hash, auction_id, etc.)';

CREATE INDEX IF NOT EXISTS idx_audit_actor   ON "AUDIT_LOG"(actor_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON "AUDIT_LOG"(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON "AUDIT_LOG"(entity_type, entity_id);

-- ============================================================
-- FUNCTION: place_bid_atomic
-- Atomically places or updates a bid using SELECT FOR UPDATE to
-- acquire a row-level lock on the auction for the duration of
-- the transaction. Concurrent calls for the same auction block
-- at this lock, preventing double-bids and race conditions.
-- Also writes an AUDIT_LOG entry inside the same transaction.
-- ============================================================

CREATE OR REPLACE FUNCTION place_bid_atomic(
  p_auction_id  BIGINT,
  p_bidder      TEXT,
  p_bid_amount  NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_auction       "AUCTIONLISTING"%ROWTYPE;
  v_existing_bid  "AUCTIONBIDS"%ROWTYPE;
  v_bid           "AUCTIONBIDS"%ROWTYPE;
  v_new_top_bid   NUMERIC;
BEGIN
  -- Acquire row-level lock on the auction.
  -- Concurrent calls block here until this transaction commits.
  SELECT * INTO v_auction
  FROM "AUCTIONLISTING"
  WHERE aid = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction not found');
  END IF;

  IF v_auction.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction is no longer active');
  END IF;

  IF v_auction.expiry <= NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction has expired');
  END IF;

  IF p_bid_amount < v_auction.min_bid THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   format('Bid must be at least %s RLUSD', v_auction.min_bid),
      'min_bid', v_auction.min_bid
    );
  END IF;

  -- Upsert: update existing active bid or insert a new one
  SELECT * INTO v_existing_bid
  FROM "AUCTIONBIDS"
  WHERE aid = p_auction_id AND bid_by = p_bidder AND check_status = 'active'
  LIMIT 1;

  IF FOUND THEN
    UPDATE "AUCTIONBIDS"
       SET bid_amount = p_bid_amount, created_at = NOW()
     WHERE bid_id = v_existing_bid.bid_id
    RETURNING * INTO v_bid;
  ELSE
    INSERT INTO "AUCTIONBIDS" (aid, bid_amount, bid_by, check_status)
    VALUES (p_auction_id, p_bid_amount, p_bidder, 'active')
    RETURNING * INTO v_bid;
  END IF;

  -- Recompute current_bid from all active bids (still inside the lock)
  SELECT COALESCE(MAX(bid_amount), v_auction.min_bid)
  INTO   v_new_top_bid
  FROM   "AUCTIONBIDS"
  WHERE  aid = p_auction_id AND check_status = 'active';

  UPDATE "AUCTIONLISTING"
     SET current_bid = v_new_top_bid
   WHERE aid = p_auction_id;

  -- Audit entry
  INSERT INTO "AUDIT_LOG" (actor_address, action, entity_type, entity_id, metadata)
  VALUES (
    p_bidder,
    'BID_PLACED',
    'AUCTIONBIDS',
    v_bid.bid_id::TEXT,
    jsonb_build_object(
      'auction_id',  p_auction_id,
      'bid_amount',  p_bid_amount,
      'new_top_bid', v_new_top_bid,
      'is_update',   (v_existing_bid.bid_id IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok',          true,
    'bid',         row_to_json(v_bid),
    'current_bid', v_new_top_bid
  );
END;
$$;

COMMENT ON FUNCTION place_bid_atomic IS
  'Atomically places or updates a bid with SELECT FOR UPDATE locking. Safe under concurrent load.';

-- ============================================================
-- ROW-LEVEL SECURITY (Supabase)
-- Permissive policies — tighten per role in production.
-- ============================================================

ALTER TABLE "USER"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NFTOKEN"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AUCTIONLISTING"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AUCTIONBIDS"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MATURITY_PAYMENT" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AUDIT_LOG"        ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated operations for now (tighten in production)
CREATE POLICY "allow_all_user"             ON "USER"             FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_nftoken"          ON "NFTOKEN"          FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_auctionlisting"   ON "AUCTIONLISTING"   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_auctionbids"      ON "AUCTIONBIDS"      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_maturity_payment" ON "MATURITY_PAYMENT" FOR ALL USING (true) WITH CHECK (true);
-- AUDIT_LOG: readable by all, but only insertable (no update/delete)
CREATE POLICY "allow_read_audit"           ON "AUDIT_LOG"        FOR SELECT USING (true);
CREATE POLICY "allow_insert_audit"         ON "AUDIT_LOG"        FOR INSERT WITH CHECK (true);
