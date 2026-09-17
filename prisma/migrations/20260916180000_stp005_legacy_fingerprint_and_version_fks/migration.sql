-- STP 005 follow-up: consume the trusted leftover allowlist captured in
-- 20260916120000, validate assigned rows and current pointers, then install
-- composite FKs and exact snapshot guards.
-- Additive. Does not rewrite the first four STP 004 migrations.
-- created_at is not provenance. Old sixth-migration fingerprints are not a source.
-- No wipe, no guess-fill, no label correction.

LOCK TABLE "student_profiles" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "grade_configs" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "grade_config_versions" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.stp005_trusted_legacy_allowlist') IS NULL THEN
    RAISE EXCEPTION 'stp005 trusted legacy allowlist missing; refuse fingerprints from a prior sixth migration';
  END IF;
END $$;

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

CREATE OR REPLACE FUNCTION stp005_education_all_null(
  grade_config_id UUID,
  grade_config_version_id UUID,
  stage_code TEXT,
  school_system_code TEXT,
  grade_code TEXT,
  grade_label TEXT,
  term_code TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN grade_config_id IS NULL
    AND grade_config_version_id IS NULL
    AND stage_code IS NULL
    AND school_system_code IS NULL
    AND grade_code IS NULL
    AND grade_label IS NULL
    AND term_code IS NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION stp005_education_leftover_shape(
  grade_config_id UUID,
  grade_config_version_id UUID,
  stage_code TEXT,
  school_system_code TEXT,
  grade_code TEXT,
  grade_label TEXT,
  term_code TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN grade_config_id IS NULL
    AND grade_config_version_id IS NULL
    AND NOT (
      stage_code IS NULL
      AND school_system_code IS NULL
      AND grade_code IS NULL
      AND grade_label IS NULL
      AND term_code IS NULL
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE
  unknown_leftover INTEGER;
  dirty_current INTEGER;
  dirty_assigned INTEGER;
BEGIN
  SELECT COUNT(*) INTO unknown_leftover
    FROM student_profiles sp
   WHERE NOT (
           sp.stage_code IS NULL
           AND sp.school_system_code IS NULL
           AND sp.grade_code IS NULL
           AND sp.grade_label IS NULL
           AND sp.term_code IS NULL
         )
     AND sp.grade_config_id IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM stp005_trusted_legacy_allowlist a
        WHERE a.student_profile_id = sp.id
          AND a.stage_code IS NOT DISTINCT FROM sp.stage_code
          AND a.school_system_code IS NOT DISTINCT FROM sp.school_system_code
          AND a.grade_code IS NOT DISTINCT FROM sp.grade_code
          AND a.grade_label IS NOT DISTINCT FROM sp.grade_label
          AND a.term_code IS NOT DISTINCT FROM sp.term_code
          AND a.tuple_digest = stp005_legacy_tuple_digest(
            sp.stage_code, sp.school_system_code, sp.grade_code, sp.grade_label, sp.term_code
          )
     );

  IF unknown_leftover > 0 THEN
    RAISE EXCEPTION 'stp005 leftover is outside the trusted allowlist or tuple rewritten (% rows); refuse to wipe or guess-fill', unknown_leftover;
  END IF;

  SELECT COUNT(*) INTO dirty_current
    FROM grade_configs g
   WHERE g.current_version_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM grade_config_versions v
        WHERE v.id = g.current_version_id
          AND v.grade_config_id = g.id
          AND v.published_at IS NOT NULL
     );

  IF dirty_current > 0 THEN
    RAISE EXCEPTION 'stp005 current grade version is unpublished or does not belong to its config (% rows); refuse to guess-map', dirty_current;
  END IF;

  SELECT COUNT(*) INTO dirty_assigned
    FROM student_profiles sp
    LEFT JOIN grade_configs g ON g.id = sp.grade_config_id
    LEFT JOIN grade_config_versions v ON v.id = g.current_version_id AND v.grade_config_id = g.id
   WHERE sp.grade_config_id IS NOT NULL
     AND (
       g.id IS NULL
       OR v.id IS NULL
       OR v.published_at IS NULL
       OR v.grade_config_id IS DISTINCT FROM g.id
       OR sp.school_system_code IS DISTINCT FROM g.school_system_code
       OR sp.stage_code IS DISTINCT FROM g.stage_code
       OR sp.grade_code IS DISTINCT FROM g.grade_code
       OR sp.grade_label IS DISTINCT FROM v.grade_label
       OR sp.term_code IS NULL
       OR v.allowed_term_codes IS NULL
       OR NOT (v.allowed_term_codes::jsonb ? sp.term_code)
     );

  IF dirty_assigned > 0 THEN
    RAISE EXCEPTION 'stp005 assigned education snapshot does not exactly match the published current version (% rows); refuse to correct labels or guess-map', dirty_assigned;
  END IF;
END $$;

ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "grade_config_version_id" UUID;

UPDATE "student_profiles" AS sp
SET "grade_config_version_id" = g."current_version_id"
FROM "grade_configs" AS g
WHERE sp."grade_config_id" = g."id"
  AND sp."grade_config_id" IS NOT NULL
  AND sp."grade_config_version_id" IS NULL;

ALTER TABLE "grade_configs" DROP CONSTRAINT IF EXISTS "grade_configs_current_version_fk";
ALTER TABLE "grade_configs"
  ADD CONSTRAINT "grade_configs_current_version_fk"
  FOREIGN KEY ("current_version_id", "id")
  REFERENCES "grade_config_versions" ("id", "grade_config_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_grade_version_fk"
  FOREIGN KEY ("grade_config_version_id", "grade_config_id")
  REFERENCES "grade_config_versions" ("id", "grade_config_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_profiles" DROP CONSTRAINT IF EXISTS "student_profiles_education_assigned_ck";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_education_shape_ck" CHECK (
    stp005_education_all_null(
      "grade_config_id", "grade_config_version_id", "stage_code", "school_system_code", "grade_code", "grade_label", "term_code"
    )
    OR (
      "grade_config_id" IS NOT NULL
      AND "grade_config_version_id" IS NOT NULL
      AND "stage_code" IS NOT NULL
      AND "school_system_code" IS NOT NULL
      AND "grade_code" IS NOT NULL
      AND "grade_label" IS NOT NULL
      AND "term_code" IN ('FULL_YEAR', 'FIRST_TERM', 'SECOND_TERM')
    )
    OR stp005_education_leftover_shape(
      "grade_config_id", "grade_config_version_id", "stage_code", "school_system_code", "grade_code", "grade_label", "term_code"
    )
  );

CREATE OR REPLACE FUNCTION stp005_current_version_must_be_published()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM grade_config_versions v
     WHERE v.id = NEW.current_version_id
       AND v.grade_config_id = NEW.id
       AND v.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'current grade version must be published and belong to the config';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS grade_configs_current_published ON "grade_configs";
CREATE TRIGGER grade_configs_current_published
BEFORE INSERT OR UPDATE ON "grade_configs"
FOR EACH ROW EXECUTE FUNCTION stp005_current_version_must_be_published();

CREATE OR REPLACE FUNCTION stp005_student_education_guard()
RETURNS TRIGGER AS $$
DECLARE
  allowed TEXT;
  leftover_match BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT'
     AND stp005_education_leftover_shape(
           NEW.grade_config_id, NEW.grade_config_version_id, NEW.stage_code, NEW.school_system_code, NEW.grade_code, NEW.grade_label, NEW.term_code
         ) THEN
    RAISE EXCEPTION 'new leftover education snapshots are not allowed';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF stp005_education_leftover_shape(
         OLD.grade_config_id, OLD.grade_config_version_id, OLD.stage_code, OLD.school_system_code, OLD.grade_code, OLD.grade_label, OLD.term_code
       )
       AND stp005_education_leftover_shape(
         NEW.grade_config_id, NEW.grade_config_version_id, NEW.stage_code, NEW.school_system_code, NEW.grade_code, NEW.grade_label, NEW.term_code
       )
       AND (
         OLD.stage_code IS DISTINCT FROM NEW.stage_code
         OR OLD.school_system_code IS DISTINCT FROM NEW.school_system_code
         OR OLD.grade_code IS DISTINCT FROM NEW.grade_code
         OR OLD.grade_label IS DISTINCT FROM NEW.grade_label
         OR OLD.term_code IS DISTINCT FROM NEW.term_code
       ) THEN
      RAISE EXCEPTION 'legacy leftover education tuples are immutable';
    END IF;

    IF NOT stp005_education_leftover_shape(
         OLD.grade_config_id, OLD.grade_config_version_id, OLD.stage_code, OLD.school_system_code, OLD.grade_code, OLD.grade_label, OLD.term_code
       )
       AND stp005_education_leftover_shape(
         NEW.grade_config_id, NEW.grade_config_version_id, NEW.stage_code, NEW.school_system_code, NEW.grade_code, NEW.grade_label, NEW.term_code
       ) THEN
      RAISE EXCEPTION 'cannot revert assigned or empty education to leftover';
    END IF;
  END IF;

  IF stp005_education_leftover_shape(
       NEW.grade_config_id, NEW.grade_config_version_id, NEW.stage_code, NEW.school_system_code, NEW.grade_code, NEW.grade_label, NEW.term_code
     ) THEN
    SELECT EXISTS (
      SELECT 1
        FROM stp005_trusted_legacy_allowlist a
       WHERE a.student_profile_id = NEW.id
         AND a.stage_code IS NOT DISTINCT FROM NEW.stage_code
         AND a.school_system_code IS NOT DISTINCT FROM NEW.school_system_code
         AND a.grade_code IS NOT DISTINCT FROM NEW.grade_code
         AND a.grade_label IS NOT DISTINCT FROM NEW.grade_label
         AND a.term_code IS NOT DISTINCT FROM NEW.term_code
         AND a.tuple_digest = stp005_legacy_tuple_digest(
           NEW.stage_code, NEW.school_system_code, NEW.grade_code, NEW.grade_label, NEW.term_code
         )
    ) INTO leftover_match;
    IF leftover_match IS NOT TRUE THEN
      RAISE EXCEPTION 'legacy leftover must match the trusted allowlist tuple';
    END IF;
  END IF;

  IF NEW.grade_config_id IS NOT NULL THEN
    SELECT v.allowed_term_codes INTO allowed
      FROM grade_config_versions v
      JOIN grade_configs g ON g.id = v.grade_config_id
     WHERE v.id = NEW.grade_config_version_id
       AND v.grade_config_id = NEW.grade_config_id
       AND g.id = NEW.grade_config_id
       AND g.current_version_id = v.id
       AND v.published_at IS NOT NULL
       AND g.school_system_code = NEW.school_system_code
       AND g.stage_code = NEW.stage_code
       AND g.grade_code = NEW.grade_code
       AND v.grade_label = NEW.grade_label;
    IF allowed IS NULL OR NOT (allowed::jsonb ? NEW.term_code) THEN
      RAISE EXCEPTION 'education snapshot must match the published grade version exactly';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS student_profiles_education_guard ON "student_profiles";
CREATE TRIGGER student_profiles_education_guard
BEFORE INSERT OR UPDATE ON "student_profiles"
FOR EACH ROW EXECUTE FUNCTION stp005_student_education_guard();
