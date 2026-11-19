//! Two-player blackjack. Both wallets fund a system-owned vault PDA.
//! The winner is owed the whole vault. A tie owes each side half.
//!
//! Settlement never transfers to a seat that is not signing. It records what
//! each seat is owed, and each seat takes its share with `withdraw`, to any
//! account it chooses. A failed transfer cannot be caught on Solana: it reverts
//! the whole instruction. If settlement paid the other seat directly, that seat
//! could put its account in a state that refuses lamports and the hand could
//! never resolve.
//!
//! Neither player may choose the cards. Each seat posts 16 SHA-256
//! commitments before any secret is revealed. A card is
//! `SHA-256(player_seed || dealer_seed)` indexed into the cards still in the shoe.
//! The dealer half of a card is revealed only after the decision that card
//! belongs to is locked, so the player cannot hit or stand on a known next card.
//! Refusing to reveal after that loses the pot on timeout, which is never a
//! better result than playing the card.
//!
//! Index map for the 16 commitments:
//! 0 player, 1 dealer upcard, 2 player, 3 dealer hole,
//! 4..9 player hits, 10..15 dealer hits.
//! The dealer hand is played by the program: stand on every 17.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use blackjack_logic::{
    card_from_hash, compare, hand_total, is_natural, DEALER_HIT_SLOTS, DEALER_HIT_START,
    FULL_DECK_MASK, GAME_PAYLOAD, HOLE_INDEX, OPENING_CARDS, OUTCOME_DEALER, OUTCOME_PLAYER,
    OUTCOME_PUSH, PLAYER_HIT_SLOTS, PLAYER_HIT_START,
};
use solana_sha256_hasher::{hash, hashv};

pub mod state;

use state::*;

declare_id!("GtkZUSisZjxGFNamJTEEZNCndUaJX9sMSm6tTgu9yAsv");

const MIN_STAKE: u64 = 10_000_000;
const MAX_STAKE: u64 = 50_000_000_000;
const TURN_SECONDS: i64 = 600;

const _: () = assert!(Game::INIT_SPACE == GAME_PAYLOAD);

#[program]
pub mod blackjack {
    use super::*;
    use super::{
        clear_staged, credit, deal, hit_index, outcome_from, pay, push_card, refresh_deadline,
        transfer_sol, verify_seed, DEALER_HIT_START, MAX_STAKE, MIN_STAKE,
    };

    pub fn create_game(
        ctx: Context<CreateGame>,
        game_id: u64,
        stake: u64,
        invite: Pubkey,
        commits: [[u8; 32]; 16],
    ) -> Result<()> {
        require!(
            (MIN_STAKE..=MAX_STAKE).contains(&stake),
            BlackjackError::StakeOutOfRange
        );
        let game = &mut *ctx.accounts.game;
        game.player = ctx.accounts.player.key();
        game.dealer = Pubkey::default();
        game.invite = invite;
        game.stake = stake;
        game.game_id = game_id;
        game.status = GameStatus::WaitingForOpponent;
        game.outcome = Outcome::None;
        game.player_commits = commits;
        game.dealer_commits = [[0u8; 32]; 16];
        game.player_cards = [0u8; 11];
        game.player_len = 0;
        game.dealer_cards = [0u8; 11];
        game.dealer_len = 0;
        game.deck_mask = FULL_DECK_MASK;
        game.next_player_hit = 0;
        game.deadline = 0;
        game.created_at = Clock::get()?.unix_timestamp;
        game.bump = ctx.bumps.game;
        game.vault_bump = ctx.bumps.vault;
        game.staged = [[0u8; 32]; 7];
        game.staged_len = 0;
        game.player_owed = 0;
        game.dealer_owed = 0;

        transfer_sol(
            &ctx.accounts.system_program,
            &ctx.accounts.player,
            &ctx.accounts.vault,
            stake,
        )?;
        msg!("table opened");
        Ok(())
    }

