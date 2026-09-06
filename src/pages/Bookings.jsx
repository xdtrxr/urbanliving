
import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar, MapPin, Users, Clock, ExternalLink, Compass, X, AlertCircle, CreditCard, CheckCircle2, Loader2, RefreshCw, Phone, Map } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import RideBookingsSection from "@/components/booking/RideBookingsSection";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const statusColors = {
  pending: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200 border-yellow-200 dark:border-yellow-900",
  confirmed: "bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 border-green-200 dark:border-green-900",
  cancelled: "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900",
  completed: "bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900",
  // Paid + still future/current → emphasize the cleared payment with a strong
  // green badge so the guest immediately sees the booking is locked in.
  paid: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900",
  // payment_expired is a sub-status of cancelled — the guest can re-book the
  // same property + dates because checkAvailabilityWebhook only blocks against
  // pending/confirmed bookings. Distinct amber styling so it doesn't look like
  // an admin rejection or a user cancellation.
  payment_expired: "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900",
};

// Returns the right label + key for the status badge, factoring in payment_status
// and cancel_reason.
const labelForStatus = (booking) => {
  if (booking.status === 'cancelled' && booking.cancel_reason === 'payment_expired') {
    return { key: 'payment_expired', label: 'Payment Expired' };
  }
  if (booking.payment_status === 'paid' && booking.status !== 'cancelled') {
    return { key: 'paid', label: '✓ Payment Made' };
  }
  return { key: booking.status, label: booking.status.charAt(0).toUpperCase() + booking.status.slice(1) };
};

const approvalStatusColors = {
  pending: "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900",
  approved: "bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 border-green-200 dark:border-green-900",
  rejected: "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900"
};

const isValidSystemId = (id) => id && typeof id === 'string' && id.length > 10 && !id.startsWith("prop_");

