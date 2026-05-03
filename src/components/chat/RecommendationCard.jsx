import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, DollarSign, Sparkles, ImageIcon, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function RecommendationCard({ recommendation }) {
  return (
    <Card className="bg-white border-slate-200/80 rounded-2xl shadow-lg overflow-hidden w-full max-w-sm mx-auto">
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
            <div className="w-full h-56 bg-slate-200 flex flex-col items-center justify-center">
              <ImageIcon className="w-16 h-16 text-slate-400" />
              <p className="text-sm text-slate-500 mt-2">Image not available</p>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        </motion.div>
        <div className="absolute top-3 right-3">
          <Badge className="bg-amber-400/90 text-slate-900 font-semibold flex items-center gap-1.5 shadow-lg">
            <Sparkles className="w-3.5 h-3.5" />
            AI Pick
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-5">
        <div className="space-y-3">
          <CardTitle className="text-lg font-bold text-slate-900 leading-tight">
            {recommendation.property_title}
          </CardTitle>
          
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <MapPin className="w-4 h-4 flex-shrink-0" />
            <span>{recommendation.location}</span>
          </div>

          <div className="flex items-center justify-between text-sm">
            <Badge variant="secondary" className="font-medium">{recommendation.property_type}</Badge>
            <div className="flex items-center gap-1.5 font-semibold text-slate-800">
              <DollarSign className="w-4 h-4 text-green-600" />
              <span>{recommendation.price_per_night}</span>
            </div>
          </div>
          
          <div>
            <h4 className="font-semibold text-slate-800 text-sm mb-2">Why you'll love it:</h4>
            <p className="text-sm text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200/80">
              {recommendation.perfect_for}
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="p-5 pt-0">
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