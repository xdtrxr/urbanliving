import { lazy } from 'react';
import __Layout from './Layout.jsx';

const Search = lazy(() => import('./pages/Search'));
const Property = lazy(() => import('./pages/Property'));
const Bookings = lazy(() => import('./pages/Bookings'));
const Wishlist = lazy(() => import('./pages/Wishlist'));
const Profile = lazy(() => import('./pages/Profile'));
const AIChatConcierge = lazy(() => import('./pages/AIChatConcierge'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const PlanTrip = lazy(() => import('./pages/PlanTrip'));
const Vehicle = lazy(() => import('./pages/Vehicle'));
const RideCheckout = lazy(() => import('./pages/RideCheckout'));
const Admin = lazy(() => import('./pages/Admin'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const FAQ = lazy(() => import('./pages/FAQ'));
const Quests = lazy(() => import('./pages/Quests'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Support = lazy(() => import('./pages/Support'));
const PaymentPage = lazy(() => import('./pages/PaymentPage'));
const BankAccounts = lazy(() => import('./pages/BankAccounts'));
const Withdrawals = lazy(() => import('./pages/Withdrawals'));
const Landing = lazy(() => import('./pages/Landing'));
const Install = lazy(() => import('./pages/Install'));

// Pages that render edge-to-edge without the standard Layout chrome
// (no sidebar, no floating header). Marketing/install pages only.
export const BARE_PAGES = new Set(["Landing", "Install"]);

export const PAGES = {
    "Landing": Landing,
    "Install": Install,
    "Search": Search,
    "Property": Property,
    "Bookings": Bookings,
    "Wishlist": Wishlist,
    "Profile": Profile,
    "AIChatConcierge": AIChatConcierge,
    "Dashboard": Dashboard,
    "PlanTrip": PlanTrip,
    "Vehicle": Vehicle,
    "RideCheckout": RideCheckout,
    "Admin": Admin,
    "PrivacyPolicy": PrivacyPolicy,
    "FAQ": FAQ,
    "Quests": Quests,
    "Checkout": Checkout,
    "Support": Support,
    "PaymentPage": PaymentPage,
    "BankAccounts": BankAccounts,
    "Withdrawals": Withdrawals,
}

export const pagesConfig = {
    mainPage: "Landing",
    Pages: PAGES,
    Layout: __Layout,
    barePages: BARE_PAGES,
};
