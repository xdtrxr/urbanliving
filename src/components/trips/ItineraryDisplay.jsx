
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
    Utensils, 
    Mountain, 
    Landmark, 
    Briefcase, 
    Bus, 
    Star, 
    Clock, 
    MapPin,
    DollarSign,
    GripVertical // Corrected from GrabVertical
} from 'lucide-react';
import { format } from 'date-fns';
import { Droppable, Draggable } from '@hello-pangea/dnd'; // Added for drag and drop

const categoryIcons = {
    dining: <Utensils className="w-5 h-5" />,
    activity: <Mountain className="w-5 h-5" />,
    sightseeing: <Landmark className="w-5 h-5" />,
    work: <Briefcase className="w-5 h-5" />,
    transport: <Bus className="w-5 h-5" />,
    other: <Star className="w-5 h-5" />
};

const categoryColors = {
    dining: "bg-orange-100 text-orange-800",
    activity: "bg-green-100 text-green-800",
    sightseeing: "bg-blue-100 text-blue-800",
    work: "bg-purple-100 text-purple-800",
    transport: "bg-gray-100 text-gray-800",
    other: "bg-yellow-100 text-yellow-800"
};

export default function ItineraryDisplay({ itineraryItems }) {
    const groupedByDate = itineraryItems.reduce((acc, item) => {
        const date = format(new Date(item.date), 'yyyy-MM-dd');
        if (!acc[date]) {
            acc[date] = [];
        }
        acc[date].push(item);
        return acc;
    }, {});

    const sortedDates = Object.keys(groupedByDate).sort();

    if (itineraryItems.length === 0) {
        return (
            <Card className="text-center p-12 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl">
                <h2 className="text-2xl font-bold text-slate-900 mb-2">Your Itinerary is Empty</h2>
                <p className="text-slate-600">Use the AI Trip Planner to generate a personalized plan for your adventure!</p>
            </Card>
        );
    }

    return (
        <div className="space-y-8">
            {sortedDates.map(date => (
                <Droppable droppableId={date} key={date}>
                    {(provided) => (
                        <div
                            ref={provided.innerRef}
                            {...provided.droppableProps}
                        >
                            <h2 className="text-2xl font-bold text-slate-800 mb-4 pb-2 border-b-2 border-amber-400">
                                {format(new Date(date), "EEEE, MMMM d")}
                            </h2>
                            <div className="space-y-4">
                                {groupedByDate[date].map((item, index) => (
                                    <Draggable key={item.id} draggableId={item.id} index={index}>
                                        {(provided, snapshot) => (
                                            <div
                                                ref={provided.innerRef}
                                                {...provided.draggableProps}
                                                {...provided.dragHandleProps}
                                                className={`transition-shadow ${snapshot.isDragging ? 'shadow-2xl' : ''}`}
                                            >
                                                <Card className="bg-white/90 backdrop-blur-sm border-slate-200/60 shadow-md">
                                                    <CardContent className="p-4 flex items-start gap-4">
                                                        <div className={`p-3 rounded-full ${categoryColors[item.category] || categoryColors.other}`}>
                                                            {categoryIcons[item.category] || categoryIcons.other}
                                                        </div>
                                                        <div className="flex-1">
                                                            <h3 className="font-bold text-lg text-slate-900">{item.title}</h3>
                                                            <p className="text-sm text-slate-600 mt-1">{item.description}</p>
                                                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-sm text-slate-500">
                                                                <div className="flex items-center gap-1.5">
                                                                    <Clock className="w-4 h-4" />
                                                                    <span>{item.start_time} - {item.end_time}</span>
                                                                </div>
                                                                <div className="flex items-center gap-1.5">
                                                                    <MapPin className="w-4 h-4" />
                                                                    <span className="line-clamp-1">{item.location_address}</span>
                                                                </div>
                                                                {item.cost_estimate && (
                                                                    <div className="flex items-center gap-1.5">
                                                                        <DollarSign className="w-4 h-4" />
                                                                        <span>{item.cost_estimate}</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex flex-col items-end justify-between h-full">
                                                          <Badge className={`${categoryColors[item.category] || categoryColors.other} self-start capitalize`}>
                                                              {item.category}
                                                          </Badge>
                                                          <GripVertical className="text-slate-400 cursor-grab" />
                                                        </div>
                                                    </CardContent>
                                                </Card>
                                            </div>
                                        )}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                            </div>
                        </div>
                    )}
                </Droppable>
            ))}
        </div>
    );
}

