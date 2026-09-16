import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');
const evidenceFile = join(root, 'docs', 'handoffs', 'STP004_BROWSER_EVIDENCE.md');

function loadEnv() {
  if (!existsSync(runtimeFile)) {
    throw new Error('runtime.env missing');
  }
  for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    process.env[line.slice(0, index)] ??= line.slice(index + 1);
  }
}

function applySetCookie(store, headers) {
  const raw = headers.getSetCookie?.() ?? [];
  for (const item of raw) {
    const pair = item.split(';')[0];
    const eq = pair.indexOf('=');
    store.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
  }
}

async function main() {
  loadEnv();
  const origin = process.env.STP004_BROWSER_ORIGIN ?? 'http://127.0.0.1:5173';
  const inboxKey = process.env.AUTH_TEST_INBOX_KEY;
  const installationId = randomUUID();
  const cookies = new Map();
  const evidence = [`Origin used: ${origin}`, 'No credentials recorded.'];

  async function call(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Origin', origin.startsWith('http://127.0.0.1:5173') || origin.startsWith('http://localhost:5173')
      ? origin
      : 'http://127.0.0.1:5173');
    if (cookies.size) {
      headers.set('Cookie', [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '));
    }
    const csrf = cookies.get('stp_csrf');
    if (csrf && init.method && init.method !== 'GET') {
      headers.set('X-CSRF-Token', csrf);
    }
    if (init.method && init.method !== 'GET' && path.startsWith('/v1/students')) {
      headers.set('Idempotency-Key', randomUUID());
    }
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    applySetCookie(cookies, response.headers);
    const body = response.status === 204 ? {} : await response.json();
    evidence.push(
      `${init.method ?? 'GET'} ${path} -> ${response.status}${
        typeof body.code === 'string' && body.code === body.code.toUpperCase() && body.code.includes('_')
          ? ` ${body.code}`
          : ''
      }${body.session?.scope ? ` scope=${body.session.scope}` : ''}`,
    );
    if (!response.ok) {
      throw new Error(`${path} ${response.status} ${body.code ?? body.message}`);
    }
    return body;
  }

  const sent = await call('/v1/auth/code', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'SIGN_IN',
      identity: { kind: 'PHONE', value: '13800138000' },
      device: { installationId },
    }),
  });
  const inbox = await fetch(
    `${origin}/__local/test-inbox?destination=${encodeURIComponent('+8613800138000')}&key=${encodeURIComponent(inboxKey)}`,
  );
  const delivered = await inbox.json();
  evidence.push(`GET /__local/test-inbox -> ${inbox.status} code_present=${Boolean(delivered.code)}`);
  const signed = await call('/v1/auth/session', {
    method: 'POST',
    body: JSON.stringify({
      grantType: 'VERIFICATION_CODE',
      challengeId: sent.challengeId,
      code: delivered.code,
      device: { installationId, label: 'browser-flow' },
    }),
  });
  evidence.push(`cookie names present: ${[...cookies.keys()].join(', ') || '(none)'}`);
  evidence.push(`csrf bound header used: ${cookies.has('stp_csrf')}`);

  const docs = await call('/v1/consent-documents?ageBand=UNDER_14');
  const created = await call('/v1/students', {
    method: 'POST',
    body: JSON.stringify({
      profile: { nickname: '浏览器档案', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
      ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
      consentAcceptances: [{ policyKey: docs.policyKey, version: docs.version }],
    }),
  });
  const studentId = created.profile.id;
  await call('/v1/auth/session', {
    method: 'POST',
    body: JSON.stringify({ grantType: 'STUDENT_MODE', studentId }),
  });
  const step = await call('/v1/auth/code', {
    method: 'POST',
    body: JSON.stringify({ purpose: 'GUARDIAN_STEP_UP', device: { installationId } }),
  });
  const stepInbox = await fetch(
    `${origin}/__local/test-inbox?destination=${encodeURIComponent('+8613800138000')}&key=${encodeURIComponent(inboxKey)}`,
  );
  const stepCode = await stepInbox.json();
  await call('/v1/auth/session', {
    method: 'POST',
    body: JSON.stringify({
      grantType: 'GUARDIAN_STEP_UP',
      challengeId: step.challengeId,
      code: stepCode.code,
      device: { installationId },
    }),
  });
  const pairing = await call(`/v1/students/${studentId}/pairings`, { method: 'POST' });
  evidence.push(`pairing secretState=${pairing.secretState}`);
  const devices = await call(`/v1/students/${studentId}/device-sessions`);
  evidence.push(`device-sessions count=${devices.items?.length ?? 0} credential_leaked=${JSON.stringify(devices).includes('credential')}`);
  const consents = await call(`/v1/students/${studentId}/consents`);
  const current = consents.items.find((item) => item.current);
  await call(`/v1/students/${studentId}/consents/${current.id}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ reasonCode: 'GUARDIAN_REQUEST' }),
  });
  evidence.push(`signed-in scope after flow start=${signed.session.scope}`);
  writeFileSync(evidenceFile, `# STP 004 Cookie / CSRF / 浏览器同源证据\n\n${evidence.map((line) => `- ${line}`).join('\n')}\n`);
  process.stdout.write(`Browser-origin flow recorded: docs/handoffs/STP004_BROWSER_EVIDENCE.md\n`);
}

await main();
