import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// manageUsers
// ----------------------------------------------------------------------------
// The Users tab on the Admin page: who has an account, what each may do, and
// invitations for new people.
//
// Three roles, kept in User.role:
//   user            every guest
//   listing_helper  may add and edit properties and vehicles, nothing else.
//                   The Property and Vehicle create and update rules name it;
//                   no other rule does, so it reaches no guest data, no
//                   payment, no payout and no costing.
//   admin           everything: guest bookings and details, payments on hold
//                   and refunds, driver payouts, and this function.
//
// Body: { action: 'list' }
//       { action: 'set_role', user_id, role }
//       { action: 'invite', email, role }
// Who may: an admin session. A listing helper is refused like anyone else.
//
// The role is written with the service role. The field-level rule on
// User.role is admin-only, which is what keeps a person from promoting
// themselves with auth.updateMe; this function is the one way the app
// changes it.

// Lockstep copy of ROLES in src/config/adminAccess.js.
const ROLES = ['user', 'listing_helper', 'admin'];
const ROLE_NAMES: Record<string, string> = { user: 'User', listing_helper: 'Listings helper', admin: 'Admin' };
const roleName = (role: unknown) => ROLE_NAMES[String(role || 'user')] || String(role);

// Newest first, a page at a time, and a ceiling. A filter given no sort and
// no limit answers with the platform's default page in its own order.
const PAGE = 200;
const MAX_USERS = 1000;

// An id goes into the URL of the row it fetches, so only a plain id is ever
// used. Lockstep copy, see createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there. Lockstep copy, see
// markHeldPaymentRefunded.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

const looksLikeEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const sameEmail = (a: unknown, b: unknown) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// What the screen is given about a person. Nothing else on the row (wallet,
// referral balance, push subscriptions) leaves this function.
const summary = (u: any) => ({
    id: u.id,
    full_name: u.full_name || '',
    email: u.email || '',
    role: u.role || 'user',
    created_date: u.created_date || null,
});

const who = (u: any) => (u.full_name ? `${u.full_name} (${u.email})` : String(u.email || u.id));

// One plain-text line to the admin group. Plain text on purpose: names are
// typed by the people they belong to and were never escaped for Markdown,
// and Telegram drops a message it cannot parse. Failure is logged, never
// passed on: the change has already been made.
async function notifyAdminLine(text: string) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    } catch (err) {
        console.error('Telegram notify failed (non-fatal):', err);
    }
}

