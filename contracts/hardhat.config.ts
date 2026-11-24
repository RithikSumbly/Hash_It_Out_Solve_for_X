import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config();

const PK = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = PK ? [PK.startsWith("0x") ? PK : `0x${PK}`] : [];

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
      },
    ],
    overrides: {
      // The Arena goes through the IR pipeline, which brings it from 26.6 KB to 22.6 KB, under the 24 KB
      // contract-size limit (the legacy pipeline cannot fit it, even at runs: 1)
      "contracts/Arena.sol": {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
      // the sparring ring runs ~1,000 simulated steps a close: the IR pipeline cut a close's gas by about a fifth
      "contracts/v2/Crucible.sol": {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
      // fixed genesis so seeded simulations (test/04 evolution) are reproducible
      initialDate: "2030-01-01T00:00:00Z",
      mining: { auto: true, interval: 0 },
      accounts: { count: 24, accountsBalance: "10000000000000000000000" },
      // = the per-transaction gas cap of the osaka hardfork (EIP-7825, 2^24). Hardhat's eth_estimateGas binary-searches
      // up to the block gas limit and fails ("greater than the cap") on transactions that use little gas but must be
      // sent with a large limit, which is what the Arena's CLOSE_GAS reserve asks for. Base Sepolia's estimator caps
      // correctly (checked read-only), so this is a local-only fix.
      blockGasLimit: 16_777_216,
    },
    localhost: { url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
    // the hackathon's network (HASH IT OUT: Base Sepolia, chain 84532)
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // Any other EVM testnet: set CUSTOM_RPC_URL + CUSTOM_CHAIN_ID and use --network custom
    custom: {
      url: process.env.CUSTOM_RPC_URL || "http://127.0.0.1:8545",
      chainId: process.env.CUSTOM_CHAIN_ID ? Number(process.env.CUSTOM_CHAIN_ID) : undefined,
      accounts,
    },
  },
  etherscan: {
    // an Etherscan v2 key verifies on Basescan too
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=84532", browserURL: "https://sepolia.basescan.org" },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "1",
    currency: "USD",
  },
  mocha: { timeout: 120000 },
};

export default config;
