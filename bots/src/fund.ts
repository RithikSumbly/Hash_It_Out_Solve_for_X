/**
 * Top up every bot wallet from the deployer key.
 *   BOT_TARGET_ETH=0.3 npm run fund -w bots
 */
import { formatEther, parseEther } from "viem";
import { ROLES, botAccount, deployerAccount, env, log, publicClient, walletFor } from "./env";

async function main() {
  const target = parseEther(process.env.BOT_TARGET_ETH ?? "0.3");
  const spectatorTarget = parseEther(process.env.SPECTATOR_TARGET_ETH ?? "0.08");
  const deployer = deployerAccount();
  const w = walletFor(deployer);
  const pub = publicClient();
  log("fund", `deployer ${deployer.address} has ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH (chain ${env.chainId})`);
  const all = [...ROLES.honest, ...ROLES.attackers, ...ROLES.evolved, ...ROLES.challengers, ...ROLES.spectators, ...ROLES.closer];
  for (const i of all) {
    const a = botAccount(i).address;
    const want = (ROLES.spectators as readonly number[]).includes(i) || (ROLES.honest as readonly number[]).includes(i) ? spectatorTarget : target;
    const bal = await pub.getBalance({ address: a });
    if (bal >= want) continue;
    const hash = await w.sendTransaction({ to: a, value: want - bal, account: deployer, chain: w.chain });
    await pub.waitForTransactionReceipt({ hash });
    log("fund", `#${i} ${a} +${formatEther(want - bal)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
