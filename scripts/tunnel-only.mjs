import { spawn } from 'node:child_process';

const cloudflaredPath = process.env.CLOUDFLARED_PATH?.trim() || 'cloudflared';

const child = spawn(cloudflaredPath, ['tunnel', '--url', 'http://127.0.0.1:5173'], {
  windowsHide: true,
  stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code ?? 0));
