// Who sees what on the Admin page, and what each role may do.
//
// Three roles live in User.role. A guest ('user') never opens the Admin page.
// A listings helper ('listing_helper') opens it to add and edit properties
// and vehicles, which the Property and Vehicle create and update rules allow
// them, and sees nothing else: none of the guest, payment, payout or support
// data an admin sees is even loaded for them, and no delete button is shown,
// because the delete rules are admin-only. An admin sees everything.
//
// The screens ask here instead of comparing roles themselves, so the answer
// lives in one place: src/pages/Admin.jsx (tabs, cards and loads),
// src/Layout.jsx and src/lib/PageNotFound.jsx (the menu entry), and
// VehiclesAdmin (costing and delete, through the props Admin.jsx passes).
// The access rules are what actually refuse; this only keeps the screen
// from offering what would be refused, and from fetching what is not theirs.
// No imports on purpose: scripts/check-manage-users.mjs loads this file as
// it is.

// Lockstep copy in base44/functions/manageUsers/entry.ts. The order is the
// order the role selects list them.
export const ROLES = ['user', 'listing_helper', 'admin'];

export const ROLE_LABELS = { user: 'User', listing_helper: 'Listings helper', admin: 'Admin' };

// A row from before roles were written on every account has none: it is a
// user. A role this file does not know is shown as it is spelled.
export const roleLabel = (role) => ROLE_LABELS[role || 'user'] || String(role);

// Every tab on the Admin page, in the order they appear.
export const ADMIN_TABS = ['overview', 'add-manual', 'manage-properties', 'vehicles', 'rides', 'leads', 'withdrawals', 'users'];
const HELPER_TABS = ['add-manual', 'manage-properties', 'vehicles'];

const NO_ACCESS = Object.freeze({
  allowed: false, full: false, tabs: [], defaultTab: null, canDelete: false, canSeeCosting: false, menuLabel: null,
});

// What the Admin page offers a role:
//   allowed        may open the page at all
//   full           everything an admin sees: stats, requests, payments on
//                  hold, bookings, support, rides, leads, withdrawals, users
//   tabs           the tabs shown, in order
//   defaultTab     where the page opens
//   canDelete      the delete buttons on properties and vehicles
//   canSeeCosting  a vehicle's partner cost, driver cost and markup
//   menuLabel      the sidebar entry, or null for none
export function adminAccess(role) {
  if (role === 'admin') {
    return {
      allowed: true, full: true, tabs: ADMIN_TABS, defaultTab: 'overview', canDelete: true, canSeeCosting: true, menuLabel: 'Admin Panel',
    };
  }
  if (role === 'listing_helper') {
    return {
      allowed: true, full: false, tabs: HELPER_TABS, defaultTab: 'add-manual', canDelete: false, canSeeCosting: false, menuLabel: 'Listings',
    };
  }
  return NO_ACCESS;
}

// What a role may do, in the words the confirmation shows before anyone is
// given it. Plain on purpose: the owner decides from this alone.
export const ROLE_POWERS = {
  admin: {
    summary: 'Admin can do everything in the app.',
    can: [
      'See every guest booking and guest details, including uploaded IDs',
      'Confirm or refund payments on hold',
      'Pay drivers and approve withdrawals',
      'Delete properties and vehicles',
      'Make other people admin, or take it away',
    ],
    cannot: [],
  },
  listing_helper: {
    summary: 'A listings helper adds and edits properties and vehicles, and nothing else.',
    can: [
      'Add properties and vehicles, with photos and videos',
      'Edit any property or vehicle, prices included',
    ],
    cannot: [
      'Delete anything',
      'See guest bookings, payments, payouts or what a car costs UrbanStays',
      'Change anyone\'s role',
    ],
  },
  user: {
    summary: 'A regular account: they can book stays and rides, and cannot open the Admin page.',
    can: [],
    cannot: [],
  },
};

// What the Users tab says once an invitation has gone out. The platform's
// invitation knows only User and Admin, so a listings helper is invited as a
// user (the server answers invited_as) and is set to helper once signed up.
export function inviteSentNote(data) {
  const email = (data && data.email) || 'them';
  const wanted = (data && data.role) || 'user';
  const as = (data && data.invited_as) || wanted;
  if (as !== wanted) {
    return `Invitation sent to ${email}. They join as a ${roleLabel(as)}; once they have signed up, set them to ${roleLabel(wanted)} in the list.`;
  }
  return `Invitation sent to ${email}, as ${roleLabel(wanted)}.`;
}
