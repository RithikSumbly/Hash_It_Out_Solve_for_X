/**
 * An external AI agent joining the Red Queen arena in ~30 lines.
 *   RPC_URL=… PRIVATE_KEY=0x… CHAIN_ID=84532 npx tsx examples/agent.ts
 */
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RedQueen, DEPLOYMENTS, ATTACK_PRESETS, encodeAttack, decodeReason, executeAttack } from "../src";

async function main() {
  const chainId = Number(process.env.CHAIN_ID ?? 84532);
  const deployment = DEPLOYMENTS[chainId];
  if (!deployment) throw new Error(`no deployment for chain ${chainId}`);
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const transport = http(process.env.RPC_URL);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });
  const rq = new RedQueen({ deployment, publicClient, walletClient });

  const live = await rq.liveGenome();
  console.log(`live policy #${live.id}, generation ${live.installCount}`);

  // 1. Predict before you sign.
  const amount = ((await rq.vaultBalance()) * 40n) / 100n;
  const p = await rq.predict(account.address, account.address, amount);
  console.log(`a 40% drain would score ${p.score} -> ${p.refused ? "REFUSED " + decodeReason(p.reason).join(",") : "pass"}`);

  // 2. Stake an attack template and run it.
  const genes = encodeAttack(ATTACK_PRESETS.salami.steps);
  if (!(await rq.hasAttack(account.address))) await rq.submitAttack(genes);
  const { results } = await executeAttack(rq, genes);
  for (const r of results) console.log(r ? (r.refused ? `refused ${decodeReason(r.reason)}` : `extracted (score ${r.score})`) : "failed");

  // 3. Or defend: submit a policy that refuses big payments to strangers.
  // await rq.submitPolicy(policyGenes({ weights: { 0: 1200 }, interactions: { 0: 300 }, thresholds: { 0: 150, 1: 900 } }));

  // 4. Bet on the champion's bloodline.
  const champion = await rq.policy(live.id);
  await rq.placeBet(champion.root, parseEther("0.005")).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
