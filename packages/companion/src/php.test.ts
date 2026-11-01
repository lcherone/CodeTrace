import assert from "node:assert/strict";
import test from "node:test";
import { parsePhp } from "./php.js";
import { resolveRelationships, symbolsFromFiles } from "./relationships.js";

test("resolves aliases, parent classes, and explicit parent calls from the PHP AST", () => {
  const parsed = parsePhp(`<?php
namespace Client\\Store;
use Vendor\\Commerce\\BaseOrder as SharedOrder;
class Order extends SharedOrder {
  public function calculateTotal(): int {
    return parent::calculateTotal();
  }
}`, "src/Order.php");
  assert.equal(parsed.types[0]?.fqn, "Client\\Store\\Order");
  assert.equal(parsed.types[0]?.parent, "Vendor\\Commerce\\BaseOrder");
  const method = parsed.types[0]?.methods[0];
  assert.equal(method?.name, "calculateTotal");
  assert.equal(method?.calls[0]?.receiver, "parent");
  assert.equal(method?.calls[0]?.methodName, "calculateTotal");
  assert.ok((method?.range.startLine ?? 0) > 0);
});

test("marks unknown object receivers as possible rather than inventing a target", () => {
  const parsed = parsePhp(`<?php class A { function run($service) { $service->execute(); } }`);
  const call = parsed.types[0]?.methods[0]?.calls[0];
  assert.equal(call?.receiver, "variable");
  assert.equal(call?.confidence, "unresolved");
});

test("keeps dynamic member names out of static relationship lookup", () => {
  const parsed = parsePhp("<?php class A { function run($method) { $this->{$method}(); } }");
  const call = parsed.types[0]?.methods[0]?.calls[0];
  assert.equal(call?.receiver, "this");
  assert.equal(call?.methodName, undefined);
  assert.equal(call?.confidence, "unresolved");
});

test("resolves a method call on a typed parameter", () => {
  const parsed = parsePhp(`<?php
namespace Client\\Store;
class CheckoutService {
  public function total(Order $order): int { return $order->calculateTotal(); }
}`, "src/CheckoutService.php");
  const call = parsed.types[0]?.methods[0]?.calls[0];
  assert.equal(call?.receiver, "variable");
  assert.equal(call?.className, "Client\\Store\\Order");
  assert.equal(call?.methodName, "calculateTotal");
  assert.equal(call?.confidence, "confirmed");
});

test("implementation fingerprints ignore formatting-only body changes", () => {
  const compact = parsePhp("<?php class A { public function total(): int { return 1; } }").types[0]?.methods[0];
  const formatted = parsePhp(`<?php class A {
    public function total(): int
    {
        return 1;
}
}`).types[0]?.methods[0];
  assert.equal(compact?.implementationFingerprint, formatted?.implementationFingerprint);
  assert.notEqual(compact?.source, formatted?.source);
});

