'use client';

import { useEffect } from 'react';
import { makeReporter } from '@receipts/shared';

/** Reports uncaught browser errors to Sentry when NEXT_PUBLIC_SENTRY_DSN is set (no-op otherwise). */
export function ErrorReporter() {
  useEffect(() => {
    const reporter = makeReporter({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      service: 'web',
      environment: process.env.NODE_ENV,
    });
    if (!reporter.enabled) return;
    const onError = (e: ErrorEvent) =>
      void reporter.capture(e.error ?? e.message, { path: location.pathname });
    const onRejection = (e: PromiseRejectionEvent) =>
      void reporter.capture(e.reason, { path: location.pathname });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
