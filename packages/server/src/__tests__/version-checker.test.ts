import { describe, it, expect, vi, afterEach } from 'vitest';
import { VersionChecker } from '../version-checker.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('VersionChecker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch latest version from npm registry', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker('0.5.3');
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

  it('should always fetch from registry (no cache)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: '1.0.0' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: '1.1.0' }) });

    const checker = new VersionChecker('0.5.3');
    await checker.check();
    const result = await checker.check();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.latestVersion).toBe('1.1.0');
  });

  it('should return hasUpdate=false when current >= latest', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '0.5.3' }),
    });

    const checker = new VersionChecker('0.5.3');
    const result = await checker.check();

    expect(result.hasUpdate).toBe(false);
  });

  it('should silently fail on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    const checker = new VersionChecker('0.5.3');
    const result = await checker.check();

    expect(result).toEqual({
      currentVersion: '0.5.3',
      latestVersion: null,
      hasUpdate: false,
      installMode: 'global',
    });
  });
});
