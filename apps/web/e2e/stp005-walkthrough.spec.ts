import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shots = join(root, '.local', 'stp005-e2e', 'screenshots');
const PHONE = '13800138210';

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

async function completeGuardianLogin(page: Page) {
  await page.getByTestId('phone-input').fill(PHONE);
  await page.getByTestId('send-code').click();
  await expect(page.getByTestId('status')).toContainText('验证码已发送');
  await page.getByTestId('code-input').fill(await readInbox(PHONE));
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('status')).toContainText('已进入家长会话', { timeout: 15_000 });
}

async function login(page: Page) {
  await page.goto('/');
  await completeGuardianLogin(page);
}

function collectEducationPatches(page: Page): Array<Record<string, unknown>> {
  const patches: Array<Record<string, unknown>> = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'PATCH' || !/\/v1\/students\//.test(request.url())) {
      return;
    }
    try {
      patches.push(JSON.parse(request.postData() || '{}') as Record<string, unknown>);
    } catch {
      patches.push({});
    }
  });
  return patches;
}

test('STP 005 P05/S07 real-browser education and templates walkthrough', async ({ page }) => {
  const nickname = `走查${Date.now().toString().slice(-6)}`;
  const patches = collectEducationPatches(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  if (await page.getByRole('heading', { name: 'P05 档案与设备' }).isVisible()) {
    await page.getByTestId('open-create').click();
  }
  await expect(page.getByRole('heading', { name: 'S02 学习档案设置' })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('nickname-input').fill(nickname);
  await page.getByTestId('accept-policy').check();
  await page.getByTestId('create-student').click();
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible();
  await expect(page.getByRole('button', { name: `${nickname} · ONBOARDING` })).toBeVisible();
  await page.getByTestId('load-grades').click();
  await expect(page.getByTestId('grade-select').locator('option')).not.toHaveCount(0);
  const labels = await page.getByTestId('grade-select').locator('option').allTextContents();
  expect(labels.some((label) => label === 'SIX_THREE · 六年级')).toBe(true);
  expect(labels.some((label) => label.startsWith('SIX_THREE') && label.includes('初四'))).toBe(false);
  expect(labels.some((label) => label === 'FIVE_FOUR · 初四')).toBe(true);
  expect(labels.some((label) => label.startsWith('FIVE_FOUR') && label.includes('六年级'))).toBe(false);
  await shot(page, '01-p05-catalog-mobile.png');

  const beforeOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  );

  async function saveEducation(expectedKind: string, expectedStatus: string | RegExp, opts: { success?: boolean } = {}) {
    const before = patches.length;
    await page.getByTestId('save-education').click();
    await expect.poll(() => patches.length).toBe(before + 1);
    expect(patches.at(-1)?.kind).toBe('EDUCATION');
    expect(patches.at(-1)?.changeKind).toBe(expectedKind);
    await expect(page.getByTestId('status')).toContainText(expectedStatus);
    if (opts.success === false) {
      await expect(page.getByTestId('status')).not.toContainText('年级已保存');
    }
  }

  await page.getByTestId('grade-select').selectOption({ label: 'SIX_THREE · 一年级' });
  await page.getByTestId('change-kind-select').selectOption('PROMOTE');
  await page.getByTestId('term-select').selectOption('FULL_YEAR');
  await saveEducation('PROMOTE', '空档案只能 SET', { success: false });
  await shot(page, '02-p05-promote-from-empty-error.png');

  await page.getByTestId('change-kind-select').selectOption('SET');
  await saveEducation('SET', '年级已保存');
  expect(patches.at(-1)?.termCode).toBe('FULL_YEAR');
  await expect(page.getByTestId('education-filled')).toContainText('一年级');
  await expect(page.getByTestId('grade-select').locator('option:checked')).toHaveText('SIX_THREE · 一年级');
  await expect(page.getByTestId('term-select')).toHaveValue('FULL_YEAR');
  await shot(page, '03-p05-after-set.png');

  await page.reload();
  await expect(page.getByTestId('phone-input')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'P05 档案与设备' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('education-filled')).toContainText('一年级', { timeout: 15_000 });
  await expect(page.getByTestId('education-filled')).toContainText('FULL_YEAR');
  await expect(page.getByTestId('grade-select').locator('option:checked')).toHaveText('SIX_THREE · 一年级');
  await expect(page.getByTestId('term-select')).toHaveValue('FULL_YEAR');
  await expect(page.getByTestId('change-kind-select')).not.toHaveValue('SET');
  await shot(page, '03b-p05-after-reload.png');

  await page.getByTestId('change-kind-select').selectOption('TERM_SWITCH');
  await page.getByTestId('term-select').selectOption('FIRST_TERM');
  await saveEducation('TERM_SWITCH', '年级已保存');
  expect(patches.at(-1)?.termCode).toBe('FIRST_TERM');
  await page.reload();
  await expect(page.getByTestId('phone-input')).toHaveCount(0);
  await expect(page.getByTestId('term-select')).toHaveValue('FIRST_TERM', { timeout: 15_000 });
  await expect(page.getByTestId('grade-select').locator('option:checked')).toHaveText('SIX_THREE · 一年级');
  await expect(page.getByTestId('education-filled')).toContainText('FIRST_TERM');

  await page.getByTestId('grade-select').selectOption({ label: 'SIX_THREE · 二年级' });
  await page.getByTestId('change-kind-select').selectOption('PROMOTE');
  await page.getByTestId('term-select').selectOption('FULL_YEAR');
  await saveEducation('PROMOTE', '年级已保存');
  await page.reload();
  await expect(page.getByTestId('phone-input')).toHaveCount(0);
  await expect(page.getByTestId('grade-select').locator('option:checked')).toHaveText('SIX_THREE · 二年级', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('term-select')).toHaveValue('FULL_YEAR');
  await expect(page.getByTestId('education-filled')).toContainText('二年级');

  await page.getByTestId('grade-select').selectOption({ label: 'FIVE_FOUR · 初四' });
  await page.getByTestId('change-kind-select').selectOption('SYSTEM_SWITCH');
  await saveEducation('SYSTEM_SWITCH', '年级已保存');

  await page.getByTestId('open-templates').click();
  await expect(page.getByRole('heading', { name: 'S07 计划模板库' })).toBeVisible();
  await expect(page.getByTestId('template-import-state')).toContainText('可推荐 3 条');
  const importButtons = page.locator('[data-testid^="import-template-"]');
  await expect(importButtons).toHaveCount(39);
  const titles = await page.locator('#root li, main li').allTextContents();
  const joined = titles.join('\n');
  expect(joined).toContain('JUNIOR_G4 · 日常安排');
  expect(joined).toContain('JUNIOR_G4 · 阅读或复习习惯');
  expect(joined).toContain('JUNIOR_G4 · 周计划');
  const entryKeys = [
    'PRIMARY_G1',
    'PRIMARY_G2',
    'PRIMARY_G3',
    'PRIMARY_G4',
    'PRIMARY_G5',
    'PRIMARY_G6',
    'JUNIOR_G1',
    'JUNIOR_G2',
    'JUNIOR_G3',
    'JUNIOR_G4',
    'SENIOR_G1',
    'SENIOR_G2',
    'SENIOR_G3',
  ];
  for (const key of entryKeys) {
    expect(joined.split(key).length - 1).toBeGreaterThanOrEqual(3);
  }
  await shot(page, '04-s07-mapped-junior-g4.png');
  await page.getByRole('listitem').filter({ hasText: 'JUNIOR_G4 · 日常安排' }).getByRole('button').click();
  await expect(page.getByRole('heading', { name: 'S03 计划预览' })).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('尚未创建计划');
  await page.getByTestId('cancel-preview').click();
  await page.getByTestId('back-from-templates').click();

  await page.getByTestId('grade-select').selectOption({ label: 'CUSTOM · 实验班' });
  await page.getByTestId('change-kind-select').selectOption('SYSTEM_SWITCH');
  await saveEducation('SYSTEM_SWITCH', '年级已保存');
  await page.getByTestId('open-templates').click();
  await expect(page.getByTestId('template-import-state')).toContainText('无合法映射，禁止导入');
  await expect(page.locator('[data-testid^="import-template-"]')).toHaveCount(39);
  await page.locator('[data-testid^="import-template-"]').first().click();
  await expect(page.getByTestId('status')).toContainText('没有合法模板映射');
  await shot(page, '05-s07-custom-unmapped.png');
  await page.getByTestId('back-from-templates').click();

  await page.getByTestId('open-consents').click();
  await expect(page.getByRole('heading', { name: 'P06 授权与数据' })).toBeVisible();
  await expect(page.getByText('当前有效')).toBeVisible();
  await expect(page.getByRole('button', { name: '撤回' })).toBeVisible();
  await page.getByTestId('back-to-profile').click();
  await expect(page.getByRole('button', { name: new RegExp(`^${nickname} ·`) })).toBeVisible();

  await page.getByTestId('enter-student').click();
  await expect(page.getByRole('heading', { name: '学生视图' })).toBeVisible();
  await expect(page.getByTestId('step-up')).toBeVisible();
  await expect(page.getByTestId('open-templates')).toHaveCount(0);
  await page.getByTestId('step-up').click();
  await expect(page.getByTestId('status')).toContainText('验证码已发送');

  expect(beforeOverflow).toBe(false);
  const afterOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  );
  expect(afterOverflow).toBe(false);
});

