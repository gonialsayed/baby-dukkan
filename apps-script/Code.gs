/**
 * Baby Dukkan Web App - Google Sheet backend
 *
 * এই কোডটা আপনার "Baby Dukkan Business Manager" শিটের
 * Extensions > Apps Script-এ পেস্ট করুন, তারপর Deploy করুন।
 * বিস্তারিত: README.md
 *
 * নিচের APP_PIN বদলে নিজের একটা গোপন PIN দিন।
 * ওয়েব অ্যাপে প্রথমবার ঢোকার সময় এই PIN লাগবে।
 */
const APP_PIN = 'baby1234';

/**
 * শিট থেকে Extensions > Apps Script দিয়ে খুললে এটা খালি রাখুন।
 * আলাদা Apps Script প্রজেক্ট হলে শিটের লিংকের /d/ আর /edit-এর মাঝের অংশটা (Sheet ID) এখানে দিন।
 */
const SHEET_ID = '';

const FIRST_ROW = 5; // ডাটা শুরু হয় ৫ নম্বর লাইন থেকে

const SHEETS = {
  orders: 'Orders',
  items: 'Order Items',
  customers: 'Customers',
  products: 'Products',
  stock: 'Stock In',
  expenses: 'Expenses',
  settings: 'Settings'
};

/* ---------- entry points ---------- */

function doGet(e) {
  return handle_(function () {
    const p = (e && e.parameter) || {};
    checkPin_(p.pin);
    if (p.action === 'ping') return { pong: true };
    return readAll_();
  });
}

function doPost(e) {
  return handle_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkPin_(body.pin);
    const lock = LockService.getDocumentLock();
    lock.waitLock(20000);
    try {
      const d = body.data || {};
      switch (body.action) {
        case 'addOrder': return addOrder_(d);
        case 'updateOrder': return updateOrder_(d);
        case 'saveCustomer': return saveCustomer_(d);
        case 'saveProduct': return saveProduct_(d);
        case 'addExpense': return addExpense_(d);
        case 'addStock': return addStock_(d);
        default: throw new Error('Unknown action: ' + body.action);
      }
    } finally {
      SpreadsheetApp.flush();
      lock.releaseLock();
    }
  });
}

function handle_(fn) {
  let out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkPin_(pin) {
  if (String(pin || '') !== String(APP_PIN)) throw new Error('PIN ভুল হয়েছে');
}

/* ---------- helpers ---------- */

function ss_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('স্ক্রিপ্টটা কোনো শিটের সাথে যুক্ত নয়। Code.gs-এর SHEET_ID লাইনে শিটের ID দিন।');
  return ss;
}

function sh_(key) {
  const s = ss_().getSheetByName(SHEETS[key]);
  if (!s) throw new Error('শিট পাওয়া যায়নি: ' + SHEETS[key]);
  return s;
}

function tz_() { return ss_().getSpreadsheetTimeZone(); }

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v === '' || v === null || v === undefined ? '' : String(v);
}

function parseDate_(s) {
  if (!s) return new Date();
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function mobile_(v) {
  let s = String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, '');
  if (s.length === 10 && s.charAt(0) === '1') s = '0' + s;
  if (s.length === 13 && s.indexOf('880') === 0) s = s.substring(2);
  return s;
}

/** All data rows of a sheet (rows whose key column is not empty). */
function rows_(key, ncols, keyCol) {
  const s = sh_(key);
  const n = s.getMaxRows() - FIRST_ROW + 1;
  if (n <= 0) return [];
  const vals = s.getRange(FIRST_ROW, 1, n, ncols).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][keyCol - 1]) !== '') out.push({ row: FIRST_ROW + i, v: vals[i] });
  }
  return out;
}

/** First empty row (by key column). Adds a row with copied formulas if the sheet is full. */
function nextRow_(s, keyCol, inputCols) {
  const max = s.getMaxRows();
  const n = max - FIRST_ROW + 1;
  if (n > 0) {
    const vals = s.getRange(FIRST_ROW, keyCol, n, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (str_(vals[i][0]) === '') return FIRST_ROW + i;
    }
  }
  const ncol = s.getMaxColumns();
  s.insertRowAfter(max);
  s.getRange(max, 1, 1, ncol).copyTo(s.getRange(max + 1, 1, 1, ncol));
  (inputCols || []).forEach(function (c) { s.getRange(max + 1, c).clearContent(); });
  return max + 1;
}

