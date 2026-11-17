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

  function mapSaleVoid(row) {
    return {
      ...row,
      createdAt: row.created_at,
      receivableReduction: Number(row.receivable_reduction || 0),
      refundAmount: Number(row.refund_amount || 0),
      refundMethod: row.refund_method || ""
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

  function mapFundOpening(row) {
    return {
      effectiveDate: row.effective_date,
      cashBalance: Number(row.cash_balance),
      gcashBalance: Number(row.gcash_balance),
      revolvingBalance: Number(row.revolving_balance),
      savingsBalance: Number(row.savings_balance),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }

  function mapFundOpeningHistory(row) {
    return {
      id: row.id,
      effectiveDate: row.effective_date,
      previousBalances: row.previous_balances,
      newBalances: row.new_balances,
      reason: row.reason,
      changedAt: row.changed_at,
      changedBy: row.changed_by
    };
  }

  function mapFundTransaction(row) {
    return {
      id: row.id,
      reference: row.reference,
      date: row.transaction_date,
      type: row.transaction_type,
      fromAccount: row.from_account || "",
      toAccount: row.to_account || "",
      amount: Number(row.amount),
      description: row.description,
      relatedReference: row.related_reference || "",
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }

  function mapStockPurchase(row) {
    return {
      id: row.id,
      reference: row.reference,
      date: row.transaction_date,
      supplier: row.supplier,
      description: row.description,
      paymentAccount: row.payment_account,
      items: Array.isArray(row.items) ? row.items : [],
      total: Number(row.total),
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }

  function mapCashClosing(row) {
    return {
      date: row.closing_date,
      expectedCash: Number(row.expected_cash),
      actualCash: Number(row.actual_cash),
      difference: Number(row.difference),
      breakdown: row.breakdown || {},
      notes: row.notes || "",
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }

  function mapCashClosingHistory(row) {
    return {
      id: row.id,
      date: row.closing_date,
      previousRecord: row.previous_record,
      newRecord: row.new_record,
      changedAt: row.changed_at,
      changedBy: row.changed_by
    };
  }

  function mapGcashClosing(row) {
    return {
      date: row.closing_date,
      expectedGcash: Number(row.expected_balance),
      actualGcash: Number(row.actual_balance),
      difference: Number(row.difference),
      notes: row.notes || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function mapGcashClosingHistory(row) {
    return {
      id: row.id,
      date: row.closing_date,
      previousRecord: row.previous_record,
      newRecord: row.new_record,
      changedAt: row.changed_at
    };
  }

  async function loadFinanceStore() {
    const [openings, openingHistory, transactions, purchases, closings, closingHistory,
      gcashClosings, gcashClosingHistory] = await Promise.all([
      getAll("fund_openings", "id.asc"),
      getAll("fund_opening_history", "changed_at.desc"),
      getAll("fund_transactions", "transaction_date.desc,created_at.desc"),
      getAll("stock_purchases", "transaction_date.desc,created_at.desc"),
      getAll("daily_cash_closings", "closing_date.desc"),
      getAll("daily_cash_closing_history", "changed_at.desc"),
      getAll("daily_gcash_closings", "closing_date.desc"),
      getAll("daily_gcash_closing_history", "changed_at.desc")
    ]);
    return {
      enabled: true,
      opening: openings[0] ? mapFundOpening(openings[0]) : null,
      openingHistory: openingHistory.map(mapFundOpeningHistory),
      transactions: transactions.map(mapFundTransaction),
      purchases: purchases.map(mapStockPurchase),
      closings: closings.map(mapCashClosing),
      closingHistory: closingHistory.map(mapCashClosingHistory),
      gcashClosings: gcashClosings.map(mapGcashClosing),
      gcashClosingHistory: gcashClosingHistory.map(mapGcashClosingHistory)
    };
  }

  async function loadStore() {
    if (!session) throw new Error("Sign in to load shared store data.");
    const [products, customers, sales, voidsResult, collections, expenses, settings, financeResult] = await Promise.all([
      getAll("products", "name.asc"),
      getAll("customers", "name.asc"),
      getAll("sales", "date.desc,created_at.desc"),
      getAll("sale_voids", "date.desc,created_at.desc").then(rows => ({
        rows: rows.map(mapSaleVoid),
        enabled: true
      })).catch(error => {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("sale_voids") &&
          (message.includes("schema cache") || message.includes("does not exist") || message.includes("could not find"))) {
          return { rows: [], enabled: false };
        }
        throw error;
      }),
      getAll("collections", "date.desc,created_at.desc"),
      getAll("expenses", "date.desc,created_at.desc"),
      request("/rest/v1/store_settings?select=id,value"),
      loadFinanceStore().catch(error => {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (["fund_openings", "fund_opening_history", "fund_transactions", "stock_purchases",
          "daily_cash_closings", "daily_cash_closing_history", "daily_gcash_closings",
          "daily_gcash_closing_history"].some(table => message.includes(table)) &&
          (message.includes("schema cache") || message.includes("does not exist") || message.includes("could not find"))) {
          return {
            enabled: false, opening: null, openingHistory: [], transactions: [],
            purchases: [], closings: [], closingHistory: [],
            gcashClosings: [], gcashClosingHistory: []
          };
        }
        throw error;
      })
    ]);
    if (!Array.isArray(settings)) throw new Error("Supabase returned invalid store settings.");
    const storeSettings = settings.find(item => item.id === "store");
    return {
      products,
      customers,
      sales: sales.map(mapSale),
      saleVoids: voidsResult.rows,
      saleVoidsEnabled: voidsResult.enabled,
      collections: collections.map(mapCollection),
      expenses: expenses.map(mapExpense),
      financeEnabled: financeResult.enabled,
      fundOpening: financeResult.opening,
      fundOpeningHistory: financeResult.openingHistory,
      fundTransactions: financeResult.transactions,
      stockPurchases: financeResult.purchases,
      cashClosings: financeResult.closings,
      cashClosingHistory: financeResult.closingHistory,
      gcashClosings: financeResult.gcashClosings,
      gcashClosingHistory: financeResult.gcashClosingHistory,
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

  async function recordSaleVoid(record) {
    const row = await request("/rest/v1/rpc/record_sale_void", {
      method: "POST",
      body: {
        p_id: record.id,
        p_invoice: record.invoice,
        p_items: record.items.map(item => ({
          lineIndex: item.lineIndex,
          productId: item.productId,
          quantity: item.quantity
        })),
        p_reason: record.reason,
        p_refund_amount: record.refundAmount,
        p_refund_method: record.refundMethod || null,
        p_date: record.date
      }
    });
    if (!row || !row.id || !row.invoice) throw new Error("Supabase did not confirm the void and inventory return.");
    return mapSaleVoid(row);
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

  async function saveExpense(expense, enforceFundBalance) {
    if (enforceFundBalance) {
      const row = await request("/rest/v1/rpc/record_expense", {
        method: "POST",
        body: {
          p_id: expense.id,
          p_date: expense.date,
          p_category: expense.category,
          p_description: expense.description,
          p_amount: expense.amount,
          p_payment_source: expense.paymentSource
        }
      });
      if (!row || !row.id) throw new Error("Supabase did not confirm the expense.");
      return mapExpense(row);
    }
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

  async function setFundOpening(opening, reason) {
    const row = await request("/rest/v1/rpc/set_fund_opening", {
      method: "POST",
      body: {
        p_effective_date: opening.effectiveDate,
        p_cash_balance: opening.cashBalance,
        p_gcash_balance: opening.gcashBalance,
        p_revolving_balance: opening.revolvingBalance,
        p_savings_balance: opening.savingsBalance,
        p_reason: reason
      }
    });
    if (!row || !row.effective_date) throw new Error("Supabase did not confirm the opening balances.");
    const history = await getAll("fund_opening_history", "changed_at.desc");
    return {
      opening: mapFundOpening(row),
      history: history.map(mapFundOpeningHistory)
    };
  }

  async function recordFundTransaction(record) {
    const row = await request("/rest/v1/rpc/record_fund_transaction", {
      method: "POST",
      body: {
        p_id: record.id,
        p_reference: record.reference,
        p_date: record.date,
        p_type: record.type,
        p_from_account: record.fromAccount || null,
        p_to_account: record.toAccount || null,
        p_amount: record.amount,
        p_description: record.description
      }
    });
    if (!row || !row.id || !row.reference) throw new Error("Supabase did not confirm the fund transaction.");
    return mapFundTransaction(row);
  }

  async function recordStockPurchase(purchase) {
    const row = await request("/rest/v1/rpc/record_stock_purchase", {
      method: "POST",
      body: {
        p_id: purchase.id,
        p_reference: purchase.reference,
        p_date: purchase.date,
        p_supplier: purchase.supplier,
        p_description: purchase.description,
        p_payment_account: purchase.paymentAccount,
        p_items: purchase.items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost
        }))
      }
    });
    if (!row || !row.id || !row.reference) throw new Error("Supabase did not confirm the stock purchase.");
    return {
      purchase: mapStockPurchase(row),
      transaction: mapFundTransaction({
        id: row.id,
        reference: row.reference,
        transaction_date: row.transaction_date,
        transaction_type: "stock_purchase",
        from_account: row.payment_account,
        to_account: null,
        amount: row.total,
        description: row.description,
        related_reference: row.reference,
        created_at: row.created_at,
        created_by: row.created_by
      })
    };
  }

  async function saveDailyCashClosing(date, actualCash, notes) {
    const row = await request("/rest/v1/rpc/save_daily_cash_closing", {
      method: "POST",
      body: { p_date: date, p_actual_cash: actualCash, p_notes: notes }
    });
    if (!row || !row.closing_date) throw new Error("Supabase did not confirm the daily cash closing.");
    return mapCashClosing(row);
  }

  async function saveDailyGcashClosing(date, actualGcash, notes) {
    const row = await request("/rest/v1/rpc/save_daily_gcash_closing", {
      method: "POST",
      body: { p_date: date, p_actual_balance: actualGcash, p_notes: notes }
    });
    if (!row || !row.closing_date) throw new Error("Supabase did not confirm the GCash reconciliation.");
    return mapGcashClosing(row);
  }

  function toDatabaseState(snapshot, includeFinance) {
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
    const state = {
      p_products: snapshot.products,
      p_customers: snapshot.customers,
      p_sales: sales,
      p_sale_voids: (snapshot.saleVoids || []).map(saleVoid => ({
        id: saleVoid.id,
        invoice: saleVoid.invoice,
        date: saleVoid.date,
        created_at: saleVoid.createdAt || new Date().toISOString(),
        items: saleVoid.items,
        reason: saleVoid.reason,
        amount: saleVoid.amount,
        receivable_reduction: saleVoid.receivableReduction || 0,
        refund_amount: saleVoid.refundAmount || 0,
        refund_method: saleVoid.refundMethod || null
      })),
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
    if (!includeFinance) return state;

    const opening = snapshot.fundOpening;
    state.p_fund_opening = opening ? {
      effective_date: opening.effectiveDate || opening.effective_date,
      cash_balance: opening.cashBalance ?? opening.cash_balance,
      gcash_balance: opening.gcashBalance ?? opening.gcash_balance,
      revolving_balance: opening.revolvingBalance ?? opening.revolving_balance,
      savings_balance: opening.savingsBalance ?? opening.savings_balance,
      updated_at: opening.updatedAt || opening.updated_at
    } : null;
    state.p_fund_opening_history = (snapshot.fundOpeningHistory || []).map(record => ({
      effective_date: record.effectiveDate || record.effective_date,
      previous_balances: record.previousBalances || record.previous_balances || null,
      new_balances: record.newBalances || record.new_balances,
      reason: record.reason,
      changed_at: record.changedAt || record.changed_at
    }));
    state.p_fund_transactions = (snapshot.fundTransactions || []).map(record => ({
      id: record.id,
      reference: record.reference,
      transaction_date: record.date || record.transactionDate || record.transaction_date,
      transaction_type: record.type || record.transactionType || record.transaction_type,
      from_account: record.fromAccount || record.from_account || null,
      to_account: record.toAccount || record.to_account || null,
      amount: record.amount,
      description: record.description,
      related_reference: record.relatedReference || record.related_reference || null,
      created_at: record.createdAt || record.created_at
    }));
    state.p_stock_purchases = (snapshot.stockPurchases || []).map(record => ({
      id: record.id,
      reference: record.reference,
      transaction_date: record.date || record.transactionDate || record.transaction_date,
      supplier: record.supplier || "",
      description: record.description,
      payment_account: record.paymentAccount || record.payment_account,
      items: record.items || [],
      total: record.total,
      created_at: record.createdAt || record.created_at
    }));
    state.p_cash_closings = (snapshot.cashClosings || []).map(record => ({
      closing_date: record.date || record.closingDate || record.closing_date,
      expected_cash: record.expectedCash ?? record.expected_cash,
      actual_cash: record.actualCash ?? record.actual_cash,
      difference: record.difference,
      breakdown: record.breakdown || {},
      notes: record.notes || "",
      created_at: record.createdAt || record.created_at,
      updated_at: record.updatedAt || record.updated_at
    }));
    state.p_cash_closing_history = (snapshot.cashClosingHistory || []).map(record => ({
      closing_date: record.date || record.closingDate || record.closing_date,
      previous_record: record.previousRecord || record.previous_record || null,
      new_record: record.newRecord || record.new_record,
      changed_at: record.changedAt || record.changed_at
    }));
    state.p_gcash_closings = (snapshot.gcashClosings || []).map(record => ({
      closing_date: record.date || record.closingDate || record.closing_date,
      expected_balance: record.expectedGcash ?? record.expectedBalance ??
        record.expected_gcash ?? record.expected_balance,
      actual_balance: record.actualGcash ?? record.actualBalance ??
        record.actual_gcash ?? record.actual_balance,
      difference: record.difference,
      notes: record.notes || "",
      created_at: record.createdAt || record.created_at,
      updated_at: record.updatedAt || record.updated_at
    }));
    state.p_gcash_closing_history = (snapshot.gcashClosingHistory || []).map(record => ({
      closing_date: record.date || record.closingDate || record.closing_date,
      previous_record: record.previousRecord || record.previous_record || null,
      new_record: record.newRecord || record.new_record,
      changed_at: record.changedAt || record.changed_at
    }));
    return state;
  }

  async function importDeviceData(snapshot, includeFinance) {
    await request("/rest/v1/rpc/import_device_data", {
      method: "POST",
      body: toDatabaseState(snapshot, includeFinance)
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
    recordSaleVoid,
    recordCollection,
    saveExpense,
    setFundOpening,
    recordFundTransaction,
    recordStockPurchase,
    saveDailyCashClosing,
    saveDailyGcashClosing,
    saveSettings,
    importDeviceData
  });
})();
