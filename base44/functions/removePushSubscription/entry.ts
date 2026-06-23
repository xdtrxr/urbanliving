import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// removePushSubscription
// ----------------------------------------------------------------------------
// Removes a Web Push subscription from the authenticated user's row.
//
// Called from:
//   - Profile "Disable notifications" toggle (after subscription.unsubscribe())
//   - The service worker's pushsubscriptionchange handler when the browser
//     invalidates the subscription (e.g. user cleared site data, key rotation)
//
// Matches by endpoint. Returns success even if the endpoint wasn't present
// — best-effort cleanup. Auth required so a random POST can't wipe someone
// else's devices.

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

    const endpoint: string | undefined = body?.endpoint;
    if (!endpoint || typeof endpoint !== 'string') {
        return Response.json({ error: 'Missing endpoint' }, { status: 400 });
    }

    try {
        const rows = await sdk.asServiceRole.entities.User.filter({ email: user.email });
        const me = rows[0];
        if (!me) return Response.json({ error: 'User row not found' }, { status: 404 });

        const existing = Array.isArray(me.push_subscriptions) ? me.push_subscriptions : [];
        const next = existing.filter((s: any) => s?.endpoint !== endpoint);

        if (next.length === existing.length) {
            // Already gone — return 200 so the client doesn't surface an error.
            return Response.json({ success: true, removed: 0, total: next.length });
        }

        await sdk.asServiceRole.entities.User.update(me.id, { push_subscriptions: next });
        return Response.json({ success: true, removed: existing.length - next.length, total: next.length });
    } catch (err) {
        console.error('removePushSubscription failed:', err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
});
