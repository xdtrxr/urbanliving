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
    <div className="min-h-[100dvh] bg-[radial-gradient(ellipse_at_top,_#1a0e08_0%,_#0a0a0a_55%,_#000000_100%)] text-white">
      {/* Top nav — minimal, just brand + sign in / dashboard */}
      <header className="px-5 sm:px-8 pt-6 pb-2 flex items-center justify-between max-w-6xl mx-auto">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20 group-hover:shadow-amber-500/40 transition-shadow">
            <Home className="w-5 h-5 text-slate-900" strokeWidth={2.5} />
          </div>
          <span className="text-lg font-bold tracking-tight">UrbanStays</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            to={createPageUrl('Install')}
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors px-3 py-2 hidden sm:inline-block"
          >
            Install app
          </Link>
          {isAuthenticated ? (
            <Link
              to={createPageUrl('Dashboard')}
              className="text-sm font-semibold text-slate-900 bg-white hover:bg-slate-100 transition-colors px-4 py-2 rounded-full"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              to="/login"
              className="text-sm font-semibold text-slate-900 bg-white hover:bg-slate-100 transition-colors px-4 py-2 rounded-full"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="px-5 sm:px-8 py-12 sm:py-20 max-w-6xl mx-auto">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Live in Abuja & Lagos
          </div>
          <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight mb-5 leading-[1.05]">
            Short-stays you can <span className="text-amber-400">actually trust</span>.
          </h1>
          <p className="text-base sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
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
              className="group flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-6 sm:px-8 py-4 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/15 hover:border-white/25 text-white font-bold text-base transition-all"
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
                className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 hover:border-amber-500/30 rounded-2xl p-6 transition-all"
              >
                <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4 group-hover:bg-amber-500/20 transition-colors">
                  <Icon className="w-5 h-5 text-amber-400" />
                </div>
                <h3 className="font-semibold text-white mb-1.5 text-base">{f.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{f.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer band */}
      <footer className="border-t border-white/10 px-5 sm:px-8 py-8 max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-sm">
          <p className="text-slate-500">
            © {new Date().getFullYear()} HOMESHARES LTD. UrbanStays.io
          </p>
          <div className="flex items-center gap-5">
            <Link to={createPageUrl('Install')} className="text-slate-400 hover:text-white transition-colors">
              Install
            </Link>
            <Link to={createPageUrl('Search')} className="text-slate-400 hover:text-white transition-colors">
              Browse
            </Link>
            <Link to={createPageUrl('FAQ')} className="text-slate-400 hover:text-white transition-colors">
              FAQs
            </Link>
            <Link to={createPageUrl('PrivacyPolicy')} className="text-slate-400 hover:text-white transition-colors">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
