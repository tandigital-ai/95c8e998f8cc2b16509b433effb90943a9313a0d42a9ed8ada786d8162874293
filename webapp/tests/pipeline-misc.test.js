import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDB } from '../public/js/core/db.js';
import { createPipeline, STEPS, summarizeJob } from '../public/js/core/pipeline.js';
import { sanitizeMermaid, cleanLabel, workflowDiagram } from '../public/js/core/mermaidSanitize.js';
import { diffLines, diffStats, diffFileSets, diffHunks } from '../public/js/core/diff.js';
import { buildExportEntries, applyBanner, safeZipPath, slugify, toCsv } from '../public/js/core/exporter.js';
import { sha256Hex, canonicalJson } from '../public/js/core/hash.js';

function makeExecutors(log, { failContract = false, truncateFile = null, files = ['a.js', 'b.js'] } = {}) {
  const ex = {};
  const state = { inputs: { architecture: 'idea-1' } };
  for (const s of STEPS) {
    if (s === 'build-files') continue;
    ex[s] = {
      input: () => state.inputs[s] || s,
      run: async () => {
        log.push(s);
        if (s === 'contract' && failContract) return { status: 'failed', error: 'Contract sai schema', halt: true };
        return { status: 'done' };
      }
    };
  }
  ex['build-files'] = {
    files: () => files,
    fileInput: (_c, p) => ({ p, v: state.inputs[p] || 1 }),
    buildFile: async (ctx, p) => {
      log.push('file:' + p);
      if (ctx.hold && p === 'b.js') await new Promise((res, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason)));
      if (p === truncateFile) return { status: 'truncated', note: 'length' };
      return { status: 'done' };
    }
  };
  return { ex, state };
}

describe('pipeline', () => {
  test('chạy trọn, checkpoint vào jobs, tổng kết', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex } = makeExecutors(log);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P1');
    const done = await pl.run(job.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(log, ['architecture', 'contract', 'file:a.js', 'file:b.js', 'checks', 'review', 'fix', 'seed', 'readme', 'save-version']);
    const saved = await db.get('jobs', job.id);
    assert.equal(saved.steps.contract.status, 'done');
    assert.equal(summarizeJob(saved).filesDone, 2);
  });

  test('Contract lỗi ⇒ DỪNG pipeline, không sinh file', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex } = makeExecutors(log, { failContract: true });
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    const r = await pl.run(job.id);
    assert.equal(r.status, 'failed');
    assert.ok(!log.some((x) => x.startsWith('file:')));
    assert.equal(r.steps.contract.error, 'Contract sai schema');
  });

  test('file bị cắt ⇒ truncated, job "done-with-issues" (không bao giờ "done")', async () => {
    const db = createMemoryDB();
    const { ex } = makeExecutors([], { truncateFile: 'b.js' });
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    const r = await pl.run(job.id);
    assert.equal(r.files['b.js'].status, 'truncated');
    assert.equal(r.steps['build-files'].status, 'truncated');
    assert.equal(r.status, 'done-with-issues');
  });

  test('Hủy giữa chừng ⇒ paused; Resume chỉ chạy phần còn lại (không gọi lại bước đã xong)', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex } = makeExecutors(log);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    const p = pl.run(job.id, { context: { hold: true } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pl.cancel(), true);
    const paused = await p;
    assert.equal(paused.status, 'paused');
    assert.equal(paused.files['a.js'].status, 'done');
    assert.equal(paused.files['b.js'].status, 'pending');
    log.length = 0;
    const r = await pl.resume(job.id);
    assert.equal(r.status, 'done');
    assert.deepEqual(log, ['file:b.js', 'checks', 'review', 'fix', 'seed', 'readme', 'save-version']);
  });

  test('tải lại trang khi đang chạy ⇒ interrupted', async () => {
    const db = createMemoryDB();
    const { ex } = makeExecutors([]);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    job.status = 'running';
    job.steps.contract.status = 'running';
    await db.put('jobs', job);
    const pl2 = createPipeline({ db, executors: ex });
    assert.equal(await pl2.markInterrupted(), 1);
    const j = await db.get('jobs', job.id);
    assert.equal(j.status, 'interrupted');
    assert.equal(j.steps.contract.status, 'pending');
  });

  test('chạy lại khi đầu vào KHÔNG đổi ⇒ không gọi lại; đổi đầu vào ⇒ chạy lại bước đó', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex, state } = makeExecutors(log);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    await pl.run(job.id);
    log.length = 0;
    await pl.run(job.id);
    assert.deepEqual(log, []);
    state.inputs.readme = 'đổi';
    state.inputs['a.js'] = 2;
    await pl.run(job.id);
    assert.deepEqual(log, ['file:a.js', 'readme']);
  });

  test('retryFile + retryStep', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex } = makeExecutors(log);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P');
    await pl.run(job.id);
    log.length = 0;
    await pl.retryFile(job.id, 'b.js');
    assert.deepEqual(log, ['file:b.js']);
    log.length = 0;
    await pl.retryStep(job.id, 'seed');
    assert.deepEqual(log, ['seed']);
  });

  test('bỏ qua bước tùy chọn', async () => {
    const db = createMemoryDB();
    const log = [];
    const { ex } = makeExecutors(log);
    const pl = createPipeline({ db, executors: ex });
    const job = await pl.create('P', { skip: ['review', 'fix', 'seed'] });
    const r = await pl.run(job.id);
    assert.ok(!log.includes('review'));
    assert.equal(r.steps.review.status, 'skipped');
  });

  test('không cho 2 pipeline chạy song song', async () => {
    const db = createMemoryDB();
    const { ex } = makeExecutors([]);
    const pl = createPipeline({ db, executors: ex });
    const a = await pl.create('P');
    const b = await pl.create('Q');
    const p = pl.run(a.id, { context: { hold: true } });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(pl.run(b.id), (e) => e.code === 'BUSY');
    pl.cancel();
    await p;
  });
});

