import type { ParsedMethod, ParsedTypeReference } from "./model.js";

export interface ContractAssessment { state: "no-signature-incompatibility" | "incompatible" | "review" | "unknown"; reasons: string[] }
export interface CompatibilityOptions { phpVersion?: string; isSubtype?: (child: string, parent: string) => boolean | undefined; childClassFinal?: boolean; traitContext?: boolean }
const visibility = { private: 0, protected: 1, public: 2 };
const builtin = new Set(["int", "float", "string", "bool", "true", "false", "null", "array", "object", "iterable", "callable", "mixed", "never", "void"]);
function types(reference: ParsedTypeReference | undefined): string[] {
  if (!reference) return ["mixed"];
  return [...new Set([...reference.builtins, ...reference.resolved, ...(reference.nullable ? ["null"] : [])])].map((type) => type.toLowerCase());
}
function subtype(child: ParsedTypeReference | undefined, parent: ParsedTypeReference | undefined, options: CompatibilityOptions): boolean | undefined {
  const clauses = (type: ParsedTypeReference | undefined): string[][] => (type?.alternatives ?? (type?.composite === "intersection" ? [types(type)] : types(type).map((atom) => [atom]))).map((clause) => clause.map((atom) => atom.toLowerCase()));
  const atomSubtype = (left: string, right: string): boolean | undefined => {
    if (left === right || left === "never" || right === "mixed") return true;
    if (left === "mixed") return false;
    if (left.startsWith("static:") || right.startsWith("static:")) {
      if (left.startsWith("static:") && right.startsWith("static:")) return options.isSubtype?.(left.slice(7), right.slice(7));
      if (left.startsWith("static:")) return atomSubtype(left.slice(7), right);
      if (options.childClassFinal && Number.parseFloat(options.phpVersion ?? "0") >= 8.5) return atomSubtype(left, right.slice(7));
      return false;
    }
    if (["true", "false"].includes(left) && right === "bool" || left === "array" && right === "iterable") return true;
    if (!builtin.has(left) && right === "object") return true;
    if (!builtin.has(left) && right === "iterable") return options.isSubtype?.(left, "traversable");
    if (left === "closure" && right === "callable") return true;
    if (builtin.has(left) && builtin.has(right)) return false;
    return options.isSubtype?.(left, right);
  };
  let unresolved = false;
  for (const left of clauses(child)) {
    let covered = false, possible = false;
    for (const right of clauses(parent)) {
      const requirements = right.map((required) => {
        const matches = left.map((provided) => atomSubtype(provided, required));
        return matches.includes(true) ? true : matches.includes(undefined) ? undefined : false;
      });
      if (requirements.every((match) => match === true)) { covered = true; break; }
      if (!requirements.includes(false)) possible = true;
    }
    if (!covered && !possible) return false;
    if (!covered) unresolved = true;
  }
  return unresolved ? undefined : true;
}

