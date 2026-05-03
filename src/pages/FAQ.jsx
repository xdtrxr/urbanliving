
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { HelpCircle } from 'lucide-react';

const faqItems = [
  {
    question: "How do I book a property?",
    answer: "You can book a property by navigating to the 'Discover' page, searching for your desired destination and dates, selecting a property, and clicking the 'Book Now' button. You will be guided through the payment process to confirm your reservation."
  },
  {
    question: "What payment methods do you accept?",
    answer: "We accept all major credit cards, including Visa, Mastercard, and American Express. All payments are processed securely through our payment provider."
  },
  {
    question: "Can I cancel a booking?",
    answer: "Cancellation policies vary depending on the property and are set by the host. You can find the specific cancellation policy for a property on its details page before you book. Confirmed bookings can be managed from the 'My Bookings' page."
  },
  {
    question: "How does the loyalty program work?",
    answer: "Our loyalty program rewards you with 'Luxe Points' for every booking you complete. You can also earn points through referrals and special promotions. These points can be redeemed for discounts on future bookings. Your loyalty status and points are visible on your Dashboard."
  },
  {
    question: "What are NFT Travel Tokens?",
    answer: "NFT Travel Tokens are unique digital collectibles you earn by reaching certain milestones, such as your first booking or visiting a new country. They serve as a memento of your travels and may unlock special perks and benefits in the future."
  },
  {
    question: "Is my personal information secure?",
    answer: "Yes, we take data security very seriously. We use industry-standard encryption and security protocols to protect your personal information. For more details, please refer to our Privacy Policy."
  }
];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
          <CardHeader className="p-4 sm:p-8 border-b border-slate-100">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-gradient-to-br from-slate-900 to-slate-800 rounded-full flex items-center justify-center">
                <HelpCircle className="w-8 h-8 text-white" />
              </div>
              <div>
                <CardTitle className="text-3xl font-bold text-slate-900">Frequently Asked Questions</CardTitle>
                <p className="text-slate-600 mt-1">Find answers to common questions about Luxeliving.</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-8">
            <Accordion type="single" collapsible className="w-full">
              {faqItems.map((item, index) => (
                <AccordionItem key={index} value={`item-${index}`}>
                  <AccordionTrigger className="text-lg font-semibold text-left">{item.question}</AccordionTrigger>
                  <AccordionContent className="text-base text-slate-700">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
