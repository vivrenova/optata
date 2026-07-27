/** Fisher-Yates. The deck is shuffled on the client at mount — the server
 * has no say in the order, and nothing is persisted between visits. */
export function fisherYates<T>(input: readonly T[], random: () => number = Math.random): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
