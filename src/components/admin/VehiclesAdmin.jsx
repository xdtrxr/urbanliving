import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
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
} from 'lucide-react';

const VEHICLE_TYPES = [
  { value: 'sedan', label: 'Sedan' },
  { value: 'suv', label: 'SUV' },
  { value: 'luxury_sedan', label: 'Luxury Sedan' },
  { value: 'luxury_suv', label: 'Luxury SUV' },
  { value: 'executive', label: 'Executive' },
  { value: 'van', label: 'Van' },
  { value: 'minibus', label: 'Minibus' },
  { value: 'coupe', label: 'Coupe' },
];

const CITIES = ['Abuja', 'Lagos'];

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
  vehicle_type: 'sedan',
  model_year: new Date().getFullYear(),
  description: '',
  images: '',         // textarea — one URL per line, split on submit
  videos: '',
  city: 'Abuja',
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
  min_hours_per_booking: 12,
};

// Splits a multi-line textarea into a clean array of URLs.
const linesToArray = (raw) =>
  (raw || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

const arrayToLines = (arr) => (Array.isArray(arr) ? arr.join('\n') : '');

const csvToArray = (raw) =>
  (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const arrayToCsv = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');

export default function VehiclesAdmin() {
  const [innerTab, setInnerTab] = useState('add');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [vehicleToDelete, setVehicleToDelete] = useState(null);
  const [error, setError] = useState(null);

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
    setEditingId(null);
  };

  const startEdit = (vehicle) => {
    setEditingId(vehicle.id);
    setForm({
      name: vehicle.name || '',
      brand: vehicle.brand || '',
      vehicle_type: vehicle.vehicle_type || 'sedan',
      model_year: vehicle.model_year || new Date().getFullYear(),
      description: vehicle.description || '',
      images: arrayToLines(vehicle.images),
      videos: arrayToLines(vehicle.videos),
      city: vehicle.city || 'Abuja',
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
      min_hours_per_booking: vehicle.min_hours_per_booking ?? 12,
    });
    setInnerTab('add');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const images = linesToArray(form.images);
      if (images.length === 0) {
        throw new Error('Add at least one image URL.');
      }
      if (!form.price_12hr_ngn || !form.price_24hr_ngn) {
        throw new Error('Both 12-hour and 24-hour prices are required.');
      }

      // Shape matches Vehicle.jsonc — coerce numerics, drop empty strings.
      const payload = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        vehicle_type: form.vehicle_type,
        model_year: Number(form.model_year) || null,
        description: form.description.trim() || undefined,
        images,
        videos: linesToArray(form.videos),
        city: form.city,
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
        min_hours_per_booking: Number(form.min_hours_per_booking) || 12,
        driver_included: true, // V1 always includes a driver
      };

      if (editingId) {
        await base44.entities.Vehicle.update(editingId, payload);
      } else {
        await base44.entities.Vehicle.create(payload);
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
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-3">
                <span className="flex items-center gap-2">
                  <Car className="w-5 h-5 text-amber-600" />
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
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                {/* IDENTITY */}
                <section>
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
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
                      <Label htmlFor="v-type">Type *</Label>
                      <Select
                        value={form.vehicle_type}
                        onValueChange={(value) => setForm({ ...form, vehicle_type: value })}
                      >
                        <SelectTrigger id="v-type"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {VEHICLE_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
                    Media (one URL per line)
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <Label htmlFor="v-images" className="flex items-center gap-2">
                        <ImageIcon className="w-4 h-4" />
                        Image URLs * (min 5 recommended)
                      </Label>
                      <Textarea
                        id="v-images"
                        rows={5}
                        value={form.images}
                        onChange={(e) => setForm({ ...form, images: e.target.value })}
                        placeholder={`https://example.com/photo1.jpg\nhttps://example.com/photo2.jpg\n...`}
                        className="font-mono text-xs"
                        required
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        {linesToArray(form.images).length} image{linesToArray(form.images).length === 1 ? '' : 's'} added
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="v-videos" className="flex items-center gap-2">
                        <VideoIcon className="w-4 h-4" />
                        Video URLs (optional walkthrough)
                      </Label>
                      <Textarea
                        id="v-videos"
                        rows={2}
                        value={form.videos}
                        onChange={(e) => setForm({ ...form, videos: e.target.value })}
                        placeholder={`https://example.com/walkthrough.mp4`}
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                </section>

                {/* LOCATION */}
                <section>
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
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
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
                    Pricing (₦ NGN)
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label htmlFor="v-price12">12-hour price *</Label>
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
                </section>

                {/* AMENITIES */}
                <section>
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
                    Amenities
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {AMENITY_OPTIONS.map((a) => (
                      <label
                        key={a.id}
                        htmlFor={`amenity-${a.id}`}
                        className="flex items-center gap-2 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer"
                      >
                        <Checkbox
                          id={`amenity-${a.id}`}
                          checked={form.amenities.includes(a.id)}
                          onCheckedChange={() => toggleAmenity(a.id)}
                        />
                        <span className="text-sm text-slate-700">{a.label}</span>
                      </label>
                    ))}
                  </div>
                </section>

                {/* FUEL */}
                <section>
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
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
                  <h3 className="font-semibold text-slate-900 mb-3 text-sm uppercase tracking-wide text-slate-500">
                    Visibility
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200">
                      <div>
                        <p className="font-medium text-slate-900 text-sm">Active</p>
                        <p className="text-xs text-slate-500">Show this vehicle in the browse list</p>
                      </div>
                      <Switch
                        checked={form.active}
                        onCheckedChange={(checked) => setForm({ ...form, active: checked })}
                      />
                    </div>
                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200">
                      <div>
                        <p className="font-medium text-slate-900 text-sm">Admin approved</p>
                        <p className="text-xs text-slate-500">Required for guests to see it</p>
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
                    className="bg-slate-900 hover:bg-slate-800 text-white"
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
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-3">
                <span className="flex items-center gap-2">
                  <List className="w-5 h-5 text-amber-600" />
                  Vehicles ({vehicles.length})
                </span>
                <Button type="button" variant="outline" size="sm" onClick={loadVehicles} disabled={isLoading}>
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Refresh'}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && vehicles.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
                  Loading vehicles…
                </div>
              )}

              {!isLoading && vehicles.length === 0 && (
                <div className="text-center py-12">
                  <Car className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-900 mb-1">No vehicles yet</h3>
                  <p className="text-sm text-slate-500 mb-4">Add your first vehicle to get started.</p>
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
                        className="flex flex-col sm:flex-row gap-3 p-3 rounded-2xl border border-slate-200 hover:border-amber-300 transition-colors"
                      >
                        <img
                          src={hero}
                          alt={v.name}
                          className="w-full sm:w-32 h-32 sm:h-24 object-cover rounded-xl flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h4 className="font-bold text-slate-900 truncate">{v.name}</h4>
                            {v.active === false && (
                              <Badge variant="outline" className="border-slate-300 text-slate-500">
                                <EyeOff className="w-3 h-3 mr-1" />
                                Hidden
                              </Badge>
                            )}
                            {v.admin_approved === false && (
                              <Badge variant="outline" className="border-amber-300 text-amber-700">
                                <AlertCircle className="w-3 h-3 mr-1" />
                                Not approved
                              </Badge>
                            )}
                            {v.active && v.admin_approved && (
                              <Badge variant="outline" className="border-green-300 text-green-700">
                                <CheckCircle2 className="w-3 h-3 mr-1" />
                                Live
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 mb-2">
                            {v.brand} · {v.vehicle_type?.replace(/_/g, ' ')} · {v.city} · {v.max_passengers || 0} seats
                          </p>
                          <div className="flex flex-wrap gap-3 text-xs text-slate-700">
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
                            className="flex-1 sm:w-24 border-red-200 text-red-600 hover:bg-red-50"
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
