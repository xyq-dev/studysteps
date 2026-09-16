import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = join(root, '.local', 'stp004-pg');
const downloadDir = join(localRoot, 'downloads');
const vendorDir = join(localRoot, 'vendor');
const dataDir = join(localRoot, 'data');
const logFile = join(localRoot, 'postgres.log');
const runtimeFile = join(localRoot, 'runtime.env');
const evidenceFile = join(root, 'docs', 'handoffs', 'STP004_PG_ISOLATION.md');
const pgVersion = '16.15-1';
const zipName = `postgresql-${pgVersion}-windows-x64-binaries.zip`;
const officialPage = 'https://www.postgresql.org/download/windows/';
const edbPage = 'https://www.enterprisedb.com/download-postgresql-binaries';
const zipUrl = `https://get.enterprisedb.com/postgresql/${zipName}`;

function randomSecret() {
  return randomBytes(24).toString('base64url');
}

function hexKey() {
  return `hex:${randomBytes(32).toString('hex')}`;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function bin(name) {
  return join(vendorDir, 'pgsql', 'bin', `${name}.exe`);
}

function run(command, args, options = {}) {
  const timeout = options.timeout ?? 20_000;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    killSignal: 'SIGTERM',
    ...options,
    timeout,
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new Error(`${command} ${args.join(' ')} timed out after ${timeout}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function startPostgres(port) {
  try {
    run(bin('pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-o', `-h 127.0.0.1 -p ${port}`, 'start'], {
      timeout: 20_000,
    });
  } catch (error) {
    if (isRunning()) {
      return;
    }
    throw error;
  }
}


async function downloadZip() {
  mkdirSync(downloadDir, { recursive: true });
  const zipPath = join(downloadDir, zipName);
  if (existsSync(zipPath) && existsSync(bin('initdb'))) {
    return zipPath;
  }
  process.stderr.write(`Downloading ${zipName} from EDB binaries (linked from ${officialPage})\n`);
  const response = await fetch(zipUrl);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${zipUrl}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));
  return zipPath;
}

function extractZip(zipPath) {
  if (existsSync(bin('initdb'))) {
    return;
  }
  mkdirSync(vendorDir, { recursive: true });
  const result = spawnSync(
    'tar',
    ['-xf', zipPath, '-C', vendorDir],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    const expand = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Force -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(vendorDir)}`],
      { encoding: 'utf8', windowsHide: true },
    );
    if (expand.status !== 0) {
      throw new Error(`extract failed: ${result.stderr || expand.stderr}`);
    }
  }
}