    pub fn join_game(ctx: Context<JoinGame>, commits: [[u8; 32]; 16]) -> Result<()> {
        let dealer = ctx.accounts.dealer.key();
        let stake = {
            let game = &mut *ctx.accounts.game;
            require!(
                game.status == GameStatus::WaitingForOpponent,
                BlackjackError::NotOpen
            );
            require!(dealer != game.player, BlackjackError::SelfJoin);
            if game.invite != Pubkey::default() {
                require!(dealer == game.invite, BlackjackError::NotInvited);
            }
            game.dealer = dealer;
            game.dealer_commits = commits;
            game.status = GameStatus::OpeningDealerReveal;
            refresh_deadline(game)?;
            game.stake
        };
        transfer_sol(
            &ctx.accounts.system_program,
            &ctx.accounts.dealer,
            &ctx.accounts.vault,
            stake,
        )?;
        msg!("dealer seated");
        Ok(())
    }

    pub fn cancel_game(ctx: Context<CancelGame>) -> Result<()> {
        require!(
            ctx.accounts.game.status == GameStatus::WaitingForOpponent,
            BlackjackError::BadState
        );
        let pot = ctx.accounts.vault.lamports();
        pay(&ctx.accounts.game, &ctx.accounts.vault, &ctx.accounts.player, &ctx.accounts.system_program, pot)?;
        Ok(())
    }

