import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';

// useDriverProfile — "is the signed-in user a driver, and which one?"
//
// There is no driver role. getDriverProfile looks the caller up on the Driver
// roster under the service role (the entity is admin-only at the API) and
// returns a few public fields, or null.
//
// isDriver is true for ANY linked driver, active or not. Deactivating a driver
// stops new assignments; it must not hide money they have already earned.
export function useDriverProfile() {
  const { user, isAuthenticated, isLoadingAuth } = useAuth();
  const enabled = !isLoadingAuth && !!isAuthenticated;

  const query = useQuery({
    queryKey: ['driverProfile', user?.email || null],
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        const res = await base44.functions.invoke('getDriverProfile', {});
        return res?.data?.success ? (res.data.data || null) : null;
      } catch (err) {
        // A failed lookup is "not a driver" for navigation purposes. The
        // driver pages make their own calls and show their own errors.
        console.warn('getDriverProfile failed:', err);
        return null;
      }
    },
  });

  const driver = query.data || null;
  return {
    driver,
    isDriver: !!driver,
    isLoading: isLoadingAuth || (enabled && query.isLoading),
    refetch: query.refetch,
  };
}
