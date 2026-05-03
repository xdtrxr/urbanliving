import Search from './pages/Search';
import Property from './pages/Property';
import Bookings from './pages/Bookings';
import Wishlist from './pages/Wishlist';
import Profile from './pages/Profile';
import AIChatConcierge from './pages/AIChatConcierge';
import Dashboard from './pages/Dashboard';
import Trips from './pages/Trips';
import TripPlanner from './pages/TripPlanner';
import Admin from './pages/Admin';
import PrivacyPolicy from './pages/PrivacyPolicy';
import FAQ from './pages/FAQ';
import Quests from './pages/Quests';
import Checkout from './pages/Checkout';
import Support from './pages/Support';
import PaymentPage from './pages/PaymentPage';
import BankAccounts from './pages/BankAccounts';
import Withdrawals from './pages/Withdrawals';
import ReferralTest from './pages/ReferralTest';
import __Layout from './Layout.jsx';


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