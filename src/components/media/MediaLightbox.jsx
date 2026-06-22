import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, PlayCircle } from 'lucide-react';

// MediaLightbox — full-screen gallery viewer with swipe + arrow-key navigation.
//
// Props:
//   media     [{ type: 'image' | 'video', url }]   ordered list to show
//   startIndex                                      index to open at
//   open                                            controlled visibility
//   onClose                                         close handler
//
// Behavior:
//   - Esc + click backdrop + close button all dismiss.
//   - ArrowLeft / ArrowRight cycle through media; loops at edges.
//   - Swipe left / right (mobile) cycles. Threshold prevents accidental swipes.
//   - Body scroll locked while open so the page underneath doesn't drift.
//   - Videos auto-play when they become the active slide; pause when navigated away.
export default function MediaLightbox({ media, startIndex = 0, open, onClose }) {
  const [index, setIndex] = useState(startIndex);
  const containerRef = useRef(null);

  useEffect(() => {
    if (open) setIndex(startIndex);
  }, [open, startIndex]);

  // Lock body scroll while the lightbox is up — otherwise iOS will bounce
  // the underlying page when the user swipes the photo.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Keyboard navigation: Esc closes, arrows cycle.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const count = media?.length || 0;
  if (!open || count === 0) return null;

  const goPrev = () => setIndex((i) => (i - 1 + count) % count);
  const goNext = () => setIndex((i) => (i + 1) % count);
  const current = media[index];

  // Swipe handling — framer-motion's drag gives us pointer events for free.
  // Threshold of ~50px feels right on both touch + trackpad.
  const handleDragEnd = (_, info) => {
    if (info.offset.x > 60) goPrev();
    else if (info.offset.x < -60) goNext();
  };

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[60] bg-black/95 backdrop-blur-sm"
        onClick={(e) => {
          // Backdrop click — only close if the user clicked the dim layer,
          // not the actual media element.
          if (e.target === e.currentTarget) onClose?.();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
      >
        {/* Close button — top-right, large enough to tap with confidence.
            Safe-area aware so it clears the iPhone notch / Dynamic Island. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 z-10 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center backdrop-blur-sm transition-colors"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Counter — top-left, so the user knows they can keep swiping */}
        {count > 1 && (
          <div
            className="absolute left-4 z-10 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-sm text-white text-sm font-medium"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
          >
            {index + 1} / {count}
          </div>
        )}

        {/* Prev / Next arrows — hidden on small touch screens where swipe is the
            obvious gesture, visible on >= sm screens (mouse / trackpad users) */}
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous"
              className="hidden sm:flex absolute left-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white items-center justify-center backdrop-blur-sm transition-colors"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next"
              className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white items-center justify-center backdrop-blur-sm transition-colors"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </>
        )}

        {/* Media slide — fills the ENTIRE viewport, edge to edge. Controls
            (close, counter, arrows, dots, thumbs) float OVER the image as
            overlays so we don't waste space reserving bands for them; their
            backdrop-blur pills stay legible regardless of the photo behind
            them. No safe-area padding here — the image is free to extend
            behind the iPhone notch / home indicator so it can actually use
            the whole screen; controls have their own safe-area padding to
            stay clear of those zones. */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.18 }}
              drag={count > 1 ? 'x' : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.2}
              onDragEnd={handleDragEnd}
              className="w-full h-full flex items-center justify-center cursor-grab active:cursor-grabbing pointer-events-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* w-full h-full (instead of max-w-full max-h-full w-auto h-auto)
                  forces the img element to fill the viewport box; object-contain
                  scales the photo to fit while preserving aspect. Without this,
                  small / awkwardly-sized source images shrank to their intrinsic
                  size and left huge black margins on tall mobile viewports. */}
              {current.type === 'image' ? (
                <img
                  src={current.url}
                  alt=""
                  draggable={false}
                  className="w-full h-full object-contain select-none pointer-events-none"
                />
              ) : (
                <video
                  src={current.url}
                  controls
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                >
                  Your browser does not support video.
                </video>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Mobile-only dot indicator — replaces the desktop thumbnail strip with
            a much smaller visual hint of "you can keep swiping". Tap-friendly
            without crowding the photo. */}
        {count > 1 && (
          <div
            className="sm:hidden absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-sm"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
          >
            {media.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show item ${i + 1}`}
                className={`rounded-full transition-all ${
                  i === index ? 'w-5 h-1.5 bg-amber-400' : 'w-1.5 h-1.5 bg-white/40'
                }`}
              />
            ))}
          </div>
        )}

        {/* Thumbnail strip at the bottom — tap to jump. Hidden on very short
            viewports so it doesn't crowd the main media on landscape phones. */}
        {count > 1 && (
          <div
            className="hidden sm:flex absolute left-1/2 -translate-x-1/2 z-10 gap-2 max-w-[90vw] overflow-x-auto p-2 rounded-2xl bg-white/5 backdrop-blur-sm"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
          >
            {media.map((m, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show item ${i + 1}`}
                className={`relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 ring-2 transition-all ${
                  i === index ? 'ring-amber-400' : 'ring-transparent opacity-60 hover:opacity-100'
                }`}
              >
                <img
                  src={m.type === 'image' ? m.url : 'https://static.thenounproject.com/png/11204-200.png'}
                  alt=""
                  className="w-full h-full object-cover"
                />
                {m.type === 'video' && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <PlayCircle className="w-4 h-4 text-white" />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
