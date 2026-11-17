# Receipts — handoff package for Claude Code

## Cara pakai (untuk ALFA / Michael)

1. Extract zip ini ke folder kosong, misalnya `receipts/`.
2. Buka folder itu di **Claude Code**.
3. Copy isi `CLAUDE_CODE_PROMPT.md` (bagian di bawah garis) lalu paste ke Claude Code.
4. Claude Code akan membangun proyek per milestone (M0 → M6) dan hanya berhenti untuk minta: API key / private key, dan izin sebelum deploy kontrak ke **mainnet** atau memakai dana asli.
5. Deploy ke VPS Hostinger mengikuti `deploy/DEPLOY.md`.

## Isi paket

| File                      | Untuk apa                                                                      |
| ------------------------- | ------------------------------------------------------------------------------ |
| `CLAUDE_CODE_PROMPT.md`   | Prompt siap paste ke Claude Code                                               |
| `HANDOFF.md`              | Spesifikasi lengkap: produk, arsitektur, milestone, keamanan, checklist launch |
| `CLAUDE.md`               | Aturan kerja repo untuk Claude Code (stack, perintah, konvensi)                |
| `specs/CONTRACTS.md`      | Spesifikasi smart contract + invariant + test yang wajib                       |
| `specs/contracts/*.sol`   | Interface Solidity (sudah dicek compile dengan solc 0.8.26)                    |
| `specs/schema.prisma`     | Skema database (sudah divalidasi Prisma)                                       |
| `specs/API.md`            | Endpoint API                                                                   |
| `specs/WORKER.md`         | Bot: indexer, runner strategi, executor, revealer, alert                       |
| `specs/DESIGN.md`         | Design token + komponen dari prototipe                                         |
| `prototype/receipts.html` | Prototipe UI yang sudah di-approve (acuan desain)                              |
| `config/robinhood.json`   | Alamat token, Chainlink feed, pool Uniswap di Robinhood Chain                  |
| `deploy/`                 | PM2, Nginx, env contoh, script deploy, docker-compose dev, panduan VPS         |
| `reference/nouny-agent/`  | Kontrak vault NOUNY (lisensi MIT) sebagai basis fork                           |

## Catatan

- Nama "Receipts" dan domain masih sementara. Ganti lewat `APP_NAME` dan `APP_DOMAIN` di `.env`.
- Alamat di `config/robinhood.json` diambil dari repo NOUNY (MIT). Wajib dicek ulang on-chain sebelum mainnet (sudah diinstruksikan ke Claude Code).
- Kontrak harus diaudit eksternal sebelum batas harian beta ($2,000 per vault) dinaikkan.
