import './App.css'
import { lazy, Suspense } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import VisualEditAgent from '@/lib/VisualEditAgent'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { ThemeProvider } from '@/lib/ThemeContext';
import FloatingThemeToggle from '@/components/ui/FloatingThemeToggle';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

const Login = lazy(() => import('./pages/Login'));

const PageFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

const { Pages, Layout, mainPage, barePages } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

// Marketing/install pages render edge-to-edge with no sidebar/header.
// Anything in barePages bypasses the Layout shell entirely.
const isBarePage = (name) => !!barePages && barePages.has(name);

const LayoutWrapper = ({ children, currentPageName }) => {
  if (!Layout || isBarePage(currentPageName)) {
    // Bare pages skip the Layout shell, so they don't get the in-header
    // ThemeToggle. Float it in so users can still flip themes from
    // Landing / Install / any other shell-less route.
    return (
      <>
        <FloatingThemeToggle />
        {children}
      </>
    );
  }
  return <Layout currentPageName={currentPageName}>{children}</Layout>;
};

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const location = useLocation();
  const onLoginRoute = location.pathname.toLowerCase().startsWith('/login');

  // Login route bypasses the auth gate entirely
  if (onLoginRoute) {
    return (
      <Suspense fallback={<PageFallback />}>
        <FloatingThemeToggle />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/Login" element={<Login />} />
        </Routes>
      </Suspense>
    );
  }

  if (isLoadingPublicSettings || isLoadingAuth) {
    return <PageFallback />;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={
          <LayoutWrapper currentPageName={mainPageKey}>
            <MainPage />
          </LayoutWrapper>
        } />
        {Object.entries(Pages).map(([path, Page]) => (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <LayoutWrapper currentPageName={path}>
                <Page />
              </LayoutWrapper>
            }
          />
        ))}
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </Suspense>
  );
};


function App() {

  return (
    <ThemeProvider>
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <NavigationTracker />
            <AuthenticatedApp />
          </Router>
          <Toaster />
          <VisualEditAgent />
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
