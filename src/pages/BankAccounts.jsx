import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { 
  CreditCard, Plus, Trash2, CheckCircle, AlertCircle, 
  Loader2, Star, Building 
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function BankAccountsPage() {
  const [user, setUser] = useState(null);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [banks, setBanks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingBanks, setIsLoadingBanks] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState(null);
  
  const [formData, setFormData] = useState({
    bank_code: '',
    bank_name: '',
    account_number: '',
    account_name: ''
  });
  
  const [verificationResult, setVerificationResult] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const userData = await base44.auth.me();
      setUser(userData);
      
      const accounts = await base44.entities.UserBankAccount.filter({
        user_email: userData.email
      }, '-created_date');
      setBankAccounts(accounts);
    } catch (error) {
      console.error('Error loading data:', error);
      alert('Failed to load bank accounts.');
    }
    setIsLoading(false);
  };

  const loadBanks = async () => {
    if (banks.length > 0) return; // Already loaded
    
    setIsLoadingBanks(true);
    try {
      const response = await base44.functions.invoke('getNigerianBanks', {});
      if (response.data.success) {
        setBanks(response.data.banks);
      } else {
        alert('Failed to load banks list');
      }
    } catch (error) {
      console.error('Error loading banks:', error);
      alert('Failed to load banks list');
    }
    setIsLoadingBanks(false);
  };

  const handleVerifyAccount = async () => {
    if (!formData.bank_code || !formData.account_number) {
      alert('Please select a bank and enter account number');
      return;
    }

    setIsVerifying(true);
    setVerificationResult(null);
    
    try {
      const response = await base44.functions.invoke('resolveBankAccount', {
        bank_code: formData.bank_code,
        account_number: formData.account_number
      });

      if (response.data.success) {
        setVerificationResult({
          success: true,
          account_name: response.data.account_name
        });
        setFormData(prev => ({
          ...prev,
          account_name: response.data.account_name
        }));
      } else {
        setVerificationResult({
          success: false,
          error: response.data.error
        });
      }
    } catch (error) {
      console.error('Error verifying account:', error);
      setVerificationResult({
        success: false,
        error: error.message || 'Failed to verify account'
      });
    }
    
    setIsVerifying(false);
  };

  const handleSaveAccount = async () => {
    if (!verificationResult?.success) {
      alert('Please verify the account first');
      return;
    }

    setIsSaving(true);
    try {
      const selectedBank = banks.find(b => b.code === formData.bank_code);
      
      await base44.entities.UserBankAccount.create({
        user_email: user.email,
        bank_name: selectedBank.name,
        bank_code: formData.bank_code,
        account_number: formData.account_number,
        account_name: formData.account_name,
        is_verified: true,
        is_primary: bankAccounts.length === 0 // First account is primary
      });

      await loadData();
      
      // Reset form
      setFormData({
        bank_code: '',
        bank_name: '',
        account_number: '',
        account_name: ''
      });
      setVerificationResult(null);
      setShowAddForm(false);
      
      alert('Bank account added successfully!');
    } catch (error) {
      console.error('Error saving account:', error);
      alert('Failed to save bank account');
    }
    setIsSaving(false);
  };

  const handleSetPrimary = async (accountId) => {
    try {
      // Set all accounts to non-primary
      for (const account of bankAccounts) {
        await base44.entities.UserBankAccount.update(account.id, {
          is_primary: account.id === accountId
        });
      }
      
      await loadData();
    } catch (error) {
      console.error('Error setting primary account:', error);
      alert('Failed to set primary account');
    }
  };

  const handleDeleteClick = (account) => {
    setAccountToDelete(account);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    if (!accountToDelete) return;

    setIsDeleting(accountToDelete.id);
    try {
      await base44.entities.UserBankAccount.delete(accountToDelete.id);
      await loadData();
      alert('Bank account deleted successfully');
    } catch (error) {
      console.error('Error deleting account:', error);
      alert('Failed to delete bank account');
    }
    setIsDeleting(null);
    setShowDeleteDialog(false);
    setAccountToDelete(null);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-slate-900" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Bank Accounts</h1>
          <p className="text-slate-600 text-lg">Manage your withdrawal accounts</p>
        </div>

        {/* Saved Accounts */}
        <div className="space-y-4 mb-6">
          <AnimatePresence>
            {bankAccounts.map(account => (
              <motion.div
                key={account.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4 flex-1">
                        <div className="w-12 h-12 bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl flex items-center justify-center">
                          <Building className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-lg font-bold text-slate-900">{account.bank_name}</h3>
                            {account.is_primary && (
                              <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                                <Star className="w-3 h-3 mr-1" />
                                Primary
                              </Badge>
                            )}
                            {account.is_verified && (
                              <Badge className="bg-green-100 text-green-800 border-green-200">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Verified
                              </Badge>
                            )}
                          </div>
                          <p className="text-slate-600 mb-1">{account.account_name}</p>
                          <p className="text-sm text-slate-500 font-mono">{account.account_number}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!account.is_primary && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSetPrimary(account.id)}
                            className="rounded-xl"
                          >
                            Set as Primary
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteClick(account)}
                          disabled={isDeleting === account.id}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          {isDeleting === account.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
          
          {bankAccounts.length === 0 && (
            <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg p-12 text-center">
              <CreditCard className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-bold text-slate-900 mb-2">No Bank Accounts</h3>
              <p className="text-slate-600 mb-6">Add a bank account to withdraw your earnings</p>
            </Card>
          )}
        </div>

        {/* Add New Account */}
        {!showAddForm ? (
          <Button
            onClick={() => {
              setShowAddForm(true);
              loadBanks();
            }}
            className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white py-6 rounded-2xl font-semibold"
          >
            <Plus className="w-5 h-5 mr-2" />
            Add New Bank Account
          </Button>
        ) : (
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardHeader>
              <CardTitle>Add New Bank Account</CardTitle>
              <CardDescription>
                Enter your Nigerian bank account details for withdrawals
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="bank">Select Bank *</Label>
                <Select
                  value={formData.bank_code}
                  onValueChange={(value) => {
                    const selectedBank = banks.find(b => b.code === value);
                    setFormData(prev => ({
                      ...prev,
                      bank_code: value,
                      bank_name: selectedBank?.name || ''
                    }));
                    setVerificationResult(null);
                  }}
                  disabled={isLoadingBanks}
                >
                  <SelectTrigger className="mt-1 rounded-xl">
                    <SelectValue placeholder={isLoadingBanks ? "Loading banks..." : "Choose your bank"} />
                  </SelectTrigger>
                  <SelectContent>
                    {banks.map(bank => (
                      <SelectItem key={bank.code} value={bank.code}>
                        {bank.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="account_number">Account Number *</Label>
                <Input
                  id="account_number"
                  type="text"
                  maxLength={10}
                  placeholder="0123456789"
                  value={formData.account_number}
                  onChange={(e) => {
                    setFormData(prev => ({ ...prev, account_number: e.target.value }));
                    setVerificationResult(null);
                  }}
                  className="mt-1 rounded-xl"
                />
              </div>

              {verificationResult && (
                <div className={`rounded-xl p-4 ${
                  verificationResult.success 
                    ? 'bg-green-50 border border-green-200' 
                    : 'bg-red-50 border border-red-200'
                }`}>
                  {verificationResult.success ? (
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <div>
                        <p className="font-semibold text-green-900">Account Verified!</p>
                        <p className="text-sm text-green-700">{verificationResult.account_name}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-5 h-5 text-red-600" />
                      <div>
                        <p className="font-semibold text-red-900">Verification Failed</p>
                        <p className="text-sm text-red-700">{verificationResult.error}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  onClick={handleVerifyAccount}
                  disabled={isVerifying || !formData.bank_code || !formData.account_number || verificationResult?.success}
                  variant="outline"
                  className="flex-1 rounded-xl"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Verify Account
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleSaveAccount}
                  disabled={isSaving || !verificationResult?.success}
                  className="flex-1 rounded-xl bg-green-600 hover:bg-green-700"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    'Save Account'
                  )}
                </Button>
              </div>

              <Button
                variant="ghost"
                onClick={() => {
                  setShowAddForm(false);
                  setFormData({
                    bank_code: '',
                    bank_name: '',
                    account_number: '',
                    account_name: ''
                  });
                  setVerificationResult(null);
                }}
                className="w-full rounded-xl"
              >
                Cancel
              </Button>
            </CardContent>
          </Card>
        )}

        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Bank Account?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this bank account?
                {accountToDelete && (
                  <div className="mt-3 p-3 bg-slate-50 rounded-lg">
                    <p className="font-semibold text-slate-900">{accountToDelete.bank_name}</p>
                    <p className="text-sm text-slate-600">{accountToDelete.account_name}</p>
                    <p className="text-sm text-slate-500 font-mono">{accountToDelete.account_number}</p>
                  </div>
                )}
                <p className="mt-3 text-red-600 font-semibold">
                  This action cannot be undone.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}