test('STP 005 A02 read-only catalog via existing admin entry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page.getByRole('heading', { name: /P05 档案与设备|S02 学习档案设置/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto('http://127.0.0.1:5174/');
  await expect(page.getByRole('heading', { name: 'A02 学段科目配置' })).toBeVisible();
  await expect(page.getByTestId('a02-readonly')).toContainText('只读预览');
  await expect(page.getByTestId('a02-readonly')).toContainText('无发布');
  await expect(page.getByTestId('a02-login-hint')).toHaveCount(0);
  await expect(page.getByTestId('a02-status')).toContainText('已加载');
  await expect(page.getByTestId('a02-status')).not.toContainText('目录读取失败');
  await expect(page.getByTestId('a02-catalog').locator('li')).toHaveCount(25);
  await expect(page.getByTestId('a02-catalog')).toContainText('初四');
  await expect(page.getByTestId('a02-catalog')).toContainText('JUNIOR_G4');
  await expect(page.getByTestId('a02-catalog')).toContainText('版本');
  await expect(page.getByRole('button', { name: /发布/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /下架/ })).toHaveCount(0);
  await shot(page, '07-a02-readonly.png');
});

test('STP 005 A02 unauthenticated visit shows login hint and no catalog', async ({ browser }) => {
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:5174/');
  await expect(page.getByRole('heading', { name: 'A02 学段科目配置' })).toBeVisible();
  await expect(page.getByTestId('a02-login-hint')).toBeVisible();
  await expect(page.getByTestId('a02-family-login')).toBeVisible();
  await expect(page.getByTestId('a02-catalog').locator('li')).toHaveCount(0);
  await expect(page.getByTestId('a02-status')).toContainText('请先使用家庭端现有登录流程');
  await expect(page.getByTestId('a02-status')).not.toContainText('已加载');
  await expect(page.getByRole('button', { name: /发布/ })).toHaveCount(0);
  await shot(page, '08-a02-unauthenticated.png');
  await anon.close();
});
