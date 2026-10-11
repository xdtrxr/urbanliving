import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

interface ConflictDetails {
    booking_id: string;
    check_in: string;
    check_out: string;
    guest_email: string;
}

function detectConflict(existing: any[], requestedIn: Date, requestedOut: Date): { hasConflict: boolean; conflicting: any | null } {
    for (const booking of existing) {
        const bookingIn = new Date(booking.check_in);
        const bookingOut = new Date(booking.check_out);
        if (
            (requestedIn >= bookingIn && requestedIn < bookingOut) ||
            (requestedOut > bookingIn && requestedOut <= bookingOut) ||
            (requestedIn <= bookingIn && requestedOut >= bookingOut)
        ) {
            return { hasConflict: true, conflicting: booking };
        }
    }
    return { hasConflict: false, conflicting: null };
}

// Resolves the first image URL for a property. Uses .get() not .filter() so
// non-DB property IDs (e.g. MCP-injected ones from chat) fail fast and obviously
// rather than silently returning empty. Returns null when the property exists
// but has no images uploaded — admin Telegram will fall back to text-only.
//
// VERBOSE LOGGING is intentional: if admin reports "no image in the Telegram
// notification" the function logs are the only place we can see whether the
// property was found, whether it had images, and which URL was attempted.
// ── Stay pricing — derived from the Property row, never from the request ────
// MIRRORED client-side by estimateStayPrice / nightsBetween in
// src/config/stays.js, which draw the figure the guest sees before submitting.
// Keep the two in lockstep; scripts/check-stay-price.mjs executes both.
//
// Until this landed the request body carried total_price and it was stored
// as-is, so a guest could request any apartment at ₦1, pay ₦1 (the payment
// verifiers only check Paystack's amount against the stored figure) and get a
// confirmed booking. The body's total_price is now ignored entirely.
const SERVICE_FEE_RATE = 0.025;
const DAY_MS = 24 * 60 * 60 * 1000;
// The longest stay one request can ask for. Pricing walks the stay a night at
// a time, so the walk needs an end that a request cannot move.
const MAX_STAY_NIGHTS = 365;

