'use client';

import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="max-w-[720px] p-9 max-[800px]:px-[18px] max-[800px]:py-[22px]">
      <div className="phead mb-[26px]">
        <h1>This page could not load</h1>
        <p>
          The data service may be restarting. Your funds are not affected: vaults live on Robinhood Chain.
        </p>
      </div>
      <button className="btn btn-dark" type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
