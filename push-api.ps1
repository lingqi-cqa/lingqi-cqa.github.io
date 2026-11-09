param([string]$token)
if (-not $token) { Write-Error "token not provided"; exit 1 }

$headers = @{ Authorization = "Bearer $token"; "User-Agent" = "deploy-script" }
$owner = "lingqi-cqa"
$repo  = "lingqi-cqa.github.io"
$base  = "C:\Users\tan'wen'wen\gh-deploy"
$api   = "https://api.github.com/repos/$owner/$repo"

function Invoke-Api {
    param($Uri, $Method, $Body, $Timeout = 120)
    try {
        $ht = @{ Authorization = "Bearer $token"; "User-Agent" = "deploy-script" }
        if ($Body) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $ht `
                -Body $Body -ContentType "application/json" -TimeoutSec $Timeout
        } else {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $ht -TimeoutSec $Timeout
        }
    } catch {
        $msg = $_.ErrorDetails.Message
        if (-not $msg) { $msg = $_.Exception.Message }
        Write-Error ("API $Method $Uri -> $msg")
        exit 1
    }
}

function Invoke-ApiSoft {
    param($Uri, $Method, $Body, $Timeout = 120)
    try {
        $ht = @{ Authorization = "Bearer $token"; "User-Agent" = "deploy-script" }
        if ($Body) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $ht `
                -Body $Body -ContentType "application/json" -TimeoutSec $Timeout
        } else {
            return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $ht -TimeoutSec $Timeout
        }
    } catch {
        return $null
    }
}

# ---- Step 0: 引导初始提交（空仓库必须先有 commit 才能用 Git Database API）----
$mainExists = $false
$r = Invoke-ApiSoft "$api/git/ref/heads/main" Get
if ($r) { $mainExists = $true; $mainSha = $r.object.sha }

if (-not $mainExists) {
    Write-Host "引导：创建初始提交 (.nojekyll)..."
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(""))
    $body = @{ message = "init"; content = $b64 } | ConvertTo-Json -Compress
    Invoke-Api "$api/contents/.nojekyll" Put $body 60 | Out-Null
    $r = Invoke-Api "$api/git/ref/heads/main" Get
    $mainSha = $r.object.sha
    Write-Host ("初始提交已创建: {0}" -f $mainSha.Substring(0,8))
} else {
    Write-Host ("main 已存在: {0}" -f $mainSha.Substring(0,8))
}

# ---- Step 1: 收集文件 ----
$files = Get-ChildItem -Path $base -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\\.git\\' -and $_.Name -ne '.git'
}

# ---- Step 2: 创建 blobs ----
$treeEntries = @()
$count = 0
foreach ($f in $files) {
    $rel   = $f.FullName.Substring($base.Length + 1) -replace '\\','/'
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $b64   = [Convert]::ToBase64String($bytes)
    $body  = @{ content = $b64; encoding = "base64" } | ConvertTo-Json -Compress
    $blob  = Invoke-Api "$api/git/blobs" Post $body 180
    $treeEntries += @{ path = $rel; mode = "100644"; type = "blob"; sha = $blob.sha }
    $count++
    Write-Host ("[{0}/{1}] blob {2} -> {3}" -f $count, $files.Count, $rel, $blob.sha.Substring(0,8))
}

# ---- Step 3: 创建 tree ----
$treeBody = @{ tree = $treeEntries } | ConvertTo-Json -Compress -Depth 5
$tree = Invoke-Api "$api/git/trees" Post $treeBody 180
Write-Host ("TREE: {0}" -f $tree.sha)

# ---- Step 4: 创建 commit（基于现有 main）----
$commitBody = @{ message = "Deploy caiwu-ai static site (via API)"; tree = $tree.sha; parents = @($mainSha) } | ConvertTo-Json -Compress -Depth 5
$commit = Invoke-Api "$api/git/commits" Post $commitBody 180
Write-Host ("COMMIT: {0}" -f $commit.sha)

# ---- Step 5: 更新 main 引用 ----
$refBody = @{ sha = $commit.sha; force = $true } | ConvertTo-Json -Compress
Invoke-Api "$api/git/refs/heads/main" Patch $refBody 120 | Out-Null
Write-Host ("MAIN ref -> {0}" -f $commit.sha.Substring(0,8))

# ---- Step 6: 启用 GitHub Pages（软调用，失败不中断）----
$pagesBody = @{ source = @{ branch = "main"; path = "/" } } | ConvertTo-Json -Compress -Depth 5
$p = Invoke-ApiSoft "$api/pages" Post $pagesBody 60
if ($p) {
    Write-Host ("PAGES enabled, status={0}" -f $p.status)
} else {
    $g = Invoke-ApiSoft "$api/pages" Get
    if ($g) {
        Write-Host ("PAGES already enabled, status={0}, url={1}" -f $g.status, $g.html_url)
    } else {
        Write-Host "PAGES enable failed; 请稍后在仓库 Settings -> Pages 手动开启 (Source=main, /root)"
    }
}

Write-Host "DEPLOY_DONE"
