
import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, ShieldCheck, CreditCard, Loader2, CheckCircle, AlertTriangle, ArrowLeft, Mail, User } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';

// Payment provider logos
const PaystackLogo = () => (
  <svg width="100" height="28" viewBox="0 0 200 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="60" rx="8" fill="#00C3F7"/>
    <text x="100" y="38" fontFamily="Arial, sans-serif" fontSize="24" fontWeight="bold" fill="white" textAnchor="middle">
      Paystack
    </text>
  </svg>
);

const StripeLogo = () => (
  <img 
    src="https://www.vectorlogo.zone/logos/stripe/stripe-ar21.svg" 
    alt="Stripe" 
    className="h-10 w-auto"
  />
);

export default function PaymentPage() {
  const [selectedMethod, setSelectedMethod] = useState(null);
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

  useEffect(() => {
    console.log('=== PAYMENT PAGE MOUNTED ===');
    console.log('URL Search Params:', window.location.search);
    console.log('booking_id:', searchParams.get('booking_id'));
    console.log('total:', searchParams.get('total'));
    console.log('property_title:', searchParams.get('property_title'));
    console.log('guest_email:', searchParams.get('guest_email'));
    
    loadBookingAndUserData();
    loadPaystackKey();
  }, []);

  const loadPaystackKey = async () => {
    try {
      const response = await base44.functions.invoke('getPaystackPublicKey');
      if (response.data && response.data.publicKey) {
        setPaystackPublicKey(response.data.publicKey);
        console.log('✅ Paystack public key loaded');
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
    console.log('=== LOADING BOOKING DATA ===');
    setIsPageLoading(true);
    setError(null);
    
    try {
      // Get URL parameters
      const bookingId = searchParams.get('booking_id');
      const total = searchParams.get('total');
      const propertyTitle = searchParams.get('property_title');
      const guestEmail = searchParams.get('guest_email');

      console.log('Extracted params:', { bookingId, total, propertyTitle, guestEmail });

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
        console.log('User loaded:', user.email);
      } catch (userError) {
        console.error('Failed to load user:', userError);
        setError("Please log in to continue with payment.");
        setIsPageLoading(false);
        return;
      }

      // Set booking data
      const bookingInfo = {
        id: bookingId,
        total_price: parseFloat(total),
        property_title: propertyTitle || 'Your selected property',
        guest_email: guestEmail || user.email,
      };

      console.log('✅ Booking data set:', bookingInfo);
      setBookingData(bookingInfo);

      // Pre-fill payment details
      setPaymentDetails({
        email: user.email,
        fullName: user.full_name || ''
      });
      
      console.log('=== BOOKING DATA LOADED SUCCESSFULLY ===');
      
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

    if (!selectedMethod || !['paystack', 'stripe'].includes(selectedMethod)) {
      errors.method = 'Please select a payment method';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handlePaymentSuccess = async (transactionRef, method) => {
    try {
      console.log('=== PROCESSING PAYMENT SUCCESS ===');
      console.log('Transaction Ref:', transactionRef);
      console.log('Method:', method);
      
      // Update booking status
      if (bookingData.id && !bookingData.id.startsWith('temp_')) {
        await base44.entities.Booking.update(bookingData.id, {
          payment_status: 'paid',
          status: 'confirmed',
          payment_method: method,
          transaction_hash: transactionRef
        });
        console.log('✅ Booking updated successfully');
      }

      setPaymentComplete(true);
      
      // Redirect after 3 seconds
      setTimeout(() => {
        console.log('Redirecting to bookings page...');
        navigate(createPageUrl('Bookings'));
      }, 3000);
      
    } catch (error) {
      console.error('Error updating booking:', error);
      alert('Payment successful but failed to update booking. Please contact support with reference: ' + transactionRef);
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePaystackPayment = async () => {
    try {
      console.log('=== INITIALIZING PAYSTACK ===');
      
      // Check if public key is loaded
      if (!paystackPublicKey) {
        throw new Error('Paystack payment system is not configured. Please contact support.');
      }

      // Load Paystack script if not already loaded
      if (!window.PaystackPop) {
        console.log('Loading Paystack script...');
        const script = document.createElement('script');
        script.src = 'https://js.paystack.co/v1/inline.js';
        script.async = true;
        document.body.appendChild(script);
        
        await new Promise((resolve, reject) => {
          script.onload = () => {
            console.log('✅ Paystack script loaded');
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

      console.log('Paystack SDK loaded, initializing payment...');

      const paymentReference = `LUX_${bookingData.id}_${Date.now()}`;
      
      // Define the callback function BEFORE creating the config
      const onPaymentSuccess = (response) => {
        console.log('✅ Paystack payment callback triggered:', response);
        handlePaymentSuccess(response.reference, 'paystack');
      };

      const onPaymentClose = () => {
        console.log('Paystack payment window closed by user');
        setIsProcessing(false);
      };

      // Create payment config with proper callback
      const config = {
        key: paystackPublicKey,
        email: paymentDetails.email,
        amount: Math.round(bookingData.total_price * 100),
        currency: 'USD',
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

      console.log('Paystack config (key hidden for security):', {
        ...config,
        key: paystackPublicKey ? paystackPublicKey.substring(0, 10) + '...' : 'key not loaded'
      });

      // Initialize and open Paystack
      const handler = window.PaystackPop.setup(config);
      handler.openIframe();
      
      console.log('✅ Paystack iframe opened');

    } catch (error) {
      console.error('❌ Paystack error:', error);
      alert(`Failed to initialize Paystack: ${error.message}. Please try again or use Stripe.`);
      setIsProcessing(false);
    }
  };

  const handleStripePayment = async () => {
    try {
      console.log('=== INITIALIZING STRIPE ===');
      
      // Load Stripe script if not already loaded
      if (!window.Stripe) {
        const script = document.createElement('script');
        script.src = 'https://js.stripe.com/v3/';
        script.async = true;
        document.body.appendChild(script);
        
        // FIX: Ensure 'reject' is defined in the Promise constructor
        await new Promise((resolve, reject) => {
          script.onload = () => {
            console.log('✅ Stripe script loaded');
            resolve();
          };
          script.onerror = (err) => {
            console.error('❌ Failed to load Stripe script', err);
            reject(err);
          };
        });
      }

      // const stripe = window.Stripe('pk_test_your_stripe_public_key'); // TODO: Replace with actual key

      // For demo purposes, simulate successful payment after a delay
      console.log('Simulating Stripe payment...');
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const simulatedReference = `stripe_sim_${Date.now()}`;
      console.log('✅ Simulated Stripe payment successful');
      
      await handlePaymentSuccess(simulatedReference, 'stripe');
      
    } catch (error) {
      console.error('❌ Stripe error:', error);
      alert(`Failed to process Stripe payment: ${error.message}. Please try again or use Paystack.`);
      setIsProcessing(false);
    }
  };

  const handlePayment = async () => {
    console.log('=== PAYMENT BUTTON CLICKED ===');
    
    if (!validatePaymentDetails()) {
      console.log('❌ Validation failed', validationErrors);
      return;
    }

    console.log('✅ Validation passed, processing payment...');
    setIsProcessing(true);
    
    try {
      if (selectedMethod === 'paystack') {
        await handlePaystackPayment();
      } else if (selectedMethod === 'stripe') {
        await handleStripePayment();
      }
    } catch (error) {
      console.error('❌ Payment error:', error);
      // The individual payment handlers (Paystack/Stripe) should already display alerts and set isProcessing(false)
      // This catch block is mostly for unexpected errors not handled within those functions.
      alert(`An unexpected error occurred during payment initiation: ${error.message}. Please try again.`);
      setIsProcessing(false); 
    }
  };

  // PREVENT ANY AUTOMATIC REDIRECTS
  useEffect(() => {
    console.log('Current state:', { isPageLoading, error, bookingData, paymentComplete });
  }, [isPageLoading, error, bookingData, paymentComplete]);

  if (isPageLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <Card className="p-8 text-center bg-white/90 backdrop-blur-sm max-w-md w-full">
          <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-slate-600 font-medium">Loading payment details...</p>
          <p className="text-xs text-slate-400 mt-2">Please wait, do not refresh the page</p>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-white/90 backdrop-blur-sm">
          <CardContent className="p-8 text-center">
            <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Payment Error</h2>
            <p className="text-slate-600 mb-6">{error}</p>
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
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <Card className="p-8 text-center bg-white/90 backdrop-blur-sm max-w-md w-full">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <p className="text-slate-600 font-medium">No booking data found</p>
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
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <Card className="max-w-md w-full bg-white/90 backdrop-blur-sm">
            <CardContent className="p-12 text-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring" }}
              >
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                  <CheckCircle className="w-12 h-12 text-green-600" />
                </div>
              </motion.div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Payment Successful!</h2>
              <p className="text-slate-600 mb-2">Your booking has been confirmed.</p>
              <p className="text-sm text-slate-500 mb-6">
                Booking ID: {bookingData.id}
              </p>
              <div className="space-y-3">
                <p className="text-sm text-slate-600">Redirecting to your bookings...</p>
                <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  const PaymentMethodCard = ({ id, logo, name, recommended }) => (
    <div
      onClick={() => setSelectedMethod(id)}
      className={`relative p-6 border-2 rounded-2xl cursor-pointer transition-all duration-300 transform hover:scale-102 ${
        selectedMethod === id
          ? 'border-blue-500 bg-blue-50 shadow-xl ring-4 ring-blue-500/20'
          : 'border-slate-200 hover:border-slate-300 bg-white hover:shadow-lg'
      }`}
    >
      {recommended && (
        <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
          <span className="bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg">
            RECOMMENDED
          </span>
        </div>
      )}
      
      {selectedMethod === id && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="absolute -top-2 -right-2"
        >
          <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center shadow-lg">
            <CheckCircle className="w-5 h-5 text-white" />
          </div>
        </motion.div>
      )}
      
      <div className="flex flex-col items-center space-y-4">
        <div className="flex items-center justify-center h-16">
          {logo}
        </div>
        <span className="font-semibold text-slate-800">{name}</span>
        <p className="text-xs text-slate-500 text-center">
          {id === 'paystack' ? 'Pay with cards, bank transfer, or USSD' : 'Pay with credit/debit cards'}
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 py-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Button
            variant="ghost"
            onClick={() => {
              console.log('Back button clicked');
              navigate(-1);
            }}
            className="mb-4 hover:bg-white/50"
            disabled={isProcessing}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div className="text-center">
            <h1 className="text-4xl font-bold text-slate-900 mb-2">Secure Checkout</h1>
            <p className="text-slate-600">Complete your booking payment</p>
          </div>
        </div>

        {/* Booking Summary */}
        <Card className="mb-6 bg-white/90 backdrop-blur-sm border-slate-200 shadow-lg">
          <CardContent className="p-6">
            <div className="bg-gradient-to-br from-slate-50 to-blue-50 rounded-2xl p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Booking Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Property:</span>
                  <span className="font-semibold text-slate-900">{bookingData.property_title}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Guest Email:</span>
                  <span className="font-medium text-slate-700">{bookingData.guest_email}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Booking ID:</span>
                  <span className="font-mono text-sm text-slate-600">{bookingData.id}</span>
                </div>
                <hr className="border-slate-200" />
                <div className="flex justify-between items-center pt-2">
                  <span className="text-lg font-bold text-slate-900">Total Amount:</span>
                  <span className="text-2xl font-bold text-slate-900">
                    ${bookingData.total_price.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment Details Form */}
        <Card className="mb-6 bg-white/90 backdrop-blur-sm border-slate-200 shadow-lg">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <User className="w-5 h-5" />
              Payment Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="email" className="text-sm font-semibold text-slate-700">
                Email Address *
              </Label>
              <div className="relative mt-2">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
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
              <Label htmlFor="fullName" className="text-sm font-semibold text-slate-700">
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

        {/* Payment Methods */}
        <Card className="mb-6 bg-white/90 backdrop-blur-sm border-slate-200 shadow-lg">
          <CardHeader className="text-center pb-4">
            <CardTitle className="text-xl">Select Payment Method</CardTitle>
            <p className="text-sm text-slate-600 mt-2">Choose how you'd like to pay</p>
          </CardHeader>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <PaymentMethodCard 
                id="paystack" 
                logo={<PaystackLogo />} 
                name="Paystack" 
                recommended={true}
              />
              <PaymentMethodCard 
                id="stripe" 
                logo={<StripeLogo />} 
                name="Stripe" 
              />
            </div>

            {validationErrors.method && (
              <p className="text-sm text-red-600 text-center mb-4">{validationErrors.method}</p>
            )}

            <AnimatePresence>
              {selectedMethod && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                >
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
                        Pay ${bookingData.total_price.toLocaleString()} with {selectedMethod === 'paystack' ? 'Paystack' : 'Stripe'}
                      </>
                    )}
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>

        {/* Security & Trust */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 shadow-lg">
          <CardContent className="p-6">
            <div className="flex items-center justify-center space-x-2 text-slate-600 mb-4">
              <Lock className="w-5 h-5 text-green-600" />
              <span className="font-semibold">Your payment is encrypted & secure</span>
            </div>
            
            <div className="flex items-center justify-center space-x-8 text-xs text-slate-500">
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

            <p className="text-center text-xs text-slate-500 mt-4">
              Payments are processed securely through {selectedMethod === 'paystack' ? 'Paystack' : selectedMethod === 'stripe' ? 'Stripe' : 'our payment partners'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
