param(
	[string]$Path = "",
	[int]$Tail = 0,
	[int]$RecentSamples = 8,
	[switch]$Json,
	[switch]$ShowSamples,
	[switch]$ShowGpuCache,
	[switch]$ShowRawHits
)

$ErrorActionPreference = "Stop"

function Resolve-BlackScreenLogPath {
	param([string]$InputPath)

	if ($InputPath) {
		$resolved = Resolve-Path -LiteralPath $InputPath -ErrorAction Stop
		$item = Get-Item -LiteralPath $resolved.Path
		if ($item.PSIsContainer) {
			$events = Join-Path $item.FullName "events.ndjson"
			if (-not (Test-Path -LiteralPath $events)) {
				throw "No events.ndjson found in directory: $($item.FullName)"
			}
			return $events
		}

		return $item.FullName
	}

	$root = Join-Path $env:TEMP "codearts-black-screen-probe"
	$latestWindow = Join-Path $root "latest-window-run.txt"
	if (Test-Path -LiteralPath $latestWindow) {
		$windowRun = Get-Content -LiteralPath $latestWindow | Where-Object { $_ } | Select-Object -Last 1
		if ($windowRun) {
			$eventsPath = Join-Path $windowRun "events.ndjson"
			if (Test-Path -LiteralPath $eventsPath) {
				return $eventsPath
			}
		}
	}

	$bestRun = Select-BestBlackScreenRun -Root $root
	if ($bestRun) {
		return $bestRun.eventsPath
	}

	$latest = Join-Path $root "latest-run.txt"
	if (-not (Test-Path -LiteralPath $latest)) {
		throw "No path was provided and no black screen probe logs were found under: $root"
	}

	$runDir = Get-Content -LiteralPath $latest | Where-Object { $_ } | Select-Object -Last 1
	if ($runDir) {
		$eventsPath = Join-Path $runDir "events.ndjson"
		if (Test-Path -LiteralPath $eventsPath) {
			return $eventsPath
		}
	}

	throw "latest-run.txt exists but no readable events.ndjson was found: $latest"
}

function Read-Events {
	param([string]$EventsPath, [int]$TailLines)

	$lines = if ($TailLines -gt 0) {
		Get-Content -LiteralPath $EventsPath -Tail $TailLines
	} else {
		Get-Content -LiteralPath $EventsPath
	}

	$events = New-Object System.Collections.Generic.List[object]
	$parseErrors = New-Object System.Collections.Generic.List[object]
	$lineNo = 0

	foreach ($line in $lines) {
		$lineNo++
		if (-not $line.Trim()) {
			continue
		}

		try {
			$events.Add(($line | ConvertFrom-Json))
		} catch {
			$parseErrors.Add([pscustomobject]@{
				line = $lineNo
				error = $_.Exception.Message
				text = $line
			})
		}
	}

	return [pscustomobject]@{
		events = $events.ToArray()
		parseErrors = $parseErrors.ToArray()
	}
}

function Select-BestBlackScreenRun {
	param([string]$Root)

	$runs = Join-Path $Root "runs"
	if (-not (Test-Path -LiteralPath $runs)) {
		return $null
	}

	$candidates = New-Object System.Collections.Generic.List[object]
	foreach ($dir in @(Get-ChildItem -LiteralPath $runs -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 40)) {
		$eventsPath = Join-Path $dir.FullName "events.ndjson"
		if (-not (Test-Path -LiteralPath $eventsPath)) {
			continue
		}

		$score = Get-BlackScreenRunScore -EventsPath $eventsPath
		if ($score.eventCount -gt 0) {
			$candidates.Add($score)
		}
	}

	return @($candidates.ToArray() | Sort-Object score,lastTime -Descending | Select-Object -First 1)
}

