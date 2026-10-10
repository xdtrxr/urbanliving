import React from "react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Search, Calendar, User, Heart, MessageCircle, LayoutGrid, Compass, Settings, Shield, HelpCircle, Trophy, LogOut, Wallet, CreditCard, Car, Banknote } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { User as UserEntity } from "@/entities/User";
import ReferralTracker from "@/components/utils/ReferralTracker";
import { useAuth } from "@/lib/AuthContext";
import { useDriverProfile } from "@/lib/useDriverProfile";
import { LogIn } from "lucide-react";
import ThemeToggle from "@/components/ui/ThemeToggle";
import BrandMark from "@/components/brand/BrandMark";

const navigationItems = [
  {
    title: "Dashboard",
    url: createPageUrl("Dashboard"),
    icon: LayoutGrid,
    description: "Your personal overview"
  },
  {
    title: "Discover",
    url: createPageUrl("Search"),
    icon: Search,
    description: "Find your perfect stay"
  },
  {
    title: "Agent Nova",
    url: createPageUrl("AIChatConcierge"),
    icon: MessageCircle,
    description: "Get personalized advice"
  },
  {
    title: "Support",
    url: createPageUrl("Support"),
    icon: HelpCircle,
    description: "Get help & assistance"
  },
  {
    title: "Quests",
    url: createPageUrl("Quests"),
    icon: Trophy,
    description: "Earn rewards & points"
  },
  {
    title: "Book a Ride",
    url: createPageUrl("PlanTrip"),
    icon: Compass,
    description: "A car with a driver, in your city"
  },
  {
    title: "My Bookings",
    url: createPageUrl("Bookings"),
    icon: Calendar,
    description: "Manage reservations"
  },
  {
    title: "Withdrawals",
    url: createPageUrl("Withdrawals"),
    icon: Wallet,
    description: "Withdraw earnings"
  },
  {
    title: "Bank Accounts",
    url: createPageUrl("BankAccounts"),
    icon: CreditCard,
    description: "Manage bank accounts"
  },
  {
    title: "Wishlist",
    url: createPageUrl("Wishlist"),
    icon: Heart,
    description: "Saved properties"
  },
  {
    title: "Profile",
    url: createPageUrl("Profile"),
    icon: User,
    description: "Account settings"
  }
];

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [user, setUser] = React.useState(null);
  const { logout: authLogout } = useAuth();

  React.useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      const userData = await UserEntity.me();
      setUser(userData);
    } catch (error) {
      // User not logged in
    }
  };

  const handleLogout = () => {
    // Use AuthContext.logout — clears the SDK token and lands the user
    // on our standalone /login (no Base44-hosted redirect).
    authLogout(true);
  };

  // Drivers get their own pages first: it is what they open the app for.
  // isDriver stays false for everyone else, so nothing changes for guests.
  const { isDriver } = useDriverProfile();
  const driverItems = isDriver ? [
    {
      title: "My rides",
      url: createPageUrl("DriverRides"),
      icon: Car,
      description: "Rides assigned to you"
    },
  ] : [];

  // Add admin link if user is admin
  const menuItems = [...driverItems, ...navigationItems];
  if (user?.role === 'admin') {
    menuItems.push({
      title: "Admin Panel",
      url: createPageUrl("Admin"),
      icon: Settings,
      description: "Manage property data"
    });
  }

  return (
    <SidebarProvider defaultOpen={true}>
      <LayoutShell
        user={user}
        menuItems={menuItems}
        location={location}
        handleLogout={handleLogout}
      >
        {children}
      </LayoutShell>
    </SidebarProvider>
  );
}

