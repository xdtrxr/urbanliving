import React, { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { UploadFile } from '@/api/integrations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus, List, Car, Image as ImageIcon, Video as VideoIcon, Trash2,
  Edit3, Save, X, AlertCircle, Loader2, CheckCircle2, Eye, EyeOff,
  Upload, PlayCircle,
} from 'lucide-react';
import {
  CITIES, CATEGORIES, categoryLabel, effectiveCategory, needsCategoryMigration,
  extraHourRate, markupFor,
} from '@/config/rides';

const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;


const FUEL_POLICIES = [
  { value: 'fuel_included', label: 'Fuel included' },
  { value: 'guest_pays_fuel', label: 'Guest pays for fuel' },
  { value: 'fuel_capped', label: 'Fuel capped (daily limit)' },
];

const AMENITY_OPTIONS = [
  { id: 'air_conditioning', label: 'Air conditioning' },
  { id: 'leather_seats', label: 'Leather seats' },
  { id: 'wifi', label: 'WiFi hotspot' },
  { id: 'child_seat', label: 'Child seat' },
  { id: 'bottled_water', label: 'Bottled water' },
  { id: 'sound_system', label: 'Premium sound' },
  { id: 'tinted_windows', label: 'Tinted windows' },
  { id: 'executive_partition', label: 'Executive partition' },
];

const EMPTY_FORM = {
  name: '',
  brand: '',
  category: 'comfort',
  model_year: new Date().getFullYear(),
  description: '',
  images: [],          // array of base44 file_urls, populated by UploadFile
  videos: [],
  city: CITIES[0],
  registration_number: '',
  price_per_hour_ngn: '',
  price_extra_hour_ngn: '',
  price_12hr_ngn: '',
  price_24hr_ngn: '',
  price_per_extra_day_ngn: '',
  max_passengers: 4,
  amenities: [],
  fuel_policy: 'fuel_included',
  fuel_cap_daily_ngn: '',
  pickup_locations: '',   // comma-separated
  service_area: '',
  active: true,
  admin_approved: true,    // admin adding a vehicle = trust that vehicle
  // 1, not 12 — the old default silently rejected every hourly booking.
  min_hours_per_booking: 1,
  turnaround_hours: 1,
};

// Internal cost structure, kept on a separate admin-only entity (VehicleCosting)
// because Vehicle rows are publicly readable and RLS is per-row: partner cost
// on the Vehicle would expose UrbanStays' margin to anyone with the API URL.
// The guest only ever sees the final price.
const EMPTY_COSTING = {
  partner_cost_per_hour_ngn: '',
  partner_cost_per_day_ngn: '',
  driver_cost_per_hour_ngn: '',
  driver_cost_per_day_ngn: '',
  notes: '',
};

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

// One row of the markup readout. Module scope, not defined inline in render,
// so React does not see a new component type on every keystroke.
function MarkupLine({ label, row }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      {row ? (
        <span className={`font-semibold ${row.markup < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'}`}>
          {ngn(row.price)} − {ngn(row.cost)} = {ngn(row.markup)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> ({row.pct}%)</span>
        </span>
      ) : (
        <span className="text-slate-400">—</span>
      )}
    </div>
  );
}

// Pull the platform's actual error text out of an upload failure so admin
// sees "integration limit reached — upgrade plan" instead of a generic
// message (a 402 quota error will never succeed on retry).
const uploadErrorText = (error) =>
  error?.response?.data?.message ||
  error?.data?.message ||
  error?.message ||
  'Unknown error';

