import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const cloudflaredPath = process.env.CLOUDFLARED_PATH?.trim() || 'cloudflared';
const tunnelTargetUrl = process.env.GUEST_CAMERA_TUNNEL_URL?.trim() || process.env.TUNNEL_URL?.trim() || 'http://127.0.0.1:5173';
const qrOutputPath = path.join(projectRoot, 'guest-camera-tunnel-qr-latest.png');
const cloudflaredLogPath = path.join(projectRoot, 'logs', 'cloudflared.latest.log');

await fs.mkdir(path.dirname(cloudflaredLogPath), { recursive: true });

const child = spawn(cloudflaredPath, ['tunnel', '--url', tunnelTargetUrl], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let tunnelUrl = '';
const extractUrl = (text) => {
  const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/i);
  return match?.[0] ?? '';
};

async function handleCloudflaredOutput(chunk, stream) {
  const text = chunk.toString();
  await fs.appendFile(cloudflaredLogPath, text, 'utf8');
  if (stream === 'stderr') {
    process.stderr.write(text);
  }

  const nextTunnelUrl = tunnelUrl || extractUrl(text);
  if (nextTunnelUrl && nextTunnelUrl !== tunnelUrl) {
    tunnelUrl = nextTunnelUrl;
    const png = await QRCode.toBuffer(tunnelUrl, {
      type: 'png',
      margin: 4,
      width: 700,
      color: { dark: '#000000', light: '#ffffff' }
    });
    await fs.writeFile(qrOutputPath, png);
    process.stdout.write(`Tunnel: ${tunnelUrl}\nQR: ${qrOutputPath}\n`);
  }
}

child.stdout.on('data', (chunk) => {
  void handleCloudflaredOutput(chunk, 'stdout');
});

child.stderr.on('data', (chunk) => {
  void handleCloudflaredOutput(chunk, 'stderr');
});

child.on('error', (cause) => {
  if (cause.code === 'ENOENT') {
    process.stderr.write('cloudflared was not found. Install it and make sure it is available in PATH, or set CLOUDFLARED_PATH.\n');
    process.exit(127);
  }
  process.stderr.write(`${cause.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (!tunnelUrl) {
    process.stderr.write(`cloudflared exited with code ${code}\n`);
  }
});
