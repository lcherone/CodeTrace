import { createHash } from "node:crypto";
import Engine from "php-parser";
import type { ParsedCall, ParsedFile, ParsedLateStaticBinding, ParsedMethod, ParsedParameter, ParsedReceiverAnalysis, ParsedType, ParsedTypeReference, ReceiverResolutionMethod } from "./model.js";

type AstNode = Record<string, any>;

const engine = new Engine({
  parser: { extractDoc: true, suppressErrors: false },
  ast: { withPositions: true, withSource: true },
  lexer: { all_tokens: true, comment_tokens: true },
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const PHP_ANALYZER_VERSION = 6;
export const phpCacheKey = (source: string): string => sha(`${PHP_ANALYZER_VERSION}\0${source}`);
const textName = (node: any): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  for (const candidate of [node?.name, node?.value, node?.raw]) {
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return "";
};
const location = (node: any) => ({
  startLine: Math.max(1, node?.loc?.start?.line ?? 1),
  startColumn: Math.max(0, node?.loc?.start?.column ?? 0),
  endLine: Math.max(1, node?.loc?.end?.line ?? node?.loc?.start?.line ?? 1),
  endColumn: Math.max(0, node?.loc?.end?.column ?? node?.loc?.start?.column ?? 0),
});

function walk(node: any, visit: (node: AstNode, parent?: AstNode) => void, parent?: AstNode): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.kind === "string") visit(node, parent);
  for (const value of Object.values(node)) {
    if (value === node.loc || value === node.leadingComments || value === node.trailingComments) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}

function collectImports(program: AstNode): { namespace: string; imports: Record<string, string>; statements: any[] } {
  let namespace = "";
  const imports: Record<string, string> = {};
  let statements = program.children ?? [];
  const ns = statements.find((child: any) => child.kind === "namespace");
  if (ns) {
    namespace = textName(ns.name).replace(/^\\/, "");
    statements = ns.children ?? [];
  }
  for (const child of statements) {
    if (child.kind !== "usegroup" && child.kind !== "useitem") continue;
    const prefix = child.kind === "usegroup" ? textName(child.name) : "";
    const items = child.kind === "usegroup" ? child.items ?? [] : [child];
    for (const item of items) {
      const suffix = textName(item.name);
      const full = [prefix, suffix].filter(Boolean).join("\\").replace(/^\\/, "");
      const alias = textName(item.alias) || full.split("\\").at(-1) || full;
      imports[alias.toLowerCase()] = full;
    }
  }
  return { namespace, imports, statements };
}

function qualify(raw: string, namespace: string, imports: Record<string, string>): string {
  const value = raw.replace(/^\\/, "");
  if (!value) return value;
  if (raw.startsWith("\\")) return value;
  if (value.toLowerCase().startsWith("namespace\\")) return [namespace, value.slice("namespace\\".length)].filter(Boolean).join("\\");
  const [head, ...tail] = value.split("\\");
  const imported = imports[(head ?? "").toLowerCase()];
  if (imported) return [imported, ...tail].join("\\");
  return namespace ? `${namespace}\\${value}` : value;
}

const builtinTypes = new Set([
  "array", "bool", "boolean", "callable", "false", "float", "double", "int", "integer", "iterable",
  "mixed", "never", "null", "object", "resource", "scalar", "string", "true", "void",
]);

interface ParsedDoc {
  summary?: string;
  details?: string;
  params: Map<string, { type?: string; description?: string }>;
  returnType?: string;
  returnDescription?: string;
}

function parseDoc(node: AstNode): ParsedDoc {
  const raw = [...(node.leadingComments ?? [])].reverse().find((comment: any) => String(comment.value ?? "").trim().startsWith("/**"))?.value as string | undefined;
  const result: ParsedDoc = { params: new Map() };
  if (!raw) return result;
  const lines = raw.replace(/^\s*\/\*\*?/, "").replace(/\*\/\s*$/, "").split(/\r?\n/).map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd());
  const descriptionLines: string[] = [];
  for (const line of lines) {
    const parameter = line.match(/^@param\s+(\S+)\s+(?:&?\.\.\.)?\$(\w+)(?:\s+(.*))?$/);
    if (parameter?.[1] && parameter[2]) {
      result.params.set(parameter[2], { type: parameter[1], ...(parameter[3] ? { description: parameter[3].trim() } : {}) });
      continue;
    }
    const returned = line.match(/^@return\s+(\S+)(?:\s+(.*))?$/);
    if (returned?.[1]) {
      result.returnType = returned[1];
      if (returned[2]) result.returnDescription = returned[2].trim();
      continue;
    }
    if (!line.startsWith("@")) descriptionLines.push(line);
  }
  while (descriptionLines.length && !descriptionLines[0]?.trim()) descriptionLines.shift();
  while (descriptionLines.length && !descriptionLines.at(-1)?.trim()) descriptionLines.pop();
  const paragraphBreak = descriptionLines.findIndex((line) => !line.trim());
  const summaryLines = paragraphBreak < 0 ? descriptionLines : descriptionLines.slice(0, paragraphBreak);
  const detailLines = paragraphBreak < 0 ? [] : descriptionLines.slice(paragraphBreak + 1);
  const summary = summaryLines.join(" ").trim();
  const details = detailLines.join("\n").trim();
  if (summary) result.summary = summary;
  if (details) result.details = details;
  return result;
}

