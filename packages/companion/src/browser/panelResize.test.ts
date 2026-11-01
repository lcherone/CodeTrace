import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRelationshipRailWidth,
  relationshipRailWidthFromKey,
  RELATIONSHIP_RAIL_MAX_WIDTH,
  RELATIONSHIP_RAIL_MIN_WIDTH,
} from "./panelResize.js";

test("relationship panel width remains within panel and canvas bounds", () => {
  assert.equal(clampRelationshipRailWidth(100, 1200), RELATIONSHIP_RAIL_MIN_WIDTH);
  assert.equal(clampRelationshipRailWidth(420, 1200), 420);
  assert.equal(clampRelationshipRailWidth(900, 1200), RELATIONSHIP_RAIL_MAX_WIDTH);
  assert.equal(clampRelationshipRailWidth(560, 780), 434);
});

test("relationship panel keyboard resizing supports steps and limits", () => {
  assert.equal(relationshipRailWidthFromKey("ArrowLeft", 300, 1200), 284);
  assert.equal(relationshipRailWidthFromKey("ArrowRight", 300, 1200, true), 348);
  assert.equal(relationshipRailWidthFromKey("Home", 300, 1200), RELATIONSHIP_RAIL_MIN_WIDTH);
  assert.equal(relationshipRailWidthFromKey("End", 300, 1200), RELATIONSHIP_RAIL_MAX_WIDTH);
  assert.equal(relationshipRailWidthFromKey("Enter", 300, 1200), undefined);
});
