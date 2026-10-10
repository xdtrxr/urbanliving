import React from 'react';
import { Link } from 'react-router-dom';
import { Car } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { createPageUrl } from '@/utils';

// Shown on the driver pages to a signed-in user who has no driver profile.
// The pages are reachable by URL, so this is what a curious guest sees.
export default function DriverNotice() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardContent className="p-8 text-center">
          <Car className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
          <h1 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
            This page is for UrbanStays drivers
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">
            If you drive for us, ask the team to link this email to your driver profile.
            Your rides and pay appear here as soon as they do.
          </p>
          <Link to={createPageUrl('Dashboard')}>
            <Button className="rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
              Back to my dashboard
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
