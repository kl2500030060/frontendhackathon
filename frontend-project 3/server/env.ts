import fs from 'fs';
import path from 'path';

// Load optional local .env file on laptop/VM before other server modules read process.env
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore malformed optional .env file
  }
}
