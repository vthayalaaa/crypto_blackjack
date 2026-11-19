use anchor_lang::prelude::*;
use blackjack_logic::GAME_PAYLOAD;

// Borsh field order is the web decoder's layout. Sizes sum to GAME_PAYLOAD (1414):
// player 32, dealer 32, invite 32, stake 8, game_id 8, status 1, outcome 1,
// player_commits 512, dealer_commits 512, player_cards 11, player_len 1,
// dealer_cards 11, dealer_len 1, deck_mask 8, next_player_hit 1, deadline 8,
// created_at 8, bump 1, vault_bump 1, staged 224, staged_len 1.
#[account]
#[derive(InitSpace)]
pub struct Game {
    pub player: Pubkey,
    pub dealer: Pubkey,
    pub invite: Pubkey,
    pub stake: u64,
    pub game_id: u64,
    pub status: GameStatus,
    pub outcome: Outcome,
    pub player_commits: [[u8; 32]; 16],
    pub dealer_commits: [[u8; 32]; 16],
    pub player_cards: [u8; 11],
    pub player_len: u8,
    pub dealer_cards: [u8; 11],
    pub dealer_len: u8,
    pub deck_mask: u64,
    pub next_player_hit: u8,
    pub deadline: i64,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Dealer secrets already revealed and waiting for the player's matching secrets.
    /// Hit uses staged[0]. Showdown uses staged[0] as the hole and staged[1..7] as hits.
    pub staged: [[u8; 32]; 7],
    pub staged_len: u8,
}

impl Game {
    pub const SPACE: usize = 8 + GAME_PAYLOAD;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GameStatus {
    WaitingForOpponent,
    OpeningDealerReveal,
    OpeningPlayerReveal,
    PlayerTurn,
    HitDealerReveal,
    HitPlayerReveal,
    StandDealerReveal,
    StandPlayerReveal,
    Resolved,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    None,
    PlayerWins,
    DealerWins,
    Push,
}

#[error_code]
pub enum BlackjackError {
    #[msg("Stake must be between 0.01 and 50 SOL")]
    StakeOutOfRange,
    #[msg("This table is not open")]
    NotOpen,
    #[msg("You cannot join your own table")]
    SelfJoin,
    #[msg("This table is reserved for another wallet")]
    NotInvited,
    #[msg("The reveal does not match the committed secret")]
    BadReveal,
    #[msg("That action is not available in the current state")]
    BadState,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("No card slots left for that action")]
    NoCardsLeft,
    #[msg("The turn has not timed out yet")]
    TooEarly,
    #[msg("The shoe could not deal a card")]
    DeckEmpty,
}
