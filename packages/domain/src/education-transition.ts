import {
  isCompleteEducationSnapshot,
  isEmptyEducationSnapshot,
  isLeftoverEducationSnapshot,
  isTermCode,
  type EducationChangeKind,
  type EducationSnapshot,
  type TermCode,
} from './grade.js';

export type GradeCatalogRow = {
  id: string;
  schoolSystemCode: string;
  stageCode: string;
  gradeCode: string;
  gradeLabel: string;
  nextGradeConfigId: string | null;
  allowedTermCodes: readonly TermCode[];
  versionId?: string;
};

export type EducationTransitionInput = {
  from: EducationSnapshot;
  kind: EducationChangeKind;
  target: GradeCatalogRow | null;
  term: string | null | undefined;
  catalog: readonly GradeCatalogRow[];
  lastChangeKind?: EducationChangeKind | null;
};

export type EducationTransitionSuccess = {
  ok: true;
  to: EducationSnapshot & { gradeConfigVersionId: string | null };
};

export type EducationTransitionFailure = {
  ok: false;
  code: 'GRADE_CHANGE_NOT_ALLOWED' | 'GRADE_CONFIG_INVALID';
  message: string;
};

export type EducationTransitionResult = EducationTransitionSuccess | EducationTransitionFailure;

function emptyTo(): EducationSnapshot & { gradeConfigVersionId: string | null } {
  return {
    gradeConfigId: null,
    gradeConfigVersionId: null,
    stageCode: null,
    schoolSystemCode: null,
    gradeCode: null,
    gradeLabel: null,
    termCode: null,
  };
}

function assignedTo(
  target: GradeCatalogRow,
  term: TermCode,
): EducationSnapshot & { gradeConfigVersionId: string | null } {
  return {
    gradeConfigId: target.id,
    gradeConfigVersionId: target.versionId ?? null,
    stageCode: target.stageCode,
    schoolSystemCode: target.schoolSystemCode,
    gradeCode: target.gradeCode,
    gradeLabel: target.gradeLabel,
    termCode: term,
  };
}

function fail(message: string, code: EducationTransitionFailure['code'] = 'GRADE_CHANGE_NOT_ALLOWED'): EducationTransitionFailure {
  return { ok: false, code, message };
}

function catalogById(catalog: readonly GradeCatalogRow[]): Map<string, GradeCatalogRow> {
  return new Map(catalog.map((row) => [row.id, row]));
}

function isForwardSkip(from: GradeCatalogRow, to: GradeCatalogRow, catalog: Map<string, GradeCatalogRow>): boolean {
  if (from.schoolSystemCode !== to.schoolSystemCode) {
    return false;
  }
  if (!from.nextGradeConfigId || from.nextGradeConfigId === to.id) {
    return false;
  }
  let cursorId: string | null = from.nextGradeConfigId;
  const seen = new Set<string>();
  while (cursorId && !seen.has(cursorId)) {
    seen.add(cursorId);
    const row = catalog.get(cursorId);
    if (!row) {
      return false;
    }
    if (row.nextGradeConfigId === to.id) {
      return true;
    }
    cursorId = row.nextGradeConfigId;
  }
  return false;
}

function requireAssignedTarget(
  target: GradeCatalogRow | null,
  term: string | null | undefined,
): EducationTransitionFailure | { target: GradeCatalogRow; term: TermCode } {
  if (!target) {
    return fail('必须指向已发布年级', 'GRADE_CONFIG_INVALID');
  }
  if (!target.versionId) {
    return fail('必须指向已发布年级版本', 'GRADE_CONFIG_INVALID');
  }
  if (!isTermCode(term) || !target.allowedTermCodes.includes(term)) {
    return fail('学期无效', 'GRADE_CONFIG_INVALID');
  }
  return { target, term };
}

export function evaluateEducationChange(input: EducationTransitionInput): EducationTransitionResult {
  const leftover = isLeftoverEducationSnapshot(input.from);
  const empty = isEmptyEducationSnapshot(input.from);
  const assigned = isCompleteEducationSnapshot(input.from);
  if (!leftover && !empty && !assigned) {
    return fail('教育快照不完整，不能修改');
  }

  if (leftover) {
    if (input.kind !== 'SET') {
      return fail('遗留快照只能显式 SET 到已发布目录，禁止改写或清空');
    }
    const checked = requireAssignedTarget(input.target, input.term);
    if ('ok' in checked) {
      return checked;
    }
    return { ok: true, to: assignedTo(checked.target, checked.term) };
  }

  if (empty) {
    if (input.kind === 'LEAVE') {
      return fail('空档案不能 LEAVE');
    }
    if (input.kind === 'RESUME' && input.lastChangeKind !== 'LEAVE') {
      return fail('空档案不能 RESUME');
    }
    if (input.kind !== 'SET' && input.kind !== 'RESUME') {
      return fail('空档案只能 SET 或在 LEAVE 之后 RESUME');
    }
    const checked = requireAssignedTarget(input.target, input.term);
    if ('ok' in checked) {
      return checked;
    }
    return { ok: true, to: assignedTo(checked.target, checked.term) };
  }

  const fromId = input.from.gradeConfigId;
  const current = fromId ? catalogById(input.catalog).get(fromId) : undefined;
  if (!current) {
    return fail('当前年级目录行无效', 'GRADE_CONFIG_INVALID');
  }

  if (input.kind === 'SET') {
    return fail('已配置年级不能再用 SET');
  }
  if (input.kind === 'LEAVE') {
    if (input.target) {
      return fail('LEAVE 不能指向目录行');
    }
    return { ok: true, to: emptyTo() };
  }
  if (input.kind === 'RESUME') {
    return fail('当前已有年级，不能 RESUME');
  }

  const checked = requireAssignedTarget(input.target, input.term);
  if ('ok' in checked) {
    return checked;
  }
  const { target, term } = checked;

  if (input.kind === 'TERM_SWITCH') {
    if (target.id !== current.id || term === input.from.termCode) {
      return fail('学期切换必须保持同一目录行并更换学期');
    }
    return { ok: true, to: assignedTo(target, term) };
  }
  if (input.kind === 'REPEAT') {
    if (target.id !== current.id) {
      return fail('留级必须指向当前年级');
    }
    if (term !== input.from.termCode) {
      return fail('REPEAT 不能同时改学期');
    }
    return { ok: true, to: assignedTo(target, term) };
  }
  if (input.kind === 'PROMOTE') {
    if (current.nextGradeConfigId !== target.id) {
      return fail('升年级必须指向目录建议的下一档');
    }
    return { ok: true, to: assignedTo(target, term) };
  }
  if (input.kind === 'SYSTEM_SWITCH') {
    if (current.schoolSystemCode === target.schoolSystemCode) {
      return fail('跨学制必须更换 schoolSystemCode');
    }
    return { ok: true, to: assignedTo(target, term) };
  }
  if (input.kind === 'SKIP') {
    if (current.schoolSystemCode !== target.schoolSystemCode) {
      return fail('SKIP 不能跨学制');
    }
    if (!isForwardSkip(current, target, catalogById(input.catalog))) {
      return fail('SKIP 不能倒退，也不能是当前档或下一档');
    }
    return { ok: true, to: assignedTo(target, term) };
  }
  return fail('不支持的变更种类');
}
