# Full rebuild script for IPC-2581 Viewer Extension
# Run this script after closing VS Code completely

Write-Host "Building Rust LSP Server..." -ForegroundColor Cyan
cargo build --release --bin lsp_server
if ($LASTEXITCODE -ne 0) {
    Write-Host "Rust build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Copying LSP Server binary..." -ForegroundColor Cyan
if (!(Test-Path "bin")) {
    New-Item -ItemType Directory -Path "bin"
}
Copy-Item "target\release\lsp_server.exe" "bin\" -Force

Write-Host "Building Extension..." -ForegroundColor Cyan
npm run build:extension
if ($LASTEXITCODE -ne 0) {
    Write-Host "Extension build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Building Webview..." -ForegroundColor Cyan
npm run build:webview
if ($LASTEXITCODE -ne 0) {
    Write-Host "Webview build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "`nBuild complete! You can now restart VS Code." -ForegroundColor Green
