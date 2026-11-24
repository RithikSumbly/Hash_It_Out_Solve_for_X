// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GenomeLib} from "./lib/GenomeLib.sol";
import {IFirewall, IVaultLog, ILineage, ICrucible} from "./interfaces/IRedQueen.sol";

/// @title Arena — epochs, shadow candidates, fitness, selection, breeding, installation, slashing, bets.
/// @notice The whole evolutionary loop runs here, in Solidity:
///   1. Every Vault spend is scored by every candidate in the shadow pool (<= 16); the refuse bitmask is logged.
///   2. Labels (honest / attack) are commit-revealed in the last `revealWindow` blocks of the epoch.
///   3. `closeEpoch()` computes the fitness F = R - C per candidate (priced by payment; see below), keeps the top 4, slashes the rest,
///      installs the champion in the Firewall, breeds 4 children (uniform crossover + 2 mutations),
///      co-evolves the attack-genome population the same way, and settles pari-mutuel bets.
///
/// Optional features (set through the constructor and `setCrucible`, so an arena without them is still possible):
///   * stakes, the minimum bet, the closer's tip, the mutation size and the genesis genome are set at deploy;
///   * attack genomes can be seeded at deploy, so the attackers' population exists from the first close;
///   * with a Crucible wired in, every candidate is also played against the attack pool and a bench of honest
///     payments at close: F = R - C + S, where S is the Crucible's sparring score in wei of the vault.
///     Refusing an honest bench payment costs more than a full drain, so epochs with no revealed honest labels
///     cannot breed a refuse-everything policy;
///   * self-driving rounds: a spend (via the Vault), a submission, a bet or a proposal from anyone not staked
///     in the current epoch closes it first if it is overdue, and is tipped from the protocol pool;
///   * policies proposed through the Crucible enter the shadow pool without a stake once they pass its screen.
///
/// Safeguards:
///   * a staked policy passes the same Crucible screen as a free proposal before it may enter, so a stake alone
///     cannot bring in a genome with a back door;
///   * betting closes at the reveal block, when the round's outcome can already be simulated;
///   * an attack's stake comes back only if its wallet took at least the stake itself that round, so a token payment
///     does not save it; the return is credited at the payment that crosses that line, not at the close;
///   * breeding is seeded from the hash of the round's last block, fixed before anyone may close the round, rather than
///     prevrandao at the close (which a closer could preview and time: on Base it holds for 60 blocks);
///   * the Crucible keeps an archive (hall of fame) of past attack plans that every close spars against too;
///   * three verdicts and payment-priced grading: candidates are graded from the Vault's tally, which credits a held
///     attack at half its value and prices a wrong refusal by the payment (Vault.tally);
///   * a challenger takes the crown only if it beats the live champion by MARGIN_BPS of the round's starting balance;
///   * every bred child is clamped monotone in amount (f0) and round outflow (f7) at birth (GenomeLib.monotone), and
///     the Crucible refuses a proposed or staked policy that is not.
contract Arena is Ownable, ReentrancyGuard {
    // ------------------------------------------------------------------ constants
    uint256 public constant MAX_CANDIDATES = 16;
    uint256 public constant MAX_ATTACK_POOL = 16;
    uint256 public constant SURVIVORS = 4;
    uint256 public constant CHILDREN = 4;
    uint256 public constant MAX_ATTACKERS_PER_EPOCH = 64;
    /// @notice lambda: what a user the live policy wrongly refused is compensated per refusal, 2% of the epoch-start
    ///         vault balance (grading itself prices wrong refusals by the payment, in Vault.tally).
    uint256 public constant LAMBDA_BPS = 200;
    uint256 public constant SURVIVOR_SHARE = 60;
    uint256 public constant HONEST_SHARE = 30;
    /// @notice Gas a transaction that may close an overdue epoch must bring (see `poke`). A heavy close (240 logged
    ///         spends, 16 candidates x 8 sparring bouts, 16 attack plans, full breeding) fits inside it; padded by a
    ///         wallet's usual 25-30% it stays under the 2^24 per-transaction gas cap (EIP-7825).
    uint256 public constant CLOSE_GAS = 10_000_000;
    /// @notice A challenger must beat the live champion's fitness by this share (bps) of the round's starting
    ///         balance to take the crown; within it, the champion keeps it.
    uint256 public constant MARGIN_BPS = 100;

    // ------------------------------------------------------------------ deploy-time economics
    uint256 public immutable POLICY_STAKE;
    uint256 public immutable ATTACK_STAKE;
    uint256 public immutable MIN_BET;
    /// @notice Paid from the protocol pool (into `claimable`) to whoever closes an epoch.
    uint256 public immutable closeTip;
    /// @notice Each of a child's 2 mutations moves a gene by +-(1..mutationScale).
    uint256 public immutable mutationScale;
    uint256 public immutable genesisLo;
    uint256 public immutable genesisHi;

    struct Config {
        address firewall;
        address lineage;
        uint256 epochLength;
        uint256 revealWindow;
        uint256 policyStake;
        uint256 attackStake;
        uint256 minBet;
        uint256 closeTip;
        uint256 mutationScale;
        uint256 genesisLo;
        uint256 genesisHi;
    }

    // ------------------------------------------------------------------ types
    struct Policy {
        uint256 lo;
        uint256 hi;
        uint64 parentA;
        uint64 parentB;
        uint64 root;
        uint32 generation;
        uint32 bornEpoch;
        address submitter;
        uint96 stake;
        bool alive;
        int256 lastFitness;
    }

    struct AttackGenome {
        uint256 lo;
        uint256 hi;
        uint64 parentA;
        uint64 parentB;
        uint32 generation;
        uint32 bornEpoch;
        address submitter;
        bool alive;
        uint256 lastExtracted;
    }

    struct Bet {
        uint64 lineage;
        uint96 amount;
        bool settled;
    }

    struct Tally {
        uint256 n;
        uint256[] retained;
        uint256[] honestCost;
        address[] users;
        uint256[] wrong;
        uint256 userCount;
        uint256 totalWrong;
        uint256 txCount;
    }

    // ------------------------------------------------------------------ wiring
    IFirewall public immutable firewall;
    ILineage public immutable lineage;
    IVaultLog public vault;
    ICrucible public crucible;
    uint256 public immutable epochLength;
    uint256 public immutable revealWindow;

    // ------------------------------------------------------------------ epoch state
    bool public started;
    uint256 public currentEpoch;
    uint256 public epochStartBlock;
    uint256 public epochStartBalance;
    mapping(uint256 => bool) public epochClosed;

    // ------------------------------------------------------------------ populations
    uint64 public policyCount;
    uint64 public attackCount;
    mapping(uint64 => Policy) internal policies;
    mapping(uint64 => AttackGenome) internal attacks;
    uint64[] internal pool;
    uint64[] internal attackPool;

    mapping(uint256 => mapping(address => bool)) public policySubmitted;
    mapping(uint256 => mapping(address => uint64)) public attackOf;
    mapping(uint256 => address[]) internal epochAttackers;
    mapping(uint256 => mapping(uint64 => uint256)) public attackExtracted;
    mapping(uint256 => mapping(address => uint256)) public walletExtracted;
    /// @notice Attackers whose stake has already come back this epoch (credited at the crossing payment).
    mapping(uint256 => uint256) public stakesReturned;

    // ------------------------------------------------------------------ economics
    mapping(address => uint256) public claimable;
    uint256 public protocolPool;
    mapping(uint256 => mapping(address => Bet)) public bets;
    mapping(uint256 => mapping(uint64 => uint256)) public lineageStake;
    mapping(uint256 => uint256) public betPool;
    mapping(uint256 => uint64) public winningLineage;

    // ------------------------------------------------------------------ events
    event VaultSet(address vault);
    event CrucibleSet(address crucible);
    event EpochStarted(uint256 indexed epoch, uint256 startBlock, uint256 endBlock, uint256 revealBlock, uint256 startBalance);
    event PolicySubmitted(uint256 indexed epoch, uint64 indexed id, address indexed submitter, uint256 lo, uint256 hi);
    event AttackSubmitted(uint256 indexed epoch, uint64 indexed id, address indexed attacker, uint256 lo, uint256 hi, bool adopted);
    event EpochClosed(
        uint256 indexed epoch,
        uint64[] ids,
        int256[] fitness,
        uint256[] retained,
        uint256[] honestCost,
        uint64 champion,
        uint256 txCount,
        uint256 seed
    );
    event AttackEpochResults(uint256 indexed epoch, uint64[] ids, uint256[] extracted);
    event PolicyInstalled(
        uint64 indexed id,
        uint32 generation,
        uint64 parentA,
        uint64 parentB,
        int256 fitness,
        uint256 indexed epoch,
        uint256 lo,
        uint256 hi,
        uint64 root
    );
    event PolicyDied(uint64 indexed id, uint256 indexed epoch, int256 fitness, uint256 slashedStake);
    /// @notice root and generation of the child are in Lineage.Born (same tx) and getPolicy().
    event ChildBorn(
        uint64 indexed id,
        uint64 parentA,
        uint64 parentB,
        uint8[2] mutGenes,
        int16[2] mutDeltas,
        uint256 lo,
        uint256 hi,
        uint256 indexed epoch
    );
    event AttackBorn(uint64 indexed id, uint64 parentA, uint64 parentB, uint8[2] mutGenes, int16[2] mutDeltas, uint256 lo, uint256 hi, uint256 indexed epoch);
    event AttackDied(uint64 indexed id, uint256 indexed epoch, uint256 extracted);
    event StakeReturned(address indexed to, uint256 amount, uint64 indexed id, bool attack);
    event StakeForfeited(address indexed from, uint256 amount, uint256 indexed epoch);
    event Slashed(uint256 indexed epoch, uint256 total, uint256 toSurvivors, uint256 toHonest, uint256 toPool);
    event Compensated(uint256 indexed epoch, address indexed user, uint256 amount, uint256 falseRefusals);
    event Rewarded(uint256 indexed epoch, address indexed to, uint256 amount, uint8 kind);
    event BetPlaced(uint256 indexed epoch, address indexed bettor, uint64 indexed lineage, uint256 amount);
    event BetSettled(uint256 indexed epoch, uint64 indexed winningLineage, uint256 totalPool, uint256 winningPool);
    event BetPaid(uint256 indexed epoch, address indexed bettor, uint256 payout);
    event Claimed(address indexed who, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount);
    /// @notice source 3: the hash of the round's last block; 4: the close came over 256 blocks later, so the hash
    ///         of the last block 256*k after it (prevrandao and the previous block hash are not used).
    event Randomness(uint256 indexed epoch, uint8 source, uint256 seed);
    /// @notice The live champion kept the crown because the best challenger did not beat it by the margin.
    event CrownKept(uint256 indexed epoch, uint64 indexed champion, uint64 challenger, int256 championFitness, int256 challengerFitness);

    // ------------------------------------------------------------------ errors
    error VaultAlreadySet();
    error NotVault();
    error NotStarted();
    error AlreadyStarted();
    error NotWired();
    error ZeroAddress();
    error BadStake(uint256 required);
    error AlreadySubmitted();
    error PoolFull();
    error EpochNotOver(uint256 endBlock);
    error EpochAlreadyClosed();
    error TooManyAttackers();
    error UnknownAttack();
    error UnknownLineage();
    error BetTooSmall();
    error AlreadyBet();
    error NoBet();
    error EpochOpen();
    error NothingToClaim();
    error TransferFailed();
    error BadTiming();
    error NotCrucible();
    error CrucibleAlreadySet();
    error NeedGas(uint256 required);
    /// @notice A staked policy failed the Crucible's screen (1 refuses an honest payment, 2 weaker than the
    ///         champion, 5 lets a drain canary through, 6 not monotone in amount and outflow).
    error Screened(uint8 verdict);
    /// @notice Bets close at the reveal block.
    error BettingClosed(uint256 closedAt);

    /// @param seedAttacks attack genomes (lo, hi) in the attack pool before anyone stakes one.
    constructor(Config memory c, uint256[2][] memory seedAttacks) Ownable(msg.sender) {
        if (c.firewall == address(0) || c.lineage == address(0)) revert ZeroAddress();
        if (c.epochLength < 2 || c.revealWindow == 0 || c.revealWindow >= c.epochLength) revert BadTiming();
        if (seedAttacks.length > MAX_ATTACK_POOL) revert PoolFull();
        firewall = IFirewall(c.firewall);
        lineage = ILineage(c.lineage);
        epochLength = c.epochLength;
        revealWindow = c.revealWindow;
        POLICY_STAKE = c.policyStake;
        ATTACK_STAKE = c.attackStake;
        MIN_BET = c.minBet;
        closeTip = c.closeTip;
        mutationScale = c.mutationScale == 0 ? 64 : c.mutationScale;
        genesisLo = c.genesisLo;
        genesisHi = c.genesisHi;
        for (uint256 i = 0; i < seedAttacks.length; i++) {
            uint64 id = ++attackCount;
            (uint256 lo, uint256 hi) = (seedAttacks[i][0], seedAttacks[i][1]);
            attacks[id] = AttackGenome(lo, hi, 0, 0, 1, 0, address(0), true, 0);
            attackPool.push(id);
            emit AttackSubmitted(0, id, address(0), lo, hi, false);
        }
    }

    modifier whenStarted() {
        if (!started) revert NotStarted();
        _;
    }

    // ------------------------------------------------------------------ setup

    function setVault(address v) external onlyOwner {
        if (address(vault) != address(0)) revert VaultAlreadySet();
        if (v == address(0)) revert ZeroAddress();
        vault = IVaultLog(v);
        emit VaultSet(v);
    }

    /// @notice Wire the sparring ring. One-shot. Without it, fitness is the live result alone.
    function setCrucible(address c) external onlyOwner {
        if (address(crucible) != address(0)) revert CrucibleAlreadySet();
        if (c == address(0)) revert ZeroAddress();
        crucible = ICrucible(c);
        emit CrucibleSet(c);
    }

    /// @notice Install the genesis policy (the deploy-time genome; all-zero refuses nothing) and open epoch 1.
    ///         Genesis is the only policy that becomes live without breeding, a stake or the Crucible's screen.
    function start() external onlyOwner {
        if (started) revert AlreadyStarted();
        if (address(vault) == address(0) || firewall.arena() != address(this) || lineage.writer() != address(this)) {
            revert NotWired();
        }
        started = true;
        uint64 id = ++policyCount;
        (uint256 lo, uint256 hi) = (genesisLo, genesisHi);
        policies[id] = Policy(lo, hi, 0, 0, id, 0, 0, address(0), 0, true, 0);
        pool.push(id);
        lineage.recordBirth(id, 0, 0, id, 0, 0, lo, hi, address(0));
        firewall.install(id, lo, hi);
        lineage.record(id, 0, 0, 0, 0, 0);
        emit PolicyInstalled(id, 0, 0, 0, 0, 0, lo, hi, id);
        _startEpoch(1);
    }

    function fundPool() external payable {
        protocolPool += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ submissions

    /// @notice Stake POLICY_STAKE and enter a candidate genome into the shadow pool. One per wallet per epoch.
    ///         With a Crucible wired, the genome must pass the same screen as a free proposal (no honest bench
    ///         payment refused, no drain canary let through, at least as strong as the live champion in sparring),
    ///         or the submission reverts with Screened(verdict) and the stake stays with the sender.
    function submitPolicy(int16[32] calldata genome) external payable whenStarted returns (uint64) {
        (uint256 lo, uint256 hi) = GenomeLib.pack(genome);
        return _submitPolicy(lo, hi);
    }

    function submitPolicyPacked(uint256 lo, uint256 hi) external payable whenStarted returns (uint64) {
        return _submitPolicy(lo, hi);
    }

    function _submitPolicy(uint256 lo, uint256 hi) internal returns (uint64) {
        if (msg.value != POLICY_STAKE) revert BadStake(POLICY_STAKE);
        _advance(msg.sender);
        if (address(crucible) != address(0)) {
            uint8 v = crucible.screenVerdict(lo, hi);
            if (v != 0) revert Screened(v);
        }
        return _enter(lo, hi, msg.sender, msg.value);
    }

    /// @notice A policy proposed through the Crucible that passed its screen (no honest refusals, at least
    ///         as strong as the live champion in sparring) enters the shadow pool without a stake. It counts as
    ///         the proposer's one policy for the epoch.
    function enterProposal(uint256 lo, uint256 hi, address proposer) external whenStarted returns (uint64) {
        if (msg.sender != address(crucible)) revert NotCrucible();
        return _enter(lo, hi, proposer, 0);
    }

    function _enter(uint256 lo, uint256 hi, address who, uint256 stake) internal returns (uint64 id) {
        uint256 e = currentEpoch;
        if (policySubmitted[e][who]) revert AlreadySubmitted();
        if (pool.length >= MAX_CANDIDATES) revert PoolFull();
        policySubmitted[e][who] = true;
        id = ++policyCount;
        policies[id] = Policy(lo, hi, 0, 0, id, 1, uint32(e), who, uint96(stake), true, 0);
        pool.push(id);
        lineage.recordBirth(id, 0, 0, id, 1, uint32(e), lo, hi, who);
        emit PolicySubmitted(e, id, who, lo, hi);
    }

    /// @notice Stake ATTACK_STAKE and enter an 8-step attack template (32 genes, 4 per step).
    ///         Grants the right to spend from the vault this epoch. One per wallet per epoch.
    function submitAttack(int16[32] calldata genome) external payable whenStarted returns (uint64) {
        (uint256 lo, uint256 hi) = GenomeLib.pack(genome);
        return _submitAttack(lo, hi);
    }

    function submitAttackPacked(uint256 lo, uint256 hi) external payable whenStarted returns (uint64) {
        return _submitAttack(lo, hi);
    }

    function _submitAttack(uint256 lo, uint256 hi) internal returns (uint64 id) {
        _enterAttacker();
        if (attackPool.length >= MAX_ATTACK_POOL) revert PoolFull();
        uint256 e = currentEpoch;
        id = ++attackCount;
        attacks[id] = AttackGenome(lo, hi, 0, 0, 1, uint32(e), msg.sender, true, 0);
        attackPool.push(id);
        attackOf[e][msg.sender] = id;
        emit AttackSubmitted(e, id, msg.sender, lo, hi, false);
    }

    /// @notice Stake ATTACK_STAKE and run an existing (e.g. bred) attack genome from the pool.
    ///         This is how the evolved-attacker runner executes the second population.
    function adoptAttack(uint64 id) external payable whenStarted {
        if (!attacks[id].alive) revert UnknownAttack();
        _enterAttacker();
        uint256 e = currentEpoch;
        attackOf[e][msg.sender] = id;
        AttackGenome storage a = attacks[id];
        emit AttackSubmitted(e, id, msg.sender, a.lo, a.hi, true);
    }

    function _enterAttacker() internal {
        if (msg.value != ATTACK_STAKE) revert BadStake(ATTACK_STAKE);
        _advance(msg.sender);
        uint256 e = currentEpoch;
        if (attackOf[e][msg.sender] != 0) revert AlreadySubmitted();
        if (epochAttackers[e].length >= MAX_ATTACKERS_PER_EPOCH) revert TooManyAttackers();
        epochAttackers[e].push(msg.sender);
    }

    // ------------------------------------------------------------------ traffic (called by Vault)

    function hasAttack(address who) external view returns (bool) {
        return started && attackOf[currentEpoch][who] != 0;
    }

    /// @notice Shadow scoring: which pool candidates would refuse, and which would hold, this feature vector
    ///         (bit j = pool[j]).
    function shadowMask(uint256[8] calldata f) external view returns (uint16 refuse, uint16 hold) {
        (uint256[] memory los, uint256[] memory his) = _policyGenomes();
        return firewall.shadowMasks(los, his, f);
    }

    function _policyGenomes() internal view returns (uint256[] memory los, uint256[] memory his) {
        uint256 n = pool.length;
        los = new uint256[](n);
        his = new uint256[](n);
        for (uint256 j = 0; j < n; j++) {
            Policy storage p = policies[pool[j]];
            (los[j], his[j]) = (p.lo, p.hi);
        }
    }

    /// @notice Self-driving rounds. The Vault calls this at the top of every spend, the Crucible at every
    ///         proposal (and submissions and bets do the same internally): if the current epoch is overdue it
    ///         is closed first, inside the caller's transaction, and the caller (tx.origin) is tipped from the
    ///         protocol pool. A wallet with an attack staked in the current epoch never closes it, so its plan
    ///         cannot expire under it mid-attack; its spends land in the epoch it staked for.
    function poke(address caller) external {
        if (msg.sender != address(vault) && msg.sender != address(crucible)) revert NotVault();
        if (started) _advance(caller);
    }

    /// @dev Anyone who may close must bring CLOSE_GAS, overdue or not: a wallet estimates gas against the state
    ///      at signing, and the epoch can fall due before the transaction lands. Unused gas is not charged.
    function _advance(address caller) internal {
        uint256 e = currentEpoch;
        if (attackOf[e][caller] != 0 || attackOf[e][tx.origin] != 0) return;
        if (gasleft() < CLOSE_GAS) revert NeedGas(CLOSE_GAS);
        if (block.number >= epochStartBlock + epochLength) _close(e, tx.origin);
    }

    /// @notice Vault reports a spend that passed the live firewall; attribute it to the running attack genome.
    function recordExtraction(address caller, address origin, uint256 amount) external {
        if (msg.sender != address(vault)) revert NotVault();
        uint256 e = currentEpoch;
        address w = caller;
        uint64 a = attackOf[e][caller];
        if (a == 0 && origin != caller) {
            w = origin;
            a = attackOf[e][origin];
        }
        if (a != 0) {
            attackExtracted[e][a] += amount;
            uint256 before = walletExtracted[e][w];
            walletExtracted[e][w] = before + amount;
            // the stake comes back once the wallet has taken at least the stake itself this round. That can only
            // become true, never false again, so it is settled here, at the payment that crosses the line.
            uint256 bar = _stakeBar();
            if (before < bar && before + amount >= bar) {
                stakesReturned[e]++;
                claimable[w] += ATTACK_STAKE;
                emit StakeReturned(w, ATTACK_STAKE, a, true);
            }
        }
    }

    /// @dev What a wallet must take in a round to get its attack stake back (the stake itself; at least 1 wei).
    function _stakeBar() internal view returns (uint256) {
        return ATTACK_STAKE == 0 ? 1 : ATTACK_STAKE;
    }

    function revealOpensAt() public view returns (uint256) {
        return epochStartBlock + epochLength - revealWindow;
    }

    // ------------------------------------------------------------------ betting

    /// @notice Bet on which lineage (root policy id) holds the live slot after this epoch closes.
    function placeBet(uint64 lineageRoot) external payable whenStarted {
        if (msg.value < MIN_BET) revert BetTooSmall();
        _advance(msg.sender);
        // from the reveal block on (an overdue round included: a staked wallet cannot close it) the
        // outcome can be simulated with a free call of the close, so betting is closed.
        uint256 closes = revealOpensAt();
        if (block.number >= closes) revert BettingClosed(closes);
        uint256 e = currentEpoch;
        if (bets[e][msg.sender].amount != 0) revert AlreadyBet();
        if (!_lineageAlive(lineageRoot)) revert UnknownLineage();
        bets[e][msg.sender] = Bet(lineageRoot, uint96(msg.value), false);
        lineageStake[e][lineageRoot] += msg.value;
        betPool[e] += msg.value;
        emit BetPlaced(e, msg.sender, lineageRoot, msg.value);
    }

    function _lineageAlive(uint64 root) internal view returns (bool) {
        for (uint256 j = 0; j < pool.length; j++) {
            if (policies[pool[j]].root == root) return true;
        }
        return false;
    }

    /// @notice Pari-mutuel settlement of your bet for a closed epoch into `claimable`.
    ///         If nobody backed the winning lineage, every bet is refunded.
    function settleBet(uint256 epoch) external {
        if (!epochClosed[epoch]) revert EpochOpen();
        Bet storage b = bets[epoch][msg.sender];
        if (b.amount == 0 || b.settled) revert NoBet();
        b.settled = true;
        uint64 win = winningLineage[epoch];
        uint256 winPool = lineageStake[epoch][win];
        uint256 payout;
        if (winPool == 0) payout = b.amount;
        else if (b.lineage == win) payout = (uint256(b.amount) * betPool[epoch]) / winPool;
        if (payout > 0) claimable[msg.sender] += payout;
        emit BetPaid(epoch, msg.sender, payout);
    }

    // ------------------------------------------------------------------ claims

    function claim() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        if (amt == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amt);
    }

    // ------------------------------------------------------------------ epoch close

    /// @notice Close the current epoch: fitness, selection, slashing, install, breeding, attack co-evolution,
    ///         bet settlement. Permissionless. Reverts before `epochLength` blocks have passed.
    function closeEpoch() external nonReentrant whenStarted {
        uint256 e = currentEpoch;
        if (epochClosed[e]) revert EpochAlreadyClosed();
        uint256 endBlock = epochStartBlock + epochLength;
        if (block.number < endBlock) revert EpochNotOver(endBlock);
        _close(e, msg.sender);
    }

    function _close(uint256 e, address closer) internal {
        epochClosed[e] = true;

        uint256 seed = _entropy(e);
        _settleAttackerStakes(e);
        (int256[] memory sp, uint256[] memory sa) = _spar(e);
        uint64 champion = _evolvePolicies(e, seed, sp);
        _evolveAttacks(e, seed, sa);

        uint64 win = policies[champion].root;
        winningLineage[e] = win;
        emit BetSettled(e, win, betPool[e], lineageStake[e][win]);
        _tip(e, closer);
        _startEpoch(e + 1);
    }

    /// @dev The Crucible's sparring score per pool candidate (wei, <= 0) and per attack genome (wei it would take,
    ///      averaged over the pool). Zeros when no Crucible is wired.
    function _spar(uint256 e) internal returns (int256[] memory, uint256[] memory) {
        uint256 na = attackPool.length;
        if (address(crucible) == address(0)) return (new int256[](pool.length), new uint256[](na));
        (uint256[] memory pl, uint256[] memory ph) = _policyGenomes();
        uint256[] memory al = new uint256[](na);
        uint256[] memory ah = new uint256[](na);
        for (uint256 k = 0; k < na; k++) {
            AttackGenome storage a = attacks[attackPool[k]];
            (al[k], ah[k]) = (a.lo, a.hi);
        }
        return crucible.grade(e, epochStartBalance, pool, pl, ph, attackPool, al, ah);
    }

    function _tip(uint256 e, address to) internal {
        uint256 t = closeTip < protocolPool ? closeTip : protocolPool;
        if (t == 0) return;
        protocolPool -= t;
        claimable[to] += t;
        emit Rewarded(e, to, t, 2);
    }

    function _evolvePolicies(uint256 e, uint256 seed, int256[] memory sp) internal returns (uint64 champion) {
        uint256 lambda = (epochStartBalance * LAMBDA_BPS) / 10_000;
        Tally memory t = _tally(e);
        (uint256[] memory order, int256[] memory fit) = _rank(t, sp);
        _keepCrown(e, order, fit);
        uint64[] memory ranked = new uint64[](t.n);
        for (uint256 r = 0; r < t.n; r++) ranked[r] = pool[order[r]];
        uint64[] memory survivors = _select(e, order, fit, t, lambda);
        champion = survivors[0];
        _install(e, champion, fit[order[0]]);
        _breedPolicies(e, survivors, seed);
        _emitTable(CloseInfo(e, champion, seed, t.txCount), t, fit, order, ranked);
    }

    /// @dev The breeding seed is the hash of the round's last block. It is fixed before anyone may close the
    ///      round and does not depend on when the close lands, so a closer can neither steer it by timing nor pick
    ///      among values (prevrandao at the close would not do: Base holds it for 60 blocks, so a closer could preview it
    ///      and wait for a better one). A contract can read only the last 256 block hashes; if the close comes later
    ///      than that, the seed is the hash of the last of the blocks 256, 512, ... after the round's last block,
    ///      which is just as fixed (moving to it means leaving the round open for another 256 blocks, which anyone's
    ///      payment, bet or proposal would close first).
    function _entropy(uint256 e) internal returns (uint256 seed) {
        uint256 last = epochStartBlock + epochLength - 1;
        uint256 anchor = last + 256 * ((block.number - last - 1) / 256);
        seed = uint256(keccak256(abi.encode(blockhash(anchor), e, address(this))));
        emit Randomness(e, anchor == last ? 3 : 4, seed);
    }

    /// @dev Returned stakes were credited during the round (recordExtraction); the rest go to the protocol pool.
    function _settleAttackerStakes(uint256 e) internal {
        address[] storage list = epochAttackers[e];
        uint256 n = list.length;
        uint256 lost = n - stakesReturned[e];
        if (lost == 0) return;
        uint256 bar = _stakeBar();
        for (uint256 i = 0; i < n; i++) {
            address w = list[i];
            if (walletExtracted[e][w] < bar) emit StakeForfeited(w, ATTACK_STAKE, e);
        }
        protocolPool += lost * ATTACK_STAKE;
    }

    function _tally(uint256 e) internal view returns (Tally memory t) {
        t.n = pool.length;
        (t.retained, t.honestCost, t.users, t.wrong, t.userCount, t.totalWrong, t.txCount) = vault.tally(e, t.n, epochStartBalance);
    }

    /// @dev F = R - C (+ the sparring score S when a Crucible is wired), ranked descending. R credits a held
    ///      attack at half its value and C prices each wrong refusal by its payment (Vault.tally).
    function _rank(Tally memory t, int256[] memory sp) internal pure returns (uint256[] memory order, int256[] memory fit) {
        fit = new int256[](t.n);
        for (uint256 j = 0; j < t.n; j++) {
            fit[j] = int256(t.retained[j]) - int256(t.honestCost[j]) + sp[j];
        }
        order = _sortDesc(fit);
    }

    /// @dev The live champion is pool[0] (start() and _breedPolicies keep it there). If the best challenger does
    ///      not beat it by MARGIN_BPS of the round's starting balance, the champion moves back to the top and keeps
    ///      the crown; everyone else keeps their relative order.
    function _keepCrown(uint256 e, uint256[] memory order, int256[] memory fit) internal {
        if (order.length < 2 || order[0] == 0) return;
        int256 margin = int256((epochStartBalance * MARGIN_BPS) / 10_000);
        if (fit[order[0]] - fit[0] >= margin) return;
        emit CrownKept(e, pool[0], pool[order[0]], fit[0], fit[order[0]]);
        uint256 p = 1;
        while (order[p] != 0) p++;
        for (; p > 0; p--) order[p] = order[p - 1];
        order[0] = 0;
    }

    /// @dev Insertion sort (stable) of indices by value, descending. Ties keep pool order, so survivors stay put
    ///      on quiet epochs.
    function _sortDesc(int256[] memory v) internal pure returns (uint256[] memory order) {
        uint256 n = v.length;
        order = new uint256[](n);
        for (uint256 j = 0; j < n; j++) order[j] = j;
        for (uint256 i = 1; i < n; i++) {
            uint256 key = order[i];
            uint256 k = i;
            while (k > 0 && v[order[k - 1]] < v[key]) {
                order[k] = order[k - 1];
                k--;
            }
            order[k] = key;
        }
    }

    function _select(uint256 e, uint256[] memory order, int256[] memory fit, Tally memory t, uint256 lambda)
        internal
        returns (uint64[] memory survivors)
    {
        uint256 s = t.n < SURVIVORS ? t.n : SURVIVORS;
        survivors = new uint64[](s);
        uint256 slashed;
        for (uint256 r = 0; r < t.n; r++) {
            uint64 id = pool[order[r]];
            Policy storage p = policies[id];
            p.lastFitness = fit[order[r]];
            uint256 st = p.stake;
            p.stake = 0;
            if (r < s) {
                survivors[r] = id;
                if (st > 0) {
                    claimable[p.submitter] += st;
                    emit StakeReturned(p.submitter, st, id, false);
                }
            } else {
                p.alive = false;
                slashed += st;
                emit PolicyDied(id, e, fit[order[r]], st);
            }
        }
        _distribute(e, slashed, survivors, t, lambda);
    }

    function _distribute(uint256 e, uint256 slashed, uint64[] memory survivors, Tally memory t, uint256 lambda) internal {
        uint256 toSurv = (slashed * SURVIVOR_SHARE) / 100;
        uint256 toHon = (slashed * HONEST_SHARE) / 100;
        uint256 toPool = slashed - toSurv - toHon;

        // 60% to the submitters (lineage owners) of the surviving policies
        uint256 payees;
        for (uint256 i = 0; i < survivors.length; i++) {
            if (policies[survivors[i]].submitter != address(0)) payees++;
        }
        if (payees == 0) {
            toPool += toSurv;
        } else {
            uint256 each = toSurv / payees;
            toPool += toSurv - each * payees;
            for (uint256 i = 0; i < survivors.length; i++) {
                address sub = policies[survivors[i]].submitter;
                if (sub != address(0) && each > 0) {
                    claimable[sub] += each;
                    emit Rewarded(e, sub, each, 0);
                }
            }
        }

        // 30% to honest users the live policy wrongly refused, weighted by count
        if (t.totalWrong == 0) {
            toPool += toHon;
        } else {
            uint256 paid;
            for (uint256 u = 0; u < t.userCount; u++) {
                uint256 amt = (toHon * t.wrong[u]) / t.totalWrong;
                if (amt > 0) {
                    claimable[t.users[u]] += amt;
                    paid += amt;
                    emit Rewarded(e, t.users[u], amt, 1);
                }
            }
            toPool += toHon - paid;
        }
        protocolPool += toPool;
        emit Slashed(e, slashed, toSurv, toHon, toPool);

        // False-refusal compensation: lambda per wrong refusal, paid from the protocol pool (pro-rata if short)
        if (t.totalWrong > 0 && lambda > 0) {
            uint256 need = lambda * t.totalWrong;
            uint256 avail = protocolPool < need ? protocolPool : need;
            for (uint256 u = 0; u < t.userCount; u++) {
                uint256 amt = (avail * t.wrong[u]) / t.totalWrong;
                if (amt > 0) {
                    protocolPool -= amt;
                    claimable[t.users[u]] += amt;
                }
                emit Compensated(e, t.users[u], amt, t.wrong[u]);
            }
        }
    }

    function _install(uint256 e, uint64 id, int256 fitness) internal {
        Policy storage p = policies[id];
        firewall.install(id, p.lo, p.hi);
        lineage.record(id, p.parentA, p.parentB, p.generation, fitness, uint32(e));
        emit PolicyInstalled(id, p.generation, p.parentA, p.parentB, fitness, e, p.lo, p.hi, p.root);
    }

    function _pairIndex(uint256 c, uint256 s) internal pure returns (uint256 a, uint256 b) {
        // Pairs (0,1) (0,2) (1,3) (2,3); with fewer than 4 survivors indices wrap.
        uint256 packed = 0x23130201; // byte c = (a << 4) | b
        uint256 by = (packed >> (c * 8)) & 0xFF;
        a = (by >> 4) % s;
        b = (by & 0x0F) % s;
    }

    function _breedPolicies(uint256 e, uint64[] memory survivors, uint256 seed) internal {
        uint256 s = survivors.length;
        delete pool;
        for (uint256 i = 0; i < s; i++) pool.push(survivors[i]);
        for (uint256 c = 0; c < CHILDREN; c++) {
            (uint256 ia, uint256 ib) = _pairIndex(c, s);
            pool.push(_breedPolicyChild(e, survivors[ia], survivors[ib], uint256(keccak256(abi.encode(seed, "policy", c)))));
        }
    }

    function _breedPolicyChild(uint256 e, uint64 pa, uint64 pb, uint256 r) internal returns (uint64 id) {
        id = ++policyCount;
        Policy storage C = policies[id];
        uint8[2] memory mg;
        int16[2] memory md;
        {
            Policy storage A = policies[pa];
            Policy storage B = policies[pb];
            // clamped monotone in amount and outflow at birth (Firewall.breedPolicy)
            (C.lo, C.hi, mg, md) = firewall.breedPolicy(A.lo, A.hi, B.lo, B.hi, r, mutationScale);
            C.generation = (A.generation > B.generation ? A.generation : B.generation) + 1;
            C.root = A.root;
            C.submitter = A.submitter;
        }
        C.parentA = pa;
        C.parentB = pb;
        C.bornEpoch = uint32(e + 1);
        C.alive = true;
        lineage.recordBirth(id, pa, pb, C.root, C.generation, C.bornEpoch, C.lo, C.hi, C.submitter);
        emit ChildBorn(id, pa, pb, mg, md, C.lo, C.hi, e);
    }

    /// @dev Attack genomes rank by what they took for real this epoch plus what they take in sparring;
    ///      `lastExtracted`, AttackEpochResults and AttackDied keep reporting the real extraction only.
    function _evolveAttacks(uint256 e, uint256 seed, uint256[] memory sa) internal {
        uint256 na = attackPool.length;
        if (na == 0) return;
        uint64[] memory ids = new uint64[](na);
        uint256[] memory ext = new uint256[](na);
        int256[] memory score = new int256[](na);
        for (uint256 j = 0; j < na; j++) {
            ids[j] = attackPool[j];
            ext[j] = attackExtracted[e][ids[j]];
            attacks[ids[j]].lastExtracted = ext[j];
            score[j] = int256(ext[j] + sa[j]);
        }
        uint64[] memory surv = _selectAttacks(e, ids, ext, _sortDesc(score));
        emit AttackEpochResults(e, ids, ext);
        _breedAttacks(e, surv, seed);
    }

    function _selectAttacks(uint256 e, uint64[] memory ids, uint256[] memory ext, uint256[] memory order)
        internal
        returns (uint64[] memory surv)
    {
        uint256 na = ids.length;
        uint256 s = na < SURVIVORS ? na : SURVIVORS;
        surv = new uint64[](s);
        for (uint256 r = 0; r < na; r++) {
            uint64 id = ids[order[r]];
            if (r < s) surv[r] = id;
            else {
                attacks[id].alive = false;
                emit AttackDied(id, e, ext[order[r]]);
            }
        }
    }

    function _breedAttacks(uint256 e, uint64[] memory surv, uint256 seed) internal {
        uint256 s = surv.length;
        delete attackPool;
        for (uint256 i = 0; i < s; i++) attackPool.push(surv[i]);
        for (uint256 c = 0; c < CHILDREN; c++) {
            (uint256 ia, uint256 ib) = _pairIndex(c, s);
            attackPool.push(_breedAttackChild(e, surv[ia], surv[ib], uint256(keccak256(abi.encode(seed, "attack", c)))));
        }
    }

    function _breedAttackChild(uint256 e, uint64 pa, uint64 pb, uint256 r) internal returns (uint64 id) {
        id = ++attackCount;
        AttackGenome storage C = attacks[id];
        uint8[2] memory mg;
        int16[2] memory md;
        {
            AttackGenome storage A = attacks[pa];
            AttackGenome storage B = attacks[pb];
            (C.lo, C.hi, mg, md) = firewall.breedScaled(A.lo, A.hi, B.lo, B.hi, r, GenomeLib.ATTACK_ACTIVE_GENES, mutationScale);
            C.generation = (A.generation > B.generation ? A.generation : B.generation) + 1;
        }
        C.parentA = pa;
        C.parentB = pb;
        C.bornEpoch = uint32(e + 1);
        C.alive = true;
        emit AttackBorn(id, pa, pb, mg, md, C.lo, C.hi, e);
    }

    struct CloseInfo {
        uint256 epoch;
        uint64 champion;
        uint256 seed;
        uint256 txCount;
    }

    function _emitTable(CloseInfo memory info, Tally memory t, int256[] memory fit, uint256[] memory order, uint64[] memory ranked)
        internal
    {
        int256[] memory fs = new int256[](t.n);
        uint256[] memory rs = new uint256[](t.n);
        uint256[] memory bs = new uint256[](t.n);
        for (uint256 r = 0; r < t.n; r++) {
            uint256 j = order[r];
            fs[r] = fit[j];
            rs[r] = t.retained[j];
            bs[r] = t.honestCost[j];
        }
        _emitClosed(info, ranked, fs, rs, bs);
    }

    function _emitClosed(CloseInfo memory info, uint64[] memory ranked, int256[] memory fs, uint256[] memory rs, uint256[] memory bs)
        internal
    {
        emit EpochClosed(info.epoch, ranked, fs, rs, bs, info.champion, info.txCount, info.seed);
    }

    function _startEpoch(uint256 e) internal {
        currentEpoch = e;
        epochStartBlock = block.number;
        epochStartBalance = vault.balance(); // what the vault can pay (held payments are reserved)
        emit EpochStarted(e, block.number, block.number + epochLength, block.number + epochLength - revealWindow, epochStartBalance);
    }

    // ------------------------------------------------------------------ views

    function getPool() external view returns (uint64[] memory) {
        return pool;
    }

    function getAttackPool() external view returns (uint64[] memory) {
        return attackPool;
    }

    function getPolicy(uint64 id) external view returns (Policy memory) {
        return policies[id];
    }

    function getAttack(uint64 id) external view returns (AttackGenome memory) {
        return attacks[id];
    }

    function epochAttackerList(uint256 e) external view returns (address[] memory) {
        return epochAttackers[e];
    }

    function epochEndBlock() external view returns (uint256) {
        return epochStartBlock + epochLength;
    }

    /// @notice One call for the arena header.
    function status()
        external
        view
        returns (
            uint256 epoch,
            uint256 startBlock,
            uint256 endBlock,
            uint256 revealBlock,
            uint256 txCount,
            uint256 poolSize,
            uint256 attackPoolSize,
            uint256 pot,
            uint256 bets_
        )
    {
        epoch = currentEpoch;
        startBlock = epochStartBlock;
        endBlock = epochStartBlock + epochLength;
        revealBlock = endBlock - revealWindow;
        txCount = vault.epochTxCount(epoch);
        poolSize = pool.length;
        attackPoolSize = attackPool.length;
        pot = protocolPool;
        bets_ = betPool[epoch];
    }
}
