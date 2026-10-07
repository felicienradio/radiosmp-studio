# Télécharge et installe Icecast pour Windows depuis le site officiel (xiph.org).
# Usage : powershell -ExecutionPolicy Bypass -File scripts\install-icecast.ps1
$ErrorActionPreference = 'Stop'
$version = '2.5.0'
$url = "https://downloads.xiph.org/releases/icecast/icecast_win64_$version.exe"
$installer = Join-Path $env:TEMP "icecast_win64_$version.exe"

if (Test-Path 'C:\Program Files\Icecast\bin\icecast.exe') {
    Write-Host 'Icecast est deja installe dans C:\Program Files\Icecast'
    exit 0
}

Write-Host "Telechargement de $url ..."
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing

Write-Host "Installation (une fenetre d'autorisation administrateur peut s'afficher)..."
$p = Start-Process -FilePath $installer -ArgumentList '/S' -Verb RunAs -Wait -PassThru
Remove-Item $installer -ErrorAction SilentlyContinue

if ($p.ExitCode -ne 0 -or -not (Test-Path 'C:\Program Files\Icecast\bin\icecast.exe')) {
    throw "L'installation a echoue (code $($p.ExitCode))"
}
Write-Host 'Icecast installe dans C:\Program Files\Icecast'
Write-Host "Il n'est pas lance comme service : c'est le dashboard Flux qui le demarre avec sa propre configuration."
