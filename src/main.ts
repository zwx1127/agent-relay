import { main } from "./app/bootstrap.ts";

if (import.meta.main) {
  await main();
}
