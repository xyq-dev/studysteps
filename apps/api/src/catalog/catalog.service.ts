import { Injectable } from '@nestjs/common';
import {
  canImportTemplates,
  canRecommendTemplates,
  isCompleteEducationSnapshot,
  type TermCode,
} from '@studysteps/domain';
import type { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export type PublishedGradeView = {
  id: string;
  versionId: string;
  schoolSystemCode: string;
  stageCode: string;
  gradeCode: string;
  gradeLabel: string;
  catalogEntryKey: string | null;
  nextGradeConfigId: string | null;
  allowedTermCodes: TermCode[];
  version: string;
};

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listGradeConfigs() {
    return { items: await this.loadPublishedGrades() };
  }

  async listTemplates(catalogEntryKey: string | null) {
    const templates = await this.prisma.planTemplateVersion.findMany({
      where: { publishedAt: { not: null } },
      orderBy: [{ catalogEntryKey: 'asc' }, { kind: 'asc' }],
    });
    const importAllowed = canImportTemplates(catalogEntryKey);
    const recommended = canRecommendTemplates(catalogEntryKey)
      ? templates.filter((item) => item.catalogEntryKey === catalogEntryKey).map((item) => item.id)
      : [];
    return {
      items: templates.map((item) => ({
        id: item.id,
        templateKey: item.templateKey,
        version: item.version,
        catalogEntryKey: item.catalogEntryKey,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        content: JSON.parse(item.contentJson) as unknown,
      })),
      recommendedTemplateIds: recommended,
      importAllowed,
      catalogEntryKey,
    };
  }

  async assertImportAllowed(catalogEntryKey: string | null, templateId: string) {
    if (!canImportTemplates(catalogEntryKey)) {
      throw new AppError('TEMPLATE_IMPORT_NOT_ALLOWED', '当前年级没有合法模板映射，不能导入', 400);
    }
    const template = await this.prisma.planTemplateVersion.findFirst({
      where: { id: templateId, publishedAt: { not: null } },
    });
    if (!template) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    return template;
  }

  async catalogEntryKeyForStudent(studentId: string): Promise<string | null> {
    const student = await this.prisma.studentProfile.findUnique({ where: { id: studentId } });
    if (!student?.gradeConfigVersionId) {
      return null;
    }
    const version = await this.prisma.gradeConfigVersion.findUnique({ where: { id: student.gradeConfigVersionId } });
    return version?.catalogEntryKey ?? null;
  }

  async loadPublishedGrades(db: PrismaService | Tx = this.prisma): Promise<PublishedGradeView[]> {
    const rows = await db.gradeConfig.findMany({
      where: { currentVersionId: { not: null } },
      include: { documents: true },
      orderBy: [{ schoolSystemCode: 'asc' }, { stageCode: 'asc' }, { gradeCode: 'asc' }],
    });
    return rows
      .map((row) => {
        const current = row.documents.find((item) => item.id === row.currentVersionId);
        if (!current?.publishedAt) {
          return null;
        }
        return {
          id: row.id,
          versionId: current.id,
          schoolSystemCode: row.schoolSystemCode,
          stageCode: row.stageCode,
          gradeCode: row.gradeCode,
          gradeLabel: current.gradeLabel,
          catalogEntryKey: current.catalogEntryKey,
          nextGradeConfigId: current.nextGradeConfigId,
          allowedTermCodes: JSON.parse(current.allowedTermCodes) as TermCode[],
          version: current.version,
        };
      })
      .filter((item): item is PublishedGradeView => item != null);
  }

  async requirePublishedGrade(db: Tx | PrismaService, gradeConfigId: string): Promise<PublishedGradeView> {
    const items = await this.loadPublishedGrades(db);
    const found = items.find((item) => item.id === gradeConfigId);
    if (!found) {
      throw new AppError('GRADE_CONFIG_INVALID', '年级配置无效', 400);
    }
    return found;
  }
}

export function educationIsAssigned(student: {
  gradeConfigId: string | null;
  stageCode: string | null;
  schoolSystemCode: string | null;
  gradeCode: string | null;
  gradeLabel: string | null;
  termCode: string | null;
}): boolean {
  return isCompleteEducationSnapshot(student);
}
