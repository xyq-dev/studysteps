import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  FIXTURE_DATABASE,
  recordFourToSixFixtureUrl,
  rewriteDb,
} from './stp005-four-to-six-upgrade.mjs';
import {
  FIXTURE_DATABASE as SIX_TO_SEVEN_DATABASE,
  recordSixToSevenFixtureUrl,
} from './stp006-six-to-seven.mjs';
import {
  FIXTURE_DATABASE as SEVEN_TO_EIGHT_DATABASE,
  recordSevenToEightFixtureUrl,
} from './stp006-seven-to-eight.mjs';
import {
  FIXTURE_DATABASE as EIGHT_TO_NINE_DATABASE,
  recordEightToNineFixtureUrl,
} from './stp006-eight-to-nine.mjs';
import {
  FIXTURE_DATABASE as NINE_TO_TEN_DATABASE,
  recordNineToTenFixtureUrl,
} from './stp006-nine-to-ten.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/api/package.json'));
const pg = require('pg');

if (process.env.CI !== 'true' && process.env.CI !== '1' && process.env.STP004_CI_PREPARE !== '1') {
  throw new Error('refusing to prepare isolation outside CI');
}

const adminUrl = process.env.STP004_ADMIN_DATABASE_URL;
if (!adminUrl) {
  throw new Error('STP004_ADMIN_DATABASE_URL is required');
}

const appUser = process.env.CI_PG_APP_USER || 'stp004_api';
const database = process.env.CI_PG_DB || 'studysteps';
const appPassword = randomBytes(24).toString('base64url');
const hexKey = () => `hex:${randomBytes(32).toString('hex')}`;
const inboxKey = randomBytes(32).toString('base64url');

const envLines = {
  APP_ENV: 'test',
  AUTH_TEST_MODE: '1',
  AUTH_TEST_INBOX_KEY: inboxKey,
  IDENTITY_LOOKUP_KEY_V1: hexKey(),
  IDENTITY_ADVISORY_KEY_V1: hexKey(),
  OTP_DIGEST_KEY_V1: hexKey(),
  PAIRING_DIGEST_KEY_V1: hexKey(),
  IDENTIFIER_ENCRYPT_KEY_V1: hexKey(),
};

const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 8000 });
await admin.connect();

const superRow = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
if (superRow.rows[0]?.rolsuper !== true) {
  await admin.end();
  throw new Error('admin role must be a superuser for CI provisioning');
}

await admin.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appUser}') THEN
      CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
    ELSE
      ALTER ROLE ${appUser} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
  END $$;
`);
await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${appUser}`);
await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${appUser}`);
await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${appUser}`);
await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${appUser}`);

const role = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [appUser]);
if (role.rows[0]?.rolsuper !== false) {
  await admin.end();
  throw new Error('application role must not be a superuser');
}
await admin.end();

const adminParsed = new URL(adminUrl);
const appUrl = `postgresql://${encodeURIComponent(appUser)}:${encodeURIComponent(appPassword)}@${adminParsed.hostname}:${adminParsed.port || '5432'}${adminParsed.pathname}`;

envLines.DATABASE_URL = appUrl;
envLines.STP004_TEST_DATABASE_URL = appUrl;
envLines.STP004_ADMIN_DATABASE_URL = adminUrl;
envLines.STP004_CI_PREPARED = '1';

const githubEnv = process.env.GITHUB_ENV;
if (githubEnv) {
  appendFileSync(
    githubEnv,
    Object.entries(envLines)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
}

for (const [key, value] of Object.entries(envLines)) {
  process.env[key] = value;
}

const migrate = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: appUrl },
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
process.stdout.write(migrate.stdout || '');
process.stderr.write(migrate.stderr || '');
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

const catalog = new pg.Client({ connectionString: appUrl, connectionTimeoutMillis: 8000 });
await catalog.connect();
const applied = await catalog.query(`
  SELECT migration_name
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL
     AND rolled_back_at IS NULL
   ORDER BY finished_at
`);
await catalog.end();

