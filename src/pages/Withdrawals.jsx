import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Link, useLocation } from 'react-router-dom';
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
import { useToast } from '@/components/ui/use-toast';
import { useDriverProfile } from '@/lib/useDriverProfile';
import { invokeFn } from '@/lib/invokeFn';

const WITHDRAWAL_THRESHOLD_NGN = 10000;

const statusConfig = {
  pending: {
    icon: Clock,
    color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
    label: 'Pending'
  },
  processing: {
    icon: Loader2,
    color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900',
    label: 'Processing'
  },
  completed: {
    icon: CheckCircle,
    color: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 border-green-200 dark:border-green-900',
    label: 'Completed'
  },
  failed: {
    icon: XCircle,
    color: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900',
    label: 'Failed'
  },
  reversed: {
    icon: AlertCircle,
    color: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-900',
    label: 'Reversed'
  }
};

export default function WithdrawalsPage() {
  const { toast } = useToast();
  const [user, setUser] = useState(null);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);

  // Drivers have a second wallet. ?wallet=driver (the Withdraw button on the
  // driver's Wallet page) opens this page on it. Anyone who is not a driver
  // stays on referral whatever the URL says, and the server checks again.
  const location = useLocation();
  const { isDriver } = useDriverProfile();
  const [chosenWallet, setChosenWallet] = useState(
    () => (new URLSearchParams(location.search).get('wallet') === 'driver' ? 'driver' : 'referral'),
  );
  const [driverWallet, setDriverWallet] = useState(null);
  const wallet = chosenWallet === 'driver' && isDriver ? 'driver' : 'referral';
  const walletLabel = wallet === 'driver' ? 'driver earnings' : 'referral earnings';
  // The driver figure is computed by the server from the earnings ledger; the
  // referral figure is the stored balance, as before.
  const availableBalance = wallet === 'driver'
    ? (driverWallet?.available_ngn || 0)
    : (user?.referral_balance_ngn || 0);

  const [formData, setFormData] = useState({
    amount: '',
    bank_account_id: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadDriverWallet = async () => {
    const r = await invokeFn('getDriverWallet');
    if (r.ok) setDriverWallet(r.data);
  };

  useEffect(() => {
    if (isDriver) loadDriverWallet();
  }, [isDriver]);

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
      toast({
        title: 'Could not load withdrawal data',
        description: error?.message || 'Please refresh and try again.',
        variant: 'destructive',
      });
    }
    setIsLoading(false);
  };

  const handleSubmitRequest = async (e) => {
    e.preventDefault();

    if (!formData.amount || !formData.bank_account_id) {
      toast({
        title: 'Missing details',
        description: 'Pick a bank account and enter an amount before requesting.',
        variant: 'destructive',
      });
      return;
    }

    const amount = Number(formData.amount);
    if (!Number.isInteger(amount)) {
      toast({
        title: 'Whole naira only',
        description: 'Enter the amount without kobo, for example 15000.',
        variant: 'destructive',
      });
      return;
    }
    if (amount < WITHDRAWAL_THRESHOLD_NGN) {
      toast({
        title: 'Below minimum',
        description: `The minimum withdrawal is ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()}.`,
        variant: 'destructive',
      });
      return;
    }

    if (amount > availableBalance) {
      toast({
        title: 'Insufficient balance',
        description: `You have ₦${availableBalance.toLocaleString()} available.`,
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // invokeFn turns a refusal (a 4xx carrying the reason) into a result
      // rather than an exception, so the branch below shows the server's own
      // sentence: "You have a pending withdrawal request…", not a status code.
      const result = await invokeFn('createWithdrawalRequest', {
        amount,
        bank_account_id: formData.bank_account_id,
        wallet,
      });
      const response = { data: result.ok ? result.body : { success: false, error: result.error } };

      if (response.data.success) {
        toast({
          title: 'Withdrawal requested',
          description: response.data.message || 'We will process it within 24–48 hours.',
        });
        setFormData({ amount: '', bank_account_id: '' });
        setShowRequestForm(false);
        await loadData();
        if (isDriver) await loadDriverWallet();
      } else {
        toast({
          title: 'Withdrawal could not be created',
          description: response.data.error || 'Please try again in a moment.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error creating withdrawal:', error);
      toast({
        title: 'Something went wrong',
        description: error?.message || 'Please try again in a moment.',
        variant: 'destructive',
      });
    }
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-slate-900 dark:text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1 sm:mb-2">Withdrawals</h1>
          <p className="text-slate-600 dark:text-slate-300 text-base sm:text-lg">Withdraw your earnings to your bank account</p>
        </div>

        {isDriver && (
          <div
            className="mb-4 inline-flex rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 p-1"
            role="tablist" aria-label="Which earnings to withdraw"
          >
            {[{ id: 'driver', label: 'Driver earnings' }, { id: 'referral', label: 'Referral earnings' }].map((option) => (
              <button
                key={option.id} type="button" role="tab" aria-selected={wallet === option.id}
                onClick={() => {
                  setChosenWallet(option.id);
                  setShowRequestForm(false);
                  setFormData({ amount: '', bank_account_id: '' });
                }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  wallet === option.id
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {/* Balance Card */}
        <Card className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-3xl shadow-xl mb-6 sm:mb-8">
          <CardContent className="p-5 sm:p-8">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-slate-300 mb-1 sm:mb-2 text-sm sm:text-base">Available Balance</p>
                <p className="text-2xl sm:text-4xl font-bold break-words">₦{availableBalance.toLocaleString()}</p>
                <p className="text-xs sm:text-sm text-slate-400 dark:text-slate-500 mt-2">
                  {wallet === 'driver' ? 'Released pay from your rides' : 'From referrals and other earnings'}
                </p>
              </div>
              <Wallet className="w-12 h-12 sm:w-16 sm:h-16 text-amber-400 opacity-50 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        {/* Withdrawal Form */}
        {bankAccounts.length === 0 ? (
          <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-12 text-center mb-8">
            <CreditCard className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No Bank Account Added</h3>
            <p className="text-slate-600 dark:text-slate-300 mb-6">
              You need to add a verified bank account before you can withdraw funds
            </p>
            <Link to={createPageUrl('BankAccounts')}>
              <Button className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-3 rounded-xl font-semibold dark:from-white dark:to-slate-200 dark:text-slate-900">
                <Plus className="w-5 h-5 mr-2" />
                Add Bank Account
              </Button>
            </Link>
          </Card>
        ) : availableBalance < WITHDRAWAL_THRESHOLD_NGN ? (
          <Card className="bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 rounded-2xl p-6 mb-8">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-900 dark:text-amber-100 mb-1">
                  Withdrawal threshold not met
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  You need at least ₦{WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in {walletLabel} to
                  request a withdrawal. You currently have ₦{availableBalance.toLocaleString()}
                  {' '}— ₦{(WITHDRAWAL_THRESHOLD_NGN - availableBalance).toLocaleString()} to go.
                </p>
              </div>
            </div>
          </Card>
        ) : !showRequestForm ? (
          <Button
            onClick={() => setShowRequestForm(true)}
            className="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white py-6 rounded-2xl font-semibold mb-8"
          >
            <Send className="w-5 h-5 mr-2" />
            Request Withdrawal
          </Button>
        ) : (
          <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg mb-8">
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
                              <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-xs">Primary</Badge>
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
                    min={WITHDRAWAL_THRESHOLD_NGN}
                    max={availableBalance}
                    step="100"
                    placeholder={`Min ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()}`}
                    value={formData.amount}
                    onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                    className="mt-1 rounded-xl"
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Minimum: ₦{WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} • Maximum: ₦{availableBalance.toLocaleString()}
                  </p>
                </div>

                <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-4">
                  <p className="text-sm text-blue-900 dark:text-blue-100">
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
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Withdrawal History</h2>
          
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
                    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge className={`${config.color} border font-medium`}>
                                <Icon className={`w-3 h-3 mr-1 ${withdrawal.status === 'processing' ? 'animate-spin' : ''}`} />
                                {config.label}
                              </Badge>
                              {isDriver && (
                                <Badge variant="outline" className="text-xs">
                                  {withdrawal.wallet === 'driver' ? 'Driver earnings' : 'Referral'}
                                </Badge>
                              )}
                            </div>
                            <p className="text-2xl font-bold text-slate-900 dark:text-white mb-1">
                              ₦{withdrawal.amount.toLocaleString()}
                            </p>
                            {account && (
                              <p className="text-sm text-slate-600 dark:text-slate-300 mb-1">
                                To: {account.bank_name} - {account.account_number}
                              </p>
                            )}
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              Requested {format(new Date(withdrawal.created_date), 'MMM d, yyyy • h:mm a')}
                            </p>
                            {withdrawal.processed_at && (
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                Processed {format(new Date(withdrawal.processed_at), 'MMM d, yyyy • h:mm a')}
                              </p>
                            )}
                            {withdrawal.error_message && (
                              <div className="mt-2 p-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg">
                                <p className="text-xs text-red-700 dark:text-red-300">{withdrawal.error_message}</p>
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
              <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-8 text-center">
                <Send className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">No Withdrawal History</h3>
                <p className="text-slate-600 dark:text-slate-300">Your withdrawal requests will appear here</p>
              </Card>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}