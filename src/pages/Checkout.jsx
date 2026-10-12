import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar, MapPin, Users, ArrowLeft, CheckCircle, Loader2, Clock, AlertCircle, Shield, Phone } from 'lucide-react';
import { format, differenceInCalendarDays, parseISO, addDays } from 'date-fns';
import { bookingOptionsOf, priceStay } from '@/config/stays';
import { invokeFn } from '@/lib/invokeFn';
import { createPageUrl } from '@/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

// A YYYY-MM-DD string as that calendar day in the browser's own timezone.
// new Date('2026-12-13') is midnight UTC, which is still the 12th anywhere
// west of Greenwich: the date a guest picked slid back a day and the request
// went out for the wrong nights.
function dayOf(value) {
  const day = parseISO(String(value || '').slice(0, 10));
  return Number.isNaN(day.getTime()) ? null : day;
}

// The option a bedroom count names. When it names none: the smallest that
// takes a party of `guests`, else the smallest.
function chosenOption(property, bedrooms, guests) {
  const options = bookingOptionsOf(property);
  const party = Math.round(Number(guests)) || 0;
  return options.find((o) => o.bedrooms === bedrooms)
    || options.find((o) => !(party > 0 && o.max_guests > 0 && o.max_guests < party))
    || options[0]
    || null;
}