async function start() {
  mkdirSync(localRoot, { recursive: true });
  const zipPath = await downloadZip();
  extractZip(zipPath);
  if (!existsSync(bin('initdb')) || !existsSync(bin('pg_ctl')) || !existsSync(bin('psql'))) {
    throw new Error('EDB zip did not contain initdb/pg_ctl/psql');
  }

  const adminPassword = randomSecret();
  const apiPassword = randomSecret();
  const port = await freePort();
  const pwFile = join(tmpdir(), `stp004-pg-${randomBytes(6).toString('hex')}.pw`);
  writeFileSync(pwFile, `${adminPassword}\n`, { encoding: 'utf8' });

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    run(bin('initdb'), [
      '-D',
      dataDir,
      '--auth-host=scram-sha-256',
      '--auth-local=scram-sha-256',
      '--username=stp004_admin',
      `--pwfile=${pwFile}`,
      '--encoding=UTF8',
      '--locale=C',
    ], { env: { ...process.env, TZ: 'UTC' } });
  }

  const conf = readFileSync(join(dataDir, 'postgresql.conf'), 'utf8')
    .replace(/^#?listen_addresses\s*=.*/m, "listen_addresses = '127.0.0.1'")
    .replace(/^#?port\s*=.*/m, `port = ${port}`)
    .replace(/^#?password_encryption\s*=.*/m, "password_encryption = 'scram-sha-256'");
  writeFileSync(join(dataDir, 'postgresql.conf'), conf);
  writeFileSync(
    join(dataDir, 'pg_hba.conf'),
    [
      'host all all 127.0.0.1/32 scram-sha-256',
      'host all all ::1/128 scram-sha-256',
      'local all all scram-sha-256',
      '',
    ].join('\n'),
  );

  startPostgres(port);
  provision(port, adminPassword, apiPassword);
  writeRuntime(port, adminPassword, apiPassword);
  await writeEvidenceAsync(port, adminPassword);
  process.stdout.write('STP004 isolated PostgreSQL started. Evidence: docs/handoffs/STP004_PG_ISOLATION.md\n');
}

function writeHba(mode) {
  const lines =
    mode === 'trust'
      ? ['host all all 127.0.0.1/32 trust', 'host all all ::1/128 trust', 'local all all trust', '']
      : [
          'host all all 127.0.0.1/32 scram-sha-256',
          'host all all ::1/128 scram-sha-256',
          'local all all scram-sha-256',
          '',
        ];
  writeFileSync(join(dataDir, 'pg_hba.conf'), lines.join('\n'));
}

function readPort() {
  const pid = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/);
  return Number(pid[3]);
}

function psql(port, user, database, args, password) {
  return run(bin('psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', database, ...args], {
    env: { ...process.env, PGPASSWORD: password ?? '', PGCONNECT_TIMEOUT: '5' },
    timeout: 8_000,
  });
}

function provision(port, adminPassword, apiPassword) {
  writeHba('trust');
  spawnSync(bin('pg_ctl'), ['-D', dataDir, 'reload'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  psql(port, 'stp004_admin', 'postgres', [
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stp004_api') THEN
        CREATE ROLE stp004_api LOGIN PASSWORD '${apiPassword.replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
      ELSE
        ALTER ROLE stp004_api LOGIN PASSWORD '${apiPassword.replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
      ALTER ROLE stp004_admin PASSWORD '${adminPassword.replaceAll("'", "''")}';
    END $$;`,
  ]);
  const dbCheck = psql(port, 'stp004_admin', 'postgres', [
    '-tAc',
    "SELECT 1 FROM pg_database WHERE datname = 'stp004_identity'",
  ]);
  if (!dbCheck.stdout.includes('1')) {
    psql(port, 'stp004_admin', 'postgres', [
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE DATABASE stp004_identity OWNER stp004_api;',
    ]);
  }
  writeHba('scram');
  spawnSync(bin('pg_ctl'), ['-D', dataDir, 'reload'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
}

function writeRuntime(port, adminPassword, apiPassword) {
  const inboxKey = randomSecret();
  const envLines = [
    `APP_ENV=test`,
    `NODE_ENV=test`,
    `AUTH_TEST_MODE=1`,
    `AUTH_TEST_INBOX_KEY=${inboxKey}`,
    `LISTEN_HOST=127.0.0.1`,
    `PORT=3000`,
    `IDENTITY_LOOKUP_KEY_V1=${hexKey()}`,
    `IDENTITY_ADVISORY_KEY_V1=${hexKey()}`,
    `OTP_DIGEST_KEY_V1=${hexKey()}`,
    `PAIRING_DIGEST_KEY_V1=${hexKey()}`,
    `IDENTIFIER_ENCRYPT_KEY_V1=${hexKey()}`,
    `STP004_PG_PORT=${port}`,
    `STP004_PG_DATA=${dataDir}`,
    `STP004_PG_VENDOR=${join(vendorDir, 'pgsql')}`,
    `DATABASE_URL=postgresql://stp004_api:${encodeURIComponent(apiPassword)}@127.0.0.1:${port}/stp004_identity`,
    `STP004_ADMIN_DATABASE_URL=postgresql://stp004_admin:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/stp004_identity`,
    `STP004_TEST_DATABASE_URL=postgresql://stp004_api:${encodeURIComponent(apiPassword)}@127.0.0.1:${port}/stp004_identity`,
  ];
  writeFileSync(runtimeFile, `${envLines.join('\n')}\n`);
}

async function withAdminClient(port, adminPassword, database, work) {
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'stp004_admin',
    password: adminPassword,
    database,
    connectionTimeoutMillis: 5_000,
    query_timeout: 8_000,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function writeEvidenceAsync(port, adminPassword) {
  const isolationRow = await withAdminClient(port, adminPassword, 'postgres', (client) =>
    client.query(
      "SELECT current_database() || '|' || coalesce(inet_server_addr()::text, '127.0.0.1') || '|' || inet_server_port() || '|' || current_setting('listen_addresses') AS v",
    ),
  );
  const rolesRow = await withAdminClient(port, adminPassword, 'postgres', (client) =>
    client.query(
      "SELECT rolname || '|super=' || rolsuper || '|createdb=' || rolcreatedb AS v FROM pg_roles WHERE rolname IN ('stp004_admin','stp004_api') ORDER BY rolname",
    ),
  );
  const ownerRow = await withAdminClient(port, adminPassword, 'postgres', (client) =>
    client.query(
      "SELECT d.datname || '|owner=' || r.rolname AS v FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'stp004_identity'",
    ),
  );
  const tablesRow = await withAdminClient(port, adminPassword, 'stp004_identity', (client) =>
    client.query("SELECT count(*)::text AS v FROM information_schema.tables WHERE table_schema = 'public'"),
  );
  const isolation = isolationRow.rows[0]?.v ?? 'unknown';
  const roleFlags = rolesRow.rows.map((row) => row.v).join('\n');
  const dbOwner = ownerRow.rows[0]?.v ?? 'unknown';
  const tableCount = tablesRow.rows[0]?.v ?? 'unknown';
  const parts = String(isolation).split('|');
  const redacted = `${parts[0]}|${parts[1]}|PORT|${parts[3] ?? ''}`;
  const postmaster = spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
  });
  const pidMatch = (postmaster.stdout || '').match(/PID:\s*(\d+)/);
  writeFileSync(
    evidenceFile,
    [
      '# STP 004 隔离 PostgreSQL 证据（无凭证）',
      '',
      `- 来源：PostgreSQL 官网 Windows 页 ${officialPage} 指向的 EDB binaries ${edbPage}`,
      `- 包：${zipName}`,
      `- 工作目录：项目忽略目录 \`.local/stp004-pg\``,
      `- 数据目录：\`.local/stp004-pg/data\``,
      `- 监听：仅 127.0.0.1，端口不写入本文件`,
      `- 认证：scram-sha-256；API 角色 \`stp004_api\` 为非超级用户`,
      `- 探测结果：\`${redacted}\``,
      `- 角色：`,
      '```',
      roleFlags,
      '```',
      `- 数据库：\`${dbOwner}\``,
      `- 当前 public 表数量：${tableCount}`,
      `- postmaster PID：${pidMatch?.[1] ?? 'unknown'}`,
      `- 证据刷新走 SCRAM 与 5s/8s 超时，不再切换 trust/psql`,
      `- 未安装系统服务，未改共享实例，未输出密码`,
      '',
    ].join('\n'),
  );
}

async function finishExisting() {
  const port = readPort();
  const adminPassword = randomSecret();
  const apiPassword = randomSecret();
  provision(port, adminPassword, apiPassword);
  writeRuntime(port, adminPassword, apiPassword);
  await writeEvidenceAsync(port, adminPassword);
  process.stdout.write('STP004 isolated PostgreSQL provisioned. Evidence: docs/handoffs/STP004_PG_ISOLATION.md\n');
}

function readRuntimeValue(key) {
  if (!existsSync(runtimeFile)) {
    return '';
  }
  for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1);
    }
  }
  return '';
}

