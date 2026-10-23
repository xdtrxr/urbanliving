import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverProfile
// ----------------------------------------------------------------------------
// Answers one question for the signed-in user: "am I a driver here?"
//
// There is no driver role. A driver is an ordinary account whose email admin
// has written on a Driver row (Driver.user_email). The Driver entity is
// admin-only at the API, so the browser cannot look itself up; this function
// does it under the service role and returns a handful of harmless fields, or
// null. The navigation calls it once per session to decide whether to show
// "My rides" and "Wallet".
//
// A deactivated or unapproved driver still gets their profile back: those
// switches stop new assignments (assignRideDriver enforces them), they must
// never lock someone out of pay they have already earned.

// The Driver row this login belongs to, or null. The Drivers admin form stores
// emails trimmed and lower-cased; the second lookup covers a row typed
// straight into the data browser with capitals. Two rows on one login is an
// admin mistake: the oldest wins, so the answer never flips between calls.
// Lockstep copies in getDriverRides, getDriverWallet and
// createWithdrawalRequest; scripts/check-driver-wallet.mjs compares them.
async function findDriverForUser(sr: any, email: string) {
    const raw = String(email || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return null;
    let rows = await sr.Driver.filter({ user_email: lower });
    if ((!rows || rows.length === 0) && raw !== lower) rows = await sr.Driver.filter({ user_email: raw });
    if (!rows || rows.length === 0) return null;
    rows.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
    return rows[0];
}

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
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const driver = await findDriverForUser(base44.asServiceRole.entities, user.email);
        if (!driver) return json({ success: true, data: null });

        // Explicit allow-list: licence details, phone and the login history
        // stay on the server.
        return json({
            success: true,
            data: {
                id: driver.id,
                full_name: driver.full_name || '',
                photo: driver.photo || null,
                city: driver.city || null,
                active: driver.active !== false,
                admin_approved: driver.admin_approved !== false,
            },
        });
    } catch (error) {
        console.error('getDriverProfile error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