function nightsBetween(checkIn: string, checkOut: string): number {
    const a = Date.parse(`${checkIn}T00:00:00Z`);
    const b = Date.parse(`${checkOut}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    return Math.max(0, Math.round((b - a) / DAY_MS));
}

interface StayPrice { nights: number; subtotal: number; serviceFee: number; cautionFee: number; total: number }

function priceForStay(property: any, nights: number): StayPrice | null {
    const rate = Number(property?.price_per_night) || 0;
    const n = Number(nights) || 0;
    if (!rate || n < 1) return null;
    const subtotal = rate * n;
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
    const cautionFee = Number(property?.caution_fee) || 0;
    return { nights: n, subtotal, serviceFee, cautionFee, total: subtotal + serviceFee + cautionFee };
}

async function fetchPropertyImage(base44Client: any, propertyId: string): Promise<string | null> {
    console.log(`[fetchPropertyImage] looking up property_id=${propertyId}`);
    try {
        const prop = await base44Client.asServiceRole.entities.Property.get(propertyId);
        if (!prop) {
            console.warn(`[fetchPropertyImage] ⚠️ property ${propertyId} NOT FOUND in DB. Likely MCP/Airbnb result that was never ingested. No image possible.`);
            return null;
        }
        const imageCount = Array.isArray(prop.images) ? prop.images.length : 0;
        console.log(`[fetchPropertyImage] property ${propertyId} found: title="${prop.title}", images.length=${imageCount}`);
        if (imageCount === 0) {
            console.warn(`[fetchPropertyImage] ⚠️ property ${propertyId} has NO images. Admin needs to upload one in the Admin form.`);
            return null;
        }
        const url = prop.images[0];
        // Sanity check the URL — Telegram needs a publicly fetchable URL.
        if (typeof url !== 'string' || !url.startsWith('http')) {
            console.warn(`[fetchPropertyImage] ⚠️ property ${propertyId} first image is not a valid URL: ${JSON.stringify(url).slice(0, 200)}`);
            return null;
        }
        console.log(`[fetchPropertyImage] ✅ using image URL: ${url}`);
        return url;
    } catch (e) {
        console.error('[fetchPropertyImage] threw:', (e as Error).message);
        return null;
    }
}

async function sendAdminTelegram(opts: {
    propertyTitle: string;
    propertyId: string;
    propertyLocation: any;
    propertyImageUrl: string | null;
    userName: string;
    userEmail: string;
    userMobile: string;
    guests: number;
    optionLabel: string;
    checkIn: string;
    checkOut: string;
    totalPrice: number;
    specialRequests: string;
    hasConflict: boolean;
    conflicting: any | null;
    requestId: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.warn('Telegram credentials not configured — skipping admin notification');
        return { sent: false, message_id: null as string | null };
    }

    const conflictEmoji = opts.hasConflict ? '⚠️' : '✅';
    const conflictText = opts.hasConflict ? 'CONFLICT DETECTED' : 'NO CONFLICTS';
    const locationStr = opts.propertyLocation
        ? [opts.propertyLocation.address, opts.propertyLocation.city, opts.propertyLocation.country].filter(Boolean).join(', ')
        : 'Not provided';

    const conflictBlock = opts.hasConflict && opts.conflicting
        ? `\n\n⚠️ *${conflictText}*\n• Conflicting Booking: \`${opts.conflicting.id}\`\n• Dates: ${opts.conflicting.check_in} → ${opts.conflicting.check_out}\n• Guest: ${opts.conflicting.guest_email}`
        : `\n\n✅ *${conflictText}*\nNo overlapping bookings.`;

    const specialRequestsBlock = opts.specialRequests && opts.specialRequests.trim()
        ? `\n\n📝 *Special Requests:*\n${opts.specialRequests.trim()}`
        : '';

    const totalLine = opts.totalPrice > 0
        ? `\n💰 *Total:* ₦${opts.totalPrice.toLocaleString()}`
        : '';

    const text = `${conflictEmoji} *AVAILABILITY CHECK REQUEST*

📍 *Property:* ${opts.propertyTitle}
🆔 *Property ID:* \`${opts.propertyId}\`
📌 *Location:* ${locationStr}

👤 *Guest Details:*
• Name: ${opts.userName}
• Email: ${opts.userEmail}
• Mobile: ${opts.userMobile || 'Not provided'}
• Guests: ${opts.guests}${opts.optionLabel ? `\n• Booking: ${opts.optionLabel}` : ''}

📅 *Requested Dates:*
• Check-in: ${opts.checkIn}
• Check-out: ${opts.checkOut}${totalLine}${specialRequestsBlock}${conflictBlock}

*Request ID:* \`${opts.requestId}\``;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${opts.requestId}` },
            { text: '❌ Reject', callback_data: `reject_${opts.requestId}` },
        ]],
    };

    // Try sendPhoto first when we have an image URL. If Telegram can't fetch
    // the photo (signed/private URL, expired token, bad domain, etc.) fall
    // back to a plain sendMessage so admin still gets the request + buttons
    // and a link to the image at the bottom. Previously a failed sendPhoto
    // silently dropped the entire notification.
    const trySend = async (endpoint: string, payload: Record<string, unknown>) => {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return res.json();
    };

    if (opts.propertyImageUrl) {
        const photoResp = await trySend(`https://api.telegram.org/bot${token}/sendPhoto`, {
            chat_id: chatId,
            photo: opts.propertyImageUrl,
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        });
        if (photoResp.ok) {
            return { sent: true, message_id: String(photoResp.result.message_id) };
        }
        console.warn('Telegram sendPhoto failed, falling back to text:', photoResp);
    }

    const textWithImage = opts.propertyImageUrl
        ? `${text}\n\n🖼 *Property image:* ${opts.propertyImageUrl}`
        : text;
    const msgResp = await trySend(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: textWithImage,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
    });
    if (!msgResp.ok) {
        console.error('Telegram sendMessage also failed:', msgResp);
        return { sent: false, message_id: null as string | null };
    }
    return { sent: true, message_id: String(msgResp.result.message_id) };
}

