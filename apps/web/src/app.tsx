import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME, GUARDIAN_DECLARATION_TEXT } from '@studysteps/contracts';
import { StatusBanner } from '@studysteps/ui';

type Screen = 's01' | 's02' | 'p05' | 'p06' | 's07' | 's03' | 's05' | 's06' | 's08' | 'student';
type PreviewTask = {
  name: string;
  subject: string;
  standard: string;
  durationMinutes?: number | null;
  steps?: string[];
  repeatKind?: string;
  weekdays?: number[] | null;
  startLocalDate?: string;
  endLocalDate?: string | null;
  ongoing?: boolean;
};
type TermCode = 'FULL_YEAR' | 'FIRST_TERM' | 'SECOND_TERM';
type ChangeKind = 'SET' | 'PROMOTE' | 'REPEAT' | 'SKIP' | 'LEAVE' | 'RESUME' | 'SYSTEM_SWITCH' | 'TERM_SWITCH';
type GradeItem = {
  id: string;
  gradeLabel: string;
  schoolSystemCode: string;
  catalogEntryKey: string | null;
  version: string;
  versionId: string;
};
type EducationDetail = {
  gradeConfigId: string | null;
  schoolSystemCode: string | null;
  gradeLabel: string | null;
  termCode: string | null;
};

const ACTIVE_STUDENT_KEY = 'stp.ui.activeStudentId';
const TASK_EXTRA_DATES_KEY = 'stp.ui.taskExtraDates';

function isTermCode(value: string | null | undefined): value is TermCode {
  return value === 'FULL_YEAR' || value === 'FIRST_TERM' || value === 'SECOND_TERM';
}

function readStoredStudentId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_STUDENT_KEY);
  } catch {
    return null;
  }
}

function writeStoredStudentId(id: string | null) {
  try {
    if (id) {
      sessionStorage.setItem(ACTIVE_STUDENT_KEY, id);
    } else {
      sessionStorage.removeItem(ACTIVE_STUDENT_KEY);
    }
  } catch {
    /* ignore private-mode quota */
  }
}

