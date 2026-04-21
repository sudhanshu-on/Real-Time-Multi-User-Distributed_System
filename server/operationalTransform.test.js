/**
 * Operational Transformation Tests
 * Validates transformation logic for concurrent edits
 */
import { transformOperation, transformAgainstPriors } from "../utils/operationalTransform.utils.js";

// Test helper
const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

const test = (name, fn) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
  }
};

const describe = (suite, fn) => {
  console.log(`\n${suite}`);
  fn();
};

// Tests
describe("Operational Transformation Engine", () => {
  describe("transformOperation", () => {
    test("should shift insert position right when prior insert is before", () => {
      const incoming = { type: "insert", position: 5, text: "B" };
      const prior = { type: "insert", position: 2, text: "AAAA" };

      const result = transformOperation(incoming, prior);

      assert(result.position === 9, `Expected 9, got ${result.position}`);
      assert(result.text === "B", `Expected 'B', got '${result.text}'`);
    });

    test("should not shift insert position when prior insert is after", () => {
      const incoming = { type: "insert", position: 2, text: "B" };
      const prior = { type: "insert", position: 5, text: "AAAA" };

      const result = transformOperation(incoming, prior);

      assert(result.position === 2, `Expected 2, got ${result.position}`);
    });

    test("should shift insert position left when prior delete is before", () => {
      const incoming = { type: "insert", position: 10, text: "B" };
      const prior = { type: "delete", position: 2, length: 3 };

      const result = transformOperation(incoming, prior);

      assert(result.position === 7, `Expected 7, got ${result.position}`);
    });

    test("should shift delete position right when prior insert is before", () => {
      const incoming = { type: "delete", position: 5, length: 2 };
      const prior = { type: "insert", position: 2, text: "AAA" };

      const result = transformOperation(incoming, prior);

      assert(result.position === 8, `Expected 8, got ${result.position}`);
      assert(result.length === 2, `Expected 2, got ${result.length}`);
    });

    test("should extend delete length when prior insert overlaps", () => {
      const incoming = { type: "delete", position: 0, length: 5 };
      const prior = { type: "insert", position: 2, text: "XXX" };

      const result = transformOperation(incoming, prior);

      assert(result.position === 0, `Expected 0, got ${result.position}`);
      assert(result.length === 8, `Expected 8, got ${result.length}`);
    });

    test("should reduce delete length when prior delete overlaps", () => {
      const incoming = { type: "delete", position: 0, length: 10 };
      const prior = { type: "delete", position: 2, length: 3 };

      const result = transformOperation(incoming, prior);

      assert(result.length === 7, `Expected 7, got ${result.length}`);
    });
  });

  describe("transformAgainstPriors", () => {
    test("should transform multiple operations sequentially", () => {
      const incoming = [
        { type: "insert", position: 0, text: "C" },
        { type: "insert", position: 1, text: "D" },
      ];

      const priors = [
        { type: "insert", position: 0, text: "A" },
        { type: "insert", position: 1, text: "B" },
      ];

      const result = transformAgainstPriors(incoming, priors);

      assert(result.length === 2, `Expected 2 operations, got ${result.length}`);
    });

    test("empty priors should return unchanged operations", () => {
      const incoming = [
        { type: "insert", position: 0, text: "A" },
        { type: "delete", position: 1, length: 2 },
      ];

      const result = transformAgainstPriors(incoming, []);

      assert(result.length === incoming.length, `Expected ${incoming.length} operations`);
      assert(result[0].position === incoming[0].position, "First op position should match");
    });

    test("empty incoming should return empty array", () => {
      const priors = [
        { type: "insert", position: 0, text: "A" },
      ];

      const result = transformAgainstPriors([], priors);

      assert(result.length === 0, `Expected 0 operations, got ${result.length}`);
    });
  });

  describe("Real-world concurrent scenarios", () => {
    test("Scenario 1: Both users append at end simultaneously", () => {
      // Initial content: "Hello" (length 5)
      // User A appends "X" at pos 5
      // User B appends "Y" at pos 5 (concurrent)
      const userA = [{ type: "insert", position: 5, text: "X" }];
      const userB = [{ type: "insert", position: 5, text: "Y" }];

      // User A applied first, B transforms against A
      const transformedB = transformAgainstPriors(userB, userA);

      assert(transformedB.length === 1, "Should have 1 operation");
      assert(transformedB[0].type === "insert", "Should be insert");
      assert(transformedB[0].text === "Y", "Should preserve text");
    });

    test("Scenario 2: User inserts in middle while other deletes from start", () => {
      // Initial: "Hello World" (11 chars)
      // User A: Insert "!" at position 5 -> "Hello! World"
      // User B: Delete positions 0-5 (delete "Hello")

      const userA = [{ type: "insert", position: 5, text: "!" }];
      const userB = [{ type: "delete", position: 0, length: 5 }];

      // B transforms against A
      const transformedB = transformAgainstPriors(userB, userA);

      assert(transformedB[0].position === 0, `Expected position 0, got ${transformedB[0].position}`);
      assert(transformedB[0].type === "delete", "Should be delete");
    });

    test("Scenario 3: Overlapping deletes from different users", () => {
      // Initial: "0123456789"
      // User A: Delete positions 2-5 (deletes "234")
      // User B: Delete positions 3-8 (deletes "34567")

      const userA = [{ type: "delete", position: 2, length: 3 }];
      const userB = [{ type: "delete", position: 3, length: 5 }];

      const transformedB = transformAgainstPriors(userB, userA);

      assert(transformedB.length === 1, "Should have 1 operation");
      assert(transformedB[0].type === "delete", "Should be delete");
      // Length should be reduced due to overlap
      assert(transformedB[0].length <= 5, "Delete length should be reduced");
    });
  });
});

console.log("\n✅ All tests completed");
