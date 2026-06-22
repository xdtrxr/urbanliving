import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '@/lib/ThemeContext';

// ThemeToggle — single round button that flips between light and dark.
// We intentionally don't expose the "system" option in the UI; users who
// haven't touched the toggle inherit the OS pref via the provider default.
export default function ThemeToggle({ className = '' }) {
  const { resolved, toggle } = useTheme();
  const isDark = resolved === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={
        'inline-flex items-center justify-center w-10 h-10 rounded-full ' +
        'text-slate-600 hover:text-slate-900 hover:bg-slate-100 ' +
        'dark:text-slate-300 dark:hover:text-white dark:hover:bg-slate-800 ' +
        'transition-colors ' +
        className
      }
    >
      {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
