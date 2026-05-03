/**
 * Property Service - Smart data fetching with caching and rate limit handling
 * Enhanced with detailed logging for debugging
 */

import { base44 } from '@/api/base44Client';

class PropertyService {
  constructor() {
    this.cache = new Map();
    this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    this.lastApiCall = null;
    this.API_COOLDOWN = 60 * 1000; // 1 minute cooldown between API calls
    this.apiCallCount = 0; // Track API calls
    this.MAX_API_CALLS_PER_SESSION = 20; // Limit to 20 API calls per session
  }

  /**
   * Check if we're being rate limited
   */
  isRateLimited() {
    if (!this.lastApiCall) return false;
    const timeSinceLastCall = Date.now() - this.lastApiCall;
    const isLimited = timeSinceLastCall < this.API_COOLDOWN;
    console.log(`[PropertyService] Rate limit check: isLimited=${isLimited}, timeSinceLastCall=${timeSinceLastCall}ms, cooldown=${this.API_COOLDOWN}ms`);
    return isLimited;
  }

  /**
   * Check if we've exceeded API call limit
   */
  hasExceededAPILimit() {
    const exceeded = this.apiCallCount >= this.MAX_API_CALLS_PER_SESSION;
    console.log(`[PropertyService] API call limit check: count=${this.apiCallCount}/${this.MAX_API_CALLS_PER_SESSION}, exceeded=${exceeded}`);
    return exceeded;
  }

  /**
   * Get cache key for search parameters
   */
  getCacheKey(params) {
    return JSON.stringify({
      location: params.location || '',
      guests: params.guests || 2,
      bedrooms: params.bedrooms || 'any',
      propertyType: params.propertyType || 'any'
    });
  }

  /**
   * Check if cached data is still valid
   */
  isCacheValid(cacheEntry) {
    if (!cacheEntry) return false;
    const age = Date.now() - cacheEntry.timestamp;
    const isValid = age < this.CACHE_DURATION;
    console.log(`[PropertyService] Cache validity check: age=${age}ms, duration=${this.CACHE_DURATION}ms, valid=${isValid}`);
    return isValid;
  }

