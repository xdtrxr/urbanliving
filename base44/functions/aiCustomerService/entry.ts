import { createClient } from 'npm:@base44/sdk@0.1.0';

const base44 = createClient({
    appId: Deno.env.get('BASE44_APP_ID'),
});

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
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers
        });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers
            });
        }

        const token = authHeader.split(' ')[1];
        base44.auth.setToken(token);
        
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ error: 'User not found' }), {
                status: 401,
                headers
            });
        }

        const body = await req.json();
        const { action } = body;

        switch (action) {
            case 'my-tickets':
                const tickets = await base44.entities.SupportTicket.filter(
                    { user_email: user.email }, 
                    '-created_date'
                );
                return new Response(JSON.stringify({ tickets }), { 
                    status: 200, 
                    headers 
                });

            case 'create-ticket':
                const { subject, message, category } = body;
                
                const ticket = await base44.entities.SupportTicket.create({
                    user_email: user.email,
                    subject: subject || 'Support Request',
                    category: category || 'general',
                    priority: 'medium',
                    description: message,
                    status: 'open',
                    ai_handled: false
                });

                await base44.entities.SupportMessage.create({
                    ticket_id: ticket.id,
                    sender_type: 'user',
                    message: message,
                    message_type: 'text'
                });

                return new Response(JSON.stringify({
                    ticket_id: ticket.id,
                    message: 'Ticket created successfully'
                }), { status: 200, headers });

            case 'ticket-messages':
                const { ticket_id } = body;
                
                const ticketData = await base44.entities.SupportTicket.retrieve(ticket_id);
                if (ticketData.user_email !== user.email) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                        status: 403,
                        headers
                    });
                }

                const messages = await base44.entities.SupportMessage.filter(
                    { ticket_id }, 
                    'created_date'
                );

                return new Response(JSON.stringify({ 
                    ticket: ticketData, 
                    messages 
                }), { status: 200, headers });

            case 'send-message':
                const { ticket_id: msgTicketId, message: newMessage } = body;
                
                const msgTicket = await base44.entities.SupportTicket.retrieve(msgTicketId);
                if (msgTicket.user_email !== user.email) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                        status: 403,
                        headers
                    });
                }

                await base44.entities.SupportMessage.create({
                    ticket_id: msgTicketId,
                    sender_type: 'user',
                    message: newMessage,
                    message_type: 'text'
                });

                return new Response(JSON.stringify({ 
                    success: true,
                    message: 'Message sent successfully'
                }), { status: 200, headers });

            default:
                return new Response(JSON.stringify({ error: 'Unknown action' }), {
                    status: 400,
                    headers
                });
        }

    } catch (error) {
        console.error('Support function error:', error);
        return new Response(JSON.stringify({ 
            error: 'Internal server error',
            details: error.message 
        }), {
            status: 500,
            headers
        });
    }
});