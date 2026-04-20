const app = document.getElementById("app");
const modalOverlay = document.getElementById("modalOverlay");
const modalContent = document.getElementById("modalContent");
const modalTitle = document.getElementById("modalTitle");
const cardTitle = document.getElementById("cardTitle");
const cardMeta = document.getElementById("cardMeta");
const splitSummary = document.getElementById("splitSummary");
const currentCategory = document.getElementById("currentCategory");
const totals = document.getElementById("totals");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const DEBUG_RECEIPTS = false;
let currentCategoryBreakdownRows = [];
let currentCategoryBreakdownName = "";

function debugReceipt(...args){
  if(DEBUG_RECEIPTS) console.log(...args);
}

function warnReceipt(...args){
  if(DEBUG_RECEIPTS) console.warn(...args);
}

function edgeFunctionUrl(functionName){
  return `${SUPABASE_URL}/functions/v1/${encodeURIComponent(functionName)}`;
}

function jsString(value){
  return JSON.stringify(String(value || ""));
}

function htmlJsString(value){
  return escapeHtml(jsString(value));
}

function normalizeMoney(value){
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeNullableMoney(value){
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function getAllowedCategoryName(value, fallback = "Needs Review"){
  const requested = String(value || "").trim();
  const normalized = normalizeCategoryName(requested);
  return categories.some((category) => category.name === normalized) ? normalized : fallback;
}

const ModalRoutes = {
  split: () => openSplitModal(),
  detectedItems: () => openDetectedReceiptItemsModal(),
};

function runModalRoute(routeName){
  const route = ModalRoutes[String(routeName || "")];
  if(!route) {
    closeModal();
    return;
  }
  closeModal();
  window.setTimeout(() => route(), 0);
}
function triggerHaptic(style = "light"){
  if(!navigator?.vibrate) return;
  const pattern = style === "success" ? [14, 18, 24] : style === "heavy" ? [24] : [10];
  navigator.vibrate(pattern);
}

function enableHaptics(){
  document.addEventListener("click", (event) => {
    const interactive = event.target.closest("button, select, input[type='date'], .category-btn, .touchButton, .modalItem, .totalRow, .receiptUploadLabel");
    if(!interactive || interactive.disabled) return;
    const tone = interactive.classList.contains("splitHeaderExit") || /remove|close|cancel|clear/i.test((interactive.innerText || "").trim()) ? "heavy" : "light";
    triggerHaptic(tone);
  }, { passive: true });
}
const keypadOverlay = document.getElementById("keypadOverlay");
const keypadGrid = document.getElementById("keypadGrid");
const keypadDisplay = document.getElementById("keypadDisplay");
const keypadHint = document.getElementById("keypadHint");
const keypadTitle = document.getElementById("keypadTitle");

// UI COMPONENTS
const UIComponents = {
  updateHTML(el, html){ if(el) el.innerHTML = html; },
  setText(el, text){ if(el) el.innerText = text; }
};

function initTouchFeedback(){
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if(!button) return;
    button.classList.add("tapPulse");
    window.setTimeout(() => button.classList.remove("tapPulse"), 140);
  });
}

initTouchFeedback();

// STATE MANAGEMENT
const AppState = {
  get currentItem(){ return data[currentIndex]; },
  get isModalOpen(){ return modalOverlay.style.display === "flex"; }
};

function initSwipeNavigation(){
  const transactionReviewPanel = document.getElementById("transactionReviewPanel");
  if(!transactionReviewPanel) return;

  const SWIPE_THRESHOLD = 100;
  const HORIZONTAL_INTENT_RATIO = 1.5;
  let touchStartX = null;
  let touchStartY = null;
  let touchCurrentX = null;
  let touchCurrentY = null;
  let swipeDirection = null;

  function shouldIgnoreSwipeStart(event){
    if(AppState.isModalOpen) return true;
    if(event.touches.length !== 1) return true;

    const target = event.target;
    const interactiveTarget = target.closest("button, input, select, textarea, a, [role='button'], .lineItemCard");
    return !!interactiveTarget;
  }

  transactionReviewPanel.addEventListener("touchstart", (event) => {
    if(shouldIgnoreSwipeStart(event)){
      touchStartX = null;
      touchStartY = null;
      touchCurrentX = null;
      touchCurrentY = null;
      swipeDirection = null;
      return;
    }

    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchCurrentX = touch.clientX;
    touchCurrentY = touch.clientY;
    swipeDirection = null;
  }, { passive: true });

  transactionReviewPanel.addEventListener("touchmove", (event) => {
    if(touchStartX === null || touchStartY === null) return;
    if(AppState.isModalOpen) return;

    const touch = event.touches[0];
    touchCurrentX = touch.clientX;
    touchCurrentY = touch.clientY;

    const deltaX = touchCurrentX - touchStartX;
    const deltaY = touchCurrentY - touchStartY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    if(!swipeDirection){
      if(absDeltaX > absDeltaY * HORIZONTAL_INTENT_RATIO){
        swipeDirection = "horizontal";
      } else if(absDeltaY > absDeltaX){
        swipeDirection = "vertical";
      }
    }

    if(swipeDirection === "horizontal"){
      event.preventDefault();
    }
  }, { passive: false });

  transactionReviewPanel.addEventListener("touchend", (event) => {
    if(touchStartX === null || touchStartY === null) return;
    if(AppState.isModalOpen) return;

    const touch = event.changedTouches[0];
    const endX = touchCurrentX ?? touch.clientX;
    const endY = touchCurrentY ?? touch.clientY;
    const deltaX = endX - touchStartX;
    const deltaY = endY - touchStartY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    const isClearlyHorizontal = absDeltaX > absDeltaY * HORIZONTAL_INTENT_RATIO;

    touchStartX = null;
    touchStartY = null;
    touchCurrentX = null;
    touchCurrentY = null;
    const completedDirection = swipeDirection;
    swipeDirection = null;

    if(completedDirection !== "horizontal" && !isClearlyHorizontal) return;
    if(absDeltaX < SWIPE_THRESHOLD) return;

    transactionReviewPanel.style.setProperty("--swipe-offset", deltaX < 0 ? "-14px" : "14px");
    transactionReviewPanel.classList.remove("swipeNavFeedback");
    void transactionReviewPanel.offsetWidth;
    transactionReviewPanel.classList.add("swipeNavFeedback");

    if(deltaX < 0){
      goNext();
      return;
    }

    goBack();
  }, { passive: true });
}

initSwipeNavigation();

let modalBackAction = null;
function setModalBackAction(action){
  modalBackAction = typeof action === "function" ? action : null;
}

function dismissModalToContext(){
  if(typeof modalBackAction === "function") {
    const action = modalBackAction;
    closeModal();
    window.setTimeout(() => action(), 0);
    return;
  }
  closeModal();
}

// API LAYER
const Api = {
  async updateTransaction(id, payload){
    if(!id) return { error: null };
    return supabaseClient.from("transactions").update(payload).eq("id", id);
  },
  async deleteTransaction(id){
    if(!id) return { error: null };
    return supabaseClient.from("transactions").delete().eq("id", id);
  }
};

// UTILITIES
const Utils = {
  cents(value){ return Math.round(parseFloat(value || 0) * 100); },
  money(value){ return `$${parseFloat(value || 0).toFixed(2)}`; }
};

function toggleQuickActionsMenu() {
  const menu = document.getElementById("quickActionsMenu");
  menu.classList.toggle("open");
}

/* ALL YOUR ORIGINAL JS REMAINS UNCHANGED BELOW */

let rawRows=[];
let headers=[];
let data=[];
let currentIndex=0;
let showOnlyUncategorized=false;
let activeSearchFilter=null;
let activeYearFilter = null;
let activeStartDateFilter = null;
let activeEndDateFilter = null;
let activeTransactionTypeFilter = "all";
let aiContext = null;
let aiSuggestionResult = null;
// null = normal transaction
// { type: "receipt", index: X } = receipt item mode
/* ================= LOAD FROM SUPABASE ================= */

async function loadTransactions() {
  const { data: rows, error } = await supabaseClient
    .from("transactions")
    .select("*")
    .order("date", { ascending: true }); // safer than created_at

  if (error) {
    console.error("Load error:", error);
    return;
  }

  debugReceipt("Rows from Supabase:", rows);

data = rows.map(r => ({
  id: r.id,

  // 🔥 FIXED MAPPING
  Title: r.name || r.merchant_name || r.title || "",
  Vendor: r.merchant_name || r.vendor || r.name || "",

  Date: r.date,
  Amount: normalizeMoney(r.amount),

  Category: r.category || "",
  Splits: r.splits || [],
  ReviewStatus: r.review_status || "",
  DeductionStatus: r.deduction_status || "",
  ReviewNote: r.review_note || "",

  receipt_url: r.receipt_url,

  Institution: r.institution_name || r.institution || ""
}));

  app.style.display = "block";

  renderCategories();
  populateYearFilter();
  updateTotals();
  updateProgress();

  if (data.length > 0) {
    showCard();
  }
}

/* ================= SUPABASE ================= */

/* ================= SUPABASE ================= */

const SUPABASE_URL = "https://xbayklklcdohewvnbglq.supabase.co";

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiYXlrbGtsY2RvaGV3dm5iZ2xxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjQ0ODYsImV4cCI6MjA4NzEwMDQ4Nn0.ZPfwZfGGfziSw5CzehkW1S3m40Gf1FOPXeG7Je3Cp7Q";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

/* 🔐 ADD THIS RIGHT HERE */
async function getValidAccessToken() {
  let { data: { session } } = await supabaseClient.auth.getSession();

  if (!session?.access_token) {
    const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();
    if (refreshError || !refreshed?.session?.access_token) {
      alert("You must be logged in.");
      throw new Error("No valid session");
    }
    session = refreshed.session;
  }

  const { error: userError } = await supabaseClient.auth.getUser(session.access_token);
  if (userError) {
    const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();
    if (refreshError || !refreshed?.session?.access_token) {
      alert("Your session expired. Please log in again.");
      throw new Error("Session expired");
    }
    session = refreshed.session;
  }

  return session.access_token;
}

async function getAuthHeaders() {
  const token = await getValidAccessToken();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "apikey": SUPABASE_ANON_KEY
  };
}

async function invokeEdgeFunction(functionName, payload) {
  const headers = await getAuthHeaders();

  let response;

  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn(`Edge function ${functionName} network/CORS failure`, error);
    return {
      response: { ok: false, status: 0 },
      result: {
        error: {
          code: "EDGE_FUNCTION_FETCH_FAILED",
          message: "Unable to reach Supabase edge function (likely CORS, network, or undeployed function)."
        }
      }
    };
  }

  if (response.status === 401) {
    const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();

    if (!refreshError && refreshed?.session?.access_token) {
      try {
        response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
          method: "POST",
          headers: {
            ...headers,
            authorization: `Bearer ${refreshed.session.access_token}`
          },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        console.warn(`Edge function ${functionName} retry network/CORS failure`, error);
        return {
          response: { ok: false, status: 0 },
          result: {
            error: {
              code: "EDGE_FUNCTION_FETCH_FAILED",
              message: "Unable to reach Supabase edge function after token refresh."
            }
          }
        };
      }
    }
  }

  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { error: text || `Edge function ${functionName} failed.` };
  }

  return { response, result };
}
  async function login() {

  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    alert(error.message);
    return;
  }

  document.getElementById("authPanel").style.display = "none";
  app.style.display = "block";

  await loadTransactions();
}

async function checkSession() {

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    document.getElementById("authPanel").style.display = "none";
    app.style.display = "block";
    await loadTransactions();
  } else {
    document.getElementById("authPanel").style.display = "block";
    app.style.display = "none";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  enableHaptics();
  checkSession();
});

const categories=[
{
name:"COGS - Ingredients",
class:"cogs",
description:`
<strong>Definition:</strong><br>
Raw materials that physically become part of a finished Bathhouse product.<br><br>

<strong>Examples:</strong><br>
• Olive oil, coconut oil, shea butter<br>
• Grass-fed tallow<br>
• Essential oils & phthalate-free fragrance oils<br>
• Lye<br>
• Mica, titanium dioxide (in product)<br>
• Goat milk<br>
• Aloe juice (in soap/lotion)<br><br>

<strong>Does NOT Include:</strong><br>
• Cleaning chemicals<br>
• Soap nuts for cleaning<br>
• Store hand soap<br><br>

Ask yourself: Does this physically go inside the product being sold?
`
},
{
name:"COGS - Packaging",
class:"cogs",
description:`
<strong>Definition:</strong><br>
Packaging that becomes part of the product at time of sale.<br><br>

<strong>Examples:</strong><br>
• Soap boxes<br>
• Shrink wrap<br>
• Product labels<br>
• Ingredient labels<br>
• Jars & pump tops<br>
• Lip balm tubes<br>
• Deodorant tubes<br>
• Inserts inside retail packaging<br><br>

<strong>Does NOT Include:</strong><br>
• Shipping boxes<br>
• Tissue paper in shipments<br>
• Packing tape<br>
• Shipping labels<br><br>

Rule: If it stays attached to the product itself → Packaging.
`
},
{
name:"COGS - Resale Inventory",
class:"cogs",
description:`
Items purchased finished and resold without modification.<br><br>

Examples:<br>
• Pumice stones sold as-is<br>
• Sleep masks<br>
• Wholesale accessories<br>
`
},
{
name:"COGS - Production Supplies",
class:"cogs",
description:`
Consumables used during production but not in final product.<br><br>

Examples:<br>
• Gloves<br>
• Mixing sticks<br>
• Alcohol for sanitizing<br>
• Paper towels used in production<br>
• Mold liners<br>
`
},
{
name:"COGS - Shipping from Suppliers",
class:"cogs",
description:`
Freight-in paid to receive ingredients or inventory.<br><br>

Examples:<br>
• Shipping from Wholesale Supplies Plus<br>
• Freight charges on jars<br>
• UPS cost from ingredient vendors<br>
`
},
{
name:"Shipping Supplies",
class:"expense",
description:`
Materials used to ship orders to customers.<br><br>

Examples:<br>
• Shipping boxes<br>
• Tissue paper in shipping box<br>
• Bubble wrap<br>
• Packing tape<br>
• Order stickers<br>
• Shipping label paper<br><br>

This is NOT COGS.
`
},
{
name:"Shipping to Customers",
class:"expense",
description:`
Postage or shipping labels purchased to send orders.<br><br>

Examples:<br>
• USPS postage<br>
• UPS postage<br>
• Shopify shipping labels<br>
`
},
{
name:"Advertising & Marketing",
class:"expense",
description:`
Promotional spending to generate sales.<br><br>

Examples:<br>
• Facebook ads<br>
• Google Ads<br>
• Newspaper ads<br>
• Loofah Fest signage<br>
• Canva Pro (if marketing related)<br>
`
},
{
name:"Commissions & Merchant Fees",
class:"expense",
description:`
Transaction fees charged by payment processors.<br><br>

Examples:<br>
• Shopify processing fees<br>
• Square fees<br>
• Faire commission fees<br>
`
},
{
name:"Software & Subscriptions",
class:"expense",
description:`
Recurring digital tools used to run Bathhouse.<br><br>

Examples:<br>
• Shopify subscription<br>
• QuickBooks<br>
• Supabase<br>
• Plaid<br>
`
},
{
name:"Insurance",
class:"expense",
description:`Business or product liability insurance.`
},
{
name:"Utilities",
class:"expense",
description:`Electric, water, internet used for business.`
},
  {
  name:"Office Supplies",
  class:"expense",
  description:`
Office consumables used to operate Bathhouse Trading Company.

Examples:
• Printer paper
• Receipt paper
• Pens
• File folders
• Storage bins
• Desk organizers

Does NOT include:
• Product packaging
• Shipping supplies
• Equipment over $2,500 (capital asset)
`
},
  {
name:"Equipment",
class:"expense",
description:`
Business equipment purchases under IRS capitalization threshold.

Examples:
• Label printer
• Small shelving
• Storage racks
• Small tools
• Washer/dryer (if expensed, not depreciated)

Note: Larger capital assets may require depreciation.
`
},
  {
name:"Meals",
class:"expense",
description:`
Business meals related to operations.

Examples:
• Vendor meetings
• Market event meals
• Business planning lunches

Note: Typically 50% deductible.
`
},
{
name:"Professional Services",
class:"expense",
description:`CPA, legal fees, consulting services.`
},
{
name:"Fuel",
class:"expense",
description:`Gas used for markets, supply pickups, or business travel.`
},
{
name:"Taxes & Licenses",
class:"expense",
description:`Business license fees and state filings (not income tax).`
},
{
  name:"Sales Tax Paid",
  class:"expense",
  description:`
Sales tax paid on business purchases.

Examples:
• Sales tax on ingredient purchases
• Sales tax on packaging
• Sales tax on equipment

This is NOT income tax.
`
},
{
name:"Interest Expense",
class:"expense",
description:`Credit card or business loan interest.`
},

{
name:"Needs Review",
class:"special",
description:`If unsure, temporarily park the transaction here.`
}
];
const categoryAliases = {

  // Software rename
  "Software": "Software & Subscriptions",

  // Advertising rename
  "Advertising": "Advertising & Marketing",

  // Gas rename
  "Gas": "Fuel",

  // Interest rename
  "Other Interest": "Interest Expense",

  // Office rename (choose correct destination)
  "Office / Admin": "Office Supplies",

  // Old spelling
  "COGS - Resell Inventory": "COGS - Resale Inventory",

  // Explicit no category
  "NO CATEGORY": "Needs Review",

  // Merchant rename
  "Merchant Processing Fees": "Commissions & Merchant Fees",

  // Legacy auto-tax split bucket
  "Line Items": "Sales Tax Paid"

};