function typeReference(
  declared: string,
  source: ParsedTypeReference["source"],
  namespace: string,
  imports: Record<string, string>,
  classFqn: string,
  parentFqn?: string,
  nullable = false,
): ParsedTypeReference | undefined {
  const clean = declared.trim();
  if (!clean) return undefined;
  const atoms = clean.match(/\\?[A-Za-z_$][A-Za-z0-9_\\-]*/g) ?? [];
  const resolved = new Set<string>();
  const builtins = new Set<string>();
  let lateStatic = false;
  for (const atom of atoms) {
    const lower = atom.toLowerCase();
    if (builtinTypes.has(lower) || lower === "array-key" || lower === "class-string" || lower === "list") {
      builtins.add(lower);
      continue;
    }
    if (lower === "self") resolved.add(classFqn);
    else if (lower === "parent") { if (parentFqn) resolved.add(parentFqn); }
    else if (lower === "static" || lower === "$this") { resolved.add(classFqn); lateStatic = true; }
    else resolved.add(qualify(atom, namespace, imports));
  }
  return {
    declared: `${nullable && !clean.startsWith("?") ? "?" : ""}${clean}`,
    resolved: [...resolved],
    builtins: [...builtins],
    source,
    composite: clean.includes("|") ? "union" : clean.includes("&") ? "intersection" : "named",
    nullable: nullable || clean.startsWith("?") || atoms.some((atom) => atom.toLowerCase() === "null"),
    lateStatic,
  };
}

function nativeTypeReference(node: any, nullable: boolean, namespace: string, imports: Record<string, string>, classFqn: string, parentFqn?: string): ParsedTypeReference | undefined {
  if (!node) return undefined;
  const sourceDeclared = node?.loc?.source || textName(node) || (node.types ?? []).map((part: any) => textName(part)).join(node.kind === "intersectiontype" ? "&" : "|");
  return typeReference(sourceDeclared, "native", namespace, imports, classFqn, parentFqn, nullable);
}

function sourceSlice(source: string, node: any): string {
  const start = node?.loc?.start?.offset;
  const end = node?.loc?.end?.offset;
  return Number.isInteger(start) && Number.isInteger(end) ? source.slice(start, end) : "";
}

function normalizeTokens(source: string, includeComments = false): string {
  try {
    const tokenSource = source.includes("<?") ? source : `<?php ${source}`;
    return engine.tokenGetAll(tokenSource).flatMap((token: string | [string, string, number]) => {
      if (typeof token === "string") return [token];
      const [kind, value] = token;
      if (!includeComments && /COMMENT|WHITESPACE|OPEN_TAG|CLOSE_TAG/.test(kind)) return [];
      if (/WHITESPACE/.test(kind)) return [];
      return [value];
    }).join("");
  } catch {
    return source.replace(/\s+/g, "");
  }
}

function methodSignature(node: AstNode, source: string): string {
  const full = sourceSlice(source, node);
  const bodyStart = full.indexOf("{");
  const semicolon = full.indexOf(";");
  const cut = bodyStart >= 0 ? bodyStart : semicolon >= 0 ? semicolon + 1 : full.length;
  return full.slice(0, cut).trim();
}

interface ReceiverState {
  candidates: string[];
  /** Types named inside class-string<T>/ReflectionClass<T>; diagnostic only. */
  diagnosticCandidates?: string[];
  resolutionMethod: ReceiverResolutionMethod;
  confidence: ParsedCall["confidence"];
  limitations: string[];
}

