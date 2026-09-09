import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, ShieldCheck, Loader2, ArrowLeft } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Two-step inline gate for an anon lead about to book.
//   1. Reconfirm email — pre-filled from the Lead. User can edit before we
//      fire the OTP email. Prevents wasted codes from typos in chat.
//   2. Enter 6-digit code → verifyOtp + loginViaEmailPassword + updateMe
//      (name, phone from the lead). Account is created here, then onVerified
//      runs so the parent can complete the booking.
//
// The user never sees or sets a password — we generate a strong random one.
// They can use "Forgot Password" later if they want a password login.

function randomPassword() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return 'UrSt-' + btoa(String.fromCharCode(...arr)).replace(/[^A-Za-z0-9]/g, '').slice(0, 22) + '!9';
}

export default function LeadOtpGate({ lead, onVerified, onCancel }) {
  const [step, setStep] = useState('confirm-email');
  const [email, setEmail] = useState(lead?.email || '');
  const [otpCode, setOtpCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [generatedPassword] = useState(() => randomPassword());

  const sendCode = async () => {
    setError(null);
    setInfo(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address');
      return;
    }
    setWorking(true);
    try {
      try {
        await base44.auth.register({ email: trimmed, password: generatedPassword });
      } catch (registerErr) {
        // If the email already has an account, register fails — fall back to
        // resendOtp so the user can verify (or, if already verified, we'll
        // catch it on the verify step and route to login).
        const msg = registerErr?.response?.data?.message || registerErr?.message || '';
        if (/already|exists|registered/i.test(msg)) {
          try {
            await base44.auth.resendOtp(trimmed);
          } catch {
            // existing account, already verified — tell the user
            setError('This email already has an account. Please sign in instead.');
            setWorking(false);
            return;
          }
        } else {
          throw registerErr;
        }
      }
      setInfo(`We sent a 6-digit code to ${trimmed}.`);
      setStep('enter-code');
    } catch (err) {
      console.error('OTP send failed:', err);
      setError(err?.response?.data?.message || err?.message || 'Could not send code. Try again.');
    } finally {
      setWorking(false);
    }
  };

  const verify = async () => {
    setError(null);
    setInfo(null);
    const code = otpCode.trim();
    if (!/^\d{4,8}$/.test(code)) {
      setError('Enter the code from your email');
      return;
    }
    setWorking(true);
    try {
      await base44.auth.verifyOtp({ email: email.trim().toLowerCase(), otpCode: code });
      try {
        await base44.auth.loginViaEmailPassword(email.trim().toLowerCase(), generatedPassword);
      } catch {
        // verifyOtp may have already logged us in
      }
      try {
        await base44.auth.updateMe({
          full_name: lead?.name || undefined,
          phone_number: lead?.phone || undefined,
        });
      } catch (profileErr) {
        console.warn('Profile update after OTP failed (non-fatal):', profileErr);
      }
      onVerified?.({ email: email.trim().toLowerCase() });
    } catch (err) {
      console.error('OTP verify failed:', err);
      setError(err?.response?.data?.message || err?.message || 'Invalid or expired code');
    } finally {
      setWorking(false);
    }
  };

  const resend = async () => {
    setError(null);
    setInfo(null);
    setWorking(true);
    try {
      await base44.auth.resendOtp(email.trim().toLowerCase());
      setInfo('A new code has been sent.');
    } catch (err) {
      setError(err?.message || 'Could not resend code');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 border-2 border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-5 mt-2 mb-4">
      {step === 'confirm-email' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-slate-700 dark:text-slate-200" />
            <h3 className="font-semibold text-slate-900 dark:text-white">Confirm your email</h3>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            We'll send a 6-digit verification code so we can create your account and secure this booking. Double-check the email — typos waste codes.
          </p>
          <div>
            <Label htmlFor="lead-email" className="text-sm">Email</Label>
            <Input
              id="lead-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 rounded-xl mt-1"
              autoComplete="email"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            {onCancel && (
              <Button variant="outline" onClick={onCancel} className="rounded-xl" disabled={working}>
                Cancel
              </Button>
            )}
            <Button
              onClick={sendCode}
              disabled={working}
              className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl px-5 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
            >
              {working ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send code'}
            </Button>
          </div>
        </div>
      )}

      {step === 'enter-code' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-slate-700 dark:text-slate-200" />
            <h3 className="font-semibold text-slate-900 dark:text-white">Enter verification code</h3>
          </div>
          {info && <p className="text-sm text-slate-600 dark:text-slate-300">{info}</p>}
          <div>
            <Label htmlFor="lead-otp" className="text-sm">6-digit code</Label>
            <Input
              id="lead-otp"
              inputMode="numeric"
              pattern="\d*"
              maxLength={8}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="h-11 rounded-xl mt-1 tracking-widest text-center text-lg"
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={() => { setStep('confirm-email'); setOtpCode(''); setError(null); setInfo(null); }}
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1"
              disabled={working}
            >
              <ArrowLeft className="w-3 h-3" /> Change email
            </button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={resend}
                disabled={working}
                className="rounded-xl"
              >
                Resend
              </Button>
              <Button
                onClick={verify}
                disabled={working}
                className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl px-5 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {working ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & continue'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