const categoryTaxMetadata = {
  "COGS - Ingredients": {
    tax_treatment: "cogs",
    schedule_c_reference: "Schedule C Part III - Cost of Goods Sold",
    tax_note: "Direct materials that become part of inventory.",
  },
  "COGS - Packaging": {
    tax_treatment: "cogs",
    schedule_c_reference: "Schedule C Part III - Cost of Goods Sold",
    tax_note: "Packaging that stays with inventory at sale.",
  },
  "COGS - Resale Inventory": {
    tax_treatment: "cogs",
    schedule_c_reference: "Schedule C Part III - Cost of Goods Sold",
    tax_note: "Finished goods purchased for resale.",
  },
  "COGS - Production Supplies": {
    tax_treatment: "review",
    schedule_c_reference: "Review - COGS vs Line 22 Supplies",
    tax_note: "Indirect production consumables may need accountant review before filing.",
  },
  "COGS - Shipping from Suppliers": {
    tax_treatment: "cogs",
    schedule_c_reference: "Schedule C Part III - Cost of Goods Sold",
    tax_note: "Freight-in commonly attaches to inventory cost.",
  },
  "Shipping Supplies": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 22 or Line 27a review",
    tax_note: "Customer-order shipping materials may be treated as supplies or other expense.",
  },
  "Shipping to Customers": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 27a Other Expenses",
    tax_note: "Postage and delivery expense typically exported as other expense.",
  },
  "Advertising & Marketing": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 8 - Advertising",
    tax_note: "Maps cleanly to advertising expense.",
  },
  "Commissions & Merchant Fees": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 10 - Commissions and fees",
    tax_note: "Processor and marketplace fees.",
  },
  "Software & Subscriptions": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 27a - Other Expenses",
    tax_note: "Software subscriptions should usually remain itemized as other expenses.",
  },
  "Insurance": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 15 - Insurance",
    tax_note: "Business and product liability coverage.",
  },
  "Utilities": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 25 - Utilities",
    tax_note: "Utilities used in the business.",
  },
  "Office Supplies": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 18 - Office expense",
    tax_note: "Office consumables and admin supplies.",
  },
  "Equipment": {
    tax_treatment: "review",
    schedule_c_reference: "Review - current expense vs depreciation",
    tax_note: "Assets may require capitalization, depreciation, or Section 179 treatment.",
  },
  "Meals": {
    tax_treatment: "review",
    schedule_c_reference: "Schedule C Line 24b - Meals",
    tax_note: "Deductibility may be limited and substantiation is required.",
  },
  "Professional Services": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 17 - Legal and professional services",
    tax_note: "CPA, legal, and outside professional support.",
  },
  "Fuel": {
    tax_treatment: "review",
    schedule_c_reference: "Review - vehicle expense support required",
    tax_note: "Fuel often needs mileage/method support before it belongs on Schedule C line 9.",
  },
  "Taxes & Licenses": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 23 - Taxes and licenses",
    tax_note: "Business taxes, filing fees, and licenses other than federal income tax.",
  },
  "Sales Tax Paid": {
    tax_treatment: "review",
    schedule_c_reference: "Review - usually fold into underlying expense or inventory cost",
    tax_note: "Standalone sales tax buckets often need consolidation before filing.",
  },
  "Interest Expense": {
    tax_treatment: "expense",
    schedule_c_reference: "Schedule C Line 16b - Other interest",
    tax_note: "Business credit card or loan interest, if properly separated from principal.",
  },
  "Needs Review": {
    tax_treatment: "review",
    schedule_c_reference: "Review required before export",
    tax_note: "Not ready for tax filing.",
  },
};

function normalizeCategoryName(name){
  const normalized = String(name || "").trim();
  return categoryAliases[normalized] || normalized || "Needs Review";
}

function getCategoryTaxMetadata(name){
  const normalized = normalizeCategoryName(name);
  return categoryTaxMetadata[normalized] || {
    tax_treatment: "review",
    schedule_c_reference: "Review required before export",
    tax_note: "No tax mapping has been assigned yet.",
  };
}
/* ================= SEARCH ================= */

function openSearchModal(){
modalTitle.innerText="Search Transactions";
modalContent.innerHTML=`
<input type="text" id="searchInput" placeholder="Search vendor or amount..." style="margin-bottom:10px;">
<div id="searchResults"></div>
`;
document.getElementById("searchInput").addEventListener("input",updateSearchResults);
openModal();
setTimeout(() => {
document.getElementById("searchInput").focus();
}, 50);
}

function populateYearFilter(){
  const years = new Set();

  data.forEach(d=>{
    if(!d.Date) return;
    const year = d.Date ? d.Date.toString().slice(0,4) : null;
    if(!isNaN(year)) years.add(year.toString());
  });

  const sortedYears = Array.from(years).sort((a,b)=>b-a);

  if (sortedYears.length === 0) {
    activeYearFilter = null;
    updateDateFilterSummary();
    return;
  }

  if (activeYearFilter && !sortedYears.includes(activeYearFilter)) {
    activeYearFilter = null;
  }
  updateDateFilterSummary();
}
async function forcePlaidSync(){

  try {

    const { data: { session } } = await supabaseClient.auth.getSession();

    if(!session){
      alert("Not logged in");
      return;
    }

    const res = await fetch(
      edgeFunctionUrl("sync-plaid-transactions"),
      {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({
          user_id: session.user.id,
          reset_cursor: true
        })
      }
    );

    const result = await res.json();

    if(!res.ok){
      console.error(result);
      alert("Transaction sync failed");
      return;
    }

    if (result.webhook_repair_errors?.length) {
      console.error("Plaid webhook repair errors:", result.webhook_repair_errors);
    }

    await loadTransactions();

    const resetLabel = result.reset_cursor ? " Full resync completed." : "";
    const repairedLabel = typeof result.webhook_repairs === "number"
      ? ` Webhooks repaired: ${result.webhook_repairs}.`
      : "";
    const repairErrorLabel = result.webhook_repair_errors?.length
      ? ` Webhook repair errors: ${result.webhook_repair_errors.length}.`
      : "";

    alert(`Transactions synced!${resetLabel}${repairedLabel}${repairErrorLabel}`);

  } catch(err){
    console.error(err);
    alert("Sync error");
  }

}
function applyYearFilter(yearValue){
  activeYearFilter = yearValue || null;
  activeSearchFilter = null;
  document.getElementById("clearSearchBtn").style.display = "none";
  currentIndex = 0;
  const hasYearFilter = !!activeYearFilter;
  const hasDateRange = !!(activeStartDateFilter || activeEndDateFilter);
  const hasTypeFilter = (activeTransactionTypeFilter || "all") !== "all";
  document.getElementById("clearDateBtn").style.display = (hasYearFilter || hasDateRange || hasTypeFilter) ? "block" : "none";
  updateTotals();
  updateProgress();
  showCard();
  updateDateFilterSummary();
}

function applyDateFilter(startVal = "", endVal = ""){
  activeStartDateFilter = startVal || null;
  activeEndDateFilter = endVal || null;
  currentIndex = 0;
  const hasYearFilter = !!activeYearFilter;
  const hasDateRange = !!(activeStartDateFilter || activeEndDateFilter);
  const hasTypeFilter = (activeTransactionTypeFilter || "all") !== "all";
  document.getElementById("clearDateBtn").style.display = (hasYearFilter || hasDateRange || hasTypeFilter) ? "block" : "none";
  updateTotals();
  updateProgress();
  showCard();
  updateDateFilterSummary();
}

function applyTransactionTypeFilter(){
  const val = document.getElementById("transactionFilter")?.value || "all";
  activeTransactionTypeFilter = val;
  currentIndex = 0;
  const hasYearFilter = !!activeYearFilter;
  const hasDateRange = !!(activeStartDateFilter || activeEndDateFilter);
  const hasTypeFilter = val !== "all";
  document.getElementById("clearDateBtn").style.display = (hasYearFilter || hasDateRange || hasTypeFilter) ? "block" : "none";
  updateTotals();
  updateProgress();
  showCard();
  updateDateFilterSummary();
}

function clearDateFilter(){
  activeYearFilter = null;
  activeStartDateFilter = null;
  activeEndDateFilter = null;
  activeTransactionTypeFilter = "all";
  const transactionTypeInput = document.getElementById("transactionFilter");
  if(transactionTypeInput) transactionTypeInput.value = "all";
  document.getElementById("clearDateBtn").style.display = "none";
  currentIndex = 0;
  updateTotals();
  updateProgress();
  showCard();
  updateDateFilterSummary();
}

function openDateFilterModal(){
  const years = new Set();
  data.forEach(d=>{
    if(!d.Date) return;
    const year = d.Date.toString().slice(0,4);
    if(!isNaN(year)) years.add(year.toString());
  });
  const sortedYears = Array.from(years).sort((a,b)=>b-a);

  modalTitle.innerText = "Date Filter";
  modalContent.innerHTML = `
    <div style="display:grid;gap:10px;padding:8px 0;">
      <label>Year
        <select id="modalYearFilter">
          <option value="">All Years</option>
          ${sortedYears.map(y=>`<option value="${y}" ${activeYearFilter===y ? "selected" : ""}>${y}</option>`).join("")}
        </select>
      </label>
      <label>Start Date
        <input type="date" id="modalStartDateFilter" value="${activeStartDateFilter || ""}">
      </label>
      <label>End Date
        <input type="date" id="modalEndDateFilter" value="${activeEndDateFilter || ""}">
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button class="touchButton" style="background:#0f766e;color:#fff;" onclick="applyDateFilterFromModal()">Apply Filter</button>
        <button class="touchButton" style="background:#6b7280;color:#fff;" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `;
  openModal();
}

function applyDateFilterFromModal(){
  const yearVal = document.getElementById("modalYearFilter")?.value || "";
  const startVal = document.getElementById("modalStartDateFilter")?.value || "";
  const endVal = document.getElementById("modalEndDateFilter")?.value || "";
  applyYearFilter(yearVal);
  applyDateFilter(startVal, endVal);
  closeModal();
}

function updateDateFilterSummary(){
  const summaryEl = document.getElementById("dateFilterSummary");
  if(!summaryEl) return;
  const parts = [];
  if(activeYearFilter) parts.push(`Year: ${activeYearFilter}`);
  if(activeStartDateFilter) parts.push(`From: ${activeStartDateFilter}`);
  if(activeEndDateFilter) parts.push(`To: ${activeEndDateFilter}`);
  summaryEl.innerText = parts.length ? parts.join(" • ") : "All dates";
}

function updateSearchResults(){
const query=document.getElementById("searchInput").value.trim().toLowerCase();
const resultsDiv=document.getElementById("searchResults");
resultsDiv.innerHTML="";
if(!query) return;

const numeric=parseFloat(query);

getVisibleIndexes().forEach(i=>{
  const d = data[i];
let vendorMatch=d.Vendor && d.Vendor.toLowerCase().includes(query);
let amountMatch=!isNaN(numeric) && normalizeMoney(d.Amount)===numeric;

if(vendorMatch || amountMatch){
resultsDiv.innerHTML+=`
<div class="modalItem" onclick="applySearchFilter(${i})">
${escapeHtml(d.Vendor || d.Title || "Untitled Transaction")} — $${normalizeMoney(d.Amount).toFixed(2)}
</div>`;
}
});
}

function applySearchFilter(index){

  const visible = getVisibleIndexes();

  // If the clicked item is NOT inside the current filtered view,
  // do NOT jump to it.
  if(!visible.includes(index)){
    alert("This transaction is outside your current filter.");
    return;
  }

  currentIndex = index;

  closeModal();
  showCard();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearSearchFilter(){
activeSearchFilter=null;
document.getElementById("clearSearchBtn").style.display="none";
showCard();
}

/* ================= CREATE TRANSACTION ================= */

function openCreateTransactionModal(){

modalTitle.innerText = "Create Transaction";

modalContent.innerHTML = `
<div style="display:flex; flex-direction:column; gap:12px;">

<label>Vendor</label>
<input type="text" id="newVendor">

<label>Date</label>
<input type="date" id="newDate">

<label>Amount</label>
<input type="number" step="0.01" id="newAmount">

<button class="category-btn expense" onclick="saveNewTransaction()">
Save Transaction
</button>

</div>
`;

openModal();
}

async function saveNewTransaction(){

const vendor = document.getElementById("newVendor").value.trim();
const rawDate = document.getElementById("newDate").value;

let formattedDate = "";
if(rawDate){
const parts = rawDate.split("-");
formattedDate = rawDate; // store as YYYY-MM-DD
}
const amount = parseFloat(document.getElementById("newAmount").value);

if(!vendor || !formattedDate || isNaN(amount)){
alert("Please complete all fields.");
return;
}

const { data: { session } } = await supabaseClient.auth.getSession();
if (!session) {
  alert("You must be logged in.");
  return;
}

const { data: insertedRows, error } = await supabaseClient
  .from("transactions")
  .insert({
    user_id: session.user.id,
    date: formattedDate,
    name: vendor,
    merchant_name: vendor,
    amount,
    category: "",
    splits: [],
    review_status: "",
    deduction_status: "",
    review_note: ""
  })
  .select("id, date, name, merchant_name, amount, category, splits, receipt_url, review_status, deduction_status, review_note")
  .single();

if (error) {
  console.error("Create transaction error:", error);
  alert("Error saving transaction");
  return;
}

// Add instantly to UI (optimistic update)
data.unshift({
  id: insertedRows.id,
  Title: insertedRows.name || insertedRows.merchant_name || "",
  Vendor: insertedRows.merchant_name || insertedRows.name || "",
  Date: insertedRows.date,
  Amount: insertedRows.amount,
  Category: insertedRows.category || "",
  Splits: insertedRows.splits || [],
  ReviewStatus: insertedRows.review_status || "",
  DeductionStatus: insertedRows.deduction_status || "",
  ReviewNote: insertedRows.review_note || "",
  receipt_url: insertedRows.receipt_url || null
});

closeModal();

updateTotals();
updateProgress();
showCard();

// THEN refresh quietly in background
loadTransactions();

// Jump to new transaction
activeSearchFilter = null;
const clearBtn = document.getElementById("clearSearchBtn");
if(clearBtn) clearBtn.style.display = "none";

if(showOnlyUncategorized){
showOnlyUncategorized = false;
const toggleBtn = document.getElementById("filterToggle");
if(toggleBtn) toggleBtn.innerText = "Show Only Uncategorized";
}

currentIndex = 0;
showCard();
}

async function deleteTransaction(){

if(!confirm("Are you sure you want to delete this transaction?")) return;

const id = data[currentIndex].id;

if (id) {
  const { error } = await Api.deleteTransaction(id);
  if(error){
    console.error("Delete transaction error:", error);
    alert("Error deleting transaction.");
    return;
  }
}

data.splice(currentIndex,1);

if(currentIndex >= data.length){
currentIndex = data.length - 1;
}

updateTotals();
updateProgress();

if(data.length === 0){
cardTitle.innerText = "No Transactions";
cardMeta.innerHTML = "";
splitSummary.innerHTML = "";
currentCategory.innerText = "";
return;
}

showCard();
}


/* CSV */

document.getElementById("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
complete: async (res) => {

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    alert("You must be logged in.");
    return;
  }

  const userId = session.user.id;

const rowsToInsert = res.data.map(row => ({
  user_id: userId,
  date: row.date,
  name: row.title,
  merchant_name: row.vendor || row.Vendor || row.VENDOR || "",
  amount: parseFloat(row.amount) || 0,
  category: row.category || "",
  splits: []
}));

  const { error } = await supabaseClient
    .from("transactions")
    .insert(rowsToInsert);

  if (error) {
    console.error(error);
    alert("CSV Import Error");
    return;
  }

  app.style.display = "block";
  await loadTransactions();
}
  });
});

/* Receipt */

