import { z } from 'zod';

const isoWeekdaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

export const planSeriesInputSchema = z.object({
  name: z.string().min(1).max(64),
  subject: z.string().min(1).max(32),
  standard: z.string().min(1).max(240),
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  steps: z.array(z.string().min(1).max(120)).max(12).optional(),
  repeatKind: z.enum(['ONCE', 'DAILY', 'WEEKLY_DAYS']).optional(),
  weekdays: z.array(isoWeekdaySchema).min(1).max(7).nullable().optional(),
  startLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  ongoing: z.boolean().optional(),
});

export const previewTemplateSchema = z.object({
  tasks: z.array(planSeriesInputSchema).min(1).max(20).optional(),
});

export const importTemplateConfirmSchema = z.object({
  expectedStudentVersion: z.number().int().positive(),
  previewDigest: z.string().min(16).max(128),
  templateVersion: z.string().min(1).max(32),
  tasks: z.array(planSeriesInputSchema).min(1).max(20),
  coCreationAttested: z.boolean().optional(),
});

export const listTasksQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const taskHorizonSchema = z.object({
  expectedStudentVersion: z.number().int().positive().optional(),
});

export type PreviewTemplateInput = z.infer<typeof previewTemplateSchema>;
export type ImportTemplateConfirmInput = z.infer<typeof importTemplateConfirmSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type TaskHorizonInput = z.infer<typeof taskHorizonSchema>;