    pub fn dealer_reveal_opening(ctx: Context<DealerMove>, seeds: [[u8; 32]; 3]) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(
            game.status == GameStatus::OpeningDealerReveal,
            BlackjackError::BadState
        );
        for i in 0..OPENING_CARDS {
            verify_seed(&seeds[i], &game.dealer_commits[i])?;
            game.staged[i] = seeds[i];
        }
        game.staged_len = OPENING_CARDS as u8;
        game.status = GameStatus::OpeningPlayerReveal;
        refresh_deadline(game)
    }

    pub fn player_reveal_opening(ctx: Context<PlayerMove>, seeds: [[u8; 32]; 3]) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(
            game.status == GameStatus::OpeningPlayerReveal,
            BlackjackError::BadState
        );
        require!(game.staged_len == OPENING_CARDS as u8, BlackjackError::BadState);
        for i in 0..OPENING_CARDS {
            verify_seed(&seeds[i], &game.player_commits[i])?;
            let card = deal(&mut game.deck_mask, &seeds[i], &game.staged[i])?;
            if i == 1 {
                push_card(&mut game.dealer_cards, &mut game.dealer_len, card)?;
            } else {
                push_card(&mut game.player_cards, &mut game.player_len, card)?;
            }
        }
        clear_staged(game);
        let natural = is_natural(&game.player_cards[..game.player_len as usize]);
        game.status = if natural {
            GameStatus::StandDealerReveal
        } else {
            GameStatus::PlayerTurn
        };
        refresh_deadline(game)
    }

    pub fn hit(ctx: Context<PlayerMove>) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(game.status == GameStatus::PlayerTurn, BlackjackError::BadState);
        require!(
            game.next_player_hit < PLAYER_HIT_SLOTS as u8,
            BlackjackError::NoCardsLeft
        );
        let total = hand_total(&game.player_cards[..game.player_len as usize]);
        require!(total < 21, BlackjackError::BadState);
        game.status = GameStatus::HitDealerReveal;
        refresh_deadline(game)
    }

    pub fn stand(ctx: Context<PlayerMove>) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(game.status == GameStatus::PlayerTurn, BlackjackError::BadState);
        game.status = GameStatus::StandDealerReveal;
        refresh_deadline(game)
    }

    pub fn dealer_reveal_hit(ctx: Context<DealerMove>, seed: [u8; 32]) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(
            game.status == GameStatus::HitDealerReveal,
            BlackjackError::BadState
        );
        let index = hit_index(game)?;
        verify_seed(&seed, &game.dealer_commits[index])?;
        game.staged[0] = seed;
        game.staged_len = 1;
        game.status = GameStatus::HitPlayerReveal;
        refresh_deadline(game)
    }

    pub fn player_reveal_hit(ctx: Context<PlayerMove>, seed: [u8; 32]) -> Result<()> {
        let pot = ctx.accounts.vault.lamports();
        let busted = {
            let game = &mut *ctx.accounts.game;
            require!(
                game.status == GameStatus::HitPlayerReveal,
                BlackjackError::BadState
            );
            require!(game.staged_len == 1, BlackjackError::BadState);
            let index = hit_index(game)?;
            verify_seed(&seed, &game.player_commits[index])?;
            let dealer_seed = game.staged[0];
            let card = deal(&mut game.deck_mask, &seed, &dealer_seed)?;
            push_card(&mut game.player_cards, &mut game.player_len, card)?;
            game.next_player_hit = game
                .next_player_hit
                .checked_add(1)
                .ok_or(BlackjackError::NoCardsLeft)?;
            clear_staged(game);
            let total = hand_total(&game.player_cards[..game.player_len as usize]);
            if total > 21 {
                game.outcome = Outcome::DealerWins;
                game.status = GameStatus::Resolved;
                credit(game, pot)?;
                true
            } else if total == 21 {
                game.status = GameStatus::StandDealerReveal;
                refresh_deadline(game)?;
                false
            } else {
                game.status = GameStatus::PlayerTurn;
                refresh_deadline(game)?;
                false
            }
        };
        if busted {
            msg!("player busts");
        }
        Ok(())
    }

    pub fn dealer_reveal_showdown(
        ctx: Context<DealerMove>,
        hole: [u8; 32],
        hits: [[u8; 32]; 6],
    ) -> Result<()> {
        let game = &mut *ctx.accounts.game;
        require!(
            game.status == GameStatus::StandDealerReveal,
            BlackjackError::BadState
        );
        verify_seed(&hole, &game.dealer_commits[HOLE_INDEX])?;
        for i in 0..DEALER_HIT_SLOTS {
            verify_seed(&hits[i], &game.dealer_commits[DEALER_HIT_START + i])?;
        }
        game.staged[0] = hole;
        game.staged[1..7].copy_from_slice(&hits);
        game.staged_len = 7;
        game.status = GameStatus::StandPlayerReveal;
        refresh_deadline(game)
    }

    pub fn player_reveal_showdown(
        ctx: Context<PlayerMove>,
        hole: [u8; 32],
        hits: [[u8; 32]; 6],
    ) -> Result<()> {
        let pot = ctx.accounts.vault.lamports();
        {
            let game = &mut *ctx.accounts.game;
            require!(
                game.status == GameStatus::StandPlayerReveal,
                BlackjackError::BadState
            );
            require!(game.staged_len == 7, BlackjackError::BadState);
            verify_seed(&hole, &game.player_commits[HOLE_INDEX])?;
            for i in 0..DEALER_HIT_SLOTS {
                verify_seed(&hits[i], &game.player_commits[DEALER_HIT_START + i])?;
            }
            let staged = game.staged;
            let hole_card = deal(&mut game.deck_mask, &hole, &staged[0])?;
            push_card(&mut game.dealer_cards, &mut game.dealer_len, hole_card)?;
            let mut drawn = 0usize;
            while hand_total(&game.dealer_cards[..game.dealer_len as usize]) < 17
                && drawn < DEALER_HIT_SLOTS
            {
                let card = deal(&mut game.deck_mask, &hits[drawn], &staged[drawn + 1])?;
                push_card(&mut game.dealer_cards, &mut game.dealer_len, card)?;
                drawn += 1;
            }
            let player_total = hand_total(&game.player_cards[..game.player_len as usize]);
            let dealer_total = hand_total(&game.dealer_cards[..game.dealer_len as usize]);
            let code = compare(player_total, dealer_total);
            game.outcome = outcome_from(code);
            game.status = GameStatus::Resolved;
            clear_staged(game);
            credit(game, pot)?;
            msg!("settled {} {}", player_total, dealer_total);
        }
        Ok(())
    }

    /// Take this seat's share of a resolved hand. The signer picks where it goes,
    /// so a seat whose own wallet cannot receive lamports can still be paid.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let claimant = ctx.accounts.claimant.key();
        let destination = ctx.accounts.destination.key();
        require!(
            destination != ctx.accounts.vault.key() && destination != ctx.accounts.game.key(),
            BlackjackError::BadDestination
        );
        let amount = {
            let game = &mut *ctx.accounts.game;
            require!(game.status == GameStatus::Resolved, BlackjackError::BadState);
            let owed = if claimant == game.player {
                &mut game.player_owed
            } else if claimant == game.dealer {
                &mut game.dealer_owed
            } else {
                return err!(BlackjackError::NotYourTurn);
            };
            let amount = *owed;
            require!(amount > 0, BlackjackError::NothingOwed);
            *owed = 0;
            amount
        };
        pay(
            &ctx.accounts.game,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.system_program,
            amount,
        )?;
        msg!("withdrew {}", amount);
        Ok(())
    }

    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let claimant = ctx.accounts.claimant.key();
        let player_collects = {
            let game = &mut *ctx.accounts.game;
            require!(
                !matches!(
                    game.status,
                    GameStatus::WaitingForOpponent | GameStatus::Resolved
                ),
                BlackjackError::BadState
            );
            let now = Clock::get()?.unix_timestamp;
            require!(game.deadline != 0 && now >= game.deadline, BlackjackError::TooEarly);
            let player_collects = matches!(
                game.status,
                GameStatus::OpeningDealerReveal
                    | GameStatus::HitDealerReveal
                    | GameStatus::StandDealerReveal
            );
            if player_collects {
                require!(claimant == game.player, BlackjackError::NotYourTurn);
                game.outcome = Outcome::PlayerWins;
            } else {
                require!(claimant == game.dealer, BlackjackError::NotYourTurn);
                game.outcome = Outcome::DealerWins;
            }
            game.status = GameStatus::Resolved;
            player_collects
        };
        let pot = ctx.accounts.vault.lamports();
        pay(
            &ctx.accounts.game,
            &ctx.accounts.vault,
            &ctx.accounts.claimant,
            &ctx.accounts.system_program,
            pot,
        )?;
        msg!("timeout claimed {}", if player_collects { "player" } else { "dealer" });
        Ok(())
    }

    pub fn close_table(ctx: Context<CloseTable>) -> Result<()> {
        require!(
            ctx.accounts.game.status == GameStatus::Resolved,
            BlackjackError::BadState
        );
        // Closing erases the record of what the dealer is owed, and the dust sweep
        // below would hand the dealer's share to the player.
        require!(
            ctx.accounts.game.player_owed == 0 && ctx.accounts.game.dealer_owed == 0,
            BlackjackError::StillOwed
        );
        let dust = ctx.accounts.vault.lamports();
        if dust > 0 {
            pay(
                &ctx.accounts.game,
                &ctx.accounts.vault,
                &ctx.accounts.player,
                &ctx.accounts.system_program,
                dust,
            )?;
        }
        Ok(())
    }
}

