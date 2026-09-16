-- STP 004 identity, profiles, consents, sessions and rate-limit buckets.
-- Pure additive migration. Application rollback keeps these objects.
-- After real identity/child/consent data exists, do not drop tables; forward-fix instead.

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DISABLED', 'DELETION_PENDING', 'DELETED');
CREATE TYPE "StudentStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'RESTRICTED', 'DELETION_PENDING', 'DELETED');
CREATE TYPE "AgeBand" AS ENUM ('UNDER_14', 'AGE_14_TO_17', 'AGE_18_PLUS');
CREATE TYPE "GuardianRole" AS ENUM ('PRIMARY_GUARDIAN');
CREATE TYPE "GuardianLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "SessionScope" AS ENUM ('GUARDIAN', 'STUDENT');
CREATE TYPE "ChallengePurpose" AS ENUM ('SIGN_IN', 'GUARDIAN_STEP_UP');

CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "locked_until" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_identifier" BYTEA NOT NULL,
    "encryption_key_version" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_identities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "auth_identities_id_provider_kind_key" UNIQUE ("id", "provider", "kind"),
    CONSTRAINT "auth_identities_id_account_provider_kind_key" UNIQUE ("id", "account_id", "provider", "kind")
);

CREATE TABLE "auth_identity_lookups" (
    "id" UUID NOT NULL,
    "auth_identity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "lookup_key_version" TEXT NOT NULL,
    "subject_lookup_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_identity_lookups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_identity_lookups_identity_fk" FOREIGN KEY ("auth_identity_id", "provider", "kind") REFERENCES "auth_identities"("id", "provider", "kind") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "auth_identity_lookups_digest_key" UNIQUE ("provider", "kind", "lookup_key_version", "subject_lookup_digest"),
    CONSTRAINT "auth_identity_lookups_identity_version_key" UNIQUE ("auth_identity_id", "lookup_key_version"),
    CONSTRAINT "auth_identity_lookups_full_alias_key" UNIQUE ("auth_identity_id", "provider", "kind", "lookup_key_version", "subject_lookup_digest")
);

CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "status" "StudentStatus" NOT NULL DEFAULT 'ONBOARDING',
    "nickname" TEXT NOT NULL,
    "avatar_preset_id" TEXT NOT NULL,
    "age_band" "AgeBand" NOT NULL,
    "age_confirmation_source" TEXT NOT NULL,
    "age_confirmed_at" TIMESTAMPTZ(3) NOT NULL,
    "age_confirmed_by_account_id" UUID NOT NULL,
    "stage_code" TEXT,
    "school_system_code" TEXT,
    "grade_code" TEXT,
    "grade_label" TEXT,
    "term_code" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_by_account_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "restricted_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_profiles_created_by_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "student_profiles_age_confirmed_by_fkey" FOREIGN KEY ("age_confirmed_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "student_profiles_age_confirmation_ck" CHECK (
      "age_confirmation_source" <> '' AND "age_confirmed_at" IS NOT NULL AND "age_confirmed_by_account_id" IS NOT NULL
    )
);

CREATE TABLE "guardian_links" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "student_profile_id" UUID NOT NULL,
    "role" "GuardianRole" NOT NULL DEFAULT 'PRIMARY_GUARDIAN',
    "permission_set_key" TEXT NOT NULL DEFAULT 'PRIMARY_GUARDIAN_V1',
    "status" "GuardianLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "active_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    "revocation_reason_code" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "guardian_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guardian_links_account_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "guardian_links_student_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "guardian_links_revoked_by_fkey" FOREIGN KEY ("revoked_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "guardian_links_id_student_key" UNIQUE ("id", "student_profile_id"),
    CONSTRAINT "guardian_links_id_student_account_key" UNIQUE ("id", "student_profile_id", "account_id")
);

