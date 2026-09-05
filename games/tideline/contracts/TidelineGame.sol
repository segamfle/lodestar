// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// The SDK interface is inlined rather than imported: the simulator's hot-reload compiler
// builds each dropped file standalone with no import resolution, and a single self-contained
// source is also easier for the jam to review. Kept byte-identical to
// `solidity/ICasinoGameV2.sol` in the SDK package — if that drifts, this must follow.

enum SessionPhase {
    NONE,
    WAITING_RANDOMNESS,
    WAITING_PLAYER_ACTION,
    SETTLED,
    FORFEITED,
    CANCELLED
}

struct SessionContext {
    uint256 sessionId;
    address player;
    address vault;
    uint256 wagerBase;
    uint256 escrowedStake;
    uint256 reservedProfit;
    uint32 step;
    bytes gameData;
    bytes gameState;
}

struct StepResult {
    bytes newGameState;
    int256 escrowDelta;
    int256 reservedProfitDelta;
    SessionPhase nextPhase;
    bool requestRandomnessNow;
    uint256 payout;
}

interface ICasinoGameV2 {
    function quoteCaps(
        uint256 wager,
        bytes calldata gameData
    ) external view returns (uint256 maxEscrowStake, uint256 maxReservedProfit);

    function quoteRiskParams(
        uint256 wager,
        bytes calldata gameData
    )
        external
        view
        returns (
            uint256 maxPayout,
            uint256 probabilityWad,
            uint256 expectedPayout,
            uint256 subJackpotVarianceScaled
        );

    function onSessionStart(
        SessionContext calldata ctx
    ) external view returns (StepResult memory);

    function onPlayerAction(
        SessionContext calldata ctx,
        bytes calldata actionData
    ) external view returns (StepResult memory);

    function onRandomness(
        SessionContext calldata ctx,
        bytes32 randomness
    ) external view returns (StepResult memory);

    function quoteForfeitPayout(SessionContext calldata ctx) external view returns (uint256 cashoutValue);
}

