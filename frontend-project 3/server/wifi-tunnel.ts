import { spawn } from 'child_process';
import QRCode from 'qrcode';

const PORT = Number(process.env.PORT) || 3000;
const IS_WIN = process.platform === 'win32';

function runCommand(cmd: string, args: string[]) {
  return spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: IS_WIN,
  });
}

console.log('\n============================================================');
console.log('  AutoAuction — College Wi-Fi HTTPS Tunnel Showcase');
console.log('============================================================');
console.log('  Starting production server + secure HTTPS tunnel (WSS ready)...\n');

const serverProc = spawn('npx', ['tsx', 'server.ts', '--prod'], {
  stdio: 'inherit',
  shell: IS_WIN,
  env: { ...process.env, PORT: String(PORT) },
});

let tunnelProc: ReturnType<typeof spawn> | null = null;
let printedUrl = false;

setTimeout(() => {
  tunnelProc = runCommand('npx', [
    '--yes',
    'cloudflared',
    'tunnel',
    '--url',
    `http://127.0.0.1:${PORT}`,
  ]);

  const handleChunk = async (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !printedUrl) {
      printedUrl = true;
      const publicUrl = match[0];
      console.log('\n============================================================');
      console.log('  COLLEGE WI-FI HTTPS LINK READY (No Hotspot Needed!)');
      console.log('============================================================');
      console.log(`  Open on iPhone & Laptop : ${publicUrl}`);
      console.log('  Real-time WebSockets    : Enabled automatically (WSS)');
      console.log('  Works on                : College Wi-Fi, 5G, or any Wi-Fi\n');
      try {
        const qr = await QRCode.toString(publicUrl, {
          type: 'terminal',
          small: true,
          margin: 1,
        });
        console.log('  Scan with iPhone Camera:');
        console.log(
          qr
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')
        );
      } catch {
        // Ignore QR formatting issues
      }
      console.log('============================================================\n');
    }
  };

  tunnelProc.stdout?.on('data', (d) => void handleChunk(d));
  tunnelProc.stderr?.on('data', (d) => void handleChunk(d));

  tunnelProc.on('exit', (code) => {
    if (!printedUrl && code !== 0) {
      console.log('\n  [Tunnel Notice] Cloudflare tunnel could not connect on this network.');
      console.log('  Use VS Code Built-in Port Forwarding instead (works on all campus firewalls):');
      console.log('    1. Click the PORTS tab in VS Code (next to Terminal)');
      console.log('    2. Click "Forward a Port" -> enter 3000');
      console.log('    3. Right-click port 3000 -> Port Visibility -> Public');
      console.log('    4. Open the https://...devtunnels.ms link on your iPhone Safari!\n');
    }
  });
}, 1800);

const shutdown = () => {
  tunnelProc?.kill();
  serverProc.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
