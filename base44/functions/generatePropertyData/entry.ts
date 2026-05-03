
import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ 
            status: 'error',
            details: 'Method not allowed' 
        }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        
        // Verify user is authenticated
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ 
                status: 'error',
                details: 'Unauthorized - Please log in' 
            }), { status: 401, headers });
        }

        // Only allow admin users to generate data
        if (user.role !== 'admin') {
            return new Response(JSON.stringify({ 
                status: 'error',
                details: 'Unauthorized - Admin access required' 
            }), { status: 403, headers });
        }

        const body = await req.json();
        const { prompt, city, country, count, output_format } = body;

        console.log('[AI Generator] Request received:', { prompt, city, country, count });

        // Validate inputs
        if (!city || !country) {
            return new Response(JSON.stringify({ 
                status: 'error',
                details: 'City and country are required' 
            }), { status: 400, headers });
        }

        if (!count || count < 1 || count > 20) {
            return new Response(JSON.stringify({ 
                status: 'error',
                details: 'Count must be between 1 and 20' 
            }), { status: 400, headers });
        }

        // Build the AI prompt
        const aiPrompt = `Generate ${count} realistic luxury rental property listings for ${city}, ${country}.

${prompt ? `User preferences: ${prompt}\n` : ''}

Generate properties that are:
- Realistic and appropriate for ${city}, ${country}
- Varied in terms of property type, price range, and amenities
- Detailed with compelling descriptions
- Suitable for short-term rentals (Airbnb-style)

For each property, provide:
1. A catchy, descriptive title
2. A detailed description (2-3 sentences highlighting unique features)
3. The exact city name: "${city}"
4. The exact country name: "${country}"
5. A realistic street address in ${city}
6. A realistic price per night in US Dollars (USD) - range from $100 to $1000
7. Maximum number of guests (2-10)
8. Number of bedrooms (1-5)
9. Number of bathrooms (1-4)
10. Property type: one of [apartment, house, studio, loft, penthouse, villa]
11. Amenities as comma-separated: choose from [wifi, kitchen, parking, pool, gym, balcony, air_conditioning, heating, washer, dryer, workspace]
12. Image URLs: provide 3-5 relevant Unsplash image URLs (use: https://images.unsplash.com/photo-[id]?w=800)
13. Rating: 3.5 to 5.0 (realistic distribution)
14. Reviews count: 10 to 300
15. Host name: realistic local name
16. Instant book: true or false (mix of both)

Make the data realistic and varied. Properties should feel authentic to ${city}, ${country}.
All prices must be in US Dollars (USD).`;

        console.log('[AI Generator] Calling LLM...');

        // Call the LLM
        const response = await base44.integrations.Core.InvokeLLM({
            prompt: aiPrompt,
            add_context_from_internet: true, // Get real info about the city
            response_json_schema: output_format || {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        city: { type: "string" },
                        country: { type: "string" },
                        address: { type: "string" },
                        price_per_night: { type: "number" },
                        max_guests: { type: "number" },
                        bedrooms: { type: "number" },
                        bathrooms: { type: "number" },
                        property_type: { 
                            type: "string", 
                            enum: ["apartment", "house", "studio", "loft", "penthouse", "villa"] 
                        },
                        amenities: { 
                            type: "string", 
                            description: "comma-separated list of amenities" 
                        },
                        images: { 
                            type: "string", 
                            description: "comma-separated list of image URLs" 
                        },
                        rating: { type: "number", minimum: 0, maximum: 5 },
                        reviews_count: { type: "number" },
                        host_name: { type: "string" },
                        instant_book: { type: "boolean" }
                    },
                    required: ["title", "city", "country", "price_per_night", "max_guests", "property_type"]
                }
            }
        });

        console.log('[AI Generator] LLM response received');

        // Validate response
        if (!response || !Array.isArray(response)) {
            throw new Error('Invalid response from AI - expected array of properties');
        }

        if (response.length === 0) {
            throw new Error('AI generated no properties - please try again with different parameters');
        }

        console.log(`[AI Generator] Successfully generated ${response.length} properties`);

        return new Response(JSON.stringify({ 
            status: 'success',
            output: response,
            count: response.length
        }), { status: 200, headers });

    } catch (error) {
        console.error('[AI Generator] Error:', error);
        
        return new Response(JSON.stringify({ 
            status: 'error',
            details: error.message || 'Failed to generate property data'
        }), { 
            status: 500, 
            headers 
        });
    }
});
