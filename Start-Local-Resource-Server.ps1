param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$resourcePath = Join-Path $root 'veno-twitch-stable.js'

if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) {
    throw "Missing resource file: $resourcePath"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host ''
Write-Host 'Veno Twitch Stability Fork local resource server' -ForegroundColor Cyan
Write-Host "Serving only: http://127.0.0.1:$Port/veno-twitch-stable.js"
Write-Host "Health check: http://127.0.0.1:$Port/health"
Write-Host 'Press Ctrl+C or close this window to stop. No background process is created.'
Write-Host ''

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [byte[]]$Body,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [bool]$HeadOnly = $false
    )

    $headerText = "HTTP/1.1 $StatusCode $StatusText`r`n" +
        "Content-Type: $ContentType`r`n" +
        "Content-Length: $($Body.Length)`r`n" +
        "Cache-Control: no-store, max-age=0`r`n" +
        "Access-Control-Allow-Origin: *`r`n" +
        "X-Content-Type-Options: nosniff`r`n" +
        "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 5000
            $stream = $client.GetStream()
            $buffer = New-Object byte[] 16384
            $read = $stream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { continue }

            $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            $requestLine = ($request -split "`r?`n", 2)[0]
            $parts = $requestLine -split ' '
            if ($parts.Count -lt 2) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('Bad Request')
                Send-Response -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Body $body
                continue
            }

            $method = $parts[0].ToUpperInvariant()
            $rawTarget = $parts[1]
            $requestPath = [System.Uri]::UnescapeDataString(($rawTarget -split '\?', 2)[0])
            $headOnly = $method -eq 'HEAD'

            if ($method -ne 'GET' -and -not $headOnly) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('Method Not Allowed')
                Send-Response -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Body $body -HeadOnly:$headOnly
            }
            elseif ($requestPath -eq '/veno-twitch-stable.js') {
                $body = [System.IO.File]::ReadAllBytes($resourcePath)
                Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -Body $body -ContentType 'application/javascript; charset=utf-8' -HeadOnly:$headOnly
            }
            elseif ($requestPath -eq '/health') {
                $body = [System.Text.Encoding]::UTF8.GetBytes('ok')
                Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -Body $body -HeadOnly:$headOnly
            }
            else {
                $body = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
                Send-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -Body $body -HeadOnly:$headOnly
            }
        }
        catch {
            try {
                if ($stream) {
                    $body = [System.Text.Encoding]::UTF8.GetBytes('Internal Server Error')
                    Send-Response -Stream $stream -StatusCode 500 -StatusText 'Internal Server Error' -Body $body
                }
            } catch {}
            Write-Warning $_.Exception.Message
        }
        finally {
            if ($stream) { $stream.Dispose() }
            $client.Close()
            $stream = $null
        }
    }
}
finally {
    $listener.Stop()
    Write-Host 'Local resource server stopped.'
}