  /**
   * Smart search - prioritizes database, only calls external APIs when necessary
   */
  async smartSearch(params = {}) {
    console.log('========================================');
    console.log('[PropertyService] 🔍 SMART SEARCH STARTED');
    console.log('[PropertyService] Input params:', JSON.stringify(params, null, 2));
    console.log('[PropertyService] Current API call count:', this.apiCallCount);
    console.log('========================================');

    try {
      // Check cache first
      const cacheKey = this.getCacheKey(params);
      console.log('[PropertyService] Cache key:', cacheKey);
      
      const cached = this.cache.get(cacheKey);
      
      if (cached && this.isCacheValid(cached)) {
        console.log('[PropertyService] ✅ RETURNING CACHED RESULTS');
        console.log('[PropertyService] Cached properties count:', cached.properties.length);
        return {
          success: true,
          properties: cached.properties,
          dbCount: cached.dbCount,
          mcpCount: 0,
          totalCount: cached.properties.length,
          sources: ['cache'],
          fromCache: true
        };
      } else {
        console.log('[PropertyService] ❌ Cache miss or invalid');
      }

      // ALWAYS search database first
      console.log('[PropertyService] 📊 Searching database...');
      const dbProperties = await this.searchDatabase(params);
      console.log(`[PropertyService] ✅ Database returned ${dbProperties.length} properties`);

      // If we have enough database results, return them (don't hit API)
      if (dbProperties.length >= 10) {
        console.log('[PropertyService] ✅ Sufficient database results (>=10), skipping external APIs');
        
        const result = {
          success: true,
          properties: dbProperties,
          dbCount: dbProperties.length,
          mcpCount: 0,
          totalCount: dbProperties.length,
          sources: ['database'],
          fromCache: false
        };

        // Cache the results
        this.cache.set(cacheKey, {
          properties: dbProperties,
          dbCount: dbProperties.length,
          timestamp: Date.now()
        });
        console.log('[PropertyService] 💾 Results cached');

        return result;
      }

      // Check if we should try MCP
      const rateLimited = this.isRateLimited();
      const apiLimitExceeded = this.hasExceededAPILimit();
      const hasLocation = params.location && params.location.trim() !== '';
      
      console.log('[PropertyService] MCP eligibility check:');
      console.log(`  - Has location: ${hasLocation}`);
      console.log(`  - Rate limited: ${rateLimited}`);
      console.log(`  - API limit exceeded: ${apiLimitExceeded}`);
      console.log(`  - DB results count: ${dbProperties.length}`);

      const shouldTryMCP = hasLocation && 
                          dbProperties.length < 10 &&
                          !rateLimited &&
                          !apiLimitExceeded;

      console.log(`[PropertyService] Should try MCP: ${shouldTryMCP}`);

      if (!shouldTryMCP) {
        let reason = 'Unknown reason';
        if (!hasLocation) reason = 'No location provided';
        else if (rateLimited) reason = 'Rate limit cooldown active';
        else if (apiLimitExceeded) reason = `API call limit reached (${this.apiCallCount}/${this.MAX_API_CALLS_PER_SESSION})`;
        
        console.log(`[PropertyService] ⚠️ Skipping MCP: ${reason}`);
        
        return {
          success: true,
          properties: dbProperties,
          dbCount: dbProperties.length,
          mcpCount: 0,
          totalCount: dbProperties.length,
          sources: ['database'],
          fromCache: false,
          mcpMessage: reason
        };
      }

      // Try MCP ingestion for more results
      console.log('[PropertyService] 📡 Attempting MCP ingestion for:', params.location);
      console.log('[PropertyService] Incrementing API call count:', this.apiCallCount, '->', this.apiCallCount + 1);
      this.lastApiCall = Date.now();
      this.apiCallCount++;

      const mcpResult = await this.ingestFromMCP(params.location);

      console.log('[PropertyService] MCP ingestion result:', {
        success: mcpResult.success,
        stored: mcpResult.stored,
        updated: mcpResult.updated,
        message: mcpResult.message
      });

      if (mcpResult.success) {
        // Refresh database results after MCP ingestion
        console.log('[PropertyService] 🔄 Refreshing database after MCP ingestion...');
        const updatedDbProperties = await this.searchDatabase(params);
        console.log(`[PropertyService] ✅ Updated database returned ${updatedDbProperties.length} properties`);
        
        const result = {
          success: true,
          properties: updatedDbProperties,
          dbCount: dbProperties.length,
          mcpCount: mcpResult.stored + mcpResult.updated,
          totalCount: updatedDbProperties.length,
          sources: ['database', 'airbnb'],
          fromCache: false,
          mcpMessage: mcpResult.message
        };

        // Cache combined results
        this.cache.set(cacheKey, {
          properties: updatedDbProperties,
          dbCount: updatedDbProperties.length,
          timestamp: Date.now()
        });
        console.log('[PropertyService] 💾 Updated results cached');

        return result;
      } else {
        // MCP failed, return database results
        console.log('[PropertyService] ⚠️ MCP ingestion failed, returning database results');
        
        return {
          success: true,
          properties: dbProperties,
          dbCount: dbProperties.length,
          mcpCount: 0,
          totalCount: dbProperties.length,
          sources: ['database'],
          fromCache: false,
          mcpMessage: mcpResult.message || 'External API unavailable. Showing database results.'
        };
      }

    } catch (error) {
      console.error('[PropertyService] ❌ FATAL ERROR in smart search:', error);
      console.error('[PropertyService] Error stack:', error.stack);
      
      // Always return database results even on error
      try {
        console.log('[PropertyService] 🔄 Attempting to fetch database properties as fallback...');
        const dbProperties = await this.searchDatabase(params);
        console.log(`[PropertyService] ✅ Fallback database returned ${dbProperties.length} properties`);
        return {
          success: true,
          properties: dbProperties,
          dbCount: dbProperties.length,
          mcpCount: 0,
          totalCount: dbProperties.length,
          sources: ['database'],
          error: error.message
        };
      } catch (dbError) {
        console.error('[PropertyService] ❌ FALLBACK FAILED:', dbError);
        return {
          success: false,
          properties: [],
          dbCount: 0,
          mcpCount: 0,
          totalCount: 0,
          sources: [],
          error: 'Failed to load properties'
        };
      }
    }
  }

  /**
   * Search database only
   */
  async searchDatabase(params = {}) {
    console.log('[PropertyService] 📊 DATABASE SEARCH');
    console.log('[PropertyService] Search params:', JSON.stringify(params, null, 2));
    
    try {
      // Build filter criteria
      const filter = {};

      // Location filter (city or country)
      if (params.location && params.location.trim() !== '') {
        const locationLower = params.location.toLowerCase().trim();
        console.log('[PropertyService] Filtering by location (case-insensitive):', locationLower);
        filter['location.city'] = { $regex: locationLower, $options: 'i' };
      }

      // Guests filter
      if (params.guests) {
        console.log('[PropertyService] Filtering by guests (>= ):', params.guests);
        filter.max_guests = { $gte: parseInt(params.guests) };
      }

      // Bedrooms filter
      if (params.bedrooms && params.bedrooms !== 'any') {
        if (params.bedrooms === 'studio') {
          console.log('[PropertyService] Filtering by property_type: studio');
          filter.property_type = 'studio';
        } else if (params.bedrooms === 'loft') {
          console.log('[PropertyService] Filtering by property_type: loft');
          filter.property_type = 'loft';
        } else {
          console.log('[PropertyService] Filtering by bedrooms (>=):', params.bedrooms);
          filter.bedrooms = { $gte: parseInt(params.bedrooms) };
        }
      }

      // Property type filter
      if (params.propertyType && params.propertyType !== 'any') {
        console.log('[PropertyService] Filtering by property_type:', params.propertyType);
        filter.property_type = params.propertyType;
      }

      console.log('[PropertyService] Final database filter:', JSON.stringify(filter, null, 2));
      console.log('[PropertyService] Executing query with limit:', params.limit || 50);

      const properties = await base44.entities.Property.filter(
        Object.keys(filter).length > 0 ? filter : {},
        '-created_date',
        params.limit || 50
      );

      console.log(`[PropertyService] ✅ Database query successful: ${properties.length} properties found`);
      return properties || [];

    } catch (error) {
      console.error('[PropertyService] ❌ DATABASE SEARCH ERROR:', error);
      console.error('[PropertyService] Error details:', error.message);
      console.error('[PropertyService] Error stack:', error.stack);
      return [];
    }
  }

