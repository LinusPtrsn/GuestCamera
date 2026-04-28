import { useEffect } from 'react';
import type { FrontendLog } from '../types';

export function serializeConsoleArg(value: unknown) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type Options = {
  hasPendingPreview: () => boolean;
  sendLog: (entry: FrontendLog) => void;
};

export function useFrontendLogging({ hasPendingPreview, sendLog }: Options) {
  useEffect(() => {
    const originalConsole = {
      debug: console.debug.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      log: console.log.bind(console),
      warn: console.warn.bind(console)
    };
    const wrapConsole = (method: keyof typeof originalConsole, level: FrontendLog['level']) => {
      console[method] = (...args: unknown[]) => {
        originalConsole[method](...args);
        sendLog({
          level,
          message: args.map(serializeConsoleArg).join(' '),
          source: `console.${method}`,
          stack: args.find((arg): arg is Error => arg instanceof Error)?.stack
        });
      };
    };
    wrapConsole('debug', 'info');
    wrapConsole('log', 'info');
    wrapConsole('info', 'info');
    wrapConsole('warn', 'warn');
    wrapConsole('error', 'error');

    const onWindowError = (event: ErrorEvent) => {
      sendLog({
        level: 'error',
        message: event.message || 'Window error',
        source: 'window.error',
        stack: event.error instanceof Error ? event.error.stack : undefined
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      sendLog({
        level: 'error',
        message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
        source: 'window.unhandledrejection',
        stack: reason instanceof Error ? reason.stack : undefined
      });
    };
    const onPageHide = () => {
      if (hasPendingPreview()) {
        sendLog({
          level: 'warn',
          message: 'Page hidden while confirmation preview was open',
          source: 'pagehide'
        });
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasPendingPreview()) {
        sendLog({
          level: 'warn',
          message: 'Document hidden while confirmation preview was open',
          source: 'visibilitychange'
        });
      }
    };
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      console.debug = originalConsole.debug;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [hasPendingPreview, sendLog]);
}
