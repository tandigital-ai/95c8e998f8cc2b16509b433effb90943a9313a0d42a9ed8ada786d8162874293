// Khung xem trước: nhận HTML qua postMessage rồi thay toàn bộ tài liệu.
// Chạy trong iframe sandbox="allow-scripts" (origin mờ) — không truy cập được dữ liệu của app.
window.addEventListener('message', function (ev) {
  if (ev.source !== window.parent) return;
  var d = ev.data;
  if (!d || d.type !== 'ai-architect-preview' || typeof d.html !== 'string') return;
  document.open();
  document.write(d.html);
  document.close();
});
window.parent.postMessage({ type: 'ai-architect-preview-ready' }, '*');
