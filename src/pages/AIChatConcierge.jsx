
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, Bot, User as UserIcon, Sparkles, MessageCircle, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format } from 'date-fns';
import BookingAssistant from '../components/chat/BookingAssistant';
import RecommendationCard from '../components/chat/RecommendationCard';
import SearchResultCard from '../components/chat/SearchResultCard';
import BookingDetailsCard from '../components/chat/BookingDetailsCard'; // New import
import { usePropertySearch } from "../components/hooks/usePropertySearch";

const welcomeLines = [
  "Hello! 👋 I'm **Agent Luxe**, your AI rental assistant.",
  "I'm here to help you find the perfect property, manage bookings, and provide personalized recommendations.",
  "I can assist with property searches, booking inquiries, check-in details, local recommendations, and much more! ✨"
];

export default function AIChatConciergePage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isIntroComplete, setIsIntroComplete] = useState(false);
  const [showBookingAssistant, setShowBookingAssistant] = useState(false);
  const [bookingParams, setBookingParams] = useState(null);
  const [user, setUser] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [userMessageCount, setUserMessageCount] = useState(0);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const { properties: searchedProperties, isLoading: isSearchingProperties, search: searchProperties } = usePropertySearch();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, showBookingAssistant]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  
  const animateWelcomeMessage = useCallback(() => {
    let currentLineIndex = 0;
    
    const showNextLine = () => {
      if (currentLineIndex < welcomeLines.length) {
        setMessages(prev => prev.map(msg => 
          msg.id === 'intro' ? { ...msg, content: welcomeLines.slice(0, currentLineIndex + 1).join('\n\n') } : msg
        ));
        currentLineIndex++;
        setTimeout(showNextLine, 1200);
      } else {
        setIsIntroComplete(true);
      }
    };
    
    setTimeout(showNextLine, 500);
  }, []);

  const initializeChatSession = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const userData = await base44.auth.me();
      setUser(userData);
      
      const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setSessionId(newSessionId);
      
      const recentHistory = await base44.entities.ChatHistory.filter(
        { user_email: userData.email },
        '-created_date',
        20
      );
      
      if (recentHistory.length > 0) {
        const historyMessages = recentHistory.reverse().map(h => ({
          id: h.id,
          role: h.role,
          content: h.message,
          type: h.message_type,
          metadata: h.metadata
        }));

        const userMessages = recentHistory.filter(h => h.role === 'user');
        setUserMessageCount(userMessages.length);
        
        setMessages([
          { 
            role: 'assistant', 
            content: "Welcome back! I remember our previous conversations. Would you like to continue where we left off, or start fresh?",
            id: 'welcome_back',
            showHistory: true,
            previousMessages: historyMessages
          }
        ]);
        setIsIntroComplete(true);
      } else {
        setMessages([{ role: 'assistant', content: '', id: 'intro' }]);
        animateWelcomeMessage();
      }
    } catch (error) {
      console.error("Error loading chat history:", error);
      setMessages([{ role: 'assistant', content: '', id: 'intro' }]);
      animateWelcomeMessage();
    }
    setIsLoadingHistory(false);
  }, [animateWelcomeMessage]);

  useEffect(() => {
    initializeChatSession();
  }, [initializeChatSession]);
  
  const checkChatQuestCompletion = async (userData, messageCount) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const chatQuest = await base44.entities.Quest.filter({ 
        user_email: userData.email, 
        quest_id: 'daily_chat_agent',
        status: 'available'
      });

      if (chatQuest.length > 0 && messageCount >= 2) {
        const quest = chatQuest[0];
        
        await base44.entities.Quest.update(quest.id, {
          status: 'completed',
          completion_date: new Date().toISOString(),
          last_completed_date: today
        });

        const newLoyaltyPoints = (userData.loyalty_points || 0) + quest.points_reward;
        const newTier = calculateLoyaltyTier(newLoyaltyPoints);

        await base44.auth.updateMe({
          loyalty_points: newLoyaltyPoints,
          loyalty_tier: newTier
        });

        await base44.entities.LoyaltyTransaction.create({
          user_email: userData.email,
          points_earned: quest.points_reward,
          transaction_type: 'engagement',
          description: 'Daily chat with Agent Luxe',
          quest_id: quest.id
        });

        await base44.entities.Quest.update(quest.id, { status: 'claimed' });

        setTimeout(() => {
          alert(`🎉 Daily quest completed! You earned ${quest.points_reward} Luxe Points for chatting with Agent Luxe today!`);
        }, 1500);
      }
    } catch (error) {
      console.error('Error checking chat quest:', error);
    }
  };

  const calculateLoyaltyTier = (points) => {
    if (points >= 10000) return 'Diamond';
    if (points >= 5000) return 'Platinum';
    if (points >= 2500) return 'Gold';
    if (points >= 1000) return 'Silver';
    return 'Bronze';
  };

  const saveMessageToHistory = async (message, role, messageType = 'text', metadata = null) => {
    if (!user || !sessionId) return;
    
    try {
      await base44.entities.ChatHistory.create({
        user_email: user.email,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        role,
        message_type: messageType,
        session_id: sessionId,
        metadata
      });
    } catch (error) {
      console.error("Error saving message to history:", error);
    }
  };

  const loadPreviousConversation = () => {
    const welcomeMessage = messages.find(m => m.showHistory);
    if (welcomeMessage && welcomeMessage.previousMessages) {
      setMessages([...welcomeMessage.previousMessages]);
    }
  };

  const startFreshConversation = () => {
    setMessages([{ role: 'assistant', content: '', id: 'intro' }]);
    animateWelcomeMessage();
    setUserMessageCount(0);
  };

  const continueWithAI = async (availableProperties, conversationContext, userMessage) => {
    try {
      let userBookings = [];
      let propertyMap = {};
      if (user) {
        try {
          userBookings = await base44.entities.Booking.filter({ guest_email: user.email });
          
          if (userBookings.length > 0) {
            const propertyIds = [...new Set(userBookings.map(b => b.property_id))];
            const properties = await base44.entities.Property.filter({ id: { $in: propertyIds } });
            propertyMap = properties.reduce((acc, prop) => {
              acc[prop.id] = prop;
              return acc;
            }, {});
          }
        } catch (error) {
          console.error('Failed to fetch bookings:', error);
        }
      }

      const prompt = `
You are **Agent Luxe (AI Rental Assistant)** — an expert AI co-host that manages and optimizes short-term rental properties for LuxeLiving.

## 🎯 YOUR CORE MISSION
Help guests find perfect properties, manage bookings, answer questions, and deliver five-star experiences through warm, professional, and efficient service.

## 🧠 INTELLIGENT BOOKING ASSISTANCE & MANAGEMENT

**SHOW INTERACTIVE BOOKING FORM when user:**
- Asks to "book a property" or "find a place"
- Wants to "search for accommodation"
- Says "I need a place to stay"
- Mentions travel to a specific location
- Asks "what's available in [location]?"
- Says "looking for" or "searching for" properties

**IMPORTANT: When you want to show the booking form, you MUST respond with EXACTLY this JSON format:**
{
  "action": "initiate_booking",
  "parameters": {
    "location": "extracted_location_or_null",
    "guests": "number_or_null"
  },
  "response": "Brief friendly message"
}

**SHOW BOOKING DETAILS when user asks about their bookings:**
- "Show my bookings"
- "What are my upcoming trips?"
- "Check my reservations"
- "Do I have any bookings?"
- "When is my next trip?"

When showing booking details, return:
{
  "action": "show_bookings",
  "response": "Here are your bookings:"
}

## ⚠️ CRITICAL RULES FOR PROPERTY RECOMMENDATIONS

1. **ONLY USE REAL PROPERTIES**: You can ONLY recommend properties from the database list provided below.
2. **NO FABRICATION**: NEVER make up property names, locations, or details.
3. **EXACT DATA ONLY**: Use the EXACT property_id, title, location, price, and images from the database.
4. **IF NO MATCH**: If no suitable properties exist in the database, trigger the booking form instead.
5. **VERIFY IDS**: Always double-check that the property_id you recommend exists in the provided list.
6. **DATA SOURCES**: Properties may come from our database OR live Airbnb/Booking.com data. Recommend from ALL available sources.

## 💬 COMMUNICATION STYLE
- Warm, polite, concise, and humanlike
- Natural short paragraphs
- Positive and solution-focused
- Thank users for their messages
- Use emojis sparingly for friendliness
- Be conversational and friendly

## 🚫 CRITICAL BOUNDARIES
- NEVER process payments directly
- NEVER confirm bookings without platform verification
- NEVER share sensitive personal data
- NEVER invent or fabricate property information
- Always direct payment to proper booking flow

## 📊 AVAILABLE PROPERTIES (Database + Live Airbnb Data via MCP)

${availableProperties.length > 0 ? JSON.stringify(availableProperties, null, 2) : "⚠️ NO PROPERTIES CURRENTLY IN DATABASE"}

**Total Properties Available: ${availableProperties.length}**
**Data Sources: ${[...new Set(availableProperties.map(p => p.source || 'database'))].join(', ')}**

${availableProperties.some(p => p.source === 'airbnb') ? '✨ **Note:** Some properties are fetched live from Airbnb via our MCP integration!' : ''}

## 📚 USER'S ACTIVE BOOKINGS

${userBookings.length > 0 ? JSON.stringify(userBookings.map(b => ({
  id: b.id,
  property_id: b.property_id,
  check_in: b.check_in,
  check_out: b.check_out,
  status: b.status,
  guests: b.guests,
  total_price: b.total_price,
  special_requests: b.special_requests
})), null, 2) : "No active bookings"}

## 💬 CONVERSATION HISTORY

${conversationContext}

## 📝 CURRENT USER MESSAGE

"${userMessage.content}"

## 🎯 RESPONSE ACTIONS

**ACTION 1: Show Interactive Booking Form**
When user wants to search/book/find properties:
{
  "action": "initiate_booking",
  "parameters": {
    "location": "city_name_if_mentioned_or_null",
    "guests": "number_if_mentioned_or_null"
  },
  "response": "I'd be happy to help you find the perfect property! Please fill out the search form below."
}

**ACTION 2: Show User Bookings**
When user asks about their bookings:
{
  "action": "show_bookings",
  "response": "Here are your bookings:"
}

**ACTION 3: Property Recommendations**
If user wants to browse properties AND suitable properties exist:
{
  "action": "provide_recommendations",
  "recommendations": [
    {
      "property_id": "exact_id_from_database",
      "property_title": "exact_title",
      "location": "city, country",
      "price_per_night": "actual_price",
      "perfect_for": "why this property matches their needs",
      "property_type": "type",
      "imageUrl": "first_image_url"
    }
  ],
  "response": "Brief introduction message"
}

**ACTION 4: General Conversation**
For other queries, return just a text response (not JSON).

## 🌟 REMEMBER
- Be helpful and proactive
- Show booking details when asked
- Use interactive forms for searches
- **NEVER RECOMMEND FAKE PROPERTIES**
- **ALWAYS return proper JSON for actions**
- **Recommend from ALL available properties (database + MCP/Airbnb)**
`;

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        add_context_from_internet: false
      });
      
      let assistantMessage;
      try {
        const parsedResult = JSON.parse(result);
        
        if (parsedResult.action === 'show_bookings') {
          if (userBookings.length > 0) {
            assistantMessage = { 
              id: Date.now() + 1, 
              role: 'assistant', 
              content: parsedResult.response,
              type: 'booking_details',
              bookings: userBookings,
              properties: propertyMap
            };
            await saveMessageToHistory(parsedResult.response, 'assistant', 'booking_details');
          } else {
            assistantMessage = { 
              id: Date.now() + 1, 
              role: 'assistant', 
              content: "You don't have any bookings yet. Would you like me to help you find a property?" 
            };
            await saveMessageToHistory(assistantMessage.content, 'assistant');
          }
        } else if (parsedResult.action === 'provide_recommendations') {
          const validRecommendations = [];
          
          for (const rec of parsedResult.recommendations) {
            const propertyExists = availableProperties.find(p => p.id === rec.property_id);
            if (propertyExists) {
              validRecommendations.push({
                ...rec,
                imageUrl: propertyExists.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800'
              });
            }
          }
          
          if (validRecommendations.length > 0) {
            assistantMessage = { 
              id: Date.now() + 1,
              role: 'assistant', 
              type: 'recommendations',
              content: validRecommendations
            };
            await saveMessageToHistory(validRecommendations, 'assistant', 'recommendations');
          } else {
            assistantMessage = { 
              id: Date.now() + 1, 
              role: 'assistant', 
              content: "I apologize, but I couldn't find exact matches for your criteria. Let me show you our available properties instead, or you can refine your search." 
            };
            await saveMessageToHistory(assistantMessage.content, 'assistant');
          }
        } else if (parsedResult.action === 'initiate_booking') {
          assistantMessage = { 
            id: Date.now() + 1, 
            role: 'assistant', 
            content: parsedResult.response,
            type: 'booking_form',
            showForm: true
          };
          setBookingParams(parsedResult.parameters);
          setShowBookingAssistant(true);
          await saveMessageToHistory(parsedResult.response, 'assistant', 'booking_assistance', parsedResult.parameters);
        } else {
          assistantMessage = { id: Date.now() + 1, role: 'assistant', content: result };
          if (parsedResult.response) {
            assistantMessage.content = parsedResult.response;
          }
          await saveMessageToHistory(assistantMessage.content, 'assistant');
        }
      } catch (e) {
        assistantMessage = { id: Date.now() + 1, role: 'assistant', content: result };
        await saveMessageToHistory(result, 'assistant');
      }

      setMessages(prev => [...prev, assistantMessage]);

    } catch (error) {
      console.error("Error in AI processing:", error);
      throw error;
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    if (showBookingAssistant) setShowBookingAssistant(false);

    const userMessage = { id: Date.now(), role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    
    await saveMessageToHistory(input, 'user');
    
    const newMessageCount = userMessageCount + 1;
    setUserMessageCount(newMessageCount);
    
    if (user && newMessageCount >= 2) {
      await checkChatQuestCompletion(user, newMessageCount);
    }
    
    const recentMessages = messages.slice(-10);
    const conversationContext = [...recentMessages, userMessage]
      .map(msg => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`)
      .join('\n');
    
    setInput("");
    setIsLoading(true);

    try {
      console.log('🤖 Agent Luxe: Fetching properties via smart search...');
      
      let propertiesForAI = [];
      try {
        // Extract location from user message if present
        const locationMatch = input.toLowerCase().match(/(?:in|at|near|around)\s+([a-z\s]+?)(?:\s|$|,|\.|for|with)/i);
        const extractedLocation = locationMatch ? locationMatch[1].trim() : null;
        
        console.log('🔍 Extracted location from message:', extractedLocation);
        
        // Use smart search with location to get both DB + MCP properties
        await searchProperties({
          location: extractedLocation,
          limit: 30
        });
        
        // We need to wait for the state update from usePropertySearch to reflect.
        // A simple setTimeout is used as a workaround. In a more robust system,
        // usePropertySearch could expose a promise or a callback to signal completion.
        setTimeout(async () => {
          if (searchedProperties.length > 0) {
            propertiesForAI = searchedProperties;
          } else {
            // Fallback to fetching only database properties if search hook yields nothing initially
            const dbProperties = await base44.entities.Property.list('-rating', 30);
            propertiesForAI = dbProperties.map(p => ({ ...p, source: 'database' }));
          }

          const mappedPropertiesForAI = propertiesForAI.map(p => ({
            id: p.id,
            title: p.title,
            location_city: p.location?.city,
            location_country: p.location?.country,
            price_per_night: p.price_per_night,
            currency: p.currency || 'USD',
            max_guests: p.max_guests,
            bedrooms: p.bedrooms,
            property_type: p.property_type,
            amenities: p.amenities || [],
            rating: p.rating,
            images: p.images || [],
            source: p.source || 'database' // Ensure source is included
          }));
          
          console.log(`🤖 Agent Luxe: Using ${mappedPropertiesForAI.length} properties (DB + MCP)`);
          console.log(`📊 Sources: ${[...new Set(mappedPropertiesForAI.map(p => p.source))].join(', ')}`);
          
          await continueWithAI(mappedPropertiesForAI, conversationContext, userMessage);
        }, 100); // Small delay to allow searchedProperties to potentially update
        
      } catch (error) {
        console.error('Failed to fetch properties via smart search:', error);
        // Fallback to database only in case of error
        const dbProperties = await base44.entities.Property.list('-rating', 30);
        propertiesForAI = dbProperties.map(p => ({
          id: p.id,
          title: p.title,
          location_city: p.location?.city,
          location_country: p.location?.country,
          price_per_night: p.price_per_night,
          currency: p.currency || 'USD',
          max_guests: p.max_guests,
          bedrooms: p.bedrooms,
          property_type: p.property_type,
          amenities: p.amenities || [],
          rating: p.rating,
          images: p.images || [],
          source: 'database'
        }));
        
        await continueWithAI(propertiesForAI, conversationContext, userMessage);
      }

    } catch (error) {
      console.error("Error communicating with AI:", error);
      const errorMessage = { 
        id: Date.now() + 1,
        role: 'assistant', 
        content: "I'm having a little trouble connecting right now. Please try again in a moment! In the meantime, you can browse our available properties or contact our support team for immediate assistance. 😊" 
      };
      setMessages(prev => [...prev, errorMessage]);
      await saveMessageToHistory(errorMessage.content, 'assistant');
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickPrompts = [
    "Show me my bookings",
    "Find me a place in Manhattan",
    "What's available in Miami for next weekend?",
    "Show me luxury apartments"
  ];

  const handleQuickPrompt = (prompt) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleBookingSearch = async (details) => {
    const { location, checkIn, checkOut, guests, propertyType, bedrooms } = details;
    
    setShowBookingAssistant(false);
    setIsLoading(true);

    const searchMessage = {
      id: Date.now(),
      role: 'user',
      content: `Looking for ${propertyType && propertyType !== 'any' ? propertyType : 'any'} property in ${location} for ${guests} guests from ${format(checkIn, 'MMM d, yyyy')} to ${format(checkOut, 'MMM d, yyyy')}${bedrooms && bedrooms !== 'any' ? `, ${bedrooms} bedroom${bedrooms !== '1' ? 's' : ''}` : ''}`
    };
    setMessages(prev => [...prev, searchMessage]);
    await saveMessageToHistory(searchMessage.content, 'user', 'booking_search', details);

    try {
      await searchProperties({
        location,
        guests,
        bedrooms: bedrooms === 'any' ? null : bedrooms,
        propertyType: propertyType === 'any' ? null : propertyType,
        limit: 20
      });

      // Another setTimeout workaround to ensure `searchedProperties` is updated before using it
      setTimeout(() => {
        if (searchedProperties.length > 0) {
          const resultsMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            type: 'search_results',
            content: {
              results: searchedProperties,
              searchCriteria: details,
              message: `I found ${searchedProperties.length} properties matching your criteria in ${location}. Here are some great options for you:`
            }
          };
          setMessages(prev => [...prev, resultsMessage]);
          saveMessageToHistory(resultsMessage.content, 'assistant', 'search_results', details);
        } else {
          const noResultsMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: `I couldn't find any properties matching your exact criteria in ${location}. Would you like me to:\n\n• Expand the search to nearby areas\n• Show properties with different guest capacity\n• Suggest alternative property types\n• Help you search in a different location\n\nJust let me know how you'd like to adjust your search!`
          };
          setMessages(prev => [...prev, noResultsMessage]);
          saveMessageToHistory(noResultsMessage.content, 'assistant', 'no_results', details);
        }
        setIsLoading(false);
      }, 100);

    } catch (error) {
      console.error('Error searching properties:', error);
      const errorMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: "I'm having trouble searching our properties right now. Please try again in a moment, or feel free to browse our available properties manually."
      };
      setMessages(prev => [...prev, errorMessage]);
      await saveMessageToHistory(errorMessage.content, 'assistant', 'error');
      setIsLoading(false);
    }
  };

  if (isLoadingHistory) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-slate-900 border-t-transparent mx-auto mb-4"></div>
          <p className="text-slate-600">Loading your conversation history...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <div className="flex-shrink-0 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-gradient-to-br from-slate-900 to-slate-800 rounded-full flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-900">Agent Luxe</h1>
                <p className="text-xs text-slate-500">Your AI Travel Concierge</p>
              </div>
            </div>
            {user && (
              <Button
                variant="ghost"
                size="sm"
                onClick={startFreshConversation}
                className="text-slate-500 hover:text-slate-700"
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                Start Fresh
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto">
          <div className="px-4 sm:px-6 py-4">
            <AnimatePresence>
              {messages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className={`flex gap-3 mb-5 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {message.role === 'assistant' && (
                    <div className="w-7 h-7 bg-gradient-to-br from-slate-900 to-slate-800 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-amber-400" />
                    </div>
                  )}
                  
                  <div className={`max-w-[85%] sm:max-w-[75%] ${message.role === 'user' ? 'order-1' : ''}`}>
                    {message.showHistory ? (
                      <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
                        <ReactMarkdown className="prose max-w-none prose-sm prose-slate mb-4">
                          {message.content}
                        </ReactMarkdown>
                        <div className="flex gap-3">
                          <Button 
                            onClick={loadPreviousConversation}
                            size="sm"
                            className="bg-slate-900 hover:bg-slate-800"
                          >
                            Continue Previous Chat
                          </Button>
                          <Button 
                            onClick={startFreshConversation}
                            variant="outline"
                            size="sm"
                          >
                            Start Fresh
                          </Button>
                        </div>
                      </div>
                    ) : message.type === 'booking_form' && message.showForm ? (
                      <div className="space-y-2">
                        <div className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                          <p className="text-sm text-slate-800">{message.content}</p>
                        </div>
                        <BookingAssistant 
                          initialParams={bookingParams}
                          onSearch={handleBookingSearch}
                          onCancel={() => {
                            setMessages(prev => prev.map(m => 
                              m.id === message.id ? { ...m, showForm: false } : m
                            ));
                          }}
                        />
                      </div>
                    ) : message.type === 'booking_details' ? (
                      <div className="space-y-4">
                        <div className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                          <p className="text-sm text-slate-800">{message.content}</p>
                        </div>
                        {message.bookings.map((booking) => (
                          <BookingDetailsCard 
                            key={booking.id} 
                            booking={booking}
                            property={message.properties[booking.property_id]}
                          />
                        ))}
                      </div>
                    ) : message.type === 'recommendations' ? (
                      <div className="space-y-4">
                        {message.content.map((rec, recIndex) => (
                          <RecommendationCard key={recIndex} recommendation={rec} />
                        ))}
                      </div>
                    ) : message.type === 'search_results' ? (
                      <div className="space-y-4">
                        <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
                          <ReactMarkdown className="prose max-w-none prose-sm prose-slate">
                            {message.content.message}
                          </ReactMarkdown>
                        </div>
                        <div className="grid grid-cols-1 gap-4 max-w-2xl">
                          {message.content.results.slice(0, 3).map((property) => (
                            <SearchResultCard 
                              key={property.id} 
                              property={property}
                              user={user}
                            />
                          ))}
                        </div>
                        {message.content.results.length > 3 && (
                          <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl text-center">
                            <p className="text-sm text-slate-600 mb-2">
                              And {message.content.results.length - 3} more properties available
                            </p>
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => {
                                const params = new URLSearchParams();
                                if (message.content.searchCriteria.location) {
                                  params.append('search', message.content.searchCriteria.location);
                                }
                                if (message.content.searchCriteria.checkIn) {
                                  params.append('checkIn', format(message.content.searchCriteria.checkIn, 'yyyy-MM-dd'));
                                }
                                if (message.content.searchCriteria.checkOut) {
                                  params.append('checkOut', format(message.content.searchCriteria.checkOut, 'yyyy-MM-dd'));
                                }
                                if (message.content.searchCriteria.guests) {
                                  params.append('guests', message.content.searchCriteria.guests.toString());
                                }
                                if (message.content.searchCriteria.propertyType && message.content.searchCriteria.propertyType !== 'any') {
                                  params.append('propertyType', message.content.searchCriteria.propertyType);
                                }
                                if (message.content.searchCriteria.bedrooms && message.content.searchCriteria.bedrooms !== 'any') {
                                  params.append('bedrooms', message.content.searchCriteria.bedrooms);
                                }

                                navigate(createPageUrl(`Search?${params.toString()}`));
                              }}
                            >
                              View All Results
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className={`p-3 rounded-xl shadow-sm ${
                        message.role === 'user' 
                          ? 'bg-slate-900 text-white rounded-br-lg'
                          : 'bg-white text-slate-800 border border-slate-200 rounded-bl-lg'
                      }`}>
                        <ReactMarkdown 
                          className={`prose max-w-none prose-sm prose-p:my-1.5 ${
                            message.role === 'user' ? 'prose-invert' : 'prose-slate'
                          }`}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {message.role === 'user' && (
                    <div className="w-7 h-7 bg-slate-300 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 order-2">
                      <UserIcon className="w-3.5 h-3.5 text-slate-600" />
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex gap-3 mb-5"
              >
                <div className="w-7 h-7 bg-gradient-to-br from-slate-900 to-slate-800 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <div className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              </motion.div>
            )}

            {!showBookingAssistant && isIntroComplete && messages.length === 1 && !isLoading && (
              <div className="mt-6">
                <p className="text-xs text-slate-500 mb-3 text-center">Or try one of these:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {quickPrompts.map((prompt, index) => (
                    <Card 
                      key={index}
                      className="p-2.5 cursor-pointer hover:bg-slate-100 transition-colors border-slate-200 rounded-lg"
                      onClick={() => handleQuickPrompt(prompt)}
                    >
                      <div className="flex items-center gap-1.5">
                        <MessageCircle className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-xs text-slate-600 line-clamp-1">{prompt}</span>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="px-3 sm:px-4 py-2.5">
          <div className="flex gap-2 items-center">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Message Agent Luxe..."
              className="flex-1 py-2.5 px-3.5 rounded-lg border-slate-300 focus:border-slate-500 focus:ring-slate-500/30 resize-none text-sm"
              disabled={isLoading}
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="bg-slate-900 hover:bg-slate-800 text-white p-2.5 rounded-lg shadow-sm transition-all duration-200 hover:shadow-md disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
