
import React, { useState, useEffect, useCallback } from 'react';
import { Booking } from '@/entities/Booking';
import { Property } from '@/entities/Property';
import { Trip } from '@/entities/Trip';
import { ItineraryItem } from '@/entities/ItineraryItem';
import { User } from '@/entities/User';
import AIGenerationPanel from '../components/trips/AIGenerationPanel';
import ItineraryDisplay from '../components/trips/ItineraryDisplay';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { DragDropContext } from '@hello-pangea/dnd';
import { format } from 'date-fns';

// Helper function to validate system-generated IDs
const isValidSystemId = (id) => {
    return id && typeof id === 'string' && id.length > 20 && !id.startsWith("prop_");
};

export default function TripPlannerPage() {
    const navigate = useNavigate();
    const urlParams = new URLSearchParams(window.location.search);
    const bookingId = urlParams.get('booking_id');
    const tripIdFromUrl = urlParams.get('trip_id');

    const [user, setUser] = useState(null);
    const [booking, setBooking] = useState(null);
    const [property, setProperty] = useState(null);
    const [trip, setTrip] = useState(null);
    const [itineraryItems, setItineraryItems] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null); // Add error state
    const [isGenerating, setIsGenerating] = useState(false); // New state for AI generation

    // DND sensors are removed as they are not used by @hello-pangea/dnd

    const loadTripData = useCallback(async () => {
        setIsLoading(true);
        setError(null); // Reset error on new load
        try {
            const currentUser = await User.me();
            setUser(currentUser);

            let currentTrip;
            let currentBooking;
            
            if (tripIdFromUrl) {
                const trips = await Trip.filter({ id: tripIdFromUrl });
                if (trips.length > 0) {
                    currentTrip = trips[0];
                    setTrip(currentTrip);
                    const bookings = await Booking.filter({id: currentTrip.booking_id});
                    if(bookings.length > 0) currentBooking = bookings[0];
                }
            } else if (bookingId) {
                const bookings = await Booking.filter({ id: bookingId });
                if (bookings.length > 0) {
                    currentBooking = bookings[0];
                    
                    if (!isValidSystemId(currentBooking.property_id)) {
                        setError(`This booking is linked to an invalid property ID ('${currentBooking.property_id}'). A trip cannot be planned.`);
                        setIsLoading(false);
                        return;
                    }

                    // Check if a trip already exists for this booking
                    const existingTrips = await Trip.filter({ booking_id: bookingId });
                    if (existingTrips.length > 0) {
                        currentTrip = existingTrips[0];
                    } else {
                        // Create a new trip if one doesn't exist
                        const propertyData = await Property.filter({ id: currentBooking.property_id });
                        if (propertyData.length === 0) {
                            setError("The property for this booking could not be found. It may have been deleted.");
                            setIsLoading(false);
                            return;
                        }
                        
                        const prop = propertyData[0];
                        currentTrip = await Trip.create({
                            name: `Trip to ${prop.location.city}`,
                            booking_id: bookingId,
                            start_date: currentBooking.check_in,
                            end_date: currentBooking.check_out,
                            preferences: {
                                pace: 'moderate',
                                interests: [],
                                budget: 'moderate',
                            },
                        });
                    }
                    setTrip(currentTrip);
                    // navigate to the planner with the trip_id to have a stable URL
                    navigate(createPageUrl(`TripPlanner?trip_id=${currentTrip.id}`), { replace: true });
                }
            }
            
            setBooking(currentBooking);

            if (currentBooking) {
                if (!isValidSystemId(currentBooking.property_id)) {
                    // This case is handled above, but as a safeguard:
                    if(!error) setError(`This booking is linked to an invalid property ID ('${currentBooking.property_id}').`);
                } else {
                    const properties = await Property.filter({ id: currentBooking.property_id });
                    if (properties.length > 0) {
                        setProperty(properties[0]);
                    } else {
                        if(!error) setError("Could not find the property associated with this trip.");
                    }
                }
            }

            if (currentTrip) {
                const items = await ItineraryItem.filter({ trip_id: currentTrip.id }, 'date,start_time');
                setItineraryItems(items);
            }
        } catch (err) {
            console.error("Error loading trip data:", err);
            setError("An unexpected error occurred while loading your trip data. Please try again later.");
        }
        setIsLoading(false);
    }, [bookingId, tripIdFromUrl, navigate, error]);

    useEffect(() => {
        loadTripData();
    }, [loadTripData]);

    const handleOnDragEnd = (result) => {
        if (!result.destination) return;

        const { source, destination } = result;

        // Create a mutable copy of itineraryItems
        const currentItems = [...itineraryItems];

        // Group items by date for easier manipulation
        const grouped = currentItems.reduce((acc, item) => {
            // Ensure the date is in a consistent format for grouping
            const dateKey = item.date ? format(new Date(item.date), 'yyyy-MM-dd') : 'no-date';
            if (!acc[dateKey]) acc[dateKey] = [];
            acc[dateKey].push(item);
            return acc;
        }, {});

        const sourceListId = source.droppableId;
        const destinationListId = destination.droppableId;

        const sourceList = grouped[sourceListId] || [];
        
        // Remove the dragged item from its source list
        const [movedItem] = sourceList.splice(source.index, 1);

        if (sourceListId === destinationListId) {
            // Reordering within the same list
            sourceList.splice(destination.index, 0, movedItem);
        } else {
            // Moving to a different list
            const destList = grouped[destinationListId] || [];
            
            // Update the date of the moved item
            movedItem.date = destinationListId; // This assumes droppableId is the date in 'yyyy-MM-dd' format
            
            destList.splice(destination.index, 0, movedItem);
            grouped[destinationListId] = destList; // Ensure the destination list is updated in grouped object
        }
        
        // Flatten groups back into a single sorted array
        // Sort by date, then by start_time
        const newItineraryItems = Object.keys(grouped)
            .sort() // Sort dates chronologically
            .reduce((acc, key) => {
                const dayItems = grouped[key] || [];
                // Sort items within each day by start_time
                dayItems.sort((a, b) => {
                    if (a.start_time && b.start_time) {
                        return a.start_time.localeCompare(b.start_time);
                    }
                    if (a.start_time) return -1;
                    if (b.start_time) return 1;
                    return 0;
                });
                return acc.concat(dayItems);
            }, []);
        
        setItineraryItems(newItineraryItems);
        // Note: This change is only in the local state and will reset on page load.
        // A backend update would be needed to persist the new order (e.g., updating date/time or order index).
    };
    
    // Adapted from handleItineraryGenerated based on the outline's prop name change
    const handleAIGenerate = async () => {
        setIsGenerating(true);
        // After bulk create in AIGenerationPanel, we just need to reload
        await loadTripData();
        setIsGenerating(false);
    };
    
    if (isLoading) {
        return <div className="p-8">Loading your trip plan...</div>;
    }

    if (error) {
        return (
            <div className="p-8">
                <h2 className="text-2xl font-bold text-red-600 mb-4">Could not load Trip Planner</h2>
                <p className="text-red-800 bg-red-100 p-4 rounded-lg">{error}</p>
                 <div className="mt-6">
                    <Link to={createPageUrl("Trips")} className="inline-flex items-center text-sm font-semibold text-slate-600 hover:text-slate-900">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to All Trips
                    </Link>
                </div>
            </div>
        );
    }
    
    if (!trip || !booking || !property) {
        return (
             <div className="p-8">
                <h2 className="text-2xl font-bold text-slate-800 mb-4">Trip Details Not Found</h2>
                <p className="text-slate-600">We could not find all the details for the requested trip. It might be incomplete or the associated booking may no longer be valid.</p>
                <div className="mt-6">
                    <Link to={createPageUrl("Trips")} className="inline-flex items-center text-sm font-semibold text-slate-600 hover:text-slate-900">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to All Trips
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
            <div className="p-4 md:p-8">
                <div className="mb-6">
                    <Link to={createPageUrl("Trips")} className="inline-flex items-center text-sm font-semibold text-slate-600 hover:text-slate-900">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to All Trips
                    </Link>
                </div>

                <header className="mb-8">
                    <h1 className="text-4xl font-bold text-slate-900">{trip.name}</h1>
                    <p className="text-lg text-slate-600">
                        Your personalized itinerary for {property.location.city}, {property.location.country}.
                    </p>
                </header>
                
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-1">
                        <AIGenerationPanel
                            onGenerate={handleAIGenerate}
                            trip={trip}
                            booking={booking}
                            isLoading={isGenerating}
                        />
                    </div>
                    <div className="lg:col-span-2">
                        <DragDropContext onDragEnd={handleOnDragEnd}>
                            <ItineraryDisplay itineraryItems={itineraryItems} />
                        </DragDropContext>
                    </div>
                </div>
            </div>
        </div>
    );
}
