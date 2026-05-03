import React, { useState, useEffect } from "react";
import { User } from "@/entities/User";
import { Property } from "@/entities/Property";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, Search, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import PropertyCard from "../components/search/PropertyCard";

export default function WishlistPage() {
  const [user, setUser] = useState(null);
  const [wishlistItems, setWishlistItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    loadWishlist();
  }, []);

  const loadWishlist = async () => {
    setIsLoading(true);
    try {
      const userData = await User.me();
      setUser(userData);
      
      if (userData.wishlist && userData.wishlist.length > 0) {
        // Use $in operator to fetch multiple properties by IDs
        const properties = await Property.filter({ 
          id: { $in: userData.wishlist } 
        });
        setWishlistItems(properties);
      } else {
        setWishlistItems([]);
      }
    } catch (error) {
      console.error("Failed to load wishlist", error);
      setWishlistItems([]);
    }
    setIsLoading(false);
  };

  const refreshWishlist = async () => {
    setIsRefreshing(true);
    await loadWishlist();
    setIsRefreshing(false);
  };

  const handleToggleWishlist = async (propertyId) => {
    try {
      // Get fresh user data
      const freshUserData = await User.me();
      const newWishlist = freshUserData.wishlist.filter(id => id !== propertyId);
      
      // Update user's wishlist
      await User.updateMyUserData({ wishlist: newWishlist });
      
      // Update local states
      setUser(prev => ({ ...prev, wishlist: newWishlist }));
      setWishlistItems(prev => prev.filter(item => item.id !== propertyId));
      
    } catch (error) {
      console.error("Failed to update wishlist:", error);
      // Refresh the entire wishlist on error
      await loadWishlist();
    }
  };
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
           <div className="animate-pulse space-y-6">
            <div className="h-8 bg-slate-200 rounded-xl w-48" />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {Array(3).fill(0).map((_, i) => (
                  <div key={i} className="bg-white/50 rounded-3xl h-96" />
                ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">My Wishlist</h1>
            <p className="text-slate-600 text-lg">Your saved properties for later</p>
          </div>
          <Button
            variant="outline"
            onClick={refreshWishlist}
            disabled={isRefreshing}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {wishlistItems.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {wishlistItems.map(property => (
              <PropertyCard
                key={property.id}
                property={property}
                isWishlisted={true}
                onToggleWishlist={() => handleToggleWishlist(property.id)}
              />
            ))}
          </div>
        ) : (
          <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
            <CardContent className="p-12 text-center">
              <div className="text-6xl mb-6">💝</div>
              <h2 className="text-2xl font-bold text-slate-900 mb-4">Your wishlist is empty</h2>
              <p className="text-slate-600 mb-6">
                Start browsing and save properties you love by clicking the heart icon.
              </p>
              <Link to={createPageUrl("Search")}>
                <Button className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-3 rounded-xl font-semibold">
                  <Search className="w-4 h-4 mr-2" />
                  Explore Properties
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}