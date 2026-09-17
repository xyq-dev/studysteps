import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

const upgrade = spawnSync(process.execPath, [join(root, 'scripts/stp005-four-to-six-upgrade.mjs')], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(upgrade.stdout || '');
process.stderr.write(upgrade.stderr || '');
if (upgrade.status !== 0) {
  process.exit(upgrade.status ?? 1);
}

process.stdout.write(`CI isolation ready: app role=${appUser} nosuperuser; migrations=${names.length}\n`);
