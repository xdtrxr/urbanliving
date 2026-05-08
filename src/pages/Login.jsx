import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Mail, Lock, AlertCircle, ArrowRight } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const GoogleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.11A6.62 6.62 0 0 1 5.5 12c0-.73.13-1.45.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
  </svg>
);

const AppleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.05 12.04c-.03-3.04 2.49-4.5 2.6-4.57-1.42-2.07-3.62-2.36-4.4-2.39-1.87-.19-3.66 1.1-4.61 1.1-.97 0-2.42-1.08-3.99-1.05-2.05.03-3.95 1.19-5 3.03-2.13 3.7-.55 9.16 1.53 12.16 1.02 1.47 2.23 3.12 3.83 3.06 1.54-.06 2.12-1 3.98-1 1.86 0 2.39 1 4.01.97 1.66-.03 2.7-1.5 3.71-2.97a13.6 13.6 0 0 0 1.7-3.42c-.04-.02-3.26-1.25-3.36-4.92zM14.1 3.85c.83-1.04 1.4-2.46 1.24-3.86-1.2.05-2.7.81-3.56 1.83-.78.91-1.46 2.39-1.27 3.74 1.34.1 2.74-.68 3.59-1.71z" />
  </svg>
);

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isWorking, setIsWorking] = useState(false);
  const [referralCode, setReferralCode] = useState('');

  // Pull referral code from URL or localStorage so signup can attribute it.
  // Re-run when query string changes so a freshly clicked ?ref=... gets picked up.
  useEffect(() => {
    const urlRef = new URLSearchParams(location.search).get('ref');
    const stored = localStorage.getItem('luxeliving_referral_code');
    setReferralCode(urlRef || stored || '');
  }, [location.search]);

  // Bounce away once on mount if the user is already signed in. Don't re-run
  // on URL changes — that races with the user typing into the form.
  useEffect(() => {
    let cancelled = false;
    base44.auth.me()
      .then(() => { if (!cancelled) navigate('/Search', { replace: true }); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redirectAfterAuth = () => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('from_url');
    if (fromUrl) {
      try {
        const target = new URL(fromUrl, window.location.origin);
        // Only allow same-origin redirects to prevent phishing.
        if (target.origin === window.location.origin && target.href !== window.location.href) {
          window.location.href = target.href;
          return;
        }
      } catch {
        // Malformed URL — fall through to default
      }
    }
    navigate('/Search', { replace: true });
  };

  const handleProvider = (provider) => {
    setError(null);
    try {
      // Return to the originally-requested page after auth, falling back to /Search.
      // Same-origin only (already enforced when we read from_url).
      let returnPath = '/Search';
      const params = new URLSearchParams(location.search);
      const fromUrl = params.get('from_url');
      if (fromUrl) {
        try {
          const target = new URL(fromUrl, window.location.origin);
          if (target.origin === window.location.origin) returnPath = target.pathname + target.search;
        } catch { /* keep default */ }
      }
      base44.auth.loginWithProvider(provider, returnPath);
    } catch (err) {
      console.error(`${provider} login failed:`, err);
      setError(err.message || `Failed to start ${provider} sign-in`);
    }
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsWorking(true);
    try {
      if (mode === 'signup') {
        await base44.auth.register({
          email,
          password,
          referral_code: referralCode || undefined,
        });
        // Some flows auto-login; if not, attempt sign-in afterwards
        try {
          await base44.auth.loginViaEmailPassword(email, password);
        } catch { /* ignore — register may have logged in */ }
      } else {
        await base44.auth.loginViaEmailPassword(email, password);
      }
      redirectAfterAuth();
    } catch (err) {
      console.error('Auth failed:', err);
      const msg = err?.response?.data?.message || err?.message || 'Authentication failed';
      setError(msg);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-white/95 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl">
        <CardContent className="p-8">
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold text-slate-900">UrbanStays</h1>
            <p className="text-slate-600 mt-1">
              {mode === 'signin' ? 'Welcome back — sign in to continue' : 'Create an account to get started'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 mb-5">
            <Button
              variant="outline"
              onClick={() => handleProvider('google')}
              className="rounded-xl h-12 font-medium border-slate-200 hover:bg-slate-50 flex items-center justify-center gap-3"
            >
              <GoogleIcon />
              Continue with Google
            </Button>
            <Button
              variant="outline"
              onClick={() => handleProvider('apple')}
              className="rounded-xl h-12 font-medium border-slate-200 hover:bg-slate-50 flex items-center justify-center gap-3"
            >
              <AppleIcon />
              Continue with Apple
            </Button>
          </div>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs uppercase tracking-wide text-slate-500">or with email</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <div className="relative mt-1">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-12 rounded-xl"
                  disabled={isWorking}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <div className="relative mt-1">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'signup' ? 'Min 8 characters' : 'Your password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 h-12 rounded-xl"
                  disabled={isWorking}
                />
              </div>
            </div>

            {mode === 'signup' && referralCode && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-800">
                Using referral code <strong>{referralCode}</strong>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={isWorking}
              className="w-full h-12 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold"
            >
              {isWorking ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Working...</>
              ) : (
                <>{mode === 'signin' ? 'Sign in' : 'Create account'}<ArrowRight className="w-4 h-4 ml-2" /></>
              )}
            </Button>
          </form>

          <div className="text-center mt-6 text-sm text-slate-600">
            {mode === 'signin' ? (
              <>
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('signup'); setError(null); }}
                  className="text-slate-900 font-semibold hover:underline"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('signin'); setError(null); }}
                  className="text-slate-900 font-semibold hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
