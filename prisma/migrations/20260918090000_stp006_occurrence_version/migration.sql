-- STP 006 single-occurrence reschedule optimistic lock.
-- Does not change occurrence_key, original_local_date, or snapshots.

ALTER TABLE "task_occurrences"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "task_occurrences"
  ADD CONSTRAINT "task_occurrences_version_positive_check" CHECK ("version" >= 1);
