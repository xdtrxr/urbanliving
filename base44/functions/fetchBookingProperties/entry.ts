import { createClient } from 'npm:@base44/sdk@0.1.0';

const base44 = createClient({
    appId: Deno.env.get('BASE44_APP_ID'), 
});

Deno.serve(async (req) => {
    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        const token = authHeader.split(' ')[1];
        base44.auth.setToken(token);
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { "Content-Type": "application/json" } });
        }

        const { location, checkin_date, checkout_date, guests } = await req.json();

        if (!location || !checkin_date || !checkout_date) {
            return new Response(JSON.stringify({ error: "Location, check-in date, and check-out date are required." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        
        // 1. Get Destination ID from location search
        const destUrl = new URL('https://booking-com.p.rapidapi.com/v1/hotels/locations');
        destUrl.searchParams.append('name', location);
        destUrl.searchParams.append('locale', 'en-gb');
        
        const destResponse = await fetch(destUrl, {
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': Deno.env.get('RAPID_API_KEY'),
                'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
            }
        });

        if (!destResponse.ok) {
            const errorText = await destResponse.text();
            return new Response(JSON.stringify({ error: `Failed to get location data: ${errorText}` }), { status: destResponse.status, headers: { "Content-Type": "application/json" } });
        }

        const destData = await destResponse.json();
        
        if (!destData || destData.length === 0) {
            return new Response(JSON.stringify({ error: "Could not find the specified location." }), { status: 404, headers: { "Content-Type": "application/json" } });
        }

        const destination = destData[0];
        const dest_id = destination.dest_id;
        const dest_type = destination.dest_type;

        // 2. Search for properties with the destination ID
        const searchUrl = new URL('https://booking-com.p.rapidapi.com/v1/hotels/search');
        searchUrl.searchParams.append('checkin_date', checkin_date);
        searchUrl.searchParams.append('checkout_date', checkout_date);
        searchUrl.searchParams.append('dest_type', dest_type);
        searchUrl.searchParams.append('dest_id', dest_id);
        searchUrl.searchParams.append('adults_number', guests);
        searchUrl.searchParams.append('order_by', 'popularity');
        searchUrl.searchParams.append('units', 'metric');
        searchUrl.searchParams.append('room_number', '1');
        searchUrl.searchParams.append('filter_by_currency', 'NGN');
        searchUrl.searchParams.append('locale', 'en-gb');
        searchUrl.searchParams.append('page_number', '0');
        searchUrl.searchParams.append('include_adjacency', 'true');
        searchUrl.searchParams.append('categories_filter', 'class::2,class::4,free_cancellation::1');

        const searchResponse = await fetch(searchUrl, {
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': Deno.env.get('RAPID_API_KEY'),
                'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
            }
        });

        if (!searchResponse.ok) {
            const errorText = await searchResponse.text();
            return new Response(JSON.stringify({ error: `Failed to search properties: ${errorText}` }), { status: searchResponse.status, headers: { "Content-Type": "application/json" } });
        }
        
        const searchData = await searchResponse.json();
        
        return new Response(JSON.stringify(searchData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
});