/** Native-contract checks with explicit version and optional nominal hierarchy evidence. */
export function assessOverride(child: ParsedMethod, parent: ParsedMethod, options: CompatibilityOptions = {}): ContractAssessment {
  const incompatible: string[] = [], review: string[] = [], unknown: string[] = [];
  if (parent.visibility === "private") return { state: "unknown", reasons: ["A private parent method does not establish an inherited override contract"] };
  if (parent.final) incompatible.push("The parent method is final");
  if (parent.name.toLowerCase() === "__construct" && !parent.abstract) return { state: incompatible.length ? "incompatible" : "review", reasons: incompatible.length ? incompatible : ["Concrete constructors are exempt from normal inherited signature compatibility; construction behaviour requires review"] };
  if (child.static !== parent.static) incompatible.push("Static and instance declarations differ");
  if (visibility[child.visibility] < visibility[parent.visibility]) incompatible.push("The override reduces visibility");
  if (parent.returnsByReference && !child.returnsByReference) incompatible.push("The override removes return-by-reference support");
  if (child.abstract && !parent.abstract) incompatible.push("An abstract override cannot replace a concrete parent implementation");
  const version = Number.parseFloat(options.phpVersion ?? "8.4");
  const references = [child.returnType, parent.returnType, ...(child.parameters ?? []).map((item) => item.type), ...(parent.parameters ?? []).map((item) => item.type)].filter((item): item is ParsedTypeReference => Boolean(item));
  for (const reference of references) {
    const minimum = reference.declared.includes("|") && reference.declared.includes("&") ? 8.2 : reference.composite === "intersection" ? 8.1 : reference.composite === "union" || reference.builtins.includes("mixed") || reference.lateStatic ? 8 : reference.builtins.includes("never") ? 8.1 : reference.builtins.some((type) => ["true", "false", "null"].includes(type)) && !reference.nullable ? 8.2 : reference.builtins.includes("object") ? 7.2 : reference.nullable || reference.builtins.includes("void") || reference.builtins.includes("iterable") ? 7.1 : 7;
    if (version < minimum) incompatible.push(`Native type ${reference.declared} requires PHP ${minimum.toFixed(1)} or later; configured version is ${options.phpVersion}`);
  }
  if (version < 7.4 && child.signatureFingerprint !== parent.signatureFingerprint) unknown.push("Full variance checks require PHP 7.4 or later; older PHP-specific variance needs review");
  const returns = subtype(child.returnType, parent.returnType, options);
  if (returns === false) incompatible.push(`Return type ${child.returnType?.declared ?? "untyped"} is not covariant with ${parent.returnType?.declared ?? "untyped"}`);
  if (returns === undefined) unknown.push("Return type requires class hierarchy, intersection, or late-static resolution");
  const parentParameters = parent.parameters ?? [], childParameters = child.parameters ?? [];
  const childRequired = childParameters.filter((item) => item.optional === false).length;
  const parentRequired = parentParameters.filter((item) => item.optional === false).length;
  if (childRequired > parentRequired) incompatible.push("The override introduces additional required parameters");
  if (parentParameters.some((item) => item.optional === undefined) || childParameters.some((item) => item.optional === undefined)) unknown.push("Parameter optionality was not captured in this indexed declaration");
  if (childParameters.length < parentParameters.length && !childParameters.at(-1)?.variadic) incompatible.push("The override accepts fewer parameters than its parent");
  for (let index = 0; index < parentParameters.length; index++) {
    const parentParameter = parentParameters[index]!;
    const childParameter = childParameters[index] ?? (childParameters.at(-1)?.variadic ? childParameters.at(-1) : undefined);
    if (!childParameter) continue;
    if (parentParameter.byReference !== childParameter.byReference) incompatible.push(`Parameter ${index + 1} changes reference passing`);
    if (parentParameter.variadic && !childParameter.variadic) incompatible.push(`Parameter ${index + 1} removes variadic support`);
    if (parentParameter.optional && childParameter.optional === false) incompatible.push(`Parameter ${index + 1} becomes required`);
    const parameters = subtype(parentParameter.type, childParameter.type, options);
    if (parameters === false) incompatible.push(`Parameter ${index + 1} narrows the accepted native type`);
    if (parameters === undefined) unknown.push(`Parameter ${index + 1} requires class hierarchy or composite type resolution`);
    if (parentParameter.name !== childParameter.name && version >= 8) review.push(`Parameter ${index + 1} changes name from $${parentParameter.name} to $${childParameter.name}; named arguments require review`);
  }
  return { state: incompatible.length ? "incompatible" : unknown.length ? "unknown" : review.length ? "review" : "no-signature-incompatibility", reasons: [...incompatible, ...unknown, ...review, ...(!incompatible.length && !unknown.length && !review.length ? ["No incompatibility detected in the supported native signature checks; behaviour still requires review"] : [])] };
}
