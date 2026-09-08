import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// submitBookingId
// ----------------------------------------------------------------------------
// Attaches the guest's ID document to a paid booking. The only remaining
// guest-side write to a Booking now that the entity's update rule is
// admin-only, so it exists to write exactly three fields and nothing else.
//
// Two shapes:
//   { booking_id, id_document_url, id_document_type }   fresh upload
//   { booking_id, reuse_from_booking_id }               copy from a prior stay
//
// The reuse path copies server-side after checking both bookings belong to
// the caller, rather than trusting a URL the client read off another row.

const ID_TYPES = ['national_id', 'drivers_license', 'passport', 'voters_card', 'other'];
const MAX_URL_LEN = 2048;

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
        const bookingId = String(body.booking_id || '').trim();
        if (!bookingId) return json({ success: false, error: 'booking_id is required' }, 400);

        const booking = await base44.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) return json({ success: false, error: 'Booking not found' }, 404);
        if (booking.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        let url = '';
        let type = '';

        if (body.reuse_from_booking_id) {
            const source = await base44.asServiceRole.entities.Booking.get(String(body.reuse_from_booking_id));
            if (!source || source.guest_email !== booking.guest_email) {
                return json({ success: false, error: 'No prior ID found to reuse', code: 'NO_PRIOR_ID' }, 404);
            }
            if (!source.id_document_url) {
                return json({ success: false, error: 'That booking has no ID on file', code: 'NO_PRIOR_ID' }, 404);
            }
            url = String(source.id_document_url);
            type = String(source.id_document_type || 'other');
        } else {
            url = String(body.id_document_url || '').trim();
            type = String(body.id_document_type || '').trim();
            if (!url.startsWith('https://') || url.length > MAX_URL_LEN) {
                return json({ success: false, error: 'id_document_url must be an https URL', code: 'BAD_URL' }, 400);
            }
            if (!ID_TYPES.includes(type)) {
                return json({ success: false, error: `id_document_type must be one of ${ID_TYPES.join(', ')}`, code: 'BAD_TYPE' }, 400);
            }
        }

        await base44.asServiceRole.entities.Booking.update(bookingId, {
            id_document_url: url,
            id_document_type: type,
            id_uploaded_at: new Date().toISOString(),
        });

        return json({ success: true, data: { booking_id: bookingId, id_document_type: type } });
    } catch (error) {
        console.error('submitBookingId error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
