import React, { useState, useEffect } from "react";
import { User } from "@/entities/User";
import { Referral } from "@/entities/Referral";
import { base44 } from "@/api/base44Client";
import { UploadFile } from "@/integrations/Core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserCircle, Mail, MapPin, Languages, Save, Camera, Upload, Phone } from "lucide-react";
import ReferralCard from "../components/profile/ReferralCard";

export default function ProfilePage() {
  const [user, setUser] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPicture, setIsUploadingPicture] = useState(false);
  const [profileData, setProfileData] = useState({
    profile_picture: "",
    bio: "",
    phone_number: "",
    travel_style: "",
    interests: ""
  });

  useEffect(() => {
    loadUserData();
  }, []);

  const loadUserData = async () => {
    setIsLoading(true);
    try {
      const userData = await base44.auth.me();
      setUser(userData);
      setProfileData({
        profile_picture: userData.profile_picture || "",
        bio: userData.bio || "",
        phone_number: userData.phone_number || "",
        travel_style: userData.travel_style || "",
        interests: userData.interests || ""
      });

      if (userData.referral_code) {
        const referralData = await Referral.filter({ referrer_email: userData.email });
        setReferrals(referralData);
      }
    } catch (error) {
      console.error("Error loading user data:", error);
    }
    setIsLoading(false);
  };

  const handleProfilePictureUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      alert('Please upload a valid image file (JPEG, PNG, or WebP).');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert('Please upload an image smaller than 5MB.');
      return;
    }

    setIsUploadingPicture(true);
    try {
      const uploadResult = await UploadFile({ file });
      const newProfileData = { ...profileData, profile_picture: uploadResult.file_url };
      setProfileData(newProfileData);
      
      // Auto-save the profile picture
      await base44.auth.updateMe({ profile_picture: uploadResult.file_url });
      await loadUserData(); // Reload user data
    } catch (error) {
      console.error("Error uploading profile picture:", error);
      alert("Failed to upload profile picture. Please try again.");
    }
    setIsUploadingPicture(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await base44.auth.updateMe(profileData);
      alert('Profile updated successfully!');
      await loadUserData(); // Reload data
    } catch (error) {
      console.error("Error saving profile:", error);
      alert('Failed to save profile. Please try again.');
    }
    setIsSaving(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8">
        <div className="max-w-2xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-slate-200 rounded-xl w-48" />
            <div className="h-96 bg-slate-200 rounded-3xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          {/* Profile Details Card */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-slate-900 mb-2">My Profile</h1>
            <p className="text-slate-600 text-lg">Manage your account and preferences</p>
          </div>

          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardHeader className="p-8 border-b border-slate-100">
              <div className="flex items-center gap-6">
                {/* Profile Picture Section */}
                <div className="relative">
                  <div className="w-24 h-24 rounded-full overflow-hidden bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center relative group">
                    {profileData.profile_picture ? (
                      <img
                        src={profileData.profile_picture}
                        alt="Profile"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <UserCircle className="w-12 h-12 text-white" />
                    )}
                    
                    {/* Upload overlay */}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center">
                      <Camera className="w-6 h-6 text-white" />
                    </div>
                  </div>
                  
                  {/* Upload button */}
                  <label className="absolute -bottom-2 -right-2 bg-slate-900 hover:bg-slate-800 text-white p-2 rounded-full cursor-pointer shadow-lg transition-colors duration-200">
                    <Upload className="w-4 h-4" />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleProfilePictureUpload}
                      className="hidden"
                      disabled={isUploadingPicture}
                    />
                  </label>
                  
                  {/* Loading overlay */}
                  {isUploadingPicture && (
                    <div className="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center">
                      <div className="animate-spin rounded-full h-6 w-6 border-2 border-white/30 border-t-white"></div>
                    </div>
                  )}
                </div>

                <div>
                  <CardTitle className="text-2xl font-bold text-slate-900">
                    {user?.full_name || "User"}
                  </CardTitle>
                  <div className="flex items-center gap-2 text-slate-600 mt-1">
                    <Mail className="w-4 h-4" />
                    <span>{user?.email}</span>
                  </div>
                  {isUploadingPicture && (
                    <p className="text-sm text-blue-600 mt-2">Uploading profile picture...</p>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-8 space-y-6">
              <div>
                <Label htmlFor="phone_number" className="text-sm font-semibold text-slate-700">
                  Phone Number *
                </Label>
                <div className="relative mt-2">
                  <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                  <Input
                    id="phone_number"
                    type="tel"
                    value={profileData.phone_number}
                    onChange={(e) => setProfileData({ ...profileData, phone_number: e.target.value })}
                    placeholder="+234 800 000 0000"
                    className="pl-10 rounded-xl border-slate-200"
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Required for booking confirmations and property communication
                </p>
              </div>

              <div>
                <Label htmlFor="bio" className="text-sm font-semibold text-slate-700">
                  About Me
                </Label>
                <Textarea
                  id="bio"
                  value={profileData.bio}
                  onChange={(e) => setProfileData({ ...profileData, bio: e.target.value })}
                  placeholder="Tell us about yourself..."
                  className="mt-2 rounded-xl border-slate-200 min-h-[100px]"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label className="text-sm font-semibold text-slate-700">
                    Travel Style
                  </Label>
                  <Select
                    value={profileData.travel_style}
                    onValueChange={(value) => setProfileData({ ...profileData, travel_style: value })}
                  >
                    <SelectTrigger className="mt-2 rounded-xl border-slate-200">
                      <SelectValue placeholder="Select your style" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="luxury">Luxury</SelectItem>
                      <SelectItem value="budget">Budget</SelectItem>
                      <SelectItem value="adventure">Adventure</SelectItem>
                      <SelectItem value="business">Business</SelectItem>
                      <SelectItem value="family">Family</SelectItem>
                      <SelectItem value="romantic">Romantic</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="interests" className="text-sm font-semibold text-slate-700">
                    Travel Interests
                  </Label>
                  <Input
                    id="interests"
                    value={profileData.interests}
                    onChange={(e) => setProfileData({ ...profileData, interests: e.target.value })}
                    placeholder="e.g., food, culture, nature"
                    className="mt-2 rounded-xl border-slate-200"
                  />
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-sm text-amber-900">
                  <strong>📞 Important:</strong> Your phone number will be included in booking records sent to property owners and logged in our booking sheet for communication purposes.
                </p>
              </div>

              <Button
                onClick={handleSave}
                disabled={isSaving}
                className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold py-3 rounded-xl text-lg shadow-lg transition-all duration-300 hover:shadow-xl"
              >
                {isSaving ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white mr-2" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-5 h-5 mr-2" />
                    Save Changes
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
          {/* Referral Card */}
          {user && user.referral_code && (
            <ReferralCard user={user} referrals={referrals} />
          )}
        </div>
      </div>
    </div>
  );
}