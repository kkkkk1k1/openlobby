/**
 * Detect if the current process is managed by a process manager (pm2, systemd, supervisord).
 * When under a process manager, the upgrade strategy changes: instead of the wrapper
 * restarting the child internally, the wrapper exits and lets the process manager restart it.
 */
export function isUnderProcessManager(): boolean {
  return !!(
    process.env.PM2_HOME ||          // pm2
    process.env.pm_id ||             // pm2
    process.env.INVOCATION_ID ||     // systemd
    process.env.SUPERVISOR_ENABLED   // supervisord
  );
}
