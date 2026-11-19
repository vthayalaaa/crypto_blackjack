/** "DeFi Casino", with every line the same width so the letters stay lined up. */
const HEADER = [
  " _______             ________  __         ______                       __                     ",
  "/       \\           /        |/  |       /      \\                     /  |                    ",
  "$$$$$$$  |  ______  $$$$$$$$/ $$/       /$$$$$$  |  ______    _______ $$/  _______    ______  ",
  "$$ |  $$ | /      \\ $$ |__    /  |      $$ |  $$/  /      \\  /       |/  |/       \\  /      \\ ",
  "$$ |  $$ |/$$$$$$  |$$    |   $$ |      $$ |       $$$$$$  |/$$$$$$$/ $$ |$$$$$$$  |/$$$$$$  |",
  "$$ |  $$ |$$    $$ |$$$$$/    $$ |      $$ |   __  /    $$ |$$      \\ $$ |$$ |  $$ |$$ |  $$ |",
  "$$ |__$$ |$$$$$$$$/ $$ |      $$ |      $$ \\__/  |/$$$$$$$ | $$$$$$  |$$ |$$ |  $$ |$$ \\__$$ |",
  "$$    $$/ $$       |$$ |      $$ |      $$    $$/ $$    $$ |/     $$/ $$ |$$ |  $$ |$$    $$/ ",
  "$$$$$$$/   $$$$$$$/ $$/       $$/        $$$$$$/   $$$$$$$/ $$$$$$$/  $$/ $$/   $$/  $$$$$$/  ",
];

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(pad)}${text}`;
}

export function consoleBanner(): string {
  const width = HEADER[0]?.length ?? 0;
  return `${HEADER.join("\n")}\n\n${center("Blackjack", width)}`;
}

export function consoleRule(): string {
  return "   ( 5 )    ( 25 )    ( 100 )";
}
