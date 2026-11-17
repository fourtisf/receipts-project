'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { CATEGORIES, SORTS, type Category, type Sort } from '@/lib/strategy';

/** Category segmented control + sort select; state lives in the URL so views are shareable. */
export function StrategiesToolbar({ category, sort }: { category: Category; sort: Sort }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = (key: 'category' | 'sort', value: string, fallback: string) => {
    const next = new URLSearchParams(params?.toString() ?? '');
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : (pathname ?? '/app'), { scroll: false }));
  };

  return (
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3.5" aria-busy={pending}>
      <div className="seg" role="group" aria-label="Filter strategies">
        {CATEGORIES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={category === value}
            onClick={() => update('category', value, 'all')}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2.5 text-[14px] text-muted">
        Sort by
        <select className="select" value={sort} onChange={(e) => update('sort', e.target.value, 'vs')}>
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