function Get-BlackScreenRunScore {
	param([string]$EventsPath)

	$score = 0
	$eventCount = 0
	$firstTime = $null
	$lastTime = $null
	$processId = $null

	foreach ($line in @(Get-Content -LiteralPath $EventsPath -ErrorAction SilentlyContinue)) {
		if (-not $line.Trim()) {
			continue
		}

		try {
			$event = $line | ConvertFrom-Json
		} catch {
			continue
		}

		$eventCount++
		if (-not $firstTime) {
			$firstTime = $event.time
		}
		$lastTime = $event.time
		$processId = $event.pid

		switch ($event.event) {
			"blackScreenRecovery.captureBlackHit" { $score += 20000; break }
			"blackScreenRecovery.installed" { $score += 10000; break }
			"blackScreenRecovery.appWindowCreated" { $score += 5000; break }
			"blackScreenRecovery.windowHook" { $score += 3000; break }
			"blackScreenRecovery.installAttempt" { $score += 1000; break }
			"blackScreenRecovery.sample" { $score += 100; break }
			"blackScreenRecovery.sample.timeout" { $score += 80; break }
			"blackScreenRecovery.heartbeat" { $score += 40; break }
			"blackScreenRecovery.window.state" { $score += 20; break }
			default { $score += 1; break }
		}
	}

	return [pscustomobject]@{
		eventsPath = $EventsPath
		score = $score
		eventCount = $eventCount
		firstTime = $firstTime
		lastTime = $lastTime
		pid = $processId
	}
}

function Get-DataValue {
	param($Object, [string]$Name)

	if ($null -eq $Object) {
		return $null
	}

	$property = $Object.PSObject.Properties[$Name]
	if ($property) {
		return $property.Value
	}

	return $null
}

function Select-Events {
	param($Events, [string]$Name)

	return @($Events | Where-Object { $_.event -eq $Name })
}

function Select-EventPattern {
	param($Events, [string]$Pattern)

	return @($Events | Where-Object { $_.event -like $Pattern })
}

function Get-LastEvent {
	param($Events, [string]$Name)

	return Select-Events $Events $Name | Select-Object -Last 1
}

function Format-Value {
	param($Value)

	if ($null -eq $Value) {
		return "<null>"
	}

	if ($Value -is [string]) {
		return $Value
	}

	return ($Value | ConvertTo-Json -Compress -Depth 8)
}

$eventsPath = Resolve-BlackScreenLogPath -InputPath $Path
$read = Read-Events -EventsPath $eventsPath -TailLines $Tail
$events = @($read.events)

if ($events.Count -eq 0) {
	throw "No valid events found in $eventsPath"
}

$eventCounts = $events | Group-Object event | Sort-Object Count -Descending | Select-Object Count, Name
$firstEvent = $events | Select-Object -First 1
$lastEvent = $events | Select-Object -Last 1
$startup = Get-LastEvent $events "blackScreenRecovery.startupSwitches"
$appWindowHook = Get-LastEvent $events "blackScreenRecovery.appWindowHook.installed"
$appWindowCreated = Get-LastEvent $events "blackScreenRecovery.appWindowCreated"
$windowHook = Get-LastEvent $events "blackScreenRecovery.windowHook"
$installAttempt = Get-LastEvent $events "blackScreenRecovery.installAttempt"
$installSkippedEvents = Select-Events $events "blackScreenRecovery.installSkipped"
$installSkipped = $installSkippedEvents | Select-Object -Last 1
$blockingInstallSkipped = @($installSkippedEvents | Where-Object { (Get-DataValue $_.data "reason") -ne "duplicateWindow" })
$installed = Get-LastEvent $events "blackScreenRecovery.installed"
$gpuInfo = Get-LastEvent $events "blackScreenRecovery.gpuInfoComplete"
$captureHits = Select-Events $events "blackScreenRecovery.captureBlackHit"
$samples = Select-Events $events "blackScreenRecovery.sample"
$sampleTimeouts = Select-Events $events "blackScreenRecovery.sample.timeout"
$heartbeats = Select-Events $events "blackScreenRecovery.heartbeat"
$windowStates = Select-Events $events "blackScreenRecovery.window.state"
$windowEvents = Select-EventPattern $events "blackScreenRecovery.window.*"
$rendererGone = Select-Events $events "blackScreenRecovery.webContents.renderProcessGone"
$unresponsive = Select-Events $events "blackScreenRecovery.webContents.unresponsive"
$responsive = Select-Events $events "blackScreenRecovery.webContents.responsive"
$sampleErrors = Select-Events $events "blackScreenRecovery.sample.error"
$invalidStrategy = Select-Events $events "blackScreenRecovery.invalidStrategy"

$blackSamples = @($samples | Where-Object {
	$capture = Get-DataValue $_.data "capture"
	$isBlack = Get-DataValue $capture "isBlack"
	$isBlack -eq $true
})

