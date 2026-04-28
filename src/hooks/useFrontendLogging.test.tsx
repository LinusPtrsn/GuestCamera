import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeConsoleArg, useFrontendLogging } from './useFrontendLogging';

describe('useFrontendLogging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes common console values', () => {
    expect(serializeConsoleArg('hello')).toBe('hello');
    expect(serializeConsoleArg({ ok: true })).toBe('{"ok":true}');
    expect(serializeConsoleArg(new Error('boom'))).toContain('Error: boom');
  });

  it('mirrors console calls and restores console methods on cleanup', () => {
    const sendLog = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { unmount } = renderHook(() => useFrontendLogging({ hasPendingPreview: () => false, sendLog }));
    console.log('from browser');

    expect(sendLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      message: 'from browser',
      source: 'console.log'
    }));

    unmount();
    console.log('after cleanup');
    expect(sendLog).toHaveBeenCalledTimes(1);
  });

  it('logs pagehide when a preview is still open', () => {
    const sendLog = vi.fn();
    renderHook(() => useFrontendLogging({ hasPendingPreview: () => true, sendLog }));

    window.dispatchEvent(new Event('pagehide'));

    expect(sendLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      source: 'pagehide'
    }));
  });
});
