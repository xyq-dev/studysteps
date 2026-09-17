import { expect, test } from '@playwright/test';

const PHONE = '13800138301';

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

test('STP 005 S02 empty education, S07 browse, no unmapped import', async ({ page }) => {
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
  await page.getByTestId('accept-policy').check();
  await page.getByTestId('create-student').click();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible();
  await page.getByTestId('load-grades').click();
  await expect(page.getByTestId('grade-select').locator('option')).not.toHaveCount(0);
  await page.getByTestId('grade-select').selectOption({ label: 'SIX_THREE · 一年级' });
  await page.getByTestId('change-kind-select').selectOption('SET');
  await page.getByTestId('term-select').selectOption('FULL_YEAR');
  await page.getByTestId('save-education').click();
  await expect(page.getByTestId('status')).toContainText('年级已保存');
  await page.getByTestId('open-templates').click();
  await expect(page.getByRole('heading', { name: 'S07 计划模板库' })).toBeVisible();
  await expect(page.getByTestId('template-import-state')).toContainText('可推荐');
  await page.locator('[data-testid^="import-template-"]').first().click();
  await expect(page.getByTestId('status')).toContainText('计划导入属于后续任务');
  await page.getByTestId('back-from-templates').click();
  await page.getByTestId('grade-select').selectOption({ label: 'CUSTOM · 实验班' });
  await page.getByTestId('change-kind-select').selectOption('SYSTEM_SWITCH');
  await page.getByTestId('term-select').selectOption('FULL_YEAR');
  await page.getByTestId('save-education').click();
  await expect(page.getByTestId('status')).toContainText('年级已保存');
  await page.getByTestId('open-templates').click();
  await expect(page.getByTestId('template-import-state')).toContainText('无合法映射，禁止导入');
  await page.locator('[data-testid^="import-template-"]').first().click();
  await expect(page.getByTestId('status')).toContainText('没有合法模板映射');
});
