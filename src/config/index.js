import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, '..', '..', '.env');

const defaults = {
  DB_TYPE: 'memory',
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: '',
  DB_NAME: 'openlogtool',
};

function readConfig() {
  const config = { ...defaults };
  if (!fs.existsSync(configPath)) {
    return config;
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key in defaults) {
        config[key] = value;
      }
    }
  }
  return config;
}

function writeConfig(updates) {
  const config = readConfig();
  const newConfig = { ...config, ...updates };
  const lines = [];
  for (const [key, value] of Object.entries(newConfig)) {
    if (key in defaults) {
      lines.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(configPath, lines.join('\n') + '\n');
  return newConfig;
}

function getConfig() {
  return readConfig();
}

export { readConfig, writeConfig, getConfig };