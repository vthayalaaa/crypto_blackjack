# Blackjack

Two wallets sit at one table on Solana devnet, Solana mainnet, Solana localnet, Ethereum Sepolia, or Ethereum mainnet. Each sends the same buy-in to a seat the server creates. They play one hand. The server pays the winner from those seats. A tie sends both buy-ins back. Mainnet moves real SOL or real ETH. Devnet, localnet, and Sepolia do not.

There is no dealer. Both players choose hit or stand. Each player sees only their own cards until both have finished. The higher total takes the pot. A bust loses to a finished hand, and two busts or two equal totals send both buy-ins back. A 21 is a 21 whether it took two cards or more.

## Where the secrets live

The shoe, the other player's cards, the undealt cards, and the seat private keys are stored on the server in `web/data/`, which is not committed. The browser receives the cards it is allowed to see and an httpOnly session cookie. It does not receive a private key or the rest of the deck.

You can invite a friend, or pick a buy-in and wait for another wallet that wants the same stake on the same network. The choices are 0.05, 0.1, 0.25, 0.5, 1, 5, 10, 20, 50, and 100. The lobby shows how many wallets are waiting and how many are at a table right now. Each wallet counts once. Leaving the table, or staying quiet for 20 seconds, drops that seat from the count. The hand itself stays until the usual timeout. The first person in line is player 1. The second is player 2. A wait expires after 15 minutes.

Before a wallet can join the line, sit, or be paid, the server checks it against the digital-currency addresses on the U.S. Treasury OFAC SDN list. It also reads that wallet's transaction history. Listed addresses are published for Ethereum mainnet and Solana mainnet, so every wallet is read against that history. A mainnet table also sends the buy-in and the payout on that network. A devnet, localnet, or Sepolia table does not. A listed address, or a transfer with one, is refused. If the list or the history cannot be loaded, the wallet is refused too. A history longer than 2,000 Solana signatures or 2,000 Ethereum transfers is refused when the check cannot finish it. A clear result only means that exact address is not published on the list and no listed address appeared in the history that was read.

Your own wallet key stays in Phantom, Solflare, MetaMask, or WalletConnect. The wallet only signs the buy-in transfer to the server seat. The server cannot see that key. The server can move the buy-in, because it holds the seat key. That is the tradeoff for dealing away from the browser. Choose the network before anyone sends a buy-in. Mainnet cannot be undone.

A player who stops acting for 10 minutes loses the pot. The other player can claim it.

## Program

`GtkZUSisZjxGFNamJTEEZNCndUaJX9sMSm6tTgu9yAsv`

Buy-in is 0.01 to 50 SOL per seat. The player also pays rent for the table account (about 0.015 SOL) and can reclaim it after the hand. Cancel is only available before the dealer sits, and it returns the buy-in and the rent.

| Instruction | Who signs | What it does |
| --- | --- | --- |
| `create_game` | Player | Opens the table, stores 16 commitments, deposits the buy-in |
| `join_game` | Dealer | Matches the buy-in and stores 16 commitments |
| `cancel_game` | Player | Refunds an empty table |
| `dealer_reveal_opening` / `player_reveal_opening` | Each seat | Deals two player cards and the dealer upcard |
| `hit` / `stand` | Player | Locks the decision |
| `dealer_reveal_hit` / `player_reveal_hit` | Each seat | Draws the locked hit. A bust pays the dealer |
| `dealer_reveal_showdown` / `player_reveal_showdown` | Each seat | Deals the hole card and plays the dealer to 17, then pays the vault |
| `claim_timeout` | The seat that is waiting | Takes the pot after 10 minutes of silence |
| `close_table` | Player | Reclaims table rent after settlement |

The dealer hole card is not written into the account until showdown, so the player sees one dealer upcard while they act.

This program has not been audited and is not what the running app uses to deal. The server deals the hand. Solana play stays on devnet and localnet. Ethereum play stays on Sepolia.

## Run the table

The web app needs Node.js 20 or newer.

```powershell
cd web
npm install
npm test
npm run dev
```

Open http://localhost:3000, set the wallet to Devnet, and use the airdrop button or [the public faucet](https://faucet.solana.com). Create a table in one browser profile and open the invite link in another.

The on-chain program has to be deployed before a hand can be funded. Building it needs Rust, the Solana CLI, and Anchor 1.2.2. On Windows, WSL is the reliable way to run `anchor build`.

```bash
cargo test -p blackjack-logic
cp programs/blackjack/blackjack-keypair.json target/deploy/blackjack-keypair.json
anchor build
anchor deploy
```

The keypair in `programs/blackjack/blackjack-keypair.json` is the program address, not a funded wallet. `declare_id!` in `programs/blackjack/src/lib.rs` matches it. A new keypair would deploy a different program, and the web app would not find the tables.

`NEXT_PUBLIC_RPC_URL` overrides the devnet RPC used by the app.

WalletConnect appears in the wallet list on devnet. Create a project at [cloud.walletconnect.com](https://cloud.walletconnect.com) and put the id in `web/.env.local`:

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
```

Restart `npm run dev` after saving that file. Localnet has no WalletConnect chain.

## Ethereum Sepolia

`contracts/Blackjack.sol` is the same hand: both seats commit 16 SHA-256 card secrets, the dealer stands on every 17, and the winner takes the pot. The app can connect MetaMask or WalletConnect and read a Sepolia balance before that contract is deployed. Creating a table needs the deployed address.

The network list sends nothing on Ethereum mainnet. A wallet on mainnet is asked to switch to Sepolia before a transaction. If it refuses, the request stops.

This repository does not deploy the contract. After you deploy `Blackjack.sol` to Sepolia yourself, add the address and restart the dev server:

```
NEXT_PUBLIC_ETH_BLACKJACK_ADDRESS=0x...
NEXT_PUBLIC_ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

Buy-in is 0.01 to 50 ETH per seat. There is no table rent. Cancel before the dealer sits and the buy-in comes back. Test ETH comes from a Sepolia faucet, such as [Alchemy's](https://www.alchemy.com/faucets/ethereum-sepolia). Open a Sepolia table at `http://localhost:3000/?chain=sepolia`.