const csvToArray = (raw) =>
  (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const arrayToCsv = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');

export default function VehiclesAdmin() {
  const [innerTab, setInnerTab] = useState('add');
  const [form, setForm] = useState(EMPTY_FORM);
  const [costing, setCosting] = useState(EMPTY_COSTING);
  // Id of the VehicleCosting row for the vehicle being edited, so save can
  // update rather than create a duplicate. Null on a fresh vehicle or when
  // no costing has been entered yet.
  const [costingRowId, setCostingRowId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [vehicleToDelete, setVehicleToDelete] = useState(null);
  const [error, setError] = useState(null);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [isUploadingVideos, setIsUploadingVideos] = useState(false);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);

  const loadVehicles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await base44.entities.Vehicle.list('-created_date', 200);
      setVehicles(rows || []);
    } catch (err) {
      console.error('Failed to load vehicles:', err);
      setError(err?.message || 'Failed to load vehicles');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setCosting(EMPTY_COSTING);
    setCostingRowId(null);
    setEditingId(null);
  };

  // Costing lives on its own entity, so it is fetched separately when a
  // vehicle is opened for editing. A read failure leaves the section blank
  // rather than blocking the edit — the customer-facing fields matter more.
  const loadCosting = async (vehicleId) => {
    setCosting(EMPTY_COSTING);
    setCostingRowId(null);
    try {
      const rows = await base44.entities.VehicleCosting.filter({ vehicle_id: vehicleId }, undefined, 1);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return;
      setCostingRowId(row.id);
      setCosting({
        partner_cost_per_hour_ngn: row.partner_cost_per_hour_ngn ?? '',
        partner_cost_per_day_ngn: row.partner_cost_per_day_ngn ?? '',
        driver_cost_per_hour_ngn: row.driver_cost_per_hour_ngn ?? '',
        driver_cost_per_day_ngn: row.driver_cost_per_day_ngn ?? '',
        notes: row.notes || '',
      });
    } catch (err) {
      console.warn('Could not load vehicle costing (non-fatal):', err);
    }
  };

  const startEdit = (vehicle) => {
    setEditingId(vehicle.id);
    loadCosting(vehicle.id);
    setForm({
      name: vehicle.name || '',
      brand: vehicle.brand || '',
      category: vehicle.category || 'comfort',
      model_year: vehicle.model_year || new Date().getFullYear(),
      description: vehicle.description || '',
      images: Array.isArray(vehicle.images) ? vehicle.images : [],
      videos: Array.isArray(vehicle.videos) ? vehicle.videos : [],
      city: vehicle.city || CITIES[0],
      registration_number: vehicle.registration_number || '',
      price_per_hour_ngn: vehicle.price_per_hour_ngn ?? '',
      price_extra_hour_ngn: vehicle.price_extra_hour_ngn ?? '',
      price_12hr_ngn: vehicle.price_12hr_ngn ?? '',
      price_24hr_ngn: vehicle.price_24hr_ngn ?? '',
      price_per_extra_day_ngn: vehicle.price_per_extra_day_ngn ?? '',
      max_passengers: vehicle.max_passengers ?? 4,
      amenities: vehicle.amenities || [],
      fuel_policy: vehicle.fuel_policy || 'fuel_included',
      fuel_cap_daily_ngn: vehicle.fuel_cap_daily_ngn ?? '',
      pickup_locations: arrayToCsv(vehicle.pickup_locations),
      service_area: vehicle.service_area || '',
      active: vehicle.active !== false,
      admin_approved: vehicle.admin_approved !== false,
      min_hours_per_booking: vehicle.min_hours_per_booking ?? 1,
      turnaround_hours: vehicle.turnaround_hours ?? 1,
    });
    setInnerTab('add');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const images = Array.isArray(form.images) ? form.images : [];
      if (images.length === 0) {
        throw new Error('Add at least one image.');
      }
      if (!form.price_12hr_ngn || !form.price_24hr_ngn) {
        throw new Error('Both 12-hour and 24-hour prices are required.');
      }

      // Shape matches Vehicle.jsonc — coerce numerics, drop empty strings.
      const payload = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        category: form.category,
        model_year: Number(form.model_year) || null,
        description: form.description.trim() || undefined,
        images,
        videos: Array.isArray(form.videos) ? form.videos : [],
        city: form.city,
        registration_number: form.registration_number.trim() || undefined,
        price_per_hour_ngn: form.price_per_hour_ngn === '' ? undefined : Number(form.price_per_hour_ngn),
        price_extra_hour_ngn: form.price_extra_hour_ngn === '' ? undefined : Number(form.price_extra_hour_ngn),
        price_12hr_ngn: Number(form.price_12hr_ngn),
        price_24hr_ngn: Number(form.price_24hr_ngn),
        price_per_extra_day_ngn: form.price_per_extra_day_ngn
          ? Number(form.price_per_extra_day_ngn)
          : undefined,
        max_passengers: Number(form.max_passengers) || 0,
        amenities: form.amenities,
        fuel_policy: form.fuel_policy,
        fuel_cap_daily_ngn:
          form.fuel_policy === 'fuel_capped' && form.fuel_cap_daily_ngn
            ? Number(form.fuel_cap_daily_ngn)
            : undefined,
        pickup_locations: csvToArray(form.pickup_locations),
        service_area: form.service_area.trim() || undefined,
        active: form.active,
        admin_approved: form.admin_approved,
        min_hours_per_booking: Number(form.min_hours_per_booking) || 1,
        turnaround_hours: form.turnaround_hours === '' ? 1 : Number(form.turnaround_hours),
        driver_included: true, // V1 always includes a driver
      };

      let vehicleId = editingId;
      if (editingId) {
        await base44.entities.Vehicle.update(editingId, payload);
      } else {
        const created = await base44.entities.Vehicle.create(payload);
        vehicleId = created?.id;
        // If the costing write below fails, the retry must update this
        // vehicle rather than create a second copy of it.
        setEditingId(vehicleId || null);
      }

      // Upsert the costing row. Only written when something was entered or a
      // row already exists, so vehicles with no internal costing never grow
      // an empty companion row.
      const num = (v) => (v === '' || v == null ? undefined : Number(v));
      const costingPayload = {
        vehicle_id: vehicleId,
        partner_cost_per_hour_ngn: num(costing.partner_cost_per_hour_ngn),
        partner_cost_per_day_ngn: num(costing.partner_cost_per_day_ngn),
        driver_cost_per_hour_ngn: num(costing.driver_cost_per_hour_ngn),
        driver_cost_per_day_ngn: num(costing.driver_cost_per_day_ngn),
        notes: costing.notes.trim() || undefined,
      };
      const hasCosting = Object.entries(costingPayload)
        .some(([k, v]) => k !== 'vehicle_id' && v !== undefined);
      if (vehicleId && (hasCosting || costingRowId)) {
        try {
          if (costingRowId) {
            await base44.entities.VehicleCosting.update(costingRowId, costingPayload);
          } else {
            await base44.entities.VehicleCosting.create(costingPayload);
          }
        } catch (err) {
          // The vehicle itself is saved; say so and leave the form open so
          // the costing can be retried without re-entering everything.
          console.error('Failed to save vehicle costing:', err);
          throw new Error(`Vehicle saved, but its internal costing did not: ${err?.message || 'unknown error'}. Edit it and save again.`);
        }
      }

      resetForm();
      await loadVehicles();
      setInnerTab('manage');
    } catch (err) {
      console.error('Failed to save vehicle:', err);
      setError(err?.message || 'Failed to save vehicle');
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!vehicleToDelete) return;
    setDeletingId(vehicleToDelete.id);
    try {
      await base44.entities.Vehicle.delete(vehicleToDelete.id);
      await loadVehicles();
    } catch (err) {
      console.error('Failed to delete vehicle:', err);
      alert(err?.message || 'Failed to delete vehicle');
    } finally {
      setDeletingId(null);
      setVehicleToDelete(null);
    }
  };

  const toggleAmenity = (id) => {
    setForm((prev) => {
      const has = prev.amenities.includes(id);
      return {
        ...prev,
        amenities: has
          ? prev.amenities.filter((a) => a !== id)
          : [...prev.amenities, id],
      };
    });
  };

  // Push each chosen file through base44's UploadFile and append the returned
  // file_urls to the form. We never block on a single failure — bad files are
  // skipped with a console warning so the rest of the batch still uploads.
  const handleImagePick = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setIsUploadingImages(true);
    setError(null);
    const uploaded = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        console.warn('Skipping non-image file:', file.name);
        continue;
      }
      try {
        const { file_url } = await UploadFile({ file });
        if (file_url) uploaded.push(file_url);
      } catch (err) {
        console.error('Image upload failed for', file.name, err);
        setError(`Failed to upload ${file.name}: ${uploadErrorText(err)}`);
        break; // same failure will hit every file in the batch
      }
    }
    setForm((prev) => ({ ...prev, images: [...prev.images, ...uploaded] }));
    setIsUploadingImages(false);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleVideoPick = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setIsUploadingVideos(true);
    setError(null);
    const uploaded = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('video/')) {
        console.warn('Skipping non-video file:', file.name);
        continue;
      }
      if (file.size > MAX_VIDEO_SIZE_BYTES) {
        setError(`${file.name} is larger than 100 MB — please trim it first.`);
        continue;
      }
      try {
        const { file_url } = await UploadFile({ file });
        if (file_url) uploaded.push(file_url);
      } catch (err) {
        console.error('Video upload failed for', file.name, err);
        setError(`Failed to upload ${file.name}: ${uploadErrorText(err)}`);
        break; // same failure will hit every file in the batch
      }
    }
    setForm((prev) => ({ ...prev, videos: [...prev.videos, ...uploaded] }));
    setIsUploadingVideos(false);
    if (videoInputRef.current) videoInputRef.current.value = '';
  };

  const removeImage = (idx) => {
    setForm((prev) => ({
      ...prev,
      images: prev.images.filter((_, i) => i !== idx),
    }));
  };

  const removeVideo = (idx) => {
    setForm((prev) => ({
      ...prev,
      videos: prev.videos.filter((_, i) => i !== idx),
    }));
  };

  return (
    <div className="space-y-6">
      <Tabs value={innerTab} onValueChange={setInnerTab}>
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="add">
            <Plus className="w-4 h-4 mr-2" />
            {editingId ? 'Edit vehicle' : 'Add vehicle'}
          </TabsTrigger>
          <TabsTrigger value="manage">
            <List className="w-4 h-4 mr-2" />
            Manage ({vehicles.length})
          </TabsTrigger>
        </TabsList>

        {/* ADD / EDIT FORM */}
        <TabsContent value="add">
          <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-3">
                <span className="flex items-center gap-2">
                  <Car className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  {editingId ? 'Edit vehicle' : 'Add a new vehicle'}
                </span>
                {editingId && (
                  <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
                    <X className="w-4 h-4 mr-1" />
                    Cancel edit
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {error && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                {/* IDENTITY */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Vehicle details
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="v-name">Display name *</Label>
                      <Input
                        id="v-name"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="Toyota Prado VXR 2022"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="v-brand">Brand *</Label>
                      <Input
                        id="v-brand"
                        value={form.brand}
                        onChange={(e) => setForm({ ...form, brand: e.target.value })}
                        placeholder="Toyota"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="v-type">Category *</Label>
                      <Select
                        value={form.category}
                        onValueChange={(value) => setForm({ ...form, category: value })}
                      >
                        <SelectTrigger id="v-type"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Guests browse by this after picking a city.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-year">Model year</Label>
                      <Input
                        id="v-year"
                        type="number"
                        min={1990}
                        max={new Date().getFullYear() + 1}
                        value={form.model_year}
                        onChange={(e) => setForm({ ...form, model_year: e.target.value })}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="v-description">Description</Label>
                      <Textarea
                        id="v-description"
                        rows={3}
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        placeholder="Spacious, comfortable, perfect for executive trips around Abuja."
                      />
                    </div>
                  </div>
                </section>

                {/* MEDIA */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Media
                  </h3>
                  <div className="grid grid-cols-1 gap-5">
                    {/* IMAGES */}
                    <div>
                      <Label className="flex items-center gap-2">
                        <ImageIcon className="w-4 h-4" />
                        Photos * (min 5 recommended)
                      </Label>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <input
                          ref={imageInputRef}
                          id="v-images-file"
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={handleImagePick}
                          className="hidden"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => imageInputRef.current?.click()}
                          disabled={isUploadingImages}
                          className="rounded-xl"
                        >
                          {isUploadingImages ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Uploading…
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mr-2" />
                              {form.images.length ? 'Add more photos' : 'Choose photos'}
                            </>
                          )}
                        </Button>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {form.images.length} photo{form.images.length === 1 ? '' : 's'} uploaded
                        </p>
                      </div>
                      {form.images.length > 0 && (
                        <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                          {form.images.map((url, idx) => (
                            <div
                              key={`${url}-${idx}`}
                              className="relative group aspect-square rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800"
                            >
                              <img src={url} alt="" className="w-full h-full object-cover" />
                              <button
                                type="button"
                                onClick={() => removeImage(idx)}
                                aria-label="Remove photo"
                                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                              >
                                <X className="w-3 h-3" />
                              </button>
                              {idx === 0 && (
                                <span className="absolute bottom-1 left-1 text-[10px] font-semibold bg-amber-400 text-slate-900 px-1.5 py-0.5 rounded">
                                  Cover
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* VIDEOS */}
                    <div>
                      <Label className="flex items-center gap-2">
                        <VideoIcon className="w-4 h-4" />
                        Walkthrough video (optional, max 100 MB)
                      </Label>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <input
                          ref={videoInputRef}
                          id="v-videos-file"
                          type="file"
                          accept="video/*"
                          multiple
                          onChange={handleVideoPick}
                          className="hidden"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => videoInputRef.current?.click()}
                          disabled={isUploadingVideos}
                          className="rounded-xl"
                        >
                          {isUploadingVideos ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Uploading…
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mr-2" />
                              {form.videos.length ? 'Add another video' : 'Choose a video'}
                            </>
                          )}
                        </Button>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {form.videos.length} video{form.videos.length === 1 ? '' : 's'} uploaded
                        </p>
                      </div>
                      {form.videos.length > 0 && (
                        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {form.videos.map((url, idx) => (
                            <div
                              key={`${url}-${idx}`}
                              className="relative group aspect-video rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900 flex items-center justify-center"
                            >
                              <video src={url} className="w-full h-full object-cover" muted />
                              <PlayCircle className="absolute w-8 h-8 text-white/80 pointer-events-none" />
                              <button
                                type="button"
                                onClick={() => removeVideo(idx)}
                                aria-label="Remove video"
                                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {/* LOCATION */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Location
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="v-city">City *</Label>
                      <Select value={form.city} onValueChange={(v) => setForm({ ...form, city: v })}>
                        <SelectTrigger id="v-city"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CITIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Guests pick a city first and only ever see cars based in it.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-plate">Registration number</Label>
                      <Input
                        id="v-plate"
                        value={form.registration_number}
                        onChange={(e) => setForm({ ...form, registration_number: e.target.value })}
                        placeholder="ABC-123-XY"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Internal until the guest has paid and a driver is assigned,
                        then shown so they can identify the car.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-seats">Max passengers</Label>
                      <Input
                        id="v-seats"
                        type="number"
                        min={1}
                        max={20}
                        value={form.max_passengers}
                        onChange={(e) => setForm({ ...form, max_passengers: e.target.value })}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="v-pickups">Pickup areas (comma-separated)</Label>
                      <Input
                        id="v-pickups"
                        value={form.pickup_locations}
                        onChange={(e) => setForm({ ...form, pickup_locations: e.target.value })}
                        placeholder="Maitama, Wuse, NAIA Airport"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="v-service-area">Service area description</Label>
                      <Textarea
                        id="v-service-area"
                        rows={2}
                        value={form.service_area}
                        onChange={(e) => setForm({ ...form, service_area: e.target.value })}
                        placeholder="Anywhere in Abuja + Suleja. Inter-state on request."
                      />
                    </div>
                  </div>
                </section>

                {/* PRICING */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Pricing (₦ NGN)
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label htmlFor="v-priceHour">Hourly rate</Label>
                      <Input
                        id="v-priceHour"
                        type="number"
                        min={0}
                        value={form.price_per_hour_ngn}
                        onChange={(e) => setForm({ ...form, price_per_hour_ngn: e.target.value })}
                        placeholder="15000"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Leave blank if this car is day-hire only — guests then
                        see no hourly options for it at all.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-priceExtraHour">Extra hour rate</Label>
                      <Input
                        id="v-priceExtraHour"
                        type="number"
                        min={0}
                        value={form.price_extra_hour_ngn}
                        onChange={(e) => setForm({ ...form, price_extra_hour_ngn: e.target.value })}
                        placeholder={form.price_per_hour_ngn || '18000'}
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Charged per hour the guest keeps the car past what they
                        booked. Blank means the standard hourly rate applies.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-price12">Full day (12h) price *</Label>
                      <Input
                        id="v-price12"
                        type="number"
                        min={0}
                        value={form.price_12hr_ngn}
                        onChange={(e) => setForm({ ...form, price_12hr_ngn: e.target.value })}
                        placeholder="60000"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="v-price24">24-hour price *</Label>
                      <Input
                        id="v-price24"
                        type="number"
                        min={0}
                        value={form.price_24hr_ngn}
                        onChange={(e) => setForm({ ...form, price_24hr_ngn: e.target.value })}
                        placeholder="100000"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="v-priceExtra">Extra day rate</Label>
                      <Input
                        id="v-priceExtra"
                        type="number"
                        min={0}
                        value={form.price_per_extra_day_ngn}
                        onChange={(e) => setForm({ ...form, price_per_extra_day_ngn: e.target.value })}
                        placeholder="90000"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                    <div>
                      <Label htmlFor="v-minhours">Minimum hours per booking</Label>
                      <Input
                        id="v-minhours"
                        type="number"
                        min={1}
                        max={24}
                        value={form.min_hours_per_booking}
                        onChange={(e) => setForm({ ...form, min_hours_per_booking: e.target.value })}
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Hourly options below this are greyed out for guests.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-turnaround">Turnaround hours</Label>
                      <Input
                        id="v-turnaround"
                        type="number"
                        min={0}
                        max={24}
                        value={form.turnaround_hours}
                        onChange={(e) => setForm({ ...form, turnaround_hours: e.target.value })}
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Gap needed between hires. Raising this blocks more of the
                        day around each booking.
                      </p>
                    </div>
                  </div>
                </section>

                {/* INTERNAL COSTING — admin-only entity, never shown to guests */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-1 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Internal costing (₦ NGN)
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                    What this car actually costs UrbanStays. Stored separately from the
                    vehicle and readable by admins only — the guest sees the final price
                    above and nothing else.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <Label htmlFor="c-partner-hr">Partner cost / hour</Label>
                      <Input
                        id="c-partner-hr" type="number" min={0}
                        value={costing.partner_cost_per_hour_ngn}
                        onChange={(e) => setCosting({ ...costing, partner_cost_per_hour_ngn: e.target.value })}
                        placeholder="10000"
                      />
                    </div>
                    <div>
                      <Label htmlFor="c-driver-hr">Driver cost / hour</Label>
                      <Input
                        id="c-driver-hr" type="number" min={0}
                        value={costing.driver_cost_per_hour_ngn}
                        onChange={(e) => setCosting({ ...costing, driver_cost_per_hour_ngn: e.target.value })}
                        placeholder="3000"
                      />
                    </div>
                    <div>
                      <Label htmlFor="c-partner-day">Partner cost / 24h</Label>
                      <Input
                        id="c-partner-day" type="number" min={0}
                        value={costing.partner_cost_per_day_ngn}
                        onChange={(e) => setCosting({ ...costing, partner_cost_per_day_ngn: e.target.value })}
                        placeholder="70000"
                      />
                    </div>
                    <div>
                      <Label htmlFor="c-driver-day">Driver cost / 24h</Label>
                      <Input
                        id="c-driver-day" type="number" min={0}
                        value={costing.driver_cost_per_day_ngn}
                        onChange={(e) => setCosting({ ...costing, driver_cost_per_day_ngn: e.target.value })}
                        placeholder="15000"
                      />
                    </div>
                  </div>

                  {/* Live margin readout so the admin sees the consequence of a
                      price or cost edit before saving it. */}
                  {(() => {
                    const m = markupFor(form, costing);
                    return (
                      <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3 space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          UrbanStays markup
                        </p>
                        <MarkupLine label="Per hour" row={m.hourly} />
                        <MarkupLine label="Per 24 hours" row={m.daily} />
                      </div>
                    );
                  })()}

                  <div className="mt-3">
                    <Label htmlFor="c-notes">Partner notes</Label>
                    <Textarea
                      id="c-notes" rows={2}
                      value={costing.notes}
                      onChange={(e) => setCosting({ ...costing, notes: e.target.value })}
                      placeholder="Owner: Mr Bala, 0803… Supplies own driver. Invoices weekly."
                    />
                  </div>
                </section>

                {/* AMENITIES */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Amenities
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {AMENITY_OPTIONS.map((a) => (
                      <label
                        key={a.id}
                        htmlFor={`amenity-${a.id}`}
                        className="flex items-center gap-2 p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 cursor-pointer"
                      >
                        <Checkbox
                          id={`amenity-${a.id}`}
                          checked={form.amenities.includes(a.id)}
                          onCheckedChange={() => toggleAmenity(a.id)}
                        />
                        <span className="text-sm text-slate-700 dark:text-slate-200">{a.label}</span>
                      </label>
                    ))}
                  </div>
                </section>

                {/* FUEL */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Fuel policy
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="v-fuel">Policy</Label>
                      <Select value={form.fuel_policy} onValueChange={(v) => setForm({ ...form, fuel_policy: v })}>
                        <SelectTrigger id="v-fuel"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {FUEL_POLICIES.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {form.fuel_policy === 'fuel_capped' && (
                      <div>
                        <Label htmlFor="v-fuelcap">Daily fuel cap (₦)</Label>
                        <Input
                          id="v-fuelcap"
                          type="number"
                          min={0}
                          value={form.fuel_cap_daily_ngn}
                          onChange={(e) => setForm({ ...form, fuel_cap_daily_ngn: e.target.value })}
                          placeholder="15000"
                        />
                      </div>
                    )}
                  </div>
                </section>

                {/* VISIBILITY */}
                <section>
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-3 text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Visibility
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white text-sm">Active</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Show this vehicle in the browse list</p>
                      </div>
                      <Switch
                        checked={form.active}
                        onCheckedChange={(checked) => setForm({ ...form, active: checked })}
                      />
                    </div>
                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white text-sm">Admin approved</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Required for guests to see it</p>
                      </div>
                      <Switch
                        checked={form.admin_approved}
                        onCheckedChange={(checked) => setForm({ ...form, admin_approved: checked })}
                      />
                    </div>
                  </div>
                </section>

                {/* SUBMIT */}
                <div className="flex gap-3 pt-2">
                  <Button
                    type="submit"
                    disabled={isSaving}
                    className="bg-slate-900 hover:bg-slate-800 text-white dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                  >
                    {isSaving ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
                    ) : (
                      <><Save className="w-4 h-4 mr-2" /> {editingId ? 'Update vehicle' : 'Save vehicle'}</>
                    )}
                  </Button>
                  {editingId && (
                    <Button type="button" variant="outline" onClick={resetForm}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* MANAGE LIST */}
        <TabsContent value="manage">
          <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-3">
                <span className="flex items-center gap-2">
                  <List className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  Vehicles ({vehicles.length})
                </span>
                <Button type="button" variant="outline" size="sm" onClick={loadVehicles} disabled={isLoading}>
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Refresh'}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && vehicles.length === 0 && (
                <div className="text-center py-12 text-slate-500 dark:text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
                  Loading vehicles…
                </div>
              )}

              {!isLoading && vehicles.length === 0 && (
                <div className="text-center py-12">
                  <Car className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-1">No vehicles yet</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Add your first vehicle to get started.</p>
                  <Button onClick={() => setInnerTab('add')}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add a vehicle
                  </Button>
                </div>
              )}

              {vehicles.length > 0 && (
                <div className="space-y-3">
                  {vehicles.map((v) => {
                    const hero = v.images?.[0]
                      || 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=400';
                    return (
                      <div
                        key={v.id}
                        className="flex flex-col sm:flex-row gap-3 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-amber-300 transition-colors"
                      >
                        <img
                          src={hero}
                          alt={v.name}
                          className="w-full sm:w-32 h-32 sm:h-24 object-cover rounded-xl flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h4 className="font-bold text-slate-900 dark:text-white truncate">{v.name}</h4>
                            {v.active === false && (
                              <Badge variant="outline" className="border-slate-300 text-slate-500 dark:text-slate-400">
                                <EyeOff className="w-3 h-3 mr-1" />
                                Hidden
                              </Badge>
                            )}
                            {v.admin_approved === false && (
                              <Badge variant="outline" className="border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                                <AlertCircle className="w-3 h-3 mr-1" />
                                Not approved
                              </Badge>
                            )}
                            {v.active && v.admin_approved && (
                              <Badge variant="outline" className="border-green-300 dark:border-green-800 text-green-700 dark:text-green-300">
                                <CheckCircle2 className="w-3 h-3 mr-1" />
                                Live
                              </Badge>
                            )}
                            {/* Only visible via the legacy-type fallback. Guests
                                can still find it, but the category shown is a
                                guess until someone picks a real one. */}
                            {needsCategoryMigration(v) && (
                              <Badge variant="outline" className="border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                                <AlertCircle className="w-3 h-3 mr-1" />
                                Set a category
                              </Badge>
                            )}
                            {!v.price_per_hour_ngn && (
                              <Badge variant="outline" className="border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                                Day hire only
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                            {v.brand} · {categoryLabel(effectiveCategory(v))} · {v.city} · {v.max_passengers || 0} seats
                          </p>
                          <div className="flex flex-wrap gap-3 text-xs text-slate-700 dark:text-slate-200">
                            {v.price_per_hour_ngn ? (
                              <span>/hr: <strong>₦{v.price_per_hour_ngn.toLocaleString()}</strong></span>
                            ) : null}
                            {extraHourRate(v) ? (
                              <span>Extra hr: <strong>₦{extraHourRate(v).toLocaleString()}</strong></span>
                            ) : null}
                            <span>12h: <strong>₦{(v.price_12hr_ngn || 0).toLocaleString()}</strong></span>
                            <span>24h: <strong>₦{(v.price_24hr_ngn || 0).toLocaleString()}</strong></span>
                            {v.price_per_extra_day_ngn ? (
                              <span>Extra day: <strong>₦{v.price_per_extra_day_ngn.toLocaleString()}</strong></span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex sm:flex-col gap-2 self-start sm:self-center">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => startEdit(v)}
                            className="flex-1 sm:w-24"
                          >
                            <Edit3 className="w-3.5 h-3.5 mr-1" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(`/Vehicle?id=${v.id}`, '_blank')}
                            className="flex-1 sm:w-24"
                          >
                            <Eye className="w-3.5 h-3.5 mr-1" />
                            View
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setVehicleToDelete(v)}
                            disabled={deletingId === v.id}
                            className="flex-1 sm:w-24 border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:bg-red-950/40"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete confirmation */}
      <AlertDialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete vehicle?</AlertDialogTitle>
            <AlertDialogDescription>
              {vehicleToDelete && (
                <>This will permanently delete <strong>{vehicleToDelete.name}</strong>. Existing ride bookings on this vehicle stay intact, but the vehicle will no longer be browseable.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep vehicle</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
