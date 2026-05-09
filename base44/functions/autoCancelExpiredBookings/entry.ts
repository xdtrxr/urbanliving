import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Auto-cancels pending bookings whose payment_deadline has passed and notifies
// admin via Telegram. Runs on a schedule (Deno.cron) and is also exposed as a
// manual POST endpoint for testing or admin re-runs.

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const APPROVAL_CAP_MS = 3 * HOUR_MS;

function computeDeadlineMs(b: any): number | null {
    const approvedAt = Date.parse(b.approved_at || '');
    if (Number.isNaN(approvedAt)) return null;
    const startedAt = Date.parse(b.payment_started_at || '');
    const fromOpen = Number.isNaN(startedAt) ? 0 : startedAt + PAYMENT_WINDOW_MS;
    const fromApproval = approvedAt + PAYMENT_WINDOW_MS;
    const cap = approvedAt + APPROVAL_CAP_MS;
    return Math.min(cap, Math.max(fromApproval, fromOpen));
}

async function notifyAdmin(b: any) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const message =
        `⏰ *PAYMENT TIMER EXPIRED*\n\n` +
        `Booking \`${b.id}\` was auto-cancelled.\n` +
        `• Guest: ${b.guest_name} (${b.guest_email})\n` +
        `• Property: \`${b.property_id}\`\n` +
        `• Dates: ${b.check_in} → ${b.check_out}\n` +
        `• Total: ₦${(b.total_price || 0).toLocaleString()}`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram expiry notify failed:', err);
    }
}

async function runSweep(): Promise<{ scanned: number; cancelled: number }> {
    const appId = Deno.env.get('BASE44_APP_ID');
    const apiKey = Deno.env.get('BASE44_SERVICE_ROLE_KEY');
    if (!appId || !apiKey) {
        console.error('BASE44_APP_ID / BASE44_SERVICE_ROLE_KEY not configured');
        return { scanned: 0, cancelled: 0 };
    }
    const sdk = createClient({ appId, serviceToken: apiKey, requiresAuth: false });

    const pending = await sdk.asServiceRole.entities.Booking.filter({ status: 'pending' });
    const now = Date.now();
    let cancelled = 0;

    for (const b of pending) {
        const deadlineMs = computeDeadlineMs(b);
        if (deadlineMs === null) continue; // not approved yet
        if (now <= deadlineMs) continue;
        try {
            await sdk.asServiceRole.entities.Booking.update(b.id, { status: 'cancelled' });
            await notifyAdmin(b);
            cancelled += 1;
            console.log(`⏰ Auto-cancelled expired booking ${b.id}`);
        } catch (err) {
            console.error(`Failed to auto-cancel booking ${b.id}:`, err);
        }
    }

    return { scanned: pending.length, cancelled };
}

// Scheduled execution. Base44's runtime supports Deno.cron at module top level.
try {
    Deno.cron('auto-cancel expired bookings', '*/5 * * * *', async () => {
        console.log('🕒 Cron: sweeping expired pending bookings');
        const result = await runSweep();
        console.log(`🕒 Cron complete: scanned ${result.scanned}, cancelled ${result.cancelled}`);
    });
} catch (cronErr) {
    // Some environments don't support Deno.cron at top level; the HTTP handler
    // below still works for manual/scheduled triggers via curl or Base44 hooks.
    console.warn('Deno.cron registration failed:', cronErr);
}

// Manual HTTP trigger — admin only. Useful for ad-hoc sweeps or test environments
// that don't expose Deno.cron.
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

    // Admin-only when invoked via HTTP (the cron entry point bypasses Deno.serve).
    try {
        const userClient = createClientFromRequest(req);
        const user = await userClient.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }
        if (user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Admin role required' }), { status: 403, headers });
        }
    } catch (authErr) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
    }

    try {
        const result = await runSweep();
        return new Response(JSON.stringify({ success: true, data: result }), { status: 200, headers });
    } catch (error) {
        console.error('autoCancelExpiredBookings error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
