import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped workspace script
import {
  FIXTURE_DATABASE,
  assertAllowed,
  assertOriginalIdentityPresence,
  recordFourToSixFixtureUrl,
  rewriteDb,
  shouldRequireLocalOriginalIdentity,
  shouldWriteLocalRuntime,
} from '../../../../scripts/stp005-four-to-six-upgrade.mjs';

const dummyAdmin = 'postgresql://stp004_admin:secret@127.0.0.1:5432/studysteps';

describe('STP 005 CI upgrade fixture gate', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the local original database only outside CI/prepare', () => {
    expect(shouldRequireLocalOriginalIdentity({ CI: '', STP004_CI_PREPARED: '' })).toBe(true);
    expect(shouldRequireLocalOriginalIdentity({ CI: 'true' })).toBe(false);
    expect(shouldRequireLocalOriginalIdentity({ CI: '1' })).toBe(false);
    expect(shouldRequireLocalOriginalIdentity({ STP004_CI_PREPARED: '1' })).toBe(false);
    expect(shouldRequireLocalOriginalIdentity({ STP004_CI_PREPARE: '1' })).toBe(false);
    expect(() => assertOriginalIdentityPresence(0, { CI: '' })).toThrow(
      /original stp004_identity missing; leave it read-only/,
    );
    expect(() => assertOriginalIdentityPresence(1, { CI: '' })).not.toThrow();
    expect(() => assertOriginalIdentityPresence(0, { CI: 'true' })).not.toThrow();
    expect(() => assertOriginalIdentityPresence(0, { STP004_CI_PREPARED: '1' })).not.toThrow();
  });

  it('keeps forbidden and exclusive fixture checks under CI', () => {
    expect(() => assertAllowed('stp004_identity')).toThrow(/refusing database/);
    expect(() => assertAllowed('stp004_identity_fresh')).toThrow(/refusing database/);
    expect(() => assertAllowed('stp005_four_to_six')).toThrow(/refusing database/);
    expect(() => assertAllowed('studysteps')).toThrow(/refusing database/);
    expect(() => assertAllowed(FIXTURE_DATABASE)).not.toThrow();
    expect(rewriteDb(dummyAdmin, FIXTURE_DATABASE)).toMatch(/\/stp005_rev_four_to_six$/);
  });

  it('records the fixture URL on the current env and GITHUB_ENV without relying on later steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stp005-gh-env-'));
    dirs.push(dir);
    const githubEnv = join(dir, 'github.env');
    writeFileSync(githubEnv, 'EXISTING=1\n');
    const env: NodeJS.ProcessEnv = { GITHUB_ENV: githubEnv };
    const fixtureUrl = rewriteDb(dummyAdmin, FIXTURE_DATABASE);
    recordFourToSixFixtureUrl(fixtureUrl, env);
    expect(env.STP005_FOUR_TO_SIX_DATABASE_URL).toBe(fixtureUrl);
    const text = readFileSync(githubEnv, 'utf8');
    expect(text).toContain('EXISTING=1');
    expect(text).toContain(`STP005_FOUR_TO_SIX_DATABASE_URL=${fixtureUrl}`);
    expect(() =>
      recordFourToSixFixtureUrl('postgresql://stp004_admin:secret@127.0.0.1:5432/stp004_identity', env),
    ).toThrow(/refusing database/);
  });

  it('does not clobber a different local runtime cluster', () => {
    const local = 'postgresql://stp004_admin:secret@127.0.0.1:6260/stp005_rev_fresh';
    const ciFixture = 'postgresql://stp004_admin:secret@127.0.0.1:5432/stp005_rev_four_to_six';
    const sameCluster = 'postgresql://stp004_admin:secret@127.0.0.1:6260/stp005_rev_four_to_six';
    expect(shouldWriteLocalRuntime(local, ciFixture)).toBe(false);
    expect(shouldWriteLocalRuntime(local, sameCluster)).toBe(true);
    expect(shouldWriteLocalRuntime('', sameCluster)).toBe(false);
  });
});
