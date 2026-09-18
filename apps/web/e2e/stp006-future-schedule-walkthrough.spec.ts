import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp006-e2e', 'screenshots');
const PHONE = '13800138226';

function isoWeekday(localDate: string): number {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  const utcDay = new Date(Date.UTC(year as number, (month as number) - 1, day as number)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + days));
  return utc.toISOString().slice(0, 10);
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

test('STP 006 Chromium previews and confirms future schedule while keeping exceptions and blocking collisions', async ({
  page,
}) => {
  const nickname = `排期${Date.now().toString().slice(-6)}`;
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
  const firstText = await first.innerText();
  const firstDate = firstText.split(' · ')[0] ?? '';
  const firstName = firstText.split(' · ')[1] ?? '';
  const firstWeekday = isoWeekday(firstDate);
  await first.getByRole('button', { name: '调整重复安排' }).click();
  await expect(page.getByTestId('future-schedule')).toBeVisible();
  await expect(page.getByTestId('future-schedule-scope')).toContainText('原始日期');
  await page.getByTestId('cancel-future-schedule').click();
  await expect(page.getByTestId('future-schedule')).toHaveCount(0);

  await first.getByRole('button', { name: '调整重复安排' }).click();
  await page.getByTestId('future-schedule-repeat-kind').selectOption('WEEKLY_DAYS');
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    const box = page.getByTestId(`future-schedule-weekday-${day}`);
    const checked = await box.isChecked();
    if (day === firstWeekday && !checked) {
      await box.check();
    }
    if (day !== firstWeekday && checked) {
      await box.uncheck();
    }
  }
  await page.getByTestId('preview-future-schedule').click();
  await expect(page.getByTestId('future-schedule-preview')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('future-schedule-preview-cutoff')).toContainText('原始生效切点');
  await expect(page.getByTestId('future-schedule-preview-cancelled')).toContainText('将取消');
  await page.getByTestId('confirm-future-schedule').click();
  await expect(page.getByTestId('status')).toContainText('已调整本次及未来的重复安排', { timeout: 15_000 });
  await shot(page, '09-s05-after-future-schedule.png');

  const remaining = page.getByTestId('task-list').locator('li').filter({ hasText: firstName }).first();
  await remaining.getByRole('button', { name: '改期' }).click();
  const farDate = addLocalDays(firstDate, 20);
  await page.getByTestId('reschedule-date').fill(farDate);
  await page.getByTestId('confirm-reschedule').click();
  await expect(page.getByTestId('status')).toContainText('已将任务从', { timeout: 15_000 });

  await page
    .getByTestId('task-list')
    .locator('li')
    .filter({ hasText: farDate })
    .filter({ hasText: firstName })
    .getByRole('button', { name: '调整重复安排' })
    .click();
  await expect(page.getByTestId('future-schedule-anchor-exception')).toBeVisible();
  await page.getByTestId('future-schedule-repeat-kind').selectOption('DAILY');
  await page.getByTestId('preview-future-schedule').click();
  await expect(page.getByTestId('future-schedule-preview-conflicts')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('confirm-future-schedule')).toBeDisabled();
  await page.getByTestId('cancel-future-schedule').click();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-tasks').click();
  await expect(page.getByRole('heading', { name: 'S05 今日任务' })).toBeVisible();
  await page.getByTestId('update-task-horizon').click();
  await expect(page.getByTestId('status')).toContainText(/已新增|当前窗口无需补齐/, { timeout: 15_000 });
});