function isRunning() {
  return spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
  }).status === 0;
}

async function refreshEvidence() {
  const port = Number(readRuntimeValue('STP004_PG_PORT') || readPort());
  const adminUrl = readRuntimeValue('STP004_ADMIN_DATABASE_URL');
  const matched = adminUrl.match(/^postgresql:\/\/stp004_admin:([^@]+)@/);
  const adminPassword = matched ? decodeURIComponent(matched[1]) : '';
  if (!port || !adminPassword) {
    throw new Error('runtime.env missing port or admin credential for evidence refresh');
  }
  await writeEvidenceAsync(port, adminPassword);
}

async function ensure() {
  if (!existsSync(bin('pg_ctl')) || !existsSync(join(dataDir, 'PG_VERSION'))) {
    await start();
    return;
  }
  if (isRunning()) {
    await refreshEvidence();
    process.stdout.write('STP004 isolated PostgreSQL already running. Evidence refreshed.\n');
    return;
  }
  const port = Number(readRuntimeValue('STP004_PG_PORT'));
  if (!port) {
    await start();
    return;
  }
  const conf = readFileSync(join(dataDir, 'postgresql.conf'), 'utf8')
    .replace(/^#?listen_addresses\s*=.*/m, "listen_addresses = '127.0.0.1'")
    .replace(/^#?port\s*=.*/m, `port = ${port}`);
  writeFileSync(join(dataDir, 'postgresql.conf'), conf);
  startPostgres(port);
  await refreshEvidence();
  process.stdout.write('STP004 isolated PostgreSQL ensured without rotating secrets. Evidence: docs/handoffs/STP004_PG_ISOLATION.md\n');
}

function stop() {
  if (!existsSync(dataDir)) {
    return;
  }
  spawnSync(bin('pg_ctl'), ['-D', dataDir, '-w', 'stop', '-m', 'fast'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  process.stdout.write('STP004 isolated PostgreSQL stop requested.\n');
}

function status() {
  if (!existsSync(dataDir)) {
    process.stdout.write('not initialized\n');
    return;
  }
  const result = spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
  });
  process.stdout.write(result.stdout || result.stderr || 'unknown\n');
}

const command = process.argv[2] ?? 'start';
if (command === 'start') {
  await start();
} else if (command === 'ensure') {
  await ensure();
} else if (command === 'stop') {
  stop();
} else if (command === 'status') {
  status();
} else if (command === 'finish') {
  await finishExisting();
} else if (command === 'print-env-path') {
  process.stdout.write(`${runtimeFile}\n`);
} else {
  throw new Error(`unknown command ${command}`);
}

