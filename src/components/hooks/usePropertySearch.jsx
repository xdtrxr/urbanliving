/**
 * Custom hook for property searching
 * Provides a clean interface for components to search properties
 */

import { useState, useCallback } from 'react';
import propertyService from '../utils/propertyService';

export function usePropertySearch() {
  const [properties, setProperties] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState({
    dbCount: 0,
    mcpCount: 0,
    totalCount: 0,
    sources: [],
    fromCache: false
  });

  const search = useCallback(async (params) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await propertyService.smartSearch(params);

      if (result.success) {
        setProperties(result.properties);
        setMetadata({
          dbCount: result.dbCount,
          mcpCount: result.mcpCount,
          totalCount: result.totalCount,
          sources: result.sources,
          fromCache: result.fromCache || false,
          mcpMessage: result.mcpMessage,
          errors: result.errors
        });
      } else {
        setError('Failed to fetch properties');
        setProperties([]);
      }

    } catch (err) {
      console.error('[usePropertySearch] Error:', err);
      setError(err.message || 'An unexpected error occurred');
      setProperties([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const getRecommendations = useCallback(async (params) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await propertyService.getRecommendations(params);

      if (result.success) {
        setProperties(result.properties);
        setMetadata({
          dbCount: result.dbCount,
          mcpCount: result.mcpCount,
          totalCount: result.totalCount,
          sources: result.sources,
          fromCache: result.fromCache || false
        });
      } else {
        setError('Failed to fetch recommendations');
        setProperties([]);
      }

    } catch (err) {
      console.error('[usePropertySearch] Error:', err);
      setError(err.message || 'An unexpected error occurred');
      setProperties([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearCache = useCallback(() => {
    propertyService.clearCache();
  }, []);

  return {
    properties,
    isLoading,
    error,
    metadata,
    search,
    getRecommendations,
    clearCache
  };
}