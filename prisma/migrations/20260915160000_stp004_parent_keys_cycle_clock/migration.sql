-- STP 004: AuthChallenge parent-key CHECKs (MATCH SIMPLE completeness) and
-- replacement anti-cycle locks covering both sessions with post-lock re-read.
-- Does not rewrite 20260914000000, 20260914170000, or 20260914233000.
-- Does not guess-fill historical lookup aliases or replacement pointers.

-- 1) Identity/account parent key is all-null or all-present so identity composite FK cannot be skipped.
ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_identity_parent_ck"
  CHECK (("auth_identity_id" IS NULL) = ("account_id" IS NULL));

-- 2) Lookup alias parent key is complete whenever identity is stamped so lookup MATCH SIMPLE FK applies.
ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_lookup_parent_ck"
  CHECK (
    "auth_identity_id" IS NULL
    OR (
      "auth_identity_id" IS NOT NULL
      AND "provider" IS NOT NULL
      AND "identity_kind" IS NOT NULL
      AND "destination_lookup_key_version" IS NOT NULL
      AND "destination_lookup_digest" IS NOT NULL
    )
  );

-- 3) Replacement anti-cycle: lock both ends in id order, re-read after the wait, walk successors under row locks.
CREATE OR REPLACE FUNCTION ss_device_sessions_replacement_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  succ RECORD;
  walk UUID;
  seen UUID[] := ARRAY[]::UUID[];
  pred_account UUID;
  succ_account UUID;
BEGIN
  IF NEW.replaced_by_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.replaced_by_session_id = NEW.id THEN
    RAISE EXCEPTION 'session replacement cannot point to self'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
    FROM device_sessions
   WHERE id IN (NEW.id, NEW.replaced_by_session_id)
   ORDER BY id
     FOR UPDATE;

  SELECT * INTO succ
    FROM device_sessions
   WHERE id = NEW.replaced_by_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session replacement successor missing'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.device_installation_digest IS DISTINCT FROM succ.device_installation_digest THEN
    RAISE EXCEPTION 'session replacement device digest mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  pred_account := COALESCE(NEW.account_id, NEW.issued_by_account_id);
  succ_account := COALESCE(succ.account_id, succ.issued_by_account_id);
  IF pred_account IS DISTINCT FROM succ_account THEN
    RAISE EXCEPTION 'session replacement account mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scope = 'GUARDIAN' AND succ.scope = 'STUDENT' THEN
    IF NEW.account_id IS DISTINCT FROM succ.issued_by_account_id THEN
      RAISE EXCEPTION 'guardian to student replacement issuer mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.scope = 'STUDENT' AND succ.scope = 'GUARDIAN' THEN
    IF NEW.issued_by_account_id IS DISTINCT FROM succ.account_id THEN
      RAISE EXCEPTION 'student to guardian replacement account mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'session replacement scope direction invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  walk := succ.replaced_by_session_id;
  WHILE walk IS NOT NULL LOOP
    IF walk = NEW.id OR walk = ANY(seen) THEN
      RAISE EXCEPTION 'session replacement cycle'
        USING ERRCODE = 'check_violation';
    END IF;
    seen := array_append(seen, walk);
    SELECT replaced_by_session_id
      INTO walk
      FROM device_sessions
     WHERE id = walk
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'session replacement successor missing'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
