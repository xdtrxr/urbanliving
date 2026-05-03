import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';
import { GoogleAuth } from 'npm:google-auth-library@9.6.3';
import { google } from 'npm:googleapis@134.0.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { booking_id } = await req.json();

        if (!booking_id) {
            return Response.json({ 
                error: 'Missing booking_id parameter' 
            }, { status: 400 });
        }

        // Load Google credentials from environment
        const credentialsJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY_JSON');
        const sheetId = Deno.env.get('GOOGLE_SHEET_ID');

        if (!credentialsJson || !sheetId) {
            console.error('Missing Google Sheets configuration');
            return Response.json({ 
                error: 'Google Sheets integration not configured' 
            }, { status: 500 });
        }

        const credentials = JSON.parse(credentialsJson);

        // Initialize Google Auth
        const auth = new GoogleAuth({
            credentials,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'
            ],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        // Fetch booking data using service role for reliable access
        const booking = await base44.asServiceRole.entities.Booking.get(booking_id);
        
        if (!booking) {
            return Response.json({ 
                error: 'Booking not found' 
            }, { status: 404 });
        }

        // Fetch property details
        let propertyTitle = 'Unknown Property';
        try {
            const property = await base44.asServiceRole.entities.Property.get(booking.property_id);
            propertyTitle = property?.title || 'Unknown Property';
        } catch (error) {
            console.error('Error fetching property:', error);
        }

        // Fetch user details for phone number
        let phoneNumber = 'N/A';
        try {
            const bookingUsers = await base44.asServiceRole.entities.User.filter({ 
                email: booking.guest_email 
            });
            if (bookingUsers.length > 0) {
                phoneNumber = bookingUsers[0].phone_number || 'N/A';
            }
        } catch (error) {
            console.error('Error fetching user:', error);
        }

        // Prepare row data
        const rowData = [
            booking.guest_name,
            phoneNumber,
            booking.guest_email,
            propertyTitle,
            booking.check_in,
            booking.check_out,
            `₦${booking.total_price.toLocaleString()}`,
            new Date().toISOString(),
            booking.id
        ];

        console.log('Appending row to Google Sheet:', rowData);

        // Append to Google Sheet
        const appendRequest = {
            spreadsheetId: sheetId,
            range: 'Sheet1!A:I', // Adjust range and sheet name as needed
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [rowData],
            },
        };

        const response = await sheets.spreadsheets.values.append(appendRequest);

        console.log('✅ Successfully logged booking to Google Sheet');

        return Response.json({ 
            success: true, 
            message: 'Booking logged to Google Sheet successfully',
            updates: response.data.updates
        });

    } catch (error) {
        console.error('❌ Error logging booking to Google Sheet:', error);
        return Response.json({ 
            success: false,
            error: error.message,
            stack: error.stack
        }, { status: 500 });
    }
});