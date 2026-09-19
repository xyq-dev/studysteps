import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type UpgradeGate = {
  FIXTURE_DATABASE: string;
  assertAllowed: (name: string) => void;
  recordTenToElevenFixtureUrl: (
    fixtureUrl: string,
    env?: NodeJS.ProcessEnv,
    io?: { appendFileSync: typeof writeFileSync },
  ) => void;
  rewriteDb: (url: string, name: string) => string;
  shouldRequireLocalOriginalIdentity: (env?: NodeJS.ProcessEnv) => boolean;
  shouldWriteLocalRuntime: (localAdminUrl: string, fixtureUrl: string) => boolean;
};

const dummyAdmin = 'postgresql://stp004_admin:secret@127.0.0.1:5432/studysteps';

describe('STP 006 CI ten-to-eleven upgrade fixture gate', () => {
  const dirs: string[] = [];
  let gate: UpgradeGate;

  beforeAll(async () => {
    const specifier = '../../../../scripts/stp006-ten-to-eleven.mjs';
    gate = (await import(specifier)) as UpgradeGate;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the local original database only outside CI/prepare', () => {
    expect(gate.shouldRequireLocalOriginalIdentity({ CI: '', STP004_CI_PREPARED: '' })).toBe(true);
    expect(gate.shouldRequireLocalOriginalIdentity({ CI: 'true' })).toBe(false);
    expect(gate.shouldRequireLocalOriginalIdentity({ STP004_CI_PREPARED: '1' })).toBe(false);
  });

  it('keeps forbidden and exclusive fixture checks under CI', () => {
    expect(() => gate.assertAllowed('stp004_identity')).toThrow(/refusing database/);
    expect(() => gate.assertAllowed('stp006_nine_to_ten')).toThrow(/refusing database/);
    expect(() => gate.assertAllowed('stp006_eight_to_nine')).toThrow(/refusing database/);
    expect(() => gate.assertAllowed('stp006_fresh')).toThrow(/refusing database/);
    expect(() => gate.assertAllowed('studysteps')).toThrow(/refusing database/);
    expect(() => gate.assertAllowed(gate.FIXTURE_DATABASE)).not.toThrow();
    expect(gate.rewriteDb(dummyAdmin, gate.FIXTURE_DATABASE)).toMatch(/\/stp006_ten_to_eleven$/);
  });

  it('records the fixture URL on the current env and GITHUB_ENV without relying on later steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stp006-11-gh-env-'));
    dirs.push(dir);
    const githubEnv = join(dir, 'github.env');
    writeFileSync(githubEnv, 'EXISTING=1\n');
    const env: NodeJS.ProcessEnv = { GITHUB_ENV: githubEnv };
    const fixtureUrl = gate.rewriteDb(dummyAdmin, gate.FIXTURE_DATABASE);
    gate.recordTenToElevenFixtureUrl(fixtureUrl, env);
    expect(env.STP006_TEN_TO_ELEVEN_DATABASE_URL).toBe(fixtureUrl);
    const text = readFileSync(githubEnv, 'utf8');
    expect(text).toContain('EXISTING=1');
    expect(text).toContain(`STP006_TEN_TO_ELEVEN_DATABASE_URL=${fixtureUrl}`);
    expect(() =>
      gate.recordTenToElevenFixtureUrl(
        'postgresql://stp004_admin:secret@127.0.0.1:5432/stp006_nine_to_ten',
        env,
      ),
    ).toThrow(/refusing database/);
  });

  it('does not clobber a different local runtime cluster', () => {
    const local = 'postgresql://stp004_admin:secret@127.0.0.1:6260/stp006_fresh';
    const ciFixture = 'postgresql://stp004_admin:secret@127.0.0.1:5432/stp006_ten_to_eleven';
    const sameCluster = 'postgresql://stp004_admin:secret@127.0.0.1:6260/stp006_ten_to_eleven';
    expect(gate.shouldWriteLocalRuntime(local, ciFixture)).toBe(false);
    expect(gate.shouldWriteLocalRuntime(local, sameCluster)).toBe(true);
    expect(gate.shouldWriteLocalRuntime('', sameCluster)).toBe(false);
  });
});
