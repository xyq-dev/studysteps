-- STP 004 expand: lookup alias FK, replacement 1:1, issue-fact immutability, aligned step-up trigger.
-- Does not rewrite 20260914000000 or 20260914170000.
-- Does NOT require replacement reason to have a pointer (old writers may revoke without successor).
-- Forward: statements below.
-- Rollback (isolation only, not executed this round): drop new FK/triggers/checks/unique; restore 20260914170000 step-up function body if needed.

-- 1) AuthChallenge → AuthIdentityLookup five-column MATCH SIMPLE FK.
-- PostgreSQL default MATCH SIMPLE: if any referencing column is NULL, the row is not required to match.
-- First SIGN_IN may insert with auth_identity_id/account_id NULL; consume backfills after lookup exists.
ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_lookup_alias_fkey"
  FOREIGN KEY (
    "auth_identity_id",
    "provider",
    "identity_kind",
    "destination_lookup_key_version",
    "destination_lookup_digest"
  )
  REFERENCES "auth_identity_lookups" (
    "auth_identity_id",
    "provider",
    "kind",
    "lookup_key_version",
    "subject_lookup_digest"
  )
  MATCH SIMPLE
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

-- 2) Align step-up bound trigger with design terms: identity belongs to account;
-- Guardian account_id OR Student issued_by_account_id equals challenge account;
-- device digest equals bound session.
CREATE OR REPLACE FUNCTION ss_auth_challenges_step_up_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sess RECORD;
  ident_account UUID;
BEGIN
  IF NEW.purpose IS DISTINCT FROM 'GUARDIAN_STEP_UP' THEN
    RETURN NEW;
  END IF;
  IF NEW.bound_session_id IS NULL OR NEW.account_id IS NULL OR NEW.auth_identity_id IS NULL THEN
    RAISE EXCEPTION 'step-up challenge must bind a session, account and identity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT account_id
    INTO ident_account
    FROM auth_identities
   WHERE id = NEW.auth_identity_id;
  IF NOT FOUND OR ident_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'step-up identity does not belong to challenge account'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT *
    INTO sess
    FROM device_sessions
   WHERE id = NEW.bound_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step-up bound session missing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF sess.device_installation_digest IS DISTINCT FROM NEW.device_installation_digest THEN
    RAISE EXCEPTION 'step-up device digest mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF sess.scope = 'STUDENT' THEN
    IF sess.issued_by_account_id IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'step-up bound student session account mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sess.scope = 'GUARDIAN' THEN
    IF sess.account_id IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'step-up bound guardian session account mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'step-up bound session scope invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ss_auth_challenges_step_up_bound_trg ON auth_challenges;
CREATE TRIGGER ss_auth_challenges_step_up_bound_trg
  BEFORE INSERT OR UPDATE ON auth_challenges
  FOR EACH ROW
  EXECUTE FUNCTION ss_auth_challenges_step_up_bound();

-- 3) DeviceSession issue facts are immutable after insert.
CREATE OR REPLACE FUNCTION ss_device_sessions_issue_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.student_profile_id IS DISTINCT FROM OLD.student_profile_id
     OR NEW.issued_by_guardian_link_id IS DISTINCT FROM OLD.issued_by_guardian_link_id
     OR NEW.issued_by_account_id IS DISTINCT FROM OLD.issued_by_account_id
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.credential_digest IS DISTINCT FROM OLD.credential_digest
     OR NEW.csrf_digest IS DISTINCT FROM OLD.csrf_digest
     OR NEW.account_auth_version_at_issue IS DISTINCT FROM OLD.account_auth_version_at_issue
     OR NEW.issuer_auth_version_at_issue IS DISTINCT FROM OLD.issuer_auth_version_at_issue
     OR NEW.device_installation_digest IS DISTINCT FROM OLD.device_installation_digest
     OR NEW.device_label IS DISTINCT FROM OLD.device_label
     OR NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at
     OR NEW.step_up_verified_at IS DISTINCT FROM OLD.step_up_verified_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device session issue facts are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ss_device_sessions_issue_immutable_trg ON device_sessions;
CREATE TRIGGER ss_device_sessions_issue_immutable_trg
  BEFORE UPDATE ON device_sessions
  FOR EACH ROW
  EXECUTE FUNCTION ss_device_sessions_issue_immutable();

-- 4) replaced_by_session_id is 1:1; pointer implies revoked + reason; account/device/scope direction/anti-cycle.
CREATE UNIQUE INDEX IF NOT EXISTS "device_sessions_replaced_by_session_id_key"
  ON "device_sessions" ("replaced_by_session_id");

ALTER TABLE "device_sessions"
  DROP CONSTRAINT IF EXISTS "device_sessions_replaced_pointer_ck";
ALTER TABLE "device_sessions"
  ADD CONSTRAINT "device_sessions_replaced_pointer_ck"
  CHECK (
    "replaced_by_session_id" IS NULL
    OR ("revoked_at" IS NOT NULL AND "revocation_reason_code" IS NOT NULL)
  );

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
  SELECT * INTO succ FROM device_sessions WHERE id = NEW.replaced_by_session_id;
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
    SELECT replaced_by_session_id INTO walk FROM device_sessions WHERE id = walk;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ss_device_sessions_replacement_guard_trg ON device_sessions;
CREATE TRIGGER ss_device_sessions_replacement_guard_trg
  BEFORE INSERT OR UPDATE OF replaced_by_session_id ON device_sessions
  FOR EACH ROW
  EXECUTE FUNCTION ss_device_sessions_replacement_guard();
