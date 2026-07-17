# JKBMS Pro Mobil GitHub Pages Deployment Helper Script
# This script initializes Git, commits your files, and prepares to push to your GitHub account.

$ErrorActionPreference = "Stop"

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "   JKBMS Pro Mobil GitHub Pages Deployer       " -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan

# 1. Ask user to create the repo
Write-Host "Lütfen tarayıcınızda şu adımları takip edin:" -ForegroundColor Yellow
Write-Host "1. https://github.com/new adresine gidin." -ForegroundColor White
Write-Host "2. Repository Name (Depo Adı) kısmına 'BMSmobil' yazın." -ForegroundColor White
Write-Host "3. Depoyu 'Public' (Kamuya Açık) olarak seçin." -ForegroundColor White
Write-Host "4. Alt kısımdaki 'Create Repository' (Depo Oluştur) butonuna tıklayın." -ForegroundColor White
Write-Host "   (README, .gitignore veya License eklemeyin, tamamen boş kalsın)." -ForegroundColor Gray

Write-Host ""
$confirm = Read-Host "Depoyu oluşturdunuz mu? (E/H)"
if ($confirm -ne "E" -and $confirm -ne "e") {
    Write-Host "İşlem iptal edildi. Depoyu oluşturduktan sonra tekrar deneyin." -ForegroundColor Red
    Exit 1
}

# 2. Git setup
Write-Host ""
Write-Host "Git deposu başlatılıyor..." -ForegroundColor Yellow

if (Test-Path ".git") {
    Remove-Item -Recurse -Force ".git"
}

git init
git branch -M main

# Add files
git add .
git commit -m "Initial commit JKBMS Pro Mobil PWA"

# Add remote
$remoteUrl = "https://github.com/bugrabayin/BMSmobil.git"
Write-Host "Uzak depo adresi ekleniyor: $remoteUrl" -ForegroundColor Yellow
git remote add origin $remoteUrl

# Push
Write-Host ""
Write-Host "Dosyalar GitHub'a yükleniyor. Giriş yapmanız istenebilir..." -ForegroundColor Green
git push -u origin main --force

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "  YÜKLEME BAŞARILI! SON 1 ADIM KALDI:                 " -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "1. GitHub'da https://github.com/bugrabayin/BMSmobil adresine gidin." -ForegroundColor White
Write-Host "2. Üst menüden 'Settings' (Ayarlar) sekmesine tıklayın." -ForegroundColor White
Write-Host "3. Sol menüden 'Pages' seçeneğine gidin." -ForegroundColor White
Write-Host "4. 'Build and deployment > Source' kısmını 'Deploy from a branch' yapın." -ForegroundColor White
Write-Host "5. 'Branch' altından 'main' ve klasör olarak '/ (root)' seçip 'Save' butonuna tıklayın." -ForegroundColor White
Write-Host ""
Write-Host "Yaklaşık 1 dakika içinde uygulamanız şu adreste yayında olacaktır:" -ForegroundColor Cyan
Write-Host "https://bugrabayin.github.io/BMSmobil/index.html" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Green
