import type { EditorContextSelection, SymbolOccurrence } from "@trace/contracts";

/** Ignore cursor jitter in the original declaration while a user explores its graph. */
export function sameEditorSymbol(selection: EditorContextSelection, original: SymbolOccurrence | undefined): boolean {
  if (!original || selection.revision.repositoryId !== original.revision.repositoryId || selection.revision.commit !== original.revision.commit || selection.relativePath !== original.path) return false;
  const name = `${original.logical.fullyQualifiedName}${original.logical.memberName ? `::${original.logical.memberName}` : ""}`;
  if (selection.symbolHint) return selection.symbolHint.toLowerCase() === name.toLowerCase();
  if (original.logical.kind !== "method") return selection.range.startLine === original.range.startLine && selection.range.endLine === original.range.startLine;
  return selection.range.startLine >= original.range.startLine && selection.range.endLine <= original.range.endLine;
}
