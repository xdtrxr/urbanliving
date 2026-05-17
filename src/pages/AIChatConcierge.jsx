import React, { useState, useRef, useEffect, useCallback } from 'react';
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, Bot, User as UserIcon, Sparkles, MessageCircle, RotateCcw, Mic, MicOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { format } from 'date-fns';
import BookingAssistant from '../components/chat/BookingAssistant';
import RecommendationCard from '../components/chat/RecommendationCard';
import SearchResultCard from '../components/chat/SearchResultCard';
import BookingDetailsCard from '../components/chat/BookingDetailsCard'; // New import
import BookingConfirmCard from '../components/chat/BookingConfirmCard';
import { usePropertySearch } from "../components/hooks/usePropertySearch";
import { useSpeechToText } from "../components/hooks/useSpeechToText";

const welcomeLines = [
  "Hello! 👋 I'm **Agent Nova**, your AI rental assistant.",
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
  const [lastLead, setLastLead] = useState(null);
  const [user, setUser] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [userMessageCount, setUserMessageCount] = useState(0);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const autoPromptSentRef = useRef(false);
  const navigate = useNavigate();

  const { properties: searchedProperties, isLoading: isSearchingProperties, search: searchProperties } = usePropertySearch();

  // Speech-to-text: appends final transcript to whatever's already in the input.
  const { isSupported: speechSupported, isListening, transcript, start: startListening, stop: stopListening } = useSpeechToText({
    onFinal: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
    lang: 'en-US',
  });
  const toggleMic = () => {
    if (isListening) stopListening();
    else startListening();
  };

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

  // Auto-send a one-shot prompt when arriving with `?prompt=...` in the URL.
  // Used by the Search page's "AI Recommendations" button so the rec flow
  // happens inside Nova end-to-end. Fires once after the chat is ready.
  useEffect(() => {
    if (autoPromptSentRef.current) return;
    if (isLoadingHistory || !user || !isIntroComplete) return;
    const params = new URLSearchParams(window.location.search);
    const seeded = params.get('prompt');
    if (!seeded || !seeded.trim()) return;
    autoPromptSentRef.current = true;
    // Clear the param from the URL so a refresh doesn't re-send it.
    params.delete('prompt');
    const newQs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${newQs ? `?${newQs}` : ''}`);
    handleSend(seeded.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingHistory, user, isIntroComplete]);

  // Proactive Nova nudges: surface unread booking status changes when chat reopens.
  // Tracks announced booking IDs in localStorage so we don't re-nudge.
  const surfaceProactiveNudges = useCallback(async () => {
    try {
      const result = await base44.functions.invoke('getBookings', { scope: 'mine' });
      if (!result?.data?.success) return;
      const bookings = result.data.data || [];

      const seenKey = 'nova_announced_booking_events';
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem(seenKey) || '{}'); } catch { seen = {}; }

      const nudgeMessages = [];
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      for (const b of bookings) {
        // Approved + awaiting payment — render a CTA card with Pay Now + View Property
        if (b.bucket === 'pending-approval' && b.approved_at && !b.payment_started_at) {
          const key = `approved:${b.id}`;
          if (!seen[key]) {
            nudgeMessages.push({
              id: `nova_cta_${b.id}`,
              role: 'assistant',
              type: 'booking_cta',
              cta: 'pay',
              content: `✅ Admin approved your request for **${b.property_title || 'your booking'}**. You have ~1 hour to pay before it auto-cancels.`,
              booking: {
                id: b.id,
                property_id: b.property_id,
                property_title: b.property_title || '',
                guest_email: b.guest_email || '',
                total_price: b.total_price || 0,
              },
            });
            seen[key] = now;
          }
        }
        // Newly paid/confirmed in last 24h — text-only nudge
        if (b.bucket === 'upcoming' && b.paid_at) {
          const paidMs = Date.parse(b.paid_at);
          if (!Number.isNaN(paidMs) && now - paidMs < dayMs) {
            const key = `paid:${b.id}`;
            if (!seen[key]) {
              nudgeMessages.push({
                id: `nova_cta_${b.id}_paid`,
                role: 'assistant',
                type: 'booking_cta',
                cta: 'view',
                content: `🎉 Payment confirmed for **${b.property_title || 'your booking'}**. See you soon!`,
                booking: {
                  id: b.id,
                  property_id: b.property_id,
                  property_title: b.property_title || '',
                },
              });
              seen[key] = now;
            }
          }
        }
        // Auto-cancelled (timer expired)
        if (b.bucket === 'cancelled' && b.payment_deadline) {
          const key = `expired:${b.id}`;
          if (!seen[key]) {
            nudgeMessages.push({
              id: `nova_nudge_${b.id}_expired`,
              role: 'assistant',
              content: `⏰ Booking \`${b.id}\` was auto-cancelled because the payment window expired. Want me to find another option?`,
            });
            seen[key] = now;
          }
        }
      }

      if (nudgeMessages.length === 0) return;

      // Prune entries older than 30 days
      for (const k of Object.keys(seen)) {
        if (now - (seen[k] || 0) > 30 * dayMs) delete seen[k];
      }
      localStorage.setItem(seenKey, JSON.stringify(seen));

      setMessages((prev) => [...nudgeMessages, ...prev]);
    } catch (err) {
      console.warn('Proactive nudge check failed:', err);
    }
  }, []);

  useEffect(() => {
    if (!isLoadingHistory && user) {
      surfaceProactiveNudges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingHistory, user]);
  
  const checkChatQuestCompletion = async (userData, messageCount) => {
    if (messageCount < 2) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      const DAILY_CHAT_POINTS = 50; // mirrors QUEST_REGISTRY.daily_chat_agent.points

      // Self-healing: find OR create the daily quest, then daily-reset if stale.
      // Previously this only awarded when the user had visited /Quests first,
      // because that's where the Quest row was created and daily-reset. Users
      // who only used Nova never got their 50 points.
      let existing = await base44.entities.Quest.filter({
        user_email: userData.email,
        quest_id: 'daily_chat_agent',
      });
      let quest = existing[0];

      if (!quest) {
        quest = await base44.entities.Quest.create({
          quest_id: 'daily_chat_agent',
          quest_type: 'daily_engagement',
          platform: 'chat_agent',
          points_reward: DAILY_CHAT_POINTS,
          verification_method: 'automatic',
          is_daily: true,
          user_email: userData.email,
          status: 'available',
        });
      } else if (quest.status === 'claimed' && quest.last_completed_date !== today) {
        // Daily reset
        await base44.entities.Quest.update(quest.id, {
          status: 'available',
          completion_date: null,
          last_completed_date: null,
        });
        quest = { ...quest, status: 'available', completion_date: null, last_completed_date: null };
      }

      if (quest.status !== 'available') return; // already claimed today

      const reward = quest.points_reward || DAILY_CHAT_POINTS;

      await base44.entities.Quest.update(quest.id, {
        status: 'completed',
        completion_date: new Date().toISOString(),
        last_completed_date: today,
      });

      const newLoyaltyPoints = (userData.loyalty_points || 0) + reward;
      const newTier = calculateLoyaltyTier(newLoyaltyPoints);

      await base44.auth.updateMe({
        loyalty_points: newLoyaltyPoints,
        loyalty_tier: newTier,
      });

      await base44.entities.LoyaltyTransaction.create({
        user_email: userData.email,
        points_earned: reward,
        transaction_type: 'engagement',
        description: 'Daily chat with Agent Nova',
        quest_id: quest.id,
      });

      await base44.entities.Quest.update(quest.id, { status: 'claimed' });

      setTimeout(() => {
        alert(`🎉 Daily quest completed! You earned ${reward} Urban Points for chatting with Agent Nova today!`);
      }, 1500);
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
    
    const MAX_MESSAGE_LENGTH = 2000;
    let messageText = typeof message === 'string' ? message : JSON.stringify(message);
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      messageText = messageText.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]';
    }

    try {
      await base44.entities.ChatHistory.create({
        user_email: user.email,
        message: messageText,
        role,
        message_type: ['text', 'recommendations', 'booking_assistance'].includes(messageType) ? messageType : 'text',
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

  // For each property in the candidate list, attach the active booked ranges
  // so Nova can avoid recommending properties whose dates conflict with
  // existing pending/confirmed bookings. Fails open (empty ranges) on error
  // so a bookings-API blip doesn't take down recommendations.
  const enrichWithBookedRanges = async (props) => {
    if (!Array.isArray(props) || props.length === 0) return props;
    const dbIds = props.map((p) => p.id).filter((id) => typeof id === 'string' && id.length > 10);
    if (dbIds.length === 0) return props.map((p) => ({ ...p, booked_ranges: [] }));
    let activeBookings = [];
    try {
      activeBookings = await base44.entities.Booking.filter({
        property_id: { $in: dbIds },
        status: { $in: ['confirmed', 'pending'] },
      });
    } catch (err) {
      console.warn('enrichWithBookedRanges: Booking.filter failed (fail-open):', err);
    }
    const byProperty = new Map();
    for (const b of activeBookings || []) {
      if (!b.property_id || !b.check_in || !b.check_out) continue;
      const arr = byProperty.get(b.property_id) || [];
      arr.push({ check_in: b.check_in, check_out: b.check_out, status: b.status });
      byProperty.set(b.property_id, arr);
    }
    return props.map((p) => ({ ...p, booked_ranges: byProperty.get(p.id) || [] }));
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

      const knownUser = user ? {
        is_authenticated: true,
        full_name: user.full_name || null,
        email: user.email || null,
        phone_number: user.phone_number || null,
      } : { is_authenticated: false };

      const prompt = `
You are **Agent Nova**, the AI booking assistant for **UrbanStays by HOMESHARES LTD** — verified short-stay apartments in Nigeria.

## 🆔 IDENTITY
If asked who you are, respond:
"Hi, I'm Agent Nova, your AI booking assistant for UrbanStays by HOMESHARES. I help you find and book verified apartments in Abuja and Lagos quickly and stress-free."

You are NOT a generic chatbot. You sell, qualify, support, and close bookings for UrbanStays. Tone: friendly, professional, fast, human-like, knowledgeable, helpful.

## 🌍 COVERAGE (V1 — Nigeria Launch)
- Launch cities: **Abuja** and **Lagos** only.
- Abuja areas: Maitama, Asokoro, Wuse, Wuse 2, Jabi, Gwarinpa, Utako, Life Camp, Katampe.
- Lagos areas: Lekki, Ikoyi, Victoria Island (VI), Ajah, Chevron, Ikeja, Yaba, Surulere.
- If the user asks about another Nigerian city, say it's coming soon and offer Abuja or Lagos meanwhile.
- International guests are welcome ("Absolutely. UrbanStays supports both local and international guests. I can help you find and secure the right apartment.").

## 🗣 LANGUAGE SUPPORT — STRICT MIRRORING
You MIRROR the user's most recent message language. Check the latest user message every turn — do NOT pick a language once and stick to it.

- User wrote pure English last turn → you reply in English. ("I need an apartment in Lekki" → "Got it. Which area in Lekki do you prefer?")
- User wrote pure Pidgin last turn → you reply in Pidgin. ("Abeg I need apartment for Abuja" → "No wahala, which area for Abuja you wan stay?")
- User mixed English + Pidgin → mirror the same mix.
- User SWITCHED languages mid-conversation (e.g. opened in Pidgin, now writing English) → switch with them on the very next reply. Don't keep speaking Pidgin to an English message — it sounds robotic and breaks trust.
- Slang, abbreviations, typos are fine — infer intent; never reply "I didn't understand," ask a clarifying question instead.

Slang & abbreviation glossary:
- "abj" = Abuja • "lag" = Lagos • "VI" = Victoria Island • "wknd" = weekend
- "2bed" / "2br" = 2 bedroom • "chk in" / "ci" = check-in • "chk out" / "co" = check-out
- "abeg" = please • "no wahala" = no problem • "fit" = can / able • "wetin" = what
- "dey" = is/are • "wan" = want • "shortlet" = short-let apartment

Always infer intent through typos — never reply "I didn't understand," ask a clarifying question instead.

## 🎯 CORE BOOKING FLOW (qualification → lead → options)

When the user signals booking intent (any of: "I need apartment", "looking for a place", "got any shortlet?", "need somewhere for [date]", "any place for tonight?", "need a spot", "book apartment"), qualify in this order, **STRICTLY ONE question per turn**, in their language:

1. City — Abuja or Lagos?
2. Area / neighbourhood
3. Check-in date
4. Check-out date
5. Number of guests
6. Budget per night (or total budget)
7. Apartment type — Studio, 1 Bedroom, 2 Bedroom, 3 Bedroom, or Family Apartment

HARD RULE: NEVER ask two qualification questions in one message. "What are your check-in and check-out dates?" is forbidden — ask check-in first, then on the next turn ask check-out. If the user volunteers multiple answers in one message (e.g. "Lekki, 2 guests, March 5-8"), parse them all and skip to the next missing question.

Only when you have ALL SEVEN, move to lead capture.

## 📇 LEAD CAPTURE (mandatory before showing properties)

${knownUser.is_authenticated
  ? `The user is already signed in. We already have:
  • Name: ${knownUser.full_name || '(missing — ask for it)'}
  • Email: ${knownUser.email}
  • Phone: ${knownUser.phone_number || '(missing — ask for it once, politely)'}
  Do NOT re-ask for name or email. Only ask for phone if missing.`
  : `The user is NOT signed in. After the 7 qualification questions, collect:
  • Full name
  • Phone number (international format if possible)
  • Email address
  Collect them politely in 1–2 turns. Don't lecture about why.`}

Once you have qualification + contact info, return action **capture_lead** (see below). The system will create a Lead row, notify the admin sales team instantly, and then you should ask the sales-close question.

## 🛎 SALES CLOSE (every booking conversation ends here)
After lead capture, ask:
- English: "Would you like me to show you available apartments now?"
- Pidgin variant if user has been Pidgin: "You wan make I show you available apartments now?"

When they say yes → return **provide_recommendations** (matching the lead) OR **initiate_booking** if no exact match.

## 💬 RESPONSE TEMPLATES (use the spirit, not the exact words; adapt to register)

- **Trust / "is this legit?"** → "UrbanStays works with verified apartments and structured bookings to provide a reliable, stress-free experience. Every property is vetted, and your payment is protected through our secure flow."
- **Price / "how much?"** → "Pricing depends on location, dates, apartment type, and availability. Share your budget and preferred area and I'll show you what fits."
- **Urgent / "I need a place today"** → "I can help with urgent bookings. Send your city, area, budget, and number of guests so I can check live availability."
- **Cancellation / refund** → "Cancellation and refund policies vary by property. I'll show you the exact terms before you confirm any booking."
- **Random / "you be human?"** → "I'm Agent Nova, your UrbanStays AI booking assistant. I may be AI, but I know my way around apartments in Abuja and Lagos."

## 🆘 ESCALATION
If the user's request is genuinely outside booking (legal issue, dispute, refund complaint, anything you can't confidently resolve, or they explicitly ask for a human), return action **escalate_to_human**. Don't loop — escalate after one honest attempt to help.

## ⚠️ HARD RULES
- ONLY recommend properties from the AVAILABLE PROPERTIES list below. Never invent property names, IDs, prices, or locations.
- NEVER process payments yourself. Direct payment through the platform flow.
- NEVER share personal data of other users.
- NEVER guess dates or guest counts. If unknown, ask.
- ALWAYS return valid JSON when you choose an action. For plain conversation, return text only (no JSON).

## 📆 AVAILABILITY-AWARE RECOMMENDATIONS
Each property in AVAILABLE PROPERTIES has a \`booked_ranges\` array of \`{check_in, check_out, status}\` for currently pending or confirmed bookings.

When the user has given you their requested check_in and check_out dates, BEFORE recommending or proposing a booking on a property:
1. Check each \`booked_range\` for that property.
2. Two ranges overlap if requested.check_in < range.check_out AND requested.check_out > range.check_in.
3. If ANY overlap exists, the property is UNAVAILABLE for those dates — do NOT recommend it and do NOT use it in \`confirm_booking\`. Suggest alternative properties instead, or ask the user about different dates.

If the user hasn't given dates yet, ignore booked_ranges and recommend normally — they'll be filtered when dates are chosen.

## 👤 KNOWN USER CONTEXT
${JSON.stringify(knownUser, null, 2)}

## 🧾 LEAD STATUS THIS SESSION
${lastLead ? `LEAD_ALREADY_CAPTURED for ${lastLead.email || lastLead.name || '(unknown)'} — city=${lastLead.city || '?'}, area=${lastLead.area || '?'}, check_in=${lastLead.check_in || '?'}, check_out=${lastLead.check_out || '?'}, guests=${lastLead.guests || '?'}, type=${lastLead.apartment_type || '?'}.

HARD RULE: DO NOT emit \`capture_lead\` again — admin has already been notified for this session. Instead progress the conversation:
- If user says yes/yeah/sure/show me/abeg show/wetin you get to the sales-close question, IMMEDIATELY emit \`provide_recommendations\` using the AVAILABLE PROPERTIES list filtered by the lead's city/area/budget/type and skipping anything whose booked_ranges overlap the lead's dates.
- If the user names a specific property and we have property + dates + guests, emit \`confirm_booking\`.
- If no properties match the lead's criteria, say so and offer to broaden the search.` : 'No lead captured yet this session.'}

## 📊 AVAILABLE PROPERTIES (Database + Live Data via MCP)
${availableProperties.length > 0 ? JSON.stringify(availableProperties, null, 2) : "⚠️ NO PROPERTIES CURRENTLY AVAILABLE"}
Total: ${availableProperties.length} | Sources: ${[...new Set(availableProperties.map(p => p.source || 'database'))].join(', ')}

## 📚 USER'S ACTIVE BOOKINGS
${userBookings.length > 0 ? JSON.stringify(userBookings.map(b => ({
  id: b.id, property_id: b.property_id, check_in: b.check_in, check_out: b.check_out,
  status: b.status, guests: b.guests, total_price: b.total_price, special_requests: b.special_requests,
})), null, 2) : "No active bookings"}

## 💬 CONVERSATION HISTORY (last 10)
${conversationContext}

## 📝 CURRENT USER MESSAGE
"${userMessage.content}"

## 🎯 RESPONSE ACTIONS — choose ONE and return as STRICT JSON, or return plain text for casual chat.

**capture_lead** — when you have all 7 qualification answers + (name, phone, email):
{
  "action": "capture_lead",
  "lead": {
    "name": "...",
    "phone": "...",
    "email": "...",
    "city": "Abuja" | "Lagos" | "Other",
    "area": "...",
    "check_in": "YYYY-MM-DD",
    "check_out": "YYYY-MM-DD",
    "guests": 2,
    "budget_min": 50000,
    "budget_max": 150000,
    "apartment_type": "Studio" | "1 Bedroom" | "2 Bedroom" | "3 Bedroom" | "Family Apartment" | "Any",
    "special_requests": "..."
  },
  "response": "Got it — I've passed your details to our team. Want me to show you available apartments now?"
}

**provide_recommendations** — only when properties matching the lead exist in the AVAILABLE PROPERTIES list:
{
  "action": "provide_recommendations",
  "recommendations": [
    {
      "property_id": "exact_id_from_database",
      "property_title": "exact_title",
      "location": "city, country",
      "price_per_night": 80000,
      "perfect_for": "why this matches their criteria",
      "property_type": "type",
      "imageUrl": "first_image_url"
    }
  ],
  "response": "Brief intro message"
}

**confirm_booking** — fire AS SOON AS you have all four of: a real property_id from AVAILABLE PROPERTIES, a check_in (YYYY-MM-DD), a check_out (YYYY-MM-DD), and a guest count.

You MUST emit confirm_booking when:
- You just showed recommendations and the user picks one ("I'll take the Lekki one", "book the first one", "the 2-bedroom in Wuse", "yes that one"). Map their reference back to the exact property in AVAILABLE PROPERTIES.
- The user gives you all four pieces of info in any single message ("book the Maitama 2-bed Apr 5 to Apr 8 for 2 people"). Don't ask follow-ups when nothing is missing.
- The user already gave dates + guests earlier and now confirms a property.

Do NOT emit confirm_booking when:
- The chosen property's booked_ranges overlap the requested dates (it's unavailable — offer alternatives).
- You're still missing one of the four required fields.
- The user is browsing or comparing, not committing.

After emitting confirm_booking, the user will see a Submit button that sends the booking request to admin for approval — they tap once and you're done with this step.

{
  "action": "confirm_booking",
  "booking": {
    "property_id": "...",
    "property_title": "...",
    "property_location": { "city": "...", "country": "..." },
    "check_in": "YYYY-MM-DD",
    "check_out": "YYYY-MM-DD",
    "guests": 2,
    "nights": 3,
    "price_per_night": 50000,
    "total_price": 150000,
    "special_requests": ""
  },
  "response": "One-sentence confirmation prompt."
}

**show_bookings** — when user asks about their existing bookings:
{ "action": "show_bookings", "response": "Here are your bookings:" }

**initiate_booking** — only if the user wants the structured form instead of chatting:
{
  "action": "initiate_booking",
  "parameters": { "location": "city_or_null", "guests": "number_or_null" },
  "response": "I'd be happy to help — fill out the form below."
}

**escalate_to_human** — when you genuinely can't help or user asks for a human:
{
  "action": "escalate_to_human",
  "reason": "short reason — e.g. 'refund dispute', 'legal question', 'user requested human'",
  "summary": "2–3 line summary of the conversation so admin has context",
  "response": "I want to make sure you're properly assisted. Let me connect you with our UrbanStays team."
}

**Plain text** — for chit-chat, greetings, FAQ-style answers, or mid-qualification questions. Just text, no JSON.

## 🌟 REMEMBER
- ONE qualification question per turn — never dump all 7 at once.
- Mirror the user's language (English/Pidgin/Mixed).
- Never recommend a property not in the AVAILABLE PROPERTIES list.
- Capture the lead BEFORE showing properties when the user is anon. For signed-in users, still emit capture_lead so admin gets the alert.
- Always end with the sales close after capture_lead.
- JSON actions must be strict valid JSON (double quotes, no trailing commas).
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
        } else if (parsedResult.action === 'confirm_booking') {
          assistantMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            type: 'booking_confirm',
            content: parsedResult.response,
            booking: parsedResult.booking,
          };
          await saveMessageToHistory(parsedResult.response, 'assistant', 'booking_confirm', parsedResult.booking);
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
        } else if (parsedResult.action === 'capture_lead') {
          // Nova has gathered qualification + contact info. Persist a Lead and
          // fire admin Telegram alert. Confirmed-email loop happens later in
          // the booking confirm flow — at this stage we trust what Nova captured.
          const leadInput = parsedResult.lead || {};
          let leadId = null;
          try {
            const lead = await base44.entities.Lead.create({
              name: leadInput.name,
              phone: leadInput.phone,
              email: leadInput.email,
              city: leadInput.city,
              area: leadInput.area,
              check_in: leadInput.check_in,
              check_out: leadInput.check_out,
              guests: Number(leadInput.guests) || undefined,
              budget_min: Number(leadInput.budget_min) || undefined,
              budget_max: Number(leadInput.budget_max) || undefined,
              apartment_type: leadInput.apartment_type,
              special_requests: leadInput.special_requests || '',
              status: 'qualified',
              user_email: user?.email || undefined,
              source: 'chat',
              session_id: sessionId || undefined,
            });
            leadId = lead.id;
            setLastLead(lead);
            try {
              await base44.functions.invoke('notifyLead', { lead_id: lead.id });
            } catch (notifyErr) {
              console.warn('notifyLead failed (non-fatal):', notifyErr);
            }
          } catch (createErr) {
            console.error('Failed to create Lead:', createErr);
          }
          assistantMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: parsedResult.response || "Got it — passed your details to our team. Want me to show you available apartments now?",
            type: 'lead_captured',
            leadId,
          };
          await saveMessageToHistory(assistantMessage.content, 'assistant', 'lead_captured', { lead_id: leadId });
        } else if (parsedResult.action === 'escalate_to_human') {
          // Hand-off path. For signed-in users we open a SupportTicket so admin
          // can pick it up; for anon we still create a Lead row tagged as escalation
          // so sales has the contact + context. Full support flow is task #6.
          try {
            if (user?.email) {
              await base44.entities.SupportTicket.create({
                user_email: user.email,
                subject: `Escalation from Agent Nova chat — ${parsedResult.reason || 'user requested human'}`,
                category: 'general',
                priority: 'high',
                description: parsedResult.summary || conversationContext.slice(-2000),
                ai_handled: false,
              });
            }
          } catch (ticketErr) {
            console.warn('SupportTicket create failed (non-fatal):', ticketErr);
          }
          assistantMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: parsedResult.response || "I want to make sure you're properly assisted. Let me connect you with our UrbanStays team.",
            type: 'escalated',
          };
          await saveMessageToHistory(assistantMessage.content, 'assistant', 'escalated', { reason: parsedResult.reason });
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

  const handleSend = async (overrideText) => {
    // overrideText lets programmatic callers (e.g., URL ?prompt= auto-send)
    // bypass the input state which may not have updated yet on the same tick.
    const text = (typeof overrideText === 'string' && overrideText) ? overrideText : input;
    if (!text.trim() || isLoading) return;
    if (showBookingAssistant) setShowBookingAssistant(false);

    const userMessage = { id: Date.now(), role: 'user', content: text };
    setMessages(prev => [...prev, userMessage]);

    await saveMessageToHistory(text, 'user');

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
      console.log('🤖 Agent Nova: Fetching properties via smart search...');
      
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
          
          console.log(`🤖 Agent Nova: Using ${mappedPropertiesForAI.length} properties (DB + MCP)`);
          console.log(`📊 Sources: ${[...new Set(mappedPropertiesForAI.map(p => p.source))].join(', ')}`);

          const enriched = await enrichWithBookedRanges(mappedPropertiesForAI);
          await continueWithAI(enriched, conversationContext, userMessage);
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

        const enriched = await enrichWithBookedRanges(propertiesForAI);
        await continueWithAI(enriched, conversationContext, userMessage);
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
                <h1 className="text-lg font-semibold text-slate-900">Agent Nova</h1>
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
                    ) : message.type === 'booking_cta' ? (
                      <div className="space-y-3">
                        <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
                          <ReactMarkdown>{message.content || ''}</ReactMarkdown>
                          <div className="flex flex-wrap gap-2 mt-3">
                            {message.cta === 'pay' && message.booking?.id && (
                              <Button
                                onClick={() => navigate(
                                  `${createPageUrl('PaymentPage')}?${new URLSearchParams({
                                    booking_id: message.booking.id,
                                    total: String(message.booking.total_price || 0),
                                    property_title: message.booking.property_title || '',
                                    guest_email: message.booking.guest_email || '',
                                  }).toString()}`
                                )}
                                size="sm"
                                className="rounded-xl bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white"
                              >
                                Pay Now
                              </Button>
                            )}
                            {message.booking?.property_id && (
                              <Button
                                onClick={() => navigate(createPageUrl(`Property?id=${message.booking.property_id}`))}
                                size="sm"
                                variant="outline"
                                className="rounded-xl"
                              >
                                View Property
                              </Button>
                            )}
                            <Button
                              onClick={() => navigate(createPageUrl('Bookings'))}
                              size="sm"
                              variant="ghost"
                              className="rounded-xl text-slate-600"
                            >
                              All Bookings
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : message.type === 'booking_confirm' ? (
                      <div className="space-y-3">
                        {message.content && (
                          <div className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
                            <p className="text-sm text-slate-800">{message.content}</p>
                          </div>
                        )}
                        <BookingConfirmCard
                          booking={message.booking}
                          isAuthenticated={!!user}
                          lead={lastLead}
                          onAuthenticated={async () => {
                            try {
                              const me = await base44.auth.me();
                              setUser(me);
                            } catch { /* noop */ }
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
                          <RecommendationCard
                            key={recIndex}
                            recommendation={rec}
                            onCheckAvailability={(picked) => {
                              // Build a clear follow-up so Nova has everything it needs
                              // to emit confirm_booking on the next turn. Pulls dates +
                              // guests from the captured lead when present; otherwise
                              // Nova will ask for whatever's missing.
                              const parts = [`I'd like to book ${picked.property_title}`];
                              if (lastLead?.check_in && lastLead?.check_out) {
                                parts.push(`from ${lastLead.check_in} to ${lastLead.check_out}`);
                              }
                              if (lastLead?.guests) {
                                parts.push(`for ${lastLead.guests} guest${Number(lastLead.guests) === 1 ? '' : 's'}`);
                              }
                              parts.push(`(property_id: ${picked.property_id})`);
                              handleSend(parts.join(' ') + '.');
                            }}
                          />
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
          {/* Live interim transcript shown while the user is speaking */}
          {isListening && transcript && (
            <div className="mb-2 px-3 py-1.5 bg-slate-100 rounded-md text-xs text-slate-700 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="italic">{transcript}</span>
            </div>
          )}
          <div className="flex gap-2 items-center">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={isListening ? 'Listening… speak now' : 'Message Agent Nova...'}
              className="flex-1 py-2.5 px-3.5 rounded-lg border-slate-300 focus:border-slate-500 focus:ring-slate-500/30 resize-none text-sm"
              disabled={isLoading}
            />
            {speechSupported && (
              <Button
                type="button"
                onClick={toggleMic}
                disabled={isLoading}
                title={isListening ? 'Stop listening' : 'Speak to dictate'}
                className={`p-2.5 rounded-lg shadow-sm transition-all duration-200 ${
                  isListening
                    ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
              >
                {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </Button>
            )}
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