describe('mermaid sanitize', () => {
  test('ép flowchart TD, quote nhãn, chuyển "A --> B: x"', () => {
    const r = sanitizeMermaid('```mermaid\ngraph LR\n  A[Người dùng (web)] --> B{Đã duyệt?}\n  B --> C: Có\n  B --> D |Không|\n```');
    const lines = r.code.split('\n');
    assert.equal(lines[0], 'flowchart TD');
    assert.ok(r.code.includes('A["Người dùng web"]'));
    assert.ok(r.code.includes('B{"Đã duyệt?"}'));
    assert.ok(r.code.includes('B -->|Có| C'));
    assert.ok(r.code.includes('B -->|Không| D'));
    assert.ok(r.warnings.some((w) => /flowchart TD/.test(w)));
  });
  test('gộp nhãn vỡ dòng, bỏ văn bản thừa và marker', () => {
    const r = sanitizeMermaid('Đây là sơ đồ:\n===DIAGRAM_START===\nflowchart TD\n  A["Dòng một\n  dòng hai"] --> B[(Dữ liệu)]\n===DIAGRAM_END===');
    assert.ok(r.code.includes('A["Dòng một dòng hai"]'), r.code);
    assert.ok(r.code.includes('B[("Dữ liệu")]'), r.code);
  });
  test('nhãn tối đa 6 từ, cảnh báo quá 18 node', () => {
    assert.equal(cleanLabel('một hai ba bốn năm sáu bảy tám'), 'một hai ba bốn năm sáu…');
    const many = ['flowchart TD', ...Array.from({ length: 20 }, (_, i) => `  N${i} --> N${i + 1}`)].join('\n');
    const r = sanitizeMermaid(many);
    assert.ok(r.warnings.some((w) => /node/.test(w)));
    assert.equal(r.stats.edges, 20);
  });
  test('rỗng / không nhận ra', () => {
    assert.match(sanitizeMermaid('').code, /flowchart TD/);
    assert.match(sanitizeMermaid('chỉ là văn bản').warnings[0], /Không nhận ra/);
  });
  test('workflowDiagram', () => {
    const code = workflowDiagram([{ name: 'Bot A' }, { name: 'Data Seeder & QA' }]);
    assert.ok(code.startsWith('flowchart TD'));
    assert.ok(code.includes('S1["Data Seeder QA"]'));
  });
});

