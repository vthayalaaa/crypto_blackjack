import { cardFace } from "../lib/cards";

export function PlayingCard({ card, faceDown = false }: { card?: number; faceDown?: boolean }) {
  if (faceDown || card === undefined) {
    return <div className="card back" aria-hidden="true" />;
  }
  const face = cardFace(card);
  return (
    <div className={`card ${face.red ? "red" : "black"}`} aria-label={face.name}>
      <span className="corner">
        {face.rank}
        <small>{face.suit}</small>
      </span>
      <span className="pip">{face.suit}</span>
    </div>
  );
}