async function countAdmins(db: any, exceptId?: string) {
    const rows = await db.User.filter({ role: 'admin' }, '-created_date', 5);
    return (Array.isArray(rows) ? rows : []).filter((u) => u && u.id !== exceptId).length;
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
        // auth.me() throws for a caller who is not signed in.
        const me = await base44.auth.me().catch(() => null);
        if (!me) return json({ success: false, error: 'Please sign in again.', code: 'UNAUTHORIZED' }, 401);
        if (me.role !== 'admin') {
            return json({ success: false, error: 'Only an admin can manage users.', code: 'ADMIN_ONLY' }, 403);
        }

        const body = await req.json().catch(() => ({}));
        const action = body && typeof body.action === 'string' ? body.action : '';
        const db = base44.asServiceRole.entities;

        if (action === 'list') {
            const seen = new Set<string>();
            const users: any[] = [];
            let full = false;
            for (let skip = 0; skip < MAX_USERS; skip += PAGE) {
                const page = await db.User.filter({}, '-created_date', PAGE, skip);
                if (!Array.isArray(page) || page.length === 0) break;
                // Someone signing up between two pages moves everyone down
                // one place, so the next page can repeat a row.
                for (const u of page) {
                    if (!u || seen.has(u.id)) continue;
                    seen.add(u.id);
                    users.push(summary(u));
                }
                if (page.length < PAGE) break;
                if (skip + PAGE >= MAX_USERS) full = true;
            }
            return json({ success: true, data: { users: users.slice(0, MAX_USERS), truncated: full } });
        }

        if (action !== 'set_role' && action !== 'invite') {
            return json({ success: false, error: 'Unknown action.', code: 'BAD_ACTION' }, 400);
        }

        const role = typeof body.role === 'string' ? body.role : '';
        if (!ROLES.includes(role)) {
            return json({ success: false, error: 'Choose User, Listings helper or Admin.', code: 'BAD_ROLE' }, 400);
        }

        if (action === 'set_role') {
            const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
            if (!isId(userId)) return json({ success: false, error: 'That user was not found.', code: 'NOT_FOUND' }, 404);
            // An admin who could demote themselves could leave nobody able to
            // put them back. Another admin can change it.
            if (userId === me.id) {
                return json({ success: false, error: 'You cannot change your own role. Ask another admin to.', code: 'OWN_ROLE' }, 409);
            }
            const target = await getOrNull(db.User, userId);
            if (!target) return json({ success: false, error: 'That user was not found.', code: 'NOT_FOUND' }, 404);
            if (sameEmail(target.email, me.email)) {
                return json({ success: false, error: 'You cannot change your own role. Ask another admin to.', code: 'OWN_ROLE' }, 409);
            }

            const from = target.role || 'user';
            if (from === role) {
                return json({ success: true, data: { user: summary(target), previous_role: from, unchanged: true } });
            }

            // The caller is an admin and cannot be the one demoted, so this
            // should never find nobody. It counts the table rather than
            // trusting the session: a session can be older than a change
            // made a moment ago by another admin or in the Base44 dashboard.
            const lastAdmin = () => json({
                success: false,
                error: `${target.full_name || target.email || 'This person'} is the only admin. Make someone else admin first, so the app is never left without one.`,
                code: 'LAST_ADMIN',
            }, 409);
            const demoting = from === 'admin' && role !== 'admin';
            if (demoting && await countAdmins(db, target.id) === 0) return lastAdmin();

            await db.User.update(target.id, { role });

            // Two admins demoting each other at the same moment both pass the
            // count above. Whoever finds no admin left afterwards puts their
            // own change back, so the app always keeps one.
            if (demoting && await countAdmins(db) === 0) {
                await db.User.update(target.id, { role: 'admin' });
                return lastAdmin();
            }

            console.log(`manageUsers: ${me.email} changed ${target.email} from ${from} to ${role}`);
            await notifyAdminLine(`Role changed by ${who(me)}: ${who(target)} is now ${roleName(role)} (was ${roleName(from)}).`);
            return json({ success: true, data: { user: { id: target.id, full_name: target.full_name || '', email: target.email || '', role }, previous_role: from } });
        }

        // action === 'invite'
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!looksLikeEmail(email)) {
            return json({ success: false, error: 'Enter a full email address, like name@example.com.', code: 'BAD_EMAIL' }, 400);
        }
        const existing = await db.User.filter({ email }, '-created_date', 1);
        if (Array.isArray(existing) && existing.length > 0) {
            return json({ success: false, error: `${email} already has an account. Change their role in the list instead.`, code: 'ALREADY_USER' }, 409);
        }

        // The platform's invitation knows two roles, 'user' and 'admin'; the
        // SDK refuses any other before sending. A listings helper is invited
        // as a user, and an admin sets the role in the list once they have
        // signed up. The invitation goes out on the caller's own client:
        // asServiceRole has no users module (SDK 0.8.27 and 0.8.53 alike).
        // Invitations count toward a daily allowance on the Base44 plan.
        const invitedAs = role === 'admin' ? 'admin' : 'user';
        const users = (base44 as any).users;
        if (!users || typeof users.inviteUser !== 'function') {
            return json({ success: false, error: 'Invitations are not available right now. Try again later.', code: 'INVITE_FAILED' }, 502);
        }
        try {
            await users.inviteUser(email, invitedAs);
        } catch (err) {
            console.error('manageUsers: invite failed:', err);
            const said = err && err.response && err.response.data && (err.response.data.message || err.response.data.detail);
            return json({
                success: false,
                error: 'Base44 did not send the invitation. Invitations have a daily limit on the Base44 plan, so if several went out today, try again tomorrow.'
                    + (typeof said === 'string' && said.trim() ? ` (Base44 said: ${said.trim()})` : ''),
                code: 'INVITE_FAILED',
            }, 502);
        }

        console.log(`manageUsers: ${me.email} invited ${email} as ${invitedAs} (for ${role})`);
        await notifyAdminLine(`Invitation sent by ${who(me)}: ${email}, for ${roleName(role)}.`);
        return json({ success: true, data: { invited: true, email, role, invited_as: invitedAs } });
    } catch (error) {
        console.error('manageUsers error:', error);
        return json({ success: false, error: 'Something went wrong. Please try again.', details: (error as Error).message }, 500);
    }
});