// ── Booking options and seasonal rates ──────────────────────────────────────
// One property can be booked several ways (1 bedroom, 2 bedrooms, the whole
// house), each with its own nightly price and guest limit, and any of those
// prices can be different for a named stretch of dates. A property with no
// options listed has exactly one: the whole place at price_per_night.
//
// On a row WITH options, price_per_night and max_guests are still the whole
// place: the largest option's. So anything that knows nothing of options (an
// old browser tab, an old copy of this function, a list that prints one
// price) quotes and charges a real offer, and never a small option's price
// for the whole house. Naming no option means the same thing: the largest.

// The ways a property can be booked, smallest first. Bad rows are dropped,
// and a bedroom count listed twice counts once.
function bookingOptionsOf(property: any) {
    const listed = property && Array.isArray(property.booking_options) ? property.booking_options : [];
    const out = [];
    for (const o of listed) {
        const bedrooms = Math.round(Number(o && o.bedrooms));
        const price = Math.round(Number(o && o.price_per_night));
        const guests = Math.round(Number(o && o.max_guests));
        if (!(bedrooms >= 1) || !(price > 0) || out.some((x) => x.bedrooms === bedrooms)) continue;
        out.push({ bedrooms, price_per_night: price, max_guests: guests >= 1 ? guests : 0 });
    }
    if (out.length === 0) {
        const price = Math.round(Number(property && property.price_per_night) || 0);
        if (price > 0) {
            out.push({
                bedrooms: Math.round(Number(property.bedrooms) || 0),
                price_per_night: price,
                max_guests: Math.round(Number(property.max_guests) || 0),
                whole: true,
            });
        }
    }
    return out.sort((a, b) => a.bedrooms - b.bedrooms);
}

// What one night costs for one option. `night` is YYYY-MM-DD. A season covers
// its start and end dates inclusive, and only changes an option it prices.
// A place with no options listed (`whole`) has one seasonal price: the one
// saved under its bedroom count, or, if that count has since changed, the
// highest the season lists.
function nightlyRate(property: any, option: any, night: string) {
    const seasons = property && Array.isArray(property.seasonal_rates) ? property.seasonal_rates : [];
    for (const s of seasons) {
        // Both days, or the season does not count; a date-time is read as its day.
        const from = String((s && s.start_date) || '').slice(0, 10);
        const to = String((s && s.end_date) || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !(from <= night && night <= to)) continue;
        const listed = (Array.isArray(s.prices) ? s.prices : []).filter((p) => !!p && Math.round(Number(p.price_per_night)) > 0);
        const row = listed.find((p) => Math.round(Number(p.bedrooms)) === option.bedrooms)
            || (option.whole ? listed.reduce((a, b) => (Number(b.price_per_night) > Number(a.price_per_night) ? b : a), listed[0]) : undefined);
        const price = Math.round(Number(row && row.price_per_night));
        if (price > 0) return { rate: price, season: String(s.name || 'Seasonal rate') };
    }
    return { rate: option.price_per_night, season: '' };
}

// The price of a stay, night by night, or null when it cannot be priced.
// `bedrooms` picks the option. Left out, it is the whole place: the largest.
// lines groups consecutive nights at the same rate, for the guest to read.
function priceStay(property: any, checkIn: string, checkOut: string, bedrooms: unknown) {
    const options = bookingOptionsOf(property);
    const wanted = Math.round(Number(bedrooms));
    const option = wanted >= 1 ? options.find((o) => o.bedrooms === wanted) : options[options.length - 1];
    const nights = nightsBetween(checkIn, checkOut);
    if (!option || nights < 1 || nights > MAX_STAY_NIGHTS) return null;
    const first = Date.parse(`${checkIn}T00:00:00Z`);
    const lines = [];
    let subtotal = 0;
    for (let i = 0; i < nights; i += 1) {
        const night = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
        const r = nightlyRate(property, option, night);
        const last = lines[lines.length - 1];
        if (last && last.rate === r.rate && last.season === r.season) last.nights += 1;
        else lines.push({ season: r.season, rate: r.rate, nights: 1, from: night });
        subtotal += r.rate;
    }
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
    const cautionFee = Number(property && property.caution_fee) || 0;
    return { nights, option, lines, subtotal, serviceFee, cautionFee, total: subtotal + serviceFee + cautionFee };
}

