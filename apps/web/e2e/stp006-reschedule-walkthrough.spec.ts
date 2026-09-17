import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp006-e2e', 'screenshots');
const PHONE = '13800138224';

function addLocalDays(localDate: string, days: number) {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + days)).toISOString().slice(0, 10);
}

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

test('STP 006 Chromium reschedules a task and keeps old/new dates consistent after refresh', async ({ page }) => {
  const nickname = `改期${Date.now().toString().slice(-6)}`;
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
  await page.getByTestId('open-tasks-from-plan').click();
  await expect(page.getByRole('heading', { name: 'S05 今日任务' })).toBeVisible();
  const first = page.getByTestId('task-list').locator('li').first();
  const originalText = await first.innerText();
  const originalDate = originalText.slice(0, 10);
  const taskName = originalText.split(' · ')[1] ?? '';
  const newDate = addLocalDays(originalDate, 20);
  const beforeCount = await page.getByTestId('task-list').locator('li').count();
  await first.getByRole('button', { name: '改期' }).click();
  await expect(page.getByTestId('reschedule-confirm')).toBeVisible();
  await expect(page.getByTestId('reschedule-confirm')).toContainText(`将从 ${originalDate}`);
  await page.getByTestId('cancel-reschedule').click();
  await expect(page.getByTestId('reschedule-confirm')).toHaveCount(0);
  await expect(page.getByTestId('task-list').locator('li')).toHaveCount(beforeCount);
  await first.getByRole('button', { name: '改期' }).click();
  await page.getByTestId('reschedule-date').fill(newDate);
  await page.getByTestId('confirm-reschedule').click();
  await expect(page.getByTestId('status')).toContainText(`已将任务从 ${originalDate} 改到 ${newDate}`, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('reschedule-confirm')).toHaveCount(0);
  await expect(page.getByTestId('task-list')).toContainText(`${newDate} · ${taskName}`);
  await expect(page.getByTestId('task-list')).not.toContainText(`${originalDate} · ${taskName}`);
  await shot(page, '06-s05-after-reschedule.png');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-tasks').click();
  await expect(page.getByRole('heading', { name: 'S05 今日任务' })).toBeVisible();
  await expect(page.getByTestId('task-list')).toContainText(`${newDate} · ${taskName}`);
  await expect(page.getByTestId('task-list')).not.toContainText(`${originalDate} · ${taskName}`);
});
