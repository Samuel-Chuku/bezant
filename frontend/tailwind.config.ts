import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Ink & Mint tokens. Stored as RGB channels in globals.css :root so the
        // `<alpha-value>` form below makes opacity modifiers work (bg-surface/50,
        // border-primary/20, etc.). The `soft` variants are fixed-alpha tints.
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          hover: 'rgb(var(--primary-hover) / <alpha-value>)',
          fg: 'rgb(var(--primary-fg) / <alpha-value>)',
          soft: 'rgb(var(--primary) / 0.12)',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn) / <alpha-value>)',
          soft: 'rgb(var(--warn) / 0.12)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          soft: 'rgb(var(--danger) / 0.12)',
        },
        info: 'rgb(var(--info) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
      },
      fontFamily: {
        // Bezant type trio. `brand`/`display` are the Fraunces serif; `sans` is
        // Bricolage (the default body); `mono` is JetBrains Mono for all data.
        brand: ['var(--font-brand)', 'Fraunces', 'serif'],
        display: ['var(--font-brand)', 'Fraunces', 'serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
