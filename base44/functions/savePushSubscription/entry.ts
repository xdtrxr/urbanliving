import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// savePushSubscription
// ----------------------------------------------------------------------------
// Stores a Web Push subscription object on the authenticated user's row.
//
// The client calls PushManager.subscribe() in the browser, gets back a
// PushSubscription, then POSTs the JSON here. We keep it on
// User.push_subscriptions so sendPushNotification can deliver to every
// device the user has opted in from.
//
// Dedup: subscriptions are keyed by endpoint. If the user re-subscribes
// from the same browser (e.g. toggles off then on, or after a SW update),
// the old entry is replaced — we don't accumulate dupes.

Deno.serve(async (req) => {
    if (req.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let sdk: any;
    let user: any;
    try {
        sdk = createClientFromRequest(req);
        user = await sdk.auth.me();
    } catch {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { subscription, label } = body || {};
    if (!subscription || typeof subscription !== 'object' || !subscription.endpoint || !subscription.keys) {
        return Response.json({
            error: 'Missing or malformed subscription. Expected { subscription, label? } with subscription.endpoint and subscription.keys.',
        }, { status: 400 });
    }

    try {
        const rows = await sdk.asServiceRole.entities.User.filter({ email: user.email });
        const me = rows[0];
        if (!me) return Response.json({ error: 'User row not found' }, { status: 404 });

        const existing = Array.isArray(me.push_subscriptions) ? me.push_subscriptions : [];
        // Drop any prior entry with the same endpoint — re-subscriptions from
        // the same browser would otherwise stack and we'd send duplicate pushes.
        const deduped = existing.filter((s: any) => s?.endpoint !== subscription.endpoint);

        const next = [
            ...deduped,
            {
                endpoint: subscription.endpoint,
                expirationTime: subscription.expirationTime ?? null,
                keys: {
                    p256dh: subscription.keys.p256dh || '',
                    auth: subscription.keys.auth || '',
                },
                label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : undefined,
                created_at: new Date().toISOString(),
            },
        ];

        await sdk.asServiceRole.entities.User.update(me.id, { push_subscriptions: next });
        return Response.json({ success: true, total: next.length });
    } catch (err) {
        console.error('savePushSubscription failed:', err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
});
