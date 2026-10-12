import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getBookedRanges
// ----------------------------------------------------------------------------
// The dates each of up to 50 properties is already taken for. Agent Nova asks
// before it recommends a place. Read in the browser, Booking shows a guest
// their own rows only (the read rule), so Nova never saw anybody else's stay
// and could offer a property that was taken.
//
// Body:   { property_ids: string[] }
// Answer: { ranges: { [property_id]: [{ check_in, check_out, status }] } }
// A booking counts while it is pending or confirmed and checks out today or
// later. Every property asked about gets a list, soonest stay first, and an
// empty one when nothing is booked.
//
// WHAT LEAVES. The service role reads every guest's bookings, so each range
// is built from three named fields and the row is never passed on: no guest,
// no price, no booking id.
//
// NO LOGIN IS REQUIRED. The concierge is a public page and Nova recommends to
// visitors with no session; the browser read gave those visitors nothing at
// all. notifyLead is called from the same page on the same terms. All a
// caller learns is which dates a listed property is taken, and a guest
// account, which is free, would show them that anyway. So the caller is never
// looked up: auth.me() throws when there is no session.

const MAX_PROPERTIES = 50;
// What holds a property's dates: a request still to be approved or paid for,
// and a paid stay.
const ACTIVE = ['confirmed', 'pending'];
const PAGE = 500;
// Nigeria is WAT (UTC+1) year-round. "Today" is the calendar day there; the
// server's clock is UTC, still on yesterday for the first hour of it.
const WAT_OFFSET_MS = 60 * 60 * 1000;

interface BookedRange { check_in: string; check_out: string; status: string }

// Each id goes into the query as it is, so it has to be a plain id: text, and
// nothing a query could read as an operator. Lockstep copy, see
// processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// A stored date as its calendar day, or '' when it is not one. A date-time is
// read as its day.
function dayOf(value: unknown) {
    const day = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
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
        const body = await req.json().catch(() => ({}));
        const asked = body?.property_ids;
        if (Array.isArray(asked) && asked.length > MAX_PROPERTIES) {
            return new Response(JSON.stringify({
                success: false,
                error: `Ask about at most ${MAX_PROPERTIES} properties at a time.`,
                code: 'TOO_MANY_PROPERTIES',
            }), { status: 400, headers });
        }
        if (!Array.isArray(asked) || !asked.every(isId)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'property_ids must be a list of property ids.',
            }), { status: 400, headers });
        }

        // One list for every property asked about, so "nothing booked" never
        // reads like "not answered". A Map, because an id is any plain text
        // and "__proto__" is not a key an object takes like the others.
        const byProperty = new Map<string, BookedRange[]>();
        for (const id of asked) byProperty.set(id, []);
        const ids = [...byProperty.keys()];

        const today = new Date(Date.now() + WAT_OFFSET_MS).toISOString().slice(0, 10);
        // Latest-ending first, a page at a time, until a page ends with a
        // stay that is over. A paid stay is still "confirmed" after the guest
        // has left (no function moves it on), so a property's history only
        // grows: in any other order, or on the default page of 50, it would
        // crowd out the bookings still to come. An empty list reads nothing.
        for (let skip = 0; ids.length > 0 && skip < 50000; skip += PAGE) {
            const page = await base44.asServiceRole.entities.Booking.filter({
                property_id: { $in: ids },
                status: { $in: ACTIVE },
            }, '-check_out', PAGE, skip);
            if (!Array.isArray(page) || page.length === 0) break;
            for (const b of page) {
                const list = byProperty.get(b.property_id);
                const checkIn = dayOf(b.check_in);
                const checkOut = dayOf(b.check_out);
                if (!list || !checkIn || checkOut < today) continue;
                list.push({ check_in: checkIn, check_out: checkOut, status: b.status });
            }
            const last = dayOf(page[page.length - 1].check_out);
            if (page.length < PAGE || (last && last < today)) break;
        }
        for (const list of byProperty.values()) list.sort((a, b) => a.check_in.localeCompare(b.check_in));

        return new Response(JSON.stringify({
            success: true,
            data: { ranges: Object.fromEntries(byProperty) },
        }), { status: 200, headers });
    } catch (error) {
        console.error('getBookedRanges error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
