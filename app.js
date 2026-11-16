(() => {
  "use strict";

  const STORAGE_KEYS = {
    products: "rlstoreos.products",
    sales: "rlstoreos.sales",
    expenses: "rlstoreos.expenses",
    customers: "rlstoreos.customers",
    collections: "rlstoreos.collections",
    settings: "rlstoreos.settings"
  };
  const NAV_LABELS = {
    dashboard: "Dashboard",
    pos: "Point of sale",
    inventory: "Inventory",
    customers: "Customers",
    expenses: "Expenses",
    reports: "Reports"
  };
  const EXPENSE_CATEGORIES = ["Rent", "Internet", "Gasoline", "Utilities", "Salary", "Supplies", "Others"];
  const PAYMENT_SOURCES = ["Cash", "GCash", "Bank transfer", "Other"];
  const STARTER_PRODUCTS = [];
  const peso = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2
  });
  const quantityFormat = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 3 });
  const localDate = new Intl.DateTimeFormat("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
  const cloud = window.RLStoreSupabase;
  const cloudMode = Boolean(cloud && cloud.isConfigured());
  const today = getLocalDateKey(new Date());
  const elements = {};
  let cart = [];
  let selectedPayment = "Cash";
  let selectedCustomerId = "";
  let activeLedgerCustomerId = "";
  let cloudReadOnly = false;
  let cloudUser = null;
  let localMigrationSnapshot = null;
  let localMigrationError = null;
  let cloudRefreshTimer = null;

  function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function readArray(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error(`Saved data for "${key}" must be a list.`);
    return value;
  }

  function readObject(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`Saved data for "${key}" must be an object.`);
    }
    return value;
  }

  function normalizeProduct(product) {
    if (!product || typeof product !== "object" || Array.isArray(product)) {
      throw new Error("A product record is not an object.");
    }
    const optionalQuantity = value => value === null || value === undefined || value === "" ? null : Number(value);
    const normalized = {
      id: String(product.id || "").trim(),
      name: String(product.name || "").trim(),
      unit: String(product.unit || "PC").trim().toUpperCase(),
      price: Number(product.price),
      cost: Number(product.cost),
      stock: optionalQuantity(product.stock),
      minimum: optionalQuantity(product.minimum)
    };
    if (!normalized.id || !normalized.name || !normalized.unit) throw new Error("Products need an ID, name, and unit.");
    if (![normalized.price, normalized.cost].every(Number.isFinite) ||
      [normalized.stock, normalized.minimum].some(value => value !== null && !Number.isFinite(value))) {
      throw new Error(`Product "${normalized.id}" has an invalid number.`);
    }
    if (normalized.price < 0 || normalized.cost < 0 ||
      [normalized.stock, normalized.minimum].some(value => value !== null && value < 0)) {
      throw new Error(`Product "${normalized.id}" cannot have negative values.`);
    }
    return normalized;
  }

  function readProducts() {
    return readArray(STORAGE_KEYS.products).map(normalizeProduct);
  }

  function saveProducts(products) {
    localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(products));
  }

  function normalizeCustomer(customer, fallbackId) {
    if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
      throw new Error("A customer record is not an object.");
    }
    const normalized = {
      id: String(customer.id || fallbackId || "").trim(),
      name: String(customer.name || "").trim(),
      balance: Number(customer.balance ?? 0)
    };
    if (!normalized.id || !normalized.name) throw new Error("Customers need an ID and name.");
    if (!Number.isFinite(normalized.balance) || normalized.balance < 0) {
      throw new Error(`Customer "${normalized.name}" has an invalid balance.`);
    }
    return normalized;
  }

  function readCustomers() {
    const records = readArray(STORAGE_KEYS.customers);
    const usedIds = new Set(records.map(customer => String(customer && customer.id || "").trim()).filter(Boolean));
    let sequence = 1;
    return records.map(customer => {
      let id = String(customer && customer.id || "").trim();
      if (!id) {
        id = `C${String(sequence).padStart(4, "0")}`;
        while (usedIds.has(id)) {
          sequence += 1;
          id = `C${String(sequence).padStart(4, "0")}`;
        }
        usedIds.add(id);
        sequence += 1;
      }
      return normalizeCustomer(customer, id);
    });
  }

  function saveCustomers(customers) {
    localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customers));
  }

  function captureLocalStore() {
    return {
      products: readProducts(),
      customers: readCustomers(),
      sales: readArray(STORAGE_KEYS.sales),
      collections: readArray(STORAGE_KEYS.collections),
      expenses: readExpenses(),
      settings: readObject(STORAGE_KEYS.settings)
    };
  }

  function applyCloudStore(store) {
    localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(store.products));
    localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(store.customers));
    localStorage.setItem(STORAGE_KEYS.sales, JSON.stringify(store.sales));
    localStorage.setItem(STORAGE_KEYS.collections, JSON.stringify(store.collections));
    localStorage.setItem(STORAGE_KEYS.expenses, JSON.stringify(store.expenses));
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(store.settings));
  }

  function hasLocalStoreData(store) {
    return Boolean(store && (
      store.products.length || store.customers.length || store.sales.length ||
      store.collections.length || store.expenses.length || Object.keys(store.settings).length
    ));
  }

  function isCloudStoreEmpty(store) {
    return !store.products.length && !store.customers.length && !store.sales.length &&
      !store.collections.length && !store.expenses.length;
  }

  function renderWorkspace() {
    renderCustomers();
    renderExpenses();
    renderReports();
    renderCart();
    setView(location.hash.slice(1) || "dashboard");
    renderDashboard();
  }

  function setCloudStatus(message, readOnly) {
    cloudReadOnly = Boolean(readOnly);
    if (elements.workspaceModeLabel) {
      elements.workspaceModeLabel.textContent = cloudMode ? "Shared workspace" : "Local workspace";
    }
    if (elements.workspaceModeDetail) {
      elements.workspaceModeDetail.textContent = cloudMode
        ? "Shared with invited staff"
        : "Data stays on this device";
    }
    if (elements.cloudSyncStatus) {
      elements.cloudSyncStatus.textContent = message || "";
      elements.cloudSyncStatus.hidden = !cloudMode || !message;
    }
    if (elements.cloudUserEmail) {
      elements.cloudUserEmail.textContent = cloudUser && cloudUser.email ? cloudUser.email : "";
      elements.cloudUserEmail.hidden = !cloudMode || !cloudUser;
    }
    if (elements.cloudSignoutButton) elements.cloudSignoutButton.hidden = !cloudMode || !cloudUser;
    if (elements.completeSaleButton) updateCheckoutState();
  }

  function showCloudAuthError(message) {
    elements.cloudAuthError.textContent = message;
    elements.cloudAuthError.hidden = false;
  }

  function setCloudAuthVisible(visible) {
    elements.appShell.hidden = visible;
    elements.cloudAuthScreen.hidden = !visible;
  }

  async function loadCloudStore() {
    const store = await cloud.loadStore();
    applyCloudStore(store);
    return store;
  }

  async function openCloudWorkspace(session) {
    if (!navigator.onLine) {
      if (localStorage.getItem(STORAGE_KEYS.products) === null) {
        throw new Error("There is no cached shared data on this device. Connect to the internet, then sign in.");
      }
      cloudUser = session.user;
      setCloudStatus("Offline · cached data is read-only", true);
      setCloudAuthVisible(false);
      renderWorkspace();
      startCloudRefreshTimer();
      return true;
    }

    let store;
    try {
      store = await cloud.loadStore();
    } catch (error) {
      if (localStorage.getItem(STORAGE_KEYS.products) === null) throw error;
      cloudUser = session.user;
      setCloudStatus(
        `Shared store unavailable · showing cached data read-only: ${error instanceof Error ? error.message : "Could not connect."}`,
        true
      );
      setCloudAuthVisible(false);
      renderWorkspace();
      startCloudRefreshTimer();
      return true;
    }
    if (isCloudStoreEmpty(store) && hasLocalStoreData(localMigrationSnapshot)) {
      if (localMigrationError) {
        throw new Error(`This shared store is empty, but local data could not be prepared for import: ${localMigrationError}`);
      }
      const shouldImport = window.confirm(
        "The shared store is empty. Import the products, customers, sales, collections, and expenses saved on this device? This import runs only into an empty shared store."
      );
      if (!shouldImport) {
        await cloud.signOut();
        showCloudAuthError("Sign-in was canceled. The local data on this device was left unchanged.");
        return false;
      }
      await cloud.importDeviceData(localMigrationSnapshot);
      store = await cloud.loadStore();
    }

    applyCloudStore(store);
    cloudUser = session.user;
    setCloudStatus("Online · shared data synced", false);
    setCloudAuthVisible(false);
    renderWorkspace();
    startCloudRefreshTimer();
    return true;
  }

  async function handleCloudLogin(event) {
    event.preventDefault();
    elements.cloudAuthError.hidden = true;
    if (!elements.cloudAuthForm.reportValidity()) return;
    elements.cloudSigninButton.disabled = true;
    elements.cloudSigninButton.textContent = "Signing in…";
    try {
      const session = await cloud.signIn(
        elements.cloudAuthEmail.value.trim(),
        elements.cloudAuthPassword.value
      );
      await openCloudWorkspace(session);
    } catch (error) {
      showCloudAuthError(error instanceof Error ? error.message : "Could not sign in to the shared store.");
    } finally {
      elements.cloudSigninButton.disabled = false;
      elements.cloudSigninButton.textContent = "Sign in";
    }
  }

  async function handleCloudLogout() {
    let logoutError = null;
    try {
      await cloud.signOut();
    } catch (error) {
      logoutError = error;
    } finally {
      cloudUser = null;
      cloudReadOnly = false;
      [STORAGE_KEYS.products, STORAGE_KEYS.customers, STORAGE_KEYS.sales,
        STORAGE_KEYS.collections, STORAGE_KEYS.expenses, STORAGE_KEYS.settings]
        .forEach(key => localStorage.removeItem(key));
      elements.cloudAuthForm.reset();
      setCloudAuthVisible(true);
      setCloudStatus("", false);
      elements.cloudAuthError.hidden = !logoutError;
      if (logoutError) {
        showCloudAuthError(`Signed out on this device, but the server sign-out request failed: ${logoutError.message}`);
      }
    }
  }

  async function refreshCloudWorkspace() {
    const store = await loadCloudStore();
    cloudUser = cloud.getSession() && cloud.getSession().user;
    setCloudStatus("Online · shared data synced", false);
    renderWorkspace();
    return store;
  }

  function startCloudRefreshTimer() {
    if (cloudRefreshTimer) return;
    cloudRefreshTimer = window.setInterval(async () => {
      if (!cloudUser || !navigator.onLine || cloudReadOnly) return;
      try {
        await refreshCloudWorkspace();
      } catch (error) {
        setCloudStatus(`Sync failed: ${error instanceof Error ? error.message : "Could not refresh shared data."}`, true);
      }
    }, 60000);
  }

  function handleOffline() {
    if (!cloudMode || !cloudUser) return;
    setCloudStatus("Offline · cached data is read-only", true);
  }

  async function handleOnline() {
    if (!cloudMode || !cloudUser) return;
    try {
      await refreshCloudWorkspace();
      startCloudRefreshTimer();
    } catch (error) {
      setCloudStatus(`Could not sync: ${error instanceof Error ? error.message : "Shared store unavailable."}`, true);
    }
  }

  function ensureWriteAccess(errorElement) {
    if (!cloudMode || (!cloudReadOnly && navigator.onLine)) return true;
    if (errorElement) {
      errorElement.textContent = "Shared data is read-only while offline. Reconnect before saving changes.";
      errorElement.hidden = false;
    }
    return false;
  }

  function cacheCloudRecord(storageKey, record, matchField) {
    const records = readArray(storageKey);
    const field = matchField || "id";
    const index = records.findIndex(item => item[field] === record[field]);
    if (index === -1) records.push(record);
    else records[index] = record;
    localStorage.setItem(storageKey, JSON.stringify(records));
  }

  async function refreshAfterCloudWrite(label) {
    try {
      await refreshCloudWorkspace();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not refresh shared data.";
      setCloudStatus(`${label} saved, but shared data could not refresh: ${detail}`, true);
    }
  }

  function normalizeExpense(expense) {
    if (!expense || typeof expense !== "object" || Array.isArray(expense)) {
      throw new Error("An expense record is not an object.");
    }
    const normalized = {
      id: String(expense.id || "").trim(),
      date: String(expense.date || "").slice(0, 10),
      category: String(expense.category || ""),
      description: String(expense.description || "").trim(),
      amount: Number(expense.amount),
      paymentSource: String(expense.paymentSource || expense.payment || "Cash"),
      createdAt: String(expense.createdAt || "")
    };
    if (!normalized.id || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.date) ||
      !normalized.description || !EXPENSE_CATEGORIES.includes(normalized.category) ||
      !PAYMENT_SOURCES.includes(normalized.paymentSource)) {
      throw new Error("An expense record is missing valid required details.");
    }
    if (!Number.isFinite(normalized.amount) || normalized.amount <= 0) {
      throw new Error(`Expense "${normalized.id}" has an invalid amount.`);
    }
    return normalized;
  }

  function readExpenses() {
    return readArray(STORAGE_KEYS.expenses).map(normalizeExpense);
  }

  function initializeProductDatabase() {
    if (localStorage.getItem(STORAGE_KEYS.products) === null) {
      saveProducts(STARTER_PRODUCTS);
    }
  }

  function amount(value) {
    if (value === null || value === undefined || value === "") return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function saleDate(sale) {
    const value = sale.date || sale.createdAt || "";
    return String(value).slice(0, 10);
  }

  function lineItems(sale) {
    return Array.isArray(sale.items) ? sale.items : [];
  }

  function itemTotal(item) {
    const quantity = amount(item.quantity);
    const price = amount(item.price ?? item.sellingPrice);
    return amount(item.total) || quantity * price;
  }

  function saleTotal(sale) {
    if (sale.total !== undefined) return amount(sale.total);
    return lineItems(sale).reduce((sum, item) => sum + itemTotal(item), 0);
  }

  function saleCost(sale) {
    return lineItems(sale).reduce((sum, item) => {
      const quantity = amount(item.quantity);
      const cost = amount(item.cost ?? item.unitCost);
      return sum + quantity * cost;
    }, 0);
  }

  function isPayment(sale, payment) {
    return String(sale.payment || "").toLowerCase() === payment.toLowerCase();
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function showError(message) {
    elements.dataError.textContent = `Dashboard data could not be loaded: ${message}`;
    elements.dataError.hidden = false;
  }

  function renderDashboard() {
    elements.dataError.hidden = true;
    try {
      const products = readArray(STORAGE_KEYS.products);
      const sales = readArray(STORAGE_KEYS.sales);
      const expenses = readArray(STORAGE_KEYS.expenses);
      const customers = readArray(STORAGE_KEYS.customers);
      const collections = readArray(STORAGE_KEYS.collections);
      const settings = readObject(STORAGE_KEYS.settings);

      const todaysSales = sales.filter(sale => saleDate(sale) === today);
      const todaysExpenses = expenses.filter(expense => String(expense.date || "").slice(0, 10) === today);
      const salesAmount = todaysSales.reduce((sum, sale) => sum + saleTotal(sale), 0);
      const grossProfit = todaysSales.reduce((sum, sale) => sum + saleTotal(sale) - saleCost(sale), 0);
      const expenseAmount = todaysExpenses.reduce((sum, expense) => sum + amount(expense.amount), 0);
      const cashSales = todaysSales.filter(sale => isPayment(sale, "cash")).reduce((sum, sale) => sum + saleTotal(sale), 0);
      const cashExpenses = todaysExpenses.filter(expense => String(expense.paymentSource || expense.payment || "").toLowerCase() === "cash")
        .reduce((sum, expense) => sum + amount(expense.amount), 0);
      const cashCollections = collections
        .filter(collection => String(collection.date || "").slice(0, 10) === today &&
          String(collection.paymentSource || "Cash").toLowerCase() === "cash")
        .reduce((sum, collection) => sum + amount(collection.amount), 0);
      const openingCash = amount(settings.openingCash);
      const inventoryValue = products.reduce((sum, product) => sum + amount(product.stock) * amount(product.cost), 0);
      const creditSales = todaysSales.filter(sale => isPayment(sale, "credit")).reduce((sum, sale) => sum + saleTotal(sale), 0);
      const collectionsTotal = collections.reduce((sum, collection) => sum + amount(collection.amount), 0);
      const customerBalances = customers.reduce((sum, customer) => sum + amount(customer.balance), 0);
      const creditBalance = sales.filter(sale => isPayment(sale, "credit")).reduce((sum, sale) => sum + saleTotal(sale), 0) - collectionsTotal;
      const hasCustomerBalances = customers.some(customer => customer.balance !== undefined);
      const receivables = hasCustomerBalances ? customerBalances : Math.max(0, creditBalance);
      const expectedCash = openingCash + cashSales + cashCollections - cashExpenses;
      const hasUnknownStock = products.some(product => product.stock === null || product.stock === undefined);

      setText("sales-today", peso.format(salesAmount));
      setText("sales-count", `${todaysSales.length} ${todaysSales.length === 1 ? "transaction" : "transactions"}`);
      setText("gross-profit", peso.format(grossProfit));
      setText("expenses-today", peso.format(expenseAmount));
      setText("net-profit", peso.format(grossProfit - expenseAmount));
      setText("inventory-value", hasUnknownStock ? "—" : peso.format(inventoryValue));
      setText("inventory-value-caption", hasUnknownStock ? "Enter stock for full valuation" : "At recorded product cost");
      setText("cash-on-hand", peso.format(expectedCash));
      setText("credit-sales", peso.format(creditSales));
      setText("receivables", peso.format(receivables));
      setText("opening-cash", peso.format(openingCash));
      setText("cash-sales", `+ ${peso.format(cashSales)}`);
      setText("cash-collections", `+ ${peso.format(cashCollections)}`);
      setText("cash-expenses", `− ${peso.format(cashExpenses)}`);
      setText("expected-cash", peso.format(expectedCash));
      renderSales(todaysSales);
      renderTopProducts(todaysSales);
      renderLowStock(products);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Unexpected local storage error.");
    }
  }

  function renderSales(sales) {
    const body = elements.salesTableBody;
    body.replaceChildren();
    elements.salesEmpty.hidden = sales.length > 0;
    sales.slice().reverse().slice(0, 6).forEach(sale => {
      const row = document.createElement("tr");
      appendCell(row, sale.invoice || "—");
      appendCell(row, sale.customer || "Walk-In");
      const paymentCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `payment-badge payment-${String(sale.payment || "cash").toLowerCase()}`;
      badge.textContent = sale.payment || "Cash";
      paymentCell.append(badge);
      row.append(paymentCell);
      appendCell(row, peso.format(saleTotal(sale)), "align-right");
      body.append(row);
    });
  }

  function appendCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    row.append(cell);
  }

  function renderTopProducts(sales) {
    const totals = new Map();
    sales.forEach(sale => lineItems(sale).forEach(item => {
      const name = item.name || item.productName || item.productId || "Product";
      const entry = totals.get(name) || { quantity: 0, amount: 0 };
      entry.quantity += amount(item.quantity);
      entry.amount += itemTotal(item);
      totals.set(name, entry);
    }));
    const products = Array.from(totals.entries())
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);
    elements.topProducts.replaceChildren();
    elements.productsEmpty.hidden = products.length > 0;
    products.forEach((product, index) => {
      const row = document.createElement("div");
      row.className = "product-row";
      const rank = document.createElement("span");
      rank.className = "product-rank";
      rank.textContent = String(index + 1).padStart(2, "0");
      const detail = document.createElement("span");
      detail.className = "product-detail";
      const name = document.createElement("strong");
      name.textContent = product.name;
      const quantity = document.createElement("small");
      quantity.textContent = `${product.quantity} sold`;
      detail.append(name, quantity);
      const total = document.createElement("strong");
      total.className = "product-amount";
      total.textContent = peso.format(product.amount);
      row.append(rank, detail, total);
      elements.topProducts.append(row);
    });
  }

  function renderLowStock(products) {
    const lowStock = products.filter(product => {
      return product.stock !== null && product.stock !== undefined &&
        product.minimum !== null && product.minimum !== undefined &&
        amount(product.stock) <= amount(product.minimum);
    }).sort((a, b) => amount(a.stock) - amount(b.stock));
    setText("low-stock-count", String(lowStock.length));
    elements.lowStockList.replaceChildren();
    const hasUnknownLevels = products.some(product =>
      product.stock === null || product.stock === undefined ||
      product.minimum === null || product.minimum === undefined
    );
    elements.stockEmpty.hidden = lowStock.length > 0;
    if (lowStock.length === 0) {
      setText("stock-empty", hasUnknownLevels
        ? "Enter current and minimum stock to show alerts."
        : "No low-stock products to show.");
    }
    lowStock.slice(0, 5).forEach(product => {
      const row = document.createElement("div");
      row.className = "stock-row";
      const detail = document.createElement("span");
      detail.className = "stock-detail";
      const name = document.createElement("strong");
      name.textContent = product.name || product.id || "Product";
      const id = document.createElement("small");
      id.textContent = product.unit ? `${product.id} · ${product.unit}` : product.id || "Inventory item";
      detail.append(name, id);
      const quantity = document.createElement("span");
      quantity.className = `stock-level${amount(product.stock) === 0 ? " stock-critical" : ""}`;
      quantity.textContent = `${amount(product.stock)} left`;
      row.append(detail, quantity);
      elements.lowStockList.append(row);
    });
  }

  function renderCatalog(searchTerm) {
    const results = elements.productResults;
    results.replaceChildren();
    elements.catalogError.hidden = true;
    try {
      const query = searchTerm.trim().toLocaleLowerCase();
      const allProducts = readProducts();
      const products = allProducts.filter(product =>
        product.name.toLocaleLowerCase().includes(query) || product.id.toLocaleLowerCase().includes(query)
      );
      setText("catalog-count", query
        ? `${products.length} ${products.length === 1 ? "result" : "results"}`
        : `${products.length} ${products.length === 1 ? "product" : "products"}`);
      elements.catalogEmpty.hidden = products.length > 0;
      setText("catalog-empty-title", query ? "No matching products" : "Product catalog is empty");
      setText("catalog-empty-message", query ? "Try another product name or ID." : "Add products from Inventory to start a sale.");
      products.forEach(product => {
        const card = document.createElement("article");
        card.className = "catalog-product";
        const details = document.createElement("div");
        details.className = "catalog-product-details";
        const name = document.createElement("strong");
        name.textContent = product.name;
        const id = document.createElement("small");
        id.textContent = `${product.id} · ${product.unit}`;
        details.append(name, id);

        const price = document.createElement("strong");
        price.className = "catalog-product-price";
        price.textContent = peso.format(product.price);

        const stock = document.createElement("span");
        stock.className = `catalog-product-stock${product.stock === 0 ? " stock-critical" : ""}`;
        stock.textContent = product.stock === null
          ? "Stock not entered"
          : product.stock === 0
            ? "Out of stock"
            : `${quantityFormat.format(product.stock)} in stock`;

        const addButton = document.createElement("button");
        addButton.className = "button button-secondary catalog-add-button";
        addButton.type = "button";
        addButton.dataset.productId = product.id;
        addButton.setAttribute("aria-label", `Add ${product.name} to cart`);
        addButton.textContent = "Add item";
        card.append(details, price, stock, addButton);
        results.append(card);
      });
    } catch (error) {
      setText("catalog-count", "Unavailable");
      elements.catalogEmpty.hidden = true;
      elements.catalogError.textContent = `Products could not be loaded: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
      elements.catalogError.hidden = false;
    }
  }

  function quantityStep(unit) {
    return unit === "KG" ? 0.1 : 1;
  }

  function quantityMinimum(unit) {
    return unit === "KG" ? 0.001 : 1;
  }

  function roundQuantity(quantity) {
    return Math.round((quantity + Number.EPSILON) * 1000) / 1000;
  }

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function getCartTotal() {
    return roundMoney(cart.reduce((sum, item) => sum + roundMoney(item.unitPrice * item.quantity), 0));
  }

  function addProductToCart(productId) {
    try {
      const product = readProducts().find(item => item.id === productId);
      if (!product) throw new Error("This product is no longer in the catalog.");
      const existing = cart.find(item => item.productId === product.id);
      if (existing) {
        existing.quantity = roundQuantity(existing.quantity + 1);
      } else {
        cart.push({
          productId: product.id,
          name: product.name,
          unit: product.unit,
          unitPrice: product.price,
          unitCost: product.cost,
          quantity: 1
        });
      }
      renderCart();
      showCartMessage(`${product.name} added to cart.`);
    } catch (error) {
      showCartMessage(error instanceof Error ? error.message : "Product could not be added.", true);
    }
  }

  function renderCart() {
    const cartItems = elements.cartItems;
    cartItems.replaceChildren();
    elements.cartEmpty.hidden = cart.length > 0;
    setText("cart-count", String(cart.length));
    setText("cart-line-count", String(cart.length));
    elements.clearCartButton.disabled = cart.length === 0;
    const subtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    setText("cart-subtotal", peso.format(subtotal));
    setText("cart-total", peso.format(getCartTotal()));
    renderPaymentOptions();
    updateCheckoutState();

    cart.forEach(item => {
      const row = document.createElement("article");
      row.className = "cart-item";
      const header = document.createElement("div");
      header.className = "cart-item-header";
      const details = document.createElement("div");
      details.className = "cart-item-details";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const meta = document.createElement("small");
      meta.textContent = `${item.productId} · ${peso.format(item.unitPrice)} / ${item.unit}`;
      details.append(name, meta);

      const remove = document.createElement("button");
      remove.className = "cart-remove-button";
      remove.type = "button";
      remove.dataset.cartAction = "remove";
      remove.dataset.productId = item.productId;
      remove.setAttribute("aria-label", `Remove ${item.name} from cart`);
      remove.textContent = "×";
      header.append(details, remove);

      const footer = document.createElement("div");
      footer.className = "cart-item-footer";
      const quantityControl = document.createElement("div");
      quantityControl.className = "quantity-control";
      const step = quantityStep(item.unit);
      const minimum = quantityMinimum(item.unit);

      const decrease = document.createElement("button");
      decrease.className = "quantity-button";
      decrease.type = "button";
      decrease.dataset.cartAction = "decrease";
      decrease.dataset.productId = item.productId;
      decrease.setAttribute("aria-label", `Decrease ${item.name} quantity`);
      decrease.disabled = item.quantity <= minimum;
      decrease.textContent = "−";

      const quantityInput = document.createElement("input");
      quantityInput.className = "cart-quantity-input";
      quantityInput.type = "number";
      quantityInput.min = String(minimum);
      quantityInput.step = item.unit === "KG" ? "0.001" : "1";
      quantityInput.value = String(item.quantity);
      quantityInput.dataset.productId = item.productId;
      quantityInput.setAttribute("aria-label", `${item.name} quantity`);
      quantityInput.inputMode = item.unit === "KG" ? "decimal" : "numeric";

      const increase = document.createElement("button");
      increase.className = "quantity-button";
      increase.type = "button";
      increase.dataset.cartAction = "increase";
      increase.dataset.productId = item.productId;
      increase.setAttribute("aria-label", `Increase ${item.name} quantity`);
      increase.textContent = "+";
      quantityControl.append(decrease, quantityInput, increase);

      const lineTotal = document.createElement("strong");
      lineTotal.className = "cart-line-total";
      lineTotal.textContent = peso.format(item.unitPrice * item.quantity);
      footer.append(quantityControl, lineTotal);
      row.append(header, footer);
      cartItems.append(row);
    });
  }

  function renderPaymentOptions() {
    document.querySelectorAll(".payment-option[data-payment]").forEach(button => {
      const selected = button.dataset.payment === selectedPayment;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function updateCheckoutState() {
    const creditSelected = selectedPayment === "Credit";
    const cashSelected = selectedPayment === "Cash";
    const hasCustomer = Boolean(selectedCustomerId);
    const writeUnavailable = cloudMode && (cloudReadOnly || !navigator.onLine);
    const tenderText = elements.cashReceivedInput.value.trim();
    const tender = tenderText === "" ? NaN : Number(tenderText);
    const validTender = Number.isFinite(tender) && tender >= 0 && elements.cashReceivedInput.checkValidity();
    const total = getCartTotal();
    const shortfall = validTender ? roundMoney(total - tender) : 0;
    const underpaid = validTender && shortfall > 0;
    const invalidTender = cashSelected && tenderText !== "" && !validTender;
    const changeText = !cashSelected || cart.length === 0 || !validTender
      ? invalidTender ? "Enter a valid amount" : "—"
      : underpaid
        ? `Short ${peso.format(shortfall)}`
        : peso.format(roundMoney(tender - total));
    elements.cashTenderField.hidden = !cashSelected || cart.length === 0;
    elements.cashChange.classList.toggle("is-short", underpaid || invalidTender);
    elements.cashChange.textContent = changeText;
    elements.cashReceivedInput.setAttribute("aria-invalid", String(invalidTender || underpaid));
    elements.completeSaleButton.disabled = writeUnavailable || cart.length === 0 ||
      (creditSelected && !hasCustomer) || (cashSelected && (!validTender || underpaid));
    elements.creditCustomerField.hidden = !creditSelected;
    elements.paymentHint.hidden = !creditSelected;
    if (creditSelected) {
      if (elements.creditCustomerSelect.options.length <= 1) {
        elements.paymentHint.textContent = "Add a customer before recording a credit sale.";
      } else if (hasCustomer) {
        const selectedOption = elements.creditCustomerSelect.selectedOptions[0];
        elements.paymentHint.textContent = `This sale will be added to ${selectedOption.textContent}'s balance.`;
      } else {
        elements.paymentHint.textContent = "Select the customer responsible for this balance.";
      }
    }
    elements.completeSaleButton.title = writeUnavailable
      ? "Reconnect to the internet to save to the shared store."
      : creditSelected
      ? hasCustomer ? "" : "Select a customer to enable credit checkout."
      : cart.length === 0
        ? "Add a product to enable checkout."
        : "";
  }

  function showCartMessage(message, isError) {
    elements.cartMessage.textContent = message;
    elements.cartMessage.classList.toggle("is-error", Boolean(isError));
    elements.cartMessage.hidden = false;
  }

  function handleCatalogClick(event) {
    const button = event.target.closest(".catalog-add-button");
    if (button && !button.disabled) addProductToCart(button.dataset.productId);
  }

  function handleCartClick(event) {
    const button = event.target.closest("[data-cart-action]");
    if (!button) return;
    const item = cart.find(entry => entry.productId === button.dataset.productId);
    if (!item) return;

    if (button.dataset.cartAction === "remove") {
      cart = cart.filter(entry => entry.productId !== item.productId);
      if (cart.length === 0) {
        selectedPayment = "Cash";
        elements.cashReceivedInput.value = "";
        selectedCustomerId = "";
      }
      renderCart();
      showCartMessage(`${item.name} removed from cart.`);
      return;
    }

    const step = quantityStep(item.unit);
    const minimum = quantityMinimum(item.unit);
    if (button.dataset.cartAction === "increase") {
      item.quantity = roundQuantity(item.quantity + step);
    } else if (button.dataset.cartAction === "decrease") {
      item.quantity = roundQuantity(Math.max(minimum, item.quantity - step));
    }
    renderCart();
    showCartMessage(`${item.name} quantity updated.`);
  }

  function handleCartQuantityChange(event) {
    const input = event.target.closest(".cart-quantity-input");
    if (!input) return;
    const item = cart.find(entry => entry.productId === input.dataset.productId);
    if (!item) return;
    const quantity = Number(input.value);
    if (!input.value || !input.checkValidity() || !Number.isFinite(quantity) || quantity <= 0) {
      showCartMessage(`Enter a valid quantity for ${item.name}.`, true);
      input.value = String(item.quantity);
      return;
    }
    item.quantity = roundQuantity(quantity);
    renderCart();
    showCartMessage(`${item.name} quantity updated.`);
  }

  function handlePaymentSelection(event) {
    const button = event.target.closest(".payment-option[data-payment]");
    if (!button) return;
    selectedPayment = button.dataset.payment;
    if (selectedPayment !== "Credit") selectedCustomerId = "";
    if (selectedPayment !== "Cash") {
      elements.cashReceivedInput.value = "";
    }
    renderPaymentOptions();
    updateCheckoutState();
    showCartMessage(`${selectedPayment} selected.`);
  }

  function handleCustomerSelection() {
    selectedCustomerId = elements.creditCustomerSelect.value;
    updateCheckoutState();
    if (selectedCustomerId) {
      const option = elements.creditCustomerSelect.selectedOptions[0];
      if (option) showCartMessage(`${option.textContent} selected for this credit sale.`);
    }
  }

  function clearCart() {
    if (cart.length === 0) return;
    cart = [];
    selectedPayment = "Cash";
    elements.cashReceivedInput.value = "";
    selectedCustomerId = "";
    renderCart();
    showCartMessage("Cart cleared.");
  }

  function nextInvoiceNumber(sales) {
    const usedInvoices = new Set(sales.map(sale => String(sale.invoice || "")));
    const highestNumber = sales.reduce((highest, sale) => {
      const match = /^INV(\d+)$/.exec(String(sale.invoice || ""));
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    let sequence = highestNumber + 1;
    let invoice = `INV${String(sequence).padStart(4, "0")}`;
    while (usedInvoices.has(invoice)) {
      sequence += 1;
      invoice = `INV${String(sequence).padStart(4, "0")}`;
    }
    return invoice;
  }

  function saveLocalTransaction(updates) {
    const saved = [];
    try {
      updates.forEach(update => {
        localStorage.setItem(update.key, update.value);
        saved.push(update);
      });
    } catch (error) {
      const rollbackFailures = [];
      saved.reverse().forEach(update => {
        try {
          if (update.previous === null) localStorage.removeItem(update.key);
          else localStorage.setItem(update.key, update.previous);
        } catch (rollbackError) {
          const message = rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
          rollbackFailures.push(`${update.label} (${message})`);
        }
      });
      if (rollbackFailures.length) {
        const saveMessage = error instanceof Error ? error.message : "unknown storage error";
        throw new Error(`Transaction save failed (${saveMessage}), and rollback failed for ${rollbackFailures.join(", ")}. Check those records before retrying.`);
      }
      throw error;
    }
  }

  function saveSaleTransaction(sales, products, previousSales, previousProducts, customers, previousCustomers) {
    const updates = [
      { key: STORAGE_KEYS.sales, value: JSON.stringify(sales), previous: previousSales, label: "sales" },
      { key: STORAGE_KEYS.products, value: JSON.stringify(products), previous: previousProducts, label: "inventory" }
    ];
    if (customers) {
      updates.push({
        key: STORAGE_KEYS.customers,
        value: JSON.stringify(customers),
        previous: previousCustomers,
        label: "customer balances"
      });
    }
    saveLocalTransaction(updates);
  }

  async function completeSale() {
    if (cart.length === 0) {
      showCartMessage("Add at least one product before completing a sale.", true);
      return;
    }
    if (selectedPayment === "Credit" && !selectedCustomerId) {
      showCartMessage("Select a customer before completing a credit sale.", true);
      return;
    }
    const cashReceivedAmount = selectedPayment === "Cash" ? Number(elements.cashReceivedInput.value) : null;
    if (selectedPayment === "Cash" && (
      !elements.cashReceivedInput.value.trim() ||
      !elements.cashReceivedInput.checkValidity() ||
      !Number.isFinite(cashReceivedAmount) ||
      cashReceivedAmount < 0 ||
      roundMoney(cashReceivedAmount) < getCartTotal()
    )) {
      updateCheckoutState();
      showCartMessage("Enter the amount received. It must cover the sale total.", true);
      return;
    }
    if (!ensureWriteAccess(elements.cartMessage)) return;

    let sale;
    let syncWarning = "";
    try {
      if (cloudMode) {
        sale = await cloud.recordSale(cart, selectedPayment, selectedCustomerId, getLocalDateKey(new Date()));
        try {
          await refreshCloudWorkspace();
        } catch (error) {
          syncWarning = error instanceof Error ? error.message : "Could not refresh shared data.";
          setCloudStatus(`Sale ${sale.invoice} saved, but shared data needs refresh: ${syncWarning}`, true);
        }
      } else {
        const previousSales = localStorage.getItem(STORAGE_KEYS.sales);
        const previousProducts = localStorage.getItem(STORAGE_KEYS.products);
        const previousCustomers = selectedPayment === "Credit"
          ? localStorage.getItem(STORAGE_KEYS.customers)
          : null;
        const sales = readArray(STORAGE_KEYS.sales);
        const products = readProducts();
        const customers = selectedPayment === "Credit" ? readCustomers() : null;
        const customer = customers
          ? customers.find(item => item.id === selectedCustomerId)
          : null;
        if (selectedPayment === "Credit" && !customer) {
          showCartMessage("That customer account is no longer available. Select a customer again.", true);
          return;
        }
        const productsById = new Map(products.map(product => [product.id, product]));
        const productsWithInsufficientStock = [];
        const missingProducts = [];

        cart.forEach(item => {
          const product = productsById.get(item.productId);
          if (!product) {
            missingProducts.push(`${item.name} (${item.productId})`);
          } else if (product.stock !== null && product.stock + 1e-9 < item.quantity) {
            productsWithInsufficientStock.push(
              `${product.name}: ${quantityFormat.format(product.stock)} ${product.unit} available, ${quantityFormat.format(item.quantity)} requested`
            );
          }
        });

        const stockMessages = [];
        if (missingProducts.length) {
          stockMessages.push(`These products are no longer in Inventory: ${missingProducts.join(", ")}.`);
        }
        if (productsWithInsufficientStock.length) {
          stockMessages.push(`Insufficient stock: ${productsWithInsufficientStock.join("; ")}.`);
        }
        if (stockMessages.length) {
          showCartMessage(`Sale blocked. ${stockMessages.join(" ")}`, true);
          return;
        }

        const soldQuantities = new Map(cart.map(item => [item.productId, item.quantity]));
        const updatedProducts = products.map(product => {
          const quantitySold = soldQuantities.get(product.id);
          if (quantitySold === undefined || product.stock === null) return product;
          return {
            ...product,
            stock: Math.max(0, roundQuantity(product.stock - quantitySold))
          };
        });
        const items = cart.map(item => ({
          productId: item.productId,
          name: item.name,
          unit: item.unit,
          quantity: item.quantity,
          price: item.unitPrice,
          cost: item.unitCost,
          total: roundMoney(item.unitPrice * item.quantity),
          stockDeducted: productsById.get(item.productId).stock !== null
        }));
        const total = roundMoney(items.reduce((sum, item) => sum + item.total, 0));
        const totalCost = cart.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);
        sale = {
          date: getLocalDateKey(new Date()),
          createdAt: new Date().toISOString(),
          invoice: nextInvoiceNumber(sales),
          customer: customer ? customer.name : "Walk-In",
          payment: selectedPayment,
          items,
          total,
          grossProfit: roundMoney(total - totalCost)
        };
        if (customer) sale.customerId = customer.id;
        sales.push(sale);
        const updatedCustomers = customer
          ? customers.map(item => item.id === customer.id
            ? { ...item, balance: roundMoney(item.balance + total) }
            : item)
          : null;
        saveSaleTransaction(
          sales,
          updatedProducts,
          previousSales,
          previousProducts,
          updatedCustomers,
          previousCustomers
        );
      }
    } catch (error) {
      showCartMessage(`Checkout failed: ${error instanceof Error ? error.message : "Unexpected local storage error."}`, true);
      return;
    }

    cart = [];
    selectedPayment = "Cash";
    elements.cashReceivedInput.value = "";
    selectedCustomerId = "";
    elements.productSearch.value = "";
    renderCart();
    renderInventory();
    renderCustomers();
    renderCatalog("");
    renderDashboard();
    setText("completed-invoice", sale.invoice);
    setText("completed-payment", sale.payment);
    setText("completed-total", peso.format(sale.total));
    const cashSale = sale.payment === "Cash";
    elements.completedCashRow.hidden = !cashSale;
    elements.completedChangeRow.hidden = !cashSale;
    if (cashSale) {
      setText("completed-cash", peso.format(cashReceivedAmount));
      setText("completed-change", peso.format(roundMoney(cashReceivedAmount - sale.total)));
    }
    const untrackedProductCount = sale.items.filter(item => !item.stockDeducted).length;
    const completionMessage = untrackedProductCount
      ? `Sale saved. Stock was not deducted for ${untrackedProductCount} untracked ${untrackedProductCount === 1 ? "product" : "products"}. Enter the physical quantity on hand when you count them.`
      : "Sale saved. Tracked stock quantities were deducted automatically.";
    setText("sale-complete-subtitle", syncWarning
      ? `${completionMessage} Refresh shared data before recording another sale.`
      : completionMessage);
    elements.completedCustomerRow.hidden = sale.payment !== "Credit";
    setText("completed-customer", sale.customer);
    try {
      elements.saleCompleteDialog.showModal();
    } catch (error) {
      showCartMessage(`Sale ${sale.invoice} was saved, but the confirmation could not be opened.`, true);
    }
  }

  function renderInventory() {
    const body = elements.inventoryTableBody;
    body.replaceChildren();
    elements.productError.hidden = true;
    try {
      const products = readProducts();
      setText("inventory-count", `${products.length} ${products.length === 1 ? "product" : "products"}`);
      elements.inventoryEmpty.hidden = products.length > 0;
      products.forEach(product => {
        const row = document.createElement("tr");
        const productCell = document.createElement("td");
        const productName = document.createElement("strong");
        productName.className = "inventory-product-name";
        productName.textContent = product.name;
        const productId = document.createElement("small");
        productId.className = "inventory-product-id";
        productId.textContent = product.id;
        productCell.append(productName, productId);
        row.append(productCell);
        appendCell(row, product.unit);
        appendCell(row, peso.format(product.price), "align-right");
        appendCell(row, peso.format(product.cost), "align-right");
        appendCell(row, product.stock === null ? "Not set" : quantityFormat.format(product.stock), "align-right");
        appendCell(row, product.minimum === null ? "Not set" : quantityFormat.format(product.minimum), "align-right");
        const actionCell = document.createElement("td");
        actionCell.className = "align-right";
        const editButton = document.createElement("button");
        editButton.className = "table-action edit-product";
        editButton.type = "button";
        editButton.dataset.productId = product.id;
        editButton.textContent = "Edit";
        actionCell.append(editButton);
        row.append(actionCell);
        body.append(row);
      });
    } catch (error) {
      elements.inventoryEmpty.hidden = true;
      elements.productError.textContent = `Product database could not be loaded: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
      elements.productError.hidden = false;
      setText("inventory-count", "Catalog unavailable");
    }
  }

  function renderCreditCustomerOptions(customers) {
    if (!customers.some(customer => customer.id === selectedCustomerId)) selectedCustomerId = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a customer";
    elements.creditCustomerSelect.replaceChildren(placeholder);
    customers.forEach(customer => {
      const option = document.createElement("option");
      option.value = customer.id;
      option.textContent = customer.name;
      elements.creditCustomerSelect.append(option);
    });
    elements.creditCustomerSelect.value = selectedCustomerId;
    updateCheckoutState();
  }

  function renderCustomers() {
    const body = elements.customerTableBody;
    body.replaceChildren();
    elements.customerError.hidden = true;
    try {
      const customers = readCustomers();
      setText("customer-count", `${customers.length} ${customers.length === 1 ? "customer" : "customers"}`);
      elements.customerEmpty.hidden = customers.length > 0;
      customers.forEach(customer => {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        const name = document.createElement("strong");
        name.className = "inventory-product-name";
        name.textContent = customer.name;
        const id = document.createElement("small");
        id.className = "inventory-product-id";
        id.textContent = customer.id;
        nameCell.append(name, id);
        row.append(nameCell);
        appendCell(row, peso.format(customer.balance), "align-right");
        const actionCell = document.createElement("td");
        actionCell.className = "customer-actions";
        const ledgerButton = document.createElement("button");
        ledgerButton.className = "table-action view-customer-ledger";
        ledgerButton.type = "button";
        ledgerButton.dataset.customerId = customer.id;
        ledgerButton.textContent = "View ledger";
        const collectionButton = document.createElement("button");
        collectionButton.className = "table-action record-customer-collection";
        collectionButton.type = "button";
        collectionButton.dataset.customerId = customer.id;
        collectionButton.textContent = "Collect";
        collectionButton.disabled = customer.balance <= 0;
        collectionButton.title = collectionButton.disabled ? "This customer has no outstanding balance." : "Record a payment";
        actionCell.append(ledgerButton, collectionButton);
        row.append(actionCell);
        body.append(row);
      });
      renderCreditCustomerOptions(customers);
      if (activeLedgerCustomerId) renderCustomerLedger(activeLedgerCustomerId);
    } catch (error) {
      elements.customerEmpty.hidden = true;
      elements.customerError.textContent = `Customer data could not be loaded: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
      elements.customerError.hidden = false;
      setText("customer-count", "Customer data unavailable");
      renderCreditCustomerOptions([]);
    }
  }

  function formatLedgerDate(value) {
    const dateKey = String(value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "—";
    const date = new Date(`${dateKey}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "—" : localDate.format(date);
  }

  function renderCustomerLedger(customerId) {
    try {
      const customer = readCustomers().find(item => item.id === customerId);
      if (!customer) throw new Error("This customer is no longer available.");
      activeLedgerCustomerId = customer.id;
      setText("customer-ledger-customer", customer.name);
      setText("customer-ledger-balance", `Balance ${peso.format(customer.balance)}`);
      const sales = readArray(STORAGE_KEYS.sales)
        .filter(sale => isPayment(sale, "Credit") && sale.customerId === customer.id)
        .map(sale => ({
          date: saleDate(sale),
          createdAt: String(sale.createdAt || ""),
          type: "Credit sale",
          reference: sale.invoice || "—",
          amount: saleTotal(sale),
          className: "ledger-sale"
        }));
      const collections = readArray(STORAGE_KEYS.collections)
        .filter(collection => collection.customerId === customer.id)
        .map(collection => ({
          date: String(collection.date || "").slice(0, 10),
          createdAt: String(collection.createdAt || ""),
          type: "Payment received",
          reference: collection.receipt || collection.invoice || collection.id || "—",
          amount: -amount(collection.amount),
          className: "ledger-payment"
        }));
      const entries = sales.concat(collections).sort((left, right) =>
        left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt)
      );
      const activityBalance = entries.reduce((sum, entry) => sum + entry.amount, 0);
      const openingBalance = roundMoney(customer.balance - activityBalance);
      if (openingBalance < -0.01) throw new Error(`The ledger for ${customer.name} does not match the saved balance.`);
      if (openingBalance > 0) {
        entries.unshift({
          date: "",
          createdAt: "",
          type: "Opening balance",
          reference: "—",
          amount: openingBalance,
          className: "ledger-opening"
        });
      }
      const body = elements.customerLedgerBody;
      body.replaceChildren();
      let balance = 0;
      entries.forEach(entry => {
        balance = roundMoney(balance + entry.amount);
        const row = document.createElement("tr");
        appendCell(row, formatLedgerDate(entry.date));
        const typeCell = document.createElement("td");
        typeCell.className = entry.className;
        typeCell.textContent = entry.type;
        row.append(typeCell);
        appendCell(row, entry.reference);
        const amountText = entry.amount < 0
          ? `− ${peso.format(Math.abs(entry.amount))}`
          : `+ ${peso.format(entry.amount)}`;
        appendCell(row, amountText, "align-right");
        appendCell(row, peso.format(balance), "align-right");
        body.append(row);
      });
      elements.customerLedgerEmpty.hidden = entries.length > 0;
      elements.customerLedgerEmpty.textContent = "No ledger transactions yet.";
      elements.customerLedgerTableWrap.hidden = entries.length === 0;
      elements.customerError.hidden = true;
    } catch (error) {
      activeLedgerCustomerId = "";
      elements.customerLedgerBody.replaceChildren();
      elements.customerLedgerTableWrap.hidden = true;
      elements.customerLedgerEmpty.hidden = false;
      elements.customerLedgerEmpty.textContent = "Customer ledger could not be loaded.";
      elements.customerError.textContent = error instanceof Error ? error.message : "Customer ledger could not be loaded.";
      elements.customerError.hidden = false;
    }
  }

  function handleCustomerTableClick(event) {
    const ledgerButton = event.target.closest(".view-customer-ledger");
    if (ledgerButton) {
      renderCustomerLedger(ledgerButton.dataset.customerId);
      return;
    }
    const collectionButton = event.target.closest(".record-customer-collection");
    if (collectionButton && !collectionButton.disabled) openCollectionDialog(collectionButton.dataset.customerId);
  }

  function openCollectionDialog(customerId) {
    try {
      const customer = readCustomers().find(item => item.id === customerId);
      if (!customer) throw new Error("This customer is no longer available.");
      if (customer.balance <= 0) throw new Error("This customer has no outstanding balance.");
      elements.collectionForm.reset();
      elements.collectionFormError.hidden = true;
      elements.collectionForm.elements.namedItem("customerId").value = customer.id;
      elements.collectionForm.elements.namedItem("date").value = getLocalDateKey(new Date());
      setText("collection-customer-label", `${customer.name} · Current balance ${peso.format(customer.balance)}`);
      elements.collectionDialog.showModal();
    } catch (error) {
      elements.customerError.textContent = error instanceof Error ? error.message : "Collection could not be opened.";
      elements.customerError.hidden = false;
    }
  }

  function nextCollectionId(collections) {
    const usedIds = new Set(collections.map(collection => String(collection.id || "")));
    const highestId = collections.reduce((highest, collection) => {
      const match = /^COL(\d+)$/.exec(String(collection.id || ""));
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    let sequence = highestId + 1;
    let id = `COL${String(sequence).padStart(4, "0")}`;
    while (usedIds.has(id)) {
      sequence += 1;
      id = `COL${String(sequence).padStart(4, "0")}`;
    }
    return id;
  }

  async function saveCollectionFromForm(event) {
    event.preventDefault();
    elements.collectionFormError.hidden = true;
    if (!elements.collectionForm.reportValidity()) return;
    if (!ensureWriteAccess(elements.collectionFormError)) return;
    let cloudSaved = false;
    try {
      const formData = new FormData(elements.collectionForm);
      const customerId = String(formData.get("customerId") || "");
      const collectionAmount = Number(formData.get("amount"));
      if (!Number.isFinite(collectionAmount) || collectionAmount <= 0) {
        throw new Error("Enter an amount greater than zero.");
      }
      const previousCustomers = localStorage.getItem(STORAGE_KEYS.customers);
      const previousCollections = localStorage.getItem(STORAGE_KEYS.collections);
      const customers = readCustomers();
      const customer = customers.find(item => item.id === customerId);
      if (!customer) throw new Error("This customer is no longer available.");
      if (collectionAmount > customer.balance + 1e-9) {
        throw new Error(`Payment exceeds ${customer.name}'s outstanding balance of ${peso.format(customer.balance)}.`);
      }
      const collections = readArray(STORAGE_KEYS.collections);
      const collection = {
        id: nextCollectionId(collections),
        date: String(formData.get("date") || ""),
        createdAt: new Date().toISOString(),
        customerId: customer.id,
        customer: customer.name,
        amount: roundMoney(collectionAmount),
        paymentSource: String(formData.get("paymentSource") || "Cash")
      };
      if (!collection.date) throw new Error("Choose the payment date.");
      if (cloudMode) {
        const result = await cloud.recordCollection(collection);
        cloudSaved = true;
        const updatedCustomer = normalizeCustomer(result.customer);
        cacheCloudRecord(STORAGE_KEYS.collections, result.collection);
        saveCustomers(customers.map(item => item.id === updatedCustomer.id ? updatedCustomer : item));
        activeLedgerCustomerId = customer.id;
        elements.collectionDialog.close();
        await refreshAfterCloudWrite("Collection");
        renderCustomers();
        renderDashboard();
        return;
      }

      collections.push(collection);
      const updatedCustomers = customers.map(item => item.id === customer.id
        ? { ...item, balance: Math.max(0, roundMoney(item.balance - collection.amount)) }
        : item);
      saveLocalTransaction([
        {
          key: STORAGE_KEYS.collections,
          value: JSON.stringify(collections),
          previous: previousCollections,
          label: "collections"
        },
        {
          key: STORAGE_KEYS.customers,
          value: JSON.stringify(updatedCustomers),
          previous: previousCustomers,
          label: "customer balances"
        }
      ]);
      activeLedgerCustomerId = customer.id;
      elements.collectionDialog.close();
      renderCustomers();
      renderDashboard();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected error.";
      elements.collectionFormError.textContent = cloudSaved
        ? `Collection saved to the shared store, but this device could not update its cache: ${detail}`
        : `Collection could not be saved: ${detail}`;
      elements.collectionFormError.hidden = false;
    }
  }

  function renderExpenses() {
    const body = elements.expenseTableBody;
    body.replaceChildren();
    elements.expenseDataError.hidden = true;
    try {
      const expenses = readExpenses();
      const todaysExpenses = expenses.filter(expense => expense.date === today);
      const monthExpenses = expenses.filter(expense => expense.date.slice(0, 7) === today.slice(0, 7));
      setText("expense-record-count", `${expenses.length} ${expenses.length === 1 ? "expense" : "expenses"}`);
      setText("expense-today-total", peso.format(todaysExpenses.reduce((sum, expense) => sum + expense.amount, 0)));
      setText("expense-today-count", `${todaysExpenses.length} ${todaysExpenses.length === 1 ? "record" : "records"}`);
      setText("expense-month-total", peso.format(monthExpenses.reduce((sum, expense) => sum + expense.amount, 0)));
      setText("expense-month-count", `${monthExpenses.length} ${monthExpenses.length === 1 ? "record" : "records"}`);
      elements.expenseEmpty.hidden = expenses.length > 0;
      expenses.slice().sort((left, right) =>
        right.date.localeCompare(left.date) || String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      ).forEach(expense => {
        const row = document.createElement("tr");
        appendCell(row, formatLedgerDate(expense.date));
        appendCell(row, expense.category);
        appendCell(row, expense.description);
        appendCell(row, expense.paymentSource);
        appendCell(row, peso.format(expense.amount), "align-right");
        body.append(row);
      });
    } catch (error) {
      elements.expenseEmpty.hidden = true;
      elements.expenseDataError.textContent = `Expense data could not be loaded: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
      elements.expenseDataError.hidden = false;
      setText("expense-record-count", "Expense data unavailable");
    }
  }

  function openExpenseDialog() {
    elements.expenseForm.reset();
    elements.expenseFormError.hidden = true;
    elements.expenseForm.elements.namedItem("date").value = getLocalDateKey(new Date());
    elements.expenseDialog.showModal();
  }

  function nextExpenseId(expenses) {
    const usedIds = new Set(expenses.map(expense => String(expense.id || "")));
    const highestId = expenses.reduce((highest, expense) => {
      const match = /^EXP(\d+)$/.exec(String(expense.id || ""));
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    let sequence = highestId + 1;
    let id = `EXP${String(sequence).padStart(4, "0")}`;
    while (usedIds.has(id)) {
      sequence += 1;
      id = `EXP${String(sequence).padStart(4, "0")}`;
    }
    return id;
  }

  async function saveExpenseFromForm(event) {
    event.preventDefault();
    elements.expenseFormError.hidden = true;
    if (!elements.expenseForm.reportValidity()) return;
    if (!ensureWriteAccess(elements.expenseFormError)) return;
    let cloudSaved = false;
    try {
      const formData = new FormData(elements.expenseForm);
      const expenses = readExpenses();
      const expense = normalizeExpense({
        id: cloudMode ? cloud.makeId("EXP-") : nextExpenseId(expenses),
        date: formData.get("date"),
        category: formData.get("category"),
        description: formData.get("description"),
        amount: formData.get("amount"),
        paymentSource: formData.get("paymentSource"),
        createdAt: new Date().toISOString()
      });
      if (cloudMode) {
        const savedExpense = await cloud.saveExpense(expense);
        cloudSaved = true;
        cacheCloudRecord(STORAGE_KEYS.expenses, savedExpense);
        elements.expenseDialog.close();
        await refreshAfterCloudWrite("Expense");
        renderExpenses();
        renderDashboard();
        return;
      }
      expenses.push(expense);
      localStorage.setItem(STORAGE_KEYS.expenses, JSON.stringify(expenses));
      elements.expenseDialog.close();
      renderExpenses();
      renderDashboard();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected error.";
      elements.expenseFormError.textContent = cloudSaved
        ? `Expense saved to the shared store, but this device could not update its cache: ${detail}`
        : `Expense could not be saved: ${detail}`;
      elements.expenseFormError.hidden = false;
    }
  }

  function renderReportSales(body, empty, sales) {
    body.replaceChildren();
    empty.hidden = sales.length > 0;
    sales.slice().sort((left, right) =>
      saleDate(right).localeCompare(saleDate(left)) ||
      String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    ).forEach(sale => {
      const row = document.createElement("tr");
      appendCell(row, sale.invoice || "—");
      appendCell(row, sale.customer || "Walk-In");
      appendCell(row, sale.payment || "Cash");
      appendCell(row, peso.format(saleTotal(sale)), "align-right");
      body.append(row);
    });
  }

  function renderReports() {
    elements.reportError.hidden = true;
    try {
      const reportDay = elements.reportDay.value || today;
      const reportMonth = elements.reportMonth.value || reportDay.slice(0, 7);
      const sales = readArray(STORAGE_KEYS.sales);
      const expenses = readExpenses();
      const customers = readCustomers();
      const products = readProducts();
      const dailySales = sales.filter(sale => saleDate(sale) === reportDay);
      const monthlySales = sales.filter(sale => saleDate(sale).slice(0, 7) === reportMonth);
      const dailyExpenses = expenses.filter(expense => expense.date === reportDay);
      const monthlyExpenses = expenses.filter(expense => expense.date.slice(0, 7) === reportMonth);
      const dailySalesTotal = dailySales.reduce((sum, sale) => sum + saleTotal(sale), 0);
      const dailyGrossProfit = dailySales.reduce((sum, sale) => sum + saleTotal(sale) - saleCost(sale), 0);
      const dailyExpenseTotal = dailyExpenses.reduce((sum, expense) => sum + expense.amount, 0);
      const monthlySalesTotal = monthlySales.reduce((sum, sale) => sum + saleTotal(sale), 0);
      const monthlyGrossProfit = monthlySales.reduce((sum, sale) => sum + saleTotal(sale) - saleCost(sale), 0);
      const monthlyExpenseTotal = monthlyExpenses.reduce((sum, expense) => sum + expense.amount, 0);
      setText("report-daily-sales", peso.format(dailySalesTotal));
      setText("report-daily-count", `${dailySales.length} ${dailySales.length === 1 ? "transaction" : "transactions"}`);
      setText("report-daily-gross", peso.format(dailyGrossProfit));
      setText("report-daily-expenses", peso.format(dailyExpenseTotal));
      setText("report-daily-net", peso.format(dailyGrossProfit - dailyExpenseTotal));
      setText("report-monthly-sales", peso.format(monthlySalesTotal));
      setText("report-monthly-count", `${monthlySales.length} ${monthlySales.length === 1 ? "transaction" : "transactions"}`);
      setText("report-monthly-gross", peso.format(monthlyGrossProfit));
      setText("report-monthly-expenses", peso.format(monthlyExpenseTotal));
      setText("report-monthly-net", peso.format(monthlyGrossProfit - monthlyExpenseTotal));
      renderReportSales(elements.reportDailySalesBody, elements.reportDailySalesEmpty, dailySales);
      renderReportSales(elements.reportMonthlySalesBody, elements.reportMonthlySalesEmpty, monthlySales);

      const topProducts = new Map();
      monthlySales.forEach(sale => lineItems(sale).forEach(item => {
        const key = String(item.productId || item.name || "Unknown");
        const current = topProducts.get(key) || {
          name: String(item.name || key),
          quantity: 0,
          sales: 0
        };
        current.quantity += amount(item.quantity);
        current.sales += itemTotal(item);
        topProducts.set(key, current);
      }));
      const productsBody = elements.reportProductsBody;
      productsBody.replaceChildren();
      const topProductRows = Array.from(topProducts.values()).sort((left, right) => right.quantity - left.quantity);
      elements.reportProductsEmpty.hidden = topProductRows.length > 0;
      topProductRows.slice(0, 10).forEach(product => {
        const row = document.createElement("tr");
        appendCell(row, product.name);
        appendCell(row, quantityFormat.format(product.quantity), "align-right");
        appendCell(row, peso.format(product.sales), "align-right");
        productsBody.append(row);
      });

      const receivablesBody = elements.reportReceivablesBody;
      receivablesBody.replaceChildren();
      const owingCustomers = customers.filter(customer => customer.balance > 0)
        .sort((left, right) => right.balance - left.balance);
      elements.reportReceivablesEmpty.hidden = owingCustomers.length > 0;
      owingCustomers.forEach(customer => {
        const row = document.createElement("tr");
        appendCell(row, customer.name);
        appendCell(row, peso.format(customer.balance), "align-right");
        receivablesBody.append(row);
      });
      setText("report-receivables-total", peso.format(
        customers.reduce((sum, customer) => sum + customer.balance, 0)
      ));

      const inventoryBody = elements.reportInventoryBody;
      inventoryBody.replaceChildren();
      const hasUnknownStock = products.some(product => product.stock === null);
      const inventoryValue = products.reduce((sum, product) =>
        sum + (product.stock === null ? 0 : product.stock * product.cost), 0
      );
      setText("report-inventory-value", hasUnknownStock
        ? `Inventory value — (${products.filter(product => product.stock === null).length} stock counts missing)`
        : `Inventory value ${peso.format(inventoryValue)}`);
      elements.reportInventoryEmpty.hidden = products.length > 0;
      products.slice().sort((left, right) => left.name.localeCompare(right.name)).forEach(product => {
        const row = document.createElement("tr");
        appendCell(row, product.name);
        appendCell(row, product.unit);
        appendCell(row, product.stock === null ? "Not set" : quantityFormat.format(product.stock), "align-right");
        appendCell(row, product.minimum === null ? "Not set" : quantityFormat.format(product.minimum), "align-right");
        let status = "Minimum not set";
        let statusClass = "status-untracked";
        if (product.stock === null) {
          status = "Stock not set";
        } else if (product.stock === 0 || (product.minimum !== null && product.stock <= product.minimum * 0.25)) {
          status = "Critical";
          statusClass = "status-critical";
        } else if (product.minimum !== null && product.stock <= product.minimum) {
          status = "Reorder soon";
          statusClass = "status-reorder";
        } else if (product.minimum !== null) {
          status = "Good";
          statusClass = "status-good";
        }
        const statusCell = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `report-stock-status ${statusClass}`;
        badge.textContent = status;
        statusCell.append(badge);
        row.append(statusCell);
        appendCell(row, product.stock === null ? "—" : peso.format(product.stock * product.cost), "align-right");
        inventoryBody.append(row);
      });
    } catch (error) {
      elements.reportError.textContent = `Reports could not be loaded: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
      elements.reportError.hidden = false;
    }
  }

  function openCustomerDialog() {
    elements.customerForm.reset();
    elements.customerFormError.hidden = true;
    elements.customerDialog.showModal();
  }

  function nextCustomerId(customers) {
    const ids = new Set(customers.map(customer => customer.id));
    const highestId = customers.reduce((highest, customer) => {
      const match = /^C(\d+)$/.exec(customer.id);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    let sequence = highestId + 1;
    let id = `C${String(sequence).padStart(4, "0")}`;
    while (ids.has(id)) {
      sequence += 1;
      id = `C${String(sequence).padStart(4, "0")}`;
    }
    return id;
  }

  async function saveCustomerFromForm(event) {
    event.preventDefault();
    elements.customerFormError.hidden = true;
    if (!elements.customerForm.reportValidity()) return;
    if (!ensureWriteAccess(elements.customerFormError)) return;
    let cloudSaved = false;
    try {
      const name = String(new FormData(elements.customerForm).get("name") || "").trim();
      if (!name) throw new Error("Enter a customer name.");
      const customers = readCustomers();
      if (customers.some(customer => customer.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(`Customer "${name}" already exists.`);
      }
      if (cloudMode) {
        const savedCustomer = await cloud.createCustomer(name);
        cloudSaved = true;
        cacheCloudRecord(STORAGE_KEYS.customers, normalizeCustomer(savedCustomer));
        elements.customerDialog.close();
        await refreshAfterCloudWrite("Customer");
        renderCustomers();
        renderDashboard();
        return;
      }
      customers.push(normalizeCustomer({ id: nextCustomerId(customers), name, balance: 0 }));
      saveCustomers(customers);
      elements.customerDialog.close();
      renderCustomers();
      renderDashboard();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected error.";
      elements.customerFormError.textContent = cloudSaved
        ? `Customer saved to the shared store, but this device could not update its cache: ${detail}`
        : `Customer could not be saved: ${detail}`;
      elements.customerFormError.hidden = false;
    }
  }

  function openProductDialog(product) {
    const form = elements.productForm;
    form.reset();
    elements.productFormError.hidden = true;
    elements.productDialog.dataset.editingId = product ? product.id : "";
    setText("product-dialog-title", product ? "Edit product" : "Add product");
    if (product) {
      Object.keys(product).forEach(key => { form.elements.namedItem(key).value = product[key]; });
    }
    elements.productDialog.showModal();
  }

  async function saveProductFromForm(event) {
    event.preventDefault();
    elements.productFormError.hidden = true;
    const form = elements.productForm;
    if (!form.reportValidity()) return;
    if (!ensureWriteAccess(elements.productFormError)) return;
    let cloudSaved = false;

    try {
      const formData = new FormData(form);
      const product = normalizeProduct({
        id: formData.get("id"),
        name: formData.get("name"),
        unit: formData.get("unit"),
        price: formData.get("price"),
        cost: formData.get("cost"),
        stock: formData.get("stock") || null,
        minimum: formData.get("minimum") || null
      });
      const products = readProducts();
      const editingId = elements.productDialog.dataset.editingId;
      const duplicate = products.some(existing =>
        existing.id.toLocaleLowerCase() === product.id.toLocaleLowerCase() &&
        existing.id.toLocaleLowerCase() !== editingId.toLocaleLowerCase()
      );
      if (duplicate) throw new Error(`Product ID "${product.id}" is already in use.`);

      const updatedProducts = editingId
        ? products.map(existing => existing.id === editingId ? product : existing)
        : products.concat(product);
      if (cloudMode) {
        const savedProduct = await cloud.saveProduct(product);
        cloudSaved = true;
        const normalizedSavedProduct = normalizeProduct(savedProduct);
        saveProducts(editingId
          ? updatedProducts.map(item => item.id === normalizedSavedProduct.id ? normalizedSavedProduct : item)
          : updatedProducts.map(item => item.id === normalizedSavedProduct.id ? normalizedSavedProduct : item));
        elements.productDialog.close();
        await refreshAfterCloudWrite("Product");
        renderInventory();
        renderCatalog(elements.productSearch.value);
        renderDashboard();
        return;
      }
      saveProducts(updatedProducts);
      elements.productDialog.close();
      renderInventory();
      renderCatalog(elements.productSearch.value);
      renderDashboard();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected error.";
      elements.productFormError.textContent = cloudSaved
        ? `Product saved to the shared store, but this device could not update its cache: ${detail}`
        : `Product could not be saved: ${detail}`;
      elements.productFormError.hidden = false;
    }
  }

  function handleInventoryAction(event) {
    const button = event.target.closest(".edit-product");
    if (!button) return;
    try {
      const product = readProducts().find(item => item.id === button.dataset.productId);
      if (!product) throw new Error("This product no longer exists. Refresh the catalog and try again.");
      openProductDialog(product);
    } catch (error) {
      elements.productError.textContent = error instanceof Error ? error.message : "Product could not be opened.";
      elements.productError.hidden = false;
    }
  }

  function setView(view) {
    const dashboard = view === "dashboard" || !NAV_LABELS[view];
    const pos = view === "pos";
    const inventory = view === "inventory";
    const customers = view === "customers";
    const expenses = view === "expenses";
    const reports = view === "reports";
    document.querySelectorAll(".nav-link[data-view]").forEach(link => {
      const active = dashboard ? link.dataset.view === "dashboard" : link.dataset.view === view;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    elements.dashboardView.hidden = !dashboard;
    elements.dashboardView.classList.toggle("is-visible", dashboard);
    elements.posView.hidden = !pos;
    elements.posView.classList.toggle("is-visible", pos);
    elements.inventoryView.hidden = !inventory;
    elements.inventoryView.classList.toggle("is-visible", inventory);
    elements.customersView.hidden = !customers;
    elements.customersView.classList.toggle("is-visible", customers);
    elements.expensesView.hidden = !expenses;
    elements.expensesView.classList.toggle("is-visible", expenses);
    elements.reportsView.hidden = !reports;
    elements.reportsView.classList.toggle("is-visible", reports);
    elements.placeholderView.hidden = dashboard || pos || inventory || customers || expenses || reports;
    elements.placeholderView.classList.toggle("is-visible", !dashboard && !pos && !inventory && !customers && !expenses && !reports);
    if (dashboard) {
      setText("page-title", "Dashboard");
      document.title = "Dashboard | RL StoreOS";
    } else if (pos) {
      setText("page-title", NAV_LABELS[view]);
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
      renderCatalog(elements.productSearch.value);
      renderCart();
    } else if (inventory) {
      setText("page-title", NAV_LABELS[view]);
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
      renderInventory();
    } else if (customers) {
      setText("page-title", NAV_LABELS[view]);
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
      renderCustomers();
    } else if (expenses) {
      setText("page-title", NAV_LABELS[view]);
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
      renderExpenses();
    } else if (reports) {
      setText("page-title", NAV_LABELS[view]);
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
      renderReports();
    } else {
      setText("page-title", NAV_LABELS[view]);
      setText("placeholder-title", NAV_LABELS[view]);
      setText("placeholder-message", `${NAV_LABELS[view]} will be built in a later step. Your dashboard is ready to preview.`);
      const selectedLink = document.querySelector(`.nav-link[data-view="${view}"]`);
      setText("placeholder-symbol", selectedLink ? selectedLink.querySelector(".nav-icon").textContent : "▣");
      document.title = `${NAV_LABELS[view]} | RL StoreOS`;
    }
    closeSidebar();
  }

  function openSidebar() {
    document.body.classList.add("sidebar-open");
    elements.menuToggle.setAttribute("aria-expanded", "true");
    elements.menuToggle.setAttribute("aria-label", "Close navigation");
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    elements.menuToggle.setAttribute("aria-expanded", "false");
    elements.menuToggle.setAttribute("aria-label", "Open navigation");
  }

  function registerServiceWorker() {
    const status = document.getElementById("pwa-status");
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (!window.isSecureContext || (location.protocol !== "https:" && !localHost)) {
      status.textContent = "Install/offline needs HTTPS or localhost.";
      return;
    }
    if (!("serviceWorker" in navigator)) {
      status.textContent = "Offline support is unavailable in this browser.";
      return;
    }
    navigator.serviceWorker.register("./service-worker.js")
      .then(() => {
        status.textContent = "Offline ready · install from the browser menu.";
      })
      .catch(error => {
        status.textContent = `Offline setup failed: ${error instanceof Error ? error.message : "Unknown service worker error."}`;
        console.error("RL StoreOS service worker registration failed.", error);
      });
  }

  async function init() {
    [
      "data-error", "sales-today", "sales-count", "gross-profit", "expenses-today", "net-profit",
      "inventory-value", "cash-on-hand", "credit-sales", "receivables", "opening-cash",
      "cash-sales", "cash-collections", "cash-expenses", "expected-cash", "sales-table-body", "sales-empty",
      "top-products", "products-empty", "low-stock-list", "low-stock-count", "stock-empty",
      "dashboard", "placeholder", "menu-toggle", "sidebar-scrim", "page-title",
      "placeholder-title", "placeholder-message", "placeholder-symbol"
    ].forEach(id => {
      const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      elements[key] = document.getElementById(id);
    });
    elements.dashboardView = document.getElementById("view-dashboard");
    elements.posView = document.getElementById("view-pos");
    elements.inventoryView = document.getElementById("view-inventory");
    elements.customersView = document.getElementById("view-customers");
    elements.expensesView = document.getElementById("view-expenses");
    elements.reportsView = document.getElementById("view-reports");
    elements.placeholderView = document.getElementById("view-placeholder");
    elements.salesTableBody = document.getElementById("sales-table-body");
    elements.salesEmpty = document.getElementById("sales-empty");
    elements.topProducts = document.getElementById("top-products");
    elements.productsEmpty = document.getElementById("products-empty");
    elements.lowStockList = document.getElementById("low-stock-list");
    elements.stockEmpty = document.getElementById("stock-empty");
    elements.dataError = document.getElementById("data-error");
    elements.menuToggle = document.getElementById("menu-toggle");
    elements.placeholderView = document.getElementById("view-placeholder");
    elements.productResults = document.getElementById("product-results");
    elements.catalogEmpty = document.getElementById("catalog-empty");
    elements.catalogError = document.getElementById("catalog-error");
    elements.productSearch = document.getElementById("product-search");
    elements.inventoryTableBody = document.getElementById("inventory-table-body");
    elements.inventoryEmpty = document.getElementById("inventory-empty");
    elements.productError = document.getElementById("product-error");
    elements.productDialog = document.getElementById("product-dialog");
    elements.productForm = document.getElementById("product-form");
    elements.productFormError = document.getElementById("product-form-error");
    elements.cartItems = document.getElementById("cart-items");
    elements.cartEmpty = document.getElementById("cart-empty");
    elements.clearCartButton = document.getElementById("clear-cart-button");
    elements.cartMessage = document.getElementById("cart-message");
    elements.completeSaleButton = document.getElementById("complete-sale-button");
    elements.paymentHint = document.getElementById("payment-hint");
    elements.cashTenderField = document.getElementById("cash-tender-field");
    elements.cashReceivedInput = document.getElementById("cash-received-input");
    elements.cashChange = document.getElementById("cash-change");
    elements.saleCompleteDialog = document.getElementById("sale-complete-dialog");
    elements.newSaleButton = document.getElementById("new-sale-button");
    elements.creditCustomerField = document.getElementById("credit-customer-field");
    elements.creditCustomerSelect = document.getElementById("credit-customer-select");
    elements.customerError = document.getElementById("customer-error");
    elements.customerTableBody = document.getElementById("customer-table-body");
    elements.customerEmpty = document.getElementById("customer-empty");
    elements.customerLedgerCustomer = document.getElementById("customer-ledger-customer");
    elements.customerLedgerBalance = document.getElementById("customer-ledger-balance");
    elements.customerLedgerEmpty = document.getElementById("customer-ledger-empty");
    elements.customerLedgerTableWrap = document.getElementById("customer-ledger-table-wrap");
    elements.customerLedgerBody = document.getElementById("customer-ledger-body");
    elements.customerDialog = document.getElementById("customer-dialog");
    elements.customerForm = document.getElementById("customer-form");
    elements.customerFormError = document.getElementById("customer-form-error");
    elements.collectionDialog = document.getElementById("collection-dialog");
    elements.collectionForm = document.getElementById("collection-form");
    elements.collectionFormError = document.getElementById("collection-form-error");
    elements.expenseTableBody = document.getElementById("expense-table-body");
    elements.expenseEmpty = document.getElementById("expense-empty");
    elements.expenseDataError = document.getElementById("expense-data-error");
    elements.expenseDialog = document.getElementById("expense-dialog");
    elements.expenseForm = document.getElementById("expense-form");
    elements.expenseFormError = document.getElementById("expense-form-error");
    elements.reportError = document.getElementById("report-error");
    elements.reportDay = document.getElementById("report-day");
    elements.reportMonth = document.getElementById("report-month");
    elements.reportDailySalesBody = document.getElementById("report-daily-sales-body");
    elements.reportDailySalesEmpty = document.getElementById("report-daily-sales-empty");
    elements.reportMonthlySalesBody = document.getElementById("report-monthly-sales-body");
    elements.reportMonthlySalesEmpty = document.getElementById("report-monthly-sales-empty");
    elements.reportProductsBody = document.getElementById("report-products-body");
    elements.reportProductsEmpty = document.getElementById("report-products-empty");
    elements.reportReceivablesBody = document.getElementById("report-receivables-body");
    elements.reportReceivablesEmpty = document.getElementById("report-receivables-empty");
    elements.reportInventoryBody = document.getElementById("report-inventory-body");
    elements.reportInventoryEmpty = document.getElementById("report-inventory-empty");
    elements.completedCustomerRow = document.getElementById("completed-customer-row");
    elements.completedCashRow = document.getElementById("completed-cash-row");
    elements.completedChangeRow = document.getElementById("completed-change-row");
    elements.cloudAuthForm = document.getElementById("cloud-auth-form");
    elements.cloudAuthScreen = document.getElementById("cloud-auth-screen");
    elements.cloudAuthError = document.getElementById("cloud-auth-error");
    elements.cloudAuthEmail = document.getElementById("cloud-auth-email");
    elements.cloudAuthPassword = document.getElementById("cloud-auth-password");
    elements.cloudSigninButton = document.getElementById("cloud-signin-button");
    elements.workspaceModeLabel = document.getElementById("workspace-mode-label");
    elements.workspaceModeDetail = document.getElementById("workspace-mode-detail");
    elements.cloudSignoutButton = document.getElementById("cloud-signout-button");
    elements.cloudUserEmail = document.getElementById("cloud-user-email");
    elements.cloudSyncStatus = document.getElementById("cloud-sync-status");
    elements.appShell = document.getElementById("app-shell");
    if (cloudMode) setCloudAuthVisible(true);

    const todayText = localDate.format(new Date());
    document.getElementById("today-label").textContent = todayText;
    document.getElementById("sales-date").textContent = todayText;
    document.getElementById("refresh-button").addEventListener("click", async () => {
      if (!cloudMode || !cloudUser) {
        renderDashboard();
        return;
      }
      try {
        await refreshCloudWorkspace();
      } catch (error) {
        setCloudStatus(`Refresh failed: ${error instanceof Error ? error.message : "Could not refresh shared data."}`, true);
      }
    });
    elements.productSearch.addEventListener("input", () => renderCatalog(elements.productSearch.value));
    document.getElementById("add-product-button").addEventListener("click", () => openProductDialog());
    document.getElementById("add-first-product-button").addEventListener("click", () => openProductDialog());
    document.getElementById("close-product-dialog").addEventListener("click", () => elements.productDialog.close());
    document.getElementById("cancel-product-button").addEventListener("click", () => elements.productDialog.close());
    elements.productForm.addEventListener("submit", saveProductFromForm);
    elements.inventoryTableBody.addEventListener("click", handleInventoryAction);
    document.getElementById("add-customer-button").addEventListener("click", openCustomerDialog);
    document.getElementById("close-customer-dialog").addEventListener("click", () => elements.customerDialog.close());
    document.getElementById("cancel-customer-button").addEventListener("click", () => elements.customerDialog.close());
    elements.customerForm.addEventListener("submit", saveCustomerFromForm);
    elements.customerTableBody.addEventListener("click", handleCustomerTableClick);
    document.getElementById("close-collection-dialog").addEventListener("click", () => elements.collectionDialog.close());
    document.getElementById("cancel-collection-button").addEventListener("click", () => elements.collectionDialog.close());
    elements.collectionForm.addEventListener("submit", saveCollectionFromForm);
    document.getElementById("add-expense-button").addEventListener("click", openExpenseDialog);
    document.getElementById("close-expense-dialog").addEventListener("click", () => elements.expenseDialog.close());
    document.getElementById("cancel-expense-button").addEventListener("click", () => elements.expenseDialog.close());
    elements.expenseForm.addEventListener("submit", saveExpenseFromForm);
    elements.reportDay.value = today;
    elements.reportMonth.value = today.slice(0, 7);
    elements.reportDay.addEventListener("change", renderReports);
    elements.reportMonth.addEventListener("change", renderReports);
    elements.productResults.addEventListener("click", handleCatalogClick);
    elements.cartItems.addEventListener("click", handleCartClick);
    elements.cartItems.addEventListener("change", handleCartQuantityChange);
    document.querySelector(".payment-options").addEventListener("click", handlePaymentSelection);
    elements.cashReceivedInput.addEventListener("input", () => {
      updateCheckoutState();
    });
    elements.clearCartButton.addEventListener("click", clearCart);
    elements.completeSaleButton.addEventListener("click", completeSale);
    elements.creditCustomerSelect.addEventListener("change", handleCustomerSelection);
    elements.newSaleButton.addEventListener("click", () => elements.saleCompleteDialog.close());
    elements.saleCompleteDialog.addEventListener("close", () => elements.productSearch.focus());
    elements.menuToggle.addEventListener("click", () => {
      if (document.body.classList.contains("sidebar-open")) closeSidebar();
      else openSidebar();
    });
    elements.sidebarScrim.addEventListener("click", closeSidebar);
    document.addEventListener("click", event => {
      const link = event.target.closest("[data-view]");
      if (link) {
        event.preventDefault();
        const view = link.dataset.view;
        if (location.hash !== `#${view}`) location.hash = view;
        else setView(view);
      }
    });
    window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "dashboard"));
    window.addEventListener("storage", () => {
      renderDashboard();
      renderInventory();
      renderCustomers();
      renderExpenses();
      renderReports();
      renderCatalog(elements.productSearch.value);
    });
    if (cloudMode) {
      elements.cloudAuthForm.addEventListener("submit", handleCloudLogin);
      elements.cloudSignoutButton.addEventListener("click", handleCloudLogout);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      try {
        localMigrationSnapshot = captureLocalStore();
      } catch (error) {
        localMigrationError = error instanceof Error ? error.message : "Could not read local data.";
      }
      const savedSession = cloud.getSession();
      if (savedSession) {
        try {
          const restoredSession = await cloud.restoreSession();
          if (restoredSession) await openCloudWorkspace(restoredSession);
          else setCloudAuthVisible(true);
        } catch (error) {
          try {
            if (localStorage.getItem(STORAGE_KEYS.products) === null) throw error;
            await openCloudWorkspace(savedSession);
          } catch (fallbackError) {
            setCloudAuthVisible(true);
            showCloudAuthError(`Could not restore the shared-store session: ${fallbackError instanceof Error ? fallbackError.message : "Sign in again."}`);
          }
        }
      } else {
        setCloudAuthVisible(true);
      }
    } else {
      try {
        initializeProductDatabase();
      } catch (error) {
        elements.productError.textContent = `Product database could not be initialized: ${error instanceof Error ? error.message : "Unexpected local storage error."}`;
        elements.productError.hidden = false;
      }
      setCloudStatus("", false);
      renderWorkspace();
    }
    registerServiceWorker();
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch(error => {
      console.error("RL StoreOS could not initialize.", error);
      const authError = document.getElementById("cloud-auth-error");
      if (authError) {
        authError.textContent = `The app could not start: ${error instanceof Error ? error.message : "Unexpected initialization error."}`;
        authError.hidden = false;
      }
    });
  });
})();