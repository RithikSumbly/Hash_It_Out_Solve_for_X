// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFirewall, IArena, IIdentityRegistry} from "./interfaces/IRedQueen.sol";

/// @title Vault — holds test ETH and routes every spend through the evolving Firewall.
/// @notice Two modes:
///   * Arena mode (`arena != 0`): the vault the room attacks. Participants are registered honest wallets,
///     wallets with a staked attack in the current epoch, or agents they delegated to. Every spend is
///     logged to the Arena so every shadow candidate is scored against the same traffic.
///   * Subscriber mode (`arena == 0`): anyone can deploy their own vault that follows a champion Firewall.
///     Only owner-registered wallets (and their delegated agents) may spend.
///
/// A refused spend does NOT revert: it emits `Spend(..., refused = true, reason, score)` and moves no funds,
/// so the refusal (and the attacker's attempt) is permanently on the explorer and in the shadow log.
///
/// Two hard limits sit under the evolved policy, and no genome can lift them (a back-doored champion included):
///   * one payment may take at most half of what the vault holds right now (MAX_SPEND_BPS, reason bit 16);
///   * a round's payments may take at most half of what the vault held when the round began (MAX_ROUND_OUTFLOW_BPS,
///     reason bit 17; the same start balance and outflow f7 measures).
/// A payment over either is refused like any refusal (recorded, not reverted). The live policy and every shadow
/// candidate still judge it as usual, so evolution keeps learning from it; the limits only override the live verdict.
///
/// A payment asked for by an attacker (a wallet with an attack staked this round,
/// a contract it calls through, or an agent it delegated to; `isAttacker`) meets tighter limits, so a policy the
/// screens failed to see through can still let out only a small share:
///   * one payment at most ATTACK_SPEND_BPS (10%) of what the vault can pay (reason bit 18);
///   * all attackers' payments in a round at most ATTACK_ROUND_BPS (20%) of the round's start balance (bit 19);
///   * a payment the policy would hold is refused instead (bit 20): nobody need watch an attacker's hold.
/// The round's log keeps HONEST_RESERVE slots for wallets that are not attacking, and one wallet (as caller or as
/// tx.origin) may log at most MAX_TX_PER_CALLER requests a round; its second request over a hard limit in a round
/// reverts (HardLimit) instead of being logged, so one wallet cannot fill the round's log. The vault never pays itself, and a deposit made in a round counts
/// against that round's outflow, so money that comes straight back does not fill the round's cap.
///
/// Three verdicts: a payment scoring above HOLD_SCORE but not above the refusal threshold is HELD,
/// not paid: it waits HOLD_DELAY blocks, during which the owner or a guardian may veto it, and then anyone may
/// release it. A held amount is reserved (every balance the vault uses is its balance minus `heldTotal`) and counts
/// toward the round's outflow from the moment it is held. Order: a hard limit refuses; a score above 500,000
/// refuses; a score above HOLD_SCORE holds; anything else pays.
contract Vault is Ownable, ReentrancyGuard {
    // ------------------------------------------------------------------ constants
    uint8 public constant KIND_PAY = 0;
    uint8 public constant KIND_WITHDRAW = 1;
    uint8 public constant KIND_DELEGATE = 2;

    /// @notice f2 window: spends by the caller in the last VELOCITY_WINDOW blocks.
    uint256 public constant VELOCITY_WINDOW = 20;
    /// @notice f2 increment per prior spend in the window (5 prior spends saturate at 1000).
    uint256 public constant VELOCITY_UNIT = 200;
    /// @notice f3 cap in blocks.
    uint256 public constant GAP_CAP = 100;
    /// @notice f4 age ramp in blocks.
    uint256 public constant REP_AGE_CAP = 1000;
    /// @notice Bound on logged spends per epoch so `closeEpoch()` stays well inside the block gas limit.
    uint256 public constant MAX_TX_PER_EPOCH = 240;
    /// @notice At most this many distinct wrongly refused honest users are paid at one close (bounds its gas, so
    ///         no epoch can ever need more than the per-transaction gas cap to close).
    uint256 public constant MAX_COMPENSATED = 32;
    /// @notice Hard limit: one payment may take at most this share (bps) of the vault's current balance.
    uint256 public constant MAX_SPEND_BPS = 5000;
    /// @notice Hard limit: a round's payments may take at most this share (bps) of the round's starting balance.
    uint256 public constant MAX_ROUND_OUTFLOW_BPS = 5000;
    /// @notice Reason bit of a payment refused because it asked for more than MAX_SPEND_BPS of the vault.
    uint256 public constant REASON_SPEND_CAP = 1 << 16;
    /// @notice Reason bit of a payment refused because it would take the round's outflow past MAX_ROUND_OUTFLOW_BPS.
    uint256 public constant REASON_ROUND_CAP = 1 << 17;
    /// @notice Hard limit for attackers: one payment may take at most this share (bps) of what the vault can pay.
    uint256 public constant ATTACK_SPEND_BPS = 1000;
    /// @notice Hard limit for attackers: all attackers' payments in a round together, at most this share (bps) of
    ///         the round's starting balance.
    uint256 public constant ATTACK_ROUND_BPS = 2000;
    /// @notice Reason bit of an attacker's payment over ATTACK_SPEND_BPS of the vault.
    uint256 public constant REASON_ATTACK_SPEND_CAP = 1 << 18;
    /// @notice Reason bit of an attacker's payment that would take the round's attacker outflow past ATTACK_ROUND_BPS.
    uint256 public constant REASON_ATTACK_ROUND_CAP = 1 << 19;
    /// @notice Reason bit of an attacker's payment the policy would hold: refused instead.
    uint256 public constant REASON_ATTACK_HOLD = 1 << 20;
    /// @notice Requests one wallet (as caller or as tx.origin) may log in a round.
    uint256 public constant MAX_TX_PER_CALLER = 16;
    /// @notice Slots of a round's log only wallets that are not attacking may fill.
    uint256 public constant HONEST_RESERVE = 48;

    /// @notice Verdicts (Spend.verdict, previewSpend, the tx log).
    uint8 public constant VERDICT_PAID = 0;
    uint8 public constant VERDICT_HELD = 1;
    uint8 public constant VERDICT_REFUSED = 2;
    /// @notice A score above this (and not above the refusal threshold, 500,000) holds the payment. Fixed, not
    ///         evolved; the same number as Firewall.HOLD_THRESHOLD.
    uint256 public constant HOLD_SCORE = 350_000;
    /// @notice Blocks a held payment waits before anyone may release it (about a minute on Base Sepolia).
    uint256 public constant HOLD_DELAY = 300;
    /// @notice Grading: share (bps) of an attack payment's value a candidate is credited with for holding it.
    uint256 public constant HOLD_CREDIT_BPS = 5000;
    /// @notice Grading: a wrongly refused honest payment costs a candidate WRONG_REFUSAL_MULT x its
    ///         amount plus WRONG_REFUSAL_FLOOR_BPS of the round's start balance; holding it costs a tenth of that.
    uint256 public constant WRONG_REFUSAL_MULT = 2;
    uint256 public constant WRONG_REFUSAL_FLOOR_BPS = 50;
    uint256 public constant HONEST_HOLD_DIVISOR = 10;

    uint8 public constant LABEL_NONE = 0;
    uint8 public constant LABEL_HONEST = 1;
    uint8 public constant LABEL_ATTACK = 2;

    // ------------------------------------------------------------------ wiring
    IFirewall public immutable firewall;
    IArena public arena;
    address public identityRegistry;
    /// @notice Subscriber-mode outflow period (blocks) for f7.
    uint256 public immutable periodLength;

    // ------------------------------------------------------------------ participants
    mapping(address => bool) public isHonest;
    mapping(address => uint64) public honestSince;
    mapping(address => bool) public isRegistrar;
    /// @notice Wallets that may veto a held payment (besides the owner).
    mapping(address => bool) public isGuardian;
    /// @notice agent => principal that funded it with a DELEGATE spend.
    mapping(address => address) public delegateOf;

    // ------------------------------------------------------------------ feature state
    mapping(address => uint256) public recipientPaid;
    mapping(address => uint256) public lastSpendBlock;
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public windowCount;
    uint256 public periodId;
    uint256 public periodStartBalance;
    uint256 public periodOutflow;
    /// @notice What attackers took this period (paid; an attacker's payment is never held), net of their deposits.
    uint256 public periodAttackOutflow;

    /// @dev A wallet's requests logged in a round, and whether one of them broke a hard limit.
    struct Quota {
        uint64 epoch;
        uint32 count;
        bool limited;
    }

    mapping(address => Quota) internal quota;

    // ------------------------------------------------------------------ held payments
    /// @notice A payment the live policy held: it waits until releaseBlock, then anyone may release it, unless the
    ///         owner or a guardian vetoes it first. `origin` is the transaction's sender at the time (it attributes
    ///         the extraction to a staked attacker who spent through an agent).
    struct HeldPayment {
        address from;
        uint96 amount;
        address to;
        uint64 releaseBlock;
        uint8 kind;
        bool settled;
        address origin;
        uint64 epoch;
        uint32 txId;
    }

    mapping(uint256 => HeldPayment) internal held;
    uint256 public heldCount;
    /// @notice The sum of every unsettled held payment; reserved, so it cannot be paid twice.
    uint256 public heldTotal;

    // ------------------------------------------------------------------ outcome log (arena mode)
    /// @notice `shadowMask` bit j = pool slot j would refuse; `holdMask` bit j = it would hold; `liveVerdict` is
    ///         0 paid, 1 held, 2 refused (`liveRefused` = liveVerdict == 2).
    struct TxRecord {
        address caller;
        uint96 amount;
        bytes32 commit;
        uint16 shadowMask;
        bool liveRefused;
        uint8 label;
        uint16 holdMask;
        uint8 liveVerdict;
    }

    /// @dev Stored with the amount next to the verdicts, so the close's tally reads one slot per payment (the
    ///      caller only for an honest payment the live policy refused). `getTx` returns a TxRecord.
    struct StoredTx {
        address caller;
        bytes32 commit;
        uint96 amount;
        uint16 shadowMask;
        uint16 holdMask;
        uint8 liveVerdict;
        uint8 label;
    }

    mapping(uint256 => StoredTx[]) internal epochTxs;

    // ------------------------------------------------------------------ stats
    uint256 public totalSpends;
    uint256 public totalRefused;
    uint256 public totalOutflow;
    uint256 public totalDeposited;

    // ------------------------------------------------------------------ events
    event Deposit(address indexed from, uint256 amount, uint256 balance);
    /// @notice The kill-feed event. `features` packs f0..f7 as 16-bit lanes (f_i at bits [16i, 16i+16)).
    ///         `verdict` 0 paid, 1 held (see Held), 2 refused; `refused` = verdict == 2. `reason` holds the
    ///         policy's bits on a hold or a refusal, plus bits 16/17 for the hard limits. `balanceAfter` is what the
    ///         vault can still pay (its balance minus held payments).
    event Spend(
        address indexed caller,
        address indexed to,
        uint256 amount,
        bool refused,
        uint256 reason,
        uint256 score,
        uint256 indexed epoch,
        uint256 txId,
        uint8 kind,
        uint256 features,
        uint256 balanceAfter,
        uint8 verdict
    );
    event HonestRegistered(address indexed who, address indexed by);
    event RegistrarSet(address indexed who, bool enabled);
    event IdentityRegistrySet(address registry);
    event ArenaSet(address arena);
    event Delegated(address indexed principal, address indexed agent, uint256 amount);
    /// @notice A delegation released by its agent or its principal (`by`), so the agent can be funded afresh.
    event Undelegated(address indexed principal, address indexed agent, address by);
    /// @notice Every shadow candidate's verdict on a logged spend (bit j of shadowMask = Arena pool slot j refused it;
    ///         bit j of holdMask = it would hold it; liveVerdict 0 paid, 1 held, 2 refused).
    event ShadowScored(
        uint256 indexed epoch, uint256 indexed txId, address indexed caller, uint16 shadowMask, bool liveRefused, uint16 holdMask, uint8 liveVerdict
    );
    /// @notice A payment held for HOLD_DELAY blocks (it moves nothing yet; its amount is reserved).
    event Held(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 releaseBlock, uint256 epoch, uint256 txId);
    /// @notice A held payment paid out by `by` once its delay was over.
    event Released(uint256 indexed id, address indexed by);
    /// @notice A held payment cancelled by the owner or a guardian (`by`); the money stays in the vault.
    event Vetoed(uint256 indexed id, address indexed by);
    event GuardianSet(address indexed who, bool enabled);
    event LabelRevealed(uint256 indexed epoch, uint256 indexed txId, address indexed caller, uint8 label);

    // ------------------------------------------------------------------ errors
    error NotParticipant();
    error NotRegistrar();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 balance, uint256 amount);
    error BadKind(uint8 kind);
    error WithdrawMustBeSelf();
    error TransferFailed();
    error ArenaAlreadySet();
    error EpochSaturated();
    error RevealNotOpen(uint256 opensAt);
    error NotYourTx();
    error AlreadyRevealed();
    error BadReveal();
    error LengthMismatch();
    error NoArena();
    /// @notice The agent already belongs to another principal (it or its principal must release it first).
    error AlreadyDelegated(address agent, address principal);
    error NotDelegated(address agent);
    error NotAgentOrPrincipal();
    /// @notice A held payment can be released only from its releaseBlock on.
    error TooEarly(uint256 releaseBlock);
    error AlreadySettled();
    error NotGuardian();
    error UnknownHold(uint256 id);
    /// @notice This wallet (as caller or tx.origin) has logged MAX_TX_PER_CALLER requests this round.
    error CallerSaturated(address who);
    /// @notice A second request over a hard limit in one round, from the same wallet (`reason` = the limits' bits).
    error HardLimit(uint256 reason);
    /// @notice The vault never pays itself.
    error PayToVault();

    constructor(address firewall_, address arena_, uint256 periodLength_) Ownable(msg.sender) {
        if (firewall_ == address(0)) revert ZeroAddress();
        firewall = IFirewall(firewall_);
        arena = IArena(arena_);
        periodLength = periodLength_ == 0 ? 25 : periodLength_;
        isRegistrar[msg.sender] = true;
    }

    // ------------------------------------------------------------------ admin

    /// @notice One-shot wiring for Remix deploy order (Vault can be deployed before the Arena).
    function setArena(address a) external onlyOwner {
        if (address(arena) != address(0)) revert ArenaAlreadySet();
        if (a == address(0)) revert ZeroAddress();
        arena = IArena(a);
        emit ArenaSet(a);
    }

    function setRegistrar(address who, bool enabled) external onlyOwner {
        isRegistrar[who] = enabled;
        emit RegistrarSet(who, enabled);
    }

    /// @notice Allow or stop a wallet vetoing held payments (the owner always may).
    function setGuardian(address who, bool enabled) external onlyOwner {
        isGuardian[who] = enabled;
        emit GuardianSet(who, enabled);
    }

    /// @notice ERC-8004 identity registry (ERC-721). Holders get a reputation bonus in f4.
    function setIdentityRegistry(address r) external onlyOwner {
        identityRegistry = r;
        emit IdentityRegistrySet(r);
    }

    function registerHonest(address who) external {
        if (!isRegistrar[msg.sender]) revert NotRegistrar();
        if (who == address(0)) revert ZeroAddress();
        if (isHonest[who]) return;
        isHonest[who] = true;
        honestSince[who] = uint64(block.number);
        emit HonestRegistered(who, msg.sender);
    }

    /// @notice Release an agent's delegation. Only the agent itself or its principal may, so no other
    ///         wallet can re-point the agent to itself with a DELEGATE payment.
    function undelegate(address agent) external {
        address principal = delegateOf[agent];
        if (principal == address(0)) revert NotDelegated(agent);
        if (msg.sender != agent && msg.sender != principal) revert NotAgentOrPrincipal();
        delete delegateOf[agent];
        emit Undelegated(principal, agent, msg.sender);
    }

    // ------------------------------------------------------------------ funds

    function deposit() public payable {
        if (msg.value == 0) revert ZeroAmount();
        totalDeposited += msg.value;
        // money back in the same round nets that round's outflow (an attacker's own deposit nets the
        // attackers' outflow too), so paying out and depositing back does not fill the round's cap
        if (periodId == _currentPeriod()) {
            periodOutflow = _less(periodOutflow, msg.value);
            if (periodAttackOutflow != 0 && isAttacker(msg.sender, tx.origin)) {
                periodAttackOutflow = _less(periodAttackOutflow, msg.value);
            }
        }
        emit Deposit(msg.sender, msg.value, _available());
    }

    receive() external payable {
        deposit();
    }

    /// @notice What the vault can pay: its balance minus the held payments it has reserved. The ETH balance of
    ///         the contract itself also includes those.
    function balance() external view returns (uint256) {
        return _available();
    }

    function _available() internal view returns (uint256) {
        return address(this).balance - heldTotal;
    }

    // ------------------------------------------------------------------ participation

    function isParticipant(address caller, address origin) public view returns (bool) {
        if (isHonest[caller]) return true;
        address principal = delegateOf[caller];
        if (principal != address(0) && (isHonest[principal] || _hasAttack(principal))) return true;
        if (_hasAttack(caller)) return true;
        if (origin != caller && _hasAttack(origin)) return true;
        return false;
    }

    /// @notice Whether a spend by `caller` in a transaction sent by `origin` is an attacker's: the caller, the
    ///         origin, or the principal the caller is an agent of has an attack staked this round.
    function isAttacker(address caller, address origin) public view returns (bool) {
        if (address(arena) == address(0)) return false;
        if (_hasAttack(caller)) return true;
        if (origin != caller && _hasAttack(origin)) return true;
        address p = delegateOf[caller];
        return p != address(0) && _hasAttack(p);
    }

    function _less(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _hasAttack(address who) internal view returns (bool) {
        if (address(arena) == address(0)) return false;
        return arena.hasAttack(who);
    }

    // ------------------------------------------------------------------ features

    function _currentPeriod() internal view returns (uint256) {
        if (address(arena) != address(0) && arena.started()) return arena.currentEpoch();
        return block.number / periodLength + 1;
    }

    /// @dev Start balance and outflow for the current period, rolling over lazily.
    function _periodView() internal view returns (uint256 startBal, uint256 outflow) {
        uint256 pid = _currentPeriod();
        if (address(arena) != address(0) && arena.started()) {
            startBal = arena.epochStartBalance();
        } else {
            startBal = pid == periodId ? periodStartBalance : _available();
        }
        outflow = pid == periodId ? periodOutflow : 0;
        if (startBal == 0) startBal = _available();
    }

    function _reputation(address who) internal view returns (uint256 r) {
        if (isHonest[who]) {
            uint256 age = block.number - honestSince[who];
            r = 500 + (age >= REP_AGE_CAP ? 300 : (age * 300) / REP_AGE_CAP);
        }
        if (identityRegistry != address(0)) {
            try IIdentityRegistry(identityRegistry).balanceOf(who) returns (uint256 n) {
                if (n > 0) r += 200;
            } catch {}
        }
        if (r > 1000) r = 1000;
    }

    /// @notice The 8 on-chain features (0..1000) a spend would have right now.
    ///         Callable by anyone to preview what the Firewall will see before signing.
    function features(address caller, address origin, address to, uint256 amount)
        public
        view
        returns (uint256[8] memory f)
    {
        (f,,) = _features(caller, origin, to, amount);
    }

    /// @dev The features, plus the round's start balance and outflow so far (what f7 and the round limit measure).
    function _features(address caller, address origin, address to, uint256 amount)
        internal
        view
        returns (uint256[8] memory f, uint256 startBal, uint256 outflow)
    {
        uint256 bal = _available();
        // f0 amount as share of what the vault can pay
        f[0] = bal == 0 ? 1000 : _cap((amount * 1000) / bal);
        // f1 recipient novelty
        f[1] = 1000 / (1 + recipientPaid[to]);
        // f2 velocity: prior spends by caller inside the window
        f[2] = block.number >= windowStart[caller] + VELOCITY_WINDOW ? 0 : _cap(windowCount[caller] * VELOCITY_UNIT);
        // f3 blocks since caller's last spend, capped
        uint256 last = lastSpendBlock[caller];
        f[3] = last == 0 ? 1000 : _cap(((block.number - last > GAP_CAP ? GAP_CAP : block.number - last) * 1000) / GAP_CAP);
        // f4 reputation: honest flag + age + ERC-8004 identity. Delegated agents inherit their principal's.
        address principal = delegateOf[caller];
        f[4] = _reputation(principal != address(0) && !isHonest[caller] ? principal : caller);
        // f5 call depth
        f[5] = origin != caller ? 1000 : 0;
        // f6 recipient is a contract
        f[6] = to.code.length > 0 ? 1000 : 0;
        // f7 cumulative outflow this epoch including this spend, as share of epoch start balance
        (startBal, outflow) = _periodView();
        f[7] = startBal == 0 ? 1000 : _cap(((outflow + amount) * 1000) / startBal);
    }

    /// @dev Hard limits: the reason bits of the limits a payment of `amount` would break (0 if none); an
    ///      attacker's payment also meets the attackers' limits.
    function _limits(uint256 amount, uint256 startBal, uint256 outflow, bool attacker) internal view returns (uint256 r) {
        uint256 avail = _available();
        if (amount * 10_000 > avail * MAX_SPEND_BPS) r = REASON_SPEND_CAP;
        if ((outflow + amount) * 10_000 > startBal * MAX_ROUND_OUTFLOW_BPS) r |= REASON_ROUND_CAP;
        if (attacker) {
            if (amount * 10_000 > avail * ATTACK_SPEND_BPS) r |= REASON_ATTACK_SPEND_CAP;
            if ((attackOutflow() + amount) * 10_000 > startBal * ATTACK_ROUND_BPS) r |= REASON_ATTACK_ROUND_CAP;
        }
    }

    /// @notice What attackers have taken in the current round (net of their own deposits).
    function attackOutflow() public view returns (uint256) {
        return periodId == _currentPeriod() ? periodAttackOutflow : 0;
    }

    /// @dev The live verdict with the vault's own rules over the policy's: an attacker's hold is refused (bit 20),
    ///      and a payment over a hard limit is refused (bits 16 to 19).
    function _override(uint8 verdict, uint256 reason, uint256 lim, bool attacker) internal pure returns (uint8, uint256) {
        if (attacker && verdict == VERDICT_HELD) {
            verdict = VERDICT_REFUSED;
            reason |= REASON_ATTACK_HOLD;
        }
        if (lim != 0) {
            verdict = VERDICT_REFUSED;
            reason |= lim;
        }
        return (verdict, reason);
    }

    function _cap(uint256 x) internal pure returns (uint256) {
        return x > 1000 ? 1000 : x;
    }

    function packFeatures(uint256[8] memory f) public pure returns (uint256 p) {
        for (uint256 i = 0; i < 8; i++) p |= (f[i] & 0xFFFF) << (16 * i);
    }

    /// @notice Preview the live verdict for a hypothetical spend (no state change), the hard limits included.
    ///         `verdict` 0 pay, 1 hold, 2 refuse (`refused` = verdict == 2). The attackers' limits apply too, when
    ///         `caller` is one (sent directly, so tx.origin = caller).
    function previewSpend(address caller, address to, uint256 amount)
        external
        view
        returns (bool refused, uint256 reason, uint256 score, uint256[8] memory f, uint8 verdict)
    {
        uint256 startBal;
        uint256 outflow;
        (f, startBal, outflow) = _features(caller, caller, to, amount);
        (verdict, reason, score) = firewall.judge(f);
        bool atk = isAttacker(caller, caller);
        (verdict, reason) = _override(verdict, reason, _limits(amount, startBal, outflow, atk), atk);
        refused = verdict == VERDICT_REFUSED;
    }

    // ------------------------------------------------------------------ spend

    /// @notice Ask the vault to send `amount` to `to`. The live firewall decides.
    /// @param kind 0 pay, 1 withdraw (to must be caller), 2 delegate (funds an agent that may then act for you)
    /// @param labelCommit keccak256(abi.encodePacked(uint8 label, bytes32 salt, address caller)); label 1 = honest, 2 = attack.
    /// @return passed true if the funds moved now (false when held or refused).
    struct Verdict {
        uint8 verdict;
        uint256 reason;
        uint256 score;
        uint256 epoch;
        uint256 txId;
        uint256 packed;
        bool attacker;
    }

    function spend(address payable to, uint256 amount, uint8 kind, bytes32 labelCommit)
        external
        nonReentrant
        returns (bool passed)
    {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert PayToVault();
        if (amount == 0) revert ZeroAmount();
        uint256 avail = _available();
        if (amount > avail) revert InsufficientBalance(avail, amount);
        if (kind > KIND_DELEGATE) revert BadKind(kind);
        if (kind == KIND_WITHDRAW && to != msg.sender) revert WithdrawMustBeSelf();
        if (kind == KIND_DELEGATE && to != msg.sender) {
            // an agent that already has a principal can be re-funded as a delegate only by that
            // principal; anyone else is refused until the agent or its principal releases it (`undelegate`).
            address p = delegateOf[to];
            if (p != address(0) && p != msg.sender) revert AlreadyDelegated(to, p);
        }
        if (!isParticipant(msg.sender, tx.origin)) revert NotParticipant();
        // Self-driving rounds: an overdue epoch closes here first (unless the caller is staked in it), so this
        // spend is judged by the freshly installed champion and logged in the new epoch.
        if (address(arena) != address(0)) arena.poke(msg.sender);

        Verdict memory v = _judge(to, amount, labelCommit);
        _touchCaller(msg.sender);
        totalSpends += 1;

        if (v.verdict == VERDICT_REFUSED) {
            totalRefused += 1;
        } else {
            // held or paid, it counts toward the round's outflow now
            periodOutflow += amount;
            if (v.verdict == VERDICT_HELD) {
                _hold(to, amount, kind, v);
            } else {
                if (v.attacker) periodAttackOutflow += amount;
                _pay(msg.sender, tx.origin, to, amount, kind);
            }
        }
        _emitSpend(to, amount, kind, v);
        return v.verdict == VERDICT_PAID;
    }

    function _emitSpend(address to, uint256 amount, uint8 kind, Verdict memory v) internal {
        emit Spend(
            msg.sender, to, amount, v.verdict == VERDICT_REFUSED, v.reason, v.score, v.epoch, v.txId, kind, v.packed, _available(), v.verdict
        );
    }

    /// @dev Moves the money (a paid spend, or a held one at its release), with the bookkeeping a payment carries.
    function _pay(address from, address origin, address to, uint256 amount, uint8 kind) internal {
        recipientPaid[to] += 1;
        totalOutflow += amount;
        if (kind == KIND_DELEGATE && to != from) {
            address p = delegateOf[to];
            if (p == address(0) || p == from) {
                delegateOf[to] = from;
                emit Delegated(from, to, amount);
            }
        }
        if (address(arena) != address(0) && arena.started()) arena.recordExtraction(from, origin, amount);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _hold(address to, uint256 amount, uint8 kind, Verdict memory v) internal {
        uint256 id = heldCount++;
        uint256 releaseBlock = block.number + HOLD_DELAY;
        held[id] = HeldPayment(msg.sender, uint96(amount), to, uint64(releaseBlock), kind, false, tx.origin, uint64(v.epoch), uint32(v.txId));
        heldTotal += amount;
        emit Held(id, msg.sender, to, amount, releaseBlock, v.epoch, v.txId);
    }

    /// @notice Pay out a held payment once its delay is over. Anyone may call it.
    function release(uint256 id) external nonReentrant {
        HeldPayment storage h = held[id];
        if (h.from == address(0)) revert UnknownHold(id);
        if (h.settled) revert AlreadySettled();
        if (block.number < h.releaseBlock) revert TooEarly(h.releaseBlock);
        h.settled = true;
        uint256 amount = h.amount;
        heldTotal -= amount;
        emit Released(id, msg.sender);
        _pay(h.from, h.origin, h.to, amount, h.kind);
    }

    /// @notice Cancel a held payment (the owner or a guardian, any time before it is released). The money stays
    ///         in the vault, and leaves the round's outflow if the round it was held in is still running.
    function veto(uint256 id) external {
        if (msg.sender != owner() && !isGuardian[msg.sender]) revert NotGuardian();
        HeldPayment storage h = held[id];
        if (h.from == address(0)) revert UnknownHold(id);
        if (h.settled) revert AlreadySettled();
        h.settled = true;
        uint256 amount = h.amount;
        heldTotal -= amount;
        if (h.epoch == periodId && periodId == _currentPeriod()) periodOutflow = _less(periodOutflow, amount); // deposits may have netted it
        emit Vetoed(id, msg.sender);
    }

    function getHeld(uint256 id) external view returns (HeldPayment memory) {
        return held[id];
    }

    function _judge(address to, uint256 amount, bytes32 labelCommit) internal returns (Verdict memory v) {
        _rollPeriod();
        (uint256[8] memory f, uint256 startBal, uint256 outflow) = _features(msg.sender, tx.origin, to, amount);
        (v.verdict, v.reason, v.score) = firewall.judge(f);
        // Hard limits (the attackers' too): they override the live verdict only; the shadow candidates below
        // still judge the payment
        v.attacker = isAttacker(msg.sender, tx.origin);
        uint256 lim = _limits(amount, startBal, outflow, v.attacker);
        (v.verdict, v.reason) = _override(v.verdict, v.reason, lim, v.attacker);
        v.packed = packFeatures(f);
        v.txId = type(uint256).max;
        if (address(arena) != address(0) && arena.started()) {
            v.epoch = arena.currentEpoch();
            StoredTx[] storage txs = epochTxs[v.epoch];
            // attackers cannot fill the slots kept for everyone else, nor one wallet more than its share
            if (txs.length >= (v.attacker ? MAX_TX_PER_EPOCH - HONEST_RESERVE : MAX_TX_PER_EPOCH)) revert EpochSaturated();
            _count(msg.sender, v.epoch, lim);
            if (tx.origin != msg.sender) _count(tx.origin, v.epoch, lim);
            (uint16 mask, uint16 hmask) = arena.shadowMask(f);
            v.txId = txs.length;
            txs.push(StoredTx(msg.sender, labelCommit, uint96(amount), mask, hmask, v.verdict, LABEL_NONE));
            emit ShadowScored(v.epoch, v.txId, msg.sender, mask, v.verdict == VERDICT_REFUSED, hmask, v.verdict);
        } else {
            v.epoch = periodId;
        }
    }

    /// @dev One more logged request for wallet `w` this round; at most MAX_TX_PER_CALLER, and only the first
    ///      over a hard limit is logged (a second reverts: it teaches the arena nothing new).
    function _count(address w, uint256 e, uint256 lim) internal {
        Quota memory q = quota[w];
        if (q.epoch != e) q = Quota(uint64(e), 0, false);
        if (q.count >= MAX_TX_PER_CALLER) revert CallerSaturated(w);
        if (lim != 0) {
            if (q.limited) revert HardLimit(lim);
            q.limited = true;
        }
        q.count++;
        quota[w] = q;
    }

    /// @notice Requests `who` has logged in the current round, and whether one broke a hard limit.
    function requestsThisRound(address who) external view returns (uint256 count, bool limited) {
        if (address(arena) == address(0)) return (0, false);
        Quota memory q = quota[who];
        if (q.epoch == arena.currentEpoch()) return (q.count, q.limited);
    }

    // ------------------------------------------------------------------ commit-reveal + outcome tally

    /// @notice Reveal labels for your own spends in the current epoch (opens in the last `revealWindow`
    ///         blocks). Only a registered honest wallet that did not stake an attack this epoch can make a
    ///         label count as honest; anything else counts as attack, and an unrevealed label counts as attack.
    function revealLabels(uint256[] calldata txIds, uint8[] calldata labels, bytes32[] calldata salts) external {
        if (address(arena) == address(0)) revert NoArena();
        if (txIds.length != labels.length || txIds.length != salts.length) revert LengthMismatch();
        uint256 opens = arena.revealOpensAt();
        if (block.number < opens) revert RevealNotOpen(opens);
        uint256 e = arena.currentEpoch();
        bool honestAllowed = isHonest[msg.sender] && !arena.hasAttack(msg.sender);
        StoredTx[] storage txs = epochTxs[e];
        for (uint256 i = 0; i < txIds.length; i++) {
            StoredTx storage t = txs[txIds[i]];
            if (t.caller != msg.sender) revert NotYourTx();
            if (t.label != LABEL_NONE) revert AlreadyRevealed();
            if (keccak256(abi.encodePacked(labels[i], salts[i], msg.sender)) != t.commit) revert BadReveal();
            uint8 l = (labels[i] == LABEL_HONEST && honestAllowed) ? LABEL_HONEST : LABEL_ATTACK;
            t.label = l;
            emit LabelRevealed(e, txIds[i], msg.sender, l);
        }
    }

    function epochTxCount(uint256 e) external view returns (uint256) {
        return epochTxs[e].length;
    }

    function getTx(uint256 e, uint256 i) external view returns (TxRecord memory) {
        StoredTx storage t = epochTxs[e][i];
        return TxRecord(t.caller, t.amount, t.commit, t.shadowMask, t.liveVerdict == VERDICT_REFUSED, t.label, t.holdMask, t.liveVerdict);
    }

    /// @notice Per-candidate outcome of an epoch for the first `n` pool slots (priced by payment, holds included):
    ///         retained[j]   wei candidate j would have kept against attack-labelled (or unrevealed) spends: the whole
    ///                       amount of one it refuses, HOLD_CREDIT_BPS of one it holds
    ///         honestCost[j] wei: for each honest spend it would refuse, WRONG_REFUSAL_MULT x the amount plus
    ///                       WRONG_REFUSAL_FLOOR_BPS of `startBalance` (the round's start); a tenth of that if it holds
    ///         users/wrong   honest users the LIVE verdict wrongly refused (a hold is not a refusal), and how often
    function tally(uint256 e, uint256 n, uint256 startBalance)
        external
        view
        returns (
            uint256[] memory retained,
            uint256[] memory honestCost,
            address[] memory users,
            uint256[] memory wrong,
            uint256 userCount,
            uint256 totalWrong,
            uint256 txCount
        )
    {
        StoredTx[] storage txs = epochTxs[e];
        txCount = txs.length;
        retained = new uint256[](n);
        honestCost = new uint256[](n);
        uint256 cap = txCount < MAX_COMPENSATED ? txCount : MAX_COMPENSATED;
        users = new address[](cap);
        wrong = new uint256[](cap);
        uint256 floor = (startBalance * WRONG_REFUSAL_FLOOR_BPS) / 10_000;
        for (uint256 i = 0; i < txCount; i++) {
            StoredTx storage r = txs[i];
            if (r.label == LABEL_HONEST) {
                _charge(honestCost, n, r.shadowMask, r.holdMask, WRONG_REFUSAL_MULT * r.amount + floor, HONEST_HOLD_DIVISOR);
                if (r.liveVerdict == VERDICT_REFUSED) {
                    totalWrong++;
                    uint256 u;
                    while (u < userCount && users[u] != r.caller) u++;
                    if (u == userCount) {
                        // at most MAX_COMPENSATED distinct users are paid per epoch (their share of the pot is
                        // computed over every wrong refusal, so the rest stays in the pool). This bounds the close.
                        if (userCount == MAX_COMPENSATED) continue;
                        users[u] = r.caller;
                        userCount++;
                    }
                    wrong[u]++;
                }
            } else {
                _charge(retained, n, r.shadowMask, r.holdMask, r.amount, 10_000 / HOLD_CREDIT_BPS);
            }
        }
    }

    /// @dev acc[j] += value for each candidate j that refuses, value / holdDivisor for each that holds.
    function _charge(uint256[] memory acc, uint256 n, uint256 mask, uint256 hmask, uint256 value, uint256 holdDivisor)
        internal
        pure
    {
        uint256 part = value / holdDivisor;
        for (uint256 j = 0; j < n && (mask | hmask) != 0; j++) {
            if (mask & 1 == 1) acc[j] += value;
            else if (hmask & 1 == 1) acc[j] += part;
            mask >>= 1;
            hmask >>= 1;
        }
    }

    function _rollPeriod() internal {
        uint256 pid = _currentPeriod();
        if (pid != periodId) {
            periodId = pid;
            periodStartBalance = _available();
            periodOutflow = 0;
            periodAttackOutflow = 0;
        }
    }

    function _touchCaller(address c) internal {
        if (block.number >= windowStart[c] + VELOCITY_WINDOW) {
            windowStart[c] = block.number;
            windowCount[c] = 1;
        } else {
            windowCount[c] += 1;
        }
        lastSpendBlock[c] = block.number;
    }
}