/// @title Tideline — a harbour ladder against a rising tide
/// @notice Six rungs stand above the waterline. The tide comes in to a level `L` drawn
///         uniformly from {0..6}. The player spreads a wager across any rungs before the
///         draw, and every rung the water reaches or covers pays out.
///
///         The payout condition is `L >= rung`, not `L == rung`, so outcomes nest instead
///         of competing: the lowest rung is a near-certainty at a thin multiplier, the top
///         rung is a long shot, and a spread across both is a genuine portfolio rather than
///         two unrelated bets.
///
/// @dev THE INVARIANT THIS CONTRACT EXISTS TO PROTECT:
///
///      Multipliers are defined as `m_i = RTP / P(L >= i)`. Expected return on a stake
///      placed at rung `i` is therefore
///
///          stake * m_i * P(L >= i) = stake * RTP
///
///      which is independent of `i`. Every rung returns exactly RTP per unit staked, so
///      every possible allocation of every possible size returns exactly RTP.
///
///      That is deliberate. The jam requires declared RTP to sit in 93-98% and to match the
///      actual paytable. Any game where player skill moves expected value has an RTP *range*
///      rather than an RTP, and a strong player pushing effective return past 98% would break
///      eligibility through no fault of the table. Here the player chooses the shape of their
///      variance and never touches the edge, so the declared number is exact under every
///      strategy and there is nothing for an optimizer to extract.
contract TidelineGame is ICasinoGameV2 {
    /// @dev Rungs above the waterline. Rung indices run 1..6; array slots run 0..5.
    ///      Array types below spell the size as a literal 6 because Solidity demands an
    ///      integer literal in a type position — if this constant changes, those change too.
    uint256 internal constant RUNGS = 6;

    /// @dev The tide level is uniform over {0,1,2,3,4,5,6} — seven outcomes, one of which
    ///      (level 0) leaves the whole ladder dry.
    uint256 internal constant LEVELS = RUNGS + 1;

    /// @dev Rejection threshold for an unbiased draw over `LEVELS` outcomes from one byte:
    ///      floor(256 / 7) * 7 = 252. Bytes at or above this are discarded rather than
    ///      folded back in, because 256 is not divisible by 7 and a raw modulo would make
    ///      levels 0-3 measurably more likely than 4-6.
    uint256 internal constant LEVEL_REJECT = 252;

    uint256 internal constant WAD = 1e18;

    /// @dev Return to player, 96%. Sits mid-band in the jam's required 93-98%.
    uint256 internal constant RTP_WAD = 0.96e18;

    error Tideline__NoPlayerAction();
    error Tideline__StakesMustSumToWager(uint256 provided, uint256 wager);
    error Tideline__EmptyLadder();

    /// @notice Payout multiplier for a rung, in WAD.
    /// @dev `m_i = RTP / P(L >= i)` where `P(L >= i) = (LEVELS - i) / LEVELS`, so
    ///      `m_i = RTP * LEVELS / (LEVELS - i)`. Computed rather than hardcoded so the
    ///      table can never drift out of step with the constants above — the paytable the
    ///      player sees and the math the house prices are the same expression.
    ///
    ///      At RTP 96% over seven levels this yields:
    ///        rung 1 → 1.12x   rung 2 → 1.344x   rung 3 → 1.68x
    ///        rung 4 → 2.24x   rung 5 → 3.36x    rung 6 → 6.72x
    function multiplierWad(uint256 rung) public pure returns (uint256) {
        return (RTP_WAD * LEVELS) / (LEVELS - rung);
    }

    /// @notice Total payout if the tide crowns the ladder — every rung pays at once.
    /// @dev This is the maximum over all levels because the payout set is monotone in `L`:
    ///      a higher tide pays a superset of the rungs a lower tide pays.
    function _maxPayout(uint256[6] memory stakes) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < RUNGS; ++i) {
            total += (stakes[i] * multiplierWad(i + 1)) / WAD;
        }
    }

    function _decodeAndValidate(
        bytes calldata gameData,
        uint256 wagerBase
    ) internal pure returns (uint256[6] memory stakes) {
        stakes = abi.decode(gameData, (uint256[6]));

        uint256 staked;
        for (uint256 i = 0; i < RUNGS; ++i) {
            staked += stakes[i];
        }
        if (staked == 0) revert Tideline__EmptyLadder();
        // The facet has already pulled exactly `wagerBase` from the player, so an allocation
        // that does not account for all of it would either strand funds or pay out money the
        // player never staked.
        if (staked != wagerBase) revert Tideline__StakesMustSumToWager(staked, wagerBase);
    }

    /// @inheritdoc ICasinoGameV2
    function quoteCaps(
        uint256 wager,
        bytes calldata gameData
    ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
        uint256[6] memory stakes = _decodeAndValidate(gameData, wager);
        uint256 maxPayout = _maxPayout(stakes);

        // Escrow never grows mid-session: there are no player actions to double down with.
        maxEscrowStake = wager;
        maxReservedProfit = maxPayout > wager ? maxPayout - wager : 0;
    }

    /// @inheritdoc ICasinoGameV2
    function quoteRiskParams(
        uint256 wager,
        bytes calldata gameData
    )
        external
        pure
        returns (
            uint256 maxPayout,
            uint256 probabilityWad,
            uint256 expectedPayout,
            uint256 subJackpotVarianceScaled
        )
    {
        uint256[6] memory stakes = _decodeAndValidate(gameData, wager);

        maxPayout = _maxPayout(stakes);

        // The facet's VaR model pairs `maxPayout` with the probability of reaching it, and
        // the full ladder only pays when the tide crowns rung 6 — one level in seven.
        probabilityWad = WAD / LEVELS;

        // Exact, not estimated: every rung returns RTP per unit staked, so the expectation
        // over the whole allocation collapses to RTP on the wager. See the class docs.
        expectedPayout = (wager * RTP_WAD) / WAD;

        // Top payout is 6.72x. The heavy-tail reserve path triggers above 100x, so this game
        // never reaches the jackpot machinery and has no sub-jackpot tier to strip.
        subJackpotVarianceScaled = 0;
    }

    /// @inheritdoc ICasinoGameV2
    function onSessionStart(
        SessionContext calldata ctx
    ) external pure returns (StepResult memory stepResult) {
        uint256[6] memory stakes = _decodeAndValidate(ctx.gameData, ctx.wagerBase);
        uint256 maxPayout = _maxPayout(stakes);

        // Carry the allocation forward so the guest can render the ladder from session state
        // alone after a mid-round refresh, without re-deriving it from gameData.
        stepResult.newGameState = abi.encode(stakes, uint256(0), false);
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0);
        stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        stepResult.requestRandomnessNow = true;
        stepResult.payout = 0;
    }

    /// @inheritdoc ICasinoGameV2
    function onPlayerAction(
        SessionContext calldata,
        bytes calldata
    ) external pure returns (StepResult memory) {
        // The entire decision is made before the draw. There is no mid-round move to make.
        revert Tideline__NoPlayerAction();
    }

    /// @inheritdoc ICasinoGameV2
    function onRandomness(
        SessionContext calldata ctx,
        bytes32 randomness
    ) external pure returns (StepResult memory stepResult) {
        uint256[6] memory stakes = _decodeAndValidate(ctx.gameData, ctx.wagerBase);
        uint256 level = _tideLevel(randomness);

        uint256 payout;
        for (uint256 i = 0; i < RUNGS; ++i) {
            // Rung `i + 1` is underwater when the tide reaches it or rises past it.
            if (i + 1 <= level) {
                payout += (stakes[i] * multiplierWad(i + 1)) / WAD;
            }
        }

        stepResult.newGameState = abi.encode(stakes, level, true);
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = 0;
        stepResult.nextPhase = SessionPhase.SETTLED;
        stepResult.requestRandomnessNow = false;
        stepResult.payout = payout;
    }

    /// @inheritdoc ICasinoGameV2
    function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
        // Nothing is cashable mid-round. The session only ever waits on randomness, never on
        // the player, and quoting a value against an unresolved draw would hand the vault an
        // adverse-selection loss.
        return 0;
    }

    /// @notice Draw the tide level, uniform over {0..6}, from VRF bytes.
    /// @dev Rejection sampling, per the SDK's randomness rules: a byte at or above 252 is
    ///      discarded and the cursor advances, because 256 is not a multiple of 7. When the
    ///      32-byte word is exhausted the seed is rehashed and the cursor resets — the
    ///      chance of needing that is (4/256)^32, but the loop must terminate for reasons
    ///      other than optimism.
    function _tideLevel(bytes32 randomness) internal pure returns (uint256) {
        bytes32 seed = randomness;
        uint256 idx;

        while (true) {
            if (idx < 32) {
                uint256 b = uint8(seed[idx]);
                unchecked {
                    ++idx;
                }
                if (b < LEVEL_REJECT) {
                    return b % LEVELS;
                }
                continue;
            }
            seed = keccak256(abi.encodePacked(seed));
            idx = 0;
        }

        // Unreachable: the loop above only exits by returning.
        revert();
    }
}
