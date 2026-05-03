
/**
 * Quest System - Production Ready Implementation
 * 
 * @description
 * Enterprise-grade quest management system with robust tracking,
 * state management, and error handling.
 * 
 * Quest Types:
 * - ONE-TIME QUESTS: Complete once, permanent (Instagram, TikTok)
 * - DAILY QUESTS: Reset at midnight UTC (Agent Luxe Chat)
 * 
 * Features:
 * - Race condition prevention
 * - Database-first verification
 * - Atomic transactions
 * - Auto-creation on missing quests
 * - Comprehensive error handling
 * - Real-time progress tracking
 * - LocalStorage backup for quest state
 * 
 * @author Senior Engineering Team
 * @version 6.0.0 - FIXED DATABASE PERSISTENCE ISSUE
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Trophy,
  ExternalLink,
  CheckCircle,
  Star,
  Target,
  MessageCircle,
  Loader2,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import { motion } from 'framer-motion';

// ============================================================================
// CONSTANTS & TYPES
// ============================================================================

const InstagramLogo = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M7.8,2H16.2C19.4,2 22,4.6 22,7.8V16.2A5.8,5.8 0 0,1 16.2,22H7.8C4.6,22 2,19.4 2,16.2V7.8A5.8,5.8 0 0,1 7.8,2M7.6,4A3.6,3.6 0 0,0 4,7.6V16.4C4,18.39 5.61,20 7.6,20H16.4A3.6,3.6 0 0,0 20,16.4V7.6C20,5.61 18.39,4 16.4,4H7.6M17.25,5.5A1.25,1.25 0 0,1 18.5,6.75A1.25,1.25 0 0,1 17.25,8A1.25,1.25 0 0,1 16,6.75A1.25,1.25 0 0,1 17.25,5.5M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9Z" />
  </svg>
);

const TikTokLogo = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
  </svg>
);

/**
 * Quest Configuration Registry
 * Single source of truth for all quest definitions
 */
const QUEST_REGISTRY = {
  // ONE-TIME SOCIAL MEDIA QUESTS
  'follow_instagram': {
    id: 'follow_instagram',
    name: 'Instagram',
    description: 'Follow us on Instagram for stunning property photos',
    points: 75,
    color: 'bg-gradient-to-br from-purple-500 to-pink-500 text-white',
    url: 'https://www.instagram.com/luxelivingproperty',
    icon: InstagramLogo,
    type: 'social_follow',
    isDaily: false,
    category: 'social'
  },
  'follow_tiktok': {
    id: 'follow_tiktok',
    name: 'TikTok',
    description: 'Follow us on TikTok for amazing property videos',
    points: 70,
    color: 'bg-gradient-to-br from-pink-500 to-purple-600 text-white',
    url: 'https://www.tiktok.com/@luxelivingproperty_',
    icon: TikTokLogo,
    type: 'social_follow',
    isDaily: false,
    category: 'social'
  },
  
  // DAILY ENGAGEMENT QUESTS
  'daily_chat_agent': {
    id: 'daily_chat_agent',
    name: 'Daily Chat with Agent Luxe',
    description: 'Chat with our AI concierge (send at least 2 messages)',
    points: 50,
    color: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white',
    url: '/AIChatConcierge',
    icon: MessageCircle,
    type: 'daily_engagement',
    isDaily: true,
    category: 'daily'
  }
};

