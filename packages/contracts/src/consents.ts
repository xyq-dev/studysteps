import { z } from 'zod';

export const grantConsentSchema = z.object({
  expectedStudentVersion: z.number().int().positive(),
  acceptances: z
    .array(
      z.object({
        policyKey: z.string().min(1).max(64),
        version: z.string().min(1).max(64),
      }),
    )
    .min(1),
});

export const withdrawConsentSchema = z.object({
  reasonCode: z.enum(['GUARDIAN_REQUEST', 'POLICY_CHANGE', 'OTHER']),
});

export const createPairingSchema = z.object({
  deviceLabel: z.string().min(1).max(64).optional(),
});

export const revokeDeviceSchema = z.object({
  reasonCode: z.enum(['GUARDIAN_REQUEST', 'LOST_DEVICE', 'OTHER']),
});

export type GrantConsentInput = z.infer<typeof grantConsentSchema>;
export type WithdrawConsentInput = z.infer<typeof withdrawConsentSchema>;