// A real calendar day written YYYY-MM-DD. The engine's own date parsing also
// takes '2026-12', a year of six digits, and 29 February in a year that has
// none (it rolls that into March); none of those is a day a guest picked.
function isCalendarDay(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

// entity.get() REJECTS for an id that is not there; it does not return null.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = await req.json().catch(() => ({}));
        // total_price is deliberately NOT read from the body — see priceForStay.
        // property_title / property_location are accepted only as fallbacks
        // for the Telegram card; the Property row wins when it has them.
        const {
            property_id,
            property_title,
            property_location,
            check_in,
            check_out,
            guests,
            special_requests,
            bedrooms,
        } = body;

        if (!property_id || !check_in || !check_out) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Missing required fields: property_id, check_in, check_out',
            }), { status: 400, headers });
        }

        if (!isCalendarDay(check_in) || !isCalendarDay(check_out)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid date format' }), { status: 400, headers });
        }
        const checkInDate = new Date(check_in);
        const checkOutDate = new Date(check_out);
        if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid date format' }), { status: 400, headers });
        }
        if (checkOutDate <= checkInDate) {
            return new Response(JSON.stringify({ success: false, error: 'check_out must be after check_in' }), { status: 400, headers });
        }

        // ── Price from the Property row ─────────────────────────────────
        const property = await getOrNull(base44.asServiceRole.entities.Property, property_id);
        if (!property) {
            return new Response(JSON.stringify({ success: false, error: 'Property not found' }), { status: 404, headers });
        }
        const nights = nightsBetween(check_in, check_out);
        if (nights < 1) {
            return new Response(JSON.stringify({ success: false, error: 'A stay must be at least one night' }), { status: 400, headers });
        }
        if (nights > MAX_STAY_NIGHTS) {
            return new Response(JSON.stringify({
                success: false,
                error: `A stay can be at most ${MAX_STAY_NIGHTS} nights. Please contact support for a longer stay.`,
                code: 'STAY_TOO_LONG',
            }), { status: 400, headers });
        }
        // Priced night by night for the option the guest chose: each option
        // has its own rate and guest limit, and a seasonal rate applies only
        // to the nights that fall inside it.
        const options = bookingOptionsOf(property);
        const pricing = priceStay(property, check_in, check_out, bedrooms);
        if (!pricing && options.length > 0) {
            // The row has a price, so what failed is the option that was
            // named: it is not (or is no longer) one this property offers.
            // A request that names none is priced as the whole place.
            return new Response(JSON.stringify({
                success: false,
                error: 'That booking option is not available for this property. Please reload the page and choose again.',
                code: 'OPTION_UNAVAILABLE',
            }), { status: 400, headers });
        }
        const limit = pricing ? pricing.option.max_guests : 0;
        if (limit && Number(guests) > limit) {
            return new Response(JSON.stringify({
                success: false,
                error: options.length > 1
                    ? `The ${pricing.option.bedrooms}-bedroom option sleeps up to ${limit} guests`
                    : `This property sleeps up to ${limit} guests`,
                code: 'TOO_MANY_GUESTS',
            }), { status: 400, headers });
        }
        if (!pricing) {
            return new Response(JSON.stringify({
                success: false,
                error: 'This property has no nightly rate set. Please contact support.',
                code: 'NO_PRICE',
            }), { status: 409, headers });
        }
        const total_price = pricing.total;
        const resolvedTitle = property.title || property_title || 'Untitled property';
        const resolvedLocation = property.location || property_location || '';

        // Same-user same-property guard: if this guest already has an open
        // pending booking on this property — whether still awaiting admin
        // approval OR approved-and-awaiting-payment — they must finish (or let
        // it expire / cancel) before requesting another. Re-booking is only
        // unlocked once their prior booking is paid (status='confirmed'),
        // cancelled, or completed. Per product rule: paid/cancelled/current/past
        // are all re-bookable, only 'upcoming + unpaid' blocks.
        const userPending = await base44.asServiceRole.entities.Booking.filter({
            property_id,
            guest_email: user.email,
            status: 'pending',
        });
        if (userPending && userPending.length > 0) {
            const open = userPending[0];
            const awaitingPayment = !!open.approved_at;
            const msg = awaitingPayment
                ? 'You already have an approved booking for this property awaiting payment. Please complete payment (or let it expire) before booking it again.'
                : 'You already have a pending request for this property awaiting admin approval. Please wait for the response before submitting another.';
            return new Response(JSON.stringify({
                success: false,
                error: msg,
                code: awaitingPayment ? 'EXISTING_AWAITING_PAYMENT' : 'EXISTING_PENDING_APPROVAL',
                existing_booking_id: open.id,
            }), { status: 409, headers });
        }

        // Conflict detection: any existing pending/confirmed booking on the same property whose dates overlap
        // Latest-ending first and well past the default page of 50, so a busy
        // property's upcoming bookings are all in the list that is compared.
        const existing = await base44.asServiceRole.entities.Booking.filter({
            property_id,
            status: { $in: ['confirmed', 'pending'] },
        }, '-check_out', 500);
        const { hasConflict, conflicting } = detectConflict(existing, checkInDate, checkOutDate);
        const conflictDetails: ConflictDetails | null = hasConflict && conflicting ? {
            booking_id: conflicting.id,
            check_in: conflicting.check_in,
            check_out: conflicting.check_out,
            guest_email: conflicting.guest_email,
        } : null;

        // Both rows are written with the service role, never as the guest:
        // the guest reads them by their email, and a row a guest could write
        // by hand could carry any price or status. The option and the total
        // go on the request too, so the admin approving it in the app sees
        // what Telegram shows.
        const availabilityRequest = await base44.asServiceRole.entities.AvailabilityRequest.create({
            property_id,
            property_title: resolvedTitle,
            user_email: user.email,
            user_name: user.full_name || 'Guest User',
            check_in,
            check_out,
            guests,
            bedrooms_booked: options.length > 1 ? pricing.option.bedrooms : undefined,
            total_price,
            status: 'pending',
            has_conflict: hasConflict,
            conflict_details: conflictDetails,
        });

        // Create the pending Booking (holds the slot + the timer attaches once admin approves)
        const pendingBooking = await base44.asServiceRole.entities.Booking.create({
            property_id,
            guest_name: user.full_name || 'Guest User',
            guest_email: user.email,
            check_in,
            check_out,
            guests: guests || 1,
            // Server-computed. The only figure the payment verifiers ever
            // compare Paystack's amount against.
            total_price,
            // Which option was booked, when the property has several. The
            // whole property is still blocked for these dates whichever it is.
            bedrooms_booked: options.length > 1 ? pricing.option.bedrooms : undefined,
            special_requests: special_requests || '',
            status: 'pending',
            payment_status: 'unpaid',
        });

        // Notify admin (with property photo if available)
        let telegramMessageId: string | null = null;
        try {
            const propertyImageUrl = await fetchPropertyImage(base44, property_id);
            const tgResult = await sendAdminTelegram({
                propertyTitle: resolvedTitle,
                propertyId: property_id,
                propertyLocation: resolvedLocation,
                propertyImageUrl,
                userName: user.full_name || 'Guest User',
                userEmail: user.email,
                userMobile: user.phone_number || '',
                guests: guests || 1,
                optionLabel: options.length > 1 ? `${pricing.option.bedrooms}-bedroom option` : '',
                checkIn: check_in,
                checkOut: check_out,
                totalPrice: total_price,
                specialRequests: special_requests || '',
                hasConflict,
                conflicting,
                requestId: availabilityRequest.id,
            });
            telegramMessageId = tgResult.message_id;
        } catch (tgErr) {
            console.error('Telegram notification failed (non-fatal):', tgErr);
        }

        if (telegramMessageId) {
            try {
                await base44.asServiceRole.entities.AvailabilityRequest.update(availabilityRequest.id, {
                    telegram_message_id: telegramMessageId,
                });
            } catch (updateErr) {
                console.warn('Failed to attach telegram_message_id to request:', updateErr);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                request_id: availabilityRequest.id,
                booking_id: pendingBooking.id,
                // Returned so the checkout page shows the figure that was
                // actually stored, not its own pre-submit estimate.
                total_price,
                pricing,
                has_conflict: hasConflict,
                conflict_details: conflictDetails,
                telegram_sent: telegramMessageId !== null,
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('checkAvailabilityWebhook error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});