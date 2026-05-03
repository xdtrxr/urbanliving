import React, { useState, useEffect } from 'react';
import { User } from '@/entities/User';
import { SupportTicket } from '@/entities/SupportTicket';
import { SupportMessage } from '@/entities/SupportMessage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { 
  MessageCircle, 
  Send, 
  Bot, 
  User as UserIcon, 
  Star,
  ThumbsUp,
  ThumbsDown,
  Plus,
  Clock,
  CheckCircle,
  AlertCircle,
  HelpCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const categoryColors = {
  booking: 'bg-blue-100 text-blue-800',
  payment: 'bg-green-100 text-green-800',
  account: 'bg-purple-100 text-purple-800',
  technical: 'bg-orange-100 text-orange-800',
  general: 'bg-gray-100 text-gray-800'
};

const statusColors = {
  open: 'bg-red-100 text-red-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  resolved: 'bg-green-100 text-green-800',
  closed: 'bg-gray-100 text-gray-800'
};

const statusIcons = {
  open: AlertCircle,
  in_progress: Clock,
  resolved: CheckCircle,
  closed: CheckCircle
};

export default function SupportPage() {
  const [user, setUser] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingTicket, setIsCreatingTicket] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [showNewTicketDialog, setShowNewTicketDialog] = useState(false);

  // New ticket form
  const [newTicket, setNewTicket] = useState({
    subject: '',
    category: '',
    message: ''
  });

  // Chat message input
  const [messageInput, setMessageInput] = useState('');

  useEffect(() => {
    loadUserAndTickets();
  }, []);

  const loadUserAndTickets = async () => {
    setIsLoading(true);
    try {
      const userData = await User.me();
      setUser(userData);

      // Load user's tickets directly from entity
      const userTickets = await SupportTicket.filter(
        { user_email: userData.email }, 
        '-created_date'
      );
      setTickets(userTickets);
    } catch (error) {
      console.error('Error loading support data:', error);
      setTickets([]);
    }
    setIsLoading(false);
  };

  const createNewTicket = async () => {
    if (!newTicket.subject || !newTicket.category || !newTicket.message) {
      alert('Please fill in all fields');
      return;
    }

    if (!user) {
      alert('Please log in to create a support ticket');
      return;
    }

    setIsCreatingTicket(true);
    try {
      // Create ticket directly using entity
      const ticket = await SupportTicket.create({
        user_email: user.email,
        subject: newTicket.subject,
        category: newTicket.category,
        priority: 'medium',
        description: newTicket.message,
        status: 'open',
        ai_handled: false
      });

      // Create initial message
      await SupportMessage.create({
        ticket_id: ticket.id,
        sender_type: 'user',
        message: newTicket.message,
        message_type: 'text'
      });

      // Reset form
      setNewTicket({ subject: '', category: '', message: '' });
      setShowNewTicketDialog(false);
      
      // Reload tickets
      await loadUserAndTickets();
      
      // Auto-open the new ticket
      await openTicket(ticket);

    } catch (error) {
      console.error('Error creating ticket:', error);
      alert('Failed to create ticket. Please try again.');
    }
    setIsCreatingTicket(false);
  };

  const openTicket = async (ticket) => {
    setSelectedTicket(ticket);
    try {
      // Load messages for this ticket
      const messages = await SupportMessage.filter(
        { ticket_id: ticket.id }, 
        'created_date'
      );
      setTicketMessages(messages);
    } catch (error) {
      console.error('Error loading ticket messages:', error);
      setTicketMessages([]);
    }
  };

  const sendMessage = async () => {
    if (!messageInput.trim() || !selectedTicket || !user) return;

    setIsSendingMessage(true);
    try {
      // Create message directly using entity
      await SupportMessage.create({
        ticket_id: selectedTicket.id,
        sender_type: 'user',
        message: messageInput,
        message_type: 'text'
      });

      setMessageInput('');
      await openTicket(selectedTicket); // Reload messages
      
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message. Please try again.');
    }
    setIsSendingMessage(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-slate-200 rounded-xl w-48" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="h-96 bg-slate-200 rounded-3xl" />
              <div className="h-96 bg-slate-200 rounded-3xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show login prompt if user is not authenticated
  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardContent className="p-12 text-center">
              <HelpCircle className="w-16 h-16 text-slate-400 mx-auto mb-6" />
              <h2 className="text-2xl font-bold text-slate-900 mb-4">Login Required</h2>
              <p className="text-slate-600 mb-6">
                Please log in to access the support center and manage your tickets.
              </p>
              <Button onClick={() => window.location.reload()}>
                Try Again
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <HelpCircle className="w-8 h-8 text-blue-600" />
              <div>
                <h1 className="text-3xl font-bold text-slate-900">Support Center</h1>
                <p className="text-slate-600">Get help with your bookings, payments, and account</p>
              </div>
            </div>
            
            <Dialog open={showNewTicketDialog} onOpenChange={setShowNewTicketDialog}>
              <DialogTrigger asChild>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  New Ticket
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Create Support Ticket</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700">Subject</label>
                    <Input
                      value={newTicket.subject}
                      onChange={(e) => setNewTicket({ ...newTicket, subject: e.target.value })}
                      placeholder="Brief description of your issue"
                      className="mt-1"
                    />
                  </div>
                  
                  <div>
                    <label className="text-sm font-semibold text-slate-700">Category</label>
                    <Select
                      value={newTicket.category}
                      onValueChange={(value) => setNewTicket({ ...newTicket, category: value })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="booking">Booking Issues</SelectItem>
                        <SelectItem value="payment">Payment & Billing</SelectItem>
                        <SelectItem value="account">Account & Profile</SelectItem>
                        <SelectItem value="technical">Technical Issues</SelectItem>
                        <SelectItem value="general">General Questions</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div>
                    <label className="text-sm font-semibold text-slate-700">Message</label>
                    <Textarea
                      value={newTicket.message}
                      onChange={(e) => setNewTicket({ ...newTicket, message: e.target.value })}
                      placeholder="Describe your issue in detail..."
                      className="mt-1 min-h-[100px]"
                    />
                  </div>
                  
                  <Button
                    onClick={createNewTicket}
                    disabled={isCreatingTicket}
                    className="w-full"
                  >
                    {isCreatingTicket ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white mr-2" />
                        Creating...
                      </>
                    ) : (
                      'Create Ticket'
                    )}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Tickets List */}
          <div>
            <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageCircle className="w-5 h-5" />
                  Your Support Tickets ({tickets.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {tickets.length === 0 ? (
                  <div className="text-center py-8">
                    <HelpCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">No Support Tickets</h3>
                    <p className="text-slate-600 mb-4">You haven't created any support tickets yet.</p>
                    <Button
                      onClick={() => setShowNewTicketDialog(true)}
                      variant="outline"
                    >
                      Create Your First Ticket
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {tickets.map((ticket) => {
                      const StatusIcon = statusIcons[ticket.status];
                      return (
                        <div
                          key={ticket.id}
                          onClick={() => openTicket(ticket)}
                          className={`p-4 rounded-xl border cursor-pointer transition-all duration-200 hover:shadow-md ${
                            selectedTicket?.id === ticket.id 
                              ? 'border-blue-400 bg-blue-50' 
                              : 'border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <h4 className="font-semibold text-slate-900 truncate">{ticket.subject}</h4>
                            <StatusIcon className="w-4 h-4 text-slate-500 flex-shrink-0 ml-2" />
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <Badge className={categoryColors[ticket.category]}>
                              {ticket.category}
                            </Badge>
                            <Badge className={statusColors[ticket.status]}>
                              {ticket.status.replace('_', ' ')}
                            </Badge>
                          </div>
                          <p className="text-sm text-slate-600 truncate">{ticket.description}</p>
                          <p className="text-xs text-slate-400 mt-2">
                            {new Date(ticket.created_date).toLocaleDateString()}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Chat Interface */}
          <div>
            <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="w-5 h-5" />
                  {selectedTicket ? `Support Chat - ${selectedTicket.subject}` : 'Select a Ticket'}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-full">
                {selectedTicket ? (
                  <div className="flex flex-col h-full">
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto space-y-4 mb-4 max-h-80">
                      {ticketMessages.map((message, index) => (
                        <div
                          key={index}
                          className={`flex items-start gap-3 ${
                            message.sender_type === 'user' ? 'flex-row-reverse' : ''
                          }`}
                        >
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            message.sender_type === 'user' 
                              ? 'bg-blue-100 text-blue-600' 
                              : 'bg-slate-100 text-slate-600'
                          }`}>
                            {message.sender_type === 'user' ? <UserIcon className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                          </div>
                          <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-xl ${
                            message.sender_type === 'user'
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-100 text-slate-900'
                          }`}>
                            <p className="text-sm">{message.message}</p>
                            <p className={`text-xs mt-1 ${
                              message.sender_type === 'user' ? 'text-blue-200' : 'text-slate-500'
                            }`}>
                              {new Date(message.created_date).toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Message Input */}
                    <div className="flex gap-2">
                      <Input
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        placeholder="Type your message..."
                        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        className="flex-1"
                      />
                      <Button
                        onClick={sendMessage}
                        disabled={isSendingMessage || !messageInput.trim()}
                        size="sm"
                      >
                        {isSendingMessage ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <MessageCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">Select a Support Ticket</h3>
                      <p className="text-slate-600">Choose a ticket from the list to start chatting</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}