$highBlackSamples = @($samples | Where-Object {
	$capture = Get-DataValue $_.data "capture"
	$ratio = Get-DataValue $capture "blackRatio"
	$ratio -ne $null -and [double]$ratio -ge 0.5
})

$hiddenRendererSamples = @($samples | Where-Object {
	$renderer = Get-DataValue $_.data "renderer"
	$visibility = Get-DataValue $renderer "visibilityState"
	$visibility -eq "hidden"
})

$largeRafAgeSamples = @($samples | Where-Object {
	$renderer = Get-DataValue $_.data "renderer"
	$rafAge = Get-DataValue $renderer "rafAgeMs"
	$rafAge -ne $null -and [double]$rafAge -ge 5000
})

$gpuCacheChangedSamples = @($samples | Where-Object {
	(Get-DataValue $_.data "gpuCacheChangedFromInstall") -eq $true
})

$summary = [ordered]@{
	eventsPath = $eventsPath
	eventCount = $events.Count
	firstTime = $firstEvent.time
	lastTime = $lastEvent.time
	parseErrorCount = $read.parseErrors.Count
	appWindowHookCount = (Select-Events $events "blackScreenRecovery.appWindowHook.installed").Count
	appWindowCreatedCount = (Select-Events $events "blackScreenRecovery.appWindowCreated").Count
	windowHookCount = (Select-Events $events "blackScreenRecovery.windowHook").Count
	installAttemptCount = (Select-Events $events "blackScreenRecovery.installAttempt").Count
	installSkippedCount = $installSkippedEvents.Count
	blockingInstallSkippedCount = $blockingInstallSkipped.Count
	strategy = Get-DataValue $installed.data "strategy"
	startupStrategy = Get-DataValue $startup.data "strategy"
	installAttemptStrategy = Get-DataValue $installAttempt.data "strategy"
	installSkippedReason = Get-DataValue $installSkipped.data "reason"
	heartbeatCount = $heartbeats.Count
	captureBlackHitCount = $captureHits.Count
	blackSampleCount = $blackSamples.Count
	highBlackSampleCount = $highBlackSamples.Count
	hiddenRendererSampleCount = $hiddenRendererSamples.Count
	largeRafAgeSampleCount = $largeRafAgeSamples.Count
	gpuCacheChangedSampleCount = $gpuCacheChangedSamples.Count
	renderProcessGoneCount = $rendererGone.Count
	unresponsiveCount = $unresponsive.Count
	responsiveCount = $responsive.Count
	sampleErrorCount = $sampleErrors.Count
	sampleTimeoutCount = $sampleTimeouts.Count
	invalidStrategyCount = $invalidStrategy.Count
}

if ($Json) {
	[pscustomobject]@{
		summary = $summary
		eventCounts = $eventCounts
		parseErrors = $read.parseErrors
		recentSamples = @($samples | Select-Object -Last $RecentSamples)
		captureBlackHits = $captureHits
		renderProcessGone = $rendererGone
		unresponsive = $unresponsive
	} | ConvertTo-Json -Depth 20
	exit 0
}

Write-Host "== Black Screen Probe Summary =="
Write-Host "Log: $eventsPath"
Write-Host "Events: $($events.Count)"
Write-Host "Time(local): $($firstEvent.time) -> $($lastEvent.time)"
Write-Host "Parse errors: $($read.parseErrors.Count)"
Write-Host ""

Write-Host "== Strategy =="
Write-Host "Installed strategy: $(Format-Value (Get-DataValue $installed.data 'strategy'))"
Write-Host "Startup strategy:   $(Format-Value (Get-DataValue $startup.data 'strategy'))"
Write-Host "App hook strategy:  $(Format-Value (Get-DataValue $appWindowHook.data 'startupStrategy'))"
Write-Host "Hook resolution:    $(Format-Value (Get-DataValue $windowHook.data 'resolution'))"
Write-Host "Install attempt:    $(Format-Value (Get-DataValue $installAttempt.data 'strategyResolution'))"
Write-Host "Install skipped:    $(Format-Value (Get-DataValue $installSkipped.data 'reason'))"
Write-Host "Disable features:   $(Format-Value (Get-DataValue $startup.data 'disableFeaturesAfter'))"
Write-Host "Renderer bg off:    $(Format-Value (Get-DataValue $startup.data 'rendererBackgroundingDisabled'))"
Write-Host ""

