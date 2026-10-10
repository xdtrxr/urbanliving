import React, { useState, useEffect, useRef } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ImagePlus, X, AlertCircle, Flag } from 'lucide-react';
import { UploadFile } from '@/api/integrations';
import { invokeFn } from '@/lib/invokeFn';
import { fromThrown } from '@/lib/fnResult';
import { REPORT_CATEGORIES, REPORT_LIMITS } from '@/config/rides';

// RideReportDialog — one party to a ride tells the team about a problem with
// the other. The same form serves both sides; only the wording changes.
//
// The server decides everything that matters (who may report, when, how
// often): see createRideReport. This form only collects the three things it
// asks for and shows the server's own sentence if it says no.

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// The words on each chip. The values are the server's; a category this map
// has no words for still shows, as its value, rather than disappearing.
const CATEGORY_WORDS = {
  driver: {
    rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe behaviour',
    no_show: 'Did not show up', damage: 'Damaged the car', other: 'Something else',
  },
  guest: {
    rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe driving',
    no_show: 'Driver did not show up', damage: 'Damage or loss', other: 'Something else',
  },
};

const COPY = {
  driver: {
    title: 'Report this customer',
    intro: 'Tell us what happened. Only the UrbanStays team sees this, and reporting never affects your pay for the ride.',
    placeholder: 'What did the customer do or say? When, and where?',
  },
  guest: {
    title: 'Report a problem with this driver',
    intro: 'Tell us what happened. Only the UrbanStays team sees this.',
    placeholder: 'What happened on the ride? When, and where?',
  },
};

export default function RideReportDialog({ open, ride, role, onClose, onSubmitted }) {
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // A clean form each time it opens, whichever ride it opens for.
  const rideId = ride?.id;
  useEffect(() => {
    if (!open) return;
    setCategory('');
    setDescription('');
    setPhotos([]);
    setError(null);
  }, [open, rideId]);

  const side = role === 'driver' ? 'driver' : 'guest';
  const copy = COPY[side];
  const text = description.trim();
  const tooShort = text.length < REPORT_LIMITS.minDescription;
  const busy = uploading || submitting;
  const canSubmit = !!category && !tooShort && text.length <= REPORT_LIMITS.maxDescription && !busy;

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Photos only. Choose a JPG or PNG.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('That photo is over 10 MB. Choose a smaller one.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { file_url } = await UploadFile({ file });
      if (!file_url) throw new Error('The upload did not return a link.');
      setPhotos((list) => (list.includes(file_url) ? list : [...list, file_url]).slice(0, REPORT_LIMITS.maxPhotos));
    } catch (err) {
      // Show the platform's own reason: an exhausted upload quota will not
      // succeed on a retry, and "please try again" would be a lie.
      setError(`The photo could not be uploaded: ${fromThrown(err).error}`);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!canSubmit || !ride) return;
    setSubmitting(true);
    setError(null);
    const r = await invokeFn('createRideReport', {
      ride_booking_id: ride.id,
      category,
      description: text,
      evidence_urls: photos,
    });
    setSubmitting(false);
    if (r.ok) {
      onSubmitted?.('sent');
    } else if (r.code === 'ALREADY_REPORTED') {
      onSubmitted?.('already');
    } else {
      setError(r.error);
    }
  };

  return (
    <Dialog open={!!open} onOpenChange={(o) => { if (!o && !busy) onClose?.(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="w-4 h-4 text-red-600 dark:text-red-400" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>
            {[ride?.vehicle_name, ride?.booking_reference].filter(Boolean).join(' · ')}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-slate-600 dark:text-slate-300">{copy.intro}</p>

        <div>
          <Label>What kind of problem was it?</Label>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="What kind of problem was it?">
            {REPORT_CATEGORIES.map((value) => {
              const chosen = category === value;
              return (
                <button
                  key={value} type="button" role="radio" aria-checked={chosen}
                  onClick={() => setCategory(value)}
                  className={`px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
                    chosen
                      ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500'
                  }`}
                >
                  {CATEGORY_WORDS[side][value] || value}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label htmlFor="rr-description">What happened?</Label>
          <Textarea
            id="rr-description" rows={5} value={description} maxLength={REPORT_LIMITS.maxDescription}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={copy.placeholder} className="mt-1 rounded-xl"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {tooShort
              ? `At least ${REPORT_LIMITS.minDescription} characters.`
              : `${text.length} of ${REPORT_LIMITS.maxDescription} characters.`}
          </p>
        </div>

        <div>
          <Label>Photos, if you have any</Label>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {photos.map((url) => (
              <div key={url} className="relative">
                <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover border border-slate-200 dark:border-slate-800" />
                <button
                  type="button" aria-label="Remove photo"
                  onClick={() => setPhotos((list) => list.filter((u) => u !== url))}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {photos.length < REPORT_LIMITS.maxPhotos && (
              <>
                <input ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} className="hidden" id="rr-photo" />
                <Button
                  type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => fileRef.current?.click()} className="rounded-xl"
                >
                  {uploading
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
                    : <><ImagePlus className="w-4 h-4 mr-2" /> Add a photo</>}
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Up to {REPORT_LIMITS.maxPhotos} photos, 10 MB each.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3" role="alert">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onClose?.()} disabled={busy} className="rounded-xl">
            Cancel
          </Button>
          <Button
            onClick={submit} disabled={!canSubmit}
            className="rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Send report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
