import { z } from 'zod';

export const ageBandSchema = z.enum(['UNDER_14', 'AGE_14_TO_17', 'AGE_18_PLUS']);
export const educationSnapshotSchema = z.object({
  stageCode: z.string().min(1).max(32).nullable(),
  schoolSystemCode: z.string().min(1).max(32).nullable(),
  gradeCode: z.string().min(1).max(32).nullable(),
  gradeLabel: z.string().min(1).max(64).nullable(),
  termCode: z.string().min(1).max(32).nullable(),
});

export const createStudentSchema = z.object({
  profile: z.object({
    nickname: z.string().min(1).max(32),
    avatarPresetId: z.string().min(1).max(32),
    timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
  }),
  ageConfirmation: z.object({
    band: ageBandSchema,
    source: z.literal('GUARDIAN_DECLARATION'),
  }),
  education: educationSnapshotSchema.optional(),
  consentAcceptances: z
    .array(
      z.object({
        policyKey: z.string().min(1).max(64),
        version: z.string().min(1).max(64),
      }),
    )
    .min(1),
});

export const patchStudentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('BASIC'),
    expectedVersion: z.number().int().positive(),
    nickname: z.string().min(1).max(32).optional(),
    avatarPresetId: z.string().min(1).max(32).optional(),
    timezone: z.string().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal('AGE'),
    expectedVersion: z.number().int().positive(),
    band: ageBandSchema,
    source: z.literal('GUARDIAN_DECLARATION'),
    consentAcceptances: z
      .array(
        z.object({
          policyKey: z.string().min(1).max(64),
          version: z.string().min(1).max(64),
        }),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal('EDUCATION'),
    expectedVersion: z.number().int().positive(),
    education: educationSnapshotSchema,
  }),
]);

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type PatchStudentInput = z.infer<typeof patchStudentSchema>;

export type LearningAccess = {
  allowed: false;
  reason: 'ACADEMIC_CONFIGURATION_PENDING' | 'RESTRICTED' | 'CONSENT_REQUIRED';
};

export type StudentSummary = {
  id: string;
  nickname: string;
  avatarPresetId: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'RESTRICTED';
  ageBand: 'UNDER_14' | 'AGE_14_TO_17';
  version: number;
};
