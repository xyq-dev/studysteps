-- STP 006 first-batch structure only. Does not publish consent documents.

CREATE TABLE "study_plans" (
    "id" UUID NOT NULL,
    "student_profile_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "origin" TEXT NOT NULL,
    "created_by_account_id" UUID,
    "created_by_session_id" UUID,
    "co_creation_attested_at" TIMESTAMPTZ(3),
    "co_creation_attested_by_account_id" UUID,
    "student_confirmed_at" TIMESTAMPTZ(3),
    "source_template_version_id" UUID,
    "imported_content_json" TEXT NOT NULL,
    "timezone_snapshot" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "study_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "study_plans_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
    CONSTRAINT "study_plans_origin_check" CHECK ("origin" IN ('STUDENT', 'GUARDIAN_ASSISTED', 'MANUAL')),
    CONSTRAINT "study_plans_assisted_attestation_check" CHECK (
        ("origin" = 'GUARDIAN_ASSISTED'
            AND "co_creation_attested_at" IS NOT NULL
            AND "co_creation_attested_by_account_id" IS NOT NULL)
        OR ("origin" <> 'GUARDIAN_ASSISTED'
            AND "co_creation_attested_at" IS NULL
            AND "co_creation_attested_by_account_id" IS NULL)
    )
);

CREATE TABLE "task_series" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "completion_standard" TEXT NOT NULL,
    "duration_minutes" INTEGER,
    "steps_json" TEXT NOT NULL DEFAULT '[]',
    "repeat_kind" TEXT NOT NULL,
    "weekdays_json" TEXT,
    "start_local_date" TEXT NOT NULL,
    "end_local_date" TEXT,
    "ongoing" BOOLEAN NOT NULL DEFAULT false,
    "effective_from_local_date" TEXT NOT NULL,
    "effective_to_local_date" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_series_repeat_kind_check" CHECK ("repeat_kind" IN ('ONCE', 'DAILY', 'WEEKLY_DAYS')),
    CONSTRAINT "task_series_end_ongoing_check" CHECK (
        ("ongoing" = true AND "end_local_date" IS NULL)
        OR ("ongoing" = false AND "end_local_date" IS NOT NULL)
    )
);

CREATE TABLE "task_occurrences" (
    "id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "occurrence_key" TEXT NOT NULL,
    "original_local_date" TEXT NOT NULL,
    "scheduled_local_date" TEXT NOT NULL,
    "timezone_snapshot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "cancel_reason" TEXT,
    "name_snapshot" TEXT NOT NULL,
    "subject_snapshot" TEXT NOT NULL,
    "completion_standard_snapshot" TEXT NOT NULL,
    "duration_minutes_snapshot" INTEGER,
    "steps_snapshot_json" TEXT NOT NULL,
    "grade_config_id" UUID NOT NULL,
    "grade_config_version_id" UUID NOT NULL,
    "stage_code_snapshot" TEXT NOT NULL,
    "school_system_code_snapshot" TEXT NOT NULL,
    "grade_code_snapshot" TEXT NOT NULL,
    "grade_label_snapshot" TEXT NOT NULL,
    "term_code_snapshot" TEXT NOT NULL,
    "catalog_entry_key_snapshot" TEXT NOT NULL,
    "source_occurrence_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_occurrences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_occurrences_status_check" CHECK ("status" IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED')),
    CONSTRAINT "task_occurrences_key_matches_original" CHECK ("occurrence_key" = "original_local_date")
);

CREATE TABLE "plan_adjustments" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "series_id" UUID,
    "occurrence_id" UUID,
    "reason_code" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_occurrences_series_id_occurrence_key_key" ON "task_occurrences"("series_id", "occurrence_key");
CREATE INDEX "study_plans_student_profile_id_status_idx" ON "study_plans"("student_profile_id", "status");
CREATE INDEX "task_series_plan_id_idx" ON "task_series"("plan_id");
CREATE INDEX "task_occurrences_scheduled_local_date_idx" ON "task_occurrences"("scheduled_local_date");
CREATE INDEX "plan_adjustments_plan_id_created_at_idx" ON "plan_adjustments"("plan_id", "created_at");

ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_student_profile_id_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_created_by_account_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_created_by_session_id_fkey" FOREIGN KEY ("created_by_session_id") REFERENCES "device_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_co_creation_attested_by_account_id_fkey" FOREIGN KEY ("co_creation_attested_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_source_template_version_id_fkey" FOREIGN KEY ("source_template_version_id") REFERENCES "plan_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_series" ADD CONSTRAINT "task_series_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "study_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "task_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_source_occurrence_id_fkey" FOREIGN KEY ("source_occurrence_id") REFERENCES "task_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_grade_config_id_fkey" FOREIGN KEY ("grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_grade_version_fkey" FOREIGN KEY ("grade_config_version_id", "grade_config_id") REFERENCES "grade_config_versions"("id", "grade_config_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "plan_adjustments" ADD CONSTRAINT "plan_adjustments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "study_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_adjustments" ADD CONSTRAINT "plan_adjustments_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "task_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_adjustments" ADD CONSTRAINT "plan_adjustments_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "task_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
