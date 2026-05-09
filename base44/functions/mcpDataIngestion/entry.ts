import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

// Fetches Airbnb listings for a city via RapidAPI's airbnb13 service and
// upserts them into the Property entity.
//
// Requires env vars:
//   RAPID_API_KEY     — your RapidAPI key
//   RAPID_API_HOST    — defaults to 'airbnb13.p.rapidapi.com' (override if you
//                       use a different Airbnb scraper provider)
//
// Both Admin (admin role) and the regular search flow (any signed-in user)
// can trigger this; rate limits are enforced by RapidAPI itself.

const DEFAULT_HOST = 'airbnb13.p.rapidapi.com';

interface AirbnbListing {
    id?: string | number;
    name?: string;
    title?: string;
    type?: string;
    propertyType?: string;
    persons?: number;
    bedrooms?: number;
    bathrooms?: number;
    price?: { rate?: number; total?: number };
    images?: string[];
    photos?: string[];
    address?: string;
    city?: string;
    country?: string;
    lat?: number;
    lng?: number;
    rating?: number;
    reviewsCount?: number;
    hostName?: string;
    instantBook?: boolean;
}

function mapToProperty(listing: AirbnbListing, fallbackCity: string) {
    const externalId = listing.id ? `airbnb_${listing.id}` : undefined;
    const images = (listing.images || listing.photos || []).filter(Boolean).slice(0, 10);
    const propertyType = (listing.type || listing.propertyType || 'apartment').toString().toLowerCase();
    const priceNGN = Number(listing.price?.rate ?? listing.price?.total ?? 0);

    return {
        title: listing.title || listing.name || 'Untitled',
        description: '',
        location: {
            city: listing.city || fallbackCity,
            country: listing.country || '',
            address: listing.address || '',
            coordinates: {
                lat: typeof listing.lat === 'number' ? listing.lat : null,
                lng: typeof listing.lng === 'number' ? listing.lng : null,
            },
        },
        price_per_night: priceNGN,
        currency: 'NGN',
        max_guests: Number(listing.persons) || 1,
        bedrooms: Number(listing.bedrooms) || 0,
        bathrooms: Number(listing.bathrooms) || 0,
        property_type: ['apartment', 'house', 'villa', 'studio', 'loft'].includes(propertyType) ? propertyType : 'apartment',
        amenities: [] as string[],
        images,
        videos: [] as string[],
        rating: Number(listing.rating) || 0,
        reviews_count: Number(listing.reviewsCount) || 0,
        host_name: listing.hostName || 'Airbnb Host',
        instant_book: Boolean(listing.instantBook),
        external_id: externalId,
        source: 'airbnb',
    };
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = await req.json().catch(() => ({}));
        const city = (body.city || '').toString().trim();
        if (!city) {
            return new Response(JSON.stringify({
                success: false,
                error: 'city is required',
            }), { status: 400, headers });
        }

        const rapidKey = Deno.env.get('RAPID_API_KEY');
        if (!rapidKey) {
            return new Response(JSON.stringify({
                success: false,
                message: 'RAPID_API_KEY is not configured. Set it in Base44 secrets to enable live Airbnb fetches.',
                stored: 0,
                updated: 0,
            }), { status: 500, headers });
        }
        const rapidHost = Deno.env.get('RAPID_API_HOST') || DEFAULT_HOST;

        // airbnb13 endpoint: /search-location?location=<city>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=1&page=1&currency=NGN
        const checkin = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const checkout = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const url = `https://${rapidHost}/search-location?location=${encodeURIComponent(city)}&checkin=${checkin}&checkout=${checkout}&adults=1&page=1&currency=NGN`;

        const apiRes = await fetch(url, {
            headers: {
                'X-RapidAPI-Key': rapidKey,
                'X-RapidAPI-Host': rapidHost,
            },
        });

        if (!apiRes.ok) {
            const text = await apiRes.text();
            console.error(`RapidAPI ${apiRes.status}: ${text.slice(0, 200)}`);
            return new Response(JSON.stringify({
                success: false,
                message: `External API request failed (${apiRes.status})`,
                stored: 0,
                updated: 0,
            }), { status: apiRes.status, headers });
        }

        const apiData = await apiRes.json();
        const listings: AirbnbListing[] = Array.isArray(apiData?.results)
            ? apiData.results
            : Array.isArray(apiData?.listings)
                ? apiData.listings
                : Array.isArray(apiData)
                    ? apiData
                    : [];

        if (listings.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: `No listings returned by ${rapidHost} for "${city}".`,
                stored: 0,
                updated: 0,
            }), { status: 200, headers });
        }

        let stored = 0;
        let updated = 0;
        const errors: string[] = [];

        for (const listing of listings) {
            try {
                const mapped = mapToProperty(listing, city);
                if (!mapped.external_id) continue;

                const existing = await base44.asServiceRole.entities.Property.filter({
                    external_id: mapped.external_id,
                });

                if (existing.length > 0) {
                    await base44.asServiceRole.entities.Property.update(existing[0].id, mapped);
                    updated += 1;
                } else {
                    await base44.asServiceRole.entities.Property.create(mapped);
                    stored += 1;
                }
            } catch (err) {
                console.error('Failed to upsert listing:', err);
                errors.push((err as Error).message);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            message: `Fetched ${listings.length} listings for "${city}": ${stored} new, ${updated} updated.`,
            stored,
            updated,
            errors: errors.slice(0, 10),
        }), { status: 200, headers });
    } catch (error) {
        console.error('mcpDataIngestion error:', error);
        return new Response(JSON.stringify({
            success: false,
            message: 'Internal server error',
            details: (error as Error).message,
            stored: 0,
            updated: 0,
        }), { status: 500, headers });
    }
});
