
import React, { useState, useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Property as PropertyEntity } from '@/entities/Property';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    MapPin, Users, Bed, Bath, Wifi, Car, Utensils, Star, Calendar,
    ArrowLeft, Share2, Heart, PlayCircle, Image as ImageIcon, Shield, Clock
} from 'lucide-react';
import { createPageUrl } from '@/utils';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '@/lib/AuthContext';
import MediaLightbox from '@/components/media/MediaLightbox';

const amenityIcons = {
  wifi: Wifi,
  parking: Car,
  kitchen: Utensils,
};

// App is NGN-only — every entry resolves to ₦ so guests never see $/€/£.
const currencySymbols = {
  NGN: '₦',
  USD: '₦',
  EUR: '₦',
  GBP: '₦',
  CAD: '₦'
};

export default function PropertyPage() {
  const { isAuthenticated } = useAuth();
    const [property, setProperty] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [media, setMedia] = useState([]);
    const [selectedMedia, setSelectedMedia] = useState(null);
    // Approved-but-unpaid booking by the current user for this property — when
    // present we swap the "Book Now" CTA for "Proceed to Payment".
    const [pendingPaymentBooking, setPendingPaymentBooking] = useState(null);
    // Pending-approval booking by the current user for this property — they
    // can't request another booking on this property until this one resolves.
    const [pendingApprovalBooking, setPendingApprovalBooking] = useState(null);
    // Lightbox state — full-screen gallery viewer. Opens on hero/thumbnail
    // click; `lightboxIndex` is the entry to open at so the viewer starts on
    // whatever the user tapped.
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [lightboxIndex, setLightboxIndex] = useState(0);
    const location = useLocation();

    useEffect(() => {
        const loadProperty = async () => {
            const params = new URLSearchParams(location.search);
            const propertyId = params.get('id');
            if (propertyId) {
                try {
                    const data = await PropertyEntity.get(propertyId);
                    setProperty(data);

                    const images = (data.images || []).map(url => ({ type: 'image', url }));
                    const videos = (data.videos || []).map(url => ({ type: 'video', url }));

                    const combinedMedia = [...images, ...videos];
                    setMedia(combinedMedia);

                    if (combinedMedia.length > 0) {
                        setSelectedMedia(combinedMedia[0]);
                    }

                    // If the user has a non-paid pending booking for this property,
                    // surface the right CTA: "Proceed to Payment" for approved-unpaid,
                    // or a locked "Awaiting Admin Approval" pill for pre-approval.
                    // Same-user re-bookings are blocked by checkAvailabilityWebhook
                    // until this prior booking is paid, cancelled, or expired.
                    if (isAuthenticated) {
                        try {
                            const me = await base44.auth.me();
                            const matches = await base44.entities.Booking.filter({
                                property_id: propertyId,
                                guest_email: me.email,
                                status: 'pending',
                            });
                            const approvedUnpaid = (matches || []).find(b => b.approved_at && b.payment_status !== 'paid');
                            const awaitingApproval = (matches || []).find(b => !b.approved_at);
                            if (approvedUnpaid) setPendingPaymentBooking(approvedUnpaid);
                            else if (awaitingApproval) setPendingApprovalBooking(awaitingApproval);
                        } catch (lookupErr) {
                            console.warn('Could not look up existing booking for this property:', lookupErr);
                        }
                    }
                } catch (error) {
                    console.error("Failed to fetch property:", error);
                }
            }
            setIsLoading(false);
        };

        loadProperty();
    }, [location.search, isAuthenticated]);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
                <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent"></div>
            </div>
        );
    }

    if (!property) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-8 text-center">
                <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl p-12">
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">Property Not Found</h2>
                    <p className="text-slate-600 dark:text-slate-300 mb-6">The property you're looking for doesn't exist or has been removed.</p>
                    <Link to={createPageUrl('Search')}>
                        <Button>Back to Search</Button>
                    </Link>
                </Card>
            </div>
        );
    }
    
    const currencySymbol = currencySymbols[property.currency] || '₦';

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <Link to={createPageUrl('Search')}>
                    <Button variant="ghost" className="mb-6 flex items-center gap-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:text-white">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Search
                    </Button>
                </Link>

                <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-4 sm:p-6 md:p-8">
                    {/* Media Gallery — hero is tap-to-open-lightbox; thumbnails jump
                        to that media inside the lightbox. No more in-place swap. */}
                    <div className="mb-6 sm:mb-8">
                        <button
                            type="button"
                            onClick={() => {
                                const heroIdx = selectedMedia
                                    ? media.findIndex((m) => m.url === selectedMedia.url)
                                    : 0;
                                setLightboxIndex(Math.max(0, heroIdx));
                                setLightboxOpen(true);
                            }}
                            className="group relative block w-full aspect-video bg-slate-200 dark:bg-slate-800 rounded-2xl overflow-hidden shadow-lg cursor-zoom-in"
                            aria-label="Open photo gallery"
                        >
                            <AnimatePresence mode="wait">
                                {selectedMedia && selectedMedia.type === 'image' && (
                                    <motion.img
                                        key={selectedMedia.url}
                                        initial={{ opacity: 0, scale: 0.95 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.95 }}
                                        transition={{ duration: 0.3 }}
                                        src={selectedMedia.url}
                                        alt={property.title}
                                        className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                                    />
                                )}
                                {selectedMedia && selectedMedia.type === 'video' && (
                                    <motion.video
                                        key={selectedMedia.url}
                                        initial={{ opacity: 0, scale: 0.95 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.95 }}
                                        transition={{ duration: 0.3 }}
                                        src={selectedMedia.url}
                                        className="w-full h-full object-cover"
                                        muted
                                        loop
                                        playsInline
                                    >
                                        Your browser does not support the video tag.
                                    </motion.video>
                                )}
                            </AnimatePresence>
                            {/* Photo count overlay so users know there's more */}
                            {media.length > 1 && (
                                <div className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-semibold">
                                    <ImageIcon className="w-3.5 h-3.5" />
                                    {media.length} photos
                                </div>
                            )}
                        </button>

                        {media.length > 1 && (
                            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3 mt-4">
                                {media.map((item, index) => (
                                    <button
                                        type="button"
                                        key={index}
                                        onClick={() => {
                                            setLightboxIndex(index);
                                            setLightboxOpen(true);
                                            // Also update the hero so when the lightbox closes
                                            // the page reflects the user's last viewed item.
                                            setSelectedMedia(item);
                                        }}
                                        className={`relative aspect-square rounded-lg overflow-hidden ring-2 transition-all duration-200 ${selectedMedia?.url === item.url ? 'ring-amber-500 ring-offset-2' : 'ring-transparent hover:ring-amber-300'}`}
                                    >
                                        <img src={item.type === 'image' ? item.url : 'https://static.thenounproject.com/png/11204-200.png'} alt={`${property.title} thumbnail ${index + 1}`} className="w-full h-full object-cover" />
                                        {item.type === 'video' && (
                                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                                <PlayCircle className="w-6 h-6 text-white" />
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <MediaLightbox
                        media={media}
                        startIndex={lightboxIndex}
                        open={lightboxOpen}
                        onClose={() => setLightboxOpen(false)}
                    />

                    <CardHeader className="p-0 mb-6">
                        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                            <div>
                                <CardTitle className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-2 break-words">{property.title}</CardTitle>
                                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                                    <MapPin className="w-5 h-5" />
                                    <span className="font-medium">{property.location?.city}, {property.location?.country}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                                <Button variant="outline" size="icon"><Share2 className="w-4 h-4" /></Button>
                                <Button variant="outline" size="icon" className="text-red-500 dark:text-red-400"><Heart className="w-4 h-4 fill-current" /></Button>
                            </div>
                        </div>
                    </CardHeader>

                    <CardContent className="p-0">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                            <div className="lg:col-span-2">
                                <div className="border-b pb-6 mb-6">
                                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-slate-700 dark:text-slate-200">
                                        <div className="flex items-center gap-2"><Users className="w-5 h-5 text-amber-500 dark:text-amber-400" /> <span>{property.max_guests} guests</span></div>
                                        <div className="flex items-center gap-2"><Bed className="w-5 h-5 text-amber-500 dark:text-amber-400" /> <span>{property.bedrooms || 1} bedroom(s)</span></div>
                                        <div className="flex items-center gap-2"><Bath className="w-5 h-5 text-amber-500 dark:text-amber-400" /> <span>{property.bathrooms || 1} bathroom(s)</span></div>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100">About this place</h3>
                                    <p className="text-slate-600 dark:text-slate-300 leading-relaxed">{property.description}</p>
                                </div>

                                <div className="mt-8">
                                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-4">What this place offers</h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        {property.amenities?.map((amenity) => (
                                            <div key={amenity} className="flex items-center gap-3">
                                                {React.createElement(amenityIcons[amenity] || Star, { className: "w-5 h-5 text-slate-600 dark:text-slate-300" })}
                                                <span className="text-slate-700 dark:text-slate-200 capitalize">{amenity.replace(/_/g, ' ')}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="mt-8">
                                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-4">Check-in & Check-out</h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                                            <Clock className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
                                            <div>
                                                <p className="text-xs text-slate-500 dark:text-slate-400">Check-in</p>
                                                <p className="font-semibold text-slate-900 dark:text-white">from 2:00 PM</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                                            <Clock className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
                                            <div>
                                                <p className="text-xs text-slate-500 dark:text-slate-400">Check-out</p>
                                                <p className="font-semibold text-slate-900 dark:text-white">by 12:00 PM</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="lg:col-span-1">
                                <Card className="bg-slate-50/80 border-slate-200 dark:border-slate-800 shadow-md rounded-2xl p-5 sm:p-6 lg:sticky lg:top-24">
                                    <div className="mb-6">
                                        <div className="text-3xl font-bold text-slate-900 dark:text-white">
                                            {currencySymbol}{property.price_per_night.toLocaleString()}
                                        </div>
                                        <div className="text-base text-slate-600 dark:text-slate-300 mt-1">per night</div>
                                        
                                        {property.caution_fee > 0 && (
                                            <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Shield className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                                    <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">Refundable Caution Fee</span>
                                                </div>
                                                <div className="text-xl font-bold text-amber-900 dark:text-amber-100">
                                                    {currencySymbol}{property.caution_fee.toLocaleString()}
                                                </div>
                                                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                                                    Fully refundable after checkout
                                                </p>
                                            </div>
                                        )}
                                    </div>

                                    {property.rating > 0 && (
                                        <div className="flex items-center gap-2 mb-6 pb-6 border-b border-slate-200 dark:border-slate-800">
                                            <Star className="w-5 h-5 text-amber-400 fill-current" />
                                            <span className="font-semibold text-slate-900 dark:text-white text-lg">{property.rating}</span>
                                            <span className="text-slate-500 dark:text-slate-400">({property.reviews_count})</span>
                                        </div>
                                    )}

                                    {!isAuthenticated ? (
                                        <Link to={`/login?from_url=${encodeURIComponent(window.location.href)}`}>
                                            <Button size="lg" className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold rounded-xl">
                                                Sign in to Book
                                            </Button>
                                        </Link>
                                    ) : pendingPaymentBooking ? (
                                        <Link to={`${createPageUrl('PaymentPage')}?${new URLSearchParams({
                                            booking_id: pendingPaymentBooking.id,
                                            total: String(pendingPaymentBooking.total_price || 0),
                                            property_title: property.title || '',
                                            guest_email: pendingPaymentBooking.guest_email || '',
                                        }).toString()}`}>
                                            <Button size="lg" className="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-semibold rounded-xl">
                                                Proceed to Payment
                                            </Button>
                                        </Link>
                                    ) : pendingApprovalBooking ? (
                                        <Link to={createPageUrl('Bookings')}>
                                            <Button size="lg" className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-semibold rounded-xl">
                                                Awaiting Admin Approval
                                            </Button>
                                        </Link>
                                    ) : (
                                        <Link to={createPageUrl(`Checkout?property=${property.id}`)}>
                                            <Button size="lg" className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold rounded-xl">
                                                Book Now
                                            </Button>
                                        </Link>
                                    )}

                                    <p className="text-xs text-center text-slate-500 dark:text-slate-400 mt-4">
                                        {!isAuthenticated
                                            ? 'Create an account or sign in to book.'
                                            : pendingPaymentBooking
                                                ? 'Your booking has been approved — complete payment to confirm.'
                                                : pendingApprovalBooking
                                                    ? "You have a pending request on this property — you'll be able to re-book once it's resolved."
                                                    : "You won't be charged yet"}
                                    </p>
                                </Card>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
