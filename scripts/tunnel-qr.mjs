import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cloudflaredPath = process.env.CLOUDFLARED_PATH?.trim() || 'cloudflared';
const qrOutputPath = path.join(projectRoot, 'guest-camera-tunnel-qr-latest.png');
const cloudflaredLogPath = path.join(projectRoot, 'logs', 'cloudflared.latest.log');

await fs.mkdir(path.dirname(cloudflaredLogPath), { recursive: true });

const child = spawn(cloudflaredPath, ['tunnel', '--url', 'http://127.0.0.1:5173'], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let tunnelUrl = '';
const extractUrl = (text) => {
  const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/i);
  return match?.[0] ?? '';
};

child.stdout.on('data', async (chunk) => {
  const text = chunk.toString();
  await fs.appendFile(cloudflaredLogPath, text, 'utf8');
  tunnelUrl ||= extractUrl(text);
  if (tunnelUrl) {
    const png = await QRCode.toBuffer(tunnelUrl, {
      type: 'png',
      margin: 4,
      width: 700,
      color: { dark: '#000000', light: '#ffffff' }
    });
    await fs.writeFile(qrOutputPath, png);
    process.stdout.write(`Tunnel: ${tunnelUrl}\nQR: ${qrOutputPath}\n`);
  }
});

child.stderr.on('data', async (chunk) => {
  const text = chunk.toString();
  await fs.appendFile(cloudflaredLogPath, text, 'utf8');
  process.stderr.write(text);
});

child.on('exit', (code) => {
  if (!tunnelUrl) {
    process.stderr.write(`cloudflared exited with code ${code}\n`);
  }
});