function findRow_(s, keyCol, value, normalize) {
  const n = s.getMaxRows() - FIRST_ROW + 1;
  if (n <= 0) return -1;
  const vals = s.getRange(FIRST_ROW, keyCol, n, 1).getValues();
  const target = normalize ? normalize(value) : str_(value);
  for (let i = 0; i < vals.length; i++) {
    const v = normalize ? normalize(vals[i][0]) : str_(vals[i][0]);
    if (v !== '' && v === target) return FIRST_ROW + i;
  }
  return -1;
}

function setText_(s, row, col, value) {
  const r = s.getRange(row, col);
  r.setNumberFormat('@');
  r.setValue(String(value));
}

function listCol_(values, idx) {
  const out = [];
  values.forEach(function (r) { if (str_(r[idx]) !== '') out.push(str_(r[idx])); });
  return out;
}

/* ---------- read ---------- */

function readAll_() {
  const st = sh_('settings').getRange(5, 1, 20, 19).getValues();
  const settings = {
    statuses: listCol_(st, 0),
    payments: listCol_(st, 2),
    couriers: listCol_(st, 4),
    expenseCats: listCol_(st, 6),
    sources: listCol_(st, 9),
    productCats: listCol_(st, 15),
    vip: num_(st[0][18]) || 5000,
    risky: num_(st[1][18]) || 2,
    lowStock: num_(st[2][18]) || 5,
    prefix: str_(st[3][18]) || 'BD-'
  };

  const products = rows_('products', 8, 2).map(function (r) {
    const v = r.v;
    return { row: r.row, id: str_(v[0]), name: str_(v[1]), category: str_(v[2]),
      buy: num_(v[3]), sell: num_(v[4]), opening: num_(v[7]) };
  });

  const customers = rows_('customers', 7, 1).map(function (r) {
    const v = r.v;
    return { row: r.row, mobile: mobile_(v[0]), name: str_(v[1]), address: str_(v[2]),
      district: str_(v[3]), source: str_(v[4]), addedOn: fmtDate_(v[5]), notes: str_(v[6]) };
  });

  const orders = rows_('orders', 18, 2).map(function (r) {
    const v = r.v;
    return { row: r.row, date: fmtDate_(v[0]), id: str_(v[1]), mobile: mobile_(v[2]),
      discount: num_(v[7]), delivery: num_(v[8]), payment: str_(v[10]), courier: str_(v[11]),
      courierCost: num_(v[12]), status: str_(v[13]), tracking: str_(v[16]), notes: str_(v[17]) };
  });

  const items = rows_('items', 7, 1).map(function (r) {
    const v = r.v;
    return { row: r.row, orderId: str_(v[0]), product: str_(v[1]), qty: num_(v[2]),
      special: v[3] === '' ? '' : num_(v[3]), unitPrice: num_(v[4]), unitCost: num_(v[6]) };
  });

  const stock = rows_('stock', 7, 2).map(function (r) {
    const v = r.v;
    return { row: r.row, date: fmtDate_(v[0]), product: str_(v[1]), qty: num_(v[2]),
      price: num_(v[3]), supplier: str_(v[5]), notes: str_(v[6]) };
  });

  const expenses = rows_('expenses', 7, 4).map(function (r) {
    const v = r.v;
    return { row: r.row, date: fmtDate_(v[0]), category: str_(v[1]), desc: str_(v[2]),
      amount: num_(v[3]), paidVia: str_(v[4]), orderId: str_(v[5]), notes: str_(v[6]) };
  });

  return { settings: settings, products: products, customers: customers, orders: orders,
    items: items, stock: stock, expenses: expenses, sheetUrl: ss_().getUrl(),
    serverTime: Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm:ss") };
}

/* ---------- write: orders ---------- */

function nextOrderId_(prefix) {
  const s = sh_('orders');
  const n = s.getMaxRows() - FIRST_ROW + 1;
  const vals = n > 0 ? s.getRange(FIRST_ROW, 2, n, 1).getValues() : [];
  let max = 0;
  vals.forEach(function (r) {
    const m = str_(r[0]).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

function productMap_() {
  const map = {};
  rows_('products', 5, 2).forEach(function (r) {
    map[str_(r.v[1])] = { buy: num_(r.v[3]), sell: num_(r.v[4]) };
  });
  return map;
}

function addOrder_(d) {
  const mobile = mobile_(d.mobile);
  if (mobile.length !== 11) throw new Error('মোবাইল নম্বর ১১ ডিজিট হতে হবে');
  if (!d.items || !d.items.length) throw new Error('অন্তত একটা প্রোডাক্ট দিন');

  // customer: add if new, update if details sent
  const cs = sh_('customers');
  let crow = findRow_(cs, 1, mobile, mobile_);
  if (crow === -1) {
    if (!d.customer || !str_(d.customer.name)) throw new Error('নতুন কাস্টমারের নাম দিন');
    saveCustomer_({ mobile: mobile, name: d.customer.name, address: d.customer.address,
      district: d.customer.district, source: d.customer.source, isNew: true, addedOn: d.date });
  } else if (d.customer && d.customer.update) {
    saveCustomer_({ mobile: mobile, name: d.customer.name, address: d.customer.address,
      district: d.customer.district, source: d.customer.source });
  }

  const pm = productMap_();
  d.items.forEach(function (it) {
    if (!pm[str_(it.product)]) throw new Error('প্রোডাক্ট পাওয়া যায়নি: ' + it.product);
    if (num_(it.qty) <= 0) throw new Error('Qty ০-এর বেশি হতে হবে');
  });

  const st = sh_('settings').getRange(8, 19).getValue();
  const id = nextOrderId_(str_(st) || 'BD-');

  const os = sh_('orders');
  const r = nextRow_(os, 2, [1, 2, 3, 8, 9, 11, 12, 13, 14, 17, 18]);
  os.getRange(r, 1, 1, 2).setValues([[parseDate_(d.date), id]]);
  setText_(os, r, 3, mobile);
  os.getRange(r, 8, 1, 2).setValues([[d.discount ? num_(d.discount) : '', num_(d.delivery)]]);
  os.getRange(r, 11, 1, 4).setValues([[str_(d.payment), str_(d.courier),
    d.courierCost ? num_(d.courierCost) : '', str_(d.status) || 'Pending']]);
  os.getRange(r, 17, 1, 2).setValues([[str_(d.tracking), str_(d.notes)]]);

  const is = sh_('items');
  d.items.forEach(function (it) {
    const p = pm[str_(it.product)];
    const special = it.special === '' || it.special === null || it.special === undefined ? '' : num_(it.special);
    const unit = special === '' ? p.sell : special;
    const ir = nextRow_(is, 1, [1, 2, 3, 4]);
    is.getRange(ir, 1, 1, 5).setValues([[id, str_(it.product), num_(it.qty), special, unit]]);
    is.getRange(ir, 7).setValue(p.buy); // কেনা দাম জমিয়ে রাখা, পরে দাম বদলালেও পুরনো হিসাব ঠিক থাকবে
  });

  return { id: id };
}

function updateOrder_(d) {
  const os = sh_('orders');
  const r = findRow_(os, 2, d.id);
  if (r === -1) throw new Error('অর্ডার পাওয়া যায়নি: ' + d.id);
  const set = function (col, val) { os.getRange(r, col).setValue(val); };
  if (d.status !== undefined) set(14, str_(d.status));
  if (d.courier !== undefined) set(12, str_(d.courier));
  if (d.courierCost !== undefined) set(13, d.courierCost === '' ? '' : num_(d.courierCost));
  if (d.tracking !== undefined) set(17, str_(d.tracking));
  if (d.notes !== undefined) set(18, str_(d.notes));
  if (d.payment !== undefined) set(11, str_(d.payment));
  if (d.discount !== undefined) set(8, d.discount === '' ? '' : num_(d.discount));
  if (d.delivery !== undefined) set(9, num_(d.delivery));
  return { id: d.id };
}

/* ---------- write: customers ---------- */

function saveCustomer_(d) {
  const mobile = mobile_(d.mobile);
  if (mobile.length !== 11) throw new Error('মোবাইল নম্বর ১১ ডিজিট হতে হবে');
  const cs = sh_('customers');
  let r = findRow_(cs, 1, mobile, mobile_);
  if (r === -1) {
    r = nextRow_(cs, 1, [1, 2, 3, 4, 5, 6, 7]);
    setText_(cs, r, 1, mobile);
    cs.getRange(r, 6).setValue(parseDate_(d.addedOn));
  } else if (d.isNew) {
    throw new Error('এই নম্বরের কাস্টমার আগেই আছে');
  }
  cs.getRange(r, 2, 1, 4).setValues([[str_(d.name), str_(d.address), str_(d.district), str_(d.source)]]);
  if (d.notes !== undefined) cs.getRange(r, 7).setValue(str_(d.notes));
  return { mobile: mobile };
}

/* ---------- write: products ---------- */

/** পুরনো অর্ডারের দাম ফর্মুলা থেকে স্থায়ী মানে বদলে দেয়, যাতে দাম বদলালে আগের হিসাব না বদলায়। */
function freezeProduct_(name) {
  const is = sh_('items');
  const n = is.getMaxRows() - FIRST_ROW + 1;
  if (n <= 0) return;
  const names = is.getRange(FIRST_ROW, 2, n, 1).getValues();
  [5, 7].forEach(function (col) {
    const rng = is.getRange(FIRST_ROW, col, n, 1);
    const f = rng.getFormulas();
    const v = rng.getValues();
    let changed = false;
    const out = f.map(function (row, i) {
      if (str_(names[i][0]) === name && row[0]) { changed = true; return [v[i][0]]; }
      return [row[0] || v[i][0]];
    });
    if (changed) rng.setValues(out);
  });
}

function saveProduct_(d) {
  const ps = sh_('products');
  const name = str_(d.name);
  if (!name) throw new Error('প্রোডাক্টের নাম দিন');
  let r;
  if (d.originalName) {
    r = findRow_(ps, 2, d.originalName);
    if (r === -1) throw new Error('প্রোডাক্ট পাওয়া যায়নি');
    const old = ps.getRange(r, 1, 1, 5).getValues()[0];
    if (num_(old[3]) !== num_(d.buy) || num_(old[4]) !== num_(d.sell)) freezeProduct_(str_(d.originalName));
  } else {
    if (findRow_(ps, 2, name) !== -1) throw new Error('এই নামে প্রোডাক্ট আগেই আছে');
    r = nextRow_(ps, 2, [1, 2, 3, 4, 5, 8]);
    ps.getRange(r, 2).setValue(name);
  }
  ps.getRange(r, 1).setValue(str_(d.id));
  ps.getRange(r, 3, 1, 3).setValues([[str_(d.category), num_(d.buy), num_(d.sell)]]);
  ps.getRange(r, 8).setValue(num_(d.opening));
  return { name: name };
}

/* ---------- write: expenses, stock ---------- */

function addExpense_(d) {
  if (num_(d.amount) <= 0) throw new Error('টাকার অংক দিন');
  if (!str_(d.category)) throw new Error('Category বাছুন');
  const s = sh_('expenses');
  const r = nextRow_(s, 4, [1, 2, 3, 4, 5, 6, 7]);
  s.getRange(r, 1, 1, 7).setValues([[parseDate_(d.date), str_(d.category), str_(d.desc),
    num_(d.amount), str_(d.paidVia), str_(d.orderId), str_(d.notes)]]);
  return { row: r };
}

function addStock_(d) {
  if (num_(d.qty) <= 0) throw new Error('কত পিস দিন');
  const pm = productMap_();
  if (!pm[str_(d.product)]) throw new Error('প্রোডাক্ট পাওয়া যায়নি: ' + d.product);
  const s = sh_('stock');
  const r = nextRow_(s, 2, [1, 2, 3, 4, 6, 7]);
  s.getRange(r, 1, 1, 4).setValues([[parseDate_(d.date), str_(d.product), num_(d.qty), num_(d.price)]]);
  s.getRange(r, 6, 1, 2).setValues([[str_(d.supplier), str_(d.notes)]]);
  return { row: r };
}

/** Apps Script এডিটরে এটা একবার Run করলে অনুমতি (Authorize) দেওয়া হয়ে যায়। */
function testSetup() {
  const d = readAll_();
  Logger.log('ঠিক আছে! প্রোডাক্ট: ' + d.products.length + ', অর্ডার: ' + d.orders.length);
}
