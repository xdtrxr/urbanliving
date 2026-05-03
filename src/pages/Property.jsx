
import React, { useState, useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Property as PropertyEntity } from '@/entities/Property';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
    MapPin, Users, Bed, Bath, Wifi, Car, Utensils, Star, Calendar, 
    ArrowLeft, Share2, Heart, PlayCircle, Image as ImageIcon, Shield 
} from 'lucide-react';
import { createPageUrl } from '@/utils';
import { AnimatePresence, motion } from 'framer-motion';

const amenityIcons = {
  wifi: Wifi,
  parking: Car,
  kitchen: Utensils,
};

const currencySymbols = {
  NGN: '₦',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$'
};

export default function PropertyPage() {
    const [property, setProperty] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [media, setMedia] = useState([]);
    const [selectedMedia, setSelectedMedia] = useState(null);
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
                } catch (error) {
                    console.error("Failed to fetch property:", error);
                }
            }
            setIsLoading(false);
        };

        loadProperty();
    }, [location.search]);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
                <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent"></div>
            </div>
        );
    }

    if (!property) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-8 text-center">
                <Card className="max-w-md w-full bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl p-12">
                    <h2 className="text-2xl font-bold text-slate-900 mb-4">Property Not Found</h2>
                    <p className="text-slate-600 mb-6">The property you're looking for doesn't exist or has been removed.</p>
                    <Link to={createPageUrl('Search')}>
                        <Button>Back to Search</Button>
                    </Link>
                </Card>
            </div>
        );
    }
    
    const currencySymbol = currencySymbols[property.currency] || '₦';

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <Link to={createPageUrl('Search')}>
                    <Button variant="ghost" className="mb-6 flex items-center gap-2 text-slate-600 hover:text-slate-900">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Search
                    </Button>
                </Link>

                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-6 md:p-8">
                    {/* Media Gallery */}
                    <div className="mb-8">
                        <div className="relative w-full aspect-video bg-slate-200 rounded-2xl overflow-hidden shadow-lg">
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
                                        className="w-full h-full object-cover"
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
                                        controls
                                        autoPlay
                                        muted
                                        loop
                                    >
                                        Your browser does not support the video tag.
                                    </motion.video>
                                )}
                            </AnimatePresence>
                        </div>
                        
                        {media.length > 1 && (
                            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3 mt-4">
                                {media.map((item, index) => (
                                    <button
                                        key={index}
                                        onClick={() => setSelectedMedia(item)}
                                        className={`relative aspect-square rounded-lg overflow-hidden ring-2 transition-all duration-200 ${selectedMedia.url === item.url ? 'ring-amber-500 ring-offset-2' : 'ring-transparent hover:ring-amber-300'}`}
                                    >
                                        <img src={item.type === 'image' ? item.url : 'https://static.thenounproject.com/png/11204-200.png'} alt={`${property.title} thumbnail ${index + 1}`} className="w-full h-full object-cover" />
                                        {item.type === 'video' && (
                                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                                <PlayCircle className="w-6 h-6 text-white" />
                                            </div>
                                        )}
                                        <div className={`absolute inset-0 transition-all duration-200 ${selectedMedia.url === item.url ? 'border-2 border-amber-500' : 'border-2 border-transparent'}`} />
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <CardHeader className="p-0 mb-6">
                        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                            <div>
                                <CardTitle className="text-3xl font-bold text-slate-900 mb-2">{property.title}</CardTitle>
                                <div className="flex items-center gap-2 text-slate-600">
                                    <MapPin className="w-5 h-5" />
                                    <span className="font-medium">{property.location?.city}, {property.location?.country}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                                <Button variant="outline" size="icon"><Share2 className="w-4 h-4" /></Button>
                                <Button variant="outline" size="icon" className="text-red-500"><Heart className="w-4 h-4 fill-current" /></Button>
                            </div>
                        </div>
                    </CardHeader>

                    <CardContent className="p-0">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                            <div className="lg:col-span-2">
                                <div className="border-b pb-6 mb-6">
                                    <div className="flex items-center gap-6 text-slate-700">
                                        <div className="flex items-center gap-2"><Users className="w-5 h-5 text-amber-500" /> <span>{property.max_guests} guests</span></div>
                                        <div className="flex items-center gap-2"><Bed className="w-5 h-5 text-amber-500" /> <span>{property.bedrooms || 1} bedroom(s)</span></div>
                                        <div className="flex items-center gap-2"><Bath className="w-5 h-5 text-amber-500" /> <span>{property.bathrooms || 1} bathroom(s)</span></div>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h3 className="font-bold text-xl text-slate-800">About this place</h3>
                                    <p className="text-slate-600 leading-relaxed">{property.description}</p>
                                </div>

                                <div className="mt-8">
                                    <h3 className="font-bold text-xl text-slate-800 mb-4">What this place offers</h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        {property.amenities?.map((amenity) => (
                                            <div key={amenity} className="flex items-center gap-3">
                                                {React.createElement(amenityIcons[amenity] || Star, { className: "w-5 h-5 text-slate-600" })}
                                                <span className="text-slate-700 capitalize">{amenity.replace(/_/g, ' ')}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="lg:col-span-1">
                                <Card className="bg-slate-50/80 border-slate-200 shadow-md rounded-2xl p-6 sticky top-24">
                                    <div className="mb-6">
                                        <div className="text-3xl font-bold text-slate-900">
                                            {currencySymbol}{property.price_per_night.toLocaleString()}
                                        </div>
                                        <div className="text-base text-slate-600 mt-1">per night</div>
                                        
                                        {property.caution_fee > 0 && (
                                            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Shield className="w-4 h-4 text-amber-600" />
                                                    <span className="text-sm font-semibold text-amber-900">Refundable Caution Fee</span>
                                                </div>
                                                <div className="text-xl font-bold text-amber-900">
                                                    {currencySymbol}{property.caution_fee.toLocaleString()}
                                                </div>
                                                <p className="text-xs text-amber-700 mt-1">
                                                    Fully refundable after checkout
                                                </p>
                                            </div>
                                        )}
                                    </div>

                                    {property.rating > 0 && (
                                        <div className="flex items-center gap-2 mb-6 pb-6 border-b border-slate-200">
                                            <Star className="w-5 h-5 text-amber-400 fill-current" />
                                            <span className="font-semibold text-slate-900 text-lg">{property.rating}</span>
                                            <span className="text-slate-500">({property.reviews_count})</span>
                                        </div>
                                    )}

                                    <Link to={createPageUrl(`Checkout?property=${property.id}`)}>
                                        <Button size="lg" className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold rounded-xl">
                                            Book Now
                                        </Button>
                                    </Link>

                                    <p className="text-xs text-center text-slate-500 mt-4">You won't be charged yet</p>
                                </Card>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