function inferReceiptFileKind(pathOrName = "", mimeType = ""){
  const normalizedPath = String(pathOrName || "").toLowerCase().split("?")[0].split("#")[0];
  const normalizedMime = String(mimeType || "").toLowerCase();
  const ext = (normalizedPath.split(".").pop() || "").trim();

  if(ext === "pdf" || normalizedMime === "application/pdf") return "pdf";
  if(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"].includes(ext)) return "image";
  if(normalizedMime.startsWith("image/")) return "image";
  return "unknown";
}

function sanitizeReceiptFileExt(file){
  const mimeExt = receiptFileExtForMimeType(file?.type);
  if(mimeExt) return mimeExt;

  const inferredExt = String(file?.name || "").split(".").pop()?.toLowerCase()?.replace(/[^a-z0-9]/g, "");
  if(inferredExt) return inferredExt;
  if(file?.type === "application/pdf") return "pdf";
  if(String(file?.type || "").startsWith("image/")) return "jpg";
  return "bin";
}

function normalizeReceiptMimeType(value = ""){
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function receiptFileExtForMimeType(mimeType = ""){
  switch(normalizeReceiptMimeType(mimeType)){
    case "application/pdf":
      return "pdf";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "";
  }
}

function isSupportedReceiptImageMimeType(mimeType = ""){
  return ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"].includes(normalizeReceiptMimeType(mimeType));
}

function isBrowserConvertibleReceiptMimeType(mimeType = ""){
  const normalized = normalizeReceiptMimeType(mimeType);
  return normalized.startsWith("image/") && !isSupportedReceiptImageMimeType(normalized);
}

function receiptAsciiFromBytes(bytes){
  return Array.from(bytes || []).map((byte) => String.fromCharCode(byte)).join("");
}

function receiptBytesStartWith(bytes, text){
  if(!bytes || bytes.length < text.length) return false;
  for(let i = 0; i < text.length; i += 1){
    if(bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function sniffReceiptFileMimeType(bytes){
  if(!bytes || !bytes.length) return "";

  if(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if(bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) return "image/png";
  if(receiptBytesStartWith(bytes, "GIF87a") || receiptBytesStartWith(bytes, "GIF89a")) return "image/gif";
  if(bytes.length >= 12 && receiptBytesStartWith(bytes.slice(0, 4), "RIFF") && receiptBytesStartWith(bytes.slice(8, 12), "WEBP")) return "image/webp";
  if(receiptBytesStartWith(bytes, "%PDF-")) return "application/pdf";

  if(bytes.length >= 12 && receiptBytesStartWith(bytes.slice(4, 8), "ftyp")){
    const brandHeader = receiptAsciiFromBytes(bytes.slice(8, Math.min(bytes.length, 64))).toLowerCase();
    if(["heic", "heix", "hevc", "hevx", "heif", "heis", "mif1", "msf1"].some((brand) => brandHeader.includes(brand))){
      return "image/heic";
    }
  }

  return "";
}

async function readReceiptFileHeader(file){
  const header = await file.slice(0, 64).arrayBuffer();
  return new Uint8Array(header);
}

async function prepareReceiptUploadFile(file){
  const headerMimeType = sniffReceiptFileMimeType(await readReceiptFileHeader(file));
  const declaredMimeType = normalizeReceiptMimeType(file.type);
  const fileKind = inferReceiptFileKind(file.name, file.type);

  if(headerMimeType === "application/pdf" || declaredMimeType === "application/pdf"){
    return {
      file,
      contentType: "application/pdf",
      safeExt: "pdf",
      wasConverted: false
    };
  }

  if(isSupportedReceiptImageMimeType(headerMimeType)){
    const contentType = headerMimeType === "image/jpg" ? "image/jpeg" : headerMimeType;
    return {
      file,
      contentType,
      safeExt: receiptFileExtForMimeType(contentType),
      wasConverted: false
    };
  }

  if(headerMimeType === "image/heic" || headerMimeType === "image/heif" || isBrowserConvertibleReceiptMimeType(declaredMimeType)){
    return convertReceiptImageToJpeg(file);
  }

  if(fileKind === "image" && !headerMimeType){
    return convertReceiptImageToJpeg(file);
  }

  if(isSupportedReceiptImageMimeType(declaredMimeType)){
    return {
      file,
      contentType: declaredMimeType === "image/jpg" ? "image/jpeg" : declaredMimeType,
      safeExt: receiptFileExtForMimeType(declaredMimeType),
      wasConverted: false
    };
  }

  throw new Error("Unsupported receipt file. Upload a JPG, PNG, HEIC, or PDF receipt.");
}

async function convertReceiptImageToJpeg(file){
  const objectUrl = URL.createObjectURL(file);
  try{
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("This browser could not decode the receipt image."));
    });
    image.src = objectUrl;
    await loaded;

    if(!image.naturalWidth || !image.naturalHeight){
      throw new Error("The receipt image did not contain valid dimensions.");
    }

    const maxLongSide = 3200;
    const scale = Math.min(1, maxLongSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if(!context) throw new Error("Unable to prepare the receipt image.");

    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if(!blob) throw new Error("Unable to convert the receipt image to JPEG.");

    const baseName = String(file.name || "receipt").replace(/\.[^.]+$/, "").trim() || "receipt";
    return {
      file: new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }),
      contentType: "image/jpeg",
      safeExt: "jpg",
      wasConverted: true
    };
  }finally{
    URL.revokeObjectURL(objectUrl);
  }
}

function receiptPathBaseName(path){
  return String(path || "receipt").split("/").pop()?.replace(/\.[^.]+$/, "").trim() || "receipt";
}

async function createReceiptSignedUrl(path, expiresIn = 60){
  const { data: signedData, error } = await supabaseClient
    .storage
    .from("receipts")
    .createSignedUrl(path, expiresIn);

  if(error || !signedData?.signedUrl){
    throw new Error("Unable to load attached receipt.");
  }

  return signedData.signedUrl;
}

async function fetchAttachedReceiptBlob(path){
  const signedUrl = await createReceiptSignedUrl(path, 60);
  const response = await fetch(signedUrl);
  if(!response.ok){
    throw new Error("Unable to read attached receipt.");
  }
  return response.blob();
}

async function repairAttachedReceiptForAnalysis(item){
  if(!item?.id || !item?.receipt_url) return false;
  if(inferReceiptFileKind(item.receipt_url) === "pdf") return false;

  let blob;
  try{
    blob = await fetchAttachedReceiptBlob(item.receipt_url);
  }catch(error){
    console.warn("Unable to inspect attached receipt before analysis", error);
    return false;
  }

  const headerBytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const headerMimeType = sniffReceiptFileMimeType(headerBytes);
  if(headerMimeType === "application/pdf" || isSupportedReceiptImageMimeType(headerMimeType)){
    return false;
  }

  const shouldTryConversion = headerMimeType === "image/heic"
    || headerMimeType === "image/heif"
    || isBrowserConvertibleReceiptMimeType(blob.type)
    || inferReceiptFileKind(item.receipt_url, blob.type) === "image";
  if(!shouldTryConversion) return false;

  const previousReceiptUrl = item.receipt_url;
  const sourceFile = new File(
    [blob],
    `${receiptPathBaseName(previousReceiptUrl)}.${receiptFileExtForMimeType(blob.type) || "heic"}`,
    { type: blob.type || headerMimeType || "image/heic" }
  );

  let preparedReceipt;
  try{
    preparedReceipt = await convertReceiptImageToJpeg(sourceFile);
  }catch(error){
    console.error("Attached receipt conversion failed", error);
    throw new Error("The attached receipt is HEIC/HEIF even though its name may end in .jpeg. Export it from Preview as JPEG or PNG, then attach that exported file.");
  }

  const filePath = `receipts/${item.id}.jpg`;
  const { error: uploadError } = await supabaseClient
    .storage
    .from("receipts")
    .upload(filePath, preparedReceipt.file, {
      upsert: true,
      contentType: "image/jpeg"
    });

  if(uploadError){
    console.error("Receipt repair upload failed", uploadError);
    throw new Error("Unable to replace the attached HEIC receipt with a JPEG copy.");
  }

  if(previousReceiptUrl !== filePath){
    const { error: updateError } = await supabaseClient
      .from("transactions")
      .update({ receipt_url: filePath })
      .eq("id", item.id);

    if(updateError){
      console.error("Receipt repair DB update failed", updateError);
      await supabaseClient.storage.from("receipts").remove([filePath]);
      throw new Error("Unable to update the transaction to use the converted JPEG receipt.");
    }

    const { error: cleanupError } = await supabaseClient.storage.from("receipts").remove([previousReceiptUrl]);
    if(cleanupError) console.warn("Unable to remove replaced receipt file", cleanupError);
    item.receipt_url = filePath;
  }
  clearReceiptAnalysisCacheForTransaction(item.id);

  return true;
}

async function attachReceipt(e){

const file = e.target.files[0];
if(!file) return;

const fileKind = inferReceiptFileKind(file.name, file.type);
if(fileKind === "unknown"){
  console.error("Unsupported receipt file selected", { fileName: file.name, fileType: file.type });
  alert("Unsupported file type. Please upload JPG, PNG, HEIC, or PDF receipts.");
  e.target.value = "";
  return;
}

const item = data[currentIndex];
if(!item.id){
  alert("Transaction must be saved before attaching receipt.");
  e.target.value = "";
  return;
}

let preparedReceipt;
try{
  preparedReceipt = await prepareReceiptUploadFile(file);
}catch(error){
  console.error("Receipt preparation failed", error);
  alert(error?.message || "Unsupported receipt image. Please upload a JPG, PNG, HEIC, or PDF receipt.");
  e.target.value = "";
  return;
}

const safeExt = preparedReceipt.safeExt || sanitizeReceiptFileExt(preparedReceipt.file);
const filePath = `receipts/${item.id}.${safeExt}`;
const previousReceiptUrl = item.receipt_url;

const { error: uploadError } = await supabaseClient
  .storage
  .from("receipts")
  .upload(filePath, preparedReceipt.file, {
    upsert: true,
    contentType: preparedReceipt.contentType || preparedReceipt.file.type || undefined
  });

if(uploadError){
  console.error("Upload error:", uploadError);
  alert("Error uploading receipt.");
  e.target.value = "";
  return;
}

const { error: updateError } = await supabaseClient
  .from("transactions")
  .update({ receipt_url: filePath })
  .eq("id", item.id);

if(updateError){
  console.error("DB update error:", updateError);
  await supabaseClient.storage.from("receipts").remove([filePath]);
  alert("Error saving receipt reference.");
  e.target.value = "";
  return;
}

item.receipt_url = filePath;
if(previousReceiptUrl && previousReceiptUrl !== filePath){
  const { error: cleanupError } = await supabaseClient.storage.from("receipts").remove([previousReceiptUrl]);
  if(cleanupError) console.warn("Unable to remove previous receipt file", cleanupError);
}
clearReceiptAnalysisCacheForTransaction(item.id);

showCard(); // refreshes the UI
alert("Receipt saved successfully.");
e.target.value = "";
}

function buildReceiptFallbackMarkup(message, url = ""){
  const safeMessage = escapeHtml(message || "Receipt preview is unavailable.");
  const openLink = url
    ? `<div style="margin-top:10px;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open receipt in a new tab</a></div>`
    : "";
  return `<div class="receiptFallback">${safeMessage}${openLink}</div>`;
}

function attachReceiptPreviewHandlers(container, { url, fileKind }){
  if(!container) return;

  const showFallback = (message) => {
    console.error("Receipt preview rendering failed", { url, fileKind, message });
    container.innerHTML = buildReceiptFallbackMarkup(message, url);
  };

  if(fileKind === "pdf"){
    const frame = container.querySelector("iframe");
    if(!frame){
      showFallback("Unable to render PDF preview.");
      return;
    }

    let loaded = false;
    const timeoutId = setTimeout(() => {
      if(!loaded) showFallback("PDF preview timed out. Your browser may not support inline PDF for this file.");
    }, 5000);

    frame.addEventListener("load", () => {
      loaded = true;
      clearTimeout(timeoutId);
    }, { once: true });

    frame.addEventListener("error", () => {
      clearTimeout(timeoutId);
      showFallback("Failed to load PDF preview.");
    }, { once: true });

    return;
  }

  const img = container.querySelector("img");
  if(!img){
    showFallback("Unable to render image preview.");
    return;
  }

  img.addEventListener("load", () => {
    if(!img.naturalWidth || !img.naturalHeight){
      showFallback("Image loaded but dimensions are invalid.");
      return;
    }

    const viewportWidth = container.clientWidth;
    const renderedWidth = img.clientWidth;
    if(viewportWidth > 0 && renderedWidth === 0){
      showFallback("Image loaded but did not render. Try opening the receipt in a new tab.");
    }
  }, { once: true });

  img.addEventListener("error", () => {
    showFallback("Failed to load image preview. The file may be unsupported by this browser (HEIC on some devices).");
  }, { once: true });
}

async function openReceiptViewerModal(item, backAction = "", title = "Receipt Preview"){

const backRoute = typeof backAction === "string" ? backAction : "";
setModalBackAction(backRoute ? ModalRoutes[backRoute] : (typeof backAction === "function" ? backAction : null));

if(!item?.id) return;

if(!item.receipt_url){
  alert("No receipt attached.");
  return;
}

let url;
try{
  url = await createReceiptSignedUrl(item.receipt_url, 60);
}catch(error){
  console.error(error);
  alert("Unable to load receipt.");
  return;
}

modalTitle.innerText = title;

const fileKind = inferReceiptFileKind(item.receipt_url);
const renderAsPdf = fileKind === "pdf";
const footerButtons = [
  `<button class="touchButton" style="background:#111827;color:white;" onclick="openReceiptFullscreen(${htmlJsString(url)}, ${htmlJsString(fileKind)})">Expand Fullscreen</button>`
];

if(backAction){
  if(backRoute){
    footerButtons.unshift(`<button class="touchButton" style="background:#1565c0;color:#fff;" onclick="runModalRoute(${htmlJsString(backRoute)})">Back</button>`);
  }
}

modalContent.innerHTML = `
  <div style="height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:10px;">
    <div class="receiptViewport" id="receiptPreviewViewport" style="max-height:100%;">
      ${renderAsPdf ? `<iframe src="${escapeHtml(url)}" title="Receipt PDF" loading="lazy"></iframe>` : `<img src="${escapeHtml(url)}" alt="Receipt image" loading="lazy" decoding="async">`}
    </div>
    <div style="display:grid;grid-template-columns:repeat(${footerButtons.length},minmax(0,1fr));gap:8px;">
      ${footerButtons.join("")}
    </div>
  </div>
`;

const previewViewport = document.getElementById("receiptPreviewViewport");
attachReceiptPreviewHandlers(previewViewport, { url, fileKind: renderAsPdf ? "pdf" : "image" });

openModal();
}

async function viewReceipt(){
  const item = data[currentIndex];
  await openReceiptViewerModal(item);
}

async function removeReceipt(){

const item = data[currentIndex];
if(!item.id || !item.receipt_url) return;

const { error: storageError } = await supabaseClient
  .storage
  .from("receipts")
  .remove([item.receipt_url]);

if(storageError){
  console.error("Storage delete error:", storageError);
  alert("Error deleting file from storage.");
  return;
}

const { error: dbError } = await supabaseClient
  .from("transactions")
  .update({ receipt_url: null })
  .eq("id", item.id);

if(dbError){
  console.error("DB update error:", dbError);
  alert("Error clearing receipt reference.");
  return;
}

item.receipt_url = null;
clearReceiptAnalysisCacheForTransaction(item.id);

showCard();
alert("Receipt removed successfully.");
}

/* Filter */

function toggleFilter(){
  showOnlyUncategorized = !showOnlyUncategorized;

  const btn = document.getElementById("filterToggle");
  if(btn){
    btn.innerText = showOnlyUncategorized
      ? "Show All Transactions"
      : "Show Only Uncategorized";
  }

  updateProgress();
  showCard();
}

function getVisibleIndexes(){

let baseList;

if(!showOnlyUncategorized){
baseList = data.map((_,i)=>i);
}else{
baseList = data.map((d,i)=>!d.Category?i:null).filter(i=>i!==null);
}

let filtered = baseList;

if(activeYearFilter){
  filtered = filtered.filter(i=>{
    const d = data[i];
    if(!d.Date) return false;

    const year = d.Date ? d.Date.toString().slice(0,4) : null;
    return year === activeYearFilter;
  });
}

if(activeStartDateFilter || activeEndDateFilter){
  filtered = filtered.filter(i=>{
    const d = data[i];
    if(!d.Date) return false;
    const normalized = d.Date.toString().slice(0,10);
    if(activeStartDateFilter && normalized < activeStartDateFilter) return false;
    if(activeEndDateFilter && normalized > activeEndDateFilter) return false;
    return true;
  });
}

if(activeTransactionTypeFilter && activeTransactionTypeFilter !== "all"){
  filtered = filtered.filter(i=>{
    const d = data[i];
    const hasCategory = !!(d.Category && String(d.Category).trim());
    const hasReceipt = !!d.receipt_url;

    if(activeTransactionTypeFilter === "uncategorized") return !hasCategory;
    if(activeTransactionTypeFilter === "categorized") return hasCategory;
    if(activeTransactionTypeFilter === "with_receipt") return hasReceipt;
    if(activeTransactionTypeFilter === "without_receipt") return !hasReceipt;
    return true;
  });
}

if(!activeSearchFilter) return filtered;

return filtered.filter(i=>{
const d=data[i];

const vendorMatch =
activeSearchFilter.vendor &&
d.Vendor === activeSearchFilter.vendor;

const amountMatch =
activeSearchFilter.amount != null &&
normalizeMoney(d.Amount) === activeSearchFilter.amount;

return vendorMatch || amountMatch;
});
}

/* Navigation */

function goNext(){
  const visible = getVisibleIndexes();

  let pos = visible.indexOf(currentIndex);

  // 🔥 FIX: if index not found, don't reset to 0
  if(pos === -1){
    // try to move forward based on raw index instead
    const next = visible.find(i => i > currentIndex);

    if(next !== undefined){
      currentIndex = next;
      showCard();
    }
    return;
  }

  if(pos < visible.length - 1){
    currentIndex = visible[pos + 1];
    showCard();
  }
}

function goBack(){
  const visible = getVisibleIndexes();

  let pos = visible.indexOf(currentIndex);

  if(pos === -1){
    const prev = [...visible].reverse().find(i => i < currentIndex);

    if(prev !== undefined){
      currentIndex = prev;
      showCard();
    }
    return;
  }

  if(pos > 0){
    currentIndex = visible[pos - 1];
    showCard();
  }
}

/* Category Buttons */

function renderCategories(){
const div=document.getElementById("categoryButtons");
if(!div) return;

const item = data[currentIndex] || {};

const receiptButtons = `
  <div class="pillRow">
    ${item.receipt_url ? `<button class="compactActionBtn primary touchButton" onclick="viewReceipt()">👁 View</button>` : ""}
    <label class="compactActionBtn upload" for="receiptUploadInput">📎 Add Receipt</label>
    ${item.receipt_url ? `<button class="compactActionBtn danger touchButton" onclick="removeReceipt()">✕ Remove Receipt</button>` : ""}
    <input id="receiptUploadInput" class="receiptUploadInput" type="file" accept="image/*,.pdf,.heic,.heif,image/heic,image/heif" onchange="attachReceipt(event)">
  </div>`;

div.innerHTML = `
  <div class="workflowSection">
    <section class="uiSection">
      <div class="sectionLabel">Navigation</div>
      <div class="navActionRow">
        <button class="navBtn" onclick="goBack()">⬅ Back</button>
        <button class="navBtn" onclick="goNext()">Next ➡</button>
      </div>
    </section>

    <section class="uiSection">
      <div class="sectionLabel">Categorization Actions</div>
      <div class="middleActions categoryPickerActions">
        <button class="category-btn" style="background:#1e3a8a;" onclick="openCategoryModal()">Choose Category</button>
        <button class="category-btn" style="background:#ff9800;" onclick="openSplitModal()">Split Transaction</button>
      </div>
    </section>

    <section class="uiSection">
      <div class="sectionLabel">Tools</div>
      <button class="secondaryActionBtn toolsBtn touchButton" onclick="askAI()">Ask AI</button>
    </section>

    <section class="uiSection">
      <div class="sectionLabel">Receipt Actions</div>
      ${receiptButtons}
    </section>

    <section class="uiSection dangerZone">
      <div class="sectionLabel">Danger Zone</div>
      <button class="deletePillBtn touchButton" style="width:100%;" onclick="deleteTransaction()">Delete Transaction</button>
    </section>
  </div>
`;
}


function generateCategoryButtons(){
  return generateCategoryButtonsForAction("selectCategory");
}

function escapeForSingleQuote(value){
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function generateCategoryButtonsForAction(actionName, actionArgs = []){
  const serializedArgs = actionArgs.map((arg) => `'${escapeForSingleQuote(arg)}'`).join(", ");
  return `
    <div style="padding:10px; display:flex; flex-direction:column; gap:8px;">
      <button class="touchButton" type="button" onclick="dismissModalToContext()" style="background:#6b7280;color:#fff;">← Back</button>
      ${categories.map(c => `
        <div class="categoryPickerRow">
          <button class="category-btn ${c.class}"
            style="width:100%; text-align:left; padding:12px; border-radius:12px;"
            onclick="${actionName}(${serializedArgs}${serializedArgs ? ", " : ""}'${escapeForSingleQuote(c.name)}')">
            ${escapeHtml(c.name)}
          </button>
          <button class="touchButton categoryInfoInline" onclick="showCategoryInfo('${escapeForSingleQuote(c.name)}')">i</button>
        </div>
      `).join("")}
    </div>
  `;
}

function openCategoryModal(){
  setModalBackAction(null);
  aiContext = null;
  modalTitle.innerText = "Choose Category";
  modalContent.innerHTML = generateCategoryButtonsForAction("selectCategory");
  openModal(100000);
}

function showCategoryInfo(name){

  const category = categories.find(c => c.name === name);
  if(!category) return;

  const modal = document.createElement("div");

  modal.style.position = "fixed";
  modal.style.top = "0";
  modal.style.left = "0";
  modal.style.width = "100%";
  modal.style.height = "100%";
  modal.style.background = "rgba(0,0,0,0.5)";
  modal.style.display = "flex";
  modal.style.alignItems = "center";
  modal.style.justifyContent = "center";
  modal.style.zIndex = "100000"; // 👈 above picker

  modal.innerHTML = `
    <div style="
      background:white;
      width:90%;
      max-width:500px;
      max-height:80vh;
      border-radius:16px;
      padding:16px;
      overflow:auto;
      box-sizing:border-box;
    ">

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h3 style="margin:0;">${escapeHtml(category.name)}</h3>
        <button onclick="closeCategoryInfo()" style="
          background:#c62828;
          color:white;
          border:none;
          padding:6px 10px;
          border-radius:8px;
        ">✕</button>
      </div>

      <div style="font-size:14px; line-height:1.5;">
        ${category.description || "No description available."}
      </div>

    </div>
  `;

  document.body.appendChild(modal);

  window.closeCategoryInfo = () => {
    document.body.removeChild(modal);
  };

}

async function categorize(name){

  const item = data[currentIndex];
  if(!item) return;
  const categoryName = getAllowedCategoryName(name);
  const previousCategory = item.Category;
  const previousSplits = Array.isArray(item.Splits) ? [...item.Splits] : [];

  item.Category = categoryName;
  item.Splits = [];

  updateTotals();
  updateProgress();

  if(item.id){
    const { error } = await Api.updateTransaction(item.id, {
      category: categoryName,
      splits: []
    });

    if(error){
      item.Category = previousCategory;
      item.Splits = previousSplits;
      updateTotals();
      updateProgress();
      console.error("Category save error:", error);
      alert("Error saving category to database.");
      return;
    }
  }

  // 🔥 slight delay prevents UI race condition
  setTimeout(() => {
    goNext();
  }, 0);
}

const SplitState = {
  manualAmount: 0,
  manualCategory: null,
  highlightedIndex: null,
  receiptAnalysisCache: {},
  detectedMerchant: "misc",
  detectedItemNumbers: [],
  detectedParsedItems: [],
  detectedResolvedProducts: {},
  detectedLineItemPrices: {},
  detectedReceiptTax: null,
  detectedReceiptSubtotal: null,
  detectedReceiptTotal: null,
  detectedUnassignedDiscount: 0,
  detectedTransactionId: null,
  receiptMathValidation: null,
  receiptItemDrafts: {},
  receiptItemEditorOpen: {},
  receiptNameDrafts: {},
  selectedDetectedItem: null,
  receiptExpanded: false,
  keypad: {
    value: "",
    max: Infinity,
    onChange: null,
    onConfirm: null,
    onCancel: null
  }
};

function clonePlainValue(value){
  if(value == null) return value;
  try{
    return JSON.parse(JSON.stringify(value));
  }catch{
    return value;
  }
}

function getReceiptAnalysisCacheKey(item){
  if(!item?.id || !item?.receipt_url) return "";
  return `${String(item.id)}::${String(item.receipt_url)}`;
}

function buildReceiptAnalysisSnapshot(item){
  const key = getReceiptAnalysisCacheKey(item);
  if(!key) return null;

  return {
    key,
    transactionId: String(item.id),
    receiptUrl: String(item.receipt_url),
    detectedMerchant: SplitState.detectedMerchant || "misc",
    detectedItemNumbers: clonePlainValue(SplitState.detectedItemNumbers || []),
    detectedParsedItems: clonePlainValue(SplitState.detectedParsedItems || []),
    detectedResolvedProducts: clonePlainValue(SplitState.detectedResolvedProducts || {}),
    detectedLineItemPrices: clonePlainValue(SplitState.detectedLineItemPrices || {}),
    detectedReceiptTax: SplitState.detectedReceiptTax,
    detectedReceiptSubtotal: SplitState.detectedReceiptSubtotal,
    detectedReceiptTotal: SplitState.detectedReceiptTotal,
    detectedUnassignedDiscount: SplitState.detectedUnassignedDiscount || 0,
    receiptMathValidation: clonePlainValue(SplitState.receiptMathValidation || null),
    receiptNameDrafts: clonePlainValue(SplitState.receiptNameDrafts || {}),
    cachedAt: Date.now()
  };
}

function storeReceiptAnalysisCache(item = data[currentIndex]){
  const snapshot = buildReceiptAnalysisSnapshot(item);
  if(!snapshot) return;
  SplitState.receiptAnalysisCache[snapshot.key] = snapshot;
}

function getReceiptAnalysisCache(item){
  const key = getReceiptAnalysisCacheKey(item);
  if(!key) return null;

  const snapshot = SplitState.receiptAnalysisCache[key];
  if(!snapshot) return null;
  if(String(snapshot.transactionId || "") !== String(item.id || "")) return null;
  if(String(snapshot.receiptUrl || "") !== String(item.receipt_url || "")) return null;

  return snapshot;
}

function hasReceiptAnalysisCache(item){
  return Boolean(getReceiptAnalysisCache(item));
}

function clearReceiptAnalysisCacheForTransaction(transactionId){
  const prefix = `${String(transactionId || "")}::`;
  if(!prefix.trim()) return;

  Object.keys(SplitState.receiptAnalysisCache || {}).forEach((key) => {
    if(key.startsWith(prefix)){
      delete SplitState.receiptAnalysisCache[key];
    }
  });
}

function restoreReceiptAnalysisSnapshot(snapshot){
  if(!snapshot) return false;

  SplitState.detectedMerchant = snapshot.detectedMerchant || "misc";
  SplitState.detectedItemNumbers = clonePlainValue(snapshot.detectedItemNumbers || []);
  SplitState.detectedParsedItems = clonePlainValue(snapshot.detectedParsedItems || []);
  SplitState.detectedResolvedProducts = clonePlainValue(snapshot.detectedResolvedProducts || {});
  SplitState.detectedLineItemPrices = clonePlainValue(snapshot.detectedLineItemPrices || {});
  SplitState.detectedReceiptTax = normalizeNullableMoney(snapshot.detectedReceiptTax);
  SplitState.detectedReceiptSubtotal = normalizeNullableMoney(snapshot.detectedReceiptSubtotal);
  SplitState.detectedReceiptTotal = normalizeNullableMoney(snapshot.detectedReceiptTotal);
  SplitState.detectedUnassignedDiscount = Number.isFinite(Number(snapshot.detectedUnassignedDiscount))
    ? Number(snapshot.detectedUnassignedDiscount)
    : 0;
  SplitState.detectedTransactionId = snapshot.transactionId || null;
  SplitState.receiptMathValidation = clonePlainValue(snapshot.receiptMathValidation || null);
  SplitState.receiptNameDrafts = clonePlainValue(snapshot.receiptNameDrafts || {});

  return true;
}

function openCachedReceiptAnalysis(item){
  const snapshot = getReceiptAnalysisCache(item);
  if(!restoreReceiptAnalysisSnapshot(snapshot)) return false;

  openDetectedReceiptItemsModal();
  return true;
}

function parseLineItemPrice(line){
  const text = String(line || "").trim();
  if(!text) return null;

  const matches = text.match(/\d+\.\d{2}/g);
  if(!matches || !matches.length) return null;

  const parsed = Number(matches[matches.length - 1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCents(value){
  const amount = Number(value);
  if(!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function centsToAmount(cents){
  return Number.isFinite(cents) ? cents / 100 : null;
}

function parseTrailingCurrencyToCents(line){
  const text = String(line || "").trim();
  if(!text) return null;

  const match = text.match(/(\d+\.\d{2})\s*[A-Z]?\s*$/i);
  if(!match) return null;

  const cents = toCents(Number(match[1]));
  return Number.isFinite(cents) ? cents : null;
}

function parseReceiptTotals(rawReceiptText){
  const totals = { tax: null, subtotal: null, receiptTotal: null };
  const lines = String(rawReceiptText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let taxSumCents = 0;
  let foundTax = false;

  lines.forEach((line) => {
    const trailingAmountCents = parseTrailingCurrencyToCents(line);

    if(/\bSUB\s*TOTAL\b/i.test(line) && Number.isFinite(trailingAmountCents)){
      totals.subtotal = centsToAmount(trailingAmountCents);
    }

    if(/\bTAX\b/i.test(line) && Number.isFinite(trailingAmountCents)){
      taxSumCents += trailingAmountCents;
      foundTax = true;
    }

    if(/\bTOTAL\b/i.test(line) && !/\bSUB\s*TOTAL\b/i.test(line) && Number.isFinite(trailingAmountCents)){
      totals.receiptTotal = centsToAmount(trailingAmountCents);
    }
  });

  totals.tax = foundTax ? centsToAmount(taxSumCents) : null;
  return totals;
}

function parseReceiptInstantSavingsTotal(rawReceiptText){
  const lines = String(rawReceiptText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.reduce((sum, line) => {
    if(!/^INST\s+SV\b/i.test(line)) return sum;
    const match = line.match(/(\d+\.\d{2})-\s*[A-Z.]*\s*$/i);
    if(!match) return sum;
    const amount = Number(match[1]);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

function getAssignedReceiptDiscount(){
  return (SplitState.detectedParsedItems || []).reduce((sum, parsed) => {
    const discount = Number(parsed?.instant_savings_discount);
    return Number.isFinite(discount) ? sum + discount : sum;
  }, 0);
}

function getEffectiveReceiptDiscount(item){
  const currentItem = data[currentIndex];
  if(!item || !currentItem || item !== currentItem) return 0;
  if(String(SplitState.detectedTransactionId || "") !== String(currentItem.id || "")) return 0;
  const discount = Number(SplitState.detectedUnassignedDiscount || 0);
  return Number.isFinite(discount) && discount > 0 ? parseFloat(discount.toFixed(2)) : 0;
}

function validateReceiptMath(parsedItems, receiptTotals, options = {}){
  const merchant = String(options.merchant || "misc");
  const itemNumbers = Array.isArray(options.itemNumbers) ? options.itemNumbers : [];
  const lineItemPrices = options.lineItemPrices && typeof options.lineItemPrices === "object"
    ? options.lineItemPrices
    : {};
  const parsedItemsByProduct = new Map(
    (parsedItems || []).map((entry) => [String(entry?.product_number || "").trim(), entry])
  );
  const effectiveParsedItems = [
    ...(parsedItems || []).filter((entry) => String(entry?.product_number || "").trim())
  ];

  if(merchant === "walmart"){
    effectiveParsedItems.forEach((entry) => {
      if(!Number(entry?.quantity)) entry.quantity = 1;
      if(!Number(entry?.unit_price) && Number(entry?.total_price)) entry.unit_price = Number(entry.total_price);
    });
  }

  itemNumbers.forEach((num) => {
    const normalized = String(num || "").trim();
    if(!normalized || parsedItemsByProduct.has(normalized)) return;

    const fallbackPrice = Number(lineItemPrices[normalized]);
    if(!Number.isFinite(fallbackPrice)) return;

    effectiveParsedItems.push({
      product_number: normalized,
      quantity: 1,
      unit_price: fallbackPrice,
      total_price: fallbackPrice,
      inferred_from_line_item_price: true
    });
  });

  const lineItemDiagnostics = [];
  let computedSubtotalCents = 0;

  effectiveParsedItems.forEach((entry, index) => {
    const quantity = Number(entry?.quantity || 0);
    const unitPriceCents = toCents(entry?.unit_price);
    const parsedLineTotalCents = toCents(entry?.total_price);

    if(!Number.isFinite(quantity) || !Number.isFinite(unitPriceCents) || !Number.isFinite(parsedLineTotalCents)){
      lineItemDiagnostics.push({
        index,
        product_number: entry?.product_number || "unknown",
        status: "invalid",
        reason: "non-finite value",
        quantity,
        unit_price: entry?.unit_price,
        line_total: entry?.total_price
      });
      return;
    }

    const expectedLineTotalCents = Math.round(quantity * unitPriceCents);
    const differenceCents = parsedLineTotalCents - expectedLineTotalCents;

    lineItemDiagnostics.push({
      index,
      product_number: entry?.product_number || "unknown",
      status: differenceCents === 0 ? "ok" : "mismatch",
      quantity,
      unit_price: centsToAmount(unitPriceCents),
      detected_line_total: centsToAmount(parsedLineTotalCents),
      expected_line_total: centsToAmount(expectedLineTotalCents),
      difference: centsToAmount(differenceCents),
      instant_savings_discount: Number.isFinite(Number(entry?.instant_savings_discount))
        ? Number(entry.instant_savings_discount)
        : 0,
      inferred_from_line_item_price: Boolean(entry?.inferred_from_line_item_price)
    });

    const discountCents = toCents(entry?.instant_savings_discount) || 0;
    computedSubtotalCents += parsedLineTotalCents - discountCents;
  });

  const parsedSubtotalCents = toCents(receiptTotals?.subtotal);
  const parsedTaxCents = toCents(receiptTotals?.tax);
  const parsedReceiptTotalCents = toCents(receiptTotals?.receiptTotal);
  const expectedTotalCents = Number.isFinite(parsedTaxCents)
    ? computedSubtotalCents + parsedTaxCents
    : null;

  const summary = {
    computedSubtotalCents,
    parsedSubtotalCents,
    parsedTaxCents,
    expectedTotalCents,
    parsedReceiptTotalCents,
    subtotalDifferenceCents: Number.isFinite(parsedSubtotalCents)
      ? computedSubtotalCents - parsedSubtotalCents
      : null,
    totalDifferenceCents: Number.isFinite(expectedTotalCents) && Number.isFinite(parsedReceiptTotalCents)
      ? parsedReceiptTotalCents - expectedTotalCents
      : null
  };

  return {
    effectiveParsedItems,
    lineItemDiagnostics,
    summary,
    hasDiscrepancy: lineItemDiagnostics.some((entry) => entry.status === "mismatch" || entry.status === "invalid")
      || (Number.isFinite(summary.subtotalDifferenceCents) && summary.subtotalDifferenceCents !== 0)
      || (Number.isFinite(summary.totalDifferenceCents) && summary.totalDifferenceCents !== 0)
  };
}

function calculateSplitStats(item){
  const totalAmount = normalizeMoney(item?.Amount);
  const allocated = (item.Splits || []).reduce((sum, s) => sum + Math.round(normalizeMoney(s.Amount) * 100), 0) / 100;
  const receiptDiscount = getEffectiveReceiptDiscount(item);
  const remaining = parseFloat((totalAmount - allocated - receiptDiscount).toFixed(2));
  return { allocated, remaining, totalAmount };
}

function findAutoTaxSplitIndex(item){
  if(!item?.Splits?.length) return -1;
  return item.Splits.findIndex((split) => split?.AutoDetectedTax === true);
}

function syncDetectedTaxSplit(item, taxAmount){
  if(!item) return false;
  if(!item.Splits) item.Splits = [];

  const taxCents = toCents(taxAmount);
  const index = findAutoTaxSplitIndex(item);

  if(!Number.isFinite(taxCents) || taxCents <= 0){
    if(index >= 0){
      item.Splits.splice(index, 1);
      if(!item.Splits.length) item.Category = "";
      return true;
    }
    return false;
  }

  const normalizedTaxAmount = centsToAmount(taxCents);

  if(index >= 0){
    const currentCents = Math.round(parseFloat(item.Splits[index].Amount || 0) * 100);
    if(currentCents === taxCents) return false;
    item.Splits[index].Amount = normalizedTaxAmount;
    return true;
  }

  item.Splits.push({
    Category: "Sales Tax Paid",
    Amount: normalizedTaxAmount,
    AutoDetectedTax: true
  });
  item.Category = "SPLIT";
  return true;
}

function renderSplitTotals(item){
  const { allocated, remaining, totalAmount } = calculateSplitStats(item);
  const receiptDiscount = getEffectiveReceiptDiscount(item);
  const remainingClass = Math.abs(remaining) < 0.01 ? "done zeroFlash" : remaining <= totalAmount * 0.2 ? "nearDone" : "";
  return `
    <div id="remainingBar" class="splitTotalsCard">
      <div class="splitMetric">Total<strong>$${totalAmount.toFixed(2)}</strong></div>
      ${receiptDiscount > 0 ? `<div class="splitMetric">Discounts<strong>-${Utils.money(receiptDiscount).replace("$", "$")}</strong></div>` : ""}
      <div class="splitMetric">Allocated<strong>$${allocated.toFixed(2)}</strong></div>
      <div class="splitMetric remaining ${remainingClass}">Remaining<strong>$${remaining.toFixed(2)}</strong></div>
    </div>
  `;
}

function renderSplitItems(item){
  if(!(item.Splits || []).length){
    return `<div class="small">No line items assigned yet. Add your first split below.</div>`;
  }

  return item.Splits.map((s, i) => {
    const canEdit = !item.receipt_url;
    return `
      <div class="splitItemRow ${SplitState.highlightedIndex === i ? "justAdded" : ""}">
        <div class="splitItemMeta">
          <strong>${escapeHtml(s.Category || "Uncategorized")}</strong>
          <div class="small">$${parseFloat(s.Amount || 0).toFixed(2)}</div>
        </div>
        <div class="splitItemActions">
          ${canEdit ? `<button class="touchButton" style="background:#1e3a8a;color:#fff;" onclick="editSplitAmount(${i})">Edit Amount</button>` : ""}
          <button class="touchButton" style="background:#c62828;color:#fff;" onclick="removeSplitAtIndex(${i})">Remove</button>
        </div>
      </div>
    `;
  }).join("");
}

async function openSplitModal(){
  setModalBackAction(null);
  SplitState.receiptExpanded = false;
  const item = data[currentIndex];
  if(!item) return;
  const hasCachedAnalysis = hasReceiptAnalysisCache(item);

  modalTitle.innerText = "Split Transaction";

  modalContent.innerHTML = `
    <div id="splitModalSheet" class="splitModalLayout">
      <div class="splitHeaderRow">
        <h3 class="splitHeaderTitle">Split Transaction</h3>
        <button class="splitHeaderExit" onclick="closeModal()" aria-label="Close split transaction">✕</button>
      </div>
      <div class="splitBody">
        <div class="receiptCard">
          <div class="receiptControls">
            <button class="touchButton" onclick="openManualSplitModal()" style="background:#1e3a8a;color:#fff;flex:1;">Add Split</button>
            ${item.receipt_url ? `<button class="touchButton" onclick="analyzeSplitReceipt()" style="background:#6a1b9a;color:#fff;flex:1;">${hasCachedAnalysis ? "Review Detected Items" : "Analyze Receipt"}</button>` : ""}
            ${item.receipt_url ? `<button class="touchButton" onclick="openSplitReceiptViewer()" style="background:#1565c0;color:#fff;flex:1;">View Receipt</button>` : ""}
          </div>
          ${item.receipt_url ? `` : `<div class="small" style="margin-bottom:8px;">No receipt attached. Use keypad-first split entry for fast mobile input.</div>`}
          <div class="small" style="padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-alt);">Receipt hidden by default. Tap <strong>View Receipt</strong> to open it.</div>
        </div>
        <div id="splitItemsScroller" class="lineItemsScroller">${renderSplitItems(item)}</div>
      </div>
      <div id="splitFooterSticky" class="splitFooterSticky">
        <div id="splitCompletionText" class="small">Assign all line items to complete this transaction.</div>
        <button id="splitDoneBtn" class="touchButton" style="background:#2e7d32;color:#fff;" onclick="completeSplitWorkflow()">Done</button>
      </div>
      ${renderSplitTotals(item)}
    </div>
  `;

  updateSplitProgressState();
  openModal();
}

async function analyzeSplitReceipt(){
  const item = data[currentIndex];
  if(!item?.id || !item?.receipt_url){
    alert("No receipt attached.");
    return;
  }

  if(openCachedReceiptAnalysis(item)){
    return;
  }

  try {
    modalTitle.innerText = "Analyzing Receipt";
    modalContent.innerHTML = `<div class="small" style="padding:14px;">Preparing receipt image…</div>`;
    setModalBackAction(() => openSplitModal());
    openModal();

    const repairedReceipt = await repairAttachedReceiptForAnalysis(item);
    modalContent.innerHTML = `<div class="small" style="padding:14px;">${repairedReceipt ? "Converted receipt to JPEG. Extracting item numbers…" : "Extracting item numbers…"}</div>`;

    const payload = {
      transaction_id: item.id,
      receipt_url: item.receipt_url
    };
    debugReceipt("analyze-receipt payload:", payload);

    const { response, result } = await invokeEdgeFunction("analyze-receipt", payload);

    const rawReceiptText = String(result?.debug?.raw_receipt_text || "");
    const detectedMerchant = String(result?.merchant || result?.debug?.merchant || "misc").trim() || "misc";
    const totalLinesDetected = Number(result?.debug?.total_lines_detected || 0);
    const matchingLines = Array.isArray(result?.debug?.lines_matching_item_number_pattern)
      ? result.debug.lines_matching_item_number_pattern
      : [];
    const itemNumbers = Array.isArray(result?.item_numbers)
      ? result.item_numbers.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const resolvedProducts = result?.resolved_products && typeof result.resolved_products === "object"
      ? result.resolved_products
      : {};
    const parsedItems = Array.isArray(result?.parsed_items)
      ? result.parsed_items
        .map((entry) => ({
          product_number: String(entry?.product_number || "").trim(),
          receipt_label: String(entry?.receipt_label || "").trim(),
          identifier_type: String(entry?.identifier_type || "unknown").trim() || "unknown",
          quantity: Number(entry?.quantity || 0),
          unit_price: Number(entry?.unit_price || 0),
          total_price: Number(entry?.total_price || 0),
          instant_savings_discount: Number.isFinite(Number(entry?.instant_savings_discount))
            ? Number(entry.instant_savings_discount)
            : undefined
        }))
        .filter((entry) => entry.product_number)
      : [];
    const parsedLineItemPrices = matchingLines.reduce((acc, line) => {
      const rawNumber = String(line || "").match(/(?:^|\D)(\d{9,12})(?=\D|$)/)?.[1] || "";
      const normalizedNumber = rawNumber.replace(/\D/g, "").replace(/^0+/, "");
      const price = parseLineItemPrice(line);
      if(normalizedNumber && Number.isFinite(price) && !Object.prototype.hasOwnProperty.call(acc, normalizedNumber)){
        acc[normalizedNumber] = price;
      }
      return acc;
    }, {});
    const serverReceiptTotals = result?.receipt_totals && typeof result.receipt_totals === "object"
      ? {
        tax: normalizeNullableMoney(result.receipt_totals.tax),
        subtotal: normalizeNullableMoney(result.receipt_totals.subtotal),
        receiptTotal: normalizeNullableMoney(result.receipt_totals.receiptTotal)
      }
      : null;
    const receiptTotals = serverReceiptTotals || parseReceiptTotals(rawReceiptText);
    const serverInstantSavingsTotal = normalizeNullableMoney(result?.instant_savings_total);
    const detectedInstantSavingsTotal = Number.isFinite(serverInstantSavingsTotal)
      ? serverInstantSavingsTotal
      : parseReceiptInstantSavingsTotal(rawReceiptText);
    const assignedInstantSavingsTotal = getAssignedReceiptDiscount();
    const unassignedReceiptDiscount = Math.max(0, parseFloat((detectedInstantSavingsTotal - assignedInstantSavingsTotal).toFixed(2)));
    const receiptMathValidation = validateReceiptMath(parsedItems, receiptTotals, {
      merchant: detectedMerchant,
      itemNumbers,
      lineItemPrices: parsedLineItemPrices
    });

    if(DEBUG_RECEIPTS){
      if(rawReceiptText){
        console.group("RAW RECEIPT TEXT");
        console.log(rawReceiptText);
        console.groupEnd();
      }

      console.log("TOTAL LINES DETECTED:", totalLinesDetected);
      console.log("RECEIPT MERCHANT:", detectedMerchant);
      console.log("LINES MATCHING ITEM NUMBER PATTERN:", matchingLines);
      console.log("ITEM NUMBERS FOUND:", itemNumbers);
      console.log("PARSED PURCHASE LINES:", parsedItems);

      console.group("RECEIPT MATH DIAGNOSTICS");
      console.log("Parsed Line Totals:", (parsedItems || []).map((entry) => ({
        product_number: entry.product_number,
        quantity: entry.quantity,
        unit_price: entry.unit_price,
        line_total: entry.total_price,
        instant_savings_discount: entry.instant_savings_discount || 0
      })));
      console.log("Computed Subtotal:", centsToAmount(receiptMathValidation.summary.computedSubtotalCents)?.toFixed(2));
      console.log("Parsed Subtotal:", Number.isFinite(receiptMathValidation.summary.parsedSubtotalCents)
        ? centsToAmount(receiptMathValidation.summary.parsedSubtotalCents)?.toFixed(2)
        : "N/A");
      console.log("Parsed Tax:", Number.isFinite(receiptMathValidation.summary.parsedTaxCents)
        ? centsToAmount(receiptMathValidation.summary.parsedTaxCents)?.toFixed(2)
        : "N/A");
      console.log("Expected Total:", Number.isFinite(receiptMathValidation.summary.expectedTotalCents)
        ? centsToAmount(receiptMathValidation.summary.expectedTotalCents)?.toFixed(2)
        : "N/A");
      console.log("Receipt Total:", Number.isFinite(receiptMathValidation.summary.parsedReceiptTotalCents)
        ? centsToAmount(receiptMathValidation.summary.parsedReceiptTotalCents)?.toFixed(2)
        : "N/A");
      console.log("Difference:", Number.isFinite(receiptMathValidation.summary.totalDifferenceCents)
        ? centsToAmount(receiptMathValidation.summary.totalDifferenceCents)?.toFixed(2)
        : "N/A");

      receiptMathValidation.lineItemDiagnostics
        .filter((entry) => entry.status !== "ok")
        .forEach((entry) => warnReceipt("Line item math mismatch detected", entry));

      if(Number.isFinite(receiptMathValidation.summary.subtotalDifferenceCents)
        && receiptMathValidation.summary.subtotalDifferenceCents !== 0){
        warnReceipt("Subtotal mismatch detected", {
          computed_subtotal: centsToAmount(receiptMathValidation.summary.computedSubtotalCents),
          parsed_subtotal: centsToAmount(receiptMathValidation.summary.parsedSubtotalCents),
          difference: centsToAmount(receiptMathValidation.summary.subtotalDifferenceCents)
        });
      }

      if(Number.isFinite(receiptMathValidation.summary.totalDifferenceCents)
        && receiptMathValidation.summary.totalDifferenceCents !== 0){
        warnReceipt("Grand total mismatch detected", {
          expected_total: centsToAmount(receiptMathValidation.summary.expectedTotalCents),
          parsed_total: centsToAmount(receiptMathValidation.summary.parsedReceiptTotalCents),
          difference: centsToAmount(receiptMathValidation.summary.totalDifferenceCents)
        });
      }
      console.groupEnd();
    }

    if(!response?.ok || !result?.success){
      console.warn("analyze-receipt failed", { status: response?.status, result });
      alert(result?.message || result?.error?.message || "Unable to analyze receipt.");
      openSplitModal();
      return;
    }

    SplitState.detectedItemNumbers = itemNumbers;
    SplitState.detectedMerchant = detectedMerchant;
    SplitState.detectedParsedItems = parsedItems;
    SplitState.detectedResolvedProducts = resolvedProducts;
    SplitState.detectedLineItemPrices = parsedLineItemPrices;
    SplitState.detectedReceiptTax = receiptTotals.tax;
    SplitState.detectedReceiptSubtotal = receiptTotals.subtotal;
    SplitState.detectedReceiptTotal = receiptTotals.receiptTotal;
    SplitState.detectedUnassignedDiscount = unassignedReceiptDiscount;
    SplitState.detectedTransactionId = item.id || null;
    SplitState.receiptMathValidation = receiptMathValidation;
    SplitState.receiptNameDrafts = {};

    const taxSplitChanged = syncDetectedTaxSplit(item, receiptTotals.tax);
    if(taxSplitChanged){
      await persistSplitItem(item);
    }

    storeReceiptAnalysisCache(item);
    openDetectedReceiptItemsModal();
  } catch (error) {
    console.error("Receipt analysis error:", error);
    alert("Unable to analyze receipt.");
    openSplitModal();
  }
}

function openDetectedReceiptItemsModal(){
  setModalBackAction(() => openSplitModal());
  const item = data[currentIndex];
  if(!item) return;

  const itemNumbers = SplitState.detectedItemNumbers || [];
  const parsedItemsByProduct = new Map(
    (SplitState.detectedParsedItems || []).map((entry) => [entry.product_number, entry])
  );
  const resolvedProducts = SplitState.detectedResolvedProducts || {};
  const lineItemPrices = SplitState.detectedLineItemPrices || {};
  const subtotal = SplitState.detectedReceiptSubtotal;
  const tax = SplitState.detectedReceiptTax;
  const receiptTotal = SplitState.detectedReceiptTotal;
  const receiptDiscount = getEffectiveReceiptDiscount(item);
  const merchant = String(SplitState.detectedMerchant || "misc").replace(/_/g, " ");

  const getNetDetectedItemAmount = (parsed, fallback) => {
    if(parsed && Number.isFinite(parsed.total_price) && parsed.total_price > 0){
      const discount = Number.isFinite(parsed.instant_savings_discount) ? parsed.instant_savings_discount : 0;
      const net = parsed.total_price - discount;
      return net > 0 ? parseFloat(net.toFixed(2)) : 0;
    }
    return Number.isFinite(fallback) && fallback > 0
      ? parseFloat(fallback.toFixed(2))
      : null;
  };

  const getDetectedItemAmount = (itemNumber) => {
    const parsed = parsedItemsByProduct.get(itemNumber);
    return getNetDetectedItemAmount(parsed, lineItemPrices[itemNumber]);
  };

  const getAssignedForItem = (itemNumber) => {
    if(!item.Splits?.length) return 0;
    return item.Splits.reduce((sum, split) => {
      if(String(split?.SourceProductNumber || "") !== String(itemNumber)) return sum;
      return sum + parseFloat(split?.Amount || 0);
    }, 0);
  };

  const listHtml = itemNumbers.length
    ? `<div style="display:grid;gap:8px;">${itemNumbers.map((num) => {
      const parsed = parsedItemsByProduct.get(num) || (Number.isFinite(lineItemPrices[num])
        ? { quantity: 1, unit_price: lineItemPrices[num], total_price: lineItemPrices[num] }
        : null);
      const resolved = resolvedProducts?.[num] || null;
      const amount = getDetectedItemAmount(num);
      const assigned = getAssignedForItem(num);
      const assignedCategories = (item.Splits || []).filter((split) => String(split?.SourceProductNumber || "") === String(num)).map((split) => split?.Category).filter(Boolean);
      const displayCategory = assignedCategories.length ? assignedCategories[assignedCategories.length - 1] : "Uncategorized";
      const purchaseLine = parsed
        ? `${parsed.quantity} @ ${Utils.money(parsed.unit_price)} = ${Utils.money(parsed.total_price)}${Number.isFinite(parsed.instant_savings_discount) ? ` less ${Utils.money(parsed.instant_savings_discount)} instant savings` : ""}`
        : null;
      const displayName = resolved?.product_name || parsed?.receipt_label || "Name unavailable";
      const nameMeta = resolved?.source
        ? `${String(resolved.source).replace(/_/g, " ")}${resolved?.confidence ? ` • ${resolved.confidence}` : ""}`
        : (parsed?.receipt_label ? "receipt label" : "");
      const canConfirmResolvedName = Boolean(displayName && displayName !== "Name unavailable");
      return `
        <div class="splitItemRow">
          <div><span class="currentCategoryBadge" style="margin-top:0;">${escapeHtml(displayCategory)}</span></div>
          <div class="splitItemMeta">
            <strong>${escapeHtml(displayName)}</strong>
            <div class="small"><code>${escapeHtml(num)}</code></div>
            <div class="small">${amount ? Utils.money(amount) : "No total price detected"}</div>
          </div>
          <div class="small">${purchaseLine ? escapeHtml(purchaseLine) : "Quantity/price details unavailable"}${nameMeta ? `<br>${escapeHtml(nameMeta)}` : ""}</div>
          <div class="splitItemActions">
            <button class="touchButton" style="background:#1e3a8a;color:#fff;" onclick="openDetectedItemCategoryModal('${escapeForSingleQuote(num)}')" ${amount ? "" : "disabled"}>Choose Category</button>
            <button class="touchButton" style="background:#000;color:#fff;" onclick="askAIForDetectedItem('${escapeForSingleQuote(num)}')">Ask AI</button>
            <button class="touchButton" style="background:#0f766e;color:#fff;" onclick="confirmDetectedItemName('${escapeForSingleQuote(num)}')" ${canConfirmResolvedName ? "" : "disabled"}>Confirm Name</button>
            <button class="touchButton" style="background:#7c3aed;color:#fff;" onclick="openDetectedItemNameModal('${escapeForSingleQuote(num)}')">Edit Name</button>
            ${assigned > 0 ? `<button class="touchButton" style="background:#0f766e;color:#fff;" disabled>Assigned ${Utils.money(assigned)}</button>` : ""}
          </div>
        </div>
      `;
    }).join("")}</div>`
    : `<div class="small">No item numbers detected.</div>`;
  const totalsHtml = Number.isFinite(subtotal) || Number.isFinite(tax) || Number.isFinite(receiptTotal)
    ? `<div class="small" style="display:grid;gap:4px;padding-top:4px;">
        ${Number.isFinite(subtotal) ? `<div><strong>Subtotal =</strong> ${subtotal.toFixed(2)}</div>` : ""}
        ${Number.isFinite(tax) ? `<div><strong>Tax =</strong> ${tax.toFixed(2)}</div>` : ""}
        ${receiptDiscount > 0 ? `<div><strong>Discounts =</strong> -${receiptDiscount.toFixed(2)}</div>` : ""}
        ${Number.isFinite(receiptTotal) ? `<div><strong>Total Receipt =</strong> ${receiptTotal.toFixed(2)}</div>` : ""}
      </div>`
    : "";

  modalTitle.innerText = "Detected Items";
  modalContent.innerHTML = `
    <div class="splitModalLayout" style="padding:8px;">
      <div class="lineItemsScroller" style="display:grid;gap:10px;">
        <h3 style="margin:0;">Detected Items:</h3>
        <div class="small">Merchant parser: <strong>${escapeHtml(merchant)}</strong></div>
        ${listHtml}
        ${totalsHtml}
      </div>
      <div class="splitFooterSticky" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
        <button class="touchButton" onclick="openSplitModal()" style="background:#6b7280;color:#fff;">Back</button>
        <button class="touchButton" onclick="openReceiptViewerModal(data[currentIndex], 'detectedItems', 'Receipt Preview')" style="background:#1565c0;color:#fff;">Show Receipt</button>
      </div>
    </div>
  `;

  openModal();
}

function openDetectedItemCategoryModal(itemNumber){
  setModalBackAction(() => openDetectedReceiptItemsModal());
  SplitState.selectedDetectedItem = itemNumber;
  const normalized = String(itemNumber || "").trim();
  const resolved = SplitState.detectedResolvedProducts?.[normalized] || null;
  if(needsDetectedItemNameConfirmation(normalized, resolved)){
    alert("Confirm or edit the product name before choosing a category for this line item.");
    openDetectedItemNameModal(normalized);
    return;
  }
  modalTitle.innerText = `Choose Category • ${itemNumber}`;
  modalContent.innerHTML = generateCategoryButtonsForAction("applyDetectedItemCategory", [itemNumber]);
  openModal();
}

function needsDetectedItemNameConfirmation(itemNumber, resolved){
  const normalized = String(itemNumber || "").trim();
  const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
  const source = String(resolved?.source || "").trim();
  const productName = String(resolved?.product_name || parsed?.receipt_label || "").trim();

  if(!productName || productName === "Name unavailable") return true;
  return source !== "verified_lookup";
}

function openDetectedItemNameModal(itemNumber){
  setModalBackAction(() => openDetectedReceiptItemsModal());
  const normalized = String(itemNumber || "").trim();
  if(!normalized) return;

  const resolved = SplitState.detectedResolvedProducts?.[normalized] || null;
  const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
  const suggestedName = SplitState.receiptNameDrafts?.[normalized]
    || resolved?.product_name
    || parsed?.receipt_label
    || "";

  modalTitle.innerText = `Edit Product Name • ${normalized}`;
  modalContent.innerHTML = `
    <div style="padding:10px;display:grid;gap:10px;">
      <div class="small">Use this when the detected name is wrong or too vague. Saving here creates a verified mapping for future receipts.</div>
      <div class="small"><strong>Current name:</strong> ${escapeHtml(resolved?.product_name || parsed?.receipt_label || "Unknown")}</div>
      <label class="small" for="detectedItemNameInput">Verified product name</label>
      <input id="detectedItemNameInput" type="text" value="${escapeHtml(suggestedName)}" placeholder="Enter the correct product name">
      <label class="small" for="detectedItemReasonInput">Reason (optional)</label>
      <input id="detectedItemReasonInput" type="text" placeholder="Example: receipt label was abbreviated">
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
        <button class="touchButton" onclick="openDetectedReceiptItemsModal()" style="background:#6b7280;color:#fff;">Cancel</button>
        <button class="touchButton" onclick="saveDetectedItemName('${escapeForSingleQuote(normalized)}')" style="background:#0f766e;color:#fff;">Save Name</button>
      </div>
    </div>
  `;

  openModal();
}

async function confirmDetectedItemName(itemNumber){
  const normalized = String(itemNumber || "").trim();
  const resolved = SplitState.detectedResolvedProducts?.[normalized] || null;
  const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
  const productName = String(resolved?.product_name || parsed?.receipt_label || "").trim();

  if(!normalized || !productName){
    alert("No product name available to confirm.");
    return;
  }

  await saveVerifiedProductName({
    merchant: SplitState.detectedMerchant || "any",
    itemNumber: normalized,
    newProductName: productName,
    previousProductName: resolved?.product_name || "",
    reason: "Confirmed from receipt analysis",
  });
}

async function saveDetectedItemName(itemNumber){
  const normalized = String(itemNumber || "").trim();
  const nameInput = document.getElementById("detectedItemNameInput");
  const reasonInput = document.getElementById("detectedItemReasonInput");
  const newProductName = String(nameInput?.value || "").trim();
  const reason = String(reasonInput?.value || "").trim();
  const previousProductName = String(SplitState.detectedResolvedProducts?.[normalized]?.product_name || "").trim();

  if(!normalized || !newProductName){
    alert("Enter a product name before saving.");
    return;
  }

  SplitState.receiptNameDrafts[normalized] = newProductName;
  await saveVerifiedProductName({
    merchant: SplitState.detectedMerchant || "any",
    itemNumber: normalized,
    newProductName,
    previousProductName,
    reason,
  });
}

async function saveVerifiedProductName({ merchant, itemNumber, newProductName, previousProductName, reason }){
  const normalizedMerchant = String(merchant || "any").trim() || "any";
  const normalized = String(itemNumber || "").trim();
  const cleanName = String(newProductName || "").replace(/\s+/g, " ").trim();
  const oldName = String(previousProductName || "").replace(/\s+/g, " ").trim();
  const cleanReason = String(reason || "").replace(/\s+/g, " ").trim();

  if(!normalized || !cleanName){
    alert("Missing product lookup values.");
    return false;
  }

  try {
    const { error: lookupError } = await supabaseClient
      .from("product_lookup")
      .upsert({
        merchant: normalizedMerchant,
        item_number: normalized,
        product_name: cleanName,
        verified_by_user: true
      }, { onConflict: "merchant,item_number" });

    if(lookupError) throw lookupError;

    const { error: auditError } = await supabaseClient
      .from("product_lookup_audit")
      .insert({
        merchant: normalizedMerchant,
        item_number: normalized,
        previous_product_name: oldName || null,
        new_product_name: cleanName,
        reason: cleanReason || null
      });

    if(auditError) console.warn("Product lookup audit insert failed", auditError);

    const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
    SplitState.detectedResolvedProducts = {
      ...(SplitState.detectedResolvedProducts || {}),
      [normalized]: {
        product_name: cleanName,
        source: "verified_lookup",
        confidence: "high",
        ...(parsed?.receipt_label ? { receipt_label: parsed.receipt_label } : {})
      }
    };
    storeReceiptAnalysisCache(data[currentIndex]);

    alert("Verified product name saved.");
    openDetectedReceiptItemsModal();
    return true;
  } catch(error){
    console.error("Failed to save verified product name", error);
    alert("Unable to save verified product name.");
    return false;
  }
}

async function applyDetectedItemCategory(itemNumber, category){
  const normalized = String(itemNumber || "").trim();
  if(!normalized){
    alert("Missing detected item number.");
    return;
  }

  const resolved = SplitState.detectedResolvedProducts?.[normalized] || null;
  if(needsDetectedItemNameConfirmation(normalized, resolved)){
    alert("Confirm or edit the product name before assigning a category.");
    openDetectedItemNameModal(normalized);
    return;
  }

  const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
  const fallback = SplitState.detectedLineItemPrices?.[normalized];
  const amount = Number.isFinite(parsed?.total_price)
    ? parseFloat((parsed.total_price - (Number.isFinite(parsed?.instant_savings_discount) ? parsed.instant_savings_discount : 0)).toFixed(2))
    : (Number.isFinite(fallback) ? fallback : null);

  if(!Number.isFinite(amount) || amount <= 0){
    alert("No valid item total found for this line.");
    openDetectedReceiptItemsModal();
    return;
  }

  const success = await applySplit(category, parseFloat(amount.toFixed(2)), {
    sourceProductNumber: normalized,
    sourceMerchant: SplitState.detectedMerchant || "misc",
    sourceIdentifierType: parsed?.identifier_type || "unknown"
  });
  if(success){
    storeReceiptAnalysisCache(data[currentIndex]);
    openDetectedReceiptItemsModal();
  }
}

function askAIForDetectedItem(itemNumber){
  const normalized = String(itemNumber || "").trim();
  const resolved = SplitState.detectedResolvedProducts?.[normalized] || null;
  if(needsDetectedItemNameConfirmation(normalized, resolved)){
    alert("Confirm or edit the product name before asking AI to categorize this item.");
    openDetectedItemNameModal(normalized);
    return;
  }
  const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === normalized);
  const fallback = SplitState.detectedLineItemPrices?.[normalized];
  const amount = Number.isFinite(parsed?.total_price)
    ? parseFloat((parsed.total_price - (Number.isFinite(parsed?.instant_savings_discount) ? parsed.instant_savings_discount : 0)).toFixed(2))
    : (Number.isFinite(fallback) ? fallback : null);

  aiContext = {
    type: "detected-receipt-item",
    itemNumber: normalized,
    amount: Number.isFinite(amount) ? parseFloat(amount.toFixed(2)) : null
  };

  askAI();
}

function openManualSplitModal(){
  setModalBackAction(() => openSplitModal());
  SplitState.manualAmount = 0;
  SplitState.manualCategory = null;
  const item = data[currentIndex];
  if(!item) return;

  modalTitle.innerText = "Manual Split";
  modalContent.innerHTML = `
    <div class="splitModalLayout" style="padding:6px;">
      <div class="splitHeaderRow">
        <h3 class="splitHeaderTitle">Manual Split</h3>
        <button class="splitHeaderExit" onclick="openSplitModal()" aria-label="Back to split">←</button>
      </div>
      <div class="lineItemsScroller" style="display:grid;gap:10px;">
        <label class="small" for="manualSplitAmount">Split Amount</label>
        <input id="manualSplitAmount" type="text" inputmode="decimal" readonly placeholder="0.00" onclick="openManualAmountKeypad()">
        <button class="touchButton" onclick="openManualAmountKeypad()" style="background:#1565c0;color:white;">Enter Amount</button>
        <button class="touchButton" onclick="openManualSplitCategorySelector()" style="background:#1e3a8a;color:white;">Choose Category</button>
        <div id="manualSplitCategory" class="small">No category selected.</div>
      </div>
      <div class="splitFooterSticky">
        <button class="touchButton" onclick="openSplitModal()" style="background:#6b7280;color:#fff;">← Back</button>
        <button class="touchButton" onclick="submitManualSplit()" style="background:#2e7d32;color:#fff;">Add Split</button>
      </div>
      ${renderSplitTotals(item)}
    </div>
  `;
}

function openManualAmountKeypad(){
  const item = data[currentIndex];
  if(!item) return;
  const { remaining } = calculateSplitStats(item);
  openNumericKeypad({
    title: "Enter split amount",
    initial: SplitState.manualAmount,
    max: Math.max(remaining, 0),
    onChange: (value) => {
      SplitState.manualAmount = value;
      const field = document.getElementById("manualSplitAmount");
      if(field) field.value = value ? value.toFixed(2) : "";
    },
    onConfirm: (value) => {
      SplitState.manualAmount = value;
      const field = document.getElementById("manualSplitAmount");
      if(field) field.value = value.toFixed(2);
    }
  });
}

function captureManualAmount(){
  SplitState.manualAmount = parseFloat(document.getElementById("manualSplitAmount")?.value || 0);
}

function openManualSplitCategorySelector(){
  captureManualAmount();
  if(!SplitState.manualAmount || SplitState.manualAmount <= 0){
    alert("Enter a valid split amount first.");
    return;
  }

  pickCategory(SplitState.manualAmount).then(category => {
    if(!category) return;
    SplitState.manualCategory = category;
    const label = document.getElementById("manualSplitCategory");
    if(label) label.innerText = `Selected: ${category}`;
  });
}

async function submitManualSplit(){
  captureManualAmount();

  if(!SplitState.manualCategory){
    alert("Please choose a category.");
    return;
  }

  if(!SplitState.manualAmount || SplitState.manualAmount <= 0){
    alert("Enter a valid split amount.");
    return;
  }

  const success = await applySplit(SplitState.manualCategory, SplitState.manualAmount);
  if(success){
    openSplitModal();
    showCard();
  }
}

function removeSplitAtIndex(index){
  const item = data[currentIndex];
  if(!item || !item.Splits || !item.Splits[index]) return;
  item.Splits.splice(index, 1);
  if(!item.Splits.length) item.Category = "";
  persistSplitItem(item);
}

function editSplitAmount(index){
  const item = data[currentIndex];
  if(!item?.Splits?.[index]) return;
  const original = parseFloat(item.Splits[index].Amount || 0);
  const { remaining } = calculateSplitStats(item);
  const editableMax = Math.max(original + remaining, 0);

  openNumericKeypad({
    title: `Edit ${item.Splits[index].Category || "line item"}`,
    initial: original,
    max: editableMax,
    onChange: (value) => {
      item.Splits[index].Amount = parseFloat((value || 0).toFixed(2));
      updateRemainingUI();
    },
    onCancel: () => {
      item.Splits[index].Amount = original;
      updateRemainingUI();
    },
    onConfirm: () => persistSplitItem(item)
  });
}

function openReceiptFullscreen(url, fileKind = "image") {
  modalTitle.innerText = "Receipt Viewer";
  const renderAsPdf = fileKind === "pdf";
  modalContent.innerHTML = `<div class="receiptViewport" id="receiptFullscreenViewport" style="max-height:100%;height:100%;">${renderAsPdf ? `<iframe src="${escapeHtml(url)}" title="Receipt PDF fullscreen"></iframe>` : `<img src="${escapeHtml(url)}" alt="Receipt expanded" loading="lazy" decoding="async">`}</div>`;
  const fullscreenViewport = document.getElementById("receiptFullscreenViewport");
  attachReceiptPreviewHandlers(fullscreenViewport, { url, fileKind: renderAsPdf ? "pdf" : "image" });
  openModal();
}

function updateSplitProgressState(){
  const item = data[currentIndex];
  if(!item) return;
  const { remaining } = calculateSplitStats(item);
  const done = Math.abs(remaining) < 0.01;
  const txt = document.getElementById("splitCompletionText");
  const btn = document.getElementById("splitDoneBtn");
  const remainingNode = document.querySelector(".splitMetric.remaining");
  const footer = document.getElementById("splitFooterSticky");

  if(txt) txt.innerText = done ? "✅ Split complete — ready to finish." : `Remaining to assign: $${remaining.toFixed(2)}`;
  if(btn) {
    btn.disabled = !done;
    btn.style.opacity = done ? "1" : ".65";
  }
  if(footer) footer.style.borderColor = done ? "#2e7d32" : "var(--border)";
  if(remainingNode){
    remainingNode.classList.toggle("done", done);
    remainingNode.classList.toggle("nearDone", !done && remaining <= normalizeMoney(item.Amount) * 0.2);
    remainingNode.classList.toggle("zeroFlash", done);
  }
}

function completeSplitWorkflow(){
  const item = data[currentIndex];
  if(!item) return;
  const { remaining } = calculateSplitStats(item);
  if(Math.abs(remaining) >= 0.01){
    alert("Allocate remaining balance before finishing.");
    return;
  }
  const footer = document.querySelector(".splitFooterSticky");
  if(footer) footer.style.animation = "splitPulse .45s ease";
  setTimeout(() => {
    triggerHaptic("success");
    closeModal();
    showCard();
  }, 220);
}

async function resetSplits(){

  if(!confirm("Reset all splits?")) return;

  const item = data[currentIndex];

  item.Splits = [];
  item.Category = "";

  updateRemainingUI();

// Force UI refresh if modal is open
setTimeout(() => {
  updateRemainingUI();
}, 50);
  updateTotals();
  updateProgress();
showCard();
  // Save to Supabase
  if(item.id){
    const { error } = await supabaseClient
      .from("transactions")
      .update({
        category: "",
        splits: []
      })
      .eq("id", item.id);

    if(error){
      console.error("Reset error:", error);
      alert("Error resetting splits.");
    }
  }

  // Reset remaining bar UI
  const el = document.getElementById("remainingBar");
  if(el){
    el.innerText = "Remaining: $" + normalizeMoney(item.Amount).toFixed(2);
    el.style.color = "orange";
  }
}

function initKeypad(){
  if(!keypadGrid || keypadGrid.dataset.ready) return;
  keypadGrid.dataset.ready = "true";
  const keys = ["1","2","3","4","5","6","7","8","9",".","0","⌫"];
  keypadGrid.innerHTML = `${keys.map((k) => `<button class="keypadKey" type="button" onclick="pressKeypadKey('${k}')">${k}</button>`).join("")}
    <button class="keypadKey warn" type="button" onclick="cancelNumericKeypad()">Cancel</button>
    <button class="keypadKey" type="button" onclick="clearNumericKeypad()">Clear</button>
    <button class="keypadKey action" type="button" onclick="confirmNumericKeypad()">Done</button>`;
}

function openNumericKeypad({ title = "Enter amount", initial = 0, max = Infinity, onChange, onConfirm, onCancel } = {}){
  initKeypad();
  SplitState.keypad.value = initial > 0 ? Number(initial).toFixed(2) : "";
  SplitState.keypad.max = max;
  SplitState.keypad.onChange = onChange || null;
  SplitState.keypad.onConfirm = onConfirm || null;
  SplitState.keypad.onCancel = onCancel || null;
  if(keypadTitle) keypadTitle.innerText = title;
  if(keypadOverlay) keypadOverlay.classList.add("open");
  updateKeypadDisplay();
}

function closeNumericKeypad(silent = false){
  if(!silent && typeof SplitState.keypad.onCancel === "function") SplitState.keypad.onCancel();
  if(keypadOverlay) keypadOverlay.classList.remove("open");
  SplitState.keypad.onChange = null;
  SplitState.keypad.onConfirm = null;
  SplitState.keypad.onCancel = null;
  if(keypadHint) keypadHint.innerText = "";
}

function handleKeypadBackdrop(event){
  if(event.target === keypadOverlay) cancelNumericKeypad();
}

function pressKeypadKey(key){
  let val = SplitState.keypad.value || "";
  if(key === "⌫"){
    val = val.slice(0, -1);
  } else if(key === "."){
    if(!val.includes(".")) val = val ? `${val}.` : "0.";
  } else {
    val = `${val}${key}`;
  }
  SplitState.keypad.value = val;
  updateKeypadDisplay();
}

function clearNumericKeypad(){
  SplitState.keypad.value = "";
  updateKeypadDisplay();
}

function keypadNumericValue(){
  const raw = (SplitState.keypad.value || "").trim();
  if(!raw) return 0;
  let normalized;
  if(raw.includes(".")){
    normalized = Number.parseFloat(raw);
  } else {
    normalized = Number.parseInt(raw, 10) / 100;
  }
  return Number.isFinite(normalized) ? parseFloat(normalized.toFixed(2)) : 0;
}

function updateKeypadDisplay(){
  const value = keypadNumericValue();
  if(keypadDisplay) keypadDisplay.innerText = `$${value.toFixed(2)}`;
  const over = value > SplitState.keypad.max + 0.009;
  if(keypadHint) keypadHint.innerText = over ? `Amount exceeds remaining ($${SplitState.keypad.max.toFixed(2)} max).` : "";
  if(typeof SplitState.keypad.onChange === "function"){
    SplitState.keypad.onChange(Math.min(value, SplitState.keypad.max));
  }
}

function confirmNumericKeypad(){
  const value = keypadNumericValue();
  if(value <= 0){
    if(keypadHint) keypadHint.innerText = "Enter an amount greater than $0.00.";
    return;
  }
  if(value > SplitState.keypad.max + 0.009){
    if(keypadHint) keypadHint.innerText = `Amount exceeds remaining ($${SplitState.keypad.max.toFixed(2)} max).`;
    return;
  }
  if(typeof SplitState.keypad.onConfirm === "function") SplitState.keypad.onConfirm(value);
  closeNumericKeypad(true);
}

function cancelNumericKeypad(){
  closeNumericKeypad(false);
}

function openSplitReceiptViewer(){
  const item = data[currentIndex];
  openReceiptViewerModal(item, "split", "Split Receipt");
}

function updateRemainingUI(){

  const item = data[currentIndex];
  if(!item) return;

  requestAnimationFrame(() => {
    const el = document.getElementById("remainingBar");
    if(!el) return;
    el.outerHTML = renderSplitTotals(item);
    updateSplitProgressState();
  });
}

function buildSplitSummaryHTML(item){

  if(!item.Splits || !item.Splits.length){
    return `<div class="small">No split line items yet.</div>`;
  }

  const bucketTotals = {};

  item.Splits.forEach(s => {
    const category = s.Category || "Uncategorized";
    const cents = Math.round(parseFloat(s.Amount || 0) * 100);
    bucketTotals[category] = (bucketTotals[category] || 0) + cents;
  });

  let html = ``;

  Object.keys(bucketTotals).forEach(category => {
    html += `
      <div class="totalRow" style="cursor:default; border-bottom:1px solid var(--border);">
        <div>${escapeHtml(category)}</div>
        <div>$${(bucketTotals[category] / 100).toFixed(2)}</div>
      </div>
    `;
  });

  return html;
}

function updateSplitSummaryUI(){

  const item = data[currentIndex];
  const el = document.getElementById("splitSummary");

  if(!el || !item) return;

  el.innerHTML = buildSplitSummaryHTML(item);
}

async function persistSplitItem(item){
  updateRemainingUI();
  updateSplitSummaryUI();
  updateTotals();
  updateProgress();

  if(document.getElementById("splitItemsScroller")){
    document.getElementById("splitItemsScroller").innerHTML = renderSplitItems(item);
  }
  if(document.getElementById("remainingBar")){
    document.getElementById("remainingBar").outerHTML = renderSplitTotals(item);
  }
  updateSplitProgressState();

  if(item.id){
    await persistReceiptInteractions(item);
  }
}

async function persistReceiptInteractions(item){
  if(!item?.id) return;

  const { error } = await Api.updateTransaction(item.id, {
    category: item.Splits?.length ? "SPLIT" : "",
    splits: item.Splits || [],
    review_status: item.ReviewStatus || "",
    deduction_status: item.DeductionStatus || "",
    review_note: item.ReviewNote || ""
  });

  if(error){
    console.error("Receipt interaction save error:", error);
    alert("Error saving receipt updates.");
    return;
  }

}

async function applySplit(category, amount, options = {}){
  const item = data[currentIndex];
  const categoryName = getAllowedCategoryName(category);
  if (!item.Splits) item.Splits = [];
  const previousSplits = Array.isArray(item.Splits) ? clonePlainValue(item.Splits) : [];
  const previousCategory = item.Category;
  const sourceProductNumber = String(options.sourceProductNumber || "").trim();
  if(sourceProductNumber){
    item.Splits = item.Splits.filter((split) => String(split?.SourceProductNumber || "") !== sourceProductNumber);
  }

  let total = item.Splits.reduce((sum, s) => sum + Math.round(normalizeMoney(s.Amount) * 100), 0) / 100;
  const receiptDiscount = getEffectiveReceiptDiscount(item);
  const remaining = parseFloat((normalizeMoney(item.Amount) - total - receiptDiscount).toFixed(2));

  if(amount > remaining + 0.01){
    item.Splits = previousSplits;
    item.Category = previousCategory;
    alert("Amount exceeds remaining balance.");
    return false;
  }

  if(Math.abs(amount - remaining) < 0.01) amount = remaining;
  if(amount <= 0){
    item.Splits = previousSplits;
    item.Category = previousCategory;
    alert("Enter a valid amount.");
    return false;
  }

  item.Splits.push({
    Category: categoryName,
    Amount: parseFloat(amount.toFixed(2)),
    ...(sourceProductNumber ? { SourceProductNumber: sourceProductNumber } : {}),
    ...(options.sourceMerchant ? { SourceMerchant: options.sourceMerchant } : {}),
    ...(options.sourceIdentifierType ? { SourceIdentifierType: options.sourceIdentifierType } : {}),
    ...(options.reviewStatus ? { ReviewStatus: options.reviewStatus } : {}),
    ...(options.deductionStatus ? { DeductionStatus: options.deductionStatus } : {}),
    ...(options.reviewNote ? { ReviewNote: options.reviewNote } : {})
  });
  item.Category = "SPLIT";
  SplitState.highlightedIndex = item.Splits.length - 1;

  await persistSplitItem(item);
  setTimeout(() => { SplitState.highlightedIndex = null; }, 420);

  return true;
}

function pickCategory(amount){

  return new Promise(resolve => {

    const overlay = document.createElement("div");

    overlay.style.position = "fixed";
    overlay.style.borderTop = "1px solid #eee";
overlay.style.backdropFilter = "blur(6px)";
    overlay.style.bottom = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.maxHeight = "50vh"; // 👈 less aggressive
overlay.style.padding = "12px 12px 20px 12px"; // 👈 bottom breathing room
overlay.style.boxSizing = "border-box";
overlay.style.paddingBottom = "env(safe-area-inset-bottom, 20px)";
    overlay.style.background = "white";
    overlay.style.borderTopLeftRadius = "16px";
    overlay.style.borderTopRightRadius = "16px";
    overlay.style.boxShadow = "0 -4px 20px rgba(0,0,0,.2)";

    overlay.style.overflowY = "auto";
  overlay.style.zIndex = "400000"; // 👈 ALWAYS on top

    let html = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h3 style="margin:0;">Select Category</h3>
        <button onclick="closeCategoryPicker()" style="
          background:#c62828;
          color:white;
          border:none;
          padding:6px 10px;
          border-radius:8px;
        ">← Back</button>
      </div>

      <div style="margin-bottom:10px; font-size:14px;">
        <strong>Amount:</strong> $${amount.toFixed(2)}
      </div>
    `;

    categories.forEach(c=>{
      html += `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">

  <button class="category-btn ${c.class}"
    style="flex:1; min-width:0;"
    onclick="selectCategory(${htmlJsString(c.name)})">
    ${escapeHtml(c.name)}
  </button>

  <button onclick="showCategoryInfo(${htmlJsString(c.name)})" style="
    flex-shrink:0;
    width:36px;
    height:36px;
    border-radius:50%;
    border:none;
    background:#eee;
    font-weight:bold;
  ">i</button>

</div>
      `;
    });

    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    window.selectCategory = (name)=>{
      document.body.removeChild(overlay);
      resolve(name);
    };

    window.closeCategoryPicker = ()=>{
      document.body.removeChild(overlay);
      resolve(null); // ← THIS IS THE FIX (escape hatch)
    };

  });

}

/* Category Breakdown Modal */

function showCategoryBreakdown(categoryName){

  currentCategoryBreakdownRows = [];
  currentCategoryBreakdownName = categoryName;
  let html = "";

  const visible = getVisibleIndexes();

  visible.forEach(i => {

    const d = data[i];

    // Normalize main category
    let normalizedCategory = d.Category;
    if(categoryAliases[normalizedCategory]){
      normalizedCategory = categoryAliases[normalizedCategory];
    }

    if(normalizedCategory === categoryName){
      currentCategoryBreakdownRows.push({
        index: i,
        Date: d.Date,
        LineItemTitle: d.Title || "",
        VendorDescription: d.Vendor || d.Title || "",
        Category: normalizedCategory || "",
        Amount: normalizeMoney(d.Amount),
        Notes: d.Notes || d.notes || "",
        ReceiptAttached: !!d.receipt_url
      });
      html += `
        <div class="modalItem" onclick="jumpToItem(${i})">
          ${escapeHtml(d.Title || d.Vendor || "Untitled Transaction")} — $${normalizeMoney(d.Amount).toFixed(2)}
        </div>
      `;
    }

    // Normalize splits
    if(d.Splits && d.Splits.length){
      d.Splits.forEach(s => {

        let splitCategory = s.Category;
        if(categoryAliases[splitCategory]){
          splitCategory = categoryAliases[splitCategory];
        }

        if(splitCategory === categoryName){
          currentCategoryBreakdownRows.push({
            index: i,
            Date: d.Date,
            LineItemTitle: d.Title || "",
            VendorDescription: d.Vendor || d.Title || "",
            Category: splitCategory || "",
            Amount: normalizeMoney(s.Amount),
            Notes: d.Notes || d.notes || "",
            ReceiptAttached: !!d.receipt_url
          });
          html += `
            <div class="modalItem" onclick="jumpToItem(${i})">
              ${escapeHtml(d.Title || d.Vendor || "Untitled Transaction")} (Split) — $${normalizeMoney(s.Amount).toFixed(2)}
            </div>
          `;
        }

      });
    }

  });

  const exportDisabled = currentCategoryBreakdownRows.length === 0 ? "disabled" : "";
  modalTitle.innerHTML = `
    <div class="breakdownTitleRow">
      <span>${escapeHtml(categoryName)} Transactions</span>
      <button class="breakdownExportBtn" onclick="exportCurrentCategoryBreakdown()" ${exportDisabled}>Export to Excel</button>
    </div>
  `;

  if(!html) html = "No transactions in this category.";

  modalContent.innerHTML = html;
  openModal();
}

function toExcelDateValue(value){
  if(!value) return "";
  const parsed = new Date(value);
  if(Number.isNaN(parsed.getTime())) return value;
  return parsed;
}

function toExportFileSlug(categoryName){
  return String(categoryName || "category")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "category";
}

function buildExportRows(){
  const rows = [];

  data.forEach((item) => {
    const base = {
      Date: toExcelDateValue(item.Date),
      Vendor: item.Vendor || "",
      Description: item.Title || "",
      Institution: item.Institution || "",
      "Receipt Attached": !!item.receipt_url ? "Yes" : "No",
      Notes: item.Notes || item.notes || "",
      "Transaction Amount": normalizeMoney(item.Amount),
      "Review Status": item.ReviewStatus || "",
      "Deduction Status": item.DeductionStatus || "",
      "Review Note": item.ReviewNote || "",
    };

    if(Array.isArray(item.Splits) && item.Splits.length){
      item.Splits.forEach((split) => {
        const categoryName = normalizeCategoryName(split.Category || "Needs Review");
        const taxMeta = getCategoryTaxMetadata(categoryName);
        rows.push({
          ...base,
          Category: categoryName,
          Amount: normalizeMoney(split.Amount),
          "Split Transaction": "Yes",
          "Source Product Number": split.SourceProductNumber || "",
          "Source Merchant": split.SourceMerchant || "",
          "Source Identifier Type": split.SourceIdentifierType || "",
          "Review Status": split.ReviewStatus || item.ReviewStatus || "",
          "Deduction Status": split.DeductionStatus || item.DeductionStatus || "",
          "Review Note": split.ReviewNote || item.ReviewNote || "",
          "Tax Treatment": taxMeta.tax_treatment,
          "Schedule C Reference": taxMeta.schedule_c_reference,
          "Tax Note": taxMeta.tax_note,
        });
      });
      return;
    }

    const categoryName = normalizeCategoryName(item.Category || "Needs Review");
    const taxMeta = getCategoryTaxMetadata(categoryName);
    rows.push({
      ...base,
      Category: categoryName,
      Amount: normalizeMoney(item.Amount),
      "Split Transaction": "No",
      "Source Product Number": "",
      "Source Merchant": "",
      "Source Identifier Type": "",
      "Review Status": item.ReviewStatus || "",
      "Deduction Status": item.DeductionStatus || "",
      "Review Note": item.ReviewNote || "",
      "Tax Treatment": taxMeta.tax_treatment,
      "Schedule C Reference": taxMeta.schedule_c_reference,
      "Tax Note": taxMeta.tax_note,
    });
  });

  return rows;
}

function buildSummaryRows(rows, key){
  const totalsByKey = {};

  rows.forEach((row) => {
    const bucket = String(row[key] || "Unassigned");
    totalsByKey[bucket] = (totalsByKey[bucket] || 0) + (Number(row.Amount) || 0);
  });

  return Object.keys(totalsByKey)
    .sort((left, right) => left.localeCompare(right))
    .map((bucket) => ({
      [key]: bucket,
      Amount: Number(totalsByKey[bucket].toFixed(2)),
    }));
}

function buildReviewRows(rows){
  return rows
    .filter((row) => {
      const category = String(row.Category || "");
      const taxTreatment = String(row["Tax Treatment"] || "");
      const scheduleRef = String(row["Schedule C Reference"] || "");
      return category === "Needs Review"
        || taxTreatment === "review"
        || /review/i.test(scheduleRef);
    })
    .map((row) => ({
      Date: row.Date,
      Vendor: row.Vendor,
      Description: row.Description,
      Category: row.Category,
      Amount: row.Amount,
      "Transaction Amount": row["Transaction Amount"],
      "Split Transaction": row["Split Transaction"],
      "Review Status": row["Review Status"],
      "Deduction Status": row["Deduction Status"],
      "Review Note": row["Review Note"],
      "Schedule C Reference": row["Schedule C Reference"],
      "Tax Treatment": row["Tax Treatment"],
      "Tax Note": row["Tax Note"],
      "Source Merchant": row["Source Merchant"],
      "Source Product Number": row["Source Product Number"],
    }));
}

function formatWorksheetNumbers(ws, amountColumnIndexes = []){
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");

  for(let r = 1; r <= range.e.r; r++){
    const dateCellAddress = XLSX.utils.encode_cell({ r, c: 0 });
    const dateCell = ws[dateCellAddress];
    if(dateCell && dateCell.t === "d") dateCell.z = "yyyy-mm-dd";

    amountColumnIndexes.forEach((columnIndex) => {
      const amountCellAddress = XLSX.utils.encode_cell({ r, c: columnIndex });
      const amountCell = ws[amountCellAddress];
      if(amountCell){
        amountCell.t = "n";
        amountCell.z = "0.00";
      }
    });
  }
}

function exportCurrentCategoryBreakdown(){
  if(!currentCategoryBreakdownRows.length) return;

  const rows = currentCategoryBreakdownRows.map((row) => ({
    "Date": toExcelDateValue(row.Date),
    "Line Item Title": row.LineItemTitle || "",
    "Vendor / Description": row.VendorDescription || "",
    "Category": row.Category || "",
    "Amount": Number(row.Amount) || 0
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");

  for(let r = 1; r <= range.e.r; r++){
    const dateCellAddress = XLSX.utils.encode_cell({ r, c: 0 });
    const dateCell = ws[dateCellAddress];
    if(dateCell && dateCell.t === "d"){
      dateCell.z = "yyyy-mm-dd";
    }

    const amountCellAddress = XLSX.utils.encode_cell({ r, c: 4 });
    const amountCell = ws[amountCellAddress];
    if(amountCell){
      amountCell.t = "n";
      amountCell.z = "0.00";
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transactions");
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${toExportFileSlug(currentCategoryBreakdownName)}-transactions-${today}.xlsx`;
  XLSX.writeFile(wb, filename, { cellDates: true });
}

function jumpToItem(index){

// Clear search filter so the item is visible
activeSearchFilter = null;
const clearBtn = document.getElementById("clearSearchBtn");
if(clearBtn) clearBtn.style.display = "none";

// Ensure we are not restricted by Uncategorized filter
if(showOnlyUncategorized && data[index].Category){
showOnlyUncategorized = false;
const toggleBtn = document.getElementById("filterToggle");
if(toggleBtn) toggleBtn.innerText = "Show Only Uncategorized";
}

currentIndex = index;
closeModal();
showCard();

// Scroll to top for clarity (optional but helpful UX)
window.scrollTo({ top: 0, behavior: "smooth" });
}

/* Modal Controls */

const modalSwipeState = {
  startY: 0,
  startX: 0,
  startTime: 0,
  lastY: 0,
  lastTime: 0,
  dragY: 0,
  tracking: false,
  lockedToScroll: false,
  activeScroller: null,
  startedInHeader: false
};

const MODAL_SWIPE_DISTANCE_PX = 140;
const MODAL_SWIPE_VELOCITY_PX_PER_MS = 0.9;
const MODAL_SWIPE_MIN_DRAG_PX = 18;
const MODAL_SWIPE_RESISTANCE = 0.42;

function getScrollableParent(target, limitEl){
  let node = target;
  while(node && node !== limitEl){
    if(node.scrollHeight > node.clientHeight){
      const style = window.getComputedStyle(node);
      if(style.overflowY === 'auto' || style.overflowY === 'scroll') return node;
    }
    node = node.parentElement;
  }
  return modalContent;
}

function resetModalSheetStyles(sheet){
  sheet.style.transition = '';
  sheet.style.transform = '';
  sheet.style.opacity = '';
}

function animateModalSnapBack(sheet){
  sheet.style.transition = 'transform 280ms cubic-bezier(.22,.61,.36,1), opacity 220ms ease';
  sheet.style.transform = 'translateY(0) scale(1)';
  sheet.style.opacity = '1';
  window.setTimeout(() => {
    if(modalOverlay.classList.contains('isOpen')) resetModalSheetStyles(sheet);
  }, 300);
}

function animateModalCloseFromSwipe(sheet){
  const fromY = Math.max(modalSwipeState.dragY, 0);
  const endY = Math.max(window.innerHeight, sheet.getBoundingClientRect().height + 120);
  sheet.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease';
  sheet.style.transform = `translateY(${fromY}px) scale(1)`;
  sheet.style.opacity = String(Math.max(0.55, 1 - (fromY / 500)));
  requestAnimationFrame(() => {
    sheet.style.transform = `translateY(${endY}px) scale(1)`;
    sheet.style.opacity = '0';
  });
  window.setTimeout(() => {
    resetModalSheetStyles(sheet);
    dismissModalToContext();
  }, 220);
}

function openModal(zIndex = 9999){
  modalOverlay.style.display = "flex";
  modalOverlay.style.zIndex = zIndex;
  modalOverlay.classList.add("isOpen");
  document.body.style.overflow = "hidden";
  initModalSwipeClose();
}

function closeModal(){
  modalOverlay.classList.remove("isOpen");
  modalOverlay.style.display = "none";
  modalOverlay.style.zIndex = 9999; // reset to default
  modalContent.innerHTML = "";
  document.body.style.overflow = "";
  closeNumericKeypad(true);
  modalBackAction = null;
  const sheet = document.querySelector('.modalBox');
  if(sheet) resetModalSheetStyles(sheet);
}

function initModalSwipeClose(){
  const sheet = document.querySelector('.modalBox');
  if(!sheet || sheet.dataset.swipeBound) return;
  sheet.dataset.swipeBound = 'true';

  sheet.addEventListener('touchstart', (e) => {
    if(e.touches.length !== 1) return;
    const t = e.touches[0];
    modalSwipeState.startY = t.clientY;
    modalSwipeState.startX = t.clientX;
    modalSwipeState.startTime = performance.now();
    modalSwipeState.lastY = t.clientY;
    modalSwipeState.lastTime = modalSwipeState.startTime;
    modalSwipeState.dragY = 0;
    modalSwipeState.tracking = true;
    const sheetRect = sheet.getBoundingClientRect();
    modalSwipeState.startedInHeader = !!e.target.closest(".modalDragHandle") || (t.clientY - sheetRect.top) <= 110;
    modalSwipeState.activeScroller = getScrollableParent(e.target, sheet);
    modalSwipeState.lockedToScroll = (modalSwipeState.activeScroller?.scrollTop || 0) > 0 || !modalSwipeState.startedInHeader;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if(!modalSwipeState.tracking || e.touches.length !== 1) return;

    const t = e.touches[0];
    const dy = t.clientY - modalSwipeState.startY;
    const dx = Math.abs(t.clientX - modalSwipeState.startX);

    modalSwipeState.lastY = t.clientY;
    modalSwipeState.lastTime = performance.now();

    if(dx > Math.abs(dy)) return;
    if(dy <= 0) return;

    if(!modalSwipeState.startedInHeader) return;
    const scrollerTop = (modalSwipeState.activeScroller?.scrollTop || 0) <= 0;
    if(modalSwipeState.lockedToScroll || !scrollerTop) return;

    if(dy < MODAL_SWIPE_MIN_DRAG_PX) return;

    e.preventDefault();
    modalSwipeState.dragY = dy * MODAL_SWIPE_RESISTANCE;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${modalSwipeState.dragY}px) scale(1)`;
    sheet.style.opacity = String(Math.max(0.78, 1 - (modalSwipeState.dragY / 700)));
  }, { passive: false });

  sheet.addEventListener('touchend', () => {
    if(!modalSwipeState.tracking) return;

    const totalDy = modalSwipeState.lastY - modalSwipeState.startY;
    const totalDt = Math.max(modalSwipeState.lastTime - modalSwipeState.startTime, 1);
    const velocityY = totalDy / totalDt;

    const shouldClose =
      modalSwipeState.dragY >= MODAL_SWIPE_DISTANCE_PX ||
      (totalDy >= MODAL_SWIPE_MIN_DRAG_PX && velocityY >= MODAL_SWIPE_VELOCITY_PX_PER_MS);

    if(shouldClose){
      animateModalCloseFromSwipe(sheet);
    } else if(modalSwipeState.dragY > 0){
      animateModalSnapBack(sheet);
    }

    modalSwipeState.tracking = false;
    modalSwipeState.lockedToScroll = false;
    modalSwipeState.activeScroller = null;
    modalSwipeState.startedInHeader = false;
    modalSwipeState.dragY = 0;
  }, { passive: true });

  sheet.addEventListener('touchcancel', () => {
    if(modalSwipeState.dragY > 0) animateModalSnapBack(sheet);
    modalSwipeState.tracking = false;
    modalSwipeState.lockedToScroll = false;
    modalSwipeState.activeScroller = null;
    modalSwipeState.startedInHeader = false;
    modalSwipeState.dragY = 0;
  }, { passive: true });
}

modalOverlay.addEventListener("click",function(e){
if(e.target===modalOverlay) dismissModalToContext();
});

document.addEventListener("keydown",function(e){
if(e.key==="Escape") dismissModalToContext();
});

/* Show Card */

function showCard(){

  if(!data.length){
    cardTitle.innerText = "No Transactions";
    cardMeta.innerHTML = "";
    splitSummary.innerHTML = "";
    currentCategory.innerText = "";
    document.getElementById("positionIndicator").innerText = "";
    return;
  }

  const visible = getVisibleIndexes();

  if(visible.length === 0){
    cardTitle.innerText = "No Transactions Found";
    cardMeta.innerHTML = "";
    splitSummary.innerHTML = "";
    currentCategory.innerText = "";
    document.getElementById("positionIndicator").innerText = "";
    return;
  }

  if(!visible.includes(currentIndex)){
    currentIndex = visible[0];
  }

  const position = visible.indexOf(currentIndex) + 1;

  document.getElementById("positionIndicator").innerText =
    `Transaction ${position} of ${visible.length}`;

  const item = data[currentIndex];

  // Clean title
  cardTitle.innerText = item.Title || item.Vendor || "Untitled Transaction";

  cardMeta.innerHTML =
  `<div class="transactionMeta">${item.Date ? `Date: ${escapeHtml(item.Date)}<br>` : ""}Amount: $${normalizeMoney(item.Amount).toFixed(2)}</div>`;

  splitSummary.innerHTML = buildSplitSummaryHTML(item);

  const categoryLabel = item.Splits && item.Splits.length
    ? "Split transaction"
    : (item.Category || "Uncategorized");

  currentCategory.innerHTML = `<div class="currentCategoryRow"><span class="currentCategoryBadge">Current Category: ${escapeHtml(categoryLabel)}</span></div>`;
  renderCategories();
}

/* Totals */

function updateTotals(){

  let totalsObj = {};

  // Build totals object dynamically from categories (stored in cents)
  categories.forEach(c => totalsObj[c.name] = 0);

  const visible = getVisibleIndexes();

  visible.forEach(i => {

    const d = data[i];

    const addAmount = (cat, amount) => {
      if(!cat || cat.trim() === ""){
        return; // skip uncategorized entirely
      }

      if(categoryAliases[cat]){
        cat = categoryAliases[cat];
      }

      const cents = Math.round(normalizeMoney(amount) * 100);

      if(totalsObj[cat] != null){
        totalsObj[cat] += cents;
      }
    };

    // Handle splits
    if(d.Splits && d.Splits.length){

      d.Splits.forEach(s => {
        addAmount(s.Category, s.Amount);
      });

    } else {

      addAmount(d.Category, d.Amount);

    }

  });

  // Render totals UI
  totals.innerHTML = "";

  Object.keys(totalsObj).forEach(k => {
    totals.innerHTML += `
      <div class="totalRow" onclick="showCategoryBreakdown(${htmlJsString(k)})">
        <div>${escapeHtml(k)}</div>
        <div>$${(totalsObj[k] / 100).toFixed(2)}</div>
      </div>
    `;
  });

}

/* Progress */

function updateProgress(){
const visible = getVisibleIndexes();
const total = visible.length;
const done = visible.filter(i => data[i].Category).length;
const percent=total?Math.round((done/total)*100):0;
progressBar.style.width=percent+"%";
progressText.innerText=`${done} of ${total} categorized (${percent}%)`;
}

/* Export */

function exportExcel(){
const exportRows = buildExportRows();
const detailWs = XLSX.utils.json_to_sheet(exportRows);
formatWorksheetNumbers(detailWs, [6, 8]);

const summaryByCategoryWs = XLSX.utils.json_to_sheet(buildSummaryRows(exportRows, "Category"));
formatWorksheetNumbers(summaryByCategoryWs, [1]);

const summaryByTaxWs = XLSX.utils.json_to_sheet(buildSummaryRows(exportRows, "Schedule C Reference"));
formatWorksheetNumbers(summaryByTaxWs, [1]);

const reviewRows = buildReviewRows(exportRows);
const reviewWs = XLSX.utils.json_to_sheet(reviewRows.length ? reviewRows : [{ Note: "No review items." }]);
if(reviewRows.length) formatWorksheetNumbers(reviewWs, [4, 5]);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, detailWs, "Detail");
XLSX.utils.book_append_sheet(wb, summaryByCategoryWs, "By Category");
XLSX.utils.book_append_sheet(wb, summaryByTaxWs, "By Tax Bucket");
XLSX.utils.book_append_sheet(wb, reviewWs, "Review Items");
XLSX.writeFile(wb, `schedule-c-categorizer-export-${new Date().toISOString().slice(0, 10)}.xlsx`, { cellDates: true });
}

function buildQaReviewRows(){
  const rows = [];

  getVisibleIndexes().forEach((index) => {
    const item = data[index];
    const categoryName = normalizeCategoryName(item.Category || "Needs Review");
    const taxMeta = getCategoryTaxMetadata(categoryName);
    const issues = [];

    if((!item.Splits || !item.Splits.length) && !item.Category){
      issues.push("Uncategorized transaction");
    }

    if(item.ReviewStatus && item.ReviewStatus !== "Deductible"){
      issues.push(item.ReviewStatus);
    }

    if((!item.Splits || !item.Splits.length) && taxMeta.tax_treatment === "review"){
      issues.push("Review-tax category");
    }

    (item.Splits || []).forEach((split) => {
      const splitCategory = normalizeCategoryName(split.Category || "Needs Review");
      const splitTaxMeta = getCategoryTaxMetadata(splitCategory);
      const splitReviewStatus = String(split.ReviewStatus || "").trim();
      if(splitReviewStatus && splitReviewStatus !== "Deductible"){
        issues.push(`Split: ${splitReviewStatus} (${splitCategory})`);
      } else if(splitTaxMeta.tax_treatment === "review"){
        issues.push(`Split: review-tax category (${splitCategory})`);
      }
    });

    const uniqueIssues = [...new Set(issues)];
    if(!uniqueIssues.length) return;

    rows.push({
      index,
      issue: uniqueIssues.join(" • "),
      issueCount: uniqueIssues.length,
      vendor: item.Vendor || item.Title || "",
      amount: normalizeMoney(item.Amount),
      date: item.Date || "",
    });
  });

  rows.sort((left, right) => {
    if(right.issueCount !== left.issueCount) return right.issueCount - left.issueCount;
    return String(left.date || "").localeCompare(String(right.date || ""));
  });

  return rows;
}

function openQaReviewModal(){
  const rows = buildQaReviewRows();
  modalTitle.innerText = "QA Review";

  if(!rows.length){
    modalContent.innerHTML = `<div style="padding:10px;" class="small">No current QA review items.</div>`;
    openModal();
    return;
  }

  modalContent.innerHTML = `
    <div style="padding:10px;" class="small">
      Reviewing <strong>${rows.length}</strong> transaction${rows.length === 1 ? "" : "s"} within the current filter scope.
    </div>
    ${rows.map((row) => `
    <div class="modalItem" onclick="jumpToItem(${row.index})">
      <strong>${escapeHtml(row.issue)}</strong><br>
      ${row.date ? `<span class="small">${escapeHtml(row.date)}</span><br>` : ""}
      ${escapeHtml(row.vendor)}<br>
      <span class="small">${Utils.money(row.amount)}</span>
    </div>
  `).join("")}
  `;
  openModal();
}

async function connectBank() {

  const res = await fetch(
    edgeFunctionUrl("create-link-token"),
    {
      method: "POST",
      headers: await getAuthHeaders()
    }
  );

  const linkData = await res.json();

  if (!linkData.link_token) {
    alert("Failed to create link token");
    console.error(linkData);
    return;
  }

  const handler = Plaid.create({
    token: linkData.link_token,

    onSuccess: async (public_token) => {

      // Exchange token
      const exchangeRes = await fetch(
        edgeFunctionUrl("exchange-token"),
        {
          method: "POST",
          headers: await getAuthHeaders(),
          body: JSON.stringify({ public_token })
        }
      );

      const exchangeData = await exchangeRes.json();

      if (!exchangeRes.ok) {
        console.error(exchangeData);
        alert("Token exchange failed");
        return;
      }

      await loadTransactions();

      const importLabel = typeof exchangeData.imported === "number"
        ? ` Imported: ${exchangeData.imported}.`
        : "";
      const removedLabel = typeof exchangeData.removed === "number" && exchangeData.removed > 0
        ? ` Removed: ${exchangeData.removed}.`
        : "";
      const repairedLabel = exchangeData.webhook_updated === true
        ? " Webhook repaired."
        : "";
      const repairErrorLabel = exchangeData.webhook_error
        ? ` Webhook repair error: ${exchangeData.webhook_error}.`
        : "";

      alert(`Bank connected and transactions synced.${importLabel}${removedLabel}${repairedLabel}${repairErrorLabel}`);
    },

    onExit: function(err) {
      if (err) console.log("Plaid exit error:", err);
    }
  });

  handler.open();
}

async function askAI(){
  const resolvedProduct = aiContext?.type === "detected-receipt-item"
    ? (SplitState.detectedResolvedProducts?.[aiContext.itemNumber] || null)
    : null;
  const contextPrompt = aiContext?.type === "detected-receipt-item"
    ? `<div class="small" style="margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--panel-alt);">
        Line item <strong>${escapeHtml(resolvedProduct?.product_name || aiContext.itemNumber)}</strong>
        <br><code>${escapeHtml(aiContext.itemNumber)}</code>${Number.isFinite(aiContext.amount) ? ` • ${Utils.money(aiContext.amount)}` : ""}
      </div>`
    : "";

  // STEP 1: Ask user for context FIRST
  modalTitle.innerText = "🤖 AI Categorization";

  modalContent.innerHTML = `
    <div style="padding:10px;">
      ${contextPrompt}

      <div style="margin-bottom:10px;">
        <strong>What was this purchase for?</strong>
      </div>

      <textarea id="aiUserInput" placeholder="Example: we bought keys for the shop, packaging supplies, resale items..." style="
        width:100%;
        height:100px;
        padding:10px;
        border-radius:10px;
        border:1px solid #ddd;
        margin-bottom:12px;
        font-size:14px;
      "></textarea>

      <button onclick="submitAIRequest()" style="
        background:#000;
        color:white;
        padding:12px;
        border-radius:10px;
        width:100%;
      ">
        Ask AI
      </button>

    </div>
  `;

  openModal();
}

async function submitAIRequest(){

  const item = data[currentIndex];
  const userInput = document.getElementById("aiUserInput").value;

  if(!userInput.trim()){
    alert("Please enter a quick description.");
    return;
  }

  modalContent.innerHTML = `
    <div style="padding:10px;">
      <strong>Analyzing transaction...</strong>
    </div>
  `;

  try {

    const response = await fetch(
      edgeFunctionUrl("ask-ai"),
      {
        method: "POST",
        headers: await getAuthHeaders(),
 body: JSON.stringify({
  userInput: userInput,
  categories: categories.map(c => {
    const taxMeta = getCategoryTaxMetadata(c.name);
    return {
      name: c.name,
      description: stripHtml(c.description || ""),
      tax_treatment: taxMeta.tax_treatment,
      schedule_c_reference: taxMeta.schedule_c_reference,
      tax_note: taxMeta.tax_note
    };
  }),
  transactionContext: {
    title: item?.Title || "",
    vendor: item?.Vendor || "",
    amount: Number(item?.Amount || 0),
    institution: item?.Institution || "",
    current_category: item?.Category || ""
  },
  receiptItemContext: aiContext?.type === "detected-receipt-item"
    ? {
      item_number: aiContext.itemNumber,
      product_name: SplitState.detectedResolvedProducts?.[aiContext.itemNumber]?.product_name || "",
      receipt_label: (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === String(aiContext.itemNumber))?.receipt_label || "",
      amount: Number(aiContext.amount || 0)
    }
    : null
})
      }
    );

    const result = await response.json();

    if(!response.ok){
      throw new Error(result.error || "AI request failed");
    }

    const rawCategory = String(result?.category || "").trim();
    const safeResult = {
      category: getAllowedCategoryName(rawCategory),
      reasoning: String(result?.reasoning || "").trim(),
      confidence: ["High", "Medium", "Low"].includes(String(result?.confidence || "").trim())
        ? String(result.confidence).trim()
        : "Low",
      deduction_status: ["Deductible", "Review Required", "Potentially Non-Deductible"].includes(String(result?.deduction_status || "").trim())
        ? String(result.deduction_status).trim()
        : "Review Required",
      tax_consideration: String(result?.tax_consideration || "").trim(),
      follow_up_question: String(result?.follow_up_question || "").trim(),
    };

    if(rawCategory && rawCategory !== safeResult.category){
      safeResult.reasoning = [
        safeResult.reasoning,
        `AI returned unsupported category "${rawCategory}", so this was routed to ${safeResult.category}.`
      ].filter(Boolean).join(" ");
    }

    aiSuggestionResult = safeResult;

    modalContent.innerHTML = `
      <div style="padding:10px;">

        <div style="font-size:16px; margin-bottom:10px;">
          <strong>Suggested Category:</strong><br>
          <span style="color:#2e7d32; font-size:18px;">
            ${escapeHtml(safeResult.category)}
          </span>
        </div>

        <div style="margin-bottom:15px;">
          <strong>Reasoning:</strong><br>
         ${escapeHtml(safeResult.reasoning)}
<br><br>
Confidence: <strong>${escapeHtml(safeResult.confidence)}</strong>
${safeResult.deduction_status ? `<br><br><strong>Deduction status:</strong><br>${escapeHtml(safeResult.deduction_status)}` : ""}
${safeResult.tax_consideration ? `<br><br><strong>Tax consideration:</strong><br>${escapeHtml(safeResult.tax_consideration)}` : ""}
${safeResult.follow_up_question ? `<br><br><strong>If still unsure:</strong><br>${escapeHtml(safeResult.follow_up_question)}` : ""}
        </div>

        <button onclick="applyAISuggestion(${htmlJsString(safeResult.category)})" style="
  background:#2e7d32;
  color:white;
  padding:12px;
  border-radius:10px;
  width:100%;
  margin-bottom:8px;
">
  ✅ Accept Suggestion
</button>

        <button onclick="askAI()" style="
          background:#ccc;
          padding:12px;
          border-radius:10px;
          width:100%;
        ">
          Try Again
        </button>

      </div>
    `;

  } catch(err){
    console.error(err);

    modalContent.innerHTML = `
      <div style="padding:10px; color:red;">
        Error getting AI suggestion
      </div>
    `;
  }
}

async function applyAISuggestion(category){
  const categoryName = getAllowedCategoryName(category);

  if(aiContext?.type === "detected-receipt-item"){
    const selectedItem = aiContext.itemNumber;
    const amount = aiContext.amount;
    const parsed = (SplitState.detectedParsedItems || []).find((entry) => String(entry?.product_number || "") === String(selectedItem));
    const resolved = SplitState.detectedResolvedProducts?.[selectedItem] || null;
    const suggestion = aiSuggestionResult;
    aiContext = null;

    if(needsDetectedItemNameConfirmation(selectedItem, resolved)){
      alert("Confirm or edit the product name before applying an AI category suggestion.");
      openDetectedItemNameModal(selectedItem);
      return;
    }

    if(!selectedItem || !Number.isFinite(amount) || amount <= 0){
      alert("Missing detected item amount for AI assignment.");
      openDetectedReceiptItemsModal();
      return;
    }

    const success = await applySplit(categoryName, amount, {
      sourceProductNumber: selectedItem,
      sourceMerchant: SplitState.detectedMerchant || "misc",
      sourceIdentifierType: parsed?.identifier_type || "unknown",
      reviewStatus: suggestion?.deduction_status || "",
      deductionStatus: suggestion?.deduction_status || "",
      reviewNote: [suggestion?.reasoning, suggestion?.tax_consideration].filter(Boolean).join(" | ")
    });
    aiSuggestionResult = null;
    if(success){
      storeReceiptAnalysisCache(data[currentIndex]);
      openDetectedReceiptItemsModal();
    }
    return;
  }

  aiContext = null;

  // NORMAL FLOW
  const item = data[currentIndex];
  if(!item) return;

  const previousState = {
    Category: item.Category,
    Splits: Array.isArray(item.Splits) ? [...item.Splits] : [],
    ReviewStatus: item.ReviewStatus,
    DeductionStatus: item.DeductionStatus,
    ReviewNote: item.ReviewNote,
  };

  item.Category = categoryName;
  item.Splits = [];
  item.ReviewStatus = aiSuggestionResult?.deduction_status || "";
  item.DeductionStatus = aiSuggestionResult?.deduction_status || "";
  item.ReviewNote = [aiSuggestionResult?.reasoning, aiSuggestionResult?.tax_consideration].filter(Boolean).join(" | ");

  updateTotals();
  updateProgress();

  if(item.id){
    const { error } = await Api.updateTransaction(item.id, {
      category: categoryName,
      splits: [],
      review_status: item.ReviewStatus || "",
      deduction_status: item.DeductionStatus || "",
      review_note: item.ReviewNote || ""
    });

    if(error){
      Object.assign(item, previousState);
      updateTotals();
      updateProgress();
      console.error("AI category save error:", error);
      alert("Error saving AI suggestion.");
      return;
    }
  }

  aiSuggestionResult = null;
  closeModal();
  goNext();
}

function stripHtml(value){
  const container = document.createElement("div");
  container.innerHTML = String(value || "");
  return (container.textContent || container.innerText || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function selectCategory(category){

  // NORMAL FLOW (unchanged)
  categorize(category);
  closeModal();
}
