import React, { useState, useEffect } from 'react';
import { Trip } from '@/entities/Trip';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight, Plus, Calendar, Compass } from 'lucide-react';
import { format } from 'date-fns';

export default function TripsPage() {
    const [trips, setTrips] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadTrips();
    }, []);

    const loadTrips = async () => {
        setIsLoading(true);
        try {
            // Assuming trips are associated with the logged-in user (created_by)
            const userTrips = await Trip.list('-start_date');
            setTrips(userTrips);
        } catch (error) {
            console.error("Failed to load trips:", error);
        }
        setIsLoading(false);
    };

    if (isLoading) {
        return (
            <div className="p-4 md:p-8">
                <div className="animate-pulse space-y-6">
                    <div className="h-8 bg-slate-200 rounded-lg w-1/3" />
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div className="h-40 bg-slate-200 rounded-2xl" />
                        <div className="h-40 bg-slate-200 rounded-2xl" />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-slate-900">My Trips</h1>
                    <p className="text-slate-600">Your planned adventures and itineraries.</p>
                </div>
                <Link to={createPageUrl("Bookings")}>
                    <Button>
                        <Plus className="w-4 h-4 mr-2" />
                        Plan New Trip from Booking
                    </Button>
                </Link>
            </div>

            {trips.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {trips.map(trip => (
                        <Link to={createPageUrl(`TripPlanner?trip_id=${trip.id}`)} key={trip.id}>
                            <Card className="group hover:shadow-xl hover:border-amber-400 transition-all duration-300 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl">
                                <CardHeader>
                                    <CardTitle className="text-xl font-bold text-slate-900 group-hover:text-amber-600 transition-colors">
                                        {trip.name}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex items-center gap-2 text-slate-600 mb-4">
                                        <Calendar className="w-4 h-4" />
                                        <span>{format(new Date(trip.start_date), 'MMM d, yyyy')}</span>
                                        <ArrowRight className="w-4 h-4" />
                                        <span>{format(new Date(trip.end_date), 'MMM d, yyyy')}</span>
                                    </div>
                                    <div className="flex justify-end">
                                        <Button variant="outline" size="sm">
                                            View Plan <ArrowRight className="w-4 h-4 ml-2" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </Link>
                    ))}
                </div>
            ) : (
                <Card className="text-center p-12 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl">
                    <Compass className="w-16 h-16 mx-auto text-slate-400 mb-4" />
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">No Trips Planned Yet</h2>
                    <p className="text-slate-600 mb-6">Start by making a booking, then you can create a personalized itinerary here.</p>
                    <Link to={createPageUrl("Search")}>
                        <Button size="lg">Find Your Next Stay</Button>
                    </Link>
                </Card>
            )}
        </div>
    );
}