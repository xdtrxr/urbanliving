import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Wallet, Send, Clock, CheckCircle, XCircle, AlertCircle, 
  Loader2, CreditCard, ArrowRight, Plus 
} from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';

const statusConfig = {
  pending: {
    icon: Clock,
    color: 'bg-amber-100 text-amber-800 border-amber-200',
    label: 'Pending'
  },
  processing: {
    icon: Loader2,
    color: 'bg-blue-100 text-blue-800 border-blue-200',
    label: 'Processing'
  },
  completed: {
    icon: CheckCircle,
    color: 'bg-green-100 text-green-800 border-green-200',
    label: 'Completed'
  },
  failed: {
    icon: XCircle,
    color: 'bg-red-100 text-red-800 border-red-200',
    label: 'Failed'
  },
  reversed: {
    icon: AlertCircle,
    color: 'bg-purple-100 text-purple-800 border-purple-200',
    label: 'Reversed'
  }
};

export default function WithdrawalsPage() {
  const [user, setUser] = useState(null);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  
  const [formData, setFormData] = useState({
    amount: '',
    bank_account_id: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const userData = await base44.auth.me();
      setUser(userData);

      const accounts = await base44.entities.UserBankAccount.filter({
        user_email: userData.email,
        is_verified: true
      });
      setBankAccounts(accounts);

      const withdrawalRequests = await base44.entities.WithdrawalRequest.filter({
        user_email: userData.email
      }, '-created_date');
      setWithdrawals(withdrawalRequests);
    } catch (error) {
      console.error('Error loading data:', error);
      alert('Failed to load withdrawal data');
    }
    setIsLoading(false);
  };

  const handleSubmitRequest = async (e) => {
    e.preventDefault();
    
    if (!formData.amount || !formData.bank_account_id) {
      alert('Please fill in all fields');
      return;
    }

    const amount = parseFloat(formData.amount);
    if (amount < 1000) {
      alert('Minimum withdrawal amount is ₦1,000');
      return;
    }

    if (amount > (user?.referral_balance_ngn || 0)) {
      alert('Insufficient balance');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await base44.functions.invoke('createWithdrawalRequest', {
        amount: amount,
        bank_account_id: formData.bank_account_id
      });

      if (response.data.success) {
        alert(response.data.message);
        setFormData({ amount: '', bank_account_id: '' });
        setShowRequestForm(false);
        await loadData();
      } else {
        alert(response.data.error || 'Failed to create withdrawal request');
      }
    } catch (error) {
      console.error('Error creating withdrawal:', error);
      alert(error.message || 'Failed to create withdrawal request');
    }
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-slate-900" />
      </div>
    );
  }

  const availableBalance = user?.referral_balance_ngn || 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Withdrawals</h1>
          <p className="text-slate-600 text-lg">Withdraw your earnings to your bank account</p>
        </div>

        {/* Balance Card */}
        <Card className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-3xl shadow-xl mb-8">
          <CardContent className="p-8">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-300 mb-2">Available Balance</p>
                <p className="text-4xl font-bold">₦{availableBalance.toLocaleString()}</p>
                <p className="text-sm text-slate-400 mt-2">From referrals and other earnings</p>
              </div>
              <Wallet className="w-16 h-16 text-amber-400 opacity-50" />
            </div>
          </CardContent>
        </Card>

        {/* Withdrawal Form */}
        {bankAccounts.length === 0 ? (
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-12 text-center mb-8">
            <CreditCard className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-900 mb-2">No Bank Account Added</h3>
            <p className="text-slate-600 mb-6">
              You need to add a verified bank account before you can withdraw funds
            </p>
            <Link to={createPageUrl('BankAccounts')}>
              <Button className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-3 rounded-xl font-semibold">
                <Plus className="w-5 h-5 mr-2" />
                Add Bank Account
              </Button>
            </Link>
          </Card>
        ) : !showRequestForm ? (
          <Button
            onClick={() => setShowRequestForm(true)}
            disabled={availableBalance < 1000}
            className="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white py-6 rounded-2xl font-semibold mb-8"
          >
            <Send className="w-5 h-5 mr-2" />
            {availableBalance < 1000 ? 'Minimum Balance Required (₦1,000)' : 'Request Withdrawal'}
          </Button>
        ) : (
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg mb-8">
            <CardHeader>
              <CardTitle>Request Withdrawal</CardTitle>
              <CardDescription>
                Withdraw funds to your verified bank account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmitRequest} className="space-y-4">
                <div>
                  <Label htmlFor="bank_account">Select Bank Account *</Label>
                  <Select
                    value={formData.bank_account_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, bank_account_id: value }))}
                  >
                    <SelectTrigger className="mt-1 rounded-xl">
                      <SelectValue placeholder="Choose bank account" />
                    </SelectTrigger>
                    <SelectContent>
                      {bankAccounts.map(account => (
                        <SelectItem key={account.id} value={account.id}>
                          <div className="flex items-center gap-2">
                            <span>{account.bank_name} - {account.account_number}</span>
                            {account.is_primary && (
                              <Badge className="bg-amber-100 text-amber-800 text-xs">Primary</Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="amount">Amount (NGN) *</Label>
                  <Input
                    id="amount"
                    type="number"
                    min="1000"
                    max={availableBalance}
                    step="100"
                    placeholder="Enter amount"
                    value={formData.amount}
                    onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                    className="mt-1 rounded-xl"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Minimum: ₦1,000 • Maximum: ₦{availableBalance.toLocaleString()}
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-sm text-blue-900">
                    <strong>Processing Time:</strong> Withdrawals are processed within 24-48 hours during business days.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowRequestForm(false);
                      setFormData({ amount: '', bank_account_id: '' });
                    }}
                    className="flex-1 rounded-xl"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 rounded-xl bg-green-600 hover:bg-green-700"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Submit Request
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Withdrawal History */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-slate-900">Withdrawal History</h2>
          
          <AnimatePresence>
            {withdrawals.length > 0 ? (
              withdrawals.map(withdrawal => {
                const config = statusConfig[withdrawal.status];
                const Icon = config.icon;
                const account = bankAccounts.find(a => a.id === withdrawal.bank_account_id);

                return (
                  <motion.div
                    key={withdrawal.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                  >
                    <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge className={`${config.color} border font-medium`}>
                                <Icon className={`w-3 h-3 mr-1 ${withdrawal.status === 'processing' ? 'animate-spin' : ''}`} />
                                {config.label}
                              </Badge>
                            </div>
                            <p className="text-2xl font-bold text-slate-900 mb-1">
                              ₦{withdrawal.amount.toLocaleString()}
                            </p>
                            {account && (
                              <p className="text-sm text-slate-600 mb-1">
                                To: {account.bank_name} - {account.account_number}
                              </p>
                            )}
                            <p className="text-xs text-slate-500">
                              Requested {format(new Date(withdrawal.created_date), 'MMM d, yyyy • h:mm a')}
                            </p>
                            {withdrawal.processed_at && (
                              <p className="text-xs text-slate-500">
                                Processed {format(new Date(withdrawal.processed_at), 'MMM d, yyyy • h:mm a')}
                              </p>
                            )}
                            {withdrawal.error_message && (
                              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                                <p className="text-xs text-red-700">{withdrawal.error_message}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })
            ) : (
              <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-8 text-center">
                <Send className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-slate-900 mb-2">No Withdrawal History</h3>
                <p className="text-slate-600">Your withdrawal requests will appear here</p>
              </Card>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}