import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { VersionChecker } from '../version-checker.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('VersionChecker', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('should fetch latest version from npm registry on first check', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/openlobby/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      currentVersion: '0.5.3',
      latestVersion: '1.0.0',
      hasUpdate: true,
      installMode: 'global',
    });
  });

  it('should use cached result within 24 hours', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    await checker.check();
    const result = await checker.check();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.hasUpdate).toBe(true);
  });

  it('should return hasUpdate=false when current >= latest', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '0.5.3' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(result.hasUpdate).toBe(false);
  });

  it('should silently fail on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(result).toEqual({
      currentVersion: '0.5.3',
      latestVersion: null,
      hasUpdate: false,
      installMode: 'global',
    });
  });
});
