import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useAuth } from '@/lib/AuthContext';
import {
  Home,
  ArrowRight,
  Download,
  Search,
  ShieldCheck,
  Banknote,
  Sparkles,
  MapPin,
  Clock,
} from 'lucide-react';

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Verified apartments',
    body: 'Every listing is vetted by HOMESHARES — no scams, no surprise listings.',
  },
  {
    icon: Banknote,
    title: 'Pay in naira',
    body: 'NGN end-to-end. Card or bank transfer via Paystack. No FX shenanigans.',
  },
  {
    icon: Sparkles,
    title: 'AI concierge',
    body: 'Agent Nova helps you find, compare and book — in English or Pidgin.',
  },
  {
    icon: MapPin,
    title: 'Abuja & Lagos',
    body: 'Curated short-stays across Maitama, Lekki, Victoria Island, Asokoro and more.',
  },
  {
    icon: Clock,
    title: 'Standard times',
    body: 'Check-in from 2:00 PM. Check-out by 12:00 PM. Same on every property.',
  },
];

export default function LandingPage() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-white via-amber-50/30 to-white text-slate-900">
      {/* Top nav — minimal, just brand + sign in / dashboard */}
      <header className="px-5 sm:px-8 pt-6 pb-2 flex items-center justify-between max-w-6xl mx-auto">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center shadow-md group-hover:shadow-lg transition-shadow">
            <Home className="w-5 h-5 text-amber-400" strokeWidth={2.5} />
          </div>
          <span className="text-lg font-bold tracking-tight text-slate-900">UrbanStays</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            to={createPageUrl('Install')}
            className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-2 hidden sm:inline-block"
          >
            Install app
          </Link>
          {isAuthenticated ? (
            <Link
              to={createPageUrl('Dashboard')}
              className="text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 transition-colors px-4 py-2 rounded-full shadow-md"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              to="/login"
              className="text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 transition-colors px-4 py-2 rounded-full shadow-md"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="px-5 sm:px-8 py-12 sm:py-20 max-w-6xl mx-auto">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-xs font-semibold mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Live in Abuja & Lagos
          </div>
          <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight mb-5 leading-[1.05] text-slate-900">
            Short-stays you can <span className="text-amber-600">actually trust</span>.
          </h1>
          <p className="text-base sm:text-xl text-slate-600 max-w-2xl mx-auto mb-10 leading-relaxed">
            Verified apartments across Nigeria’s capital and economic hub. Book
            direct, pay in naira, and have Agent Nova answer every question
            before you arrive.
          </p>

          {/* Dual CTA — equal weight */}
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center max-w-md sm:max-w-none mx-auto">
            <Link
              to={createPageUrl('Search')}
              className="group flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-6 sm:px-8 py-4 rounded-xl bg-gradient-to-b from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-900 font-bold text-base shadow-lg shadow-amber-500/30 transition-all"
            >
              <Search className="w-5 h-5" />
              Browse properties
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <Link
              to={createPageUrl('Install')}
              className="group flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-6 sm:px-8 py-4 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 text-slate-900 font-bold text-base shadow-sm transition-all"
            >
              <Download className="w-5 h-5" />
              Install the app
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="px-5 sm:px-8 pb-20 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group bg-white hover:bg-amber-50/40 border border-slate-200 hover:border-amber-300 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all"
              >
                <div className="w-11 h-11 rounded-xl bg-amber-100 border border-amber-200 flex items-center justify-center mb-4 group-hover:bg-amber-200/70 transition-colors">
                  <Icon className="w-5 h-5 text-amber-700" />
                </div>
                <h3 className="font-semibold text-slate-900 mb-1.5 text-base">{f.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{f.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer band */}
      <footer className="border-t border-slate-200 px-5 sm:px-8 py-8 max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-sm">
          <p className="text-slate-500">
            © {new Date().getFullYear()} HOMESHARES LTD. UrbanStays.io
          </p>
          <div className="flex items-center gap-5">
            <Link to={createPageUrl('Install')} className="text-slate-500 hover:text-slate-900 transition-colors">
              Install
            </Link>
            <Link to={createPageUrl('Search')} className="text-slate-500 hover:text-slate-900 transition-colors">
              Browse
            </Link>
            <Link to={createPageUrl('FAQ')} className="text-slate-500 hover:text-slate-900 transition-colors">
              FAQs
            </Link>
            <Link to={createPageUrl('PrivacyPolicy')} className="text-slate-500 hover:text-slate-900 transition-colors">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
