import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// One-time migration of localStorage keys from the old Luxeliving brand
// to Urban Stays. Runs synchronously before React mounts so consumers
// always see the new keys. Safe to leave in indefinitely — it's a no-op
// after the first run.
(function migrateStorageKeys() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (localStorage.getItem('urbanstays_storage_migrated') === '1') return;
  try {
    const oldNew = [
      ['luxeliving_referral_code', 'urbanstays_referral_code'],
      ['luxeliving_quest_state', 'urbanstays_quest_state'],
    ];
    for (const [oldKey, newKey] of oldNew) {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldVal);
      }
      if (oldVal !== null) {
        localStorage.removeItem(oldKey);
      }
    }
    localStorage.setItem('urbanstays_storage_migrated', '1');
  } catch (err) {
    console.warn('Storage key migration failed:', err);
  }
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  // <React.StrictMode>
  <App />
  // </React.StrictMode>,
)

// Register the PWA service worker (production only — dev would race with HMR).
// The SW itself is a no-op pass-through; its only job is to unlock the
// browser's install prompt. Add caching strategies in /public/sw.js later
// if we want offline support.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:beforeUpdate' }, '*');
  });
  import.meta.hot.on('vite:afterUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:afterUpdate' }, '*');
  });
}