fn outcome_from(code: u8) -> Outcome {
    match code {
        OUTCOME_PLAYER => Outcome::PlayerWins,
        OUTCOME_DEALER => Outcome::DealerWins,
        OUTCOME_PUSH => Outcome::Push,
        _ => Outcome::None,
    }
}

fn verify_seed(seed: &[u8; 32], commit: &[u8; 32]) -> Result<()> {
    let got = hash(seed).to_bytes();
    require!(got == *commit, BlackjackError::BadReveal);
    Ok(())
}

fn deal(mask: &mut u64, player_seed: &[u8; 32], dealer_seed: &[u8; 32]) -> Result<u8> {
    let mixed = hashv(&[player_seed.as_slice(), dealer_seed.as_slice()]).to_bytes();
    card_from_hash(mask, &mixed).ok_or_else(|| error!(BlackjackError::DeckEmpty))
}

fn push_card(cards: &mut [u8; 11], len: &mut u8, card: u8) -> Result<()> {
    let index = *len as usize;
    require!(index < cards.len(), BlackjackError::NoCardsLeft);
    cards[index] = card;
    *len += 1;
    Ok(())
}

fn hit_index(game: &Game) -> Result<usize> {
    let index = PLAYER_HIT_START + game.next_player_hit as usize;
    require!(
        game.next_player_hit < PLAYER_HIT_SLOTS as u8,
        BlackjackError::NoCardsLeft
    );
    Ok(index)
}

