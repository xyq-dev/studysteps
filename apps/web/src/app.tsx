import { useMemo, useState } from 'react';
import { APP_NAME, GUARDIAN_DECLARATION_TEXT } from '@studysteps/contracts';
import { StatusBanner } from '@studysteps/ui';

type Screen = 's01' | 's02' | 'p05' | 'p06' | 's07' | 'student';

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

export function App() {
  const installationId = useMemo(() => crypto.randomUUID(), []);
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
  const [grades, setGrades] = useState<Array<{ id: string; gradeLabel: string; schoolSystemCode: string; catalogEntryKey: string | null }>>([]);
  const [gradeConfigId, setGradeConfigId] = useState('');
  const [changeKind, setChangeKind] = useState<'SET' | 'PROMOTE' | 'REPEAT' | 'SKIP' | 'LEAVE' | 'RESUME' | 'SYSTEM_SWITCH' | 'TERM_SWITCH'>('SET');
  const [termCode, setTermCode] = useState<'FULL_YEAR' | 'FIRST_TERM' | 'SECOND_TERM'>('FULL_YEAR');
  const [templates, setTemplates] = useState<Array<{ id: string; title: string }>>([]);
  const [importAllowed, setImportAllowed] = useState(false);
  const [recommendedCount, setRecommendedCount] = useState(0);

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
      setStudents(listed.items ?? []);
      setScreen((listed.items ?? []).length ? 'p05' : 's02');
      setStatus(grantType === 'GUARDIAN_STEP_UP' ? '已重新验证并回到家长会话' : '已进入家长会话');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '登录失败');
    }
  }

  async function pairingSignIn() {
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
      setStudents((current) => [...current, created.profile]);
      setScreen('p05');
      setStatus('档案已创建。请选择学制年级后才能去掉配置待办。');
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
      const result = await api('/v1/grade-configs');
      const items = (result.items ?? []) as Array<{
        id: string;
        gradeLabel: string;
        schoolSystemCode: string;
        catalogEntryKey: string | null;
      }>;
      setGrades(items);
      const preferred = items.find((item) => item.catalogEntryKey) ?? items[0];
      setGradeConfigId((current) => current || preferred?.id || '');
    } catch (error) {
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
      setStatus(
        result.learningAccess?.allowed
          ? '年级已保存。学习计划导入仍属后续任务。'
          : `年级已保存，当前状态 ${result.status}`,
      );
    } catch (error) {
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
          ? '可浏览并看到推荐；导入尚未开放。'
          : '可浏览模板库，但无合法映射，不能导入。',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法打开模板库');
    }
  }

  async function tryImport(templateId: string) {
    if (!activeStudentId) {
      return;
    }
    try {
      await api(`/v1/students/${activeStudentId}/templates/${templateId}/import`, { method: 'POST' });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '不能导入');
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
                <button type="button" data-testid={`student-${item.id}`} onClick={() => setActiveStudentId(item.id)}>
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
              {grades.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.schoolSystemCode} · {item.gradeLabel}
                </option>
              ))}
            </select>
          </label>
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
            {importAllowed ? `可推荐 ${recommendedCount} 条；导入未开放` : '无合法映射，禁止导入'}
          </p>
          <ul>
            {templates.map((item) => (
              <li key={item.id}>
                {item.title}
                <button type="button" data-testid={`import-template-${item.id}`} onClick={() => void tryImport(item.id)}>
                  导入
                </button>
              </li>
            ))}
          </ul>
          <button type="button" data-testid="back-from-templates" onClick={() => setScreen('p05')}>
            返回档案
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
