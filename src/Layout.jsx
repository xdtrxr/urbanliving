import React from "react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Search, Calendar, User, Heart, Home, MessageCircle, LayoutGrid, Compass, Settings, Shield, HelpCircle, Trophy, LogOut, Wallet, CreditCard } from "lucide-react";
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
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { User as UserEntity } from "@/entities/User";
import ReferralTracker from "@/components/utils/ReferralTracker";
import { useAuth } from "@/lib/AuthContext";
import { LogIn } from "lucide-react";

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
    title: "My Trips",
    url: createPageUrl("Trips"),
    icon: Compass,
    description: "Plan your itineraries"
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

  // Add admin link if user is admin
  const menuItems = [...navigationItems];
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
      
      <div className="min-h-screen flex w-full bg-gradient-to-br from-slate-50 to-blue-50">
        {user && (
        <Sidebar collapsible="icon" className="border-r border-slate-200/60 bg-white/80 backdrop-blur-xl">
          <SidebarHeader className="border-b border-slate-100 p-4">
            <div className="flex items-center gap-3 justify-center group-data-[collapsible=icon]:justify-center">
              <div className="w-8 h-8 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl flex items-center justify-center shadow-lg flex-shrink-0">
                <Home className="w-4 h-4 text-amber-400" />
              </div>
              <div className="sidebar-header-text group-data-[collapsible=icon]:hidden">
                <h2 className="font-bold text-slate-900 text-base tracking-tight">Urban Stays</h2>
                <p className="text-xs text-slate-500 font-medium">Luxury Stays Worldwide</p>
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
                          className={`relative hover:bg-slate-100/80 transition-all duration-300 rounded-xl group ${
                            location.pathname === item.url 
                              ? 'bg-gradient-to-r from-slate-900 to-slate-800 text-white shadow-lg' 
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                          tooltip={item.title}
                        >
                          <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
                            <item.icon className={`w-5 h-5 transition-colors flex-shrink-0 ${
                              location.pathname === item.url ? 'text-amber-400' : 'group-hover:text-amber-500'
                            }`} />
                            <div className="sidebar-menu-text flex flex-col group-data-[collapsible=icon]:hidden">
                              <span className="font-semibold text-sm leading-tight">{item.title}</span>
                              <span className={`text-[10px] leading-tight ${
                                location.pathname === item.url ? 'text-slate-300' : 'text-slate-400'
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
            
            <div className="mt-auto pt-3 border-t border-slate-100">
              <div className="sidebar-footer-text group-data-[collapsible=icon]:hidden">
                <div className="flex items-center justify-center gap-3 px-3 py-2">
                  <Link 
                    to={createPageUrl("PrivacyPolicy")} 
                    className="text-xs text-slate-500 hover:text-slate-700 transition-colors duration-200"
                  >
                    Privacy policy
                  </Link>
                  <span className="text-xs text-slate-300">|</span>
                  <Link 
                    to={createPageUrl("FAQ")} 
                    className="text-xs text-slate-500 hover:text-slate-700 transition-colors duration-200"
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
                      className="hover:bg-slate-100/80 transition-all duration-300 rounded-xl"
                    >
                      <Link to={createPageUrl("PrivacyPolicy")} className="flex items-center justify-center px-2 py-2">
                        <Shield className="w-4 h-4 text-slate-500" />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton 
                      asChild 
                      tooltip="FAQs"
                      className="hover:bg-slate-100/80 transition-all duration-300 rounded-xl"
                    >
                      <Link to={createPageUrl("FAQ")} className="flex items-center justify-center px-2 py-2">
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

        <main className="flex-1 flex flex-col relative">
          <header className="absolute top-4 sm:top-6 left-4 sm:left-6 right-4 sm:right-6 z-10 bg-white/80 backdrop-blur-xl border border-slate-200/60 shadow-lg rounded-2xl px-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                {user && (
                  <SidebarTrigger className="hover:bg-slate-100 p-2 rounded-xl transition-colors duration-200 flex-shrink-0" />
                )}
                {/* When sidebar is hidden (signed out) the desktop has no brand,
                    so always show the wordmark for unauthenticated users. Clicking
                    the wordmark always takes the user to the home (Search) page. */}
                <Link
                  to={createPageUrl('Search')}
                  className={`text-xl font-bold text-slate-900 ${user ? 'md:hidden' : ''} flex items-center gap-2 hover:opacity-80 transition-opacity`}
                  aria-label="Urban Stays — go to home"
                >
                  <span className="w-7 h-7 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-lg flex items-center justify-center">
                    <Home className="w-4 h-4 text-amber-400" />
                  </span>
                  Urban Stays
                </Link>
              </div>
              {user ? (
                <Button
                  onClick={handleLogout}
                  variant="ghost"
                  size="icon"
                  className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full"
                  title="Sign Out"
                >
                  <LogOut className="w-5 h-5" />
                </Button>
              ) : (
                <Link to="/login">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-full font-medium"
                  >
                    <LogIn className="w-4 h-4 mr-2" />
                    Sign in
                  </Button>
                </Link>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-auto pt-20 sm:pt-24">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}