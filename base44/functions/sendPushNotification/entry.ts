import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';
import webpush from 'npm:web-push@3.6.7';

// sendPushNotification
// ----------------------------------------------------------------------------
// Server-side push helper. Given a user_email and a payload, encrypts the
// payload against every stored subscription on User.push_subscriptions and
// POSTs to each browser's push service.
//
// Other functions (verifyPaystackPayment, paystackTransferWebhook,
// telegramWebhook, etc.) invoke this — they don't call web-push directly,
// so the VAPID key handling and dead-subscription pruning live in one place.
//
// Subscription pruning: push services return 404 or 410 when a subscription
// is permanently dead (user uninstalled the PWA, cleared site data, etc.).
// We strip those endpoints from User.push_subscriptions so future sends
// don't waste round-trips. Transient errors (5xx, network) are logged but
// the subscription is kept.
//
// Invoke shape:
//   {
//     user_email: string,            // required
//     title: string,                 // required
//     body?: string,
//     url?: string,                  // path the SW opens on click
//     tag?: string,                  // dedupe key
//     data?: object,                 // forwarded to notificationclick
//   }
//
// Returns: { success, sent, pruned, total }

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:hassan@urbanstays.io';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ── Caller gate ─────────────────────────────────────────────────────────────
// This function is invoked by other functions (webhooks, crons, decision
// paths) that carry no user session, so it cannot demand a login. Until this
// gate existed it accepted any POST, which let anyone push arbitrary text and
// a link to any user by email — a phishing tool. Internal callers now pass
// INTERNAL_FUNCTION_SECRET in the body; a logged-in admin may also call it
// directly. If the secret is not configured the gate warns and allows, so an
// unset env var degrades to the old behaviour rather than killing every push.
const INTERNAL_SECRET = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function internalOrAdmin(sdk: any, body: any): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!INTERNAL_SECRET) {
        console.warn('INTERNAL_FUNCTION_SECRET not configured — sendPushNotification is accepting unauthenticated calls');
        return { ok: true };
    }
    const presented = typeof body?.internal_secret === 'string' ? body.internal_secret : '';
    if (presented && safeEqual(presented, INTERNAL_SECRET)) return { ok: true };
    try {
        const user = await sdk.auth.me();
        if (user?.role === 'admin') return { ok: true };
    } catch { /* no session on this request */ }
    return { ok: false, status: 401, error: 'Unauthorized' };
}

Deno.serve(async (req) => {
    if (req.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('sendPushNotification: VAPID keys not configured — push disabled');
        return Response.json({ success: false, error: 'Push not configured' }, { status: 503 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { user_email, title, body: msgBody, url, tag, data: extraData } = body || {};
    if (!user_email || !title) {
        return Response.json({ error: 'Missing user_email or title' }, { status: 400 });
    }

    const sdk = createClientFromRequest(req);

    const gate = await internalOrAdmin(sdk, body);
    if (!gate.ok) return Response.json({ success: false, error: gate.error }, { status: gate.status });

    try {
        const rows = await sdk.asServiceRole.entities.User.filter({ email: user_email });
        const user = rows[0];
        if (!user) {
            return Response.json({ success: false, error: 'User not found' }, { status: 404 });
        }

        const subscriptions = Array.isArray(user.push_subscriptions) ? user.push_subscriptions : [];
        if (subscriptions.length === 0) {
            return Response.json({ success: true, sent: 0, pruned: 0, total: 0, skipped: 'no_subscriptions' });
        }

        const payload = JSON.stringify({
            title,
            body: msgBody || '',
            url: url || '/',
            tag,
            data: extraData || {},
        });

        const deadEndpoints: string[] = [];
        let sent = 0;

        // Fire in parallel — push services accept many concurrent requests
        // per subscription endpoint, and serial would block for too long.
        const results = await Promise.allSettled(
            subscriptions.map(async (sub: any) => {
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: sub.endpoint,
                            keys: sub.keys || {},
                        },
                        payload,
                    );
                    return { ok: true, endpoint: sub.endpoint };
                } catch (err: any) {
                    const status = err?.statusCode;
                    // 404 = subscription doesn't exist anymore
                    // 410 = "Gone" — browser uninstalled / unsubscribed
                    if (status === 404 || status === 410) {
                        return { ok: false, endpoint: sub.endpoint, dead: true };
                    }
                    console.warn(`Push send failed for ${sub.endpoint} (status ${status}):`, err?.body || err?.message);
                    return { ok: false, endpoint: sub.endpoint, dead: false };
                }
            }),
        );

        for (const r of results) {
            if (r.status === 'fulfilled') {
                if (r.value.ok) sent += 1;
                if (r.value.dead) deadEndpoints.push(r.value.endpoint);
            }
        }

        // Prune dead subscriptions in a single User write.
        if (deadEndpoints.length > 0) {
            const next = subscriptions.filter((s: any) => !deadEndpoints.includes(s?.endpoint));
            await sdk.asServiceRole.entities.User.update(user.id, { push_subscriptions: next });
        }

        return Response.json({
            success: true,
            sent,
            pruned: deadEndpoints.length,
            total: subscriptions.length,
        });
    } catch (err) {
        console.error('sendPushNotification failed:', err);
        return Response.json({ success: false, error: (err as Error).message }, { status: 500 });
    }
});