test("tracks native and documented type contracts, interfaces, and late static binding", () => {
  const parsed = parsePhp(`<?php
namespace App\\Pricing;

/** Defines pricing behaviour. */
interface PricesOrder {
  public function price(PriceContext $context): Money;
}

class PriceContext {}
class Money {}

class Order implements PricesOrder {
  /**
   * Calculate the payable order total.
   *
   * Applies promotions before returning a money value.
   * @param PriceContext $context Rules and currency for the calculation.
   * @return Money The final payable amount.
   */
  public function price(PriceContext $context): Money {
    static::boot();
    return new Money();
  }

  /** Create the runtime order subtype. */
  public static function create(): static { return new static(); }
  protected static function boot(): void {}
}`, "src/Pricing.php");

  const order = parsed.types.find((type) => type.shortName === "Order");
  const price = order?.methods.find((method) => method.name === "price");
  const create = order?.methods.find((method) => method.name === "create");
  assert.equal(parsed.types.find((type) => type.shortName === "PricesOrder")?.description, "Defines pricing behaviour.");
  assert.equal(price?.description, "Calculate the payable order total.");
  assert.equal(price?.documentationDetails, "Applies promotions before returning a money value.");
  assert.deepEqual(price?.parameters?.[0]?.type?.resolved, ["App\\Pricing\\PriceContext"]);
  assert.equal(price?.parameters?.[0]?.description, "Rules and currency for the calculation.");
  assert.deepEqual(price?.returnType?.resolved, ["App\\Pricing\\Money"]);
  assert.equal(price?.returnDescription, "The final payable amount.");
  assert.equal(price?.calls[0]?.receiver, "static");
  assert.ok(price?.lateStaticBindings?.some((binding) => binding.kind === "static-call"));
  assert.equal(create?.returnType?.lateStatic, true);
  assert.ok(create?.lateStaticBindings?.some((binding) => binding.kind === "return-type"));
  assert.ok(create?.lateStaticBindings?.some((binding) => binding.kind === "instantiation"));

  const symbols = symbolsFromFiles("pricing", 1, "abc123", [parsed]);
  const relationships = resolveRelationships("pricing", 1, "abc123", symbols);
  const priceSymbol = symbols.find((symbol) => symbol.memberName === "price" && symbol.classFqn?.endsWith("\\Order"));
  assert.ok(relationships.some((relationship) => relationship.sourceId === priceSymbol?.id && relationship.type === "implements-method"));
  assert.ok(relationships.some((relationship) => relationship.sourceId === priceSymbol?.id && relationship.type === "parameter-type" && relationship.confidence === "confirmed"));
  assert.ok(relationships.some((relationship) => relationship.sourceId === priceSymbol?.id && relationship.type === "return-type" && relationship.confidence === "confirmed"));
  assert.ok(relationships.some((relationship) => relationship.sourceId === priceSymbol?.id && relationship.type === "late-static-binding" && relationship.confidence === "possible"));
});

test("uses PHPDoc types as possible evidence when a native type is absent", () => {
  const parsed = parsePhp(`<?php
namespace App;
class Result {}
class Service {
  /** @param Result $value input result
   * @return Result output result
   */
  public function copy($value) { return $value; }
}`);
  const method = parsed.types.find((type) => type.shortName === "Service")?.methods[0];
  assert.equal(method?.parameters?.[0]?.docType?.source, "phpdoc");
  const symbols = symbolsFromFiles("app", 1, "abc", [parsed]);
  const relationships = resolveRelationships("app", 1, "abc", symbols);
  assert.ok(relationships.some((relationship) => relationship.type === "parameter-type" && relationship.confidence === "possible" && relationship.limitations[0]?.includes("PHPDoc")));
  assert.ok(relationships.some((relationship) => relationship.type === "return-type" && relationship.confidence === "possible"));
});

test("deduplicates repeated declarations and relationship evidence before publication", () => {
  const first = parsePhp("<?php class Repeated { function target() {} function run() { $this->target(); $this->target(); } }");
  const duplicate = parsePhp("<?php class Repeated { function target() {} function run() {} }");
  const symbols = symbolsFromFiles("repo", 1, "abc", [first, duplicate]);
  assert.equal(new Set(symbols.map((symbol) => symbol.id)).size, symbols.length);
  const relationships = resolveRelationships("repo", 1, "abc", symbols);
  assert.equal(new Set(relationships.map((relationship) => relationship.id)).size, relationships.length);
  assert.equal(relationships.filter((relationship) => relationship.type === "calls").length, 1);
});

