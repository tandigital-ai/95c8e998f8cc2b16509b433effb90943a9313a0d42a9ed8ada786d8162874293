import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMemoryDB } from '../public/js/core/db.js';
import { createVault, VaultError, MIN_ITERATIONS } from '../public/js/core/vault.js';
import { createKeyring, maskKey, COOLDOWN_429_MS } from '../public/js/core/keyring.js';
import { fakeClock } from './helpers.js';

const cryptoImpl = globalThis.crypto || webcrypto;

function makeVault(db = createMemoryDB(), extra = {}) {
  // Dùng đúng số vòng tối thiểu thật (600k) — test chậm hơn một chút nhưng trung thực.
  return createVault({ db, cryptoImpl, ...extra });
}

describe('vault', () => {
  test('từ chối số vòng < 600k', () => {
    assert.throws(() => createVault({ db: createMemoryDB(), cryptoImpl, iterations: 1000 }), VaultError);
  });

  test('round-trip: tạo, khóa, mở lại đúng dữ liệu; salt ngẫu nhiên; không lưu plaintext', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.create('mat-khau-dai-1');
    const sec = v.getSecrets();
    sec.providers.gemini = [{ id: 'k1', key: 'AIza-SECRET-KEY-0001', label: '', addedAt: 1 }];
    sec.accessToken = 'proxy-token-xyz';
    await v.setSecrets(sec);

    const rec = await db.get('vault', 'main');
    const raw = JSON.stringify(rec);
    assert.ok(!raw.includes('AIza-SECRET-KEY-0001'), 'không được lưu key dạng rõ');
    assert.ok(!raw.includes('proxy-token-xyz'));
    assert.ok(!raw.includes('mat-khau-dai-1'));
    assert.equal(rec.kdf.name, 'PBKDF2');
    assert.equal(rec.kdf.hash, 'SHA-256');
    assert.ok(rec.kdf.iterations >= MIN_ITERATIONS);
    assert.equal(rec.cipher.name, 'AES-GCM');

    v.lock();
    assert.equal(v.isUnlocked, false);
    assert.throws(() => v.getSecrets(), (e) => e.code === 'LOCKED');

    const v2 = makeVault(db);
    await v2.unlock('mat-khau-dai-1');
    assert.equal(v2.getSecrets().providers.gemini[0].key, 'AIza-SECRET-KEY-0001');
    assert.equal(v2.getSecrets().accessToken, 'proxy-token-xyz');

    // Salt khác nhau giữa 2 vault
    const db2 = createMemoryDB();
    const v3 = makeVault(db2);
    await v3.create('mat-khau-dai-1');
    assert.notEqual((await db2.get('vault', 'main')).kdf.salt, rec.kdf.salt);
  });

  test('sai mật khẩu => WRONG_PASSWORD, không nạp gì', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.create('dung-mat-khau');
    v.lock();
    await assert.rejects(v.unlock('sai-mat-khau'), (e) => e instanceof VaultError && e.code === 'WRONG_PASSWORD');
    assert.equal(v.isUnlocked, false);
  });

  test('dữ liệu bị sửa => báo lỗi (AES-GCM xác thực)', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.create('dung-mat-khau');
    const rec = await db.get('vault', 'main');
    const ct = Buffer.from(rec.ciphertext, 'base64');
    ct[0] ^= 1;
    rec.ciphertext = ct.toString('base64');
    await db.put('vault', rec);
    v.lock();
    await assert.rejects(v.unlock('dung-mat-khau'), (e) => e.code === 'WRONG_PASSWORD');
  });

  test('đổi mật khẩu: salt mới, mật khẩu cũ hết tác dụng', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.create('mat-khau-cu-1');
    await v.setSecrets({ providers: { mistral: [{ id: 'a', key: 'mistral-key-123456' }] } });
    const salt1 = (await db.get('vault', 'main')).kdf.salt;
    await assert.rejects(v.changePassword('khong-dung', 'mat-khau-moi-2'), (e) => e.code === 'WRONG_PASSWORD');
    await v.changePassword('mat-khau-cu-1', 'mat-khau-moi-2');
    assert.notEqual((await db.get('vault', 'main')).kdf.salt, salt1);
    v.lock();
    await assert.rejects(v.unlock('mat-khau-cu-1'), (e) => e.code === 'WRONG_PASSWORD');
    await v.unlock('mat-khau-moi-2');
    assert.equal(v.getSecrets().providers.mistral[0].key, 'mistral-key-123456');
  });

  test('mật khẩu yếu bị từ chối', async () => {
    const v = makeVault();
    await assert.rejects(v.create('123'), (e) => e.code === 'WEAK_PASSWORD');
  });

  test('auto-lock sau N phút', async () => {
    const timers = [];
    const v = makeVault(createMemoryDB(), { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    v.setAutoLockMinutes(5);
    await v.create('mat-khau-dai-1');
    assert.equal(v.isUnlocked, true);
    const last = timers[timers.length - 1];
    assert.equal(last.ms, 5 * 60000);
    last.fn();
    assert.equal(v.isUnlocked, false);
  });

  test('chế độ chỉ RAM: không ghi xuống DB', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.useMemoryOnly();
    await v.setSecrets({ providers: { grok: [{ id: 'x', key: 'xai-ram-only-key-1' }] } });
    assert.equal(await db.get('vault', 'main'), undefined);
    assert.equal(v.getSecrets().providers.grok[0].key, 'xai-ram-only-key-1');
    // Chuyển từ RAM sang vault mã hóa giữ lại key
    await v.create('mat-khau-dai-1');
    assert.equal(v.getSecrets().providers.grok[0].key, 'xai-ram-only-key-1');
    assert.ok(await db.get('vault', 'main'));
  });
});

