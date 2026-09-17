import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp006-e2e', 'screenshots');
const PHONE = '13800138222';

async function readInbox(phone: string): Promise<string> {
  const key = process.env.AUTH_TEST_INBOX_KEY ?? '';
  const response = await fetch(
    `http://127.0.0.1:3000/__local/test-inbox?destination=${encodeURIComponent(`+86${phone}`)}&key=${encodeURIComponent(key)}`,
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

test('STP 006 pause resume archive and archived history remain visible', async ({ page }) => {
  const nickname = `状态${Date.now().toString().slice(-6)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('phone-input').fill(PHONE);
  await page.getByTestId('send-code').click();
  await expect(page.getByTestId('status')).toContainText('验证码已发送');
  await page.getByTestId('code-input').fill(await readInbox(PHONE));
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('status')).toContainText('已进入家长会话', { timeout: 15_000 });
  if (await page.getByRole('heading', { name: 'P05 档案与设备' }).isVisible()) {
    await page.getByTestId('open-create').click();
  }
  await expect(page.getByRole('heading', { name: 'S02 学习档案设置' })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('accept-policy').check();
  await page.getByTestId('create-student').click();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible();
  await page.getByTestId('load-grades').click();
  await page.getByTestId('grade-select').selectOption({ label: 'SIX_THREE · 一年级' });
  await page.getByTestId('change-kind-select').selectOption('SET');
  await page.getByTestId('save-education').click();
  await expect(page.getByTestId('status')).toContainText('年级已保存');
  await page.getByTestId('open-templates').click();
  await expect(page.getByRole('heading', { name: 'S07 计划模板库' })).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'PRIMARY_G1 · 日常安排' }).getByRole('button').click();
  await page.getByTestId('co-creation-attested').check();
  await page.getByTestId('confirm-plan').click();
  await expect(page.getByRole('heading', { name: 'S08 计划详情' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('plan-detail')).toContainText('ACTIVE');
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('计划已暂停');
  await expect(page.getByTestId('plan-detail')).toContainText('PAUSED');
  await expect(page.getByTestId('plan-last-adjustment')).toContainText('PLAN_PAUSED');
  await shot(page, '03-s08-paused.png');
  await page.getByTestId('open-tasks-from-plan').click();
  await expect(page.getByRole('heading', { name: 'S05 今日任务' })).toBeVisible();
  await expect(page.getByTestId('plan-status-notice')).toContainText('计划已暂停');
  await expect(page.getByTestId('task-list').locator('li')).toHaveCount(0);
  await page.getByRole('button', { name: '恢复' }).click();
  await expect(page.getByTestId('status')).toContainText('计划已恢复');
  await expect(page.getByTestId('task-list').locator('li')).not.toHaveCount(0);
  await page.getByTestId('back-from-tasks').click();
  await page.getByTestId('open-plans').click();
  await expect(page.getByTestId('plan-list')).toContainText('ACTIVE');
  await page.getByRole('button', { name: '归档' }).click();
  await expect(page.getByTestId('archive-confirm')).toContainText('不能恢复为进行中');
  await page.getByTestId('confirm-archive').click();
  await expect(page.getByTestId('status')).toContainText('计划已归档');
  await expect(page.getByTestId('plan-list')).toContainText('ARCHIVED');
  await expect(page.getByRole('button', { name: '恢复' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消归档' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看', exact: true }).click();
  await expect(page.getByTestId('plan-detail')).toContainText('ARCHIVED');
  await shot(page, '04-s08-archived.png');
  await page.getByTestId('back-from-plan').click();
  await page.getByTestId('open-templates').click();
  await expect(page.getByRole('heading', { name: 'S07 计划模板库' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'PRIMARY_G1 · 日常安排' })).toBeVisible();
});
