import React, { useState } from 'react';
import { InvokeLLM } from "@/integrations/Core";
import { ItineraryItem } from '@/entities/ItineraryItem';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from "@/components/ui/checkbox";
import { Sparkles } from 'lucide-react';

const interestOptions = [
    { id: "art_culture", label: "Art & Culture" },
    { id: "history", label: "History & Museums" },
    { id: "foodie", label: "Food & Dining" },
    { id: "nightlife", label: "Nightlife & Bars" },
    { id: "nature_outdoors", label: "Nature & Outdoors" },
    { id: "shopping", label: "Shopping" },
    { id: "relaxation", label: "Relaxation" },
    { id: "family_friendly", label: "Family Friendly" },
];

export default function AIGenerationPanel({ trip, user, property, onItineraryGenerated }) {
    const [preferences, setPreferences] = useState(trip.preferences || {
        pace: 'moderate',
        interests: [],
        budget: 'moderate',
    });
    const [isLoading, setIsLoading] = useState(false);

    const handleInterestChange = (interestId, checked) => {
        setPreferences(prev => {
            const newInterests = checked
                ? [...prev.interests, interestId]
                : prev.interests.filter(i => i !== interestId);
            return { ...prev, interests: newInterests };
        });
    };

    const handleGenerateItinerary = async () => {
        setIsLoading(true);

        const prompt = `
            You are an expert travel agent creating a personalized itinerary.
            **Trip Details:**
            - Destination: ${property.location.city}, ${property.location.country}
            - Dates: From ${trip.start_date} to ${trip.end_date}
            - Accommodation Address (for proximity reference): ${property.location.address}

            **User Preferences:**
            - Trip Pace: ${preferences.pace}
            - Budget: ${preferences.budget}
            - Key Interests: ${preferences.interests.join(', ') || 'general sightseeing'}
            - User's General Travel Style (from profile): ${user.travel_style || 'not specified'}
            - User's General Interests (from profile): ${user.interests || 'not specified'}

            **Task:**
            Generate a detailed, day-by-day itinerary. For each day, suggest 2-4 activities or dining options. 
            The itinerary should be logically sequenced and geographically considerate.
            For each item, provide a title, a short description, category, date, start time, end time, location address, and a cost estimate.
            Ensure the generated dates fall strictly between ${trip.start_date} and ${trip.end_date}.
            Return the response as a JSON object containing a single key "itinerary", which is an array of items.
        `;

        try {
            const response = await InvokeLLM({
                prompt,
                add_context_from_internet: true,
                response_json_schema: {
                    type: "object",
                    properties: {
                        itinerary: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    title: { type: "string" },
                                    description: { type: "string" },
                                    category: { type: "string", enum: ["dining", "activity", "sightseeing", "work", "transport", "other"] },
                                    date: { type: "string", format: "date" },
                                    start_time: { type: "string" },
                                    end_time: { type: "string" },
                                    location_address: { type: "string" },
                                    cost_estimate: { type: "string" }
                                },
                                required: ["title", "category", "date", "start_time"]
                            }
                        }
                    },
                    required: ["itinerary"]
                }
            });

            if (response && response.itinerary && response.itinerary.length > 0) {
                // Clear existing items for this trip before adding new ones
                const existingItems = await ItineraryItem.filter({ trip_id: trip.id });
                for(const item of existingItems) {
                    await ItineraryItem.delete(item.id);
                }

                const newItems = response.itinerary.map(item => ({
                    ...item,
                    trip_id: trip.id
                }));
                await ItineraryItem.bulkCreate(newItems);
                onItineraryGenerated();
            }
        } catch (error) {
            console.error("Failed to generate itinerary:", error);
            // You might want to show an error message to the user here
        }

        setIsLoading(false);
    };

    return (
        <Card className="sticky top-8 bg-white/95 backdrop-blur-sm border-slate-200 shadow-xl rounded-2xl">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                    <Sparkles className="w-5 h-5 text-amber-500" />
                    AI Trip Planner
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
                <div>
                    <Label className="font-semibold">Trip Pace</Label>
                    <Select value={preferences.pace} onValueChange={(value) => setPreferences({...preferences, pace: value})}>
                        <SelectTrigger className="mt-2 rounded-xl">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="relaxed">Relaxed</SelectItem>
                            <SelectItem value="moderate">Moderate</SelectItem>
                            <SelectItem value="fast_paced">Fast-Paced</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div>
                    <Label className="font-semibold">Interests</Label>
                    <div className="mt-2 space-y-2">
                        {interestOptions.map(interest => (
                            <div key={interest.id} className="flex items-center space-x-2">
                                <Checkbox
                                    id={interest.id}
                                    checked={preferences.interests.includes(interest.id)}
                                    onCheckedChange={(checked) => handleInterestChange(interest.id, checked)}
                                />
                                <Label htmlFor={interest.id} className="text-sm text-slate-600 font-normal">
                                    {interest.label}
                                </Label>
                            </div>
                        ))}
                    </div>
                </div>

                <div>
                    <Label className="font-semibold">Budget</Label>
                    <Select value={preferences.budget} onValueChange={(value) => setPreferences({...preferences, budget: value})}>
                        <SelectTrigger className="mt-2 rounded-xl">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="budget">Budget-Friendly</SelectItem>
                            <SelectItem value="moderate">Moderate</SelectItem>
                            <SelectItem value="luxury">Luxury</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <Button onClick={handleGenerateItinerary} disabled={isLoading} className="w-full text-lg py-6">
                    {isLoading ? "Generating..." : "Generate Itinerary"}
                </Button>
            </CardContent>
        </Card>
    );
}