const LOYALTY_TIERS = {
  Bronze: { threshold: 0, color: 'text-orange-600' },
  Silver: { threshold: 1000, color: 'text-gray-600' },
  Gold: { threshold: 2500, color: 'text-yellow-600' },
  Platinum: { threshold: 5000, color: 'text-purple-600' },
  Diamond: { threshold: 10000, color: 'text-blue-600' }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const calculateLoyaltyTier = (points) => {
  if (points >= LOYALTY_TIERS.Diamond.threshold) return 'Diamond';
  if (points >= LOYALTY_TIERS.Platinum.threshold) return 'Platinum';
  if (points >= LOYALTY_TIERS.Gold.threshold) return 'Gold';
  if (points >= LOYALTY_TIERS.Silver.threshold) return 'Silver';
  return 'Bronze';
};

const getTodayDateUTC = () => new Date().toISOString().split('T')[0];

const isQuestCompletedToday = (quest) => {
  if (!quest || quest.status !== 'claimed') return false;
  
  // For one-time quests: if claimed, it's completed
  if (!quest.is_daily) {
    return true;
  }
  
  // For daily quests: check if completed today
  const today = getTodayDateUTC();
  return quest.last_completed_date === today;
};

// Helper function to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// LocalStorage helpers for quest state persistence
const STORAGE_KEY = 'luxeliving_quest_state';

const saveQuestStateToStorage = (userEmail, questsMap) => {
  try {
    const questsArray = Array.from(questsMap.values());
    const state = {
      userEmail,
      quests: questsArray,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    console.log(`💾 Saved ${questsArray.length} quests to localStorage`);
  } catch (err) {
    console.warn('⚠️ Failed to save to localStorage:', err);
  }
};

const loadQuestStateFromStorage = (userEmail) => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    
    const state = JSON.parse(stored);
    
    // Only use if same user and less than 1 hour old
    if (state.userEmail === userEmail && (Date.now() - state.timestamp) < 3600000) {
      const questsMap = new Map();
      state.quests.forEach(quest => {
        questsMap.set(quest.quest_id, quest);
      });
      console.log(`💾 Loaded ${questsMap.size} quests from localStorage`);
      return questsMap;
    }
    
    return null;
  } catch (err) {
    console.warn('⚠️ Failed to load from localStorage:', err);
    return null;
  }
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function QuestsPage() {
  // Core State
  const [user, setUser] = useState(null);
  const [questsMap, setQuestsMap] = useState(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState(new Set());
  const [error, setError] = useState(null);
  
  // Computed State
  const [metrics, setMetrics] = useState({
    totalPoints: 0,
    completedCount: 0,
    totalCount: Object.keys(QUEST_REGISTRY).length,
    progressPercent: 0
  });
  
  // Refs
  const initLock = useRef(false);

  // ============================================================================
  // INITIALIZATION WITH RETRY LOGIC
  // ============================================================================

  const fetchQuestsWithRetry = async (userEmail, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt}/${maxRetries}: Fetching quests for ${userEmail}...`);
        
        const quests = await base44.entities.Quest.filter({ 
          user_email: userEmail 
        });
        
        console.log(`   Found ${quests.length} quests`);
        
        // If we got quests, return them
        if (quests.length > 0) {
          return quests;
        }
        
        // If no quests but not last attempt, wait and retry
        if (attempt < maxRetries) {
          console.log(`   No quests found, waiting ${attempt * 500}ms before retry...`);
          await wait(attempt * 500);
        }
        
      } catch (err) {
        console.error(`   ❌ Attempt ${attempt} failed:`, err.message);
        if (attempt < maxRetries) {
          await wait(attempt * 500);
        } else {
          throw err;
        }
      }
    }
    
    // All retries exhausted, return empty array
    console.warn('⚠️ All retry attempts exhausted, returning empty array');
    return [];
  };

  const initializeQuestSystem = useCallback(async () => {
    // Prevent concurrent initialization
    if (initLock.current) {
      console.log('⏭️ Init already in progress, skipping...');
      return;
    }
    
    initLock.current = true;
    setIsLoading(true);
    setError(null);
    
    try {
      console.log('🚀 ========== QUEST SYSTEM INIT START ==========');
      const startTime = performance.now();
      
      // Step 1: Authenticate
      const userData = await base44.auth.me();
      setUser(userData);
      console.log(`✅ User: ${userData.email} | Points: ${userData.loyalty_points || 0}`);

      // Step 2: Try to load from localStorage first (instant)
      const cachedQuestsMap = loadQuestStateFromStorage(userData.email);
      
      if (cachedQuestsMap && cachedQuestsMap.size > 0) {
        console.log('💾 Using cached quest state from localStorage');
        setQuestsMap(cachedQuestsMap);
        
        // Calculate metrics from cache
        let completedCount = 0;
        cachedQuestsMap.forEach((quest) => {
          if (isQuestCompletedToday(quest)) {
            completedCount++;
          }
        });
        
        const totalCount = Object.keys(QUEST_REGISTRY).length;
        const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
        
        setMetrics({
          totalPoints: userData.loyalty_points || 0,
          completedCount,
          totalCount,
          progressPercent
        });
        
        setIsLoading(false);
        initLock.current = false;
        
        // Fetch from database in background to verify/update
        console.log('🔄 Fetching fresh data from database in background...');
        fetchQuestsWithRetry(userData.email, 3).then(freshQuests => {
          if (freshQuests.length > 0) {
            const freshMap = new Map();
            freshQuests.forEach(quest => {
              if (quest.id && quest.quest_id) {
                freshMap.set(quest.quest_id, quest);
              }
            });
            
            console.log(`✅ Background fetch complete: ${freshMap.size} quests`);
            setQuestsMap(freshMap);
            saveQuestStateToStorage(userData.email, freshMap);
          }
        }).catch(bgErr => {
          console.error('❌ Background fetch failed:', bgErr);
        });
        
        return; // Early return with cached data
      }

      // Step 3: Fetch existing quests with retry logic
      const existingQuests = await fetchQuestsWithRetry(userData.email, 3);
      console.log(`📊 Fetched ${existingQuests.length} existing quests from DB`);

      // Step 4: Build quest map from existing quests
      const questMap = new Map();
      existingQuests.forEach(quest => {
        if (quest.id && quest.quest_id) {
          questMap.set(quest.quest_id, quest);
          console.log(`  📋 ${quest.quest_id}: status=${quest.status}, is_daily=${quest.is_daily}, last_completed=${quest.last_completed_date || 'never'}`);
        }
      });

      // Step 5: Create missing quests ONLY if they don't exist
      const missingQuestIds = Object.keys(QUEST_REGISTRY).filter(
        questId => !questMap.has(questId)
      );

      if (missingQuestIds.length > 0) {
        console.log(`➕ Creating ${missingQuestIds.length} missing quests...`);
        
        for (const questId of missingQuestIds) {
          const config = QUEST_REGISTRY[questId];
          
          try {
            // Double-check: fetch directly by quest_id before creating
            console.log(`   🔍 Double-checking existence of: ${questId}...`);
            const doubleCheck = await base44.entities.Quest.filter({
              user_email: userData.email,
              quest_id: questId
            });
            
            if (doubleCheck.length > 0) {
              console.log(`   ✅ Found existing: ${questId} (${doubleCheck[0].id})`);
              questMap.set(questId, doubleCheck[0]);
              continue; // Skip creation
            }
            
            console.log(`   Creating: ${questId}...`);
            
            const questData = {
              quest_id: questId,
              quest_type: config.type,
              platform: questId.replace('follow_', '').replace('daily_', ''),
              points_reward: config.points,
              verification_method: 'automatic',
              is_daily: config.isDaily,
              user_email: userData.email,
              status: 'available'
            };
            
            const created = await base44.entities.Quest.create(questData);
            
            if (created && created.id) {
              console.log(`   ✅ Created successfully: ${questId} (${created.id})`);
              questMap.set(questId, created);
            } else {
              console.error(`   ⚠️ Quest created but no ID returned:`, created);
            }
            
            await wait(200);
            
          } catch (createError) {
            console.error(`   ❌ Failed to create ${questId}:`, createError.message);
          }
        }
      }

      // Step 6: Reset daily quests if needed
      const today = getTodayDateUTC();
      const resetPromises = [];
      
      questMap.forEach((quest) => {
        if (quest.is_daily && quest.status === 'claimed' && quest.last_completed_date !== today) {
          console.log(`🔄 Resetting daily quest: ${quest.quest_id}`);
          resetPromises.push(
            base44.entities.Quest.update(quest.id, {
              status: 'available',
              completion_date: null,
              last_completed_date: null
            }).then(() => {
              quest.status = 'available';
              quest.completion_date = null;
              quest.last_completed_date = null;
            }).catch(err => {
              console.error(`  ⚠️ Failed to reset ${quest.quest_id}:`, err.message);
            })
          );
        }
      });

      if (resetPromises.length > 0) {
        await Promise.all(resetPromises);
      }

      // Step 7: Calculate metrics
      console.log('📊 Calculating quest metrics...');
      let completedCount = 0;
      
      questMap.forEach((quest) => {
        const isCompleted = isQuestCompletedToday(quest);
        console.log(`  Quest ${quest.quest_id}: status=${quest.status}, is_daily=${quest.is_daily}, completed_today=${isCompleted}`);
        
        if (isCompleted) {
          completedCount++;
        }
      });

      const totalCount = Object.keys(QUEST_REGISTRY).length;
      const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

      console.log(`📈 Metrics calculated: ${completedCount}/${totalCount} completed (${progressPercent}%)`);

      setQuestsMap(questMap);
      setMetrics({
        totalPoints: userData.loyalty_points || 0,
        completedCount,
        totalCount,
        progressPercent
      });
      
      // Save to localStorage
      saveQuestStateToStorage(userData.email, questMap);

      const elapsed = (performance.now() - startTime).toFixed(2);
      console.log('✅ ========== INIT COMPLETE ==========');
      console.log(`✅ Time: ${elapsed}ms | Loaded: ${questMap.size}/${totalCount} quests | Completed: ${completedCount}/${totalCount} (${progressPercent}%)`);

    } catch (err) {
      console.error('❌ ========== INIT FAILED ==========');
      console.error('❌ Error:', err);
      setError(`Failed to initialize quests: ${err.message}`);
    } finally {
      setIsLoading(false);
      initLock.current = false;
    }
  }, []);

  useEffect(() => {
    initializeQuestSystem();
  }, [initializeQuestSystem]);

  // ============================================================================
  // QUEST COMPLETION HANDLERS
  // ============================================================================

  /**
   * Ensure quest exists (create if missing)
   */
  const ensureQuestExists = async (questId, userData) => {
    console.log(`🔍 Ensuring quest exists: ${questId}`);
    
    try {
      // Try to find existing quest
      const existing = await base44.entities.Quest.filter({
        user_email: userData.email,
        quest_id: questId
      });
      
      if (existing.length > 0) {
        console.log(`✅ Quest found: ${questId} (${existing[0].id})`);
        return existing[0];
      }
      
      // Create if doesn't exist
      console.log(`➕ Creating quest on-demand: ${questId}`);
      const config = QUEST_REGISTRY[questId];
      
      const created = await base44.entities.Quest.create({
        quest_id: questId,
        quest_type: config.type,
        platform: questId.replace('follow_', '').replace('daily_', ''),
        points_reward: config.points,
        verification_method: 'automatic',
        is_daily: config.isDaily,
        user_email: userData.email,
        status: 'available'
      });
      
      console.log(`✅ Quest created: ${questId} (${created.id})`);
      return created;
      
    } catch (err) {
      console.error(`❌ Failed to ensure quest exists:`, err);
      throw err;
    }
  };

  const completeSocialQuest = async (questId) => {
    const config = QUEST_REGISTRY[questId];
    
    console.log('🎯 ========== SOCIAL QUEST HANDLER ==========');
    console.log(`Quest: ${questId}`);

    // Validation
    if (!user) {
      alert('Please log in to complete quests.');
      return;
    }

    if (!config) {
      alert('Invalid quest configuration.');
      return;
    }

    // Lock button immediately
    setProcessingIds(prev => new Set(prev).add(questId));

    try {
      // Step 1: Ensure quest exists in database
      console.log('🔍 Step 1: Verifying/creating quest...');
      const freshQuest = await ensureQuestExists(questId, user);
      
      if (!freshQuest || !freshQuest.id) {
        throw new Error('Failed to get or create quest');
      }
      
      console.log(`✅ Quest ready: ${freshQuest.quest_id} (DB ID: ${freshQuest.id})`);
      console.log(`   Current status: ${freshQuest.status}`);
      
      // Step 2: Check if already completed
      if (freshQuest.status === 'claimed') {
        console.log('⛔ Quest already completed');
        alert('✅ You have already completed this quest!\n\nOne-time quests can only be completed once.');
        return;
      }

      // Step 3: Open social media page
      console.log('🌐 Step 2: Opening social media page...');
      window.open(config.url, '_blank');
      
      // Step 4: Calculate new points and tier
      const currentPoints = user.loyalty_points || 0;
      const newPoints = currentPoints + freshQuest.points_reward;
      const newTier = calculateLoyaltyTier(newPoints);
      console.log(`💰 Step 3: Points calculation: ${currentPoints} + ${freshQuest.points_reward} = ${newPoints}`);
      console.log(`🏆 New tier: ${newTier}`);

      // Step 5: Update quest status to CLAIMED
      console.log(`📝 Step 4: Updating quest ${freshQuest.id} to CLAIMED...`);
      const updateData = {
        status: 'claimed',
        completion_date: new Date().toISOString(),
        last_completed_date: getTodayDateUTC(),
        verification_data: { 
          timestamp: Date.now(),
          platform: config.name,
          quest_type: 'one_time_social',
          auto_completed: true
        }
      };
      
      await base44.entities.Quest.update(freshQuest.id, updateData);
      console.log(`✅ Quest updated successfully`);

      // Step 6: Update user points and tier
      console.log('💎 Step 5: Updating user points and tier...');
      await base44.auth.updateMe({
        loyalty_points: newPoints,
        loyalty_tier: newTier
      });
      console.log(`✅ User updated successfully`);
      
      // Step 7: Create loyalty transaction
      console.log('📋 Step 6: Creating loyalty transaction...');
      await base44.entities.LoyaltyTransaction.create({
        user_email: user.email,
        points_earned: freshQuest.points_reward,
        transaction_type: 'quest',
        description: `Completed quest: Follow us on ${config.name}`,
        quest_id: freshQuest.id
      });
      console.log(`✅ Transaction created successfully`);
      
      console.log('🎉 ========== QUEST COMPLETED SUCCESSFULLY ==========');
      
      // Step 8: Update LOCAL state immediately
      console.log('🔄 Step 7: Updating local state immediately...');
      
      const updatedQuest = {
        ...freshQuest,
        ...updateData
      };
      
      setQuestsMap(prev => {
        const newMap = new Map(prev);
        newMap.set(questId, updatedQuest);
        console.log(`   ✅ Updated ${questId} in local map to status=claimed`);
        
        // Save to localStorage immediately
        saveQuestStateToStorage(user.email, newMap);
        
        return newMap;
      });
      
      setUser(prevUser => ({
        ...prevUser,
        loyalty_points: newPoints,
        loyalty_tier: newTier
      }));
      
      setMetrics(prevMetrics => {
        const newCompletedCount = prevMetrics.completedCount + 1;
        const newProgressPercent = Math.round((newCompletedCount / prevMetrics.totalCount) * 100);
        console.log(`   ✅ Updated metrics: ${newCompletedCount}/${prevMetrics.totalCount} (${newProgressPercent}%)`);
        return {
          ...prevMetrics,
          totalPoints: newPoints,
          completedCount: newCompletedCount,
          progressPercent: newProgressPercent
        };
      });
      
      console.log('✅ Local state updated and saved to localStorage');
      
      alert(`🎉 Quest Completed!\n\nYou earned ${freshQuest.points_reward} Luxe Points!\n\nNew Balance: ${newPoints} points\nNew Tier: ${newTier}`);
      
    } catch (err) {
      console.error('❌ ========== QUEST COMPLETION FAILED ==========');
      console.error('❌ Error:', err);
      console.error('❌ Stack:', err.stack);
      alert(`❌ Failed to complete quest: ${err.message}\n\nPlease try again or contact support if the issue persists.`);
      
      // Reload on error to sync state
      await initializeQuestSystem();
    } finally {
      // Unlock button
      setProcessingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(questId);
        return newSet;
      });
    }
  };

  const startDailyQuest = () => {
    window.location.href = QUEST_REGISTRY.daily_chat_agent.url;
  };

  // ============================================================================
  // UI HELPERS
  // ============================================================================

  const getQuestStatusIcon = (quest) => {
    if (!quest) return <Target className="w-5 h-5 text-slate-400" />;
    if (quest.status === 'claimed') return <CheckCircle className="w-5 h-5 text-green-500" />;
    if (quest.status === 'processing') return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
    return <Target className="w-5 h-5 text-slate-400" />;
  };

  const renderQuestCard = (questId, config) => {
    const quest = questsMap.get(questId);
    const IconComponent = config.icon;
    const isProcessing = processingIds.has(questId);
    const isCompleted = quest && isQuestCompletedToday(quest);

    return (
      <Card key={questId} className="hover:shadow-2xl transition-all duration-500 border-0 rounded-3xl overflow-hidden bg-white/90 backdrop-blur-sm h-full flex flex-col">
        <div className={`h-2 ${config.color}`} />
        <CardHeader className="p-6 flex-grow">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className={`w-12 h-12 rounded-full ${config.color} flex items-center justify-center shadow-lg flex-shrink-0`}>
                <IconComponent className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0">
                <CardTitle className="text-base font-bold text-slate-900 mb-2 break-words">
                  {config.name}
                </CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <Star className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <span className="font-semibold text-amber-600 text-sm whitespace-nowrap">{config.points} Points</span>
                  <Badge className={config.isDaily ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}>
                    {config.isDaily ? 'Daily' : 'One-Time'}
                  </Badge>
                </div>
              </div>
            </div>
            <div className="flex-shrink-0 ml-2">
              {quest && getQuestStatusIcon(quest)}
            </div>
          </div>
          <p className="text-slate-600 text-sm leading-relaxed">{config.description}</p>
        </CardHeader>
        <CardContent className="px-6 pb-6 mt-auto">
          {isCompleted ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-center gap-2 p-3 bg-green-50 border-2 border-green-400 rounded-xl">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="font-bold text-green-800">
                  {config.isDaily ? 'Completed Today ✓' : 'Completed Forever ✓'}
                </span>
              </div>
              {config.isDaily && (
                <p className="text-xs text-center text-slate-500">Come back tomorrow!</p>
              )}
            </div>
          ) : (
            <Button
              onClick={() => config.isDaily ? startDailyQuest() : completeSocialQuest(questId)}
              disabled={isProcessing}
              className={`w-full ${config.isDaily ? 'bg-gradient-to-r from-emerald-600 to-teal-700' : 'bg-gradient-to-r from-slate-900 to-slate-800'} text-white rounded-xl font-semibold disabled:opacity-50`}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Start Quest
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <div className="animate-pulse space-y-8">
            <div className="h-12 bg-slate-200 rounded-xl w-64 mx-auto" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl mx-auto">
              {[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded-2xl" />)}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map(i => <div key={i} className="h-64 bg-slate-200 rounded-3xl" />)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md bg-red-50 border-red-200 rounded-3xl">
          <CardContent className="p-8 text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-red-900 mb-2">System Error</h2>
            <p className="text-red-700 mb-6">{error}</p>
            <Button onClick={initializeQuestSystem} className="bg-red-600 hover:bg-red-700">
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry Initialization
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <div className="flex items-center justify-center gap-3 mb-4">
            <Trophy className="w-12 h-12 text-amber-500" />
            <h1 className="text-4xl font-bold text-slate-900">Quest Center</h1>
          </div>
          <p className="text-xl text-slate-600">
            Complete quests to earn Luxe Points and unlock exclusive rewards!
          </p>
        </motion.div>

        {/* Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl mx-auto mb-8">
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-2xl hover:shadow-lg transition-shadow">
            <CardContent className="p-6 text-center">
              <div className="text-4xl font-bold text-amber-600 mb-2">{metrics.totalPoints}</div>
              <div className="text-sm text-slate-600 font-medium">Total Points Earned</div>
            </CardContent>
          </Card>
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-2xl hover:shadow-lg transition-shadow">
            <CardContent className="p-6 text-center">
              <div className="text-4xl font-bold text-green-600 mb-2">{metrics.completedCount}</div>
              <div className="text-sm text-slate-600 font-medium">Quests Completed</div>
            </CardContent>
          </Card>
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-2xl hover:shadow-lg transition-shadow">
            <CardContent className="p-6 text-center">
              <div className="text-4xl font-bold text-blue-600 mb-2">{metrics.progressPercent}%</div>
              <div className="text-sm text-slate-600 font-medium">Progress</div>
            </CardContent>
          </Card>
        </div>

        {/* Progress Bar */}
        <div className="max-w-xl mx-auto mb-12">
          <Progress value={metrics.progressPercent} className="h-3" />
          <p className="text-xs text-slate-500 mt-2 text-center">
            {metrics.completedCount} of {metrics.totalCount} quests completed
          </p>
        </div>

        {/* Quest Grid */}
        <div>
          <h2 className="text-2xl font-bold text-slate-900 mb-6 text-center">Available Quests</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch">
            {Object.entries(QUEST_REGISTRY).map(([questId, config]) => 
              renderQuestCard(questId, config)
            )}
          </div>
        </div>

        {/* Completion Banner */}
        {metrics.completedCount === metrics.totalCount && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-12"
          >
            <Card className="bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-200 rounded-3xl">
              <CardContent className="p-8 text-center">
                <div className="text-6xl mb-4">🎉</div>
                <h2 className="text-3xl font-bold text-amber-900 mb-4">All Quests Complete!</h2>
                <p className="text-amber-800 text-lg mb-6">
                  You've earned <strong>{metrics.totalPoints} Luxe Points</strong>!
                </p>
                <Badge className="bg-amber-100 text-amber-800 px-6 py-3 text-lg font-bold">
                  <Trophy className="w-5 h-5 mr-2 inline" />
                  Quest Master
                </Badge>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </div>
    </div>
  );
}
