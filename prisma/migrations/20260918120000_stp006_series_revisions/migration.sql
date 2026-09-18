-- STP 006-A: stable TaskSeries + dual-axis revisions + explicit single-occurrence exceptions.
-- Does not rewrite migrations 1–8 or test-v2.

LOCK TABLE task_series, task_occurrences, plan_adjustments IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION stp006_is_local_date(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN FALSE;
  END IF;
  RETURN to_date(value, 'YYYY-MM-DD')::text = value;
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

DO $$
DECLARE
  bad_series INTEGER;
  bad_occ INTEGER;
  bad_dates INTEGER;
  bad_audit INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_series
    FROM task_series
   WHERE version <> 1
      OR effective_from_local_date IS DISTINCT FROM start_local_date
      OR effective_to_local_date IS DISTINCT FROM end_local_date
      OR NOT stp006_is_local_date(start_local_date)
      OR (end_local_date IS NOT NULL AND NOT stp006_is_local_date(end_local_date));
  IF bad_series > 0 THEN
    RAISE EXCEPTION 'stp006 nine precheck: % series rows fail version/effective-date alignment', bad_series;
  END IF;

  SELECT COUNT(*) INTO bad_occ
    FROM task_occurrences
   WHERE NOT stp006_is_local_date(occurrence_key)
      OR NOT stp006_is_local_date(original_local_date)
      OR NOT stp006_is_local_date(scheduled_local_date)
      OR occurrence_key IS DISTINCT FROM original_local_date;
  IF bad_occ > 0 THEN
    RAISE EXCEPTION 'stp006 nine precheck: % occurrences fail local-date/key shape', bad_occ;
  END IF;

  SELECT COUNT(*) INTO bad_dates
    FROM (
      SELECT series_id, scheduled_local_date, COUNT(*) AS n
        FROM task_occurrences
       GROUP BY series_id, scheduled_local_date
      HAVING COUNT(*) > 1
    ) dup;
  IF bad_dates > 0 THEN
    RAISE EXCEPTION 'stp006 nine precheck: % series have duplicate scheduled_local_date', bad_dates;
  END IF;

  SELECT COUNT(*) INTO bad_audit
    FROM plan_adjustments a
    LEFT JOIN study_plans p ON p.id = a.plan_id
    LEFT JOIN task_series s ON s.id = a.series_id
    LEFT JOIN task_occurrences o ON o.id = a.occurrence_id
   WHERE a.payload_json IS NULL
      OR a.payload_json = ''
      OR (a.payload_json IS NOT NULL AND a.payload_json::json IS NULL)
      OR (a.series_id IS NOT NULL AND (s.id IS NULL OR s.plan_id <> a.plan_id))
      OR (a.occurrence_id IS NOT NULL AND (o.id IS NULL OR o.series_id IS DISTINCT FROM a.series_id));
  IF bad_audit > 0 THEN
    RAISE EXCEPTION 'stp006 nine precheck: % plan_adjustments fail JSON/ownership', bad_audit;
  END IF;
END;
$$;

CREATE TABLE "task_series_revisions" (
    "task_series_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "change_kind" TEXT NOT NULL,
    "effective_from_occurrence_key" TEXT NOT NULL,
    "name" TEXT,
    "subject" TEXT,
    "completion_standard" TEXT,
    "duration_minutes" INTEGER,
    "steps_json" TEXT,
    "repeat_kind" TEXT,
    "weekdays_json" TEXT,
    "end_local_date" TEXT,
    "ongoing" BOOLEAN,
    "source_adjustment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_series_revisions_pkey" PRIMARY KEY ("task_series_id", "revision_no"),
    CONSTRAINT "task_series_revisions_no_positive" CHECK ("revision_no" >= 1),
    CONSTRAINT "task_series_revisions_kind_check" CHECK ("change_kind" IN ('BASELINE', 'CONTENT', 'SCHEDULE')),
    CONSTRAINT "task_series_revisions_cutoff_check" CHECK (stp006_is_local_date("effective_from_occurrence_key")),
    CONSTRAINT "task_series_revisions_source_unique" UNIQUE ("source_adjustment_id"),
    CONSTRAINT "task_series_revisions_kind_shape_check" CHECK (
        (
            "change_kind" = 'BASELINE'
            AND "name" IS NOT NULL AND char_length("name") BETWEEN 1 AND 64
            AND "subject" IS NOT NULL AND char_length("subject") BETWEEN 1 AND 32
            AND "completion_standard" IS NOT NULL AND char_length("completion_standard") BETWEEN 1 AND 240
            AND "steps_json" IS NOT NULL
            AND "repeat_kind" IS NOT NULL
            AND "ongoing" IS NOT NULL
            AND "source_adjustment_id" IS NULL
        )
        OR (
            "change_kind" = 'CONTENT'
            AND "name" IS NOT NULL AND char_length("name") BETWEEN 1 AND 64
            AND "subject" IS NOT NULL AND char_length("subject") BETWEEN 1 AND 32
            AND "completion_standard" IS NOT NULL AND char_length("completion_standard") BETWEEN 1 AND 240
            AND "steps_json" IS NOT NULL
            AND "repeat_kind" IS NULL
            AND "weekdays_json" IS NULL
            AND "end_local_date" IS NULL
            AND "ongoing" IS NULL
            AND "source_adjustment_id" IS NOT NULL
        )
        OR (
            "change_kind" = 'SCHEDULE'
            AND "name" IS NULL
            AND "subject" IS NULL
            AND "completion_standard" IS NULL
            AND "duration_minutes" IS NULL
            AND "steps_json" IS NULL
            AND "repeat_kind" IS NOT NULL
            AND "ongoing" IS NOT NULL
            AND "source_adjustment_id" IS NOT NULL
        )
    ),
    CONSTRAINT "task_series_revisions_duration_check" CHECK (
        "duration_minutes" IS NULL OR ("duration_minutes" >= 1 AND "duration_minutes" <= 1440)
    ),
    CONSTRAINT "task_series_revisions_repeat_check" CHECK (
        "repeat_kind" IS NULL OR "repeat_kind" IN ('ONCE', 'DAILY', 'WEEKLY_DAYS')
    ),
    CONSTRAINT "task_series_revisions_end_ongoing_check" CHECK (
        "ongoing" IS NULL
        OR ("ongoing" = true AND "end_local_date" IS NULL)
        OR ("ongoing" = false AND "end_local_date" IS NOT NULL AND stp006_is_local_date("end_local_date"))
    ),
    CONSTRAINT "task_series_revisions_weekdays_check" CHECK (
        "repeat_kind" IS NULL
        OR (
            "repeat_kind" = 'WEEKLY_DAYS'
            AND "weekdays_json" IS NOT NULL
        )
        OR (
            "repeat_kind" IN ('ONCE', 'DAILY')
            AND "weekdays_json" IS NULL
        )
    )
);

CREATE INDEX "task_series_revisions_lookup_idx"
    ON "task_series_revisions" ("task_series_id", "change_kind", "effective_from_occurrence_key", "revision_no" DESC);

ALTER TABLE "task_occurrences"
    ADD COLUMN "content_revision_no" INTEGER,
    ADD COLUMN "schedule_revision_no" INTEGER,
    ADD COLUMN "content_exception_adjustment_id" UUID,
    ADD COLUMN "schedule_exception_adjustment_id" UUID;

INSERT INTO "task_series_revisions" (
    "task_series_id",
    "revision_no",
    "change_kind",
    "effective_from_occurrence_key",
    "name",
    "subject",
    "completion_standard",
    "duration_minutes",
    "steps_json",
    "repeat_kind",
    "weekdays_json",
    "end_local_date",
    "ongoing",
    "source_adjustment_id",
    "created_at"
)
SELECT
    s.id,
    1,
    'BASELINE',
    s.start_local_date,
    s.name,
    s.subject,
    s.completion_standard,
    s.duration_minutes,
    s.steps_json,
    s.repeat_kind,
    s.weekdays_json,
    s.end_local_date,
    s.ongoing,
    NULL,
    s.created_at
FROM task_series s;

UPDATE task_occurrences
   SET content_revision_no = 1,
       schedule_revision_no = 1;

CREATE OR REPLACE FUNCTION stp006_apply_content_fields(state JSONB, fields JSONB) RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  field TEXT;
BEGIN
  IF fields IS NULL OR jsonb_typeof(fields) <> 'array' THEN
    RAISE EXCEPTION 'stp006 content audit fields must be an array';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(fields)
  LOOP
    field := item->>'field';
    IF field IS NULL THEN
      RAISE EXCEPTION 'stp006 content audit field name missing';
    END IF;
    IF (state -> field) IS DISTINCT FROM (item -> 'from') THEN
      RAISE EXCEPTION 'stp006 content audit from-value does not match reconstructed state';
    END IF;
    state := jsonb_set(state, ARRAY[field], item -> 'to', true);
  END LOOP;
  RETURN state;
END;
$$;

DO $$
DECLARE
  occ RECORD;
  series RECORD;
  baseline JSONB;
  current JSONB;
  reconstructed JSONB;
  unused JSONB := '[]'::jsonb;
  adj RECORD;
  candidates INTEGER;
  chosen UUID;
  chosen_fields JSONB;
  first_id UUID;
  applied INTEGER;
  date_unused JSONB := '[]'::jsonb;
  date_state TEXT;
  date_candidates INTEGER;
  date_chosen UUID;
  date_from TEXT;
  date_to TEXT;
  date_first UUID;
BEGIN
  FOR occ IN
    SELECT o.*, s.plan_id AS series_plan_id, s.name AS series_name, s.subject AS series_subject,
           s.completion_standard AS series_standard, s.duration_minutes AS series_duration,
           s.steps_json AS series_steps
      FROM task_occurrences o
      JOIN task_series s ON s.id = o.series_id
  LOOP
    baseline := jsonb_build_object(
      'name', to_jsonb(occ.series_name),
      'subject', to_jsonb(occ.series_subject),
      'completionStandard', to_jsonb(occ.series_standard),
      'durationMinutes', to_jsonb(occ.series_duration),
      'steps', occ.series_steps::jsonb
    );
    current := jsonb_build_object(
      'name', to_jsonb(occ.name_snapshot),
      'subject', to_jsonb(occ.subject_snapshot),
      'completionStandard', to_jsonb(occ.completion_standard_snapshot),
      'durationMinutes', to_jsonb(occ.duration_minutes_snapshot),
      'steps', occ.steps_snapshot_json::jsonb
    );
    unused := '[]'::jsonb;
    FOR adj IN
      SELECT a.id, a.plan_id, a.series_id, a.payload_json::jsonb AS payload
        FROM plan_adjustments a
       WHERE a.occurrence_id = occ.id
         AND a.reason_code = 'TASK_CONTENT_EDITED'
    LOOP
      IF adj.plan_id <> occ.series_plan_id OR adj.series_id IS DISTINCT FROM occ.series_id THEN
        RAISE EXCEPTION 'stp006 nine backfill: content audit % ownership mismatch', adj.id;
      END IF;
      unused := unused || jsonb_build_array(jsonb_build_object('id', adj.id, 'fields', adj.payload -> 'fields'));
    END LOOP;
    IF jsonb_array_length(unused) = 0 THEN
      IF baseline IS DISTINCT FROM current THEN
        RAISE EXCEPTION 'stp006 nine backfill: occurrence % drifted without TASK_CONTENT_EDITED', occ.id;
      END IF;
    ELSE
      reconstructed := baseline;
      first_id := NULL;
      applied := 0;
      WHILE applied < jsonb_array_length(unused) LOOP
        candidates := 0;
        chosen := NULL;
        chosen_fields := NULL;
        FOR adj IN
          SELECT (item->>'id')::uuid AS id, item->'fields' AS fields
            FROM jsonb_array_elements(unused) item
           WHERE NOT COALESCE((item->>'used')::boolean, false)
        LOOP
          BEGIN
            PERFORM stp006_apply_content_fields(reconstructed, adj.fields);
            candidates := candidates + 1;
            chosen := adj.id;
            chosen_fields := adj.fields;
          EXCEPTION
            WHEN OTHERS THEN
              NULL;
          END;
        END LOOP;
        IF candidates <> 1 THEN
          RAISE EXCEPTION 'stp006 nine backfill: content audit lineage fork/gap for occurrence %', occ.id;
        END IF;
        reconstructed := stp006_apply_content_fields(reconstructed, chosen_fields);
        unused := (
          SELECT jsonb_agg(
            CASE WHEN (item->>'id')::uuid = chosen THEN item || '{"used":true}'::jsonb ELSE item END
          )
          FROM jsonb_array_elements(unused) item
        );
        IF first_id IS NULL THEN
          first_id := chosen;
        END IF;
        applied := applied + 1;
      END LOOP;
      IF reconstructed IS DISTINCT FROM current THEN
        RAISE EXCEPTION 'stp006 nine backfill: content audit lineage does not reach current snapshots for %', occ.id;
      END IF;
      UPDATE task_occurrences
         SET content_exception_adjustment_id = first_id
       WHERE id = occ.id;
    END IF;

    date_unused := '[]'::jsonb;
    FOR adj IN
      SELECT a.id, a.plan_id, a.series_id, a.payload_json::jsonb AS payload
        FROM plan_adjustments a
       WHERE a.occurrence_id = occ.id
         AND a.reason_code = 'TASK_RESCHEDULED'
    LOOP
      IF adj.plan_id <> occ.series_plan_id OR adj.series_id IS DISTINCT FROM occ.series_id THEN
        RAISE EXCEPTION 'stp006 nine backfill: reschedule audit % ownership mismatch', adj.id;
      END IF;
      date_unused := date_unused || jsonb_build_array(jsonb_build_object(
        'id', adj.id,
        'from', adj.payload->>'fromScheduledLocalDate',
        'to', adj.payload->>'toScheduledLocalDate'
      ));
    END LOOP;
    IF jsonb_array_length(date_unused) = 0 THEN
      IF occ.scheduled_local_date IS DISTINCT FROM occ.original_local_date THEN
        RAISE EXCEPTION 'stp006 nine backfill: occurrence % date drifted without TASK_RESCHEDULED', occ.id;
      END IF;
    ELSE
      date_state := occ.original_local_date;
      date_first := NULL;
      applied := 0;
      WHILE applied < jsonb_array_length(date_unused) LOOP
        date_candidates := 0;
        date_chosen := NULL;
        date_from := NULL;
        date_to := NULL;
        FOR adj IN
          SELECT (item->>'id')::uuid AS id, item->>'from' AS from_date, item->>'to' AS to_date
            FROM jsonb_array_elements(date_unused) item
           WHERE NOT COALESCE((item->>'used')::boolean, false)
        LOOP
          IF adj.from_date = date_state THEN
            date_candidates := date_candidates + 1;
            date_chosen := adj.id;
            date_from := adj.from_date;
            date_to := adj.to_date;
          END IF;
        END LOOP;
        IF date_candidates <> 1 THEN
          RAISE EXCEPTION 'stp006 nine backfill: reschedule audit lineage fork/gap for occurrence %', occ.id;
        END IF;
        date_state := date_to;
        date_unused := (
          SELECT jsonb_agg(
            CASE WHEN (item->>'id')::uuid = date_chosen THEN item || '{"used":true}'::jsonb ELSE item END
          )
          FROM jsonb_array_elements(date_unused) item
        );
        IF date_first IS NULL THEN
          date_first := date_chosen;
        END IF;
        applied := applied + 1;
      END LOOP;
      IF date_state IS DISTINCT FROM occ.scheduled_local_date THEN
        RAISE EXCEPTION 'stp006 nine backfill: reschedule audit lineage does not reach current date for %', occ.id;
      END IF;
      UPDATE task_occurrences
         SET schedule_exception_adjustment_id = date_first
       WHERE id = occ.id;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE "task_occurrences"
    ALTER COLUMN "content_revision_no" SET NOT NULL,
    ALTER COLUMN "schedule_revision_no" SET NOT NULL,
    ALTER COLUMN "content_revision_no" SET DEFAULT 1,
    ALTER COLUMN "schedule_revision_no" SET DEFAULT 1;

ALTER TABLE "task_series_revisions"
    ADD CONSTRAINT "task_series_revisions_series_fkey"
    FOREIGN KEY ("task_series_id") REFERENCES "task_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_series_revisions"
    ADD CONSTRAINT "task_series_revisions_source_adjustment_fkey"
    FOREIGN KEY ("source_adjustment_id") REFERENCES "plan_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_occurrences"
    ADD CONSTRAINT "task_occurrences_content_revision_fkey"
    FOREIGN KEY ("series_id", "content_revision_no")
    REFERENCES "task_series_revisions"("task_series_id", "revision_no")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_occurrences"
    ADD CONSTRAINT "task_occurrences_schedule_revision_fkey"
    FOREIGN KEY ("series_id", "schedule_revision_no")
    REFERENCES "task_series_revisions"("task_series_id", "revision_no")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_occurrences"
    ADD CONSTRAINT "task_occurrences_content_exception_fkey"
    FOREIGN KEY ("content_exception_adjustment_id") REFERENCES "plan_adjustments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_occurrences"
    ADD CONSTRAINT "task_occurrences_schedule_exception_fkey"
    FOREIGN KEY ("schedule_exception_adjustment_id") REFERENCES "plan_adjustments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "task_occurrences_series_content_revision_idx"
    ON "task_occurrences" ("series_id", "content_revision_no");
CREATE INDEX "task_occurrences_series_schedule_revision_idx"
    ON "task_occurrences" ("series_id", "schedule_revision_no");
CREATE INDEX "task_occurrences_content_exception_idx"
    ON "task_occurrences" ("content_exception_adjustment_id");
CREATE INDEX "task_occurrences_schedule_exception_idx"
    ON "task_occurrences" ("schedule_exception_adjustment_id");
CREATE INDEX "plan_adjustments_series_id_idx" ON "plan_adjustments" ("series_id");
CREATE INDEX "plan_adjustments_occurrence_id_idx" ON "plan_adjustments" ("occurrence_id");

CREATE UNIQUE INDEX "task_occurrences_series_id_scheduled_local_date_key"
    ON "task_occurrences" ("series_id", "scheduled_local_date");

CREATE OR REPLACE FUNCTION stp006_reject_series_legacy_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.completion_standard IS DISTINCT FROM OLD.completion_standard
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.steps_json IS DISTINCT FROM OLD.steps_json
     OR NEW.repeat_kind IS DISTINCT FROM OLD.repeat_kind
     OR NEW.weekdays_json IS DISTINCT FROM OLD.weekdays_json
     OR NEW.start_local_date IS DISTINCT FROM OLD.start_local_date
     OR NEW.end_local_date IS DISTINCT FROM OLD.end_local_date
     OR NEW.ongoing IS DISTINCT FROM OLD.ongoing
     OR NEW.effective_from_local_date IS DISTINCT FROM OLD.effective_from_local_date
     OR NEW.effective_to_local_date IS DISTINCT FROM OLD.effective_to_local_date THEN
    RAISE EXCEPTION 'task_series legacy rule columns are immutable after revision baseline';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_series_legacy_immutable
    BEFORE UPDATE ON task_series
    FOR EACH ROW
    EXECUTE FUNCTION stp006_reject_series_legacy_mutation();

CREATE OR REPLACE FUNCTION stp006_reject_revision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task_series_revisions are immutable';
END;
$$;

CREATE TRIGGER task_series_revisions_immutable
    BEFORE UPDATE OR DELETE ON task_series_revisions
    FOR EACH ROW
    EXECUTE FUNCTION stp006_reject_revision_mutation();

CREATE OR REPLACE FUNCTION stp006_reject_adjustment_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'plan_adjustments are immutable';
END;
$$;

CREATE TRIGGER plan_adjustments_immutable
    BEFORE UPDATE OR DELETE ON plan_adjustments
    FOR EACH ROW
    EXECUTE FUNCTION stp006_reject_adjustment_mutation();

CREATE OR REPLACE FUNCTION stp006_exception_pointer_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.content_exception_adjustment_id IS NOT NULL
       AND NEW.content_exception_adjustment_id IS DISTINCT FROM OLD.content_exception_adjustment_id THEN
      RAISE EXCEPTION 'content exception pointer cannot be replaced or cleared';
    END IF;
    IF OLD.schedule_exception_adjustment_id IS NOT NULL
       AND NEW.schedule_exception_adjustment_id IS DISTINCT FROM OLD.schedule_exception_adjustment_id THEN
      RAISE EXCEPTION 'schedule exception pointer cannot be replaced or cleared';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_occurrences_exception_pointer_guard
    BEFORE UPDATE ON task_occurrences
    FOR EACH ROW
    EXECUTE FUNCTION stp006_exception_pointer_guard();

CREATE OR REPLACE FUNCTION stp006_fill_exception_from_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason_code = 'TASK_CONTENT_EDITED' AND NEW.occurrence_id IS NOT NULL THEN
    UPDATE task_occurrences
       SET content_exception_adjustment_id = NEW.id
     WHERE id = NEW.occurrence_id
       AND content_exception_adjustment_id IS NULL;
  END IF;
  IF NEW.reason_code = 'TASK_RESCHEDULED' AND NEW.occurrence_id IS NOT NULL THEN
    UPDATE task_occurrences
       SET schedule_exception_adjustment_id = NEW.id
     WHERE id = NEW.occurrence_id
       AND schedule_exception_adjustment_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_adjustments_fill_exception
    AFTER INSERT ON plan_adjustments
    FOR EACH ROW
    EXECUTE FUNCTION stp006_fill_exception_from_adjustment();

CREATE OR REPLACE FUNCTION stp006_task_series_create_baseline() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO task_series_revisions (
    task_series_id, revision_no, change_kind, effective_from_occurrence_key,
    name, subject, completion_standard, duration_minutes, steps_json,
    repeat_kind, weekdays_json, end_local_date, ongoing, source_adjustment_id, created_at
  ) VALUES (
    NEW.id, 1, 'BASELINE', NEW.start_local_date,
    NEW.name, NEW.subject, NEW.completion_standard, NEW.duration_minutes, NEW.steps_json,
    NEW.repeat_kind, NEW.weekdays_json, NEW.end_local_date, NEW.ongoing, NULL, clock_timestamp()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_series_create_baseline
    AFTER INSERT ON task_series
    FOR EACH ROW
    EXECUTE FUNCTION stp006_task_series_create_baseline();

CREATE OR REPLACE FUNCTION stp006_assert_revision_axis() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  kind TEXT;
BEGIN
  SELECT change_kind INTO kind
    FROM task_series_revisions
   WHERE task_series_id = NEW.series_id AND revision_no = NEW.content_revision_no;
  IF kind IS NULL OR kind NOT IN ('BASELINE', 'CONTENT') THEN
    RAISE EXCEPTION 'content_revision_no must point at BASELINE or CONTENT';
  END IF;
  SELECT change_kind INTO kind
    FROM task_series_revisions
   WHERE task_series_id = NEW.series_id AND revision_no = NEW.schedule_revision_no;
  IF kind IS NULL OR kind NOT IN ('BASELINE', 'SCHEDULE') THEN
    RAISE EXCEPTION 'schedule_revision_no must point at BASELINE or SCHEDULE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER task_occurrences_revision_axis
    AFTER INSERT OR UPDATE OF content_revision_no, schedule_revision_no, series_id ON task_occurrences
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_revision_axis();

CREATE OR REPLACE FUNCTION stp006_assert_exception_ownership() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  adj RECORD;
BEGIN
  IF NEW.content_exception_adjustment_id IS NOT NULL THEN
    SELECT * INTO adj FROM plan_adjustments WHERE id = NEW.content_exception_adjustment_id;
    IF adj.id IS NULL
       OR adj.reason_code <> 'TASK_CONTENT_EDITED'
       OR adj.occurrence_id IS DISTINCT FROM NEW.id
       OR adj.series_id IS DISTINCT FROM NEW.series_id THEN
      RAISE EXCEPTION 'content exception pointer must reference TASK_CONTENT_EDITED for this occurrence';
    END IF;
  END IF;
  IF NEW.schedule_exception_adjustment_id IS NOT NULL THEN
    SELECT * INTO adj FROM plan_adjustments WHERE id = NEW.schedule_exception_adjustment_id;
    IF adj.id IS NULL
       OR adj.reason_code <> 'TASK_RESCHEDULED'
       OR adj.occurrence_id IS DISTINCT FROM NEW.id
       OR adj.series_id IS DISTINCT FROM NEW.series_id THEN
      RAISE EXCEPTION 'schedule exception pointer must reference TASK_RESCHEDULED for this occurrence';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER task_occurrences_exception_ownership
    AFTER INSERT OR UPDATE OF content_exception_adjustment_id, schedule_exception_adjustment_id, series_id ON task_occurrences
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_exception_ownership();

CREATE OR REPLACE FUNCTION stp006_assert_series_version_head_for(target UUID) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  head INTEGER;
  current_version INTEGER;
BEGIN
  SELECT MAX(revision_no) INTO head FROM task_series_revisions WHERE task_series_id = target;
  SELECT version INTO current_version FROM task_series WHERE id = target;
  IF target IS NULL OR head IS NULL OR current_version IS DISTINCT FROM head THEN
    RAISE EXCEPTION 'task_series.version must equal max revision_no';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION stp006_assert_series_version_head_from_revision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM stp006_assert_series_version_head_for(COALESCE(NEW.task_series_id, OLD.task_series_id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stp006_assert_series_version_head_from_series() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM stp006_assert_series_version_head_for(COALESCE(NEW.id, OLD.id));
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER task_series_version_head_from_revision
    AFTER INSERT OR UPDATE OR DELETE ON task_series_revisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_series_version_head_from_revision();

CREATE CONSTRAINT TRIGGER task_series_version_head_from_series
    AFTER INSERT OR UPDATE OF version ON task_series
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_series_version_head_from_series();

CREATE OR REPLACE FUNCTION stp006_assert_revision_source() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  adj RECORD;
  occ_key TEXT;
  series_plan UUID;
BEGIN
  IF NEW.change_kind = 'BASELINE' THEN
    IF NEW.source_adjustment_id IS NOT NULL THEN
      RAISE EXCEPTION 'baseline revision cannot have source_adjustment_id';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO adj FROM plan_adjustments WHERE id = NEW.source_adjustment_id;
  SELECT plan_id INTO series_plan FROM task_series WHERE id = NEW.task_series_id;
  IF adj.id IS NULL OR adj.series_id IS DISTINCT FROM NEW.task_series_id OR adj.plan_id IS DISTINCT FROM series_plan THEN
    RAISE EXCEPTION 'revision source adjustment must belong to the same plan/series';
  END IF;
  IF NEW.change_kind = 'CONTENT' AND adj.reason_code <> 'SERIES_FUTURE_CONTENT_CHANGED' THEN
    RAISE EXCEPTION 'CONTENT revision must point at SERIES_FUTURE_CONTENT_CHANGED';
  END IF;
  IF NEW.change_kind = 'SCHEDULE' AND adj.reason_code <> 'SERIES_FUTURE_SCHEDULE_CHANGED' THEN
    RAISE EXCEPTION 'SCHEDULE revision must point at SERIES_FUTURE_SCHEDULE_CHANGED';
  END IF;
  SELECT occurrence_key INTO occ_key FROM task_occurrences WHERE id = adj.occurrence_id;
  IF occ_key IS DISTINCT FROM NEW.effective_from_occurrence_key THEN
    RAISE EXCEPTION 'revision cutoff must equal source adjustment occurrence key';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER task_series_revisions_source_guard
    AFTER INSERT OR UPDATE ON task_series_revisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_revision_source();

CREATE OR REPLACE FUNCTION stp006_assert_single_edit_has_exception() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pointer UUID;
BEGIN
  IF NEW.reason_code = 'TASK_CONTENT_EDITED' AND NEW.occurrence_id IS NOT NULL THEN
    SELECT content_exception_adjustment_id INTO pointer FROM task_occurrences WHERE id = NEW.occurrence_id;
    IF pointer IS NULL THEN
      RAISE EXCEPTION 'TASK_CONTENT_EDITED committed without content exception pointer';
    END IF;
  END IF;
  IF NEW.reason_code = 'TASK_RESCHEDULED' AND NEW.occurrence_id IS NOT NULL THEN
    SELECT schedule_exception_adjustment_id INTO pointer FROM task_occurrences WHERE id = NEW.occurrence_id;
    IF pointer IS NULL THEN
      RAISE EXCEPTION 'TASK_RESCHEDULED committed without schedule exception pointer';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER plan_adjustments_exception_present
    AFTER INSERT ON plan_adjustments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION stp006_assert_single_edit_has_exception();
