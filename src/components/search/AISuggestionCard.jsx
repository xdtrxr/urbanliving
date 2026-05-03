// This component is no longer needed since we're using PropertyCard for AI recommendations
// Keeping it for backwards compatibility but it won't be used
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Sparkles, 
  MapPin, 
  Star, 
  DollarSign, 
  CheckCircle, 
  Users,
  Navigation,
  Heart,
  Info,
  Lightbulb
} from "lucide-react";

export default function AISuggestionCard({ recommendation }) {
  // This component is deprecated - AI recommendations now use PropertyCard
  return null;
}