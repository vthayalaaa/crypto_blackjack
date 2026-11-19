const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = ["♠", "♥", "♦", "♣"] as const;

export type CardFace = {
  rank: string;
  suit: string;
  red: boolean;
  name: string;
};

export function cardFace(card: number): CardFace {
  const rank = RANKS[card % 13] ?? "?";
  const suit = SUITS[Math.floor(card / 13)] ?? "?";
  const red = suit === "♥" || suit === "♦";
  return { rank, suit, red, name: `${rank} ${suit}` };
}

/** Best blackjack total. Ace is 11 until the hand would bust. */
export function handTotal(cards: number[]): number {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = card % 13;
    if (rank === 0) {
      aces += 1;
      total += 11;
    } else if (rank >= 9) {
      total += 10;
    } else {
      total += rank + 1;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}
