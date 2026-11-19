// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Two-player blackjack escrow.
/// @notice Same hand as the Solana program. Both seats deposit the same buy-in.
/// Cards are SHA-256 commitments. The dealer stands on every 17. The winner
/// takes the pot. A tie returns both buy-ins. There is no mainnet deployment
/// in this repository. Deploy this only on Sepolia or a local chain.
contract Blackjack {
    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant MAX_STAKE = 50 ether;
    uint256 public constant TURN_SECONDS = 600;
    uint8 public constant CARD_SLOTS = 16;

    uint256 public nextId = 1;
    uint256 private locked;

    struct Game {
        address player;
        address dealer;
        address invite;
        uint256 stake;
        uint8 status;
        uint8 outcome;
        bytes32[16] playerCommits;
        bytes32[16] dealerCommits;
        uint8[11] playerCards;
        uint8 playerLen;
        uint8[11] dealerCards;
        uint8 dealerLen;
        uint64 deckMask;
        uint8 nextPlayerHit;
        uint64 deadline;
        bytes32[7] staged;
        uint8 stagedLen;
    }

    mapping(uint256 => Game) private games;
    mapping(uint256 => uint256) public pots;
    /// @notice Payouts that could not be delivered, waiting for `withdraw`.
    mapping(address => uint256) public owed;

    uint256 private constant PAY_GAS = 30_000;

    event PayoutHeld(address indexed to, uint256 amount);
    event TableCreated(uint256 indexed id, address indexed player);
    event TableUpdated(uint256 indexed id);

    modifier lock() {
        require(locked == 0, "locked");
        locked = 1;
        _;
        locked = 0;
    }

    function createGame(uint256 stake, address invite, bytes32[16] calldata commits)
        external
        payable
        lock
        returns (uint256 id)
    {
        require(stake >= MIN_STAKE && stake <= MAX_STAKE, "stake");
        require(msg.value == stake, "value");
        id = nextId;
        nextId = id + 1;
        Game storage game = games[id];
        game.player = msg.sender;
        game.invite = invite;
        game.stake = stake;
        game.playerCommits = commits;
        game.deckMask = uint64((uint256(1) << 52) - 1);
        pots[id] = msg.value;
        emit TableCreated(id, msg.sender);
        emit TableUpdated(id);
    }

    function joinGame(uint256 id, bytes32[16] calldata commits) external payable lock {
        Game storage game = games[id];
        require(game.player != address(0) && game.status == 0, "state");
        require(msg.sender != game.player, "self");
        if (game.invite != address(0)) require(msg.sender == game.invite, "invite");
        require(msg.value == game.stake, "value");
        game.dealer = msg.sender;
        game.dealerCommits = commits;
        game.status = 1;
        touch(game);
        pots[id] += msg.value;
        emit TableUpdated(id);
    }

    function cancelGame(uint256 id) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 0, "state");
        uint256 pot = pots[id];
        pots[id] = 0;
        delete games[id];
        pay(msg.sender, pot);
        emit TableUpdated(id);
    }

    function dealerRevealOpening(uint256 id, bytes32[3] calldata seeds) external lock {
        Game storage game = games[id];
        require(msg.sender == game.dealer && game.status == 1, "state");
        for (uint256 i = 0; i < 3; i++) {
            verify(seeds[i], game.dealerCommits[i]);
            game.staged[i] = seeds[i];
        }
        game.stagedLen = 3;
        game.status = 2;
        touch(game);
        emit TableUpdated(id);
    }

    function playerRevealOpening(uint256 id, bytes32[3] calldata seeds) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 2 && game.stagedLen == 3, "state");
        for (uint256 i = 0; i < 3; i++) {
            verify(seeds[i], game.playerCommits[i]);
            uint8 card = take(game, seeds[i], game.staged[i]);
            if (i == 1) game.dealerLen = push(game.dealerCards, game.dealerLen, card);
            else game.playerLen = push(game.playerCards, game.playerLen, card);
        }
        clearStaged(game);
        game.status = natural(game.playerCards, game.playerLen) ? 6 : 3;
        touch(game);
        emit TableUpdated(id);
    }

    function hit(uint256 id) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 3, "state");
        require(game.nextPlayerHit < 6, "no cards");
        require(total(game.playerCards, game.playerLen) < 21, "state");
        game.status = 4;
        touch(game);
        emit TableUpdated(id);
    }

    function stand(uint256 id) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 3, "state");
        game.status = 6;
        touch(game);
        emit TableUpdated(id);
    }

    function dealerRevealHit(uint256 id, bytes32 seed) external lock {
        Game storage game = games[id];
        require(msg.sender == game.dealer && game.status == 4, "state");
        uint256 index = hitIndex(game);
        verify(seed, game.dealerCommits[index]);
        game.staged[0] = seed;
        game.stagedLen = 1;
        game.status = 5;
        touch(game);
        emit TableUpdated(id);
    }

    function playerRevealHit(uint256 id, bytes32 seed) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 5 && game.stagedLen == 1, "state");
        uint256 index = hitIndex(game);
        verify(seed, game.playerCommits[index]);
        uint8 card = take(game, seed, game.staged[0]);
        game.playerLen = push(game.playerCards, game.playerLen, card);
        game.nextPlayerHit += 1;
        clearStaged(game);
        uint8 hand = total(game.playerCards, game.playerLen);
        if (hand > 21) {
            game.outcome = 2;
            game.status = 8;
            uint256 pot = pots[id];
            pots[id] = 0;
            pay(game.dealer, pot);
        } else {
            game.status = hand == 21 ? 6 : 3;
            touch(game);
        }
        emit TableUpdated(id);
    }

    function dealerRevealShowdown(uint256 id, bytes32 hole, bytes32[6] calldata hits) external lock {
        Game storage game = games[id];
        require(msg.sender == game.dealer && game.status == 6, "state");
        verify(hole, game.dealerCommits[3]);
        for (uint256 i = 0; i < 6; i++) verify(hits[i], game.dealerCommits[10 + i]);
        game.staged[0] = hole;
        for (uint256 i = 0; i < 6; i++) game.staged[i + 1] = hits[i];
        game.stagedLen = 7;
        game.status = 7;
        touch(game);
        emit TableUpdated(id);
    }

    function playerRevealShowdown(uint256 id, bytes32 hole, bytes32[6] calldata hits) external lock {
        Game storage game = games[id];
        require(msg.sender == game.player && game.status == 7 && game.stagedLen == 7, "state");
        verify(hole, game.playerCommits[3]);
        for (uint256 i = 0; i < 6; i++) verify(hits[i], game.playerCommits[10 + i]);
        uint8 holeCard = take(game, hole, game.staged[0]);
        game.dealerLen = push(game.dealerCards, game.dealerLen, holeCard);
        uint256 drawn = 0;
        while (total(game.dealerCards, game.dealerLen) < 17 && drawn < 6) {
            uint8 card = take(game, hits[drawn], game.staged[drawn + 1]);
            game.dealerLen = push(game.dealerCards, game.dealerLen, card);
            drawn += 1;
        }
        uint8 playerTotal = total(game.playerCards, game.playerLen);
        uint8 dealerTotal = total(game.dealerCards, game.dealerLen);
        uint8 outcome = playerTotal > 21 ? 2 : dealerTotal > 21 ? 1 : playerTotal > dealerTotal ? 1 : dealerTotal > playerTotal ? 2 : 3;
        game.outcome = outcome;
        game.status = 8;
        clearStaged(game);
        settle(id, game.player, game.dealer, outcome);
        emit TableUpdated(id);
    }

    function claimTimeout(uint256 id) external lock {
        Game storage game = games[id];
        require(game.status != 0 && game.status != 8, "state");
        require(game.deadline != 0 && block.timestamp >= game.deadline, "early");
        bool playerCollects = game.status == 1 || game.status == 4 || game.status == 6;
        if (playerCollects) {
            require(msg.sender == game.player, "turn");
            game.outcome = 1;
        } else {
            require(msg.sender == game.dealer, "turn");
            game.outcome = 2;
        }
        game.status = 8;
        uint256 pot = pots[id];
        pots[id] = 0;
        pay(msg.sender, pot);
        emit TableUpdated(id);
    }

    function getTable(uint256 id)
        external
        view
        returns (
            address player,
            address dealer,
            address invite,
            uint256 stake,
            uint8 status,
            uint8 outcome,
            uint8 playerLen,
            uint8 dealerLen,
            uint8 nextPlayerHit,
            uint64 deadline,
            uint256 pot,
            uint8[11] memory playerCards,
            uint8[11] memory dealerCards
        )
    {
        Game storage game = games[id];
        player = game.player;
        dealer = game.dealer;
        invite = game.invite;
        stake = game.stake;
        status = game.status;
        outcome = game.outcome;
        playerLen = game.playerLen;
        dealerLen = game.dealerLen;
        nextPlayerHit = game.nextPlayerHit;
        deadline = game.deadline;
        pot = pots[id];
        playerCards = game.playerCards;
        dealerCards = game.dealerCards;
    }

    function verify(bytes32 seed, bytes32 commit) private pure {
        require(sha256(abi.encodePacked(seed)) == commit, "reveal");
    }

    function take(Game storage game, bytes32 playerSeed, bytes32 dealerSeed) private returns (uint8 card) {
        bytes32 mixed = sha256(abi.encodePacked(playerSeed, dealerSeed));
        uint256 remaining = 0;
        for (uint256 i = 0; i < 52; i++) {
            if ((game.deckMask & (uint64(1) << i)) != 0) remaining += 1;
        }
        require(remaining > 0, "deck");
        uint256 pick = uint256(le64(mixed)) % remaining;
        for (uint256 i = 0; i < 52; i++) {
            if ((game.deckMask & (uint64(1) << i)) != 0) {
                if (pick == 0) {
                    game.deckMask &= ~(uint64(1) << i);
                    return uint8(i);
                }
                pick -= 1;
            }
        }
        revert("deck");
    }

    function le64(bytes32 mixed) private pure returns (uint64 value) {
        for (uint256 i = 0; i < 8; i++) value |= uint64(uint8(mixed[i])) << (8 * i);
    }

    function push(uint8[11] storage cards, uint8 len, uint8 card) private returns (uint8) {
        require(len < 11, "no cards");
        cards[len] = card;
        return len + 1;
    }

    function hitIndex(Game storage game) private view returns (uint256) {
        require(game.nextPlayerHit < 6, "no cards");
        return 4 + uint256(game.nextPlayerHit);
    }

    function total(uint8[11] storage cards, uint8 len) private view returns (uint8) {
        uint256 sum = 0;
        uint256 aces = 0;
        for (uint256 i = 0; i < len; i++) {
            uint256 rank = uint256(cards[i]) % 13;
            if (rank == 0) {
                aces += 1;
                sum += 11;
            } else if (rank >= 9) {
                sum += 10;
            } else {
                sum += rank + 1;
            }
        }
        while (sum > 21 && aces > 0) {
            sum -= 10;
            aces -= 1;
        }
        return uint8(sum);
    }

    function natural(uint8[11] storage cards, uint8 len) private view returns (bool) {
        return len == 2 && total(cards, len) == 21;
    }

    function clearStaged(Game storage game) private {
        delete game.staged;
        game.stagedLen = 0;
    }

    function touch(Game storage game) private {
        game.deadline = uint64(block.timestamp + TURN_SECONDS);
    }

    function settle(uint256 id, address player, address dealer, uint8 outcome) private {
        uint256 pot = pots[id];
        if (outcome == 1) {
            pots[id] = 0;
            pay(player, pot);
        } else if (outcome == 2) {
            pots[id] = 0;
            pay(dealer, pot);
        } else if (outcome == 3) {
            uint256 half = pot / 2;
            pots[id] = pot - half;
            pay(player, half);
            uint256 rest = pots[id];
            pots[id] = 0;
            pay(dealer, rest);
        } else {
            revert("outcome");
        }
    }

    /// @dev A payout must never be able to undo the move that earned it. The
    /// receiver gets a fixed amount of gas, and a transfer that fails is kept
    /// in `owed` for `withdraw` instead of reverting. Otherwise a dealer
    /// contract could refuse a push, let the player time out, and claim the pot.
    function pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: PAY_GAS}("");
        if (!ok) {
            owed[to] += amount;
            emit PayoutHeld(to, amount);
        }
    }

    /// @notice Collect a payout that could not be delivered when the hand settled.
    function withdraw() external lock {
        uint256 amount = owed[msg.sender];
        require(amount > 0, "nothing");
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }
}
