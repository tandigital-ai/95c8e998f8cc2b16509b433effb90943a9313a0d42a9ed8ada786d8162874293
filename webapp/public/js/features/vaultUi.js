/**
 * vaultUi.js — Hộp thoại Vault: tạo / mở khóa / khóa / đổi mật khẩu / chế độ chỉ RAM / xóa.
 * Mật khẩu chỉ nằm trong ô nhập lúc gõ, xóa khỏi DOM ngay sau khi dùng.
 */
import { h, mount } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { MIN_PASSPHRASE_LENGTH } from '../core/vault.js';

function pwInput(label, id) {
  const inp = h('input', { class: 'inp', type: 'password', id, autocomplete: 'off', 'aria-label': label });
  return { inp, field: h('div', { class: 'field' }, h('label', { for: id }, label), inp) };
}

export async function openVaultDialog(app) {
  const body = h('div', { class: 'col' });
  const m = openModal({ title: '🔐 Vault khóa API', body, size: 'narrow' });
  const after = () => { app.emit('providers'); app.emit('models'); app.emit('vault'); };

  async function render() {
    const st = await app.vault.status();
    const info = h('div', { class: 'info-box small' },
      'Key trong trình duyệt được mã hóa AES-GCM 256-bit, khóa sinh từ mật khẩu bằng PBKDF2-SHA256 ', String(st.iterations || 600000).replace(/\B(?=(\d{3})+(?!\d))/g, '.'), ' vòng, salt ngẫu nhiên. ',
      'Mật khẩu CHỈ nằm trong RAM; tự khóa sau ', String(app.settings.get().vaultAutoLockMinutes), ' phút không thao tác. ',
      h('b', null, 'Quên mật khẩu = mất các key trong vault'), ' (chỉ cần xóa vault và nhập lại key).');

    if (st.mode === 'memory') {
      const a = pwInput(`Mật khẩu mới (≥ ${MIN_PASSPHRASE_LENGTH} ký tự)`, 'vp-new');
      const b = pwInput('Nhập lại', 'vp-new2');
      mount(body,
        h('div', { class: 'warn-box' }, '⚠ Đang ở chế độ CHỈ RAM: key không lưu xuống ổ đĩa, tải lại trang là mất.'),
        info, a.field, b.field,
        h('div', { class: 'row' }, h('button', {
          class: 'btn btn-pri',
          onclick: async () => {
            if (a.inp.value !== b.inp.value) { app.toast('Hai mật khẩu không khớp', 'err'); return; }
            const ok = await app.guard(() => app.vault.create(a.inp.value), 'Tạo vault');
            a.inp.value = ''; b.inp.value = '';
            if (ok) { app.toast('Đã tạo vault mã hóa và chuyển key từ RAM vào vault', 'ok'); after(); m.close(); }
          }
        }, '🔒 Lưu key vào vault mã hóa')));
      return;
    }

    if (!st.exists) {
      const a = pwInput(`Mật khẩu vault (≥ ${MIN_PASSPHRASE_LENGTH} ký tự)`, 'vp-new');
      const b = pwInput('Nhập lại mật khẩu', 'vp-new2');
      mount(body, info, a.field, b.field,
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn-pri',
            onclick: async () => {
              if (a.inp.value !== b.inp.value) { app.toast('Hai mật khẩu không khớp', 'err'); return; }
              const ok = await app.guard(() => app.vault.create(a.inp.value), 'Tạo vault');
              a.inp.value = ''; b.inp.value = '';
              if (ok) { app.toast('Đã tạo vault. Giờ bạn có thể thêm key trong panel Providers.', 'ok'); after(); m.close(); }
            }
          }, '🔐 Tạo vault'),
          h('button', {
            class: 'btn btn-out',
            onclick: async () => {
              const ok = await app.guard(() => app.vault.useMemoryOnly(), 'Chế độ chỉ RAM');
              if (ok) { app.toast('Chế độ CHỈ RAM: key mất khi tải lại trang', 'warn'); after(); m.close(); }
            }
          }, '🧠 Không lưu khóa (chỉ RAM)')),
        h('div', { class: 'small muted' }, 'Hoặc bỏ qua vault và đặt key trong server/.env (KEY_GEMINI=..., ...).'));
      return;
    }

    if (!st.unlocked) {
      const a = pwInput('Mật khẩu vault', 'vp-open');
      const errBox = h('div', { role: 'alert' });
      const submit = async () => {
        const pass = a.inp.value;
        a.inp.value = '';
        try {
          await app.vault.unlock(pass);
          app.toast('🔓 Đã mở khóa vault', 'ok');
          after();
          m.close();
        } catch (e) {
          await app.logger.error('vault', e.message, { code: e.code });
          mount(errBox, h('div', { class: 'error-box' }, '❌ ', e.message));
          a.inp.focus();
        }
      };
      a.inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      mount(body, info, a.field, errBox,
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-pri', onclick: submit }, '🔓 Mở khóa'),
          h('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!(await confirmDialog({ title: 'Xóa vault', message: 'Xóa vault sẽ xóa VĨNH VIỄN mọi key đã lưu trong trình duyệt. Tiếp tục?', okText: 'Xóa vault', danger: true }))) return;
              await app.guard(() => app.vault.destroy(), 'Xóa vault');
              app.toast('Đã xóa vault', 'warn'); after(); render();
            }
          }, '🗑️ Quên mật khẩu? Xóa vault')));
      return;
    }

    // Đang mở
    const old = pwInput('Mật khẩu hiện tại', 'vp-old');
    const n1 = pwInput(`Mật khẩu mới (≥ ${MIN_PASSPHRASE_LENGTH} ký tự)`, 'vp-n1');
    const n2 = pwInput('Nhập lại mật khẩu mới', 'vp-n2');
    const autoLock = h('input', { class: 'inp inp-sm', type: 'number', min: '0', max: '1440', value: String(app.settings.get().vaultAutoLockMinutes), 'aria-label': 'Tự khóa sau (phút)' });
    autoLock.addEventListener('change', async () => {
      const v = Math.max(0, Number(autoLock.value) || 0);
      await app.settings.update({ vaultAutoLockMinutes: v });
      app.vault.setAutoLockMinutes(v);
      app.toast(v ? `Tự khóa sau ${v} phút không thao tác` : 'Đã TẮT tự khóa (không khuyến nghị)', v ? 'ok' : 'warn');
    });
    mount(body,
      h('div', { class: 'ok-box' }, '🔓 Vault đang MỞ.'),
      info,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-pri', onclick: () => { app.vault.lock('manual'); app.toast('🔒 Đã khóa vault', 'ok'); after(); render(); } }, '🔒 Khóa ngay'),
        h('label', { class: 'row small' }, 'Tự khóa sau (phút, 0 = tắt):', autoLock)),
      h('div', { class: 'section-title mt-12' }, 'Đổi mật khẩu'),
      old.field, n1.field, n2.field,
      h('button', {
        class: 'btn btn-out',
        onclick: async () => {
          if (n1.inp.value !== n2.inp.value) { app.toast('Hai mật khẩu mới không khớp', 'err'); return; }
          const ok = await app.guard(() => app.vault.changePassword(old.inp.value, n1.inp.value), 'Đổi mật khẩu');
          old.inp.value = ''; n1.inp.value = ''; n2.inp.value = '';
          if (ok) app.toast('Đã đổi mật khẩu (salt mới, mã hóa lại toàn bộ)', 'ok');
        }
      }, '🔁 Đổi mật khẩu'),
      h('div', { class: 'section-title mt-12' }, 'Vùng nguy hiểm'),
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Xóa vault', message: 'Xóa VĨNH VIỄN mọi key trong trình duyệt?', okText: 'Xóa vault', danger: true }))) return;
          await app.guard(() => app.vault.destroy(), 'Xóa vault');
          app.toast('Đã xóa vault', 'warn'); after(); render();
        }
      }, '🗑️ Xóa vault'));
  }
  await render();
}
