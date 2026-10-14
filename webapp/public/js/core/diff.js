/**
 * diff.js — Diff theo dòng (thuật toán LCS/Myers đơn giản) cho xem trước bản sửa và so sánh version.
 * Hàm thuần, có test.
 */

/**
 * @returns {Array<{op:'eq'|'add'|'del', a:number|null, b:number|null, text:string}>}
 */
export function diffLines(oldText, newText, { maxCells = 4_000_000 } = {}) {
  const a = String(oldText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(newText ?? '').replace(/\r\n?/g, '\n').split('\n');
  // bỏ phần đầu/cuối giống nhau để giảm kích thước bảng
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'eq', a: i + 1, b: i + 1, text: a[i] });
  const A = a.slice(start, endA + 1);
  const B = b.slice(start, endB + 1);
  const n = A.length;
  const m = B.length;
  if (n * m > maxCells) {
    // Quá lớn: hiển thị dạng thay thế khối (vẫn đúng, chỉ kém gọn)
    A.forEach((t, i) => ops.push({ op: 'del', a: start + i + 1, b: null, text: t }));
    B.forEach((t, i) => ops.push({ op: 'add', a: null, b: start + i + 1, text: t }));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ op: 'eq', a: start + i + 1, b: start + j + 1, text: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', a: start + i + 1, b: null, text: A[i] }); i++; }
      else { ops.push({ op: 'add', a: null, b: start + j + 1, text: B[j] }); j++; }
    }
    while (i < n) { ops.push({ op: 'del', a: start + i + 1, b: null, text: A[i] }); i++; }
    while (j < m) { ops.push({ op: 'add', a: null, b: start + j + 1, text: B[j] }); j++; }
  }
  const offB = b.length - a.length;
  for (let i = endA + 1; i < a.length; i++) ops.push({ op: 'eq', a: i + 1, b: i + 1 + offB, text: a[i] });
  return ops;
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o.op === 'add') added++; else if (o.op === 'del') removed++; }
  return { added, removed, changed: added + removed > 0 };
}

/** Gom thành các khối có ngữ cảnh (giống unified diff). */
export function diffHunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== 'eq') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const hunks = [];
  let cur = null;
  ops.forEach((o, i) => {
    if (keep[i]) { if (!cur) { cur = []; hunks.push(cur); } cur.push(o); } else cur = null;
  });
  return hunks;
}

/** So sánh 2 tập file (path -> nội dung). */
export function diffFileSets(oldFiles = {}, newFiles = {}) {
  const paths = [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].sort();
  return paths.map((path) => {
    const o = oldFiles[path];
    const n = newFiles[path];
    if (o === undefined) return { path, status: 'added', stats: { added: String(n).split('\n').length, removed: 0, changed: true } };
    if (n === undefined) return { path, status: 'removed', stats: { added: 0, removed: String(o).split('\n').length, changed: true } };
    if (o === n) return { path, status: 'same', stats: { added: 0, removed: 0, changed: false } };
    const ops = diffLines(o, n);
    return { path, status: 'modified', stats: diffStats(ops), ops };
  });
}
