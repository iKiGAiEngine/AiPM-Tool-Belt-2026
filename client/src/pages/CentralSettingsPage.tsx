import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Building2, Package, Plus, Pencil, Trash2, Search, X, BookOpen, MapPin, FolderArchive, FileSpreadsheet, Upload, Download, Check, Star, FileSearch, Save, History, RotateCcw, Tag, CheckCircle, ClipboardList, FileUp, AlertTriangle, Mail } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Vendor, Div10Product, ScopeDictionary, Region, FolderTemplate, EstimateTemplate, StampMapping, SpecsiftConfig, AccessoryScopeData } from "@shared/schema";
import { DIV10_SCOPE_CATEGORIES, PLAN_PARSER_SCOPES } from "@shared/schema";
import { useAuth } from "@/lib/auth";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { Lock } from "lucide-react";

export default function CentralSettingsPage() {
  const { isAdmin } = useAuth();
  const { hasFeature } = useFeatureAccess();
  const hasFullSettings = isAdmin || hasFeature("central-settings");
  const regionsOnly = !hasFullSettings && hasFeature("settings-regions");
  const [activeTab, setActiveTab] = useState(regionsOnly ? "regions" : "vendors");

  useEffect(() => {
    if (regionsOnly && activeTab !== "regions") setActiveTab("regions");
  }, [regionsOnly, activeTab]);

  const handleTabChange = (val: string) => {
    if (regionsOnly && val !== "regions") return;
    setActiveTab(val);
  };

  const lockIcon = regionsOnly ? <Lock className="w-3 h-3 ml-1 opacity-60" /> : null;

  return (
    <div className="container max-w-6xl mx-auto py-8 px-4 animate-page-enter">
      <div className="flex items-center gap-4 mb-8">
        <BackNav href="/" label="Home" testId="button-back" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-foreground font-heading">{regionsOnly ? "Settings — Regions" : "Settings"}</h1>
          <p className="text-muted-foreground">{regionsOnly ? "You have access to the Regions tab. Other tabs are visible but restricted to admins." : "Manage vendors, products, scope dictionaries, regions, templates, spec extraction, and email notifications"}</p>
        </div>
        <Link href="/tools/bc-sync-table">
          <Button variant="outline" className="gap-2" data-testid="button-bc-sync-table">
            <ClipboardList className="w-4 h-4" />
            BC Sync Table
          </Button>
        </Link>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="flex flex-wrap gap-1 max-w-5xl">
          <TabsTrigger value="vendors" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-vendors" title={regionsOnly ? "Restricted to admins" : undefined}>
            <Building2 className="w-4 h-4" />
            Vendors{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="products" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-products" title={regionsOnly ? "Restricted to admins" : undefined}>
            <Package className="w-4 h-4" />
            Products{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="scopes" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-scopes" title={regionsOnly ? "Restricted to admins" : undefined}>
            <BookOpen className="w-4 h-4" />
            Scopes{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="regions" className="gap-2" data-testid="tab-regions">
            <MapPin className="w-4 h-4" />
            Regions
          </TabsTrigger>
          <TabsTrigger value="folder-templates" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-folder-templates" title={regionsOnly ? "Restricted to admins" : undefined}>
            <FolderArchive className="w-4 h-4" />
            Folders{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="estimate-templates" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-estimate-templates" title={regionsOnly ? "Restricted to admins" : undefined}>
            <FileSpreadsheet className="w-4 h-4" />
            Estimates{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="spec-extractor" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-spec-extractor" title={regionsOnly ? "Restricted to admins" : undefined}>
            <FileSearch className="w-4 h-4" />
            Spec Extractor{lockIcon}
          </TabsTrigger>
          <TabsTrigger value="email-templates" className={`gap-2 ${regionsOnly ? "opacity-50 cursor-not-allowed" : ""}`} data-testid="tab-email-templates" title={regionsOnly ? "Restricted to admins" : undefined}>
            <Mail className="w-4 h-4" />
            Email Templates{lockIcon}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="vendors">
          <VendorSection />
        </TabsContent>

        <TabsContent value="products">
          <ProductSection />
        </TabsContent>

        <TabsContent value="scopes">
          <ScopeDictionarySection />
        </TabsContent>

        <TabsContent value="regions">
          <RegionSection />
        </TabsContent>

        <TabsContent value="folder-templates">
          <FolderTemplateSection />
        </TabsContent>

        <TabsContent value="estimate-templates">
          <EstimateTemplateSection />
        </TabsContent>

        <TabsContent value="spec-extractor">
          <SpecExtractorSettingsSection />
        </TabsContent>

        <TabsContent value="email-templates">
          <EmailTemplateSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VendorSection() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: vendors = [], isLoading } = useQuery<Vendor[]>({
    queryKey: ["/api/settings/vendors"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/settings/vendors/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/vendors"] });
      toast({ title: "Vendor deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete vendor", variant: "destructive" });
    },
  });

  const filteredVendors = vendors.filter(
    (v) =>
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.shortName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading">Vendor Profiles</CardTitle>
            <CardDescription>
              Manage vendor information and quote parsing patterns
            </CardDescription>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="button-import-vendors">
                <FileUp className="w-4 h-4 mr-2" />
                Import
              </Button>
              <Button onClick={() => setIsAddDialogOpen(true)} data-testid="button-add-vendor">
                <Plus className="w-4 h-4 mr-2" />
                Add Vendor
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search vendors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-vendors"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading vendors...</div>
        ) : filteredVendors.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {searchQuery ? "No vendors found" : "No vendors added yet. Click 'Add Vendor' to get started."}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredVendors.map((vendor) => (
              <div
                key={vendor.id}
                className="flex items-center justify-between p-4 rounded-lg border bg-card"
                data-testid={`vendor-row-${vendor.id}`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{vendor.name}</span>
                    {vendor.shortName && (
                      <Badge variant="secondary">{vendor.shortName}</Badge>
                    )}
                    {!vendor.isActive && (
                      <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                    )}
                  </div>
                  {vendor.modelPrefixes && vendor.modelPrefixes.length > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs text-muted-foreground">Model prefixes:</span>
                      {vendor.modelPrefixes.map((prefix, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{prefix}</Badge>
                      ))}
                    </div>
                  )}
                  {vendor.notes && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-1">{vendor.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingVendor(vendor)}
                    data-testid={`button-edit-vendor-${vendor.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm("Delete this vendor?")) {
                          deleteMutation.mutate(vendor.id);
                        }
                      }}
                      data-testid={`button-delete-vendor-${vendor.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <VendorDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        vendor={null}
        mode="add"
      />

      {editingVendor && (
        <VendorDialog
          open={!!editingVendor}
          onOpenChange={(open) => !open && setEditingVendor(null)}
          vendor={editingVendor}
          mode="edit"
        />
      )}

      <BulkImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        title="Vendors"
        importEndpoint="/api/settings/vendors/bulk-import"
        invalidateKey="/api/settings/vendors"
        templateUrl="/templates/vendors-import-template.xlsx"
        columns={[
          { key: "name", label: "Name", required: true },
          { key: "shortName", label: "Short Name" },
          { key: "modelPrefixes", label: "Model Prefixes" },
          { key: "contactEmail", label: "Email" },
          { key: "contactPhone", label: "Phone" },
          { key: "website", label: "Website" },
          { key: "notes", label: "Notes" },
        ]}
      />
    </Card>
  );
}

interface VendorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: Vendor | null;
  mode: "add" | "edit";
}

function VendorDialog({ open, onOpenChange, vendor, mode }: VendorDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState(vendor?.name ?? "");
  const [shortName, setShortName] = useState(vendor?.shortName ?? "");
  const [modelPrefixes, setModelPrefixes] = useState(vendor?.modelPrefixes?.join(", ") ?? "");
  const [quotePatterns, setQuotePatterns] = useState(vendor?.quotePatterns?.join("\n") ?? "");
  const [contactEmail, setContactEmail] = useState(vendor?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(vendor?.contactPhone ?? "");
  const [website, setWebsite] = useState(vendor?.website ?? "");
  const [notes, setNotes] = useState(vendor?.notes ?? "");

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Vendor>) => {
      await apiRequest("POST", "/api/settings/vendors", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/vendors"] });
      toast({ title: "Vendor created" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to create vendor", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Vendor>) => {
      await apiRequest("PUT", `/api/settings/vendors/${vendor?.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/vendors"] });
      toast({ title: "Vendor updated" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to update vendor", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    const data = {
      name,
      shortName: shortName || null,
      modelPrefixes: modelPrefixes.split(",").map((s) => s.trim()).filter(Boolean),
      quotePatterns: quotePatterns.split("\n").map((s) => s.trim()).filter(Boolean),
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      website: website || null,
      notes: notes || null,
    };

    if (mode === "add") {
      createMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Vendor" : "Edit Vendor"}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "Add a new vendor profile for quote parsing"
              : "Update vendor information and parsing patterns"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Vendor Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Activar/Maxam"
                data-testid="input-vendor-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortName">Short Name</Label>
              <Input
                id="shortName"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                placeholder="e.g., Activar"
                data-testid="input-vendor-shortname"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="modelPrefixes">Model Prefixes (comma-separated)</Label>
            <Input
              id="modelPrefixes"
              value={modelPrefixes}
              onChange={(e) => setModelPrefixes(e.target.value)}
              placeholder="e.g., FEA, C2037, B-"
              data-testid="input-vendor-prefixes"
            />
            <p className="text-xs text-muted-foreground">
              Model number prefixes to help identify products from this vendor
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="quotePatterns">Quote Identification Patterns (one per line)</Label>
            <Textarea
              id="quotePatterns"
              value={quotePatterns}
              onChange={(e) => setQuotePatterns(e.target.value)}
              placeholder="e.g., ACTIVAR CONSTRUCTION&#10;MAXAM&#10;SQ02630"
              rows={3}
              data-testid="input-vendor-patterns"
            />
            <p className="text-xs text-muted-foreground">
              Text patterns that identify quotes from this vendor
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contactEmail">Email</Label>
              <Input
                id="contactEmail"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="sales@vendor.com"
                data-testid="input-vendor-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactPhone">Phone</Label>
              <Input
                id="contactPhone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="(555) 123-4567"
                data-testid="input-vendor-phone"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="website">Website</Label>
            <Input
              id="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://www.vendor.com"
              data-testid="input-vendor-website"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes about this vendor..."
              rows={2}
              data-testid="input-vendor-notes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name || createMutation.isPending || updateMutation.isPending}
            data-testid="button-save-vendor"
          >
            {mode === "add" ? "Add Vendor" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductSection() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [editingProduct, setEditingProduct] = useState<Div10Product | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: products = [], isLoading } = useQuery<Div10Product[]>({
    queryKey: ["/api/settings/products"],
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/settings/vendors"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/settings/products/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/products"] });
      toast({ title: "Product deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete product", variant: "destructive" });
    },
  });

  const filteredProducts = products.filter((p) => {
    const matchesSearch =
      p.modelNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.manufacturer?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesScope = scopeFilter === "all" || p.scopeCategory === scopeFilter;
    return matchesSearch && matchesScope;
  });

  const groupedProducts = filteredProducts.reduce((acc, product) => {
    const scope = product.scopeCategory;
    if (!acc[scope]) acc[scope] = [];
    acc[scope].push(product);
    return acc;
  }, {} as Record<string, Div10Product[]>);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading">Division 10 Product Dictionary</CardTitle>
            <CardDescription>
              Manage known products and model numbers for better quote parsing
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="button-import-products">
              <FileUp className="w-4 h-4 mr-2" />
              Import
            </Button>
            <Button onClick={() => setIsAddDialogOpen(true)} data-testid="button-add-product">
              <Plus className="w-4 h-4 mr-2" />
              Add Product
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-products"
            />
          </div>
          <Select value={scopeFilter} onValueChange={setScopeFilter}>
            <SelectTrigger className="w-[200px]" data-testid="select-scope-filter">
              <SelectValue placeholder="All scopes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Scopes</SelectItem>
              {DIV10_SCOPE_CATEGORIES.map((scope) => (
                <SelectItem key={scope} value={scope}>{scope}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading products...</div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {searchQuery || scopeFilter !== "all"
              ? "No products found"
              : "No products added yet. Click 'Add Product' to get started."}
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedProducts).map(([scope, scopeProducts]) => (
              <div key={scope}>
                <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2 font-heading">
                  {scope}
                  <Badge variant="secondary">{scopeProducts.length}</Badge>
                </h3>
                <div className="space-y-2">
                  {scopeProducts.map((product) => (
                    <div
                      key={product.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card"
                      data-testid={`product-row-${product.id}`}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium">{product.modelNumber}</span>
                          {product.manufacturer && (
                            <Badge variant="outline">{product.manufacturer}</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
                          {product.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingProduct(product)}
                          data-testid={`button-edit-product-${product.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm("Delete this product?")) {
                              deleteMutation.mutate(product.id);
                            }
                          }}
                          data-testid={`button-delete-product-${product.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ProductDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        product={null}
        vendors={vendors}
        mode="add"
      />

      {editingProduct && (
        <ProductDialog
          open={!!editingProduct}
          onOpenChange={(open) => !open && setEditingProduct(null)}
          product={editingProduct}
          vendors={vendors}
          mode="edit"
        />
      )}

      <BulkImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        title="Products"
        importEndpoint="/api/settings/products/bulk-import"
        invalidateKey="/api/settings/products"
        templateUrl="/templates/products-import-template.xlsx"
        columns={[
          { key: "modelNumber", label: "Model Number", required: true },
          { key: "description", label: "Description", required: true },
          { key: "manufacturer", label: "Manufacturer" },
          { key: "scopeCategory", label: "Scope Category" },
          { key: "aliases", label: "Aliases" },
          { key: "typicalPrice", label: "Typical Price" },
          { key: "notes", label: "Notes" },
        ]}
      />
    </Card>
  );
}

interface ProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Div10Product | null;
  vendors: Vendor[];
  mode: "add" | "edit";
}

function ProductDialog({ open, onOpenChange, product, vendors, mode }: ProductDialogProps) {
  const { toast } = useToast();
  const [modelNumber, setModelNumber] = useState(product?.modelNumber ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [manufacturer, setManufacturer] = useState(product?.manufacturer ?? "");
  const [scopeCategory, setScopeCategory] = useState(product?.scopeCategory ?? "");
  const [vendorId, setVendorId] = useState<string>(product?.vendorId?.toString() ?? "");
  const [aliases, setAliases] = useState(product?.aliases?.join(", ") ?? "");
  const [typicalPrice, setTypicalPrice] = useState(product?.typicalPrice ?? "");
  const [notes, setNotes] = useState(product?.notes ?? "");

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Div10Product>) => {
      await apiRequest("POST", "/api/settings/products", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/products"] });
      toast({ title: "Product created" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to create product", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Div10Product>) => {
      await apiRequest("PUT", `/api/settings/products/${product?.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/products"] });
      toast({ title: "Product updated" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to update product", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    const data = {
      modelNumber,
      description,
      manufacturer: manufacturer || null,
      scopeCategory,
      vendorId: vendorId ? parseInt(vendorId) : null,
      aliases: aliases.split(",").map((s) => s.trim()).filter(Boolean),
      typicalPrice: typicalPrice || null,
      notes: notes || null,
    };

    if (mode === "add") {
      createMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Product" : "Edit Product"}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "Add a new product to the Division 10 dictionary"
              : "Update product information"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="modelNumber">Model Number *</Label>
              <Input
                id="modelNumber"
                value={modelNumber}
                onChange={(e) => setModelNumber(e.target.value)}
                placeholder="e.g., B-2111"
                className="font-mono"
                data-testid="input-product-model"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manufacturer">Manufacturer</Label>
              <Input
                id="manufacturer"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="e.g., Bobrick"
                data-testid="input-product-manufacturer"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description *</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Paper Towel Dispenser, Surface Mounted"
              rows={2}
              data-testid="input-product-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="scopeCategory">Scope Category *</Label>
              <Select value={scopeCategory} onValueChange={setScopeCategory}>
                <SelectTrigger data-testid="select-product-scope">
                  <SelectValue placeholder="Select scope..." />
                </SelectTrigger>
                <SelectContent>
                  {DIV10_SCOPE_CATEGORIES.map((scope) => (
                    <SelectItem key={scope} value={scope}>{scope}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendorId">Vendor</Label>
              <Select value={vendorId || "none"} onValueChange={(val) => setVendorId(val === "none" ? "" : val)}>
                <SelectTrigger data-testid="select-product-vendor">
                  <SelectValue placeholder="Select vendor..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id.toString()}>
                      {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="aliases">Aliases (comma-separated)</Label>
            <Input
              id="aliases"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="e.g., B2111, 2111"
              data-testid="input-product-aliases"
            />
            <p className="text-xs text-muted-foreground">
              Alternative model numbers or names for this product
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="typicalPrice">Typical Price</Label>
              <Input
                id="typicalPrice"
                value={typicalPrice}
                onChange={(e) => setTypicalPrice(e.target.value)}
                placeholder="e.g., $185.00"
                data-testid="input-product-price"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes about this product..."
              rows={2}
              data-testid="input-product-notes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!modelNumber || !description || !scopeCategory || createMutation.isPending || updateMutation.isPending}
            data-testid="button-save-product"
          >
            {mode === "add" ? "Add Product" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeDictionarySection() {
  const { toast } = useToast();
  const [editingScope, setEditingScope] = useState<ScopeDictionary | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: dictionaries = [], isLoading } = useQuery<ScopeDictionary[]>({
    queryKey: ["/api/scope-dictionaries"],
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/scope-dictionaries/seed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scope-dictionaries"] });
      toast({ title: "Default scope dictionaries loaded" });
    },
    onError: () => {
      toast({ title: "Failed to seed defaults", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/scope-dictionaries/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scope-dictionaries"] });
      toast({ title: "Scope dictionary deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="font-heading">Scope Dictionaries</CardTitle>
            <CardDescription>
              Manage keywords per scope type for Plan Parser and Spec Extractor relevance scoring
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {dictionaries.length === 0 && (
              <Button
                variant="outline"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
                data-testid="button-seed-scopes"
              >
                Load Defaults
              </Button>
            )}
            <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="button-import-scopes">
              <FileUp className="w-4 h-4 mr-2" />
              Import
            </Button>
            <Button onClick={() => setIsAddDialogOpen(true)} data-testid="button-add-scope">
              <Plus className="w-4 h-4 mr-2" />
              Add Scope
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading scope dictionaries...</div>
        ) : dictionaries.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No scope dictionaries configured. Click 'Load Defaults' to populate from built-in keywords, or add custom scopes.
          </div>
        ) : (
          <div className="space-y-3">
            {dictionaries.map((dict) => (
              <div
                key={dict.id}
                className="flex items-start justify-between gap-4 p-4 rounded-lg border bg-card"
                data-testid={`scope-row-${dict.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{dict.scopeName}</span>
                    <Badge variant="secondary">Weight: {dict.weight}%</Badge>
                    {!dict.isActive && (
                      <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(dict.includeKeywords || []).slice(0, 8).map((kw, i) => (
                      <Badge key={i} variant="outline" className="text-xs font-normal">{kw}</Badge>
                    ))}
                    {(dict.includeKeywords || []).length > 8 && (
                      <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                        +{(dict.includeKeywords || []).length - 8} more
                      </Badge>
                    )}
                  </div>
                  {(dict.boostPhrases || []).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="text-xs text-muted-foreground mr-1">Boost:</span>
                      {(dict.boostPhrases || []).map((bp, i) => (
                        <Badge key={i} variant="secondary" className="text-xs font-normal">{bp}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingScope(dict)}
                    data-testid={`button-edit-scope-${dict.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (confirm("Delete this scope dictionary?")) {
                        deleteMutation.mutate(dict.id);
                      }
                    }}
                    data-testid={`button-delete-scope-${dict.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ScopeDictionaryDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        scopeDict={null}
        mode="add"
      />

      {editingScope && (
        <ScopeDictionaryDialog
          open={!!editingScope}
          onOpenChange={(open) => !open && setEditingScope(null)}
          scopeDict={editingScope}
          mode="edit"
        />
      )}

      <BulkImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        title="Scope Dictionaries"
        importEndpoint="/api/scope-dictionaries/bulk-import"
        invalidateKey="/api/scope-dictionaries"
        templateUrl="/templates/scopes-import-template.xlsx"
        columns={[
          { key: "scopeName", label: "Scope Name", required: true },
          { key: "includeKeywords", label: "Include Keywords" },
          { key: "boostPhrases", label: "Boost Phrases" },
          { key: "excludeKeywords", label: "Exclude Keywords" },
          { key: "weight", label: "Weight" },
          { key: "specSectionNumbers", label: "Spec Section Numbers" },
        ]}
      />
    </Card>
  );
}

interface ScopeDictionaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeDict: ScopeDictionary | null;
  mode: "add" | "edit";
}

function ScopeDictionaryDialog({ open, onOpenChange, scopeDict, mode }: ScopeDictionaryDialogProps) {
  const { toast } = useToast();
  const [scopeName, setScopeName] = useState(scopeDict?.scopeName ?? "");
  const [includeKeywords, setIncludeKeywords] = useState((scopeDict?.includeKeywords || []).join(", "));
  const [boostPhrases, setBoostPhrases] = useState((scopeDict?.boostPhrases || []).join(", "));
  const [excludeKeywords, setExcludeKeywords] = useState((scopeDict?.excludeKeywords || []).join(", "));
  const [weight, setWeight] = useState(scopeDict?.weight?.toString() ?? "100");
  const [specSectionNumbers, setSpecSectionNumbers] = useState((scopeDict?.specSectionNumbers || []).join(", "));
  const [isActive, setIsActive] = useState(scopeDict?.isActive ?? true);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/scope-dictionaries", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scope-dictionaries"] });
      toast({ title: "Scope dictionary created" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to create scope dictionary", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("PUT", `/api/scope-dictionaries/${scopeDict?.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scope-dictionaries"] });
      toast({ title: "Scope dictionary updated" });
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to update scope dictionary", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    const data = {
      scopeName,
      includeKeywords: includeKeywords.split(",").map((s) => s.trim()).filter(Boolean),
      boostPhrases: boostPhrases.split(",").map((s) => s.trim()).filter(Boolean),
      excludeKeywords: excludeKeywords.split(",").map((s) => s.trim()).filter(Boolean),
      weight: parseInt(weight) || 100,
      specSectionNumbers: specSectionNumbers.split(",").map((s) => s.trim()).filter(Boolean),
      isActive,
    };

    if (mode === "add") {
      createMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Scope Dictionary" : "Edit Scope Dictionary"}</DialogTitle>
          <DialogDescription>
            Define keywords and boost phrases used by Plan Parser and Spec Extractor for relevance scoring
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="scopeName">Scope Name *</Label>
              {mode === "add" ? (
                <Select value={scopeName} onValueChange={setScopeName}>
                  <SelectTrigger data-testid="select-scope-name">
                    <SelectValue placeholder="Select scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAN_PARSER_SCOPES.map((scope) => (
                      <SelectItem key={scope} value={scope}>{scope}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="scopeName"
                  value={scopeName}
                  disabled
                  data-testid="input-scope-name"
                />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="weight">Weight (%)</Label>
              <Input
                id="weight"
                type="number"
                min="1"
                max="200"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                data-testid="input-scope-weight"
              />
              <p className="text-xs text-muted-foreground">100 = normal, 50 = half weight, 150 = boosted</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="includeKeywords">Include Keywords (comma-separated)</Label>
            <Textarea
              id="includeKeywords"
              value={includeKeywords}
              onChange={(e) => setIncludeKeywords(e.target.value)}
              placeholder="toilet accessories, grab bar, soap dispenser, paper towel..."
              rows={4}
              data-testid="input-include-keywords"
            />
            <p className="text-xs text-muted-foreground">
              Keywords that indicate a page belongs to this scope
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="boostPhrases">Boost Phrases (comma-separated)</Label>
            <Textarea
              id="boostPhrases"
              value={boostPhrases}
              onChange={(e) => setBoostPhrases(e.target.value)}
              placeholder="toilet accessory schedule, restroom accessory..."
              rows={2}
              data-testid="input-boost-phrases"
            />
            <p className="text-xs text-muted-foreground">
              Phrases that strongly confirm this scope (double weight)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="excludeKeywords">Exclude Keywords (comma-separated)</Label>
            <Textarea
              id="excludeKeywords"
              value={excludeKeywords}
              onChange={(e) => setExcludeKeywords(e.target.value)}
              placeholder="signage, wayfinding, room sign..."
              rows={2}
              data-testid="input-exclude-keywords"
            />
            <p className="text-xs text-muted-foreground">
              Keywords that should reduce confidence for this scope
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="specSectionNumbers">Spec Section Numbers (comma-separated)</Label>
            <Input
              id="specSectionNumbers"
              value={specSectionNumbers}
              onChange={(e) => setSpecSectionNumbers(e.target.value)}
              placeholder="10 28, 102800"
              data-testid="input-spec-sections"
            />
            <p className="text-xs text-muted-foreground">
              CSI section numbers associated with this scope
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded"
              data-testid="checkbox-scope-active"
            />
            <Label htmlFor="isActive">Active</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!scopeName || createMutation.isPending || updateMutation.isPending}
            data-testid="button-save-scope"
          >
            {mode === "add" ? "Add Scope" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegionSection() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingRegion, setEditingRegion] = useState<Region | null>(null);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: allRegions = [], isLoading } = useQuery<Region[]>({
    queryKey: ["/api/regions"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { code: string; name: string }) => {
      await apiRequest("POST", "/api/regions", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/regions"] });
      toast({ title: "Region added" });
      setNewCode("");
      setNewName("");
      setIsAddDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to add region", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      await apiRequest("PUT", `/api/regions/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/regions"] });
      toast({ title: "Region updated" });
      setEditingRegion(null);
    },
    onError: () => {
      toast({ title: "Failed to update region", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/regions/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/regions"] });
      toast({ title: "Region deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete region", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading">Regions / Airport Codes</CardTitle>
            <CardDescription>
              Manage region codes used in project naming (e.g., LAX, DFW, ORD)
            </CardDescription>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="button-import-regions">
                <FileUp className="w-4 h-4 mr-2" />
                Import
              </Button>
              <Button onClick={() => setIsAddDialogOpen(true)} data-testid="button-add-region">
                <Plus className="w-4 h-4 mr-2" />
                Add Region
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading regions...</div>
        ) : allRegions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No regions added yet. Add airport codes or region identifiers for project naming.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {allRegions.map((region) => (
              <div
                key={region.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-card"
                data-testid={`region-row-${region.id}`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-mono font-medium">{region.code}</span>
                  {region.name && (
                    <span className="text-sm text-muted-foreground">{region.name}</span>
                  )}
                  {region.selfPerformEstimators && region.selfPerformEstimators.length > 0 && (
                    <span className="text-xs text-muted-foreground/70" title={`SP Estimators: ${region.selfPerformEstimators.join(", ")}`}>· {region.selfPerformEstimators.join(", ")}</span>
                  )}
                  {region.aliases && region.aliases.length > 0 && (
                    <span className="text-xs text-muted-foreground/60" title={region.aliases.join(", ")}>({region.aliases.length} aliases)</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingRegion(region)}
                    data-testid={`button-edit-region-${region.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm("Delete this region?")) {
                          deleteMutation.mutate(region.id);
                        }
                      }}
                      data-testid={`button-delete-region-${region.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Region</DialogTitle>
            <DialogDescription>Add an airport code or region identifier</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="regionCode">Code *</Label>
              <Input
                id="regionCode"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                placeholder="LAX"
                maxLength={20}
                data-testid="input-region-code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="regionName">Name</Label>
              <Input
                id="regionName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Los Angeles International"
                data-testid="input-region-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate({ code: newCode, name: newName })}
              disabled={!newCode || createMutation.isPending}
              data-testid="button-save-region"
            >
              Add Region
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingRegion && (
        <RegionEditDialog
          open={!!editingRegion}
          onOpenChange={(open) => !open && setEditingRegion(null)}
          region={editingRegion}
          onSave={(data) => updateMutation.mutate({ id: editingRegion.id, data })}
          isPending={updateMutation.isPending}
        />
      )}

      <BulkImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        title="Regions"
        importEndpoint="/api/regions/bulk-import"
        invalidateKey="/api/regions"
        templateUrl="/api/regions/export"
        columns={[
          { key: "code", label: "Code", required: true },
          { key: "name", label: "Name" },
          { key: "aliases", label: "Aliases" },
          { key: "selfPerformEstimators", label: "Self Perform Estimators" },
        ]}
      />
    </Card>
  );
}

interface RegionEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  region: Region;
  onSave: (data: { code: string; name: string; aliases: string[]; selfPerformEstimators: string[] | null }) => void;
  isPending: boolean;
}

function RegionEditDialog({ open, onOpenChange, region, onSave, isPending }: RegionEditDialogProps) {
  const [code, setCode] = useState(region.code);
  const [name, setName] = useState(region.name ?? "");
  const [aliasesStr, setAliasesStr] = useState((region.aliases || []).join(", "));
  const [spEstimatorsStr, setSpEstimatorsStr] = useState((region.selfPerformEstimators || []).join(", "));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Region</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="editCode">Code *</Label>
            <Input
              id="editCode"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={20}
              data-testid="input-edit-region-code"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="editName">Name</Label>
            <Input
              id="editName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-edit-region-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="editSelfPerformEstimators">Self Perform Estimators (comma-separated)</Label>
            <Textarea
              id="editSelfPerformEstimators"
              value={spEstimatorsStr}
              onChange={(e) => setSpEstimatorsStr(e.target.value)}
              placeholder="e.g. John Smith, Jane Doe"
              rows={2}
              data-testid="input-edit-region-self-perform-estimators"
            />
            <p className="text-xs text-muted-foreground">Self perform estimator contacts for this region (comma-separated, append-only from Proposal Log Dashboard)</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="editAliases">Aliases (comma-separated)</Label>
            <Textarea
              id="editAliases"
              value={aliasesStr}
              onChange={(e) => setAliasesStr(e.target.value)}
              placeholder="e.g. denver, colorado, arvada"
              rows={3}
              data-testid="input-edit-region-aliases"
            />
            <p className="text-xs text-muted-foreground">Keywords used for auto-matching locations to this region</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              const spArr = spEstimatorsStr.split(",").map(s => s.trim()).filter(Boolean);
              onSave({ code, name, aliases: aliasesStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean), selfPerformEstimators: spArr.length ? spArr : null });
            }}
            disabled={!code || isPending}
            data-testid="button-save-edit-region"
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderTemplateSection() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [templateName, setTemplateName] = useState("Default Folder Template");
  const [isDragOver, setIsDragOver] = useState(false);

  const { data: templates = [], isLoading } = useQuery<FolderTemplate[]>({
    queryKey: ["/api/templates/folders"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", templateName);
      const res = await fetch("/api/templates/folders", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/folders"] });
      toast({ title: "Folder template uploaded" });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: () => {
      toast({ title: "Failed to upload template", variant: "destructive" });
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("PUT", `/api/templates/folders/${id}/activate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/folders"] });
      toast({ title: "Template activated" });
    },
    onError: () => {
      toast({ title: "Failed to activate template", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/templates/folders/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/folders"] });
      toast({ title: "Template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast({ title: "Please drop a ZIP file", variant: "destructive" });
      return;
    }
    if (!templateName) {
      toast({ title: "Please enter a template name first", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading">Folder Templates</CardTitle>
            <CardDescription>Upload ZIP files that define the standard estimate folder structure. The active template is copied for every new project.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="templateName">Template Name</Label>
            <Input
              id="templateName"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Default Folder Template"
              data-testid="input-folder-template-name"
            />
          </div>

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !uploadMutation.isPending && templateName && fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center gap-3 p-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
              isDragOver
                ? "border-border"
                : "border-border hover:border-muted-foreground/50"
            } ${uploadMutation.isPending || !templateName ? "opacity-50 cursor-not-allowed" : ""}`}
            style={isDragOver ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
            data-testid="dropzone-folder-template"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-folder-template-file"
            />
            {uploadMutation.isPending ? (
              <>
                <Upload className="w-8 h-8 animate-pulse" style={{ color: "var(--gold)" }} />
                <p className="text-sm font-medium">Uploading...</p>
              </>
            ) : (
              <>
                <FolderArchive className="w-8 h-8 text-muted-foreground" style={isDragOver ? { color: "var(--gold)" } : undefined} />
                <div className="text-center">
                  <p className="text-sm font-medium">
                    {isDragOver ? "Drop ZIP file here" : "Drag and drop a ZIP file here"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
                </div>
              </>
            )}
          </div>

          {isLoading && <p className="text-sm text-muted-foreground">Loading templates...</p>}

          {templates.length === 0 && !isLoading && (
            <p className="text-sm text-muted-foreground">No folder templates uploaded yet. Drop a ZIP file above to get started.</p>
          )}

          {templates.length > 0 && (
            <div className="space-y-3">
              {templates.map((tmpl) => (
                <Card key={tmpl.id} style={tmpl.isActive ? { borderColor: "var(--gold)" } : undefined}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <FolderArchive className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate" data-testid={`text-folder-template-name-${tmpl.id}`}>{tmpl.name}</span>
                            <Badge variant="outline">v{tmpl.version}</Badge>
                            {tmpl.isActive && <Badge variant="default">Active</Badge>}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
                            <span>{formatFileSize(tmpl.fileSize)}</span>
                            <span>{new Date(tmpl.createdAt).toLocaleDateString()}</span>
                            {tmpl.folderStructure && tmpl.folderStructure.length > 0 && (
                              <span>{tmpl.folderStructure.length} folders</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/templates/folders/${tmpl.id}/download`, "_blank")}
                          data-testid={`button-download-folder-template-${tmpl.id}`}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        {!tmpl.isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => activateMutation.mutate(tmpl.id)}
                            disabled={activateMutation.isPending}
                            data-testid={`button-activate-folder-template-${tmpl.id}`}
                          >
                            <Star className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => deleteMutation.mutate(tmpl.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-folder-template-${tmpl.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EstimateTemplateSection() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [templateName, setTemplateName] = useState("Default Estimate Template");
  const [editingMappings, setEditingMappings] = useState<{ id: number; mappings: StampMapping[] } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const { data: templates = [], isLoading } = useQuery<EstimateTemplate[]>({
    queryKey: ["/api/templates/estimates"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", templateName);
      const res = await fetch("/api/templates/estimates", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/estimates"] });
      toast({ title: "Estimate template uploaded" });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: () => {
      toast({ title: "Failed to upload template", variant: "destructive" });
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("PUT", `/api/templates/estimates/${id}/activate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/estimates"] });
      toast({ title: "Template activated" });
    },
    onError: () => {
      toast({ title: "Failed to activate template", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/templates/estimates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/estimates"] });
      toast({ title: "Template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  const saveMappingsMutation = useMutation({
    mutationFn: async ({ id, mappings }: { id: number; mappings: StampMapping[] }) => {
      await apiRequest("PUT", `/api/templates/estimates/${id}/stamp-mappings`, { mappings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/templates/estimates"] });
      toast({ title: "Stamp mappings updated" });
      setEditingMappings(null);
    },
    onError: () => {
      toast({ title: "Failed to update mappings", variant: "destructive" });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".xlsx") && !ext.endsWith(".xlsm")) {
      toast({ title: "Please drop an Excel file (.xlsx or .xlsm)", variant: "destructive" });
      return;
    }
    if (!templateName) {
      toast({ title: "Please enter a template name first", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const addMapping = () => {
    if (!editingMappings) return;
    setEditingMappings({
      ...editingMappings,
      mappings: [...editingMappings.mappings, { cellRef: "", fieldName: "", label: "" }],
    });
  };

  const updateMapping = (index: number, field: keyof StampMapping, value: string) => {
    if (!editingMappings) return;
    const updated = [...editingMappings.mappings];
    updated[index] = { ...updated[index], [field]: value };
    setEditingMappings({ ...editingMappings, mappings: updated });
  };

  const removeMapping = (index: number) => {
    if (!editingMappings) return;
    setEditingMappings({
      ...editingMappings,
      mappings: editingMappings.mappings.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading">Estimate File Templates</CardTitle>
            <CardDescription>Upload Excel estimate templates (.xlsx/.xlsm). Configure which cells get stamped with project data when a new project is created.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="estimateName">Template Name</Label>
            <Input
              id="estimateName"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Default Estimate Template"
              data-testid="input-estimate-template-name"
            />
          </div>

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !uploadMutation.isPending && templateName && fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center gap-3 p-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
              isDragOver
                ? "border-border"
                : "border-border hover:border-muted-foreground/50"
            } ${uploadMutation.isPending || !templateName ? "opacity-50 cursor-not-allowed" : ""}`}
            style={isDragOver ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
            data-testid="dropzone-estimate-template"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-estimate-template-file"
            />
            {uploadMutation.isPending ? (
              <>
                <Upload className="w-8 h-8 animate-pulse" style={{ color: "var(--gold)" }} />
                <p className="text-sm font-medium">Uploading...</p>
              </>
            ) : (
              <>
                <FileSpreadsheet className="w-8 h-8 text-muted-foreground" style={isDragOver ? { color: "var(--gold)" } : undefined} />
                <div className="text-center">
                  <p className="text-sm font-medium">
                    {isDragOver ? "Drop Excel file here" : "Drag and drop an Excel file here"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">or click to browse (.xlsx, .xlsm)</p>
                </div>
              </>
            )}
          </div>

          {isLoading && <p className="text-sm text-muted-foreground">Loading templates...</p>}

          {templates.length === 0 && !isLoading && (
            <p className="text-sm text-muted-foreground">No estimate templates uploaded yet. Upload an Excel file to get started.</p>
          )}

          {templates.length > 0 && (
            <div className="space-y-3">
              {templates.map((tmpl) => (
                <Card key={tmpl.id} style={tmpl.isActive ? { borderColor: "var(--gold)" } : undefined}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileSpreadsheet className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate" data-testid={`text-estimate-template-name-${tmpl.id}`}>{tmpl.name}</span>
                            <Badge variant="outline">v{tmpl.version}</Badge>
                            {tmpl.isActive && <Badge variant="default">Active</Badge>}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
                            <span>{tmpl.originalFilename}</span>
                            <span>{formatFileSize(tmpl.fileSize)}</span>
                            <span>{new Date(tmpl.createdAt).toLocaleDateString()}</span>
                          </div>
                          {tmpl.sheetNames && tmpl.sheetNames.length > 0 && (
                            <div className="flex items-center gap-1 mt-1 flex-wrap">
                              {tmpl.sheetNames.map((name) => (
                                <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                              ))}
                            </div>
                          )}
                          {tmpl.stampMappings && tmpl.stampMappings.length > 0 && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {tmpl.stampMappings.length} stamp mapping{tmpl.stampMappings.length !== 1 ? "s" : ""} configured
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingMappings({ id: tmpl.id, mappings: [...(tmpl.stampMappings || [])] })}
                          data-testid={`button-edit-mappings-${tmpl.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/templates/estimates/${tmpl.id}/download`, "_blank")}
                          data-testid={`button-download-estimate-template-${tmpl.id}`}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        {!tmpl.isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => activateMutation.mutate(tmpl.id)}
                            disabled={activateMutation.isPending}
                            data-testid={`button-activate-estimate-template-${tmpl.id}`}
                          >
                            <Star className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => deleteMutation.mutate(tmpl.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-estimate-template-${tmpl.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editingMappings} onOpenChange={(open) => !open && setEditingMappings(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Stamp Mappings</DialogTitle>
            <DialogDescription>Configure which cells in the Excel template get filled with project data when a new project is created.</DialogDescription>
          </DialogHeader>
          {editingMappings && (
            <div className="space-y-4 max-h-96 overflow-y-auto">
              {editingMappings.mappings.map((mapping, index) => (
                <div key={index} className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Cell Reference</Label>
                    <Input
                      value={mapping.cellRef}
                      onChange={(e) => updateMapping(index, "cellRef", e.target.value)}
                      placeholder="Summary Sheet!AB1"
                      data-testid={`input-mapping-cell-${index}`}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Field</Label>
                    <Select value={mapping.fieldName} onValueChange={(v) => updateMapping(index, "fieldName", v)}>
                      <SelectTrigger data-testid={`select-mapping-field-${index}`}>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="projectId">Project ID (Bid ID)</SelectItem>
                        <SelectItem value="projectName">Project Name</SelectItem>
                        <SelectItem value="regionCode">Region / Airport Code</SelectItem>
                        <SelectItem value="dueDate">Due Date</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => removeMapping(index)}
                    data-testid={`button-remove-mapping-${index}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" onClick={addMapping} className="w-full" data-testid="button-add-mapping">
                <Plus className="w-4 h-4 mr-2" /> Add Mapping
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMappings(null)}>Cancel</Button>
            <Button
              onClick={() => editingMappings && saveMappingsMutation.mutate({ id: editingMappings.id, mappings: editingMappings.mappings })}
              disabled={saveMappingsMutation.isPending}
              data-testid="button-save-mappings"
            >
              Save Mappings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SpecExtractorSettingsSection() {
  const { toast } = useToast();
  const [sectionPattern, setSectionPattern] = useState("");
  const [defaultScopes, setDefaultScopes] = useState<Record<string, string>>({});
  const [accessoryScopes, setAccessoryScopes] = useState<AccessoryScopeData[]>([]);
  const [newScopeKey, setNewScopeKey] = useState("");
  const [newScopeValue, setNewScopeValue] = useState("");
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const configQuery = useQuery<SpecsiftConfig>({
    queryKey: ["/api/settings/config"],
  });

  const versionsQuery = useQuery<SpecsiftConfig[]>({
    queryKey: ["/api/settings/versions"],
  });

  const loadConfigIntoState = (config: SpecsiftConfig) => {
    setSectionPattern(config.sectionPattern);
    setDefaultScopes(config.defaultScopes as Record<string, string>);
    setAccessoryScopes(config.accessoryScopes as AccessoryScopeData[]);
  };

  if (configQuery.data && !configLoaded && !configQuery.isLoading) {
    loadConfigIntoState(configQuery.data);
    setConfigLoaded(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const existing = configQuery.data;
      const response = await fetch("/api/settings/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: "admin123",
          sectionPattern,
          defaultScopes,
          accessoryScopes,
          manufacturerExcludeTerms: existing?.manufacturerExcludeTerms || [],
          modelPatterns: existing?.modelPatterns || [],
          materialKeywords: existing?.materialKeywords || [],
          conflictPatterns: existing?.conflictPatterns || [],
          notePatterns: existing?.notePatterns || [],
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to save");
      }
      return response.json();
    },
    onSuccess: (newConfig) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/versions"] });
      loadConfigIntoState(newConfig);
      toast({
        title: "Settings Saved",
        description: `Version ${newConfig.version} created successfully.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Save Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async (versionId: number) => {
      const response = await fetch(`/api/settings/rollback/${versionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "admin123" }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to rollback");
      }
      return response.json();
    },
    onSuccess: (restored) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/versions"] });
      loadConfigIntoState(restored);
      setRollbackDialogOpen(false);
      toast({
        title: "Settings Restored",
        description: `Successfully rolled back to version ${restored.version}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Rollback Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [activeSubTab, setActiveSubTab] = useState("patterns");

  if (configQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading configuration...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 font-heading">
            <FileSearch className="h-5 w-5" />
            Spec Extractor Configuration
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure section detection patterns, default scope titles, and accessory scope keywords.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => versionsQuery.data && versionsQuery.data.length > 0 && setRollbackDialogOpen(true)}
            disabled={!versionsQuery.data || versionsQuery.data.length <= 1}
            data-testid="button-spec-view-history"
          >
            <History className="mr-2 h-4 w-4" />
            Version History
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-spec-save-settings"
          >
            <Save className="mr-2 h-4 w-4" />
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>

      {configQuery.data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle className="h-4 w-4 text-green-500" />
          Current version: {configQuery.data.version}
          <span className="text-xs">
            (saved {new Date(configQuery.data.createdAt).toLocaleString()})
          </span>
        </div>
      )}

      <Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="space-y-4">
        <TabsList className="flex flex-wrap gap-1">
          <TabsTrigger value="patterns" data-testid="tab-spec-patterns">
            Section Patterns
          </TabsTrigger>
          <TabsTrigger value="scopes" data-testid="tab-spec-scopes">
            Default Scopes
          </TabsTrigger>
          <TabsTrigger value="accessories" data-testid="tab-spec-accessories">
            Accessory Scopes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="patterns" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-heading">Division 10 Section Pattern</CardTitle>
              <CardDescription>
                Regular expression pattern used to identify Division 10 section numbers in PDF text.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="spec-section-pattern">Section Number Regex</Label>
                  <Textarea
                    id="spec-section-pattern"
                    value={sectionPattern}
                    onChange={(e) => setSectionPattern(e.target.value)}
                    className="font-mono text-sm"
                    rows={3}
                    data-testid="input-spec-section-pattern"
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    This regex matches section numbers like "10 21 13", "102113", "10-21-13", etc.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scopes" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-heading">Default Scope Titles</CardTitle>
              <CardDescription>
                Mapping of section numbers to default titles used when a title cannot be extracted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Section Number (e.g., 10 28 00)"
                    value={newScopeKey}
                    onChange={(e) => setNewScopeKey(e.target.value)}
                    className="flex-1"
                    data-testid="input-spec-new-scope-key"
                  />
                  <Input
                    placeholder="Title (e.g., Toilet Accessories)"
                    value={newScopeValue}
                    onChange={(e) => setNewScopeValue(e.target.value)}
                    className="flex-1"
                    data-testid="input-spec-new-scope-value"
                  />
                  <Button
                    onClick={() => {
                      if (newScopeKey && newScopeValue) {
                        setDefaultScopes({ ...defaultScopes, [newScopeKey]: newScopeValue });
                        setNewScopeKey("");
                        setNewScopeValue("");
                      }
                    }}
                    size="icon"
                    data-testid="button-spec-add-scope"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                <div className="max-h-80 overflow-y-auto space-y-2">
                  {Object.entries(defaultScopes).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 p-2 rounded border bg-muted/30">
                      <Badge variant="outline" className="font-mono">{key}</Badge>
                      <span className="flex-1 text-sm">{value}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          const updated = { ...defaultScopes };
                          delete updated[key];
                          setDefaultScopes(updated);
                        }}
                        data-testid={`button-spec-remove-scope-${key}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accessories" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="font-heading">Accessory Scope Definitions</CardTitle>
                  <CardDescription>
                    Define accessory scopes with keywords for matching in spec documents.
                  </CardDescription>
                </div>
                <Button
                  onClick={() => {
                    setAccessoryScopes([
                      ...accessoryScopes,
                      { name: "New Scope", keywords: [], sectionHint: "", divisionScope: [] },
                    ]);
                  }}
                  size="sm"
                  data-testid="button-spec-add-accessory-scope"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Scope
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 max-h-[600px] overflow-y-auto">
                {accessoryScopes.map((scope, index) => (
                  <div key={index} className="p-4 rounded border bg-muted/30 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <Input
                        value={scope.name}
                        onChange={(e) => {
                          const updated = [...accessoryScopes];
                          updated[index] = { ...updated[index], name: e.target.value };
                          setAccessoryScopes(updated);
                        }}
                        placeholder="Scope Name"
                        className="font-medium"
                        data-testid={`input-spec-accessory-name-${index}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setAccessoryScopes(accessoryScopes.filter((_, i) => i !== index))}
                        data-testid={`button-spec-remove-accessory-${index}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                    <div>
                      <Label className="text-xs">Keywords (comma-separated)</Label>
                      <Textarea
                        value={scope.keywords.join(", ")}
                        onChange={(e) => {
                          const updated = [...accessoryScopes];
                          updated[index] = {
                            ...updated[index],
                            keywords: e.target.value.split(",").map(k => k.trim()).filter(Boolean),
                          };
                          setAccessoryScopes(updated);
                        }}
                        placeholder="bike rack, bicycle rack, bicycle parking"
                        rows={2}
                        className="text-sm"
                        data-testid={`input-spec-accessory-keywords-${index}`}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Section Hint</Label>
                        <Input
                          value={scope.sectionHint}
                          onChange={(e) => {
                            const updated = [...accessoryScopes];
                            updated[index] = { ...updated[index], sectionHint: e.target.value };
                            setAccessoryScopes(updated);
                          }}
                          placeholder="12 93 43"
                          className="text-sm"
                          data-testid={`input-spec-accessory-hint-${index}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Division Scope (comma-separated)</Label>
                        <Input
                          value={scope.divisionScope.join(", ")}
                          onChange={(e) => {
                            const updated = [...accessoryScopes];
                            updated[index] = {
                              ...updated[index],
                              divisionScope: e.target.value.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n)),
                            };
                            setAccessoryScopes(updated);
                          }}
                          placeholder="11, 12"
                          className="text-sm"
                          data-testid={`input-spec-accessory-division-${index}`}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={rollbackDialogOpen} onOpenChange={setRollbackDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Version History
            </DialogTitle>
            <DialogDescription>
              Select a previous version to restore. This will create a new version with the selected configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            {versionsQuery.data?.map((version) => (
              <div
                key={version.id}
                className={`p-3 rounded border flex items-center justify-between gap-4 ${
                  version.isActive ? "" : "bg-muted/30"
                }`}
                style={version.isActive ? { background: "rgba(200,164,78,0.06)", borderColor: "var(--gold)" } : undefined}
              >
                <div className="flex items-center gap-3">
                  <Badge variant={version.isActive ? "default" : "outline"}>
                    v{version.version}
                  </Badge>
                  <div>
                    <div className="text-sm font-medium">
                      {version.isActive && "(Current) "}
                      {version.notes || "Configuration update"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()} by {version.createdBy || "admin"}
                    </div>
                  </div>
                </div>
                {!version.isActive && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => rollbackMutation.mutate(version.id)}
                    disabled={rollbackMutation.isPending}
                    data-testid={`button-spec-rollback-${version.id}`}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Restore
                  </Button>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface BulkImportColumn {
  key: string;
  label: string;
  required?: boolean;
}

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  columns: BulkImportColumn[];
  importEndpoint: string;
  invalidateKey: string;
  templateUrl?: string;
}

function BulkImportDialog({ open, onOpenChange, title, columns, importEndpoint, invalidateKey, templateUrl }: BulkImportDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [step, setStep] = useState<"upload" | "preview">("upload");

  const importMutation = useMutation({
    mutationFn: async (rows: Record<string, string>[]) => {
      const res = await apiRequest("POST", importEndpoint, { rows });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [invalidateKey] });
      toast({
        title: `Import complete`,
        description: `${data.imported} imported, ${data.skipped} skipped${data.errors?.length ? `, ${data.errors.length} errors` : ""}`,
      });
      handleClose();
    },
    onError: () => {
      toast({ title: "Import failed", variant: "destructive" });
    },
  });

  const handleClose = () => {
    setParsedRows([]);
    setColumnMapping({});
    setFileName("");
    setStep("upload");
    onOpenChange(false);
  };

  const handleFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        if (raw.length < 2) {
          toast({ title: "File appears empty or has no data rows", variant: "destructive" });
          return;
        }
        const headers = raw[0].map(h => h.toString().trim());
        const autoMapping: Record<string, string> = {};
        for (const col of columns) {
          const match = headers.findIndex(h =>
            h.toLowerCase() === col.key.toLowerCase() ||
            h.toLowerCase() === col.label.toLowerCase() ||
            h.toLowerCase().replace(/[\s_-]/g, "") === col.key.toLowerCase().replace(/[\s_-]/g, "")
          );
          if (match !== -1) autoMapping[col.key] = headers[match];
        }
        setColumnMapping(autoMapping);
        const rows = raw.slice(1).filter(r => r.some(c => c !== "")).map(r => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => { obj[h] = (r[i] || "").toString(); });
          return obj;
        });
        setParsedRows(rows);
        setStep("preview");
      } catch (err) {
        toast({ title: "Failed to parse file", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleImport = () => {
    const mappedRows = parsedRows.map(row => {
      const mapped: Record<string, string> = {};
      for (const col of columns) {
        const sourceCol = columnMapping[col.key];
        if (sourceCol) mapped[col.key] = row[sourceCol] || "";
      }
      return mapped;
    });
    const validRows = mappedRows.filter(r =>
      columns.filter(c => c.required).every(c => (r[c.key] || "").trim())
    );
    if (validRows.length === 0) {
      toast({ title: "No valid rows to import", description: "Required columns are missing data", variant: "destructive" });
      return;
    }
    importMutation.mutate(validRows);
  };

  const fileHeaders = parsedRows.length > 0 ? Object.keys(parsedRows[0]) : [];
  const requiredMapped = columns.filter(c => c.required).every(c => columnMapping[c.key]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-heading">Bulk Import {title}</DialogTitle>
          <DialogDescription>
            Upload an Excel (.xlsx) or CSV file to import multiple {title.toLowerCase()} at once. Duplicates will be automatically skipped.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            {templateUrl && (
              <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-muted/50 border">
                <Download className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Not sure what format to use?</span>
                <a
                  href={templateUrl}
                  download
                  className="text-sm font-medium text-primary hover:underline"
                  data-testid="link-download-template"
                >
                  Download Template
                </a>
              </div>
            )}
            <div
              className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              data-testid="bulk-import-dropzone"
            >
              <FileUp className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-lg font-medium mb-1">Drop your file here or click to browse</p>
              <p className="text-sm text-muted-foreground">Supports .xlsx, .xls, and .csv files</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                data-testid="bulk-import-file-input"
              />
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{fileName}</span> — {parsedRows.length} rows found
              </p>
              <Button variant="ghost" size="sm" onClick={() => { setStep("upload"); setParsedRows([]); setFileName(""); }}>
                Choose different file
              </Button>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium">Column Mapping</p>
              <div className="grid grid-cols-2 gap-3">
                {columns.map(col => (
                  <div key={col.key} className="flex items-center gap-2">
                    <Label className="text-sm min-w-[120px]">
                      {col.label} {col.required && <span className="text-destructive">*</span>}
                    </Label>
                    <Select
                      value={columnMapping[col.key] || "__unmapped__"}
                      onValueChange={(v) => setColumnMapping(prev => ({ ...prev, [col.key]: v === "__unmapped__" ? "" : v }))}
                    >
                      <SelectTrigger className="h-8 text-sm" data-testid={`mapping-${col.key}`}>
                        <SelectValue placeholder="Select column..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unmapped__">-- Not mapped --</SelectItem>
                        {fileHeaders.map(h => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {columnMapping[col.key] && columnMapping[col.key] !== "__unmapped__" && (
                      <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">#</th>
                    {columns.filter(c => columnMapping[c.key]).map(col => (
                      <th key={col.key} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      {columns.filter(c => columnMapping[c.key]).map(col => (
                        <td key={col.key} className="px-3 py-1.5 max-w-[200px] truncate">
                          {row[columnMapping[col.key]] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedRows.length > 50 && (
                <div className="text-center py-2 text-sm text-muted-foreground border-t">
                  Showing first 50 of {parsedRows.length} rows
                </div>
              )}
            </div>

            {!requiredMapped && (
              <div className="flex items-center gap-2 text-sm text-amber-500">
                <AlertTriangle className="w-4 h-4" />
                Map all required columns (marked with *) to proceed
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          {step === "preview" && (
            <Button
              onClick={handleImport}
              disabled={!requiredMapped || importMutation.isPending}
              data-testid="button-confirm-import"
            >
              {importMutation.isPending ? "Importing..." : `Import ${parsedRows.length} Rows`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function EmailTemplateSection() {
  const [activeEmailTab, setActiveEmailTab] = useState("bid-assignment");

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="font-heading">Email Templates</CardTitle>
          <CardDescription>
            Customize email notifications sent to users for bid assignments and project wins
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeEmailTab} onValueChange={setActiveEmailTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="bid-assignment" data-testid="tab-email-bid-assignment">Bid Assignment</TabsTrigger>
            <TabsTrigger value="project-won" data-testid="tab-email-project-won">Project Won</TabsTrigger>
          </TabsList>
          <TabsContent value="bid-assignment">
            <BidAssignmentTemplateEditor />
          </TabsContent>
          <TabsContent value="project-won">
            <ProjectWonTemplateEditor />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function BidAssignmentTemplateEditor() {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [greeting, setGreeting] = useState("");
  const [bodyMessage, setBodyMessage] = useState("");
  const [signOff, setSignOff] = useState("");
  const [initialized, setInitialized] = useState(false);

  const { data: template, isLoading } = useQuery<{
    subject: string;
    greeting: string;
    bodyMessage: string;
    signOff: string;
  }>({
    queryKey: ["/api/settings/email-template/bid-assignment"],
  });

  useEffect(() => {
    if (template && !initialized) {
      setSubject(template.subject);
      setGreeting(template.greeting);
      setBodyMessage(template.bodyMessage);
      setSignOff(template.signOff);
      setInitialized(true);
    }
  }, [template, initialized]);

  const saveMutation = useMutation({
    mutationFn: async (data: { subject: string; greeting: string; bodyMessage: string; signOff: string }) => {
      await apiRequest("PUT", "/api/settings/email-template/bid-assignment", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/email-template/bid-assignment"] });
      toast({ title: "Email template saved" });
    },
    onError: () => {
      toast({ title: "Failed to save template", variant: "destructive" });
    },
  });

  const sampleData = {
    estimatorName: "Haley Kruse",
    projectName: "Downtown Medical Center Renovation",
    estimateNumber: "26-0001",
    dueDate: "2026-04-15",
    gcLead: "John Smith",
  };

  const previewGreeting = escapeHtml(greeting.replace(/\{\{estimator\}\}/g, sampleData.estimatorName));
  const previewBody = escapeHtml(bodyMessage);
  const previewSignOff = escapeHtml(signOff).replace(/\n/g, "<br>");

  const previewHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #333; font-size: 15px; margin: 0 0 16px 0;">${previewGreeting}</p>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">${previewBody}</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #D4A843;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px; width: 110px;">Project</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.projectName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Estimate #</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.estimateNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Due Date</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.dueDate}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">GC Lead</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.gcLead}</td>
          </tr>
        </table>
      </div>
      <p style="color: #666; font-size: 13px; margin: 0;">${previewSignOff}</p>
    </div>
  `;

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading template...</div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="space-y-5">
        <h3 className="font-medium text-sm text-foreground">Editable Fields</h3>

        <div className="space-y-2">
          <Label htmlFor="email-subject">Subject Line</Label>
          <Input
            id="email-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject line"
            data-testid="input-email-subject"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email-greeting">
            Greeting <span className="text-xs text-muted-foreground ml-1">Use {"{{estimator}}"} for the estimator's name</span>
          </Label>
          <Input
            id="email-greeting"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="Hello {{estimator}},"
            data-testid="input-email-greeting"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email-body">Body Message</Label>
          <Textarea
            id="email-body"
            value={bodyMessage}
            onChange={(e) => setBodyMessage(e.target.value)}
            placeholder="Message text before the project details"
            rows={3}
            data-testid="input-email-body"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email-signoff">Sign-off</Label>
          <Textarea
            id="email-signoff"
            value={signOff}
            onChange={(e) => setSignOff(e.target.value)}
            placeholder="Thank you,&#10;AiPM Tool Belt Team"
            rows={2}
            data-testid="input-email-signoff"
          />
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Dynamic fields (auto-filled from bid data):</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Project Name</li>
            <li>Estimate Number</li>
            <li>Due Date</li>
            <li>GC Lead</li>
          </ul>
        </div>

        <Button
          onClick={() => saveMutation.mutate({ subject, greeting, bodyMessage, signOff })}
          disabled={saveMutation.isPending || !subject || !greeting || !bodyMessage || !signOff}
          className="gap-2"
          data-testid="button-save-email-template"
        >
          <Save className="w-4 h-4" />
          {saveMutation.isPending ? "Saving..." : "Save Template"}
        </Button>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium text-sm text-foreground">Live Preview</h3>

        <div className="rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">Subject: </span>
          <span className="text-sm font-medium" data-testid="text-email-subject-preview">{subject}</span>
        </div>

        <div
          className="border rounded-lg bg-white overflow-hidden"
          data-testid="email-preview-container"
        >
          <iframe
            srcDoc={previewHtml}
            title="Email Preview"
            className="w-full border-0"
            style={{ minHeight: 420 }}
            sandbox=""
          />
        </div>
      </div>
    </div>
  );
}

function ProjectWonTemplateEditor() {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [bodyMessage, setBodyMessage] = useState("");
  const [signOff, setSignOff] = useState("");
  const [initialized, setInitialized] = useState(false);

  const { data: template, isLoading } = useQuery<{
    subject: string;
    bodyMessage: string;
    signOff: string;
  }>({
    queryKey: ["/api/settings/email-template/project-won"],
  });

  useEffect(() => {
    if (template && !initialized) {
      setSubject(template.subject);
      setBodyMessage(template.bodyMessage);
      setSignOff(template.signOff);
      setInitialized(true);
    }
  }, [template, initialized]);

  const saveMutation = useMutation({
    mutationFn: async (data: { subject: string; bodyMessage: string; signOff: string }) => {
      await apiRequest("PUT", "/api/settings/email-template/project-won", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/email-template/project-won"] });
      toast({ title: "Email template saved" });
    },
    onError: () => {
      toast({ title: "Failed to save template", variant: "destructive" });
    },
  });

  const sampleData = {
    projectName: "Downtown Medical Center Renovation",
    estimateNumber: "26-0001",
    proposalTotal: "$1,250,000",
    gcLead: "John Smith",
    dueDate: "2026-04-15",
  };

  const previewBody = escapeHtml(bodyMessage);
  const previewSignOff = escapeHtml(signOff).replace(/\n/g, "<br>");

  const previewHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">${previewBody}</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #D4A843;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px; width: 120px;">Project</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.projectName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Estimate #</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.estimateNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Proposal Total</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.proposalTotal}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">GC Lead</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.gcLead}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Due Date</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${sampleData.dueDate}</td>
          </tr>
        </table>
      </div>
      <p style="color: #666; font-size: 13px; margin: 0;">${previewSignOff}</p>
    </div>
  `;

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading template...</div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="space-y-5">
        <h3 className="font-medium text-sm text-foreground">Editable Fields</h3>

        <div className="space-y-2">
          <Label htmlFor="won-email-subject">Subject Line</Label>
          <Input
            id="won-email-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject line"
            data-testid="input-won-email-subject"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="won-email-body">Body Message</Label>
          <Textarea
            id="won-email-body"
            value={bodyMessage}
            onChange={(e) => setBodyMessage(e.target.value)}
            placeholder="Message text before the project details"
            rows={3}
            data-testid="input-won-email-body"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="won-email-signoff">Sign-off</Label>
          <Textarea
            id="won-email-signoff"
            value={signOff}
            onChange={(e) => setSignOff(e.target.value)}
            placeholder="Congratulations,&#10;AiPM Tool Belt Team"
            rows={2}
            data-testid="input-won-email-signoff"
          />
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Sent automatically when a project is marked Won:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>All admin users</li>
            <li>Assigned estimator(s)</li>
          </ul>
          <p className="font-medium text-foreground mt-2">Dynamic fields (auto-filled from project data):</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Project Name</li>
            <li>Estimate Number</li>
            <li>Proposal Total</li>
            <li>GC Lead</li>
            <li>Due Date</li>
          </ul>
        </div>

        <Button
          onClick={() => saveMutation.mutate({ subject, bodyMessage, signOff })}
          disabled={saveMutation.isPending || !subject || !bodyMessage || !signOff}
          className="gap-2"
          data-testid="button-save-won-email-template"
        >
          <Save className="w-4 h-4" />
          {saveMutation.isPending ? "Saving..." : "Save Template"}
        </Button>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium text-sm text-foreground">Live Preview</h3>

        <div className="rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">Subject: </span>
          <span className="text-sm font-medium" data-testid="text-won-email-subject-preview">{subject}</span>
        </div>

        <div
          className="border rounded-lg bg-white overflow-hidden"
          data-testid="won-email-preview-container"
        >
          <iframe
            srcDoc={previewHtml}
            title="Project Won Email Preview"
            className="w-full border-0"
            style={{ minHeight: 460 }}
            sandbox=""
          />
        </div>
      </div>
    </div>
  );
}
