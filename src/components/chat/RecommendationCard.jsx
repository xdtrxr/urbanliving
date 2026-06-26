import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, Wallet, Sparkles, ImageIcon, ExternalLink, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

// onCheckAvailability is invoked with the recommendation when the user taps
// the green button. The chat handler turns that into a follow-up user message
// so Nova can emit confirm_booking on the next turn (uses dates+guests from
// the captured lead via closure).
export default function RecommendationCard({ recommendation, onCheckAvailability }) {
  return (
    <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800/80 rounded-2xl shadow-lg overflow-hidden w-full max-w-sm mx-auto">
      <CardHeader className="p-0">
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="relative"
        >
          {recommendation.imageUrl ? (
            <img
              src={recommendation.imageUrl}
              alt={recommendation.property_title}
              className="w-full h-56 object-cover"
            />
          ) : (
            <div className="w-full h-56 bg-slate-200 dark:bg-slate-800 flex flex-col items-center justify-center">
              <ImageIcon className="w-16 h-16 text-slate-400 dark:text-slate-500" />
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">Image not available</p>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        </motion.div>
        <div className="absolute top-3 right-3">
          <Badge className="bg-amber-400/90 text-slate-900 dark:text-white font-semibold flex items-center gap-1.5 shadow-lg">
            <Sparkles className="w-3.5 h-3.5" />
            AI Pick
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-5">
        <div className="space-y-3">
          <CardTitle className="text-lg font-bold text-slate-900 dark:text-white leading-tight">
            {recommendation.property_title}
          </CardTitle>
          
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <MapPin className="w-4 h-4 flex-shrink-0" />
            <span>{recommendation.location}</span>
          </div>

          <div className="flex items-center justify-between text-sm">
            <Badge variant="secondary" className="font-medium">{recommendation.property_type}</Badge>
            <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
              <Wallet className="w-4 h-4 text-green-600" />
              <span>₦{Number(recommendation.price_per_night || 0).toLocaleString()}</span>
            </div>
          </div>
          
          <div>
            <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-2">Why you'll love it:</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
              {recommendation.perfect_for}
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="p-5 pt-0 flex flex-col gap-2">
        {onCheckAvailability && (
          <Button
            onClick={() => onCheckAvailability(recommendation)}
            className="w-full bg-green-600 hover:bg-green-700 text-white shadow-sm"
          >
            <Calendar className="w-4 h-4 mr-2" />
            Check Availability
          </Button>
        )}
        <Link to={createPageUrl(`Property?id=${recommendation.property_id}`)} className="w-full">
          <Button variant="outline" className="w-full">
            <ExternalLink className="w-4 h-4 mr-2" />
            View Property
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
}