import { describe, expect, it } from 'vitest';
import { getBuildStatus, normalizeBuildVersion } from './useBuildStatus';

describe('build status', () => {
  it('normalizes empty frontend versions to dev', () => {
    expect(normalizeBuildVersion(null)).toBe('dev');
    expect(normalizeBuildVersion('')).toBe('dev');
    expect(normalizeBuildVersion(' v1 ')).toBe('v1');
  });

  it('detects frontend/backend version mismatches', () => {
    expect(getBuildStatus('v1.0.0', 'v1.0.0')).toMatchObject({ hasMismatch: false, label: 'v1.0.0' });
    expect(getBuildStatus('v1.0.0', 'v1.0.1')).toMatchObject({
      hasMismatch: true,
      label: 'FE v1.0.0 / BE v1.0.1'
    });
  });
});
