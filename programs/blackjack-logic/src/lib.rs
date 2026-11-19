//! Blackjack totals, deck indexing, and the account byte layout.
//!
//! The Solana program owns commitments, vault transfers, and turn order.
//! This crate stays free of Anchor so the rules can be tested with `cargo test`.

/// 16 precommitted secrets per player.
/// 0 player, 1 dealer upcard, 2 player, 3 dealer hole,
/// 4..10 player hits, 10..16 dealer hits.
pub const CARD_SLOTS: usize = 16;
pub const OPENING_CARDS: usize = 3;
pub const HOLE_INDEX: usize = 3;
pub const PLAYER_HIT_START: usize = 4;
pub const PLAYER_HIT_SLOTS: usize = 6;
pub const DEALER_HIT_START: usize = 10;
pub const DEALER_HIT_SLOTS: usize = 6;
pub const MAX_HAND: usize = 11;

pub const OUTCOME_NONE: u8 = 0;
pub const OUTCOME_PLAYER: u8 = 1;
pub const OUTCOME_DEALER: u8 = 2;
pub const OUTCOME_PUSH: u8 = 3;

/// Low 52 bits set. Bit `n` means card `n` is still in the shoe.
pub const FULL_DECK_MASK: u64 = (1u64 << 52) - 1;

/// Borsh payload of the on-chain `Game` account, excluding the 8-byte discriminator.
/// Field order is the source of truth for `web/lib/layout.ts`.
pub const GAME_PAYLOAD: usize = 1430;

pub fn hand_total(cards: &[u8]) -> u8 {
    let mut total: u16 = 0;
    let mut aces: u16 = 0;
    for &card in cards {
        let rank = card % 13;
        if rank == 0 {
            aces += 1;
            total += 11;
        } else if rank >= 9 {
            total += 10;
        } else {
            total += u16::from(rank) + 1;
        }
    }
    while total > 21 && aces > 0 {
        total -= 10;
        aces -= 1;
    }
    total as u8
}

pub fn is_natural(cards: &[u8]) -> bool {
    cards.len() == 2 && hand_total(cards) == 21
}

pub fn is_bust(cards: &[u8]) -> bool {
    hand_total(cards) > 21
}

/// Remove one card from `mask`. `hash` is SHA-256(player_seed || dealer_seed).
/// The pick is `u64le(hash[0..8]) % cards_remaining`, walking set bits in order.
pub fn card_from_hash(mask: &mut u64, hash: &[u8; 32]) -> Option<u8> {
    let remaining = mask.count_ones();
    if remaining == 0 {
        return None;
    }
    let n = u64::from_le_bytes(hash[0..8].try_into().ok()?);
    let mut pick = n % u64::from(remaining);
    for card in 0..52u8 {
        if *mask & (1u64 << card) != 0 {
            if pick == 0 {
                *mask &= !(1u64 << card);
                return Some(card);
            }
            pick -= 1;
        }
    }
    None
}

pub fn compare(player: u8, dealer: u8) -> u8 {
    if player > 21 {
        OUTCOME_DEALER
    } else if dealer > 21 {
        OUTCOME_PLAYER
    } else if player > dealer {
        OUTCOME_PLAYER
    } else if dealer > player {
        OUTCOME_DEALER
    } else {
        OUTCOME_PUSH
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_follow_blackjack_rules() {
        // Ace + King
        assert_eq!(hand_total(&[0, 12]), 21);
        assert!(is_natural(&[0, 12]));
        // Ace + Ace + 9 = 21
        assert_eq!(hand_total(&[0, 13, 8]), 21);
        assert!(!is_natural(&[0, 13, 8]));
        // Three aces + 9 = 12
        assert_eq!(hand_total(&[0, 13, 26, 8]), 12);
        // King + Queen
        assert_eq!(hand_total(&[12, 11]), 20);
        // 10 + 6 + 7 busts
        assert_eq!(hand_total(&[9, 5, 6]), 23);
        assert!(is_bust(&[9, 5, 6]));
        // 5 + Ace is a soft 16
        assert_eq!(hand_total(&[4, 0]), 16);
        // 9 + Ace + Ace = 21
        assert_eq!(hand_total(&[8, 0, 13]), 21);
    }

    #[test]
    fn compare_pays_the_better_hand() {
        assert_eq!(compare(21, 20), OUTCOME_PLAYER);
        assert_eq!(compare(18, 19), OUTCOME_DEALER);
        assert_eq!(compare(20, 20), OUTCOME_PUSH);
        assert_eq!(compare(22, 17), OUTCOME_DEALER);
        assert_eq!(compare(19, 22), OUTCOME_PLAYER);
    }

    #[test]
    fn draw_removes_unique_cards_until_the_shoe_is_empty() {
        let mut mask = FULL_DECK_MASK;
        let mut seen = [false; 52];
        for i in 0..52u8 {
            let mut hash = [0u8; 32];
            hash[0] = i.wrapping_mul(3);
            hash[1] = 9;
            let card = card_from_hash(&mut mask, &hash).unwrap();
            assert!(!seen[card as usize], "duplicate card {card}");
            seen[card as usize] = true;
        }
        assert_eq!(mask, 0);
        assert!(card_from_hash(&mut mask, &[1u8; 32]).is_none());
    }

    #[test]
    fn payload_size_matches_the_field_table() {
        let payload = 32 * 3
            + 8 * 2
            + 1
            + 1
            + 32 * 16 * 2
            + 11
            + 1
            + 11
            + 1
            + 8
            + 1
            + 8
            + 8
            + 1
            + 1
            + 32 * 7
            + 1
            + 8
            + 8;
        assert_eq!(payload, GAME_PAYLOAD);
    }
}