CREATE UNIQUE INDEX "guardian_links_one_active_per_pair" ON "guardian_links" ("account_id", "student_profile_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "guardian_links_one_active_primary" ON "guardian_links" ("student_profile_id") WHERE "status" = 'ACTIVE' AND "role" = 'PRIMARY_GUARDIAN';
CREATE INDEX "guardian_links_account_status_idx" ON "guardian_links" ("account_id", "status", "student_profile_id");
CREATE INDEX "guardian_links_student_status_idx" ON "guardian_links" ("student_profile_id", "status");

CREATE TABLE "consent_policies" (
    "id" UUID NOT NULL,
    "policy_key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "current_document_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "consent_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_policies_key_locale_key" UNIQUE ("policy_key", "locale")
);

CREATE TABLE "consent_document_versions" (
    "id" UUID NOT NULL,
    "consent_policy_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "content_format" TEXT NOT NULL,
    "content_body" TEXT NOT NULL,
    "content_digest" TEXT NOT NULL,
    "scope_canonical_json" TEXT NOT NULL,
    "scope_digest" TEXT NOT NULL,
    "scope_schema_version" TEXT NOT NULL,
    "digest_algorithm_version" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consent_document_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_document_versions_policy_fkey" FOREIGN KEY ("consent_policy_id") REFERENCES "consent_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_document_versions_policy_version_key" UNIQUE ("consent_policy_id", "version"),
    CONSTRAINT "consent_document_versions_id_policy_key" UNIQUE ("id", "consent_policy_id")
);

ALTER TABLE "consent_policies"
  ADD CONSTRAINT "consent_policies_current_version_fk"
  FOREIGN KEY ("current_document_version_id", "id")
  REFERENCES "consent_document_versions"("id", "consent_policy_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "student_profile_id" UUID NOT NULL,
    "guardian_link_id" UUID NOT NULL,
    "consent_policy_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "scope_snapshot" TEXT NOT NULL,
    "scope_digest" TEXT NOT NULL,
    "scope_schema_version" TEXT NOT NULL,
    "digest_algorithm_version" TEXT NOT NULL,
    "age_band_snapshot" "AgeBand" NOT NULL,
    "granted_by_account_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_by_account_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawal_reason_code" TEXT,
    "superseded_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_records_student_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_link_fk" FOREIGN KEY ("guardian_link_id", "student_profile_id", "granted_by_account_id") REFERENCES "guardian_links"("id", "student_profile_id", "account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_policy_fkey" FOREIGN KEY ("consent_policy_id") REFERENCES "consent_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_document_fk" FOREIGN KEY ("document_version_id", "consent_policy_id") REFERENCES "consent_document_versions"("id", "consent_policy_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_granted_by_fkey" FOREIGN KEY ("granted_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_withdraw_ck" CHECK (
      ("withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL AND "withdrawal_reason_code" IS NULL)
      OR ("withdrawn_at" IS NOT NULL AND "withdrawn_by_account_id" IS NOT NULL AND "withdrawal_reason_code" IS NOT NULL AND "withdrawn_at" >= "granted_at")
    )
);

CREATE UNIQUE INDEX "consent_records_one_current" ON "consent_records" ("student_profile_id", "consent_policy_id")
  WHERE "withdrawn_at" IS NULL AND "superseded_at" IS NULL;

CREATE TABLE "device_sessions" (
    "id" UUID NOT NULL,
    "scope" "SessionScope" NOT NULL,
    "account_id" UUID,
    "student_profile_id" UUID,
    "issued_by_guardian_link_id" UUID,
    "issued_by_account_id" UUID,
    "origin" TEXT NOT NULL,
    "credential_digest" TEXT NOT NULL,
    "csrf_digest" TEXT NOT NULL,
    "account_auth_version_at_issue" INTEGER,
    "issuer_auth_version_at_issue" INTEGER,
    "device_installation_digest" TEXT NOT NULL,
    "device_label" TEXT,
    "authenticated_at" TIMESTAMPTZ(3) NOT NULL,
    "step_up_verified_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason_code" TEXT,
    "replaced_by_session_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_sessions_credential_key" UNIQUE ("credential_digest"),
    CONSTRAINT "device_sessions_id_student_key" UNIQUE ("id", "student_profile_id"),
    CONSTRAINT "device_sessions_id_account_key" UNIQUE ("id", "account_id"),
    CONSTRAINT "device_sessions_account_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_sessions_student_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_sessions_issued_account_fkey" FOREIGN KEY ("issued_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_sessions_expires_ck" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "device_sessions_scope_ck" CHECK (
      ("scope" = 'GUARDIAN' AND "account_id" IS NOT NULL AND "account_auth_version_at_issue" IS NOT NULL
        AND "student_profile_id" IS NULL AND "issued_by_guardian_link_id" IS NULL AND "issued_by_account_id" IS NULL AND "issuer_auth_version_at_issue" IS NULL)
      OR
      ("scope" = 'STUDENT' AND "account_id" IS NULL AND "account_auth_version_at_issue" IS NULL
        AND "student_profile_id" IS NOT NULL AND "issued_by_guardian_link_id" IS NOT NULL AND "issued_by_account_id" IS NOT NULL AND "issuer_auth_version_at_issue" IS NOT NULL)
    )
);

ALTER TABLE "device_sessions"
  ADD CONSTRAINT "device_sessions_link_fk"
  FOREIGN KEY ("issued_by_guardian_link_id", "student_profile_id", "issued_by_account_id")
  REFERENCES "guardian_links"("id", "student_profile_id", "account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "device_sessions"
  ADD CONSTRAINT "device_sessions_replaced_by_fkey"
  FOREIGN KEY ("replaced_by_session_id") REFERENCES "device_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "purpose" "ChallengePurpose" NOT NULL,
    "identity_kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" UUID,
    "auth_identity_id" UUID,
    "bound_session_id" UUID,
    "device_installation_digest" TEXT NOT NULL,
    "destination_lookup_digest" TEXT NOT NULL,
    "destination_lookup_key_version" TEXT NOT NULL,
    "encrypted_destination" BYTEA,
    "code_digest" TEXT NOT NULL,
    "code_digest_key_version" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_challenges_account_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "auth_challenges_session_fkey" FOREIGN KEY ("bound_session_id") REFERENCES "device_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "auth_challenges_purpose_ck" CHECK (
      ("purpose" = 'SIGN_IN' AND "bound_session_id" IS NULL)
      OR
      ("purpose" = 'GUARDIAN_STEP_UP' AND "bound_session_id" IS NOT NULL AND "account_id" IS NOT NULL AND "auth_identity_id" IS NOT NULL)
    )
);

ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_identity_fk"
  FOREIGN KEY ("auth_identity_id", "account_id", "provider", "identity_kind")
  REFERENCES "auth_identities"("id", "account_id", "provider", "kind")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "device_pairings" (
    "id" UUID NOT NULL,
    "student_profile_id" UUID NOT NULL,
    "issued_by_guardian_link_id" UUID NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_by_session_id" UUID NOT NULL,
    "code_digest" TEXT NOT NULL,
    "digest_key_version" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "consumed_by_session_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_pairings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_pairings_digest_key" UNIQUE ("digest_key_version", "code_digest"),
    CONSTRAINT "device_pairings_consumed_session_key" UNIQUE ("consumed_by_session_id"),
    CONSTRAINT "device_pairings_student_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_pairings_account_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_pairings_link_fk" FOREIGN KEY ("issued_by_guardian_link_id", "student_profile_id", "created_by_account_id") REFERENCES "guardian_links"("id", "student_profile_id", "account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_pairings_created_session_fk" FOREIGN KEY ("created_by_session_id", "created_by_account_id") REFERENCES "device_sessions"("id", "account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_pairings_consumed_session_fk" FOREIGN KEY ("consumed_by_session_id", "student_profile_id") REFERENCES "device_sessions"("id", "student_profile_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_pairings_terminal_ck" CHECK (
      (("consumed_at" IS NULL AND "consumed_by_session_id" IS NULL) OR ("consumed_at" IS NOT NULL AND "consumed_by_session_id" IS NOT NULL))
      AND NOT ("consumed_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
      AND NOT ("locked_at" IS NOT NULL AND "consumed_at" IS NOT NULL)
    )
);

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "actor_scope" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key_digest" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "response_status" INTEGER,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_records_scope_key" UNIQUE ("actor_scope", "actor_id", "operation", "key_digest")
);

CREATE TABLE "rate_limit_buckets" (
    "id" UUID NOT NULL,
    "bucket_key" TEXT NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rate_limit_buckets_window_key" UNIQUE ("bucket_key", "window_started_at")
);

CREATE OR REPLACE FUNCTION stp004_reject_published_document_mutation()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published consent document is immutable';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'published consent document is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_document_versions_immutable
BEFORE UPDATE OR DELETE ON "consent_document_versions"
FOR EACH ROW EXECUTE FUNCTION stp004_reject_published_document_mutation();

CREATE OR REPLACE FUNCTION stp004_current_policy_must_be_published()
RETURNS trigger AS $$
DECLARE
  published_at TIMESTAMPTZ;
  version_policy UUID;
BEGIN
  IF NEW.current_document_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT d.published_at, d.consent_policy_id
    INTO published_at, version_policy
    FROM consent_document_versions d
   WHERE d.id = NEW.current_document_version_id;
  IF published_at IS NULL OR version_policy IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'current policy pointer must reference a published version of the same policy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_policies_current_published
BEFORE INSERT OR UPDATE ON "consent_policies"
FOR EACH ROW EXECUTE FUNCTION stp004_current_policy_must_be_published();
