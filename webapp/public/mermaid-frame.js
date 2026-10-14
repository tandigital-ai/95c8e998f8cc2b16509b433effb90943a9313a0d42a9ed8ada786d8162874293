// Khung render Mermaid. Lý do tồn tại: Mermaid phải gán style inline để đo chữ khi bố cục,
// trong khi trang chính có CSP style-src 'self' (không 'unsafe-inline'). Khung này có CSP riêng
// (chỉ nới style; script vẫn chỉ 'self', connect-src 'none') và chạy trong iframe sandbox="allow-scripts"
// (origin mờ ⇒ không đọc được IndexedDB / key của app). SVG được làm sạch bằng DOMPurify NGAY TẠI ĐÂY
// rồi gửi chuỗi về; trang chính chỉ hiển thị qua <img src=blob:> (SVG trong <img> không chạy script).

// Script thường (không module): iframe sandbox có origin mờ ⇒ module script cần CORS, proxy không bật CORS.
(function () {
const mermaid = window.mermaid;
const DOMPurify = window.DOMPurify;
let seq = 0;
let lastTheme = null;

function init(theme) {
  if (theme === lastTheme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    htmlLabels: false, // Mermaid ≥11 đọc ở cấp gốc; nhãn HTML (foreignObject) sẽ bị DOMPurify loại
    flowchart: { htmlLabels: false, useMaxWidth: false, nodeSpacing: 50, rankSpacing: 60, curve: 'basis', padding: 10 }
  });
  lastTheme = theme;
}

window.addEventListener('message', async (ev) => {
  if (ev.source !== window.parent) return;
  const d = ev.data;
  if (!d || d.type !== 'mmd-render' || typeof d.code !== 'string') return;
  const reply = (payload) => window.parent.postMessage({ type: 'mmd-result', id: d.id, ...payload }, '*');
  try {
    if (!mermaid || !DOMPurify) throw new Error('Không nạp được mermaid trong khung render');
    init(d.theme);
    await mermaid.parse(d.code);
    const id = 'm' + Date.now() + '_' + seq++;
    const { svg } = await mermaid.render(id, d.code, document.getElementById('stage'));
    document.getElementById(id)?.remove();
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick']
    });
    reply({ ok: true, svg: clean });
  } catch (e) {
    reply({ ok: false, error: String((e && (e.message || e.str)) || e) });
  }
});

window.parent.postMessage({ type: 'mmd-ready' }, '*');
})();