// Inner shell so we can use the `useSidebar` hook (it needs the SidebarProvider
// in the tree above it). Lets the mobile sheet auto-close after nav clicks.
function LayoutShell({ user, menuItems, location, handleLogout, children }) {
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const closeMobileSheet = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      {/* Referral Tracker - runs silently in the background */}
      <ReferralTracker />
      
      <style>{`
        :root {
          --primary-navy: #0F172A;
          --primary-gold: #F59E0B;
          --accent-blue: #3B82F6;
          --soft-gray: #F8FAFC;
          --warm-white: #FEFEFE;
        }
        
        /* Custom styles for collapsed sidebar */
        [data-sidebar="sidebar"][data-state="collapsed"] {
          width: 4rem;
        }
        
        [data-sidebar="sidebar"][data-state="collapsed"] [data-sidebar="menu-button"] {
          justify-content: center;
          padding: 0.75rem;
        }
        
        [data-sidebar="sidebar"][data-state="collapsed"] .sidebar-menu-text {
          display: none;
        }
        
        [data-sidebar="sidebar"][data-state="collapsed"] .sidebar-header-text {
          display: none;
        }
        
        [data-sidebar="sidebar"][data-state="collapsed"] .sidebar-footer-text {
          display: none;
        }
      `}</style>
      
      <div className="min-h-screen flex w-full bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900">
        {user && (
        <Sidebar collapsible="icon" className="border-r border-slate-200/60 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-xl">
          <SidebarHeader className="border-b border-slate-100 dark:border-slate-800 p-4">
            <div className="flex items-center gap-3 justify-center group-data-[collapsible=icon]:justify-center">
              <BrandMark className="w-8 h-8" radius="rounded-xl" />
              <div className="sidebar-header-text group-data-[collapsible=icon]:hidden">
                <h2 className="font-bold text-slate-900 dark:text-white text-base tracking-tight">Urban Stays</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Luxury Stays Worldwide</p>
              </div>
            </div>
          </SidebarHeader>
          
          <SidebarContent className="p-2 flex flex-col h-full">
            <div className="flex-1">
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-1">
                    {menuItems.map((item) => (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          asChild
                          className={`relative hover:bg-slate-100/80 dark:hover:bg-slate-800/80 transition-all duration-300 rounded-xl group ${
                            location.pathname === item.url
                              ? 'bg-gradient-to-r from-slate-900 to-slate-800 dark:from-amber-500 dark:to-amber-600 text-white shadow-lg'
                              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                          }`}
                          tooltip={item.title}
                        >
                          <Link to={item.url} onClick={closeMobileSheet} className="flex items-center gap-3 px-3 py-2.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
                            <item.icon className={`w-5 h-5 transition-colors flex-shrink-0 ${
                              location.pathname === item.url ? 'text-amber-400 dark:text-white' : 'group-hover:text-amber-500'
                            }`} />
                            <div className="sidebar-menu-text flex flex-col group-data-[collapsible=icon]:hidden">
                              <span className="font-semibold text-sm leading-tight">{item.title}</span>
                              <span className={`text-[10px] leading-tight ${
                                location.pathname === item.url ? 'text-slate-300 dark:text-amber-100' : 'text-slate-400 dark:text-slate-500'
                              }`}>
                                {item.description}
                              </span>
                            </div>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </div>
            
            <div className="mt-auto pt-3 border-t border-slate-100 dark:border-slate-800">
              <div className="sidebar-footer-text group-data-[collapsible=icon]:hidden">
                <div className="flex items-center justify-center gap-3 px-3 py-2">
                  <Link
                    to={createPageUrl("PrivacyPolicy")}
                    onClick={closeMobileSheet}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors duration-200"
                  >
                    Privacy policy
                  </Link>
                  <span className="text-xs text-slate-300 dark:text-slate-600">|</span>
                  <Link
                    to={createPageUrl("FAQ")}
                    onClick={closeMobileSheet}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors duration-200"
                  >
                    FAQs
                  </Link>
                </div>
              </div>
              
              {/* Icons only when collapsed */}
              <div className="group-data-[collapsible=icon]:block hidden">
                <SidebarMenu className="space-y-1">
                  <SidebarMenuItem>
                    <SidebarMenuButton 
                      asChild 
                      tooltip="Privacy Policy"
                      className="hover:bg-slate-100/80 transition-all duration-300 rounded-xl dark:hover:bg-slate-800"
                    >
                      <Link to={createPageUrl("PrivacyPolicy")} onClick={closeMobileSheet} className="flex items-center justify-center px-2 py-2">
                        <Shield className="w-4 h-4 text-slate-500" />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton 
                      asChild 
                      tooltip="FAQs"
                      className="hover:bg-slate-100/80 transition-all duration-300 rounded-xl dark:hover:bg-slate-800"
                    >
                      <Link to={createPageUrl("FAQ")} onClick={closeMobileSheet} className="flex items-center justify-center px-2 py-2">
                        <HelpCircle className="w-4 h-4 text-slate-500" />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </div>
            </div>
          </SidebarContent>
        </Sidebar>
        )}

        {/* min-w-0 is critical: as a flex child <main> would otherwise
            inherit its content's min-content width and any single oversized
            descendant (a long booking ID, an un-wrapped status row, a tab
            strip) would push the whole page sideways. Pinning min-w-0
            forces the flex layout to respect the parent width. */}
        <main className="flex-1 min-w-0 flex flex-col relative">
          {/* The floating header has to clear the iOS status bar when the app
              runs in standalone PWA mode (otherwise the time / battery icons
              cover the Menu button). env(safe-area-inset-top) is 0 in the
              browser and ~47px on iPhone with Dynamic Island. */}
          <header
            className="absolute left-4 sm:left-6 right-4 sm:right-6 z-10 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border border-slate-200/60 dark:border-slate-800 shadow-lg rounded-2xl px-4 py-2"
            style={{
              top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
            }}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                {user && (
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label="Open navigation menu"
                    className="flex-shrink-0 inline-flex items-center gap-2 h-10 px-3 sm:px-4 rounded-xl bg-slate-900 text-white hover:bg-slate-800 hover:text-amber-400 dark:bg-amber-500 dark:hover:bg-amber-600 dark:text-slate-950 dark:hover:text-white shadow-md transition-colors duration-200 font-semibold text-sm"
                  >
                    <Menu className="w-5 h-5" />
                    <span className="hidden sm:inline">Menu</span>
                  </button>
                )}
                {/* When sidebar is hidden (signed out) the desktop has no brand,
                    so always show the wordmark for unauthenticated users. Clicking
                    the wordmark always takes the user to the home (Search) page. */}
                <Link
                  to={createPageUrl('Search')}
                  className={`text-xl font-bold text-slate-900 dark:text-white ${user ? 'md:hidden' : ''} flex items-center gap-2 hover:opacity-80 transition-opacity`}
                  aria-label="Urban Stays — go to home"
                >
                  <BrandMark className="w-7 h-7" radius="rounded-lg" />
                  Urban Stays
                </Link>
              </div>
              <div className="flex items-center gap-1">
                <ThemeToggle />
                {user ? (
                  <Button
                    onClick={handleLogout}
                    variant="ghost"
                    size="icon"
                    className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 rounded-full"
                    title="Sign Out"
                  >
                    <LogOut className="w-5 h-5" />
                  </Button>
                ) : (
                  <Link to="/login">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-slate-700 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-200 dark:hover:text-white dark:hover:bg-slate-800 rounded-full font-medium"
                    >
                      <LogIn className="w-4 h-4 mr-2" />
                      Sign in
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </header>

          {/* Push content below the floating header and clear of the
              bottom gesture bar / home indicator. env(safe-area-inset-*)
              is supported by Chromium (Chrome / Edge / Samsung Internet),
              Gecko (Firefox), and WebKit (Safari) on both Android and iOS
              — returns 0 anywhere without an inset so no harm on desktop. */}
          <div
            className="flex-1 overflow-y-auto overflow-x-hidden"
            style={{
              paddingTop: 'calc(env(safe-area-inset-top, 0px) + 5rem)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            {children}
          </div>
        </main>
      </div>
    </>
  );
}