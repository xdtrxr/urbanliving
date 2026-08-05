import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Mail, Lock, AlertCircle, ArrowRight, User as UserIcon, Phone, ShieldCheck } from 'lucide-react';
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
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'verify'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [isWorking, setIsWorking] = useState(false);
  const [referralCode, setReferralCode] = useState('');

  // Pull referral code from URL or localStorage so signup can attribute it.
  // Re-run when query string changes so a freshly clicked ?ref=... gets picked up.
  useEffect(() => {
    const urlRef = new URLSearchParams(location.search).get('ref');
    const stored = localStorage.getItem('urbanstays_referral_code');
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
    navigate('/Dashboard', { replace: true });
  };

  const handleProvider = (provider) => {
    setError(null);
    try {
      // Return to the originally-requested page after auth, falling back to /Search.
      // Same-origin only (already enforced when we read from_url).
      let returnPath = '/Dashboard';
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
    if (mode === 'signup') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (!firstName.trim()) {
        setError('First name is required');
        return;
      }
      if (!phoneNumber.trim() || phoneNumber.trim().replace(/\D/g, '').length < 10) {
        setError('A valid phone number is required (at least 10 digits)');
        return;
      }
    }

    setIsWorking(true);
    try {
      if (mode === 'signup') {
        await base44.auth.register({
          email,
          password,
          referral_code: referralCode || undefined,
        });
        // Base44 sends an email with a 6-digit OTP. Switch to verify mode so
        // the user can enter the code. We finish login + save profile fields
        // after the OTP is verified.
        setInfo(`We sent a 6-digit verification code to ${email}. Enter it below to finish creating your account.`);
        setMode('verify');
      } else {
        await base44.auth.loginViaEmailPassword(email, password);
        redirectAfterAuth();
      }
    } catch (err) {
      console.error('Auth failed:', err);
      const msg = err?.response?.data?.message || err?.message || 'Authentication failed';
      setError(msg);
    } finally {
      setIsWorking(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const code = otpCode.trim();
    if (!/^\d{4,8}$/.test(code)) {
      setError('Enter the verification code from your email');
      return;
    }
    setIsWorking(true);
    try {
      await base44.auth.verifyOtp({ email, otpCode: code });
      // After verification, log in and persist profile fields.
      try {
        await base44.auth.loginViaEmailPassword(email, password);
      } catch { /* ignore — verify may have logged in already */ }

      const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
      try {
        await base44.auth.updateMe({
          full_name: fullName,
          phone_number: phoneNumber.trim(),
        });
      } catch (profileErr) {
        console.warn('Failed to save profile fields after verify:', profileErr);
      }
      redirectAfterAuth();
    } catch (err) {
      console.error('Verify failed:', err);
      const msg = err?.response?.data?.message || err?.message || 'Invalid or expired code';
      setError(msg);
    } finally {
      setIsWorking(false);
    }
  };

  const handleResendOtp = async () => {
    setError(null);
    setInfo(null);
    setIsWorking(true);
    try {
      await base44.auth.resendOtp(email);
      setInfo(`A new code has been sent to ${email}.`);
    } catch (err) {
      console.error('Resend failed:', err);
      setError(err?.message || 'Could not resend code');
    } finally {
      setIsWorking(false);
    }
  };

  if (mode === 'verify') {
    return (
      <div
        className="min-h-[100dvh] bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4"
        style={{
          paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <Card className="w-full max-w-md bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl">
          <CardContent className="p-6 sm:p-8">
            <div className="text-center mb-6">
              <div className="w-12 h-12 mx-auto mb-3 bg-slate-900 rounded-full flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-amber-400" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900">Verify your email</h1>
              <p className="text-slate-600 mt-2 text-sm">
                {info || `We sent a 6-digit code to ${email}.`}
              </p>
            </div>

            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <Label htmlFor="otpCode">Verification code <span className="text-red-500 dark:text-red-400">*</span></Label>
                <Input
                  id="otpCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  className="mt-1 h-14 rounded-xl text-2xl tracking-[0.5em] text-center font-mono"
                  maxLength={8}
                  disabled={isWorking}
                  autoFocus
                />
                <p className="text-xs text-slate-500 mt-2 text-center">
                  Check your inbox (and spam folder).
                </p>
              </div>

              {error && (
                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                </div>
              )}

              <Button
                type="submit"
                disabled={isWorking}
                className="w-full h-12 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold"
              >
                {isWorking ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying…</>
                ) : (
                  <>Verify and continue<ArrowRight className="w-4 h-4 ml-2" /></>
                )}
              </Button>
            </form>

            <div className="text-center mt-6 text-sm text-slate-600 space-y-2">
              <div>
                Didn&apos;t get the code?{' '}
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={isWorking}
                  className="text-slate-900 font-semibold hover:underline disabled:opacity-50"
                >
                  Resend
                </button>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => { setMode('signup'); setError(null); setInfo(null); setOtpCode(''); }}
                  className="text-slate-500 hover:underline text-xs"
                >
                  ← Use a different email
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Card className="w-full max-w-md bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="text-center mb-6">
            <div className="w-12 h-12 mx-auto mb-3 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl flex items-center justify-center shadow-lg">
              <span className="text-amber-400 font-bold text-lg">US</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="text-slate-600 mt-1 text-sm sm:text-base">
              {mode === 'signin'
                ? 'Sign in to continue to UrbanStays'
                : 'Sign up to book verified short-stays'}
            </p>
          </div>

          {/* Tabs — make the Sign In / Sign Up choice front-and-center so new
              vs. existing users know exactly where they should go. */}
          <div role="tablist" className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-6">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signin'}
              onClick={() => { setMode('signin'); setError(null); }}
              className={`h-11 rounded-lg text-sm font-semibold transition-colors ${
                mode === 'signin'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              onClick={() => { setMode('signup'); setError(null); }}
              className={`h-11 rounded-lg text-sm font-semibold transition-colors ${
                mode === 'signup'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Create account
            </button>
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
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
            <span className="text-xs uppercase tracking-wide text-slate-500">or with email</span>
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-4">
            {mode === 'signup' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="firstName">First name <span className="text-red-500 dark:text-red-400">*</span></Label>
                    <div className="relative mt-1">
                      <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        id="firstName"
                        autoComplete="given-name"
                        placeholder="Jane"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="pl-10 h-12 rounded-xl"
                        disabled={isWorking}
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="lastName">Last name</Label>
                    <Input
                      id="lastName"
                      autoComplete="family-name"
                      placeholder="Optional"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="mt-1 h-12 rounded-xl"
                      disabled={isWorking}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="phoneNumber">Phone number <span className="text-red-500 dark:text-red-400">*</span></Label>
                  <div className="relative mt-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="phoneNumber"
                      type="tel"
                      autoComplete="tel"
                      placeholder="+234 800 000 0000"
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      className="pl-10 h-12 rounded-xl"
                      disabled={isWorking}
                    />
                  </div>
                </div>
              </>
            )}
            <div>
              <Label htmlFor="email">Email <span className="text-red-500 dark:text-red-400">*</span></Label>
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
              <Label htmlFor="password">Password <span className="text-red-500 dark:text-red-400">*</span></Label>
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

            {mode === 'signup' && (
              <div>
                <Label htmlFor="confirmPassword">Confirm password <span className="text-red-500 dark:text-red-400">*</span></Label>
                <div className="relative mt-1">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10 h-12 rounded-xl"
                    disabled={isWorking}
                  />
                </div>
              </div>
            )}

            {mode === 'signup' && referralCode && (
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-3 text-sm text-blue-800 dark:text-blue-200">
                Using referral code <strong>{referralCode}</strong>
              </div>
            )}

            {error && (
              <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
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

          {/* Sign in / Create account toggle lives in the tab row at the
              top — no need for a redundant text link down here. */}
        </CardContent>
      </Card>
    </div>
  );
}
