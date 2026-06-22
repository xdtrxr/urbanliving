
import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, ShieldCheck, CreditCard, Loader2, CheckCircle, AlertTriangle, ArrowLeft, Mail, User, Clock } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { awardBookingMilestones } from '@/components/utils/loyaltyService';
import IdUploadGate from '@/components/booking/IdUploadGate';

const DEBUG_PAYMENT = false;
const dlog = (...args) => { if (DEBUG_PAYMENT) console.log(...args); };

// Payment provider logos
const PaystackLogo = () => (
  <svg width="100" height="28" viewBox="0 0 200 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="60" rx="8" fill="#00C3F7"/>
    <text x="100" y="38" fontFamily="Arial, sans-serif" fontSize="24" fontWeight="bold" fill="white" textAnchor="middle">
      Paystack
    </text>
  </svg>
);

// Stripe logo + handler removed — Paystack is the sole payment processor.

export default function PaymentPage() {
  // Paystack is the only processor. Kept as a const rather than removed
  // because validatePaymentDetails + the button label still reference it,
  // and it makes re-introducing a picker trivial later.
  const selectedMethod = 'paystack';
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [bookingData, setBookingData] = useState(null);
  const [error, setError] = useState(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [paystackPublicKey, setPaystackPublicKey] = useState(null);

  // Payment form data
  const [paymentDetails, setPaymentDetails] = useState({
    email: '',
    fullName: ''
  });
  const [validationErrors, setValidationErrors] = useState({});

  // Payment window countdown
  const [deadlineMs, setDeadlineMs] = useState(null);
  const [msLeft, setMsLeft] = useState(null);
  const [hasExpired, setHasExpired] = useState(false);

  useEffect(() => {
    dlog('=== PAYMENT PAGE MOUNTED ===');
    dlog('URL Search Params:', window.location.search);
    dlog('booking_id:', searchParams.get('booking_id'));
    dlog('total:', searchParams.get('total'));
    dlog('property_title:', searchParams.get('property_title'));
    dlog('guest_email:', searchParams.get('guest_email'));
    
    loadBookingAndUserData();
    loadPaystackKey();
  }, []);

  // Tick the countdown every second once we know the deadline
  useEffect(() => {
    if (!deadlineMs) return;
    const tick = () => {
      const remaining = deadlineMs - Date.now();
      setMsLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        setHasExpired(true);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadlineMs]);

  // On expiry: alert user and redirect. Server-side getBookings will mark
  // the booking cancelled on its next read (single source of truth).
  useEffect(() => {
    if (!hasExpired || !bookingData?.id) return;
    alert('Your payment window has expired and the booking has been cancelled. Please request availability again.');
    navigate(createPageUrl('Bookings'));
  }, [hasExpired, bookingData?.id, navigate]);

  const formatRemaining = (ms) => {
    if (ms == null) return '';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const loadPaystackKey = async () => {
    try {
      const response = await base44.functions.invoke('getPaystackPublicKey');
      if (response.data && response.data.publicKey) {
        setPaystackPublicKey(response.data.publicKey);
        dlog('✅ Paystack public key loaded');
      } else {
        console.error('Failed to load Paystack public key: Response missing publicKey', response);
        setError("Could not load payment provider configuration. Please try again later.");
      }
    } catch (err) {
      console.error('Error loading Paystack key:', err);
      setError("Failed to connect to payment provider. Please check your internet connection or try again later.");
    }
  };

  const loadBookingAndUserData = async () => {
    dlog('=== LOADING BOOKING DATA ===');
    setIsPageLoading(true);
    setError(null);
    
    try {
      // Get URL parameters
      const bookingId = searchParams.get('booking_id');
      const total = searchParams.get('total');
      const propertyTitle = searchParams.get('property_title');
      const guestEmail = searchParams.get('guest_email');

      dlog('Extracted params:', { bookingId, total, propertyTitle, guestEmail });

      // Validate required parameters
      if (!bookingId) {
        console.error('Missing booking_id');
        setError("Missing booking ID. Please restart the booking process.");
        setIsPageLoading(false);
        return;
      }

      if (!total || isNaN(parseFloat(total))) {
        console.error('Invalid total:', total);
        setError("Invalid payment amount. Please restart the booking process.");
        setIsPageLoading(false);
        return;
      }

      // Get current user
      let user;
      try {
        user = await base44.auth.me();
        dlog('User loaded:', user.email);
      } catch (userError) {
        console.error('Failed to load user:', userError);
        setError("Please log in to continue with payment.");
        setIsPageLoading(false);
        return;
      }

      // Fetch the full booking record so we can compute the payment deadline
      // and stamp payment_started_at on first visit.
      let fullBooking = null;
      try {
        fullBooking = await base44.entities.Booking.get(bookingId);
      } catch (fetchErr) {
        console.warn('Could not fetch full booking record:', fetchErr);
      }

      // Set booking data
      const bookingInfo = {
        id: bookingId,
        total_price: parseFloat(total),
        property_title: propertyTitle || 'Your selected property',
        guest_email: guestEmail || user.email,
        approved_at: fullBooking?.approved_at || null,
        payment_started_at: fullBooking?.payment_started_at || null,
      };

      dlog('✅ Booking data set:', bookingInfo);
      setBookingData(bookingInfo);

      // Stamp payment_started_at on first arrival (one-shot)
      if (fullBooking && !fullBooking.payment_started_at) {
        try {
          const nowIso = new Date().toISOString();
          await base44.entities.Booking.update(bookingId, { payment_started_at: nowIso });
          bookingInfo.payment_started_at = nowIso;
          dlog('✅ payment_started_at stamped:', nowIso);
        } catch (stampErr) {
          console.warn('Could not stamp payment_started_at:', stampErr);
        }
      }

      // Compute deadline: min(approved + 3hr, max(approved + 1hr, started + 1hr))
      if (bookingInfo.approved_at) {
        const HOUR = 60 * 60 * 1000;
        const approved = Date.parse(bookingInfo.approved_at);
        if (!Number.isNaN(approved)) {
          const started = Date.parse(bookingInfo.payment_started_at || '');
          const fromOpen = Number.isNaN(started) ? 0 : started + HOUR;
          const fromApproval = approved + HOUR;
          const cap = approved + 3 * HOUR;
          setDeadlineMs(Math.min(cap, Math.max(fromApproval, fromOpen)));
        }
      }

      // Pre-fill payment details
      setPaymentDetails({
        email: user.email,
        fullName: user.full_name || ''
      });
      
      dlog('=== BOOKING DATA LOADED SUCCESSFULLY ===');
      
    } catch (e) {
      console.error('=== ERROR LOADING BOOKING DATA ===', e);
      setError("Could not load payment information. Please restart the booking process.");
    }
    
    setIsPageLoading(false);
  };

  const validatePaymentDetails = () => {
    const errors = {};

    if (!paymentDetails.email || !/\S+@\S+\.\S+/.test(paymentDetails.email)) {
      errors.email = 'Valid email is required';
    }

    if (!paymentDetails.fullName || paymentDetails.fullName.trim().length < 3) {
      errors.fullName = 'Full name is required';
    }

    if (selectedMethod !== 'paystack') {
      errors.method = 'Please select a payment method';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handlePaymentSuccess = async (transactionRef, method) => {
    try {
      dlog('=== PROCESSING PAYMENT SUCCESS ===');
      dlog('Transaction Ref:', transactionRef);
      dlog('Method:', method);

      if (bookingData.id && !bookingData.id.startsWith('temp_')) {
        // Paystack is the only processor — server verifies the transaction
        // (authoritative), notifies admin, and triggers the referral reward.
        const result = await base44.functions.invoke('verifyPaystackPayment', {
          booking_id: bookingData.id,
          reference: transactionRef,
        });
        if (!result?.data?.success) {
          throw new Error(result?.data?.error || 'Payment verification failed');
        }
        dlog('✅ Payment verified server-side');
        // Award client-driven loyalty milestones (5% + first-booking + 3-in-month)
        try {
          await awardBookingMilestones({
            id: bookingData.id,
            total_price: bookingData.total_price,
          });
        } catch (e) {
          console.warn('Loyalty milestone award failed (non-fatal):', e);
        }
      }

      setPaymentComplete(true);
      // Note: no auto-redirect. The guest must upload their ID via
      // IdUploadGate first; gate's onComplete navigates to Bookings.
    } catch (error) {
      console.error('Error verifying payment:', error);
      alert(
        `Your payment has been received but we could not verify it automatically. ` +
        `Please contact support with reference: ${transactionRef}\n\nDetails: ${error.message || error}`
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePaystackPayment = async () => {
    try {
      dlog('=== INITIALIZING PAYSTACK ===');
      
      // Check if public key is loaded
      if (!paystackPublicKey) {
        throw new Error('Paystack payment system is not configured. Please contact support.');
      }

      // Load Paystack script if not already loaded
      if (!window.PaystackPop) {
        dlog('Loading Paystack script...');
        const script = document.createElement('script');
        script.src = 'https://js.paystack.co/v1/inline.js';
        script.async = true;
        document.body.appendChild(script);
        
        await new Promise((resolve, reject) => {
          script.onload = () => {
            dlog('✅ Paystack script loaded');
            resolve();
          };
          script.onerror = (err) => {
            console.error('❌ Failed to load Paystack script', err);
            reject(err);
          };
        });
      }

      // Verify PaystackPop is available
      if (!window.PaystackPop) {
        throw new Error('Paystack SDK failed to load');
      }

      dlog('Paystack SDK loaded, initializing payment...');

      const paymentReference = `LUX_${bookingData.id}_${Date.now()}`;
      
      // Define the callback function BEFORE creating the config
      const onPaymentSuccess = (response) => {
        dlog('✅ Paystack payment callback triggered:', response);
        handlePaymentSuccess(response.reference, 'paystack');
      };

      const onPaymentClose = () => {
        dlog('Paystack payment window closed by user');
        setIsProcessing(false);
      };

      // Create payment config with proper callback
      const config = {
        key: paystackPublicKey,
        email: paymentDetails.email,
        amount: Math.round(bookingData.total_price * 100),
        currency: 'NGN',
        ref: paymentReference,
        metadata: {
          booking_id: bookingData.id,
          property_title: bookingData.property_title,
          custom_fields: [
            {
              display_name: "Booking ID",
              variable_name: "booking_id",
              value: bookingData.id
            },
            {
              display_name: "Property",
              variable_name: "property_title",
              value: bookingData.property_title
            }
          ]
        },
        callback: onPaymentSuccess,
        onClose: onPaymentClose
      };

      dlog('Paystack config (key hidden for security):', {
        ...config,
        key: paystackPublicKey ? paystackPublicKey.substring(0, 10) + '...' : 'key not loaded'
      });

      // Initialize and open Paystack
      const handler = window.PaystackPop.setup(config);
      handler.openIframe();
      
      dlog('✅ Paystack iframe opened');

    } catch (error) {
      console.error('❌ Paystack error:', error);
      alert(`Failed to initialize Paystack: ${error.message}. Please try again.`);
      setIsProcessing(false);
    }
  };

  const handlePayment = async () => {
    dlog('=== PAYMENT BUTTON CLICKED ===');

    if (!validatePaymentDetails()) {
      dlog('❌ Validation failed', validationErrors);
      return;
    }

    dlog('✅ Validation passed, processing payment...');
    setIsProcessing(true);

    try {
      await handlePaystackPayment();
    } catch (error) {
      console.error('❌ Payment error:', error);
      // handlePaystackPayment displays its own alerts + resets isProcessing.
      // This catch is only for unexpected errors not handled inside that path.
      alert(`An unexpected error occurred during payment initiation: ${error.message}. Please try again.`);
      setIsProcessing(false);
    }
  };

  // PREVENT ANY AUTOMATIC REDIRECTS
  useEffect(() => {
    dlog('Current state:', { isPageLoading, error, bookingData, paymentComplete });
  }, [isPageLoading, error, bookingData, paymentComplete]);

  if (isPageLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 text-center bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm max-w-md w-full">
          <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-slate-600 dark:text-slate-300 font-medium">Loading payment details...</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">Please wait, do not refresh the page</p>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm">
          <CardContent className="p-8 text-center">
            <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Payment Error</h2>
            <p className="text-slate-600 dark:text-slate-300 mb-6">{error}</p>
            <div className="space-y-3">
              <Button 
                onClick={() => navigate(createPageUrl('Search'))}
                className="w-full bg-gradient-to-r from-slate-900 to-slate-800"
              >
                Start New Booking
              </Button>
              <Button 
                variant="outline"
                onClick={() => navigate(createPageUrl('Bookings'))}
                className="w-full"
              >
                View My Bookings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!bookingData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 text-center bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm max-w-md w-full">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <p className="text-slate-600 dark:text-slate-300 font-medium">No booking data found</p>
          <Button 
            onClick={() => navigate(createPageUrl('Search'))}
            className="mt-4"
          >
            Return to Search
          </Button>
        </Card>
      </div>
    );
  }

  if (paymentComplete) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4 flex items-start justify-center pt-12">
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-md space-y-4"
        >
          <Card className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm">
            <CardContent className="p-6 text-center">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">Payment Successful</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">Booking ID: {bookingData.id}</p>
            </CardContent>
          </Card>

          <IdUploadGate
            bookingId={bookingData.id}
            onComplete={() => navigate(createPageUrl('Bookings'))}
          />
        </motion.div>
      </div>
    );
  }

  // PaymentMethodCard removed — payment-method picker collapsed since
  // Paystack is the only processor.

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 py-6 sm:py-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <Button
            variant="ghost"
            onClick={() => {
              dlog('Back button clicked');
              navigate(-1);
            }}
            className="mb-4 hover:bg-white/50 dark:bg-slate-900/50"
            disabled={isProcessing}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div className="text-center">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-2">Secure Checkout</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">Complete your booking payment</p>
          </div>
        </div>

        {/* Payment timer */}
        {msLeft != null && !paymentComplete && (
          <div
            className={`mb-6 rounded-2xl border px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-sm ${
              msLeft < 5 * 60 * 1000
                ? 'bg-red-50 border-red-200 text-red-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Clock className="w-5 h-5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold text-sm sm:text-base">
                  {msLeft > 0 ? 'Complete payment within' : 'Payment window expired'}
                </p>
                <p className="text-xs sm:text-sm opacity-80">
                  Booking will be auto-cancelled if not paid in time.
                </p>
              </div>
            </div>
            <div className="font-mono text-xl sm:text-2xl font-bold tabular-nums self-end sm:self-auto">
              {formatRemaining(msLeft)}
            </div>
          </div>
        )}

        {/* Booking Summary — rows stack on mobile so long property titles,
            emails, and booking IDs don't horizontal-scroll the page. */}
        <Card className="mb-6 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 shadow-lg">
          <CardContent className="p-4 sm:p-6">
            <div className="bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 rounded-2xl p-4 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white mb-4">Booking Summary</h3>
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                  <span className="text-slate-600 dark:text-slate-300 text-sm">Property:</span>
                  <span className="font-semibold text-slate-900 dark:text-white sm:text-right break-words min-w-0">{bookingData.property_title}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                  <span className="text-slate-600 dark:text-slate-300 text-sm">Guest Email:</span>
                  <span className="font-medium text-slate-700 dark:text-slate-200 sm:text-right break-all min-w-0">{bookingData.guest_email}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                  <span className="text-slate-600 dark:text-slate-300 text-sm">Booking ID:</span>
                  <span className="font-mono text-xs sm:text-sm text-slate-600 dark:text-slate-300 sm:text-right break-all min-w-0">{bookingData.id}</span>
                </div>
                <hr className="border-slate-200 dark:border-slate-800" />
                <div className="flex justify-between items-baseline gap-3 pt-2">
                  <span className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">Total:</span>
                  <span className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white text-right break-words">
                    ₦{bookingData.total_price.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment Details Form */}
        <Card className="mb-6 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 shadow-lg">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <User className="w-5 h-5" />
              Payment Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="email" className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Email Address *
              </Label>
              <div className="relative mt-2">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 dark:text-slate-500 w-4 h-4" />
                <Input
                  id="email"
                  type="email"
                  value={paymentDetails.email}
                  onChange={(e) => setPaymentDetails(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="your@email.com"
                  className="pl-10 rounded-xl"
                  disabled={isProcessing}
                />
              </div>
              {validationErrors.email && (
                <p className="text-xs text-red-600 mt-1">{validationErrors.email}</p>
              )}
            </div>

            <div>
              <Label htmlFor="fullName" className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Full Name *
              </Label>
              <Input
                id="fullName"
                type="text"
                value={paymentDetails.fullName}
                onChange={(e) => setPaymentDetails(prev => ({ ...prev, fullName: e.target.value }))}
                placeholder="John Doe"
                className="mt-2 rounded-xl"
                disabled={isProcessing}
              />
              {validationErrors.fullName && (
                <p className="text-xs text-red-600 mt-1">{validationErrors.fullName}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Payment Method — Paystack only. No selector since there's only one
            processor; surface the Paystack badge so the guest still recognises
            who they're paying through, then go straight to the pay button. */}
        <Card className="mb-6 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 shadow-lg">
          <CardContent className="p-6 space-y-5">
            <div className="flex items-center justify-between gap-4 rounded-2xl border-2 border-slate-900 bg-slate-50 p-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex-shrink-0">
                  <PaystackLogo />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">Pay with Paystack</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Card, bank transfer, USSD or mobile money</p>
                </div>
              </div>
              <Badge className="bg-green-100 text-green-800 border-green-200 flex-shrink-0">
                <ShieldCheck className="w-3 h-3 mr-1" />
                Secured
              </Badge>
            </div>

            <Button
              onClick={handlePayment}
              disabled={isProcessing}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold py-6 rounded-xl text-lg shadow-lg transition-all duration-300 hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <CreditCard className="w-5 h-5 mr-2" />
                  Pay ₦{bookingData.total_price.toLocaleString()} with Paystack
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Security & Trust */}
        <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 shadow-lg">
          <CardContent className="p-6">
            <div className="flex items-center justify-center space-x-2 text-slate-600 dark:text-slate-300 mb-4">
              <Lock className="w-5 h-5 text-green-600" />
              <span className="font-semibold">Your payment is encrypted & secure</span>
            </div>
            
            <div className="flex items-center justify-center space-x-8 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-green-600" />
                <span>256-bit SSL</span>
              </div>
              <div className="flex items-center space-x-2">
                <Lock className="w-4 h-4 text-green-600" />
                <span>PCI Compliant</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span>Secure Payment</span>
              </div>
            </div>

            <p className="text-center text-xs text-slate-500 dark:text-slate-400 mt-4">
              Payments are processed securely through Paystack
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
