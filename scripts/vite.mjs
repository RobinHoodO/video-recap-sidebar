import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Vite reads .env itself, but it cannot resolve 1Password references. Resolve
// before starting either command. A clean clone can build without a local .env.
const args = process.argv.slice(2);
const child = existsSync('.env')
  ? spawn('oprun', ['--env-file', '.env', '--', 'vite', ...args], { stdio: 'inherit' })
  : spawn('vite', args, { stdio: 'inherit' });
child.on('error', () => {
  console.error('Could not start Vite. Install dependencies and, when using .env, ensure oprun is on PATH.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
