-- STP 005 grade catalog, education history and 39 original templates.
-- Additive only. Does not rewrite STP 004 migrations.
-- Leftover student education snapshots are kept; no backfill and no wipe.
-- After history exists, do not drop tables; forward-fix instead.
-- Trusted leftover allowlist is captured in this same transaction under a table lock.
-- created_at is not provenance. Post-migration inserts cannot join the allowlist.

LOCK TABLE "student_profiles" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "student_profiles" ADD COLUMN "grade_config_id" UUID;

CREATE OR REPLACE FUNCTION stp005_legacy_tuple_digest(
  stage_code TEXT,
  school_system_code TEXT,
  grade_code TEXT,
  grade_label TEXT,
  term_code TEXT
) RETURNS TEXT AS $$
BEGIN
  RETURN md5(
    concat_ws(
      E'\x1f',
      COALESCE(stage_code, ''),
      COALESCE(school_system_code, ''),
      COALESCE(grade_code, ''),
      COALESCE(grade_label, ''),
      COALESCE(term_code, '')
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE "stp005_trusted_legacy_allowlist" (
    "student_profile_id" UUID NOT NULL,
    "stage_code" TEXT,
    "school_system_code" TEXT,
    "grade_code" TEXT,
    "grade_label" TEXT,
    "term_code" TEXT,
    "tuple_digest" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stp005_trusted_legacy_allowlist_pkey" PRIMARY KEY ("student_profile_id"),
    CONSTRAINT "stp005_trusted_legacy_allowlist_student_fk"
      FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "stp005_trusted_legacy_allowlist" (
  "student_profile_id", "stage_code", "school_system_code", "grade_code", "grade_label", "term_code", "tuple_digest"
)
SELECT
  sp.id,
  sp.stage_code,
  sp.school_system_code,
  sp.grade_code,
  sp.grade_label,
  sp.term_code,
  stp005_legacy_tuple_digest(sp.stage_code, sp.school_system_code, sp.grade_code, sp.grade_label, sp.term_code)
FROM "student_profiles" sp
WHERE NOT (
  sp.stage_code IS NULL
  AND sp.school_system_code IS NULL
  AND sp.grade_code IS NULL
  AND sp.grade_label IS NULL
  AND sp.term_code IS NULL
);

CREATE OR REPLACE FUNCTION stp005_reject_trusted_legacy_allowlist_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'trusted legacy allowlist is sealed; refuse insert, rewrite, or backfill';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stp005_trusted_legacy_allowlist_immutable ON "stp005_trusted_legacy_allowlist";
CREATE TRIGGER stp005_trusted_legacy_allowlist_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "stp005_trusted_legacy_allowlist"
FOR EACH ROW EXECUTE FUNCTION stp005_reject_trusted_legacy_allowlist_mutation();

CREATE TABLE "grade_configs" (
    "id" UUID NOT NULL,
    "school_system_code" TEXT NOT NULL,
    "stage_code" TEXT NOT NULL,
    "grade_code" TEXT NOT NULL,
    "current_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "grade_configs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grade_configs_slot_key" UNIQUE ("school_system_code", "stage_code", "grade_code"),
    CONSTRAINT "grade_configs_system_ck" CHECK ("school_system_code" IN ('SIX_THREE', 'FIVE_FOUR', 'CUSTOM')),
    CONSTRAINT "grade_configs_stage_ck" CHECK ("stage_code" IN ('PRIMARY', 'JUNIOR', 'SENIOR'))
);

CREATE TABLE "grade_config_versions" (
    "id" UUID NOT NULL,
    "grade_config_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "grade_label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "next_grade_config_id" UUID,
    "catalog_entry_key" TEXT,
    "allowed_term_codes" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "grade_config_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grade_config_versions_config_fk" FOREIGN KEY ("grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "grade_config_versions_next_fk" FOREIGN KEY ("next_grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "grade_config_versions_config_version_key" UNIQUE ("grade_config_id", "version"),
    CONSTRAINT "grade_config_versions_id_config_key" UNIQUE ("id", "grade_config_id")
);

ALTER TABLE "grade_configs" ADD CONSTRAINT "grade_configs_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "grade_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_grade_config_fk" FOREIGN KEY ("grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_education_assigned_ck" CHECK (
    "grade_config_id" IS NULL
    OR (
        "stage_code" IS NOT NULL
        AND "school_system_code" IS NOT NULL
        AND "grade_code" IS NOT NULL
        AND "grade_label" IS NOT NULL
        AND "term_code" IN ('FULL_YEAR', 'FIRST_TERM', 'SECOND_TERM')
    )
);
CREATE TABLE "student_education_history" (
    "id" UUID NOT NULL,
    "student_profile_id" UUID NOT NULL,
    "change_kind" TEXT NOT NULL,
    "from_grade_config_id" UUID,
    "to_grade_config_id" UUID,
    "from_stage_code" TEXT,
    "from_school_system_code" TEXT,
    "from_grade_code" TEXT,
    "from_grade_label" TEXT,
    "from_term_code" TEXT,
    "to_stage_code" TEXT,
    "to_school_system_code" TEXT,
    "to_grade_code" TEXT,
    "to_grade_label" TEXT,
    "to_term_code" TEXT,
    "actor_account_id" UUID NOT NULL,
    "effective_local_date" TEXT NOT NULL,
    "timezone_snapshot" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_education_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_education_history_student_fk" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "student_education_history_from_fk" FOREIGN KEY ("from_grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "student_education_history_to_fk" FOREIGN KEY ("to_grade_config_id") REFERENCES "grade_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "student_education_history_kind_ck" CHECK ("change_kind" IN ('SET','PROMOTE','REPEAT','SKIP','LEAVE','RESUME','SYSTEM_SWITCH','TERM_SWITCH')),
    CONSTRAINT "student_education_history_date_ck" CHECK ("effective_local_date" ~ '^\d{4}-\d{2}-\d{2}$')
);
CREATE INDEX "student_education_history_student_created_idx" ON "student_education_history"("student_profile_id", "created_at");
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subjects_code_key" UNIQUE ("code")
);
CREATE TABLE "plan_template_versions" (
    "id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "catalog_entry_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content_json" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_template_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_template_versions_key_version_key" UNIQUE ("template_key", "version"),
    CONSTRAINT "plan_template_versions_kind_ck" CHECK ("kind" IN ('DAILY', 'READING_REVIEW', 'WEEKLY'))
);
CREATE INDEX "plan_template_versions_entry_kind_idx" ON "plan_template_versions"("catalog_entry_key", "kind");
CREATE OR REPLACE FUNCTION stp005_reject_published_grade_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published grade config version is immutable';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published grade config version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER grade_config_versions_immutable
BEFORE UPDATE OR DELETE ON "grade_config_versions"
FOR EACH ROW EXECUTE FUNCTION stp005_reject_published_grade_version_mutation();
CREATE OR REPLACE FUNCTION stp005_reject_education_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'education history is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER student_education_history_immutable
BEFORE UPDATE OR DELETE ON "student_education_history"
FOR EACH ROW EXECUTE FUNCTION stp005_reject_education_history_mutation();
CREATE OR REPLACE FUNCTION stp005_reject_published_template_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published template version is immutable';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published template version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER plan_template_versions_immutable
BEFORE UPDATE OR DELETE ON "plan_template_versions"
FOR EACH ROW EXECUTE FUNCTION stp005_reject_published_template_mutation();

-- Seed publish locks only catalog rows (no student_profiles).
INSERT INTO "grade_configs" ("id", "school_system_code", "stage_code", "grade_code", "updated_at") VALUES
    ('a0056300-0000-4000-8000-000000000101', 'SIX_THREE', 'PRIMARY', 'G1', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000102', 'SIX_THREE', 'PRIMARY', 'G2', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000103', 'SIX_THREE', 'PRIMARY', 'G3', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000104', 'SIX_THREE', 'PRIMARY', 'G4', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000105', 'SIX_THREE', 'PRIMARY', 'G5', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000106', 'SIX_THREE', 'PRIMARY', 'G6', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000201', 'SIX_THREE', 'JUNIOR', 'G1', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000202', 'SIX_THREE', 'JUNIOR', 'G2', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000203', 'SIX_THREE', 'JUNIOR', 'G3', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000301', 'SIX_THREE', 'SENIOR', 'G1', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000302', 'SIX_THREE', 'SENIOR', 'G2', CURRENT_TIMESTAMP),
    ('a0056300-0000-4000-8000-000000000303', 'SIX_THREE', 'SENIOR', 'G3', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000101', 'FIVE_FOUR', 'PRIMARY', 'G1', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000102', 'FIVE_FOUR', 'PRIMARY', 'G2', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000103', 'FIVE_FOUR', 'PRIMARY', 'G3', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000104', 'FIVE_FOUR', 'PRIMARY', 'G4', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000105', 'FIVE_FOUR', 'PRIMARY', 'G5', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000201', 'FIVE_FOUR', 'JUNIOR', 'G1', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000202', 'FIVE_FOUR', 'JUNIOR', 'G2', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000203', 'FIVE_FOUR', 'JUNIOR', 'G3', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000204', 'FIVE_FOUR', 'JUNIOR', 'G4', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000301', 'FIVE_FOUR', 'SENIOR', 'G1', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000302', 'FIVE_FOUR', 'SENIOR', 'G2', CURRENT_TIMESTAMP),
    ('a0055400-0000-4000-8000-000000000303', 'FIVE_FOUR', 'SENIOR', 'G3', CURRENT_TIMESTAMP),
    ('a0057500-0000-4000-8000-000000000209', 'CUSTOM', 'JUNIOR', 'EXPERIMENTAL', CURRENT_TIMESTAMP);

INSERT INTO "grade_config_versions" ("id", "grade_config_id", "version", "grade_label", "sort_order", "next_grade_config_id", "catalog_entry_key", "allowed_term_codes", "published_at") VALUES
    ('b0056300-0000-4000-8000-000000000101', 'a0056300-0000-4000-8000-000000000101', 'v1', '一年级', 1, 'a0056300-0000-4000-8000-000000000102', 'PRIMARY_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000102', 'a0056300-0000-4000-8000-000000000102', 'v1', '二年级', 2, 'a0056300-0000-4000-8000-000000000103', 'PRIMARY_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000103', 'a0056300-0000-4000-8000-000000000103', 'v1', '三年级', 3, 'a0056300-0000-4000-8000-000000000104', 'PRIMARY_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000104', 'a0056300-0000-4000-8000-000000000104', 'v1', '四年级', 4, 'a0056300-0000-4000-8000-000000000105', 'PRIMARY_G4', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000105', 'a0056300-0000-4000-8000-000000000105', 'v1', '五年级', 5, 'a0056300-0000-4000-8000-000000000106', 'PRIMARY_G5', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000106', 'a0056300-0000-4000-8000-000000000106', 'v1', '六年级', 6, 'a0056300-0000-4000-8000-000000000201', 'PRIMARY_G6', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000201', 'a0056300-0000-4000-8000-000000000201', 'v1', '初一', 7, 'a0056300-0000-4000-8000-000000000202', 'JUNIOR_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000202', 'a0056300-0000-4000-8000-000000000202', 'v1', '初二', 8, 'a0056300-0000-4000-8000-000000000203', 'JUNIOR_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000203', 'a0056300-0000-4000-8000-000000000203', 'v1', '初三', 9, 'a0056300-0000-4000-8000-000000000301', 'JUNIOR_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000301', 'a0056300-0000-4000-8000-000000000301', 'v1', '高一', 10, 'a0056300-0000-4000-8000-000000000302', 'SENIOR_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000302', 'a0056300-0000-4000-8000-000000000302', 'v1', '高二', 11, 'a0056300-0000-4000-8000-000000000303', 'SENIOR_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0056300-0000-4000-8000-000000000303', 'a0056300-0000-4000-8000-000000000303', 'v1', '高三', 12, NULL, 'SENIOR_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000101', 'a0055400-0000-4000-8000-000000000101', 'v1', '一年级', 13, 'a0055400-0000-4000-8000-000000000102', 'PRIMARY_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000102', 'a0055400-0000-4000-8000-000000000102', 'v1', '二年级', 14, 'a0055400-0000-4000-8000-000000000103', 'PRIMARY_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000103', 'a0055400-0000-4000-8000-000000000103', 'v1', '三年级', 15, 'a0055400-0000-4000-8000-000000000104', 'PRIMARY_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000104', 'a0055400-0000-4000-8000-000000000104', 'v1', '四年级', 16, 'a0055400-0000-4000-8000-000000000105', 'PRIMARY_G4', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000105', 'a0055400-0000-4000-8000-000000000105', 'v1', '五年级', 17, 'a0055400-0000-4000-8000-000000000201', 'PRIMARY_G5', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000201', 'a0055400-0000-4000-8000-000000000201', 'v1', '初一', 18, 'a0055400-0000-4000-8000-000000000202', 'JUNIOR_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000202', 'a0055400-0000-4000-8000-000000000202', 'v1', '初二', 19, 'a0055400-0000-4000-8000-000000000203', 'JUNIOR_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000203', 'a0055400-0000-4000-8000-000000000203', 'v1', '初三', 20, 'a0055400-0000-4000-8000-000000000204', 'JUNIOR_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000204', 'a0055400-0000-4000-8000-000000000204', 'v1', '初四', 21, 'a0055400-0000-4000-8000-000000000301', 'JUNIOR_G4', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000301', 'a0055400-0000-4000-8000-000000000301', 'v1', '高一', 22, 'a0055400-0000-4000-8000-000000000302', 'SENIOR_G1', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000302', 'a0055400-0000-4000-8000-000000000302', 'v1', '高二', 23, 'a0055400-0000-4000-8000-000000000303', 'SENIOR_G2', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0055400-0000-4000-8000-000000000303', 'a0055400-0000-4000-8000-000000000303', 'v1', '高三', 24, NULL, 'SENIOR_G3', '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP),
    ('b0057500-0000-4000-8000-000000000209', 'a0057500-0000-4000-8000-000000000209', 'v1', '实验班', 25, NULL, NULL, '["FULL_YEAR","FIRST_TERM","SECOND_TERM"]', CURRENT_TIMESTAMP);

UPDATE "grade_configs" AS g SET "current_version_id" = v."id" FROM "grade_config_versions" AS v WHERE v."grade_config_id" = g."id" AND v."version" = 'v1';
INSERT INTO "subjects" ("id", "code", "label") VALUES
    ('d0050000-0001-4000-8001-000000000001', 'CHINESE', '语文'),
    ('d0050000-0002-4000-8001-000000000002', 'MATH', '数学'),
    ('d0050000-0003-4000-8001-000000000003', 'ENGLISH', '英语'),
    ('d0050000-0004-4000-8001-000000000004', 'READING', '阅读'),
    ('d0050000-0005-4000-8001-000000000005', 'SPORT', '运动'),
    ('d0050000-0006-4000-8001-000000000006', 'CUSTOM', '自定义');
INSERT INTO "plan_template_versions" ("id", "template_key", "version", "catalog_entry_key", "kind", "title", "summary", "content_json", "published_at") VALUES
    ('c0050000-0001-4000-8000-000000000139', 'TPL_PRIMARY_G1_DAILY', 'v1', 'PRIMARY_G1', 'DAILY', 'PRIMARY_G1 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0001-4000-8000-000000000239', 'TPL_PRIMARY_G1_READING_REVIEW', 'v1', 'PRIMARY_G1', 'READING_REVIEW', 'PRIMARY_G1 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0001-4000-8000-000000000339', 'TPL_PRIMARY_G1_WEEKLY', 'v1', 'PRIMARY_G1', 'WEEKLY', 'PRIMARY_G1 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0002-4000-8000-000000000139', 'TPL_PRIMARY_G2_DAILY', 'v1', 'PRIMARY_G2', 'DAILY', 'PRIMARY_G2 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0002-4000-8000-000000000239', 'TPL_PRIMARY_G2_READING_REVIEW', 'v1', 'PRIMARY_G2', 'READING_REVIEW', 'PRIMARY_G2 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0002-4000-8000-000000000339', 'TPL_PRIMARY_G2_WEEKLY', 'v1', 'PRIMARY_G2', 'WEEKLY', 'PRIMARY_G2 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0003-4000-8000-000000000139', 'TPL_PRIMARY_G3_DAILY', 'v1', 'PRIMARY_G3', 'DAILY', 'PRIMARY_G3 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0003-4000-8000-000000000239', 'TPL_PRIMARY_G3_READING_REVIEW', 'v1', 'PRIMARY_G3', 'READING_REVIEW', 'PRIMARY_G3 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0003-4000-8000-000000000339', 'TPL_PRIMARY_G3_WEEKLY', 'v1', 'PRIMARY_G3', 'WEEKLY', 'PRIMARY_G3 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0004-4000-8000-000000000139', 'TPL_PRIMARY_G4_DAILY', 'v1', 'PRIMARY_G4', 'DAILY', 'PRIMARY_G4 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0004-4000-8000-000000000239', 'TPL_PRIMARY_G4_READING_REVIEW', 'v1', 'PRIMARY_G4', 'READING_REVIEW', 'PRIMARY_G4 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0004-4000-8000-000000000339', 'TPL_PRIMARY_G4_WEEKLY', 'v1', 'PRIMARY_G4', 'WEEKLY', 'PRIMARY_G4 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0005-4000-8000-000000000139', 'TPL_PRIMARY_G5_DAILY', 'v1', 'PRIMARY_G5', 'DAILY', 'PRIMARY_G5 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0005-4000-8000-000000000239', 'TPL_PRIMARY_G5_READING_REVIEW', 'v1', 'PRIMARY_G5', 'READING_REVIEW', 'PRIMARY_G5 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0005-4000-8000-000000000339', 'TPL_PRIMARY_G5_WEEKLY', 'v1', 'PRIMARY_G5', 'WEEKLY', 'PRIMARY_G5 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0006-4000-8000-000000000139', 'TPL_PRIMARY_G6_DAILY', 'v1', 'PRIMARY_G6', 'DAILY', 'PRIMARY_G6 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0006-4000-8000-000000000239', 'TPL_PRIMARY_G6_READING_REVIEW', 'v1', 'PRIMARY_G6', 'READING_REVIEW', 'PRIMARY_G6 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0006-4000-8000-000000000339', 'TPL_PRIMARY_G6_WEEKLY', 'v1', 'PRIMARY_G6', 'WEEKLY', 'PRIMARY_G6 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0007-4000-8000-000000000139', 'TPL_JUNIOR_G1_DAILY', 'v1', 'JUNIOR_G1', 'DAILY', 'JUNIOR_G1 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0007-4000-8000-000000000239', 'TPL_JUNIOR_G1_READING_REVIEW', 'v1', 'JUNIOR_G1', 'READING_REVIEW', 'JUNIOR_G1 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0007-4000-8000-000000000339', 'TPL_JUNIOR_G1_WEEKLY', 'v1', 'JUNIOR_G1', 'WEEKLY', 'JUNIOR_G1 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0008-4000-8000-000000000139', 'TPL_JUNIOR_G2_DAILY', 'v1', 'JUNIOR_G2', 'DAILY', 'JUNIOR_G2 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0008-4000-8000-000000000239', 'TPL_JUNIOR_G2_READING_REVIEW', 'v1', 'JUNIOR_G2', 'READING_REVIEW', 'JUNIOR_G2 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0008-4000-8000-000000000339', 'TPL_JUNIOR_G2_WEEKLY', 'v1', 'JUNIOR_G2', 'WEEKLY', 'JUNIOR_G2 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0009-4000-8000-000000000139', 'TPL_JUNIOR_G3_DAILY', 'v1', 'JUNIOR_G3', 'DAILY', 'JUNIOR_G3 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0009-4000-8000-000000000239', 'TPL_JUNIOR_G3_READING_REVIEW', 'v1', 'JUNIOR_G3', 'READING_REVIEW', 'JUNIOR_G3 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0009-4000-8000-000000000339', 'TPL_JUNIOR_G3_WEEKLY', 'v1', 'JUNIOR_G3', 'WEEKLY', 'JUNIOR_G3 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0010-4000-8000-000000000139', 'TPL_JUNIOR_G4_DAILY', 'v1', 'JUNIOR_G4', 'DAILY', 'JUNIOR_G4 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0010-4000-8000-000000000239', 'TPL_JUNIOR_G4_READING_REVIEW', 'v1', 'JUNIOR_G4', 'READING_REVIEW', 'JUNIOR_G4 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0010-4000-8000-000000000339', 'TPL_JUNIOR_G4_WEEKLY', 'v1', 'JUNIOR_G4', 'WEEKLY', 'JUNIOR_G4 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0011-4000-8000-000000000139', 'TPL_SENIOR_G1_DAILY', 'v1', 'SENIOR_G1', 'DAILY', 'SENIOR_G1 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0011-4000-8000-000000000239', 'TPL_SENIOR_G1_READING_REVIEW', 'v1', 'SENIOR_G1', 'READING_REVIEW', 'SENIOR_G1 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0011-4000-8000-000000000339', 'TPL_SENIOR_G1_WEEKLY', 'v1', 'SENIOR_G1', 'WEEKLY', 'SENIOR_G1 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0012-4000-8000-000000000139', 'TPL_SENIOR_G2_DAILY', 'v1', 'SENIOR_G2', 'DAILY', 'SENIOR_G2 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0012-4000-8000-000000000239', 'TPL_SENIOR_G2_READING_REVIEW', 'v1', 'SENIOR_G2', 'READING_REVIEW', 'SENIOR_G2 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0012-4000-8000-000000000339', 'TPL_SENIOR_G2_WEEKLY', 'v1', 'SENIOR_G2', 'WEEKLY', 'SENIOR_G2 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0013-4000-8000-000000000139', 'TPL_SENIOR_G3_DAILY', 'v1', 'SENIOR_G3', 'DAILY', 'SENIOR_G3 · 日常安排', '把今天要做的两三件小事写清楚，做完可以勾掉。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"日常安排","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0013-4000-8000-000000000239', 'TPL_SENIOR_G3_READING_REVIEW', 'v1', 'SENIOR_G3', 'READING_REVIEW', 'SENIOR_G3 · 阅读或复习习惯', '留出一小段时间读或复习自己选的内容。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"阅读或复习习惯","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP),
    ('c0050000-0013-4000-8000-000000000339', 'TPL_SENIOR_G3_WEEKLY', 'v1', 'SENIOR_G3', 'WEEKLY', 'SENIOR_G3 · 周计划', '看一看这一周想完成的安排，可以随时改。', '{"note":"原创示例，可预览后修改或取消。不代表全国统一课表。","tasks":[{"name":"周计划","subject":"自定义","standard":"按自己的计划完成所选事项","durationMinutes":null}]}', CURRENT_TIMESTAMP);