test("infers evidence-backed receivers through properties, assignments, aliases, branches, unions, PHPDoc, and factory returns", () => {
  const parsed = parsePhp(`<?php
namespace App;
class First { public function run(): void {} }
class Second { public function run(): void {} }
class Child extends First {}
class Factory { public function make(): First { return new First(); } }
class Showcase {
  private First $native;
  public function __construct(private First $promoted, Second $assigned) { $this->assigned = $assigned; }
  /** @param First $documented */
  public function exercise(First|Second $union, Factory $factory, $documented): void {
    $local = new First();
    $child = new Child();
    $alias = $local;
    if (rand(0, 1)) { $branch = new First(); } else { $branch = new Second(); }
    $this->native->run();
    $this->promoted->run();
    $this->assigned->run();
    $local->run();
    $child->run();
    $alias->run();
    $branch->run();
    $union->run();
    $documented->run();
    $factory->make()->run();
  }
}`);
  const method = parsed.types.find((type) => type.shortName === "Showcase")?.methods.find((item) => item.name === "exercise"); assert.ok(method);
  const byExpression = new Map(method.receiverAnalysis?.map((item) => [item.expression, item]));
  assert.equal(byExpression.get("$this->native")?.resolutionMethod, "native-property");
  assert.equal(byExpression.get("$this->promoted")?.resolutionMethod, "promoted-property");
  assert.equal(byExpression.get("$this->assigned")?.resolutionMethod, "constructor-assignment");
  assert.equal(byExpression.get("$local")?.resolutionMethod, "local-new");
  assert.equal(byExpression.get("$child")?.resolutionMethod, "local-new");
  assert.equal(byExpression.get("$alias")?.resolutionMethod, "variable-alias");
  assert.equal(byExpression.get("$branch")?.status, "ambiguous"); assert.deepEqual(new Set(byExpression.get("$branch")?.candidateTypes), new Set(["App\\First", "App\\Second"]));
  assert.equal(byExpression.get("$union")?.resolutionMethod, "native-parameter"); assert.equal(byExpression.get("$union")?.confidence, "possible");
  assert.equal(byExpression.get("$documented")?.resolutionMethod, "phpdoc-parameter"); assert.equal(byExpression.get("$documented")?.confidence, "possible");
  assert.equal(byExpression.get("$factory->make()")?.resolutionMethod, "method-return"); assert.equal(byExpression.get("$factory->make()")?.confidence, "confirmed");
  const symbols = symbolsFromFiles("app", 1, "abc", [parsed]); const relationships = resolveRelationships("app", 1, "abc", symbols);
  const calls = relationships.filter((relationship) => relationship.type === "calls" && relationship.sourceId.includes("showcase::exercise"));
  assert.ok(calls.some((call) => call.resolutionMethod === "receiver-native-property" && call.confidence === "confirmed"));
  assert.ok(calls.some((call) => call.detail.includes("$child->run") && call.targetId.includes("first::run")), "inherited receiver call resolves to the declaring parent method");
  assert.equal(calls.filter((call) => call.detail.includes("$branch->run")).length, 2);
  assert.ok(calls.filter((call) => call.detail.includes("$union->run")).every((call) => call.confidence === "possible"));
  assert.ok(calls.some((call) => call.detail.includes("$factory->make()->run") && call.resolutionMethod === "receiver-method-return"));
});