describe('diff', () => {
  test('diff dòng', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc\nd');
    assert.deepEqual(diffStats(ops), { added: 2, removed: 1, changed: true });
    assert.deepEqual(ops.map((o) => o.op), ['eq', 'del', 'add', 'eq', 'add']);
    assert.equal(diffHunks(diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\n4\nX\n6\n7\n8\n9'), 1)[0].length, 4);
  });
  test('diff tập file', () => {
    const r = diffFileSets({ a: '1', b: '2', c: '3' }, { a: '1', b: '22', d: '4' });
    assert.deepEqual(r.map((x) => `${x.path}:${x.status}`), ['a:same', 'b:modified', 'c:removed', 'd:added']);
  });
});

describe('exporter', () => {
  test('manifest có SHA-256 đúng + trạng thái kiểm tra thật, không nói "đã chạy"', async () => {
    const snapshot = {
      claudeMd: '# A', skills: [{ filename: 'skill-01', name: 'Bot', content: 'x' }], diagram: 'flowchart TD',
      contract: { projectName: 'A' }, validation: { ok: true }, seed: { seed: {} },
      files: {
        'Code.gs': { content: 'function a(){}', state: 'syntax-checked', checks: { syntax: { status: 'pass', checker: 'acorn' } } },
        'x.py': { content: 'print(1)', state: 'generated', checks: { syntax: { status: 'unchecked' } } },
        'b.js': { content: 'cut', state: 'truncated', truncated: true }
      }
    };
    const { entries, manifest, root } = await buildExportEntries({ project: { name: 'Dự án Ví dụ' }, snapshot });
    assert.equal(root, 'du-an-vi-du');
    const paths = entries.map((e) => e.path);
    for (const p of ['README.md', 'docs/Claude.md', 'docs/skills/skill-01.md', 'docs/contract.json', 'docs/validation-report.json', 'docs/diagram.mmd', 'data/seed.json', 'manifest.json', 'Code.gs']) {
      assert.ok(paths.includes(`${root}/${p}`), p);
    }
    const code = manifest.files.find((f) => f.path === 'Code.gs');
    assert.equal(code.sha256, await sha256Hex('function a(){}'));
    assert.equal(code.syntax.status, 'pass');
    assert.equal(code.runtimeTested, false);
    assert.equal(manifest.files.find((f) => f.path === 'b.js').truncated, true);
    assert.equal(manifest.summary.truncated, 1);
    assert.equal(manifest.summary.syntaxUnchecked, 2);
  });
  test('ZIP thật bằng JSZip: mở ra đúng cấu trúc', async () => {
    // jszip.min.js là UMD; package.json "type":"module" khiến Node coi .js là ESM ⇒ chép sang .cjs tạm để nạp.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const tmp = path.join(os.tmpdir(), `jszip-${process.pid}.cjs`);
    fs.copyFileSync(new URL('../public/vendor/jszip.min.js', import.meta.url), tmp);
    const JSZip = createRequire(import.meta.url)(tmp);
    assert.equal(typeof JSZip, 'function', 'không nạp được JSZip');
    const { entries } = await buildExportEntries({ project: { name: 'Z' }, snapshot: { files: { 'a.js': { content: 'x' } } } });
    const { buildZipBlob } = await import('../public/js/core/exporter.js');
    const buf = await buildZipBlob({ JSZip, entries, type: 'uint8array' });
    const z = await JSZip.loadAsync(buf);
    assert.ok(z.file('z/a.js'));
    assert.ok(z.file('z/manifest.json'));
    assert.equal(await z.file('z/a.js').async('string'), 'x');
  });
  test('banner: tắt mặc định; bật thì đúng cú pháp từng loại, không chèn json/txt, giữ shebang', () => {
    assert.equal(applyBanner('a.js', 'x', { enabled: false, author: 'T' }), 'x');
    const b = { enabled: true, author: 'TDA', contact: 'c' };
    assert.match(applyBanner('a.js', 'x', b), /^\/\* AI-ARCHITECT-BANNER/);
    assert.match(applyBanner('a.py', 'x', b), /^# Tác giả: TDA/);
    assert.equal(applyBanner('requirements.txt', 'flask', b), 'flask');
    assert.equal(applyBanner('a.json', '{}', b), '{}');
    assert.match(applyBanner('cli.js', '#!/usr/bin/env node\nx', b), /^#!\/usr\/bin\/env node\n\/\*/);
    const once = applyBanner('a.js', 'x', b);
    assert.equal(applyBanner('a.js', once, b), once, 'không chèn 2 lần');
  });
  test('đường dẫn an toàn, CSV injection', () => {
    assert.equal(safeZipPath('../../etc/passwd'), 'etc/passwd');
    assert.throws(() => safeZipPath('../..'));
    assert.equal(slugify(''), 'ai-project');
    const csv = toCsv([{ a: '=HYPERLINK()', b: 'x,"y"' }], [{ key: 'a' }, { key: 'b' }]);
    assert.ok(csv.includes("'=HYPERLINK()"));
    assert.ok(csv.includes('"x,""y"""'));
  });
  test('canonicalJson ổn định', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
