-- STP 004 additive constraint for GUARDIAN_STEP_UP binding.
-- Forward: CREATE FUNCTION/TRIGGER below.
-- Rollback: DROP TRIGGER ss_auth_challenges_step_up_bound_trg ON auth_challenges;
--           DROP FUNCTION ss_auth_challenges_step_up_bound();
-- Does not rewrite 20260914000000_stp004_identity_profiles_consents.

CREATE OR REPLACE FUNCTION ss_auth_challenges_step_up_bound() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sess RECORD;
BEGIN
  IF NEW.purpose IS DISTINCT FROM 'GUARDIAN_STEP_UP' THEN
    RETURN NEW;
  END IF;
  IF NEW.bound_session_id IS NULL OR NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'step-up challenge must bind a session and account'
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
