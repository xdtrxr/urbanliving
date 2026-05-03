
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar, MapPin, Users, Clock, ExternalLink, Compass, X, AlertCircle, CreditCard, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { format, isAfter, isBefore, parseISO } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
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
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  confirmed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  completed: "bg-blue-100 text-blue-800 border-blue-200"
};

const approvalStatusColors = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-green-100 text-green-800 border-green-200",
  rejected: "bg-red-100 text-red-800 border-red-200"
};

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

  useEffect(() => {
    console.log('🔄 Initial load of bookings page');
    loadBookings();
    
    // Poll for updates every 3 seconds when there are pending approvals
    const interval = setInterval(() => {
      const hasPendingApprovals = bookings.some(b => 
        b.status === 'pending' && b.payment_status === 'unpaid'
      );
      
      if (hasPendingApprovals) {
        console.log('🔄 Auto-refreshing (pending approvals detected)');
        loadBookings(true); // Silent refresh
        loadAvailabilityRequests();
      }
    }, 3000); // Reduced from 5s to 3s for faster updates

    return () => clearInterval(interval);
  }, [bookings.length]);

  const loadBookings = async (silent = false) => {
    // Show loading spinner only for initial load, not for background refreshes
    if (!silent && bookings.length === 0) {
      setIsLoading(true);
    } else if (!silent) {
      setIsRefreshing(true);
    }
    
    try {
      console.log('📡 Fetching bookings from database...');
      const bookingData = await base44.entities.Booking.filter({}, '-created_date'); // Most recent first
      console.log(`✅ Loaded ${bookingData.length} bookings`);
      
      // Log pending bookings specifically
      const pendingBookings = bookingData.filter(b => b.status === 'pending' && b.payment_status === 'unpaid');
      console.log(`📋 Found ${pendingBookings.length} pending approval bookings:`, 
        pendingBookings.map(b => ({ id: b.id, property_id: b.property_id, created: b.created_date }))
      );
      
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

  const categorizeBookings = () => {
    const now = new Date();
    const upcoming = [];
    const current = [];
    const past = [];
    const pendingApproval = [];

    console.log('📊 Categorizing', bookings.length, 'bookings...');

    bookings.forEach(booking => {
      // Skip cancelled bookings from main categorization
      if (booking.status === 'cancelled') {
        return;
      }

      // CRITICAL: Identify pending bookings awaiting approval
      if (booking.status === 'pending' && booking.payment_status === 'unpaid') {
        console.log('✅ Found pending approval booking:', booking.id);
        pendingApproval.push(booking);
        return;
      }

      const checkIn = parseISO(booking.check_in);
      const checkOut = parseISO(booking.check_out);

      if (isAfter(now, checkOut)) {
        past.push(booking);
      } else if (isBefore(now, checkIn)) {
        upcoming.push(booking);
      } else {
        current.push(booking);
      }
    });

    console.log('📊 Categorization complete:', {
      pendingApproval: pendingApproval.length,
      upcoming: upcoming.length,
      current: current.length,
      past: past.length,
      cancelled: bookings.filter(b => b.status === 'cancelled').length
    });

    return { upcoming, current, past, pendingApproval };
  };

  const canCancelBooking = (booking) => {
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
      
      alert("Booking cancelled successfully. You may be eligible for a refund based on the cancellation policy.");
    } catch (error) {
      console.error("Error cancelling booking:", error);
      alert("Failed to cancel booking. Please try again or contact support.");
    } finally {
      setCancellingBookingId(null);
      setShowCancelDialog(false);
      setSelectedBooking(null);
    }
  };

  const PendingApprovalCard = ({ booking }) => {
    const property = isValidSystemId(booking.property_id) ? properties[booking.property_id] : null;
    const checkIn = parseISO(booking.check_in);
    const checkOut = parseISO(booking.check_out);
    const availabilityRequest = getAvailabilityRequest(booking);
    const approvalStatus = availabilityRequest?.status || 'pending';

    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
      >
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg overflow-hidden hover:shadow-xl transition-all duration-300">
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
              <div className="md:w-1/3 bg-slate-100 flex items-center justify-center h-48 md:h-full">
                <MapPin className="w-16 h-16 text-slate-300" />
              </div>
            )}
            <div className="md:w-2/3 p-6">
              <CardHeader className="p-0 mb-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <CardTitle className="text-xl font-bold text-slate-900 mb-2">
                      {property ? property.title : "Property details unavailable"}
                    </CardTitle>
                    {property && (
                      <div className="flex items-center gap-2 text-slate-600 mb-3">
                        <MapPin className="w-4 h-4" />
                        <span className="text-sm font-medium">
                          {property.location?.city}, {property.location?.country}
                        </span>
                      </div>
                    )}
                  </div>
                  <Badge className={`${approvalStatusColors[approvalStatus]} border font-medium`}>
                    {approvalStatus === 'pending' && '⏳ Awaiting Approval'}
                    {approvalStatus === 'approved' && '✅ Approved'}
                    {approvalStatus === 'rejected' && '❌ Rejected'}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="p-0 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Check-in</p>
                      <p className="font-semibold text-slate-900">
                        {format(checkIn, "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Check-out</p>
                      <p className="font-semibold text-slate-900">
                        {format(checkOut, "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Guests</p>
                      <p className="font-semibold text-slate-900">{booking.guests}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Total</p>
                      <p className="font-semibold text-slate-900">₦{booking.total_price.toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                {availabilityRequest?.admin_response && (
                  <div className={`rounded-xl p-4 ${
                    approvalStatus === 'approved' ? 'bg-green-50 border border-green-200' :
                    approvalStatus === 'rejected' ? 'bg-red-50 border border-red-200' :
                    'bg-amber-50 border border-amber-200'
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
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                    <div className="flex items-start gap-3">
                      <Loader2 className="w-5 h-5 text-amber-600 animate-spin flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-amber-900 mb-1">Availability Check in Progress</p>
                        <p className="text-xs text-amber-700">
                          Your booking request is being reviewed by our team. You'll be notified once approved, and you can proceed to payment.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {approvalStatus === 'rejected' && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-red-900 mb-1">Booking Request Declined</p>
                        <p className="text-xs text-red-700">
                          Unfortunately, this property is not available for your selected dates. Please try different dates or explore other properties.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                  <div className="text-sm text-slate-500">
                    Requested on {format(new Date(booking.created_date), "MMM d, yyyy 'at' h:mm a")}
                  </div>
                  <div className="flex gap-3">
                    {property && (
                      <Link to={createPageUrl(`Property?id=${property.id}`)}>
                        <Button variant="outline" size="sm" className="rounded-xl">
                          <ExternalLink className="w-4 h-4 mr-2" />
                          View Property
                        </Button>
                      </Link>
                    )}
                    {approvalStatus === 'approved' && (
                      <Link to={createPageUrl(`Checkout?bookingId=${booking.id}`)}>
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
  };

  const BookingCard = ({ booking }) => {
    const property = isValidSystemId(booking.property_id) ? properties[booking.property_id] : null;
    const checkIn = parseISO(booking.check_in);
    const checkOut = parseISO(booking.check_out);
    const isCancellable = canCancelBooking(booking);

    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
      >
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg overflow-hidden hover:shadow-xl transition-all duration-300">
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
              <div className="md:w-1/3 bg-slate-100 flex items-center justify-center h-48 md:h-full">
                <MapPin className="w-16 h-16 text-slate-300" />
              </div>
            )}
            <div className="md:w-2/3 p-6">
              <CardHeader className="p-0 mb-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <CardTitle className="text-xl font-bold text-slate-900 mb-2">
                      {property ? property.title : "Property details unavailable"}
                    </CardTitle>
                    {property && (
                      <div className="flex items-center gap-2 text-slate-600 mb-3">
                        <MapPin className="w-4 h-4" />
                        <span className="text-sm font-medium">
                          {property.location?.city}, {property.location?.country}
                        </span>
                      </div>
                    )}
                    {!property && booking.property_id && !isValidSystemId(booking.property_id) && (
                      <p className="text-xs text-red-500">Invalid property ID: {booking.property_id}</p>
                    )}
                  </div>
                  <Badge className={`${statusColors[booking.status]} border font-medium`}>
                    {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="p-0 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Check-in</p>
                      <p className="font-semibold text-slate-900">
                        {format(checkIn, "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Check-out</p>
                      <p className="font-semibold text-slate-900">
                        {format(checkOut, "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Guests</p>
                      <p className="font-semibold text-slate-900">{booking.guests}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-slate-500">Total</p>
                      <p className="font-semibold text-slate-900">₦{booking.total_price.toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                {booking.special_requests && (
                  <div className="bg-slate-50 rounded-xl p-4">
                    <p className="text-sm font-semibold text-slate-700 mb-1">Special Requests</p>
                    <p className="text-sm text-slate-600">{booking.special_requests}</p>
                  </div>
                )}

                <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                  <div className="text-sm text-slate-500">
                    Booked on {format(new Date(booking.created_date), "MMM d, yyyy")}
                  </div>
                  <div className="flex gap-3">
                    {property && (
                      <Link to={createPageUrl(`Property?id=${property.id}`)}>
                        <Button variant="outline" size="sm" className="rounded-xl">
                          <ExternalLink className="w-4 h-4 mr-2" />
                          View Property
                        </Button>
                      </Link>
                    )}
                    {booking.status === 'confirmed' && (
                      <Link to={createPageUrl(`TripPlanner?booking_id=${booking.id}`)}>
                        <Button size="sm" className="rounded-xl bg-slate-900 hover:bg-slate-800">
                          <Compass className="w-4 h-4 mr-2" />
                          Plan Trip
                        </Button>
                      </Link>
                    )}
                    {isCancellable && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancelClick(booking)}
                        disabled={cancellingBookingId === booking.id}
                        className="rounded-xl border-red-200 text-red-600 hover:bg-red-50"
                      >
                        <X className="w-4 h-4 mr-2" />
                        {cancellingBookingId === booking.id ? 'Cancelling...' : 'Cancel'}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </div>
          </div>
        </Card>
      </motion.div>
    );
  };

  const { upcoming, current, past, pendingApproval } = categorizeBookings();
  const cancelledBookings = bookings.filter(b => b.status === 'cancelled');

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8">
        <div className="max-w-6xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-slate-200 rounded-xl w-48" />
            {Array(3).fill(0).map((_, i) => (
              <div key={i} className="h-48 bg-slate-200 rounded-3xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">My Bookings</h1>
            <p className="text-slate-600 text-lg">Manage your travel reservations and plan your trips</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="rounded-xl"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>

        <Tabs defaultValue="pending-approval" className="space-y-6">
          <TabsList className="bg-white/80 backdrop-blur-sm p-1 rounded-xl shadow-sm">
            <TabsTrigger value="pending-approval" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white">
              Pending Approval {pendingApproval.length > 0 && `(${pendingApproval.length})`}
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white">
              Upcoming {upcoming.length > 0 && `(${upcoming.length})`}
            </TabsTrigger>
            <TabsTrigger value="current" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white">
              Current {current.length > 0 && `(${current.length})`}
            </TabsTrigger>
            <TabsTrigger value="past" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white">
              Past {past.length > 0 && `(${past.length})`}
            </TabsTrigger>
            <TabsTrigger value="cancelled" className="rounded-lg data-[state=active]:bg-slate-900 data-[state=active]:text-white">
              Cancelled {cancelledBookings.length > 0 && `(${cancelledBookings.length})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending-approval" className="space-y-6">
            <AnimatePresence>
              {pendingApproval.length > 0 ? (
                pendingApproval.map(booking => <PendingApprovalCard key={booking.id} booking={booking} />)
              ) : (
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-12 text-center">
                  <div className="text-6xl mb-6">⏳</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">No Pending Approvals</h3>
                  <p className="text-slate-600 mb-6">You don't have any bookings awaiting approval.</p>
                  <p className="text-sm text-slate-500 mb-6">
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
                upcoming.map(booking => <BookingCard key={booking.id} booking={booking} />)
              ) : (
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-12 text-center">
                  <div className="text-6xl mb-6">📅</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">No Upcoming Bookings</h3>
                  <p className="text-slate-600 mb-6">Start planning your next adventure!</p>
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
                current.map(booking => <BookingCard key={booking.id} booking={booking} />)
              ) : (
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-8 text-center">
                  <div className="text-6xl mb-4">🏠</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">No Current Stays</h3>
                  <p className="text-slate-600">You don't have any active bookings at the moment.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="past" className="space-y-6">
            <AnimatePresence>
              {past.length > 0 ? (
                past.map(booking => <BookingCard key={booking.id} booking={booking} />)
              ) : (
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-8 text-center">
                  <div className="text-6xl mb-4">🕰️</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">No Past Bookings</h3>
                  <p className="text-slate-600">Your booking history will appear here.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>

          <TabsContent value="cancelled" className="space-y-6">
            <AnimatePresence>
              {cancelledBookings.length > 0 ? (
                cancelledBookings.map(booking => <BookingCard key={booking.id} booking={booking} />)
              ) : (
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-8 text-center">
                  <div className="text-6xl mb-4">✅</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">No Cancelled Bookings</h3>
                  <p className="text-slate-600">You haven't cancelled any bookings.</p>
                </Card>
              )}
            </AnimatePresence>
          </TabsContent>
        </Tabs>

        <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-500" />
                Cancel Booking?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to cancel this booking? This action cannot be undone.
                {selectedBooking && (
                  <div className="mt-4 p-3 bg-slate-50 rounded-lg text-sm text-slate-700">
                    <p><strong>Property:</strong> {properties[selectedBooking.property_id]?.title || 'Property'}</p>
                    <p><strong>Check-in:</strong> {format(parseISO(selectedBooking.check_in), "MMM d, yyyy")}</p>
                    <p><strong>Total:</strong> ₦{selectedBooking.total_price.toLocaleString()}</p>
                  </div>
                )}
                <p className="mt-3 text-amber-600">
                  <strong>Cancellation Policy:</strong> Refunds are processed based on the cancellation policy. You may be eligible for a full or partial refund.
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
