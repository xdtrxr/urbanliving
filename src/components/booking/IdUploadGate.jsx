import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, ShieldCheck, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import { UploadFile } from '@/integrations/Core';
import { base44 } from '@/api/base44Client';

// Hard gate shown immediately after payment success. The user picks an ID type,
// uploads a photo/scan, and we stamp { id_document_url, id_document_type,
// id_uploaded_at } on the Booking before they can move on. Required by
// HOMESHARES KYC policy for short-let bookings.
//
// Accepted file types: image/* and application/pdf. Max ~10 MB.

const ID_TYPES = [
  { value: 'national_id', label: 'Nigerian National ID (NIN)' },
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'passport', label: 'International Passport' },
  { value: 'voters_card', label: "Voter's Card (PVC)" },
  { value: 'other', label: 'Other government-issued ID' },
];

const MAX_BYTES = 10 * 1024 * 1024;

export default function IdUploadGate({ bookingId, onComplete }) {
  const [idType, setIdType] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  // Tracks whether we're still checking past bookings for an existing ID.
  // Keeps the gate from flashing into view if we're about to skip it.
  const [reusing, setReusing] = useState(true);
  const fileInputRef = useRef(null);

  // If the guest uploaded an ID on a previous booking, reuse it: copy the
  // {id_document_url, id_document_type} forward onto this booking, then close
  // the gate. Guest never sees the upload form for subsequent bookings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await base44.auth.me();
        if (!me?.email) {
          if (!cancelled) setReusing(false);
          return;
        }
        const prior = await base44.entities.Booking.filter(
          { guest_email: me.email },
          '-id_uploaded_at',
          50,
        );
        const withId = (prior || []).find(
          (b) => b.id_document_url && b.id !== bookingId,
        );
        if (!withId) {
          if (!cancelled) setReusing(false);
          return;
        }
        await base44.entities.Booking.update(bookingId, {
          id_document_url: withId.id_document_url,
          id_document_type: withId.id_document_type,
          id_uploaded_at: new Date().toISOString(),
        });
        if (!cancelled) {
          setDone(true);
          setTimeout(() => onComplete?.(), 600);
        }
      } catch (err) {
        console.warn('IdUploadGate reuse check failed (showing upload form):', err);
        if (!cancelled) setReusing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId, onComplete]);

  const handleFileChange = (e) => {
    setError(null);
    const f = e.target.files?.[0] || null;
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('File is too large. Max 10 MB.');
      setFile(null);
      e.target.value = '';
      return;
    }
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') {
      setError('Please upload an image (JPG/PNG) or a PDF.');
      setFile(null);
      e.target.value = '';
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    setError(null);
    if (!idType) {
      setError('Pick the type of ID you are uploading.');
      return;
    }
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    setUploading(true);
    try {
      const { file_url } = await UploadFile({ file });
      if (!file_url) throw new Error('Upload did not return a URL');
      await base44.entities.Booking.update(bookingId, {
        id_document_url: file_url,
        id_document_type: idType,
        id_uploaded_at: new Date().toISOString(),
      });
      setDone(true);
      // Brief success state so the user sees confirmation, then hand control back.
      setTimeout(() => onComplete?.(), 800);
    } catch (err) {
      console.error('ID upload failed:', err);
      setError(err?.message || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  if (done) {
    return (
      <Card className="bg-emerald-50 border-emerald-200 rounded-2xl">
        <CardContent className="p-6 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-2" />
          <p className="font-semibold text-emerald-900">ID received — thanks!</p>
          <p className="text-sm text-emerald-800 mt-1">Taking you to your bookings…</p>
        </CardContent>
      </Card>
    );
  }

  // Brief loading state while we check past bookings for an ID we can reuse.
  // Skipped quickly when there's none — the user sees the upload form normally.
  if (reusing) {
    return (
      <Card className="bg-white border-slate-200 rounded-2xl shadow-md">
        <CardContent className="p-6 text-center">
          <Loader2 className="w-6 h-6 text-slate-500 mx-auto mb-2 animate-spin" />
          <p className="text-sm text-slate-600">Checking your account for an ID on file…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white border-slate-200 rounded-2xl shadow-md">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-5 h-5 text-amber-700" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">One last step — verify your ID</h3>
            <p className="text-sm text-slate-600 mt-1">
              For your safety and the host's, we need a clear photo or scan of a government-issued ID
              before you can check in. Takes ~30 seconds.
            </p>
          </div>
        </div>

        <div>
          <Label htmlFor="id-type" className="text-sm">ID type</Label>
          <Select value={idType} onValueChange={setIdType} disabled={uploading}>
            <SelectTrigger id="id-type" className="h-11 rounded-xl mt-1">
              <SelectValue placeholder="Select ID type" />
            </SelectTrigger>
            <SelectContent>
              {ID_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="id-file" className="text-sm">Upload file</Label>
          <input
            ref={fileInputRef}
            id="id-file"
            type="file"
            accept="image/*,application/pdf"
            onChange={handleFileChange}
            disabled={uploading}
            className="block w-full mt-1 text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-slate-900 file:text-white file:text-sm file:font-medium hover:file:bg-slate-800 file:cursor-pointer"
          />
          {file && (
            <p className="text-xs text-slate-500 mt-1">
              Selected: <span className="font-medium text-slate-700">{file.name}</span> ({(file.size / 1024).toFixed(0)} KB)
            </p>
          )}
          <p className="text-xs text-slate-500 mt-1">JPG, PNG, or PDF — max 10 MB.</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <Button
          onClick={submit}
          disabled={uploading || !idType || !file}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-6 text-base font-semibold"
        >
          {uploading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
          ) : (
            <><Upload className="w-4 h-4 mr-2" /> Submit ID and continue</>
          )}
        </Button>

        <p className="text-xs text-slate-500 text-center">
          Your ID is encrypted and visible only to UrbanStays staff. Required by HOMESHARES policy.
        </p>
      </CardContent>
    </Card>
  );
}
