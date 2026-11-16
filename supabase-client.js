(() => {
  "use strict";

  const config = window.RLStoreSupabaseConfig || {};
  const baseUrl = String(config.url || "").trim().replace(/\/+$/, "");
  const anonKey = String(config.anonKey || "").trim();
  const sessionKey = "rlstoreos.cloud-session";
  let session = loadSession();

  function isConfigured() {
    return Boolean(baseUrl && anonKey);
  }

  function loadSession() {
    try {
      const saved = localStorage.getItem(sessionKey);
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      localStorage.removeItem(sessionKey);
      console.error("Could not read the saved RL StoreOS cloud session.", error);
      return null;
    }
  }

  function saveSession(value) {
    session = value;
    if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
    else localStorage.removeItem(sessionKey);
  }

  function makeId(prefix) {
    const suffix = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}${suffix}`;
  }

  async function responseData(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function request(path, options, canRefresh) {
    if (!isConfigured()) throw new Error("Shared cloud access is not configured yet.");
    if (!navigator.onLine) throw new Error("Connect to the internet to save shared store changes.");

    const settings = options || {};
    const headers = new Headers(settings.headers || {});
    headers.set("apikey", anonKey);
    headers.set("Authorization", `Bearer ${session ? session.access_token : anonKey}`);
    if (settings.body !== undefined) headers.set("Content-Type", "application/json");

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: settings.method || "GET",
        headers,
        body: settings.body === undefined ? undefined : JSON.stringify(settings.body)
      });
    } catch (error) {
      throw new Error(`Could not connect to the shared store: ${error instanceof Error ? error.message : "network request failed"}`);
    }

    const data = await responseData(response);
    if (response.status === 401 && canRefresh !== false && session && session.refresh_token) {
      await refreshSession();
      return request(path, options, false);
    }
    if (!response.ok) {
      const message = data && typeof data === "object"
        ? data.message || data.msg || data.error_description || data.error
        : data;
      throw new Error(String(message || `Shared store request failed (${response.status}).`));
    }
    return data;
  }

  async function authRequest(path, body) {
    if (!isConfigured()) throw new Error("Add the Supabase project URL and anon key to supabase-config.js first.");
    if (!navigator.onLine) throw new Error("Connect to the internet to sign in.");
    let response;
    try {
      response = await fetch(`${baseUrl}/auth/v1/${path}`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(`Could not reach Supabase: ${error instanceof Error ? error.message : "network request failed"}`);
    }
    const data = await responseData(response);
    if (!response.ok) {
      const message = data && typeof data === "object"
        ? data.msg || data.message || data.error_description || data.error
        : data;
      throw new Error(String(message || `Sign-in failed (${response.status}).`));
    }
    return data;
  }

  function toSession(payload) {
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: payload.expires_at || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
      user: payload.user || (session && session.user) || null
    };
  }

  async function signIn(email, password) {
    const payload = await authRequest("token?grant_type=password", { email, password });
    if (!payload.access_token || !payload.refresh_token) throw new Error("Supabase did not return a valid sign-in session.");
    saveSession(toSession(payload));
    return session;
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) throw new Error("Your session expired. Sign in again.");
    const payload = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    if (!payload.access_token || !payload.refresh_token) {
      saveSession(null);
      throw new Error("Your session expired. Sign in again.");
    }
    saveSession(toSession(payload));
    return session;
  }

  async function restoreSession() {
    if (!session || !session.access_token) return null;
    if (!navigator.onLine) return session;
    if (Number(session.expires_at) < Math.floor(Date.now() / 1000) + 60) await refreshSession();
    const user = await request("/auth/v1/user");
    session = { ...session, user };
    saveSession(session);
    return session;
  }

  async function signOut() {
    let requestError = null;
    if (session && navigator.onLine) {
      try {
        await request("/auth/v1/logout", { method: "POST" });
      } catch (error) {
        requestError = error;
      }
    }
    saveSession(null);
    if (requestError) throw requestError;
  }

  async function getAll(table, order) {
    const pageSize = 1000;
    const records = [];
    for (let offset = 0; ; offset += pageSize) {
      const end = offset + pageSize - 1;
      const page = await request(`/rest/v1/${table}?select=*&order=${order}`, {
        headers: { "Range-Unit": "items", Range: `${offset}-${end}` }
      });
      if (!Array.isArray(page)) throw new Error(`Supabase returned invalid data for ${table}.`);
      records.push(...page);
      if (page.length < pageSize) return records;
    }
  }

  function mapSale(row) {
    return {
      ...row,
      createdAt: row.created_at,
      customerId: row.customer_id || undefined,
      grossProfit: Number(row.gross_profit)
    };
  }

  function mapCollection(row) {
    return {
      ...row,
      createdAt: row.created_at,
      customerId: row.customer_id,
      paymentSource: row.payment_source
    };
  }

  function mapExpense(row) {
    return {
      ...row,
      createdAt: row.created_at,
      paymentSource: row.payment_source
    };
  }

  async function loadStore() {
    if (!session) throw new Error("Sign in to load shared store data.");
    const [products, customers, sales, collections, expenses, settings] = await Promise.all([
      getAll("products", "name.asc"),
      getAll("customers", "name.asc"),
      getAll("sales", "date.desc,created_at.desc"),
      getAll("collections", "date.desc,created_at.desc"),
      getAll("expenses", "date.desc,created_at.desc"),
      request("/rest/v1/store_settings?select=id,value")
    ]);
    if (!Array.isArray(settings)) throw new Error("Supabase returned invalid store settings.");
    const storeSettings = settings.find(item => item.id === "store");
    return {
      products,
      customers,
      sales: sales.map(mapSale),
      collections: collections.map(mapCollection),
      expenses: expenses.map(mapExpense),
      settings: storeSettings && storeSettings.value && typeof storeSettings.value === "object"
        ? storeSettings.value
        : {}
    };
  }

  async function saveProduct(product) {
    const rows = await request("/rest/v1/products?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: [{ ...product, updated_at: new Date().toISOString() }]
    });
    if (!Array.isArray(rows) || !rows[0]) throw new Error("Supabase did not confirm the product save.");
    return rows[0];
  }

  async function createCustomer(name) {
    const row = await request("/rest/v1/rpc/create_customer", {
      method: "POST",
      body: { p_name: name }
    });
    if (!row || !row.id) throw new Error("Supabase did not confirm the customer save.");
    return row;
  }

  async function recordSale(items, payment, customerId, date) {
    const row = await request("/rest/v1/rpc/record_sale", {
      method: "POST",
      body: {
        p_items: items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.unitPrice
        })),
        p_payment: payment,
        p_customer_id: customerId || null,
        p_date: date
      }
    });
    if (!row || !row.invoice) throw new Error("Supabase did not confirm the sale.");
    return mapSale(row);
  }

  async function recordCollection(collection) {
    const result = await request("/rest/v1/rpc/record_collection", {
      method: "POST",
      body: {
        p_customer_id: collection.customerId,
        p_date: collection.date,
        p_amount: collection.amount,
        p_payment_source: collection.paymentSource,
        p_receipt: collection.receipt || null
      }
    });
    if (!result || !result.collection || !result.collection.id || !result.customer) {
      throw new Error("Supabase did not confirm the collection and customer balance.");
    }
    return {
      collection: mapCollection(result.collection),
      customer: result.customer
    };
  }

  async function saveExpense(expense) {
    const rows = await request("/rest/v1/expenses", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: [{
        id: expense.id,
        date: expense.date,
        category: expense.category,
        description: expense.description,
        amount: expense.amount,
        payment_source: expense.paymentSource,
        created_at: expense.createdAt
      }]
    });
    if (!Array.isArray(rows) || !rows[0]) throw new Error("Supabase did not confirm the expense.");
    return mapExpense(rows[0]);
  }

  function toDatabaseState(snapshot) {
    const sales = snapshot.sales.map(sale => {
      const items = Array.isArray(sale.items) ? sale.items : [];
      const total = sale.total === undefined
        ? items.reduce((sum, item) => sum + Number(item.total || Number(item.quantity || 0) * Number(item.price || 0)), 0)
        : Number(sale.total);
      const cost = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.cost || item.unitCost || 0), 0);
      return {
        invoice: sale.invoice,
        date: String(sale.date || sale.createdAt || "").slice(0, 10),
        created_at: sale.createdAt || new Date().toISOString(),
        customer_id: sale.customerId || null,
        customer: sale.customer || "Walk-In",
        payment: sale.payment || "Cash",
        items,
        total,
        gross_profit: sale.grossProfit === undefined ? Math.round((total - cost) * 100) / 100 : Number(sale.grossProfit)
      };
    });
    return {
      p_products: snapshot.products,
      p_customers: snapshot.customers,
      p_sales: sales,
      p_collections: snapshot.collections.map(collection => ({
        id: collection.id,
        date: collection.date,
        created_at: collection.createdAt || new Date().toISOString(),
        customer_id: collection.customerId,
        customer: collection.customer,
        amount: collection.amount,
        payment_source: collection.paymentSource || collection.payment || "Cash",
        receipt: collection.receipt || null
      })),
      p_expenses: snapshot.expenses.map(expense => ({
        id: expense.id,
        date: expense.date,
        created_at: expense.createdAt || new Date().toISOString(),
        category: expense.category,
        description: expense.description,
        amount: expense.amount,
        payment_source: expense.paymentSource || expense.payment || "Cash"
      })),
      p_settings: snapshot.settings
    };
  }

  async function importDeviceData(snapshot) {
    await request("/rest/v1/rpc/import_device_data", {
      method: "POST",
      body: toDatabaseState(snapshot)
    });
  }

  async function saveSettings(settings) {
    await request("/rest/v1/store_settings?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: [{ id: "store", value: settings, updated_at: new Date().toISOString() }]
    });
  }

  window.RLStoreSupabase = Object.freeze({
    isConfigured,
    makeId,
    getSession: () => session,
    signIn,
    restoreSession,
    signOut,
    loadStore,
    saveProduct,
    createCustomer,
    recordSale,
    recordCollection,
    saveExpense,
    saveSettings,
    importDeviceData
  });
})();