export default function CheckoutPage() {
  const location = useLocation();
  const navigate = useNavigate();
  
  // Core state
  const [property, setProperty] = useState(null);
  const [user, setUser] = useState(null);
  const [existingBooking, setExistingBooking] = useState(null);
  const [bookingDetails, setBookingDetails] = useState({
    checkIn: null,
    checkOut: null,
    guests: 2,
    specialRequests: ''
  });
  // The booking option the guest wants, as a bedroom count. 0 = the smallest.
  const [bedrooms, setBedrooms] = useState(0);
  const [totalPrice, setTotalPrice] = useState(0);
  const [nights, setNights] = useState(0);
  // Presentational only. The server prices from the Property row and the
  // request never carries a total — see src/config/stays.js.
  const [breakdown, setBreakdown] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // Phone number modal state
  const [showPhoneNumberModal, setShowPhoneNumberModal] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isSavingPhone, setIsSavingPhone] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  
  // Availability check state
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);
  const [availabilityStatus, setAvailabilityStatus] = useState('unknown');
  const [availabilityRequestId, setAvailabilityRequestId] = useState(null);
  const [availabilityError, setAvailabilityError] = useState(null);
  const [adminResponse, setAdminResponse] = useState('');
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);
  const [createdBookingId, setCreatedBookingId] = useState(null);
  // The approval poll has failed three times running (see the poll below).
  const [pollStalled, setPollStalled] = useState(false);

  const handleSavePhoneNumber = async () => {
    setPhoneError('');
    
    if (!phoneNumber || phoneNumber.trim().length < 10) {
      setPhoneError('Please enter a valid phone number (at least 10 digits)');
      return;
    }
    
    setIsSavingPhone(true);
    try {
      await base44.auth.updateMe({ phone_number: phoneNumber.trim() });
      setUser(prev => ({ ...prev, phone_number: phoneNumber.trim() }));
      setShowPhoneNumberModal(false);
      console.log('✅ Phone number saved successfully');
    } catch (error) {
      console.error('❌ Error saving phone number:', error);
      setPhoneError('Failed to save phone number. Please try again.');
    }
    setIsSavingPhone(false);
  };

  // Once admin has approved availability, route the user to the real
  // PaymentPage (Paystack init + server-side verify). No client-side fake-pay.
  const handleProceedToPayment = () => {
    const bookingId = existingBooking?.id || createdBookingId;
    if (!bookingId) {
      alert('Booking is still being prepared. Please wait a moment and try again.');
      return;
    }
    if (availabilityStatus !== 'available') {
      alert('This booking is still awaiting admin approval.');
      return;
    }
    const params = new URLSearchParams({
      booking_id: bookingId,
      total: String(totalPrice),
      property_title: property?.title || '',
      guest_email: user?.email || '',
    }).toString();
    navigate(`${createPageUrl('PaymentPage')}?${params}`);
  };

  const handleCheckAvailability = async () => {
    if (!user?.phone_number) {
      setShowPhoneNumberModal(true);
      return;
    }

    if (!bookingDetails.checkIn || !bookingDetails.checkOut) {
      alert('Please select both check-in and check-out dates.');
      return;
    }
    
    if (new Date(bookingDetails.checkOut) <= new Date(bookingDetails.checkIn)) {
      alert('Check-out date must be after the check-in date.');
      return;
    }

    console.log('═══════════════════════════════════════');
    console.log('🚀 STARTING AVAILABILITY CHECK PROCESS');
    console.log('═══════════════════════════════════════');

    setIsCheckingAvailability(true);
    setAvailabilityStatus('unknown');
    setAvailabilityRequestId(null);
    setAvailabilityError(null);
    setAdminResponse('');
    setShowSuccessMessage(false);

    try {
      // One backend call handles: conflict detection, AvailabilityRequest creation,
      // pending Booking creation, and admin Telegram notification.
      const result = await invokeFn('checkAvailabilityWebhook', {
        property_id: property.id,
        property_title: property.title,
        property_location: property.location,
        check_in: format(bookingDetails.checkIn, 'yyyy-MM-dd'),
        check_out: format(bookingDetails.checkOut, 'yyyy-MM-dd'),
        guests: bookingDetails.guests,
        bedrooms: bookingOptionsOf(property).length > 1 ? chosenOption(property, bedrooms)?.bedrooms : undefined,
        special_requests: bookingDetails.specialRequests || '',
      });

      if (!result.ok) {
        // A refusal (4xx) carries a sentence written for the guest. If it is
        // about the option or the guest limit, the listing has changed since
        // this page loaded: fetch it again so the choices on screen are real.
        if (['OPTION_UNAVAILABLE', 'TOO_MANY_GUESTS'].includes(result.code)) {
          base44.entities.Property.get(property.id).then(setProperty).catch(() => {});
        }
        const refusal = new Error(result.error || 'Failed to submit availability check');
        refusal.refused = result.status >= 400 && result.status < 500;
        throw refusal;
      }

      const { request_id, booking_id, has_conflict } = result.data;
      // Show the figure the server actually stored, not this page's estimate.
      if (Number(result.data.total_price) > 0) setTotalPrice(Number(result.data.total_price));
      console.log('✅ Availability check submitted', { request_id, booking_id, has_conflict });

      setCreatedBookingId(booking_id);
      setAvailabilityRequestId(request_id);
      setAvailabilityStatus('pending');
      setShowSuccessMessage(true);
      setIsCheckingAvailability(false);

      if (has_conflict) {
        console.warn('⚠️ Conflict flagged — admin will review the overlap');
      }

      console.log('🎉 AVAILABILITY CHECK COMPLETED');

    } catch (error) {
      console.error('\n❌❌❌ CRITICAL ERROR IN AVAILABILITY CHECK ❌❌❌');
      console.error('Error:', error);
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
      console.error('═══════════════════════════════════════\n');
      
      setAvailabilityError(error.message);
      setAvailabilityStatus('unknown');
      setIsCheckingAvailability(false);
      setShowSuccessMessage(false);
      
      alert(error.refused ? error.message : `Error: ${error.message}\n\nPlease try again or contact support if the problem persists.`);
    }
  };

  useEffect(() => {
    loadCheckoutData();
  }, []);

  const loadCheckoutData = async () => {
    setIsLoading(true);
    try {
      const userData = await base44.auth.me();
      setUser(userData);
      
      if (userData.phone_number) {
        setPhoneNumber(userData.phone_number);
      }

      const params = new URLSearchParams(location.search);
      const bookingId = params.get('bookingId');
      const propertyId = params.get('property');
      const checkInStr = params.get('checkIn');
      const checkOutStr = params.get('checkOut');
      const guestsStr = params.get('guests');

      if (bookingId) {
        console.log('📋 Loading pre-approved booking:', bookingId);
        const booking = await base44.entities.Booking.get(bookingId);
        setExistingBooking(booking);

        const propertyData = await base44.entities.Property.get(booking.property_id);
        setProperty(propertyData);

        setBookingDetails({
          checkIn: dayOf(booking.check_in),
          checkOut: dayOf(booking.check_out),
          guests: booking.guests,
          specialRequests: booking.special_requests || ''
        });
        // A booking made before the listing had options named none; the
        // server priced it as the whole place, which is the largest option.
        const offered = bookingOptionsOf(propertyData);
        setBedrooms(Number(booking.bedrooms_booked) || (offered.length > 1 ? offered[offered.length - 1].bedrooms : 0));

        setAvailabilityStatus('available');
        setAdminResponse('Your booking has been approved by admin. Complete payment to confirm.');
      } else {
        if (!propertyId) {
          navigate(createPageUrl('Search'));
          return;
        }

        const propertyData = await base44.entities.Property.get(propertyId);
        setProperty(propertyData);

        const checkIn = dayOf(checkInStr);
        const checkOut = dayOf(checkOutStr);
        // A party size in the link picks the smallest option that takes it.
        // The guest's own number is never changed for them: if it is too many
        // for the option on screen, the page says so and waits.
        const asked = guestsStr ? parseInt(guestsStr) || 0 : 0;
        const wanted = chosenOption(propertyData, Number(params.get('bedrooms')) || 0, asked);
        setBedrooms(wanted ? wanted.bedrooms : 0);
        const guests = asked || (wanted && wanted.max_guests > 0 ? Math.min(2, wanted.max_guests) : 2);

        setBookingDetails({
          checkIn,
          checkOut,
          specialRequests: '',
          guests
        });
      }

    } catch (error) {
      console.error('Error loading checkout data:', error);
      alert('Error loading checkout data. Please try again.');
      navigate(createPageUrl('Search'));
    }
    setIsLoading(false);
  };

  useEffect(() => {
    if (!availabilityRequestId || existingBooking) {
      return;
    }

    console.log(`🔄 Starting polling for request: ${availabilityRequestId}`);
    let stopped = false;
    // Failed polls in a row. One is a blip. Three and this page has lost sight
    // of the request, and the guest is told so rather than left on "pending".
    let failures = 0;

    const pollInterval = setInterval(async () => {
      if (stopped) return;
      try {
        const request = await base44.entities.AvailabilityRequest.get(availabilityRequestId);
        failures = 0;
        setPollStalled(false);

        if (request.status === 'approved') {
          console.log('✅ APPROVED');
          stopped = true;
          clearInterval(pollInterval);
          setAvailabilityStatus('available');
          setAdminResponse(request.admin_response || 'Property is available for your dates!');
          setIsCheckingAvailability(false);
        } else if (request.status === 'rejected') {
          console.log('❌ REJECTED');
          stopped = true;
          clearInterval(pollInterval);
          setAvailabilityStatus('unavailable');
          setAdminResponse(request.admin_response || 'Property is not available for these dates.');
          setIsCheckingAvailability(false);
        }
      } catch (error) {
        console.error('❌ Polling error:', error);
        failures += 1;
        if (failures >= 3 && !stopped) setPollStalled(true);
      }
    }, 3000);

    return () => {
      stopped = true;
      clearInterval(pollInterval);
      setPollStalled(false);
    };
  }, [availabilityRequestId, existingBooking]);

  useEffect(() => {
    if (bookingDetails.checkIn && bookingDetails.checkOut) {
      // Calendar days, so a clock change inside the stay does not lose a night.
      const nightCount = differenceInCalendarDays(bookingDetails.checkOut, bookingDetails.checkIn);
      setNights(nightCount);
      
      const option = chosenOption(property, bedrooms);
      const est = nightCount > 0 && property && option
        ? priceStay(property, format(bookingDetails.checkIn, 'yyyy-MM-dd'), format(bookingDetails.checkOut, 'yyyy-MM-dd'), option.bedrooms)
        : null;
      setBreakdown(est);
      // An approved booking is charged what the server stored for it.
      setTotalPrice(Number(existingBooking?.total_price) > 0 ? Number(existingBooking.total_price) : est ? est.total : 0);
      
      if (!existingBooking) {
        setAvailabilityStatus('unknown');
        setAvailabilityError(null);
        setAdminResponse('');
      }
    } else {
      setNights(0);
      setTotalPrice(0);
      if (!existingBooking) {
        setAvailabilityStatus('unknown');
        setAvailabilityError(null);
        setAdminResponse('');
      }
    }
  }, [bookingDetails.checkIn, bookingDetails.checkOut, property, existingBooking, bedrooms]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent dark:border-white"></div>
      </div>
    );
  }

  if (!property) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <Card className="p-12 text-center">
          <p className="text-lg text-slate-600 dark:text-slate-300">Property not found.</p>
          <Button className="mt-4" onClick={() => navigate(-1)}>Go Back</Button>
        </Card>
      </div>
    );
  }

  const options = bookingOptionsOf(property);
  const option = chosenOption(property, bedrooms);
  const guestLimit = option ? option.max_guests : 0;
  // Once a request is with the admin, or approved, what was asked for is
  // fixed: changing a field here would only throw the answer away.
  const formLocked = isCheckingAvailability || availabilityStatus === 'pending' || availabilityStatus === 'available' || !!existingBooking;
  // The total on screen is the server's once there is one. If the listing's
  // prices have changed since, today's night-by-night lines no longer add up
  // to it, so they are left out rather than shown beside a different total.
  const linesAddUp = !breakdown || breakdown.total === totalPrice;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <Dialog open={showPhoneNumberModal} onOpenChange={setShowPhoneNumberModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              Phone Number Required
            </DialogTitle>
            <DialogDescription>
              Please provide your phone number to proceed with the booking. This is essential for booking confirmations and property communication.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="phone-modal">Phone Number *</Label>
              <Input
                id="phone-modal"
                type="tel"
                value={phoneNumber}
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  setPhoneError('');
                }}
                placeholder="+234 800 000 0000"
                className="mt-1"
                disabled={isSavingPhone}
              />
              {phoneError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-1">{phoneError}</p>
              )}
            </div>
            
            <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg p-3">
              <p className="text-xs text-amber-900 dark:text-amber-100">
                <strong>📞 Important:</strong> Your phone number will be shared with the property owner for booking coordination and logged in our booking records.
              </p>
            </div>
          </div>
          
          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => setShowPhoneNumberModal(false)}
              disabled={isSavingPhone}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSavePhoneNumber}
              disabled={isSavingPhone || !phoneNumber}
              className="bg-gradient-to-r from-slate-900 to-slate-800"
            >
              {isSavingPhone ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save & Continue'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Booking confirmation modal — full-screen backdrop, centered card,
          impossible to miss on any device. Replaces the earlier top-anchored
          toast that mobile users were missing or scrolling past. */}
      <AnimatePresence>
        {showSuccessMessage && availabilityStatus === 'pending' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={() => setShowSuccessMessage(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl shadow-2xl overflow-hidden"
              role="dialog"
              aria-modal="true"
              aria-labelledby="booking-submitted-title"
            >
              {/* Green hero — big checkmark so the success is unmistakable */}
              <div className="bg-gradient-to-br from-green-500 to-emerald-600 px-6 pt-8 pb-6 text-center">
                {/* Frosted circle sits on the green gradient above, so plain
                    white/20 is correct in both themes — no dark variant. */}
                <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <CheckCircle className="w-9 h-9 text-white" strokeWidth={2.5} />
                </div>
                <h2 id="booking-submitted-title" className="text-2xl font-bold text-white">
                  Booking submitted
                </h2>
                <p className="text-green-50 text-sm mt-1.5">
                  Awaiting admin approval
                </p>
              </div>

              {/* Body — what happens next */}
              <div className="px-6 py-6">
                <ol className="space-y-3 mb-6">
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
                    <p className="text-sm text-slate-700 dark:text-slate-200">Admin reviews your request — usually within minutes.</p>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
                    <p className="text-sm text-slate-700 dark:text-slate-200">Once approved, complete payment to confirm.</p>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
                    <p className="text-sm text-slate-700 dark:text-slate-200">Track everything from <strong>My Bookings</strong>.</p>
                  </li>
                </ol>

                <div className="flex flex-col gap-2.5">
                  <Button
                    onClick={() => navigate(createPageUrl('Bookings'))}
                    className="w-full h-12 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-base dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                  >
                    Check my bookings
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowSuccessMessage(false)}
                    className="w-full h-12 rounded-xl text-base"
                  >
                    Stay here
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-7xl mx-auto">
        <AnimatePresence>
          {availabilityStatus === 'available' && adminResponse && (
            <motion.div
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-green-500 text-white p-4 rounded-2xl shadow-2xl"
            >
              <div className="flex items-center gap-3">
                <CheckCircle className="w-6 h-6 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-bold mb-1">✅ Approved!</p>
                  <p className="text-sm">{adminResponse}</p>
                </div>
              </div>
            </motion.div>
          )}
          
          {availabilityStatus === 'unavailable' && adminResponse && (
            <motion.div
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-red-500 text-white p-4 rounded-2xl shadow-2xl"
            >
              <div className="flex items-center gap-3">
                <AlertCircle className="w-6 h-6 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-bold mb-1">❌ Not Available</p>
                  <p className="text-sm">{adminResponse}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4 mb-8">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate(-1)}
            className="rounded-full"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white break-words">Complete Your Booking</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">You're just steps away from your perfect stay.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
          <div className="space-y-6">
            <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg overflow-hidden">
              <img
                src={property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800'}
                alt={property.title}
                className="w-full h-64 object-cover"
              />
              <CardContent className="p-6">
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">{property.title}</h2>
                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 mb-4">
                  <MapPin className="w-4 h-4" />
                  <span>{property.location?.city}, {property.location?.country}</span>
                </div>
                <p className="text-slate-700 dark:text-slate-200">{property.description}</p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
              <CardHeader>
                <CardTitle>Booking Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Check-in Date</Label>
                    <Input
                      type="date"
                      value={bookingDetails.checkIn ? format(bookingDetails.checkIn, 'yyyy-MM-dd') : ''}
                      onChange={(e) => {
                        setBookingDetails(prev => ({ ...prev, checkIn: dayOf(e.target.value) }));
                      }}
                      min={format(new Date(), 'yyyy-MM-dd')}
                      className="mt-1"
                      disabled={formLocked}
                    />
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Check-in from 2:00 PM</p>
                  </div>
                  <div>
                    <Label>Check-out Date</Label>
                    <Input
                      type="date"
                      value={bookingDetails.checkOut ? format(bookingDetails.checkOut, 'yyyy-MM-dd') : ''}
                      onChange={(e) => {
                        setBookingDetails(prev => ({ ...prev, checkOut: dayOf(e.target.value) }));
                      }}
                      min={format(bookingDetails.checkIn ? addDays(bookingDetails.checkIn, 1) : new Date(), 'yyyy-MM-dd')}
                      className="mt-1"
                      disabled={formLocked}
                    />
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Check-out by 12:00 PM</p>
                  </div>
                </div>

                {options.length > 1 && (
                  <fieldset disabled={formLocked}>
                    <legend className="text-sm font-medium leading-none">How many bedrooms do you want?</legend>
                    <div className="mt-2 space-y-2">
                      {options.map((o) => (
                        <label
                          key={o.bedrooms}
                          className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${formLocked ? 'opacity-70' : 'cursor-pointer'} ${option?.bedrooms === o.bedrooms ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'border-slate-200 dark:border-slate-700'}`}
                        >
                          <input
                            type="radio"
                            name="booking_option"
                            checked={option?.bedrooms === o.bedrooms}
                            onChange={() => setBedrooms(o.bedrooms)}
                          />
                          <span className="flex-1 text-sm text-slate-800 dark:text-slate-100">
                            {o.bedrooms} bedroom{o.bedrooms > 1 ? 's' : ''}
                            {o.max_guests > 0 && <span className="block text-xs text-slate-500 dark:text-slate-400">Up to {o.max_guests} guests</span>}
                          </span>
                          <span className="text-sm font-semibold text-slate-900 dark:text-white">₦{o.price_per_night.toLocaleString()}/night</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                <div>
                  <Label htmlFor="guests">Guests</Label>
                  <Input
                    id="guests"
                    type="number"
                    min="1"
                    max={guestLimit > 0 ? guestLimit : undefined}
                    value={bookingDetails.guests}
                    onChange={(e) => setBookingDetails(prev => ({ ...prev, guests: e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 1) }))}
                    className="mt-1"
                    disabled={formLocked}
                  />
                  {guestLimit > 0 && (
                    <p className={`text-[11px] mt-1 ${Number(bookingDetails.guests) > guestLimit ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
                      {options.length > 1 ? `The ${option.bedrooms}-bedroom option takes` : 'This property takes'} up to {guestLimit} guests
                    </p>
                  )}
                </div>

                <div>
                  <Label>Special Requests</Label>
                  <Textarea
                    placeholder="Any special requests or preferences..."
                    value={bookingDetails.specialRequests}
                    onChange={(e) => setBookingDetails(prev => ({ ...prev, specialRequests: e.target.value }))}
                    className="mt-1"
                    disabled={formLocked}
                  />
                </div>

                {!existingBooking && (
                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                    {availabilityStatus !== 'available' && (() => {
                      const requirementsMet = !!bookingDetails.checkIn && !!bookingDetails.checkOut && Number(bookingDetails.guests) > 0 && !(guestLimit > 0 && Number(bookingDetails.guests) > guestLimit);
                      const isBusy = isCheckingAvailability || availabilityStatus === 'pending';
                      const showGreen = requirementsMet && !isBusy;
                      return (
                        <Button
                          onClick={handleCheckAvailability}
                          disabled={isCheckingAvailability || !requirementsMet || availabilityStatus === 'pending'}
                          variant={showGreen ? 'default' : 'outline'}
                          className={`w-full mb-3 transition-colors ${
                            showGreen
                              ? 'bg-green-600 hover:bg-green-700 text-white border-0 shadow-md'
                              : ''
                          }`}
                        >
                          {availabilityStatus === 'pending' ? (
                            <>
                              <Clock className="w-4 h-4 mr-2 animate-pulse" />
                              Awaiting Admin Approval...
                            </>
                          ) : isCheckingAvailability ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Sending Request...
                            </>
                          ) : (
                            <>
                              <Calendar className="w-4 h-4 mr-2" />
                              Check Availability
                            </>
                          )}
                        </Button>
                      );
                    })()}

                    {availabilityStatus === 'pending' && (
                      <div className="flex items-start gap-3 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 p-4 rounded-xl mb-3">
                        <Clock className="w-5 h-5 animate-pulse flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold text-sm mb-1">⏳ Awaiting Admin Approval</p>
                          <p className="text-xs">Your request is being reviewed. You can track it in the "Pending Approval" tab of your bookings!</p>
                          {pollStalled && (
                            <p className="text-xs mt-2" role="status">
                              We received your request, but this page cannot refresh its status right now.{' '}
                              <Link to={createPageUrl('Bookings')} className="underline font-medium">My Bookings</Link> shows where it stands.
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {availabilityStatus === 'available' && (
                      <div className="flex items-center gap-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border-2 border-green-200 dark:border-green-900 p-4 rounded-xl mb-3">
                        <CheckCircle className="w-6 h-6" />
                        <span className="font-bold">✅ APPROVED! Ready to book</span>
                      </div>
                    )}

                    {availabilityStatus === 'unavailable' && (
                      <div className="flex items-center gap-2 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 p-3 rounded-lg mb-3">
                        <AlertCircle className="w-5 h-5" />
                        <span className="font-medium">❌ Not available. Try different dates.</span>
                      </div>
                    )}
                  </div>
                )}

                {nights > 0 && (
                  <div className="bg-slate-50 dark:bg-slate-800/60 p-4 rounded-xl space-y-2">
                    {options.length > 1 && option && (
                      <p className="text-sm font-medium text-slate-900 dark:text-white">{option.bedrooms}-bedroom option</p>
                    )}
                    {linesAddUp ? (
                      <>
                        {(breakdown?.lines || []).map((line) => (
                          <div key={line.from} className="flex justify-between gap-3">
                            <span>
                              ₦{line.rate.toLocaleString()} × {line.nights} night{line.nights > 1 ? 's' : ''}
                              {line.season && <span className="block text-xs text-amber-700 dark:text-amber-300">{line.season}</span>}
                            </span>
                            <span>₦{(line.rate * line.nights).toLocaleString()}</span>
                          </div>
                        ))}
                        <div className="flex justify-between">
                          <span>Service Fee (2.5%)</span>
                          <span>₦{(breakdown?.serviceFee ?? 0).toLocaleString()}</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-slate-600 dark:text-slate-300">
                        {nights} night{nights > 1 ? 's' : ''}, at the price confirmed for this booking. The listing's prices have changed since.
                      </p>
                    )}
                    {property.caution_fee > 0 && (
                      <div className="flex justify-between items-center py-2 px-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg">
                        <div className="flex items-center gap-2">
                          <Shield className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                          <span className="text-sm font-medium text-amber-900 dark:text-amber-100">Refundable Caution Fee</span>
                        </div>
                        <span className="font-semibold text-amber-900 dark:text-amber-100">₦{property.caution_fee.toLocaleString()}</span>
                      </div>
                    )}
                    <hr className="border-slate-200 dark:border-slate-800" />
                    <div className="flex justify-between font-bold text-lg">
                      <span>Total</span>
                      <span>₦{totalPrice.toLocaleString()}</span>
                    </div>
                    {property.caution_fee > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                        * Caution fee of ₦{property.caution_fee.toLocaleString()} will be fully refunded after checkout inspection
                      </p>
                    )}
                  </div>
                )}

                {availabilityStatus === 'available' && nights > 0 && (
                  <div className="pt-4">
                    <div className="bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-950/40 dark:to-blue-950/40 border border-green-200 dark:border-green-900 rounded-xl p-4 text-sm">
                      <p className="font-semibold mb-2 text-green-900 dark:text-green-100">💳 Secure Payment with Paystack</p>
                      <p className="text-green-800 dark:text-green-200">Fast, secure, and reliable payment processing for Nigerian users.</p>
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleProceedToPayment}
                  disabled={availabilityStatus !== 'available' || nights <= 0}
                  className={`w-full py-3 rounded-xl font-semibold transition-all ${
                    availabilityStatus === 'available' && nights > 0
                      ? 'bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-lg hover:shadow-xl'
                      : 'bg-slate-300 text-slate-500 dark:text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {availabilityStatus !== 'available'
                    ? (existingBooking ? 'Loading...' : 'Check Availability First')
                    : `Proceed to Payment (₦${totalPrice.toLocaleString()})`}
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}