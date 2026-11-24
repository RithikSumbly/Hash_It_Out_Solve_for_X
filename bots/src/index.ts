/**
 * Run the bot population against a deployment.
 *   npm run bots                         # everything, forever
 *   npm run bots -- --only honest,closer # a subset
 *   npm run bots -- --epochs 10          # stop after 10 epoch closes
 */
import { loadDeployment, log } from "./env";
import { runArena, stats, type Role } from "./arena";

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? (args[args.indexOf("--only") + 1].split(",") as Role[]) : undefined;
  const epochs = args.includes("--epochs") ? Number(args[args.indexOf("--epochs") + 1]) : undefined;
  const d = loadDeployment();
  const run = await runArena({ deployment: d, roles: only, epochs });
  process.on("SIGINT", () => {
    log("arena", "stopping…");
    run.stop();
  });
  await run.done;
  log("arena", `done: ${JSON.stringify(stats, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
