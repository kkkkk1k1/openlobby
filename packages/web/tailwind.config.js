/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--color-surface)',
          secondary: 'var(--color-surface-secondary)',
          elevated: 'var(--color-surface-elevated)',
          overlay: 'var(--color-surface-overlay)',
        },
        'on-surface': {
          DEFAULT: 'var(--color-on-surface)',
          secondary: 'var(--color-on-surface-secondary)',
          muted: 'var(--color-on-surface-muted)',
        },
        outline: {
          DEFAULT: 'var(--color-outline)',
          subtle: 'var(--color-outline-subtle)',
        },
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          surface: 'var(--color-primary-surface)',
          on: 'var(--color-primary-on)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          hover: 'var(--color-danger-hover)',
          surface: 'var(--color-danger-surface)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
          surface: 'var(--color-success-surface)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          hover: 'var(--color-warning-hover)',
          surface: 'var(--color-warning-surface)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
          surface: 'var(--color-info-surface)',
        },
      },
    },
  },
  plugins: [],
};
