import { main } from "./runtime/bootstrap.ts";
import { formatUnknownError } from "./domain/logger.ts";

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(formatUnknownError(error));
    process.exit(1);
  }
}
