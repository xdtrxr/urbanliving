import { lazy } from 'react';
import __Layout from './Layout.jsx';

const Search = lazy(() => import('./pages/Search'));
const Property = lazy(() => import('./pages/Property'));
const Bookings = lazy(() => import('./pages/Bookings'));
const Wishlist = lazy(() => import('./pages/Wishlist'));
const Profile = lazy(() => import('./pages/Profile'));
const AIChatConcierge = lazy(() => import('./pages/AIChatConcierge'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Trips = lazy(() => import('./pages/Trips'));
const TripPlanner = lazy(() => import('./pages/TripPlanner'));
const Admin = lazy(() => import('./pages/Admin'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const FAQ = lazy(() => import('./pages/FAQ'));
const Quests = lazy(() => import('./pages/Quests'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Support = lazy(() => import('./pages/Support'));
const PaymentPage = lazy(() => import('./pages/PaymentPage'));
const BankAccounts = lazy(() => import('./pages/BankAccounts'));
const Withdrawals = lazy(() => import('./pages/Withdrawals'));
const ReferralTest = lazy(() => import('./pages/ReferralTest'));

export const PAGES = {
    "Search": Search,
    "Property": Property,
    "Bookings": Bookings,
    "Wishlist": Wishlist,
    "Profile": Profile,
    "AIChatConcierge": AIChatConcierge,
    "Dashboard": Dashboard,
    "Trips": Trips,
    "TripPlanner": TripPlanner,
    "Admin": Admin,
    "PrivacyPolicy": PrivacyPolicy,
    "FAQ": FAQ,
    "Quests": Quests,
    "Checkout": Checkout,
    "Support": Support,
    "PaymentPage": PaymentPage,
    "BankAccounts": BankAccounts,
    "Withdrawals": Withdrawals,
    "ReferralTest": ReferralTest,
}

export const pagesConfig = {
    mainPage: "Search",
    Pages: PAGES,
    Layout: __Layout,
};