  /**
   * Ingest properties from MCP (Airbnb)
   */
  async ingestFromMCP(city) {
    console.log('[PropertyService] 📡 MCP INGESTION STARTED');
    console.log('[PropertyService] Target city:', city);
    
    try {
      const functionName = 'mcpDataIngestion';
      const payload = { city: city, sources: ['airbnb'] };
      
      console.log('[PropertyService] Calling backend function:', functionName);
      console.log('[PropertyService] Payload:', JSON.stringify(payload, null, 2));
      
      const response = await base44.functions.invoke(functionName, payload);

      console.log('[PropertyService] 📥 MCP Response received');
      console.log('[PropertyService] Response status:', response.status);
      console.log('[PropertyService] Response data:', JSON.stringify(response.data, null, 2));

      if (response.data && response.data.success) {
        console.log('[PropertyService] ✅ MCP ingestion successful');
        console.log('[PropertyService] Properties stored:', response.data.stored);
        console.log('[PropertyService] Properties updated:', response.data.updated);
        return response.data;
      } else {
        console.log('[PropertyService] ⚠️ MCP ingestion unsuccessful:', response.data?.message);
        return {
          success: false,
          message: response.data?.message || 'External API request failed',
          stored: 0,
          updated: 0
        };
      }

    } catch (error) {
      console.error('[PropertyService] ❌ MCP INGESTION ERROR:', error);
      console.error('[PropertyService] Error message:', error.message);
      console.error('[PropertyService] Error response:', error.response?.data);
      
      // Check if it's a rate limit error
      const errorMessage = error.response?.data?.message || error.message || '';
      const isRateLimit = errorMessage.includes('429') || errorMessage.includes('Too Many Requests');
      
      console.log('[PropertyService] Is rate limit error:', isRateLimit);
      
      return {
        success: false,
        message: isRateLimit 
          ? 'API rate limit reached. Please try again later or contact admin to upgrade the API plan.'
          : 'External API temporarily unavailable',
        stored: 0,
        updated: 0
      };
    }
  }

  /**
   * Get AI recommendations (database only for now)
   */
  async getRecommendations(params = {}) {
    console.log('[PropertyService] 💡 GET RECOMMENDATIONS');
    console.log('[PropertyService] Params:', JSON.stringify(params, null, 2));
    
    try {
      const dbProperties = await this.searchDatabase({
        ...params,
        limit: 20
      });

      console.log(`[PropertyService] Found ${dbProperties.length} properties for recommendations`);

      // Simple recommendation: return highest rated properties
      const recommended = dbProperties
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 10);

      console.log(`[PropertyService] ✅ Returning top ${recommended.length} recommended properties`);

      return {
        success: true,
        properties: recommended,
        dbCount: recommended.length,
        mcpCount: 0,
        totalCount: recommended.length,
        sources: ['database']
      };

    } catch (error) {
      console.error('[PropertyService] ❌ Recommendations error:', error);
      return {
        success: false,
        properties: [],
        dbCount: 0,
        mcpCount: 0,
        totalCount: 0,
        sources: [],
        error: error.message
      };
    }
  }

  /**
   * Clear the cache
   */
  clearCache(reason = 'Manual clear') {
    console.log('========================================');
    console.log('[PropertyService] 🗑️ CLEARING CACHE');
    console.log('[PropertyService] Reason:', reason);
    console.log('[PropertyService] Cache size before clear:', this.cache.size);
    console.log('========================================');
    
    this.cache.clear();
    this.lastApiCall = null;
    this.apiCallCount = 0; // Reset API call counter
    
    console.log('[PropertyService] ✅ Cache cleared successfully');
    console.log('[PropertyService] API call counter reset to 0');
  }
}

// Export singleton instance
const propertyService = new PropertyService();
export default propertyService;