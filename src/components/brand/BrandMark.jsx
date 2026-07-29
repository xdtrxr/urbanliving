import React, { useState } from 'react';
import { Home } from 'lucide-react';

// BrandMark — the single source of truth for the Urban Stays logo.
//
// Renders /logo.svg, which already carries its own dark-navy rounded-square
// background, so callers should NOT wrap this in a coloured tile.
//
// If the file is missing or fails to decode we fall back to the previous
// mark (a Lucide house on a navy gradient tile). That keeps every surface
// rendering something sane rather than a broken-image glyph, and means this
// component was safe to ship before the artwork landed.
//
// Sizing is caller-controlled so each surface keeps its existing dimensions:
//   <BrandMark className="w-8 h-8" radius="rounded-xl" />
export default function BrandMark({
  className = 'w-8 h-8',
  radius = 'rounded-xl',
  // Only used by the fallback — sized to sit inside the tile with padding.
  iconClassName = 'w-4 h-4 text-amber-400',
  alt = '',
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        className={`${className} ${radius} bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center flex-shrink-0`}
        aria-hidden={alt ? undefined : 'true'}
      >
        <Home className={iconClassName} strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <img
      src="/logo.svg"
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
      onError={() => setFailed(true)}
      className={`${className} ${radius} object-contain flex-shrink-0`}
    />
  );
}
