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

/// @title Constellation — draw a shape on the sky and wait for the stars
/// @notice Twenty-five cells of dark sky. Before the draw the player marks a shape of three
///         to six cells anywhere on the grid. Seven stars then light at random, and the
///         player is paid on how many of their marks came alight.
///
///         Bigger shapes are easier to clip and harder to complete; small ones are the
///         reverse. Placing a shape is a spatial decision, and near-misses are legible at a
///         glance — four of five lit reads instantly as *almost*, which is the most
///         replayable feeling the form has.
///
/// @dev THE INVARIANT THIS CONTRACT EXISTS TO PROTECT:
///
///      Every shape size returns exactly the same 96%. The tables were not chosen by hand;
///      a weight profile set the shape of each size's curve and one scale factor per size was
///      solved to force the expectation onto RTP, so a player cannot improve their edge by
///      always picking one size. They choose the silhouette of their variance and nothing
///      else.
///
///      The jam requires declared RTP to sit in 93-98% and to match the actual paytable, and
///      a game where skill moves expected value has an RTP *range* rather than an RTP. A
///      strong player pushing effective return past 98% would fail eligibility through no
///      fault of the table.
///
///      The multipliers below are exact integers, not rounded floats. The lowest paying tier
///      of each size was solved in integer arithmetic to absorb the remainder left by the
///      others, which is why every size lands on 0.96 with zero wei of drift rather than
///      merely near it. See `games/constellation/emit-table.mjs`, which derives these values
///      and refuses to print them if the drift exceeds a wei.
contract ConstellationGame is ICasinoGameV2 {
    uint256 internal constant CELLS = 25;
    uint256 internal constant STARS = 7;

    uint256 internal constant MIN_SHAPE = 3;
    uint256 internal constant MAX_SHAPE = 6;

    /// @dev Every cell mask must fit inside 25 bits. Anything above is a malformed shape.
    uint256 internal constant BOARD_MASK = (1 << 25) - 1;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RTP_WAD = 0.96e18;

    /// @dev C(25,7) — the number of equally likely draws. Used to express probabilities
    ///      exactly rather than as decimals that would not add up.
    uint256 internal constant TOTAL_DRAWS = 480700;

    error Constellation__NoPlayerAction();
    error Constellation__ShapeOffBoard();
    error Constellation__ShapeWrongSize(uint256 size);

    /// @notice Payout multiplier in WAD for a shape of `size` cells with `hits` of them lit.
    /// @dev Derived by `games/constellation/emit-table.mjs`. Completion prizes are exact
    ///      whole numbers by choice; the lowest tier of each size carries the remainder so
    ///      the expectation is exact. Do not hand-edit these — regenerate them.
    function multiplierWad(uint256 size, uint256 hits) public pure returns (uint256) {
        if (size == 3) {
            // 15x on a full shape, once in 65.7 draws.
            if (hits == 3) return 15000000000000000000;
            if (hits == 2) return 4452380952380952380;
            return 0;
        }
        if (size == 4) {
            if (hits == 4) return 22000000000000000000;
            if (hits == 3) return 6927845000000000000;
            if (hits == 2) return 2181592794895736072;
            return 0;
        }
        if (size == 5) {
            if (hits == 5) return 32000000000000000000;
            if (hits == 4) return 15562364000000000000;
            if (hits == 3) return 7568349333333333333;
            return 0;
        }
        if (size == 6) {
            if (hits == 6) return 48000000000000000000;
            if (hits == 5) return 20894481000000000000;
            if (hits == 4) return 9095402000000000000;
            if (hits == 3) return 3959243994117647058;
            return 0;
        }
        return 0;
    }

    /// @notice How many of the possible draws light a whole shape of `size` cells.
    /// @dev C(25 - size, 7 - size): the remaining stars must fall on cells outside the shape.
    function _completionsFor(uint256 size) internal pure returns (uint256) {
        if (size == 3) return 7315; // C(22,4)
        if (size == 4) return 1330; // C(21,3)
        if (size == 5) return 190;  // C(20,2)
        if (size == 6) return 19;   // C(19,1)
        return 0;
    }

    function _popcount(uint256 value) internal pure returns (uint256 count) {
        // The board is 25 bits, so a plain loop is cheaper in gas than any bit-twiddling
        // trick would be, and far easier to read at three in the morning.
        while (value != 0) {
            value &= value - 1;
            unchecked {
                ++count;
            }
        }
    }

    function _decodeAndValidate(bytes calldata gameData) internal pure returns (uint256 shape, uint256 size) {
        shape = abi.decode(gameData, (uint256));
        if (shape & ~BOARD_MASK != 0) revert Constellation__ShapeOffBoard();
        size = _popcount(shape);
        if (size < MIN_SHAPE || size > MAX_SHAPE) revert Constellation__ShapeWrongSize(size);
    }

    /// @inheritdoc ICasinoGameV2
    function quoteCaps(
        uint256 wager,
        bytes calldata gameData
    ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
        (, uint256 size) = _decodeAndValidate(gameData);
        uint256 maxPayout = (wager * multiplierWad(size, size)) / WAD;

        // Escrow never grows mid-session: the whole decision is made before the draw.
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
        (, uint256 size) = _decodeAndValidate(gameData);

        maxPayout = (wager * multiplierWad(size, size)) / WAD;

        // The facet pairs maxPayout with the chance of reaching it, which here is the chance
        // the whole shape lights.
        probabilityWad = (_completionsFor(size) * WAD) / TOTAL_DRAWS;

        // Exact, not estimated: the tables are solved so every size returns RTP. See the
        // contract docs and emit-table.mjs.
        expectedPayout = (wager * RTP_WAD) / WAD;

        // Top payout is 48x. The heavy-tail reserve path engages above 100x, so this game
        // never reaches the jackpot machinery and has no sub-jackpot tier to strip.
        subJackpotVarianceScaled = 0;
    }

    /// @inheritdoc ICasinoGameV2
    function onSessionStart(
        SessionContext calldata ctx
    ) external pure returns (StepResult memory stepResult) {
        (uint256 shape, uint256 size) = _decodeAndValidate(ctx.gameData);
        uint256 maxPayout = (ctx.wagerBase * multiplierWad(size, size)) / WAD;

        // Carry the shape forward so the guest can redraw the board from session state alone
        // after a mid-round refresh, without re-deriving it from gameData.
        stepResult.newGameState = abi.encode(shape, uint256(0), uint256(0), false);
        stepResult.escrowDelta = 0;
        stepResult.reservedProfitDelta = int256(
            maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0
        );
        stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
        stepResult.requestRandomnessNow = true;
        stepResult.payout = 0;
    }

    /// @inheritdoc ICasinoGameV2
    function onPlayerAction(
        SessionContext calldata,
        bytes calldata
    ) external pure returns (StepResult memory) {
        // The shape is committed before the sky lights. There is no mid-round move to make.
        revert Constellation__NoPlayerAction();
    }

    /// @inheritdoc ICasinoGameV2
    function onRandomness(
        SessionContext calldata ctx,
        bytes32 randomness
    ) external pure returns (StepResult memory stepResult) {
        (uint256 shape, uint256 size) = _decodeAndValidate(ctx.gameData);

        uint256 lit = _drawStars(randomness);
        uint256 hits = _popcount(shape & lit);
        uint256 payout = (ctx.wagerBase * multiplierWad(size, hits)) / WAD;

        stepResult.newGameState = abi.encode(shape, lit, hits, true);
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

    /// @notice Light seven distinct cells, uniformly over all C(25,7) possible skies.
    /// @dev A partial Fisher-Yates over the 25 cells: for each of the seven picks, choose
    ///      uniformly from the cells not yet taken and swap it to the front. Sampling without
    ///      replacement this way is what makes every combination equally likely — drawing
    ///      seven independent cells and discarding collisions would bias nothing but waste
    ///      entropy, while drawing seven independent cells and *keeping* collisions would
    ///      silently light fewer than seven.
    ///
    ///      Each index comes from rejection sampling, per the SDK's randomness rules: for a
    ///      range of n the domain is cut to floor(256/n)*n and bytes at or above that are
    ///      discarded, because 256 is not a multiple of most n and a raw modulo would favour
    ///      the low cells.
    function _drawStars(bytes32 randomness) internal pure returns (uint256 lit) {
        uint8[25] memory cells;
        for (uint256 i = 0; i < CELLS; ++i) cells[i] = uint8(i);

        bytes32 seed = randomness;
        uint256 cursor = 0;

        for (uint256 picked = 0; picked < STARS; ++picked) {
            uint256 remaining = CELLS - picked;
            uint256 limit = (256 / remaining) * remaining;

            uint256 index;
            while (true) {
                if (cursor == 32) {
                    seed = keccak256(abi.encodePacked(seed));
                    cursor = 0;
                }
                uint256 b = uint8(seed[cursor]);
                unchecked {
                    ++cursor;
                }
                if (b < limit) {
                    index = picked + (b % remaining);
                    break;
                }
            }

            uint8 chosen = cells[index];
            cells[index] = cells[picked];
            cells[picked] = chosen;
            lit |= (1 << chosen);
        }
    }
}
