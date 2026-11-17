import type { Config } from 'tailwindcss';

// Design tokens from specs/DESIGN.md (source: prototype/receipts.html).
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FFFFFF',
        'bg-2': '#FAFAFA',
        'bg-3': '#F4F4F5',
        line: '#EAEAEA',
        'line-2': '#F1F1F2',
        ink: '#0A0A0A',
        'ink-2': '#3F3F46',
        muted: '#71717A',
        faint: '#A1A1AA',
        green: { DEFAULT: '#12B76A', dark: '#067647', bg: '#ECFDF3' },
        red: { DEFAULT: '#D92D20', bg: '#FEF3F2' },
        ai: { DEFAULT: '#3538CD', bg: '#EEF4FF' },
      },
      fontFamily: {
        sans: ['var(--font-jakarta)', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', '"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        btn: '11px',
        'btn-lg': '13px',
        card: '16px',
        panel: '20px',
        frame: '18px',
        final: '28px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(10,10,10,.04)',
        DEFAULT: '0 1px 2px rgba(10,10,10,.04), 0 8px 24px rgba(10,10,10,.06)',
        lg: '0 2px 4px rgba(10,10,10,.04), 0 24px 64px rgba(10,10,10,.10)',
      },
    },
  },
  plugins: [],
};

export default config;
