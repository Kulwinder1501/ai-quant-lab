@echo off
setlocal EnableExtensions

REM ===========================================================================
REM  Holds the lid-close action open during market hours, and restores it after.
REM
REM  WHY THIS EXISTS
REM  On 2026-08-28 the host entered Windows Modern Standby overnight, which
REM  suspends the Docker VM. On resume the scheduler process stayed alive but
REM  only its hour-unrestricted cron fired again, so 1 job type of 22 ran for a
REM  whole trading day: zero option_premium_ticks, zero COLLECTOR_HEALTH runs.
REM  A mid-session standby on 2026-09-02 (11:27:42-11:42:59 IST) also cost a
REM  922-second hole in the quote series.
REM
REM  The sleep and display idle timeouts are ALREADY "never" on both AC and
REM  battery, so there is no timeout left to disable. The remaining triggers are
REM  lid close, a manual sleep, and critical battery. This script addresses the
REM  first of those; nothing in software addresses the other two.
REM
REM  ARGUMENT
REM    0  do nothing on lid close   (call at market open)
REM    1  sleep on lid close        (call after the close, to restore normal use)
REM
REM  Only the AC value is changed. On battery, lid-close keeps sleeping on
REM  purpose: a laptop that stays awake in a bag overheats, and critical battery
REM  forces a sleep regardless of this setting -- which is exactly what happened
REM  on 2026-09-01 at 11:39. Keeping the machine plugged in during the session is
REM  part of the fix, not an optional extra.
REM
REM  Requires administrator rights (powercfg refuses otherwise). The scheduled
REM  tasks that call it run as SYSTEM.
REM ===========================================================================

set "SUB_BUTTONS=4f971e89-eebd-4455-a8de-9e59040e7347"
set "LID_ACTION=5ca83367-6e45-459f-a27b-476b1d01c936"
set "LOG=%~dp0market-hours-lid.log"

if "%~1"=="0" goto :ok
if "%~1"=="1" goto :ok
echo Usage: %~nx0 ^<0^|1^>   0 = do nothing on lid close, 1 = sleep
exit /b 2

:ok
REM Re-asserted rather than toggled: the open task runs every 30 minutes through
REM the session, so a missed 09:05 start (the machine resuming late from standby,
REM which is the very failure being guarded) still leaves the setting correct for
REM the rest of the day.
powercfg /setacvalueindex SCHEME_CURRENT %SUB_BUTTONS% %LID_ACTION% %~1
if errorlevel 1 (
  echo %DATE% %TIME%  FAILED setacvalueindex %~1 >> "%LOG%"
  exit /b 1
)

REM Without this the scheme is edited but not reloaded, so the change does not
REM take effect until something else activates the scheme.
powercfg /setactive SCHEME_CURRENT
if errorlevel 1 (
  echo %DATE% %TIME%  FAILED setactive after %~1 >> "%LOG%"
  exit /b 1
)

echo %DATE% %TIME%  lid-close action set to %~1 >> "%LOG%"
exit /b 0