describe('keyring', () => {
  async function setup() {
    const clock = fakeClock();
    const v = makeVault(createMemoryDB());
    await v.useMemoryOnly();
    const kr = createKeyring({ vault: v, now: clock.now, cryptoImpl });
    return { clock, v, kr };
  }

  test('maskKey không lộ key', () => {
    assert.equal(maskKey('abcd1234567890wxyz'), 'abcd••••wxyz');
    assert.equal(maskKey('short123'), '••••23');
    assert.equal(maskKey(''), '');
  });

  test('thêm nhiều key, bỏ trùng, danh sách che', async () => {
    const { kr } = await setup();
    const r = await kr.addKeys('gemini', 'key-AAAA-1111-zzzz\nkey-BBBB-2222-yyyy\nkey-AAAA-1111-zzzz');
    assert.equal(r.added, 2);
    assert.equal(r.duplicates, 1);
    const list = kr.listMasked('gemini');
    assert.equal(list.length, 2);
    for (const k of list) {
      assert.ok(!('key' in k));
      assert.ok(k.masked.includes('••••'));
    }
    await assert.rejects(kr.addKeys('gemini', 'has space key'), (e) => e.code === 'BAD_KEY');
  });

  test('round-robin theo mức dùng', async () => {
    const { kr, clock } = await setup();
    await kr.addKeys('deepseek', 'sk-key-one-111111\nsk-key-two-222222\nsk-key-three-33333');
    const used = [];
    for (let i = 0; i < 6; i++) { used.push(kr.pick('deepseek').id); clock.advance(10); }
    const counts = {};
    for (const id of used) counts[id] = (counts[id] || 0) + 1;
    assert.deepEqual(Object.values(counts), [2, 2, 2]);
    // 3 lần đầu phải là 3 key khác nhau
    assert.equal(new Set(used.slice(0, 3)).size, 3);
  });

  test('429 => cooldown 65s, hết cooldown thì dùng lại', async () => {
    const { kr, clock } = await setup();
    await kr.addKeys('grok', 'xai-key-one-11111\nxai-key-two-22222');
    const a = kr.pick('grok');
    kr.report('grok', a.id, 429);
    for (let i = 0; i < 4; i++) assert.notEqual(kr.pick('grok').id, a.id);
    assert.equal(kr.listMasked('grok').find((k) => k.id === a.id).status, 'cooldown');
    clock.advance(COOLDOWN_429_MS - 1);
    const ids = new Set([kr.pick('grok').id, kr.pick('grok').id]);
    assert.ok(!ids.has(a.id));
    clock.advance(2);
    // sau 65s key a ít dùng hơn => được chọn
    assert.equal(kr.pick('grok').id, a.id);
  });

  test('tất cả key cooldown => pick null + nextAvailableIn', async () => {
    const { kr, clock } = await setup();
    await kr.addKeys('nvidia', 'nvapi-only-key-0001');
    const a = kr.pick('nvidia');
    kr.report('nvidia', a.id, 429, { retryAfterMs: 90000 });
    assert.equal(kr.pick('nvidia'), null);
    assert.equal(kr.nextAvailableIn('nvidia'), 90000);
    clock.advance(90000);
    assert.ok(kr.pick('nvidia'));
  });

  test('401 => đánh dấu invalid', async () => {
    const { kr } = await setup();
    await kr.addKeys('mistral', 'mistral-bad-key-0001');
    const a = kr.pick('mistral');
    kr.report('mistral', a.id, 401);
    assert.equal(kr.listMasked('mistral')[0].status, 'invalid');
    kr.resetCooldown(a.id);
    assert.equal(kr.listMasked('mistral')[0].status, 'ready');
  });

  test('vault khóa => keyring không có key', async () => {
    const db = createMemoryDB();
    const v = makeVault(db);
    await v.create('mat-khau-dai-1');
    const kr = createKeyring({ vault: v, cryptoImpl });
    await kr.addKeys('gemini', 'AIza-test-key-00001');
    assert.equal(kr.count('gemini'), 1);
    v.lock();
    assert.equal(kr.count('gemini'), 0);
    assert.equal(kr.pick('gemini'), null);
    assert.deepEqual(kr.listMasked('gemini'), []);
  });
});
