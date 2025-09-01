// Tiện ích đọc Google Sheets qua CSV export (tránh lỗi CORS của gviz)
(function (global) {
  const Sheets = {};
  const API_BASE = global.APP_CONFIG?.API_BASE?.trim();
  const CACHE_TTL = global.APP_CONFIG?.CACHE_TTL_MS || (6 * 60 * 60 * 1000);

  // ---- Lightweight cache helpers (localStorage) ----
  function cacheGet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() > data.exp) {
        localStorage.removeItem(key);
        return null;
      }
      return data.val;
    } catch { return null; }
  }
  function cacheSet(key, val, ttl = CACHE_TTL) {
    try { localStorage.setItem(key, JSON.stringify({ exp: Date.now() + ttl, val })); } catch {}
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let q = false; // đang ở trong dấu nháy kép
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { // escape ""
            cur += '"';
            i++;
          } else {
            q = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          q = true;
        } else if (ch === ',') {
          row.push(cur);
          cur = '';
        } else if (ch === '\n') {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = '';
        } else if (ch === '\r') {
          // bỏ qua
        } else {
          cur += ch;
        }
      }
    }
    // đẩy phần còn lại
    row.push(cur);
    rows.push(row);
    return rows;
  }

  async function fetchCSV(gid) {
    const id = global.APP_CONFIG?.SPREADSHEET_ID;
    if (!id) throw new Error('Thiếu cấu hình SPREADSHEET_ID');
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
    const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
    if (!res.ok) throw new Error('Không thể tải Google Sheet (CSV)');
    const text = await res.text();
    return parseCSV(text);
  }

  // --- Chế độ Apps Script API (nếu cấu hình) ---
  async function apiGet(params) {
    const qs = new URLSearchParams(params).toString();
    const url = `${API_BASE}?${qs}`;
    const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
    if (!res.ok) throw new Error(`API lỗi: ${res.status}`);
    return res.json();
  }

  Sheets.validateAccount = async function (email, phone) {
    if (!API_BASE) return null; // không dùng API
    try {
      const data = await apiGet({ action: 'auth', email, phone });
      // Khi API sập hoặc trả về lỗi định dạng, fallback sẽ kích hoạt (trả về null)
      if (typeof data?.ok === 'undefined') return null;
      return Boolean(data.ok);
    } catch (e) {
      console.warn('API auth error, fallback CSV:', e);
      return null;
    }
  };

  Sheets.getLinkForSach1000 = async function (id) {
    if (!API_BASE) return null;
    try {
      const k = `aeck_cache_sach1000_${id}`;
      const cached = cacheGet(k);
      if (cached != null) {
        // Di trú cache cũ dạng string -> object
        if (typeof cached === 'string') return { link: cached, status: undefined };
        return cached;
      }
      const data = await apiGet({ action: 'sach1000', id });
      if (typeof data?.link === 'undefined') return null;
      let payload = { link: (data && data.link) || '', status: (data && data.status) || undefined };
      // Nếu API không trả status, cố gắng lấy từ CSV map (đã cache)
      if (!payload.status) {
        try {
          const map = await Sheets.getSach1000Map();
          const obj = map.get(String(id).toUpperCase());
          if (obj && obj.status) payload.status = obj.status;
        } catch {}
      }
      // Mặc định nếu vẫn chưa có, coi là VIP để bảo vệ nội dung
      if (!payload.status) payload.status = 'VIP';
      cacheSet(k, payload);
      return payload;
    } catch (e) {
      console.warn('API lookup error, fallback CSV:', e);
      return null;
    }
  };

  // --- CSV fallback (không cần API key) ---
  Sheets.getAccounts = async function () {
    const gid = global.APP_CONFIG?.GIDS?.tai_khoan;
    if (!gid) throw new Error('Thiếu GID cho tab tai_khoan');
    const rows = await fetchCSV(gid);
    const out = [];
    // xác định chỉ số cột theo header
    const header = rows[0] || [];
    const colEmail = header.findIndex((h) => /email/i.test(String(h)));
    const colPhone = header.findIndex((h) => /(số\s*điện\s*thoại|điện\s*thoại)/i.test(String(h)));
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const email = (r[colEmail] || '').toString().trim();
      const phone = (r[colPhone] || '').toString().trim();
      if (!email && !phone) continue;
      out.push({ email, phone });
    }
    return out;
  };

  Sheets.getSach1000Map = async function () {
    const gid = global.APP_CONFIG?.GIDS?.sach_1000;
    if (!gid) throw new Error('Thiếu GID cho tab sach_1000');
    // cache theo spreadsheetId + gid để tránh xung đột
    const id = global.APP_CONFIG?.SPREADSHEET_ID || 'default';
    const key = `aeck_cache_map_${id}_${gid}`;
    const cached = cacheGet(key);
    if (cached && Array.isArray(cached)) {
      return new Map(cached);
    }
    const rows = await fetchCSV(gid);
    const map = new Map();
    const header = rows[0] || [];
    const colId = header.findIndex((h) => /(id\s*câu\s*hỏi|id)/i.test(String(h)));
    const colLink = header.findIndex((h) => /(link\s*nhúng|embed|link)/i.test(String(h)));
    const colStatus = header.findIndex((h) => /(trạng\s*thái|trang\s*thai|status)/i.test(String(h)));
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rid = (r[colId] || '').toString().trim();
      const link = (r[colLink] || '').toString().trim();
      const status = (r[colStatus] || '').toString().trim().toUpperCase();
      if (!rid) continue;
      map.set(rid.toUpperCase(), { link, status: status || 'VIP' });
    }
    // Lưu cache dạng mảng [key, value] để tái tạo Map
    cacheSet(key, Array.from(map.entries()));
    return map;
  };

  // (Giữ lại nếu cần nơi khác sử dụng)
  Sheets.fetchCSV = fetchCSV;

  global.Sheets = Sheets;
})(window);
