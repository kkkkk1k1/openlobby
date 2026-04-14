import type Database from 'better-sqlite3';
import { getServerConfig, setServerConfig } from './db.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/openlobby/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
}

function isNewer(remote: string, current: string): boolean {
  const r = remote.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function detectInstallMode(): 'global' | 'npx' {
  const execPath = process.argv[1] ?? '';
  if (execPath.includes('_npx') || execPath.includes('.npm/_npx')) {
    return 'npx';
  }
  return 'global';
}

export class VersionChecker {
  private db: Database.Database;
  private currentVersion: string;
  private installMode: 'global' | 'npx';

  constructor(db: Database.Database, currentVersion: string) {
    this.db = db;
    this.currentVersion = currentVersion;
    this.installMode = detectInstallMode();
  }

  async check(): Promise<VersionCheckResult> {
    const fallback: VersionCheckResult = {
      currentVersion: this.currentVersion,
      latestVersion: null,
      hasUpdate: false,
      installMode: this.installMode,
    };

    const lastCheck = getServerConfig(this.db, 'last_version_check');
    const cachedVersion = getServerConfig(this.db, 'latest_remote_version');

    if (lastCheck && cachedVersion) {
      const elapsed = Date.now() - parseInt(lastCheck, 10);
      if (elapsed < CACHE_TTL_MS) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: cachedVersion,
          hasUpdate: isNewer(cachedVersion, this.currentVersion),
          installMode: this.installMode,
        };
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return fallback;

      const data = (await res.json()) as { version?: string };
      const latestVersion = data.version ?? null;

      if (latestVersion) {
        setServerConfig(this.db, 'last_version_check', String(Date.now()));
        setServerConfig(this.db, 'latest_remote_version', latestVersion);
      }

      return {
        currentVersion: this.currentVersion,
        latestVersion,
        hasUpdate: latestVersion ? isNewer(latestVersion, this.currentVersion) : false,
        installMode: this.installMode,
      };
    } catch {
      return fallback;
    }
  }

  getInstallMode(): 'global' | 'npx' {
    return this.installMode;
  }
}
