/* Baby Dukkan web app
 * ডাটা থাকে Google Sheet-এ (Apps Script দিয়ে), অথবা ডেমো মোডে ব্রাউজারে।
 */
(function () {
'use strict';

/* ================= storage ================= */
const CFG_KEY = 'bd_cfg_v1', CACHE_KEY = 'bd_cache_v1', DEMO_KEY = 'bd_demo_v1', CALC_KEY = 'bd_calc_v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

let cfg = store.get(CFG_KEY, null);      // {mode:'live'|'demo', url, pin}
let RAW = null;                          // data from sheet
let D = null;                            // derived data
let loading = false;
let loadError = '';
const ui = {
  month: null,               // {y, m}  m: 0-11, null = full year
  orderFilter: 'active',
  orderQuery: '',
  custFilter: 'all',
  custQuery: '',
  expMonth: null,
  draft: null                // new order draft
};

/* ================= helpers ================= */
const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const bn = (s) => String(s).replace(/[0-9]/g, (d) => BN_DIGITS[d]);
const MONTHS = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
const MONTHS_S = ['জানু','ফেব্রু','মার্চ','এপ্রি','মে','জুন','জুলা','আগ','সেপ্টে','অক্টো','নভে','ডিসে'];
const STATUS_BN = { Pending: 'অপেক্ষায়', Confirmed: 'কনফার্ম', Shipped: 'কুরিয়ারে', Delivered: 'ডেলিভারড', Returned: 'রিটার্ন', Cancelled: 'বাতিল' };
const TYPE_BN = { VIP: 'VIP', Repeat: 'Repeat', New: 'New', Risky: 'Risky', None: 'অর্ডার নেই' };
const ACTIVE = ['Pending', 'Confirmed', 'Shipped'];
const CAT_BN = {
  'Product Sourcing': 'ঢাকা যাওয়া-আসা, সংগ্রহ',
  'Transportation': 'কুরিয়ার, বাসায় আনা',
  'Inventory Management': 'গোছানো, সংরক্ষণ',
  'Packaging': 'পলিব্যাগ, টেপ, স্টিকার',
  'Marketing': 'Boost, বিজ্ঞাপন',
  'Order Processing': 'ফোন, ইন্টারনেট',
  'Delivery': 'অতিরিক্ত ওজন ইত্যাদি',
  'Financial Settlement': 'bKash/Nagad ফি',
  'Other': 'অন্যান্য'
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
const commas = (n) => Math.round(n).toLocaleString('en-IN');
const tk = (n) => (n < 0 ? '-' : '') + '৳' + bn(commas(Math.abs(n)));
const tkPlain = (n) => bn(commas(n));
const nbn = (n) => bn(commas(n));
const pct = (x) => bn((Math.round(x * 1000) / 10).toFixed(1)) + '%';
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const parseISO = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const fmtDate = (s) => { const d = parseISO(s); return d ? bn(d.getDate()) + ' ' + MONTHS_S[d.getMonth()] : ''; };
const fmtDateLong = (s) => { const d = parseISO(s); return d ? bn(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + bn(d.getFullYear()) : ''; };
const mobileNorm = (v) => { let s = String(v || '').replace(/[^0-9]/g, ''); if (s.length === 10 && s[0] === '1') s = '0' + s; if (s.length === 13 && s.indexOf('880') === 0) s = s.slice(2); return s; };
const waLink = (mobile, text) => 'https://wa.me/88' + mobileNorm(mobile) + (text ? '?text=' + encodeURIComponent(text) : '');
const initial = (name) => { const s = String(name || '?').trim(); return s ? Array.from(s)[0].toUpperCase() : '?'; };
const avatarTone = (s) => 't' + (1 + (Array.from(String(s || '')).reduce((a, c) => a + c.charCodeAt(0), 0) % 5));
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const inRange = (iso, from, to) => { const d = parseISO(iso); return d && d >= from && d <= to; };

function periodRange(p) {
  if (p.m === null) return [new Date(p.y, 0, 1), new Date(p.y, 11, 31)];
  return [new Date(p.y, p.m, 1), new Date(p.y, p.m + 1, 0)];
}
function periodLabel(p) { return p.m === null ? 'সারা বছর ' + bn(p.y) : MONTHS[p.m] + ' ' + bn(p.y); }

/* ================= icons ================= */
const I = (p, extra) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + p + '</svg>';
const ICON = {
  home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>'),
  orders: I('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>', ' stroke-width="2.6"'),
  users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.6c2.4.2 4 1.8 4.5 4.4"/>'),
  more: I('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  refresh: I('<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 21v-5h-5"/>'),
  back: I('<path d="M15 5l-7 7 7 7"/>'),
  left: I('<path d="M14.5 6 8.5 12l6 6"/>'),
  right: I('<path d="m9.5 6 6 6-6 6"/>'),
  phone: I('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  wa: I('<path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3 3z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2z"/>'),
  box: I('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  wallet: I('<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/><circle cx="16" cy="13.5" r="1.3"/>'),
  truck: I('<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'),
  calc: I('<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M8.5 7h7M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5v3M8.5 17.5h.01M12 17.5h.01"/>'),
  sheet: I('<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 9h16M4 15h16M10 3v18"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  alert: I('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>', ' stroke-width="3"'),
  copy: I('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  edit: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  stockin: I('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>')
};

/* ================= API ================= */
async function apiGetAll() {
  if (cfg.mode === 'demo') return Demo.getAll();
  const url = cfg.url + (cfg.url.indexOf('?') > -1 ? '&' : '?') + 'action=all&pin=' + encodeURIComponent(cfg.pin) + '&t=' + Date.now();
  const r = await fetch(url, { method: 'GET', redirect: 'follow' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'শিট থেকে ডাটা আনা যায়নি');
  return j.data;
}
async function apiPost(action, data) {
  if (cfg.mode === 'demo') return Demo.post(action, data);
  const r = await fetch(cfg.url, { method: 'POST', redirect: 'follow', body: JSON.stringify({ pin: cfg.pin, action: action, data: data }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'সেভ করা যায়নি');
  return j.data;
}
async function testConnection(url, pin) {
  const r = await fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'action=ping&pin=' + encodeURIComponent(pin), { redirect: 'follow' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'সংযোগ হয়নি');
  return true;
}

/* ================= demo backend (mirrors Code.gs) ================= */
const Demo = {
  db() {
    let db = store.get(DEMO_KEY, null);
    if (!db) { db = seedDemo(); store.set(DEMO_KEY, db); }
    return db;
  },
  save(db) { store.set(DEMO_KEY, db); },
  async getAll() { await wait(250); return JSON.parse(JSON.stringify(this.db())); },
  async post(action, d) {
    await wait(350);
    const db = this.db();
    let res;
    if (action === 'addOrder') res = demoAddOrder(db, d);
    else if (action === 'updateOrder') {
      const o = db.orders.find((x) => x.id === d.id); if (!o) throw new Error('অর্ডার পাওয়া যায়নি');
      ['status', 'courier', 'tracking', 'notes', 'payment'].forEach((k) => { if (d[k] !== undefined) o[k] = String(d[k]); });
      ['courierCost', 'discount', 'delivery'].forEach((k) => { if (d[k] !== undefined) o[k] = num(d[k]); });
      res = { id: d.id };
    } else if (action === 'saveCustomer') res = demoSaveCustomer(db, d);
    else if (action === 'saveProduct') {
      if (d.originalName) {
        const p = db.products.find((x) => x.name === d.originalName); if (!p) throw new Error('প্রোডাক্ট পাওয়া যায়নি');
        Object.assign(p, { id: d.id, category: d.category, buy: num(d.buy), sell: num(d.sell), opening: num(d.opening) });
      } else {
        if (db.products.some((x) => x.name === d.name)) throw new Error('এই নামে প্রোডাক্ট আগেই আছে');
        db.products.push({ id: d.id, name: d.name, category: d.category, buy: num(d.buy), sell: num(d.sell), opening: num(d.opening) });
      }
      res = { name: d.name };
    } else if (action === 'addExpense') {
      if (num(d.amount) <= 0) throw new Error('টাকার অংক দিন');
      db.expenses.push({ date: d.date, category: d.category, desc: d.desc || '', amount: num(d.amount), paidVia: d.paidVia || '', orderId: d.orderId || '', notes: d.notes || '' });
      res = {};
    } else if (action === 'addStock') {
      if (num(d.qty) <= 0) throw new Error('কত পিস দিন');
      db.stock.push({ date: d.date, product: d.product, qty: num(d.qty), price: num(d.price), supplier: d.supplier || '', notes: d.notes || '' });
      res = {};
    } else throw new Error('Unknown action');
    this.save(db);
    return res;
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function demoSaveCustomer(db, d) {
  const m = mobileNorm(d.mobile);
  if (m.length !== 11) throw new Error('মোবাইল নম্বর ১১ ডিজিট হতে হবে');
  let c = db.customers.find((x) => x.mobile === m);
  if (!c) { c = { mobile: m, addedOn: d.addedOn || todayISO(), notes: '' }; db.customers.push(c); }
  else if (d.isNew) throw new Error('এই নম্বরের কাস্টমার আগেই আছে');
  Object.assign(c, { name: d.name || '', address: d.address || '', district: d.district || '', source: d.source || '' });
  if (d.notes !== undefined) c.notes = d.notes;
  return { mobile: m };
}
function demoAddOrder(db, d) {
  const m = mobileNorm(d.mobile);
  if (m.length !== 11) throw new Error('মোবাইল নম্বর ১১ ডিজিট হতে হবে');
  if (!d.items || !d.items.length) throw new Error('অন্তত একটা প্রোডাক্ট দিন');
  const exists = db.customers.some((x) => x.mobile === m);
  if (!exists) {
    if (!d.customer || !d.customer.name) throw new Error('নতুন কাস্টমারের নাম দিন');
    demoSaveCustomer(db, Object.assign({}, d.customer, { mobile: m, isNew: true, addedOn: d.date }));
  } else if (d.customer && d.customer.update) demoSaveCustomer(db, Object.assign({}, d.customer, { mobile: m }));
  const prefix = db.settings.prefix || 'BD-';
  const max = db.orders.reduce((a, o) => { const x = /(\d+)\s*$/.exec(o.id); return x ? Math.max(a, +x[1]) : a; }, 0);
  const id = prefix + String(max + 1).padStart(4, '0');
  d.items.forEach((it) => {
    const p = db.products.find((x) => x.name === it.product);
    if (!p) throw new Error('প্রোডাক্ট পাওয়া যায়নি: ' + it.product);
    db.items.push({ orderId: id, product: it.product, qty: num(it.qty), special: it.special === '' || it.special == null ? '' : num(it.special), unitPrice: it.special === '' || it.special == null ? p.sell : num(it.special), unitCost: p.buy });
  });
  db.orders.push({ date: d.date, id: id, mobile: m, discount: num(d.discount), delivery: num(d.delivery), payment: d.payment || '', courier: d.courier || '', courierCost: num(d.courierCost), status: d.status || 'Pending', tracking: '', notes: d.notes || '' });
  return { id: id };
}

function seedDemo() {
  const y = new Date().getFullYear(), mo = new Date().getMonth();
  const dt = (mOff, day) => { const d = new Date(y, mo + mOff, day); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const today = new Date().getDate();
  const dd = (n) => Math.max(1, Math.min(today, n));
  const settings = {
    statuses: ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Returned', 'Cancelled'],
    payments: ['Cash on Delivery (COD)', 'bKash', 'Nagad', 'Rocket', 'Bank Transfer', 'Cash'],
    couriers: ['Steadfast', 'Pathao', 'RedX', 'Sundarban', 'Paperfly', 'Self Delivery', 'Other'],
    expenseCats: ['Product Sourcing', 'Transportation', 'Inventory Management', 'Packaging', 'Marketing', 'Order Processing', 'Delivery', 'Financial Settlement', 'Other'],
    sources: ['Facebook Page', 'Messenger', 'WhatsApp', 'Instagram', 'Referral', 'Other'],
    productCats: ['Swaddle', 'Clothing', 'Bedding', 'Accessories', 'Toys', 'Other'],
    vip: 5000, risky: 2, lowStock: 5, prefix: 'BD-'
  };
  const products = [
    { id: 'P001', name: 'Single Layer Swaddle', category: 'Swaddle', buy: 300, sell: 500, opening: 20 },
    { id: 'P002', name: 'Double Layer Swaddle', category: 'Swaddle', buy: 480, sell: 750, opening: 15 },
    { id: 'P003', name: 'Genji Set', category: 'Clothing', buy: 120, sell: 200, opening: 40 },
    { id: 'P004', name: 'Pillow Set', category: 'Bedding', buy: 190, sell: 320, opening: 12 },
    { id: 'P005', name: 'Baby Blanket', category: 'Bedding', buy: 260, sell: 450, opening: 6 },
    { id: 'P006', name: 'Muslin Bib (3 pcs)', category: 'Accessories', buy: 90, sell: 180, opening: 25 }
  ];
  const customers = [
    ['01790169224', 'কামরুল নাহার', 'সাতমাথা, ওমর আলী তেলের পাম্প, নাচনিয়া', 'রংপুর', 'Facebook Page'],
    ['01711223344', 'রহিমা বেগম', 'বাড়ি ১২, রোড ৩, মিরপুর ১০', 'ঢাকা', 'Messenger'],
    ['01822334455', 'সুমাইয়া আক্তার', 'আগ্রাবাদ, বাদামতলী মোড়', 'চট্টগ্রাম', 'Facebook Page'],
    ['01933445566', 'তানিয়া ইসলাম', 'জিন্দাবাজার, পূর্ব জিন্দাবাজার', 'সিলেট', 'WhatsApp'],
    ['01644556677', 'নুসরাত জাহান', 'কাজলা, বিনোদপুর', 'রাজশাহী', 'Instagram'],
    ['01555667788', 'ফারজানা হক', 'সোনাডাঙ্গা আবাসিক এলাকা', 'খুলনা', 'Referral']
  ].map((c, i) => ({ mobile: c[0], name: c[1], address: c[2], district: c[3], source: c[4], addedOn: dt(-1, 3 + i), notes: '' }));
  const orders = [], items = [];
  const add = (date, mobile, lines, delivery, status, courierCost, payment) => {
    const id = 'BD-' + String(orders.length + 1).padStart(4, '0');
    orders.push({ date, id, mobile, discount: 0, delivery, payment: payment || 'Cash on Delivery (COD)', courier: status === 'Pending' ? '' : 'Steadfast', courierCost: courierCost || 0, status, tracking: '', notes: '' });
    lines.forEach((l) => { const p = products.find((x) => x.name === l[0]); items.push({ orderId: id, product: l[0], qty: l[1], special: '', unitPrice: p.sell, unitCost: p.buy }); });
  };
  add(dt(-1, 4), '01790169224', [['Single Layer Swaddle', 1], ['Double Layer Swaddle', 1], ['Genji Set', 3], ['Pillow Set', 1]], 125, 'Delivered', 150);
  add(dt(-1, 7), '01822334455', [['Genji Set', 4]], 125, 'Delivered', 140);
  add(dt(-1, 11), '01933445566', [['Double Layer Swaddle', 2]], 125, 'Delivered', 150);
  add(dt(-1, 15), '01644556677', [['Baby Blanket', 1], ['Muslin Bib (3 pcs)', 1]], 125, 'Returned', 190);
  add(dt(-1, 19), '01711223344', [['Single Layer Swaddle', 2]], 70, 'Delivered', 75);
  add(dt(-1, 24), '01790169224', [['Baby Blanket', 2], ['Genji Set', 2]], 125, 'Delivered', 155);
  add(dt(-1, 27), '01555667788', [['Pillow Set', 2]], 125, 'Delivered', 140, 'bKash');
  add(dt(0, dd(2)), '01711223344', [['Double Layer Swaddle', 1], ['Muslin Bib (3 pcs)', 2]], 70, 'Delivered', 80);
  add(dt(0, dd(4)), '01822334455', [['Single Layer Swaddle', 1], ['Genji Set', 3]], 125, 'Delivered', 145);
  add(dt(0, dd(6)), '01933445566', [['Pillow Set', 1]], 125, 'Cancelled', 0);
  add(dt(0, dd(5)), '01555667788', [['Double Layer Swaddle', 2], ['Pillow Set', 1]], 125, 'Delivered', 150, 'bKash');
  add(dt(0, dd(7)), '01644556677', [['Single Layer Swaddle', 2], ['Muslin Bib (3 pcs)', 2]], 125, 'Delivered', 145);
  add(dt(0, dd(8)), '01790169224', [['Genji Set', 6]], 125, 'Shipped', 0);
  add(dt(0, dd(9)), '01644556677', [['Single Layer Swaddle', 1]], 125, 'Confirmed', 0);
  add(dt(0, dd(10)), '01555667788', [['Baby Blanket', 1], ['Pillow Set', 1]], 125, 'Pending', 0);
  const expenses = [
    { date: dt(-1, 2), category: 'Product Sourcing', desc: 'ঢাকা যাওয়া-আসা, বাস ভাড়া', amount: 900, paidVia: 'Cash' },
    { date: dt(-1, 2), category: 'Transportation', desc: 'ঢাকা থেকে কুরিয়ার', amount: 350, paidVia: 'Cash' },
    { date: dt(-1, 5), category: 'Marketing', desc: 'Facebook Boost', amount: 1500, paidVia: 'bKash' },
    { date: dt(-1, 6), category: 'Packaging', desc: 'পলিব্যাগ ও টেপ', amount: 300, paidVia: 'Cash' },
    { date: dt(0, dd(1)), category: 'Marketing', desc: 'Facebook Boost', amount: 1200, paidVia: 'bKash' },
    { date: dt(0, dd(3)), category: 'Order Processing', desc: 'মোবাইল রিচার্জ', amount: 200, paidVia: 'bKash' },
    { date: dt(0, dd(5)), category: 'Packaging', desc: 'স্টিকার প্রিন্ট', amount: 250, paidVia: 'Cash' }
  ].map((e) => Object.assign({ orderId: '', notes: '' }, e));
  const stock = [
    { date: dt(-1, 2), product: 'Genji Set', qty: 20, price: 120, supplier: 'ইসলামপুর, ঢাকা', notes: '' },
    { date: dt(-1, 2), product: 'Double Layer Swaddle', qty: 10, price: 480, supplier: 'ইসলামপুর, ঢাকা', notes: '' }
  ];
  return { settings, products, customers, orders, items, stock, expenses, sheetUrl: '' };
}

/* ================= derive ================= */
function derive(raw) {
  const s = raw.settings;
  const P = {};
  raw.products.forEach((p) => { P[p.name] = Object.assign({}, p, { stockIn: 0, sold: 0 }); });
  raw.stock.forEach((x) => { if (P[x.product]) P[x.product].stockIn += num(x.qty); });
  const itemsBy = {};
  raw.items.forEach((it) => { (itemsBy[it.orderId] = itemsBy[it.orderId] || []).push(it); });
  const C = {};
  raw.customers.forEach((c) => { C[c.mobile] = Object.assign({}, c, { orders: [] }); });

  const orders = raw.orders.map((o) => {
    const its = itemsBy[o.id] || [];
    const pt = sum(its, (i) => num(i.qty) * num(i.unitPrice));
    const pc = sum(its, (i) => num(i.qty) * num(i.unitCost));
    const grand = pt - num(o.discount) + num(o.delivery);
    let profit = null;
    if (o.status === 'Delivered') profit = grand - pc - num(o.courierCost);
    else if (o.status === 'Returned') profit = -num(o.courierCost);
    const c = C[o.mobile];
    const oo = Object.assign({}, o, { items: its, pcs: sum(its, (i) => num(i.qty)), productTotal: pt, productCost: pc, grand, profit, customer: c || null });
    if (c) c.orders.push(oo);
    if (o.status !== 'Cancelled' && o.status !== 'Returned') its.forEach((i) => { if (P[i.product]) P[i.product].sold += num(i.qty); });
    return oo;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));

  const now = new Date();
  const customers = Object.values(C).map((c) => {
    const valid = c.orders.filter((o) => o.status !== 'Cancelled');
    const delivered = c.orders.filter((o) => o.status === 'Delivered');
    const returned = c.orders.filter((o) => o.status === 'Returned').length;
    const spent = sum(delivered, (o) => o.grand);
    const dates = valid.map((o) => o.date).filter(Boolean).sort();
    const first = dates[0] || '', last = dates[dates.length - 1] || '';
    let type = 'None';
    if (returned >= s.risky) type = 'Risky';
    else if (spent >= s.vip) type = 'VIP';
    else if (valid.length >= 2) type = 'Repeat';
    else if (valid.length >= 1) type = 'New';
    c.orders.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return Object.assign(c, { total: valid.length, delivered: delivered.length, returned, spent, first, last, type, days: last ? daysBetween(parseISO(last), now) : null });
  }).sort((a, b) => (b.last || b.addedOn || '').localeCompare(a.last || a.addedOn || ''));

  const products = Object.values(P).map((p) => {
    const stock = num(p.opening) + p.stockIn - p.sold;
    const status = stock <= 0 ? 'out' : stock <= s.lowStock ? 'low' : 'ok';
    return Object.assign(p, { stock, status });
  });

  return { settings: s, orders, customers, products, P, C, expenses: raw.expenses.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')), stock: raw.stock.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')), sheetUrl: raw.sheetUrl };
}

function periodStats(p) {
  const [from, to] = periodRange(p);
  const os = D.orders.filter((o) => inRange(o.date, from, to));
  const del = os.filter((o) => o.status === 'Delivered');
  const ret = os.filter((o) => o.status === 'Returned');
  const revenue = sum(del, (o) => o.grand);
  const sales = sum(del, (o) => o.productTotal - num(o.discount));
  const deliveryIn = sum(del, (o) => num(o.delivery));
  const cogs = sum(del, (o) => o.productCost);
  const courier = sum(del.concat(ret), (o) => num(o.courierCost));
  const exps = D.expenses.filter((e) => inRange(e.date, from, to));
  const expTotal = sum(exps, (e) => num(e.amount));
  const byCat = {};
  D.settings.expenseCats.forEach((c) => { byCat[c] = 0; });
  exps.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + num(e.amount); });
  byCat['Delivery'] = (byCat['Delivery'] || 0) + courier;
  const net = revenue - cogs - expTotal - courier;
  const valid = os.filter((o) => o.status !== 'Cancelled');
  const prodMap = {};
  del.forEach((o) => o.items.forEach((i) => {
    const k = i.product; prodMap[k] = prodMap[k] || { name: k, qty: 0, profit: 0 };
    prodMap[k].qty += num(i.qty); prodMap[k].profit += num(i.qty) * (num(i.unitPrice) - num(i.unitCost));
  }));
  const newCust = D.customers.filter((c) => c.first && inRange(c.first, from, to)).length;
  const stockBuy = sum(D.stock.filter((x) => inRange(x.date, from, to)), (x) => num(x.qty) * num(x.price));
  return {
    orders: valid.length, delivered: del.length, returned: ret.length,
    returnRate: del.length + ret.length ? ret.length / (del.length + ret.length) : 0,
    revenue, sales, deliveryIn, cogs, courier, expTotal, byCat, net,
    margin: revenue ? net / revenue : 0, aov: del.length ? revenue / del.length : 0,
    top: Object.values(prodMap).sort((a, b) => b.qty - a.qty).slice(0, 5), newCust, stockBuy
  };
}

/* ================= load ================= */
async function loadData(silent) {
  if (loading) return;
  loading = true; loadError = '';
  setRefreshing(true);
  try {
    RAW = await apiGetAll();
    if (cfg.mode === 'live') store.set(CACHE_KEY, RAW);
    D = derive(RAW);
  } catch (e) {
    loadError = (e && e.message) || 'ইন্টারনেট সংযোগ দেখুন';
    if (!silent) toast(loadError, true);
  } finally {
    loading = false;
    setRefreshing(false);
    render();
  }
}
function setRefreshing(on) {
  document.querySelectorAll('[data-action="refresh"]').forEach((b) => b.classList.toggle('spin', on));
}

/* ================= router ================= */
function route() { return (location.hash || '#home').slice(1).split('/'); }
function go(h) { if (location.hash === '#' + h) render(); else location.hash = h; }
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); if (ui.afterNav) { const f = ui.afterNav; ui.afterNav = null; f(); } });

const app = document.getElementById('app');

function render() {
  if (!cfg) { app.innerHTML = viewSetup(); return; }
  if (!D) {
    app.innerHTML = loadError
      ? '<div class="wrap" style="padding-top:60px">' + alertBox('err', '<b>ডাটা আনা যায়নি।</b> ' + esc(loadError)) + '<div class="btn-row mt16"><button class="btn" data-action="refresh">আবার চেষ্টা করুন</button><button class="btn ghost" data-action="disconnect">সংযোগ বদলান</button></div></div>'
      : '<div class="boot"><div class="boot-mark">BD</div><p>শিট থেকে ডাটা আনছি...</p></div>';
    return;
  }
  const [r, a] = route();
  let html = '';
  let nav = true;
  switch (r) {
    case 'orders': html = viewOrders(); break;
    case 'new': html = viewNewOrder(); nav = false; break;
    case 'customers': html = viewCustomers(); break;
    case 'more': html = viewMore(); break;
    case 'products': html = viewProducts(); break;
    case 'expenses': html = viewExpenses(); break;
    case 'stock': html = viewStock(); break;
    case 'calc': html = viewCalc(); break;
    case 'settings': html = viewSettings(); break;
    default: html = viewHome();
  }
  const demo = cfg.mode === 'demo' ? '<div class="demo-bar">ডেমো মোড: এগুলো নমুনা ডাটা <button data-action="go-setup">আসল শিট যুক্ত করুন</button></div>' : '';
  app.innerHTML = demo + html + (nav ? navBar(r) : '');
  if (r === 'new') mountNewOrder();
  if (r === 'calc') mountCalc();
  void a;
}

function navBar(r) {
  const cur = (k) => (r === k || (!r && k === 'home') ? ' aria-current="page"' : '');
  const moreCur = ['more', 'products', 'expenses', 'stock', 'calc', 'settings'].indexOf(r) > -1 ? ' aria-current="page"' : '';
  return '<nav class="nav" aria-label="মেনু">' +
    '<a href="#home"' + cur('home') + '>' + ICON.home + 'হোম</a>' +
    '<a href="#orders"' + cur('orders') + '>' + ICON.orders + 'অর্ডার</a>' +
    '<a href="#new" class="plus" aria-label="নতুন অর্ডার">' + ICON.plus + '<span>নতুন</span></a>' +
    '<a href="#customers"' + cur('customers') + '>' + ICON.users + 'কাস্টমার</a>' +
    '<a href="#more"' + moreCur + '>' + ICON.more + 'আরও</a>' +
    '</nav>';
}

function topBar() {
  const name = cfg.mode === 'demo' ? 'ডেমো' : 'আপনার দোকান';
  return '<header class="top"><div class="brand"><div class="brand-mark">BD</div><div><h1>Baby Dukkan</h1><small>' + name + '</small></div></div>' +
    '<button class="icon-btn" data-action="refresh" aria-label="রিফ্রেশ">' + ICON.refresh + '</button></header>';
}
function pageHead(title, backTo, right) {
  return '<header class="page-head">' + (backTo ? '<a class="back" href="#' + backTo + '" aria-label="পেছনে">' + ICON.back + '</a>' : '') +
    '<h1 class="page-title grow">' + title + '</h1>' + (right || '') + '</header>';
}
function monthSwitch(p, key) {
  return '<div class="month"><button data-action="month-prev" data-key="' + key + '" aria-label="আগের মাস">' + ICON.left + '</button><span>' + periodLabel(p) + '</span><button data-action="month-next" data-key="' + key + '" aria-label="পরের মাস">' + ICON.right + '</button></div>';
}
function alertBox(kind, html, extra) {
  return '<div class="alert ' + (kind || '') + '">' + ICON.alert + '<div class="grow">' + html + '</div>' + (extra || '') + '</div>';
}
const statusPill = (s) => '<span class="pill st-' + esc(s) + '">' + (STATUS_BN[s] || esc(s)) + '</span>';
const typePill = (t) => '<span class="pill ty-' + t + '">' + TYPE_BN[t] + '</span>';

/* ================= setup ================= */
function viewSetup() {
  return '<div class="setup">' +
    '<div class="setup-hero"><div class="brand-mark" style="background:#fff;color:var(--rasp)">BD</div><h1>Baby Dukkan</h1><p>অর্ডার, কাস্টমার, স্টক আর লাভ-ক্ষতি এক জায়গায়। সব তথ্য জমা থাকবে আপনার Google Sheet-এ।</p></div>' +
    '<form class="card" data-form="connect"><h2>আপনার শিট যুক্ত করুন</h2><p>Apps Script থেকে পাওয়া Web app URL আর আপনার PIN দিন।</p>' +
    '<div class="field"><label for="c-url">Web app URL</label><input class="inp" id="c-url" name="url" placeholder="https://script.google.com/macros/s/.../exec" required autocomplete="off"></div>' +
    '<div class="field"><label for="c-pin">PIN</label><input class="inp" id="c-pin" name="pin" type="password" placeholder="Code.gs-এ যে PIN দিয়েছেন" required></div>' +
    '<button class="btn" type="submit">যুক্ত করুন</button>' +
    '<details class="how"><summary>URL কোথায় পাবো?</summary><ol>' +
    '<li>আপনার Baby Dukkan Google Sheet খুলুন।</li>' +
    '<li>উপরের মেনু থেকে <b>Extensions &gt; Apps Script</b>।</li>' +
    '<li>সেখানে যা লেখা আছে সব মুছে <b>Code.gs</b> ফাইলের কোড পেস্ট করুন, প্রথম লাইনে নিজের PIN দিন, তারপর সেভ করুন।</li>' +
    '<li>উপরে ডানে <b>Deploy &gt; New deployment</b>। Type: <b>Web app</b>, Execute as: <b>Me</b>, Who has access: <b>Anyone</b>।</li>' +
    '<li><b>Deploy</b> চাপুন, অনুমতি দিন, তারপর যে <b>Web app URL</b> আসবে সেটা কপি করে এখানে বসান।</li>' +
    '</ol><p class="small muted mt8">বিস্তারিত ছবিসহ নিয়ম GitHub-এর README-তে আছে।</p></details>' +
    '</form>' +
    '<div class="card"><h2>আগে ঘুরে দেখতে চান?</h2><p>নমুনা ডাটা দিয়ে অ্যাপটা চালিয়ে দেখুন। ডেমোতে যা লিখবেন তা শুধু এই ফোনে থাকবে।</p><button class="btn ghost" data-action="demo">ডেমো চালু করুন</button></div>' +
    '</div>';
}

/* ================= home ================= */
function viewHome() {
  if (!ui.month) { const n = new Date(); ui.month = { y: n.getFullYear(), m: n.getMonth() }; }
  const st = periodStats(ui.month);
  const costs = st.cogs + st.expTotal + st.courier;
  const base = Math.max(st.revenue, costs, 1);
  const w = (x) => Math.max(0, (x / base) * 100).toFixed(1) + '%';
  const active = D.orders.filter((o) => ACTIVE.indexOf(o.status) > -1);
  const low = D.products.filter((p) => p.status !== 'ok');
  let h = topBar();
  h += '<div class="wrap flex" style="justify-content:space-between">' + monthSwitch(ui.month, 'home') + '<button class="chip" data-action="toggle-year" aria-pressed="' + (ui.month.m === null) + '">সারা বছর</button></div>';
  h += '<section class="hero" aria-label="এই সময়ের লাভ"><p class="hero-label">' + (st.net >= 0 ? 'নিট লাভ' : 'নিট লস') + ', ' + periodLabel(ui.month) + '</p>' +
    '<div class="hero-num' + (st.net < 0 ? ' neg' : '') + '">' + tk(st.net) + '</div>' +
    '<p class="hero-sub">মোট বিক্রি ' + tk(st.revenue) + (st.revenue ? ', লাভের হার ' + pct(st.margin) : '') + '</p>' +
    '<div class="takabar" role="img" aria-label="টাকা কোথায় গেল"><i class="c1" style="width:' + w(st.cogs) + '"></i><i class="c2" style="width:' + w(st.expTotal + st.courier) + '"></i><i class="c3" style="width:' + w(Math.max(st.net, 0)) + '"></i></div>' +
    '<div class="takakey"><span><i class="dot" style="background:#FFD9E6"></i>পণ্যের দাম <b>' + tk(st.cogs) + '</b></span><span><i class="dot" style="background:var(--sun)"></i>খরচ ও কুরিয়ার <b>' + tk(st.expTotal + st.courier) + '</b></span><span><i class="dot" style="background:#7FE0CB"></i>লাভ <b>' + tk(Math.max(st.net, 0)) + '</b></span></div></section>';
  h += '<div class="stats"><div class="stat"><b>' + nbn(st.orders) + '</b><span>অর্ডার</span></div><div class="stat"><b>' + nbn(st.delivered) + '</b><span>ডেলিভারড</span></div><div class="stat"><b>' + pct(st.returnRate) + '</b><span>রিটার্ন রেট</span></div><div class="stat"><b>' + tk(st.aov) + '</b><span>গড় অর্ডার</span></div></div>';

  h += '<div class="wrap"><div class="section"><div class="quick">' +
    '<a class="qa" href="#new"><span class="qi" style="background:var(--rasp-soft);color:var(--rasp)">' + ICON.plus + '</span>নতুন অর্ডার</a>' +
    '<button class="qa" data-action="add-expense"><span class="qi" style="background:var(--sun-soft);color:#946200">' + ICON.wallet + '</span>খরচ লিখুন</button>' +
    '<button class="qa" data-action="add-stock"><span class="qi" style="background:var(--teal-soft);color:var(--teal)">' + ICON.stockin + '</span>মাল কেনা</button>' +
    '</div></div>';

  if (low.length) {
    h += '<div class="section">' + alertBox('', '<b>' + nbn(low.length) + 'টা প্রোডাক্টের স্টক কম।</b> ' + low.slice(0, 3).map((p) => esc(p.name) + ' (' + nbn(p.stock) + ')').join(', '), '<a class="btn sm ghost" href="#products">দেখুন</a>') + '</div>';
  }

  h += '<div class="section"><div class="section-h"><h2>চলমান অর্ডার</h2><a href="#orders">সব অর্ডার</a></div>';
  h += active.length ? '<div class="olist">' + active.slice(0, 5).map(orderCard).join('') + '</div>' : '<div class="list"><div class="empty"><b>কোনো চলমান অর্ডার নেই</b>নতুন অর্ডার এলে নিচের + বাটনে চাপুন।</div></div>';
  h += '</div>';

  h += '<div class="section"><div class="section-h"><h2>মাসভিত্তিক বিক্রি ও লাভ</h2><span class="small muted">' + bn(ui.month.y) + '</span></div>' + yearChart(ui.month.y) + '</div>';
  h += '<div class="section"><div class="section-h"><h2>খরচ কোথায় গেল</h2></div>' + expenseBars(st.byCat) + '</div>';
  if (st.top.length) {
    h += '<div class="section"><div class="section-h"><h2>সবচেয়ে বেশি বিক্রি</h2></div><div class="list">' + st.top.map((t, i) =>
      '<div class="row"><div class="avatar ' + avatarTone(t.name) + '">' + bn(i + 1) + '</div><div class="main"><div class="t">' + esc(t.name) + '</div><div class="s">' + nbn(t.qty) + ' পিস বিক্রি</div></div><div class="r"><div class="amt pos">' + tk(t.profit) + '</div><div class="s small muted">লাভ</div></div></div>').join('') + '</div></div>';
  }
  h += '<div class="section"><div class="kv">' +
    '<div><span>পণ্য বিক্রি (ছাড় বাদে)</span><b>' + tk(st.sales) + '</b></div>' +
    '<div><span>ডেলিভারি চার্জ পেয়েছেন</span><b>' + tk(st.deliveryIn) + '</b></div>' +
    '<div><span>পণ্যের কেনা দাম</span><b>' + tk(-st.cogs) + '</b></div>' +
    '<div><span>সব খরচ (কুরিয়ারসহ)</span><b>' + tk(-(st.expTotal + st.courier)) + '</b></div>' +
    '<div class="total"><span>নিট লাভ</span><b>' + tk(st.net) + '</b></div>' +
    '<div><span>এই সময়ে নতুন কাস্টমার</span><b>' + nbn(st.newCust) + ' জন</b></div>' +
    '<div><span>মাল কেনায় খরচ</span><b>' + tk(st.stockBuy) + '</b></div>' +
    '</div></div>';
  h += '</div>';
  return h;
}

function yearChart(y) {
  const data = [];
  for (let m = 0; m < 12; m++) { const s = periodStats({ y, m }); data.push({ m, rev: s.revenue, net: s.net }); }
  const max = Math.max(1, ...data.map((d) => Math.max(d.rev, d.net)));
  const minNet = Math.min(0, ...data.map((d) => d.net));
  const W = 340, H = 170, top = 10, bottom = 26, left = 4;
  const span = max - minNet;
  const yv = (v) => top + (max - v) / span * (H - top - bottom);
  const zero = yv(0);
  const bw = (W - left * 2) / 12;
  let bars = '';
  data.forEach((d, i) => {
    const x = left + i * bw;
    const sel = ui.month && ui.month.m === d.m && ui.month.y === y;
    if (d.rev > 0) bars += '<rect x="' + (x + bw * 0.14).toFixed(1) + '" y="' + yv(d.rev).toFixed(1) + '" width="' + (bw * 0.72).toFixed(1) + '" height="' + (zero - yv(d.rev)).toFixed(1) + '" rx="5" fill="' + (sel ? '#F7B6CE' : '#FBD8E5') + '"/>';
    if (d.net !== 0) {
      const y1 = d.net > 0 ? yv(d.net) : zero, hh = Math.abs(yv(d.net) - zero);
      bars += '<rect x="' + (x + bw * 0.32).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + (bw * 0.36).toFixed(1) + '" height="' + Math.max(hh, 1.5).toFixed(1) + '" rx="3" fill="' + (d.net >= 0 ? '#0B7A6A' : '#D33A2C') + '"/>';
    }
    bars += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="' + (sel ? '#C2185B' : '#8E7488') + '" font-weight="' + (sel ? 700 : 500) + '">' + MONTHS_S[i] + '</text>';
  });
  return '<div class="chart"><div class="legend"><span><i class="dot" style="background:#FBD8E5"></i>বিক্রি</span><span><i class="dot" style="background:#0B7A6A"></i>নিট লাভ</span></div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + bn(y) + ' সালের মাসভিত্তিক বিক্রি ও লাভ"><line x1="0" x2="' + W + '" y1="' + zero.toFixed(1) + '" y2="' + zero.toFixed(1) + '" stroke="#F1DDE6"/>' + bars + '</svg></div>';
}

function expenseBars(byCat) {
  const entries = Object.entries(byCat).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<div class="list"><div class="empty"><b>এই সময়ে কোনো খরচ লেখা নেই</b>খরচ হলে "খরচ লিখুন" বাটনে চাপুন।</div></div>';
  const max = entries[0][1];
  return '<div class="hbars">' + entries.map((e) => '<div class="hbar"><span>' + esc(e[0]) + '</span><div class="track"><i style="width:' + (e[1] / max * 100).toFixed(1) + '%"></i></div><b>' + tk(e[1]) + '</b></div>').join('') + '</div>';
}

function orderCard(o) {
  const name = o.customer ? o.customer.name : 'অজানা কাস্টমার';
  return '<button class="ocard" data-action="open-order" data-id="' + esc(o.id) + '"><div class="avatar ' + avatarTone(name) + '">' + esc(initial(name)) + '</div>' +
    '<div class="main"><div class="t">' + esc(name) + '</div><div class="s"><span class="oid">' + esc(o.id) + '</span> ' + fmtDate(o.date) + ', ' + nbn(o.pcs) + ' পিস</div></div>' +
    '<div class="r"><span class="amt">' + tk(o.grand) + '</span>' + statusPill(o.status) + '</div></button>';
}

/* ================= orders ================= */
function viewOrders() {
  const f = ui.orderFilter, q = ui.orderQuery.trim().toLowerCase();
  const counts = { all: D.orders.length, active: D.orders.filter((o) => ACTIVE.indexOf(o.status) > -1).length };
  D.settings.statuses.forEach((s) => { counts[s] = D.orders.filter((o) => o.status === s).length; });
  let list = D.orders.filter((o) => f === 'all' ? true : f === 'active' ? ACTIVE.indexOf(o.status) > -1 : o.status === f);
  if (q) list = list.filter((o) => (o.id + ' ' + o.mobile + ' ' + (o.customer ? o.customer.name + ' ' + o.customer.district : '')).toLowerCase().indexOf(q) > -1);
  const chip = (k, label) => '<button class="chip" data-action="order-filter" data-f="' + k + '" aria-pressed="' + (f === k) + '">' + label + '<span class="n">' + nbn(counts[k] || 0) + '</span></button>';
  let h = pageHead('অর্ডার', null, '<button class="icon-btn" data-action="refresh" aria-label="রিফ্রেশ">' + ICON.refresh + '</button>');
  h += '<div class="wrap"><label class="search">' + ICON.search + '<span class="sr">খুঁজুন</span><input data-input="order-q" value="' + esc(ui.orderQuery) + '" placeholder="নাম, মোবাইল বা Order ID"></label>';
  h += '<div class="chips scroll mt12">' + chip('active', 'চলমান') + chip('all', 'সব') + D.settings.statuses.map((s) => chip(s, STATUS_BN[s] || s)).join('') + '</div>';
  h += '<div class="olist mt12">' + (list.length ? list.slice(0, 200).map(orderCard).join('') : '<div class="list"><div class="empty"><b>কোনো অর্ডার পাওয়া যায়নি</b>অন্য ফিল্টার বা নাম দিয়ে খুঁজে দেখুন।</div></div>') + '</div></div>';
  return h;
}

function orderSummary(o) {
  const c = o.customer || {};
  let t = '*Baby Dukkan ❤️ অর্ডার সামারি*\n\n';
  t += '*Order ID:* ' + o.id + '\n';
  t += '*Customer Name:* ' + (c.name || '') + '\n*Mobile:* ' + o.mobile + '\n*Address:* ' + [c.address, c.district].filter(Boolean).join(', ') + '\n\n';
  t += '*অর্ডারের বিবরণ:*\n\n';
  o.items.forEach((i, k) => {
    const q = num(i.qty), u = num(i.unitPrice);
    t += bn(k + 1) + '. ' + i.product + ' — ' + (q > 1 ? tkPlain(u) + ' × ' + bn(q) + ' = ' : '') + tkPlain(q * u) + ' টাকা\n';
  });
  t += '\n*Product Total:* ' + tkPlain(o.productTotal) + ' টাকা\n';
  if (num(o.discount)) t += '*Discount:* ' + tkPlain(num(o.discount)) + ' টাকা\n';
  t += '*Delivery Charge:* ' + tkPlain(num(o.delivery)) + ' টাকা\n\n';
  t += '*সর্বমোট পরিশোধযোগ্য: ' + tkPlain(o.grand) + ' টাকা*\n\n';
  t += '*Payment Method:* ' + (o.payment || 'Cash on Delivery (COD)');
  return t;
}

function openOrder(id) {
  const o = D.orders.find((x) => x.id === id);
  if (!o) return;
  const c = o.customer || {};
  const s = D.settings;
  let h = '<div class="flex"><h2 class="grow">' + esc(c.name || 'অজানা কাস্টমার') + '</h2>' + statusPill(o.status) + '</div>';
  h += '<p class="sub"><span class="oid">' + esc(o.id) + '</span> ' + fmtDateLong(o.date) + '</p>';
  h += '<div class="small">' + esc(o.mobile) + (c.address ? '<br>' + esc([c.address, c.district].filter(Boolean).join(', ')) : '') + '</div>';
  h += '<div class="contact"><a class="call" href="tel:' + esc(o.mobile) + '">' + ICON.phone + 'কল করুন</a><a class="wa" href="' + waLink(o.mobile) + '" target="_blank" rel="noopener">' + ICON.wa + 'WhatsApp</a></div>';
  h += '<div class="kv">' + o.items.map((i) => '<div><span>' + esc(i.product) + ' × ' + nbn(i.qty) + '</span><b>' + tk(num(i.qty) * num(i.unitPrice)) + '</b></div>').join('') +
    (num(o.discount) ? '<div><span>ছাড়</span><b>' + tk(-num(o.discount)) + '</b></div>' : '') +
    '<div><span>ডেলিভারি চার্জ</span><b>' + tk(num(o.delivery)) + '</b></div>' +
    '<div class="total"><span>সর্বমোট</span><b>' + tk(o.grand) + '</b></div>' +
    (o.profit !== null ? '<div><span>এই অর্ডারে ' + (o.profit >= 0 ? 'লাভ' : 'লস') + '</span><b class="' + (o.profit >= 0 ? 'pos' : 'neg') + '">' + tk(o.profit) + '</b></div>' : '') + '</div>';
  h += '<form data-form="update-order" data-id="' + esc(o.id) + '">';
  h += '<div class="field"><span class="lbl">স্ট্যাটাস বদলান</span><div class="chips">' + s.statuses.map((x) => '<button type="button" class="chip" data-action="pick" data-group="status" data-v="' + esc(x) + '" aria-pressed="' + (o.status === x) + '">' + (STATUS_BN[x] || esc(x)) + '</button>').join('') + '</div><input type="hidden" name="status" value="' + esc(o.status) + '"></div>';
  h += '<div class="field"><span class="lbl">কুরিয়ার</span><div class="chips">' + s.couriers.map((x) => '<button type="button" class="chip" data-action="pick" data-group="courier" data-v="' + esc(x) + '" aria-pressed="' + (o.courier === x) + '">' + esc(x) + '</button>').join('') + '</div><input type="hidden" name="courier" value="' + esc(o.courier) + '"></div>';
  h += '<div class="grid2"><div class="field"><label for="u-cc">কুরিয়ার + COD খরচ</label><div class="money-in"><input class="inp" id="u-cc" name="courierCost" inputmode="numeric" value="' + (num(o.courierCost) || '') + '" placeholder="0"></div></div>' +
    '<div class="field"><label for="u-tr">Tracking ID</label><input class="inp" id="u-tr" name="tracking" value="' + esc(o.tracking) + '"></div></div>';
  h += '<p class="small muted" style="margin-top:-6px">ডেলিভারি বা রিটার্ন হলে কুরিয়ার যা কেটেছে সেটা লিখুন, তাহলে লাভ ঠিক দেখাবে।</p>';
  h += '<button class="btn mt12" type="submit">আপডেট সেভ করুন</button></form>';
  h += '<div class="btn-row mt12"><button class="btn ghost" data-action="copy-summary" data-id="' + esc(o.id) + '">' + ICON.copy + 'সামারি কপি</button><a class="btn ghost" href="' + waLink(o.mobile, orderSummary(o)) + '" target="_blank" rel="noopener">' + ICON.wa + 'পাঠান</a></div>';
  openSheet(h);
}

/* ================= new order ================= */
function newDraft() {
  return { query: '', mobile: '', found: null, editCust: false, name: '', address: '', district: '', source: D.settings.sources[0] || '', lines: {}, special: {}, delivery: 70, deliveryMode: '70', discount: '', payment: D.settings.payments[0] || '', status: 'Pending', date: todayISO(), notes: '', saving: false };
}
function viewNewOrder() {
  if (!ui.draft) ui.draft = newDraft();
  const d = ui.draft, s = D.settings;
  let h = pageHead('নতুন অর্ডার', 'home', '<button class="btn sm ghost" data-action="reset-draft">মুছে ফেলুন</button>');
  h += '<div class="wrap new-page">';
  // step 1 customer
  h += '<section class="step"><div class="step-h"><span class="n">১</span><h2>কাস্টমার</h2></div><div id="cust-box"></div></section>';
  // step 2 products
  h += '<section class="step"><div class="step-h"><span class="n">২</span><h2>প্রোডাক্ট</h2></div><div class="ptiles" id="ptiles"></div><div id="lines"></div></section>';
  // step 3 delivery
  h += '<section class="step"><div class="step-h"><span class="n">৩</span><h2>ডেলিভারি ও পেমেন্ট</h2></div>' +
    '<div class="field"><span class="lbl">ডেলিভারি চার্জ</span><div class="chips">' +
    [['70', 'ঢাকার ভিতরে ৳৭০'], ['125', 'ঢাকার বাইরে ৳১২৫'], ['0', 'ফ্রি'], ['custom', 'অন্য']].map((x) => '<button type="button" class="chip" data-action="deliv" data-v="' + x[0] + '" aria-pressed="' + (d.deliveryMode === x[0]) + '">' + x[1] + '</button>').join('') +
    '</div><div class="money-in mt8" id="deliv-custom" ' + (d.deliveryMode === 'custom' ? '' : 'hidden') + '><input class="inp" data-draft="delivery" inputmode="numeric" value="' + esc(d.delivery) + '" aria-label="ডেলিভারি চার্জ"></div></div>' +
    '<div class="grid2"><div class="field"><label for="n-disc">ছাড় (পুরো অর্ডারে)</label><div class="money-in"><input class="inp" id="n-disc" data-draft="discount" inputmode="numeric" value="' + esc(d.discount) + '" placeholder="0"></div></div>' +
    '<div class="field"><label for="n-date">তারিখ</label><input class="inp" id="n-date" type="date" data-draft="date" value="' + esc(d.date) + '"></div></div>' +
    '<div class="field"><span class="lbl">পেমেন্ট</span><div class="chips">' + s.payments.map((x) => '<button type="button" class="chip" data-action="draft-pick" data-k="payment" data-v="' + esc(x) + '" aria-pressed="' + (d.payment === x) + '">' + esc(x) + '</button>').join('') + '</div></div>' +
    '<div class="field"><span class="lbl">স্ট্যাটাস</span><div class="chips">' + ['Pending', 'Confirmed'].map((x) => '<button type="button" class="chip" data-action="draft-pick" data-k="status" data-v="' + x + '" aria-pressed="' + (d.status === x) + '">' + STATUS_BN[x] + '</button>').join('') + '</div></div>' +
    '<div class="field"><label for="n-notes">নোট (ঐচ্ছিক)</label><input class="inp" id="n-notes" data-draft="notes" value="' + esc(d.notes) + '" placeholder="যেমন: বিকেলে ডেলিভারি দিতে বলেছেন"></div>' +
    '</section>';
  h += '</div>';
  h += '<div class="receipt"><div class="tot"><small id="r-sub"></small><b id="r-tot"></b></div><button class="btn" data-action="save-order" id="save-order">অর্ডার সেভ করুন</button></div>';
  return h;
}

function mountNewOrder() { renderCustBox(); renderTiles(); renderLines(); updateReceipt(); }

function renderCustBox() {
  const d = ui.draft, box = document.getElementById('cust-box');
  if (!box) return;
  let h = '<div class="field"><label for="n-q">মোবাইল নম্বর বা নাম</label><input class="inp" id="n-q" data-draft="query" inputmode="text" autocomplete="off" value="' + esc(d.query) + '" placeholder="01XXXXXXXXX"></div>';
  if (d.found) {
    const c = D.C[d.found];
    h += '<div class="found"><div class="avatar ' + avatarTone(c.name) + '">' + esc(initial(c.name)) + '</div><div class="main"><div class="t">' + esc(c.name) + ' ' + typePill(c.type) + '</div><div class="s">' + esc([c.address, c.district].filter(Boolean).join(', ')) + '</div><div class="s">আগে ' + nbn(c.total) + 'টা অর্ডার, মোট ' + tk(c.spent) + '</div></div>' +
      '<button class="btn sm ghost" data-action="edit-cust" type="button">' + ICON.edit + '</button></div>';
    if (c.type === 'Risky') h += '<div class="mt8">' + alertBox('err', 'এই কাস্টমার আগে ' + nbn(c.returned) + 'বার অর্ডার ফেরত দিয়েছেন। অগ্রিম ডেলিভারি চার্জ নিতে পারেন।') + '</div>';
  }
  if (d.found && !d.editCust) { box.innerHTML = h; return; }
  const digits = d.query.replace(/[^0-9]/g, '');
  const isPhone = digits.length >= 3 && /^[0-9+\s-]+$/.test(d.query.trim());
  if (!d.found) {
    const q = d.query.trim().toLowerCase();
    if (q.length >= 2) {
      const matches = D.customers.filter((c) => isPhone ? c.mobile.indexOf(digits) > -1 : c.name.toLowerCase().indexOf(q) > -1).slice(0, 4);
      if (matches.length && !(isPhone && digits.length === 11)) {
        h += '<div class="list sugg">' + matches.map((c) => '<button type="button" class="row" data-action="pick-cust" data-m="' + esc(c.mobile) + '"><div class="avatar ' + avatarTone(c.name) + '">' + esc(initial(c.name)) + '</div><div class="main"><div class="t">' + esc(c.name) + '</div><div class="s">' + esc(c.mobile) + ', ' + esc(c.district) + '</div></div>' + typePill(c.type) + '</button>').join('') + '</div>';
      }
    }
  }
  const showForm = d.editCust || (isPhone && mobileNorm(digits).length === 11 && !d.found);
  if (showForm) {
    h += '<div class="mt12">' + (d.found ? '<p class="small muted" style="margin:0 0 8px">কাস্টমারের তথ্য বদলান</p>' : '<p class="small" style="margin:0 0 8px"><b>নতুন কাস্টমার।</b> নাম আর ঠিকানা দিন, অর্ডারের সাথে সেভ হয়ে যাবে।</p>') +
      '<div class="field"><label for="n-name">নাম</label><input class="inp" id="n-name" data-draft="name" value="' + esc(d.name) + '"></div>' +
      '<div class="field"><label for="n-addr">ঠিকানা</label><input class="inp" id="n-addr" data-draft="address" value="' + esc(d.address) + '"></div>' +
      '<div class="field"><label for="n-dist">জেলা / এলাকা</label><input class="inp" id="n-dist" data-draft="district" value="' + esc(d.district) + '"></div>' +
      '<div class="field"><span class="lbl">কোথা থেকে এসেছেন</span><div class="chips">' + D.settings.sources.map((x) => '<button type="button" class="chip" data-action="draft-pick" data-k="source" data-v="' + esc(x) + '" aria-pressed="' + (d.source === x) + '">' + esc(x) + '</button>').join('') + '</div></div></div>';
  } else if (!d.found && isPhone && digits.length > 0 && digits.length < 11) {
    h += '<p class="small muted" style="margin:-6px 0 0">' + bn(11 - mobileNorm(digits).length > 0 ? 11 - mobileNorm(digits).length : 0) + ' ডিজিট বাকি</p>';
  }
  box.innerHTML = h;
}

function renderTiles() {
  const el = document.getElementById('ptiles');
  if (!el) return;
  const d = ui.draft;
  if (!D.products.length) { el.innerHTML = '<div class="empty" style="grid-column:1/-1"><b>কোনো প্রোডাক্ট নেই</b><a href="#products">আগে প্রোডাক্ট যোগ করুন</a></div>'; return; }
  el.innerHTML = D.products.map((p) => {
    const q = d.lines[p.name] || 0;
    const low = p.stock <= D.settings.lowStock;
    return '<div class="ptile' + (q ? ' on' : '') + '"><span class="pn">' + esc(p.name) + '</span><span class="pp">' + tk(p.sell) + '</span><span class="ps' + (low ? ' low' : '') + '">স্টক ' + nbn(p.stock) + '</span>' +
      (q ? '<div class="stepper"><button type="button" data-action="qty" data-p="' + esc(p.name) + '" data-d="-1" aria-label="কমান">−</button><span class="q">' + bn(q) + '</span><button type="button" data-action="qty" data-p="' + esc(p.name) + '" data-d="1" aria-label="বাড়ান">+</button></div>'
         : '<button type="button" class="add" data-action="qty" data-p="' + esc(p.name) + '" data-d="1">+ যোগ করুন</button>') + '</div>';
  }).join('');
}

function draftLines() {
  const d = ui.draft;
  return Object.keys(d.lines).filter((k) => d.lines[k] > 0 && D.P[k]).map((k) => {
    const sp = d.special[k];
    const unit = sp !== undefined && sp !== '' ? num(sp) : D.P[k].sell;
    return { product: k, qty: d.lines[k], unit, special: sp !== undefined && sp !== '' ? num(sp) : '' };
  });
}

function renderLines() {
  const el = document.getElementById('lines');
  if (!el) return;
  const ls = draftLines();
  if (!ls.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="lines">' + ls.map((l) => {
    const editing = ui.draft.special[l.product] !== undefined;
    return '<div class="line"><span class="ln">' + esc(l.product) + ' × ' + bn(l.qty) + '</span>' +
      (editing ? '<input inputmode="numeric" data-special="' + esc(l.product) + '" value="' + esc(ui.draft.special[l.product]) + '" placeholder="' + D.P[l.product].sell + '" aria-label="প্রতি পিসের দাম">'
               : '<button type="button" class="edit" data-action="special" data-p="' + esc(l.product) + '">দাম বদলান</button>') +
      '<span class="lp">' + tk(l.unit * l.qty) + '</span></div>';
  }).join('') + '</div>';
}

function draftTotals() {
  const d = ui.draft, ls = draftLines();
  const pt = sum(ls, (l) => l.unit * l.qty);
  const pcs = sum(ls, (l) => l.qty);
  const grand = pt - num(d.discount) + num(d.delivery);
  return { pt, pcs, grand, ls };
}
function updateReceipt() {
  const t = draftTotals();
  const sub = document.getElementById('r-sub'), tot = document.getElementById('r-tot');
  if (!sub) return;
  sub.textContent = t.pcs ? bn(t.pcs) + ' পিস, ডেলিভারিসহ' : 'প্রোডাক্ট যোগ করুন';
  tot.textContent = tk(t.grand);
}

async function saveOrder() {
  const d = ui.draft;
  if (d.saving) return;
  const t = draftTotals();
  const mobile = d.found || mobileNorm(d.query);
  if (mobile.length !== 11) return toast('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন', true);
  if (!d.found && !d.name.trim()) return toast('কাস্টমারের নাম দিন', true);
  if (!t.ls.length) return toast('অন্তত একটা প্রোডাক্ট যোগ করুন', true);
  const payload = {
    date: d.date || todayISO(), mobile, discount: num(d.discount), delivery: num(d.delivery), payment: d.payment, status: d.status, notes: d.notes,
    items: t.ls.map((l) => ({ product: l.product, qty: l.qty, special: l.special }))
  };
  if (!d.found || d.editCust) payload.customer = { name: d.name.trim(), address: d.address.trim(), district: d.district.trim(), source: d.source, update: !!d.found };
  d.saving = true;
  const btn = document.getElementById('save-order');
  if (btn) { btn.disabled = true; btn.textContent = 'সেভ হচ্ছে...'; }
  try {
    const res = await apiPost('addOrder', payload);
    ui.draft = null;
    await loadData(true);
    const o = D.orders.find((x) => x.id === res.id);
    if (o) ui.afterNav = () => showSaved(o);
    if (location.hash === '#home') { render(); if (ui.afterNav) { const f = ui.afterNav; ui.afterNav = null; f(); } } else go('home');
  } catch (e) {
    d.saving = false;
    if (btn) { btn.disabled = false; btn.textContent = 'অর্ডার সেভ করুন'; }
    toast(e.message || 'সেভ করা যায়নি', true);
  }
}

function showSaved(o) {
  const text = orderSummary(o);
  openSheet('<div class="success"><div class="tick">' + ICON.check + '</div><h2>অর্ডার সেভ হয়েছে</h2><p class="sub"><span class="oid">' + esc(o.id) + '</span> ' + esc(o.customer ? o.customer.name : '') + ', ' + tk(o.grand) + '</p></div>' +
    '<div class="summary">' + esc(text) + '</div>' +
    '<div class="btn-row"><button class="btn ghost" data-action="copy-summary" data-id="' + esc(o.id) + '">' + ICON.copy + 'কপি করুন</button><a class="btn wa" href="' + waLink(o.mobile, text) + '" target="_blank" rel="noopener">' + ICON.wa + 'WhatsApp-এ পাঠান</a></div>' +
    '<a class="btn mt12" href="#new">আরেকটা অর্ডার</a>');
}

/* ================= customers ================= */
function viewCustomers() {
  const f = ui.custFilter, q = ui.custQuery.trim().toLowerCase();
  const filters = [['all', 'সব'], ['VIP', 'VIP'], ['Repeat', 'Repeat'], ['New', 'New'], ['Risky', 'Risky'], ['idle', '৬০+ দিন কেনেননি']];
  const test = (c, k) => k === 'all' ? true : k === 'idle' ? (c.days !== null && c.days > 60) : c.type === k;
  let list = D.customers.filter((c) => test(c, f));
  if (q) list = list.filter((c) => (c.name + ' ' + c.mobile + ' ' + c.district + ' ' + c.address).toLowerCase().indexOf(q) > -1);
  let h = pageHead('কাস্টমার', null, '<button class="btn sm" data-action="new-customer">+ নতুন</button>');
  h += '<div class="wrap"><label class="search">' + ICON.search + '<span class="sr">খুঁজুন</span><input data-input="cust-q" value="' + esc(ui.custQuery) + '" placeholder="নাম, মোবাইল বা জেলা"></label>';
  h += '<div class="chips scroll mt12">' + filters.map((x) => '<button class="chip" data-action="cust-filter" data-f="' + x[0] + '" aria-pressed="' + (f === x[0]) + '">' + x[1] + '<span class="n">' + nbn(D.customers.filter((c) => test(c, x[0])).length) + '</span></button>').join('') + '</div>';
  h += '<div class="list mt12">' + (list.length ? list.slice(0, 300).map((c) =>
    '<button class="row" data-action="open-cust" data-m="' + esc(c.mobile) + '"><div class="avatar ' + avatarTone(c.name) + '">' + esc(initial(c.name)) + '</div><div class="main"><div class="t">' + esc(c.name) + '</div><div class="s">' + esc(c.mobile) + (c.district ? ', ' + esc(c.district) : '') + '</div></div><div class="r"><div class="amt">' + tk(c.spent) + '</div>' + typePill(c.type) + '</div></button>').join('')
    : '<div class="empty"><b>কোনো কাস্টমার পাওয়া যায়নি</b>অন্য নাম বা ফিল্টার দিয়ে খুঁজুন।</div>') + '</div></div>';
  return h;
}

function openCustomer(m) {
  const c = D.C[m];
  if (!c) return;
  let h = '<div class="flex"><div class="avatar ' + avatarTone(c.name) + '" style="width:54px;height:54px;font-size:24px">' + esc(initial(c.name)) + '</div><div class="grow"><h2>' + esc(c.name) + '</h2><div>' + typePill(c.type) + '</div></div></div>';
  h += '<p class="small mt8" style="margin-bottom:0">' + esc(c.mobile) + '<br>' + esc([c.address, c.district].filter(Boolean).join(', ')) + (c.source ? '<br><span class="muted">এসেছেন: ' + esc(c.source) + '</span>' : '') + '</p>';
  h += '<div class="contact"><a class="call" href="tel:' + esc(c.mobile) + '">' + ICON.phone + 'কল করুন</a><a class="wa" href="' + waLink(c.mobile) + '" target="_blank" rel="noopener">' + ICON.wa + 'WhatsApp</a></div>';
  h += '<div class="kv"><div><span>মোট অর্ডার</span><b>' + nbn(c.total) + '</b></div><div><span>ডেলিভারড / রিটার্ন</span><b>' + nbn(c.delivered) + ' / ' + nbn(c.returned) + '</b></div><div><span>মোট কিনেছেন</span><b>' + tk(c.spent) + '</b></div><div><span>শেষ অর্ডার</span><b>' + (c.last ? fmtDateLong(c.last) + ' (' + nbn(c.days) + ' দিন আগে)' : 'নেই') + '</b></div></div>';
  if (c.orders.length) h += '<div class="olist">' + c.orders.slice(0, 20).map(orderCard).join('') + '</div>';
  h += '<div class="btn-row mt16"><button class="btn ghost" data-action="edit-customer" data-m="' + esc(c.mobile) + '">' + ICON.edit + 'তথ্য বদলান</button><a class="btn" href="#new" data-action="order-for" data-m="' + esc(c.mobile) + '">নতুন অর্ডার</a></div>';
  openSheet(h);
}

function customerForm(c) {
  const s = D.settings, isNew = !c;
  c = c || { mobile: '', name: '', address: '', district: '', source: s.sources[0] || '', notes: '' };
  openSheet('<h2>' + (isNew ? 'নতুন কাস্টমার' : 'কাস্টমারের তথ্য') + '</h2><p class="sub">মোবাইল নম্বরই কাস্টমারের পরিচয়।</p>' +
    '<form data-form="customer" data-new="' + (isNew ? 1 : 0) + '">' +
    '<div class="field"><label for="cf-m">মোবাইল</label><input class="inp" id="cf-m" name="mobile" inputmode="tel" value="' + esc(c.mobile) + '" ' + (isNew ? 'required' : 'readonly') + ' placeholder="01XXXXXXXXX"></div>' +
    '<div class="field"><label for="cf-n">নাম</label><input class="inp" id="cf-n" name="name" value="' + esc(c.name) + '" required></div>' +
    '<div class="field"><label for="cf-a">ঠিকানা</label><input class="inp" id="cf-a" name="address" value="' + esc(c.address) + '"></div>' +
    '<div class="field"><label for="cf-d">জেলা / এলাকা</label><input class="inp" id="cf-d" name="district" value="' + esc(c.district) + '"></div>' +
    '<div class="field"><span class="lbl">কোথা থেকে এসেছেন</span><div class="chips">' + s.sources.map((x) => '<button type="button" class="chip" data-action="pick" data-group="source" data-v="' + esc(x) + '" aria-pressed="' + (c.source === x) + '">' + esc(x) + '</button>').join('') + '</div><input type="hidden" name="source" value="' + esc(c.source) + '"></div>' +
    '<div class="field"><label for="cf-no">নোট</label><input class="inp" id="cf-no" name="notes" value="' + esc(c.notes) + '" placeholder="যেমন: বাচ্চার বয়স ৬ মাস"></div>' +
    '<button class="btn" type="submit">সেভ করুন</button></form>');
}

/* ================= more ================= */
function viewMore() {
  const tile = (href, icon, bg, fg, title, sub, action) => (action ? '<button class="tile" data-action="' + action + '">' : '<a class="tile" href="' + href + '">') +
    '<span class="ti" style="background:' + bg + ';color:' + fg + '">' + icon + '</span><b>' + title + '</b><small>' + sub + '</small>' + (action ? '</button>' : '</a>');
  const low = D.products.filter((p) => p.status !== 'ok').length;
  let h = pageHead('আরও');
  h += '<div class="wrap"><div class="tiles">' +
    tile('#products', ICON.box, 'var(--rasp-soft)', 'var(--rasp)', 'প্রোডাক্ট ও স্টক', nbn(D.products.length) + 'টা প্রোডাক্ট' + (low ? ', ' + nbn(low) + 'টার স্টক কম' : '')) +
    tile('#expenses', ICON.wallet, 'var(--sun-soft)', '#946200', 'খরচ', 'Boost, প্যাকেজিং, যাতায়াত') +
    tile('#stock', ICON.stockin, 'var(--teal-soft)', 'var(--teal)', 'মাল কেনা', 'Stock In এর হিসাব') +
    tile('#calc', ICON.calc, 'var(--lilac-soft)', 'var(--lilac)', 'লাভ ক্যালকুলেটর', 'প্রতি পিসে আসল লাভ') +
    (D.sheetUrl ? '<a class="tile" href="' + esc(D.sheetUrl) + '" target="_blank" rel="noopener"><span class="ti" style="background:var(--sky-soft);color:var(--sky)">' + ICON.sheet + '</span><b>Google Sheet খুলুন</b><small>পুরো হিসাব শিটে দেখুন</small></a>' : '') +
    tile('#settings', ICON.gear, 'var(--grey-soft)', 'var(--ink-2)', 'সেটিংস', 'সংযোগ, রিফ্রেশ') +
    '</div></div>';
  return h;
}

/* ================= products ================= */
function viewProducts() {
  let h = pageHead('প্রোডাক্ট ও স্টক', 'more', '<button class="btn sm" data-action="new-product">+ নতুন</button>');
  const maxStock = Math.max(10, ...D.products.map((p) => p.stock));
  h += '<div class="wrap"><div class="list">' + (D.products.length ? D.products.map((p) => {
    const margin = p.sell ? (p.sell - p.buy) / p.sell : 0;
    return '<button class="row" data-action="edit-product" data-p="' + esc(p.name) + '"><div class="main"><div class="t">' + esc(p.name) + '</div><div class="s">কেনা ' + tk(p.buy) + ', বেচা ' + tk(p.sell) + ', লাভ ' + pct(margin) + '</div>' +
      '<div class="meter"><i class="' + (p.status === 'ok' ? '' : p.status) + '" style="width:' + Math.max(2, Math.min(100, p.stock / maxStock * 100)).toFixed(0) + '%"></i></div></div>' +
      '<div class="r"><div class="amt' + (p.status === 'out' ? ' neg' : '') + '">' + nbn(p.stock) + '</div><div class="s small muted">' + (p.status === 'out' ? 'স্টক নেই' : p.status === 'low' ? 'স্টক কম' : 'স্টকে আছে') + '</div></div></button>';
  }).join('') : '<div class="empty"><b>এখনও কোনো প্রোডাক্ট নেই</b>উপরের + নতুন বাটনে চাপুন।</div>') + '</div>';
  h += '<p class="small muted mt12">স্টক = শুরুর স্টক + মাল কেনা − বিক্রি। বাতিল বা রিটার্ন হওয়া অর্ডার স্টক থেকে বাদ যায় না।</p></div>';
  return h;
}

function productForm(p) {
  const s = D.settings, isNew = !p;
  const nextId = 'P' + String(D.products.length + 1).padStart(3, '0');
  p = p || { id: nextId, name: '', category: s.productCats[0] || '', buy: '', sell: '', opening: '' };
  openSheet('<h2>' + (isNew ? 'নতুন প্রোডাক্ট' : esc(p.name)) + '</h2><p class="sub">' + (isNew ? 'নামটা ঠিকমতো লিখুন, পরে আর বদলানো যাবে না।' : 'দাম বদলালে আগের অর্ডারের হিসাব আগের দামেই থাকবে।') + '</p>' +
    '<form data-form="product" data-orig="' + (isNew ? '' : esc(p.name)) + '">' +
    '<div class="field"><label for="pf-n">প্রোডাক্টের নাম</label><input class="inp" id="pf-n" name="name" value="' + esc(p.name) + '" ' + (isNew ? 'required' : 'readonly') + '></div>' +
    '<div class="field"><span class="lbl">ক্যাটাগরি</span><div class="chips">' + s.productCats.map((x) => '<button type="button" class="chip" data-action="pick" data-group="category" data-v="' + esc(x) + '" aria-pressed="' + (p.category === x) + '">' + esc(x) + '</button>').join('') + '</div><input type="hidden" name="category" value="' + esc(p.category) + '"></div>' +
    '<div class="grid2"><div class="field"><label for="pf-b">কেনা দাম (প্রতি পিস)</label><div class="money-in"><input class="inp" id="pf-b" name="buy" inputmode="numeric" value="' + esc(p.buy) + '" required></div></div>' +
    '<div class="field"><label for="pf-s">বেচা দাম</label><div class="money-in"><input class="inp" id="pf-s" name="sell" inputmode="numeric" value="' + esc(p.sell) + '" required></div></div></div>' +
    '<div class="grid2"><div class="field"><label for="pf-o">শুরুর স্টক</label><input class="inp" id="pf-o" name="opening" inputmode="numeric" value="' + esc(p.opening) + '"></div>' +
    '<div class="field"><label for="pf-i">Product ID</label><input class="inp" id="pf-i" name="id" value="' + esc(p.id) + '"></div></div>' +
    '<button class="btn" type="submit">সেভ করুন</button></form>' +
    (isNew ? '' : '<button class="btn ghost mt12" data-action="calc-for" data-p="' + esc(p.name) + '">' + ICON.calc + 'এই প্রোডাক্টের লাভ হিসাব করুন</button>'));
}

/* ================= expenses ================= */
function viewExpenses() {
  if (!ui.expMonth) { const n = new Date(); ui.expMonth = { y: n.getFullYear(), m: n.getMonth() }; }
  const [from, to] = periodRange(ui.expMonth);
  const list = D.expenses.filter((e) => inRange(e.date, from, to));
  const st = periodStats(ui.expMonth);
  let h = pageHead('খরচ', 'more', '<button class="btn sm" data-action="add-expense">+ খরচ</button>');
  h += '<div class="wrap">' + monthSwitch(ui.expMonth, 'exp');
  h += '<div class="kv"><div class="total"><span>এই মাসের মোট খরচ</span><b>' + tk(st.expTotal) + '</b></div><div><span>কুরিয়ার + COD (অর্ডার থেকে)</span><b>' + tk(st.courier) + '</b></div></div>';
  h += expenseBars(st.byCat);
  h += '<div class="list mt12">' + (list.length ? list.map((e) => '<div class="row"><div class="main"><div class="t">' + esc(e.desc || e.category) + '</div><div class="s">' + esc(e.category) + ', ' + fmtDate(e.date) + (e.paidVia ? ', ' + esc(e.paidVia) : '') + '</div></div><div class="amt">' + tk(num(e.amount)) + '</div></div>').join('')
    : '<div class="empty"><b>এই মাসে কোনো খরচ লেখা নেই</b>উপরের + খরচ বাটনে চাপুন।</div>') + '</div>';
  h += '<p class="small muted mt12">প্রতি অর্ডারের কুরিয়ার ও COD চার্জ অর্ডারের ভেতরে লিখুন, এখানে নয়। নাহলে খরচ দুবার যোগ হবে।</p></div>';
  return h;
}

function expenseForm() {
  const s = D.settings;
  openSheet('<h2>খরচ লিখুন</h2><p class="sub">কোন খাতে কত টাকা খরচ হলো।</p><form data-form="expense">' +
    '<div class="field"><label for="ef-a">টাকা</label><div class="money-in big"><input class="inp big" id="ef-a" name="amount" inputmode="numeric" required placeholder="0"></div></div>' +
    '<div class="field"><span class="lbl">ক্যাটাগরি</span><div class="chips">' + s.expenseCats.map((x) => '<button type="button" class="chip" data-action="pick" data-group="category" data-v="' + esc(x) + '" aria-pressed="false" title="' + esc(CAT_BN[x] || '') + '">' + esc(x) + '</button>').join('') + '</div><input type="hidden" name="category" value=""><div class="hint" id="cat-hint">ক্যাটাগরি বাছলে এখানে বোঝানো থাকবে কী কী পড়ে।</div></div>' +
    '<div class="field"><label for="ef-d">কী খরচ</label><input class="inp" id="ef-d" name="desc" placeholder="যেমন: Facebook Boost ৭ দিন"></div>' +
    '<div class="grid2"><div class="field"><label for="ef-dt">তারিখ</label><input class="inp" id="ef-dt" type="date" name="date" value="' + todayISO() + '"></div>' +
    '<div class="field"><label for="ef-p">কীভাবে দিলেন</label><select class="inp" id="ef-p" name="paidVia">' + s.payments.filter((x) => x.indexOf('COD') === -1).map((x) => '<option>' + esc(x) + '</option>').join('') + '</select></div></div>' +
    '<button class="btn" type="submit">খরচ সেভ করুন</button></form>');
}

/* ================= stock in ================= */
function viewStock() {
  let h = pageHead('মাল কেনা', 'more', '<button class="btn sm" data-action="add-stock">+ মাল কেনা</button>');
  h += '<div class="wrap"><div class="list">' + (D.stock.length ? D.stock.slice(0, 200).map((x) => '<div class="row"><div class="main"><div class="t">' + esc(x.product) + ' × ' + nbn(x.qty) + '</div><div class="s">' + fmtDateLong(x.date) + (x.supplier ? ', ' + esc(x.supplier) : '') + '</div></div><div class="r"><div class="amt">' + tk(num(x.qty) * num(x.price)) + '</div><div class="s small muted">' + tk(num(x.price)) + ' করে</div></div></div>').join('')
    : '<div class="empty"><b>এখনও মাল কেনার হিসাব নেই</b>ঢাকা থেকে মাল আনলে + মাল কেনা বাটনে চাপুন।</div>') + '</div>';
  h += '<p class="small muted mt12">যাতায়াত আর কুরিয়ারের খরচ "খরচ" অংশে লিখুন।</p></div>';
  return h;
}

function stockForm() {
  const ps = D.products;
  if (!ps.length) return toast('আগে প্রোডাক্ট যোগ করুন', true);
  openSheet('<h2>মাল কেনা</h2><p class="sub">কোন প্রোডাক্ট কত পিস কিনলেন। স্টক নিজেই বেড়ে যাবে।</p><form data-form="stock">' +
    '<div class="field"><span class="lbl">প্রোডাক্ট</span><div class="chips">' + ps.map((p) => '<button type="button" class="chip" data-action="pick" data-group="product" data-v="' + esc(p.name) + '" data-buy="' + p.buy + '" aria-pressed="false">' + esc(p.name) + '</button>').join('') + '</div><input type="hidden" name="product" value=""></div>' +
    '<div class="grid2"><div class="field"><label for="sf-q">কত পিস</label><input class="inp" id="sf-q" name="qty" inputmode="numeric" required></div>' +
    '<div class="field"><label for="sf-p">প্রতি পিস কেনা দাম</label><div class="money-in"><input class="inp" id="sf-p" name="price" inputmode="numeric" required></div></div></div>' +
    '<div class="grid2"><div class="field"><label for="sf-d">তারিখ</label><input class="inp" id="sf-d" type="date" name="date" value="' + todayISO() + '"></div>' +
    '<div class="field"><label for="sf-s">কোথা থেকে</label><input class="inp" id="sf-s" name="supplier" placeholder="যেমন: ইসলামপুর"></div></div>' +
    '<button class="btn" type="submit">সেভ করুন</button></form>');
}

/* ================= calculator ================= */
const CALC_DEFAULT = { product: '', sell: '', buy: '', batch: 50, perOrder: 1, ordersMonth: 60, returnRate: 10, target: 25,
  trip: 800, courierIn: 300, local: 100, inventory: 100, packaging: 15, marketing: 3000, processing: 10, courier: 130, delivIn: 125, returnLoss: 190, cod: 1, otherFee: 0 };
function calcState() { return Object.assign({}, CALC_DEFAULT, store.get(CALC_KEY, {})); }
function viewCalc() {
  const c = calcState();
  if (!c.product && D.products[0]) c.product = D.products[0].name;
  const s = (k, label, hint, suffix) => '<div class="cost-row"><div class="cl">' + label + (hint ? '<small>' + hint + '</small>' : '') + '</div><input inputmode="decimal" data-calc="' + k + '" value="' + esc(c[k]) + '" aria-label="' + esc(label) + '"' + (suffix ? ' placeholder="' + suffix + '"' : '') + '></div>';
  let h = pageHead('লাভ ক্যালকুলেটর', 'more');
  h += '<div class="wrap"><div class="field"><span class="lbl">প্রোডাক্ট</span><div class="chips">' + D.products.map((p) => '<button type="button" class="chip" data-action="calc-product" data-v="' + esc(p.name) + '" aria-pressed="' + (c.product === p.name) + '">' + esc(p.name) + '</button>').join('') + '</div></div>';
  h += '<div id="calc-out"></div>';
  h += '<section class="step"><div class="step-h"><h2>দাম</h2></div>' +
    s('sell', 'বেচা দাম', 'খালি রাখলে প্রোডাক্টের দাম ধরা হবে') + s('buy', 'কেনা দাম (প্রতি পিস)', 'খালি রাখলে প্রোডাক্টের কেনা দাম') + '</section>';
  h += '<section class="step"><div class="step-h"><h2>আপনার ব্যবসার হিসাব</h2></div>' +
    s('batch', 'এক ব্যাচে কত পিস কেনেন') + s('perOrder', 'প্রতি অর্ডারে গড়ে কত পিস') + s('ordersMonth', 'মাসে আনুমানিক কত অর্ডার') +
    s('returnRate', 'রিটার্ন রেট (%)', '১০০ অর্ডারে কতটা ফেরত আসে') + s('target', 'টার্গেট লাভ (%)') + '</section>';
  h += '<section class="step"><div class="step-h"><h2>৮ ধরনের খরচ</h2></div><div id="calc-costs">' +
    '<div class="cat-h">Product Sourcing<span id="cc-0"></span></div>' + s('trip', 'ঢাকা যাওয়া-আসা ও সংগ্রহ', 'পুরো ব্যাচে মোট') +
    '<div class="cat-h">Transportation<span id="cc-1"></span></div>' + s('courierIn', 'ঢাকা থেকে কুরিয়ার', 'পুরো ব্যাচে মোট') + s('local', 'বাসায় আনা', 'পুরো ব্যাচে মোট') +
    '<div class="cat-h">Inventory Management<span id="cc-2"></span></div>' + s('inventory', 'গ্রহণ, গোছানো, সংরক্ষণ', 'পুরো ব্যাচে মোট') +
    '<div class="cat-h">Packaging<span id="cc-3"></span></div>' + s('packaging', 'পলিব্যাগ, টেপ, স্টিকার', 'প্রতি অর্ডারে') +
    '<div class="cat-h">Marketing<span id="cc-4"></span></div>' + s('marketing', 'Facebook Boost ও বিজ্ঞাপন', 'মাসে মোট বাজেট') +
    '<div class="cat-h">Order Processing<span id="cc-5"></span></div>' + s('processing', 'যোগাযোগ, অর্ডার নেওয়া', 'প্রতি অর্ডারে') +
    '<div class="cat-h">Delivery<span id="cc-6"></span></div>' + s('courier', 'কুরিয়ার চার্জ (আসল খরচ)', 'প্রতি অর্ডারে') + s('delivIn', 'কাস্টমার থেকে নেওয়া ডেলিভারি চার্জ', 'প্রতি অর্ডারে, আয় হিসেবে বাদ যাবে') + s('returnLoss', 'রিটার্ন হলে ক্ষতি', 'প্রতি রিটার্ন অর্ডারে') +
    '<div class="cat-h">Financial Settlement<span id="cc-7"></span></div>' + s('cod', 'COD চার্জ (%)', 'কালেকশনের শতাংশ') + s('otherFee', 'অন্যান্য লেনদেন ফি', 'প্রতি অর্ডারে') +
    '</div></section>';
  h += '<section class="step"><div class="step-h"><h2>দাম কমালে বা বাড়ালে</h2></div><div id="calc-scen"></div></section>';
  h += '<button class="btn ghost mt16" data-action="calc-reset">শুরুর সংখ্যায় ফেরত যান</button></div>';
  store.set(CALC_KEY, c);
  return h;
}
function calcCompute(c) {
  const p = D.P[c.product] || { sell: 0, buy: 0 };
  const sell = c.sell !== '' && c.sell !== null ? num(c.sell) : p.sell;
  const buy = c.buy !== '' && c.buy !== null ? num(c.buy) : p.buy;
  const batch = Math.max(1, num(c.batch)), per = Math.max(0.01, num(c.perOrder)), om = Math.max(1, num(c.ordersMonth));
  const rr = num(c.returnRate) / 100, cod = num(c.cod) / 100, target = num(c.target) / 100;
  const cats = [
    buy + num(c.trip) / batch,
    (num(c.courierIn) + num(c.local)) / batch,
    num(c.inventory) / batch,
    num(c.packaging) / per,
    num(c.marketing) / (om * per),
    num(c.processing) / per,
    (num(c.courier) - num(c.delivIn)) / per + rr * num(c.returnLoss) / per,
    0 // financial set below
  ];
  const c0 = sum(cats) + num(c.otherFee) / per;           // all except COD %
  const codAt = (price) => cod * (price + num(c.delivIn) / per);
  const costAt = (price) => c0 + codAt(price);
  cats[7] = codAt(sell) + num(c.otherFee) / per;
  const total = costAt(sell);
  const profit = sell - total;
  const margin = sell ? profit / sell : 0;
  const k = c0 + cod * num(c.delivIn) / per;
  const be = 1 - cod > 0 ? k / (1 - cod) : 0;
  const tp = 1 - cod - target > 0 ? k / (1 - cod - target) : 0;
  return { sell, buy, cats, total, profit, margin, be, tp, target, batch, costAt };
}
function mountCalc() { updateCalc(); }
function updateCalc() {
  const c = calcState();
  const r = calcCompute(c);
  const out = document.getElementById('calc-out');
  if (!out) return;
  const verdict = r.profit < 0 ? '<span class="verdict bad">লস হচ্ছে, দাম বাড়ান বা খরচ কমান</span>' : r.margin < r.target ? '<span class="verdict mid">লাভ আছে, কিন্তু টার্গেটের কম</span>' : '<span class="verdict good">টার্গেট অনুযায়ী লাভ হচ্ছে</span>';
  out.innerHTML = '<div class="calc-hero"><div class="small" style="opacity:.8">প্রতি পিসে ' + (r.profit >= 0 ? 'আসল লাভ' : 'লস') + ', ' + esc(c.product) + ' ' + tk(r.sell) + ' দামে</div>' +
    '<div class="big' + (r.profit < 0 ? ' neg' : '') + '">' + tk(r.profit) + '</div>' +
    '<div class="small" style="opacity:.85">মোট খরচ প্রতি পিসে ' + tk(r.total) + ', লাভের হার ' + pct(r.margin) + '</div>' + verdict +
    '<div class="row2"><div><small>এর নিচে বেচলে লস</small><b>' + tk(Math.ceil(r.be)) + '</b></div><div><small>' + bn(Math.round(r.target * 100)) + '% লাভ পেতে দাম</small><b>' + (r.tp ? tk(Math.ceil(r.tp)) : '-') + '</b></div>' +
    '<div><small>পুরো ব্যাচ বেচলে লাভ</small><b>' + tk(r.profit * r.batch) + '</b></div><div><small>পণ্যের কেনা দাম</small><b>' + tk(r.buy) + '</b></div></div></div>';
  r.cats.forEach((v, i) => { const el = document.getElementById('cc-' + i); if (el) el.textContent = '৳' + bn((Math.round(v * 100) / 100).toFixed(2)) + ' / পিস'; });
  const sc = document.getElementById('calc-scen');
  if (sc) {
    sc.innerHTML = '<table class="scen"><tr><th>দাম</th><th>খরচ</th><th>লাভ</th><th>হার</th></tr>' + [-0.2, -0.1, 0, 0.1, 0.2].map((ch) => {
      const price = r.sell * (1 + ch), cost = r.costAt(price), pr = price - cost;
      return '<tr' + (ch === 0 ? ' class="base"' : '') + '><td>' + tk(price) + ' <span class="small muted">' + (ch ? (ch > 0 ? '+' : '−') + bn(Math.abs(ch * 100)) + '%' : 'এখন') + '</span></td><td>' + tk(cost) + '</td><td class="' + (pr < 0 ? 'neg' : 'pos') + '">' + tk(pr) + '</td><td>' + (price ? pct(pr / price) : '-') + '</td></tr>';
    }).join('') + '</table>';
  }
}

/* ================= settings ================= */
function viewSettings() {
  let h = pageHead('সেটিংস', 'more');
  h += '<div class="wrap"><div class="kv"><div><span>মোড</span><b>' + (cfg.mode === 'demo' ? 'ডেমো' : 'Google Sheet') + '</b></div>' +
    (cfg.mode === 'live' ? '<div><span>সংযোগ</span><b class="small">' + esc(cfg.url.replace(/^https:\/\/script\.google\.com\/macros\/s\//, '').slice(0, 14)) + '...</b></div>' : '') +
    '<div><span>প্রোডাক্ট / কাস্টমার / অর্ডার</span><b>' + nbn(D.products.length) + ' / ' + nbn(D.customers.length) + ' / ' + nbn(D.orders.length) + '</b></div></div>';
  h += '<div class="flex mt12" style="flex-direction:column;align-items:stretch">' +
    '<button class="btn" data-action="refresh">' + ICON.refresh + 'শিট থেকে নতুন করে আনুন</button>' +
    (D.sheetUrl ? '<a class="btn ghost" href="' + esc(D.sheetUrl) + '" target="_blank" rel="noopener">' + ICON.sheet + 'Google Sheet খুলুন</a>' : '') +
    (cfg.mode === 'demo' ? '<button class="btn ghost" data-action="reset-demo">ডেমো ডাটা আবার শুরু করুন</button>' : '') +
    '<button class="btn ghost" data-action="disconnect">' + (cfg.mode === 'demo' ? 'ডেমো বন্ধ করুন' : 'সংযোগ বিচ্ছিন্ন করুন') + '</button></div>';
  h += '<p class="small muted mt16">Status, Courier, Category-র লিস্ট আর VIP বা Low Stock-এর সীমা বদলাতে Google Sheet-এর Settings ট্যাবে যান। বদলানোর পর এখানে রিফ্রেশ চাপুন।</p></div>';
  return h;
}

/* ================= sheet + toast ================= */
const sheetRoot = document.getElementById('sheet-root');
let lastFocus = null;
function openSheet(html) {
  lastFocus = document.activeElement;
  sheetRoot.innerHTML = '<div class="backdrop" data-action="close-sheet"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div></div>';
  document.body.style.overflow = 'hidden';
  const f = sheetRoot.querySelector('input:not([type=hidden]):not([readonly]), button, a');
  if (f && f.tagName === 'INPUT' && window.innerWidth > 700) f.focus();
}
function closeSheet() {
  if (!sheetRoot.innerHTML) return;
  sheetRoot.innerHTML = '';
  document.body.style.overflow = '';
  if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* ignore */ }
}
let toastTimer;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('কপি হয়েছে'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('কপি হয়েছে'); } catch (e2) { toast('কপি করা যায়নি', true); }
    ta.remove();
  }
}

/* ================= events ================= */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'close-sheet') { if (ev.target === el) closeSheet(); return; }
  switch (a) {
    case 'refresh': await loadData(); if (D) toast('ডাটা আপডেট হয়েছে'); break;
    case 'demo': cfg = { mode: 'demo' }; store.set(CFG_KEY, cfg); D = null; render(); loadData(); break;
    case 'go-setup': case 'disconnect':
      if (a === 'disconnect' && cfg.mode === 'live' && !confirm('এই ফোন থেকে শিটের সংযোগ বিচ্ছিন্ন করবেন? শিটের ডাটা মুছবে না।')) return;
      cfg = null; store.del(CFG_KEY); store.del(CACHE_KEY); D = null; RAW = null; closeSheet(); location.hash = 'home'; render(); break;
    case 'reset-demo': store.del(DEMO_KEY); await loadData(); toast('ডেমো ডাটা নতুন করে শুরু হলো'); break;
    case 'month-prev': case 'month-next': {
      const key = el.dataset.key === 'exp' ? 'expMonth' : 'month';
      const p = ui[key], step = a === 'month-next' ? 1 : -1;
      if (p.m === null) p.y += step; else { p.m += step; if (p.m < 0) { p.m = 11; p.y--; } if (p.m > 11) { p.m = 0; p.y++; } }
      render(); break;
    }
    case 'toggle-year': { const n = new Date(); ui.month = ui.month.m === null ? { y: ui.month.y, m: ui.month.y === n.getFullYear() ? n.getMonth() : 11 } : { y: ui.month.y, m: null }; render(); break; }
    case 'order-filter': ui.orderFilter = el.dataset.f; render(); break;
    case 'cust-filter': ui.custFilter = el.dataset.f; render(); break;
    case 'open-order': openOrder(el.dataset.id); break;
    case 'open-cust': openCustomer(el.dataset.m); break;
    case 'copy-summary': { const o = D.orders.find((x) => x.id === el.dataset.id); if (o) copyText(orderSummary(o)); break; }
    case 'pick': {
      const form = el.closest('form'), g = el.dataset.group;
      form.querySelectorAll('[data-group="' + g + '"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      form.querySelector('input[name="' + g + '"]').value = el.dataset.v;
      if (g === 'product' && el.dataset.buy) { const pr = form.querySelector('input[name="price"]'); if (pr && !pr.value) pr.value = el.dataset.buy; }
      if (g === 'category') { const hint = form.querySelector('#cat-hint'); if (hint) hint.textContent = CAT_BN[el.dataset.v] || ''; }
      break;
    }
    case 'add-expense': expenseForm(); break;
    case 'add-stock': stockForm(); break;
    case 'new-product': productForm(null); break;
    case 'edit-product': productForm(D.P[el.dataset.p]); break;
    case 'new-customer': customerForm(null); break;
    case 'edit-customer': customerForm(D.C[el.dataset.m]); break;
    case 'calc-for': { const c = calcState(); c.product = el.dataset.p; c.sell = ''; c.buy = ''; store.set(CALC_KEY, c); closeSheet(); go('calc'); break; }
    case 'calc-product': { const c = calcState(); c.product = el.dataset.v; c.sell = ''; c.buy = ''; store.set(CALC_KEY, c); render(); break; }
    case 'calc-reset': store.del(CALC_KEY); render(); break;
    case 'order-for': {
      const c = D.C[el.dataset.m]; ui.draft = newDraft(); if (c) { ui.draft.query = c.mobile; ui.draft.found = c.mobile; }
      closeSheet(); break; // link navigates to #new
    }
    // new order
    case 'reset-draft': ui.draft = newDraft(); render(); break;
    case 'pick-cust': { const c = D.C[el.dataset.m]; ui.draft.found = c.mobile; ui.draft.query = c.mobile; ui.draft.editCust = false; renderCustBox(); break; }
    case 'edit-cust': {
      const d = ui.draft, c = D.C[d.found]; d.editCust = !d.editCust;
      if (d.editCust) Object.assign(d, { name: c.name, address: c.address, district: c.district, source: c.source || d.source });
      renderCustBox(); break;
    }
    case 'draft-pick': {
      ui.draft[el.dataset.k] = el.dataset.v;
      el.parentElement.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      break;
    }
    case 'deliv': {
      const d = ui.draft; d.deliveryMode = el.dataset.v;
      el.parentElement.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      const box = document.getElementById('deliv-custom');
      if (d.deliveryMode === 'custom') { box.hidden = false; box.querySelector('input').focus(); } else { box.hidden = true; d.delivery = num(d.deliveryMode); }
      updateReceipt(); break;
    }
    case 'qty': {
      const d = ui.draft, p = el.dataset.p; d.lines[p] = Math.max(0, (d.lines[p] || 0) + num(el.dataset.d));
      if (!d.lines[p]) { delete d.lines[p]; delete d.special[p]; }
      renderTiles(); renderLines(); updateReceipt(); break;
    }
    case 'special': { ui.draft.special[el.dataset.p] = ''; renderLines(); const i = document.querySelector('[data-special="' + CSS.escape(el.dataset.p) + '"]'); if (i) i.focus(); break; }
    case 'save-order': saveOrder(); break;
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.input === 'order-q') { ui.orderQuery = t.value; rerenderKeepFocus(t); return; }
  if (t.dataset.input === 'cust-q') { ui.custQuery = t.value; rerenderKeepFocus(t); return; }
  if (t.dataset.draft && ui.draft) {
    const k = t.dataset.draft; ui.draft[k] = t.value;
    if (k === 'query') {
      const m = mobileNorm(t.value);
      const was = ui.draft.found;
      ui.draft.found = m.length === 11 && D.C[m] ? m : null;
      if (was !== ui.draft.found) ui.draft.editCust = false;
      const pos = t.selectionStart; renderCustBox();
      const ni = document.getElementById('n-q'); if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
    }
    if (k === 'delivery' || k === 'discount') updateReceipt();
    return;
  }
  if (t.dataset.special !== undefined && ui.draft) { ui.draft.special[t.dataset.special] = t.value; updateReceipt(); const lp = t.parentElement.querySelector('.lp'); const l = draftLines().find((x) => x.product === t.dataset.special); if (lp && l) lp.textContent = tk(l.unit * l.qty); return; }
  if (t.dataset.calc) { const c = calcState(); c[t.dataset.calc] = t.value; store.set(CALC_KEY, c); updateCalc(); }
});

function rerenderKeepFocus(input) {
  const key = input.dataset.input, pos = input.selectionStart;
  render();
  const ni = document.querySelector('[data-input="' + key + '"]');
  if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
}

document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  const kind = form.dataset.form;
  if (!kind) return;
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(form).entries());
  const btn = form.querySelector('button[type="submit"]');
  const busy = (on, label) => { if (btn) { btn.disabled = on; if (label) btn.textContent = label; } };
  if (kind === 'connect') {
    const url = String(fd.url || '').trim(), pin = String(fd.pin || '').trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('URL টা script.google.com দিয়ে শুরু হওয়া উচিত', true);
    busy(true, 'যাচাই করছি...');
    try { await testConnection(url, pin); cfg = { mode: 'live', url, pin }; store.set(CFG_KEY, cfg); D = null; render(); await loadData(); toast('শিট যুক্ত হয়েছে'); }
    catch (e) { busy(false, 'যুক্ত করুন'); toast(e.message && e.message.indexOf('PIN') > -1 ? e.message : 'সংযোগ হয়নি। URL আর PIN আবার দেখুন।', true); }
    return;
  }
  const actions = {
    'update-order': () => ['updateOrder', { id: form.dataset.id, status: fd.status, courier: fd.courier, courierCost: fd.courierCost === '' ? '' : num(fd.courierCost), tracking: fd.tracking }, 'অর্ডার আপডেট হয়েছে'],
    'customer': () => ['saveCustomer', { mobile: fd.mobile, name: fd.name, address: fd.address, district: fd.district, source: fd.source, notes: fd.notes, isNew: form.dataset.new === '1', addedOn: todayISO() }, 'কাস্টমার সেভ হয়েছে'],
    'product': () => ['saveProduct', { originalName: form.dataset.orig || '', id: fd.id, name: String(fd.name || '').trim(), category: fd.category, buy: num(fd.buy), sell: num(fd.sell), opening: num(fd.opening) }, 'প্রোডাক্ট সেভ হয়েছে'],
    'expense': () => ['addExpense', { date: fd.date || todayISO(), category: fd.category, desc: fd.desc, amount: num(fd.amount), paidVia: fd.paidVia }, 'খরচ সেভ হয়েছে'],
    'stock': () => ['addStock', { date: fd.date || todayISO(), product: fd.product, qty: num(fd.qty), price: num(fd.price), supplier: fd.supplier }, 'মাল কেনা সেভ হয়েছে']
  };
  if (!actions[kind]) return;
  if (kind === 'expense' && !fd.category) return toast('ক্যাটাগরি বাছুন', true);
  if (kind === 'stock' && !fd.product) return toast('প্রোডাক্ট বাছুন', true);
  if (kind === 'customer' && mobileNorm(fd.mobile).length !== 11) return toast('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন', true);
  const [action, data, okMsg] = actions[kind]();
  const label = btn ? btn.textContent : '';
  busy(true, 'সেভ হচ্ছে...');
  try { await apiPost(action, data); closeSheet(); await loadData(true); toast(okMsg); }
  catch (e) { busy(false, label); toast(e.message || 'সেভ করা যায়নি', true); }
});

/* ================= start ================= */
(function start() {
  if (!cfg) { render(); return; }
  if (cfg.mode === 'live') {
    const cache = store.get(CACHE_KEY, null);
    if (cache) { RAW = cache; D = derive(RAW); }
  }
  render();
  loadData(!!D);
})();

window.__bd = { derive, calcCompute: (c) => calcCompute(Object.assign({}, CALC_DEFAULT, c)), orderSummary, periodStats: (p) => periodStats(p) };
})();
