import { readFileSync } from 'fs';
import { join } from 'path';

interface PackageMetadata {
  version?: unknown;
}

function readServerVersion(): string {
  const packagePath = join(__dirname, '..', 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;
  if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error('Server package version is missing or invalid');
  }
  return metadata.version;
}

export const SERVER_VERSION = readServerVersion();