function readTaskExtraDates(): string[] {
  try {
    const raw = sessionStorage.getItem(TASK_EXTRA_DATES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rememberTaskExtraDates(dates: string[]) {
  const merged = [...new Set([...readTaskExtraDates(), ...dates.filter(Boolean)])];
  try {
    sessionStorage.setItem(TASK_EXTRA_DATES_KEY, JSON.stringify(merged));
  } catch {
    /* ignore private-mode quota */
  }
}

function clearTaskExtraDates() {
  try {
    sessionStorage.removeItem(TASK_EXTRA_DATES_KEY);
  } catch {
    /* ignore private-mode quota */
  }
}

function readOrCreateInstallationId() {
  try {
    const existing = sessionStorage.getItem('stp.ui.installationId');
    if (existing) {
      return existing;
    }
    const created = crypto.randomUUID();
    sessionStorage.setItem('stp.ui.installationId', created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function isUnauthenticated(error: unknown) {
  return error instanceof Error && (error.message === '未登录' || error.message.includes('AUTH_SESSION_INVALID'));
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function api(path: string, init: RequestInit = {}) {
  const csrf = readCookie('stp_csrf');
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (csrf && init.method && init.method !== 'GET') {
    headers.set('X-CSRF-Token', decodeURIComponent(csrf));
  }
  if (init.method && init.method !== 'GET' && path.startsWith('/v1/students')) {
    headers.set('Idempotency-Key', crypto.randomUUID());
  }
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(data.message ?? '未登录');
    }
    throw new Error(data.message ?? data.code ?? '请求失败');
  }
  return data;
}

function addBrowserLocalDays(localDate: string, days: number) {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + days)).toISOString().slice(0, 10);
}

export function App() {
  const installationId = useMemo(() => readOrCreateInstallationId(), []);
  const [screen, setScreen] = useState<Screen>('s01');
  const [phone, setPhone] = useState('13800138000');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [status, setStatus] = useState('工程骨架已接入 STP 004 最小流程');
  const [nickname, setNickname] = useState('小树');
  const [ageBand, setAgeBand] = useState<'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS'>('UNDER_14');
  const [accepted, setAccepted] = useState(false);
  const [students, setStudents] = useState<Array<{ id: string; nickname: string; status: string }>>([]);
  const [activeStudentId, setActiveStudentId] = useState<string | null>(null);
  const [issuedPairingId, setIssuedPairingId] = useState('');
  const [issuedPairingCode, setIssuedPairingCode] = useState('');
  const [pairingIdInput, setPairingIdInput] = useState('');
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [devices, setDevices] = useState<Array<{ id: string; scope: string; revokedAt: string | null }>>([]);
  const [consents, setConsents] = useState<Array<{ id: string; policyKey: string; current: boolean }>>([]);
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [gradeConfigId, setGradeConfigId] = useState('');
  const [changeKind, setChangeKind] = useState<ChangeKind>('SET');
  const [termCode, setTermCode] = useState<TermCode>('FULL_YEAR');
  const [educationNote, setEducationNote] = useState('尚未配置年级');
  const [templates, setTemplates] = useState<Array<{ id: string; title: string }>>([]);
  const [importAllowed, setImportAllowed] = useState(false);
  const [recommendedCount, setRecommendedCount] = useState(0);
  const [sessionScope, setSessionScope] = useState<'GUARDIAN' | 'STUDENT'>('GUARDIAN');
  const [previewTemplateId, setPreviewTemplateId] = useState('');
  const [previewSource, setPreviewSource] = useState<'TEMPLATE' | 'MANUAL'>('TEMPLATE');
  const [previewDigest, setPreviewDigest] = useState('');
  const [previewTemplateVersion, setPreviewTemplateVersion] = useState('');
  const [previewTasks, setPreviewTasks] = useState<PreviewTask[]>([]);
  const [confirmAllowed, setConfirmAllowed] = useState(false);
  const [coCreationAttested, setCoCreationAttested] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draftTaskName, setDraftTaskName] = useState('自主阅读');
  const [draftTaskSubject, setDraftTaskSubject] = useState('自定义');
  const [draftTaskStandard, setDraftTaskStandard] = useState('读完指定页并口头复述');
  const [draftRepeatKind, setDraftRepeatKind] = useState<'ONCE' | 'DAILY' | 'WEEKLY_DAYS'>('DAILY');
  const [plans, setPlans] = useState<
    Array<{ id: string; status: string; origin: string; seriesCount: number; version: number }>
  >([]);
  const [planDetail, setPlanDetail] = useState<{
    id: string;
    status: string;
    origin: string;
    version: number;
    studentConfirmedAt: string | null;
    lastAdjustment: { reasonCode: string; createdAt: string } | null;
    series: Array<{ id: string; name: string; occurrenceCount: number }>;
  } | null>(null);
  const [tasks, setTasks] = useState<
    Array<{
      id: string;
      name: string;
      scheduledLocalDate: string;
      originalLocalDate?: string;
      version: number;
      status: string;
      planStatus?: string;
      executable?: boolean;
    }>
  >([]);
  const [planActionPending, setPlanActionPending] = useState(false);
  const [archiveConfirmPlanId, setArchiveConfirmPlanId] = useState<string | null>(null);
  const [horizonPending, setHorizonPending] = useState(false);
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('调到合适的一天');
  const [reschedulePending, setReschedulePending] = useState(false);
  const studentLoadSeq = useRef(0);
  const bootstrapSeq = useRef(0);

  function clearProtectedState() {
    studentLoadSeq.current += 1;
    setStudents([]);
    setActiveStudentId(null);
    writeStoredStudentId(null);
    clearTaskExtraDates();
    setGrades([]);
    setGradeConfigId('');
    setChangeKind('SET');
    setTermCode('FULL_YEAR');
    setEducationNote('尚未配置年级');
    setDevices([]);
    setConsents([]);
    setTemplates([]);
    setPreviewTemplateId('');
    setPreviewTasks([]);
    setCoCreationAttested(false);
    setPlans([]);
    setPlanDetail(null);
    setTasks([]);
    setPlanActionPending(false);
    setArchiveConfirmPlanId(null);
    setHorizonPending(false);
    setRescheduleTaskId(null);
    setRescheduleDate('');
    setRescheduleReason('调到合适的一天');
    setReschedulePending(false);
    setSessionScope('GUARDIAN');
    setIssuedPairingId('');
    setIssuedPairingCode('');
    setScreen('s01');
  }

  function applyEducation(items: GradeItem[], education: EducationDetail | undefined, nextKind?: ChangeKind) {
    setGrades(items);
    const savedId = education?.gradeConfigId ?? '';
    if (!savedId) {
      setGradeConfigId('');
      setTermCode('FULL_YEAR');
      setChangeKind(nextKind ?? 'SET');
      setEducationNote('尚未配置年级');
      return;
    }
    if (isTermCode(education?.termCode)) {
      setTermCode(education.termCode);
    }
    const matched = items.find((item) => item.id === savedId);
    if (!matched) {
      setGradeConfigId('');
      setChangeKind(nextKind ?? 'TERM_SWITCH');
      setEducationNote(
        `已保存 ${education?.schoolSystemCode ?? ''} · ${education?.gradeLabel ?? ''}，但当前目录没有对应项，未改选。`,
      );
      return;
    }
    setGradeConfigId(matched.id);
    setChangeKind(nextKind ?? 'TERM_SWITCH');
    setEducationNote(
      `当前 ${matched.schoolSystemCode} · ${matched.gradeLabel} · ${education?.termCode ?? ''} · 版本 ${matched.version}`,
    );
  }

  async function loadStudentEducation(studentId: string) {
    const seq = ++studentLoadSeq.current;
    try {
      const [catalog, detail] = await Promise.all([
        api('/v1/grade-configs') as Promise<{ items?: GradeItem[] }>,
        api(`/v1/students/${studentId}`) as Promise<{ education?: EducationDetail }>,
      ]);
      if (seq !== studentLoadSeq.current) {
        return;
      }
      applyEducation(catalog.items ?? [], detail.education);
    } catch (error) {
      if (seq !== studentLoadSeq.current) {
        return;
      }
      if (isUnauthenticated(error)) {
        clearProtectedState();
        setStatus('会话已失效，请重新登录');
        return;
      }
      setStatus(error instanceof Error ? error.message : '无法读取档案');
    }
  }

  function selectStudent(studentId: string) {
    setActiveStudentId(studentId);
    writeStoredStudentId(studentId);
    void loadStudentEducation(studentId);
  }

  async function enterGuardian(items: Array<{ id: string; nickname: string; status: string }>, message: string) {
    setStudents(items);
    if (!items.length) {
      setActiveStudentId(null);
      setScreen('s02');
      setStatus(message);
      return;
    }
    setScreen('p05');
    setStatus(message);
    const stored = readStoredStudentId();
    const only = items.length === 1 ? items[0] : undefined;
    const chosen = items.some((item) => item.id === stored) ? stored : only?.id ?? null;
    if (chosen) {
      selectStudent(chosen);
    }
  }

  useEffect(() => {
    const seq = ++bootstrapSeq.current;
    void (async () => {
      try {
        const result = await api('/v1/auth/session');
        if (seq !== bootstrapSeq.current) {
          return;
        }
        if (result.session?.scope === 'STUDENT') {
          setSessionScope('STUDENT');
          if (result.session.studentId) {
            setActiveStudentId(result.session.studentId);
            writeStoredStudentId(result.session.studentId);
          }
          setScreen('student');
          setStatus('已恢复学生会话');
          return;
        }
        setSessionScope('GUARDIAN');
        const listed = await api('/v1/students');
        if (seq !== bootstrapSeq.current) {
          return;
        }
        await enterGuardian(listed.items ?? [], '已恢复家长会话');
      } catch (error) {
        if (seq !== bootstrapSeq.current) {
          return;
        }
        clearProtectedState();
        if (isUnauthenticated(error)) {
          setStatus('请登录后继续');
          return;
        }
        setStatus(error instanceof Error ? error.message : '请登录后继续');
      }
    })();
    // Session restore runs once on mount; later student switches use selectStudent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendCode(purpose: 'SIGN_IN' | 'GUARDIAN_STEP_UP' = 'SIGN_IN') {
    try {
      const result = await api('/v1/auth/code', {
        method: 'POST',
        body: JSON.stringify(
          purpose === 'SIGN_IN'
            ? { purpose, identity: { kind: 'PHONE', value: phone }, device: { installationId } }
            : { purpose, device: { installationId } },
        ),
      });
      setChallengeId(result.challengeId);
      setStatus('验证码已发送到测试收件箱（不会出现在本响应中）');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '发送失败');
    }
  }

  async function signIn(grantType: 'VERIFICATION_CODE' | 'GUARDIAN_STEP_UP' = 'VERIFICATION_CODE') {
    bootstrapSeq.current += 1;
    try {
      await api('/v1/auth/session', {
        method: 'POST',
        body: JSON.stringify({
          grantType,
          challengeId,
          code,
          device: { installationId, label: '本机浏览器' },
        }),
      });
      const listed = await api('/v1/students');
      setSessionScope('GUARDIAN');
      await enterGuardian(listed.items ?? [], grantType === 'GUARDIAN_STEP_UP' ? '已重新验证并回到家长会话' : '已进入家长会话');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '登录失败');
    }
  }

  async function pairingSignIn() {
    bootstrapSeq.current += 1;
    try {
      await api('/v1/auth/session', {
        method: 'POST',
        body: JSON.stringify({
          grantType: 'PAIRING_CODE',
          pairingId: pairingIdInput.trim(),
          code: pairingCodeInput.trim(),
          device: { installationId, label: '第二设备' },
        }),
      });
      setSessionScope('STUDENT');
      setScreen('student');
      setStatus('已通过配对进入学生模式');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '配对失败');
    }
  }

  async function refreshSession() {
    try {
      const result = await api('/v1/auth/session');
      setStatus(`会话仍有效 · ${result.session.scope}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '未登录');
    }
  }

  async function createStudent() {
    if (ageBand === 'AGE_18_PLUS') {
      setStatus('18 岁及以上暂不支持正式建档');
      return;
    }
    try {
      const docs = await api(`/v1/consent-documents?ageBand=${ageBand}`);
      const created = await api('/v1/students', {
        method: 'POST',
        body: JSON.stringify({
          profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
          ageConfirmation: { band: ageBand, source: 'GUARDIAN_DECLARATION' },
          consentAcceptances: [{ policyKey: docs.policyKey, version: docs.version }],
        }),
      });
      setActiveStudentId(created.profile.id);
      writeStoredStudentId(created.profile.id);
      setStudents((current) => [...current, created.profile]);
      setGradeConfigId('');
      setChangeKind('SET');
      setTermCode('FULL_YEAR');
      setEducationNote('尚未配置年级');
      setScreen('p05');
      setStatus('档案已创建。请选择学制年级后才能去掉配置待办。');
      try {
        const catalog = (await api('/v1/grade-configs')) as { items?: GradeItem[] };
        applyEducation(catalog.items ?? [], undefined, 'SET');
      } catch (catalogError) {
        setStatus(
          catalogError instanceof Error
            ? `档案已创建，但目录读取失败：${catalogError.message}`
            : '档案已创建，但目录读取失败。',
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '建档失败');
    }
  }

  async function enterStudent() {
    if (!activeStudentId) {
      return;
    }
    try {
      await api('/v1/auth/session', {
        method: 'POST',
        body: JSON.stringify({ grantType: 'STUDENT_MODE', studentId: activeStudentId }),
      });
      setSessionScope('STUDENT');
      setScreen('student');
      setStatus('已进入学生模式。切回家长必须重新验证。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法进入学生模式');
    }
  }

  async function createPairing() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/pairings`, { method: 'POST' });
      if (result.secretState === 'NOT_REPLAYABLE') {
        setIssuedPairingId(result.pairingId);
        setIssuedPairingCode('');
        setStatus('已创建，明文不再重放。短码不要放进链接。');
        return;
      }
      setIssuedPairingId(result.pairingId);
      setIssuedPairingCode(result.code);
      setStatus('配对码仅显示这一次。短码不要放进链接。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法创建配对');
    }
  }

  async function loadDevices() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/device-sessions`);
      setDevices(result.items ?? []);
      setStatus('已读取设备会话，响应不含 credential。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取设备');
    }
  }

  async function revokeDevice(sessionId: string) {
    if (!activeStudentId) {
      return;
    }
    try {
      await api(`/v1/students/${activeStudentId}/device-sessions/${sessionId}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reasonCode: 'GUARDIAN_REQUEST' }),
      });
      await loadDevices();
      setStatus('已撤销目标学生会话。旧 cookie 不能再写入。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法撤销设备');
    }
  }

  async function loadGrades() {
    try {
      const result = (await api('/v1/grade-configs')) as { items?: GradeItem[] };
      const items = result.items ?? [];
      setGrades(items);
      setGradeConfigId((current) =>
        current && items.some((item) => item.id === current) ? current : '',
      );
    } catch (error) {
      if (isUnauthenticated(error)) {
        clearProtectedState();
        setStatus('会话已失效，请重新登录');
        return;
      }
      setStatus(error instanceof Error ? error.message : '无法读取年级目录');
    }
  }

  async function saveEducation() {
    if (!activeStudentId || !gradeConfigId) {
      return;
    }
    try {
      const current = await api(`/v1/students/${activeStudentId}`);
      const result = await api(`/v1/students/${activeStudentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          kind: 'EDUCATION',
          expectedVersion: current.version,
          gradeConfigId: changeKind === 'LEAVE' ? null : gradeConfigId,
          termCode: changeKind === 'LEAVE' ? undefined : termCode,
          changeKind,
        }),
      });
      applyEducation(
        grades,
        result.education,
        result.education?.gradeConfigId ? (changeKind === 'SET' ? 'TERM_SWITCH' : changeKind) : 'SET',
      );
      setStatus(
        result.learningAccess?.allowed
          ? '年级已保存。可从模板库预览并确认创建计划。'
          : `年级已保存，当前状态 ${result.status}`,
      );
    } catch (error) {
      if (isUnauthenticated(error)) {
        clearProtectedState();
        setStatus('会话已失效，请重新登录');
        return;
      }
      setStatus(error instanceof Error ? error.message : '无法保存年级');
    }
  }

  async function openTemplates() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/templates?studentId=${activeStudentId}`);
      setTemplates(result.items ?? []);
      setImportAllowed(Boolean(result.importAllowed));
      setRecommendedCount((result.recommendedTemplateIds ?? []).length);
      setScreen('s07');
      setStatus(
        result.importAllowed
          ? '可浏览并看到推荐；先预览再确认创建。'
          : '可浏览模板库，但无合法映射，不能导入。',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法打开模板库');
    }
  }

  async function openPreview(templateId: string) {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/templates/${templateId}/preview`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setPreviewTemplateId(templateId);
      setPreviewSource('TEMPLATE');
      setPreviewDigest(result.previewDigest);
      setPreviewTemplateVersion(result.template.version);
      setPreviewTasks(result.tasks ?? []);
      setConfirmAllowed(Boolean(result.confirmAllowed));
      setCoCreationAttested(false);
      if (!result.confirmAllowed) {
        setStatus(result.blockReason ?? '当前不能确认创建计划');
        return;
      }
      setScreen('s03');
      setStatus('预览已生成，尚未创建计划。确认前可调整任务。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '不能预览');
    }
  }

  async function openManualCreate() {
    setPreviewSource('MANUAL');
    setPreviewTemplateId('');
    setCoCreationAttested(false);
    setConfirmAllowed(false);
    setScreen('s06');
    setStatus('填写任务后先预览，确认前不会创建计划。');
  }

  async function previewManual() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/plans/preview`, {
        method: 'POST',
        body: JSON.stringify({
          tasks: [
            {
              name: draftTaskName,
              subject: draftTaskSubject,
              standard: draftTaskStandard,
              repeatKind: draftRepeatKind,
              weekdays: draftRepeatKind === 'WEEKLY_DAYS' ? [1, 2, 3, 4, 5] : null,
            },
          ],
        }),
      });
      setPreviewSource('MANUAL');
      setPreviewTemplateId('');
      setPreviewDigest(result.previewDigest);
      setPreviewTemplateVersion('');
      setPreviewTasks(result.tasks ?? []);
      setConfirmAllowed(Boolean(result.confirmAllowed));
      setCoCreationAttested(false);
      if (!result.confirmAllowed) {
        setStatus(result.blockReason ?? '当前不能确认创建计划');
        return;
      }
      setScreen('s03');
      setStatus('预览已生成，尚未创建计划。确认前可调整任务。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '不能预览');
    }
  }

  async function confirmPlan() {
    if (!activeStudentId || confirming) {
      return;
    }
    if (previewSource === 'TEMPLATE' && !previewTemplateId) {
      return;
    }
    setConfirming(true);
    try {
      const current = await api(`/v1/students/${activeStudentId}`);
      const body: Record<string, unknown> = {
        expectedStudentVersion: current.version,
        previewDigest,
        tasks: previewTasks,
      };
      if (previewSource === 'TEMPLATE') {
        body.templateVersion = previewTemplateVersion;
      }
      if (sessionScope === 'GUARDIAN') {
        body.coCreationAttested = coCreationAttested;
      }
      const path =
        previewSource === 'MANUAL'
          ? `/v1/students/${activeStudentId}/plans`
          : `/v1/students/${activeStudentId}/templates/${previewTemplateId}/import`;
      const result = await api(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPlanDetail(result);
      setPlans([
        {
          id: result.id,
          status: result.status,
          origin: result.origin,
          seriesCount: result.series?.length ?? 0,
          version: result.version,
        },
      ]);
      setScreen('s08');
      setStatus(`计划已创建 · ${result.origin}。学生确认时间未自动写入。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '不能确认创建');
    } finally {
      setConfirming(false);
    }
  }

  function cancelPreview() {
    setPreviewTemplateId('');
    setPreviewTasks([]);
    setCoCreationAttested(false);
    setConfirming(false);
    if (previewSource === 'MANUAL') {
      setScreen('s06');
      setStatus('已取消预览，未创建计划、规则或任务。');
      return;
    }
    setScreen('s07');
    setStatus('已取消预览，未创建计划、规则或任务。');
  }

  function cancelManualDraft() {
    setPreviewTasks([]);
    setCoCreationAttested(false);
    setScreen(sessionScope === 'STUDENT' ? 'student' : 'p05');
    setStatus('已取消填写，未创建计划、规则或任务。');
  }

  async function loadPlans() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/plans`);
      setPlans(result.items ?? []);
      setScreen('s08');
      setStatus('已读取计划列表。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取计划');
    }
  }

  async function loadPlanDetail(planId: string) {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/plans/${planId}`);
      setPlanDetail(result);
      setScreen('s08');
      setStatus(`已读取计划详情 · ${result.status}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取计划');
    }
  }

  async function refreshPlanViews(keepScreen?: Screen) {
    if (!activeStudentId) {
      return;
    }
    const listed = await api(`/v1/students/${activeStudentId}/plans`);
    setPlans(listed.items ?? []);
    if (planDetail) {
      const fresh = await api(`/v1/students/${activeStudentId}/plans/${planDetail.id}`);
      setPlanDetail(fresh);
    }
    if (keepScreen === 's05' || screen === 's05') {
      const today = new Date().toLocaleDateString('en-CA');
      const to = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');
      const tasksResult = await api(`/v1/students/${activeStudentId}/tasks?from=${today}&to=${to}`);
      setTasks(tasksResult.items ?? []);
    }
  }

  async function changePlanStatus(planId: string, action: 'PAUSE' | 'RESUME' | 'ARCHIVE', expectedVersion: number) {
    if (!activeStudentId || planActionPending) {
      return;
    }
    setPlanActionPending(true);
    try {
      const result = await api(`/v1/students/${activeStudentId}/plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, expectedVersion }),
      });
      setPlanDetail(result);
      setArchiveConfirmPlanId(null);
      await refreshPlanViews();
      if (action === 'PAUSE') {
        setStatus('计划已暂停，未删除规则或历史任务。');
      } else if (action === 'RESUME') {
        setStatus('计划已恢复，未补暂停期间的缺口任务。');
      } else {
        setStatus('计划已归档，历史可查看，不能取消归档。');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法调整计划状态');
      try {
        await refreshPlanViews();
      } catch {
        /* keep the failure message */
      }
    } finally {
      setPlanActionPending(false);
    }
  }

  function planStatusNotice() {
    if (plans.some((item) => item.status === 'PAUSED')) {
      return '计划已暂停';
    }
    if (plans.some((item) => item.status === 'ARCHIVED') && plans.every((item) => item.status !== 'ACTIVE')) {
      return '计划已归档，仅可查看历史';
    }
    return null;
  }

  function renderPlanActions(plan: { id: string; status: string; version: number }) {
    return (
      <span>
        {plan.status === 'ACTIVE' ? (
          <button
            type="button"
            data-testid={`pause-plan-${plan.id}`}
            disabled={planActionPending}
            onClick={() => void changePlanStatus(plan.id, 'PAUSE', plan.version)}
          >
            暂停
          </button>
        ) : null}
        {plan.status === 'PAUSED' ? (
          <button
            type="button"
            data-testid={`resume-plan-${plan.id}`}
            disabled={planActionPending}
            onClick={() => void changePlanStatus(plan.id, 'RESUME', plan.version)}
          >
            恢复
          </button>
        ) : null}
        {plan.status === 'ACTIVE' || plan.status === 'PAUSED' ? (
          <button
            type="button"
            data-testid={`archive-plan-${plan.id}`}
            disabled={planActionPending}
            onClick={() => setArchiveConfirmPlanId(plan.id)}
          >
            归档
          </button>
        ) : null}
      </span>
    );
  }

  function renderHorizonAction() {
    return (
      <button
        type="button"
        data-testid="update-task-horizon"
        disabled={horizonPending}
        onClick={() => void updateTaskHorizon()}
      >
        {horizonPending ? '正在更新未来任务' : '更新未来任务'}
      </button>
    );
  }

  function renderArchiveConfirm() {
    if (!archiveConfirmPlanId) {
      return null;
    }
    const target = plans.find((item) => item.id === archiveConfirmPlanId) ?? (planDetail?.id === archiveConfirmPlanId ? planDetail : null);
    if (!target) {
      return null;
    }
    return (
      <div data-testid="archive-confirm">
        <p>归档后不再生成新任务，已有历史保留，且不能恢复为进行中。确定归档？</p>
        <button
          type="button"
          data-testid="confirm-archive"
          disabled={planActionPending}
          onClick={() => void changePlanStatus(target.id, 'ARCHIVE', target.version)}
        >
          确认归档
        </button>
        <button type="button" data-testid="cancel-archive" disabled={planActionPending} onClick={() => setArchiveConfirmPlanId(null)}>
          取消
        </button>
      </div>
    );
  }

  async function updateTaskHorizon() {
    if (!activeStudentId || horizonPending) {
      return;
    }
    setHorizonPending(true);
    setStatus('正在更新未来任务');
    try {
      const result = await api(`/v1/students/${activeStudentId}/task-horizon`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadTasks();
      const skipped = Array.isArray(result.skipped) ? result.skipped : [];
      if (result.insertedCount > 0) {
        setStatus(`已新增 ${result.insertedCount} 个任务（${result.from} 至 ${result.to}）。`);
      } else if (skipped.some((item: { reason?: string }) => item.reason === 'PLAN_PAUSED')) {
        setStatus('计划已暂停，未生成新任务。');
      } else if (skipped.some((item: { reason?: string }) => item.reason === 'PLAN_ARCHIVED')) {
        setStatus('计划已归档，未生成新任务。');
      } else {
        setStatus(`当前窗口无需补齐（${result.from} 至 ${result.to}）。`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法更新未来任务');
    } finally {
      setHorizonPending(false);
    }
  }

  function openReschedule(task: { id: string; scheduledLocalDate: string; executable?: boolean }) {
    if (task.executable === false) {
      return;
    }
    const today = new Date().toLocaleDateString('en-CA');
    setRescheduleTaskId(task.id);
    setRescheduleDate(addBrowserLocalDays(task.scheduledLocalDate, 1) >= today ? addBrowserLocalDays(task.scheduledLocalDate, 1) : today);
    setRescheduleReason('调到合适的一天');
  }

  function cancelReschedule() {
    if (reschedulePending) {
      return;
    }
    setRescheduleTaskId(null);
    setRescheduleDate('');
  }

  async function confirmReschedule() {
    if (!activeStudentId || !rescheduleTaskId || reschedulePending) {
      return;
    }
    const current = tasks.find((item) => item.id === rescheduleTaskId);
    if (!current) {
      return;
    }
    setReschedulePending(true);
    setStatus('正在改期');
    try {
      await api(`/v1/students/${activeStudentId}/tasks/${current.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({
          scheduledLocalDate: rescheduleDate,
          reason: rescheduleReason,
          expectedVersion: current.version,
        }),
      });
      const previousDate = current.scheduledLocalDate;
      setRescheduleTaskId(null);
      await loadTasks([previousDate, rescheduleDate]);
      setStatus(`已将任务从 ${previousDate} 改到 ${rescheduleDate}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法改期');
    } finally {
      setReschedulePending(false);
    }
  }

  async function loadTasks(extraDates: string[] = []) {
    if (!activeStudentId) {
      return;
    }
    try {
      if (extraDates.length > 0) {
        rememberTaskExtraDates(extraDates);
      }
      const today = new Date().toLocaleDateString('en-CA');
      const defaultTo = addBrowserLocalDays(today, 13);
      const dates = [today, defaultTo, ...readTaskExtraDates(), ...extraDates].filter(Boolean).sort();
      const from = dates[0] ?? today;
      const to = dates[dates.length - 1] ?? defaultTo;
      const result = await api(`/v1/students/${activeStudentId}/tasks?from=${from}&to=${to}`);
      const listed = await api(`/v1/students/${activeStudentId}/plans`);
      setTasks(result.items ?? []);
      setPlans(listed.items ?? []);
      setScreen('s05');
      const paused = (listed.items ?? []).some((item: { status: string }) => item.status === 'PAUSED');
      const archivedOnly =
        (listed.items ?? []).length > 0 &&
        (listed.items ?? []).every((item: { status: string }) => item.status !== 'ACTIVE');
      setStatus(
        paused
          ? '计划已暂停。GET 不补齐任务。'
          : archivedOnly
            ? '计划已归档，仅可查看历史。GET 不补齐任务。'
            : '已读取任务日程（只读，GET 不补齐）。',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取任务');
    }
  }

  async function loadConsents() {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/consents`);
      setConsents(result.items ?? []);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取授权');
    }
  }

  async function withdrawConsent(consentId: string) {
    if (!activeStudentId) {
      return;
    }
    try {
      const result = await api(`/v1/students/${activeStudentId}/consents/${consentId}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ reasonCode: 'GUARDIAN_REQUEST' }),
      });
      await loadConsents();
      setStatus(`撤回已处理。当前档案状态：${result.status}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法撤回');
    }
  }

  return (
    <main>
      <p className="eyebrow">手机优先 H5 · STP 004 最小流程</p>
      <h1>{APP_NAME}</h1>
      <StatusBanner message={status} />
      <p data-testid="status">{status}</p>

      {screen === 's01' ? (
        <section>
          <h2>S01 身份与适龄引导</h2>
          <label>
            手机号
            <input data-testid="phone-input" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
          <button type="button" data-testid="send-code" onClick={() => void sendCode('SIGN_IN')}>
            发送验证码
          </button>
          <label>
            验证码
            <input data-testid="code-input" value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          <button type="button" data-testid="sign-in" onClick={() => void signIn('VERIFICATION_CODE')}>
            登录
          </button>
          <h3>用配对码进入</h3>
          <label>
            配对 ID
            <input
              data-testid="pairing-id-input"
              value={pairingIdInput}
              onChange={(event) => setPairingIdInput(event.target.value)}
            />
          </label>
          <label>
            配对码
            <input
              data-testid="pairing-code-input"
              value={pairingCodeInput}
              onChange={(event) => setPairingCodeInput(event.target.value)}
            />
          </label>
          <button type="button" data-testid="pairing-sign-in" onClick={() => void pairingSignIn()}>
            用配对码进入
          </button>
          <p>18 岁及以上：仅静态说明，本阶段拒绝正式建档。</p>
        </section>
      ) : null}

      {screen === 's02' ? (
        <section>
          <h2>S02 学习档案设置</h2>
          <p>{GUARDIAN_DECLARATION_TEXT}</p>
          <label>
            昵称
            <input data-testid="nickname-input" value={nickname} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <label>
            年龄段
            <select
              data-testid="age-band"
              value={ageBand}
              onChange={(event) =>
                setAgeBand(event.target.value as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS')
              }
            >
              <option value="UNDER_14">未满 14 岁</option>
              <option value="AGE_14_TO_17">14 至 17 岁</option>
              <option value="AGE_18_PLUS">18 岁及以上（拒绝建档）</option>
            </select>
          </label>
          <label>
            <input
              data-testid="accept-policy"
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            我已阅读并接受当前测试政策（非正式）
          </label>
          <button type="button" data-testid="create-student" disabled={!accepted} onClick={() => void createStudent()}>
            创建档案
          </button>
        </section>
      ) : null}

      {screen === 'p05' ? (
        <section>
          <h2>P05 档案与设备</h2>
          <ul>
            {students.map((item) => (
              <li key={item.id}>
                <button type="button" data-testid={`student-${item.id}`} onClick={() => selectStudent(item.id)}>
                  {item.nickname} · {item.status}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" data-testid="open-create" onClick={() => setScreen('s02')}>
            创建档案
          </button>
          <button type="button" data-testid="enter-student" onClick={() => void enterStudent()}>
            进入学生模式
          </button>
          <button type="button" data-testid="create-pairing" onClick={() => void createPairing()}>
            生成配对
          </button>
          <button type="button" data-testid="load-devices" onClick={() => void loadDevices()}>
            读取设备
          </button>
          <button type="button" data-testid="load-grades" onClick={() => void loadGrades()}>
            读取年级目录
          </button>
          <label>
            年级
            <select
              data-testid="grade-select"
              value={gradeConfigId}
              onChange={(event) => setGradeConfigId(event.target.value)}
            >
              <option value="">未选择年级</option>
              {grades.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.schoolSystemCode} · {item.gradeLabel}
                </option>
              ))}
            </select>
          </label>
          <p data-testid="education-filled">{educationNote}</p>
          <label>
            变更种类
            <select
              data-testid="change-kind-select"
              value={changeKind}
              onChange={(event) =>
                setChangeKind(event.target.value as typeof changeKind)
              }
            >
              <option value="SET">SET</option>
              <option value="PROMOTE">PROMOTE</option>
              <option value="REPEAT">REPEAT</option>
              <option value="SKIP">SKIP</option>
              <option value="LEAVE">LEAVE</option>
              <option value="RESUME">RESUME</option>
              <option value="SYSTEM_SWITCH">SYSTEM_SWITCH</option>
              <option value="TERM_SWITCH">TERM_SWITCH</option>
            </select>
          </label>
          <label>
            学期
            <select
              data-testid="term-select"
              value={termCode}
              onChange={(event) => setTermCode(event.target.value as typeof termCode)}
            >
              <option value="FULL_YEAR">FULL_YEAR</option>
              <option value="FIRST_TERM">FIRST_TERM</option>
              <option value="SECOND_TERM">SECOND_TERM</option>
            </select>
          </label>
          <button type="button" data-testid="save-education" onClick={() => void saveEducation()}>
            保存年级
          </button>
          <button type="button" data-testid="open-templates" onClick={() => void openTemplates()}>
            打开模板库
          </button>
          <button type="button" data-testid="open-manual-plan" onClick={() => void openManualCreate()}>
            自己添加
          </button>
          <button type="button" data-testid="open-plans" onClick={() => void loadPlans()}>
            打开计划
          </button>
          <button type="button" data-testid="open-tasks" onClick={() => void loadTasks()}>
            打开今日任务
          </button>
          <button
            type="button"
            data-testid="open-consents"
            onClick={() => {
              setScreen('p06');
              void loadConsents();
            }}
          >
            打开授权
          </button>
          {issuedPairingId ? <p data-testid="pairing-id">{issuedPairingId}</p> : null}
          {issuedPairingCode ? <p data-testid="pairing-code">{issuedPairingCode}</p> : null}
          <ul>
            {devices.map((item) => (
              <li key={item.id}>
                {item.scope} · {item.revokedAt ? '已撤销' : '有效'}
                {!item.revokedAt ? (
                  <button
                    type="button"
                    data-testid={`revoke-device-${item.id}`}
                    onClick={() => void revokeDevice(item.id)}
                  >
                    撤销
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p>导出／删除尚未实现，不会显示假成功。</p>
        </section>
      ) : null}

      {screen === 's07' ? (
        <section>
          <h2>S07 计划模板库</h2>
          <p data-testid="template-import-state">
            {importAllowed ? `可推荐 ${recommendedCount} 条；先预览再确认` : '无合法映射，禁止导入'}
          </p>
          <ul>
            {templates.map((item) => (
              <li key={item.id}>
                {item.title}
                <button type="button" data-testid={`import-template-${item.id}`} onClick={() => void openPreview(item.id)}>
                  预览
                </button>
              </li>
            ))}
          </ul>
          <button type="button" data-testid="back-from-templates" onClick={() => setScreen(sessionScope === 'STUDENT' ? 'student' : 'p05')}>
            返回
          </button>
        </section>
      ) : null}

      {screen === 's03' ? (
        <section>
          <h2>S03 计划预览</h2>
          <p data-testid="preview-state">{confirmAllowed ? '可以确认创建' : '当前不能确认创建'}</p>
          <ul data-testid="preview-tasks">
            {previewTasks.map((task, index) => (
              <li key={`${task.name}-${index}`}>
                <label>
                  任务名
                  <input
                    data-testid={`preview-task-name-${index}`}
                    value={task.name}
                    onChange={(event) => {
                      const next = [...previewTasks];
                      next[index] = { ...task, name: event.target.value };
                      setPreviewTasks(next);
                    }}
                  />
                </label>
                <span>
                  {task.subject} · {task.standard}
                </span>
              </li>
            ))}
          </ul>
          {sessionScope === 'GUARDIAN' ? (
            <label>
              <input
                data-testid="co-creation-attested"
                type="checkbox"
                checked={coCreationAttested}
                onChange={(event) => setCoCreationAttested(event.target.checked)}
              />
              已与孩子当面约定本计划（默认不勾选）
            </label>
          ) : null}
          <button
            type="button"
            data-testid="confirm-plan"
            disabled={!confirmAllowed || confirming || (sessionScope === 'GUARDIAN' && !coCreationAttested)}
            onClick={() => void confirmPlan()}
          >
            {confirming ? '正在创建计划' : '确认创建计划'}
          </button>
          <button type="button" data-testid="cancel-preview" onClick={() => cancelPreview()}>
            取消
          </button>
        </section>
      ) : null}

      {screen === 's06' ? (
        <section>
          <h2>S06 自己添加计划</h2>
          <p>不使用模板。预览不会创建计划。</p>
          <label>
            任务名
            <input
              data-testid="manual-task-name"
              value={draftTaskName}
              onChange={(event) => setDraftTaskName(event.target.value)}
            />
          </label>
          <label>
            科目
            <input
              data-testid="manual-task-subject"
              value={draftTaskSubject}
              onChange={(event) => setDraftTaskSubject(event.target.value)}
            />
          </label>
          <label>
            完成标准
            <input
              data-testid="manual-task-standard"
              value={draftTaskStandard}
              onChange={(event) => setDraftTaskStandard(event.target.value)}
            />
          </label>
          <label>
            重复
            <select
              data-testid="manual-repeat-kind"
              value={draftRepeatKind}
              onChange={(event) =>
                setDraftRepeatKind(event.target.value as 'ONCE' | 'DAILY' | 'WEEKLY_DAYS')
              }
            >
              <option value="ONCE">单次</option>
              <option value="DAILY">每天</option>
              <option value="WEEKLY_DAYS">每周指定日</option>
            </select>
          </label>
          <button type="button" data-testid="preview-manual-plan" onClick={() => void previewManual()}>
            预览
          </button>
          <button type="button" data-testid="cancel-manual-plan" onClick={() => cancelManualDraft()}>
            取消
          </button>
        </section>
      ) : null}

      {screen === 's08' ? (
        <section>
          <h2>S08 计划详情</h2>
          <ul data-testid="plan-list">
            {plans.map((item) => (
              <li key={item.id}>
                {item.origin} · {item.status} · {item.seriesCount} 条规则
                <button type="button" data-testid={`open-plan-${item.id}`} onClick={() => void loadPlanDetail(item.id)}>
                  查看
                </button>
                {renderPlanActions(item)}
              </li>
            ))}
          </ul>
          {renderArchiveConfirm()}
          {planDetail ? (
            <div data-testid="plan-detail">
              <p>状态 {planDetail.status}</p>
              <p>来源 {planDetail.origin}</p>
              <p>学生确认 {planDetail.studentConfirmedAt ?? '未确认'}</p>
              {planDetail.lastAdjustment ? (
                <p data-testid="plan-last-adjustment">
                  最近调整 {planDetail.lastAdjustment.reasonCode}
                </p>
              ) : null}
              <ul>
                {planDetail.series.map((item) => (
                  <li key={item.id}>
                    {item.name} · {item.occurrenceCount} 个实例
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {renderHorizonAction()}
          <button type="button" data-testid="open-tasks-from-plan" onClick={() => void loadTasks()}>
            查看日程
          </button>
          <button type="button" data-testid="back-from-plan" onClick={() => setScreen(sessionScope === 'STUDENT' ? 'student' : 'p05')}>
            返回
          </button>
        </section>
      ) : null}

      {screen === 's05' ? (
        <section>
          <h2>S05 今日任务</h2>
          {planStatusNotice() ? <p data-testid="plan-status-notice">{planStatusNotice()}</p> : null}
          {renderArchiveConfirm()}
          <ul data-testid="task-list">
            {tasks.map((item) => (
              <li key={item.id}>
                {item.scheduledLocalDate} · {item.name} · {item.status}
                {item.planStatus ? ` · ${item.planStatus}` : ''}
                {item.executable === false ? ' · 不可继续执行' : ''}
                {item.executable !== false ? (
                  <button
                    type="button"
                    data-testid={`reschedule-task-${item.id}`}
                    disabled={reschedulePending}
                    onClick={() => openReschedule(item)}
                  >
                    改期
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {rescheduleTaskId ? (
            <div data-testid="reschedule-confirm">
              <p>
                将从 {tasks.find((item) => item.id === rescheduleTaskId)?.scheduledLocalDate} 改到 {rescheduleDate || '未选择'}
              </p>
              <label>
                新日期
                <input
                  data-testid="reschedule-date"
                  type="date"
                  min={new Date().toLocaleDateString('en-CA')}
                  value={rescheduleDate}
                  onChange={(event) => setRescheduleDate(event.target.value)}
                />
              </label>
              <label>
                原因
                <input
                  data-testid="reschedule-reason"
                  value={rescheduleReason}
                  onChange={(event) => setRescheduleReason(event.target.value)}
                />
              </label>
              <button type="button" data-testid="confirm-reschedule" disabled={reschedulePending} onClick={() => void confirmReschedule()}>
                {reschedulePending ? '正在改期' : '确认改期'}
              </button>
              <button type="button" data-testid="cancel-reschedule" disabled={reschedulePending} onClick={() => cancelReschedule()}>
                取消
              </button>
            </div>
          ) : null}
          <ul>
            {plans
              .filter((item) => item.status === 'ACTIVE' || item.status === 'PAUSED')
              .map((item) => (
                <li key={`s05-${item.id}`}>
                  {item.origin} · {item.status}
                  {renderPlanActions(item)}
                </li>
              ))}
          </ul>
          {renderHorizonAction()}
          <button type="button" data-testid="open-templates-from-tasks" onClick={() => void openTemplates()}>
            选择模板
          </button>
          <button type="button" data-testid="open-manual-from-tasks" onClick={() => void openManualCreate()}>
            自己添加
          </button>
          <button type="button" data-testid="back-from-tasks" onClick={() => setScreen(sessionScope === 'STUDENT' ? 'student' : 'p05')}>
            返回
          </button>
        </section>
      ) : null}

      {screen === 'p06' ? (
        <section>
          <h2>P06 授权与数据</h2>
          <p>撤回同意不要求学生 version。导出／删除入口未交付。</p>
          <ul>
            {consents.map((item) => (
              <li key={item.id}>
                {item.policyKey} · {item.current ? '当前有效' : '历史'}
                {item.current ? (
                  <button
                    type="button"
                    data-testid={`withdraw-consent-${item.id}`}
                    onClick={() => void withdrawConsent(item.id)}
                  >
                    撤回
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button type="button" data-testid="back-to-profile" onClick={() => setScreen('p05')}>
            返回档案
          </button>
        </section>
      ) : null}

      {screen === 'student' ? (
        <section>
          <h2>学生视图</h2>
          <p>当前会话只能看到绑定档案。切回家长需要二次验证，不是前端开关。</p>
          <button type="button" data-testid="open-student-templates" onClick={() => void openTemplates()}>
            打开模板库
          </button>
          <button type="button" data-testid="open-student-manual-plan" onClick={() => void openManualCreate()}>
            自己添加
          </button>
          <button type="button" data-testid="open-student-tasks" onClick={() => void loadTasks()}>
            打开今日任务
          </button>
          <button type="button" data-testid="open-student-plans" onClick={() => void loadPlans()}>
            打开计划
          </button>
          <button type="button" data-testid="refresh-session" onClick={() => void refreshSession()}>
            刷新会话
          </button>
          <button type="button" data-testid="step-up" onClick={() => void sendCode('GUARDIAN_STEP_UP')}>
            申请家长二次验证
          </button>
          <label>
            验证码
            <input data-testid="step-up-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          <button type="button" data-testid="return-guardian" onClick={() => void signIn('GUARDIAN_STEP_UP')}>
            回到家长
          </button>
        </section>
      ) : null}
    </main>
  );
}
