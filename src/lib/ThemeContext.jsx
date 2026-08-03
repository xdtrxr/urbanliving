import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'urbanstays_theme';
const ThemeContext = createContext(null);

const getSystemTheme = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

const readStoredPreference = () => {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
};

const applyThemeClass = (resolved) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // Keep the iOS status-bar / Android theme-color meta tag in sync so the
  // PWA chrome around the viewport flips with the rest of the UI.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0a0a' : '#0B1733');
};

export function ThemeProvider({ children }) {
  const [preference, setPreferenceState] = useState(readStoredPreference);
  const [resolved, setResolved] = useState(() =>
    readStoredPreference() === 'system' ? getSystemTheme() : readStoredPreference(),
  );

  useEffect(() => {
    const next = preference === 'system' ? getSystemTheme() : preference;
    setResolved(next);
    applyThemeClass(next);
  }, [preference]);

  // Watch system changes only while preference is 'system' — otherwise an
  // explicit choice should stick regardless of what the OS does.
  useEffect(() => {
    if (preference !== 'system' || typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const next = mq.matches ? 'dark' : 'light';
      setResolved(next);
      applyThemeClass(next);
    };
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [preference]);

  const setPreference = useCallback((next) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable — keep going, just don't persist */
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setPreference]);

  const value = { preference, resolved, setPreference, toggle };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
