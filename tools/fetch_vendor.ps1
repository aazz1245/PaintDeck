# 下載打包要用、但不放進版控的兩個執行檔到 vendor\（tauri.conf.json 的 bundle.resources 會用到；cargo build／test 也要有）：
#   vendor\7zip\7zr.exe                 7-Zip 26.04 主控台版：安裝精靈解 ComfyUI 官方免安裝版（.7z）用。7zr.exe 標示 Public domain
#   vendor\onnxruntime\onnxruntime.dll  ONNX Runtime 1.30.0 CPU 版：反推（WD tagger）用。MIT（Microsoft）
#                                       從 PyPI 的 onnxruntime-1.30.0-cp312-cp312-win_amd64.whl 取出
# 兩個檔都比對 SHA-256（2026-10-20 實測跟官方來源逐位元相同）；對不上就停，不留下檔案。已經有、而且雜湊對的就跳過。
#
# 用法（在專案根目錄）：powershell -ExecutionPolicy Bypass -File tools\fetch_vendor.ps1
#   -Dest <資料夾>   改放別的地方（預設是專案根目錄的 vendor）
param([string]$Dest = (Join-Path (Split-Path $PSScriptRoot -Parent) 'vendor'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$SevenZip = @{
    Path = Join-Path $Dest '7zip\7zr.exe'
    Url  = 'https://github.com/ip7z/7zip/releases/download/26.04/7zr.exe'
    Sha  = '256FECA8E274E5DA655E2A284FABAFD9F554365EB164862089DACD4E8276D282'
}
$Onnx = @{
    Path     = Join-Path $Dest 'onnxruntime\onnxruntime.dll'
    Wheel    = 'onnxruntime-1.30.0-cp312-cp312-win_amd64.whl'
    WheelSha = 'F3501472571F1B1EEE50E017851E7929F5EA37312D2D8C2494A19E8FC58B4A38'
    Inner    = 'onnxruntime/capi/onnxruntime.dll'
    Sha      = 'E42C5C917207FF706530315177E39DCA2539695A6A8D968A22225E34291B1F12'
}

function Test-Hash([string]$File, [string]$Sha) {
    (Test-Path $File) -and ((Get-FileHash $File -Algorithm SHA256).Hash -eq $Sha)
}

function Save-Checked([string]$Tmp, [string]$Path, [string]$Sha) {
    $got = (Get-FileHash $Tmp -Algorithm SHA256).Hash
    if ($got -ne $Sha) {
        Remove-Item $Tmp -Force
        throw "SHA-256 不對：$Path`n  應該是 $Sha`n  下載到 $got"
    }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    Move-Item $Tmp $Path -Force
    Write-Host "  好了：$Path"
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("anima_vendor_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    Write-Host '7zr.exe'
    if (Test-Hash $SevenZip.Path $SevenZip.Sha) {
        Write-Host '  已經有了，跳過'
    } else {
        $tmp = Join-Path $work '7zr.exe'
        Invoke-WebRequest -UseBasicParsing $SevenZip.Url -OutFile $tmp
        Save-Checked $tmp $SevenZip.Path $SevenZip.Sha
    }

    Write-Host 'onnxruntime.dll'
    if (Test-Hash $Onnx.Path $Onnx.Sha) {
        Write-Host '  已經有了，跳過'
    } else {
        $meta = Invoke-RestMethod 'https://pypi.org/pypi/onnxruntime/1.30.0/json'
        $url = ($meta.urls | Where-Object { $_.filename -eq $Onnx.Wheel } | Select-Object -First 1).url
        if (-not $url) { throw "PyPI 上找不到 $($Onnx.Wheel)" }
        $whl = Join-Path $work $Onnx.Wheel
        Invoke-WebRequest -UseBasicParsing $url -OutFile $whl
        if ((Get-FileHash $whl -Algorithm SHA256).Hash -ne $Onnx.WheelSha) { throw "wheel 的 SHA-256 不對：$($Onnx.Wheel)" }
        $zip = [IO.Compression.ZipFile]::OpenRead($whl)
        try {
            $entry = $zip.Entries | Where-Object { $_.FullName -eq $Onnx.Inner } | Select-Object -First 1
            if (-not $entry) { throw "wheel 裡沒有 $($Onnx.Inner)" }
            $tmp = Join-Path $work 'onnxruntime.dll'
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmp, $true)
        } finally {
            $zip.Dispose()
        }
        Save-Checked $tmp $Onnx.Path $Onnx.Sha
    }
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
