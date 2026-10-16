# VENDOR — thư viện tự host (phiên bản cố định)

Tải từ jsDelivr (bản npm chính thức). Không dùng CDN lúc chạy. Kiểm tra: `sha256sum -c` với bảng dưới.

| File | Gói | Phiên bản | Giấy phép | Nguồn | SHA-256 |
|---|---|---|---|---|---|
| jszip.min.js | jszip | 3.10.1 | MIT OR GPL-3.0 | https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |
| FileSaver.min.js | file-saver | 2.0.5 | MIT | https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js | `c68874cbaa2fd1650b7d770b328680ea765fb3376023cc3608427fde4f0d0481` |
| mermaid.min.js | mermaid | 12.1.0 | MIT | https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js | `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2` |
| marked.esm.js | marked | 18.1.0 | MIT | https://cdn.jsdelivr.net/npm/marked@18.1.0/lib/marked.esm.js | `054d73b676031dc8e60e247ef228044fbeebe10af14bac1a6e53852f80f826e5` |
| purify.es.mjs | dompurify | 3.4.16 | MPL-2.0 OR Apache-2.0 | https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.es.mjs | `c44274a7959cfdd4da871fa78a5d5fbbef55db68d118c5c0833bc4b5cf9633ad` |
| purify.min.js | dompurify | 3.4.16 | MPL-2.0 OR Apache-2.0 | https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js | `2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2` |
| acorn.mjs | acorn | 8.19.0 | MIT | https://cdn.jsdelivr.net/npm/acorn@8.19.0/dist/acorn.mjs | `76254fc76529713b4dfd2532972d17a991ffd9aafeebb1f977445b5506b9fb0b` |
| pdfjs/pdf.min.mjs | pdfjs-dist | 6.4.299 | Apache-2.0 | https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| pdfjs/pdf.worker.min.mjs | pdfjs-dist | 6.4.299 | Apache-2.0 | https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |
| mammoth.browser.min.js | mammoth | 1.13.0 | BSD-2-Clause | https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js | `92914a3708cfdf1e62cb553d1856a7fedab21da83d8ee82845de2f897b368cab` |

purify.min.js (UMD) dùng trong /mermaid-frame.html (iframe sandbox origin mờ không nạp được ES module do không có CORS).
