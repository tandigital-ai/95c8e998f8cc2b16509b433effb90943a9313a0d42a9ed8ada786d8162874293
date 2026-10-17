"""Smoke test giao diện bằng Playwright (Python). Không thuộc `npm test` (cần Chromium).
Chạy: python3 tests/e2e/smoke.py [base_url]  — server phải đang chạy."""
import sys, json
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
OUT = '/tmp/shots'
import os; os.makedirs(OUT, exist_ok=True)
errors = []

def attach(page):
    page.on('console', lambda m: errors.append(f'[console.{m.type}] {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'[pageerror] {e}'))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page(); attach(page)
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_timeout(1500)
    page.screenshot(path=f'{OUT}/home-1440.png', full_page=True)
    buttons = ['#btn-projects', '#btn-vault', '#btn-analyze', '#btn-workflow', '#btn-export', '#btn-cost', '#btn-logs', '#btn-settings', '#btn-limits']
    for sel in buttons:
        el = page.query_selector(sel)
        if not el: errors.append(f'[missing] {sel}'); continue
        try:
            el.click(timeout=3000)
            page.wait_for_timeout(700)
            page.screenshot(path=f'{OUT}/modal-{sel[5:]}.png')
            page.keyboard.press('Escape'); page.wait_for_timeout(300)
        except Exception as e:
            errors.append(f'[click {sel}] {e}')
    for w, hgt in [(375, 800), (768, 1000)]:
        page.set_viewport_size({'width': w, 'height': hgt}); page.wait_for_timeout(400)
        page.screenshot(path=f'{OUT}/home-{w}.png', full_page=True)
        sw = page.evaluate('document.documentElement.scrollWidth')
        if sw > w + 1: errors.append(f'[layout] tràn ngang ở {w}px: scrollWidth={sw}')
    b.close()

print(json.dumps(errors, ensure_ascii=False, indent=1))
print('ERRORS:', len(errors))
