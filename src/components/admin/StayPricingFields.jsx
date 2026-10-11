import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, CalendarRange } from 'lucide-react';
import { newOptionRow, switchStayPricingMode } from '@/config/stays';

// The booking options and seasonal rates part of the property form. It only
// edits the form state; stayPricingToSave (config/stays.js) checks it on save.
export default function StayPricingFields({ form, setForm }) {
  const multiple = form.option_mode === 'multiple';
  const options = form.booking_options || [];
  const seasons = form.seasonal_rates || [];

  const setMode = (mode) => setForm((prev) => switchStayPricingMode(prev, mode));
  const setOption = (i, patch) => setForm((prev) => ({
    ...prev,
    booking_options: prev.booking_options.map((o, n) => (n === i ? { ...o, ...patch } : o)),
  }));
  const addOption = () => setForm((prev) => {
    const rows = prev.booking_options || [];
    const used = rows.map((o) => Number(o.bedrooms) || 0);
    return { ...prev, booking_options: [...rows, newOptionRow(rows, { bedrooms: String(Math.max(0, ...used) + 1) })] };
  });
  const removeOption = (i) => setForm((prev) => ({ ...prev, booking_options: prev.booking_options.filter((_, n) => n !== i) }));

  const setSeason = (i, patch) => setForm((prev) => ({
    ...prev,
    seasonal_rates: prev.seasonal_rates.map((s, n) => (n === i ? { ...s, ...patch } : s)),
  }));
  const addSeason = () => setForm((prev) => ({
    ...prev,
    seasonal_rates: [...(prev.seasonal_rates || []), { name: '', start_date: '', end_date: '', prices: {} }],
  }));
  const removeSeason = (i) => setForm((prev) => ({ ...prev, seasonal_rates: prev.seasonal_rates.filter((_, n) => n !== i) }));

  // What a season can price: each option, or the whole place. Prices are
  // kept under the row's own id, so retyping its bedroom count keeps them.
  const idOf = (o, i) => o.id || `row${i}`;
  const priced = multiple
    ? options.map((o, i) => ({
      key: idOf(o, i),
      label: Number(o.bedrooms) >= 1 ? `${Math.round(Number(o.bedrooms))} bedroom${Number(o.bedrooms) > 1 ? 's' : ''}` : `Option ${i + 1}`,
      normal: o.price_per_night,
    }))
    : [{ key: 'full', label: 'Full property', normal: form.price_per_night }];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Label>Can guests book part of this property?</Label>
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
            <input type="radio" name="option_mode" checked={!multiple} onChange={() => setMode('full')} />
            No, full property only
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
            <input type="radio" name="option_mode" checked={multiple} onChange={() => setMode('multiple')} />
            Yes, multiple bedroom options
          </label>
        </div>
      </div>

      {multiple && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            One row per way of booking. A booking of any option blocks the whole property for those dates.
          </p>
          {options.map((o, i) => (
            <div key={idOf(o, i)} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end pb-3 border-b border-slate-100 dark:border-slate-800 sm:pb-0 sm:border-0">
              <div>
                <Label htmlFor={`opt_bedrooms_${i}`}>Bedrooms</Label>
                <Input id={`opt_bedrooms_${i}`} type="number" min="1" value={o.bedrooms} onChange={(e) => setOption(i, { bedrooms: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label htmlFor={`opt_price_${i}`}>Price per night (₦)</Label>
                <Input id={`opt_price_${i}`} type="number" min="0" value={o.price_per_night} onChange={(e) => setOption(i, { price_per_night: e.target.value })} placeholder="e.g., 160000" className="mt-1" />
              </div>
              <div>
                <Label htmlFor={`opt_guests_${i}`}>Max guests</Label>
                <Input id={`opt_guests_${i}`} type="number" min="1" value={o.max_guests} onChange={(e) => setOption(i, { max_guests: e.target.value })} placeholder="e.g., 4" className="mt-1" />
              </div>
              <Button type="button" variant="ghost" size="icon" className="justify-self-end" onClick={() => removeOption(i)} aria-label="Remove this option">
                <Trash2 className="w-4 h-4 text-red-600" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addOption}>
            <Plus className="w-4 h-4 mr-1" /> Add booking option
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <h4 className="font-medium text-slate-900 dark:text-white flex items-center gap-2">
          <CalendarRange className="w-4 h-4 text-amber-600" />
          Seasonal pricing
        </h4>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Optional. Nights inside a seasonal rate use its price; every other night uses the normal price. Leave a price blank to keep the normal price for that option.
        </p>
        {seasons.map((s, i) => (
          <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end">
              <div>
                <Label htmlFor={`season_name_${i}`}>Season name</Label>
                <Input id={`season_name_${i}`} value={s.name} onChange={(e) => setSeason(i, { name: e.target.value })} placeholder="e.g., December Peak" className="mt-1" />
              </div>
              <div>
                <Label htmlFor={`season_start_${i}`}>Start date</Label>
                <Input id={`season_start_${i}`} type="date" value={s.start_date} onChange={(e) => setSeason(i, { start_date: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label htmlFor={`season_end_${i}`}>End date</Label>
                <Input id={`season_end_${i}`} type="date" value={s.end_date} min={s.start_date || undefined} onChange={(e) => setSeason(i, { end_date: e.target.value })} className="mt-1" />
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => removeSeason(i)} aria-label="Remove this seasonal rate">
                <Trash2 className="w-4 h-4 text-red-600" />
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {priced.map((p) => (
                <div key={p.key}>
                  <Label htmlFor={`season_${i}_${p.key}`}>{p.label} (NGN)</Label>
                  <Input
                    id={`season_${i}_${p.key}`}
                    type="number"
                    min="0"
                    value={(s.prices && s.prices[p.key]) || ''}
                    onChange={(e) => setSeason(i, { prices: { ...(s.prices || {}), [p.key]: e.target.value } })}
                    placeholder={p.normal ? `Normal ${Number(p.normal).toLocaleString()}` : 'Price per night'}
                    className="mt-1"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addSeason}>
          <Plus className="w-4 h-4 mr-1" /> Add seasonal rate
        </Button>
      </div>
    </div>
  );
}
