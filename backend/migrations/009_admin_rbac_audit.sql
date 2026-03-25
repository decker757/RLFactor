-- Migration: Admin Role, RBAC, Audit Log, and Atomic Bid Placement
-- Adds: admin role to USER, AUDIT_LOG table (6th table), place_bid_atomic RPC

-- =====================================================
-- USER TABLE - ADD ADMIN ROLE
-- =====================================================

-- Drop old role constraint
ALTER TABLE "USER"
DROP CONSTRAINT IF EXISTS check_user_role;

-- Add new constraint including admin
ALTER TABLE "USER"
ADD CONSTRAINT check_user_role
CHECK (role IN ('investor', 'business', 'admin'));

COMMENT ON COLUMN "USER".role IS 'User role: investor (bidder), business (NFT issuer), admin (platform operator)';

-- =====================================================
-- AUDIT_LOG TABLE - COMPLIANCE TRAIL (6th table)
-- =====================================================

CREATE TABLE IF NOT EXISTS "AUDIT_LOG" (
  log_id        BIGSERIAL PRIMARY KEY,
  actor_address VARCHAR(100) NOT NULL,          -- XRPL address of user who triggered action
  action        VARCHAR(50)  NOT NULL,           -- e.g. 'BID_PLACED', 'AUCTION_FINALIZED', 'NFT_MINTED'
  entity_type   VARCHAR(50),                     -- e.g. 'AUCTIONBIDS', 'AUCTIONLISTING', 'NFTOKEN'
  entity_id     VARCHAR(100),                    -- PK of affected row (cast to text for flexibility)
  metadata      JSONB        DEFAULT '{}',       -- arbitrary event payload
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

COMMENT ON TABLE "AUDIT_LOG" IS 'Immutable audit trail of all platform actions for compliance and debugging';
COMMENT ON COLUMN "AUDIT_LOG".action IS 'Uppercase snake_case action label, e.g. BID_PLACED, AUCTION_FINALIZED, ADMIN_FINALIZE';
COMMENT ON COLUMN "AUDIT_LOG".metadata IS 'JSON payload with event-specific details (bid_amount, auction_id, tx_hash, etc.)';

CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON "AUDIT_LOG"(actor_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON "AUDIT_LOG"(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity  ON "AUDIT_LOG"(entity_type, entity_id);

-- =====================================================
-- ATOMIC BID PLACEMENT FUNCTION (prevents double-bids)
-- Uses SELECT FOR UPDATE to lock the auction row so
-- concurrent requests cannot produce duplicate active bids
-- =====================================================

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
  -- Lock the auction row for the duration of this transaction.
  -- Any concurrent call to place_bid_atomic for the same auction
  -- will block here until we COMMIT, preventing race conditions.
  SELECT * INTO v_auction
  FROM "AUCTIONLISTING"
  WHERE aid = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction not found');
  END IF;

  -- Guard: auction must still be active
  IF v_auction.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction is no longer active');
  END IF;

  IF v_auction.expiry <= NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Auction has expired');
  END IF;

  IF p_bid_amount < v_auction.min_bid THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Bid must be at least %s RLUSD', v_auction.min_bid),
      'min_bid', v_auction.min_bid
    );
  END IF;

  -- Upsert bid: update if this bidder already has an active bid, else insert
  SELECT * INTO v_existing_bid
  FROM "AUCTIONBIDS"
  WHERE aid = p_auction_id
    AND bid_by = p_bidder
    AND check_status = 'active'
  LIMIT 1;

  IF FOUND THEN
    UPDATE "AUCTIONBIDS"
    SET bid_amount = p_bid_amount,
        created_at = NOW()
    WHERE bid_id = v_existing_bid.bid_id
    RETURNING * INTO v_bid;
  ELSE
    INSERT INTO "AUCTIONBIDS" (aid, bid_amount, bid_by, check_status)
    VALUES (p_auction_id, p_bid_amount, p_bidder, 'active')
    RETURNING * INTO v_bid;
  END IF;

  -- Recompute current_bid from all active bids (still inside the lock)
  SELECT COALESCE(MAX(bid_amount), v_auction.min_bid)
  INTO v_new_top_bid
  FROM "AUCTIONBIDS"
  WHERE aid = p_auction_id
    AND check_status = 'active';

  UPDATE "AUCTIONLISTING"
  SET current_bid = v_new_top_bid
  WHERE aid = p_auction_id;

  -- Write audit entry
  INSERT INTO "AUDIT_LOG" (actor_address, action, entity_type, entity_id, metadata)
  VALUES (
    p_bidder,
    'BID_PLACED',
    'AUCTIONBIDS',
    v_bid.bid_id::TEXT,
    jsonb_build_object(
      'auction_id',     p_auction_id,
      'bid_amount',     p_bid_amount,
      'new_top_bid',    v_new_top_bid,
      'is_update',      (v_existing_bid.bid_id IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok',           true,
    'bid',          row_to_json(v_bid),
    'current_bid',  v_new_top_bid
  );
END;
$$;

COMMENT ON FUNCTION place_bid_atomic IS
  'Atomically places or updates a bid using SELECT FOR UPDATE to prevent double-bids under concurrent load.';
