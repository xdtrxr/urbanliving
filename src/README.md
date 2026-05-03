# Luxeliving 🏡

A luxury short-stay property booking platform built for the Nigerian market, featuring AI-powered concierge services, Telegram-based admin management, and a loyalty rewards system.

---

## Features

### For Guests
- **Property Discovery** — Browse and search luxury properties with filters for location, price, type, and amenities
- **AI Concierge (Agent Luxe)** — Chat with an AI assistant for personalised property recommendations and booking help
- **Availability Requests** — Submit booking requests that are reviewed and approved/rejected by admin via Telegram
- **Paystack Payments** — Secure Nigerian payment processing for confirmed bookings
- **Loyalty Rewards** — Earn Luxe Points (5% of booking value) on every confirmed stay
- **NFT Collectibles** — Earn digital collectibles tied to booking milestones
- **Referral Programme** — Share a unique referral link and earn ₦ when friends complete their first booking
- **Trip Planner** — AI-generated itineraries linked to confirmed bookings
- **Wishlist** — Save favourite properties for later
- **Support Chat** — AI-powered customer support with ticket tracking

### For Admins
- **Telegram Bot** — Receive real-time booking approval requests with property photos and guest details; approve or reject with one tap
- **Admin Panel** — Manage property listings, view bookings, and oversee platform operations
- **Google Sheets Logging** — Automatically log confirmed bookings to a connected spreadsheet

---

## Tech Stack

- **Frontend:** React 18, Tailwind CSS, Framer Motion, Recharts
- **Backend:** Base44 (BaaS) — entities, backend functions (Deno), automations
- **Payments:** Paystack
- **Notifications:** Telegram Bot API
- **AI:** Base44 InvokeLLM integration (GPT-4o-mini)
- **Maps:** React Leaflet
- **Logging:** Google Sheets API

---

## Project Structure

```
src/
├── pages/             # Page-level components (Search, Checkout, Bookings, Dashboard, etc.)
├── components/        # Reusable UI components (search, dashboard, chat, profile, utils)
├── functions/         # Deno backend functions (Telegram webhook, Paystack, Google Sheets, etc.)
├── entities/          # Base44 entity schemas (Property, Booking, AvailabilityRequest, etc.)
├── agents/            # AI agent configurations (Agent Luxe)
├── api/               # Base44 SDK client setup
└── lib/               # Auth context, utilities, routing helpers
```

---

## Entities

| Entity | Description |
|---|---|
| `Property` | Luxury property listings with images, amenities, and pricing |
| `Booking` | Guest reservations with status and payment tracking |
| `AvailabilityRequest` | Admin approval requests linked to booking attempts |
| `LoyaltyTransaction` | Points earned per booking, review, referral, or milestone |
| `Referral` | Tracks referrer/referred relationships and earnings |
| `Trip` | AI-generated itinerary plans linked to bookings |
| `ItineraryItem` | Individual activities/events within a trip |
| `ChatHistory` | AI concierge conversation history per user |
| `Quest` | Gamified tasks users can complete for bonus points |
| `SupportTicket` | Customer support tickets |
| `SupportMessage` | Messages within a support ticket thread |
| `UserBankAccount` | Nigerian bank accounts for referral withdrawals |
| `WithdrawalRequest` | Referral earnings withdrawal requests |

---

## Backend Functions

| Function | Description |
|---|---|
| `sendTelegramNotification` | Sends availability request to admin Telegram with Approve/Reject buttons |
| `telegramWebhook` | Handles Telegram callback queries (approve/reject actions) |
| `checkAvailabilityWebhook` | Processes availability checks |
| `logBookingToGoogleSheet` | Logs confirmed bookings to Google Sheets |
| `aiCustomerService` | AI-powered support ticket response generation |
| `generatePropertyData` | AI-assisted property data generation for admins |
| `fetchBookingProperties` | Fetches property details for multiple bookings |
| `getNigerianBanks` | Lists Nigerian banks via Paystack API |
| `resolveBankAccount` | Verifies bank account details via Paystack |
| `createWithdrawalRequest` | Creates a Paystack transfer for referral withdrawals |
| `processWithdrawal` | Processes pending withdrawal requests |
| `getReferralStatistics` | Calculates referral earnings and statistics |

---

## Setup

### Environment Variables (Secrets)

Set these in your Base44 dashboard under **Settings → Secrets**:

| Secret | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ADMIN_CHAT_ID` | Telegram chat ID of the admin who receives booking notifications |
| `PAYSTACK_SECRET_KEY` | Paystack secret key for payment processing |
| `PAYSTACK_PUBLIC_KEY` | Paystack public key for frontend payment initialisation |
| `GOOGLE_SHEET_ID` | ID of the Google Sheet used for booking logs |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | Google service account credentials (JSON) |
| `BASE44_SERVICE_ROLE_KEY` | Base44 service role key for admin-level entity operations |

### Telegram Webhook

After deploying, register your `telegramWebhook` function URL with Telegram:

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_FUNCTION_URL>
```

You can find the function URL in **Base44 Dashboard → Code → Functions → telegramWebhook**.

---

## Booking Flow

1. Guest selects a property and picks dates on the **Checkout** page
2. Guest clicks **Check Availability** — an `AvailabilityRequest` and a pending `Booking` are created
3. Admin receives a Telegram notification with property details and Approve/Reject buttons
4. Admin taps **Approve** or **Reject** in Telegram
5. The `AvailabilityRequest` status updates in the database
6. The Checkout page polls every 3 seconds and reflects the admin decision
7. If approved, the guest can complete payment via Paystack
8. On payment, loyalty points are awarded and the booking is marked `confirmed`

---

## Loyalty & Rewards

- **Points:** 5% of booking total price = Luxe Points earned
- **Tiers:** Bronze → Silver (1,000 pts) → Gold (2,500 pts) → Platinum (5,000 pts) → Diamond (10,000 pts)
- **NFTs:** Digital collectibles awarded at booking milestones
- **Quests:** Complete social tasks (follow, engage) for bonus points
- **Referrals:** Earn 5% of referred user's first booking value as ₦ balance (withdrawable)

---

## License

Private. All rights reserved.