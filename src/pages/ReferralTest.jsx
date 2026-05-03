import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  CheckCircle, XCircle, AlertCircle, Copy, ExternalLink, 
  RefreshCw, Users, Database, Link as LinkIcon 
} from 'lucide-react';

export default function ReferralTestPage() {
  const [user, setUser] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [testResults, setTestResults] = useState([]);

  useEffect(() => {
    loadTestData();
  }, []);

  const loadTestData = async () => {
    setIsLoading(true);
    setTestResults([]);
    
    try {
      // Load current user
      const userData = await base44.auth.me();
      setUser(userData);
      addTestResult('✅ Current user loaded', 'success', userData);

      // Load referrals for this user
      const referralData = await base44.entities.Referral.filter({ 
        referrer_email: userData.email 
      });
      setReferrals(referralData);
      addTestResult(`✅ Found ${referralData.length} referrals`, 'success', referralData);

      // Check localStorage for stored referral code
      const storedCode = localStorage.getItem('luxeliving_referral_code');
      if (storedCode) {
        addTestResult('📋 Stored referral code in localStorage', 'info', { storedCode });
      } else {
        addTestResult('ℹ️ No stored referral code in localStorage', 'info');
      }

      // Check URL for referral code
      const urlParams = new URLSearchParams(window.location.search);
      const urlRefCode = urlParams.get('ref');
      if (urlRefCode) {
        addTestResult('🔗 Referral code found in URL', 'info', { urlRefCode });
      } else {
        addTestResult('ℹ️ No referral code in URL', 'info');
      }

      // Load all users (for admin testing)
      if (userData.role === 'admin') {
        const users = await base44.entities.User.list('-created_date', 20);
        setAllUsers(users);
        addTestResult(`✅ Loaded ${users.length} users (admin only)`, 'success');
      }

    } catch (error) {
      console.error('Error loading test data:', error);
      addTestResult('❌ Error loading data', 'error', error.message);
    }
    
    setIsLoading(false);
  };

  const addTestResult = (message, type, data = null) => {
    setTestResults(prev => [...prev, { message, type, data, timestamp: new Date() }]);
  };

  const copyReferralLink = () => {
    const link = `${window.location.origin}?ref=${user.referral_code}`;
    navigator.clipboard.writeText(link);
    alert('✅ Referral link copied! Share it with a friend to test.');
  };

  const simulateReferralFlow = () => {
    if (!user?.referral_code) {
      alert('❌ You need a referral code first!');
      return;
    }

    const referralLink = `${window.location.origin}?ref=${user.referral_code}`;
    alert(
      `🧪 Simulation Instructions:\n\n` +
      `1. Copy this link:\n${referralLink}\n\n` +
      `2. Open it in an INCOGNITO/PRIVATE window\n\n` +
      `3. Sign up as a new user\n\n` +
      `4. Check the ReferralCodePrompt appears\n\n` +
      `5. Accept the referral code\n\n` +
      `6. Come back here and refresh to see the new referral!`
    );
    copyReferralLink();
  };

  const checkReferralIntegrity = async () => {
    addTestResult('🔍 Starting integrity check...', 'info');
    
    try {
      // Check if user has referral_code
      if (!user.referral_code) {
        addTestResult('⚠️ User missing referral_code!', 'warning');
      } else {
        addTestResult('✅ User has referral_code', 'success', user.referral_code);
      }

      // Check if user was referred
      if (user.referred_by_code) {
        addTestResult('✅ User was referred by', 'success', user.referred_by_code);
        
        // Verify referrer exists
        const referrers = await base44.entities.User.filter({ 
          referral_code: user.referred_by_code 
        });
        
        if (referrers.length > 0) {
          addTestResult('✅ Referrer found in database', 'success', referrers[0].email);
          
          // Check if Referral record exists
          const referralRecords = await base44.entities.Referral.filter({
            referrer_email: referrers[0].email,
            referred_email: user.email
          });
          
          if (referralRecords.length > 0) {
            addTestResult('✅ Referral record exists', 'success', referralRecords[0]);
          } else {
            addTestResult('❌ Missing Referral record!', 'error');
          }
        } else {
          addTestResult('❌ Referrer not found in database!', 'error');
        }
      } else {
        addTestResult('ℹ️ User was not referred by anyone', 'info');
      }

      // Check referrals made by this user
      const myReferrals = await base44.entities.Referral.filter({ 
        referrer_email: user.email 
      });
      
      addTestResult(`📊 This user has referred ${myReferrals.length} users`, 'success');
      
      for (const ref of myReferrals) {
        // Verify referred user exists
        const referredUsers = await base44.entities.User.filter({ 
          email: ref.referred_email 
        });
        
        if (referredUsers.length > 0) {
          const referredUser = referredUsers[0];
          if (referredUser.referred_by_code === user.referral_code) {
            addTestResult(`✅ ${ref.referred_email} - Valid link`, 'success');
          } else {
            addTestResult(`⚠️ ${ref.referred_email} - referred_by_code mismatch!`, 'warning');
          }
        } else {
          addTestResult(`❌ ${ref.referred_email} - User not found!`, 'error');
        }
      }

      addTestResult('✅ Integrity check complete', 'success');
      
    } catch (error) {
      addTestResult('❌ Integrity check failed', 'error', error.message);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">🧪 Referral System Test Dashboard</h1>
          <p className="text-slate-600 text-lg">Debug and verify your referral tracking</p>
        </div>

        {/* Current User Info */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
          <CardHeader>
            <CardTitle>Current User Information</CardTitle>
            <CardDescription>Your account details and referral status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-slate-500">Email</p>
                <p className="font-semibold text-slate-900">{user?.email}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500">Name</p>
                <p className="font-semibold text-slate-900">{user?.full_name}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500">Your Referral Code</p>
                <div className="flex items-center gap-2">
                  <p className="font-mono font-bold text-amber-600">{user?.referral_code || 'Not set'}</p>
                  {user?.referral_code && (
                    <Button size="sm" variant="ghost" onClick={copyReferralLink}>
                      <Copy className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
              <div>
                <p className="text-sm text-slate-500">Referred By</p>
                <p className="font-mono text-slate-900">{user?.referred_by_code || 'None'}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500">Prompt Seen</p>
                <Badge variant={user?.referral_prompt_seen ? 'default' : 'secondary'}>
                  {user?.referral_prompt_seen ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-slate-500">Referral Balance</p>
                <p className="font-semibold text-green-600">₦{user?.referral_balance_ngn?.toLocaleString() || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Button 
            onClick={loadTestData} 
            variant="outline" 
            className="w-full rounded-xl py-6"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh Data
          </Button>
          <Button 
            onClick={simulateReferralFlow} 
            className="w-full rounded-xl py-6 bg-gradient-to-r from-blue-600 to-blue-700"
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Test Referral Flow
          </Button>
          <Button 
            onClick={checkReferralIntegrity} 
            variant="outline"
            className="w-full rounded-xl py-6"
          >
            <Database className="w-4 h-4 mr-2" />
            Run Integrity Check
          </Button>
        </div>

        {/* Test Results */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
          <CardHeader>
            <CardTitle>Test Results & Logs</CardTitle>
            <CardDescription>Real-time feedback from system checks</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {testResults.length === 0 ? (
                <p className="text-slate-500 text-center py-8">No test results yet. Run a check to see results.</p>
              ) : (
                testResults.map((result, idx) => (
                  <div 
                    key={idx} 
                    className={`p-3 rounded-lg border flex items-start gap-3 ${
                      result.type === 'success' ? 'bg-green-50 border-green-200' :
                      result.type === 'error' ? 'bg-red-50 border-red-200' :
                      result.type === 'warning' ? 'bg-amber-50 border-amber-200' :
                      'bg-blue-50 border-blue-200'
                    }`}
                  >
                    {result.type === 'success' && <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />}
                    {result.type === 'error' && <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />}
                    {result.type === 'warning' && <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />}
                    {result.type === 'info' && <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />}
                    
                    <div className="flex-1">
                      <p className="font-semibold text-sm">{result.message}</p>
                      {result.data && (
                        <pre className="text-xs mt-1 text-slate-600 overflow-x-auto">
                          {typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}
                        </pre>
                      )}
                    </div>
                    <span className="text-xs text-slate-400">
                      {result.timestamp.toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Your Referrals */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Your Referrals ({referrals.length})
            </CardTitle>
            <CardDescription>People you've referred to Luxeliving</CardDescription>
          </CardHeader>
          <CardContent>
            {referrals.length === 0 ? (
              <p className="text-slate-500 text-center py-8">No referrals yet. Share your link to get started!</p>
            ) : (
              <div className="space-y-3">
                {referrals.map(ref => (
                  <div key={ref.id} className="p-4 border border-slate-200 rounded-xl flex justify-between items-center">
                    <div>
                      <p className="font-semibold text-slate-900">{ref.referred_email}</p>
                      <p className="text-sm text-slate-500">
                        Joined: {new Date(ref.created_date).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <Badge variant={ref.status === 'booking_completed' ? 'default' : 'secondary'}>
                        {ref.status === 'booking_completed' ? '✅ Booked' : '⏳ Signed Up'}
                      </Badge>
                      {ref.amount_earned_ngn > 0 && (
                        <p className="text-sm font-semibold text-green-600 mt-1">
                          +₦{ref.amount_earned_ngn.toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Admin: All Users */}
        {user?.role === 'admin' && allUsers.length > 0 && (
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="w-5 h-5" />
                All Users (Admin View)
              </CardTitle>
              <CardDescription>System-wide referral data</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {allUsers.map(u => (
                  <div key={u.id} className="p-3 border border-slate-200 rounded-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold text-slate-900">{u.email}</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Code: <span className="font-mono text-amber-600">{u.referral_code || 'None'}</span>
                        </p>
                      </div>
                      <div className="text-right text-xs">
                        {u.referred_by_code && (
                          <p className="text-slate-600">
                            Referred by: <span className="font-mono">{u.referred_by_code}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}