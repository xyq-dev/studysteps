-- Tenth incremental migration: split parentage constraints for source_occurrence_id.
-- Does not rewrite migrations 1-9 or test-v2.

DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM task_occurrences
   WHERE cancel_reason IS NOT NULL
     AND cancel_reason NOT IN (
       'PLAN_PAUSED',
       'PLAN_ARCHIVED',
       'SERIES_RULE_REMOVED',
       'USER_CANCELLED',
       'SPLIT'
     );
  IF bad > 0 THEN
    RAISE EXCEPTION 'stp006 ten precheck: % rows have unexpected cancel_reason', bad;
  END IF;
END
$$;

ALTER TABLE "task_occurrences"
  ADD CONSTRAINT "task_occurrences_cancel_reason_check"
  CHECK (
    "cancel_reason" IS NULL
    OR "cancel_reason" IN (
      'PLAN_PAUSED',
      'PLAN_ARCHIVED',
      'SERIES_RULE_REMOVED',
      'USER_CANCELLED',
      'SPLIT'
    )
  );

CREATE INDEX "task_occurrences_source_occurrence_id_idx"
  ON "task_occurrences" ("source_occurrence_id");

CREATE OR REPLACE FUNCTION stp006_source_occurrence_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_occurrence_id IS NOT NULL
     AND NEW.source_occurrence_id IS DISTINCT FROM OLD.source_occurrence_id THEN
    RAISE EXCEPTION 'source_occurrence_id cannot be replaced or cleared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_occurrences_source_occurrence_immutable
  BEFORE UPDATE ON task_occurrences
  FOR EACH ROW
  EXECUTE FUNCTION stp006_source_occurrence_immutable();

CREATE OR REPLACE FUNCTION stp006_assert_split_parentage() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
  child_plan UUID;
  parent_plan UUID;
BEGIN
  IF NEW.source_occurrence_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.source_occurrence_id = NEW.id THEN
    RAISE EXCEPTION 'source_occurrence_id cannot be self';
  END IF;
  SELECT * INTO parent FROM task_occurrences WHERE id = NEW.source_occurrence_id;
  IF parent.id IS NULL THEN
    RAISE EXCEPTION 'source parent missing';
  END IF;
  IF parent.source_occurrence_id IS NOT NULL THEN
    RAISE EXCEPTION 'split must be one level';
  END IF;
  SELECT plan_id INTO child_plan FROM task_series WHERE id = NEW.series_id;
  SELECT plan_id INTO parent_plan FROM task_series WHERE id = parent.series_id;
  IF child_plan IS NULL OR parent_plan IS NULL OR child_plan IS DISTINCT FROM parent_plan THEN
    RAISE EXCEPTION 'split child must share the parent plan';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER task_occurrences_split_parentage
  AFTER INSERT OR UPDATE OF source_occurrence_id, series_id ON task_occurrences
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stp006_assert_split_parentage();
