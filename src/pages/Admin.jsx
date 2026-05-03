
import React, { useState, useEffect } from 'react';
import { User } from '@/entities/User';
import { UploadFile } from '@/integrations/Core';
import { SupportTicket } from '@/entities/SupportTicket';
import { SupportMessage } from '@/entities/SupportMessage';
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Database,
  Shield,
  AlertTriangle,
  Image as ImageIcon,
  Trash2,
  Video,
  Play,
  MessageSquare,
  Send,
  Loader2,
  Edit,
  List,
  Plus, // NEW
  Settings, // NEW
  DollarSign, // NEW
  FileText, // Added for basic info section
  XCircle // Added for clear edit button
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"; // NEW Tabs components

export default function AdminPage() {
  const [user, setUser] = useState(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // Removed old file upload/data ingestion states:
  // const [uploadedFile, setUploadedFile] = useState(null);
  // const [isUploading, setIsUploading] = useState(false);
  // const [isProcessing, setIsProcessing] = useState(false);
  // const [extractedData, setExtractedData] = useState(null);
  // const [importResults, setImportResults] = useState(null);
  // const [progress, setProgress] = useState(0);

  // Support Inbox State
  const [supportTickets, setSupportTickets] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  const [adminReply, setAdminReply] = useState("");
  const [isLoadingTickets, setIsLoadingTickets] = useState(false);
  const [isSendingReply, setIsSendingReply] = useState(false);

  // New state for manual form entry (updated structure)
  const [propertyFormData, setPropertyFormData] = useState({
    title: '',
    description: '',
    location: { city: '', country: '', address: '' }, // Changed to object
    price_per_night: '',
    caution_fee: '', // NEW
    max_guests: '',
    bedrooms: '',
    bathrooms: '',
    property_type: 'apartment',
    amenities: '', // Keeping as string for form input, will split on submit
    images: [],
    videos: [],
    host_name: '',
    instant_book: false
  });
  const [isSavingProperty, setIsSavingProperty] = useState(false); // Renamed from isSubmittingForm
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [isUploadingVideos, setIsUploadingVideos] = useState(false);

  // New state for "Delete All Properties"
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Removed old activeTab for data ingestion
  // const [activeTab, setActiveTab] = useState('data-ingestion');
  const [isSyncing, setIsSyncing] = useState(false);

  // NEW: MCP Data Fetch State
  const [mcpCity, setMcpCity] = useState('');
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpResult, setMcpResult] = useState(null);

  // NEW: Property Management State (renamed from propertiesList, isPropertiesLoading, editingProperty)
  const [properties, setProperties] = useState([]); // Renamed from propertiesList
  const [isLoadingProperties, setIsLoadingProperties] = useState(false); // Renamed from isPropertiesLoading
  const [editingPropertyId, setEditingPropertyId] = useState(null); // Changed to ID
  const [deletingPropertyId, setDeletingPropertyId] = useState(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [propertyToDelete, setPropertyToDelete] = useState(null);

  // State for the new Tabs component
  const [activeAdminTab, setActiveAdminTab] = useState('add-manual'); // Default to manual entry tab


  useEffect(() => {
    checkAdminAccess();
  }, []);

  useEffect(() => {
    if (isAuthorized) {
        loadSupportTickets();
        loadProperties();
    }
  }, [isAuthorized]);

  const checkAdminAccess = async () => {
    setIsLoading(true);
    try {
      const userData = await User.me();
      setUser(userData);

      // Check if user has admin role
      if (userData.role === 'admin') {
        setIsAuthorized(true);
      } else {
        setIsAuthorized(false);
      }
    } catch (error) {
      console.error('Error checking admin access:', error);
      setIsAuthorized(false);
      setUser(null); // Ensure user is null if access check fails (e.g., not logged in)
    }
    setIsLoading(false);
  };

  const loadSupportTickets = async () => {
    setIsLoadingTickets(true);
    try {
        const tickets = await SupportTicket.filter({}, '-created_date');
        setSupportTickets(tickets);
    } catch (error) {
        console.error("Failed to load support tickets:", error);
        alert("Failed to load support tickets.");
    }
    setIsLoadingTickets(false);
  };

  // NEW: Load Properties Function (updated to use new state names)
  const loadProperties = async () => {
    setIsLoadingProperties(true); // Renamed from isPropertiesLoading
    try {
      const allProperties = await base44.entities.Property.list('-created_date', 100); // Fetch up to 100 properties
      setProperties(allProperties); // Renamed from setPropertiesList
    } catch (error) {
      console.error("Failed to load properties:", error);
      alert("Failed to load properties.");
    }
    setIsLoadingProperties(false); // Renamed from isPropertiesLoading
  };

  // NEW: Handle Edit Property (updated to use new state names and structure)
  const handleEditProperty = (property) => {
    setEditingPropertyId(property.id); // Set the ID of the property being edited
    setPropertyFormData({
      title: property.title || '',
      description: property.description || '',
      location: property.location || { city: '', country: '', address: '' }, // Ensure location is an object
      price_per_night: property.price_per_night || '',
      caution_fee: property.caution_fee || '', // NEW
      max_guests: property.max_guests || '',
      bedrooms: property.bedrooms || '',
      bathrooms: property.bathrooms || '',
      property_type: property.property_type || 'apartment',
      amenities: property.amenities ? property.amenities.join(', ') : '', // Convert array to string for form input
      images: property.images || [],
      videos: property.videos || [],
      host_name: property.host_name || '',
      instant_book: property.instant_book || false
    });
    setActiveAdminTab('add-manual'); // Switch to the "Add/Edit Property" tab
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Scroll to the form
  };

  // NEW: Handle Delete Click
  const handleDeleteClick = (property) => {
    setPropertyToDelete(property);
    setShowDeleteDialog(true);
  };

  // NEW: Confirm Delete Property
  const handleConfirmDelete = async () => {
    if (!propertyToDelete) return;

    setDeletingPropertyId(propertyToDelete.id);
    try {
      await base44.entities.Property.delete(propertyToDelete.id);
      await loadProperties();
      alert('Property deleted successfully!');
    } catch (error) {
      console.error("Failed to delete property:", error);
      alert("Failed to delete property. Please try again.");
    } finally {
      setDeletingPropertyId(null);
      setShowDeleteDialog(false);
      setPropertyToDelete(null);
    }
  };

  const handleSelectTicket = async (ticket) => {
    setSelectedTicket(ticket);
    setTicketMessages([]); // Clear previous messages
    try {
        const messages = await SupportMessage.filter({ ticket_id: ticket.id }, 'created_date');
        setTicketMessages(messages);
    } catch (error) {
        console.error(`Failed to load messages for ticket ${ticket.id}:`, error);
        alert("Failed to load ticket messages.");
    }
  };

  const handleSendAdminReply = async () => {
    if (!adminReply.trim() || !selectedTicket) return;

    setIsSendingReply(true);
    try {
        await SupportMessage.create({
            ticket_id: selectedTicket.id,
            sender_type: 'human_agent',
            message: adminReply,
            message_type: 'text'
        });
        
        if (selectedTicket.status === 'open') {
            await SupportTicket.update(selectedTicket.id, { status: 'in_progress' });
        }

        setAdminReply("");
        const updatedTicket = { ...selectedTicket, status: selectedTicket.status === 'open' ? 'in_progress' : selectedTicket.status };
        await handleSelectTicket(updatedTicket);
        await loadSupportTickets();
    } catch (error) {
        console.error("Failed to send reply:", error);
        alert("Failed to send reply.");
    }
    setIsSendingReply(false);
  };
  
  const handleUpdateTicketStatus = async (newStatus) => {
    if (!selectedTicket) return;
    try {
        const updatedTicket = await SupportTicket.update(selectedTicket.id, { status: newStatus });
        await loadSupportTickets();
        setSelectedTicket(prev => ({ ...prev, status: newStatus }));
    } catch (error) {
        console.error("Failed to update ticket status:", error);
        alert("Failed to update status.");
    }
  };

  // Removed old file upload handlers:
  // const handleFileUpload = async (event) => { /* ... */ };
  // const processUploadedFile = async () => { /* ... */ };
  // const importPropertiesToDatabase = async () => { /* ... */ };
  // const downloadSampleCSV = () => { /* ... */ };

  const handlePropertyFormSubmit = async (e) => {
    e.preventDefault();
    setIsSavingProperty(true); // Renamed from isSubmittingForm

    try {
      // Transform form data to match Property entity structure
      const propertyData = {
        title: propertyFormData.title,
        description: propertyFormData.description,
        location: { // Use propertyFormData.location directly
          city: propertyFormData.location.city,
          country: propertyFormData.location.country,
          address: propertyFormData.location.address,
          coordinates: { lat: 0, lng: 0 } // Default coordinates
        },
        price_per_night: parseFloat(propertyFormData.price_per_night) || 0, // Ensure number
        currency: 'NGN', // Explicitly set to NGN as per new pricing section in outline
        caution_fee: parseFloat(propertyFormData.caution_fee) || 0, // NEW field
        max_guests: parseInt(propertyFormData.max_guests) || 1, // Ensure number
        bedrooms: parseInt(propertyFormData.bedrooms) || 1, // Ensure number
        bathrooms: parseInt(propertyFormData.bathrooms) || 1, // Ensure number
        property_type: propertyFormData.property_type,
        amenities: propertyFormData.amenities ? propertyFormData.amenities.split(',').map(a => a.trim().toLowerCase()) : [],
        images: propertyFormData.images,
        videos: propertyFormData.videos,
        rating: 0, // Removed from form, default to 0
        reviews_count: 0, // Removed from form, default to 0
        host_name: propertyFormData.host_name || '',
        instant_book: propertyFormData.instant_book,
        source: 'manual', // NEW: always 'manual' for this form
        external_id: `manual_${Date.now()}` // NEW: Unique ID for manual entries
      };

      if (editingPropertyId) { // Check for editingPropertyId instead of editingProperty
        // Update existing property
        await base44.entities.Property.update(editingPropertyId, propertyData);
        alert('Property updated successfully!');
      } else {
        // Create new property
        await base44.entities.Property.create(propertyData);
        alert('Property added successfully!');
      }
      
      // Reset form to new structure
      setPropertyFormData({
        title: '',
        description: '',
        location: { city: '', country: '', address: '' },
        price_per_night: '',
        caution_fee: '',
        max_guests: '',
        bedrooms: '',
        bathrooms: '',
        property_type: 'apartment',
        amenities: '',
        images: [],
        videos: [],
        host_name: '',
        instant_book: false
      });
      setEditingPropertyId(null); // Clear editing state
      await loadProperties(); // Refresh the property list
      setActiveAdminTab('manage-properties'); // Switch to manage properties tab after successful save
      
    } catch (error) {
      console.error('Error saving property:', error);
      alert('Failed to save property. Please try again.');
    }
    
    setIsSavingProperty(false); // Renamed from isSubmittingForm
  };
  
  const handleImageUpload = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsUploadingImages(true);
    const uploadedUrls = [];

    for (const file of Array.from(files)) { // Convert FileList to Array
        if (!file.type.startsWith('image/')) {
            alert(`Skipping non-image file: ${file.name}`);
            continue;
        }
        try {
            const uploadResult = await UploadFile({ file });
            uploadedUrls.push(uploadResult.file_url);
        } catch (error) {
            console.error('Error uploading image:', error);
            alert(`Failed to upload ${file.name}. Please try again.`);
        }
    }

    setPropertyFormData(prev => ({
        ...prev,
        images: [...prev.images, ...uploadedUrls]
    }));
    setIsUploadingImages(false);
    // Clear the input value so the same file can be selected again
    event.target.value = '';
  };

  const handleVideoUpload = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsUploadingVideos(true);
    const uploadedUrls = [];

    for (const file of Array.from(files)) {
        if (!file.type.startsWith('video/')) {
            alert(`Skipping non-video file: ${file.name}`);
            continue;
        }
        
        // Check file size (limit to 100MB for videos)
        if (file.size > 100 * 1024 * 1024) {
            alert(`Video ${file.name} is too large. Please upload videos smaller than 100MB.`);
            continue;
        }
        
        try {
            const uploadResult = await UploadFile({ file });
            uploadedUrls.push(uploadResult.file_url);
        } catch (error) {
            console.error('Error uploading video:', error);
            alert(`Failed to upload ${file.name}. Please try again.`);
        }
    }

    setPropertyFormData(prev => ({
        ...prev,
        videos: [...prev.videos, ...uploadedUrls]
    }));
    setIsUploadingVideos(false);
    // Clear the input value so the same file can be selected again
    event.target.value = '';
  };

  const handleRemoveImage = (urlToRemove) => {
    setPropertyFormData(prev => ({
        ...prev,
        images: prev.images.filter(url => url !== urlToRemove)
    }));
  };

  const handleRemoveVideo = (urlToRemove) => {
    setPropertyFormData(prev => ({
        ...prev,
        videos: prev.videos.filter(url => url !== urlToRemove)
    }));
  };

  const handleDeleteAllProperties = async () => {
    const confirmation = window.confirm(
      'DANGER: Are you sure you want to permanently delete ALL properties from the database? This action cannot be undone.'
    );

    if (confirmation) {
      setIsDeleting(true);
      try {
        // Fetch all properties from the frontend
        const allProperties = await base44.entities.Property.list();
        const count = allProperties.length;

        if (count === 0) {
          alert("There are no properties to delete.");
          setIsDeleting(false);
          return;
        }

        // Loop through and delete each property one by one
        for (const prop of allProperties) {
          await base44.entities.Property.delete(prop.id);
        }

        alert(`Success! ${count} properties have been deleted.`);
        await loadProperties(); // Refresh the property list
      } catch (error) {
        console.error('Failed to delete properties:', error);
        alert(`Error: ${error.message}`);
      } finally {
        setIsDeleting(false);
      }
    }
  };

  // NEW: MCP Data Fetch Function
  const handleMCPFetch = async () => {
    if (!mcpCity.trim()) {
      alert('Please enter a city name');
      return;
    }

    setMcpLoading(true);
    setMcpResult(null);

    try {
      console.log('Calling MCP function with city:', mcpCity);
      const response = await base44.functions.invoke('mcpDataIngestion', {
        city: mcpCity,
        sources: ['airbnb']
      });

      console.log('MCP Response:', response);
      setMcpResult({
        success: response.data.success,
        message: response.data.message || (response.data.success ? 'Properties fetched successfully!' : 'Failed to fetch properties.'),
        errors: response.data.errors || []
      });
      
      if (response.data.success) {
        await loadProperties(); // Refresh the property list after successful fetch
      }
    } catch (error) {
      console.error('MCP Error:', error);
      setMcpResult({ 
        success: false, 
        message: error.message || error.toString()
      });
    }

    setMcpLoading(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent"></div>
      </div>
    );
  }

  // New check for unauthenticated users
  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-8">
        <Card className="max-w-md w-full bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl">
          <CardContent className="p-12 text-center">
            <Shield className="w-16 h-16 text-red-500 mx-auto mb-6" />
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Authentication Required</h2>
            <p className="text-slate-600 mb-6">
              Please log in to access the admin panel.
            </p>
            <Button onClick={() => window.location.reload()} className="bg-slate-900 hover:bg-slate-800">
              Try Again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Existing check for unauthorized users (not admin)
  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-8">
        <Card className="max-w-md w-full bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-xl">
          <CardContent className="p-12 text-center">
            <Shield className="w-16 h-16 text-red-500 mx-auto mb-6" />
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Access Denied</h2>
            <p className="text-slate-600 mb-6">
              You need administrator privileges to access this page.
            </p>
            <p className="text-sm text-slate-500">
              Current role: {user.role || 'user'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Database className="w-8 h-8 text-slate-900" />
            <h1 className="text-3xl font-bold text-slate-900">Property Data Admin</h1>
            <Badge className="bg-red-100 text-red-800 border-red-200">Admin Only</Badge>
          </div>
          <p className="text-slate-600 text-lg">Manage property data via manual entry or live data fetch</p>
        </div>

        {/* MCP Data Fetch Tool */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Fetch Live Properties (Airbnb)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Rate Limit Warning */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-semibold text-amber-900 mb-1">⚠️ API Rate Limits Apply</p>
                  <p className="text-amber-700">
                    The Airbnb API has daily/monthly limits. If you get a <strong>429 error</strong>, 
                    your rate limit has been reached. Check your{' '}
                    <a 
                      href="https://rapidapi.com/developer/dashboard" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="underline hover:text-amber-900"
                    >
                      RapidAPI Dashboard
                    </a>
                    {' '}for usage details.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <Label htmlFor="mcp-city">City Name</Label>
              <div className="flex gap-2 mt-2">
                <Input
                  id="mcp-city"
                  value={mcpCity}
                  onChange={(e) => setMcpCity(e.target.value)}
                  placeholder="e.g., London, Paris, New York"
                  className="rounded-xl"
                />
                <Button
                  onClick={handleMCPFetch}
                  disabled={mcpLoading}
                  className="bg-blue-600 hover:bg-blue-700 whitespace-nowrap"
                >
                  {mcpLoading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white mr-2" />
                      Fetching...
                    </>
                  ) : (
                    'Fetch Properties'
                  )}
                </Button>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Fetches live property listings from Airbnb and saves them to your database
              </p>
            </div>

            {mcpResult && (
              <div className={`p-4 rounded-xl ${
                mcpResult.success 
                  ? 'bg-green-50 border border-green-200' 
                  : 'bg-red-50 border border-red-200'
              }`}>
                {mcpResult.success ? (
                  <div>
                    <p className="font-semibold text-green-900 mb-2">✅ Success!</p>
                    <p className="text-sm text-green-800">{mcpResult.message}</p>
                    {mcpResult.errors && mcpResult.errors.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs text-green-700 cursor-pointer">View errors ({mcpResult.errors.length})</summary>
                        <pre className="text-xs mt-2 overflow-auto max-h-32 text-green-700">
                          {mcpResult.errors.join('\n')}
                        </pre>
                      </details>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="font-semibold text-red-900 mb-2">❌ Failed</p>
                    <p className="text-sm text-red-800">{mcpResult.message}</p>
                    
                    {/* Specific guidance for 429 errors */}
                    {mcpResult.message?.includes('429') && (
                      <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-xs font-semibold text-amber-900 mb-1">💡 Rate Limit Reached</p>
                        <p className="text-xs text-amber-800">
                          You've exceeded your API quota. Solutions:
                        </p>
                        <ul className="text-xs text-amber-800 list-disc list-inside mt-1 space-y-1">
                          <li>Wait for your rate limit to reset (check RapidAPI dashboard)</li>
                          <li>Upgrade your RapidAPI plan for more requests</li>
                          <li>Use existing database properties (Search page)</li>
                          <li>Add properties manually (form below)</li>
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* NEW: Tabs for Manual Entry and Property Management */}
        <Tabs value={activeAdminTab} onValueChange={setActiveAdminTab} className="space-y-6 mb-8">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="add-manual">
              <Plus className="w-4 h-4 mr-2" />
              {editingPropertyId ? 'Edit Property' : 'Add New Property'}
            </TabsTrigger>
            <TabsTrigger value="manage-properties">
              <List className="w-4 h-4 mr-2" />
              Manage Properties
            </TabsTrigger>
          </TabsList>

          <TabsContent value="add-manual">
            <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Plus className="w-6 h-6 text-amber-500" />
                  {editingPropertyId ? 'Edit Property' : 'Add New Property Manually'}
                </CardTitle>
                <CardDescription>
                  {editingPropertyId ? 'Update property information' : 'Enter property details to add to your listings'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {editingPropertyId && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
                    <p className="text-sm text-blue-900">
                      <strong>Editing:</strong> {propertyFormData.title} (ID: {editingPropertyId.substring(0,8)}...)
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => {
                        setEditingPropertyId(null);
                        setPropertyFormData({
                          title: '', description: '', location: { city: '', country: '', address: '' }, price_per_night: '', caution_fee: '', max_guests: '', bedrooms: '', bathrooms: '', property_type: 'apartment', amenities: '', images: [], videos: [], host_name: '', instant_book: false
                        });
                      }} className="mt-2 text-blue-600 hover:bg-blue-100">
                      <XCircle className="w-3 h-3 mr-1" /> Clear Edit
                    </Button>
                  </div>
                )}
                <form onSubmit={handlePropertyFormSubmit} className="space-y-6">
                  {/* Basic Information */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg text-slate-900 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" />
                      Basic Information
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="title">Title *</Label>
                        <Input
                          id="title"
                          value={propertyFormData.title}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, title: e.target.value }))}
                          placeholder="e.g., Luxury Downtown Apartment"
                          required
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="property_type">Property Type *</Label>
                        <Select
                          value={propertyFormData.property_type}
                          onValueChange={(value) => setPropertyFormData(prev => ({ ...prev, property_type: value }))}
                        >
                          <SelectTrigger className="w-full mt-1">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="apartment">Apartment</SelectItem>
                            <SelectItem value="house">House</SelectItem>
                            <SelectItem value="studio">Studio</SelectItem>
                            <SelectItem value="loft">Loft</SelectItem>
                            <SelectItem value="penthouse">Penthouse</SelectItem>
                            <SelectItem value="villa">Villa</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="description">Description</Label>
                      <textarea
                        id="description"
                        value={propertyFormData.description}
                        onChange={(e) => setPropertyFormData(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="Detailed description of the property"
                        rows={3}
                        className="mt-1 w-full rounded-md border border-slate-200 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <Label htmlFor="city">City *</Label>
                        <Input
                          id="city"
                          value={propertyFormData.location.city}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, location: { ...prev.location, city: e.target.value } }))}
                          placeholder="e.g., Lagos"
                          required
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="country">Country *</Label>
                        <Input
                          id="country"
                          value={propertyFormData.location.country}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, location: { ...prev.location, country: e.target.value } }))}
                          placeholder="e.g., Nigeria"
                          required
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="address">Address</Label>
                        <Input
                          id="address"
                          value={propertyFormData.location.address}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, location: { ...prev.location, address: e.target.value } }))}
                          placeholder="e.g., 123 Main Street"
                          className="mt-1"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Pricing */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg text-slate-900 flex items-center gap-2">
                      <DollarSign className="w-5 h-5 text-green-600" />
                      Pricing
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="price_per_night">Price per Night (NGN) *</Label>
                        <Input
                          id="price_per_night"
                          type="number"
                          required
                          value={propertyFormData.price_per_night}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, price_per_night: e.target.value }))}
                          placeholder="e.g., 50000"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="caution_fee">Refundable Caution Fee (NGN)</Label>
                        <Input
                          id="caution_fee"
                          type="number"
                          value={propertyFormData.caution_fee}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, caution_fee: e.target.value }))}
                          placeholder="e.g., 20000"
                          className="mt-1"
                        />
                        <p className="text-xs text-slate-500 mt-1">Optional refundable deposit for property security</p>
                      </div>
                    </div>
                  </div>

                  {/* Property Details */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg text-slate-900 flex items-center gap-2">
                      <List className="w-5 h-5 text-purple-600" />
                      Property Details
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <Label htmlFor="max_guests">Max Guests *</Label>
                        <Input
                          id="max_guests"
                          type="number"
                          required
                          value={propertyFormData.max_guests}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, max_guests: e.target.value }))}
                          placeholder="e.g., 4"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="bedrooms">Bedrooms</Label>
                        <Input
                          id="bedrooms"
                          type="number"
                          value={propertyFormData.bedrooms}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, bedrooms: e.target.value }))}
                          placeholder="e.g., 2"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="bathrooms">Bathrooms</Label>
                        <Input
                          id="bathrooms"
                          type="number"
                          value={propertyFormData.bathrooms}
                          onChange={(e) => setPropertyFormData(prev => ({ ...prev, bathrooms: e.target.value }))}
                          placeholder="e.g., 1"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="amenities">Amenities (comma-separated)</Label>
                      <Input
                        id="amenities"
                        value={propertyFormData.amenities}
                        onChange={(e) => setPropertyFormData(prev => ({ ...prev, amenities: e.target.value }))}
                        placeholder="e.g., wifi, kitchen, parking"
                        className="mt-1"
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        Common: wifi, kitchen, parking, pool, gym, balcony, air_conditioning, heating, washer, dryer, pets_allowed, smoking_allowed, workspace
                      </p>
                    </div>
                  </div>

                  {/* Media */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg text-slate-900 flex items-center gap-2">
                      <ImageIcon className="w-5 h-5 text-red-600" />
                      Media
                    </h3>
                    <div>
                      <Label htmlFor="image-upload">Property Images</Label>
                      <div className="mt-2 flex items-center gap-4">
                        <Input
                          id="image-upload"
                          type="file"
                          multiple
                          accept="image/*"
                          onChange={handleImageUpload}
                          disabled={isUploadingImages}
                          className="flex-1 rounded-xl border-slate-200 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                        />
                        {isUploadingImages && (
                          <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-300 border-t-slate-900" />
                        )}
                      </div>
                      {propertyFormData.images.length > 0 && (
                        <div className="mt-4 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
                          {propertyFormData.images.map((url, index) => (
                            <div key={index} className="relative group aspect-square">
                              <img src={url} alt={`Property image ${index + 1}`} className="w-full h-full object-cover rounded-xl shadow-md" />
                              <button
                                type="button"
                                onClick={() => handleRemoveImage(url)}
                                className="absolute top-1 right-1 bg-red-600/80 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="video-upload">Property Videos</Label>
                      <div className="mt-2 flex items-center gap-4">
                        <Input
                          id="video-upload"
                          type="file"
                          multiple
                          accept="video/*"
                          onChange={handleVideoUpload}
                          disabled={isUploadingVideos}
                          className="flex-1 rounded-xl border-slate-200 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                        />
                        {isUploadingVideos && (
                          <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-300 border-t-slate-900" />
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        Supported formats: MP4, WebM, AVI, MOV (Max size: 100MB per video)
                      </p>
                      {propertyFormData.videos.length > 0 && (
                        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                          {propertyFormData.videos.map((url, index) => (
                            <div key={index} className="relative group aspect-video">
                              <video 
                                src={url} 
                                className="w-full h-full object-cover rounded-xl shadow-md"
                                controls={false}
                                preload="metadata"
                              />
                              <div className="absolute inset-0 bg-black/20 rounded-xl flex items-center justify-center">
                                <Play className="w-8 h-8 text-white opacity-80" />
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRemoveVideo(url)}
                                className="absolute top-1 right-1 bg-red-600/80 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Host Information */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg text-slate-900 flex items-center gap-2">
                      <Shield className="w-5 h-5 text-blue-400" />
                      Host Information
                    </h3>
                    <div>
                      <Label htmlFor="host_name">Host Name</Label>
                      <Input
                        id="host_name"
                        value={propertyFormData.host_name}
                        onChange={(e) => setPropertyFormData(prev => ({ ...prev, host_name: e.target.value }))}
                        placeholder="e.g., John Doe"
                        className="mt-1"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="instant_book"
                        checked={propertyFormData.instant_book}
                        onChange={(e) => setPropertyFormData(prev => ({ ...prev, instant_book: e.target.checked }))}
                        className="rounded border-slate-300 text-blue-600 shadow-sm focus:ring-blue-500"
                      />
                      <Label htmlFor="instant_book" className="text-sm font-semibold text-slate-700">
                        Instant Book Available
                      </Label>
                    </div>
                  </div>

                  <div className="flex justify-end space-x-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setEditingPropertyId(null); // Clear editing state on cancel
                        setPropertyFormData({ // Reset form data
                          title: '', description: '', location: { city: '', country: '', address: '' }, price_per_night: '', caution_fee: '', max_guests: '', bedrooms: '', bathrooms: '', property_type: 'apartment', amenities: '', images: [], videos: [], host_name: '', instant_book: false
                        });
                        setActiveAdminTab('manage-properties'); // Go back to manage tab
                      }}
                      disabled={isSavingProperty}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={isSavingProperty || isUploadingImages || isUploadingVideos}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      {isSavingProperty ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white mr-2" />
                          {editingPropertyId ? 'Updating...' : 'Adding Property...'}
                        </>
                      ) : (
                        editingPropertyId ? 'Update Property' : 'Add Property'
                      )}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="manage-properties">
            <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <List className="w-5 h-5" />
                    Property Management ({properties.length} properties)
                  </CardTitle>
                  <Button
                    onClick={loadProperties}
                    disabled={isLoadingProperties}
                    variant="outline"
                    size="sm"
                  >
                    {isLoadingProperties ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      'Refresh List'
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingProperties ? (
                  <div className="text-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-slate-400" />
                    <p className="text-slate-500">Loading properties...</p>
                  </div>
                ) : properties.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <Database className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                    <p>No properties found.</p>
                    <p className="text-sm mt-2">Add properties using the form or fetch live data.</p>
                    <Button onClick={() => setActiveAdminTab('add-manual')} className="mt-4">
                      <Plus className="w-4 h-4 mr-2" /> Add Property
                    </Button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b-2 border-slate-200">
                        <tr>
                          <th className="text-left p-3 font-semibold text-slate-700">Property</th>
                          <th className="text-left p-3 font-semibold text-slate-700">Location</th>
                          <th className="text-left p-3 font-semibold text-slate-700">Price/Night</th>
                          <th className="text-left p-3 font-semibold text-slate-700">Caution Fee</th>
                          <th className="text-left p-3 font-semibold text-slate-700">Type</th>
                          <th className="text-left p-3 font-semibold text-slate-700">Source</th>
                          <th className="text-right p-3 font-semibold text-slate-700">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {properties.map((property) => (
                          <tr key={property.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                            <td className="p-3">
                              <div className="flex items-center gap-3">
                                <img 
                                  src={property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=100'} 
                                  alt={property.title}
                                  className="w-12 h-12 rounded-lg object-cover"
                                />
                                <div>
                                  <p className="font-medium text-slate-900">{property.title}</p>
                                  <p className="text-xs text-slate-500">ID: {property.id.substring(0, 8)}...</p>
                                </div>
                              </div>
                            </td>
                            <td className="p-3 text-sm text-slate-600">
                              {property.location?.city}, {property.location?.country}
                            </td>
                            <td className="p-3 font-semibold text-slate-900">
                              ₦{property.price_per_night?.toLocaleString()}
                            </td>
                            <td className="p-3 text-slate-600">
                              {property.caution_fee > 0 ? (
                                <span className="text-sm">₦{property.caution_fee?.toLocaleString()}</span>
                              ) : (
                                <span className="text-xs text-slate-400">None</span>
                              )}
                            </td>
                            <td className="p-3">
                              <Badge variant="outline" className="capitalize">
                                {property.property_type}
                              </Badge>
                            </td>
                            <td className="p-3">
                              <Badge className={property.source === 'manual' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}>
                                {property.source}
                              </Badge>
                            </td>
                            <td className="p-3">
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleEditProperty(property)}
                                >
                                  <Edit className="w-4 h-4" />
                                </Button>
                                <Button
                                  onClick={() => handleDeleteClick(property)}
                                  variant="outline"
                                  size="sm"
                                  disabled={deletingPropertyId === property.id}
                                  className="text-red-600 hover:bg-red-50 border-red-200"
                                >
                                  {deletingPropertyId === property.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <>
                                      <Trash2 className="w-4 h-4" />
                                    </>
                                  )}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Property</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this property?
                {propertyToDelete && (
                  <div className="mt-3 p-3 bg-slate-50 rounded-lg">
                    <p className="font-semibold text-slate-900">{propertyToDelete.title}</p>
                    <p className="text-sm text-slate-600 mt-1">
                      {propertyToDelete.location?.city}, {propertyToDelete.location?.country}
                    </p>
                  </div>
                )}
                <p className="mt-3 text-red-600 font-semibold">
                  This action cannot be undone.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => {
                setShowDeleteDialog(false);
                setPropertyToDelete(null);
              }}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Property
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Support Inbox Section */}
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Support Inbox
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6" style={{ minHeight: '500px' }}>
              {/* Ticket List */}
              <div className="md:col-span-1 border-r border-slate-200 pr-4 max-h-[500px] overflow-y-auto">
                <h3 className="font-semibold text-slate-800 mb-3">Open Tickets ({supportTickets.filter(t => t.status !== 'closed' && t.status !== 'resolved').length})</h3>
                {isLoadingTickets ? (
                  <p>Loading tickets...</p>
                ) : (
                  <div className="space-y-2">
                    {supportTickets.filter(t => t.status !== 'closed' && t.status !== 'resolved').map(ticket => (
                      <div
                        key={ticket.id}
                        onClick={() => handleSelectTicket(ticket)}
                        className={`p-3 rounded-lg cursor-pointer transition-colors ${selectedTicket?.id === ticket.id ? 'bg-blue-50 border-blue-200 border' : 'hover:bg-slate-50 border border-transparent'}`}
                      >
                        <p className="font-semibold text-sm truncate">{ticket.subject}</p>
                        <p className="text-xs text-slate-500 truncate">{ticket.user_email}</p>
                        <Badge variant="outline" className="mt-1 text-xs capitalize">{ticket.status.replace('_', ' ')}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Chat View */}
              <div className="md:col-span-2 flex flex-col">
                {selectedTicket ? (
                  <>
                    <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-200">
                      <div>
                        <h3 className="font-bold text-slate-900">{selectedTicket.subject}</h3>
                        <p className="text-sm text-slate-600">From: {selectedTicket.user_email}</p>
                      </div>
                      <div>
                        <Select value={selectedTicket.status} onValueChange={handleUpdateTicketStatus}>
                          <SelectTrigger className="w-[180px] rounded-xl">
                            <SelectValue placeholder="Update status" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="open">Open</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="resolved">Resolved</SelectItem>
                            <SelectItem value="closed">Closed</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex-1 bg-slate-50 rounded-xl p-4 overflow-y-auto space-y-4 mb-4" style={{ minHeight: '300px' }}>
                      {ticketMessages.map((message, index) => (
                        <div key={index} className={`flex w-full ${message.sender_type === 'user' ? 'justify-start' : 'justify-end'}`}>
                            <div className={`p-3 rounded-xl max-w-md ${message.sender_type === 'user' ? 'bg-white border' : 'bg-blue-600 text-white'}`}>
                                <p className="text-sm whitespace-pre-wrap">{message.message}</p>
                                <p className={`text-xs mt-1 text-right ${message.sender_type === 'user' ? 'text-slate-400' : 'text-blue-200'}`}>
                                  {new Date(message.created_date).toLocaleTimeString()}
                                </p>
                            </div>
                        </div>
                      ))}
                      {ticketMessages.length === 0 && <p className="text-center text-slate-500">No messages yet.</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Type your reply..."
                        value={adminReply}
                        onChange={(e) => setAdminReply(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSendAdminReply()}
                        disabled={isSendingReply}
                        className="rounded-xl"
                      />
                      <Button onClick={handleSendAdminReply} disabled={isSendingReply || !adminReply.trim()} className="rounded-xl">
                        {isSendingReply ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <Send className="w-4 h-4" />}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-center text-slate-500">
                    <div>
                      <MessageSquare className="w-12 h-12 mx-auto mb-2" />
                      <p>Select a ticket to view the conversation.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone Card */}
        <Card className="bg-red-50/90 border-red-200 rounded-3xl shadow-lg mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-800">
              <AlertTriangle className="w-5 h-5" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-700 mb-4">
              This is a high-risk area. Actions performed here are permanent and can result in data loss. Proceed with extreme caution.
            </p>
            <Button
              variant="destructive"
              onClick={handleDeleteAllProperties}
              disabled={isDeleting}
              className="w-full bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete All Properties
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Removed File Upload, Sample CSV, Data Preview, Import Results */}
        {/* The global isProcessing modal is also removed */}
      </div>
    </div>
  );
}
