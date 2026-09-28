# Setup Baileys Server di VPS Contabo

## Persyaratan
- Node.js 18+ (cek: `node -v`)
- PM2 untuk keep-alive

## Langkah Install

### 1. SSH ke VPS
```bash
ssh root@185.194.219.199
```

### 2. Install Node.js 18 (kalau belum)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # pastikan v18+
```

### 3. Install PM2
```bash
npm install -g pm2
```

### 4. Upload folder baileys-server ke VPS
Dari lokal (Mac):
```bash
scp -r ~/Downloads/Botwa-main/baileys-server root@185.194.219.199:/root/baileys-server
```

### 5. Di VPS: install dependencies
```bash
cd /root/baileys-server
npm install
```

### 6. Buat file .env
```bash
cp .env.example .env
nano .env
```
Isi:
```
PORT=3000
VERCEL_WEBHOOK_URL=https://botwa-kappa.vercel.app/api/webhook-baileys
WEBHOOK_SECRET=buat_secret_random_panjang_disini
MAX_OUTBOUND_PER_DAY=50
```

### 7. Jalankan & scan QR
```bash
node index.js
```
Scan QR code yang muncul dengan WA yang mau dipakai.
Setelah scan → tekan Ctrl+C

### 8. Jalankan dengan PM2 (auto-restart)
```bash
pm2 start index.js --name baileys-cs
pm2 save
pm2 startup  # ikuti instruksi yang muncul
```

### 9. Buka port 3000 di firewall VPS
```bash
ufw allow 3000
```

### 10. Verifikasi
Buka browser: http://185.194.219.199:3000/health
Harus return: `{"status":"connected","wa_number":"628xxx",...}`

---

## Env Vars yang perlu ditambah di Vercel
Di Vercel dashboard → Settings → Environment Variables:

| Key | Value |
|-----|-------|
| BAILEYS_URL | http://185.194.219.199:3000 |
| WEBHOOK_SECRET | (sama dengan di .env VPS) |
| ANTHROPIC_KEY | sk-ant-xxx |
| MENGANTAR_KEY | (dari dashboard Mengantar) |

---

## Cek log
```bash
pm2 logs baileys-cs
pm2 status
```

## Restart
```bash
pm2 restart baileys-cs
```