Write-Host "== Event Counts =="
$eventCounts | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "== Key Findings =="
Write-Host "appWindowHook events:      $((Select-Events $events 'blackScreenRecovery.appWindowHook.installed').Count)"
Write-Host "appWindowCreated events:   $((Select-Events $events 'blackScreenRecovery.appWindowCreated').Count)"
Write-Host "windowHook events:          $((Select-Events $events 'blackScreenRecovery.windowHook').Count)"
Write-Host "installAttempt events:      $((Select-Events $events 'blackScreenRecovery.installAttempt').Count)"
Write-Host "installSkipped events:      $($installSkippedEvents.Count)"
Write-Host "blocking installSkipped:    $($blockingInstallSkipped.Count)"
Write-Host "heartbeat events:           $($heartbeats.Count)"
Write-Host "captureBlackHit events:      $($captureHits.Count)"
Write-Host "sample capture.isBlack=true: $($blackSamples.Count)"
Write-Host "sample blackRatio >= 0.5:    $($highBlackSamples.Count)"
Write-Host "renderer hidden samples:     $($hiddenRendererSamples.Count)"
Write-Host "RAF age >= 5000ms samples:   $($largeRafAgeSamples.Count)"
Write-Host "GPUCache changed samples:    $($gpuCacheChangedSamples.Count)"
Write-Host "render-process-gone events:  $($rendererGone.Count)"
Write-Host "unresponsive events:         $($unresponsive.Count)"
Write-Host "sample errors:               $($sampleErrors.Count)"
Write-Host "sample timeouts:             $($sampleTimeouts.Count)"
Write-Host ""

$lastWindowState = $windowStates | Select-Object -Last 1
if ($lastWindowState) {
	Write-Host "== Last Window State =="
	(Get-DataValue $lastWindowState.data "window") | ConvertTo-Json -Depth 8
	Write-Host ""
}

$recentWindowEvents = @($windowEvents | Select-Object -Last 12)
if ($recentWindowEvents.Count -gt 0) {
	Write-Host "== Recent Window Events =="
	$recentWindowEvents | Select-Object time,event | Format-Table -AutoSize | Out-String | Write-Host
}

$recentHeartbeats = @($heartbeats | Select-Object -Last 8)
if ($recentHeartbeats.Count -gt 0) {
	Write-Host "== Recent Heartbeats =="
	foreach ($heartbeat in $recentHeartbeats) {
		$renderer = Get-DataValue $heartbeat.data "renderer"
		$window = Get-DataValue $heartbeat.data "window"
		Write-Host ("{0} visible={1} focused={2} visibility={3} rafAgeMs={4} mutationAgeMs={5}" -f
			$heartbeat.time,
			(Get-DataValue $window "isVisible"),
			(Get-DataValue $window "isFocused"),
			(Get-DataValue $renderer "visibilityState"),
			(Get-DataValue $renderer "rafAgeMs"),
			(Get-DataValue $renderer "mutationAgeMs"))
	}
	Write-Host ""
}

if ($captureHits.Count -gt 0) {
	Write-Host "== Capture Black Hits =="
	foreach ($hit in $captureHits) {
		$capture = Get-DataValue $hit.data "capture"
		$renderer = Get-DataValue $hit.data "renderer"
		Write-Host ("{0} reason={1} delayMs={2} blackRatio={3} visibility={4} rafAgeMs={5}" -f
			$hit.time,
			(Get-DataValue $hit.data "reason"),
			(Get-DataValue $hit.data "delayMs"),
			(Get-DataValue $capture "blackRatio"),
			(Get-DataValue $renderer "visibilityState"),
			(Get-DataValue $renderer "rafAgeMs"))
	}
	Write-Host ""
}

if ($rendererGone.Count -gt 0) {
	Write-Host "== Render Process Gone =="
	$rendererGone | ForEach-Object {
		[pscustomobject]@{
			time = $_.time
			details = Format-Value (Get-DataValue $_.data "details")
		}
	} | Format-Table -AutoSize | Out-String | Write-Host
}

