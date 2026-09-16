import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp004-e2e', 'screenshots');
const PHONE = '13800138300';

async function readInbox(phone: string): Promise<string> {
  const key = process.env.AUTH_TEST_INBOX_KEY ?? '';
  const destination = `+86${phone}`;
  const response = await fetch(
    `http://127.0.0.1:3000/__local/test-inbox?destination=${encodeURIComponent(destination)}&key=${encodeURIComponent(key)}`,
  );
  const body = (await response.json()) as { code?: string | null };
  if (!body.code) {
    throw new Error('test inbox did not return a code');
  }
  return body.code;
}

async function shot(page: Page, name: string) {
  if (!existsSync(shots)) {
    mkdirSync(shots, { recursive: true });
  }
  await page.screenshot({ path: join(shots, name), fullPage: true });
}

test('STP 004 real browser guardian / student / pairing / revoke / withdraw', async ({ browser }) => {
  const parent = await browser.newContext();
  const parentPage = await parent.newPage();
  await parentPage.goto('/');
  await expect(parentPage.getByTestId('phone-input')).toBeVisible();
  await parentPage.getByTestId('phone-input').fill(PHONE);
  await parentPage.getByTestId('send-code').click();
  await expect(parentPage.getByTestId('status')).toContainText('验证码已发送');
  const loginCode = await readInbox(PHONE);
  await parentPage.getByTestId('code-input').fill(loginCode);
  await parentPage.getByTestId('sign-in').click();
  await expect(parentPage.getByTestId('status')).toContainText('已进入家长会话', { timeout: 15_000 });
  if (await parentPage.getByRole('heading', { name: 'P05 档案与设备' }).isVisible()) {
    await parentPage.getByTestId('open-create').click();
  }
  await expect(parentPage.getByRole('heading', { name: 'S02 学习档案设置' })).toBeVisible({ timeout: 15_000 });
  await shot(parentPage, '01-s02-after-login.png');

  await parentPage.getByTestId('accept-policy').check();
  await parentPage.getByTestId('create-student').click();
  await expect(parentPage.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible();
  await expect(parentPage.getByTestId('status')).toContainText('档案已创建');
  await shot(parentPage, '02-p05-after-create.png');

  await parentPage.getByTestId('enter-student').click();
  await expect(parentPage.getByRole('heading', { name: '学生视图' })).toBeVisible();
  await shot(parentPage, '03-student-mode.png');

  await parentPage.getByTestId('step-up').click();
  await expect(parentPage.getByTestId('status')).toContainText('验证码已发送');
  const stepCode = await readInbox(PHONE);
  await parentPage.getByTestId('step-up-code').fill(stepCode);
  await parentPage.getByTestId('return-guardian').click();
  await expect(parentPage.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible();
  await expect(parentPage.getByTestId('status')).toContainText('已重新验证并回到家长会话');
  await shot(parentPage, '04-back-to-guardian.png');

  await parentPage.getByTestId('create-pairing').click();
  await expect(parentPage.getByTestId('pairing-id')).toBeVisible();
  await expect(parentPage.getByTestId('pairing-code')).toBeVisible();
  const pairingId = (await parentPage.getByTestId('pairing-id').innerText()).trim();
  const pairingCode = (await parentPage.getByTestId('pairing-code').innerText()).trim();
  expect(pairingId.length).toBeGreaterThan(8);
  expect(pairingCode).toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
  await shot(parentPage, '05-pairing-issued.png');

  const student = await browser.newContext();
  const studentPage = await student.newPage();
  await studentPage.goto('/');
  await studentPage.getByTestId('pairing-id-input').fill(pairingId);
  await studentPage.getByTestId('pairing-code-input').fill(pairingCode);
  await studentPage.getByTestId('pairing-sign-in').click();
  await expect(studentPage.getByRole('heading', { name: '学生视图' })).toBeVisible();
  await expect(studentPage.getByTestId('status')).toContainText('已通过配对进入学生模式');
  await shot(studentPage, '06-second-device-student.png');

  await parentPage.getByTestId('load-devices').click();
  await expect(parentPage.getByTestId('status')).toContainText('已读取设备会话');
  await parentPage.locator('[data-testid^="revoke-device-"]').first().click();
  await expect(parentPage.getByTestId('status')).toContainText('已撤销目标学生会话');
  await shot(parentPage, '07-device-revoked.png');

  await studentPage.getByTestId('refresh-session').click();
  await expect(studentPage.getByTestId('status')).toContainText('未登录');
  await shot(studentPage, '08-revoked-device-denied.png');

  await parentPage.getByTestId('open-consents').click();
  await expect(parentPage.getByRole('heading', { name: 'P06 授权与数据' })).toBeVisible();
  await parentPage.locator('[data-testid^="withdraw-consent-"]').first().click();
  await expect(parentPage.getByTestId('status')).toContainText('撤回已处理');
  await expect(parentPage.getByTestId('status')).toContainText('RESTRICTED');
  await shot(parentPage, '09-consent-withdrawn.png');

  await student.close();
  await parent.close();
});
