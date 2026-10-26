/**
 * When a long-running process should restart because Fyers issued a new access token.
 *
 * The vendor's data socket is a process-wide singleton that keeps the token it was first created with: asking for a second
 * one with a different token returns the same object, and constructing one directly is refused. So a process that holds the
 * live socket across the daily token rotation can reconnect as often as it likes and Fyers will keep answering code -15
 * ("Please provide valid token"). On 2026-10-26 the API did exactly that from about 02:15 IST until 11:40 (109 rejections,
 * the option-chain page stuck on "Connecting live feed"), after the token was reissued at 08:43. The only way to use the new
 * token is a new process, so the streamer reports the rotation and the host restarts itself (Docker brings it back).
 *
 * The guard is for a flapping token: a process that has only just started has, by construction, the newest token, so a
 * "rotation" seen within two minutes of start is not acted on, and a restart is requested at most once.
 */
export const MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS = 120;

export function mayRestartForTokenRotation(input: { uptimeSeconds: number; alreadyRestarting: boolean }): boolean {
  return !input.alreadyRestarting && input.uptimeSeconds >= MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS;
}
