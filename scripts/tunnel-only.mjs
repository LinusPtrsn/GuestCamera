import { spawn } from 'node:child_process';

const cloudflaredPath = process.env.CLOUDFLARED_PATH?.trim() || 'cloudflared';
const tunnelTargetUrl = process.env.GUEST_CAMERA_TUNNEL_URL?.trim() || process.env.TUNNEL_URL?.trim() || 'http://127.0.0.1:5173';

const child = spawn(cloudflaredPath, ['tunnel', '--url', tunnelTargetUrl], {
  windowsHide: true,
  stdio: 'inherit'
});

child.on('error', (cause) => {
  if (cause.code === 'ENOENT') {
    process.stderr.write('cloudflared was not found. Install it and make sure it is available in PATH, or set CLOUDFLARED_PATH.\n');
    process.exit(127);
  }
  process.stderr.write(`${cause.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
