import os from 'os';
import QRCode from 'qrcode';

export interface DetectedInterface {
  name: string;
  address: string;
  label: string;
  priority: number;
}

const VIRTUAL_ADAPTER_PATTERN =
  /vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|tailscale|utun|br-|veth/i;

export function detectLanInterfaces(): DetectedInterface[] {
  const nets = os.networkInterfaces();
  const results: DetectedInterface[] = [];

  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      if (ip.startsWith('169.254.') || ip.startsWith('127.')) continue;

      const isVirtual = VIRTUAL_ADAPTER_PATTERN.test(name);
      const isWifi = /wi-?fi|wlan|wireless|en0/i.test(name);
      let priority = 50;
      let label = 'Local Network';

      if (!isVirtual && isWifi && !ip.startsWith('172.20.10.')) {
        priority = 5;
        label = 'Wi-Fi / Campus Network';
      } else if (!isVirtual && ip.startsWith('192.168.')) {
        priority = 10;
        label = 'Wi-Fi / LAN';
      } else if (!isVirtual && ip.startsWith('10.')) {
        priority = 12;
        label = 'College Wi-Fi / LAN';
      } else if (!isVirtual && /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) && !ip.startsWith('172.20.10.')) {
        priority = 15;
        label = 'Campus / Private LAN';
      } else if (ip.startsWith('172.20.10.')) {
        priority = 20;
        label = 'iPhone Personal Hotspot';
      } else if (isVirtual) {
        priority = 90;
        label = 'Virtual Adapter';
      }

      results.push({ name, address: ip, label, priority });
    }
  }

  return results.sort((a, b) => a.priority - b.priority);
}

export async function printStartupBanner(port: number, isProd: boolean): Promise<void> {
  const interfaces = detectLanInterfaces();
  const nonVirtual = interfaces.filter((i) => i.priority < 90);
  const primary = nonVirtual[0] ?? interfaces[0] ?? null;

  console.log('\n============================================================');
  console.log(`  AutoAuction Server Ready (${isProd ? 'Production Showcase' : 'Development'})`);
  console.log('============================================================');
  console.log(`  Laptop (VS Code) : http://localhost:${port}`);

  if (primary) {
    const phoneUrl = `http://${primary.address}:${port}`;
    console.log(`  Phone (Same WiFi): ${phoneUrl}  [${primary.label}]`);

    const extras = nonVirtual.slice(1, 3);
    for (const extra of extras) {
      console.log(`  Alternate LAN    : http://${extra.address}:${port}  [${extra.name}]`);
    }

    try {
      const qr = await QRCode.toString(phoneUrl, {
        type: 'terminal',
        small: true,
        margin: 1,
      });
      console.log('\n  Scan with iPhone Camera (direct LAN):');
      console.log(
        qr
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
      );
    } catch {
      // Fallback gracefully if QR rendering fails
    }
  } else {
    console.log('  Phone Access     : Connect laptop to Wi-Fi and restart');
  }

  console.log('  Blocked by College Wi-Fi isolation? No hotspot needed:');
  console.log('  Option 1 (Fastest): In VS Code -> PORTS tab -> Forward Port 3000');
  console.log('                      -> Right-click -> Port Visibility -> Public');
  console.log('  Option 2 (CLI QR) : Run "npm run wifi" for an instant HTTPS QR link');
  console.log('============================================================\n');
}
