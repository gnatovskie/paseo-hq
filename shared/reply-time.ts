// Only the last assistant message of a settled turn counts. Tool output,
// failed turns and the currently streaming turn must not move a session.
export function findFinalReply<T extends { turnId?: string; timestamp: string; item: { type: string } }>(
  rows: readonly T[], excludedTurns: Set<string>, allowLegacy: boolean,
): T | undefined {
  return [...rows].reverse().find(row => {
    const turn = row.turnId ?? "legacy";
    if (excludedTurns.has(turn) || (!row.turnId && !allowLegacy)) return false;
    if (row.item.type === "assistant_message") return true;
    if (row.item.type === "tool_call" || row.item.type === "error") excludedTurns.add(turn);
    return false;
  });
}