if ($unresponsive.Count -gt 0) {
	Write-Host "== Unresponsive Events =="
	$unresponsive | Select-Object time,event | Format-Table -AutoSize | Out-String | Write-Host
}

if ($ShowGpuCache -or $gpuCacheChangedSamples.Count -gt 0) {
	Write-Host "== GPUCache =="
	$gpuCache = Get-DataValue $installed.data "gpuCache"
	if ($gpuCache) {
		$gpuCache | ConvertTo-Json -Depth 12
	} else {
		Write-Host "<no installed GPUCache snapshot>"
	}
	Write-Host ""
}

if ($ShowSamples) {
	Write-Host "== Recent Samples =="
	foreach ($sample in @($samples | Select-Object -Last $RecentSamples)) {
		$capture = Get-DataValue $sample.data "capture"
		$renderer = Get-DataValue $sample.data "renderer"
		$window = Get-DataValue $sample.data "window"
		Write-Host ("{0} reason={1} delayMs={2} blackRatio={3} isBlack={4} visibility={5} rafAgeMs={6} isVisible={7} isMaximized={8} gpuCacheChanged={9}" -f
			$sample.time,
			(Get-DataValue $sample.data "reason"),
			(Get-DataValue $sample.data "delayMs"),
			(Get-DataValue $capture "blackRatio"),
			(Get-DataValue $capture "isBlack"),
			(Get-DataValue $renderer "visibilityState"),
			(Get-DataValue $renderer "rafAgeMs"),
			(Get-DataValue $window "isVisible"),
			(Get-DataValue $window "isMaximized"),
			(Get-DataValue $sample.data "gpuCacheChangedFromInstall"))
	}
	Write-Host ""
}

if ($ShowRawHits -and $captureHits.Count -gt 0) {
	Write-Host "== Raw Capture Hits =="
	$captureHits | ConvertTo-Json -Depth 20
}

Write-Host "== Quick Interpretation =="
if (-not $appWindowHook) {
	Write-Host "- No appWindowHook event was found. The early module loaded, but the packaged startup path may not include the current startup hook build."
} elseif (-not $appWindowCreated) {
	Write-Host "- appWindowHook exists but no appWindowCreated event was found. Check whether this log belongs to the same main process that created the visible window."
}

if (-not $windowHook) {
	Write-Host "- No windowHook event was found. The early module loaded, but this build likely did not execute the patched BaseWindow.setWin hook. The app-level BrowserWindow hook should still install the probe if appWindowCreated exists."
} elseif (-not $installAttempt) {
	Write-Host "- windowHook exists but installAttempt is missing. Check the call from windowImpl.ts to installBlackScreenRecoveryProbe and any internal merge differences."
} elseif ($blockingInstallSkipped.Count -gt 0) {
	Write-Host "- The window probe was skipped for a non-duplicate reason. Inspect installSkipped.reason and strategyResolution above."
} elseif (-not $installed) {
	Write-Host "- installAttempt exists but installed is missing. Check for an install-time exception or a build mismatch around blackScreenRecovery.ts."
}

if ($captureHits.Count -gt 0 -or $blackSamples.Count -gt 0) {
	Write-Host "- Internal capturePage observed black content. Prioritize Chromium compositor/Viz/Skia/GPUCache layers."
} else {
	Write-Host "- No internal capturePage black hit was found in this log. If the tester saw external black screen, prioritize final presentation/DWM/output-surface and compare with external screenshots."
}

if ($hiddenRendererSamples.Count -gt 0) {
	Write-Host "- Renderer visibilityState=hidden appeared. Check window visible state vs renderer hidden/background synchronization."
}

if ($largeRafAgeSamples.Count -gt 0) {
	Write-Host "- RAF age exceeded 5000ms in samples. Check renderer throttling/background/occlusion behavior."
}

if ($gpuCacheChangedSamples.Count -gt 0) {
	Write-Host "- GPUCache changed during the run. Preserve the GPUCache directory with this log."
}

if ($rendererGone.Count -gt 0 -or $unresponsive.Count -gt 0) {
	Write-Host "- Renderer process lifecycle/unresponsive events exist. Preserve dumps if available."
}

if ($sampleTimeouts.Count -gt 0) {
	Write-Host "- sample timeout events exist. capturePage or renderer JS may have stalled during diagnosis."
}