const names = applied.rows.map((row) => row.migration_name);
const expected = readdirSync(join(root, 'prisma', 'migrations'))
  .filter((name) => existsSync(join(root, 'prisma', 'migrations', name, 'migration.sql')))
  .sort();
if (names.length !== expected.length) {
  throw new Error(`expected ${expected.length} applied migrations, found ${names.length}: ${names.join(',')}`);
}
const missing = expected.filter((name) => !names.includes(name));
if (missing.length > 0) {
  throw new Error(`missing applied migrations: ${missing.join(',')}`);
}

const upgradeEnv = { ...process.env };
const upgrade = spawnSync(process.execPath, [join(root, 'scripts/stp005-four-to-six-upgrade.mjs')], {
  cwd: root,
  env: upgradeEnv,
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(upgrade.stdout || '');
process.stderr.write(upgrade.stderr || '');
if (upgrade.status !== 0) {
  process.exit(upgrade.status ?? 1);
}

const sixToSeven = spawnSync(process.execPath, [join(root, 'scripts/stp006-six-to-seven.mjs')], {
  cwd: root,
  env: { ...process.env },
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(sixToSeven.stdout || '');
process.stderr.write(sixToSeven.stderr || '');
if (sixToSeven.status !== 0) {
  process.exit(sixToSeven.status ?? 1);
}

const fixtureUrl = rewriteDb(adminUrl, FIXTURE_DATABASE);
const fixture = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
await fixture.connect();
const fixtureDb = await fixture.query('SELECT current_database() AS name');
if (fixtureDb.rows[0]?.name !== FIXTURE_DATABASE) {
  await fixture.end();
  throw new Error('upgrade fixture connected to the wrong database');
}
const leftover = await fixture.query(
  `SELECT COUNT(*)::int AS n FROM student_profiles WHERE nickname = '遗留快照'`,
);
await fixture.end();
if (leftover.rows[0]?.n !== 1) {
  throw new Error('upgrade fixture leftover row missing after four-to-six');
}

recordFourToSixFixtureUrl(fixtureUrl, process.env);
if (process.env.STP005_FOUR_TO_SIX_DATABASE_URL !== fixtureUrl) {
  throw new Error('STP005_FOUR_TO_SIX_DATABASE_URL was not applied in the current prepare step');
}

const sixToSevenUrl = rewriteDb(adminUrl, SIX_TO_SEVEN_DATABASE);
const sixToSevenDbClient = new pg.Client({ connectionString: sixToSevenUrl, connectionTimeoutMillis: 8000 });
await sixToSevenDbClient.connect();
const sixToSevenDb = await sixToSevenDbClient.query('SELECT current_database() AS name');
if (sixToSevenDb.rows[0]?.name !== SIX_TO_SEVEN_DATABASE) {
  await sixToSevenDbClient.end();
  throw new Error('six-to-seven fixture connected to the wrong database');
}
const baseline = await sixToSevenDbClient.query(
  `SELECT COUNT(*)::int AS n FROM student_profiles WHERE nickname = '六到七基线'`,
);
const seventh = await sixToSevenDbClient.query(`SELECT to_regclass('study_plans') AS plans`);
await sixToSevenDbClient.end();
if (baseline.rows[0]?.n !== 1) {
  throw new Error('six-to-seven baseline student missing');
}
if (!seventh.rows[0]?.plans) {
  throw new Error('six-to-seven fixture missing study_plans');
}
recordSixToSevenFixtureUrl(sixToSevenUrl, process.env);
if (process.env.STP006_SIX_TO_SEVEN_DATABASE_URL !== sixToSevenUrl) {
  throw new Error('STP006_SIX_TO_SEVEN_DATABASE_URL was not applied in the current prepare step');
}

const sevenToEight = spawnSync(process.execPath, [join(root, 'scripts/stp006-seven-to-eight.mjs')], {
  cwd: root,
  env: { ...process.env },
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(sevenToEight.stdout || '');
process.stderr.write(sevenToEight.stderr || '');
if (sevenToEight.status !== 0) {
  process.exit(sevenToEight.status ?? 1);
}

const sevenToEightUrl = rewriteDb(adminUrl, SEVEN_TO_EIGHT_DATABASE);
const sevenToEightDbClient = new pg.Client({ connectionString: sevenToEightUrl, connectionTimeoutMillis: 8000 });
await sevenToEightDbClient.connect();
const sevenToEightDb = await sevenToEightDbClient.query('SELECT current_database() AS name');
if (sevenToEightDb.rows[0]?.name !== SEVEN_TO_EIGHT_DATABASE) {
  await sevenToEightDbClient.end();
  throw new Error('seven-to-eight fixture connected to the wrong database');
}
const eightBaseline = await sevenToEightDbClient.query(
  `SELECT COUNT(*)::int AS n FROM student_profiles WHERE nickname = '七到八基线'`,
);
const eightApplied = await sevenToEightDbClient.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const eightVersion = await sevenToEightDbClient.query(
  `SELECT COUNT(*)::int AS n FROM task_occurrences WHERE version = 1`,
);
await sevenToEightDbClient.end();
if (eightBaseline.rows[0]?.n !== 1) {
  throw new Error('seven-to-eight baseline student missing');
}
if (eightApplied.rows[0]?.n !== 8) {
  throw new Error('seven-to-eight fixture did not apply eight migrations');
}
if (eightVersion.rows[0]?.n < 1) {
  throw new Error('seven-to-eight fixture missing defaulted occurrence version');
}
recordSevenToEightFixtureUrl(sevenToEightUrl, process.env);
if (process.env.STP006_SEVEN_TO_EIGHT_DATABASE_URL !== sevenToEightUrl) {
  throw new Error('STP006_SEVEN_TO_EIGHT_DATABASE_URL was not applied in the current prepare step');
}

const eightToNine = spawnSync(process.execPath, [join(root, 'scripts/stp006-eight-to-nine.mjs')], {
  cwd: root,
  env: { ...process.env },
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(eightToNine.stdout || '');
process.stderr.write(eightToNine.stderr || '');
if (eightToNine.status !== 0) {
  process.exit(eightToNine.status ?? 1);
}

const eightToNineUrl = rewriteDb(adminUrl, EIGHT_TO_NINE_DATABASE);
const eightToNineDbClient = new pg.Client({ connectionString: eightToNineUrl, connectionTimeoutMillis: 8000 });
await eightToNineDbClient.connect();
const eightToNineDb = await eightToNineDbClient.query('SELECT current_database() AS name');
if (eightToNineDb.rows[0]?.name !== EIGHT_TO_NINE_DATABASE) {
  await eightToNineDbClient.end();
  throw new Error('eight-to-nine fixture connected to the wrong database');
}
const nineBaseline = await eightToNineDbClient.query(
  `SELECT COUNT(*)::int AS n FROM student_profiles WHERE nickname = '八到九基线'`,
);
const nineApplied = await eightToNineDbClient.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const nineRevisions = await eightToNineDbClient.query(`SELECT COUNT(*)::int AS n FROM task_series_revisions`);
await eightToNineDbClient.end();
if (nineBaseline.rows[0]?.n !== 1) {
  throw new Error('eight-to-nine baseline student missing');
}
if (nineApplied.rows[0]?.n !== 9) {
  throw new Error('eight-to-nine fixture did not apply nine migrations');
}
if (nineRevisions.rows[0]?.n < 1) {
  throw new Error('eight-to-nine fixture missing baseline revisions');
}
recordEightToNineFixtureUrl(eightToNineUrl, process.env);
if (process.env.STP006_EIGHT_TO_NINE_DATABASE_URL !== eightToNineUrl) {
  throw new Error('STP006_EIGHT_TO_NINE_DATABASE_URL was not applied in the current prepare step');
}

const nineToTen = spawnSync(process.execPath, [join(root, 'scripts/stp006-nine-to-ten.mjs')], {
  cwd: root,
  env: { ...process.env },
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(nineToTen.stdout || '');
process.stderr.write(nineToTen.stderr || '');
if (nineToTen.status !== 0) {
  process.exit(nineToTen.status ?? 1);
}

const nineToTenUrl = rewriteDb(adminUrl, NINE_TO_TEN_DATABASE);
const nineToTenDbClient = new pg.Client({ connectionString: nineToTenUrl, connectionTimeoutMillis: 8000 });
await nineToTenDbClient.connect();
const nineToTenDb = await nineToTenDbClient.query('SELECT current_database() AS name');
if (nineToTenDb.rows[0]?.name !== NINE_TO_TEN_DATABASE) {
  await nineToTenDbClient.end();
  throw new Error('nine-to-ten fixture connected to the wrong database');
}
const tenBaseline = await nineToTenDbClient.query(
  `SELECT COUNT(*)::int AS n FROM student_profiles WHERE nickname = '九到十基线'`,
);
const tenApplied = await nineToTenDbClient.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const tenCheck = await nineToTenDbClient.query(`
  SELECT conname FROM pg_constraint WHERE conname = 'task_occurrences_cancel_reason_check'
`);
await nineToTenDbClient.end();
if (tenBaseline.rows[0]?.n !== 1) {
  throw new Error('nine-to-ten baseline student missing');
}
if (tenApplied.rows[0]?.n !== 10) {
  throw new Error('nine-to-ten fixture did not apply ten migrations');
}
if (tenCheck.rowCount !== 1) {
  throw new Error('nine-to-ten fixture missing cancel_reason check');
}
recordNineToTenFixtureUrl(nineToTenUrl, process.env);
if (process.env.STP006_NINE_TO_TEN_DATABASE_URL !== nineToTenUrl) {
  throw new Error('STP006_NINE_TO_TEN_DATABASE_URL was not applied in the current prepare step');
}

const sixToSevenStill = new pg.Client({ connectionString: sixToSevenUrl, connectionTimeoutMillis: 8000 });
await sixToSevenStill.connect();
const sixToSevenCount = await sixToSevenStill.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const sixToSevenVersion = await sixToSevenStill.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'task_occurrences' AND column_name = 'version'`,
);
await sixToSevenStill.end();
if (sixToSevenCount.rows[0]?.n !== 7) {
  throw new Error('six-to-seven fixture must stay at seven migrations');
}
if (sixToSevenVersion.rowCount !== 0) {
  throw new Error('six-to-seven fixture must not receive occurrence version');
}

const sevenToEightStill = new pg.Client({ connectionString: sevenToEightUrl, connectionTimeoutMillis: 8000 });
await sevenToEightStill.connect();
const sevenToEightCount = await sevenToEightStill.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const sevenToEightRevision = await sevenToEightStill.query(
  `SELECT to_regclass('task_series_revisions') AS revisions`,
);
await sevenToEightStill.end();
if (sevenToEightCount.rows[0]?.n !== 8) {
  throw new Error('seven-to-eight fixture must stay at eight migrations');
}
if (sevenToEightRevision.rows[0]?.revisions) {
  throw new Error('seven-to-eight fixture must not receive revision tables');
}

const eightToNineStill = new pg.Client({ connectionString: eightToNineUrl, connectionTimeoutMillis: 8000 });
await eightToNineStill.connect();
const eightToNineCount = await eightToNineStill.query(`
  SELECT COUNT(*)::int AS n
    FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`);
const eightToNineCheck = await eightToNineStill.query(`
  SELECT conname FROM pg_constraint WHERE conname = 'task_occurrences_cancel_reason_check'
`);
await eightToNineStill.end();
if (eightToNineCount.rows[0]?.n !== 9) {
  throw new Error('eight-to-nine fixture must stay at nine migrations');
}
if (eightToNineCheck.rowCount !== 0) {
  throw new Error('eight-to-nine fixture must not receive tenth cancel_reason check');
}

process.stdout.write(
  `CI isolation ready: app role=${appUser} nosuperuser; migrations=${names.length}; fixture=${FIXTURE_DATABASE}; sixToSeven=${SIX_TO_SEVEN_DATABASE}; sevenToEight=${SEVEN_TO_EIGHT_DATABASE}; eightToNine=${EIGHT_TO_NINE_DATABASE}; nineToTen=${NINE_TO_TEN_DATABASE}\n`,
);
