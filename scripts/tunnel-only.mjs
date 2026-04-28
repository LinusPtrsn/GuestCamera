import { spawn } from 'node:child_process';

const cloudflaredPath = 'C:\\Users\\linus\\Tools\\cloudflared\\cloudflared.exe';
const cmdPath = 'C:\\Windows\\System32\\cmd.exe';

const child = spawn(cmdPath, ['/c', cloudflaredPath, 'tunnel', '--url', 'http://127.0.0.1:5173'], {
  windowsHide: true,
  stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code ?? 0));
