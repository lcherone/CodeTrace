export const RELATIONSHIP_RAIL_MIN_WIDTH = 220;
export const RELATIONSHIP_RAIL_MAX_WIDTH = 560;
export const RELATIONSHIP_RAIL_HANDLE_WIDTH = 6;
export const RELATIONSHIP_RAIL_MIN_CANVAS_WIDTH = 340;

export function clampRelationshipRailWidth(requestedWidth: number, workspaceWidth: number): number {
  const availableMaximum = Math.max(
    RELATIONSHIP_RAIL_MIN_WIDTH,
    Math.min(
      RELATIONSHIP_RAIL_MAX_WIDTH,
      Math.floor(workspaceWidth) - RELATIONSHIP_RAIL_MIN_CANVAS_WIDTH - RELATIONSHIP_RAIL_HANDLE_WIDTH,
    ),
  );
  return Math.min(availableMaximum, Math.max(RELATIONSHIP_RAIL_MIN_WIDTH, Math.round(requestedWidth)));
}

export function relationshipRailWidthFromKey(
  key: string,
  currentWidth: number,
  workspaceWidth: number,
  largeStep = false,
): number | undefined {
  const step = largeStep ? 48 : 16;
  if (key === "ArrowLeft") return clampRelationshipRailWidth(currentWidth - step, workspaceWidth);
  if (key === "ArrowRight") return clampRelationshipRailWidth(currentWidth + step, workspaceWidth);
  if (key === "Home") return clampRelationshipRailWidth(RELATIONSHIP_RAIL_MIN_WIDTH, workspaceWidth);
  if (key === "End") return clampRelationshipRailWidth(RELATIONSHIP_RAIL_MAX_WIDTH, workspaceWidth);
  return undefined;
}
