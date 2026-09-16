import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgresql://studysteps:studysteps@127.0.0.1:5432/studysteps';
}

const child = spawn('pnpm', ['exec', 'prisma', 'validate'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
