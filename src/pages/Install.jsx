import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  Apple,
  Monitor,
  Smartphone,
  Share,
  PlusSquare,
  CheckCircle,
  Info,
  Home,
  ArrowRight,
  Download,
  MoreVertical,
} from 'lucide-react';

const PLATFORMS = [
  {
    id: 'ios',
    label: 'iPhone & iPad',
    icon: Apple,
    banner: 'Use Safari — the "Add to Home Screen" option only appears there.',
    steps: [
      { icon: Share, text: 'Tap the Share button in Safari’s toolbar.' },
      { icon: PlusSquare, text: 'Scroll down and choose “Add to Home Screen”.' },
      { icon: CheckCircle, text: 'Tap “Add” — UrbanStays appears on your home screen.' },
    ],
  },
  {
    id: 'android',
    label: 'Android',
    icon: Smartphone,
    banner: 'Works best in Chrome, Edge, or Samsung Internet.',
    steps: [
      { icon: MoreVertical, text: 'Open the three-dot menu in your browser’s toolbar.' },
      { icon: Download, text: 'Tap “Install app” or “Add to home screen”.' },
      { icon: CheckCircle, text: 'Confirm — UrbanStays installs like a native app.' },
    ],
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: Monitor,
    banner: 'Works in Chrome, Edge, and Arc. Safari on Mac doesn’t support PWA install yet.',
    steps: [
      { icon: Download, text: 'Click the install icon in the address bar (right side of the URL).' },
      { icon: PlusSquare, text: 'Click “Install” in the popup.' },
      { icon: CheckCircle, text: 'UrbanStays launches in its own window, like any other app.' },
    ],
  },
];

export default function InstallPage() {
  const [active, setActive] = useState('ios');
  const platform = PLATFORMS.find((p) => p.id === active) || PLATFORMS[0];

  return (
    <div className="min-h-[100dvh] bg-[radial-gradient(ellipse_at_top,_#1a0e08_0%,_#0a0a0a_55%,_#000000_100%)] text-white">
      <div className="max-w-2xl mx-auto px-5 sm:px-6 py-12 sm:py-20">
        {/* Hero */}
        <div className="flex flex-col items-center text-center mb-10">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 shadow-[0_0_60px_-10px_rgba(245,158,11,0.6)] flex items-center justify-center mb-6">
            <Home className="w-10 h-10 text-slate-900" strokeWidth={2.5} />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
            Install UrbanStays
          </h1>
          <p className="text-slate-400 text-base sm:text-lg max-w-md leading-relaxed">
            UrbanStays is a Progressive Web App — add it to your device and it
            works just like a native app, full-screen and one-tap fast. No app
            store required.
          </p>
        </div>

        {/* Tabs */}
        <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-1.5 mb-5 flex gap-1.5">
          {PLATFORMS.map((p) => {
            const isActive = p.id === active;
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                onClick={() => setActive(p.id)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all ${
                  isActive
                    ? 'bg-gradient-to-b from-amber-500 to-amber-600 text-slate-900 shadow-lg'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden xs:inline sm:inline">{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Banner */}
        <div className="flex items-center gap-3 bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3.5 mb-3">
          <Info className="w-5 h-5 text-amber-400 flex-shrink-0" />
          <p className="text-sm text-slate-300">{platform.banner}</p>
        </div>

        {/* Steps */}
        <div className="space-y-3">
          {platform.steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <div
                key={idx}
                className="flex items-center gap-4 bg-white/[0.04] border border-white/10 rounded-xl px-4 py-4"
              >
                <div className="w-9 h-9 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-amber-400 font-bold text-sm">{idx + 1}</span>
                </div>
                <Icon className="w-5 h-5 text-slate-400 flex-shrink-0" />
                <p className="text-sm sm:text-base text-slate-200">{step.text}</p>
              </div>
            );
          })}
        </div>

        {/* Footer link */}
        <div className="mt-10 text-center">
          <Link
            to={createPageUrl('Search')}
            className="inline-flex items-center gap-2 text-amber-500 hover:text-amber-400 text-sm font-semibold transition-colors"
          >
            Prefer the browser? Launch UrbanStays now <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
