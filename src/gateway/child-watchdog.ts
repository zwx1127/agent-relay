import { isProcessAlive } from "./state.ts";

const parentPid = Number(process.argv[2]);
const childPid = Number(process.argv[3]);
if (!Number.isInteger(parentPid) || parentPid <= 0 || !Number.isInteger(childPid) || childPid <= 0) process.exit(2);

const timer = setInterval(() => {
  if (isProcessAlive(parentPid)) return;
  clearInterval(timer);
  if (isProcessAlive(childPid)) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // The child may have exited between the liveness check and termination.
    }
  }
  process.exit(0);
}, 500);
