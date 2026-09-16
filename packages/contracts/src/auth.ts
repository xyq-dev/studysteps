import { z } from 'zod';

export const deviceInputSchema = z.object({
  installationId: z.string().min(8).max(128),
  label: z.string().min(1).max(64).optional(),
});

export const requestAuthCodeSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('SIGN_IN'),
    identity: z.object({
      kind: z.literal('PHONE'),
      value: z.string().min(1).max(32),
    }),
    device: deviceInputSchema,
  }),
  z.object({
    purpose: z.literal('GUARDIAN_STEP_UP'),
    device: deviceInputSchema,
  }),
]);

export const createSessionSchema = z.discriminatedUnion('grantType', [
  z.object({
    grantType: z.literal('VERIFICATION_CODE'),
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
    device: deviceInputSchema,
  }),
  z.object({
    grantType: z.literal('GUARDIAN_STEP_UP'),
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
    device: deviceInputSchema,
  }),
  z.object({
    grantType: z.literal('STUDENT_MODE'),
    studentId: z.string().uuid(),
  }),
  z.object({
    grantType: z.literal('PAIRING_CODE'),
    pairingId: z.string().uuid(),
    code: z.string().min(4).max(16),
    device: deviceInputSchema,
  }),
]);

export type RequestAuthCodeInput = z.infer<typeof requestAuthCodeSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export type SessionView = {
  scope: 'GUARDIAN' | 'STUDENT';
  studentId: string | null;
  expiresAt: string;
  stepUpValidUntil: string | null;
};

export type AuthCodeAccepted = {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export type SessionGranted = {
  session: SessionView;
  serverTime: string;
};