test("keeps invalidated, dynamic, container, runtime-class, reflection, and magic receivers diagnostic-only", () => {
  const parsed = parsePhp(`<?php
namespace App;
class Target { public function run(): void {} }
class ContainerInterface { public function get(string $id): object {} public function make(string $id): object {} public function resolve(string $id): object {} }
class MagicProxy { public function __call(string $name, array $arguments): mixed {} }
class UnsafeCalls {
  public function blocked(Target $target, ContainerInterface $container, string $method): void {
    $target = unknown_value();
    $target->run();
    $container->get(Target::class)->run();
    $container->make(Target::class)->run();
    $container->resolve(Target::class)->run();
    $class = Target::class;
    $class::run();
    $instance = new $class;
    $instance->run();
    (new \\ReflectionClass(Target::class))->newInstance()->run();
    $proxy = new MagicProxy();
    $proxy->missing();
    $plain = new Target();
    $plain->missing();
    $dynamic = new Target();
    $dynamic->{$method}();
  }

  /**
   * @param class-string<Target> $runtimeClass
   * @param \\ReflectionClass<Target> $reflection
   */
  public function documentedRuntime(string $runtimeClass, \\ReflectionClass $reflection): void {
    $runtimeInstance = new $runtimeClass;
    $runtimeInstance->run();
    $reflectedInstance = $reflection->newInstance();
    $reflectedInstance->run();
  }
}`);
  const symbols = symbolsFromFiles("app", 1, "abc", [parsed]); const relationships = resolveRelationships("app", 1, "abc", symbols);
  const method = parsed.types.find((type) => type.shortName === "UnsafeCalls")?.methods.find((item) => item.name === "blocked"); assert.ok(method);
  const analyses = method.receiverAnalysis ?? [];
  const methods = new Map(analyses.map((item) => [`${item.expression}:${item.methodName ?? "dynamic"}`, item]));
  assert.equal(methods.get("$target:run")?.resolutionMethod, "invalidated");
  for (const expression of ["$container->get(Target::class)", "$container->make(Target::class)", "$container->resolve(Target::class)"]) assert.equal(methods.get(`${expression}:run`)?.resolutionMethod, "container-lookup");
  assert.equal(methods.get("$class:run")?.resolutionMethod, "runtime-class-string"); assert.deepEqual(methods.get("$class:run")?.candidateTypes, ["App\\Target"]);
  assert.equal(methods.get("$instance:run")?.resolutionMethod, "runtime-class-string");
  assert.equal(analyses.find((item) => item.resolutionMethod === "reflection" && item.methodName === "run")?.status, "unresolved");
  assert.equal(methods.get("$proxy:missing")?.resolutionMethod, "magic-call"); assert.equal(methods.get("$proxy:missing")?.status, "unresolved"); assert.ok(methods.get("$proxy:missing")?.limitations.includes("Magic __call dispatch cannot prove a declared target method"));
  assert.equal(methods.get("$plain:missing")?.status, "unresolved"); assert.ok(methods.get("$plain:missing")?.limitations.some((item) => item.includes("No declared target")));
  const dynamic = analyses.find((item) => item.methodName === undefined && item.expression === "$dynamic"); assert.equal(dynamic?.resolutionMethod, "dynamic-method"); assert.deepEqual(dynamic?.candidateTypes, ["App\\Target"]);
  const unsafeRunEdges = relationships.filter((relationship) => relationship.type === "calls" && relationship.sourceId.includes("unsafecalls::blocked") && relationship.targetId.includes("target::run"));
  assert.equal(unsafeRunEdges.length, 0);
  const documented = parsed.types.find((type) => type.shortName === "UnsafeCalls")?.methods.find((item) => item.name === "documentedRuntime"); assert.ok(documented);
  const documentedAnalyses = new Map(documented.receiverAnalysis?.map((item) => [item.expression, item]));
  assert.deepEqual(documentedAnalyses.get("$runtimeInstance")?.candidateTypes, ["App\\Target"]); assert.equal(documentedAnalyses.get("$runtimeInstance")?.resolutionMethod, "runtime-class-string"); assert.equal(documentedAnalyses.get("$runtimeInstance")?.status, "unresolved");
  assert.deepEqual(documentedAnalyses.get("$reflectedInstance")?.candidateTypes, ["App\\Target"]); assert.equal(documentedAnalyses.get("$reflectedInstance")?.resolutionMethod, "reflection"); assert.equal(documentedAnalyses.get("$reflectedInstance")?.status, "unresolved");
  assert.equal(relationships.some((relationship) => relationship.type === "calls" && relationship.sourceId.includes("unsafecalls::documentedruntime") && relationship.targetId.includes("target::run")), false);
});

test("does not confuse a typed factory make method with a runtime container lookup and bounds receiver candidates", () => {
  const typeNames = Array.from({ length: 10 }, (_, index) => `C${index}`);
  const classes = typeNames.map((name) => `class ${name} { public function run(): void {} }`).join("\n");
  const parsed = parsePhp(`<?php namespace App; ${classes}
class Factory { public function make(): C0 { return new C0(); } }
class Demo { public function run(Factory $factory, ${typeNames.join("|")} $many): void { $factory->make()->run(); $many->run(); } }`);
  const method = parsed.types.find((type) => type.shortName === "Demo")?.methods[0]; assert.ok(method);
  assert.equal(method.receiverAnalysis?.find((item) => item.expression === "$factory->make()")?.resolutionMethod, "method-return");
  const bounded = method.receiverAnalysis?.find((item) => item.expression === "$many"); assert.equal(bounded?.candidateTypes.length, 8); assert.ok(bounded?.limitations.some((item) => item.includes("bounded to 8")));
});
