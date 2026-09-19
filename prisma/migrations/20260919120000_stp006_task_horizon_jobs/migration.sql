-- STP 006-D eleventh migration: per-plan standing-job. Migrations 1-10 are frozen.
-- Readonly precheck: refuse unexpected plan statuses or a pre-existing job table.

DO $$
BEGIN
  IF to_regclass('task_horizon_jobs') IS NOT NULL THEN
    RAISE EXCEPTION 'stp006 eleventh: task_horizon_jobs already exists; leaving data untouched';
  END IF;
  IF EXISTS (
    SELECT 1 FROM study_plans WHERE status IS NULL OR status NOT IN ('ACTIVE', 'PAUSED', 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'stp006 eleventh: unexpected study_plan.status; leaving data untouched';
  END IF;
END $$;

CREATE TABLE task_horizon_jobs (
  plan_id UUID PRIMARY KEY REFERENCES study_plans(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  available_at TIMESTAMPTZ,
  requested_generation BIGINT NOT NULL DEFAULT 1,
  processed_generation BIGINT NOT NULL DEFAULT 0,
  claimed_generation BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_owner TEXT,
  lease_started_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  state_reason TEXT,
  last_outcome TEXT,
  last_error_code TEXT,
  last_inserted_count INTEGER NOT NULL DEFAULT 0,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_success_local_date DATE,
  last_executor_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE task_horizon_jobs
  ADD CONSTRAINT task_horizon_jobs_state_check
    CHECK (state IN ('READY', 'LEASED', 'BLOCKED', 'FAILED', 'RETIRED')),
  ADD CONSTRAINT task_horizon_jobs_generation_check
    CHECK (
      requested_generation > 0
      AND processed_generation >= 0
      AND processed_generation <= requested_generation
    ),
  ADD CONSTRAINT task_horizon_jobs_ready_blocked_generation_check
    CHECK (
      state NOT IN ('READY', 'BLOCKED')
      OR processed_generation < requested_generation
    ),
  ADD CONSTRAINT task_horizon_jobs_attempt_check
    CHECK (attempt_count >= 0),
  ADD CONSTRAINT task_horizon_jobs_inserted_check
    CHECK (last_inserted_count >= 0),
  ADD CONSTRAINT task_horizon_jobs_leased_shape_check
    CHECK (
      (
        state = 'LEASED'
        AND lease_token IS NOT NULL
        AND lease_owner IS NOT NULL
        AND lease_started_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND claimed_generation IS NOT NULL
        AND processed_generation < claimed_generation
        AND claimed_generation <= requested_generation
        AND lease_expires_at > lease_started_at
        AND available_at IS NULL
      )
      OR (
        state <> 'LEASED'
        AND lease_token IS NULL
        AND lease_owner IS NULL
        AND lease_started_at IS NULL
        AND lease_expires_at IS NULL
        AND claimed_generation IS NULL
      )
    ),
  ADD CONSTRAINT task_horizon_jobs_available_check
    CHECK (
      (state IN ('READY', 'BLOCKED') AND available_at IS NOT NULL)
      OR (state IN ('FAILED', 'RETIRED', 'LEASED') AND available_at IS NULL)
    ),
  ADD CONSTRAINT task_horizon_jobs_reason_check
    CHECK (
      (
        state = 'BLOCKED'
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
      OR (state = 'FAILED' AND state_reason IN ('SCOPE_LIMIT', 'RETRY_EXHAUSTED'))
      OR (state = 'RETIRED' AND state_reason IN ('PLAN_ARCHIVED', 'PROFILE_DELETION'))
      OR (state IN ('READY', 'LEASED') AND state_reason IS NULL)
    ),
  ADD CONSTRAINT task_horizon_jobs_outcome_check
    CHECK (
      last_outcome IS NULL
      OR last_outcome IN ('GENERATED', 'RESTORED', 'NOOP', 'BLOCKED', 'FAILED', 'RETIRED', 'REQUEUED')
    ),
  ADD CONSTRAINT task_horizon_jobs_executor_check
    CHECK (last_executor_key IS NULL OR last_executor_key = 'HORIZON_WORKER_V1'),
  ADD CONSTRAINT task_horizon_jobs_error_len_check
    CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),
  ADD CONSTRAINT task_horizon_jobs_owner_len_check
    CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 80),
  ADD CONSTRAINT task_horizon_jobs_reason_len_check
    CHECK (state_reason IS NULL OR char_length(state_reason) <= 64);

CREATE UNIQUE INDEX task_horizon_jobs_lease_token_uidx
  ON task_horizon_jobs (lease_token)
  WHERE lease_token IS NOT NULL;

CREATE INDEX task_horizon_jobs_due_idx
  ON task_horizon_jobs (available_at, plan_id)
  WHERE state IN ('READY', 'BLOCKED');

CREATE INDEX task_horizon_jobs_expired_lease_idx
  ON task_horizon_jobs (lease_expires_at, plan_id)
  WHERE state = 'LEASED';

CREATE INDEX task_horizon_jobs_state_reason_updated_idx
  ON task_horizon_jobs (state, state_reason, updated_at);

CREATE OR REPLACE FUNCTION stp006_task_horizon_job_on_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO task_horizon_jobs (
    plan_id,
    state,
    available_at,
    requested_generation,
    processed_generation,
    attempt_count,
    state_reason,
    last_inserted_count,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    CASE NEW.status
      WHEN 'ACTIVE' THEN 'READY'
      WHEN 'PAUSED' THEN 'BLOCKED'
      WHEN 'ARCHIVED' THEN 'RETIRED'
      ELSE NULL
    END,
    CASE NEW.status
      WHEN 'ARCHIVED' THEN NULL
      ELSE clock_timestamp()
    END,
    1,
    0,
    0,
    CASE NEW.status
      WHEN 'PAUSED' THEN 'PLAN_PAUSED'
      WHEN 'ARCHIVED' THEN 'PLAN_ARCHIVED'
      ELSE NULL
    END,
    0,
    clock_timestamp(),
    clock_timestamp()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER stp006_task_horizon_job_on_plan
  AFTER INSERT ON study_plans
  FOR EACH ROW
  EXECUTE FUNCTION stp006_task_horizon_job_on_plan();

INSERT INTO task_horizon_jobs (
  plan_id,
  state,
  available_at,
  requested_generation,
  processed_generation,
  attempt_count,
  state_reason,
  last_inserted_count,
  created_at,
  updated_at
)
SELECT
  p.id,
  CASE p.status
    WHEN 'ACTIVE' THEN 'READY'
    WHEN 'PAUSED' THEN 'BLOCKED'
    WHEN 'ARCHIVED' THEN 'RETIRED'
  END,
  CASE p.status
    WHEN 'ARCHIVED' THEN NULL
    ELSE clock_timestamp()
  END,
  1,
  0,
  0,
  CASE p.status
    WHEN 'PAUSED' THEN 'PLAN_PAUSED'
    WHEN 'ARCHIVED' THEN 'PLAN_ARCHIVED'
    ELSE NULL
  END,
  0,
  clock_timestamp(),
  clock_timestamp()
FROM study_plans p;
