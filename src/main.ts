import { main } from "./runtime/bootstrap.ts";

if (import.meta.main) {
  await main();
}
