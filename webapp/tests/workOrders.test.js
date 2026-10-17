import { test } from 'node:test';
import assert from 'node:assert/strict';
import { woId, nextRev, appendLedger, checkMerge } from '../public/js/core/workOrders.js';

test('woId đúng định dạng', () => {
  assert.equal(woId({ projectId: 'proj_abc123XYZ', step: 'fix', path: 'Index.html', rev: 2 }), 'WO-123XYZ-fix-Index.html-r2');
  assert.equal(woId({ projectId: 'x', step: 'upgrade', path: 'data/seed.json', rev: 1 }), 'WO-x-upgrade-data_seed.json-r1');
});

test('nextRev tăng theo từng cặp bước + file', () => {
  const l = [{ step: 'fix', path: 'A', rev: 1 }, { step: 'fix', path: 'A', rev: 3 }, { step: 'upgrade', path: 'A', rev: 5 }];
  assert.equal(nextRev(l, 'fix', 'A'), 4);
  assert.equal(nextRev(l, 'fix', 'B'), 1);
  assert.equal(nextRev(undefined, 'fix', 'A'), 1);
});

test('appendLedger giới hạn số dòng', () => {
  const out = appendLedger([{ n: 1 }, { n: 2 }, { n: 3 }], { n: 4 }, 3);
  assert.equal(out.length, 3);
  assert.equal(out[2].n, 4);
});

test('checkMerge: các quy tắc hợp nhất', () => {
  const wo = { id: 'WO-1', status: 'verified', contractHash: 'c1', baseHash: 'b1' };
  assert.equal(checkMerge({ wo, currentContractHash: 'c1', currentBaseHash: 'b1', syntaxStatus: 'pass' }).ok, true);
  const c = checkMerge({ wo, currentContractHash: 'c2', currentBaseHash: 'b1', syntaxStatus: 'pass' });
  assert.equal(c.ok, false);
  assert.match(c.errors.join(' '), /Contract đã đổi/);
  assert.match(checkMerge({ wo, currentContractHash: 'c1', currentBaseHash: 'b2', syntaxStatus: 'pass' }).errors.join(' '), /File đã bị thay đổi/);
  assert.equal(checkMerge({ wo, currentContractHash: 'c1', currentBaseHash: 'b1', syntaxStatus: 'fail' }).ok, false);
  assert.equal(checkMerge({ wo, currentContractHash: 'c1', currentBaseHash: 'b1', syntaxStatus: 'pass', truncated: true }).ok, false);
  const u = checkMerge({ wo: { ...wo, status: 'drafted' }, currentContractHash: 'c1', currentBaseHash: 'b1', syntaxStatus: 'unchecked' });
  assert.equal(u.ok, true);
  assert.equal(u.warnings.length, 1);
  assert.equal(checkMerge({ wo: { ...wo, status: 'merged' }, currentContractHash: 'c1', currentBaseHash: 'b1', syntaxStatus: 'pass' }).ok, false);
  assert.equal(checkMerge({ wo: null, syntaxStatus: 'pass' }).ok, false);
});