fn clear_staged(game: &mut Game) {
    game.staged = [[0u8; 32]; 7];
    game.staged_len = 0;
}

fn refresh_deadline(game: &mut Game) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    game.deadline = now.saturating_add(TURN_SECONDS);
    Ok(())
}

fn transfer_sol<'info>(
    system_program: &Program<'info, System>,
    from: &Signer<'info>,
    to: &SystemAccount<'info>,
    amount: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
            },
        ),
        amount,
    )
}

fn pay<'info>(
    game: &Account<'info, Game>,
    vault: &SystemAccount<'info>,
    to: &impl ToAccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(amount <= vault.lamports(), BlackjackError::BadState);
    let key = game.key();
    let bump = [game.vault_bump];
    let seeds: &[&[u8]] = &[b"vault", key.as_ref(), &bump];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Record who is owed the vault. Nothing moves until a seat calls `withdraw`.
fn credit(game: &mut Game, pot: u64) -> Result<()> {
    let (player, dealer) = shares(game.outcome, pot).ok_or(BlackjackError::BadState)?;
    game.player_owed = player;
    game.dealer_owed = dealer;
    Ok(())
}

/// (player, dealer). A push gives the odd lamport to the dealer, as before.
fn shares(outcome: Outcome, pot: u64) -> Option<(u64, u64)> {
    match outcome {
        Outcome::PlayerWins => Some((pot, 0)),
        Outcome::DealerWins => Some((0, pot)),
        Outcome::Push => {
            let half = pot / 2;
            Some((half, pot - half))
        }
        Outcome::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_always_add_up_to_the_pot() {
        for pot in [0u64, 1, 20_000_000, 20_000_001, u64::MAX] {
            for outcome in [Outcome::PlayerWins, Outcome::DealerWins, Outcome::Push] {
                let (player, dealer) = shares(outcome, pot).unwrap();
                assert_eq!(u128::from(player) + u128::from(dealer), u128::from(pot));
            }
        }
        assert_eq!(shares(Outcome::Push, 21), Some((10, 11)));
        assert_eq!(shares(Outcome::PlayerWins, 40), Some((40, 0)));
        assert_eq!(shares(Outcome::DealerWins, 40), Some((0, 40)));
        assert_eq!(shares(Outcome::None, 40), None);
    }
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        init,
        payer = player,
        space = Game::SPACE,
        seeds = [b"game", player.key().as_ref(), &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub dealer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelGame<'info> {
    #[account(mut, address = game.player)]
    pub player: Signer<'info>,
    #[account(
        mut,
        close = player,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlayerMove<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: Pinned to the dealer stored in the game. Nothing reads or pays it
    /// here. It stays in the list so clients keep the same account order. It must
    /// not be a `SystemAccount`: the dealer could assign their wallet to another
    /// program, every player move would then fail the owner check, and the dealer
    /// would collect the pot on the timeout.
    #[account(address = game.dealer)]
    pub dealer: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = player,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DealerMove<'info> {
    /// CHECK: Pinned to the player stored in the game. Never paid here. Not a
    /// `SystemAccount`, for the same reason as the dealer in `PlayerMove`.
    #[account(address = game.player)]
    pub player: UncheckedAccount<'info>,
    #[account(mut)]
    pub dealer: Signer<'info>,
    #[account(
        mut,
        has_one = dealer,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub claimant: Signer<'info>,
    /// CHECK: Any account the claimant chooses to be paid into. It is only
    /// credited. The instruction refuses the table and its vault.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseTable<'info> {
    #[account(mut, address = game.player)]
    pub player: Signer<'info>,
    #[account(
        mut,
        close = player,
        seeds = [b"game", game.player.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump = game.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
