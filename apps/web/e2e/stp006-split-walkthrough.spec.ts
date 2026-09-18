import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp006-e2e', 'screenshots');
const PHONE = '13800138227';

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

test('STP 006 Chromium previews, cancels, confirms split and keeps child edit/reschedule without future entry', async ({
  page,
}) => {
  const nickname = `拆分${Date.now().toString().slice(-6)}`;
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
  const parentDate = firstText.split(' · ')[0] ?? '';
  const parentName = firstText.split(' · ')[1] ?? '';
  const beforeCount = await page.getByTestId('task-list').locator('li').count();
  await first.getByRole('button', { name: '拆成多条任务' }).click();
  await expect(page.getByTestId('split-task')).toBeVisible();
  await page.getByTestId('split-child-name-0').fill('拆分上半');
  await page.getByTestId('split-child-name-1').fill('拆分下半');
  await page.getByTestId('preview-split').click();
  await expect(page.getByTestId('split-preview')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('split-preview-parent')).toContainText('将被子任务替代');
  await expect(page.getByTestId('split-preview-irreversible')).toContainText('不能直接还原');
  await page.getByTestId('cancel-split').click();
  await expect(page.getByTestId('split-task')).toHaveCount(0);
  await expect(page.getByTestId('task-list')).toContainText(parentName);
  expect(await page.getByTestId('task-list').locator('li').count()).toBe(beforeCount);

  await page.getByTestId('task-list').locator('li').filter({ hasText: parentName }).first().getByRole('button', { name: '拆成多条任务' }).click();
  await page.getByTestId('split-child-name-0').fill('拆分上半');
  await page.getByTestId('split-child-name-1').fill('拆分下半');
  await page.getByTestId('preview-split').click();
  await expect(page.getByTestId('split-preview')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('confirm-split').click();
  await expect(page.getByTestId('status')).toContainText('已拆成多条任务', { timeout: 15_000 });
  await expect(page.getByTestId('task-list').locator('li').filter({ hasText: `${parentDate} · ${parentName} ·` })).toHaveCount(0);
  await expect(page.getByTestId('task-list')).toContainText('拆分上半');
  await expect(page.getByTestId('task-list')).toContainText('拆分下半');
  const upper = page.getByTestId('task-list').locator('li').filter({ hasText: '拆分上半' });
  await expect(upper.getByRole('button', { name: '本次及未来' })).toHaveCount(0);
  await expect(upper.getByRole('button', { name: '调整重复安排' })).toHaveCount(0);
  await expect(upper.getByRole('button', { name: '拆成多条任务' })).toHaveCount(0);
  await shot(page, '09-s05-after-split.png');

  await upper.getByRole('button', { name: '编辑本次' }).click();
  await page.getByTestId('edit-occurrence-name').fill('拆分上半已改');
  await page.getByTestId('confirm-edit-occurrence').click();
  await expect(page.getByTestId('status')).toContainText('已只改本次任务', { timeout: 15_000 });
  await expect(page.getByTestId('task-list')).toContainText('拆分上半已改');

  const lower = page.getByTestId('task-list').locator('li').filter({ hasText: '拆分下半' });
  await lower.getByRole('button', { name: '改期' }).click();
  await page.getByTestId('confirm-reschedule').click();
  await expect(page.getByTestId('status')).toContainText('已将任务从', { timeout: 15_000 });
  await page.getByTestId('update-task-horizon').click();
  await expect(page.getByTestId('status')).toContainText('窗口', { timeout: 15_000 });
  await expect(page.getByTestId('task-list').locator('li').filter({ hasText: '拆分上半已改' })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-tasks').click();
  await expect(page.getByTestId('task-list')).toContainText('拆分上半已改');
  await expect(page.getByTestId('task-list')).toContainText('拆分下半');
});
