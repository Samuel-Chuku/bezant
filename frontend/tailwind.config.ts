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
      // Type scale bumped ~1-2px per step for readability on the wider (1440px)
      // layout. `xs` stays 12px so dense chips/badges/meta don't overflow;
      // arbitrary sizes (text-[10px] etc.) are unaffected by design.
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }], // 12 - unchanged
        sm: ['0.9375rem', { lineHeight: '1.4rem' }], // 15
        base: ['1.0625rem', { lineHeight: '1.65rem' }], // 17
        lg: ['1.1875rem', { lineHeight: '1.75rem' }], // 19
        xl: ['1.3125rem', { lineHeight: '1.85rem' }], // 21
        '2xl': ['1.5625rem', { lineHeight: '2rem' }], // 25
        '3xl': ['1.9375rem', { lineHeight: '2.35rem' }], // 31
        '4xl': ['2.375rem', { lineHeight: '2.6rem' }], // 38
        '5xl': ['3.125rem', { lineHeight: '1.05' }], // 50
        '6xl': ['3.875rem', { lineHeight: '1.05' }], // 62
        '7xl': ['4.75rem', { lineHeight: '1' }], // 76
      },
    },
  },
  plugins: [],
};

export default config;
