// Xử lý đăng nhập/phiên làm việc 1 ngày
(function (global) {
  const Auth = {};
  const KEY = 'aeck_session_v1';

  function normalizeEmail(s) {
    return String(s || '').trim().toLowerCase();
  }
  function normalizePhone(s) {
    // Chỉ giữ chữ số và bỏ 0 ở đầu để tránh lỗi cột SĐT bị mất 0 khi lưu dạng số trong Sheet
    const digits = String(s || '').replace(/\D/g, '');
    return digits.replace(/^0+/, '');
  }

  Auth.getSession = function () {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.exp !== 'number') return null;
      if (Date.now() > data.exp) {
        localStorage.removeItem(KEY);
        return null;
      }
      return data.payload || null;
    } catch {
      return null;
    }
  };

  Auth.setSession = function (payload) {
    const ttl = global.APP_CONFIG?.SESSION_TTL_MS || 24 * 60 * 60 * 1000;
    const exp = Date.now() + ttl;
    localStorage.setItem(KEY, JSON.stringify({ payload, exp }));
  };

  Auth.logout = function () {
    localStorage.removeItem(KEY);
  };

  Auth.requireAuth = function (redirectTo) {
    const s = Auth.getSession();
    if (!s) {
      if (redirectTo) window.location.replace(redirectTo);
      return false;
    }
    return true;
  };

  // Export các hàm normalize để các module khác có thể sử dụng
  Auth.normalizeEmail = normalizeEmail;
  Auth.normalizePhone = normalizePhone;

  Auth.login = async function (email, phone) {
    const e = normalizeEmail(email);
    const p = normalizePhone(phone);
    if (!e || !p) throw new Error('Vui lòng nhập Email và SĐT');

    const hasApi = Boolean(global.APP_CONFIG?.API_BASE);
    const allowCsvFallback = Boolean(global.APP_CONFIG?.USE_CSV_FALLBACK);

    // Nếu có cấu hình API Apps Script thì xác thực trên server
    if (hasApi && global.Sheets.validateAccount) {
      const apiOk = await global.Sheets.validateAccount(e, p); // true | false | null
      if (apiOk === true) {
        Auth.setSession({ email: e });
        return;
      }
      if (apiOk === false) throw new Error('Email hoặc SĐT không khớp');
      // apiOk === null: lỗi API
      if (!allowCsvFallback) throw new Error('Không thể kết nối máy chủ. Vui lòng thử lại.');
      // Nếu cho phép, rơi xuống fallback CSV bên dưới
    }

    // Fallback CSV công khai (khi không có API hoặc được bật cho phép)
    const accounts = await global.Sheets.getAccounts();
    const ok = accounts.some((acc) => normalizeEmail(acc.email) === e && normalizePhone(acc.phone) === p);
    if (!ok) throw new Error('Email hoặc SĐT không khớp');

    Auth.setSession({ email: e });
  };

  global.Auth = Auth;
})(window);