const formatRemaining = (ms) => {
  if (ms == null) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

// Defined at module scope so React keeps the same component reference across
// parent re-renders (the polling re-render was unmounting/remounting cards
// which made the page look like it was blinking and reset the countdown timer).
const PendingApprovalCard = React.memo(function PendingApprovalCard({ booking, property, availabilityRequest }) {
  const checkIn = parseISO(booking.check_in);
  const checkOut = parseISO(booking.check_out);
  const approvalStatus = availabilityRequest?.status || 'pending';

  const [deadlineMs] = useState(() => {
    const t = Date.parse(booking.payment_deadline || '');
    return Number.isNaN(t) ? null : t;
  });
  const [msLeft, setMsLeft] = useState(() => deadlineMs ? Math.max(0, deadlineMs - Date.now()) : null);
  useEffect(() => {
    if (!deadlineMs) return;
    const tick = () => setMsLeft(Math.max(0, deadlineMs - Date.now()));
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg overflow-hidden hover:shadow-xl transition-all duration-300">
        <div className="md:flex">
          {property ? (
            <div className="md:w-1/3">
              <img
                src={property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400'}
                alt={property.title}
                className="w-full h-48 md:h-full object-cover"
              />
            </div>
          ) : (
            <div className="md:w-1/3 bg-slate-100 dark:bg-slate-800 flex items-center justify-center h-48 md:h-full">
              <MapPin className="w-16 h-16 text-slate-300" />
            </div>
          )}
          <div className="md:w-2/3 p-4 sm:p-6">
            <CardHeader className="p-0 mb-4">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white mb-2 break-words">
                    {property ? property.title : "Property details unavailable"}
                  </CardTitle>
                  {property && (
                    <div className="flex items-start gap-2 text-slate-600 dark:text-slate-300 mb-3">
                      <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span className="text-sm font-medium break-words">
                        {property.location?.city}, {property.location?.country}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-row flex-wrap sm:flex-col items-start sm:items-end gap-2 flex-shrink-0">
                  <Badge className={`${approvalStatusColors[approvalStatus]} border font-medium`}>
                    {approvalStatus === 'pending' && '⏳ Awaiting Approval'}
                    {approvalStatus === 'approved' && '✅ Approved'}
                    {approvalStatus === 'rejected' && '❌ Rejected'}
                  </Badge>
                  {approvalStatus === 'approved' && msLeft != null && msLeft > 0 && (
                    <Badge className={`border font-medium ${
                      msLeft < 5 * 60 * 1000
                        ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900'
                        : 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900'
                    }`}>
                      <Clock className="w-3 h-3 mr-1 inline" />
                      Pay in {formatRemaining(msLeft)}
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-0 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Check-in</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{format(checkIn, "MMM d, yyyy")}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">from 2:00 PM</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Check-out</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{format(checkOut, "MMM d, yyyy")}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">by 12:00 PM</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Guests</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{booking.guests}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Total</p>
                    <p className="font-semibold text-slate-900 dark:text-white">₦{booking.total_price.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {availabilityRequest?.admin_response && (
                <div className={`rounded-xl p-4 ${
                  approvalStatus === 'approved' ? 'bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900' :
                  approvalStatus === 'rejected' ? 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900' :
                  'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900'
                }`}>
                  <p className="text-sm font-semibold mb-1">
                    {approvalStatus === 'approved' ? '✅ Admin Response' :
                     approvalStatus === 'rejected' ? '❌ Admin Response' :
                     'ℹ️ Admin Response'}
                  </p>
                  <p className="text-sm">{availabilityRequest.admin_response}</p>
                </div>
              )}

              {approvalStatus === 'pending' && (
                <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <Loader2 className="w-5 h-5 text-amber-600 dark:text-amber-400 animate-spin flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">Availability Check in Progress</p>
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Your booking request is being reviewed by our team. You'll be notified once approved, and you can proceed to payment.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {approvalStatus === 'rejected' && (
                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-red-900 dark:text-red-200 mb-1">Booking Request Declined</p>
                      <p className="text-xs text-red-700 dark:text-red-300">
                        Unfortunately, this property is not available for your selected dates. Please try different dates or explore other properties.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                  Requested on {format(new Date(booking.created_date), "MMM d, yyyy 'at' h:mm a")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {booking.property_id && (
                    <Link to={createPageUrl(`Property?id=${booking.property_id}`)}>
                      <Button variant="outline" size="sm" className="rounded-xl">
                        <ExternalLink className="w-4 h-4 mr-2" />
                        View Property
                      </Button>
                    </Link>
                  )}
                  {approvalStatus === 'approved' && booking.payment_status !== 'paid' && (
                    <Link to={`${createPageUrl('PaymentPage')}?${new URLSearchParams({
                      booking_id: booking.id,
                      total: String(booking.total_price || 0),
                      property_title: property?.title || '',
                      guest_email: booking.guest_email || '',
                    }).toString()}`}>
                      <Button size="sm" className="rounded-xl bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-lg">
                        <CreditCard className="w-4 h-4 mr-2" />
                        Proceed to Payment
                      </Button>
                    </Link>
                  )}
                  {approvalStatus === 'rejected' && (
                    <Link to={createPageUrl('Search')}>
                      <Button size="sm" className="rounded-xl bg-slate-900 hover:bg-slate-800">
                        Find Another Property
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            </CardContent>
          </div>
        </div>
      </Card>
    </motion.div>
  );
});

const BookingCard = React.memo(function BookingCard({ booking, property, isCancellable, cancellingBookingId, onCancelClick }) {
  const checkIn = parseISO(booking.check_in);
  const checkOut = parseISO(booking.check_out);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg overflow-hidden hover:shadow-xl transition-all duration-300">
        <div className="md:flex">
          {property ? (
            <div className="md:w-1/3">
              <img
                src={property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400'}
                alt={property.title}
                className="w-full h-48 md:h-full object-cover"
              />
            </div>
          ) : (
            <div className="md:w-1/3 bg-slate-100 dark:bg-slate-800 flex items-center justify-center h-48 md:h-full">
              <MapPin className="w-16 h-16 text-slate-300" />
            </div>
          )}
          <div className="md:w-2/3 p-4 sm:p-6">
            <CardHeader className="p-0 mb-4">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white mb-2 break-words">
                    {property ? property.title : "Property details unavailable"}
                  </CardTitle>
                  {property && (
                    <div className="flex items-start gap-2 text-slate-600 dark:text-slate-300 mb-3">
                      <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span className="text-sm font-medium break-words">
                        {property.location?.city}, {property.location?.country}
                      </span>
                    </div>
                  )}
                  {!property && booking.property_id && !isValidSystemId(booking.property_id) && (
                    <p className="text-xs text-red-500 dark:text-red-400 break-all">Invalid property ID: {booking.property_id}</p>
                  )}
                </div>
                {(() => {
                  const s = labelForStatus(booking);
                  return (
                    <Badge className={`${statusColors[s.key]} border font-medium flex-shrink-0 self-start`}>
                      {s.label}
                    </Badge>
                  );
                })()}
              </div>
            </CardHeader>

            <CardContent className="p-0 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Check-in</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{format(checkIn, "MMM d, yyyy")}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">from 2:00 PM</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Check-out</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{format(checkOut, "MMM d, yyyy")}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">by 12:00 PM</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Guests</p>
                    <p className="font-semibold text-slate-900 dark:text-white">{booking.guests}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Total</p>
                    <p className="font-semibold text-slate-900 dark:text-white">₦{booking.total_price.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {booking.special_requests && (
                <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">Special Requests</p>
                  <p className="text-sm text-slate-600 dark:text-slate-300">{booking.special_requests}</p>
                </div>
              )}

              {booking.payment_status === 'paid' && property && (() => {
                const loc = property.location || {};
                const fullAddress = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
                const mapsLink = loc.coordinates?.lat && loc.coordinates?.lng
                  ? `https://www.google.com/maps?q=${loc.coordinates.lat},${loc.coordinates.lng}`
                  : (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}` : null);
                const hasAnything = fullAddress || property.host_phone || property.arrival_instructions;
                if (!hasAnything) return null;
                return (
                  <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-xl p-4 space-y-3">
                    <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" /> Arrival Details
                    </p>
                    {fullAddress && (
                      <div className="flex items-start gap-2 text-sm">
                        <MapPin className="w-4 h-4 text-emerald-700 dark:text-emerald-300 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-slate-900 dark:text-white">{fullAddress}</p>
                          {mapsLink && (
                            <a href={mapsLink} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:text-emerald-200 inline-flex items-center gap-1 mt-1">
                              <Map className="w-3 h-3" /> Open in Google Maps
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                    {property.host_phone && (
                      <div className="flex items-start gap-2 text-sm">
                        <Phone className="w-4 h-4 text-emerald-700 dark:text-emerald-300 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-slate-900 dark:text-white">
                            Call <span className="font-semibold">{property.host_name || 'your host'}</span> on arrival
                          </p>
                          <a href={`tel:${property.host_phone}`} className="text-sm font-semibold text-emerald-800 dark:text-emerald-200 hover:text-emerald-900 dark:text-emerald-200">
                            {property.host_phone}
                          </a>
                        </div>
                      </div>
                    )}
                    {property.arrival_instructions && (
                      <div className="text-sm text-slate-700 dark:text-slate-200 bg-white/60 dark:bg-slate-900/60 rounded-lg p-3 border border-emerald-100 dark:border-emerald-900">
                        <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200 uppercase tracking-wide mb-1">Host notes</p>
                        <p className="whitespace-pre-wrap">{property.arrival_instructions}</p>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                  Booked on {format(new Date(booking.created_date), "MMM d, yyyy")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {booking.property_id && (
                    <Link to={createPageUrl(`Property?id=${booking.property_id}`)}>
                      <Button variant="outline" size="sm" className="rounded-xl">
                        <ExternalLink className="w-4 h-4 mr-2" />
                        View Property
                      </Button>
                    </Link>
                  )}
                  {booking.status === 'confirmed' && (
                    <Link to={createPageUrl(`PlanTrip?property_booking_id=${booking.id}`)}>
                      <Button size="sm" className="rounded-xl bg-slate-900 hover:bg-slate-800">
                        <Compass className="w-4 h-4 mr-2" />
                        Add a Ride
                      </Button>
                    </Link>
                  )}
                  {isCancellable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCancelClick(booking)}
                      disabled={cancellingBookingId === booking.id}
                      className="rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:bg-red-950/40"
                    >
                      <X className="w-4 h-4 mr-2" />
                      {cancellingBookingId === booking.id ? 'Cancelling...' : 'Cancel'}
                    </Button>
                  )}
                  {booking.payment_status === 'paid' && booking.status !== 'cancelled' && (
                    <Link to={createPageUrl('Support')}>
                      <Button variant="outline" size="sm" className="rounded-xl">
                        Contact Support to Cancel
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            </CardContent>
          </div>
        </div>
      </Card>
    </motion.div>
  );
});

export default function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [properties, setProperties] = useState({});
  const [availabilityRequests, setAvailabilityRequests] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cancellingBookingId, setCancellingBookingId] = useState(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState(null);

  const isValidSystemId = (id) => {
    return id && typeof id === 'string' && id.length > 10 && !id.startsWith("prop_");
  };

  // Use a ref so the polling interval reads the latest bookings without
  // re-arming the interval on every length change.
  const bookingsRef = useRef(bookings);
  useEffect(() => { bookingsRef.current = bookings; }, [bookings]);

  useEffect(() => {
    loadBookings();

    // Poll every 5s, but stop after 60 ticks (5 min) without finding any
    // pending approvals. User can hit Refresh to re-arm.
    let ticksWithoutPending = 0;
    const MAX_IDLE_TICKS = 60;

    const interval = setInterval(() => {
      const hasPending = bookingsRef.current.some(b =>
        b.status === 'pending' && b.payment_status === 'unpaid'
      );
      if (hasPending) {
        ticksWithoutPending = 0;
        loadBookings(true);
        loadAvailabilityRequests();
      } else if (++ticksWithoutPending >= MAX_IDLE_TICKS) {
        clearInterval(interval);
      }
    }, 5000);

    return () => clearInterval(interval);
     
  }, []);

  const loadBookings = async (silent = false) => {
    // Show loading spinner only for initial load, not for background refreshes
    if (!silent && bookings.length === 0) {
      setIsLoading(true);
    } else if (!silent) {
      setIsRefreshing(true);
    }

    try {
      console.log('📡 Fetching bookings via getBookings function...');
      const result = await base44.functions.invoke('getBookings', { scope: 'mine' });
      const bookingData = result?.data?.success ? result.data.data : [];
      console.log(`✅ Loaded ${bookingData.length} bookings`, result?.data?.counts);

      setBookings(bookingData);

      const validPropertyIds = [...new Set(
        bookingData
          .map(b => b.property_id)
          .filter(id => isValidSystemId(id))
      )];
      
      if (validPropertyIds.length > 0) {
        console.log('🏠 Loading property details for', validPropertyIds.length, 'properties');
        const propertiesData = await base44.entities.Property.filter({ id: { $in: validPropertyIds } });
        const propertyMap = propertiesData.reduce((acc, prop) => {
          acc[prop.id] = prop;
          return acc;
        }, {});
        setProperties(propertyMap);
      }

      // Always load availability requests to get latest status
      await loadAvailabilityRequests();
      
    } catch (error) {
      console.error("❌ Error loading bookings:", error);
    } finally {
      if (!silent) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  };

  const loadAvailabilityRequests = async () => {
    try {
      console.log('📡 Fetching availability requests...');
      const user = await base44.auth.me();
      const requests = await base44.entities.AvailabilityRequest.filter({
        user_email: user.email
      }, '-created_date');
      
      console.log(`✅ Loaded ${requests.length} availability requests`);
      
      const requestMap = {};
      requests.forEach(req => {
        const key = `${req.property_id}_${req.check_in}_${req.check_out}`;
        requestMap[key] = req;
        console.log(`  📋 Request ${req.id}: ${req.status} for ${req.property_title}`);
      });
      
      setAvailabilityRequests(requestMap);
    } catch (error) {
      console.error("❌ Error loading availability requests:", error);
    }
  };

  const handleManualRefresh = async () => {
    console.log('🔄 Manual refresh triggered');
    await loadBookings();
  };

  const getAvailabilityRequest = (booking) => {
    const key = `${booking.property_id}_${booking.check_in}_${booking.check_out}`;
    return availabilityRequests[key] || null;
  };

  // Bucket comes from the getBookings backend function (single source of truth).
  // Fallback for any row missing a bucket: treat as pending-approval so it surfaces.
  const groupByBucket = () => {
    const buckets = {
      'pending-approval': [],
      'upcoming': [],
      'current': [],
      'past': [],
      'cancelled': [],
    };
    bookings.forEach(b => {
      const key = buckets[b.bucket] ? b.bucket : 'pending-approval';
      buckets[key].push(b);
    });
    return buckets;
  };

  const canCancelBooking = (booking) => {
    // Paid bookings need a refund pipeline — admin handles those manually for now.
    if (booking.payment_status === 'paid') return false;

    const checkIn = parseISO(booking.check_in);
    const hoursUntilCheckIn = (checkIn - new Date()) / (1000 * 60 * 60);

    return (
      (booking.status === 'pending' || booking.status === 'confirmed') &&
      hoursUntilCheckIn >= 24
    );
  };

  const handleCancelClick = (booking) => {
    setSelectedBooking(booking);
    setShowCancelDialog(true);
  };

  const handleCancelBooking = async () => {
    if (!selectedBooking) return;

    setCancellingBookingId(selectedBooking.id);
    try {
      await base44.entities.Booking.update(selectedBooking.id, {
        status: 'cancelled'
      });
      
      await loadBookings();
      
      alert("Booking cancelled successfully.");
    } catch (error) {
      console.error("Error cancelling booking:", error);
      alert("Failed to cancel booking. Please try again or contact support.");
    } finally {
      setCancellingBookingId(null);
      setShowCancelDialog(false);
      setSelectedBooking(null);
    }
  };


  const grouped = groupByBucket();
  const pendingApproval = grouped['pending-approval'];
  const upcoming = grouped['upcoming'];
  const current = grouped['current'];
  const past = grouped['past'];
  const cancelledBookings = grouped['cancelled'];

  // Bookings that have been admin-approved but not yet paid (now living in the
  // upcoming bucket per the new server-side logic) get the PendingApprovalCard
  // so the user sees the countdown + "Proceed to Payment" CTA. Paid bookings
  // get the regular BookingCard.
  const renderUpcomingItem = (booking) => {
    if (booking.payment_status === 'paid' || booking.status === 'confirmed') {
      return (
        <BookingCard
          key={booking.id}
          booking={booking}
          property={isValidSystemId(booking.property_id) ? properties[booking.property_id] : null}
          isCancellable={canCancelBooking(booking)}
          cancellingBookingId={cancellingBookingId}
          onCancelClick={handleCancelClick}
        />
      );
    }
    return (
      <PendingApprovalCard
        key={booking.id}
        booking={booking}
        property={isValidSystemId(booking.property_id) ? properties[booking.property_id] : null}
        availabilityRequest={getAvailabilityRequest(booking)}
      />
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-slate-200 dark:bg-slate-800 rounded-xl w-48" />
            {Array(3).fill(0).map((_, i) => (
              <div key={i} className="h-48 bg-slate-200 dark:bg-slate-800 rounded-3xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1 sm:mb-2">My Bookings</h1>
            <p className="text-slate-600 dark:text-slate-300 text-base sm:text-lg">Manage your travel reservations and plan your trips</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="rounded-xl self-start sm:self-auto"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>

        <Tabs defaultValue="pending-approval" className="space-y-6">
          <TabsList className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm p-1 rounded-xl shadow-sm w-full overflow-x-auto flex justify-start sm:justify-center scrollbar-thin">
            <TabsTrigger value="pending-approval" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap">
              Pending Approval {pendingApproval.length > 0 && `(${pendingApproval.length})`}
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap">
              Upcoming {upcoming.length > 0 && `(${upcoming.length})`}
            </TabsTrigger>
            <TabsTrigger value="current" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap">
              Current {current.length > 0 && `(${current.length})`}
            </TabsTrigger>
            <TabsTrigger value="past" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap">
              Past {past.length > 0 && `(${past.length})`}
            </TabsTrigger>
            <TabsTrigger value="cancelled" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap">
              Cancelled {cancelledBookings.length > 0 && `(${cancelledBookings.length})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending-approval" className="space-y-6">
            <AnimatePresence>
              {pendingApproval.length > 0 ? (
                pendingApproval.map(booking => (
                  <PendingApprovalCard
                    key={booking.id}
                    booking={booking}
                    property={isValidSystemId(booking.property_id) ? properties[booking.property_id] : null}
                    availabilityRequest={getAvailabilityRequest(booking)}
                  />
                ))
              ) : (
                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-6 sm:p-12 text-center">
                  <div className="text-6xl mb-6">⏳</div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Pending Approvals</h3>
                  <p className="text-slate-600 dark:text-slate-300 mb-6">You don't have any bookings awaiting approval.</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                    When you request to book a property, it will appear here while the admin reviews availability.
                  </p>
                  <Link to={createPageUrl("Search")}>
                    <Button className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-3 rounded-xl font-semibold">
                      Discover Properties
                    </Button>
                  </Link>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="upcoming" className="space-y-6">
            <AnimatePresence>
              {upcoming.length > 0 ? (
                upcoming.map(renderUpcomingItem)
              ) : (
                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-6 sm:p-12 text-center">
                  <div className="text-6xl mb-6">📅</div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Upcoming Bookings</h3>
                  <p className="text-slate-600 dark:text-slate-300 mb-6">Start planning your next adventure!</p>
                  <Link to={createPageUrl("Search")}>
                    <Button className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-3 rounded-xl font-semibold">
                      Discover Properties
                    </Button>
                  </Link>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="current" className="space-y-6">
            <AnimatePresence>
              {current.length > 0 ? (
                current.map(renderUpcomingItem)
              ) : (
                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-6 sm:p-8 text-center">
                  <div className="text-6xl mb-4">🏠</div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Current Stays</h3>
                  <p className="text-slate-600 dark:text-slate-300">You don't have any active bookings at the moment.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="past" className="space-y-6">
            <AnimatePresence>
              {past.length > 0 ? (
                past.map(booking => (
                  <BookingCard
                    key={booking.id}
                    booking={booking}
                    property={isValidSystemId(booking.property_id) ? properties[booking.property_id] : null}
                    isCancellable={canCancelBooking(booking)}
                    cancellingBookingId={cancellingBookingId}
                    onCancelClick={handleCancelClick}
                  />
                ))
              ) : (
                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-6 sm:p-8 text-center">
                  <div className="text-6xl mb-4">🕰️</div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Past Bookings</h3>
                  <p className="text-slate-600 dark:text-slate-300">Your booking history will appear here.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="cancelled" className="space-y-6">
            <AnimatePresence>
              {cancelledBookings.length > 0 ? (
                cancelledBookings.map(booking => (
                  <BookingCard
                    key={booking.id}
                    booking={booking}
                    property={isValidSystemId(booking.property_id) ? properties[booking.property_id] : null}
                    isCancellable={canCancelBooking(booking)}
                    cancellingBookingId={cancellingBookingId}
                    onCancelClick={handleCancelClick}
                  />
                ))
              ) : (
                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-6 sm:p-8 text-center">
                  <div className="text-6xl mb-4">✅</div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Cancelled Bookings</h3>
                  <p className="text-slate-600 dark:text-slate-300">You haven't cancelled any bookings.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>
        </Tabs>

        <RideBookingsSection />

        <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-400" />
                Cancel Booking?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to cancel this booking? This action cannot be undone.
                {selectedBooking && (
                  <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-800/60 rounded-lg text-sm text-slate-700 dark:text-slate-200">
                    <p><strong>Property:</strong> {properties[selectedBooking.property_id]?.title || 'Property'}</p>
                    <p><strong>Check-in:</strong> {format(parseISO(selectedBooking.check_in), "MMM d, yyyy")}</p>
                    <p><strong>Total:</strong> ₦{selectedBooking.total_price.toLocaleString()}</p>
                  </div>
                )}
                <p className="mt-3 text-amber-600 dark:text-amber-400">
                  Only unpaid pending or unpaid confirmed bookings can be cancelled here. To cancel a paid booking, contact support.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Booking</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleCancelBooking}
                className="bg-red-600 hover:bg-red-700"
              >
                Yes, Cancel Booking
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
