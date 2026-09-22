-- STP 006 twelfth migration: null-safe standing-job state_reason CHECK.
-- Migration 11 is frozen. Do not rewrite it.

DO $$
BEGIN
  IF to_regclass('task_horizon_jobs') IS NULL THEN
    RAISE EXCEPTION 'stp006 twelfth: task_horizon_jobs missing; leaving data untouched';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM task_horizon_jobs
     WHERE state IN ('BLOCKED', 'FAILED', 'RETIRED')
       AND state_reason IS NULL
  ) THEN
    RAISE EXCEPTION 'stp006 twelfth: BLOCKED/FAILED/RETIRED rows with NULL state_reason; leaving data untouched';
  END IF;
END $$;

ALTER TABLE task_horizon_jobs
  DROP CONSTRAINT task_horizon_jobs_reason_check;

ALTER TABLE task_horizon_jobs
  ADD CONSTRAINT task_horizon_jobs_reason_check
    CHECK (
      (
        state = 'BLOCKED'
        AND state_reason IS NOT NULL
        AND state_reason IN (
          'PLAN_PAUSED',
          'PROFILE_NOT_ACTIVE',
          'AGE_NOT_SUPPORTED',
          'ACCOUNT_NOT_ACTIVE',
          'GUARDIAN_LINK_NOT_ACTIVE',
          'CONSENT_REQUIRED',
          'CONSENT_SCOPE_MISSING',
          'EDUCATION_INVALID',
          'DATE_OCCUPIED'
        )
      )
      OR (
        state = 'FAILED'
        AND state_reason IS NOT NULL
        AND state_reason IN ('SCOPE_LIMIT', 'RETRY_EXHAUSTED')
      )
      OR (
        state = 'RETIRED'
        AND state_reason IS NOT NULL
        AND state_reason IN ('PLAN_ARCHIVED', 'PROFILE_DELETION')
      )
      OR (
        state IN ('READY', 'LEASED')
        AND state_reason IS NULL
      )
    );