interface ReceiverContext {
  classFqn: string;
  parentFqn?: string;
  namespace: string;
  imports: Record<string, string>;
  source: string;
  properties: Map<string, ReceiverState>;
  methodReturns: Map<string, ReceiverState>;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const MAX_RECEIVER_CANDIDATES = 8;
const boundedCandidates = (values: string[]) => unique(values).slice(0, MAX_RECEIVER_CANDIDATES);
const cloneState = (state: ReceiverState): ReceiverState => ({
  ...state,
  candidates: [...state.candidates],
  ...(state.diagnosticCandidates ? { diagnosticCandidates: [...state.diagnosticCandidates] } : {}),
  limitations: [...state.limitations],
});
const unknownState = (resolutionMethod: ReceiverResolutionMethod, limitation: string): ReceiverState => ({ candidates: [], resolutionMethod, confidence: "unresolved", limitations: [limitation] });

function referenceState(reference: ParsedTypeReference | undefined, resolutionMethod: ReceiverResolutionMethod, fallback: string): ReceiverState {
  if (!reference?.resolved.length) return unknownState("unresolved", fallback);
  const allCandidates = unique(reference.resolved); const candidates = boundedCandidates(allCandidates);
  const multiple = allCandidates.length !== 1 || reference.composite !== "named";
  const doc = reference.source === "phpdoc";
  return {
    candidates, resolutionMethod,
    confidence: doc || multiple || reference.lateStatic ? "possible" : "confirmed",
    limitations: [
      ...(doc ? ["Receiver type comes from PHPDoc and is not enforced by PHP"] : []),
      ...(multiple ? [`Receiver type ${reference.declared} has multiple statically possible candidates`] : []),
      ...(reference.lateStatic ? ["Late-static receiver type depends on the runtime called class"] : []),
      ...(allCandidates.length > MAX_RECEIVER_CANDIDATES ? [`Receiver candidates were bounded to ${MAX_RECEIVER_CANDIDATES}`] : []),
    ],
  };
}

function withDocGenericCandidates(
  state: ReceiverState,
  native: ParsedTypeReference | undefined,
  documented: ParsedTypeReference | undefined,
): ReceiverState {
  if (!native || !documented) return state;
  const nativeTypes = new Set(native.resolved.map((candidate) => candidate.toLowerCase()));
  const diagnostics = boundedCandidates(documented.resolved.filter((candidate) => !nativeTypes.has(candidate.toLowerCase())));
  return diagnostics.length ? { ...state, diagnosticCandidates: diagnostics } : state;
}

function mergeStates(states: ReceiverState[], method: ReceiverResolutionMethod = "branch-merge"): ReceiverState {
  const allCandidates = unique(states.flatMap((state) => state.candidates)); const candidates = boundedCandidates(allCandidates);
  const diagnosticCandidates = boundedCandidates(states.flatMap((state) => state.diagnosticCandidates ?? []));
  const limitations = unique(states.flatMap((state) => state.limitations));
  if (!candidates.length) return { candidates: [], ...(diagnosticCandidates.length ? { diagnosticCandidates } : {}), resolutionMethod: states.some((state) => state.resolutionMethod === "invalidated") ? "invalidated" : method, confidence: "unresolved", limitations: limitations.length ? limitations : ["Control-flow merge did not preserve a statically known receiver type"] };
  const possible = candidates.length > 1 || states.some((state) => state.confidence !== "confirmed");
  return { candidates, ...(diagnosticCandidates.length ? { diagnosticCandidates } : {}), resolutionMethod: method, confidence: possible ? "possible" : "confirmed", limitations: possible ? unique([...limitations, "Receiver type reflects multiple control-flow or declaration candidates", ...(allCandidates.length > MAX_RECEIVER_CANDIDATES ? [`Receiver candidates were bounded to ${MAX_RECEIVER_CANDIDATES}`] : [])]) : limitations };
}

const expressionSource = (source: string, node: AstNode): string => sourceSlice(source, node).replace(/;$/, "").trim() || node.kind;
const propertyKey = (node: AstNode): string | undefined => node.kind === "propertylookup" && node.what?.kind === "variable" && textName(node.what.name) === "this" && textName(node.offset) ? `this.${textName(node.offset)}` : undefined;

function inferExpression(node: AstNode | undefined, variables: Map<string, ReceiverState>, context: ReceiverContext): ReceiverState {
  if (!node) return unknownState("unresolved", "Receiver expression is absent");
  if (node.kind === "variable") {
    const name = textName(node.name);
    if (name === "this") return { candidates: [context.classFqn], resolutionMethod: "this", confidence: "confirmed", limitations: [] };
    return cloneState(variables.get(name) ?? unknownState("unresolved", `Variable $${name || "<dynamic>"} has no statically known object type`));
  }
  if (node.kind === "new") {
    const raw = textName(node.what);
    if (!raw || node.what?.kind === "variable") {
      const declared = node.what?.kind === "variable" ? variables.get(textName(node.what.name)) : undefined;
      return { candidates: declared?.diagnosticCandidates ?? declared?.candidates ?? [], resolutionMethod: "runtime-class-string", confidence: "unresolved", limitations: ["Runtime class-string construction cannot be resolved without executing PHP"] };
    }
    const lower = raw.toLowerCase();
    const candidate = lower === "self" || lower === "static" ? context.classFqn : lower === "parent" ? context.parentFqn : qualify(raw, context.namespace, context.imports);
    if (!candidate) return unknownState("runtime-class-string", "Dynamic construction target is unavailable");
    return { candidates: [candidate], resolutionMethod: "local-new", confidence: lower === "static" ? "possible" : "confirmed", limitations: lower === "static" ? ["new static() depends on the runtime called class"] : [] };
  }
  if (node.kind === "propertylookup") {
    const key = propertyKey(node);
    if (key) return cloneState(variables.get(key) ?? context.properties.get(key.slice(5)) ?? unknownState("unresolved", `Property $this->${key.slice(5)} has no statically known object type`));
    return unknownState("unresolved", "Nested or dynamic property lookup is not statically resolved");
  }
  if (node.kind === "assign") return inferExpression(node.right, variables, context);
  if (node.kind === "staticlookup" && textName(node.offset).toLowerCase() === "class") {
    const raw = textName(node.what); const candidate = raw ? qualify(raw, context.namespace, context.imports) : undefined;
    return { candidates: candidate ? [candidate] : [], resolutionMethod: "runtime-class-string", confidence: "unresolved", limitations: ["Class-string values are diagnostic evidence, not constructed object instances"] };
  }
  if (node.kind === "call") {
    const what = node.what;
    const methodName = textName(what?.offset ?? what?.name);
    if (!methodName) return unknownState("dynamic-method", "Dynamic method return type cannot be resolved");
    let receiver: ReceiverState;
    if (what?.kind === "propertylookup") receiver = inferExpression(what.what, variables, context);
    else if (what?.kind === "staticlookup") {
      if (what.what?.kind === "variable") {
        const declared = variables.get(textName(what.what.name));
        receiver = { candidates: declared?.candidates ?? [], resolutionMethod: "runtime-class-string", confidence: "unresolved", limitations: ["Runtime static class variables cannot be resolved without executing PHP"] };
      } else {
      const raw = textName(what.what); const lower = raw.toLowerCase();
      const candidate = lower === "self" || lower === "static" ? context.classFqn : lower === "parent" ? context.parentFqn : qualify(raw, context.namespace, context.imports);
      receiver = candidate ? { candidates: [candidate], resolutionMethod: "static-class", confidence: lower === "static" ? "possible" : "confirmed", limitations: lower === "static" ? ["Late-static call target depends on runtime class"] : [] } : unknownState("runtime-class-string", "Static call class is dynamic");
      }
    } else return unknownState("unresolved", "Function return type is outside local method receiver analysis");
    if (receiver.candidates.some((candidate) => /(?:^|\\)Reflection(?:Class|Object)$/i.test(candidate)) || ["newinstance", "newinstancewithoutconstructor"].includes(methodName.toLowerCase())) {
      return { candidates: receiver.diagnosticCandidates ?? [], resolutionMethod: "reflection", confidence: "unresolved", limitations: ["Reflection-created instances depend on runtime class metadata"] };
    }
    const returns = receiver.candidates.flatMap((candidate) => {
      const result = context.methodReturns.get(`${candidate.toLowerCase()}::${methodName.toLowerCase()}`);
      return result ? [result] : [];
    });
    if (!returns.length) {
      const expression = expressionSource(context.source, what?.kind === "propertylookup" ? what.what : what);
      const containerShaped = /container|service\s*locator/i.test(expression) || receiver.candidates.some((candidate) => /(?:Container(?:Interface)?|ServiceLocator)$/i.test(candidate));
      if (containerShaped && ["get", "make", "resolve"].includes(methodName.toLowerCase())) return unknownState("container-lookup", `Container ${methodName}() result depends on runtime bindings`);
      return unknownState("unresolved", `Return type for ${methodName}() is not statically available`);
    }
    const merged = mergeStates(returns, "method-return");
    return { ...merged, resolutionMethod: "method-return", limitations: unique([...receiver.limitations, ...merged.limitations]) };
  }
  return unknownState("invalidated", `Expression ${expressionSource(context.source, node)} does not preserve a statically known receiver type`);
}

function callFromNode(node: AstNode, variables: Map<string, ReceiverState>, context: ReceiverContext): ParsedCall | undefined {
  if (node.kind !== "call") return undefined;
  const what = node.what;
  const methodName = textName(what?.offset ?? what?.name);
  const dynamicName = !methodName;
  if (what?.kind === "propertylookup") {
    const receiver = what.what;
    const isThis = receiver?.kind === "variable" && textName(receiver.name) === "this";
    let state = inferExpression(receiver, variables, context);
    if (dynamicName) state = { ...state, resolutionMethod: "dynamic-method", confidence: "unresolved", limitations: unique([...state.limitations, "Dynamic method names cannot be matched to a declared method"]) };
    const candidates = boundedCandidates(state.candidates);
    const expression = expressionSource(context.source, receiver);
    return {
      receiver: isThis ? "this" : "variable",
      ...(candidates.length === 1 ? { className: candidates[0] } : {}),
      ...(candidates.length ? { classNames: candidates } : {}),
      ...(methodName ? { methodName } : {}),
      range: location(node),
      confidence: dynamicName ? "unresolved" : state.confidence,
      resolutionMethod: dynamicName ? "dynamic-method" : state.resolutionMethod,
      limitations: state.limitations,
      expression,
      detail: candidates.length ? `${expression}${methodName ? `->${methodName}()` : ""} receiver resolved via ${state.resolutionMethod} to ${candidates.join(" | ")}` : `${expression}${methodName ? `->${methodName}()` : ""} receiver is unresolved via ${state.resolutionMethod}`,
    };
  }
  if (what?.kind === "staticlookup") {
    if (what.what?.kind === "variable") {
      const declared = variables.get(textName(what.what.name));
      const candidates = boundedCandidates(declared?.candidates ?? []);
      return { receiver: "dynamic", ...(candidates.length ? { classNames: candidates } : {}), ...(methodName ? { methodName } : {}), range: location(node), confidence: "unresolved", resolutionMethod: "runtime-class-string", limitations: ["Runtime static class variables cannot be resolved without executing PHP"], expression: expressionSource(context.source, what.what), detail: `Runtime static receiver is unresolved (line ${location(node).startLine})` };
    }
    const raw = textName(what.what);
    const keyword = raw.toLowerCase();
    const receiver = keyword === "parent" ? "parent" : keyword === "static" ? "static" : keyword === "self" ? "self" : "class";
    const className = receiver === "class" ? qualify(raw, context.namespace, context.imports) : receiver === "parent" ? context.parentFqn : context.classFqn;
    const resolutionMethod: ReceiverResolutionMethod = dynamicName ? "dynamic-method" : receiver === "parent" ? "parent" : "static-class";
    const limitations = dynamicName ? ["Dynamic method names cannot be matched to a declared method"] : keyword === "static" ? ["Late static binding may change the target"] : [];
    return { receiver, ...(className ? { className, classNames: [className] } : {}), ...(methodName ? { methodName } : {}), range: location(node), confidence: dynamicName ? "unresolved" : keyword === "static" ? "possible" : "confirmed", resolutionMethod, limitations, expression: raw, detail: `${raw}${methodName ? `::${methodName}()` : "::<dynamic>()"} resolved via ${resolutionMethod}` };
  }
  return undefined;
}

function assignState(right: AstNode, variables: Map<string, ReceiverState>, context: ReceiverContext): ReceiverState {
  const inferred = inferExpression(right, variables, context);
  if (right.kind === "variable" && inferred.candidates.length) return { ...inferred, resolutionMethod: "variable-alias", limitations: unique([...inferred.limitations, `Receiver aliases $${textName(right.name)}`]) };
  if (!inferred.candidates.length && inferred.resolutionMethod === "unresolved") return { ...inferred, resolutionMethod: "invalidated", limitations: unique([...inferred.limitations, "Assignment invalidated the previous receiver type"]) };
  return inferred;
}

function mergeEnvironments(initial: Map<string, ReceiverState>, branches: Map<string, ReceiverState>[]): Map<string, ReceiverState> {
  const merged = new Map<string, ReceiverState>();
  const keys = new Set([...initial.keys(), ...branches.flatMap((branch) => [...branch.keys()])]);
  for (const key of keys) {
    const states = branches.map((branch) => branch.get(key) ?? initial.get(key) ?? unknownState("invalidated", `${key} is not assigned on every control-flow branch`));
    const baseline = initial.get(key);
    const signature = (state: ReceiverState) => JSON.stringify([state.candidates, state.resolutionMethod, state.confidence, state.limitations]);
    if (baseline && states.every((state) => signature(state) === signature(baseline))) merged.set(key, cloneState(baseline));
    else merged.set(key, mergeStates(states, "branch-merge"));
  }
  return merged;
}

function analyzeReceiverFlow(statements: AstNode[], variables: Map<string, ReceiverState>, context: ReceiverContext, calls: ParsedCall[]): void {
  const addCalls = (node: AstNode | undefined) => walk(node, (child) => { const call = callFromNode(child, variables, context); if (call) calls.push(call); });
  const applyAssignments = (node: AstNode) => walk(node, (child) => {
    if (child.kind === "assign" && child.operator === "=") {
      const key = child.left?.kind === "variable" ? textName(child.left.name) : propertyKey(child.left);
      if (key) {
        const previous = variables.get(key);
        const assigned = assignState(child.right, variables, context);
        if (previous?.candidates.length && !assigned.candidates.length && assigned.resolutionMethod === "invalidated") {
          assigned.limitations = unique([...assigned.limitations, "Receiver was reassigned from a known native type to an unknown object value"]);
        }
        variables.set(key, assigned);
      }
    }
    if (child.kind === "unset") for (const target of child.variables ?? []) {
      const key = target.kind === "variable" ? textName(target.name) : propertyKey(target);
      if (key) variables.set(key, unknownState("invalidated", `${key} was unset`));
    }
  });
  for (const statement of statements ?? []) {
    if (statement.kind === "if") {
      addCalls(statement.test);
      const initial = new Map([...variables].map(([key, state]) => [key, cloneState(state)]));
      const branches: Map<string, ReceiverState>[] = [];
      const yes = new Map([...initial].map(([key, state]) => [key, cloneState(state)]));
      analyzeReceiverFlow(statement.body?.children ?? [statement.body].filter(Boolean), yes, context, calls); branches.push(yes);
      if (statement.alternate) {
        const no = new Map([...initial].map(([key, state]) => [key, cloneState(state)]));
        analyzeReceiverFlow(statement.alternate.kind === "block" ? statement.alternate.children ?? [] : [statement.alternate], no, context, calls); branches.push(no);
      } else branches.push(initial);
      variables.clear(); for (const [key, state] of mergeEnvironments(initial, branches)) variables.set(key, state);
      continue;
    }
    addCalls(statement);
    applyAssignments(statement);
    if (["while", "do", "for", "foreach"].includes(statement.kind)) {
      const assigned = new Set<string>();
      walk(statement, (child) => { if (child.kind === "assign") { const key = child.left?.kind === "variable" ? textName(child.left.name) : propertyKey(child.left); if (key) assigned.add(key); } });
      for (const key of assigned) variables.set(key, unknownState("invalidated", `${key} is assigned in a loop and may have different runtime values`));
    }
  }
}

function parseMethod(node: AstNode, context: ReceiverContext): ParsedMethod {
  const { classFqn, parentFqn, namespace, imports, source } = context;
  const name = textName(node.name);
  const methodSource = sourceSlice(source, node);
  const signature = methodSignature(node, source);
  const bodySource = sourceSlice(source, node.body);
  const documentation = parseDoc(node);
  const parameters: ParsedParameter[] = [];
  const variableTypes = new Map<string, ReceiverState>();
  for (const parameter of node.arguments ?? []) {
    const variableName = textName(parameter.name);
    const type = nativeTypeReference(parameter.type, Boolean(parameter.nullable), namespace, imports, classFqn, parentFqn);
    const documented = documentation.params.get(variableName);
    const docType = documented?.type ? typeReference(documented.type, "phpdoc", namespace, imports, classFqn, parentFqn) : undefined;
    const effectiveType = type ?? docType;
    if (variableName) variableTypes.set(variableName, withDocGenericCandidates(referenceState(effectiveType, type ? "native-parameter" : docType ? "phpdoc-parameter" : "unresolved", `Parameter $${variableName} is untyped or only uses mixed/object`), type, docType));
    parameters.push({
      name: variableName,
      byReference: Boolean(parameter.byref),
      variadic: Boolean(parameter.variadic),
      ...(type ? { type } : {}),
      ...(docType ? { docType } : {}),
      ...(documented?.description ? { description: documented.description } : {}),
    });
  }
  const calls: ParsedCall[] = [];
  const lateStaticBindings: ParsedLateStaticBinding[] = [];
  const lateStaticKeys = new Set<string>();
  const addLateStatic = (kind: ParsedLateStaticBinding["kind"], target: AstNode, detail: string) => {
    const range = location(target);
    const key = `${kind}:${range.startLine}:${range.startColumn}`;
    if (!lateStaticKeys.has(key)) {
      lateStaticKeys.add(key);
      lateStaticBindings.push({ kind, range, detail });
    }
  };
  analyzeReceiverFlow(node.body?.children ?? [], variableTypes, context, calls);
  walk(node.body, (child, parent) => {
    if (child.kind === "call" && child.what?.kind === "staticlookup" && textName(child.what.what).toLowerCase() === "static") addLateStatic("static-call", child, `static::${textName(child.what.offset) || "<dynamic>"} is resolved against the runtime called class`);
    if (child.kind === "new" && textName(child.what).toLowerCase() === "static") addLateStatic("instantiation", child, "new static() instantiates the runtime called class");
    if (child.kind === "staticlookup" && textName(child.what).toLowerCase() === "static" && parent?.kind !== "call") addLateStatic("member-access", child, "static member access is resolved against the runtime called class");
  });
  const returnType = nativeTypeReference(node.type, Boolean(node.nullable), namespace, imports, classFqn, parentFqn);
  const docReturnType = documentation.returnType ? typeReference(documentation.returnType, "phpdoc", namespace, imports, classFqn, parentFqn) : undefined;
  if (returnType?.lateStatic) addLateStatic("return-type", node.type ?? node, "The static return type follows the runtime called class");
  else if (!returnType && docReturnType?.lateStatic) addLateStatic("return-type", node, "The PHPDoc static return type follows the runtime called class");
  const visibility = node.visibility === "private" || node.visibility === "protected" ? node.visibility : "public";
  const documentationSource = textName(node.leadingComments?.map((comment: any) => comment.value).join("\n"));
  const receiverAnalysis: ParsedReceiverAnalysis[] = calls.map((call) => ({
    id: `receiver:${sha(`${classFqn}\0${name}\0${call.range.startLine}\0${call.range.startColumn}\0${call.expression}\0${call.methodName ?? "dynamic"}`).slice(0, 20)}`,
    status: !call.methodName ? "dynamic" : call.confidence === "unresolved" || !(call.classNames?.length ?? 0) ? "unresolved" : (call.classNames?.length ?? 0) > 1 ? "ambiguous" : "resolved",
    expression: call.expression, ...(call.methodName ? { methodName: call.methodName } : {}), candidateTypes: call.classNames ?? [], resolutionMethod: call.resolutionMethod,
    confidence: call.confidence, range: call.range, limitations: call.limitations,
  }));
  return {
    id: `method:${classFqn.toLowerCase()}::${name.toLowerCase()}`,
    classFqn,
    name,
    visibility,
    static: Boolean(node.isStatic),
    abstract: Boolean(node.isAbstract || !node.body),
    signature,
    source: methodSource,
    range: location(node),
    implementationFingerprint: sha(normalizeTokens(bodySource)),
    signatureFingerprint: sha(normalizeTokens(signature)),
    documentationFingerprint: sha(documentationSource),
    ...(documentation.summary ? { description: documentation.summary } : {}),
    ...(documentation.details ? { documentationDetails: documentation.details } : {}),
    parameters,
    ...(returnType ? { returnType } : {}),
    ...(docReturnType ? { docReturnType } : {}),
    ...(documentation.returnDescription ? { returnDescription: documentation.returnDescription } : {}),
    lateStaticBindings,
    receiverAnalysis,
    calls,
  };
}

function receiverContextForClass(node: AstNode, classFqn: string, parentFqn: string | undefined, namespace: string, imports: Record<string, string>, source: string, methodReturns: Map<string, ReceiverState>): ReceiverContext {
  const properties = new Map<string, ReceiverState>();
  for (const statement of node.body ?? []) if (statement.kind === "propertystatement") for (const property of statement.properties ?? []) {
    const name = textName(property.name);
    if (!name) continue;
    const reference = nativeTypeReference(property.type, Boolean(property.nullable), namespace, imports, classFqn, parentFqn);
    if (reference) properties.set(name, referenceState(reference, "native-property", `Property $this->${name} has no concrete native object type`));
  }
  const constructor = (node.body ?? []).find((child: AstNode) => child.kind === "method" && textName(child.name).toLowerCase() === "__construct");
  const constructorParameters = new Map<string, ReceiverState>();
  if (constructor) for (const parameter of constructor.arguments ?? []) {
    const name = textName(parameter.name); if (!name) continue;
    const reference = nativeTypeReference(parameter.type, Boolean(parameter.nullable), namespace, imports, classFqn, parentFqn);
    const documented = parseDoc(constructor).params.get(name);
    const docReference = documented?.type ? typeReference(documented.type, "phpdoc", namespace, imports, classFqn, parentFqn) : undefined;
    const state = withDocGenericCandidates(referenceState(reference ?? docReference, reference ? "native-parameter" : docReference ? "phpdoc-parameter" : "unresolved", `Constructor parameter $${name} has no concrete object type`), reference, docReference);
    constructorParameters.set(name, state);
    if (parameter.flags || parameter.visibility && parameter.visibility !== "public") properties.set(name, { ...state, resolutionMethod: "promoted-property", limitations: unique([...state.limitations, "Receiver type comes from a constructor-promoted property"]) });
  }
  for (const statement of constructor?.body?.children ?? []) {
    const assignment = statement.kind === "expressionstatement" ? statement.expression : undefined;
    const key = assignment?.kind === "assign" && assignment.operator === "=" ? propertyKey(assignment.left) : undefined;
    const parameterName = assignment?.right?.kind === "variable" ? textName(assignment.right.name) : "";
    const state = constructorParameters.get(parameterName);
    if (key && state && !properties.has(key.slice(5))) properties.set(key.slice(5), { ...cloneState(state), resolutionMethod: "constructor-assignment", limitations: unique([...state.limitations, `Constructor assigns typed parameter $${parameterName} to $this->${key.slice(5)}`]) });
  }
  return { classFqn, ...(parentFqn ? { parentFqn } : {}), namespace, imports, source, properties, methodReturns };
}

export function parsePhp(source: string, path = "unknown.php"): ParsedFile {
  const program = engine.parseCode(source, path);
  const { namespace, imports, statements } = collectImports(program);
  const types: ParsedType[] = [];
  const classNodes = statements.filter((node: AstNode) => ["class", "interface", "trait"].includes(node.kind));
  const methodReturns = new Map<string, ReceiverState>();
  for (const node of classNodes) {
    const classFqn = qualify(textName(node.name), namespace, {});
    const parentRaw = textName(node.extends); const parentFqn = parentRaw ? qualify(parentRaw, namespace, imports) : undefined;
    for (const method of node.body ?? []) if (method.kind === "method") {
      const documentation = parseDoc(method);
      const native = nativeTypeReference(method.type, Boolean(method.nullable), namespace, imports, classFqn, parentFqn);
      const documented = documentation.returnType ? typeReference(documentation.returnType, "phpdoc", namespace, imports, classFqn, parentFqn) : undefined;
      const effective = native ?? documented;
      if (effective?.resolved.length) methodReturns.set(`${classFqn.toLowerCase()}::${textName(method.name).toLowerCase()}`, referenceState(effective, "method-return", `Return type for ${classFqn}::${textName(method.name)} is not a concrete object type`));
    }
  }
  for (const node of classNodes) {
    if (!["class", "interface", "trait"].includes(node.kind)) continue;
    const shortName = textName(node.name);
    const fqn = qualify(shortName, namespace, {});
    const kind = node.kind as ParsedType["kind"];
    const parentRaw = textName(node.extends);
    const parent = parentRaw ? qualify(parentRaw, namespace, imports) : undefined;
    const documentation = parseDoc(node);
    const interfaceNodes = Array.isArray(node.implements) ? node.implements : node.kind === "interface" && Array.isArray(node.extends) ? node.extends : [];
    const interfaces = interfaceNodes.map((item: any) => qualify(textName(item), namespace, imports));
    const traits: string[] = [];
    const methods: ParsedMethod[] = [];
    const receiverContext = receiverContextForClass(node, fqn, parent, namespace, imports, source, methodReturns);
    for (const child of node.body ?? []) {
      if (child.kind === "method") methods.push(parseMethod(child, receiverContext));
      if (child.kind === "traituse") for (const trait of child.traits ?? []) traits.push(qualify(textName(trait), namespace, imports));
    }
    types.push({
      id: `${kind}:${fqn.toLowerCase()}`,
      fqn,
      shortName,
      kind,
      abstract: Boolean(node.isAbstract),
      ...(parent ? { parent } : {}),
      interfaces,
      traits,
      ...(documentation.summary ? { description: documentation.summary } : {}),
      ...(documentation.details ? { documentationDetails: documentation.details } : {}),
      methods,
      range: location(node),
    });
  }
  return { path, contentHash: phpCacheKey(source), namespace, imports, types, limitations: [] };
}

export function fingerprintPhp(source: string): string {
  return sha(normalizeTokens(source));
}
